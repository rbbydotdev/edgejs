# Node Test: EventEmitterAsyncResource private-field errors

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in the vendored QuickJS private-field TypeError path. |
| **Severity** | Low | The behavior is likely correct, but the observable TypeError text differs from Node/V8. |

Affected test:

- `parallel/test-eventemitter-asyncresource`

## What Is The Issue

The test intentionally calls an `EventEmitterAsyncResource` method with an
invalid receiver. QuickJS throws:

```text
TypeError: private class field '#asyncResource' does not exist
```

The Node test expects a TypeError whose message matches:

```text
/Cannot read private member/
```

This is a cross-engine message compatibility gap, not necessarily a semantic
failure.

## 2026-05-15 Update

Fixed in `napi/quickjs/deps/quickjs/quickjs.c` by changing the missing private
field error text from QuickJS's `private class field ... does not exist` wording
to the Node/V8-compatible `Cannot read private member ... from an object whose
class did not declare it`.

Targeted verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
build-edge-quickjs-cli/edge test/parallel/test-eventemitter-asyncresource.js
```

## How Should We Fix It

Keep this as a vendored QuickJS compatibility patch. The failing Node API reaches
the engine private-field brand check directly, so the stable fix is to make the
missing-private-field TypeError text match the V8/Node wording at that throw
site.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-eventemitter-asyncresource.js
```
