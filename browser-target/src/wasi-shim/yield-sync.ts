// Sync yield strategy — no actual yielding.  This is the legacy /
// fallback path used when JSPI isn't available (Node v22, older
// browsers, etc.).  The wasi-shim's sync `poll_oneoff` uses
// `Atomics.wait` to block the JS thread until a wake or timeout.
//
// Consequence: host-async work scheduled while the wasm event loop is
// running (CompressionStream, fetch, postMessage) won't make progress
// until `_start` returns and Node's outer event loop turns.  Pre-JSPI
// architectural reality.

import type { YieldStrategy, SyncPollOneoff, AsyncCapablePollOneoff, SyncFutexWait, AsyncCapableFutexWait } from "./yield-strategy";

export const syncYieldStrategy: YieldStrategy = {
  name: "sync",

  wrapPollOneoff(syncImpl: SyncPollOneoff, _asyncImpl: AsyncCapablePollOneoff): Function {
    void _asyncImpl;
    return syncImpl;
  },

  wrapFutexWait(syncImpl: SyncFutexWait, _asyncImpl: AsyncCapableFutexWait): Function {
    void _asyncImpl;
    return syncImpl;
  },

  wrapExport(fn: Function): Function {
    return fn;
  },
};
