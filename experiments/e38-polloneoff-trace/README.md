# E38 — poll_oneoff sub trace

## Hypothesis (from e37)

`uv_loop_alive` returns 1 throughout the failing keepalive scenario,
yet `uv_run(UV_RUN_DEFAULT)` returns in ~140ms.  This means
`uv__io_poll`'s call to `poll()` returns repeatedly without ever
blocking on our pipe-read subscription.

The bug must be in one of these wasi-shim `pollOneoffAsyncImpl`
decisions:
- Returns `nWritten > 0` early (events ready immediately when they shouldn't be)
- Takes the timer-only path (`minTimeoutNs >= 0 && !hasSocketSub`) → broken branch ignoring pipes
- Returns the race-of-waiters Promise but it resolves immediately
- Falls back to `pollOneoffSyncImpl` (JSPI re-entry detection)

## Method

Patch `wasi-shim.ts pollOneoffAsyncImpl` in-place with verbose log lines
that fire on EVERY call.  Log:
- Call counter (n)
- nsubs, minTimeoutNs, hasSocketSub, pipeReadSubs.length
- JSPI re-entry decision (sync vs async path)
- Which branch fires: immediate-ready / timer-only / race-of-waiters
- If race: how many waiters, which slots

Run the e37 scenario (keepalive only, no user-script timers).  Pipe the
log to a file so we can analyze all calls.

## Success criteria

The trace must distinguish:

| What we see | Conclusion |
| --- | --- |
| Sub for our async pipe fd in pipeReadSubs at least once | Sub registration works |
| Sub for our async pipe fd NEVER appears | wasi-libc doesn't pass it through — investigate poll.c upstream |
| Race-of-waiters branch entered, then Promise resolves immediately | waitAsync mis-configured (wrong slot, stale seen value) |
| Repeated timer-only branch entries | line 1122 bug IS active even without user-script timer — need to find what's adding a clock sub |
| pollOneoffSyncImpl entered (JSPI re-entry) | wasm calling poll from a re-entry — race path skipped |

Output goes to `trace.log` for line-by-line analysis.

## Run

```sh
cd experiments/e38-polloneoff-trace
node probe.mjs > trace.log 2>&1
tail -100 trace.log
```
