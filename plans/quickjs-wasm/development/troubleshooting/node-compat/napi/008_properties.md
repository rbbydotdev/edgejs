# N-API Compat: Properties

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/properties.{h,cc}`. |
| **Severity** | Medium | Property assignment differences can surface as surprising N-API behavior. |

## Source Pair

- `napi/quickjs/src/compat/properties.h`
- `napi/quickjs/src/compat/properties.cc`

## What It Does

The properties adapter provides Node-compatible assignment behavior for cases where QuickJS would reject a write through the normal property path. In particular, it can define an own property when the inherited property shape would otherwise make a Node/V8-style N-API set operation fail unexpectedly.

## Why It Is Needed

N-API callers expect property operations to follow Node/V8 behavior, not raw QuickJS descriptor semantics in every edge case. Libraries that attach state to objects during initialization can trip over inherited readonly or accessor-only properties if the backend simply forwards to QuickJS. This adapter keeps the compatibility rule in one place and documents that the divergence is intentional.

## Could We Do It Better

The cleaner design is to make every public N-API property setter route through a small, tested property semantics layer. That layer should describe when QuickJS behavior is preserved and when V8 compatibility wins. If future QuickJS wrappers model Node object shapes more accurately, this adapter should shrink to only the truly observable V8 differences.
