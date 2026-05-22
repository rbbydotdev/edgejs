// Bridge worker — Emscripten PROXY_TO_PTHREAD analog for our setup.
//
// Why this exists.  Our previous architecture put the wasm runtime AND
// the cross-worker state (FS snapshot loader, layered FS adapter) on
// the same worker.  A JSPI re-entry sync wait on that worker froze
// every responsibility — including FS loads pool workers were waiting
// on — for the duration of the wait.  See NOTES.md
// `jspi-re-entry-blocks-microtasks` and `runtime-on-separate-worker`.
//
// This worker owns:
//   - The layered FS adapter (bundled-fs + opfs).
//   - The FS snapshot loader: drains the SAB request ring, fetches via
//     the adapter, publishes file bytes into the snapshot.
//
// It does NOT host wasm.  Its JS event loop stays free even when the
// runtime worker is mid-Atomics.wait.  Pool workers' cold-miss FS
// loads continue to make progress regardless of runtime state.
//
// Lifecycle:
//   1. Page spawns this worker.
//   2. Worker creates the FS snapshot SAB, builds the FS adapter.
//   3. Worker posts "bridge-ready" with the SAB back to page.
//   4. Page spawns the runtime worker, hands it the same SAB.
//   5. Worker runs its drain loop forever — `Atomics.waitAsync` on the
//      ring wake counter, drain on wake.

import { FsSnapshotRegistry } from "./wasi-shim/fs-snapshot-sab";
import { createBundledFs } from "./host/fs/adapters/bundled";
import { createOpfsFs } from "./host/fs/adapters/opfs";
import { layered } from "./host/fs/adapters/layered";

declare const self: DedicatedWorkerGlobalScope;

function post(kind: string, payload: Record<string, unknown> = {}) {
  self.postMessage({ kind, ...payload });
}
function log(text: string, level: "info" | "warn" | "err" = "info") {
  self.postMessage({ kind: "log", text: `[bridge] ${text}`, level });
}

async function main() {
  const bundledFs = createBundledFs({
    log: (line) => log(line, "info"),
  });
  const opfsFs = await createOpfsFs({
    log: (line) => log(line, "info"),
  });
  const fs = layered(bundledFs, opfsFs);

  const fsSnapshot = FsSnapshotRegistry.create();

  // Announce we're ready with the SAB.  Page passes this to the
  // runtime worker on spawn.
  post("bridge-ready", { fsSnapshotSab: fsSnapshot.sharedBuffer });
  log("FS adapter built; snapshot SAB published; drain loop starting", "info");

  function drainOnce(): void {
    let req;
    while ((req = fsSnapshot.drainNext()) !== null) {
      const res = fs.open(req.path, {});
      if (!res.ok) {
        fsSnapshot.publishError(req.slotIdx, res.errno);
        fsSnapshot.markConsumed(req.ringIdx);
        continue;
      }
      const handle = res.value;
      const statRes = fs.fstat(handle);
      const size = statRes.ok ? statRes.value.size : 1 << 20;
      const buf = new Uint8Array(size);
      let off = 0;
      while (off < buf.length) {
        const slice = buf.subarray(off);
        const r = fs.read(handle, slice);
        if (!r.ok) {
          fsSnapshot.publishError(req.slotIdx, r.errno);
          fs.close(handle);
          fsSnapshot.markConsumed(req.ringIdx);
          off = -1;
          break;
        }
        if (r.value === 0) break;
        off += r.value;
      }
      if (off < 0) continue;
      fs.close(handle);
      fsSnapshot.publishLoaded(req.path, buf.subarray(0, off), req.slotIdx);
      fsSnapshot.markConsumed(req.ringIdx);
      log(`[fs-snapshot] loaded ${req.path} (${off}B) slot=${req.slotIdx}`, "info");
    }
  }

  // First sweep before any wait — covers the case where the runtime
  // worker (or one of its pool workers) enqueued before we got here.
  drainOnce();
  while (true) {
    const h = fsSnapshot.ringWakeHandle();
    const waitAsync = (Atomics as unknown as {
      waitAsync?: (i32: Int32Array, idx: number, val: number) =>
        { async: boolean; value: Promise<string> | string };
    }).waitAsync;
    if (!waitAsync) {
      // Engines without waitAsync (very old) fall back to a sleep
      // poll loop so we don't busy-spin.  Modern Chrome/Node have it.
      await new Promise((r) => setTimeout(r, 5));
      drainOnce();
      continue;
    }
    const result = waitAsync(h.i32, h.idx, h.seen);
    if (result.async) await result.value;
    drainOnce();
  }
}

main().catch((e: unknown) => {
  const err = e as Error;
  log(`[bridge] fatal: ${err.message ?? String(e)}\n${err.stack ?? ""}`, "err");
});
