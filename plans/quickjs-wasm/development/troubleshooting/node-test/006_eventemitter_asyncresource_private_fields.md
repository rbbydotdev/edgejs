# Node Test: EventEmitterAsyncResource private-field errors

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
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

## How Should We Fix It

Avoid global QuickJS TypeError rewrites. Instead, wrap the affected
`EventEmitterAsyncResource` public methods in JS-level receiver validation
before touching private fields. Throw a Node-compatible `TypeError` message when
the receiver is not an instance carrying the expected private slots.

This keeps the compatibility fix local to the Node API that promises the V8-like
message.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-eventemitter-asyncresource.js
```
