# E35 — uv_async_t keepalive probe: findings

Live probe ran end-to-end (Vite + Playwright Chromium with JSPI).
`probe.mjs` patched `browser-target/src/worker.ts` in place with a
diagnostic block injected right after `napi.bindInstance`, ran through
the existing dev-server harness, scraped DOM `#log` lines for `[e35]`
markers, then reverted `worker.ts`.  Verified clean: `git status` shows
no diff to `worker.ts` after the run.

Reproduce: `cd experiments/e35-uv-async-keepalive-probe && node probe.mjs`.

## Captured probe output

```
[e35] BASELINE uv_loop_alive(loop=13675088) = 0  (expected 1 if wq_async counts)
[e35] TEST A (cb=0): init rc=0 alive_after_init=1 alive_after_ref=1
[e35] TEST B (cb=1): init rc=0 alive_after_init=1 alive_after_ref=1
[e35-user] t=33 bootstrap-start
[e35] TEST C (t=209ms): pre-send alive=1 send(hA) rc=0 send(hB) rc=0
[e35-user] t=1038 timer-1000ms fired
[e35] sentinel: _start ran 1145 ms (exit=0)
```

## Verified

- **`uv_async_init` works correctly at the libuv-wasix level.**
  `uv_loop_alive(loop)` returns 1 immediately after `uv_async_init`
  AND after subsequent `uv_ref`.  The handle IS counted by
  `active_handles`.  NULL cb (TEST A) and non-NULL cb (TEST B)
  behave identically — both make the loop alive.

- **`uv_async_send` returns rc=0.**  The host's call into the wasm
  export succeeds.

- **Baseline `uv_loop_alive` is 0** before any user handle is created.
  Confirms `wq_async` (libuv's thread-pool internal async handle,
  init'd by `uv_loop_init`) is NOT counting as a ref'd handle —
  matches Node's behavior of unref'ing wq_async at loop init so the
  workpool doesn't keep the loop alive when idle.

## What this experiment did NOT prove

- The test ran for ~1145ms total but that was driven by the user
  script's explicit `setTimeout(...,1000)` + `process.exit(0)`, not by
  the keepalive holding the loop open until wake.  This test was
  insufficient to confirm whether `uv_async_send` actually wakes a
  parked `poll_oneoff`.  See `e36-async-wfd-probe/` for the follow-up
  that traced the wake path and identified an in-tree wasi-shim bug
  (and the surprising conclusion that fixing it doesn't enable
  Real Path A end-to-end — there's more downstream).

## Implication

The libuv-wasix layer is NOT the bug.  `uv_async_t` keepalive
primitives work correctly there.  The wake-up chain breaks downstream
in the wasi-shim's `poll_oneoff` race-of-waiters (see e36 FINDINGS for
the exact spot) AND somewhere further still that the e36 fix alone
doesn't resolve.

The currently-shipping `setInterval(100ms)` keepalive in
`policies/worker-threads-per-thread.ts` is a pragmatic correct
fallback: the 100ms timer ticking IS the wake mechanism, sidestepping
the broken `uv_async_send` → `poll_oneoff` wake chain.  Latency cap is
100ms; correctness is reliable.
