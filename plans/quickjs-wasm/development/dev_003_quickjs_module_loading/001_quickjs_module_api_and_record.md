# Subtask 001: QuickJS Module API and Record

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented in vendored QuickJS plus `napi_module_wrap__`; focused source-text module checks pass. |
| **Severity** | High | Without a real source-text `ModuleWrap`, Node's JS loaders cannot link or evaluate module graphs. |

## Scope

Implement the QuickJS backend's core source-text module record and add the
minimal vendored QuickJS APIs needed to mirror V8's `ModuleWrap` lifecycle.

## Write Ownership

Primary files:

- `napi/quickjs/src/quickjs/quickjs.h`
- `napi/quickjs/src/quickjs/quickjs.c`
- `napi/quickjs/src/internal/napi_module_wrap.h`
- `napi/quickjs/src/internal/napi_module_wrap.cc`
- `napi/quickjs/src/unofficial_napi.cc`
- `napi/quickjs/CMakeLists.txt`

Do not edit Node JS loader files in this subtask except for small diagnostics
needed to prove integration points.

## Dependencies

None. This subtask should begin by comparing the V8 implementation in:

```text
napi/v8/src/unofficial_napi_contextify.cc
```

Focus on behavior, not V8-specific object lifetime assumptions.

## Required Behavior

- Compile source text modules with QuickJS compile-only module evaluation.
- Store a stable `JSModuleDef*` and owning `JSValue`.
- Expose module requests with specifier, attributes, and evaluation phase.
- Implement `link(...)` as a dependency-record table populated by JS loader
  output.
- Implement `instantiate()` as QuickJS link-only behavior, not evaluation.
- Implement `evaluate()` and `evaluateSync()` through evaluate-only QuickJS
  behavior.
- Map QuickJS module status to `internalBinding('module_wrap')` constants.
- Preserve and expose module evaluation errors through `getError()`.
- Report top-level await and async graph state.

## QuickJS API Patch

Add the smallest public C API needed by the N-API backend:

- request count and request metadata;
- module status;
- top-level await and async graph checks;
- link-only;
- evaluate-only;
- module evaluation error retrieval.

Keep the API names clearly embedder-oriented and avoid leaking large internal
struct definitions into N-API C++ code.

## Verification Expectations

Add focused tests before broad framework runs:

```sh
make build-napi-quickjs
make test-napi-quickjs-only
```

At this stage, passing tests should include source-text module creation,
request enumeration, link/instantiate/evaluate status transitions, and namespace
access for a dependency-free module.

## Implementation Result

The vendored QuickJS API now exposes V8-shaped module introspection and split
lifecycle operations: request enumeration, explicit host linking, link-only,
evaluate-only, status, evaluation error, top-level-await, async-graph,
`import.meta`, and dynamic import hooks.

`napi/quickjs/src/internal/napi_module_wrap.{h,cc}` owns the QuickJS-backed
module records, with `unofficial_napi.cc` reduced to forwarding glue for the
module-wrap symbols. Source text modules compile in QuickJS compile-only mode
and expose request objects with specifier, attributes, and phase.
