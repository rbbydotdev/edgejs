## E35 — uv_async_t keepalive probe

Empirically determine why `uv_async_init(loop, handle, cb=NULL) + uv_ref(handle)`
does NOT keep `_start`'s `uv_run` from returning in our wasi-libuv build,
despite all prior reading of the libuv source suggesting it should.

### Hypotheses being tested

1. **Registration broken** — `uv_async_init` succeeds, but `loop->nfds`
   doesn't increment OR `uv__has_active_handles` doesn't count the handle
   → `uv_loop_alive` returns 0 immediately after `uv_ref`.
2. **Registration works, poll doesn't wait** — `uv_loop_alive` returns 1
   after `uv_ref`, but the async pipe fd isn't in poll_oneoff's wait set
   → `uv_run` iterates without blocking, eventually exits via grace
   window. Test: timed `uv_async_send` from host should NOT wake parked
   poll if pipe isn't tracked.
3. **Both work, edge.js exits early** — `uv_loop_alive` stays 1
   indefinitely, `uv_async_send` does wake poll → bug is in edge.js's
   `RunEventLoopUntilQuiescent` quiescence detection logic, not libuv.

### Probe sequence

The probe runs all sequences end-to-end and logs results so we can
distinguish the hypotheses:

```
[e35] BASELINE
[e35]   uv_loop_alive(loop) before any handle = ?
[e35]
[e35] TEST A: NULL cb (current Path A)
[e35]   uv_async_init(loop, hA, cb=0) → rc=?
[e35]   uv_loop_alive(loop) after init = ?
[e35]   uv_ref(hA); uv_loop_alive(loop) = ?
[e35]
[e35] TEST B: non-NULL cb (uses an EXISTING wasm funcref with
[e35]   compatible signature — uv__work_done if exported, else first
[e35]   funcref index in the indirect table whose type matches
[e35]   (i32) → void)
[e35]   uv_async_init(loop, hB, cb=<index>) → rc=?
[e35]   uv_loop_alive(loop) after init = ?
[e35]   uv_ref(hB); uv_loop_alive(loop) = ?
[e35]
[e35] TEST C: wake timing
[e35]   Park: schedule a process.exit(0) at +1000ms (keeps user JS
[e35]     alive 1s) AND nothing else.  uv_run should block on the
[e35]     uv_async + the timer.
[e35]   At +500ms (after _start has been blocking 500ms),
[e35]     host calls uv_async_send(hB).
[e35]   Measure: time from send to next loop iteration (would be
[e35]     observable via a setImmediate that logs a timestamp).
[e35]   If wake works: setImmediate fires near-immediately after send.
[e35]   If wake doesn't work: setImmediate doesn't fire until the
[e35]     1000ms timer expires.
```

### Reading the results

| `uv_loop_alive` after `uv_ref`? | wake works? | Conclusion |
| --- | --- | --- |
| 0 | n/a | Hypothesis 1: registration broken. Fix at libuv/wasi-shim level. |
| 1 | no | Hypothesis 2: poll integration broken. Fix in wasi-shim's pipe→poll wiring OR add Atomics-based wake bridge. |
| 1 | yes | Hypothesis 3: libuv works, bug elsewhere. Investigate edge.js loop exit conditions. |

If NULL cb fails (`alive=0`) but non-NULL cb works (`alive=1`), the
`__edge_uv_async_noop_cb` approach I sketched earlier IS the right fix
— bring it back with this experimental evidence.

### Run

```
cd experiments/e35-uv-async-keepalive-probe
node probe.mjs
```

The probe patches `browser-target/src/worker.ts` in place with
diagnostic blocks, runs end-to-end via Vite + Chromium, scrapes the
DOM log, then reverts `worker.ts`. Verify clean: `git status` after.
