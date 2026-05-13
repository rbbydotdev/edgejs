# Known Issue: Environment lifecycle

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | `JS_FreeRuntime(...)` is enabled again; remaining lifecycle risk is finalizer/order correctness during teardown. |
| **Severity** | High | Environment lifecycle state affects cleanup, teardown, stack limits, and runtime stability. |

## Current State

Environment state is no longer carried by a separate compatibility directory.
The current direction is direct ownership on `napi_env__` plus focused internal
classes such as `napi_promises__`, `napi_contextify__`, and `napi_serdes__`.
`napi_env__` now owns allocator-backed scope, reference, cleanup-hook,
deferred, and external backing-store storage. Runtime release calls
`JS_FreeContext(...)` and `JS_FreeRuntime(...)`; the env object is kept alive
until after QuickJS runtime finalizers can run, then instance data is finalized
and the env is deleted.

## Known Incompatibility

Node's N-API assumes a rich environment lifecycle with deterministic cleanup
hooks and V8-backed runtime services. QuickJS exposes different primitives, so
cleanup, task draining, stack limits, and release still need careful ownership.
The previous disabled `JS_FreeRuntime(...)` workaround is historical. The
current teardown issue is narrower: QuickJS GC/finalizer callbacks can still
re-enter N-API during context/runtime release, so env-owned data and
external/wrap finalizer state must remain valid until those callbacks finish.

## Current Status

Keep `JS_FreeRuntime(...)` enabled. Stack sizing, cleanup queues, task queues,
allocator-backed handle storage, and internal subsystem ownership should remain
explicit environment configuration or RAII state, not side tables. Treat new
teardown crashes as ordering/finalizer lifetime bugs rather than as permission
to disable runtime release again.
