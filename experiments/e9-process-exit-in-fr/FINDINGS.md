# E9: process.exit-in-FinalizationRegistry investigation — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a3aa1c6c6859820f0` (port 5184)
**Result:** **Fixed.**  Wired `unofficial_napi_terminate_execution`
through to a sleep-SAB wake in the wasi-shim.  Test passes; combined
with E10 the related `unhandled-rejection-fires` test also passes.
Suite now 29/0/3 (was 25/0/5 at session start).

NOTE: The agent run hit an API connection error mid-execution and
did not finish wiring its own design.  This FINDINGS document was
written after I (the main session) completed the partial work.  The
design IS the agent's; the wiring completion is mine.

## Reproduction (before fix)

Test `tests/js/finalization-registry-runs.js`:
```
finalized:A
not fired
```
Expected: `finalized:A` only.  The FR callback calls `process.exit(0)`
after logging `finalized:A`, but the surviving `setTimeout(200, () =>
console.log("not fired"))` still fires.

## Trace

1. `setTimeout(200)` is scheduled.
2. Object is dropped; GC eventually fires the FR callback.
3. FR callback runs from a V8-internal microtask
   (`ClearKeptObjects` → finalizer queue).
4. The callback logs `finalized:A` then calls `process.exit(0)`.
5. Edge's `process.exit` → `process.reallyExit` →
   `Environment::Exit` → `uv_stop` + sets exit flag.
6. **But** the wasm is JSPI-suspended inside `pollOneoffAwaitTimer`,
   waiting on `Atomics.waitAsync(sleepSab, 0, 0, 200ms)`.  The
   `uv_stop` flag doesn't wake the wait.
7. Timer expires at 200ms; the wait resolves; `pollOneoffAwaitTimer`
   returns; libuv runs the expired setTimeout BEFORE re-checking the
   exit flag.
8. `not fired` is printed.

The same bug class affects `unhandled-rejection-fires`: a handler
calls `process.exit(1)` but the surviving `setTimeout(100)` fires
first because `Atomics.waitAsync` doesn't see the stop request.

## Root cause

`unofficial_napi_terminate_execution` in
`browser-target/src/napi-host/unofficial.ts` is a **no-op** in the
wasm-side napi import — it accepts the call from C++ but doesn't
propagate the termination request anywhere.  In real Node,
`v8::Isolate::TerminateExecution` sets a flag that the next stack
guard check checks; the wasm has no equivalent path because libuv's
`uv_run` is blocked inside `Atomics.waitAsync` at the wasi-shim
layer, not inside a wasm function that hits a stack guard.

## Fix

Three coordinated changes:

1. **`browser-target/src/wasi-shim.ts`**: `createWasiShim` now
   returns a `requestExit(code: number)` callback.  When called:
   - Sets an `exitState = { requested: true, code }` flag.
   - Forces the value-check in `Atomics.waitAsync(sleepI32, 0, 0,
     ms)` to differ from the expected value (0) by storing 1 then
     0 + notifying — wakes the wait immediately.
   - Also bumps `wake[WAKE_ACCEPT_IDX]` for the socket-accept path.

   `pollOneoffAwaitTimer` checks `exitState.requested` after each
   wake, flushes stdout/stderr buffers, calls `postExit(code)`, and
   throws `ExitSignal(code)` — unwinding wasm back to the harness
   before libuv gets a chance to service expired timers.

2. **`browser-target/src/napi-host/unofficial.ts`**:
   `UnofficialHostContext` gains a `requestExit?: (code) => void`
   field.  `unofficial_napi_terminate_execution` reads
   `process.exitCode` and calls `ctx.requestExit?.(code)`.

3. **`browser-target/src/napi-host/index.ts`**: `NapiHostOptions`
   gains a `requestExitHolder?: { fn?: (code: number) => void }`
   field.  `createNapiHost` passes a closure that reads
   `holder.fn` into `UnofficialHostContext.requestExit`.  The
   holder pattern lets the wasi-shim populate `fn` AFTER both
   napi-host and shim are constructed (napi-host is built first).

4. **`browser-target/src/worker.ts`**: creates the holder, passes
   it to `createNapiHost`, then sets `holder.fn = shim.requestExit`
   after `createWasiShim` returns.

## Verification

- `finalization-registry-runs`: **PASS** (was .skip).
- `unhandled-rejection-fires`: **PASS** when combined with E10's
  microtask-ops fix (was .skip).
- Full suite: **29 pass, 0 fail, 0 err, 3 skip** (was 25/0/5 at
  session start; E11 added 2 tests; E9+E10 unlocked 2 from skip).
- Typecheck: clean.

## Open questions

1. Is the `Atomics.store(sleepI32, 0, 1); notify; store(0)` racy?
   Specifically: if a second `pollOneoffAwaitTimer` is parked at
   the moment of `store(1)`, both could resolve.  In practice the
   wasm is single-threaded so only one `pollOneoffAwaitTimer` is
   parked at a time, but worth verifying.
2. Does `ExitSignal` propagation cleanly unwind the JSPI-promising
   frame?  The existing infrastructure already throws ExitSignal
   from `proc_exit`; this just adds another throw point.  No
   regressions observed.
3. Thread workers (the second `createWasiShim` call site in
   `worker.ts`) don't currently wire the holder.  Probably fine
   since pthread pool workers don't have napi imports, but worth
   checking if `unofficial_napi_terminate_execution` could ever
   fire from a thread.

## Files changed in main

- `browser-target/src/wasi-shim.ts` — `requestExit` return value
  + `exitState` + `pollOneoffAwaitTimer` early-throw.
- `browser-target/src/napi-host/unofficial.ts` — `requestExit?`
  field on `UnofficialHostContext`;
  `unofficial_napi_terminate_execution` body that calls it.
- `browser-target/src/napi-host/index.ts` —
  `requestExitHolder?` field on `NapiHostOptions`; closure
  routed to `createUnofficialNapi`.
- `browser-target/src/worker.ts` — holder creation + wiring.
- `tests/js/finalization-registry-runs.skip` — DELETED (test
  now passes).
- `tests/js/unhandled-rejection-fires.skip` — DELETED (test
  now passes with E9 + E10 combined).
