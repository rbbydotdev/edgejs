// RPC client used from the wasm worker (or any worker) to send requests
// to a host worker.
//
// Pattern:
//   const client = new RpcClient(requestRing, replyRing);
//   const reply = await client.call(OP_PING, hostWorkerId, contextId, emptyArgs);
//
// Concurrency: many calls can be in flight at once.  Each gets a unique
// requestId; replies are demuxed by id.  Slot allocation is from the
// ring; if the ring is full we wait briefly and retry.

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
  REQUEST_HEADER_SIZE,
  writeRequestHeader,
  readReplyHeader,
} from "./rpc-protocol";

interface PendingReply {
  resolve: (replyPayload: Uint8Array) => void;
  reject: (err: Error) => void;
  opCode: number;
}

export class RpcClient {
  private nextRequestId = 1;
  private pending = new Map<number, PendingReply>();

  constructor(
    private readonly requestRing: RingView,
    private readonly replyRing: RingView,
  ) {
    // Background drainer; we don't hold the Promise — errors are
    // routed to all pending callers' .reject() inside the catch.
    void this.startReplyDrainer();
  }

  /** Send a request and await the reply. */
  async call(
    opCode: number,
    hostWorkerId: number,
    contextId: number,
    args: Uint8Array | null,
  ): Promise<{ payload: Uint8Array; status: number }> {
    const requestId = this.allocRequestId();

    // Wait for a free slot (with backoff).
    let slot = -1;
    for (let attempt = 0; slot === -1 && attempt < 100; attempt++) {
      slot = tryClaimSlot(this.requestRing, hostWorkerId, contextId);
      if (slot === -1) {
        await new Promise((r) => setTimeout(r, 1 << Math.min(attempt, 6)));
      }
    }
    if (slot === -1) {
      throw new Error("rpc-client: request ring full after backoff");
    }

    const payload = payloadBytes(this.requestRing, slot);
    writeRequestHeader(payload, { opCode, requestId });
    let argsLen = 0;
    if (args && args.byteLength > 0) {
      payload.set(args, REQUEST_HEADER_SIZE);
      argsLen = args.byteLength;
    }
    publishSlot(this.requestRing, slot, REQUEST_HEADER_SIZE + argsLen);

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (replyPayload: Uint8Array) => {
          const hdr = readReplyHeader(replyPayload);
          resolve({
            payload: replyPayload.subarray(12), // REPLY_HEADER_SIZE
            status: hdr.status,
          });
        },
        reject,
        opCode,
      });
    });
  }

  private allocRequestId(): number {
    const id = this.nextRequestId++;
    if (this.nextRequestId > 0xfffffff0) this.nextRequestId = 1;
    return id;
  }

  /** Background loop that drains reply ring and dispatches to pending callers. */
  private async startReplyDrainer(): Promise<void> {
    let lastSeen = readWakeCounter(this.replyRing);
    const loop = async (): Promise<void> => {
      for (;;) {
        const messages = drainRing(this.replyRing);
        for (const m of messages) {
          const hdr = readReplyHeader(m.payload);
          const pending = this.pending.get(hdr.requestId);
          if (pending) {
            this.pending.delete(hdr.requestId);
            // Copy the payload before freeing the slot — it aliases SAB.
            const copy = new Uint8Array(m.payload.byteLength);
            copy.set(m.payload);
            freeSlot(this.replyRing, m.slot);
            pending.resolve(copy);
          } else {
            // Reply for a request that timed out / was cancelled.  Free slot.
            freeSlot(this.replyRing, m.slot);
          }
        }
        lastSeen = readWakeCounter(this.replyRing);
        await waitForReadyAsync(this.replyRing, lastSeen);
      }
    };
    await loop().catch((e) => {
      // Drainer crashed — reject all pending.
      const err = e instanceof Error ? e : new Error(String(e));
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
    });
  }
}
