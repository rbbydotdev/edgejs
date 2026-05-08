# N-API Compat: Environment

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/environment.{h,cc}`. |
| **Severity** | High | Environment lifecycle state affects cleanup, teardown, stack limits, and runtime stability. |

## Source Pair

- `napi/quickjs/src/compat/environment.h`
- `napi/quickjs/src/compat/environment.cc`

## What It Does

The environment adapter owns QuickJS-specific side state associated with an N-API environment. It tracks cleanup and destroy callbacks, promise-hook and async-context state, stack-size configuration, and runtime-lifetime decisions that do not fit cleanly in the public `napi_env` entry points.

## Why It Is Needed

Node's N-API assumes a rich environment lifecycle with deterministic cleanup hooks and V8-backed runtime services. QuickJS exposes different primitives, so the backend needs a compatibility state object to bridge env creation, cleanup, task draining, and release. This is also where current teardown limitations are contained, including the known disabled `JS_FreeRuntime(...)` path while GC-owned lifetime issues remain unresolved.

## Could We Do It Better

The better endpoint is to move more of this state into the concrete QuickJS `napi_env__` implementation with RAII ownership and a tested teardown sequence. Re-enabling `JS_FreeRuntime(...)` should be treated as a lifecycle fix, not as a local cleanup toggle. Stack sizing and callback queues should also become explicit environment configuration rather than loosely coupled compatibility state.

## Reconciled Notes

This article reconciles the previous disabled-runtime-free and stack-guard notes. The relevant compatibility behavior is now represented by the environment adapter under `napi/quickjs/src/compat`.
