# E40 — DEFINITIVE ROOT CAUSE FOUND

## Method

Used the chrome-devtools MCP to drive the failing keepalive scenario
(uv_async-only keepalive, no setInterval).  Two layers of probes:
- JS-side: log `uv_loop_alive` and the loop pointer at the policy's
  `keepalive.ensure()` call
- C++-side: printf in `RunEventLoopUntilQuiescent` showing the env's
  loop pointer and alive value at entry
- Plus the existing wasi-shim `[e40-stack]` probe capturing the
  caller stack of the first 3 poll_oneoff calls

## Captured evidence

Child worker (the failing case):

```
[e40-ka] ensure: loop=0xd0aa80 slot=h=56342400 alive_before=0
        alive_after_init=1 alive_after_ref=1
[e40-rel] enter loop=0x35479a0 timeout_ms=0 alive=0
[poll-probe] n=1 subs=1 minTimeoutNs=1000000 hasSocket=false ...
[e40-stack] n=1 subs=1 minTimeoutNs=1000000 — stack:
    at edge.clock_nanosleep
    at edge.nanosleep
    at edge.std::this_thread::sleep_for
    at edge.RunEventLoopUntilQuiescent
    ...
... (8 such sleep_for polls)
_start.ran 87 ms (returned)
```

## Root cause

**Two different `uv_loop_t` instances.**

- The policy's `keepalive.ensure()` calls
  `__edgeNapiHost.uvAsync.acquireSlot(0)`, which calls
  `uv_default_loop()` to get the loop pointer.  Returns `0xd0aa80`
  (static singleton loop in BSS, initialized by wasi-libuv's
  `__wasm_call_ctors`).
- Edge.js's `Environment::EnsureEventLoop`
  (`src/edge_environment.cc:501-515`) creates a **brand new
  `uv_loop_t`** on the heap (`new (std::nothrow) uv_loop_t() +
  uv_loop_init(loop)`).  Returns `0x35479a0`.
- `RunEventLoopUntilQuiescent` uses `EdgeGetEnvLoop(env)` =
  `env->loop_` = the heap-allocated loop, NOT the default loop.

So our keepalive's `uv_async_t` handle is registered on the default
loop (`0xd0aa80`), but `uv_run` is driven against the env's loop
(`0x35479a0`).  `uv_loop_alive(env_loop) == 0` because no ref'd
handles exist on that loop.

## What follows from this

When `uv_loop_alive(env_loop) == 0` at the top of
`RunEventLoopUntilQuiescent`'s iteration:

1. `uv_run(env_loop, UV_RUN_DEFAULT)` returns immediately (nothing to
   wait for).
2. `more = uv_loop_alive(env_loop) != 0` → `false`.
3. Falls into the idle-drain branch
   (`edge_runtime.cc:1924-1936`): increments `idle_drain_turns`,
   calls `sleep_for(1ms)`, continues outer loop.
4. After 8 such drain iterations, breaks the loop (`beforeExit` +
   final `uv_loop_alive == 0` check at line 1948-1951).
5. Returns 0.  `_start` exits.

`RunCleanup` then runs its own `uv_run(default_loop, UV_RUN_DEFAULT)`
which DOES see our handle (subs=3 with our pipe) — that's the n=9
poll-probe in the traces.  But by then it's too late; we're in
cleanup.

## Why this didn't show up earlier

The `setInterval(100ms)` keepalive in the shipping policy uses JS-side
`setTimeout` / `setInterval` which ARE on the env's loop (libuv timer
machinery via the napi enqueue path).  So setInterval correctly held
the env's loop alive.  When we tried to switch to "Real Path A" (pure
`uv_async_t`), we crossed loops without realizing.

## The fix

Two paths, in order of cleanliness:

**Option A (minimal touch):** expose the env's loop pointer to the
JS-side `uvAsync` runtime so `acquireSlot` registers on the env's
loop, not `uv_default_loop()`.

Implementation:
1. Add `extern "C" uintptr_t unofficial_napi_get_env_loop(napi_env)` to edge
   (or use the existing `napi_get_uv_event_loop` if exported).
2. In `napi-host/index.ts bindInstance`, call this once with the env
   handle, stash the loop ptr on `__edgeNapiHost.envLoop`.
3. In `napi-host/uv-async.ts`, change `acquireSlot`'s
   `uvAsyncInit(loop, ...)` to use the stashed env loop instead of
   `uv_default_loop()`.

This is a pure-C-export + pure-TS fix — one wasm rebuild + no
breaking architectural change.  Each wasm instance has one env, so
the single stashed loop ptr suffices.

**Option B (unify loops, more invasive):** change
`Environment::EnsureEventLoop` to use `uv_default_loop()` instead
of `new uv_loop_t()`.  Then all paths share one loop.  Risk: edge.js
has multi-env support; sharing the default loop across envs could
introduce coupling.  For our single-env-per-wasm setup this is
probably fine, but the design intent was clearly per-env isolation.

**Recommendation: Option A.**  Surgical, correct, doesn't change
edge.js's per-env architecture.  We just need to tell the policy
WHICH loop to use.

## Confidence

Very high.  The evidence is direct: two different loop pointers
logged from the same wasm instance, one from `uv_default_loop()`
(used by acquireSlot) and one from `EdgeGetEnvLoop(env)` (used by
RunEventLoopUntilQuiescent).  alive=1 on one, alive=0 on the other.

This single fix should make Real Path A work end-to-end without
setInterval heartbeat.

## Files used in this investigation

- `browser-target/src/policies/worker-threads-per-thread.ts` — added
  e40-ka diagnostic log to `keepalive.ensure()`
- `browser-target/src/napi-host/uv-async.ts` — added `uvLoopAlive`
  binding so the policy could probe alive state
- `src/edge_runtime.cc` — added `[e40-rel]` printf at entry of
  `RunEventLoopUntilQuiescent` showing loop ptr + timeout_ms + alive
- `browser-target/src/wasi-shim.ts` — temporarily lowered tiny-timeout
  stack threshold to 1, added `[e40-stack]` per-call stack probe
- Test page: a minimal worker with only `parentPort.on('message')` and
  no other handles, driven via the chrome-devtools MCP

All probes revert cleanly via `git checkout --`.
