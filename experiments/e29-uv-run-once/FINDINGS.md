# e29 — Per-timer microtask drain (within-iteration fix): FINDINGS

## NOTE — original README hypothesis SUPERSEDED

The original `README.md` proposed `UV_RUN_DEFAULT → UV_RUN_ONCE` as the
fix. That hypothesis was rejected after e27/e28: UV_RUN_ONCE makes the
loop iterate at single-libuv-tick granularity, but two `setTimeout(0)`
callbacks queued together fire in the **same** `uv__run_timers` call —
finer outer-loop granularity wouldn't insert a microtask drain between
them. The shipped design fires ONE timer per JS→C++ round-trip and
yields to V8 microtasks between them via the existing wasm-only-stack
Suspending import (`unofficial_napi_yield_for_microtasks`).

## Verdict: **FIX SHIPPED — closes the within-iteration drop.**

6 targeted tests × 5 runs each, all green. Full browser suite
(42 tests + 3 pre-existing skips) green in one pass.

## Patches

- `patch-timers-js.diff` — `lib/internal/timers.js`: refactor
  `processTimers` to fire at most one timer per call. Returns a
  Number (next-expiry → done) or `null` (more pending → C++ should
  drain microtasks and re-enter with the same `now`). Per-timer
  body extracted into `fireOneInList(list, now)` returning a tristate
  (`'fired'` | `'requeued'` | `'list-empty'`). Preserves every detail
  of the original `listOnTimeout` (async_id, emitBefore/emitAfter,
  AsyncContextFrame exchange, `_repeat` re-insert, `_destroyed`
  housekeeping, `try/finally`, `knownTimersById` cleanup, refcount).
  `listOnTimeout` itself is retained (now a thin loop over
  `fireOneInList`) for any future callers — current callsite is
  `processTimers` only.
- `patch-edge-timers-host-cc.diff` — `src/edge_timers_host.cc`:
  rewrite `CallTimersCallback` to iterate per result. On
  `null/undefined` result, call
  `unofficial_napi_yield_for_microtasks(env)` then re-invoke the JS
  callback with the same `now_value`. On a Number, treat as the
  next-expiry deadline and return. Bail cleanly on
  exception/`napi_ok` mismatch (no infinite loop on unexpected
  result type). Includes `#include "unofficial_napi.h"`. Keeps
  the e28 fix (`kEdgeMakeCallbackNone` flag) in place.

## Stack-safety verification

Call chain at the new yield site (between `EdgeMakeCallback`
invocations inside `CallTimersCallback`):

```
_start (wasm, promising entry)
  -> RunEventLoopUntilQuiescent (wasm/C++, src/edge_runtime.cc)
    -> uv_run (wasm/libuv)
      -> uv__run_timers (wasm/libuv)
        -> Environment::OnTimer (wasm/C++, src/edge_environment.cc:1409)
          -> EdgeTimersHostCallTimersCallback (wasm/C++)
            -> CallTimersCallback (wasm/C++)
              [EdgeMakeCallback ran + returned: JS frames popped]
              -> unofficial_napi_yield_for_microtasks (Suspending) <- OK
```

`Environment::OnTimer` is registered with `uv_timer_start` (see
`src/edge_environment.cc:659`). No JS frames between `_start` and
the yield site after `EdgeMakeCallback` returns. JSPI v2 stack-only
constraint satisfied — same chain shape as the SHIPPED `cf306ee4`
yield call site at `src/edge_runtime.cc:1865`. No `SuspendError`
observed in any run.

## Targeted test x 5 runs

| Test                                  | Runs | Pass | Fail |
|---------------------------------------|------|------|------|
| microtask-before-timer                | 5    | 5    | 0    |
| nexttick-before-microtask             | 5    | 5    | 0    |
| promise-chain-drains-fully            | 5    | 5    | 0    |
| await-resumes-as-microtask            | 5    | 5    | 0    |
| queuemicrotask-orders-with-promise    | 5    | 5    | 0    |
| e29-canary-within-iteration           | 5    | 5    | 0    |

The canary previously (e28) passed 1/5; now 5/5. All five existing
ordering tests remain green (no regression vs. e28's targeted run).

(One transient browser/Vite navigation error was observed in an
earlier exploratory canary loop — disappeared on the very next run
and never recurred across the formal 5-run sample. Not counted; not
a test failure.)

## Full suite

```
browser-test-runner: 45 test(s)
42 pass, 0 fail, 0 err, 3 skip
```

The 3 skips are pre-existing and unrelated to this work
(`fs-readfile-self` F-8 finding, `override-inspector` browser-runner
gap, `webserver` long-running HTTP). No regressions.

## State of main (left in place per "Path A, both fixes ship")

- `lib/internal/timers.js` — patched (per-timer dispatch).
- `src/edge_timers_host.cc` — patched (per-call yield + retained
  e28 `kEdgeMakeCallbackNone`).
- `build-wasix/edgejs.wasm` and `browser-target/edgejs.wasm` —
  rebuilt and md5-matched
  (`57f59c2c1038867683af3cd46c39fab5`, 26550376 bytes, May 25 16:14).
- `tests/js/e29-canary-within-iteration.{js,stdout}` — **kept in tree**
  (9-line test file; covers a silent-data-loss class of bug with no
  other suite coverage).  Recommended as permanent regression net.
  Remove if undesired.
- `wasix/build-wasix.sh` — patched with two infra fixes discovered
  during this experiment: (a) auto-deploy `cp` of built wasm to
  `browser-target/edgejs.wasm` (the runner's read path; previously
  silent foot-gun that invalidated e28's first run); (b) skip
  `setup-wasix-deps.sh` when deps are already populated, with
  `SKIP_DEPS_UPDATE` env-var override (worked around a global
  `url.git@github.com:.insteadof https://github.com/` rewrite in the
  user's gitconfig that silently undid the script's HTTPS switch).
- No other files modified.

## Why this works (one-paragraph summary)

Real Node drains V8 microtasks at `InternalCallbackScope` unwind
boundaries — the C++/JS boundary itself doubles as a microtask
checkpoint via `MicrotasksScope`. On the browser target we don't
own V8's `kExplicit` isolate, so we can't drain its host microtask
queue from JS frames; the only available checkpoint is suspending
the whole wasm stack via JSPI (`WebAssembly.Suspending`), which V8's
default `kAuto` policy uses as an implicit checkpoint. JSPI v2
forbids JS frames between the promising entry (`_start`) and the
Suspending import. e23/e23-redo confirmed yielding **before**
`uv_run` works; e27 confirmed the within-iteration case
(`uv__run_timers` batches both due timers in one C++ call) was
still broken because the wasm stack between fires contains
`processTimers` JS frames. This patch shrinks each
`EdgeMakeCallback` round-trip to exactly one timer. Between
round-trips, the C++ stack is pure wasm — yielding is legal and V8's
kAuto policy drains microtasks before we re-enter JS for the next
timer.
