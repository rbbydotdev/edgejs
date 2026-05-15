# `napi_function__`

Status: Current as of 2026-05-15.

`napi_function__` builds QuickJS functions that call native N-API callbacks.

It lives in `napi/quickjs/src/internal/napi_function.h` and `.cc`. The public
creation path stores the native callback pointer and user data as raw QuickJS
externals in `JS_NewCFunctionData(...)`, then wraps the resulting function into
the current N-API scope.

Calls enter through `napi_function__::trampoline(...)`. The trampoline recovers
the env from the QuickJS context opaque pointer, opens a callback-local handle
scope, builds a stack `napi_callback_info__`, invokes the native callback, and
duplicates the callback result before closing the temporary scope.

Constructor calls are handled specially. The trampoline creates an object with
the function prototype, exposes it as `this`, sets `new.target`, and returns
either the explicit callback result or the constructed object. `make_constructible(...)`
sets QuickJS constructor metadata and prototype linkage.

The function data externals are intentionally raw QuickJS values, not public
`napi_value` slots. That avoids leaking callback metadata into handle scopes.
