# Compatibility Adapter: Promise hooks and microtask draining patchwork

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | High | Scheduler ordering and async context are core runtime semantics. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

## Source Notes

- `plans/quickjs-wasm/development/004_promise_hooks_microtasks.md`
- `plans/quickjs-wasm/development/003_repl_tty_readline.md`
- `plans/quickjs-wasm/development/troubleshooting/wasmer-deploy/004_wasix_safe_mode_https_exit.md`
- `plans/quickjs-wasm/development/troubleshooting/node-test/005_diagnostics_channel_async_context.md`

## What Is The Compatibility Adapter

QuickJS now has local promise hook integration, explicit
`JS_ExecutePendingJob(...)` draining, real `JS_EnqueueJob(...)` microtask
enqueueing, async-context frame preservation around promise jobs, and shutdown
draining that runs platform tasks, process ticks, and microtasks until
quiescent.

## Why It Is Suspect

This is not yet one cohesive scheduler. It grew from symptoms: REPL history
stuck after `await hnd.close()`, microtasks not draining, HTTPS safe-mode
callbacks exiting too early, and async context still leaking in diagnostics
tests. Multiple drain sites risk wrong ordering, reentrancy, or shutdown-only
behavior masking normal event-loop bugs.

## How To Do It Better

Write the QuickJS event-loop contract: ticks, QuickJS jobs, platform tasks,
native callbacks, rejected promises, `beforeExit`, and shutdown. Centralize
draining behind one scheduler/checkpoint API. Keep the QuickJS promise hook
source change as an explicit patch with tests, or move to an engine version with
equivalent hooks.
