# Node Test: stream missing builtins and async iterators

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Async iterator cancellation fix implemented; missing builtin checks remain. |
| **Severity** | Medium | Blocks newer stream APIs and web-stream interop tests. |

Affected tests:

- `parallel/test-stream-readable-async-iterators`
- `parallel/test-stream-some-find-every`
- `parallel/test-whatwg-readablestream`

## What Is The Issue

The stream suite exposes three gaps:

- `test-stream-some-find-every.mjs` cannot load `timers/promises`.
- `test-whatwg-readablestream.mjs` cannot load `stream/web`.
- `test-stream-readable-async-iterators.js` reached execution but failed an
  assertion because QuickJS `for await...of` resumed after `break` before
  awaiting the async iterator `return()` cleanup.

These are probably not one code bug, but they belong to the same compatibility
surface: modern stream APIs expect builtin modules and async iterator behavior
that QuickJS Edge does not fully provide yet.

## How Should We Fix It

Implemented for the async iterator cancellation path:

- The active code change lives in the QuickJS repo on the
  `emit_async_iterator_close` branch.
- QuickJS parser state now tracks async iterator records separately from sync
  iterator records.
- Abrupt exits from `for await...of` emit an async iterator close sequence:
  call `return()`, await its result, validate the result object, then resume
  after the loop.
- `return` from inside `for await...of` uses the same awaited close behavior
  while preserving the function return value.
- Natural `for...of` / `for await...of` exhaustion now drops the iterator record
  without calling `return()`, matching Node/V8 behavior.

Remaining work:

1. Add `timers/promises` as a public builtin backed by the existing timers
   promise implementation already referenced from `lib/timers.js`.
2. Add `stream/web` as a public builtin that re-exports the available WHATWG
   streams implementation or explicitly documents missing constructors.

After imports work, continue comparing `Readable.prototype[Symbol.asyncIterator]`,
iterator cancellation, error propagation, and microtask ordering against Node.

Verified after the async iterator close fix:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
build-edge-quickjs-cli/edge -e "let flag=false; const it={i:0, async next(){return this.i++?{done:true}:{value:1,done:false};}, async return(){await 0; flag=true; return {done:true};}, [Symbol.asyncIterator](){return this;}}; (async()=>{for await (const x of it) break; console.log(flag); if (!flag) process.exitCode=1;})().catch(e=>{console.error(e&&e.stack||e);process.exitCode=1});"
build-edge-quickjs-cli/edge -e "const {Readable}=require('stream'); (async()=>{const readable=Readable.from([5]); for await (const chunk of readable.iterator({destroyOnReturn:true})) { if (chunk !== 5) throw new Error('bad chunk'); break; } console.log('destroyed', readable.destroyed); if (!readable.destroyed) process.exitCode=1;})().catch(e=>{console.error(e&&e.stack||e);process.exitCode=1});"
```

The full `test-stream-readable-async-iterators.js` now advances past the
destroy-on-return assertion under QuickJS but still hits the sandbox-local
network listener failure:

```text
listen EPERM: operation not permitted 0.0.0.0
```

When investigating a broad `make test-quickjs-only` failure list after this
change, `test-url-format.js` and `test-zlib-type-error.js` passed their test
bodies but crashed during runtime teardown with:

```text
Assertion failed: (!block->is_free(slot)), function unsafe_owner, file napi_allocator.h, line 99.
```

LLDB showed the crash under `DestroyHookFinalizer(...)` while `JS_FreeRuntime()`
runs GC and an async_wrap destroy finalizer tries to read an already-freed
`napi_ref`. Temporarily reversing the QuickJS async-close patch and rebuilding
kept the same teardown assert for `test-url-format.js`, while the async iterator
repro regressed to printing `false`. Treat that teardown assert as a separate
N-API ref lifetime issue unless a later A/B proves otherwise.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-stream-some-find-every.mjs
build-edge-quickjs-cli/edge test/parallel/test-whatwg-readablestream.mjs
build-edge-quickjs-cli/edge test/parallel/test-stream-readable-async-iterators.js
```
