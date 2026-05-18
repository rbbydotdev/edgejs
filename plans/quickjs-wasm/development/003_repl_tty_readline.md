# Edge QuickJS REPL TTY troubleshooting

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Historical REPL TTY/readline investigation. |
| **Severity** | Low | Current promise/microtask status is tracked in node-compat issue pages. |

## Context

This note captures the debugging session for the QuickJS-backed Edge REPL hang.
The user-visible symptom was:

```sh
./build-edge-quickjs-cli/edge
```

The REPL banner and prompt appeared, but typed input was not echoed, evaluated,
or otherwise handled.

The goal of this investigation was to follow the TTY read path from libuv's
kqueue polling through Edge's native TTY wrapper and into the JavaScript REPL
stack, then identify where input stopped moving.

## Short version

The TTY is reading correctly.

The typed bytes wake `kevent()`, libuv dispatches the read watcher, Edge's native
TTY `OnRead()` receives the bytes, `EdgeStreamBaseOnUvRead()` forwards them to
JavaScript, and `lib/internal/stream_base_commons.js:onStreamRead()` receives a
valid `FastBuffer`.

The bytes do not reach readline because the REPL input stream has already been
paused by REPL history initialization. History initialization pauses readline
while it opens and prepares `/Users/sadhbh/.node_repl_history`.

The immediate hang is inside the async history initialization flow:

```js
const hnd = await fs.promises.open(this[kHistoryPath], 'a+', 0o0600);
await hnd.close();
```

Native file handle close completes and resolves its N-API promise, but the
JavaScript continuation after `await hnd.close()` does not run. The current
suspect is QuickJS promise/job behavior around the `FileHandle.close()` wrapper,
especially:

```js
SafePromisePrototypeFinally(
  this[kHandle].close(),
  () => { this[kClosePromise] = undefined; },
)
```

So the REPL is not blocked because kqueue or TTY read is broken. It is blocked
because REPL history paused stdin and an fs promise/finally chain never resumes
the history initialization.

## LLDB investigation

The requested breakpoint was placed at:

```text
~/src/edgejs/deps/uv/src/unix/kqueue.c:293
```

When typing into the hung REPL, `kevent()` returned a real readable event:

```text
nfds = 1
timeout = -1
events[0].ident = 12
events[0].filter = -1   // EVFILT_READ
events[0].flags = 1
events[0].data = 1
```

Stepping forward in `uv__io_poll()` showed:

```text
fd = 12
loop->watchers[fd] = 0x...
w->fd = 12
w->pevents = 1
w->events = 1
w->cb = uv__stream_io at deps/uv/src/unix/stream.c:1189
```

This means the kernel event was real, libuv had an active watcher for the fd,
and the event was dispatched into libuv's stream read machinery.

The native stack from the read looked like:

```text
uv__io_poll
uv__stream_io
uv__read
edge_tty_wrap.cc::OnRead
EdgeStreamBaseOnUvRead
EdgeStreamEmitRead
DefaultOnRead
CallJsOnRead
EdgeAsyncWrapMakeCallback
```

Inside `edge_tty_wrap.cc::OnRead`, LLDB showed:

```text
nread = 4
buf->base starts with "2+3\n"
buf->len = 65536
```

The important detail is `nread = 4`; the backing allocation contained stale
bytes after the first four bytes, but the stream contract is to consume only
`nread` bytes. This was not the source of the hang.

## Native Edge callback result

The read callback reached `CallJsOnRead()` in:

```text
~/src/edgejs/src/edge_stream_base.cc
```

The stream state was set:

```cpp
SetStreamState(base->env, kEdgeReadBytesOrError, static_cast<int32_t>(nread));
SetStreamState(base->env, kEdgeArrayBufferOffset, static_cast<int32_t>(offset));
```

The JS callback existed and was callable. `EdgeAsyncWrapMakeCallback()` returned
`napi_ok`, produced a result value, and there was no pending exception
immediately after the callback.

That ruled out:

- kqueue not waking
- libuv watcher not registered
- native TTY `OnRead()` not firing
- missing `onread` callback
- immediate JS exception from `onStreamRead()`

## JavaScript stream trace

Temporary tracing was added behind `EDGE_TRACE_TTY` in:

```text
~/src/edgejs/src/edge_tty_wrap.cc
~/src/edgejs/src/edge_stream_base.cc
~/src/edgejs/lib/internal/stream_base_commons.js
~/src/edgejs/lib/internal/readline/emitKeypressEvents.js
~/src/edgejs/lib/internal/readline/interface.js
~/src/edgejs/lib/internal/streams/readable.js
~/src/edgejs/lib/internal/repl/history.js
~/src/edgejs/src/internal_binding/binding_fs.cc
```

After typing `2+3\n`, the JavaScript stream trace showed:

```text
EDGE_TRACE_TTY onread fd=0 nread=4 len=65536
EDGE_TRACE_TTY js stream_base onStreamRead nread= 4 destroyed= false readableLength= 0 flowing= false hasDataListeners= 1
EDGE_TRACE_TTY js stream_base push-before offset= 0 buf.length= 4 buf= 2+3
EDGE_TRACE_TTY js stream_base push-after result= false readableLength= 4 flowing= false
EDGE_TRACE_TTY js stream_base push-backpressure-readStop
```

This proves:

- `onStreamRead()` receives the input.
- The `FastBuffer` is correct and has length 4.
- The stream is not flowing.
- `stream.push(buf)` buffers the data instead of emitting it to readline.
- Because the high-water mark is zero and the stream is paused, `push()` returns
  false and stream_base calls `handle.readStop()`.

So the REPL looked locked because stdin was paused at the JS stream layer.

## Why stdin was paused

Tracing in `lib/internal/streams/readable.js`,
`lib/internal/readline/interface.js`, and `lib/internal/repl/history.js` showed
the sequence:

```text
Welcome to Edge.js 0.0.0-f287153 (Node.js v24.13.2).
Type ".help" for more information.
> EDGE_TRACE_TTY js repl_history initialize pause /Users/sadhbh/.node_repl_history
EDGE_TRACE_TTY js readline pause
EDGE_TRACE_TTY js repl_history open a+ begin
EDGE_TRACE_TTY js readable resume_ before flowing= false data= 1 readable= 0
EDGE_TRACE_TTY readStart fd=0 rc=0 has_ref=1 loop_alive=1
EDGE_TRACE_TTY js readable resume_ after flowing= false data= 1 readable= 0
EDGE_TRACE_TTY readStop ignored fd=0 raw_mode=true
EDGE_TRACE_TTY js repl_history open a+ done
```

The pause comes from `ReplHistory.initialize()`:

```js
this[kContext].pause();
this[kInitializeHistory](onReadyCallback).catch(...);
```

That is normal Node behavior. REPL history pauses input while it initializes
persistent history, and it resumes the context once history is ready.

In our QuickJS run, history initialization starts but never reaches the resume
point.

## File handle close trace

History initialization reached:

```js
const hnd = await fs.promises.open(this[kHistoryPath], 'a+', 0o0600);
await hnd.close();
```

The trace printed:

```text
EDGE_TRACE_TTY js repl_history open a+ begin
EDGE_TRACE_TTY js repl_history open a+ done
```

It did not print:

```text
EDGE_TRACE_TTY js repl_history close a+ done
```

Native tracing around `FileHandleClose` showed:

```text
EDGE_TRACE_TTY fs FileHandleClose start fd=13 rc=0 loop=0x...
EDGE_TRACE_TTY fs FileHandleClose after fd=13 result=0
EDGE_TRACE_TTY fs FileHandleClose finish fd=13 result=0 deferred=0x...
```

This proves:

- `fs.promises.open()` completes.
- `FileHandle.close()` enters native code.
- `uv_fs_close()` is submitted successfully.
- libuv calls the close completion callback.
- native resolves the N-API deferred promise.
- `EdgeRunCallbackScopeCheckpoint(env)` is called after resolving.

Despite that, the JS async function waiting on `await hnd.close()` does not
continue.

## VSCode LLDB trace confirmation

Running the same build from VSCode LLDB with:

```json
"env": {
  "EDGE_TRACE_TTY": "1"
}
```

produced the same sequence:

```text
Welcome to Edge.js 0.0.0-f287153 (Node.js v24.13.2).
Type ".help" for more information.
EDGE_TRACE_TTY readStop fd=0 rc=0 has_ref=1 loop_alive=0
EDGE_TRACE_TTY js readable resume before flowing= null data= 1 readable= 0
EDGE_TRACE_TTY js readable resume after flowing= true data= 1 readable= 0
EDGE_TRACE_TTY setRawMode fd=0 flag=true rc=0
EDGE_TRACE_TTY js readable resume before flowing= true data= 1 readable= 0
EDGE_TRACE_TTY js readable resume after flowing= true data= 1 readable= 0
> EDGE_TRACE_TTY js repl_history initialize pause /Users/sadhbh/.node_repl_history
EDGE_TRACE_TTY js readline pause
EDGE_TRACE_TTY js repl_history open a+ begin
EDGE_TRACE_TTY js readable resume_ before flowing= false data= 1 readable= 0
EDGE_TRACE_TTY readStart fd=0 rc=0 has_ref=1 loop_alive=1
EDGE_TRACE_TTY js readable resume_ after flowing= false data= 1 readable= 0
EDGE_TRACE_TTY readStop ignored fd=0 raw_mode=true
EDGE_TRACE_TTY js repl_history open a+ done
EDGE_TRACE_TTY fs FileHandleClose start fd=13 rc=0 loop=0x...
EDGE_TRACE_TTY fs FileHandleClose after fd=13 result=0
EDGE_TRACE_TTY fs FileHandleClose finish fd=13 result=0 deferred=0x...
```

The important missing line is still:

```text
EDGE_TRACE_TTY js repl_history close a+ done
```

When a key was pressed after that point, the trace showed:

```text
EDGE_TRACE_TTY onread fd=0 nread=1 len=65536
EDGE_TRACE_TTY js stream_base onStreamRead nread= 1 destroyed= false readableLength= 0 flowing= false hasDataListeners= 1 readableListeners= 0 isPaused= true
EDGE_TRACE_TTY js stream_base push-before offset= 0 buf.length= 1 buf= v
EDGE_TRACE_TTY js stream_base push-after result= false readableLength= 1 flowing= false
EDGE_TRACE_TTY js stream_base push-backpressure-readStop
EDGE_TRACE_TTY readStop ignored fd=0 raw_mode=true
```

This confirms the same conclusion from inside VSCode:

- TTY input still reaches native code.
- The typed byte is delivered to `onStreamRead()`.
- The stream is paused: `isPaused= true`, `flowing= false`.
- The byte is buffered and readline does not receive it.
- The pause comes from REPL history initialization, not from the debugger or
  kqueue.

## Quick confirmation workaround

To confirm the diagnosis without fixing promise handling yet, disable persistent
REPL history in the VSCode launch configuration:

```json
{
  "type": "lldb",
  "request": "launch",
  "name": "Debug Edge QuickJs",
  "program": "${workspaceFolder}/build-edge-quickjs-cli/edge",
  "args": [],
  "cwd": "${workspaceFolder}",
  "env": {
    "EDGE_TRACE_TTY": "1",
    "NODE_REPL_HISTORY": ""
  }
}
```

`NODE_REPL_HISTORY=""` makes `ReplHistory.initialize()` take the disabled-history
path, which avoids the `fs.promises.open()` / `FileHandle.close()` setup that
currently wedges the REPL. If the REPL becomes interactive with that setting, it
is another confirmation that the core issue is the file-handle close promise
continuation, not TTY reading.

## Current hypothesis

The current best hypothesis is a QuickJS promise/job issue, not a TTY issue.

The wrapper in `lib/internal/fs/promises.js` returns:

```js
this[kClosePromise] = SafePromisePrototypeFinally(
  this[kHandle].close(),
  () => { this[kClosePromise] = undefined; },
);
```

`this[kHandle].close()` is the native N-API promise. Native resolves that
promise, but the promise chain created by `SafePromisePrototypeFinally()` does
not appear to settle in a way that wakes the awaiting async function.

Relevant implementation areas:

```text
~/src/edgejs/napi/quickjs/src/js_native_api_quickjs.cc
~/src/edgejs/napi/quickjs/src/unofficial_napi.cc
~/src/edgejs/src/edge_runtime.cc
~/src/edgejs/src/internal_binding/binding_fs.cc
~/src/edgejs/lib/internal/per_context/primordials.js
~/src/edgejs/lib/internal/fs/promises.js
```

In particular:

- `napi_resolve_deferred()` in the QuickJS backend calls the stored promise
  resolve function.
- `unofficial_napi_process_microtasks()` calls `JS_ExecutePendingJob()` until
  the QuickJS job queue is empty.
- `EdgeRunCallbackScopeCheckpoint()` invokes `unofficial_napi_process_microtasks()`
  when appropriate.
- Native file close calls `EdgeRunCallbackScopeCheckpoint()` after resolving the
  deferred.

The missing piece is why the promise/finally/async-await continuation does not
run even after the native deferred has been resolved and a callback checkpoint is
requested.

## Temporary probe: ignoring readStop

One temporary probe changed `edge_tty_wrap.cc` so `readStop()` was ignored for
fd 0 while raw mode was enabled.

That was not a real fix. It was useful because it proved native TTY reads could
continue and that `OnRead()` saw typed bytes. With that probe, input still did
not reach readline because JS remained paused.

This probe should not be treated as the final solution.

## What to do next

1. Build a small reproduction around `fs.promises.open(...).then(h => h.close())`
   and `await h.close()` under the QuickJS Edge CLI.

2. Add targeted tracing or tests for `SafePromisePrototypeFinally()` with a
   native N-API promise:

   ```js
   const p = nativePromise();
   await SafePromisePrototypeFinally(p, () => {});
   ```

3. Inspect whether `napi_resolve_deferred()` enqueues the expected QuickJS jobs
   and whether all jobs are executed by `unofficial_napi_process_microtasks()`.

4. Check whether QuickJS's `Promise.prototype.finally` behavior with `SafePromise`
   subclassing matches what Node's primordials expect.

5. Once promise continuation works, remove the temporary TTY/readline/history/fs
   instrumentation and remove the `readStop()` ignore probe.

6. Re-test:

   ```sh
   ./build-edge-quickjs-cli/edge
   ```

   Expected behavior: the REPL prompt accepts input, echoes/evaluates commands,
   and remains interactive.

## Useful commands

Build:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Run traced REPL:

```sh
EDGE_TRACE_TTY=1 ./build-edge-quickjs-cli/edge
```

Run traced REPL with persistent history disabled:

```sh
EDGE_TRACE_TTY=1 NODE_REPL_HISTORY="" ./build-edge-quickjs-cli/edge
```

LLDB entry point:

```sh
lldb ./build-edge-quickjs-cli/edge
```

Breakpoint requested for the kqueue investigation:

```lldb
breakpoint set --file ~/src/edgejs/deps/uv/src/unix/kqueue.c --line 293
```

Useful native breakpoints:

```lldb
breakpoint set --file src/edge_tty_wrap.cc --name OnRead
breakpoint set --file src/edge_stream_base.cc --name EdgeStreamBaseOnUvRead
breakpoint set --file src/edge_stream_base.cc --name CallJsOnRead
```

## Bottom line

The REPL is not failing because QuickJS Edge cannot read from TTY. It can.

The REPL is failing because persistent history pauses readline and then gets
stuck awaiting `FileHandle.close()`. Native close resolves the promise, but the
JavaScript promise/finally/await continuation does not run. The next fix should
focus on QuickJS N-API promise resolution and microtask/job draining, especially
with `SafePromisePrototypeFinally()`.
