# Node Test: StringDecoder UTF-8 boundaries

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
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

## How Should We Fix It

Inspect `src/edge_string_decoder.cc` and compare its UTF-8 state machine with
Node's string decoder behavior for invalid leading bytes, incomplete sequences,
and `.end()` flushing. The fix should adjust the native decoder state, not the
JS wrapper, so all consumers of the `string_decoder` binding get the same
boundary behavior.

Build a tiny table-driven repro for the failing `f0,b8,41` case before editing,
then add the Node suite tests as verification.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-string-decoder.js
build-edge-quickjs-cli/edge test/parallel/test-string-decoder-end.js
```
