# N-API QuickJS Classes

Status: Current as of 2026-05-15.

This directory documents the small internal classes and opaque structs used by
the QuickJS-backed N-API implementation.

The core design rule is explicit lifetime ownership. QuickJS values that cross
the public N-API surface live in allocator-backed records, rather than in V8
local handles. Scope-local values are owned by `napi_scope__`; persistent refs
and env helpers are owned by `napi_env__`; the shared `napi_allocator__` keeps
the public handles stable and pointer-shaped.

## Status Summary

| Area | Status | Notes |
| --- | --- | --- |
| Environment, scopes, values | Current | Pointer-shaped handles backed by fixed-slab allocators. |
| Refs and finalizers | Current | Env-owned refs survive local scopes and are teardown-safe under reentrancy. |
| Externals and backing stores | Current | Finalizer metadata is centralized in env-owned hints. |
| Unofficial V8/Node helpers | Current | Implemented where QuickJS supports the behavior; stable fallbacks otherwise. |
| Diagnostics | Current | Compile-time gated lifetime tracking, no effect when disabled. |

## Core Environment And Values

- [napi_env](napi_env.md)
- [napi_scope](napi_scope.md)
- [napi_value](napi_value.md)
- [napi_allocator](napi_allocator.md)
- [napi_callback_info](napi_callback_info.md)

## Functions And Externals

- [napi_function](napi_function.md)
- [napi_external](napi_external.md)
- [napi_external_backing_store_hint](napi_external_backing_store_hint.md)

## References And Finalizers

- [napi_ref](napi_ref.md)

## Async, Promises, And Cleanup

- [napi_deferred](napi_deferred.md)
- [napi_env_cleanup_hook](napi_env_cleanup_hook.md)
- [napi_promises](napi_promises.md)

## Unofficial Node/V8 Compatibility Helpers

- [napi_contextify](napi_contextify.md)
- [napi_module_wrap](napi_module_wrap.md)
- [napi_serdes](napi_serdes.md)
- [napi_callsite](napi_callsite.md)

## Diagnostics

- [napi_lifetime_tracker](napi_lifetime_tracker.md)
