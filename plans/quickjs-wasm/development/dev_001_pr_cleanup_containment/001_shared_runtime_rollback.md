# Shared runtime rollback

## Scope

Restore these directories from `/Users/sadhbh/src/dev/wasmer-io/edgejs`:

- `lib/`
- `napi/v8/`
- `napi/src/`
- `napi/include/`

This addresses the PR cleanup request that QuickJS-only changes should not live
in shared EdgeJS library code, V8 provider code, or common N-API code.

## Status

Done locally.

## Verification

These comparisons passed after rollback:

```sh
diff -qr /Users/sadhbh/src/dev/wasmer-io/edgejs/lib /Users/sadhbh/src/dev/edgejs/lib
diff -qr /Users/sadhbh/src/dev/wasmer-io/edgejs/napi/v8 /Users/sadhbh/src/dev/edgejs/napi/v8
diff -qr /Users/sadhbh/src/dev/wasmer-io/edgejs/napi/src /Users/sadhbh/src/dev/edgejs/napi/src
diff -qr /Users/sadhbh/src/dev/wasmer-io/edgejs/napi/include /Users/sadhbh/src/dev/edgejs/napi/include
```

## Notes

The remaining `git status` modifications under `lib/` are expected because the
local branch differs from its own git base; the acceptance check for this task is
the donor-tree `diff -qr`, not a clean git diff.
