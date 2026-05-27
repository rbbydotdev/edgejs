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

import { createRing } from "../wasi-shim/sab-ring";
import { HOST_RPC_RING_CONFIG as RING_CONFIG } from "./rpc-protocol";

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
  /** Shared-wake SAB — single Int32Array slot at index 0 that BOTH
   *  channels (forward-reply publishes AND reverse-request publishes)
   *  bump via `Atomics.add` + `Atomics.notify`.  The wasm-side
   *  `SyncRpcClient` waits on this single address so a reverse-request
   *  arriving while the wasm thread is blocked on its forward-reply
   *  reliably wakes the wait loop.  Design rationale:
   *  experiments/r6-nested-sync-rpc/FINDINGS.md (re-entrant wait loop)
   *  and experiments/r1-reverse-during-forward/FINDINGS.md (race-free
   *  single-shared-wake pattern). */
  sharedWakeSab: SharedArrayBuffer;
  /** Resolves when the host worker has posted `ready`. */
  ready: Promise<void>;
  /** F-1: SAB backing the host's napi memory.  Lets probes verify the
   *  napi handlers wrote handles correctly.  Set after `ready` resolves.
   *  In F-2 this becomes the SHARED wasm linear memory. */
  napiMemorySab?: SharedArrayBuffer;
}

let nextId = 0;

export interface SpawnHostWorkerOptions {
  /** Optional JS source string evaluated inside the host worker AFTER
   *  init but BEFORE the ready signal. Used by deployments to install
   *  per-host-worker globals (notably `__edgeChildProcessExecutor` for
   *  the child-process-via-executor policy's async path). The script
   *  runs in host-worker globalThis context, so any `globalThis.X = Y`
   *  assignments are visible to subsequent RPC handlers. */
  bootScript?: string;
}

/** Spawn a new host worker.  Resolves with the SAB pair the wasm worker
 *  must attach to (via worker.postMessage handoff). */
export function spawnHostWorker(opts: SpawnHostWorkerOptions = {}): HostWorkerHandle {
  const id = nextId++;
  const requestRing = createRing(RING_CONFIG);
  const replyRing = createRing(RING_CONFIG);
  // Reverse-direction rings (host → wasm).  Allocated alongside the
  // forward pair so wasm worker can attach to them at the same handoff.
  const reverseRequestRing = createRing(RING_CONFIG);
  const reverseReplyRing = createRing(RING_CONFIG);
  // Single-shared-wake SAB.  4 bytes (one Int32 slot at index 0).
  // Every host-side publish (forward reply OR reverse request) bumps
  // this counter; wasm's SyncRpcClient `Atomics.wait`s on it so a
  // reverse request arriving during a forward-blocked wait wakes the
  // loop.  See experiments/r6-nested-sync-rpc/FINDINGS.md.
  const sharedWakeSab = new SharedArrayBuffer(4);
  // Vite requires static worker options; can't template the name.
  const worker = new Worker(
    new URL("./host-worker.ts", import.meta.url),
    { type: "module", name: "edge-host" },
  );
  const handle: HostWorkerHandle = {
    id,
    worker,
    requestSab: requestRing.sab,
    replySab: replyRing.sab,
    reverseRequestSab: reverseRequestRing.sab,
    reverseReplySab: reverseReplyRing.sab,
    sharedWakeSab,
    ready: undefined as unknown as Promise<void>,
  };
  const ready = new Promise<void>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as { kind?: string; hostWorkerId?: number; napiMemorySab?: SharedArrayBuffer };
      if (data?.kind === "ready" && data.hostWorkerId === id) {
        if (data.napiMemorySab) handle.napiMemorySab = data.napiMemorySab;
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
    sharedWakeSab,
    hostWorkerId: id,
    bootScript: opts.bootScript,
  });
  handle.ready = ready;
  return handle;
}
