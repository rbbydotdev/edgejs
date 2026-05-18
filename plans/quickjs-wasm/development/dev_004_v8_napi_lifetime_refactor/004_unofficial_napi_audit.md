# V8 N-API lifetime refactor: unofficial N-API audit

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Stage 007 audit complete; 2026-05-16 escaped-local follow-up implemented. |
| **Severity** | High | Several unofficial N-API result paths rely on the current heap-owned `napi_value__` wrapper instead of the intended current-scope local-handle design. |

## Scope

Audited source areas:

- `napi/v8/src/unofficial_napi.cc`
- `napi/v8/src/unofficial_napi_contextify.cc`
- `napi/v8/src/unofficial_napi_error_utils.cc`
- `napi/v8/src/unofficial_napi_error_utils.h`
- `napi/v8/src/internal/napi_v8_env.h`
- `napi/v8/src/internal/unofficial_napi_bridge.h`
- `napi/v8/src/internal/node_v8_default_flags.h`

This pass looked for stale assumptions that `napi_value` is a heap object backed
by `v8::Global`, and for any attempt to persist public `napi_value` handles
outside the current N-API/V8 handle scope.

## Summary

The unofficial N-API files mostly avoid storing raw `napi_value` in durable
records. Contextify and module-wrap state correctly use `napi_ref` or
`v8::Global` for durable values. The largest Stage 007 risk is result-producing
helpers that create a nested `v8::HandleScope`, call `napi_v8_wrap_value(...)`,
and return the `napi_value` after that nested scope closes. That works today
because `napi_value__` promotes every local to a `v8::Global`; it will not work
after `napi_value` becomes a direct local-handle cast.

The internal header still exposes the pre-refactor lifetime model directly:
`napi_value__` owns `v8::Global<v8::Value>` and `napi_callback_info__` stores
`napi_value` fields and vectors (`napi/v8/src/internal/napi_v8_env.h:15`,
`napi/v8/src/internal/napi_v8_env.h:25`). Stage 007 should treat any remaining
source that depends on public `napi_value` persistence as a blocker after
Stages 002-004, because current-scope local handles are the intended design.

## 2026-05-16 V8 Node-Compat Follow-Up

The `v8-macos` CI log in `test-failures-v8.log` exposed the predicted
escaped-local failure mode after the direct-local `napi_value` refactor. Several
Node compatibility tests crashed or misbehaved with V8 heap dumps showing
`<NativeContext[302]>` in places where contextify-returned values were expected,
including cross-realm `ArrayBuffer`, `String`, and `Uint8Array` cases exercised
by Buffer, querystring, crypto subtle, and VM/domain tests.

The fix updated result-producing paths in:

- `napi/v8/src/unofficial_napi_contextify.cc`
- `napi/v8/src/unofficial_napi_error_utils.cc`

Single-result paths now use `v8::EscapableHandleScope` and
`Escape(...)` before returning through `napi_v8_wrap_value(...)`. Error helpers
with multiple `napi_value*` outputs no longer open a nested `v8::HandleScope`,
so their returned locals are allocated in the caller/current N-API scope instead
of a closing temporary scope. Public `napi_value` handles remain direct
current-scope locals; persistence still belongs to `napi_ref` or explicit
`v8::Global` records.

The same follow-up also fixed contextify exception propagation: V8
`TryCatch::ReThrow()` alone did not set the N-API pending-exception state that
the Edge runtime expects when `unofficial_napi_contextify_run_script(...)`
returns. Contextify now wraps the caught V8 exception as a current-scope
`napi_value` and throws it through N-API before returning
`napi_pending_exception`. This restored top-level `-e` failures and getter
exceptions that flow through `vm.runInThisContext(...)`.

Verification run for the patch:

```sh
git -C napi diff --check -- v8/src/unofficial_napi_contextify.cc v8/src/unofficial_napi_error_utils.cc
cmake --build build-edge --target edge -j4
build-edge/edge -e "throw new Error('xyz')"
build-edge/edge test/parallel/test-os-userinfo-handles-getter-errors.js
```

The direct throw command is expected to exit nonzero and print the thrown stack.

## Findings

| Risk | Area | Evidence | Recommendation |
| --- | --- | --- | --- |
| High | Internal value and callback representation | `napi_value__` is still an owning `v8::Global` wrapper (`napi/v8/src/internal/napi_v8_env.h:15`) and callback info still stores `this_arg`, `new_target`, and `std::vector<napi_value>` (`napi/v8/src/internal/napi_v8_env.h:25`). | Stage 007 should verify Stages 002 and 004 have removed these fields before merging. Public `napi_value` handles should remain current-scope locals; callback code should read from `v8::FunctionCallbackInfo` and only escape a return value into the caller/current parent scope when required by V8 scope nesting. |
| High | Result values returned from nested handle scopes | Error helpers open `v8::HandleScope` and return wrapped locals at `napi/v8/src/unofficial_napi_error_utils.cc:405`, `napi/v8/src/unofficial_napi_error_utils.cc:426`, `napi/v8/src/unofficial_napi_error_utils.cc:471`, `napi/v8/src/unofficial_napi_error_utils.cc:489`, `napi/v8/src/unofficial_napi_error_utils.cc:512`, and `napi/v8/src/unofficial_napi_error_utils.cc:528`. Similar patterns exist in call-site helpers (`napi/v8/src/unofficial_napi.cc:2463`, `napi/v8/src/unofficial_napi.cc:2514`) and private symbol creation (`napi/v8/src/unofficial_napi.cc:2612`, `napi/v8/src/unofficial_napi.cc:2637`). | Convert result-producing nested scopes to `v8::EscapableHandleScope` and escape the V8 local before converting to `napi_value`, or remove the nested scope and rely on the caller's active N-API/V8 handle scope. |
| High | Contextify compile/run result APIs | `unofficial_napi_contextify_run_in_context(...)`, compile function, CJS loader compile, module request output, module evaluation, namespace, error, cached-data, and facade paths all open `v8::HandleScope` and return wrapped locals (`napi/v8/src/unofficial_napi_contextify.cc:1598`, `napi/v8/src/unofficial_napi_contextify.cc:1711`, `napi/v8/src/unofficial_napi_contextify.cc:1768`, `napi/v8/src/unofficial_napi_contextify.cc:1912`, `napi/v8/src/unofficial_napi_contextify.cc:1927`, `napi/v8/src/unofficial_napi_contextify.cc:1994`, `napi/v8/src/unofficial_napi_contextify.cc:2320`, `napi/v8/src/unofficial_napi_contextify.cc:2353`, `napi/v8/src/unofficial_napi_contextify.cc:2420`, `napi/v8/src/unofficial_napi_contextify.cc:2447`, `napi/v8/src/unofficial_napi_contextify.cc:2524`, `napi/v8/src/unofficial_napi_contextify.cc:2532`, `napi/v8/src/unofficial_napi_contextify.cc:2552`, `napi/v8/src/unofficial_napi_contextify.cc:2553`, `napi/v8/src/unofficial_napi_contextify.cc:2667`, `napi/v8/src/unofficial_napi_contextify.cc:2679`, `napi/v8/src/unofficial_napi_contextify.cc:2746`, `napi/v8/src/unofficial_napi_contextify.cc:2780`). | Audit every `napi_value* result_out` path after direct handles land. Use escaped locals for returned values and keep purely internal temporaries inside ordinary `HandleScope`. Add focused tests around contextify script return values, compile cache buffers, module namespace/error retrieval, and required-module facade. |
| Medium | V8 callback entry points that synthesize N-API values | Dynamic import and import-meta callbacks create temporary `napi_value` arrays from V8 locals inside V8 host callbacks (`napi/v8/src/unofficial_napi_contextify.cc:1194`, `napi/v8/src/unofficial_napi_contextify.cc:1215`, `napi/v8/src/unofficial_napi_contextify.cc:1272`). | Keep these values temporary, but ensure the V8 callback has an explicit local scope compatible with the direct-handle model and that any result returned to V8 is escaped as V8, not held as `napi_value`. |
| Medium | Serializer/deserializer native contexts | `SerializerContext` and `DeserializerContext` keep weak `v8::Global<v8::Object>` wrapper records and raw `napi_env` pointers (`napi/v8/src/unofficial_napi.cc:915`, `napi/v8/src/unofficial_napi.cc:1130`, `napi/v8/src/unofficial_napi.cc:1136`, `napi/v8/src/unofficial_napi.cc:1344`). | The wrapper globals are intentional. Stage 007 should add env-tracked cleanup or diagnostics for these records so env teardown cannot leave raw `napi_env` users only governed by V8 weak callbacks. |
| Medium | Teardown coverage for global registries | Env destroy resets promise callbacks/hooks, prepare-stack callbacks, error formatting state, profiler state, fatal/near-heap callbacks, and platform targets (`napi/v8/src/unofficial_napi.cc:1710`, `napi/v8/src/unofficial_napi.cc:1727`, `napi/v8/src/unofficial_napi.cc:1732`, `napi/v8/src/unofficial_napi.cc:1739`, `napi/v8/src/unofficial_napi.cc:1744`). Context and module-wrap cleanup hooks reset their records (`napi/v8/src/unofficial_napi_contextify.cc:775`, `napi/v8/src/unofficial_napi_contextify.cc:802`). | Keep this cleanup ordering, but add tracker output for all surviving global maps and weak wrapper contexts so Stage 007 can prove teardown reaches zero for refs, module records, context records, serializer contexts, and prepare/promise hooks. |

## Intentional long-lived globals

These `v8::Global` records should remain long-lived, or be converted only into
equivalent tracked long-lived records:

- Env-owned context and private keys: `context_ref`, `last_exception`,
  `last_exception_message`, wrap/buffer private keys in
  `napi/v8/src/internal/napi_v8_env.h:57` and
  `napi/v8/src/internal/napi_v8_env.h:60`.
- Env type-tag entries at `napi/v8/src/internal/napi_v8_env.h:46`. Stage 006 may
  move these into object/private state, but Stage 007 should not remove them
  without that replacement.
- Source-map and preserved error formatting state in
  `napi/v8/src/unofficial_napi_error_utils.cc:35`, reset through
  `napi/v8/src/unofficial_napi_error_utils.cc:447`.
- Contextify records: context globals plus persistent key refs in
  `napi/v8/src/unofficial_napi_contextify.cc:42`, stored through
  `napi/v8/src/unofficial_napi_contextify.cc:1297`.
- Module-wrap records: wrapper/callback/source/host-option `napi_ref`s and
  context/module globals in `napi/v8/src/unofficial_napi_contextify.cc:68`,
  destroyed through `napi/v8/src/unofficial_napi_contextify.cc:563`.
- Promise reject callbacks and promise hooks in
  `napi/v8/src/unofficial_napi.cc:87`, set at
  `napi/v8/src/unofficial_napi.cc:2224` and
  `napi/v8/src/unofficial_napi.cc:2240`.
- Prepare-stack-trace callbacks in `napi/v8/src/unofficial_napi.cc:72`, reset
  by `napi/v8/src/unofficial_napi.cc:341`.
- Serializer/deserializer wrapper globals in
  `napi/v8/src/unofficial_napi.cc:1132` and
  `napi/v8/src/unofficial_napi.cc:1346`.
- The temporary `UnofficialEnvScope` context global in
  `napi/v8/src/unofficial_napi.cc:50`, which keeps the bootstrap context alive
  until the env is created and then reset during scope release.

## Stage 007 recommended changes

1. After Stages 002-004, run `rg -n "napi_value__|std::vector<napi_value>|delete .*napi_value|CallbackInfoOwnsValue|new napi_value__" napi/v8/src` and treat any remaining local wrapper ownership as a blocker.
2. Convert all unofficial APIs that both open a nested `v8::HandleScope` and set a `napi_value*` output to escape the returned V8 local or allocate it in the caller's active scope.
3. Keep module/context/promise/source-map/serializer globals, but register them in a V8 lifetime tracker so teardown diagnostics can distinguish intentional long-lived records from leaks.
4. Add focused smoke tests for the result-returning unofficial APIs after direct handles land: contextify run/compile, CJS loader compile, module namespace/error/cached-data/facade, error source-line/thrown-at helpers, call-site helpers, private symbol creation, structured clone, serialize/deserialize, and serdes binding construction.
5. Verify `unofficial_napi_destroy_env_instance(...)` still clears every global map before isolate disposal, then compare tracker counts before and after `unofficial_napi_release_env(...)`.
