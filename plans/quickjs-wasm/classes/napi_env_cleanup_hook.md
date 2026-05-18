# `napi_env_cleanup_hook__`

Status: Current as of 2026-05-15.

`napi_env_cleanup_hook__` stores one env cleanup hook registration.

It lives in `napi/quickjs/src/internal/napi_env_cleanup_hook.h` and `.cc`. The
record stores the owning env, cleanup callback, and callback argument.

Creation delegates to `napi_env__::create_cleanup_hook(...)`, which allocates
from the env-owned cleanup-hook allocator and also records the hook pointer in
registration order. `matches(...)` is used by remove paths to find the exact
hook/arg pair.

`run()` calls the registered hook with its argument. During env teardown,
`napi_env__::prepare_teardown()` drains cleanup hooks while the QuickJS context
and env-owned helper allocators are still valid.
