# Phase 1 research synthesis — `uv_async_t` wake-up bug in wasi build

Four parallel research streams converged on a clean picture:

## R1 — libuv layer is correct (per spec)

Code path under `deps/libuv-wasix/src/unix/`:

- `uv_async_init` does `uv__handle_init` (sets `UV_HANDLE_REF`) + `uv__handle_start` (sets `UV_HANDLE_ACTIVE`, increments `active_handles`).  After this, `uv__has_active_handles(loop) == true`, `uv__loop_alive(loop) == 1`.
- `uv_run(UV_RUN_DEFAULT)` enters the `while (r != 0 && stop_flag == 0)` loop because `r == 1` (loop alive).
- `uv__backend_timeout()` returns the result of `uv__next_timeout()` when there's nothing else pending; with no timer handles, `uv__next_timeout()` returns `-1` (block indefinitely).
- `uv__io_poll(loop, -1)` calls `poll(loop->poll_fds, n, -1)`.

**Verdict:** libuv's own logic is correct.  A ref'd async handle alone should cause `uv_run` to block in `poll()` with `timeout=-1`.

## R2 — wasi-libc's `poll()` correctly forwards to `poll_oneoff`

From upstream + WASIX fork source (`libc-bottom-half/cloudlibc/src/libc/poll/poll.c`):

- Each `pollfd` with `POLLIN` → one `__wasi_subscription_t` with `u.tag = __WASI_EVENTTYPE_FD_READ` (=1), `fd = pollfd->fd` verbatim.
- `timeout == -1` (infinite) → **NO clock subscription added.**  poll_oneoff is called with FD subs only, blocks indefinitely on them.
- No high-fd ceiling, no fd-type guard — async pipe fds in `PIPE_FD_BASE` range (5000+) pass through unchanged.

**Verdict:** wasi-libc correctly translates our setup to ONE `FdRead` subscription on the async pipe with no clock subscription.

## R3 — Node uses ONLY `uv_async_t + uv_ref` (no heartbeat)

Code paths under `node/src/` + `node/lib/internal/worker/`:

- `MessagePort` constructor: `uv_async_init(env->event_loop(), &async_, onmessage)`.
- `port.ref()` (called when first `'message'` listener registered, `io.js:211-246`) → `HandleWrap::Ref` → `uv_ref(&async_)`.
- No additional timer.  No fallback heartbeat.  No idle handle.

**Verdict:** Node confirms our design IS correct.  A single ref'd `uv_async_t` is sufficient in real Node.  If it works for them, the libuv primitive itself is suitable.

## R4 — Bug is novel & unreported upstream

- libuv has NO supported WASI backend (cjihrig: "I can't see a ton of usefulness... PRs welcome but not too intrusive").
- Closest analogue (libuv#276) is the inverse case (unref'd handle).  No upstream issue matches our exact symptom.
- All downstream wasm projects either replaced libuv (libxev, emnapi) or used Asyncify/spinlock alternatives.

**Verdict:** We are on our own.  The fix lives in our tree.

## Putting it together — where MUST the bug be?

By process of elimination:

1. libuv code path: ✓ correct (R1)
2. wasi-libc `poll()`: ✓ correct (R2)
3. The design (uv_async + uv_ref): ✓ matches Node (R3)
4. No upstream fix exists: ✓ confirmed (R4)

The bug must be in **one of two places**:

**A. `wasi-shim.ts` poll_oneoff handler.**  We've already found that `pollOneoffAsyncImpl` has a buggy condition at line 1122 (timer-only branch with no pipe check).  HOWEVER: that branch only fires when `minTimeoutNs >= 0`.  In the keepalive-alone scenario, `timeout=-1` → no clock sub → `minTimeoutNs = -1` → broken branch not taken.  So this bug is NOT the keepalive-alone failure mode.  It's a SEPARATE bug.

**B. The actual integration between `poll_oneoff`'s wake-up and `uv_run`'s subsequent iteration.**  Things we haven't verified:
   1. Does `pollOneoffAsyncImpl` actually reach the race-of-waiters branch when called with `timeout=-1` + pipe-read sub?
   2. Does the `waitAsync` on the pipe's `wakeCounter` actually fire when `uv_async_send` notifies?
   3. After wake fires, does poll_oneoff return correctly with the FD_READ event, and does libuv's posix-poll then invoke `uv__async_io` (which would drain the pending byte and let the loop iterate normally)?

## Phase 2 — Experiments designed to nail down (B)

### e37 — Does `uv_run` block indefinitely with only a ref'd async handle?
- **Question:** Is the libuv layer fully working under wasi (block + wake), or does `uv_run` return without blocking?
- **Method:** Patch worker.ts BEFORE `_start` runs. Allocate uv_async, init+ref, then call `uv_run(loop, UV_RUN_DEFAULT)` directly with timing.  Schedule `uv_async_send` + `uv_close` from a `setTimeout(500ms)`.
- **Success criterion:**
  - If `uv_run` blocks for ~500ms then returns: ✓ libuv works end-to-end under wasi.  Bug is in edge.js's `RunEventLoopUntilQuiescent` or the policy integration.
  - If `uv_run` returns immediately (< 50ms): ✗ wasi-shim's poll_oneoff doesn't actually block on a single pipe-read sub.  Drill into pollOneoffAsyncImpl.

### e38 — What subscriptions does `poll_oneoff` actually see in the failing scenario?
- **Question:** Does the async pipe FdRead sub reach `pollOneoffWalkSubs` and end up in `pipeReadSubs`?  Does the race-of-waiters branch get taken?  Does the waitAsync on the wakeCounter actually fire on `uv_async_send`?
- **Method:** Instrument wasi-shim.ts:
  - `pollOneoffAsyncImpl` entry: log nsubs, minTimeoutNs, hasSocketSub
  - `pollOneoffWalkSubs` per-sub: log sub type, fd, whether pipe
  - The race-of-waiters branch: log "entering race with N waiters" + log when each waiter resolves
  - `pollOneoffAwaitTimer` entry: log "took timer-only path"
- Run the failing keepalive scenario.
- **Success criterion:**
  - Logs show the async pipe FdRead sub in pipeReadSubs AND `pollOneoffAsyncImpl` enters race-of-waiters AND `uv_async_send` triggers the waitAsync resolution: bug is downstream (in libuv's revents handling or edge.js loop logic).
  - Logs show the sub missing OR the race-of-waiters not entered OR waitAsync not resolving: bug is in wasi-shim, exact line identified by which condition failed.

### e39 — `unhandled-rejection-fires` double-fire root cause
- **Question:** Why does fixing wasi-shim.ts:1122 cause the rejection handler to fire twice?
- **Method:** Apply the line-1122 fix in isolation.  Run `unhandled-rejection-fires` test with verbose log on every iteration of the wasi-shim path.  Compare to baseline (no fix).
- **Success criterion:**
  - Logs identify the specific code path that runs twice with the fix and once without.
  - The mechanism is understood enough to write a regression-free fix.

## What NOT to do until Phase 2 is done

- DON'T apply the wasi-shim.ts:1122 fix yet — we now know it doesn't address the keepalive bug AND causes a regression.
- DON'T revert the `setInterval(100ms)` keepalive in the policy yet — it works, and removing it before we have a verified replacement leaves the system broken.

Each Phase 2 experiment writes its own FINDINGS.md before we touch any source.
