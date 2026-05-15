# V8 N-API lifetime refactor: subtask plan

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented and verified. |
| **Severity** | Medium | Refactor should be staged carefully because it changes public N-API handle semantics throughout the V8 provider. |

## 001 Baseline and Parity Harness

Owner: tests and diagnostics only.

Status: done.

Dependencies: none.

Write scope:

- `napi/tests/js-native-api/`
- `napi/v8/tests/` if present or newly added test glue
- optional diagnostic-only files under `napi/v8/src/internal/`

Tasks:

- Run the current V8 N-API suite and record baseline failures.
- Add focused tests for handle-scope close, escapable scope escape-once,
  callback argument lifetime, weak reference collection, wrap finalizer timing,
  `napi_remove_wrap(...)`, external type tags, and cleanup-hook ordering.
- Add a V8 diagnostic tracker or counters behind a compile-time/runtime flag.

Verification:

- Current V8 tests still pass before the refactor starts.
- New tests should initially expose the known semantic gaps where appropriate.

## 002 Direct `napi_value` Representation

Owner: core V8 handle conversion.

Status: done.

Dependencies: 001.

Write scope:

- `napi/v8/src/internal/napi_v8_env.h`
- `napi/v8/src/js_native_api_v8.cc`
- call sites in `napi/v8/src/unofficial_napi*.cc` that assume `napi_value__`
  heap ownership

Tasks:

- Replace `struct napi_value__` heap/global wrapper with Node-style conversion
  helpers:
  - `JsValueFromV8LocalValue(...)`
  - `V8LocalValueFromJsValue(...)`
- Make `napi_v8_wrap_value(...)` return a direct local-handle cast, not a new
  heap allocation.
- Make `napi_v8_unwrap_value(...)` reconstruct a `v8::Local<v8::Value>`.
- Remove manual `delete` paths for local `napi_value` objects.
- Audit every place that stores `napi_value` beyond the active call. Convert
  those locations to `v8::Global`, `napi_ref`, or a dedicated record.

Verification:

- Build succeeds with no use of `new napi_value__` / `delete napi_value`.
- Existing V8 N-API tests pass at least through primitive/object creation,
  function calls, property access, and script execution.

## 003 Real Handle Scopes

Owner: V8 scope semantics.

Status: done.

Dependencies: 002.

Write scope:

- `napi/v8/src/js_native_api_v8.cc`
- `napi/v8/src/internal/napi_v8_env.h`

Tasks:

- Add Node-style `HandleScopeWrapper` and `EscapableHandleScopeWrapper`.
- Track `env->open_handle_scopes`.
- Implement `napi_open_handle_scope(...)` / `napi_close_handle_scope(...)`
  using real `v8::HandleScope`.
- Implement `napi_open_escapable_handle_scope(...)`,
  `napi_close_escapable_handle_scope(...)`, and `napi_escape_handle(...)`
  using real `v8::EscapableHandleScope::Escape(...)`.
- Return `napi_handle_scope_mismatch` when close order/count is wrong.

Verification:

- Scope and escape tests match Node behavior.
- Callback return values survive because they are either escaped or still valid
  in the caller's active V8 scope.

## 004 Callback and Accessor Trampolines

Owner: JS-to-native callback entry.

Status: done.

Dependencies: 002 and 003.

Write scope:

- `napi/v8/src/js_native_api_v8.cc`

Tasks:

- Replace heap-owned `napi_callback_info__::args` with a Node-style callback
  wrapper that reads directly from `v8::FunctionCallbackInfo`.
- Return `this`, args, and `new_target` through direct local casts.
- Remove `CallbackInfoOwnsValue(...)` and callback-local delete logic.
- Ensure native callback exceptions flow through the env last-exception logic.

Verification:

- Constructor, function, getter, setter, and thrown-exception tests pass.
- No callback path allocates persistent handles for temporary args.

## 005 Node-Shaped References and Finalizers

Owner: persistent references, wraps, finalizers.

Status: done.

Dependencies: 002.

Write scope:

- new `napi/v8/src/internal/napi_ref.*` or equivalent
- `napi/v8/src/internal/napi_v8_env.h`
- `napi/v8/src/js_native_api_v8.cc`

Tasks:

- Port/adapt Node's `RefTracker`, `Reference`, `ReferenceWithData`, and
  `ReferenceWithFinalizer` model.
- Link references/finalizers into env-owned lists rather than detached raw
  pointers.
- Make weak callbacks reset the `v8::Global` and dispatch finalizers through the
  env finalizer path.
- Remove the current `napi_delete_reference(...)` workaround that leaves weak
  ref bookkeeping alive.
- Preserve Edge-specific env cleanup and destroy callbacks.

Verification:

- Weak-ref GC tests pass without use-after-free and without intentionally leaked
  ref records.
- Env teardown finalizes all runtime-owned references exactly once.

## 006 Wraps, Externals, Type Tags, and Buffers

Owner: object-attached native state.

Status: done.

Dependencies: 005.

Write scope:

- `napi/v8/src/js_native_api_v8.cc`
- possible new internal files for external/wrap helpers

Tasks:

- Rework `napi_wrap(...)` to store a Node-shaped tracked reference in the wrapper
  private key.
- Make `napi_unwrap(...)` and `napi_remove_wrap(...)` operate on that reference
  with keep/remove modes.
- Require a finalizer when returning a wrap reference, matching Node's ownership
  contract.
- Add/adapt `ExternalWrapper` so external values can carry native data and type
  tags without env-side identity vectors.
- Store object type tags in V8 private data, not `env->type_tag_entries`.
- Audit buffer records and external backing stores so finalizers are reachable
  from engine-owned objects and env teardown.

Verification:

- `napi_wrap`, `napi_unwrap`, `napi_remove_wrap`, `napi_add_finalizer`,
  `napi_create_external`, and type-tag tests match Node behavior.

## 007 Cleanup and Unofficial N-API Audit

Owner: integration cleanup.

Status: audit done; implementation-sensitive findings are captured in
`004_unofficial_napi_audit.md`.

Dependencies: 002-006.

Write scope:

- `napi/v8/src/unofficial_napi*.cc`
- `napi/v8/src/internal/`
- env teardown in `napi/v8/src/js_native_api_v8.cc`

Tasks:

- Audit all unofficial N-API paths for stale assumptions about heap
  `napi_value__` wrappers.
- Keep persistent `v8::Global` storage only for real long-lived records:
  contexts, modules, promises, source-map callbacks, serializer/deserializer
  state, and platform state.
- Make env teardown deterministic: cleanup hooks, pending finalizers, refs,
  buffers, async/threadsafe stubs, instance data, destroy callbacks.
- Add tracker output comparable to the QuickJS lifetime tracker for V8
  references, finalizers, wrappers, buffers, and open scopes.

Verification:

- Full V8 N-API test suite.
- Edge V8 CLI smoke tests.
- Focused app smoke tests that previously exercised wraps, streams, buffers, and
  contextify/module-wrap paths.
