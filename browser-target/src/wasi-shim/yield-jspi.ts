// JSPI yield strategy — uses `WebAssembly.Suspending` /
// `WebAssembly.promising` for engine-native wasm suspension.
//
// AVAILABILITY
//
// - Node v24+ with `--experimental-wasm-jspi --experimental-wasm-exnref`
// - Chrome 137+ (unflagged)
// - Firefox 139+ (behind flag, expected to flip 2026)
// - Safari (in progress, no ship date)
//
// HOW IT WORKS
//
// `WebAssembly.Suspending(fn)` marks a host import as suspending.  When
// wasm calls it and the impl returns a Promise, the engine captures the
// wasm stack as a continuation and returns the Promise to the host.
// Host microtasks drain naturally during the await window.  When the
// Promise settles, the wasm stack resumes with the resolved value.
//
// If the impl returns synchronously (non-Promise), wasm does NOT
// suspend — zero overhead fast path.  This is what makes Suspending
// import almost free in the events-ready case.
//
// `WebAssembly.promising(fn)` does the dual: marks a wasm export so
// JS-callers get a Promise back, even when the export's body is
// otherwise synchronous wasm.  Required at the entry point because
// once wasm suspends, the caller can no longer get a sync return.
//
// SCOPE GUARDS
//
// JSPI requires only-wasm-frames between the promising entry and any
// Suspending import call.  Our harness invokes `_start` directly, no
// JS frames between, so we're safe.  Avoid invoking the wrapped export
// from a JS function that itself goes wasm → js → wasm.

import type { YieldStrategy, SyncPollOneoff, AsyncCapablePollOneoff, SyncFutexWait, AsyncCapableFutexWait } from "./yield-strategy";

interface WebAssemblyWithJspi {
  Suspending: new (fn: Function) => Function;
  promising: (fn: Function) => Function;
}

function getJspi(): WebAssemblyWithJspi | null {
  const wa = WebAssembly as unknown as Partial<WebAssemblyWithJspi>;
  if (typeof wa.Suspending !== "function" || typeof wa.promising !== "function") {
    return null;
  }
  return wa as WebAssemblyWithJspi;
}

export function isJspiAvailable(): boolean {
  return getJspi() !== null;
}

export const jspiYieldStrategy: YieldStrategy = {
  name: "jspi",

  wrapPollOneoff(_syncImpl: SyncPollOneoff, asyncImpl: AsyncCapablePollOneoff): Function {
    void _syncImpl;
    const jspi = getJspi();
    if (!jspi) {
      throw new Error("jspiYieldStrategy: WebAssembly.Suspending unavailable; check engine + flags");
    }
    return new jspi.Suspending(asyncImpl);
  },

  wrapFutexWait(_syncImpl: SyncFutexWait, asyncImpl: AsyncCapableFutexWait): Function {
    void _syncImpl;
    const jspi = getJspi();
    if (!jspi) {
      throw new Error("jspiYieldStrategy: WebAssembly.Suspending unavailable; check engine + flags");
    }
    return new jspi.Suspending(asyncImpl);
  },

  wrapExport(fn: Function): Function {
    const jspi = getJspi();
    if (!jspi) {
      throw new Error("jspiYieldStrategy: WebAssembly.promising unavailable; check engine + flags");
    }
    return jspi.promising(fn);
  },
};
