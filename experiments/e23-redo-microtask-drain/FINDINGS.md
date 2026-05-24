# E23-redo: microtask-before-timer root cause + JSPI constraint

**Date:** 2026-05-24
**Worktree (deleted):** `agent-a8a4974db524bf0df`
**Result:** Root cause **identified**.  Fix attempted, **blocked by
JSPI v2 architectural constraint**.  Fix paths all require wasm
rebuild (NOTES followup #1 territory).  `host=1` remains the
pragmatic workaround.

## Reproduction (instrumented trace)

Test `tests/js/microtask-before-timer.js` with explicit ordering
probes A/B/C/D/E and a `microtask-fired-yet` indicator inside the
timer callback.

Observed order on the wasm path:

```
A:script-start
A:script-end
E:timer-before-exit microtask-fired-yet=NO     ← timer fires here
[timer-probe] pollOneoffAwaitTimer ENTER ms=1
[timer-probe] before-wait
C:microtask                                    ← microtask fires AFTER
D:queueMicrotask
B:set-mtFired
[timer-probe] AFTER waitAsync probeRan=true
```

A probe in `pollOneoffAwaitTimer` confirmed E8's finding: V8 DOES
drain microtasks at the JSPI suspend boundary.  The user's microtask
DOES eventually fire — but AFTER the timer.

## Root cause

`uv_run(loop, UV_RUN_DEFAULT)` fires due timers BEFORE calling
`poll_oneoff` in the same iteration.  Edge's timer-callback path
(`src/edge_timers_host.cc:115`) invokes `EdgeMakeCallbackWithFlags`
with `kEdgeMakeCallbackSkipTaskQueues`, so **NO microtask checkpoint
runs between user-script-end and timer-fire**.

Auxiliary: `unofficial_napi_process_microtasks` on the browser worker
is a no-op (the `__edgeHostTickCallback` snapshot is `null` for
DedicatedWorkers per `browser-target/src/host/globals-shim.ts:89-91`),
so the `DrainProcessTickCallback` call at `src/edge_runtime.cc:3034`
never drains V8 microtasks.

Hypothesis (A) from the prompt confirmed: `unofficial_napi_process_microtasks`
IS called, but on the browser path it's a no-op.

## Fix attempted: `WebAssembly.Suspending` wrap

Wrap the `unofficial_napi_process_microtasks` import so its Promise
return forces wasm to yield, letting V8's kAuto microtasks policy
drain at the suspend boundary.

Implementation: `microtask-ops.ts` returns `new Promise(resolve =>
queueMicrotask(() => resolve(NAPI_OK)))` on the browser path; apply
`new WebAssembly.Suspending(impl)` at registration time.

Also had to delete a duplicate `unofficial_napi_process_microtasks` in
`napi-host/unofficial.ts:412` that was silently overwriting the
Suspending-wrapped version (registered later in `napi-host/index.ts`).

## Result: 1/3 stable; blocked by JSPI v2 constraint

Three consecutive runs of `microtask-before-timer` with the fix:
PASS, FAIL, FAIL.

Failure stack:
```
SuspendError: trying to suspend JS frames
  at wasm://wasm/...:wasm-function[16146]
  at jsReentryWrap (napi-host/index.ts:318)
  at callback (@emnapi_core.js)
  at Env2.callIntoModule (@emnapi_runtime.js)
```

**JSPI v2 requires only-wasm-frames between the promising entry
(`_start`) and any Suspending import.**  Edge calls
`unofficial_napi_process_microtasks` from three sites:

| Site | Stack between promising and import | JSPI verdict |
|---|---|---|
| `edge_runtime.cc:1870` (between uv_run iterations) | wasm-only | OK |
| `edge_runtime.cc:3298` (`EdgeRunCallbackScopeCheckpoint`, from `EdgeMakeCallback`) | JS frames usually present | FAILS |
| `edge_task_queue.cc:94` (`TaskQueueRunMicrotasks` from lib's `runMicrotasks`) | JS frames (napi_call_function wrapper, processTicksAndRejections) | FAILS |

The first reached call comes via `processTicksAndRejections` during
bootstrap.  Dynamic gating via a `__edgeJsFrameDepth` counter set in
`wrapImpl` (added to `imports-generated.ts`) didn't help — the engine
throws `SuspendError` BEFORE invoking our JS function, so the runtime
check never runs.  **The Suspending wrap is all-or-nothing once
installed.**

## What WOULD fix this — all require wasm rebuild

1. **Differentiate call sites in C++**: add a NEW import symbol (e.g.,
   `unofficial_napi_yield_for_microtasks`) used only at the safe call
   site (`edge_runtime.cc:1870` between uv_run iterations); ONLY that
   import gets the Suspending wrap.  The existing
   `process_microtasks` stays sync no-op for the unsafe sites.
2. **Drain BEFORE timers fire**: insert a microtask-drain call at the
   top of `RunEventLoopUntilQuiescent`'s loop body, BEFORE `uv_run`.
   That call site has wasm-only stack.
3. **Asyncify / emnapi multithreaded** — explicit goal of NOTES
   followup #1, larger work.
4. **Lever B (current path)**: run user JS on host worker; `host=1`
   already does this.

## Final state

- All changes reverted; only kept a documenting comment block in
  `browser-target/src/napi-host/microtask-ops.ts` explaining why the
  Suspending-wrap fix does NOT close this bug.  **Prevents future
  agents from re-trying the same dead end.**
- `host=1` restored in the 3 affected `.harness-args` files.
- Suite: 36 pass / 0 fail / 0 err / 3 skip — unchanged.

## Conclusion

The bug is real, root cause identified, but the fix is
**architectural** (requires C++/wasm rebuild).  The Suspending-wrap
approach the prompt hypothesized works in principle and would close
all 3 tests IF the call sites were all JSPI-safe, but they're not —
and there's no JS-side mechanism to make them so.  The deferred work
in NOTES followup #1 (specifically option 1 above: add a separate
`unofficial_napi_yield_for_microtasks` import for the safe call site)
is the correct path.

`host=1` remains the pragmatic answer for the 3 affected tests on
the current wasm build.

## Files in worktree (NOT merged)

- `browser-target/src/napi-host/microtask-ops.ts` — documenting
  comment ported to main (just the comment, not the failed
  Suspending-wrap attempt)

Everything else in the worktree was reverted by the agent before
finishing.
