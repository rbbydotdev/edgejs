# Node Test: WHATWG URL inspect and search params

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed with native QuickJS/private-symbol compatibility changes. |
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
- `parallel/test-whatwg-url-invalidthis`

## What Is The Issue

The failures originally exposed three concrete mismatches:

- `util.inspect({ a: new URL(...) })` prints `{ a: [URL] }` instead of
  `{ a: URL {} }`.
- A custom URL parsing case preserves/encodes a lone surrogate as
  `%ED%A0%BD`, while Node replaces it with `%EF%BF%BD`.
- Passing a `Symbol` into `URLSearchParams` methods throws
  `TypeError: cannot convert symbol to string`; Node expects
  `TypeError: Cannot convert a Symbol value to a string`.

## 2026-05-15 QuickJS Error Text And UTF-8 Update

Two of the URL/SearchParams failures are fixed in vendored QuickJS without
changing `lib/internal/url.js`:

- Implicit Symbol-to-string coercion now throws
  `TypeError: Cannot convert a Symbol value to a string`.
- Normal UTF-8 export replaces lone UTF-16 surrogates with U+FFFD, so URL
  parsing percent-encodes `%EF%BF%BD` instead of raw surrogate bytes.

Targeted verification passed:

```sh
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-parsing.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-append.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-constructor.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-delete.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-get.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-getall.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-has.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-searchparams-set.js
```

## 2026-05-15 URL Inspect And Brand Update

The remaining URL inspect and invalid-this failures now pass without changing
`lib/internal/url.js` or `lib/internal/util/inspect.js`.

- `unofficial_napi_create_private_symbol()` now creates real QuickJS private
  symbols, so Node internal slots such as `node:transfer_mode` no longer appear
  in `Object.getOwnPropertySymbols(new URL(...))`.
- With that internal symbol hidden, unchanged `util.inspect` can format nested
  URL instances as `{ a: URL {} }`.
- QuickJS private brand-check failures now use
  `Receiver must be an instance of class`, while ordinary missing private member
  errors still use the `Cannot read private member ...` text.

Targeted verification passed:

```sh
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-custom-inspect.js
build-edge-quickjs-cli/edge test/parallel/test-whatwg-url-invalidthis.js
```

## Implementation Notes

Keep URL compatibility fixes on the native/private-symbol side unless the
Node-shipped `lib/` sources themselves change upstream.
