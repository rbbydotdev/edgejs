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

export class RpcServer {
  private handlers = new Map<number, Handler>();
  private running = false;

  constructor(
    private readonly requestRing: RingView,
    private readonly replyRing: RingView,
  ) {}

  /** Register a handler for an op code.  Overwrites any prior. */
  register(opCode: number, handler: Handler): void {
    this.handlers.set(opCode, handler);
  }

  /** Begin draining the request ring.  Async; runs forever until stop(). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let lastSeen = readWakeCounter(this.requestRing);
    while (this.running) {
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
      lastSeen = readWakeCounter(this.requestRing);
      await waitForReadyAsync(this.requestRing, lastSeen);
    }
  }

  stop(): void {
    this.running = false;
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
  }
}

export { EMPTY_BYTES };
