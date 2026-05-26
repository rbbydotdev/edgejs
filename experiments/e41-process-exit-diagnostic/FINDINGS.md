# E41 — process.exit not honored / wasi-shim line-1122 — findings

## Headline

Two entangled bugs, one fix each:

1. **Wasi-shim line-1122 (`pollOneoffAsyncImpl` branching)**: the timer-only
   fast path was taken even when pipe-read subs were present, dropping
   pipe wake-ups on the floor. **Fix**: tighten the condition to
   `&& r.pipeReadSubs.length === 0` (one-line patch).

2. **`process.exit()` not honored when called from a libuv callback**:
   `Environment::Exit` set the env-exiting flag and called `uv_stop` +
   `unofficial_napi_terminate_execution`, but neither could wake an
   already-blocking `uv__io_poll`. In the wasm V8 build, V8's
   `TerminateExecution()` does NOT interrupt JS at napi callback
   boundaries, so JS execution continued past `process.exit(0)`, and
   `uv_stop` only sets `loop->stop_flag` (checked at the top of the
   next iteration -- doesn't unblock a poll already in flight).
   **Fix**: add a dedicated `uv_async_t exit_wake_async_` to
   `Environment`, registered on the env loop in `EnsureEventLoop`;
   `Environment::Exit` calls `uv_async_send` on it after setting the
   exit flag. The wfd write wakes `io_poll`, the iteration completes,
   `stop_flag` is checked at the top of the next iteration, and the
   loop exits.

## Why these were entangled

Pre-fix #1, `unhandled-rejection-fires` passed *because* the buggy
timer-only path happened to give `RunEventLoopUntilQuiescent` an
opportunity to honor the exit flag before the safety timer fired.
Applying fix #1 in isolation broke the test by switching to
race-of-waiters with different timing — exposing bug #2.

## Reproduction (pre-fix)

1. Apply line-1122 patch to wasi-shim.
2. Run `unhandled-rejection-fires` test.
3. Expected: `caught:Error: boom\n` (single line, exit 0).
4. Actual: `caught:Error: boom\nhandler did not fire\n` (exit 1) — the
   100ms safety timer fired before the loop noticed the exit flag.

## Mechanism (definitive, via instrumentation)

C++ stderr probes in `RunEventLoopUntilQuiescent` traced exactly when
the exit flag became visible:

```
[e41-c++] iter=1 top exiting=0 envreq=0
[e41-c++] iter=1 post-yield exiting=0 envreq=0    ← handler NOT run during yield
[e41-c++] iter=1 pre-uv_run alive=1
                                                  ← handler fires here (during uv_run)
                                                  ← safety timer fires ~100ms later
[e41-c++] iter=1 post-uv_run exiting=1 envreq=1 alive=0
```

JS probes confirmed `process.reallyExit` returns to JS and execution
continues past `process.exit(0)` — definitively showing
`TerminateExecution()` is a no-op at napi boundaries in this wasm V8
build. (Verified across three contexts: setTimeout, plain
queueMicrotask, and unhandledRejection. setTimeout and queueMicrotask
DON'T hit bug #2 because they happen outside an already-blocked
io_poll, while unhandledRejection fires from inside one.)

## Fix details

**Wasi-shim** — `browser-target/src/wasi-shim.ts:1122`:

```ts
if (minTimeoutNs >= 0 && !hasSocketSub && r.pipeReadSubs.length === 0) {
  return pollOneoffAwaitTimer(...);
}
```

**Edge runtime** — `src/edge_environment.{h,cc}`: added
`exit_wake_async_` (`uv_async_t`), initialized in `EnsureEventLoop`
via `EnsureExitWakeHandleLocked`, signaled in `Environment::Exit`
before invoking the process exit handler, closed in
`ClosePerEnvHandlesLocked` via `CloseExitWakeHandleLocked`,
`ReleaseEventLoop` waits for `exit_wake_async_closed_` alongside the
existing threadsafe-immediate close.

## Validation

- `unhandled-rejection-fires` — PASS (was FAIL with line-1122 alone).
- `e34-keepalive-no-heartbeat` — PASS (worker_threads Real Path A unaffected).
- `worker-threads-message-roundtrip`, `worker-threads-spawn-exit` — PASS.
- Full suite: 71 pass / 0 fail / 0 err / 3 skip.

## Knowledge captured

1. **`isolate->TerminateExecution()` is a no-op at napi callback
   boundaries in our wasm V8 build.** This is the root cause of why
   `nop()` (the stack-guard probe in lib's `process.exit`) doesn't
   throw the termination exception. Whether this can be fixed at the
   V8 / wasm-build layer is a separate question; the workaround
   (uv_async wake + flag check at iteration top) is sufficient for
   correctness.

2. **`uv_stop` alone cannot wake a blocked `uv__io_poll`.** It only
   sets `loop->stop_flag`, checked at the top of the outer while loop.
   In single-threaded wasi-libuv, you must register a `uv_async_t` and
   `uv_async_send` it to force `io_poll` to return.

3. **The 16-await `unofficial_napi_yield_for_microtasks` does NOT
   drain wasm-side unhandledRejection emits.** Those fire from a
   subsequent `EdgeRunCallbackScopeCheckpoint` triggered inside
   `uv_run` (typically from a timer callback), not from the pre-uv_run
   microtask yield.

## Reproduce

```sh
node experiments/e41-process-exit-diagnostic/run-probe-with-stderr.mjs \
     experiments/e41-process-exit-diagnostic/probe-4-flags.js
```

The probe files in this directory remain for future investigators:
- `probe-1-reallyexit.js` — instruments `reallyExit` to confirm
  TerminateExecution doesn't interrupt
- `probe-2-context.js` — process.exit from setTimeout (works fine)
- `probe-3-microtask.js` — process.exit from plain microtask (works fine)
- `probe-4-flags.js` — samples `process._exiting` at multiple points
- `probe-5-wake-test.js` — disproves the "new timer wakes the poll"
  hypothesis
