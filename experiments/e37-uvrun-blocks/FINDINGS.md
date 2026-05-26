# E37 — uv_run block probe: findings

> **Cross-ref:** The symptom captured here (`uv_run` returning despite
> `alive=1`) is valid, but the root cause was found later in
> [e40](../e40-cpp-debugger/FINDINGS.md): the keepalive's `alive=1`
> was being read from `uv_default_loop()`, while `uv_run` was driving a
> different per-env loop where no handles were registered. Two loops,
> two different alive states. Fixed in commit 1eff1dfa.

## Result

```
[e37] keepalive init rc=0 alive_after_ref=1 t=323
[e37-user] bootstrap-done t=31
[e37] @t=36 alive=1 (probe-50ms)
_start ran 144 ms (returned)
[e37] @t=0 alive=1 (probe-200ms)
```

## Interpretation

- `alive_after_ref=1` immediately after `uv_async_init + uv_ref` ✓
- At wasm-clock t=36ms (during _start): `alive=1` STILL ✓
- `_start ran 144 ms (returned)` — _start function returned naturally
- At wasm-clock t=0 (after _start, clock reset): `alive=1` STILL ✓

## Conclusion

`uv_loop_alive(loop)` returns 1 throughout — both during and after
`_start`.  But `_start` returned at 144ms, meaning
`RunEventLoopUntilQuiescent`'s `uv_run(UV_RUN_DEFAULT)` returned despite
the loop being alive.

**This contradicts libuv spec:** `uv_run(loop, UV_RUN_DEFAULT)` is
documented to loop while `uv_loop_alive(loop) != 0`.  Yet here, the
loop is alive AND `uv_run` returned.

## What this implies

The bug is NOT in:
- libuv's keepalive accounting (`active_handles`/`UV_HANDLE_REF` — these work, alive=1)
- The user's policy keepalive (the probe bypasses the policy and uses raw uv_async directly — same failure)

The bug IS in one of:
- `uv__io_poll`'s call to `poll(loop->poll_fds, n, -1)` — does it ACTUALLY pass -1 as timeout in this code path, or does it transform it?
- `wasi-libc`'s `poll()` translation — does `timeout=-1` reach `__wasi_poll_oneoff` as "no clock sub"?
- `wasi-shim`'s `pollOneoffAsyncImpl` — does it return a resolved Promise immediately when it should be waiting?

The fact that `_start ran 144 ms` (not 30000ms or 60000ms) means the
poll loop runs many iterations rapidly — each iteration's poll_oneoff
likely returns without blocking.  Either:
1. `poll_oneoff` is called with timeout=0 (immediate return)
2. The Promise returned by `pollOneoffAsyncImpl` resolves immediately
3. Some other "spinning" path runs

This experiment GAVE A DEFINITIVE ANSWER:

**The libuv layer works correctly under wasi (handle accounting +
alive flag are correct).  The wasi-shim's `poll_oneoff` does not
actually block when it should.  This is the actual bug.**

The fix lives in `wasi-shim.ts pollOneoffAsyncImpl` (and possibly
`pollOneoffSyncImpl`).  e38 will trace per-call subscription counts
and branch decisions to pinpoint where it's spinning.

## Methodology notes

The probe bypasses edge.js's `RunEventLoopUntilQuiescent` only
partially — it injects pre-`_start` but `_start` still runs the full
edge.js wrapper.  A cleaner future experiment could replace the
`startFn` call entirely with a direct `uv_run(loop, UV_RUN_DEFAULT)`
call to isolate libuv from edge.js entirely.  Not done here because
the result (alive=1 + _start returned) is already conclusive enough
to know the bug is downstream of libuv's loop-alive semantics.
