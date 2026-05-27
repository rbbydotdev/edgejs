// RPC server — runs on the host worker.  Listens on the request ring,
// dispatches by opCode to registered handlers, writes replies to the
// reply ring.
//
// Pattern:
//   const server = new RpcServer(requestRing, replyRing);
//   server.register(OP_PING, async (req) => ({ payload: empty, status: OK }));
//   server.start();  // begins drain loop
//
// Handlers are async, receive (opCode, requestId, hostWorkerId, contextId,
// argsBytes), return { payload, status }.

import {
  RingView,
  tryClaimSlot,
  publishSlot,
  payloadBytes,
  drainRing,
  freeSlot,
  readWakeCounter,
  waitForReadyAsync,
  STATUS_READY,
} from "../wasi-shim/sab-ring";
import {
  REPLY_HEADER_SIZE,
  REQUEST_HEADER_SIZE,
  REPLY_STATUS_OK,
  REPLY_STATUS_INVALID_OP,
  REPLY_STATUS_HOST_ERROR,
  readRequestHeader,
  writeReplyHeader,
} from "./rpc-protocol";

export interface HandlerContext {
  opCode: number;
  requestId: number;
  hostWorkerId: number;
  contextId: number;
}

export interface HandlerReply {
  payload: Uint8Array;
  status?: number; // default REPLY_STATUS_OK
}

export type Handler = (
  ctx: HandlerContext,
  args: Uint8Array,
) => HandlerReply | Promise<HandlerReply>;

const EMPTY_BYTES = new Uint8Array(0);

const NativeAtomics = Atomics;

export class RpcServer {
  private handlers = new Map<number, Handler>();
  private running = false;
  private readonly sharedWakeI32: Int32Array | null;
  private readonly sharedWakeIdx: number;

  constructor(
    private readonly requestRing: RingView,
    private readonly replyRing: RingView,
    /** Optional single-shared-wake Int32Array view.  When provided, every
     *  reply publish bumps this counter and notifies — used to wake a
     *  wasm-side `SyncRpcClient` that's blocked on the shared address.
     *  See experiments/r6-nested-sync-rpc/FINDINGS.md. */
    sharedWake?: { i32: Int32Array; idx: number } | null,
  ) {
    this.sharedWakeI32 = sharedWake?.i32 ?? null;
    this.sharedWakeIdx = sharedWake?.idx ?? 0;
  }

  /** Register a handler for an op code.  Overwrites any prior. */
  register(opCode: number, handler: Handler): void {
    this.handlers.set(opCode, handler);
  }

  /** Begin draining the request ring.  Async; runs forever until stop(). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      // Read the wake counter BEFORE draining, not after. If a producer
      // publishes between drain and counter-read (TOCTOU window), the
      // counter would already be bumped at read time, then waitForReadyAsync
      // would wait for ANOTHER bump that may never come -- leaving the
      // freshly-published slot stranded in the ring until the next
      // unrelated wake. Reading lastSeen first guarantees that any
      // publish that happens during this iteration either (a) appears in
      // our drainRing this turn, or (b) bumps the counter past lastSeen
      // and waitForReadyAsync returns immediately so the next iteration
      // drains it. Either way, no slot is stranded.
      const lastSeen = readWakeCounter(this.requestRing);
      const messages = drainRing(this.requestRing);
      for (const m of messages) {
        // Copy header out before processing — payload aliases SAB and
        // we'll free the slot before the handler resolves.
        const hdr = readRequestHeader(m.payload);
        const argsCopy = new Uint8Array(m.payload.byteLength - REQUEST_HEADER_SIZE);
        argsCopy.set(m.payload.subarray(REQUEST_HEADER_SIZE));
        const ctx: HandlerContext = {
          opCode: hdr.opCode,
          requestId: hdr.requestId,
          hostWorkerId: m.hostWorkerId,
          contextId: m.contextId,
        };
        freeSlot(this.requestRing, m.slot);
        // Don't await here — we want to drain the ring as fast as
        // possible.  Each handler races to write its own reply.
        void this.dispatch(ctx, argsCopy);
      }
      await waitForReadyAsync(this.requestRing, lastSeen);
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Synchronously drain whatever request slots are ready RIGHT NOW and
   *  dispatch their handlers, but ONLY when the ring is under real
   *  pressure (more than half full). Wired into SyncRpcClient as
   *  drainReverseRequests so that bursty reverse traffic (cp.send loops,
   *  many concurrent callbacks) doesn't exhaust the host's reverseClient
   *  backoff and silently drop events; see NOTES.md
   *  "host-rpc-sync-reverse-drain".
   *
   *  Why gate on pressure: the async start() loop spreads dispatches
   *  across libuv ticks, and lib's Readable.push() queues a setImmediate
   *  per chunk to emit 'data'. If we drain STDOUT and EXIT into the same
   *  tick, 'data' lands on the NEXT tick (after 'exit' fired and the
   *  user's process.exit() ran), losing the buffered bytes. Under
   *  normal load, leaving the async loop in charge preserves that
   *  ordering. Under burst load, the ring would overflow anyway, so we
   *  accept the timing risk in exchange for not dropping events. */
  drainOnce(): void {
    const numSlots = this.requestRing.config.numSlots;
    const slotSize = this.requestRing.config.slotSize;
    const pressureThreshold = numSlots >>> 1; // half-full
    let ready = 0;
    for (let slot = 0; slot < numSlots; slot++) {
      // GLOBAL_HEADER_SIZE=16 + slot*slotSize + SLOT_HEADER_STATUS(=0), /4.
      const statusIdx = (16 + slot * slotSize) >>> 2;
      if (NativeAtomics.load(this.requestRing.i32, statusIdx) === STATUS_READY) {
        ready++;
        if (ready > pressureThreshold) break;
      }
    }
    if (ready <= pressureThreshold) return;

    const messages = drainRing(this.requestRing);
    for (const m of messages) {
      const hdr = readRequestHeader(m.payload);
      const argsCopy = new Uint8Array(m.payload.byteLength - REQUEST_HEADER_SIZE);
      argsCopy.set(m.payload.subarray(REQUEST_HEADER_SIZE));
      const ctx: HandlerContext = {
        opCode: hdr.opCode,
        requestId: hdr.requestId,
        hostWorkerId: m.hostWorkerId,
        contextId: m.contextId,
      };
      freeSlot(this.requestRing, m.slot);
      void this.dispatch(ctx, argsCopy);
    }
  }

  private async dispatch(ctx: HandlerContext, args: Uint8Array): Promise<void> {
    const handler = this.handlers.get(ctx.opCode);
    let reply: HandlerReply;
    if (!handler) {
      const msg = `unknown opCode 0x${ctx.opCode.toString(16)}`;
      reply = {
        payload: new TextEncoder().encode(msg),
        status: REPLY_STATUS_INVALID_OP,
      };
    } else {
      try {
        reply = await handler(ctx, args);
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)) || "host handler threw";
        reply = {
          payload: new TextEncoder().encode(msg),
          status: REPLY_STATUS_HOST_ERROR,
        };
      }
    }
    this.sendReply(ctx, reply);
  }

  private sendReply(ctx: HandlerContext, reply: HandlerReply): void {
    const payloadLen = reply.payload.byteLength;
    const totalLen = REPLY_HEADER_SIZE + payloadLen;
    if (totalLen > this.replyRing.config.slotSize - 16 /* sab-ring SLOT_HEADER_SIZE */) {
      // Too big for one slot.  Send an error reply instead.
      const msg = new TextEncoder().encode(`reply payload too large: ${payloadLen}`);
      this.sendReply(ctx, { payload: msg, status: REPLY_STATUS_HOST_ERROR });
      return;
    }
    // Claim a reply slot.  Backoff if full.
    let slot = -1;
    for (let attempt = 0; slot === -1 && attempt < 100; attempt++) {
      slot = tryClaimSlot(this.replyRing, ctx.hostWorkerId, ctx.contextId);
      if (slot === -1) {
        // Reply ring full — spin briefly.  No async wait here because
        // we're in dispatch; await would let the request drain loop
        // pile up backpressure.  In practice the reply ring drains
        // quickly because the wasm side waits on each reply by id.
        for (let i = 0; i < 1000; i++) {
          /* spin */
        }
      }
    }
    if (slot === -1) {
      // Give up; reply lost.  The wasm-side caller will time out.
      // Log so we know if this is happening in practice.
      // eslint-disable-next-line no-console
      console.warn(`[rpc-server] reply ring full; dropping reply for op 0x${ctx.opCode.toString(16)} reqId ${ctx.requestId}`);
      return;
    }
    const buf = payloadBytes(this.replyRing, slot);
    writeReplyHeader(buf, {
      opCode: ctx.opCode,
      requestId: ctx.requestId,
      status: reply.status ?? REPLY_STATUS_OK,
    });
    if (payloadLen > 0) {
      buf.set(reply.payload, REPLY_HEADER_SIZE);
    }
    publishSlot(this.replyRing, slot, totalLen);
    // Single-shared-wake bump.  Wasm-side SyncRpcClient may be blocked
    // on this address waiting for ANY publish (forward reply or reverse
    // request) to wake it.  See R6a findings.
    if (this.sharedWakeI32) {
      NativeAtomics.add(this.sharedWakeI32, this.sharedWakeIdx, 1);
      NativeAtomics.notify(this.sharedWakeI32, this.sharedWakeIdx);
    }
  }
}

export { EMPTY_BYTES };
