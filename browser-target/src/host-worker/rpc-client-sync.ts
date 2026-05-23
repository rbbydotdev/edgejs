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
// Concurrency limit: one in-flight call at a time per SyncRpcClient
// instance.  The wasm thread is BLOCKED during the call, so nothing
// else on this thread can issue another sync call.  (Async calls from
// a different RpcClient instance on the same thread CAN race; that
// would require careful coordination — not a goal for L5.)
//
// Re-entrancy: if host's handler triggers another wasm call (e.g. via
// a finalizer), the wasm thread is blocked — DEADLOCK.  Q1's pool
// allocator avoids this for malloc; other ops where host might
// re-enter wasm must be designed to not require wasm response during
// the napi call.  See experiments/l5-malloc-deadlock/FINDINGS.md.

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

export class SyncRpcClient {
  private nextRequestId = 1;

  constructor(
    private readonly requestRing: RingView,
    private readonly replyRing: RingView,
  ) {}

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
    const deadline = Date.now() + timeoutMs;
    const replyI32 = this.replyRing.i32;
    const numSlots = this.replyRing.config.numSlots;
    const slotSize = this.replyRing.config.slotSize;
    // sab-ring's GLOBAL_HEADER_SIZE = 16; slot statuses start there.
    const headerBytes = 16;
    const wakeIdx = 0; // WAKE_COUNTER_OFFSET >>> 2
    let lastWake = NativeAtomics.load(replyI32, wakeIdx);

    while (true) {
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

      // No matching reply yet.  Wait on the wake counter.
      const remainMs = deadline - Date.now();
      if (remainMs <= 0) {
        throw new Error(`sync-rpc: reply timeout after ${timeoutMs}ms for op 0x${opCode.toString(16)} reqId ${requestId}`);
      }
      const result = NativeAtomics.wait(replyI32, wakeIdx, lastWake, Math.min(remainMs, 5_000));
      lastWake = NativeAtomics.load(replyI32, wakeIdx);
      void result; // "ok" / "not-equal" / "timed-out" — either way we re-scan
    }
  }

  private allocRequestId(): number {
    const id = this.nextRequestId++;
    if (this.nextRequestId > 0xfffffff0) this.nextRequestId = 1;
    return id;
  }
}
