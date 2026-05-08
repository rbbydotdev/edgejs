# N-API Node Compatibility Adapters

This directory documents the compatibility adapter source pairs under `napi/quickjs/src/compat`. Each article maps one `.h/.cc` pair to the Node behavior it preserves, why QuickJS needs an adapter, and what a better long-term design would look like.

## Adapter Source Pairs

- [Buffer](001_buffer.md): `buffer.{h,cc}`
- [Console](002_console.md): `console.{h,cc}`
- [Contextify](003_contextify.md): `contextify.{h,cc}`
- [Environment](004_environment.md): `environment.{h,cc}`
- [Global shims](005_global_shims.md): `global_shims.{h,cc}`
- [Microtasks](006_microtasks.md): `microtasks.{h,cc}`
- [Module loading](007_module_loading.md): `module_loading.{h,cc}`
- [Properties](008_properties.md): `properties.{h,cc}`
- [QuickJS utilities](009_quickjs_utilities.md): `quickjs_utilities.{h,cc}`
- [Serdes](010_serdes.md): `serdes.{h,cc}`

## Related Engine-Level Notes

These notes also live under the N-API compatibility area because they affect the QuickJS-backed N-API runtime, but they are not one of the extracted adapter source pairs:

- [QuickJS WASIX atomics patch](011_quickjs_wasix_atomics_patch.md)
- [V8-shaped CallSite methods](013_v8_shaped_callsite_methods.md)
