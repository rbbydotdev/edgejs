# V8 N-API lifetime refactor: risk and rollout

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Rollout completed for the N-API shared suite scope. |
| **Severity** | Medium | The highest risk is breaking existing Edge V8 behavior while making handles more Node-like. |

## Rollout Strategy

1. Land tests/diagnostics first.
2. Convert `napi_value` and handle scopes together, but keep the patch small
   enough to review by direct comparison with Node's `js_native_api_v8.*`.
3. Convert callback trampolines next, because the direct-handle model changes
   how callback args and return values must be handled.
4. Convert references/finalizers/wraps after direct locals are stable.
5. Convert externals/type tags/buffers after the tracked-reference model exists.
6. Audit unofficial N-API last, because it has many legitimate long-lived
   `v8::Global` records that should not be removed blindly.

## Key Risks

- Existing Edge code may rely on the current accidental persistence of
  `napi_value__`. The test suite should expose those sites before the refactor
  is merged.
- V8 weak callbacks and finalizers have strict reset/deletion rules. Follow
  Node's `Reference` and `RefTracker` design closely rather than inventing a
  third ownership model.
- `napi_wrap(...)` behavior should follow Node's contract: if a wrap reference
  is returned, a finalizer is required and that reference is normally deleted in
  response to the finalizer.
- `unofficial_napi_contextify.cc` and module-wrap code intentionally keep
  contexts/modules in `v8::Global`; those records are long-lived by design and
  should survive the local-handle cleanup.

## Design Constraints

- Direct `napi_value` handles are current-scope locals. This is intentional
  design, not a defect to fix.
- Public `napi_value` handles must not be made persistent. Persistence belongs
  to `napi_ref` or internal `v8::Global` records only where the API contract
  explicitly owns longer lifetime.

## Verification Checklist

- `make build-napi-v8` or the repo's current V8 build target.
- V8 N-API test suite.
- Focused tests for:
  - handle scope close and mismatch;
  - escapable handle escape-once;
  - callback args, return values, constructor `new_target`;
  - weak ref collection and `napi_get_reference_value(...)` after GC;
  - wrap finalizer and `napi_remove_wrap(...)`;
  - external value data and type tags;
  - cleanup hook and instance-data finalizer order.
- Edge V8 runtime smoke tests for:
  - `-e "console.log('hello from v8')"`
  - simple HTTP server;
  - contextify/script execution;
  - module-wrap/dynamic import path if enabled.

## Verification Run

Completed:

```sh
make -C napi test-napi TEST_JOBS=4
make -C napi test-napi-quickjs TEST_JOBS=4
make test-native-quickjs
make test-native-v8
make -C napi test-native-v8 EXTRA_CMAKE_ARGS=-DNAPI_V8_ENABLE_LIFETIME_TRACKER=ON
NAPI_V8_DIST_ROOT=/Users/sadhbh/src/dev/edgejs/napi/target/debug/build/wasmer-napi-dc5f75328e8ed969/out/v8-prebuilt/11.9.2/darwin-arm64 make -C napi test-native-v8 EXTRA_CMAKE_ARGS='-DNAPI_V8_ENABLE_LIFETIME_TRACKER=ON -DNAPI_V8_ENABLE_LIFETIME_PERIODIC_STATS=ON -DNAPI_V8_ENABLE_LIFETIME_TAG_STATS=ON -DNAPI_V8_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON'
NAPI_V8_DIST_ROOT=/Users/sadhbh/src/dev/edgejs/napi/target/debug/build/wasmer-napi-dc5f75328e8ed969/out/v8-prebuilt/11.9.2/darwin-arm64 NAPI_V8_ENABLE_LIFETIME_TRACKER=ON make build-edge EXTRA_CMAKE_ARGS='-DNAPI_V8_ENABLE_LIFETIME_TRACKER=ON -DNAPI_V8_ENABLE_LIFETIME_PERIODIC_STATS=ON -DNAPI_V8_ENABLE_LIFETIME_TAG_STATS=ON -DNAPI_V8_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON'
EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge/edge -e "console.log('edge v8 napi ok')"
EDGE_TRACE_NAPI_LIFETIME=1 /Users/sadhbh/src/dev/edgejs/build-napi-v8/v8/tests/napi_v8_test_16_reference --gtest_filter='Test16Reference.PortedCoreFlow'
git diff --check
```

Results:

- V8 shared N-API suite: 48/48 passing.
- QuickJS shared N-API suite: 48/48 passing.
- V8 lifetime tracker enabled build: 48/48 passing.
- V8 full lifetime diagnostics build (tracker, periodic stats, tag stats, and
  string/symbol dump): 48/48 passing.
- Edge V8 CLI build with full lifetime diagnostics: passing.
- Edge V8 CLI smoke with lifetime trace: printed `edge v8 napi ok` and emitted
  QuickJS-shaped `[napi-lifetime-*]` teardown tables.
- V8 lifetime trace smoke: balanced `napi_ref` created/released counts and zero
  live refs at env teardown for `Test16Reference.PortedCoreFlow`; output uses
  the same `[napi-lifetime-*]` marker names as QuickJS.
- Whitespace check: passing.

The Edge V8 runtime smoke tests remain a useful follow-up if this refactor is
merged into a broader Edge runtime validation pass.
