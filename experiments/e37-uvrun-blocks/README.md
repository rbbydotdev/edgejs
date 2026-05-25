# E37 — Does `uv_run(UV_RUN_DEFAULT)` block on a ref'd async handle alone?

## Hypothesis

Per Phase 1 research (R1, R2, R3), the libuv + wasi-libc + wasi-shim stack
SHOULD support a single ref'd `uv_async_t` keeping `uv_run` blocked
indefinitely.  Confirmed by code reading.  But not yet verified empirically.

## Method

Patch `worker.ts` to inject a probe BEFORE `_start` runs.  The probe:

1. Allocates a `uv_async_t` in wasm memory.
2. `uv_async_init(loop, handle, NULL)`.
3. `uv_ref(handle)`.
4. Logs `t=N alive=1 about-to-call-uv_run`.
5. From a JS `setTimeout(500ms)`, calls `uv_async_send(handle)` then
   `uv_close(handle)` AND closes any wq_async to ensure no other handles
   are pending.
6. Calls `uv_run(loop, UV_RUN_DEFAULT)` directly (BYPASSING _start
   entirely — we want to test libuv in isolation, not edge.js's
   RunEventLoopUntilQuiescent).
7. After `uv_run` returns, logs `t=N uv_run returned`.

Crucially, the test script (`-e` source) is empty (just `process.exit(0)`)
because we DON'T want _start to run.  Actually — better: we don't run the
user script at all in this probe.  The probe block replaces the call to
`startFn()`.

## Success criteria (defined BEFORE running)

| Observation | Conclusion |
| --- | --- |
| `uv_run returned` logged ~500ms after `about-to-call-uv_run` | ✓ libuv blocks and wakes correctly under wasi.  Real Path A IS feasible.  Bug is elsewhere (e.g., in edge.js's RunEventLoopUntilQuiescent integration or the policy ↔ worker.ts wake bridge). |
| `uv_run returned` logged < 50ms after `about-to-call-uv_run` | ✗ wasi-shim's poll_oneoff does NOT block on a single pipe-read sub.  Drill into pollOneoffAsyncImpl in e38. |
| `uv_run` never returns (timeout after 25s) | ✗ wake doesn't fire — but blocking works.  `uv_async_send`'s write reaches the pipe but poll_oneoff's waitAsync never resolves.  Drill into wakeCounter / waitAsync race in e38. |
| Anything else (e.g. error logged, timing chaos) | Methodology issue — refine the probe before drawing conclusions. |

## Run

```sh
cd experiments/e37-uvrun-blocks
node probe.mjs
```

Output goes to stdout.  Patch is in-memory; `worker.ts` is reverted in
finally.  Verify `git status` shows no changes after.
