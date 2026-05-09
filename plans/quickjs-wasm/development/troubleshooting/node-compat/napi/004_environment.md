# Known Issue: Environment lifecycle

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Removed environment side code; remaining state belongs on `napi_env__` and internal classes. |
| **Severity** | High | Environment lifecycle state affects cleanup, teardown, stack limits, and runtime stability. |

## Current State

Environment state is no longer carried by a separate compatibility directory.
The current direction is direct ownership on `napi_env__` plus focused internal
classes such as `napi_promises__`, `napi_contextify__`, and `napi_serdes__`.

## Known Incompatibility

Node's N-API assumes a rich environment lifecycle with deterministic cleanup
hooks and V8-backed runtime services. QuickJS exposes different primitives, so
cleanup, task draining, stack limits, and release still need careful ownership.
The disabled `JS_FreeRuntime(...)` path remains a known teardown issue while
QuickJS GC-owned lifetime problems are unresolved.

## Current Status

Re-enable `JS_FreeRuntime(...)` only as part of a tested lifecycle fix. Stack
sizing, cleanup queues, task queues, and internal subsystem ownership should be
explicit environment configuration or RAII state, not side tables.
