# Node V8 N-API vs Edge `napi/v8`

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Mechanical comparison of the current Edge V8 N-API implementation against Node's V8 N-API implementation. |
| **Files compared** | `napi/v8/src/js_native_api_v8.cc` and `node/src/js_native_api_v8.cc` | Namespaces and class names are ignored where the mechanics are equivalent. |
| **Conclusion** | Similar core, not identical | The value/ref/scope model is now Node-shaped, but several embedder, cleanup, buffer, string, callback, and error mechanics still differ. |

## Executive Summary

The Edge `napi/v8` implementation is not an exact mechanical copy of Node's
`node/src/js_native_api_v8.cc`.

It now matches Node in the most important ownership model:

- `napi_value` is a direct current-scope V8 local handle.
- `napi_ref` is persistent storage backed by a V8 global.
- N-API handle scopes are real V8 handle scopes.
- Weak references and finalizer references follow the same broad Node pattern.

The remaining differences are mostly caused by the fact that Edge `napi/v8` is
an embeddable standalone V8 provider, while Node's file is wired into Node's
full `Environment`, `BaseObject`, `Buffer`, error, finalizer, async cleanup, and
module-callback machinery.

That means the V8-handle lifetime design is aligned, but the implementation is
not behavior-for-behavior identical yet.

## Same Or Mechanically Equivalent

### `napi_value`

This is the strongest match.

Node converts a V8 local value to `napi_value` by directly casting the internal
local handle pointer. Edge `napi/v8` now does the same thing:

```cpp
inline napi_value JsValueFromV8LocalValue(v8::Local<v8::Value> local) {
  return reinterpret_cast<napi_value>(*local);
}
```

The reverse conversion reconstructs a `v8::Local<v8::Value>` from the
`napi_value`. Edge uses the same local-handle idea, with an extra
`napi_v8_wrap_value(...)` helper so the lifetime tracker can observe value
creation.

Mechanically: same handle model, with Edge diagnostics layered on top.

### References

Node's `Reference`, `ReferenceWithData`, and `ReferenceWithFinalizer` map to
Edge's `napi_ref__`, `napi_ref_with_data__`, and
`napi_ref_with_finalizer__`.

Both implementations:

- store the JS value in a persistent V8 handle;
- track a refcount;
- make zero-ref object/symbol references weak;
- clear weakness when the refcount rises again;
- reset the persistent handle in the weak callback;
- enqueue finalizers instead of running user finalizer code inside the V8 weak
  callback;
- distinguish runtime-owned refs from userland-owned refs.

Mechanically: close match.

Differences:

- Node has an additional `TrackedFinalizer` helper used by
  `node_api_post_finalizer(...)` and instance-data finalization.
- Edge does not currently implement `node_api_post_finalizer(...)` in
  `napi/v8/src`.
- Node has special experimental-version behavior where finalizers may run
  immediately in a GC-finalizer state. Edge always uses its queued finalizer
  path.
- Edge records refs in the V8 lifetime tracker.

### Handle Scopes

Both implementations use real V8 scope objects:

- `v8::HandleScope`
- `v8::EscapableHandleScope`

Node returns a direct cast of a heap-allocated scope wrapper as
`napi_handle_scope`. Edge returns a public opaque struct that contains the env
and the wrapper.

Mechanically: the V8 scope behavior is equivalent.

Differences:

- Edge tracks a LIFO scope stack and checks that scopes are closed against the
  same env and in stack order.
- Node tracks only `open_handle_scopes` and deletes the wrapper pointer.
- Edge records scope value release and escape statistics in the lifetime
  tracker.

### Externals And Type Tags

Both implementations wrap `v8::External` with a small native object carrying:

- the native data pointer;
- optional N-API type tag state;
- a weak persistent handle so the wrapper is deleted when the external is
  collected.

Mechanically: close match.

Differences:

- Edge stores the wrapper class in `napi_external_wrapper__`.
- Edge's type-tag key for ordinary objects is an env-owned V8 private key.
  Node uses its `NAPI_PRIVATE_KEY(...)` environment/context mechanism.

### `napi_create_external(...)`

This path now follows Node's ownership shape.

Node creates a V8 external wrapper. If a finalizer is provided, it creates a
runtime-owned finalizer reference that deletes itself after finalization. Edge
does the same with `napi_ref_with_finalizer__`.

Mechanically: equivalent in the important lifetime behavior.

## Different Mechanics

### Environment Integration

Node's file depends on Node's full environment layer:

- `env-inl.h`
- `util-inl.h`
- `NAPI_PREAMBLE`
- `GET_RETURN_STATUS`
- `CHECK_*` macros
- `env->CallIntoModule(...)`
- `env->CallFinalizer(...)`
- `env->EnqueueFinalizer(...)`
- `NAPI_PRIVATE_KEY(...)`

Edge `napi/v8` has its own smaller env:

- manual `CheckEnv(...)` / `CheckValue(...)`;
- explicit `last_error` and `last_exception` storage;
- private keys stored directly on `napi_env__`;
- local cleanup-hook vectors;
- local ref/finalizer lists;
- local finalizer microtask drain;
- optional lifetime tracker state.

This is the largest structural difference. The public N-API calls often do the
same V8 operation, but the surrounding status, exception, cleanup, and embedder
integration are not the same as Node's.

### Exception And Status Handling

Node's implementation routes most calls through `NAPI_PREAMBLE` and
`GET_RETURN_STATUS`. Those macros integrate with Node's pending-exception
tracking and last-error state. Node also uses `CHECK_MAYBE_*`,
`RETURN_STATUS_IF_FALSE(...)`, and type-conversion helpers.

Edge `napi/v8` handles this manually with `v8::TryCatch`, `SetLastException`,
`napi_v8_set_last_error(...)`, and direct status returns.

Mechanical difference:

- Node's exception/status handling is centralized and environment-aware.
- Edge's is per-function and simpler.

This can change exact return status, last-error text, and pending-exception
behavior in edge cases.

### Callback Payload Lifetime

Node's callback payload is `CallbackBundle`. It is stored in a V8 external, and
Node creates a runtime-owned `ReferenceWithFinalizer` to delete the bundle when
the callback data is no longer live.

Edge allocates `napi_callback_payload__` with `new (std::nothrow)` and passes it
through a `v8::External`, but there is no equivalent finalizer reference in the
current `napi_create_function(...)` and `napi_define_class(...)` paths.

Mechanical difference:

- Node ties callback payload lifetime to V8 reachability.
- Edge currently creates callback payloads without the same cleanup mechanism.

This should be improved. The Node approach is the better model here.

### Callback Invocation

Node invokes N-API callbacks through `env->CallIntoModule(...)`. That wrapper
handles module entry, exception conversion, and termination behavior.

Edge calls the N-API callback directly from `FunctionTrampoline(...)`, then
checks `env->last_exception` and throws it back into V8 if present.

Mechanical difference:

- Node has a richer call boundary.
- Edge has a thinner direct trampoline.

The direct trampoline is simpler, but it is not identical to Node's module-call
boundary.

### Class Definition

Node's `napi_define_class(...)` builds a `v8::FunctionTemplate`, applies
prototype members on the template, uses signatures for prototype methods, gets
the constructor function, then applies static descriptors separately with
`napi_define_properties(...)`.

Edge also uses a `v8::FunctionTemplate` for the constructor, but the property
installation differs:

- Edge gets the constructor function early.
- Edge obtains the `prototype` object and defines instance descriptors directly
  on that object.
- Edge creates method/getter/setter functions through `napi_create_function(...)`
  rather than always building function templates in the Node path.
- Edge sets `InstanceTemplate()->SetInternalFieldCount(1)`.

Mechanically: not identical. The overall class shape should be close for common
N-API tests, but the construction path is not the same as Node's.

### Property Definition And Conversion Helpers

Node has shared helpers such as:

- `V8NameFromPropertyDescriptor(...)`;
- `V8PropertyAttributesFromDescriptor(...)`;
- `CHECK_TO_*` conversion macros;
- generated coercion functions.

Edge has local equivalents such as `ToV8PropertyAttributes(...)` and repeated
manual conversions.

Mechanically: mostly equivalent at the V8 API level, but not identical in error
paths and validation order.

### External Strings

Node implements `node_api_create_external_string_latin1(...)` and
`node_api_create_external_string_utf16(...)` using V8 external string resources
when possible. Those resources are tracked and call the supplied finalizer.

Edge currently falls back to ordinary copied V8 strings:

- it ignores the finalizer callback and hint;
- it calls the normal string creation path;
- it reports `copied = false` when the pointer is non-null.

Mechanical difference: substantial.

This is an area where Edge should either implement Node's external string
resource mechanics or report `copied` consistently with the actual fallback.

### Buffers

Node uses Node's Buffer implementation. `napi_create_buffer(...)`,
`napi_create_external_buffer(...)`, and
`node_api_create_buffer_from_arraybuffer(...)` produce real Node Buffer objects
through Node's internal Buffer machinery.

Edge cannot depend on Node internals, so it does this instead:

- creates or wraps a V8 `BackingStore`;
- attempts `global.Buffer.from(arrayBuffer, offset, length)` when `Buffer` is
  available;
- falls back to `Uint8Array` during early bootstrap;
- tracks backing stores with `napi_buffer_record__`;
- finalizes external backing stores through a local deleter/hint object.

Mechanical difference: substantial but intentional.

The Edge path is a standalone approximation of Node Buffer behavior. It is not
Node's native Buffer implementation.

### External ArrayBuffer

Node implements `napi_create_external_arraybuffer(...)` by delegating to
`napi_create_external_buffer(...)` and then returning the underlying arraybuffer
from the typed-array info path. The comment says this is because the API
contract requires cleanup on the JS thread with `napi_env`.

Edge creates a V8 external ArrayBuffer directly with a backing-store deleter.

Mechanical difference: substantial.

This may be fine for standalone V8, but it is not Node's exact cleanup model.

### Instance Data

Node stores instance data as a tracked finalizer object. Replacing instance data
finalizes the old data through `TrackedFinalizer`, and `napi_get_instance_data`
unwraps that tracked object.

Edge stores raw instance data, finalizer callback, and hint directly on
`napi_env__`. The env destructor calls the finalizer if present.

Mechanical difference: Node has a tracked finalizer object; Edge has direct env
fields.

### `node_api_post_finalizer(...)`

Node implements `node_api_post_finalizer(...)` in this file. It creates a
`TrackedFinalizer` and enqueues it on the env.

Edge `napi/v8/src` does not currently implement this function.

Mechanical difference: missing Node API surface in the V8 provider.

### Env Cleanup Hooks

Node's cleanup machinery is split across Node's environment implementation and
Node-API files. Edge has a local vector of `napi_env_cleanup_hook__` records and
manually sorts/runs/removes hooks during env teardown.

Mechanical difference: same intended N-API feature, different storage and
teardown machinery.

### Dynamic Import Hook

Edge installs a V8 host dynamic import callback from `napi_env__` construction.
The callback looks for a JavaScript helper named `__napi_dynamic_import` on
`process` or global.

This is Edge-specific embedding glue. It is not part of Node's
`js_native_api_v8.cc` mechanics.

### Lifetime Tracker

Edge has QuickJS-style V8 lifetime diagnostics:

- value tracking by V8 scope;
- ref/scope/buffer/deferred/hook type counts;
- scope escape counters;
- optional periodic dumps;
- optional tag/string/object summaries.

Node's implementation does not have this diagnostic layer.

Mechanical difference: Edge adds observation, but this should not alter public
N-API semantics.

The shared diagnostic core now lives in `napi/lib/src/napi_lifetime_tracker.h`
and `.cc`, with backend files acting as engine adapters. Shared allocator,
last-error, periodic-gate, text, and typed-array metadata helpers also live in
`napi/lib/src`. QuickJS and V8 use the same generic compile-time flags:

```sh
NAPI_ENABLE_LIFETIME_TRACKER=ON
NAPI_ENABLE_LIFETIME_PERIODIC_STATS=ON
NAPI_ENABLE_LIFETIME_TAG_STATS=ON
NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON
```

## Function-Level Observations

### Mostly Node-Shaped

These areas are mechanically close, even though implementation style differs:

- primitive value creation;
- object and array creation;
- date creation;
- symbol creation;
- most typed array and dataview creation;
- object property get/set/has/delete;
- prototype get/set;
- strict equality;
- reference creation/ref/unref/get/delete;
- wrapping/unwrapping native data;
- object type tags;
- promise creation/resolve/reject;
- handle scopes and escapable handle scopes.

### Not Node-Identical

These areas should not be treated as a direct Node copy:

- callback payload lifetime;
- callback entry through `CallIntoModule`;
- `napi_define_class(...)` property/template mechanics;
- external string resources;
- Buffer construction and Buffer identity;
- external ArrayBuffer cleanup;
- `node_api_post_finalizer(...)`;
- instance data finalization;
- exact exception and last-error behavior;
- env cleanup hook storage/order machinery;
- dynamic import support;
- lifetime tracker diagnostics.

## Risk Notes

### Callback Payloads Are The Biggest Mechanical Gap

The Node implementation deliberately creates a finalizer-backed reference for
callback data. Edge currently allocates callback payloads and passes them to V8
as externals without the same cleanup path.

That means the current Edge implementation is not mechanically equivalent here,
and this is likely worth fixing before calling the V8 backend "great".

### External Strings Are Not Equivalent

The Edge external-string functions currently create normal strings and ignore
the external finalizer. That is a real semantic difference, especially for
native code that expects the finalizer to release memory.

### Buffer Behavior Depends On Bootstrap State

Edge's Buffer creation path is intentionally standalone: it uses
`global.Buffer.from(...)` when possible and falls back to `Uint8Array`.

This is a reasonable embedding adaptation, but it is not Node's native Buffer
mechanics. Any code that depends on Buffer identity during early bootstrap may
see a difference.

## Recommended Follow-Up

1. Copy Node's callback payload lifetime pattern: every callback payload should
   be reachable through a finalizer-backed runtime reference or equivalent weak
   cleanup.
2. Implement external string resources properly, or correct `copied` and
   finalizer behavior for the fallback path.
3. Add `node_api_post_finalizer(...)` to Edge `napi/v8`.
4. Revisit instance data so it uses a tracked finalizer record like Node.
5. Audit `napi_define_class(...)` against Node's template-based descriptor
   installation, especially method signatures and accessor behavior.
6. Decide whether `napi_create_external_arraybuffer(...)` should keep the Edge
   direct ArrayBuffer path or follow Node's external-buffer delegation model.
7. Keep the lifetime tracker, because it is diagnostic-only and useful, but do
   not let it change `napi_value` lifetime semantics.

## Bottom Line

Edge `napi/v8` now has the right Node-style core: local `napi_value` handles,
V8 handle scopes, persistent refs, weak refs, and finalizer references.

It is not yet an exact mechanical clone of Node's `js_native_api_v8.cc`. The
remaining differences are concentrated in the surrounding embedder mechanics:
callback payload lifetime, error/status integration, external strings, buffers,
instance data, and post-finalizer support.
