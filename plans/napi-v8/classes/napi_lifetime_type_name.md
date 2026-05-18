# `napi_lifetime_type_name__`

`napi_lifetime_type_name__<T>` maps C++ helper types to stable diagnostic names
for lifetime tracker output.

It lives in `napi/v8/src/internal/napi_lifetime_tracker.h`. The default name is
`unknown`; explicit specializations currently cover refs, cleanup hooks,
deferred promise records, backing-store hints, handle scopes, escapable handle
scopes, and buffer records.

The mapping is deliberately string-based because the tracker output is meant to
match the QuickJS lifetime tracker sections and type rows. Adding a new tracked
class should include a specialization here so diagnostics remain readable.

