# Node Test: stream missing builtins and async iterators

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Medium | Blocks newer stream APIs and web-stream interop tests. |

Affected tests:

- `parallel/test-stream-readable-async-iterators`
- `parallel/test-stream-some-find-every`
- `parallel/test-whatwg-readablestream`

## What Is The Issue

The stream suite exposes three gaps:

- `test-stream-some-find-every.mjs` cannot load `timers/promises`.
- `test-whatwg-readablestream.mjs` cannot load `stream/web`.
- `test-stream-readable-async-iterators.js` reaches execution but fails an
  assertion, so readable async iterator semantics differ from Node.

These are probably not one code bug, but they belong to the same compatibility
surface: modern stream APIs expect builtin modules and async iterator behavior
that QuickJS Edge does not fully provide yet.

## How Should We Fix It

Implement or expose the missing builtins first:

1. Add `timers/promises` as a public builtin backed by the existing timers
   promise implementation already referenced from `lib/timers.js`.
2. Add `stream/web` as a public builtin that re-exports the available WHATWG
   streams implementation or explicitly documents missing constructors.

After imports work, rerun the assertion failure and compare
`Readable.prototype[Symbol.asyncIterator]`, iterator cancellation, error
propagation, and microtask ordering against Node.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-stream-some-find-every.mjs
build-edge-quickjs-cli/edge test/parallel/test-whatwg-readablestream.mjs
build-edge-quickjs-cli/edge test/parallel/test-stream-readable-async-iterators.js
```
