# N-API Compat: Buffer

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/buffer.{h,cc}`. |
| **Severity** | Medium | Node-facing code frequently treats binary data as `Buffer`, not only as generic typed arrays. |

## Source Pair

- `napi/quickjs/src/compat/buffer.h`
- `napi/quickjs/src/compat/buffer.cc`

## What It Does

The buffer adapter repairs the prototype chain for N-API-created byte arrays so values that QuickJS naturally represents as typed arrays can behave more like Node `Buffer` instances. It finds the runtime `Buffer.prototype` when the bootstrap has exposed it and applies that prototype to compatible values.

## Why It Is Needed

Node embedders and package code often rely on `Buffer` methods, `Buffer.isBuffer(...)`, and string conversion semantics even when the value originates from a native N-API allocation. QuickJS does not have Node's built-in `Buffer` object model, so a plain typed array can be semantically too weak for framework and test expectations. This adapter keeps the compatibility behavior close to the N-API QuickJS boundary rather than spreading `Buffer` checks through call sites.

## Could We Do It Better

The cleaner endpoint is for the bootstrap and N-API allocation path to construct real Node-compatible `Buffer` values from the start. That would avoid prototype repair after allocation and would make ownership, external backing stores, slices, and identity checks easier to reason about. A focused `Buffer` support matrix would also help separate behavior that must match Node from behavior that can remain typed-array-compatible for now.
