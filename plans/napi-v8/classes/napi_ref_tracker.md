# `napi_ref_tracker__`

`napi_ref_tracker__` is the intrusive list node used to track references that
must be finalized or invalidated during env teardown.

It lives in `napi/v8/src/internal/napi_ref_tracker.h` and `.cc`. Each node can
`Link(...)` into a list, `Unlink()` from its current list, and override
`Finalize()`. The env owns two list sentinels: one for normal refs and one for
refs with finalizers.

`FinalizeAll(...)` repeatedly finalizes the next node until a list is empty.
That shape matters because finalization can unlink or delete the current node.

This class does not know about V8 handles. It is the shared bookkeeping base
for `napi_ref__` and its finalizer/data variants.

