# `napi_lifetime_tracker__`

`napi_lifetime_tracker__` is the QuickJS-style diagnostic tracker for the V8
backend.

It lives in `napi/v8/src/internal/napi_lifetime_tracker.h` and `.cc` under the
`v8impl::detail` namespace. It records creation and release of tracked native
objects, records observed `napi_value` handles by active scope, tracks escaped
scope values, and can dump summaries at env teardown or periodic intervals.

Generic pieces shared with QuickJS live in `napi/lib/src/napi_lifetime_tracker.h`
and `.cc`: type counters, environment flag parsing, monotonic timing, counter
history, table formatting, tag rows, string/object aggregation, scope/slot/type
summary rows, and the common lifetime dump macro. The V8-specific file keeps
only V8 mechanics such as reading `v8::Local` values, classifying V8 values,
snapshotting refs, and maintaining the V8 scope map used by diagnostics.

Allocator-backed V8 objects reach the tracker through
`napi_allocator_lifetime__<T, napi_env__>`. That keeps `env->allocate<T>(...)`
as the single ownership path while preserving per-type rows in
`[napi-lifetime-types]`.

The tracker is controlled by CMake/env flags:

```sh
NAPI_ENABLE_LIFETIME_TRACKER=ON
NAPI_ENABLE_LIFETIME_PERIODIC_STATS=ON
NAPI_ENABLE_LIFETIME_TAG_STATS=ON
NAPI_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON
```

Runtime dumps are enabled with:

```sh
EDGE_TRACE_NAPI_LIFETIME=1
```

When the tracker is disabled, the public static methods still exist as no-ops.
That keeps ordinary CI builds compiling while allowing tracking call sites to
remain in the code.
