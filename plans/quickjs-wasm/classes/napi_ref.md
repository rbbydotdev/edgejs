# `napi_ref__`

Status: Current as of 2026-05-15.

`napi_ref__` is the persistent N-API reference object for the QuickJS backend.

It lives in `napi/quickjs/src/internal/napi_ref.h` and `.cc`. The ref stores its
owning env, a `JSValue`, a QuickJS native weak-ref link, and the logical N-API
reference count returned by `napi_reference_ref(...)` and
`napi_reference_unref(...)`.

A positive refcount owns a strong duplicate of the target value. A zero refcount
tries to install a QuickJS native weak reference with `JS_AddNativeWeakRefLink`.
If weak linking is unavailable for the target but the value is ref-counted, the
ref falls back to holding a strong duplicate so the stored `JSValue` remains
valid.

`add_ref()` promotes a weak ref back to strong ownership. `rem_ref()` decrements
the logical count and, when it reaches zero, attempts to make the target weak
and releases the strong duplicate if that weak transition succeeds.

Weak target finalization clears the stored value and resets the logical count.
Env teardown takes refs out of the allocator one at a time and calls
`clear_for_teardown()` while the QuickJS context is still valid. Deleting a ref
that has already been cleared is a no-op, which keeps finalizer reentrancy safe.

Refs are allocated from `napi_env__::refs_`, so public `napi_ref` handles are
stable pointers to env-owned allocator payloads.
