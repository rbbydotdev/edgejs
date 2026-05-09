# Known Issue: Buffer

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Accepted incompatibility after removing the N-API Buffer repair code. |
| **Severity** | Medium | Node-facing code frequently treats binary data as `Buffer`, not only as generic typed arrays. |

## Current State

There is no QuickJS N-API Buffer repair layer now. Values created as QuickJS
typed arrays keep QuickJS typed-array behavior unless a real EdgeJS/Node
`Buffer` implementation creates them.

## Known Incompatibility

Node embedders and package code often rely on `Buffer` methods,
`Buffer.isBuffer(...)`, and string conversion semantics even when binary data
originates from native N-API allocation. QuickJS does not have Node's built-in
`Buffer` object model, so plain typed arrays can be too weak for some Node
programs.

## Current Status

If Node `Buffer` compatibility becomes required again, the work should be a
real Buffer implementation in EdgeJS bootstrap/runtime code, with the N-API
allocation path constructing Buffer-backed values deliberately. It should not be
a prototype repair pass after allocation.
