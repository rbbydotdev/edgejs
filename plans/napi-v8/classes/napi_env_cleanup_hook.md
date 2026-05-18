# `napi_env_cleanup_hook__`

`napi_env_cleanup_hook__` stores one env cleanup hook registration.

It is currently defined in `napi/v8/src/js_native_api_v8.cc`. The struct stores
the env, cleanup function pointer, user argument, and insertion order.

The env owns cleanup hooks as `std::unique_ptr<napi_env_cleanup_hook__>`. The
cleanup hook list is sorted and drained during `napi_env__` teardown. The order
field lets the implementation preserve Node/N-API cleanup ordering rules while
still storing hooks in a simple vector.

Create and release are reported to the lifetime tracker, so leaked or retained
cleanup-hook records are visible in diagnostics.
