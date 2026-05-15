# `napi_external_backing_store_hint__`

Status: Current as of 2026-05-15.

`napi_external_backing_store_hint__` stores native payload and finalizer metadata
for QuickJS externals, wrapped objects, and external ArrayBuffers.

It lives in `napi/quickjs/src/internal/napi_external_backing_store_hint.h` and
`.cc`. The struct stores the env, runtime pointer, native data pointer, optional
finalizer callback, optional finalizer hint, finalizer-invoked state, a detach
flag, and an optional weak target used when a finalizer should report a
different JavaScript target.

Creation delegates to `napi_env__::create_external_backing_store(...)`, so hints
are allocated from the env-owned `external_backing_stores_` allocator. Destroy
paths go back through the stored env with
`napi_env__::destroy_external_backing_store(...)`.

`invoke_finalizer()` is idempotent. It calls the stored finalizer at most once
with the env, external data pointer, and finalizer hint. `begin_detach()` and
`end_detach()` coordinate explicit ArrayBuffer detach with later QuickJS
backing-store callbacks.

The runtime pointer is stored because QuickJS finalizers and ArrayBuffer
deleters may be called from runtime-level callbacks. Destroy paths prefer
env-owned storage while the env is alive and fall back to runtime-level cleanup
when only the QuickJS runtime is available.
