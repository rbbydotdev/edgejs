# E10: nextTick timing investigation — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-afbcdfd2b8162f532` (port 5185)
**Result:** Root cause identified.  Primary fix shipped (handler now
fires immediately).  Test still fails for an orthogonal reason — the
same `process.exit`-during-poll-suspend bug that E9 targets.

## Reproduction (before fix)

Test `tests/js/unhandled-rejection-fires.js`:
```
handler did not fire
caught:Error: boom
```
Expected: `caught:Error: boom` only.

## Trace (instrumented)

| Time | Event |
|---|---|
| t=28ms | libuv first I/O turn enters `pollOneoff` with ms=1 |
| **t=29ms** | V8 fires `unhandledrejection` macrotask; host dispatcher invokes wasm-side `promiseRejectHandler` which adds to `pendingUnhandledRejections` |
| t=30ms | pollOneoff resumes |
| t=31ms | pollOneoff enters again with ms=95 (the setTimeout(100), 5ms elapsed) |
| t=127ms | timer expires, setTimeout fires → prints "handler did not fire", `process.exit(1)` |
| (after) | `EdgeMakeCallback`'s scope checkpoint finally drains pending rejection → prints "caught:Error: boom" too late |

## Root cause

V8 dispatches `unhandledrejection` as an HTML "notify about rejected
promises" macrotask on the worker.  The host listener
(`installHostPromiseRejectListeners` in
`browser-target/src/napi-host/microtask-ops.ts`) handles it OUTSIDE
any wasm callback scope (wasm is JSPI-suspended in
`pollOneoffAwaitTimer`), so `EdgeRunCallbackScopeCheckpoint` never
runs, so `processTicksAndRejections` never fires — the pending
rejection sits in `pendingUnhandledRejections` until the next libuv
callback fires (the surviving setTimeout(100)).

## Lib emission path

`lib/internal/process/promises.js:259` `unhandledRejection()` only
queues onto `pendingUnhandledRejections` + `setHasRejectionToWarn(true)`.
The actual `process.emit('unhandledRejection', ...)` runs from
`processPromiseRejections()` (L439), which runs inside
`processTicksAndRejections` (`lib/internal/process/task_queues.js:104`).
That's registered via `setTickCallback`.

On the wasm path, `processTicksAndRejections` is only invoked from
C++ `EdgeRunCallbackScopeCheckpoint` → `DrainProcessTickCallback`
(`src/edge_runtime.cc:1355`, called from `EdgeMakeCallback` at
scope_depth==1).  The embedder loop explicitly notes "libuv callbacks
and callback scopes own nextTick draining".

When V8 fires the macrotask outside any wasm scope, there's no
callback scope to drain.

## Fix (small, shipped)

File: `browser-target/src/napi-host/microtask-ops.ts` (~25 lines,
mostly comment).

After `state.promiseRejectCallback(type, promise, reason)` returns,
call `globalThis.process._tickCallback()`.  Lib's bootstrap exposes
`processTicksAndRejections` there, so this drains
`pendingUnhandledRejections` synchronously inside the host event
handler.  Handler now fires at t=29ms instead of t=130ms.

Also wired `postLog` from `browser-target/src/worker.ts` into
`createNapiHost` for diagnostics.

## Verification

Full suite: 27 pass, 0 fail, 0 err, 5 skip (no regression vs E11
baseline).

Targeted test: output progresses from
```
handler did not fire
caught:Error: boom
```
to
```
caught:Error: boom
handler did not fire    ← still fires, but for a different reason
```

The handler IS now firing before the setTimeout, which is what this
investigation was about.  The test still fails because of an
orthogonal bug (next section).

## Orthogonal residual bug (= E9 territory)

`process.exit(0)` called from inside the handler doesn't preempt the
in-flight `pollOneoffAwaitTimer` (`Atomics.waitAsync`).  The timer
expires anyway and the surviving `setTimeout(100)` fires before
`uv_run` sees the stop flag.

Same class as `finalization-registry-runs`.  Fix shape (medium):
route `unofficial_napi_terminate_execution` (currently a no-op at
`browser-target/src/napi-host/unofficial.ts:409`) to
write+notify `sleepSab` in `wasi-shim.ts:946`; then have
`pollOneoffAwaitTimer` re-check exit state on resume and return
early.  E9 attempted this fix.

## Open questions

1. **Why `process.exit(0)` inside the handler doesn't preempt
   setTimeout** — same class as `finalization-registry-runs`.  E9
   targets this; depends on wiring `unofficial_napi_terminate_execution`
   through wasi-shim's sleepSab.
2. **Is `process._tickCallback()` re-entry from a host event
   handler always safe?**  Empirically yes (27/27 baseline still
   passes), but the callback-scope depth isn't incremented here.
3. **Should `unofficial_napi_process_microtasks` also drain
   wasm-side nextTicks?**  Would catch leaked rejections without
   dispatch-time tick calls, but is a broader semantic change.

## Files changed in main

- `browser-target/src/napi-host/microtask-ops.ts` — primary fix
  (dispatch tick drain).
- `browser-target/src/worker.ts` — wire postLog into createNapiHost.
- `tests/js/unhandled-rejection-fires.skip` — updated reason
  explaining the residual process.exit-during-poll-suspend bug.

Test remains `.skip` pending E9's process.exit fix.
