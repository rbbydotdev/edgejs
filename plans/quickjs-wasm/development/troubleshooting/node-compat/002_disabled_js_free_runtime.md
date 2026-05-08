# Compatibility Adapter: Disabled `JS_FreeRuntime(...)`

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | High | Masks QuickJS object lifetime leaks during teardown. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

## Source Notes

- `plans/quickjs-wasm/development/006_framework_app_adapters.md`
- `AGENTS.md`

## What Is The Compatibility Adapter

`JS_FreeRuntime(...)` is disabled in the QuickJS N-API env release path because
runtime teardown still hits:

```text
Assertion failed: list_empty(&rt->gc_obj_list)
```

That lets otherwise successful native and WASIX runs exit instead of aborting.

## Why It Is Suspect

This turns a real ownership bug into a leak. The runtime can appear stable even
though refs, wrapped values, module records, callbacks, or pending jobs are
still keeping QuickJS objects alive past environment release.

## How To Do It Better

Add a deterministic teardown path: close scopes, cleanup hooks, refs, callbacks,
module caches, and queued jobs in an intentional order. Add a debug teardown
mode that runs GC and reports remaining object classes. Re-enable
`JS_FreeRuntime(...)` in tests first, then normal builds.
