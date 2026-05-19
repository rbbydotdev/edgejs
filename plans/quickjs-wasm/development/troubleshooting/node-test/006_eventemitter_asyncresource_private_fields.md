# Node Test: EventEmitterAsyncResource private-field errors

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in the vendored QuickJS private-field TypeError path. |
| **Severity** | Low | The behavior is likely correct, but the observable TypeError text differs from Node/V8. |

Affected test:

- `parallel/test-eventemitter-asyncresource`

## What Is The Issue

The test intentionally calls an `EventEmitterAsyncResource` method with an
invalid receiver. QuickJS throws:

```text
TypeError: private class field '#asyncResource' does not exist
```

The Node test expects a TypeError whose message matches:

```text
/Cannot read private member/
```

This is a cross-engine message compatibility gap, not necessarily a semantic
failure.

## 2026-05-15 Update

Fixed in `napi/quickjs/deps/quickjs/quickjs.c` by changing the missing private
field error text from QuickJS's `private class field ... does not exist` wording
to the Node/V8-compatible `Cannot read private member ... from an object whose
class did not declare it`.

Targeted verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
build-edge-quickjs-cli/edge test/parallel/test-eventemitter-asyncresource.js
```

## 2026-05-19 Debug Teardown Assertion

A Debug build later reproduced a different failure after the test body passed:

```text
Assertion failed: (!block->is_free(slot)), function unsafe_owner, file napi_allocator.h
```

LLDB showed the crash during `napi_env__::prepare_teardown()`.
`clear_refs_for_teardown()` freed all env-owned `napi_ref` allocator slots before
`root_scope->close()` and `JS_RunGC(...)`. QuickJS GC then finalized an
async-wrap destroy-hook external; `DestroyHookFinalizer(...)` called
`IsDestroyHookAlreadyHandled(...)`, which attempted
`napi_get_reference_value(...)` on `DestroyHookData::destroyed_ref`. That raw
`napi_ref` handle pointed at a slot already returned to the free list.

Action plan before code changes:

1. Keep env-owned `napi_ref` slots allocated through QuickJS finalization.
2. Clear their JS ownership before GC so strong values and weak links do not
   keep objects alive during teardown.
3. Let late finalizer calls observe cleared refs as empty/inactive handles
   instead of freed allocator storage.
4. Rerun the focused EventEmitterAsyncResource test and a focused native
   QuickJS reference/teardown test.

Implemented by changing `napi_env__::clear_refs_for_teardown()` to iterate the
env-owned ref allocator and call `clear_for_teardown()` without returning slots
to the allocator free list before QuickJS GC.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
build-edge-quickjs-cli/edge test/parallel/test-eventemitter-asyncresource.js
cd napi && make build-native-quickjs
napi/build-napi-quickjs/quickjs/tests/napi_quickjs_test_16_reference
napi/build-napi-quickjs/quickjs/tests/napi_quickjs_test_37_reference_double_free
napi/build-napi-quickjs/quickjs/tests/napi_quickjs_test_38_finalizer
```

The focused commands passed. A broader `make test-quickjs-only TEST_JOBS=4`
run was stopped after it became dominated by sandbox-local `bind/listen EPERM`
network failures; no allocator assertion recurred before it was terminated.

## How Should We Fix It

Keep this as a vendored QuickJS compatibility patch. The failing Node API reaches
the engine private-field brand check directly, so the stable fix is to make the
missing-private-field TypeError text match the V8/Node wording at that throw
site.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-eventemitter-asyncresource.js
```
