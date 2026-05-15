# `napi_promises__`

Status: Current as of 2026-05-15.

`napi_promises__` stores QuickJS promise integration state for unofficial
Node/V8-shaped promise APIs.

It lives in `napi/quickjs/src/internal/napi_promises.h` and `.cc`. The class is
an env-owned subsystem and stores the env, QuickJS context, optional promise
reject callback, four lifecycle hooks, continuation-preserved embedder data,
per-promise async context frames, and a stack used while entering/leaving
promise callbacks.

The constructor does not install global hooks by itself; the public/unofficial
N-API entry points route callbacks into this subsystem. Stored callback values
are duplicated QuickJS values and freed during `teardown()`.

`set_reject_callback(...)` and `set_hooks(...)` validate optional function
values before storing them. `promise_hook(...)` is the QuickJS hook bridge for
init/before/after/resolve events. It captures or restores continuation data and
calls the corresponding JavaScript hook when one is registered.

`rejection_tracker(...)` adapts QuickJS promise rejection notifications to the
V8-shaped N-API callback surface. `microtask_job(...)` is a tiny QuickJS job
wrapper that calls a queued JavaScript function.
