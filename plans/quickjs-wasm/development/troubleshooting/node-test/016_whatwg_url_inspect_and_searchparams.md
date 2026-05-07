# Node Test: WHATWG URL inspect and search params

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Medium | WHATWG URL behavior differs in visible formatting, encoding, and error messages. |

Affected tests:

- `parallel/test-whatwg-url-custom-inspect`
- `parallel/test-whatwg-url-custom-parsing`
- `parallel/test-whatwg-url-custom-searchparams-append`
- `parallel/test-whatwg-url-custom-searchparams-constructor`
- `parallel/test-whatwg-url-custom-searchparams-delete`
- `parallel/test-whatwg-url-custom-searchparams-get`
- `parallel/test-whatwg-url-custom-searchparams-getall`
- `parallel/test-whatwg-url-custom-searchparams-has`
- `parallel/test-whatwg-url-custom-searchparams-set`

## What Is The Issue

The failures expose three concrete mismatches:

- `util.inspect({ a: new URL(...) })` prints `{ a: [URL] }` instead of
  `{ a: URL {} }`.
- A custom URL parsing case preserves/encodes a lone surrogate as
  `%ED%A0%BD`, while Node replaces it with `%EF%BF%BD`.
- Passing a `Symbol` into `URLSearchParams` methods throws
  `TypeError: cannot convert symbol to string`; Node expects
  `TypeError: Cannot convert a Symbol value to a string`.

## How Should We Fix It

Keep the fixes close to the URL implementation:

1. Add or adjust the custom inspect hook for `URL` so `internal/util/inspect`
   sees the same empty-object presentation Node uses for custom URL subclasses.
2. Normalize USVString conversion for URL paths and query values. Lone
   surrogate code units must become U+FFFD before percent-encoding.
3. Replace implicit QuickJS string concatenation/coercion in `URLSearchParams`
   methods with explicit Node-compatible `String()`/USVString conversion that
   throws the expected Symbol TypeError message.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-inspect.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-parsing.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-append.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-set.js
```
