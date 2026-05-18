# Known Issue: QuickJS N-API lifetime tracing

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | `napi_allocator__` owns N-API handle/helper storage and feeds `napi_lifetime_tracker__`; native event scopes are in place, function metadata uses raw QuickJS externals, and weak/external opaque lifetimes are now delegated to QuickJS instead of env identity maps. |
| **Severity** | Medium | Growth can destabilize long-running Edge QuickJS servers, but this note tracks diagnostics rather than a confirmed blocker. |

## Current State

The current source of truth is:

- `JS_FreeRuntime(...)` is enabled in `napi/quickjs/src/unofficial_napi.cc`.
  Env release keeps `napi_env__` alive until after QuickJS context/runtime
  finalizers can run, then finalizes instance data and deletes the env.
- `napi_allocator__` is the storage mechanism for QuickJS N-API scopes, refs,
  cleanup hooks, deferred promises, external backing-store hints, and
  scope-owned values. The current allocator uses fixed-size aligned blocks and
  stable pointer-shaped public handles.
- `napi_lifetime_tracker__` receives allocator create/release hooks. The
  tracker is compile-time gated and can report slot totals, active counts,
  scope levels, tags, string/symbol values, object prototype buckets, and
  external backing hint counts.
- `napi_function__::trampoline(...)` opens a callback-local handle scope around
  JS-to-native callbacks, duplicates callback return values before closing that
  scope, and releases the temporary local handle.
- `napi_env__::wrap_external_data(...)` creates a raw QuickJS external
  `JSValue` for native pointers. That raw value is not itself a `napi_value`
  and is not inserted into any handle scope until a public N-API call explicitly
  wraps it with `env->wrap_value_in_current_scope(...)`.
- The remaining `server.js` growth diagnosis is not that the allocator leaks
  by itself. The tracker shows native EdgeJS event paths creating request-local
  N-API values while `env->current_scope()` is still the env root scope. Those
  values then survive until environment teardown.

EdgeJS runtime code under `src/` still creates many legitimate long-lived refs
for binding singletons, wrapper objects, stream and filesystem requests, async
hooks, timers, and process state. Many paths delete refs explicitly, but others
rely on object finalizers or environment teardown. The lifetime tracker is used
to separate expected persistent ownership from request-local handle retention.

## Action Plan

1. Map allocation and free paths for `napi_value__`, `napi_ref__`,
   `napi_env__`, handle scopes, escapable handle scopes, callback info,
   externals, functions, deferred promises, and cleanup hooks.
2. Inspect representative EdgeJS `src/` bindings for explicit
   `napi_delete_reference(...)`, `napi_wrap(...)` finalizers, and handle-scope
   discipline.
3. Keep `napi_lifetime_tracker__` wired through allocator hooks so normal
   builds stay silent but diagnostic builds can report live handle/helper
   counts.
4. Use the tracker to distinguish root-scope value retention and env-owned refs.
   Native opaque payloads attached to QuickJS values should be tracked by
   QuickJS finalizer/weak-record paths, not by env identity side maps.
5. Continue with narrow native event-entry handle scopes around paths that
   construct N-API arguments before invoking JavaScript.

## Initial Investigation Notes

- `plans/quickjs-wasm/development/001_merge_analysis.md` already identified
  the key QuickJS N-API runtime types and the preference for internal RAII-style
  ownership over broad public structs.
- `004_environment.md` records the current teardown caveat around
  `JS_FreeRuntime(...)`: runtime release is enabled, and finalizer/order bugs
  should be fixed with env lifetime and allocator ownership, not by disabling
  runtime release again.
- The first instrumentation pass should remain diagnostic-only and avoid
  changing normal runtime semantics.

## Instrumentation Added

Added `napi_lifetime_tracker__` under `napi/quickjs/src/internal`. The whole
tracker is compile-time gated behind `NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER`,
which defaults to `OFF`. When compiled in, it records created, destroyed, live,
and peak counts for:

- `napi_env__`
- `napi_scope__`
- `napi_handle_scope__`
- `napi_escapable_handle_scope__`
- `napi_value__`
- `napi_ref__`
- `napi_callback_info__`
- `napi_external_backing_store_hint__`
- `napi_deferred__`
- `napi_env_cleanup_hook__`

Enable the tracker at configure time, then enable event logging at runtime with:

```sh
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON
cmake --build build-edge-quickjs-cli --target edge -j4
EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge-quickjs-cli/edge server.js
```

When the compile-time flag is off, `napi_lifetime_tracker.cc` is not compiled
into `napi_quickjs`, tracker headers are not included by the owner classes, and
the `record_create(...)` / `record_destroy(...)` call sites are excluded by the
preprocessor.

The tracker dumps live counts at `napi_env__` teardown. When compiled in, it also
exposes:

```c
napi_quickjs_lifetime_dump("lldb checkpoint")
```

so LLDB can request a snapshot while the process is paused.

Set `EDGE_TRACE_NAPI_LIFETIME_DUMP_EVERY=<N>` to print periodic summary dumps
every N creations of a given type.

## Lifetime Map

- `napi_env__` is allocated in
  `unofficial_napi_create_env_from_context(...)` and destroyed through
  `DestroyEnvInstance(...)` / `ReleaseEnvScope(...)`.
- `napi_env__` creates a root `napi_scope__`; later allocator-backed scope work
  made root-scope teardown explicit so root-owned values/refs are released
  during env destruction.
- Most public N-API value-producing calls wrap `JSValue`s into
  `env->current_scope()->wrap_value(...)`, which allocates `napi_value__`.
- Explicit handle scopes are allocated by `napi_open_handle_scope(...)` /
  `napi_open_escapable_handle_scope(...)` and destroyed only by the matching
  close APIs.
- `napi_ref__` is allocated by `napi_create_reference(...)` and freed by
  `napi_delete_reference(...)`; weak refs are also tracked on `napi_env__`.
- `napi_external_backing_store_hint__` backs externals, wraps, finalizers, and
  external array buffers; it is attached to QuickJS as opaque data and is
  destroyed by QuickJS class or array-buffer finalizers, or by
  `napi_remove_wrap(...)`.
- Internal QuickJS function metadata must not create `napi_value` wrappers just
  to smuggle native callback/data pointers into `JS_NewCFunctionData(...)`.
  `napi_env__::wrap_external_data(...)` creates the raw QuickJS external
  `JSValue`; public `napi_create_external(...)` then wraps that `JSValue` into
  the current handle scope only when returning a public `napi_value`.
- `napi_callback_info__` is stack-allocated in the QuickJS C-function
  trampoline for each N-API callback.

### Scope and ownership picture

The QuickJS backend has three different lifetime containers that must not be
blurred together:

```text
napi_env__
  |
  +-- root scope, level 0
  |     owns root-local napi_value slots
  |
  +-- current scope pointer
  |     points at root unless a handle scope is open
  |
  +-- env-owned ref allocator
  |     owns napi_ref slots independently of handle scopes
  |
  +-- env-owned helper allocators
        cleanup hooks, deferreds, external backing-store hints,
        callback helpers, scope records
```

Opening a handle scope pushes a short-lived local allocation layer:

```text
before callback:

  current_scope
      |
      v
  [level 0 root scope]

inside native event or callback:

  current_scope
      |
      v
  [level 1 local scope]  <-- new napi_value handles live here
      |
      v
  [level 0 root scope]

inside helper that must return one value:

  current_scope
      |
      v
  [level 2 escapable scope]  -- Escape(value) --> value moves to level 1
      |
      v
  [level 1 local scope]
      |
      v
  [level 0 root scope]
```

Facts to keep straight:

- A `JSValue` is the QuickJS engine value.
- A `napi_value` is a public handle slot around a `JSValue`.
- `env->wrap_value_in_current_scope(js_value, owned)` creates the `napi_value`
  in whatever `env->current_scope()` points to at that exact moment.
- If no local handle scope is open, the current scope is the root scope, so
  temporary `napi_value` handles become root-owned and survive until env
  teardown.
- `napi_ref` is not a local handle. It is persistent env-owned storage that
  keeps or observes a `JSValue` across scopes. `napi_get_reference_value(...)`
  creates a fresh `napi_value` in the current scope when code asks for the
  referenced object again.
- `napi_external_backing_store_hint__` is native pointer/finalizer state handed
  to QuickJS as opaque data. It is allocated from
  `napi_env__::external_backing_stores_`, then attached to a QuickJS object with
  `JS_SetOpaque(...)` or to an ArrayBuffer as the free-function opaque pointer.
  It is not a `napi_value`, does not live in a handle scope, and is not tracked
  through an env identity map.

The simplest mental model is:

```text
QuickJS object/value
    |
    +-- optional public napi_value handle
    |      lives in current handle scope
    |
    +-- optional napi_ref
    |      lives in env ref allocator
    |
    +-- optional opaque external/wrap hint
           lives in env external backing-store allocator and is reached through
           JS_SetOpaque or ArrayBuffer opaque data
```

### External data flow

External native pointer data now has two deliberately separate paths.

Internal QuickJS metadata can wrap a native pointer as a raw `JSValue` only:

```cpp
JSValue callback_data = env->wrap_external_data(reinterpret_cast<void *>(cb));
```

That allocates an external backing-store hint and creates a QuickJS external
object with the hint as its opaque payload. It does not allocate a `napi_value`
slot in root or in the current handle scope.

Public `napi_create_external(...)` uses the same raw primitive, then creates a
public handle in the current scope because the N-API contract returns a
`napi_value`:

```cpp
napi_status NAPI_CDECL napi_create_external(napi_env env,
                                            void *data,
                                            napi_finalize finalize_cb,
                                            void *finalize_hint,
                                            napi_value *result)
{
  if (!napi_util__::check_env(env) || result == nullptr)
    return napi_invalid_arg;

  JSValue obj = env->wrap_external_data(data, finalize_cb, finalize_hint);
  if (JS_IsException(obj))
  {
    return napi_util__::return_pending_if_caught(env,
                                                 "Failed to create external object");
  }

  *result = env->wrap_value_in_current_scope(obj, true);
  return (*result == nullptr) ? napi_generic_failure : napi_ok;
}
```

So the public path is:

```text
native pointer
  -> napi_env__::wrap_external_data(...)
       -> QuickJS external JSValue + env-owned backing hint
  -> env->wrap_value_in_current_scope(...)
       -> public napi_value in current scope
```

The internal path is shorter:

```text
native pointer
  -> napi_env__::wrap_external_data(...)
       -> QuickJS external JSValue + env-owned backing hint
       -> no napi_value handle
```

The QuickJS external object's finalizer invokes the stored finalizer, clears any
weak refs for the finalizer target, and releases the backing hint through the
env allocator. `napi_remove_wrap(...)` is the explicit early-release path for
native objects attached with `napi_wrap(...)`: it extracts the external data,
detaches the opaque/wrap record from the JS object, destroys the backing hint,
and returns the native pointer to the caller.

### Function and class metadata flow

`napi_function__::create(...)` is the core function factory for
`napi_create_function(...)`, methods, getters/setters, and constructors created
by `napi_define_class(...)`.

The metadata passed into QuickJS C functions should stay raw:

```cpp
JSValue data_values[2];
data_values[0] = env->wrap_external_data(reinterpret_cast<void *>(cb));
data_values[1] = env->wrap_external_data(data);

JSValue fn = JS_NewCFunctionData(env->context(), trampoline, 0, magic, 2,
                                 data_values);
JS_FreeValue(env->context(), data_values[0]);
JS_FreeValue(env->context(), data_values[1]);

*result = env->wrap_value_in_current_scope(fn, true);
```

The important ownership detail is that `data_values[]` are QuickJS values used
to initialize `JS_NewCFunctionData(...)`. They are freed after QuickJS has
captured them. No temporary `napi_value` is created for the callback pointer or
the callback data pointer.

The resulting function itself is a public N-API value because callers need a
`napi_value`:

```text
napi_function__::create(...)
  |
  +-- raw external JSValue for napi_callback
  +-- raw external JSValue for callback data
  |
  +-- JS_NewCFunctionData(...)
          stores those values inside the QuickJS function object
  |
  +-- wrap_value_in_current_scope(function)
          returns public napi_value for the function
```

When JavaScript calls the function, `napi_function__::trampoline(...)` opens a
callback-local handle scope before building callback arguments and
`napi_callback_info__`. Those callback argument `napi_value` handles are local
to that callback scope. If the native callback returns a value, the trampoline
duplicates the returned `JSValue` before the callback-local scope closes.

Classes are layered on top of functions:

```text
napi_define_class(...)
  |
  +-- napi_function__::create(constructor)
  |      returns constructor napi_value in current scope
  |
  +-- JS_NewObject(ctx) prototype
  |
  +-- for each method/getter/setter:
  |      napi_function__::create(property callback)
  |      JS_DefineProperty... on constructor or prototype
  |
  +-- result = constructor napi_value
```

Constructing an instance uses the constructor's `JSValue` and wraps the created
instance into the current scope:

```text
napi_new_instance(...)
  |
  +-- prepare_call_args(env, argc, argv)
  |      converts input napi_value handles to JSValue array
  |
  +-- JS_CallConstructor(...)
  |
  +-- wrap_value_in_current_scope(instance)
          returns instance napi_value in current scope
```

Native instance ownership is separate from constructor/class creation. A later
`napi_wrap(...)` attaches a native pointer/finalizer to an object using an
external backing-store hint. If QuickJS accepts the object's opaque slot, the
hint is attached there. If the object already has incompatible opaque storage,
the hint is stored in a separate QuickJS external object under the internal
`__napi_wrap__` property. In both cases, `napi_unwrap(...)` reads the hint and
returns its native pointer, while `napi_remove_wrap(...)` detaches and destroys
the hint early.

### QuickJS WeakRef intrinsic and N-API weak refs

`JS_AddIntrinsicWeakRef(ctx)` is QuickJS's installer for the ECMAScript
`WeakRef` and `FinalizationRegistry` constructors. It registers QuickJS internal
classes, creates the global constructors/prototypes, and relies on internal
`JSWeakRefRecord` lists hanging off `JSObject` / `JSAtomStruct`
`first_weak_ref` fields. During object or symbol teardown, QuickJS calls
`reset_weak_ref(...)` to clear `WeakRef` targets, remove `WeakMap`/`WeakSet`
records, and enqueue `FinalizationRegistry` cleanup jobs when allowed.

Because this tree vendors QuickJS, the backend now exposes only the native parts
it needs instead of double-tracking target identity in `napi_env__`:

- QuickJS has a new native weak record kind, `JS_WEAK_REF_KIND_NATIVE`, plus a
  shared native weak anchor/link API. `JS_GetNativeWeakRef(...)` returns the one
  native weak anchor for a live target `JSValue`, `JS_AddNativeWeakRefLink(...)`
  links each weak `napi_ref__` into that shared anchor, and
  `JS_DeleteNativeWeakRefLink(...)` unlinks it.
- Multiple weak `napi_ref__` slots pointing at the same `JSValue` therefore
  share one QuickJS-owned native weak anchor. Each `napi_ref__` embeds one
  `JSNativeWeakRefLink weak_link_` by value. When QuickJS resets the target's
  internal weak-ref list, it walks those embedded links, each linked
  `napi_ref__` clears itself to `{ JS_UNDEFINED, nullptr }`, and QuickJS frees
  the shared native weak anchor as part of target teardown.
- QuickJS has `JS_GetArrayBufferFreeInfo(...)`, which exposes the ArrayBuffer
  `free_func` and `opaque` pair already stored in `JSArrayBuffer`. During
  `napi_detach_arraybuffer(...)`, the backend asks QuickJS for that pair and
  recognizes `napi_external__::free_external_array_buffer_data` directly.
- QuickJS has `JS_GetRefCount(...)` for diagnostics. That count is the engine's
  total `JSValue` ownership pressure for the pointed-to payload, not the
  Node-API logical reference count returned by `napi_reference_ref(...)` and
  `napi_reference_unref(...)`.
- `napi_env__` no longer owns `weak_refs_` or `external_array_buffer_hints_`.
  There is no env-side identity mirror for those lifetimes.
- `napi_ref__` no longer caches `can_be_weak_`; weak state is the fact that
  QuickJS linked its embedded `JSNativeWeakRefLink`. It still keeps the N-API
  logical `ref_count_`, matching the V8 backend, because that value is API
  state rather than duplicate lifetime tracking.

The resulting ownership rule is deliberately simple:

```text
JSValue -> napi_value
  stored in current handle scope

JSValue -> napi_ref
  stored in N-API persistent/root ref storage
  napi_ref keeps the public N-API ref/unref count

native pointer -> QuickJS opaque JSValue / ArrayBuffer opaque
  not stored in napi_env__
  QuickJS owns the death notification/finalizer path

same JSValue -> multiple weak napi_refs
  QuickJS target weak list contains one JSNativeWeakRef anchor
  each napi_ref embeds one JSNativeWeakRefLink in that anchor's list
  target GC walks the embedded links
  each subscribed napi_ref clears to JS_UNDEFINED + nullptr
  QuickJS frees the shared native weak anchor
```

After collection, cloning or otherwise copying from an existing weak `napi_ref`
state must preserve emptiness:

```text
a = JSValue { someObject }
b = napi_ref { a, weak_link_ linked }
c = napi_ref { a, weak_link_ linked }

GC collects a

b = napi_ref { JS_UNDEFINED, nullptr }
c = napi_ref { JS_UNDEFINED, nullptr }

d = clone/copy state from c
d = napi_ref { JS_UNDEFINED, nullptr }
```

There is no route back from `c` to the old `a`; `napi_get_reference_value(c)`
returns `nullptr`, and `napi_reference_ref(c)` returns `0`.

### 2026-05-13 external data split

Development plan for this pass:

1. Add `napi_env__::wrap_external_data(void *data)` as the internal raw
   QuickJS external constructor.
2. Keep a finalizer-aware overload for public `napi_create_external(...)` so
   Node-API finalizer semantics stay intact.
3. Change `napi_create_external(...)` to call `wrap_external_data(...)` and
   only then wrap the returned `JSValue` into the current scope.
4. Change `napi_function__::create(...)` to pass raw external `JSValue`s into
   `JS_NewCFunctionData(...)`, with no `napi_create_external(...)` and no
   `JS_DupValue(napi_quickjs_value_inner(...))` bridge.
5. Verify with the full QuickJS N-API suite and the Edge CTest suite.

Implementation result:

- `napi/quickjs/src/internal/napi_env.{h,cc}` defines
  `wrap_external_data(...)`.
- `napi/quickjs/src/js_native_api_quickjs.cc::napi_create_external(...)` now
  uses the raw helper plus `wrap_value_in_current_scope(...)`.
- `napi/quickjs/src/internal/napi_function.cc::napi_function__::create(...)`
  now stores callback/data metadata as raw QuickJS external values.
- The exact root-scope pattern with `napi_create_external(...)` followed by
  `JS_DupValue(napi_quickjs_value_inner(...))` is gone from `napi_function.cc`.

Verification:

```sh
make test-napi-quickjs JOBS=4
ctest --test-dir build-edge-quickjs-cli --output-on-failure
```

Results: 45/45 QuickJS N-API tests passed, and 46/46 Edge CTest tests passed.

## EdgeJS Embedder Findings

Initial inspection found that `src/` did not call
`napi_open_handle_scope(...)` / `napi_close_handle_scope(...)` around native
event callbacks. After the 2026-05-12 scope pass, the Node-mapped callback
boundaries listed below use `edge::HandleScope` or `edge::EscapableHandleScope`.
Runtime bindings still rely on explicit `napi_delete_reference(...)`, object
finalizers from `napi_wrap(...)`, and environment-slot destructors for
persistent state.

Representative paths that do close refs explicitly:

- binding singleton state such as task queue, timers, stream symbols, tcp/pipe
  constructor refs, and process binding refs deletes old refs before replacing
  them or in state destructors;
- stream write/shutdown/connect request wrappers keep request and buffer refs
  until completion/finalizer cleanup;
- filesystem deferred completions destroy created refs on failure and later
  completion cleanup.

The original missing embedder handle-scope discipline meant temporary values
created during callbacks accumulated in the QuickJS root scope unless the
backend explicitly deleted them. The remaining lifetime work is now to find
unscoped native callback paths outside the current Node-mapped set and to
separate truly persistent `napi_ref` ownership from callback-local
`napi_value` churn.

## Verification

Built the native CLI:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Result: succeeded. The build emitted existing dependency deprecation warnings
from OpenSSL/c-ares paths.

Trace smoke:

```sh
EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge-quickjs-cli/edge -e "console.log('life smoke')" \
  > /private/tmp/edge-lifetime-eval.log 2>&1
```

Result: succeeded and produced lifetime events. Teardown summary showed:

```text
napi_value__ live=10088 peak=10088 created=10280 destroyed=192
napi_ref__ live=3 peak=147 created=148 destroyed=145
napi_callback_info__ live=0 peak=2 created=192 destroyed=192
napi_external_backing_store_hint__ live=2982 peak=2982 created=2982 destroyed=0
```

The existing root `server.js` and `tests/js/webserver.js` failed inside the
default sandbox with `listen EPERM`. Rerunning the loopback server with approval
allowed:

```sh
PORT=3311 EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge-quickjs-cli/edge tests/js/webserver.js \
  > /private/tmp/edge-lifetime-webserver.log 2>&1
curl -sS http://127.0.0.1:3311/
curl -sS http://127.0.0.1:3311/again
```

Both requests returned `hello`. Around listen, `napi_value__` live count was
about `11755`; after two requests it had reached `12367`, while
`napi_callback_info__` repeatedly returned to zero.

## Current Leak Suspects

1. Root-scope retention: `napi_env__::~napi_env__` does not destroy
   `root_scope_`, and `src/` does not open per-callback handle scopes, so
   temporary `napi_value__` wrappers are retained for the life of the env.
2. External hint finalization: `napi_external_backing_store_hint__` live count
   stayed high through short eval/server runs. This may be expected until
   QuickJS GC/finalizers run, but it should be checked with explicit
   `JS_RunGC(...)` and root-scope cleanup experiments.
3. Request churn: two HTTP requests increased live `napi_value__` counts by
   hundreds. The next step is to dump between requests under LLDB and correlate
   the growth with specific callbacks or property/value creation paths.

## Vector-Backed Handle Plan

The next implementation step is to remove per-wrapper allocation for
`napi_value__` and `napi_ref__`.

Planned shape:

1. Add an internal `napi_allocator__` that owns opaque handle encoding,
   decoding, slot construction, and slot release for values and refs.
2. Store actual `napi_value__` entries in `napi_scope__::values_`; the later
   env-owned reference allocator stores actual `napi_ref__` entries in
   `napi_env__::refs_`. Public `napi_value` and `napi_ref` handles are encoded
   allocator handles rather than separate heap-allocated wrapper objects.
3. Reuse freed vector entries by keeping free indexes in each scope instead of
   deleting wrapper allocations.
4. Keep value handles local to the current scope, with parent-scope lookup for
   outer handles used from nested scopes.
5. Keep refs persistent by allocating ref slots from `napi_env__::refs_`,
   because EdgeJS stores refs across callbacks and async completions. They are
   root-lifetime handles conceptually, but their allocator owner is the env.
6. Destroy the root scope during `napi_env__` teardown so root-owned values
   release their duplicated `JSValue`s, then close the env-owned ref allocator
   during env teardown.
7. Preserve `EDGE_TRACE_NAPI_LIFETIME=1` counters while changing the allocation
   backend so before/after server traces remain comparable.

## Historical Vector-Backed Handle Implementation

This section records the earlier vector-backed allocator shape. It was later
superseded by the fixed-block pointer-handle allocator.

That pass implemented `napi_allocator__<T>` for `napi_value__` and `napi_ref__`
slots. The public handles were encoded slot indexes, not addresses of
heap-allocated wrappers. Slot index zero was encoded as pointer value one so
`nullptr` remained the invalid handle.

At that point, `napi_scope__` owned:

```c++
napi_allocator__<napi_value__> values_;
napi_allocator__<napi_ref__> refs_;
```

`napi_value__` and `napi_ref__` were reusable slot payloads with custom move
operations plus `initialize(...)`, `release()`, and `is_active()` methods.
Later allocator work removed that payload protocol in favor of non-copyable,
non-movable payloads constructed in-place and destroyed explicitly.

Value handles were allocated from `env->current_scope()`. Ref handles were
allocated from `env->root_scope()` because EdgeJS stores refs across callbacks,
async completions, finalizers, and binding singleton state. Accessors routed
through:

```c++
napi_quickjs_value_inner(env, value)
napi_quickjs_value_slot(env, value)
napi_quickjs_ref_slot(env, ref)
```

so encoded handles were resolved before reading the slot payload.

`napi_env__::~napi_env__` destroyed the root scope. This released all root-owned
value/ref slots and ran their QuickJS value frees before env teardown completed.

## 2026-05-12 Fixed-Block Allocator Plan

Sadhbh noted that the vector-backed allocator can become inefficient for scope,
value, and ref churn because vector growth can reallocate storage and requires
the reserved-prefix scheme for nested scope handle lookup. The current allocator
keeps stable pointer-shaped handles without keeping cached block index vectors
or list nodes.

Implementation:

- `napi_allocator__<T, Owner>` allocates fixed-size `block__` instances and
  exposes only `T *` payload pointers.
- Blocks are owned by circular intrusive `napi_intrinsic_link__` lists.
  `first_free_` is the sentinel for completely empty blocks, `first_partial_`
  is the sentinel for blocks with both free and live slots, and `first_used_`
  is the sentinel for full blocks. Each block has exactly one allocator-list
  `link_`, and that link is present in exactly one of those three lists except
  while `destroy(T *)` has intentionally unlinked the block before invoking the
  payload destructor.
  `napi_intrinsic_link__` lives header-only in
  `napi/lib/src/napi_intrinsic_link.h`, stores only `next_link_` and
  `prev_link_`, owns circular-list operations such as `link(...)`, `unlink()`,
  `first()`, and `contains(...)`, and recovers embedded owners with
  `unsafe_get<&T::link_>()`.
- `block_layout__` exists only to compute the aligned block size. `block__`
  stores the actual fixed `std::array<slot__, N>` storage, intrusive links, and
  block-local allocation/free-list behavior directly, so pointer-to-member link
  offsets refer to `block__` itself.
- Each `block__` is aligned to the nearest power of two that can hold the block
  layout.
- Each `slot__` stores raw aligned payload storage plus `free_link_` and
  `used_link_`; there is no per-slot active flag. A slot is active when it is
  linked through the block's `first_used_slot_` list.
- The allocator recovers the slot from a payload pointer by subtracting
  `offsetof(slot__, storage_)`, then masks the slot pointer down to the aligned
  power-of-two block boundary to recover the enclosing block.
- `static_assert(sizeof(block__) == block_alignment__)` keeps the mask-down
  assumption honest if the block layout changes.
- `allocate(...)` uses the first block from `first_partial_`, then the first
  block from `first_free_`. If neither list has a block, the allocator creates
  one. After allocation, the block is relinked to `first_partial_` or
  `first_used_` according to its final slot state.
- `destroy(T *)` unlinks the slot from the block used-slot list and, if the
  block was linked at entry, puts the block in vacuum before recording release
  accounting and destroying the payload. It then links the slot to the block
  free list and relinks the block to `first_free_`, `first_partial_`, or
  `first_used_` only if this call put the block in vacuum. Reentrant sibling
  destruction that enters an already-vacuum block leaves relinking to the outer
  destroy.
- `take_used()` / `take_next_used()` marks one live slot free and returns its
  still-constructed payload pointer to the caller for external teardown work.
- Nested scope lookup no longer needs reserved prefix slots. A child allocator
  rejects a parent-owned pointer handle, and `napi_scope__::value_from_handle`
  walks to the parent scope as before.
- `napi_scope__` stores a debug `level_` instead of an allocator index:
  root scope is level 0, and each child scope is `parent.level() + 1`.
- `napi_env__::next_scope_index_` was removed; scope level is derived from the
  handle-scope stack shape, not from allocation order.
- `napi_value__` and `napi_ref__` no longer store copied scope levels either;
  their owning scope is implicit in the allocator that contains the slot.

Complexity and performance notes:

- The allocation hot path is O(1): use the front free block or create one, pop
  one slot from that block's internal free list, construct the payload in place,
  and move the block to `first_used_` only when it becomes full.
- The release hot path is O(1): recover the slot from the pointer, mask down to
  the aligned block base, unlink the slot from `first_used_slot_`, call the
  payload destructor, and push the slot back through `first_free_slot_`.
- Block scheduling uses only circular `napi_intrinsic_link__` relinks. There is
  no full-block scan and no cached block-vector erase.
- Handles are stable real pointers. Allocating or relinking a block cannot
  relocate existing slots, so `napi_value`, `napi_ref`, and scope handles do not
  depend on vector capacity or integer index encoding.
- Block-local slot arrays keep ordinary allocation/free churn cache-friendly
  within each block, while avoiding the large copy/move behavior of vector
  growth.
- `unsafe_owner(T *)` is the raw pointer-to-owner calculation. Ownership checks
  are separate and use `owns(T *)` or higher-level env/scope/ref validation
  helpers.
- Diagnostic operations such as `count_active()` and `begin()` / `end()` remain
  intentionally O(number of blocks or slots), because they are aggregate
  queries used by tracing, teardown, and tests rather than the request-time
  allocation hot path.

Cycle and memory-use notes:

- The old vector-backed allocator could turn one allocation into a capacity
  growth event that moves many existing entries. That is bad for CPU cycles and
  fundamentally incompatible with pointer-shaped handles unless handles are
  encoded indexes. The fixed-block allocator removes that relocation class
  entirely.
- Normal allocation now touches one available-block pointer, one slot pointer,
  and the payload initialization. Normal release touches the payload release
  plus a few fields in the owning block. That is the shape we want for request
  churn: small, predictable work per N-API local.
- The main memory cost is bounded slack inside the last partially used block:
  with block size `N`, each allocator can retain up to `N - 1` unused slots in a
  non-empty tail block. That trades a little reserved memory for stable handles
  and O(1) slot reuse.
- Empty blocks live on `first_free_`, partially used blocks live on
  `first_partial_`, and full blocks live on `first_used_`. `close()` destroys
  live slots and releases every block from all three mutually exclusive chains.
- Compared with vector capacity growth, this model should reduce allocator
  cycle spikes under bursty request load and make memory behavior easier to
  reason about: memory grows in fixed block increments, slots are reused
  immediately, and no active handle is invalidated by growth.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target \
  napi_quickjs_test_36_handle_scope \
  napi_quickjs_test_15_function \
  napi_quickjs_test_16_reference \
  napi_quickjs_test_41_instance_data -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_36_handle_scope --gtest_filter=Test36HandleScope.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_15_function --gtest_filter=Test15Function.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_16_reference --gtest_filter=Test16Reference.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_41_instance_data --gtest_filter=Test41InstanceData.PortedCoreFlow
make test-napi-quickjs-only
cmake --build build-edge-quickjs-cli --target edge -j4
```

Results:

- Focused allocator-sensitive tests passed.
- `make test-napi-quickjs-only` passed 45/45.
- Edge CLI relink passed.
- After switching block alignment from fixed 64 KiB to computed nearest
  power-of-two, the focused handle-scope/function/reference tests were rebuilt
  and passed again.

## 2026-05-12 Extending Fixed-Block Allocation To Other N-API Helpers

Action plan before code changes:

1. Reuse `napi_allocator__` for helper objects that currently use QuickJS
   `js_mallocz(...)` manually.
2. Classify ownership by semantic lifetime rather than by convenience:
   `napi_callback_info__` is already a good stack object because it is
   callback-frame data and cannot escape the callback; `napi_env_cleanup_hook__`
   is environment data and must be owned by `napi_env__`.
3. Keep `napi_deferred__` environment-owned. The public `napi_deferred` handle
   is intentionally resolved/rejected later, often after the handle scope that
   created the promise has closed.
4. Keep `napi_external_backing_store_hint__` environment-owned because QuickJS
   stores raw hint pointers in object opaques and array-buffer finalizer
   opaques. Ownership separation means QuickJS owns the death notification path,
   not that the backing-store record must use `new`/`delete`.
5. Do not add an allocator for `napi_external__` itself because it is a static
   QuickJS class helper, not an allocated per-instance wrapper. Its allocated
   payload is `napi_external_backing_store_hint__`.
6. Preserve existing public create/destroy entry points where useful, but route
   them through the owning allocator.

Implementation:

- Left `napi_callback_info__` as a stack object in
  `napi_function__::trampoline(...)`. It is callback-frame metadata, cannot
  outlive the native callback, and stack storage is cheaper and clearer than an
  allocator slot.
- Added env-owned `napi_allocator__` instances for
  `napi_env_cleanup_hook__`, `napi_deferred__`, and
  `napi_external_backing_store_hint__`.
- Routed `napi_env_cleanup_hook__::create/destroy(...)` and
  `napi_deferred__::create/destroy(...)` through `napi_env__`.
  `napi_external_backing_store_hint__::create/destroy(...)` also uses
  `napi_env__::external_backing_stores_`; QuickJS finalizer/remove paths still
  decide when the record dies.
- Closed deferred and cleanup-hook allocators during `napi_env__` teardown while
  the QuickJS context is still alive. External backing hints are not proactively
  closed during `prepare_teardown()` because QuickJS object and ArrayBuffer
  finalizers can still hold raw hint pointers until the context/runtime
  finalizer phase. The env-owned allocator is finally closed by normal
  `napi_env__` member destruction after that phase.
- Removed the old helper-local `js_mallocz(...)` / `js_free(...)` allocation
  path for those env-owned helper objects.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target \
  napi_quickjs_test_35_promise \
  napi_quickjs_test_38_finalizer \
  napi_quickjs_test_41_instance_data \
  napi_quickjs_test_15_function -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_35_promise --gtest_filter='Test35Promise.*'
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_38_finalizer --gtest_filter=Test38Finalizer.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_41_instance_data --gtest_filter=Test41InstanceData.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_15_function --gtest_filter=Test15Function.PortedCoreFlow
make test-napi-quickjs-only
cmake --build build-edge-quickjs-cli --target edge -j4
```

Results:

- Focused promise, finalizer, instance-data, and function tests passed.
- `make test-napi-quickjs-only` passed 45/45.
- Edge CLI relink passed.

## 2026-05-12 Object Prototype Lifetime Buckets

Action plan before code changes:

1. Extend the existing heavier lifetime value dump path so object prototype
   buckets are captured only on the slower content-dump cadence, alongside
   repeated string/symbol value counts.
2. Scan active `napi_value__` and `napi_ref__` slots for `JS_TAG_OBJECT`.
3. For each object, derive a debug type label from the object's prototype:
   `prototype.constructor.name` where possible.
4. Avoid letting diagnostics perturb runtime state: clear and ignore QuickJS
   exceptions raised while reading prototype or constructor metadata.
5. Collapse object labels into per-scope/per-owner counts and print repeated
   buckets while reporting how many object labels appeared only once.

Implementation:

- Added object prototype bucket collection to the existing
  `NAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP` path. This keeps object
  type inspection on the slower content-dump cadence instead of the normal
  two-second tag-stat cadence.
- For each active object-valued `napi_value__` or `napi_ref__`, the tracker
  reads the object's prototype, then reads `prototype.constructor.name`.
- If the prototype is null, the bucket is `<null-prototype>`.
- If prototype/constructor/name lookup throws or produces no usable name, the
  tracker clears the diagnostic exception and falls back to the QuickJS class
  name, then finally to `<object>`.
- Output lines use:

```text
[napi-lifetime-objects] scope_level=0 napi_value prototype="Object" count=62
[napi-lifetime-objects] scope_level=0 napi_ref prototype="Pipe" count=2
[napi-lifetime-objects] scope_level=0 napi_value singular_object_type_count=1
```

Verification:

```sh
cmake --build build-edge-quickjs-cli --target napi_quickjs -j4
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge -e "class Foo{}; const xs=[]; for (let i=0;i<3;i++) xs.push(new Foo(), {i}, []); console.log(xs.length)"
make test-napi-quickjs
```

Results:

- `napi_quickjs` rebuilt with the lifetime tracker changes.
- The smoke command printed object prototype buckets, including `Object`,
  `<null-prototype>`, `Function`, `Array`, `Pipe`, and typed-array buckets.
- The smoke then hit the existing `JS_FreeRuntime` GC-list assertion after
  `napi_env__ teardown end`; the lifetime dumps had already been emitted.
- `make test-napi-quickjs` rebuilt the test-enabled cache and passed 45/45.

## 2026-05-11 Periodic Allocator Stats

Action plan:

1. Preserve the existing `EDGE_TRACE_NAPI_LIFETIME` event/dump behavior when the
   tracker is compiled in.
2. Add compile-time-off-by-default flags for the tracker and periodic slot stats
   so normal builds keep the tracker source, includes, and call sites compiled
   out.
3. Track value/ref allocator slot deltas at allocation, release, prefix reserve,
   and scope close time instead of scanning all scopes globally.
4. Print at most once every two seconds from allocator activity using a
   monotonic clock check, with no background thread.
5. Rebuild the native QuickJS Edge target both with the default flag-off build
   and with the flag enabled long enough to verify output.

## 2026-05-11 Server Stats Growth Investigation

Action plan:

1. Treat the then-current vector-backed allocator, teardown fixes, and periodic
   stats feature as the baseline; inspect their accounting before changing
   behavior.
2. Confirm whether `build-edge-quickjs-cli` was configured with
   `NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON`; reconfigure only if needed
   for reproduction and record the change.
3. Reproduce `napi-lifetime-stats` growth with `./build-edge-quickjs-cli/edge
   server.js` or a minimal local HTTP server, driving a small request batch with
   `ab` or a simple local client.
4. Use LLDB breakpoints on value wrapping, scope open/close, callback
   trampolines, and ref create/delete to identify whether per-request values
   are allocated into the root scope, a temporary handle scope, or persistent
   ref storage.
5. Separate true retention from allocator bookkeeping: check whether
   `slots_total` growth is expected capacity/freelist growth while `active`
   reflects still-open scopes or root-scope values.
6. If the evidence shows N-API callback entry is missing a temporary handle
   scope, implement the narrowest RAII/internal scope around the QuickJS
   callback trampoline and rerun targeted handle-scope/function/reference tests.

Implementation:

- Added CMake option `NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER`, default `OFF`.
  This controls compilation of `napi_lifetime_tracker.cc`, guarded includes of
  `internal/napi_lifetime_tracker.h`, and all calls to
  `napi_lifetime_tracker__`. Owner files use the lightweight
  `NAPI_QUICKJS_LIFETIME_RECORD(...)` / `NAPI_QUICKJS_LIFETIME_DUMP(...)`
  macros from `internal/napi_lifetime_macros.h`, so the call sites stay compact
  and compile to no-ops when the tracker flag is off.
- Added CMake option
  `NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS`, default `OFF`. Enabling it also
  enables `NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER`, because periodic stats are
  implemented inside the tracker.
- When enabled, `napi_allocator__<napi_value__>` and
  `napi_allocator__<napi_ref__>` report total slot and active slot deltas to
  `napi_lifetime_tracker__`.
- The tracker emits a single-line summary to stderr no more than once every two
  seconds when allocator activity crosses the interval and
  `EDGE_TRACE_NAPI_LIFETIME_STATS=1` or `EDGE_TRACE_NAPI_LIFETIME=1` is set:

```text
[napi-lifetime-stats] napi_value slots_total=10676 active=10676 napi_ref slots_total=176 active=176
```

Enable for a CMake build directory with:

```sh
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
```

Run with `EDGE_TRACE_NAPI_LIFETIME_STATS=1` for stats-only output, or the
existing `EDGE_TRACE_NAPI_LIFETIME=1` for full lifetime event tracing plus
stats. Set the CMake option back to `OFF` and rebuild to return to the default
silent build.

Slot-count caveat: `slots_total` is the aggregate size of the backing vectors
for currently live allocators. For nested handle scopes, value allocators reserve
inactive prefix slots so encoded handles from parent scopes can remain
resolvable by falling back to the parent. Those reserved prefix entries are
included in `napi_value slots_total` but not in `active`.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
make test-napi-quickjs-only
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON
cmake --build build-edge-quickjs-cli --target edge -j4
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
./build-edge-quickjs-cli/edge -e "let n=0; const id=setInterval(()=>{ console.log('tick', ++n); if (n === 4) clearInterval(id); }, 700);"
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=OFF -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=OFF
cmake --build build-edge-quickjs-cli --target edge -j4
```

Results:

- Default flag-off rebuild passed.
- `make test-napi-quickjs-only` passed, 45/45.
- Flag-on rebuild passed and printed the example
  `[napi-lifetime-stats] ...` line above after the interval script crossed two
  seconds.
- The CLI interval and eval smokes still abort after printing user output with
  QuickJS debug assertion
  `Assertion failed: (list_empty(&rt->gc_obj_list))` in `JS_FreeRuntime(...)`.
  That assertion was reproduced with the flag off as well, so it is recorded as
  current teardown state rather than caused by the periodic stats flag.

## Verification After Vector-Backed Handles

Rebuilt native Edge QuickJS:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Result: passed.

Ran eval smoke:

```sh
./build-edge-quickjs-cli/edge -e "const http=require('http'); console.log('ok', typeof http.createServer)"
```

Result:

```text
ok function
```

Ran lifetime teardown smoke:

```sh
EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge-quickjs-cli/edge -e "console.log('allocator smoke')"
```

Result: passed. The final teardown summary now reports:

```text
napi_value__ live=0 peak=10621 created=10829 destroyed=10829
napi_ref__ live=0 peak=171 created=172 destroyed=172
napi_callback_info__ live=0 peak=3 created=208 destroyed=208
napi_external_backing_store_hint__ live=2916 peak=3202 created=3202 destroyed=286
```

Ran the QuickJS N-API suite:

```sh
make test-napi-quickjs-only
```

Result: 45/45 tests passed.

## 2026-05-15 allocator used/free block refactor

The shared allocator in `napi/lib/src/napi_allocator.h` is now
`napi_allocator__<T, Owner>` and only exposes typed payload pointers. The old
handle-parameter slab allocator surface, cached full/available vectors, and
`std::list` block storage are gone.

Current shape:

- Blocks are owned by circular intrusive `napi_intrinsic_link__` lists.
  `first_free_` owns completely empty blocks; `first_partial_` owns blocks with
  both free and live slots; `first_used_` owns full blocks. Each block is on
  exactly one of those lists through its single `link_`, except during the
  explicit vacuum window in `destroy(T *)`. The link implementation is
  header-only in `napi/lib/src/napi_intrinsic_link.h`; it stores only
  `next_link_` and `prev_link_`, with `unsafe_get<&T::link_>()` doing owner
  recovery from an embedded link pointer.
- Slots contain `storage_`, `free_link_`, and `used_link_`. There is no slot
  `active` flag and no per-block active counter. A block is full when its
  block-local `first_free_slot_` list is empty; a block is empty when its
  block-local `first_used_slot_` list is empty.
- `allocate(...)` is O(1): allocate from the first block in `first_partial_`,
  then `first_free_`, creating a block only when both lists are empty. Relink
  the block to `first_partial_` or `first_used_` after the slot is taken.
- `destroy(T *)` remembers whether the block was linked at entry, unlinks the
  slot from the block used list, unlinks a linked block before running the
  payload destructor, and links the slot to the block free list afterward. If
  the block was already in vacuum at entry, it remains in vacuum; otherwise,
  the call relinks the block to `first_free_`, `first_partial_`, or
  `first_used_`.
- `take_used()` / `take_next_used()` removes one live slot from a full block
  first, or from a partial block if no full blocks exist, marks that slot free,
  records allocator release accounting, and returns the still-constructed
  payload pointer to the caller for external teardown work.
- `begin()` / `end()` iterate over active slots by walking `first_used_` and
  then `first_partial_`, following each block's `first_used_slot_` chain
  through slot `used_link_` links.
  `count_active()` walks the same full and partial lists.
- `owns(T *)` is implemented from `unsafe_owner(T *)`, which derives the block
  from the slot address and checks the block owner.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
make test-napi-quickjs-only
```

Result: edge target built, and the QuickJS N-API suite passed 48/48.

## 2026-05-13 Async-Wrap Destroy Hook Scope Fix

The remaining `Function`/`Object` `napi_value` growth under `server.js` was
tracked to async-wrap destroy-hook draining. A live LLDB run against
`./build-edge-quickjs-cli/edge server.js` showed repeated root-scope Function
handle creation from this stack:

```text
napi_env__::wrap_value_in_current_scope(...)
  -> napi_get_named_property(..., utf8name="destroy", ...)
  -> internal_binding::EmitDestroyHookForAsyncId(...)
  -> internal_binding::DrainQueuedDestroyHooks(...)
  -> EdgeRuntimePlatformDrainImmediateTasks(...)
  -> edge::Environment::OnImmediateCheck(...)
  -> uv_run(..., UV_RUN_DEFAULT)
  -> RunEventLoopUntilQuiescent(...)
```

`EmitDestroyHookForAsyncId(...)` is invoked from the native immediate/check
drain, not from a JS callback trampoline, so it did not inherit the temporary
`quickjs_callback_handle_scope__`. The `"destroy"` property lookup was therefore
wrapping the hook function into the root scope on each drain. The adjacent
`IsDestroyHookAlreadyHandled(...)` helper also rehydrates the destroyed object
reference and reads the `"destroyed"` flag, so it needs the same local-scope
protection.

Implementation:

- Added `edge::HandleScope` to
  `src/internal_binding/binding_async_wrap.cc::EmitDestroyHookForAsyncId(...)`.
- Added `edge::HandleScope` to
  `src/internal_binding/binding_async_wrap.cc::IsDestroyHookAlreadyHandled(...)`
  after the existing `env`/reference null guard.

Verification used a Debug edge build with all lifetime diagnostics enabled:

```sh
CMAKE_BUILD_TYPE=Debug \
EXTRA_CMAKE_ARGS='-DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON' \
make build-edge-quickjs-cli

CMAKE_BUILD_TYPE=Debug \
EXTRA_CMAKE_ARGS='-DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON' \
make test-napi-quickjs

cd /Users/sadhbh/src/dev/edgejs/napi
CMAKE_BUILD_TYPE=Debug make test-native-quickjs
```

Both test suites passed 45/45.

Runtime profile used the patched server on an alternate port so the existing
`8080` run stayed untouched:

```sh
PORT=3316 EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
ab -n 5000 -c 10 http://127.0.0.1:3316/
```

After 5,000 requests, the periodic full dump showed stable active value counts
instead of the previous 1,500-per-period growth:

```text
napi_value created=1331955 released=1331512 x[i-1]=443 speed=0
napi_ref   created=81000   released=80802   x[i-1]=198 speed=0

[napi-lifetime-objects]
Function values:x=109 speed=0 refs:x=64 speed=0
Object   values:x=58  speed=0 refs:x=93 speed=0
```

Conclusion: `binding_async_wrap.cc` had the same missing native callback scope
shape as the earlier stream/parser paths. The destroy-hook property lookup now
lands in the short-lived local scope instead of the root scope, and the observed
Function/Object active counts stay flat under HTTP load.

### 2026-05-13 Internal Binding Async Scope Audit

Follow-up review request: scan `src/internal_binding` for the same class of leak
as `binding_async_wrap.cc`, especially async workloads where a native/libuv
callback starts JS-facing N-API work without an explicit local scope. The current
truth from the scan is that more candidates exist.

Definite missing local scopes:

- `src/internal_binding/binding_fs_event_wrap.cc::OnEvent(...)` is registered
  through `uv_fs_event_start(...)`. It rehydrates the wrapper, reads the
  `"onchange"` property, builds status/event/filename values, and calls JS via
  `EdgeMakeCallback(...)`. It has no `edge::HandleScope`.
- `src/internal_binding/binding_fs.cc::OnStatWatcherChange(...)` is registered
  through `uv_fs_poll_start(...)`. It rehydrates the wrapper, reads `"onchange"`,
  creates the status value and stat array, then calls JS. The other async fs
  completions in this file already have scopes, but this StatWatcher callback
  does not.
- `src/internal_binding/binding_messaging.cc::OnMessagePortAsync(...)` is a
  `uv_async_t` callback and calls `ProcessQueuedMessages(...)`. That path
  deserializes payloads, restores transferred ports, creates event objects and
  arrays, and calls JS through `EmitMessageToPort(...)`. It has no
  `edge::HandleScope`.
- `src/internal_binding/binding_worker.cc::OnWorkerCompletionAsync(...)` is a
  parent-thread `uv_async_t` callback. It rehydrates task callback refs, builds
  result/error objects and strings, and calls `ondone`. It has no
  `edge::HandleScope`.

Potential/brittle path:

- `src/internal_binding/binding_performance.cc::PerformanceEmitEntry(...)`
  rehydrates an observer callback and calls JS. Current observed callers appear
  to be covered by other scopes, but the helper itself does not document or
  enforce that requirement. It should either open a scope itself or have an
  explicit "caller must already be scoped" contract.

Covered paths found during the same scan:

- `src/internal_binding/binding_zlib.cc` async completion runs through
  `src/node_api.cc::UvAfterWork(...)`, which opens `edge::HandleScope` before
  invoking the N-API async-work completion callback.
- Handle close notifications are covered by
  `src/edge_handle_wrap.cc::EdgeHandleWrapMaybeCallOnClose(...)`, which opens a
  scope before rehydrating and invoking JS close hooks.
- Stream listener callbacks are intended to be covered by
  `src/edge_stream_listener.cc`, whose scoped dispatch helpers open
  `edge::HandleScope` around listener calls when an env is present.
- `src/edge_environment.cc` drains interrupt and threadsafe-immediate tasks with
  `edge::HandleScope`, so worker parent-completion foreground tasks such as
  `CallWorkerOnExit(...)` look covered when reached through that scheduler.

Next continuation point: patch the four definite callbacks first, then rebuild
with lifetime stats and stress the matching workloads (`fs.watch`,
`fs.watchFile`, `MessagePort`, and worker operation callbacks). Recheck whether
`PerformanceEmitEntry(...)` should become self-scoped after inspecting all
current and expected callers.

2026-05-14 resolution pass:

- Added `edge::HandleScope` to
  `src/internal_binding/binding_fs_event_wrap.cc::OnEvent(...)`.
- Added `edge::HandleScope` to
  `src/internal_binding/binding_fs.cc::OnStatWatcherChange(...)`.
- Added `edge::HandleScope` to
  `src/internal_binding/binding_messaging.cc::OnMessagePortAsync(...)`.
- Added `edge::HandleScope` to
  `src/internal_binding/binding_worker.cc::OnWorkerCompletionAsync(...)`.

The patch keeps the scope at the native async-entry boundary, immediately after
the existing env guard. If the scope cannot open, the callback returns before
creating or rehydrating any public `napi_value`.

Verification:

```sh
make build-edge-quickjs-cli JOBS=4
```

Result: passed. This is the edge-side compile/link check for the touched
`src/internal_binding` files. The build emitted existing vendored/OpenSSL
deprecation warnings, but no errors from the scope patch.

```sh
cd /Users/sadhbh/src/dev/edgejs/napi
CMAKE_BUILD_TYPE=Debug make test-native-quickjs
```

Result: passed, 45/45 QuickJS N-API tests.

2026-05-14 one-minute `server.js` fs-watch stress:

`server.js` was expanded for local profiling so each HTTP request asynchronously
reads `server.js` and returns a randomly selected, fixed-width source line. It
also creates a temporary watched file under `/private/tmp`, installs both
`fs.watch(...)` and `fs.watchFile(...)`, and periodically writes to that file
during request handling. This exercises:

- async fs read completions,
- `binding_fs_event_wrap.cc::OnEvent(...)` through `fs.watch(...)`,
- `binding_fs.cc::OnStatWatcherChange(...)` through `fs.watchFile(...)`,
- the normal HTTP parser/stream callback scopes under load.

Build:

```sh
CMAKE_BUILD_TYPE=Debug \
EXTRA_CMAKE_ARGS='-DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS=ON -DNAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON' \
make build-edge-quickjs-cli JOBS=4
```

Run:

```sh
PORT=3318 EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
ab -t 60 -c 10 http://127.0.0.1:3318/
```

`ab` result:

```text
Complete requests:      21477
Failed requests:        0
Requests per second:    357.93 [#/sec] (mean)
Time per request:       27.938 [ms] (mean)
Document Length:        155 bytes
```

Last under-load full dump:

```text
napi_value created=11976548 released=11976091 x[i-1]=447 peak=2854 speed=-9
napi_ref   created=781992   released=781739   x[i-1]=260 peak=285  speed=-1
external_backing_store_hint created=225484 released=222087 x[i-1]=3397 peak=3408 speed=0

Function values:x=110 speed=0 refs:x=72 speed=1
Object   values:x=58  speed=0 refs:x=96 speed=0
FSEvent  refs:x=2     speed=0
StatWatcher refs:x=2  speed=0
```

Final dump after stopping the server:

```text
napi_value created=11982061 released=11981618 x[i-1]=443 speed=-14
napi_ref   created=782279   released=782065   x[i-1]=214 speed=-39
external_backing_store_hint created=225565 released=222178 x[i-1]=3387 speed=-10
```

Release ratios from the final dump:

```text
napi_value: 99.9963% released, 443 active
napi_ref:   99.9726% released, 214 active
external_backing_store_hint: 98.4984% released, 3387 active
```

Conclusion: the fs watcher workload did not show unbounded `napi_value` or
`napi_ref` growth. `FSEvent` and `StatWatcher` refs remained stable at their
expected watcher refs while the callback-generated values were released through
the new local scopes.

### 2026-05-13 `napi_wrap(...)` result references must be weak

LLDB investigation of the server lifetime run showed
`napi_ref__::make_weak()` was never called. That ruled out the QuickJS native
weak-ref callback path as an active participant in the observed server growth.

The mismatch was in the QuickJS implementation of `napi_wrap(...)`:

```cpp
return napi_create_reference(env, js_object, 1, result);
```

The V8 backend creates the optional `napi_wrap(..., result)` reference with
initial refcount `0`. That makes the returned wrapper reference weak by default.
Embedder code can then explicitly pin it with `napi_reference_ref(...)` while a
native handle/request is active and release it back to weak with
`napi_reference_unref(...)`.

QuickJS creating this reference with initial refcount `1` made every wrapper ref
strong immediately. For handle wrappers such as `TCP`, `WriteWrap`, and
`ShutdownWrap`, that means:

```text
napi_wrap(..., &wrapper_ref)
  -> strong napi_ref
  -> wrapped JS object stays alive
  -> QuickJS finalizer does not run
  -> external backing-store hint also stays alive
```

The fix is to match V8:

```cpp
return napi_create_reference(env, js_object, 0, result);
```

After this change, wrapper references enter `napi_ref__::make_weak()` at
creation time. Active native resources still pin themselves explicitly through
their normal `napi_reference_ref(...)` / `napi_reference_unref(...)` lifecycle,
but idle wrapper refs no longer start life as unintended strong roots.

## 2026-05-13 Allocator Handle Decoding Checks

Sadhbh caught a real invariant mismatch in the fixed-block allocator lookup:
`napi_value` handles do not have to belong to the current scope. A value can be
owned by the current scope, any parent scope, and later possibly a detached
scope. Therefore, decoding a public handle into a candidate slot/block must be
separate from proving that the current allocator owns that slot.

Current allocator contract:

- The allocator public API is pointer-shaped: `allocate(...)`, `destroy(T *)`,
  `take_used()` / `take_next_used()`, `owns(T *)`, and `unsafe_owner(T *)`.
- Release builds trust that incoming public handles came from this N-API
  backend and treat the opaque public handle as the typed payload pointer at the
  N-API boundary.
- Debug builds derive the owner from the slot/block and assert the expected
  ownership fact: scope handles must belong to the env scope allocator, value
  handles must point at a scope owned by the env, and ref handles must belong to
  the env-owned ref allocator.
- Relationship operations validate the narrower relationship at the point of
  use instead of adding broad null checks everywhere. `napi_scope__::parent()`
  stops at the root parent handle. `napi_scope__::delete_value(...)` releases
  only if the value is owned by that exact scope, so a callback returning a
  parent-scope value does not destroy the parent handle. `escape_value(...)`
  remains an exact-scope operation.
- `napi_ref` slots are persistent env-owned slots in `napi_env__::refs_`. They
  are root-lifetime handles conceptually, but the allocator owner checked by
  `ref_from_handle(...)` is the env, which also preserves the existing
  `napi_lifetime__<napi_ref__>` tracking.

Verification after applying the caller-side ownership fixes:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
make test-napi-quickjs-only
ctest --test-dir build-edge-quickjs-cli --output-on-failure
cmake --build build-edge-quickjs-cli-debug --target \
  napi_quickjs_test_36_handle_scope \
  napi_quickjs_test_15_function \
  napi_quickjs_test_16_reference \
  napi_quickjs_test_37_reference_double_free -j4
```

Results:

- Release Edge build passed.
- Release QuickJS N-API suite passed 45/45.
- Release full Edge CTest passed 46/46.
- Debug focused handle-scope/function/reference/double-free executables built
  and passed individually. The Debug CTest registry still contains many
  `_NOT_BUILT` placeholder entries, so the focused Debug executables are the
  meaningful Debug verification for this build tree.

## 2026-05-13 Allocator Constructor/Destructor Payloads

The allocator payload protocol now matches the `napi_scope__` pattern:
allocation constructs the payload directly in its slot, and release destroys
the object directly.

Current facts:

- `napi_allocator__` stores raw `alignas(T) std::byte storage[sizeof(T)]` in
  each slot rather than a live `T data` member.
- `allocate(args...)` calls placement construction:

```c++
new (address) T(args...);
```

- `release(handle)` and allocator `close()` call the payload's explicit
  destructor before marking the slot reusable:

```c++
value->~T();
```

- Debug builds zero the raw slot storage after the destructor returns. Release
  builds intentionally leave the old bytes alone.
- The allocator no longer requires payloads to implement `initialize(...)` or
  `release()`.
- Allocator-owned payload types are non-copyable and non-movable:
  `napi_scope__`, `napi_value__`, `napi_ref__`, `napi_deferred__`, and
  `napi_env_cleanup_hook__`. `napi_external_backing_store_hint__` follows the
  same constructor/destructor and non-copyable/non-movable pattern once routed
  through `napi_env__::external_backing_stores_`.

Verification after this pass:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
make test-napi-quickjs-only
ctest --test-dir build-edge-quickjs-cli --output-on-failure
cmake --build build-edge-quickjs-cli-debug --target \
  napi_quickjs_test_36_handle_scope \
  napi_quickjs_test_15_function \
  napi_quickjs_test_16_reference \
  napi_quickjs_test_37_reference_double_free -j4
./build-edge-quickjs-cli-debug/napi-quickjs/tests/napi_quickjs_test_36_handle_scope
./build-edge-quickjs-cli-debug/napi-quickjs/tests/napi_quickjs_test_15_function
./build-edge-quickjs-cli-debug/napi-quickjs/tests/napi_quickjs_test_16_reference
./build-edge-quickjs-cli-debug/napi-quickjs/tests/napi_quickjs_test_37_reference_double_free
```

Results:

- Release Edge build passed.
- Release QuickJS N-API suite passed 45/45.
- Release full Edge CTest passed 46/46.
- Debug focused handle-scope, function, reference, and reference double-free
  executables passed.

## 2026-05-13 External Backing Store Allocator

`napi_external_backing_store_hint__` is allocator-backed again. The important
ownership distinction is:

```text
napi_env__::external_backing_stores_
  owns fast/stable native storage for napi_external_backing_store_hint__

QuickJS object opaque / ArrayBuffer free opaque
  stores the raw pointer and decides when that record should die
```

`napi_external_backing_store_hint__::create(...)` delegates to
`napi_env__::create_external_backing_store(...)`, which allocates from:

```c++
napi_allocator__<napi_external_backing_store_hint,
                 napi_external_backing_store_hint__,
                 napi_env__> external_backing_stores_;
```

`napi_external_backing_store_hint__::destroy_with_runtime(...)` reads the stored
env from the hint and returns the slot through
`napi_env__::destroy_external_backing_store(...)`. That keeps allocator-backed
lifetime tracking for external hints without reintroducing env identity maps.

The allocator is not closed in `prepare_teardown()`, because QuickJS can still
hold raw hint pointers in object and ArrayBuffer finalizers until the
context/runtime finalizer phase. The allocator closes as an env member after
that phase.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
make build-napi-quickjs
make test-napi-quickjs-only
ctest --test-dir build-edge-quickjs-cli --output-on-failure
git diff --check
git -C napi diff --check
```

Results:

- Release Edge build passed.
- N-API-enabled rebuild passed.
- QuickJS N-API suite passed 45/45.
- Edge CTest passed 46/46.
- Diff whitespace checks passed.

## 2026-05-12 Compact Detailed Lifetime Tables

The compact lifetime dump keeps the rolling three-sample columns:

- `x[i-1]`: the centered current value;
- `speed`: `x[i] - x[i-2]`;
- `accel`: `x[i] - 2*x[i-1] + x[i-2]`.

Detailed attribution was added back in the same format:

```text
[napi-lifetime-scopes]
  level                x[i-1]      speed      accel

[napi-lifetime-strings]
  string               x[i-1]      speed      accel

[napi-lifetime-objects]
  type                 values:x    speed      accel      refs:x      speed      accel
```

Scope rows are aggregated by scope level, so multiple active scopes at level 2
produce one level-2 row with the total active `napi_value` count. String and
object detail rows only print entries whose count is greater than one; singleton
strings/object types are collapsed into a single `count == 1` summary row. The
object table merges `napi_value` object prototypes and `napi_ref` object
prototypes side by side.

While validating `NAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=1`,
`napi_quickjs_test_16_reference` exposed a crash in the old detailed capture
path: the tracker attempted to stringify QuickJS symbols by treating the symbol
payload as a `JSAtom`. The detailed dump no longer stringifies symbols; symbols
remain visible through the tag table only.

Verification:

```sh
NAPI_QUICKJS_BUILD_TESTS=1 \
NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=1 \
NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=1 \
NAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS=1 \
NAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=1 \
cmake -S . -B build-edge-quickjs-cli -DEDGE_BUILD_NAPI_TESTS=ON
cmake --build build-edge-quickjs-cli --target edge \
  napi_quickjs_test_16_reference \
  napi_quickjs_test_36_handle_scope \
  napi_quickjs_test_37_reference_double_free \
  napi_quickjs_test_38_finalizer -j4
ctest --test-dir build-edge-quickjs-cli --output-on-failure \
  -R 'napi_quickjs_test_16_reference|napi_quickjs_test_36_handle_scope|napi_quickjs_test_37_reference_double_free|napi_quickjs_test_38_finalizer'
EDGE_TRACE_NAPI_LIFETIME_STATS=1 \
  ./build-edge-quickjs-cli/edge -e 'console.log("tracker details smoke")'
```

The focused CTest run passed 4/4. The detailed smoke printed the scopes,
strings, and objects tables.

## 2026-05-12 HTTP Load Detailed Snapshot

Sadhbh captured the following detailed lifetime dump while running the local
HTTP server under load:

```text
NAPI LIFETIME TRACKER
=====================
[napi-lifetime-slots]
  metric                                   x[i-1]      speed      accel
  napi_value.slots_total                   195328      13312          0
  napi_value.active                        195225      13418         -6
  napi_value.tracked_active                195225      13418         -6
  napi_ref.slots_total                       6144        512          0
  napi_ref.active                            6003        400          0
  napi_ref.tracked_active                    6003        400          0
  napi_scope.slots_total                      256          0          0
  napi_scope.active                             1          0          0
  napi_scope.escape_value.calls                 0          0          0
  napi_scope.escape_value.succeeded             0          0          0
  napi_scope.escape_value.failed                0          0          0
[napi-lifetime-scopes]
  level                x[i-1]      speed      accel
  0                    195225      13418         -6
[napi-lifetime-types]
  type                                 created   released     x[i-1]       peak      speed      accel
  napi_value                            404368     202437     195225     201931      13418         -6
  napi_ref                               24204      18001       6003       6211        400          0
  napi_env_cleanup_hook                      0          0          0          0          0          0
  napi_deferred                              0          0          0          0          0          0
  napi_external_backing_store_hint        7937         73       7714       7864        300          0
[napi-lifetime-tags] owner=napi_value
  tag                  x[i-1]      speed      accel
  symbol                 1494        100          0
  string                10278        700          0
  object               129587       8909         -3
  int                   13115        903         -1
  bool                   4385        300          0
  null                   1485        103         -1
  undefined             30485       2100          0
  float64                4396        303         -1
[napi-lifetime-tags] owner=napi_ref
  tag                  x[i-1]      speed      accel
  symbol                    5          0          0
  object                 5995        400          0
  undefined                 3          0          0
[napi-lifetime-strings]
  string                                   x[i-1]      speed      accel
  */*                                        1250        500          0
  /                                          1250        500          0
  127.0.0.1:8080                             1250        500          0
  Accept                                     1250        500          0
  ApacheBench/2.3                            1250        500          0
  Host                                       1250        500          0
  User-Agent                                 1250        500          0
  primordials                                  11          0          0
  internalBinding                               7          0          0
  process                                       7          0          0
  require                                       6          0          0
  ./build-edge-quickjs-cli/edge                 3          0          0
  deps/undici/undici.js                         3          0          0
  exports                                       3          0          0
  perIsolateSymbols                             3          0          0
  privateSymbols                                3          0          0
  10                                            2          0          0
  count == 1                                   80          0          0
[napi-lifetime-objects]
  type                            values:x      speed      accel      refs:x      speed      accel
  ArrayBuffer                        26252      10500          0           -          -          -
  Function                           20169       8013          1        1314        500          0
  Float64Array                       18750       7500          0           3          0          0
  TCP                                 8751       3500          0        1252        500          0
  Array                               8765       3500          0           3          0          0
  Object                              7585       3013          1          95          0          0
  Uint32Array                         7502       3000          0           5          0          0
  HTTPParser                          6250       2500          0           2          0          0
  process                             3791       1513          1           -          -          -
  ShutdownWrap                        2500       1000          0        1250        500          0
  WriteWrap                              -          -          -        1251        500          0
  Socket                              1250        500          0           -          -          -
  <null-prototype>                     171          0          0           4          0          0
  Signal                                33          0          0           2          0          0
  Int32Array                             -          -          -           4          0          0
  TTY                                    -          -          -           4          0          0
  Uint8Array                             -          -          -           3          0          0
  count == 1                             0          0          0           3          0          0
```

Interpretation:

- The decisive line is `[napi-lifetime-scopes] level 0 = 195225`, with
  `napi_scope.active = 1`. Every active `napi_value` in this snapshot is in the
  root scope. No request/callback-local scope is active when these values are
  created.
- Growth is linear and stable: slot/value speeds stay around `13418` per
  two-sample window and acceleration is near zero. That points to per-request
  retention, not compounding retention.
- The repeated strings are exactly request-local HTTP parse data:
  `Host`, `127.0.0.1:8080`, `User-Agent`, `ApacheBench/2.3`, `Accept`, `*/*`,
  and `/`. These should be temporary N-API local values, but they remain in
  level 0 because the native HTTP/parser path enters N-API without first
  preparing a scoped lifetime boundary.
- The object table has the same shape: `ArrayBuffer`, `Function`,
  `Float64Array`, `TCP`, `Array`, `Uint32Array`, `HTTPParser`, `Socket`, and
  `ShutdownWrap` grow at request-correlated rates. Their value handles are local
  wrappers allocated into the current scope, and the current scope is the root
  scope in these native-entry paths.
- `napi_ref` growth is smaller and separately meaningful. Refs are persistent by
  design, but `Function`, `TCP`, `WriteWrap`, and `ShutdownWrap` refs growing by
  roughly `500` over the same window indicates per-request or per-connection
  persistent ownership that must be released by completion/finalizer paths.
- `napi_external_backing_store_hint` growth (`x[i-1] = 7714`, speed `300`) is
  another separate lifetime issue. It is likely tied to ArrayBuffer/external
  backing-store finalization rather than local handle scopes alone.

Working conclusion:

The root problem for `napi_value` growth is not the allocator. The allocator is
now correctly showing where live handles are owned. The issue is that EdgeJS
native event paths call N-API while `env->current_scope()` is still the env root
scope. In Node/V8, a handle scope is normally prepared around such native/API
entry boundaries. In the QuickJS backend, if no scope is prepared before native
HTTP/parser/stream callbacks create local values, those local values are owned
by root scope and survive until environment teardown.

The next fix should add a small RAII scope around native event-entry paths that
call N-API and do not return a `napi_value` to their caller. The likely first
targets remain the HTTP parser callback path, stream read/event callbacks, and
TCP/Pipe connection callbacks. Refs and external backing-store hints should be
tracked separately after local value scope containment is fixed.

## 2026-05-12 Allocator Hook Lifetime Refactor

The lifetime tracker was moved away from scattered
`NAPI_QUICKJS_LIFETIME_MAYBE_DUMP(...)` call sites. `napi_allocator__` now calls
`napi_lifetime__<T>::record_create(...)` after slot initialization and
`record_release(...)` before slot release, including allocator `close()`.

The allocator is now owner-aware:

```c++
template <napi_allocator_payload__ T, napi_allocator_owner__ Owner_, size_t N = 256>
class napi_allocator__
```

The allocator stores `Owner_ *owner_` and passes it to lifetime hooks. Env-owned
allocators use `napi_env__` as owner, while `napi_scope__::values_` uses
`napi_scope__` as owner so value counting can attribute through the scope.

The generic `napi_lifetime__<T>` is a no-op so untracked allocator payloads can
still use `napi_allocator__`. Real specializations are compile-time gated in
`napi_lifetime_tracker.h` for:

- `napi_value__`
- `napi_ref__`
- `napi_env_cleanup_hook__`
- `napi_deferred__`
- `napi_external_backing_store_hint__`

The implementation in `napi_lifetime_tracker.cc` keeps one process-static
counter/snapshot state. Value and ref records capture tag, string/symbol text,
and object prototype names at create time, then remove those snapshots at
release time. Periodic stats are triggered from allocator lifetime hooks.

`napi_scope__::escape_value(...)` now has a separate semantic tracker hook that
counts every escape attempt and splits successful versus failed escapes. This is
reported in the compact stats table.

Lifetime dumps now use compact readable tables. Each metric keeps a three-sample
rolling window. Once three samples exist, the displayed point is centered on
`x[i-1]`; `speed` is `x[i] - x[i-2]`, and `accel` is
`x[i] - 2*x[i-1] + x[i-2]`. String/symbol and object details collapse entries
with count `< 2` into one row, and print one row per repeated value/type.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
cmake --build build-edge-quickjs-cli --target \
  napi_quickjs_test_16_reference \
  napi_quickjs_test_36_handle_scope \
  napi_quickjs_test_37_reference_double_free \
  napi_quickjs_test_38_finalizer -j4
ctest --test-dir build-edge-quickjs-cli/napi-quickjs/tests \
  --output-on-failure \
  -R 'napi_quickjs_test_16_reference|napi_quickjs_test_36_handle_scope|napi_quickjs_test_37_reference_double_free|napi_quickjs_test_38_finalizer'
EDGE_TRACE_NAPI_LIFETIME_STATS=1 \
  ./build-edge-quickjs-cli/edge -e "console.log('tracker smoke')"
```

Build and focused tests passed. The tracker smoke emitted create/release totals
and showed `tracked_active` matching active value/ref slots at teardown begin
and returning to zero after env value/ref/scope close.

## 2026-05-11 Root `test_6` Debug Check

Sadhbh reported that `make test-native-quickjs` from `napi/` passed, while a
clean root rebuild with `make test-napi-quickjs` failed
`napi_quickjs_test_6.Test6.PortedCoreFlow`.

Current action plan:

1. Reproduce from the root build directory, not the standalone `napi/` build.
2. Run `napi_quickjs_test_6` directly, through CTest, and under LLDB.
3. Check both Release and Debug root build shapes, because the root `Makefile`
   defaults to Release unless `CMAKE_BUILD_TYPE=Debug` is supplied.
4. If the failure reproduces, inspect the post-test teardown path and callback
   scope/result ownership before changing code.

Findings:

- The current root-built `napi_quickjs_test_6 --gtest_filter=Test6.PortedCoreFlow`
  passes directly.
- `ctest --test-dir build-edge-quickjs-cli/napi-quickjs/tests -R
  napi_quickjs_test_6 --output-on-failure -V` passes the discovered
  `Test6.PortedCoreFlow` case.
- A clean root Release run via `make test-napi-quickjs` passes 45/45 tests.
- A forced root Debug rebuild via `CMAKE_BUILD_TYPE=Debug make
  build-napi-quickjs`, followed by `CMAKE_BUILD_TYPE=Debug make
  test-napi-quickjs-only`, also passes 45/45 tests.
- LLDB initially stopped a stale Release binary in `malloc` while GoogleTest was
  printing the test result, but after the Debug rebuild LLDB ran the same
  `Test6.PortedCoreFlow` filter to process exit status 0. No stable
  `test_6` failure is currently reproducible.

Interpretation:

The `test_6` symptom appears to have been stale-build or configuration-state
dependent rather than a remaining object-wrap semantic failure in the current
source. The callback trampoline now opens a child handle scope, duplicates the
callback result into a QuickJS return value before closing that scope, and
deletes the local `napi_value` handle from the current scope. That is the
important ownership boundary for object-wrap constructor and method callbacks.

Follow-up implementation:

- Tightened `napi_scope__::delete_value(...)` so deleting a callback return
  handle only releases a value owned by that exact scope. Lookup still walks
  parents, but deletion should not; otherwise a callback that returns a
  parent-scope handle could accidentally invalidate the outer handle while the
  trampoline is only trying to drop its local return handle.
- Added `test_function` coverage where a callback returns a module-init
  parent-scope value twice. The second return verifies the trampoline did not
  destroy the outer handle during the first callback return cleanup.
- Fixed reentrant slot release during teardown: `napi_ref__::release()` and
  `napi_value__::release()` now mark the slot inactive before calling
  `JS_FreeValue(...)`. This matters for object-wrap refs because freeing the
  strong JS value can synchronously run the wrapped object's finalizer, and that
  finalizer may call `napi_delete_reference(...)` on the same ref.
- Moved instance-data finalization out of `prepare_teardown()` for owned env
  release. `test_6` object finalizers call `napi_get_instance_data(...)`, and
  QuickJS can run those finalizers during `JS_FreeContext(...)` and the final
  `JS_FreeRuntime(...)` GC; the instance data must remain alive until after
  runtime finalizers have run.

## 2026-05-11 Reentrancy Audit

Action plan before code changes:

1. Scan QuickJS N-API paths that call user callbacks or QuickJS operations that
   can synchronously run finalizers: `JS_FreeValue(...)`, `JS_RunGC(...)`,
   `JS_FreeContext(...)`, `JS_FreeRuntime(...)`,
   `JS_DetachArrayBuffer(...)`, N-API finalizers, and env cleanup hooks.
2. Look for state that is cleared only after one of those calls, because a
   finalizer can re-enter N-API on the same thread before the outer operation
   finishes.
3. Fix only high-confidence cases with direct user callback/finalizer exposure.
4. Add focused regression coverage where the current N-API suite can observe
   the issue without depending on timing or multiple threads.

Initial findings:

- `napi_env__::prepare_teardown()` runs cleanup hooks while iterating the
  `env_cleanup_hooks_` vector. A cleanup hook can call
  `napi_remove_env_cleanup_hook(...)`, which can erase and destroy the current
  or a later entry while teardown still owns an iterator/entry pointer.
- `napi_env__::set_instance_data(...)` and `finalize_instance_data()` invoke the
  old instance-data finalizer while the old data/finalizer fields are still set.
  If that finalizer re-enters instance-data APIs, it can observe stale data or
  trigger duplicate finalization.
- `napi_ref__::rem_ref()` transitions a strong ref to weak by calling
  `JS_FreeValue(...)`. That can synchronously run a finalizer that deletes the
  same ref, so the outer unref path must not read or mutate the slot after the
  free call.

Implementation:

- Env cleanup teardown now pops a hook entry out of the vector before running
  the user hook. Reentrant removal of that same hook no longer finds it, and
  removal of a later hook cannot invalidate the teardown iterator.
- Instance-data replacement/finalization now snapshots and clears the old fields
  before invoking the user finalizer.
- `napi_ref__::rem_ref()` now snapshots the env/value/ref-count state and
  returns the local count after `JS_FreeValue(...)`, avoiding post-finalizer slot
  access.
- Added `test_instance_data` coverage where one cleanup hook removes another
  cleanup hook during env teardown. The removed hook aborts if it runs.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target \
  napi_quickjs_test_41_instance_data \
  napi_quickjs_test_6 \
  napi_quickjs_test_16_reference \
  napi_quickjs_test_37_reference_double_free -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_41_instance_data --gtest_filter=Test41InstanceData.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_6 --gtest_filter=Test6.PortedCoreFlow --gtest_also_run_disabled_tests
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_16_reference --gtest_filter=Test16Reference.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_37_reference_double_free --gtest_filter=Test37ReferenceDoubleFree.PortedCoreFlow
make test-napi-quickjs-only
```

Results:

- The focused build passed.
- All four focused test binaries passed.
- `make test-napi-quickjs-only` passed 45/45.

## 2026-05-11 String And Symbol Value Dump Plan

Action plan before code changes:

1. Keep the existing slot and tag counters as aggregate diagnostics.
2. Add a separate compile-time flag for the heavier value-content dump, default
   off.
3. Use a separate 10-second content-dump cadence and the runtime
   `EDGE_TRACE_NAPI_LIFETIME_STATS=1` gate, while aggregate stats stay on their
   two-second cadence.
4. Capture only active `JS_TAG_STRING`, `JS_TAG_STRING_ROPE`, and
   `JS_TAG_SYMBOL` values from `napi_value__` and `napi_ref__`.
5. Split output by scope level and by owner kind, then collapse duplicates into
   `count=N value="..."` lines so repeated per-request values are visible.
6. Convert strings with `JS_ToCStringLen(...)`; convert symbols with
   `JS_ValueToAtom(...)` and `JS_AtomToCStringLen(...)`, because direct string
   conversion throws for symbols.
7. Escape control bytes and cap stored display text to keep periodic output
   usable.
8. Rebuild the existing `build-edge-quickjs-cli` cache with the new diagnostic
   flag on, and leave that cache in the diagnostic configuration.

Implementation notes:

- Added `NAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP`, default off.
- The new flag enables tag stats if needed; tag stats already enable periodic
  stats, and periodic stats enable the lifetime tracker.
- Active string/symbol values are counted in the lifetime tracker by
  `(scope_level, napi_value/napi_ref, tag, escaped value)`.
- Output lines use:

```text
[napi-lifetime-values] scope_level=0 napi_value tag=string count=1000 value="Host"
[napi-lifetime-values] scope_level=0 napi_value tag=symbol count=1002 value="handle_onclose"
```

Verification:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON
cmake --build build-edge-quickjs-cli --target edge -j4
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
for i in {1..20}; do ab -n 50 -c 10 http://127.0.0.1:8080/ >/dev/null; sleep 1; done
```

The build succeeded. During the local server run the 10-second dumps showed
string/symbol content counts increasing with request churn:

```text
[napi-lifetime-stats] napi_value slots_total=67788 active=67788 napi_ref slots_total=2214 active=2206 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope_level=0 napi_value symbol=545 string=3628 object=45003 int=4522 bool=1502 null=513 undefined=10557 float64=1519
[napi-lifetime-values] scope_level=0 napi_value tag=symbol count=502 value="handle_onclose"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="Host"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="127.0.0.1:8080"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="User-Agent"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="ApacheBench/2.3"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="Accept"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="*/*"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="/"

[napi-lifetime-stats] napi_value slots_total=134840 active=134840 napi_ref slots_total=4214 active=4206 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope_level=0 napi_value symbol=1045 string=7128 object=89529 int=9032 bool=3002 null=1023 undefined=21055 float64=3027
[napi-lifetime-values] scope_level=0 napi_value tag=symbol count=1002 value="handle_onclose"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=1000 value="Host"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=1000 value="127.0.0.1:8080"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=1000 value="User-Agent"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=1000 value="ApacheBench/2.3"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=1000 value="Accept"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=1000 value="*/*"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=1000 value="/"
```

The cache was intentionally left with the diagnostic flags on.

## 2026-05-11 Tracker-Owned Value Extraction Correction

Action plan before code changes:

1. Remove string/symbol extraction helpers from `napi_value__` and `napi_ref__`.
2. Remove direct tag/string diagnostic macros from value/ref call sites.
3. Keep call-site instrumentation to lifetime record macros only:
   `NAPI_QUICKJS_LIFETIME_RECORD(create|destroy|update, ..., this, env_)`.
4. Add typed overloads on `napi_lifetime_tracker__` for `napi_value__` and
   `napi_ref__`, so C++ overload resolution routes value/ref slots through the
   diagnostic-aware tracker path.
5. Let the tracker read the slot's env and `JSValue`, with scope labels supplied
   by the active-scope scan, extract tag and string/symbol content internally,
   and maintain active per-slot snapshots so ref value changes can decrement
   the old value and increment the new value.
6. Restore periodic aggregate stats to the intended 2-second cadence.
7. Keep string/symbol value dumps on a separate 10-second cadence.
8. Rebuild the existing diagnostic cache and rerun a short local server/request
   sample.

Implementation notes:

- Removed create/destroy/update lifetime recording for value/ref slots. Because
  `napi_value__` and `napi_ref__` entries are owned by `napi_allocator__`
  vectors inside `napi_scope__`, the env scan is the source of truth.
- Removed the global active-value snapshot registry, per-scope tag/string
  counters, mutexes, atomics, and slot-delta accounting from
  `napi_lifetime_tracker.cc`.
- Added read-only allocator/scope/env iteration helpers so the tracker scans
  `napi_env__ -> scopes_ -> values_/refs_` whenever it dumps.
- The only periodic trigger is `NAPI_QUICKJS_LIFETIME_MAYBE_DUMP(env)` at
  scope/env ownership boundaries such as `wrap_value(...)`, `delete_value(...)`,
  `wrap_ref(...)`, `delete_ref(...)`, `close()`, and env scope
  create/destroy.
- Aggregate slot stats and tag breakdowns are computed fresh from active scopes
  at most every two seconds. String content lines are computed fresh from active
  slots at most every ten seconds.
- Symbol names/atoms are intentionally not materialized in the value-content
  dump; symbols remain visible only as tag counts.
- The build cache was intentionally left in diagnostic mode with
  `NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON`,
  `NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON`, and
  `NAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON`.

## 2026-05-11 Native Callback Handle-Scope Investigation

Action plan before code changes:

1. Preserve the then-current vector-backed allocator, root-scope teardown, periodic
   stats, and string/value dump diagnostics as the baseline.
2. Confirm which callback direction is already scoped. In the current worktree,
   `napi_function__::trampoline` opens a temporary handle scope before invoking
   the underlying `napi_callback`, so JS-to-native callbacks are already
   covered.
3. Reproduce or sample the request path around `napi_scope__::wrap_value`,
   `napi_create_string_utf8`, `napi_get_named_property`,
   `napi_get_reference_value`, and HTTP/TCP native event callbacks.
4. Determine whether the repeated header/path strings are created before
   `napi_call_function(...)`. If so, a scope opened inside `napi_call_function`
   is too late to own those argument handles.
5. Identify the native-to-JS event boundary that should own temporary argument
   handles: TCP connection, stream read, HTTP parser callbacks, timers, and
   other `EdgeMakeCallback` / `EdgeAsyncWrapMakeCallback` entry paths.
6. Prefer one shared callback-scope guard at the Edge callback-dispatch layer if
   it can cover argument construction safely. If that is not possible, document
   the app/runtime-specific event guards required before changing broad N-API
   call semantics.
7. Treat return values separately from temporary arguments. Any result that must
   survive past the callback boundary must be consumed before the scope closes
   or explicitly escaped/duplicated into the parent scope.
8. Classify `napi_ref` growth separately. Persistent references live in the env
   root scope and should be deleted by their owners or finalizers; they are not
   automatically freed by local handle-scope closure.

Initial findings:

- The current `napi_function__::trampoline` already creates
  `quickjs_callback_handle_scope__` before invoking the native `napi_callback`.
  It also duplicates a non-null callback return value into a raw QuickJS result
  and deletes the temporary local handle before returning to QuickJS.
- `src/edge_http_parser.cc` creates the repeated request strings before
  entering JS: `BuildHeadersArray(...)` creates header field/value strings such
  as `Host`, `127.0.0.1:8080`, `User-Agent`, `ApacheBench/2.3`, `Accept`, and
  `*/*`; `ParserOnHeadersComplete(...)` creates the URL string such as `/`.
- Those strings are then passed as arguments to `EdgeMakeCallback(...)` /
  `EdgeMakeCallbackWithFlags(...)` or, in propagate-exception mode,
  `napi_call_function(...)`. Because the values are already wrapped by then, an
  automatic scope opened only inside `napi_call_function(...)` would not own
  them.
- The intended lifetime model for those request strings is a native callback
  local scope that opens before the parser/TCP/timer/stream event constructs
  N-API arguments and closes after the JS callback path has returned and any
  required task-queue checkpoint has run. Closing that scope should release the
  local `napi_value` handles for the header/path strings; JavaScript objects
  that stored the actual strings keep their own QuickJS references independently
  of the N-API wrapper handles.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
for i in {1..12}; do ab -n 50 -c 10 http://127.0.0.1:8080/ >/dev/null; sleep 1; done
```

Result: build passed. The server run showed two-second scanner-derived
stats/tag output and a separate ten-second string-only value dump.
Representative lines:

```text
[napi-lifetime-stats] napi_value slots_total=67661 active=67661 napi_ref slots_total=2207 active=2199 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope_level=0 napi_value symbol=544 string=3628 object=44905 int=4512 bool=1502 null=513 undefined=10535 float64=1522
[napi-lifetime-tags] scope_level=0 napi_ref symbol=5 object=2191 undefined=3

[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="Host"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="127.0.0.1:8080"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="User-Agent"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="ApacheBench/2.3"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="Accept"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="*/*"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="/"
[napi-lifetime-values] scope_level=0 napi_value singular_string_count=80
[napi-lifetime-values] scope_level=0 napi_ref singular_string_count=0
```

The direct helper names, old direct diagnostic macros, global snapshot state,
and mutex/atomic includes are absent from the tracker:

```sh
rg -n "NAPI_QUICKJS_LIFETIME_RECORD|record_create|record_destroy|record_update|record_allocator_slot_delta|NAPI_QUICKJS_LIFETIME_SLOT_DELTA|std::mutex|#include <mutex>|std::atomic|#include <atomic>|active_value_snapshots|tag_stats_by_scope|string_symbol_values_by_scope" napi/quickjs/src/internal/napi_lifetime_tracker.cc napi/quickjs/src/internal/napi_lifetime_tracker.h napi/quickjs/src/internal/napi_lifetime_macros.h
```

## 2026-05-11 Handle Representation And Trampoline RAII Update

Action plan before code changes:

1. Remove the temporary internal `napi_handle_scope__` and
   `napi_escapable_handle_scope__` wrapper classes.
2. Stop using the private `napi_scope_handle__ = void *` alias.
3. Use the public opaque N-API handle types,
   `napi_handle_scope` and `napi_escapable_handle_scope`, as encoded
   index-plus-one handles into `napi_env__::scopes_`.
4. Keep `napi_scope__` as the single internal scope payload; all QuickJS N-API
   scopes can support escaping.
5. Expose `napi_scope__ *scope_from_handle(napi_handle_scope scope) const` as
   the internal decode point instead of exposing current/root raw
   `napi_scope__ *` values.
6. Make `quickjs_callback_handle_scope__` in `napi_function.cc` the RAII owner
   for JS-to-native callback execution: create a child scope in the
   constructor, make it current, restore the parent in the destructor, and
   destroy the child scope.

Implementation notes:

- Deleted `napi_handle_scope.h/.cc` and `napi_escapable_handle_scope.h/.cc`
  from `napi/quickjs/src/internal` and removed those source files from
  `napi/quickjs/CMakeLists.txt`.
- `napi_env__` now returns `napi_handle_scope` from `root_scope()`,
  `current_scope()`, and `create_scope(...)`; scope payload access goes through
  `scope_from_handle(...)`.
- `napi_open_handle_scope(...)`, `napi_close_handle_scope(...)`,
  `napi_open_escapable_handle_scope(...)`, `napi_close_escapable_handle_scope(...)`,
  and `napi_escape_handle(...)` now operate on encoded scope handles. Escapable
  handles are represented by casting the same encoded `napi_handle_scope`
  value; the internal `napi_scope__` tracks whether it has already escaped.
- `quickjs_callback_handle_scope__` no longer depends on the deleted wrapper
  class. It creates a child scope from the current parent scope and closes it
  with `env_->destroy_scope(scope_)` on unwind.

LLDB evidence:

```text
breakpoint set --name 'napi_function__::trampoline(JSContext*, JSValue, int, JSValue*, int, JSValue*)'
run --gtest_filter=Test3.Ported
bt
```

showed JS calling a native N-API function through the QuickJS C function data
path:

```text
frame #0: napi_function__::trampoline(JSContext*, JSValue, int, JSValue*, int, JSValue*)
frame #1: js_call_c_function_data
frame #2: JS_CallInternal
frame #8: napi_run_script
frame #12: Test3_Ported_Test::TestBody()
```

Ignoring the env-constructor root-scope allocation and breaking on scope create:

```text
breakpoint set --name 'napi_env__::create_scope(napi_handle_scope__*)'
breakpoint modify 1 --ignore-count 1
run --gtest_filter=Test3.Ported
bt
```

showed the callback frame opening inside the trampoline:

```text
frame #0: napi_env__::create_scope(napi_handle_scope__*)
frame #1: napi_function__::trampoline(JSContext*, JSValue, int, JSValue*, int, JSValue*) + 140
frame #2: js_call_c_function_data
```

Breaking on scope destroy showed the matching close on the trampoline unwind
path:

```text
frame #0: napi_env__::destroy_scope(napi_handle_scope__*)
frame #1: napi_function__::trampoline(JSContext*, JSValue, int, JSValue*, int, JSValue*) + 768
frame #2: js_call_c_function_data
```

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
make build-napi-quickjs
make test-napi-quickjs-only
```

Results:

- Edge CLI build passed.
- Test-enabled N-API QuickJS build passed.
- `make test-napi-quickjs-only` passed, 45/45.

Request-load validation:

```sh
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
watch -n 1 ab -n 50 -c 10 http://127.0.0.1:8080/
```

The sandboxed listen failed with `EPERM`; rerunning the server and `watch` load
with localhost/network approval succeeded. After several `ab -n 50 -c 10`
batches, root-scope request strings still grew:

```text
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="Host"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="127.0.0.1:8080"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="User-Agent"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="ApacheBench/2.3"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="Accept"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="*/*"
[napi-lifetime-values] scope_level=0 napi_value tag=string count=500 value="/"
```

Conclusion: the trampoline RAII frame is now implemented and verified for
JS-to-native N-API function calls, but it is not the lifetime boundary that owns
HTTP request header/path argument handles. Those strings are created in native
HTTP parser/server code before `napi_call_function(...)` enters JavaScript, so
they need a native event callback/request scope opened before argument
construction and closed after callback dispatch. `napi_ref` growth remains
separate; these root refs are persistent handles and must be classified by
owner/finalizer or explicit `napi_delete_reference(...)`, not by local
handle-scope closure.

## 2026-05-11 String And Symbol Value Dump Plan

Action plan:

1. Keep the periodic slot and tag counters separate from content dumping.
2. Add a new compile-time flag for string/symbol value content dumps so the
   potentially noisy string capture code is compiled out by default.
3. Reuse active value/ref slot lifecycle hooks, and only record content for
   `JS_TAG_STRING`, `JS_TAG_STRING_ROPE`, and `JS_TAG_SYMBOL`.
4. Split dump output by scope level and owner kind (`napi_value` versus
   `napi_ref`) so root-scope retention remains easy to identify.
5. Use QuickJS C-string conversion only while the underlying `JSValue` is known
   to be alive; store a bounded escaped copy in the tracker.
6. Print the captured string/symbol values on a separate 10-second cadence;
   aggregate stats remain on the two-second cadence.
7. Rebuild with the stats, tag-stats, and content-dump flags enabled and leave
   the build cache in that diagnostic state.

## 2026-05-11 QuickJS Tag Breakdown Plan

Action plan:

1. Keep the existing periodic slot stats gated behind
   `NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS`.
2. Add a separate compile-time flag for QuickJS value/ref tag breakdowns so the
   additional counters are compiled out unless explicitly requested.
3. Count active `napi_value__` slots and active `napi_ref__` slots by
   `JS_VALUE_GET_TAG(...)`, using the QuickJS tag names from `quickjs.h`.
4. Update counts when a value/ref slot initializes, releases, or changes the
   retained `JSValue` to `JS_UNDEFINED` during weak/empty ref cleanup.
5. Print the tag breakdown alongside periodic stats. The current corrected
   implementation uses the two-second aggregate stats cadence.
6. Rebuild with stats and tag stats enabled, run a small smoke command, and run
   focused value/reference/handle-scope tests.

Implementation notes:

- Added `NAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS`, default `OFF`. Enabling it
  adds per-active-slot `JS_VALUE_GET_NORM_TAG(...)` accounting for
  `napi_value__` and `napi_ref__`.
- This first implementation printed periodic stats every 10 seconds; the later
  tracker-owned extraction correction restored aggregate stats and tag
  breakdowns to the intended two-second cadence.
- Tag stats are split by the lifetime tracker's scope levels, so
  output can distinguish root-scope retention from child-scope retention without
  storing an index inside `napi_scope__`:

```text
[napi-lifetime-tags] scope_level=0 napi_value symbol=794 string=5378 object=67179 int=6781 bool=2252 null=771 undefined=15785 float64=2269
[napi-lifetime-tags] scope_level=0 napi_ref symbol=5 object=3191 undefined=3
```

Sample run:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DEDGE_NAPI_PROVIDER=quickjs \
  -DEDGE_BUILD_NAPI_TESTS=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
ab -n 50 -c 10 http://127.0.0.1:8080/
```

Observed after driving repeated small `ab` batches for about 30 seconds:

```text
[napi-lifetime-stats] napi_value slots_total=34136 active=34136 napi_ref slots_total=1207 active=1199 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope_level=0 napi_value symbol=294 string=1878 object=22643 int=2269 bool=752 null=259 undefined=5285 float64=757
[napi-lifetime-tags] scope_level=0 napi_ref symbol=5 object=1191 undefined=3

[napi-lifetime-stats] napi_value slots_total=67678 active=67678 napi_ref slots_total=2207 active=2199 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope_level=0 napi_value symbol=544 string=3628 object=44914 int=4526 bool=1502 null=516 undefined=10535 float64=1514
[napi-lifetime-tags] scope_level=0 napi_ref symbol=5 object=2191 undefined=3

[napi-lifetime-stats] napi_value slots_total=101208 active=101208 napi_ref slots_total=3207 active=3199 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope_level=0 napi_value symbol=794 string=5378 object=67179 int=6781 bool=2252 null=771 undefined=15785 float64=2269
[napi-lifetime-tags] scope_level=0 napi_ref symbol=5 object=3191 undefined=3
```

Conclusion from this sample: retained values/refs are all in `scope_level=0`, the
root scope. The dominant retained value tag is `object`, followed by
`undefined`, `int`, `string`, and `float64`; refs are almost entirely `object`.

Ran loopback webserver smoke with elevated localhost bind permission:

```sh
PORT=3313 ./build-edge-quickjs-cli/edge tests/js/webserver.js
curl -sS http://127.0.0.1:3313/
curl -sS http://127.0.0.1:3313/again
```

Result: server printed `webserver listening on port 3313`; both requests
returned `hello`.

Remaining leak suspect after this change: `napi_external_backing_store_hint__`
still has live objects at teardown. That is no longer explained by
`napi_value__` or `napi_ref__` wrapper retention and should be investigated as a
separate QuickJS finalizer/external backing-store lifetime issue.

## 2026-05-11 Standalone N-API Segfault Regression Plan

User reported that running `make test-napi-quickjs` from
`/Users/sadhbh/src/dev/edgejs/napi` now produces 32 segfault failures, while the
root QuickJS CLI build/test path previously passed. This investigation worked
with the then-current vector-backed `napi_value__` / `napi_ref__` allocator
state and avoided reverting concurrent edits. The current source has since
moved to fixed-block `napi_allocator__` storage.

Action plan:

1. Reproduce from the `napi` subdirectory, then reduce to the first crashing
   binary/test: `napi_quickjs_test_2 --gtest_filter=Test2.Ported`.
2. Use LLDB on that exact test to prove where an encoded `napi_value` or
   `napi_ref` handle was still being treated as a direct pointer, or whether the
   then-current allocator slot lookup collided across scopes/build harnesses.
3. Patch only the focused QuickJS N-API implementation path that bypasses the
   allocator decode layer, preserving scope-owned value slots, root-scope ref
   slots, free-list reuse, and root-scope teardown.
4. Verify the targeted test first, then run the `napi` subdirectory
   `make test-napi-quickjs`; run the root `make test-napi-quickjs-only` if
   time allows.

Findings and fix:

- The standalone 32-crash pattern was not a handle-storage collision. LLDB on
  `napi_quickjs_test_2 --gtest_filter=Test2.Ported` stopped in QuickJS runtime
  teardown: `JS_FreeRuntime(...)` finalized GC objects after `DestroyEnvInstance`
  had deleted `napi_env__`. External/wrap finalizers still carried `napi_env`
  pointers, so the env must stay alive until after `JS_FreeRuntime(...)`.
- After rebuilding the root harness with `CMAKE_BUILD_TYPE=Debug`, the remaining
  root crashes reduced to Test6 and Test33. Test6 stopped in
  `napi_delete_reference(...) -> napi_scope__::delete_ref(...)` from
  `MyObject::~MyObject`, called by a QuickJS finalizer after `root_scope_` had
  already been destroyed. The root scope now closes allocator slots first, runs a
  GC pass while the root-scope owner still exists, then frees the scope storage;
  a late `napi_delete_reference(...)` after root teardown is treated as an
  idempotent cleanup.
- Test33 stopped in `js_free_rt(rt=0x12004, ptr=hint)` from
  `napi_external_backing_store_hint__::destroy(...)`. The bad runtime pointer
  was stale hint memory: QuickJS calls an ArrayBuffer free callback on
  `JS_DetachArrayBuffer(...)`, then can call it again when the detached
  ArrayBuffer object finalizes. External ArrayBuffer hints now keep their hint
  object alive across detach, invoke the user finalizer only once, and destroy
  the hint on the final object free path using the `JSRuntime*` passed by
  QuickJS.
- Escapable handle ownership was reviewed while checking the allocator model:
  `escape_value(...)` wraps the inner `JSValue` into the parent scope with
  `owned=false`, and `napi_value__::initialize(..., owned=false)` performs the
  `JS_DupValue(...)`. The child scope later releases its own allocator slot, so
  the escaped parent slot does not borrow freed storage. A future allocator
  `move_to(...)` helper could reduce the temporary duplicate, but the current
  duplicate-and-release behavior is logically safe.

Verification:

```text
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_6 --gtest_filter=Test6.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_33_typedarray --gtest_filter=Test33TypedArray.PortedCoreFlow
CMAKE_BUILD_TYPE=Debug make test-napi-quickjs
(cd /Users/sadhbh/src/dev/edgejs/napi && CMAKE_BUILD_TYPE=Debug make test-napi-quickjs)
```

Both full suites reported 45/45 passing.

## LLDB Breakpoints And Calls

Useful breakpoints:

```text
breakpoint set -n napi_quickjs_lifetime_dump
breakpoint set -n napi_scope__::wrap_value
breakpoint set -n napi_value__::create
breakpoint set -n napi_ref__::create
breakpoint set -n napi_external_backing_store_hint__::create
breakpoint set -n napi_env__::~napi_env__
```

Useful LLDB expression while stopped:

```text
expr napi_quickjs_lifetime_dump("after request")
```

## Node/V8 Lifetime Comparison

Node's V8 backend does not allocate a C++ `napi_value__` wrapper per returned
value. `node/src/js_native_api_v8.h` asserts that `v8::Local<v8::Value>` and
`napi_value` are one pointer wide, then converts with
`reinterpret_cast<napi_value>(*local)`. Rehydration copies that pointer back into
a stack `v8::Local<v8::Value>`.

For older/indirect V8 locals, that pointer is the local handle slot. In that
mode, `v8::LocalBase<T>::New(...)` calls `v8::HandleScope::CreateHandle(...)`;
the internal implementation takes `isolate->handle_scope_data()->next`, extends
the handle block if `next == limit`, advances `next`, writes the tagged value
into the slot, and returns the slot address. Closing a V8 handle scope restores
the previous `next`/`limit`, so all local slots created inside that scope become
invalid as a group.

Modern V8 also has a direct-handle path. Many API implementations in
`node/deps/v8/src/api/api.cc` allocate JS heap objects through the factory as
`DirectHandle`s, for example `v8::Object::New(...)`, `v8::Array::New(...)`,
`v8::Number::New(...)`, and `String::NewFrom*`. They then return public
`Local<T>` values through `Utils::ToLocal(...)` /
`Utils::Convert(...)`. With `V8_ENABLE_DIRECT_HANDLE`, `Utils::Convert(...)`
returns `Local<T>::FromAddress(obj.address())`, so no local handle slot is
allocated for that conversion. Without direct handles, the same conversion uses
`Local<T>::FromSlot(indirect_handle(obj).location())`, which routes through the
handle-scope slot machinery above. Node's bundled V8 defaults direct handles to
the conservative-stack-scanning setting; `node/common.gypi` sets
`v8_enable_conservative_stack_scanning` to `0` by default, so exact behavior is
build-configuration dependent.

Node-owned allocations are therefore concentrated in the surrounding lifetime
objects:

- `napi_handle_scope` and `napi_escapable_handle_scope` are `new`-allocated
  wrappers around stack-like V8 handle scopes, then deleted on close.
- `napi_ref` is a real `Reference` object that owns a V8 persistent handle and
  links into the env reference lists; `napi_get_reference_value(...)` creates a
  fresh local handle slot from that persistent.
- Function callback arguments, `this`, `new.target`, return values from V8
  factory/property/call APIs, and escaped handles are all surfaced as borrowed
  local handle slots rather than per-value heap wrappers.

This is the main design gap for QuickJS tracing: `napi_value__` creation in the
QuickJS backend is closer to allocating per-value handles. If those handles live
in the env root scope, the backend behaves more like an always-open V8 handle
scope whose cursor never rewinds.

## QuickJS Scope Model

The QuickJS backend has a scope stack, but it is implemented differently from
V8's local handle blocks. `napi_env__` creates one `root_scope_` during env
construction and initializes `current_scope_` to that root. Opening a handle
scope allocates a `napi_handle_scope__` with `parent = current_scope_`, then
makes it current. Closing requires that the supplied scope is exactly the
current scope, restores `current_scope_` to `scope->parent()`, and destroys the
scope.

Each scope owns fixed-block `napi_allocator__` storage for local values:

```c++
napi_allocator__<napi_value__, napi_scope__> values_;
```

Public `napi_value` handles are stable pointers to allocator payload slots.
`napi_scope__::wrap_value(...)` initializes an active value slot in the current
scope. Releasing a handle marks the slot inactive and returns it to the block's
free list. Closing a scope releases active slots in reverse order and drops the
allocator blocks.

Persistent `napi_ref` handles are env-owned rather than scope-owned:

```c++
napi_allocator__<napi_ref__, napi_env__> refs_;
```

That matches their semantic lifetime: refs can outlive the local handle scope
that created them and are released by explicit `napi_delete_reference(...)`,
object/finalizer cleanup, or env teardown.

Escapable scopes duplicate the underlying QuickJS value into the parent scope:
`escape_value(...)` calls `parent_->wrap_value(value->get_inner(), false)`.
That creates a separate parent-scope `napi_value__` with its own
`JS_DupValue(...)`; closing the child then frees the child wrapper without
invalidating the escaped parent wrapper.

Callback invocation now opens an automatic temporary N-API handle scope in
`napi_function__::trampoline(...)`. The trampoline stack-allocates
`napi_callback_info__`, invokes the native callback, duplicates a non-null
callback return value into a raw QuickJS result, and deletes the temporary local
return handle before the child scope closes.

That trampoline scope does not cover earlier native libuv/event-entry work such
as `OnConnection(...)` or HTTP parser callbacks that create N-API argument
values before entering JavaScript. Those paths still need explicit Edge-side
handle scopes or an equivalent backend-owned entry scope.

The root scope is destroyed during environment teardown. That releases
root-owned value slots before env teardown completes; remaining teardown
failures should be treated as QuickJS GC/finalizer or external backing-store
lifetime issues, not as allocator storage leaks.

## 2026-05-11 Server Stats Growth Findings

Reproduced the reported shape with the native QuickJS CLI and the local
`server.js`:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
PORT=3312 EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
ab -n 5000 -c 10 http://127.0.0.1:3312/
```

Before adding any callback scope experiment, periodic stats climbed during
request traffic from roughly:

```text
napi_value slots_total=11733 active=11733 napi_ref slots_total=196 active=196
napi_value slots_total=487814 active=487814 napi_ref slots_total=8211 active=8203
napi_value slots_total=1677931 active=1677931 napi_ref slots_total=28211 active=28203
```

The primary value growth is temporary N-API handle creation in native event
entry paths while `env->current_scope()` is still the env root scope. LLDB stack
samples from a single request showed:

```text
OnConnection
  EdgeStreamBaseGetWrapper
  napi_get_reference_value
  napi_scope__::wrap_value

OnConnection
  napi_get_named_property(..., "onconnection")
  napi_scope__::wrap_value

OnConnection
  EdgeStreamBaseMakeInt32
  napi_create_int32
  napi_scope__::wrap_value
```

At the `wrap_value(...)` breakpoint in these stacks:

```text
this == env->root_scope()
this->parent() == nullptr
env->current_scope() == env->root_scope()
```

This means the large `napi_value active == slots_total` growth is not mainly
QuickJS heap values leaking from JavaScript function calls. It is QuickJS N-API
handle wrappers for normal native operations such as reference lookup, property
access, and small integer/value creation being allocated into the always-open
root scope.

An internal temporary scope around `napi_function__::trampoline(...)` does open
and close around JS-to-native callback bodies. LLDB confirmed the scope is
created and destroyed for the `TcpCtor` callback during `napi_new_instance(...)`.
However, that does not cover the earlier native libuv entry work in
`OnConnection(...)`, so it is insufficient as a complete server-growth fix.

Ref growth is a separate but related signal. LLDB samples showed persistent refs
created for per-connection wrappers and active-resource tracking:

```text
napi_wrap
  TcpCtor
  napi_create_reference

Environment::RegisterActiveHandle("TCPSocketWrap")
  EdgeStreamBaseSetWrapperRef
  napi_create_reference
```

Deletes were also observed on request cleanup paths:

```text
FreeWriteReq
  EdgeUnregisterActiveRequestToken
  Environment::UnregisterActiveRequest
  napi_delete_reference
```

So some `napi_ref` churn is expected live socket/request ownership, but the
value-slot growth is root-scope temporary handle retention.

The old vector-backed allocator's reserved-prefix scheme was also checked while
experimenting with automatic callback scopes. Materializing parent prefixes in
child scopes made each callback scope expensive once the root had many slots.
The current fixed-block pointer-handle allocator removed that reserved-prefix
class of overhead.

Current conclusion: the right fix is to open short-lived handle scopes around
native event-entry / libuv callback processing that calls N-API before entering
JS, or to add an equivalent backend-owned entry scope for those EdgeJS runtime
boundaries. A trampoline-only scope is useful but does not address
`OnConnection(...)` and similar native paths.

## 2026-05-12 Native Event Scope Plan

The active reproduction server is the repository-local
`/Users/sadhbh/src/dev/edgejs/server.js`, a minimal `node:http` server that
writes a plain text response. The repeated strings in the root-scope dump map
directly to `BuildHeadersArray(...)` and URL-string creation in
`src/edge_http_parser.cc`, reached from the consumed stream listener while
`llhttp_execute(...)` calls the parser callbacks.

Completed action plan for the first native-event scope pass:

1. Add a tiny Edge-side RAII helper around `napi_open_handle_scope(...)` /
   `napi_close_handle_scope(...)`.
2. Use it only around native libuv/event callbacks that call N-API and do not
   return a `napi_value` to their caller.
3. Start with the server hot path: TCP/Pipe `OnConnection(...)`, consumed HTTP
   parser reads, and stream read callbacks that create ArrayBuffer handles
   before calling JavaScript.
4. Leave normal N-API callback functions and helpers that return `napi_value`
   untouched unless they use an escapable handle scope.

### Node/V8 native event scope comparison

The direct leak-shaped call in the consumed HTTP parser path is:

```c++
napi_value ret = ParserExecuteCommon(p, data, len);
```

inside `src/edge_http_parser.cc::DispatchConsumedParserRead(...)`. That return
value is only used as the `kOnExecute` callback argument. In the current
QuickJS backend, because no local handle scope has been opened for the native
stream-read entry, `ParserExecuteCommon(...)` wraps the return value in
`env->current_scope()`, which is still the env root scope. The same root-scope
ownership also applies to `parser_obj`, `onexecute`, and request-local values
created while `llhttp_execute(...)` runs parser callbacks.

Node's V8 implementation opens the native-event handle scope explicitly before
this kind of work:

- `node/src/node_http_parser.cc::Parser::OnStreamRead(...)` opens
  `HandleScope scope(env()->isolate())` before calling `Execute(...)`, reading
  `kOnExecute`, and calling JavaScript.
- `Parser::Execute(...)` opens an `EscapableHandleScope`, builds the parser
  result/error value, then escapes the return value back to the surrounding
  `OnStreamRead(...)` scope.
- `node/src/connection_wrap.cc::ConnectionWrap::OnConnection(...)` opens
  `HandleScope handle_scope(env->isolate())` before instantiating the accepted
  socket object, building argv, and calling `onconnection`.
- `node/src/stream_base.cc` listener implementations that materialize JS values
  also open scopes themselves: `EmitToJSStreamListener::OnStreamRead(...)`,
  `CustomBufferJSListener::OnStreamRead(...)`, and
  `ReportWritesToJSStreamListener::OnStreamAfterReqFinished(...)`.

The native Node HTTP read flow is:

```text
HTTP bytes arrive from socket
  -> libuv read callback
    -> StreamBase::EmitRead(...)
      -> DebugSealHandleScope
      -> listener_->OnStreamRead(nread, buf)

        HTTPParser::OnStreamRead(...) {
          HandleScope scope;                         // level 1 opens

          ret = Execute(buf.base, nread);

            Execute(...) {
              EscapableHandleScope scope;             // level 2 opens

              current_buffer = buf;
              llhttp_execute(...)

                -> parser callback: on_headers_complete / on_body / Flush
                   may open its own HandleScope when calling JS

              nread_obj = Integer::New(...)
              return scope.Escape(nread_obj);         // escape to level 1
            }                                         // level 2 closes

          cb = object()->Get(kOnExecute)
          current_buffer = buf;
          MakeCallback(cb, [ret])
          current_buffer = null
        }                                             // level 1 closes
```

The generic Node stream dispatch layer does not open the allocation scope for
listeners. `node/src/stream_base-inl.h::StreamResource::EmitRead(...)` wraps
the listener call in `DebugSealHandleScope`, which is a debug barrier that
rejects handle creation unless the listener opens an inner `HandleScope`. This
matches V8's handle discipline: `v8::HandleScope::CreateHandle(...)` checks
that there is an active non-sealed handle scope before creating a local handle.

The analogous EdgeJS paths now provide explicit `edge::HandleScope` /
`edge::EscapableHandleScope` coverage at the matching native-event boundaries
where EdgeJS has implemented the corresponding Node subsystem. The current
scope audit table is:

| location | Node | Edge |
| --- | --- | --- |
| HTTP parser stream read: `node/src/node_http_parser.cc::Parser::OnStreamRead(...)` / `src/edge_http_parser.cc::ParserConsumedListenerOnRead(...)` via `EdgeStreamEmitRead(...)` | yes | yes |
| HTTP parser execute return: `Parser::Execute(...)` / `ParserExecuteCommon(...)` | yes, `EscapableHandleScope` | yes, `edge::EscapableHandleScope` |
| Stream alloc/read entry: `node/src/stream_wrap.cc::LibuvStreamWrap::OnUvAlloc(...)`, `OnUvRead(...)` / `EdgeStreamBaseOnUvAlloc(...)`, `EdgeStreamBaseOnUvRead(...)` | yes | yes |
| Stream JS listener implementations: `node/src/stream_base.cc` listener classes / `src/edge_stream_listener.cc` dispatch | yes | yes |
| Stream write/shutdown completion: `AfterUvWrite(...)`, `AfterUvShutdown(...)` / `OnWriteDone(...)`, `OnShutdownDone(...)` | yes | yes |
| TCP/Pipe connect completion: `ConnectionWrap::AfterConnect(...)` / `edge_tcp_wrap.cc::OnConnectDone(...)`, `edge_pipe_wrap.cc::OnConnectDone(...)` | yes | yes |
| TCP/Pipe accepted connection: `ConnectionWrap::OnConnection(...)` / `edge_tcp_wrap.cc::OnConnection(...)`, `edge_pipe_wrap.cc::OnConnection(...)` | yes | yes |
| Handle close callback: `node/src/handle_wrap.cc::HandleWrap::OnClose(...)` / `EdgeHandleWrapMaybeCallOnClose(...)`, `MaybeCallHandleOnClose(...)` | yes | yes |
| DNS query completion: `node/src/cares_wrap.h::ParseError(...)`, `CallOnComplete(...)`, `node/src/cares_wrap.cc` parse methods / `edge_cares_wrap.cc::CompleteQuery(...)` | yes | yes |
| DNS `getaddrinfo`: `AfterGetAddrInfo(...)` / `OnGetAddrInfo(...)` | yes | yes |
| DNS `getnameinfo`: `AfterGetNameInfo(...)` / `OnGetNameInfo(...)` | yes | yes |
| UDP receive/send completion: `UDPWrap::OnRecv(...)`, `UDPWrap::OnSendDone(...)` / `UdpWrap::OnRecv(...)`, `UdpWrap::OnSendDone(...)` | yes | yes |
| Signal callback: `node/src/signal_wrap.cc` signal lambda / `edge_signal_wrap.cc::OnSignal(...)` | yes | yes |
| Child process exit: `node/src/process_wrap.cc::OnExit(...)` / `edge_process_wrap.cc::EmitOnExit(...)` | yes | yes |
| N-API async work completion: `node/src/node_api.cc::AsyncWorker::AfterThreadPoolWork(...)` / `src/node_api.cc::UvAfterWork(...)` | yes | yes |
| Async fs completion: `node/src/node_file.h::FSReqAfterScope` used by `AfterNoArgs(...)`, `AfterStat(...)`, `AfterInteger(...)`, `AfterScanDir(...)` / `binding_fs.cc::AfterAsyncFsReq(...)` | yes | yes |
| Async file-handle close/read completion: `node/src/node_file-inl.h` / `binding_fs.cc::AfterFileHandleClose(...)`, `AfterFileHandleRead(...)` | yes | yes |
| Async fs dir completion: Node FS after-scope pattern / `binding_fs_dir.cc::AfterOpenDir(...)`, `AfterReadDir(...)`, `AfterCloseDir(...)` | yes | yes |
| Timers/immediates callback dispatch: Node timer callback dispatch runs inside V8 handle scope / `edge_timers_host.cc::CallTimersCallback(...)`, `CallImmediateCallback(...)` | yes | yes |
| Threadsafe immediate/interrupt task callbacks: Node N-API/threadsafe callback paths open a V8 handle scope / `edge_environment.cc::DrainInterrupts(...)`, `DrainThreadsafeImmediates(...)` | yes | yes |
| HTTP/2 callback helpers: `node/src/node_http2.cc` callback dispatch sites / `binding_http2.cc::CallCallbackRef(...)`, `CallCallbackRefWithResource(...)`, `CallNamedIntMethod(...)` | yes | yes |
| TLS/OpenSSL callbacks: `node/src/crypto/crypto_tls.cc` callback paths / `edge_tls_wrap.cc` handshake, keylog, session, OCSP, ALPN, PSK, info, error, and parent-method callbacks | yes | yes |
| Crypto async completion: Node crypto job completion callback dispatch / `binding_crypto.cc::RunCryptoOnDoneTask(...)` | yes | yes |

`src/edge_runtime.cc::EdgeMakeCallbackWithFlags(...)` still intentionally does
not try to retroactively scope handles created before the callback call. The
fix is at the native event boundary, matching Node's ownership model.

### Native event scope implementation

Added `src/edge_handle_scope.h` with two non-copyable, non-movable RAII helpers:

- `edge::HandleScope`, which opens with `napi_open_handle_scope(...)` and
  closes with `napi_close_handle_scope(...)`.
- `edge::EscapableHandleScope`, which opens with
  `napi_open_escapable_handle_scope(...)`, closes with
  `napi_close_escapable_handle_scope(...)`, and exposes `Escape(...)` through
  `napi_escape_handle(...)`.

`EdgeStreamListener` and `EdgeStreamListenerState` now carry `napi_env` so the
generic listener dispatch layer can open a scope without knowing each concrete
listener payload type. The env is set directly for the default/user stream
listeners in `EdgeStreamBaseInit(...)`, for the consumed parser listener in
`ParserCtor(...)`, and propagated in `EdgePushStreamListener(...)`. When a
specific listener has no env, dispatch scans the remaining listener chain or
uses the caller/state env as a fallback. If no env is available, dispatch does
not invoke the listener, because executing a JS-facing listener without a local
handle scope would silently allocate into the root scope.

The following stream-listener callback paths now invoke listener functions under
`edge::HandleScope` when an env is available:

- `EdgeStreamEmitAlloc(...)`
- `EdgeStreamEmitRead(...)`
- `EdgeStreamEmitAfterWrite(...)`
- `EdgeStreamEmitAfterShutdown(...)`
- `EdgeStreamEmitWantsWrite(...)`
- `EdgeStreamPassAfterWrite(...)`
- `EdgeStreamPassAfterShutdown(...)`
- `EdgeStreamPassWantsWrite(...)`
- `EdgeStreamNotifyClosed(...)`

`ParserExecuteCommon(...)` now mirrors Node's inner `Parser::Execute(...)`
shape: it opens `edge::EscapableHandleScope` before `llhttp_execute(...)` /
`llhttp_finish(...)`, then escapes only the intended return value (`nread`,
`undefined`, or parse error) back to the caller's outer listener scope. The RAII
scope helpers treat a null `napi_env` as a fatal internal misuse and abort with
a `FATAL ERROR` message instead of permitting unscoped execution.

The second scope pass added `edge::HandleScope` to the broader Node-mapped
native callback set:

- `src/edge_stream_base.cc`: libuv stream alloc/read, write completion,
  shutdown completion, and stream handle-close callback dispatch.
- `src/edge_tcp_wrap.cc` and `src/edge_pipe_wrap.cc`: connect completion and
  accepted connection callbacks.
- `src/edge_cares_wrap.cc`: c-ares query completion plus `uv_getaddrinfo(...)`
  and `uv_getnameinfo(...)` completion callbacks.
- `src/edge_udp_wrap.cc`: UDP receive and send completion callbacks.
- `src/edge_signal_wrap.cc`: signal delivery callback.
- `src/edge_process_wrap.cc`: child process exit callback.
- `src/edge_handle_wrap.cc`: generic handle close callback dispatch.
- `src/node_api.cc`: N-API async work completion callback.
- `src/internal_binding/binding_fs.cc`: async fs completion and async
  file-handle close/read completion.
- `src/internal_binding/binding_fs_dir.cc`: async directory open/read/close
  completion.
- `src/edge_timers_host.cc` and `src/edge_environment.cc`: timers, immediates,
  interrupt tasks, and threadsafe immediate task dispatch.
- `src/internal_binding/binding_http2.cc`: HTTP/2 callback reference and named
  integer method dispatch.
- `src/edge_tls_wrap.cc`: OpenSSL/TLS handshake, keylog, session, OCSP, ALPN,
  PSK, info, error, and parent-method callback dispatch.
- `src/internal_binding/binding_crypto.cc`: crypto async `ondone` task
  dispatch.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_36_handle_scope \
  --gtest_filter=Test36HandleScope.PortedCoreFlow
./build-edge-quickjs-cli/edge -e "const http=require('http'); console.log('http', typeof http.createServer)"
PORT=3315 EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
curl -sS http://127.0.0.1:3315/
curl -sS http://127.0.0.1:3315/again
```

Results:

- Native QuickJS Edge build passed.
- Focused `napi_quickjs_test_36_handle_scope` passed.
- HTTP eval printed `http function`, then hit the pre-existing
  `JS_FreeRuntime` GC-list teardown assertion.
- The sandboxed server run still failed with the expected `listen EPERM`; the
  approved localhost run served requests successfully.
- Server lifetime stats after requests showed root-scope `napi_value.active`
  bounded in the hundreds with `napi_scope.escape_value.calls` incrementing,
  rather than the previous request-correlated root-scope growth into tens or
  hundreds of thousands.
- After the broader Node-mapped callback scope pass, including HTTP/2, TLS, and
  crypto callback helpers, `cmake --build build-edge-quickjs-cli --target edge
  -j4` passed again. The build still emits pre-existing c-ares and OpenSSL
  deprecation warnings.

### Periodic lifetime stats verbosity split

`napi/quickjs/src/internal/napi_lifetime_tracker.cc` now separates the periodic
stats tick from the heavy diagnostic dump:

- `env->should_dump_lifetime_stats(now)` emits a single
  `[napi-lifetime-stats]` line with `napi_value`, `napi_ref`, and `napi_scope`
  slot totals plus active counts.
- `env->should_dump_lifetime_string_symbol_values(now)` emits the full
  `NAPI LIFETIME TRACKER` dump, including the detailed slot/type/scope/tag
  tables and, when `NAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP` is
  compiled in, the strings and object-type tables.

This keeps normal request-load tracing readable while still allowing the heavier
string/object classification snapshots at the slower interval.

## 2026-05-12 Env-Owned Reference Allocator Plan

`napi_ref` handles are persistent references rather than local handles. They
should therefore be owned directly by `napi_env__`, not by the root
`napi_scope__`.

## 2026-05-16 Platform Task And Contextify Teardown Pass

Follow-up from the Next `entryCSSFiles` investigation:

- Added `edge::HandleScope` to `EdgeRunTaskQueueTickCallback(...)`,
  `DrainProcessTickCallback(...)`, direct loop microtask checkpoints, callback
  scope checkpoints, and the Edge runtime platform foreground/immediate task
  callbacks. These paths can enter JS or run promise jobs without passing
  through the normal N-API callback trampoline.
- Investigated the remaining Debug `JS_FreeRuntime(...)` assertion with LLDB.
  The promise-frame maps were empty; the leaked object was the ESM dynamic
  import registry value `{ importModuleDynamically, callbackReferrer }`.
- Fixed the contextify/module-wrap lifetime natively. Script dynamic-import
  referrer symbols are unregistered after `napi_contextify__::run_script(...)`,
  and Edge's `ContextifyScript` wrapper now keeps its host-defined option in a
  native record, restoring it onto JS only while the script is running and
  clearing the JS properties afterward. Env cleanup detaches these records
  before QuickJS runtime teardown.

Verification:

```sh
cmake --build /Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli-debug --target edge -j4
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli-debug/edge -e "console.log('hi')"
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli-debug/edge -e "import('node:fs').then(m => console.log(typeof m.readFile))"
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli-debug/edge --experimental-vm-modules -e "const vm=require('vm'); const s=new vm.Script('import(\"node:fs\").then(m=>globalThis.n=(globalThis.n||0)+(typeof m.readFile===\"function\"))', { importModuleDynamically: (x)=>import(x) }); s.runInThisContext(); s.runInThisContext(); setImmediate(()=>console.log(globalThis.n));"
cd /Users/sadhbh/src/dev/edgejs/napi && make test-native-quickjs
```

Results: Debug teardown assertion no longer reproduces; dynamic import smokes
print `function` and `2`; native QuickJS tests pass 67/67.

Action plan before code changes:

1. Move `napi_allocator__<napi_ref__>` from `napi_scope__` into `napi_env__`.
2. Keep public reference creation/deletion routed through env helpers.
3. Leave `napi_value__` allocation in `napi_scope__`, because values remain
   local to the current handle scope.
4. Update lifetime scanning so `napi_ref` totals and tag dumps come from the
   env-level ref allocator rather than scope-level ref allocators.
5. Historical decision, superseded on 2026-05-13: the first pass replaced the
   linear weak-ref vector with an object-identity keyed multimap. The later
   QuickJS native weak-ref API removed `weak_refs_` entirely.
6. Historical decision, superseded on 2026-05-13: the first pass replaced the
   linear external ArrayBuffer hint vector with an object-identity keyed
   multimap. The later `JS_GetArrayBufferFreeInfo(...)` API removed
   `external_array_buffer_hints_` entirely.

Verification after the investigation:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_36_handle_scope
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_15_function
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_16_reference
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_37_reference_double_free
env -u CPPFLAGS -u LDFLAGS \
  ./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_6 \
  --gtest_filter=Test6.PortedCoreFlow
```

All of the direct targeted tests passed. `make test-napi-quickjs-only` was run
twice and reported 44/45 passing both times, with
`napi_quickjs_test_6.Test6.PortedCoreFlow` marked failed by CTest
(`SEGFAULT` once, `SIGTRAP` once) even though the test's own output showed
`PASSED` and direct reruns of that test passed. Treat that as a separate
intermittent CTest/process-exit issue unless it reproduces under direct LLDB.

## 2026-05-13 Env-Owned Ref Teardown Assertion

After the env-owned `napi_ref` allocator and constructor/destructor allocator
refactor, `make test-native-quickjs` in Debug reproduced a hard assertion in
the allocator's pointer release path:

```text
napi_quickjs.napi_quickjs_test_6.Test6.PortedCoreFlow
Assertion failed: (owns_block(block)), function release, file napi_allocator.h
```

LLDB showed the assert was not allocator address math. The call stack was:

```text
JS_FreeRuntime(...)
  -> JS_RunGC(...)
  -> napi_external__::finalizer(...)
  -> napi_external_backing_store_hint__::invoke_finalizer(...)
  -> MyObject::Destructor(...)
  -> MyObject::~MyObject()
  -> napi_delete_reference(env_, wrapper_)
  -> napi_env__::delete_ref_from_root_scope(...)
  -> refs_.release(wrapper_)
```

The stale-handle bug was teardown ordering. `napi_env__::prepare_teardown()`
closed the env-owned `refs_` allocator before QuickJS runtime finalization.
QuickJS later finalized a wrapped object during `JS_FreeRuntime(...)`; that
object's native destructor called `napi_delete_reference(...)` on its wrapper
ref, but the allocator blocks had already been destroyed.

The fix keeps allocator slots alive through QuickJS finalization, while still
dropping JS ownership before the context/runtime teardown:

- `napi_ref__::clear_for_teardown()` clears the weak link, releases any strong
  `JSValue` while the context is still valid, then sets the ref to
  `{ env=nullptr, value=JS_UNDEFINED, ref_count=0 }`.
- `napi_env__::prepare_teardown()` now clears active refs instead of closing the
  ref allocator. The allocator itself closes later with `napi_env__` destruction,
  after `JS_FreeRuntime(...)` has had a chance to run object finalizers.
- Late finalizer-driven `napi_delete_reference(...)` now releases an active but
  already-cleared ref slot, so the operation is idempotent and does not touch
  freed allocator storage or a freed QuickJS context.

Verification:

```sh
cd /Users/sadhbh/src/dev/edgejs/napi
CMAKE_BUILD_TYPE=Debug make build-native-quickjs
/Users/sadhbh/src/dev/edgejs/build-napi-quickjs/quickjs/tests/napi_quickjs_test_6 --gtest_filter=Test6.PortedCoreFlow
CMAKE_BUILD_TYPE=Debug make test-native-quickjs
make test-native-quickjs
```

The focused Debug test passed. The full Debug native QuickJS suite passed
45/45. The exact user command `make test-native-quickjs` also passed 45/45 in
the default Release configuration.

## 2026-05-15 Reentrant Allocator Destroy Assertion

With the shared slab allocator and lifetime tracker enabled, the native
QuickJS Edge CLI could serve `server.js` initially, then abort under concurrent
HTTP load:

```text
Assertion failed during allocator `destroy(T *)` block-list membership checking.
```

LLDB showed the assertion was caused by reentrant destruction, not by wrong
owner decoding or bad block alignment. The outer destroy was releasing one
`napi_ref__` slot. Its payload destructor freed a QuickJS value, which ran an
external finalizer for a stream wrapper. That finalizer called
`napi_delete_reference(...)` for another `napi_ref__` in the same allocator
block:

```text
napi_allocator__<napi_ref__, napi_env__>::destroy(ref A)
  -> napi_ref__::~napi_ref__()
  -> napi_ref__::clear_for_teardown()
  -> JS_FreeValue(...)
  -> napi_external__::finalizer(...)
  -> EdgeStreamBaseFinalize(...)
  -> DeleteOnReadRefs(...)
  -> napi_delete_reference(ref B)
  -> napi_allocator__<napi_ref__, napi_env__>::destroy(ref B)
```

The allocator had already unlinked the block from its owning list before
running `slot->destroy()`. During the nested
`destroy(ref B)`, the same block was temporarily in no owning list, so the
membership assertion failed even though the pointer was a valid live slot.

The allocator invariant is now stricter and simpler:

- `destroy(T *)` first unlinks the slot from the block's `first_used_slot_`
  list.
- If the block was linked when `destroy(T *)` began, it unlinks the block's
  single allocator-list `link_` before running the payload destructor.
- It records release, runs `slot->destroy()`, links the slot through
  `first_free_slot_`, then relinks the block only if this call put it in
  vacuum. A nested destroy that enters while the block is already in vacuum
  leaves it in vacuum; the outer destroy owns the final relink.
- `close()` follows the same slot release rule, then unlinks and deletes each
  block after `block->close()` returns.

Verification:

```sh
env CMAKE_BUILD_TYPE=Debug \
  NAPI_ENABLE_LIFETIME_TRACKER=ON \
  NAPI_ENABLE_LIFETIME_PERIODIC_STATS=ON \
  NAPI_ENABLE_LIFETIME_TAG_STATS=ON \
  NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON \
  EDGE_TRACE_NAPI_LIFETIME=1 \
  make build-edge-quickjs-cli

lldb -- ./build-edge-quickjs-cli/edge ./server.js
# target env included the same lifetime flags plus PORT=8081
ab -n 500 -c 10 http://127.0.0.1:8081/
ab -n 5000 -c 10 http://127.0.0.1:8081/

env CMAKE_BUILD_TYPE=Debug \
  NAPI_ENABLE_LIFETIME_TRACKER=ON \
  NAPI_ENABLE_LIFETIME_PERIODIC_STATS=ON \
  NAPI_ENABLE_LIFETIME_TAG_STATS=ON \
  NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON \
  EDGE_TRACE_NAPI_LIFETIME=1 \
  make test-native-quickjs
```

The patched server handled 500 and then 5,000 ApacheBench requests at
concurrency 10 with zero failed requests while LLDB stayed running and did not
hit `__assert_rtn`. The native QuickJS N-API suite passed 48/48 with the
lifetime tracker options enabled.

One separate cleanup-path bug was exposed while port 8080 was still occupied:
the bind failure path produced `EADDRINUSE`, then an `FSEvent` close callback
called `napi_open_handle_scope(...)` with a stale poisoned `napi_env` pointer
during environment cleanup. That is not the allocator membership bug; track it
as an EdgeJS handle-wrapper/env cleanup ordering issue if it reproduces after
the listener conflict is removed.

## 2026-05-13 Root-Scope Function Value Growth

After the reference leak was reduced, lifetime stats still showed request-rate
growth in root-scope `napi_value` object buckets, especially `Function` and
`Object`, while `napi_ref` stayed flat. That points at temporary public
`napi_value` handles being created with `env->current_scope() == root_scope_`,
not persistent reference retention.

LLDB attached to a live `server.js` process and set a conditional breakpoint on:

```text
napi_env__::wrap_value_in_current_scope(JSValue, bool)
condition: this->current_scope_ == this->root_scope_ && JS_IsFunction(this->context_, value)
```

The repeated Function root-scope stack was:

```text
napi_env__::wrap_value_in_current_scope(...)
  -> napi_get_named_property(..., utf8name="destroy", ...)
  -> internal_binding::EmitDestroyHookForAsyncId(...)
  -> internal_binding::DrainQueuedDestroyHooks(...)
  -> EdgeRuntimePlatformDrainImmediateTasks(...)
  -> edge::Environment::OnImmediateCheck(...)
  -> uv__run_check(...)
  -> uv_run(..., UV_RUN_DEFAULT)
  -> RunEventLoopUntilQuiescent(...)
```

So at least one live Function handle leak is not an escaped child scope. It is
the async-wrap destroy-hook drain running as a native immediate/check callback
without an Edge/N-API handle scope around the JS-facing work. Each
`napi_get_named_property(..., "destroy", ...)` wraps the hook function into a
new public `napi_value` in the root scope.

Resolution: `binding_async_wrap.cc::EmitDestroyHookForAsyncId(...)` and the
adjacent `IsDestroyHookAlreadyHandled(...)` helper now open `edge::HandleScope`
around their JS-facing N-API work. The follow-up profile is recorded in
`2026-05-13 Async-Wrap Destroy Hook Scope Fix`; after a patched 5,000-request
HTTP run, `Function` and `Object` value counts stayed flat with speed 0.

## 2026-05-11 Scope Handle Allocator Plan

Action plan:

1. Keep the then-existing vector-backed value/ref allocator behavior intact.
2. Add an internal opaque `napi_scope_handle__` for env-owned scope identity,
   backed by `napi_allocator__<napi_scope__>` rather than raw scope pointers.
3. Store `root_scope_` and `current_scope_` in `napi_env__` as scope handles,
   and resolve them through env helpers when N-API code needs the underlying
   scope object.
4. Preserve public `napi_handle_scope` and `napi_escapable_handle_scope`
   semantics; these may continue to be the concrete public handles returned to
   callers while env bookkeeping uses the allocator-backed internal handle.
5. Extend periodic stats so scopes report total created and active live counts
   alongside value/ref slot totals.
6. Rebuild and rerun focused handle-scope/function/reference tests, plus the
   already-built QuickJS N-API suite if practical.

Implementation notes:

- `napi_scope_handle__` is now an internal opaque handle type.
- `napi_env__::root_scope()` and `napi_env__::current_scope()` return
  `napi_scope_handle__`; code that needs the underlying scope slot resolves it
  through `root_scope_value()`, `current_scope_value()`, or
  `scope_from_handle(...)`.
- `napi_env__` owns a `napi_allocator__<napi_scope__>` for all base scope slots.
  The root scope and current scope are allocator handles, not raw
  `napi_scope__ *` fields.
- Public `napi_handle_scope__` and `napi_escapable_handle_scope__` remain stable
  public handle objects, but each owns an internal allocator-backed scope handle.
- `napi_allocator__::close()` now resets its logical base index so reused scope
  slots do not inherit stale child-scope prefix offsets.
- Periodic stats now print scope slot totals alongside value/ref slot totals:

```text
[napi-lifetime-stats] napi_value slots_total=595 active=595 napi_ref slots_total=196 active=196 napi_scope slots_total=3 active=1
```

Server smoke with allocator-backed scopes:

```sh
PORT=3314 EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
ab -n 5000 -c 10 http://127.0.0.1:3314/
```

Observed scope slots stayed bounded during the run:

```text
napi_scope slots_total=3 active=1
napi_scope slots_total=3 active=1
napi_scope slots_total=3 active=1
```

Verification:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_36_handle_scope
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_15_function
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_16_reference
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_37_reference_double_free
make test-napi-quickjs-only
```

Focused tests passed, and the full already-built QuickJS N-API suite reported
45/45 passing.

The build cache was then restored to the default lifetime flags:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=OFF \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=OFF
cmake --build build-edge-quickjs-cli --target edge -j4
```

The default-off build succeeded. The focused handle-scope, function, reference,
and reference double-free tests also passed against that build. A subsequent
default-off full rerun passed as well:

```sh
make test-napi-quickjs-only
```

Result: 45/45 tests passed.
