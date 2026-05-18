# `quickjs::detail::napi_lifetime_tracker__`

Status: Current as of 2026-05-15.

`napi_lifetime_tracker__` is the diagnostic lifetime tracker for the QuickJS
backend.

It lives in `napi/quickjs/src/internal/napi_lifetime_tracker.h` and `.cc` under
the `quickjs::detail` namespace. It records allocator create/release events for
`napi_value__`, `napi_ref__`, `napi_env_cleanup_hook__`, `napi_deferred__`, and
`napi_external_backing_store_hint__`, plus semantic scope escapes.

The tracker is compile-time gated by `NAPI_ENABLE_LIFETIME_TRACKER`. When the
flag is enabled, `napi_allocator_lifetime__` specializations route allocator
events into per-type tracking. When disabled, the same call sites compile to
no-ops.

Dumping is controlled at runtime with `EDGE_TRACE_NAPI_LIFETIME=1`, with
additional periodic and string/tag/object detail controlled by the generic
lifetime tracker flags. `napi_quickjs_lifetime_dump(...)` exists as an extern
entry point so LLDB or diagnostics can request a snapshot.

The tracker is intentionally observational. It does not own handles or alter
runtime lifetime; it reports the shape of env-owned refs/helpers and
scope-owned value slots so leaks and root-scope retention can be investigated.
