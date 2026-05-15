# `napi_env__`

Status: Current as of 2026-05-15.

`napi_env__` is the QuickJS N-API environment. It binds one `JSContext` to the
public N-API surface, owns env-wide helper storage, and controls teardown order.

The class lives in `napi/quickjs/src/internal/napi_env.h` and `.cc`. It stores
the QuickJS context, module API version, last N-API error state, pending
exception state, instance data, cleanup-hook registrations, the root/current
handle-scope handles, external memory accounting, and env-owned subsystems for
promises, contextify, and module-wrap compatibility.

QuickJS needs explicit handle storage, so the env owns allocator pools for
`napi_scope__`, `napi_ref__`, `napi_env_cleanup_hook__`, `napi_deferred__`, and
`napi_external_backing_store_hint__`. The pools use the shared fixed-slab
`napi_allocator__`, which gives stable pointer-shaped handles while feeding
lifetime diagnostics when tracking is enabled.

The root scope is created during env construction and remains the fallback
current scope. Public N-API functions that produce values call
`wrap_value_in_current_scope(...)`, which stores a `JSValue` in the active
`napi_scope__`. Refs are env-owned instead of scope-owned, because N-API refs
outlive local handle scopes and are released by explicit ref APIs or env
teardown.

Teardown is deliberately ordered. `prepare_teardown()` runs cleanup hooks,
closes deferreds, clears refs with `take_next_used()` while the QuickJS context
is still alive, closes the root scope, tears down promise/contextify/module-wrap
subsystems, and marks the env torn down. The destructor then finalizes instance
data; allocator members close naturally after the destructor body.
