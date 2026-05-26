# E36 — Async-wfd probe: findings

> **Cross-ref:** The wasi-shim line-1122 bug surfaced here is real, but
> it was *not* the root cause of the ~140ms child exit that motivated
> the worker_threads investigation. That bug was found in
> [e40](../e40-cpp-debugger/FINDINGS.md): keepalive registered on
> `uv_default_loop()` while `uv_run` drove a fresh per-env loop. The
> line-1122 patch is necessary-but-insufficient (see also
> [e38](../e38-polloneoff-trace/FINDINGS.md)) and did not ship as part
> of the fix in commit 1eff1dfa.

## What this experiment proved

1. **libuv's async pipe wfd IS in the wasi-shim pipeRegistry range.**
   Probe `probe.mjs` read uv_loop_t struct offsets — found pairs of
   sequential fds in the 5000-5006 range matching pipeRegistry's
   PIPE_FD_BASE allocation pattern.

2. **`uv_async_send` IS actually reaching `pipeRegistry.write`.**
   Probe `probe-pipe-write.mjs` instrumented `PipeRegistry.write()`
   with a console.log and confirmed `[ws-pipe-write] slot=2 len=1`
   fires exactly when `uv_async_send` is called.  The notify on the
   pipe's wakeCounter DOES happen.

3. **There is a real wasi-shim bug at `wasi-shim.ts:1122`.**
   ```ts
   if (minTimeoutNs >= 0 && !hasSocketSub) {
     return pollOneoffAwaitTimer(...);  // timer-only — IGNORES pipe wakes
   }
   ```
   When `poll_oneoff` has BOTH a timer sub AND a pipe-read sub, this
   wrongly takes the timer-only branch (which only `Atomics.waitAsync`'s
   the timer SAB) and never includes the pipe's wakeCounter in its wait
   set.  Result: `Atomics.notify` on the pipe wakeCounter has no listener.

4. **Fix is one line:**
   ```ts
   if (minTimeoutNs >= 0 && !hasSocketSub && r.pipeReadSubs.length === 0) {
     return pollOneoffAwaitTimer(...);
   }
   ```
   This correctly forces the race-of-waiters path whenever a pipe-read
   sub is present.

## What this experiment did NOT prove

5. **The fix alone does NOT enable Real Path A end-to-end.** When the
   wasi-shim fix was applied AND the policy was reverted to pure
   uv_async_t keepalive (no setInterval), `e34-keepalive-no-heartbeat`
   still fails.  Cross-worker `worker.postMessage` does not result in
   the child's user listener firing.  Some other layer in the wake-up
   chain (perhaps the bridging between worker.ts's
   `pokeParentPortSlot` and the actual wasm-side `uv_async_send`
   reaching the right slot, or the JSPI re-entry handling for the
   reverse-RPC dispatcher) has a separate issue.

6. **The fix introduces an unrelated regression.** With the wasi-shim
   fix applied (even with the existing setInterval keepalive),
   `unhandled-rejection-fires` test starts firing the rejection
   handler twice instead of once.  Likely because the race-of-waiters
   path resolves faster than the timer-only path, exposing some
   V8 microtask queue race in the rejection-tracking path.

## Decision

**Do not ship the wasi-shim fix in its current form.**

- It's a real bug (provable via reading the code), but the user-visible
  improvement from fixing it requires fixing additional issues
  (point 5).
- The fix has an unexplained side effect (point 6) that breaks an
  existing test.
- The current `setInterval(100ms)` keepalive in
  `policies/worker-threads-per-thread.ts` works end-to-end with the
  100ms wake latency that's been the shipping behavior.

The fix is correctly characterized as "an optimization that doesn't yet
deliver" — leave it documented here for future work.  If Real Path A
becomes a priority later, the next investigator can start from this
finding and trace why pure uv_async still doesn't wake the loop
end-to-end despite the wake-fix being plausibly correct in isolation.

## Reproduce

```sh
cd experiments/e36-async-wfd-probe
node probe.mjs              # reads loop->async_wfd values from struct
node probe-pipe-write.mjs   # instruments pipeRegistry.write
node probe-wake-verifies.mjs # ad-hoc wake-detection test (results
                             # confounded by _start exit semantics —
                             # not as reliable as the others)
```

Probes patch `worker.ts` and/or `pipes-sab.ts` in place, run via Vite +
Chromium, then revert.  Verify clean: `git status` after.

## Captured outputs (verbatim)

### probe.mjs

```
[e36] loop=13675088 init_rc=0 our_handle=22118688
[e36] loop_t plausible-fd sweep: +260=1 +268=5004 +272=5005 +300=414 +304=5002 +308=5003 +312=7011 +332=1 +340=5002 +352=16 +388=16
[e36] uv_async_send rc=0 struct-diffs: []
[e36-user] bootstrap
[e36] sentinel: _start ran 626 ms (exit=0)
```

`+304=5002` and `+308=5003` are sequential pipe fd pairs — confirms
wfd is in pipeRegistry range.

### probe-pipe-write.mjs

```
[e36-pw] handle init rc=0 h=22118688; will send at t=500
[e36-pw-user] bootstrap
[ws-pipe-write] slot=2 len=1 t=389
[e36-pw] uv_async_send rc=0 at t=389
[e36-pw-user] timer fired
[e36-pw] sentinel: _start ran 1126 ms (returned)
```

`[ws-pipe-write] slot=2 len=1` proves `uv_async_send` reaches
`PipeRegistry.write` — the notify on the wakeCounter is happening but
nobody is listening (per the wasi-shim bug).
