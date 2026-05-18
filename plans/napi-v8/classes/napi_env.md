# `napi_env__`

`napi_env__` is the V8 N-API environment. It binds the N-API surface to one V8
isolate and context, stores process-local N-API state, and owns teardown order.

The class lives in `napi/v8/src/internal/napi_v8_env.h`, with methods defined in
`napi/v8/src/js_native_api_v8.cc`. It owns the persistent context reference,
last-error state, last thrown exception details, private keys used for wraps and
type tags, instance data, cleanup hooks, buffer records, and the reference
lists used by `napi_ref_tracker__`.

It also owns the V8 backend's allocator pools. Env-owned helper objects are
created with `env->allocate<T>(...)` and released with `env->release(ptr)`, which
routes storage through the shared `napi/lib/src/napi_allocator.h` fixed-block
allocator and feeds lifetime diagnostics when tracking is enabled. Last-error
state and periodic lifetime dump scheduling are shared through
`napi/lib/src/napi_error_state.*` and `napi/lib/src/napi_periodic_gate.*`.

External backing-store hints are registered on the env but are not allocated
from the env factory, because their true parent is V8's backing store. During
teardown the env finalizes and detaches any outstanding hints so the later V8
deleter can delete them without touching a dead env.

Its most important responsibility is orderly cleanup. The destructor dumps
lifetime diagnostics, runs env cleanup hooks, finalizes refs with finalizers,
finalizes ordinary refs, finalizes outstanding external backing-store hints,
drains buffer records, runs instance-data finalizers, and finally calls the
embedder destroy callback.

`napi_env__` also bridges V8 GC finalization to N-API finalization. Weak
reference callbacks enqueue `napi_ref_tracker__` objects on the env, and a V8
microtask drains that queue later through `DrainFinalizerQueue()`.
