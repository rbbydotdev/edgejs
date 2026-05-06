# Next App Standalone: Route Request Stack Exhaustion

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation after startup compatibility fixes. |
| **Severity** | High | The Next standalone server starts, but the first HTTP request crashes the Wasmer process. |

## Context

After fixing the QuickJS `serdes` binding and adding an unavailable-inspector
stub, `private-poker` starts under Wasmer:

```text
▲ Next.js 16.1.6
- Local:         http://localhost:3000
- Network:       http://0.0.0.0:3000

✓ Starting...
✓ Ready in 1303ms
```

A request to the root route then fails:

```sh
curl -i --max-time 10 http://127.0.0.1:3000/
```

with the client receiving:

```text
curl: (52) Empty reply from server
```

and Wasmer reporting:

```text
RuntimeError: call stack exhausted
```

## Impact

This is past module-load compatibility and server startup. The remaining blocker
is now request-time rendering or request dispatch under the Next standalone
runtime.

## Action Plan

1. Reproduce with the smallest route possible, starting with `/`, then known
   static asset paths, then any simple route if available.
2. Enable focused tracing if useful to find whether the exhaustion occurs in
   HTTP dispatch, module loading, React/Next rendering, or user app code.
3. Compare native QuickJS CLI behavior against WASIX to determine whether this
   is QuickJS JS stack, native/wasm stack, or request lifecycle recursion.
4. If it is a known stack-depth issue, adjust the narrow WASIX/QuickJS stack
   configuration rather than changing broad module semantics.
5. Rerun `private-poker` under Wasmer and verify at least one HTML route returns
   an HTTP response.

## Native Versus Wasmer Samples

Two macOS `sample` captures from `private-poker` show different runtime shapes:

- `~/src/dev/edgejs/next-server.txt`: native Edge QuickJS.
- `~/src/dev/edgejs/wasmer-sample.txt`: `wasmer run` of the same app package.

The native sample is quiescent in the expected way. Its main thread is parked in
`RunEventLoopUntilQuiescent(...) -> uv_run(...) -> uv__io_poll(...) -> kevent`,
and libuv worker threads are blocked in `uv_cond_wait(...)`. This matches a
server that has no pending CPU work while waiting for socket activity.

The Wasmer sample is not just the same libuv loop behind a WASIX boundary. It
shows Wasmer/WASIX task machinery on the hot path:

- `TokioTaskManager Thread Pool_thread_1`
- `stack_call_trampoline`
- `corosensei::coroutine::on_stack::wrapper`
- `wasmer_wasix::syscalls::wasix::sched_yield`
- `wasmer_wasix::syscalls::wasix::thread_sleep_internal`
- `wasmer_wasix::syscalls::handle_rewind_ext`
- a very deep repeated sequence of unknown generated wasm frames

Other TokioTaskManager pool threads are blocked in:

```text
 stack_call_trampoline
 corosensei::coroutine::on_stack::wrapper
 wasmer_wasix::syscalls::wasix::futex_wait
 wasmer_wasix::syscalls::__asyncify_with_deep_sleep
 virtual_mio::waker::block_on
 parking::Inner::park
 _pthread_cond_wait
```

This points away from QuickJS JavaScript promise continuations as the direct
stack-growth mechanism. In our Edge QuickJS layer, async/await is represented as
QuickJS promise jobs drained by `JS_ExecutePendingJob(...)` through
`unofficial_napi_process_microtasks(...)`. The N-API backend also installs
QuickJS promise hooks that capture, enter, and leave async context frames around
promise reaction jobs.

The coroutine names in the Wasmer sample are from Wasmer/WASIX asyncify and task
scheduling, not from our QuickJS promise-job implementation. The suspicious
pattern is that a WASIX syscall path that should suspend/yield through asyncify
appears to keep re-entering generated wasm frames until the host reports
`RuntimeError: call stack exhausted`.

## Stack Size Probe

Increasing Wasmer's runtime stack changes the failure mode but does not resolve
the route:

- default stack: first request returns an empty reply and Wasmer reports
  `RuntimeError: call stack exhausted`;
- `--stack-size 4194304`: same `call stack exhausted` on the first request;
- `--stack-size 6291456`: same `call stack exhausted` on the first request;
- `--stack-size 8388608`: the server reaches `Ready`, but HTTP requests hang
  without returning bytes.

This suggests stack size is only exposing the next symptom. The likely blocker
is a WASIX coroutine/asyncify re-entry or wakeup issue around a syscall used by
the Next request path, rather than a simple need for a larger QuickJS JS stack.

## Updated Investigation Plan

1. Capture a focused Wasmer sample during the first hanging or overflowing HTTP
   request and map the generated wasm addresses if possible.
2. Reproduce outside Next with a small Edge QuickJS WASIX script that performs
   the likely syscall pattern: HTTP accept, read, response write, and any
   `setImmediate` / Promise continuation used by the request path.
3. Add tracing around `uv_run` callbacks and QuickJS microtask checkpoints to
   verify whether JavaScript continuations are re-entering normally or whether
   execution is stuck before returning from a WASIX syscall suspension.
4. If the small repro shows the same deep `corosensei` / `handle_rewind_ext`
   stack, treat this as a Wasmer/WASIX asyncify task scheduling issue rather
   than a QuickJS promise-hook issue.
