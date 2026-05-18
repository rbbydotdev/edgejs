# Node Test: StringDecoder UTF-8 boundaries

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in native StringDecoder binding. |
| **Severity** | Medium | Incorrect replacement-character behavior can corrupt streaming UTF-8 decoding. |

Affected tests:

- `parallel/test-string-decoder`
- `parallel/test-string-decoder-end`

## What Is The Issue

Invalid or incomplete UTF-8 sequences produce too many replacement characters.
The log shows examples such as:

```text
'��a' !== '�a'
Expected "\ufffd\u41", but got "\ufffd\ufffd\u41"
input: f0,b8,41
```

Node's `StringDecoder` coalesces certain invalid multi-byte prefix sequences
into one replacement character across chunk/end boundaries. The current native
decoder state in QuickJS Edge emits one replacement for the bad prefix and
another for the following byte.

## 2026-05-15 Native Decoder Update

The failing UTF-8 boundary cases now pass without changing `lib/`. The native
binding had a UTF-8 decoder with the right streaming behavior, but
`MakeStringFromBytes(...)` tried `Buffer.from(...).toString('utf8')` first.
That raw Buffer fallback produced too many replacement characters for cases
such as `f0,b8,41`.

The native `StringDecoder` binding now bypasses the Buffer fallback for UTF-8
and uses its streaming-aware decoder directly. QuickJS Buffer UTF-8 slicing gets
matching replacement behavior from the QuickJS N-API implementation of
`napi_create_string_utf8()`, so the shared Buffer binding does not need a
QuickJS-specific decoder and V8 keeps its native string behavior.

Smoke check:

```text
new StringDecoder('utf8').write(Buffer.from([0xf0, 0xb8, 0x41])) === '\uFFFDA'
```

Targeted verification passed:

```sh
build-edge-quickjs-cli/edge test/parallel/test-string-decoder.js
build-edge-quickjs-cli/edge test/parallel/test-string-decoder-end.js
build-edge-quickjs-cli/edge test/parallel/test-string-decoder-fuzz.js
```

## Implementation Notes

Keep future streaming-state fixes in the native StringDecoder binding. Keep raw
Buffer UTF-8 byte-to-string parity in the N-API backend so engine differences do
not leak into the shared Buffer binding. The JS wrapper should remain unchanged.
