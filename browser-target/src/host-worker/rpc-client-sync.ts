// Sync RPC client — for callers that must BLOCK until a reply arrives.
//
// Why this exists separately from the async RpcClient:
//   The async client uses `await waitForReadyAsync(replyRing, lastSeen)`,
//   which depends on the JS event loop turning.  Wasm runtime worker
//   enters JSPI suspend during edge.js execution; its event loop pauses;
//   the async drainer never wakes.  So we need a SYNC variant that
//   uses `Atomics.wait` directly — the wasm thread blocks the entire
//   JS thread until reply arrives.  Standard pattern for wasm-driven
//   RPC (Pyodide uses it; emnapi uses it for tsfn signaling).
//
// Caller pattern (from a JS function called by wasm via emnapi imports):
//   function napi_get_undefined_stub(env, resultPtr) {
//     return syncClient.callSync(OP_NAPI_GET_UNDEFINED,
//       hostWorkerId, contextId, encodeTwoU32(env, resultPtr));
//     // returns napi_status; host writes the handle to memory[resultPtr]
//   }
//
// Concurrency: multiple forward sync calls can be in flight on this
// client.  Each gets a unique requestId; the wait loop scans every
// reply slot and matches by requestId.  The wasm thread is blocked
// during any one call, so additional in-flight calls can only arise
// via re-entry (see below) — not from arbitrary host JS scheduling.
//
// Re-entrancy: when `drainReverseRequests` is provided, the wait loop
// invokes it at the top of every iteration BEFORE the reply scan,
// before any `Atomics.wait`.  Reverse-channel handlers (host → wasm
// callbacks for napi_create_function, finalizers, tsfn dispatch, …)
// run there and MAY recursively call back into `callSync` — that
// works naturally because every publish (forward reply OR reverse
// request) bumps the shared-wake counter, so the outer wait wakes
// once the inner call's reply arrives.  Re-entrant depth is bounded
// only by concurrent-in-flight ring width, not by recursion depth —
// see experiments/r6-nested-sync-rpc/FINDINGS.md.
//
// Finalizer-style ops where host needs a synchronous wasm response
// during a call the wasm thread is BLOCKED on (no callback frame in
// the chain to drain it) still require the pool/deferred pattern —
// see experiments/l5-malloc-deadlock/FINDINGS.md and the R2 finding.

import {
  RingView,
  tryClaimSlot,
  publishSlot,
  payloadBytes,
  freeSlot,
  STATUS_READY,
  SLOT_HEADER_SIZE,
  SLOT_HEADER_STATUS,
} from "../wasi-shim/sab-ring";
import {
  REQUEST_HEADER_SIZE,
  REPLY_HEADER_SIZE,
  writeRequestHeader,
  readReplyHeader,
} from "./rpc-protocol";

const NativeAtomics = Atomics;

export interface SyncReply {
  status: number;
  payload: Uint8Array;
}

export interface SharedWakeView {
  /** Int32Array aliased over the shared-wake SAB. */
  i32: Int32Array;
  /** Slot index inside `i32` to wait/notify on (usually 0). */
  idx: number;
}

export class SyncRpcClient {
  private nextRequestId = 1;
  private readonly sharedWake: SharedWakeView | null;
  private readonly drainReverseRequests: (() => void) | null;

  constructor(
    private readonly requestRing: RingView,
    private readonly replyRing: RingView,
    /** Optional shared-wake view.  When provided, the wait loop blocks
     *  on this address instead of the reply ring's per-ring wake.  Host
     *  must bump the same address on every publish (forward reply OR
     *  reverse request) so a reverse request arriving during a
     *  forward-blocked wait wakes the loop.  R1 / R6a findings. */
    sharedWake?: SharedWakeView | null,
    /** Optional reverse-channel drainer.  Invoked at the top of every
     *  wait-loop iteration BEFORE the reply scan.  Handlers MAY
     *  recursively call back into `callSync` (re-entrant by design —
     *  see R6a).  Default: no drainer, no re-entry. */
    drainReverseRequests?: (() => void) | null,
  ) {
    this.sharedWake = sharedWake ?? null;
    this.drainReverseRequests = drainReverseRequests ?? null;
  }

  /** Send a request and BLOCK until reply arrives (or timeout).
   *  Returns the reply payload + status.  Throws on timeout. */
  callSync(
    opCode: number,
    hostWorkerId: number,
    contextId: number,
    args: Uint8Array | null,
    timeoutMs = 30_000,
  ): SyncReply {
    const requestId = this.allocRequestId();

    // ── 1. Claim a request slot (sync backoff).
    let reqSlot = -1;
    for (let attempt = 0; reqSlot === -1 && attempt < 1000; attempt++) {
      reqSlot = tryClaimSlot(this.requestRing, hostWorkerId, contextId);
      if (reqSlot === -1) {
        // Spin briefly; no event-loop turn available to us.
        for (let i = 0; i < 1000; i++) { /* burn */ }
      }
    }
    if (reqSlot === -1) {
      throw new Error("sync-rpc: request ring full after backoff");
    }

    // ── 2. Write payload.
    const payload = payloadBytes(this.requestRing, reqSlot);
    writeRequestHeader(payload, { opCode, requestId });
    const argsLen = args && args.byteLength > 0 ? args.byteLength : 0;
    if (argsLen > 0) {
      payload.set(args!, REQUEST_HEADER_SIZE);
    }
    publishSlot(this.requestRing, reqSlot, REQUEST_HEADER_SIZE + argsLen);

    // ── 3. Wait for the reply slot to become READY with our requestId.
    //
    // The reply ring may have multiple slots in-flight; we scan all
    // slots looking for ours.  In practice the ring has 32 slots, so
    // worst-case 32 status reads per wakeup.
    //
    // Wait address: if `sharedWake` was supplied at construction, we
    // block on it (host bumps the SAME address for forward-reply
    // publishes AND reverse-request publishes — see R1/R6a).  Otherwise
    // we fall back to the reply ring's per-ring wake counter, which
    // preserves backward compatibility for call sites that don't need
    // the reverse channel.
    const deadline = Date.now() + timeoutMs;
    const replyI32 = this.replyRing.i32;
    const numSlots = this.replyRing.config.numSlots;
    const slotSize = this.replyRing.config.slotSize;
    // sab-ring's GLOBAL_HEADER_SIZE = 16; slot statuses start there.
    const headerBytes = 16;
    const replyWakeIdx = 0; // WAKE_COUNTER_OFFSET >>> 2 on replyRing
    const waitI32 = this.sharedWake ? this.sharedWake.i32 : replyI32;
    const waitIdx = this.sharedWake ? this.sharedWake.idx : replyWakeIdx;
    let lastWake = NativeAtomics.load(waitI32, waitIdx);

    while (true) {
      // Re-entrant reverse-channel drain.  Runs BEFORE the reply scan
      // so queued host → wasm requests aren't starved by our own
      // forward reply landing first.  Handlers may recursively call
      // back into `callSync` — the outer wait wakes naturally because
      // every publish bumps the shared-wake counter.
      this.drainReverseRequests?.();

      // Scan all reply slots for one that's READY and matches our requestId.
      for (let slot = 0; slot < numSlots; slot++) {
        const statusByteOff = headerBytes + slot * slotSize + SLOT_HEADER_STATUS;
        const statusIdx = statusByteOff >>> 2;
        if (NativeAtomics.load(replyI32, statusIdx) !== STATUS_READY) continue;
        // Peek the requestId.  Reply layout: [opCode, requestId, status, payload...].
        const payloadStart = headerBytes + slot * slotSize + SLOT_HEADER_SIZE;
        const replyView = this.replyRing.u8.subarray(payloadStart, payloadStart + slotSize - SLOT_HEADER_SIZE);
        const hdr = readReplyHeader(replyView);
        if (hdr.requestId !== requestId) continue;
        // Found our reply.  Read it, free the slot, return.
        const payloadBytesLen = NativeAtomics.load(replyI32, (headerBytes + slot * slotSize + 12 /* SLOT_HEADER_PAYLOAD_LEN */) >>> 2) >>> 0;
        const copy = new Uint8Array(payloadBytesLen - REPLY_HEADER_SIZE);
        if (copy.byteLength > 0) {
          copy.set(replyView.subarray(REPLY_HEADER_SIZE, payloadBytesLen));
        }
        freeSlot(this.replyRing, slot);
        return { status: hdr.status, payload: copy };
      }

      // No matching reply yet.  Wait on the configured wake address.
      const remainMs = deadline - Date.now();
      if (remainMs <= 0) {
        throw new Error(`sync-rpc: reply timeout after ${timeoutMs}ms for op 0x${opCode.toString(16)} reqId ${requestId}`);
      }
      const result = NativeAtomics.wait(waitI32, waitIdx, lastWake, Math.min(remainMs, 5_000));
      lastWake = NativeAtomics.load(waitI32, waitIdx);
      void result; // "ok" / "not-equal" / "timed-out" — either way we re-scan
    }
  }

  private allocRequestId(): number {
    const id = this.nextRequestId++;
    if (this.nextRequestId > 0xfffffff0) this.nextRequestId = 1;
    return id;
  }
}
