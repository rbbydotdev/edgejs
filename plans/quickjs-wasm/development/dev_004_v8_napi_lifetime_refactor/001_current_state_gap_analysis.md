# V8 N-API lifetime refactor: current state and gap analysis

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented. |
| **Severity** | Medium | The V8 backend is functional, but its handle, reference, wrap, and finalizer lifetimes are less Node-like than both Node's V8 N-API and the newer QuickJS backend. |

## Scope

Compare:

- QuickJS reference implementation: `napi/quickjs/src/`
- Edge V8 implementation: `napi/v8/src/`
- Node V8 implementation reference: `node/src/js_native_api_v8.*`

The goal is not to port QuickJS mechanics directly into V8. The goal is to bring
the Edge V8 implementation back toward Node's V8 ownership model, while reusing
the cleanup discipline and diagnostics lessons learned in the QuickJS backend.

## Current Edge V8 Shape

The Edge V8 provider currently defines `napi_value__` as an owning wrapper around
`v8::Global<v8::Value>` in `napi/v8/src/internal/napi_v8_env.h`. Every call to
`napi_v8_wrap_value(...)` allocates a heap object and promotes a local V8 handle
to a persistent/global handle. Handle scopes in `napi/v8/src/js_native_api_v8.cc`
are lightweight structs with only `env` and `escaped` state; they do not contain
real V8 `HandleScope` / `EscapableHandleScope` objects and do not bound the
lifetime of returned `napi_value` handles.

References, wraps, buffers, finalizers, and type tags are mostly independent
records held through `std::vector<void*>`, `v8::Global`, private properties, and
weak callbacks. This works for many paths, but it is unlike Node's implementation
and makes local handles look persistent by default.

## QuickJS Lessons

The QuickJS backend solved the same class of bugs through explicit ownership:

- `napi_value__` owns a `JSValue`, and values are allocated into an active
  `napi_scope__`.
- `napi_scope__` owns local value slots and implements close/escape behavior.
- `napi_ref__` is separate env-owned storage for persistent references.
- external/wrap/finalizer state lives in dedicated external backing-store
  records and is finalized by engine-owned weak/finalizer paths.
- `napi_function__::trampoline(...)` opens a callback-local handle scope and
  duplicates the return value before closing it.
- `napi_lifetime_tracker__` can report value, reference, scope, external, and
  callback object counts without changing normal runtime behavior.

For V8, the key lesson is not "copy QuickJS slots". It is "make local handles
local again, keep persistent ownership explicit, and make finalizer ownership
trackable".

## Node V8 Reference Point

Node's `node/src/js_native_api_v8.h` has the desired `napi_value` shape:

```cpp
static_assert(sizeof(v8::Local<v8::Value>) == sizeof(napi_value),
              "Cannot convert between v8::Local<v8::Value> and napi_value");

inline napi_value JsValueFromV8LocalValue(v8::Local<v8::Value> local) {
  return reinterpret_cast<napi_value>(*local);
}

inline v8::Local<v8::Value> V8LocalValueFromJsValue(napi_value v) {
  v8::Local<v8::Value> local;
  memcpy(static_cast<void*>(&local), &v, sizeof(v));
  return local;
}
```

Node then uses real `v8::HandleScope` and `v8::EscapableHandleScope` wrappers for
N-API scopes, while `napi_ref` is a tracked `v8impl::Reference` around
`v8::Global`. Wraps and finalizers are also represented by tracked references
with explicit runtime or userland ownership.

## Main Gaps

1. `napi_value` representation is too heavy and too persistent.
   Edge V8 currently turns locals into heap-allocated global handles. This
   bypasses V8's native local-handle scope model and can retain values far
   longer than intended.

2. handle scopes are not real handle scopes.
   `napi_open_handle_scope(...)` allocates a plain struct; closing it does not
   release local V8 handles. `napi_escape_handle(...)` returns the same handle
   instead of using `EscapableHandleScope::Escape(...)`.

3. callback info owns heap-wrapped arguments.
   Function/accessor trampolines allocate `napi_value__` wrappers for `this`,
   args, return values, and `new_target`, then delete some of them manually.
   Node passes local handles through the callback wrapper.

4. references are close in spirit but not Node-like enough.
   `napi_ref__` has a `v8::Global`, weak callback, and refcount, but it is not a
   `RefTracker`, is not linked into env lists, and has a known "do not delete
   weak ref during GC" workaround that intentionally leaks the bookkeeping
   object.

5. wraps/finalizers are split across private properties and vectors.
   Node stores a tracked reference behind the wrapper private key. Edge V8 stores
   raw native data, an optional raw ref pointer, and a separate finalizer record.
   This makes ownership rules harder to reason about and diverges from Node.

6. type tags and externals diverge from Node behavior.
   Edge V8 uses an env vector of `v8::Global` entries for object type tags and
   raw `v8::External` values for externals. Node uses object/private state for
   objects and an `ExternalWrapper` for external values, including type tags.

7. cleanup is not unified.
   Env teardown manually walks several vectors. Node's env carries tracked lists
   for references/finalizers and has explicit finalizer enqueue/dequeue behavior.

## Desired End State

- `napi_value` in `napi/v8/src` is a direct V8 local-handle slot cast, following
  Node's `JsValueFromV8LocalValue(...)` / `V8LocalValueFromJsValue(...)`.
- N-API handle scopes allocate real V8 handle-scope wrappers and enforce mismatch
  checks.
- `napi_ref`, wraps, externals, and finalizers use Node-shaped tracked reference
  classes adapted to Edge's smaller env.
- Local handles are not promoted to `v8::Global` unless the API explicitly asks
  for persistence: references, env state, cached constructors, context records,
  module records, buffers, or finalizers.
- A V8 lifetime tracker, inspired by the QuickJS tracker, can report live
  references/finalizers/wrap records and open-scope counts in diagnostic builds.

## Implementation Result

Implemented across the Stage 001-006 task sequence:

- `napi_value` now follows Node-style direct local-handle conversion.
- N-API handle scopes use real V8 `HandleScope` / `EscapableHandleScope`
  wrappers with LIFO close validation and real escape behavior.
- Callback info is stack-backed and reads directly from V8 callback state.
- `napi_ref__`, `napi_ref_with_data__`, `napi_ref_with_finalizer__`,
  `napi_ref_tracker__`, `napi_external_wrapper__`, handle-scope wrappers, and
  callback-info wrappers now live as `napi_***__` internal classes under
  `napi/v8/src/internal/`, with utility callbacks in `napi_util.*`.
- `napi_ref__` is env-tracked; weak refs reset/unlink through finalization, and
  the previous weak-delete leak workaround was removed. Finalizer references use
  a Node-shaped finalizing list and env-mediated drain queue.
- Cleanup hooks now run in Node-style LIFO passes and tolerate removal by later
  hooks.
- Wraps, finalizers, externals, and type tags were moved onto tracked,
  Node-shaped ownership.
- V8 now has QuickJS-style lifetime tracker plumbing under
  `napi/v8/src/internal/napi_lifetime_tracker.*`, enabled with
  `NAPI_V8_ENABLE_LIFETIME_TRACKER=ON` and dumped with
  `EDGE_TRACE_NAPI_LIFETIME=1`.
- The V8 tracker uses the same output markers as QuickJS
  (`[napi-lifetime-stats]`, `[napi-lifetime-slots]`,
  `[napi-lifetime-types]`, `[napi-lifetime-tags]`, and related tables), while
  keeping V8 semantics thin: public `napi_value` handles are direct current
  scope V8 locals, and the tracker records their creation/release for diagnostics
  without making them persistent.
- Simple V8 value constructors now follow Node's direct local-handle result
  pattern where Edge's standalone env boundary permits it. This includes
  undefined/null/global/boolean, scalar number/bigint creators, object/array,
  array-with-length, symbols, and dates.
- Root `make test-native-v8` and `make test-native-quickjs` now forward to the
  native N-API backend test targets under `napi/`.

## Reference Rule

For continuing V8 N-API work, treat `napi/quickjs/src` as the current Edge
behavioral baseline and `node/src/js_native_api_v8.cc` as the V8-native
reference. The `napi/v8` implementation should follow Node's V8 shape unless
there is a concrete Edge embedding constraint, such as Node-private
`Environment` state, Node's split `node_api.cc` ownership, libuv/runtime hooks,
or Edge-specific env/contextify/module-wrap integration.

Verification after implementation:

```sh
make -C napi test-napi TEST_JOBS=4
make -C napi test-napi-quickjs TEST_JOBS=4
make test-native-v8
make test-native-quickjs
```

The shared native V8 and QuickJS suites now pass 48/48. The tracker-enabled V8
build also passed 48/48, and a focused `EDGE_TRACE_NAPI_LIFETIME=1`
`Test16Reference.PortedCoreFlow` run emitted balanced `napi_ref` lifetime stats
at env teardown.
