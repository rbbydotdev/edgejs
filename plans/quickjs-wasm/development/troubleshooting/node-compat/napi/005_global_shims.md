# N-API Compat: Global Shims

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/global_shims.{h,cc}`. |
| **Severity** | Medium | Node and framework code probe for modern globals during bootstrap. |

## Source Pair

- `napi/quickjs/src/compat/global_shims.h`
- `napi/quickjs/src/compat/global_shims.cc`

## What It Does

The global-shims adapter installs small Node-facing global compatibility pieces into the QuickJS context. These include well-known symbol compatibility, WeakRef-related handling where required by the runtime, and bootstrap support for JavaScript paths that expect WebAssembly-backed dependencies such as Undici's llhttp layer.

## Why It Is Needed

Modern Node packages often check for globals before choosing code paths. QuickJS may not expose the same objects, or may expose them with different behavior, which can push libraries into failing branches during startup. Centralizing these shims makes the compatibility policy visible and keeps feature probes from being patched individually across EdgeJS and N-API code.

## Could We Do It Better

The stronger approach is to provide real engine-backed implementations for each global where feasible, and to make unsupported globals fail in a way that matches Node's capability detection. WebAssembly-dependent shims should eventually be replaced by a proper WebAssembly story or by loader choices that avoid pretending unavailable runtime features exist.
