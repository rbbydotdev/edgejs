// Host worker pool — page-side coordinator.
//
// L2 today: spawns ONE host worker, allocates request+reply SABs, hands
// them to the host worker via postMessage, also hands them to the wasm
// worker (which uses them via its RpcClient).  After ready, RPC is
// SAB-only — no postMessage traffic on the hot path.
//
// L9 (worker_threads) will spawn additional host workers on demand;
// each gets its own pair of rings + a unique hostWorkerId.  The current
// API shape supports that future shape; today it just hard-codes id=0.

import { createRing, type RingConfig } from "../wasi-shim/sab-ring";

// Must match host-worker.ts's RING_CONFIG.
const RING_CONFIG: RingConfig = {
  numSlots: 32,
  slotSize: 4 * 1024,
};

export interface HostWorkerHandle {
  /** Unique id for this host worker.  0 in single-host setup. */
  id: number;
  /** The DedicatedWorker reference; for postMessage if needed. */
  worker: Worker;
  // ── Forward channel (wasm → host) ────────────────────────────────
  /** SAB the WASM-side RpcClient writes requests into. */
  requestSab: SharedArrayBuffer;
  /** SAB the WASM-side RpcClient reads replies from. */
  replySab: SharedArrayBuffer;
  // ── Reverse channel (host → wasm) ────────────────────────────────
  /** SAB the host-side RpcClient writes requests into.
   *  Used for: finalizers, threadsafe function dispatch, future
   *  host→wasm signals. */
  reverseRequestSab: SharedArrayBuffer;
  /** SAB the host-side RpcClient reads replies from. */
  reverseReplySab: SharedArrayBuffer;
  /** Resolves when the host worker has posted `ready`. */
  ready: Promise<void>;
}

let nextId = 0;

/** Spawn a new host worker.  Resolves with the SAB pair the wasm worker
 *  must attach to (via worker.postMessage handoff). */
export function spawnHostWorker(): HostWorkerHandle {
  const id = nextId++;
  const requestRing = createRing(RING_CONFIG);
  const replyRing = createRing(RING_CONFIG);
  // Reverse-direction rings (host → wasm).  Allocated alongside the
  // forward pair so wasm worker can attach to them at the same handoff.
  const reverseRequestRing = createRing(RING_CONFIG);
  const reverseReplyRing = createRing(RING_CONFIG);
  // Vite requires static worker options; can't template the name.
  const worker = new Worker(
    new URL("./host-worker.ts", import.meta.url),
    { type: "module", name: "edge-host" },
  );
  const ready = new Promise<void>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as { kind?: string; hostWorkerId?: number };
      if (data?.kind === "ready" && data.hostWorkerId === id) {
        worker.removeEventListener("message", onMsg);
        resolve();
      }
    };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", (e: ErrorEvent) => {
      reject(new Error(`host worker ${id} error: ${e.message}`));
    });
    // 5s ready timeout — generous for cold start.
    setTimeout(() => {
      reject(new Error(`host worker ${id} ready timeout`));
    }, 5_000);
  });
  worker.postMessage({
    kind: "init",
    requestSab: requestRing.sab,
    replySab: replyRing.sab,
    reverseRequestSab: reverseRequestRing.sab,
    reverseReplySab: reverseReplyRing.sab,
    hostWorkerId: id,
  });
  return {
    id,
    worker,
    requestSab: requestRing.sab,
    replySab: replyRing.sab,
    reverseRequestSab: reverseRequestRing.sab,
    reverseReplySab: reverseReplyRing.sab,
    ready,
  };
}
