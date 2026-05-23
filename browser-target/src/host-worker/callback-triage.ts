// Callback triage — opt-out list for known hot-path callback identifiers.
//
// Policy (from experiments/e4-callback-realistic/FINDINGS.md):
//   - Every callback created via `napi_create_function` etc. goes through
//     the reverse-RPC dispatcher by default (~31 µs median per fire,
//     bundled-args path).
//   - That cost is fine for setup-time callbacks, JS-facing method
//     handlers, error callbacks, fs/net continuation callbacks, etc.
//   - It is NOT viable for hot-path callbacks: stream `_read`, http
//     parser callbacks (llhttp), v8 inspector, async-hook hooks.  E4
//     measured per-iter overheads in the 100s of µs range for realistic
//     "many calls per request" patterns.
//   - The two-tier dispatch end-state is: callbacks whose caller-symbol
//     matches an entry in this allow-list get a direct in-process
//     funcref invocation (via the wasm-table Proxy already in
//     napi-host/index.ts:570-610) instead of going via RPC.
//
// Today this Set is intentionally EMPTY.  Every callback goes via the
// RPC dispatcher.  We only add entries when:
//   1. A specific call site has been measured and is provably the
//      dominant contributor to a request's overhead, AND
//   2. The in-process path is acceptable from a security / isolation
//      standpoint (no JSPI re-entry interaction we can't reason about).
//
// Per-op handlers in this batch MUST NOT consult `isHotPathCallback`
// at create-time — they always wrap via `makeHostSideCallbackClosure`.
// The in-process tier is a future optimization once we have actual
// hot-path identifiers and a working measurement harness.
//
// API surface:
//   - HOT_PATH_CALLBACK_IDENTIFIERS  : Set<string>
//   - isHotPathCallback(callerSymbol): boolean
//
// `callerSymbol` is intended to be an identifier the dispatcher (or its
// caller) can compute cheaply at call time — e.g. the property name that
// the JS-side callback was assigned to on a known prototype, or a tag
// installed by a higher-level wrapper (`stream._read`, `llhttp.onUrl`).
// Stringly-typed by design; the cost of resolving a real identifier
// per callback fire is what we'd be moving the callback in-process to
// avoid, so any lookup here must be cheap (Set.has → O(1)).

/** Hot-path callback identifiers (caller-symbol form).
 *
 *  EMPTY by default.  Populated only when a callback identifier has
 *  been measured to dominate a request's overhead AND the in-process
 *  path is acceptable.  See module header for policy. */
export const HOT_PATH_CALLBACK_IDENTIFIERS: Set<string> = new Set<string>();

/** Triage decision: is this callback identifier on the in-process tier?
 *
 *  Returns `false` until a measurement justifies adding the identifier
 *  to the allow-list.  Per-op napi handlers SHOULD NOT call this — the
 *  dispatcher itself (or, eventually, a higher-level routing layer)
 *  is the only consumer.  See `callback-dispatch.ts` for usage. */
export function isHotPathCallback(callerSymbol: string): boolean {
  return HOT_PATH_CALLBACK_IDENTIFIERS.has(callerSymbol);
}
