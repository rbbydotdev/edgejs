# Shared runtime rollback

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Historical containment task. |
| **Severity** | Low | Current issues are tracked in troubleshooting pages. |

## Scope

Restore these directories from `~/src/dev/wasmer-io/edgejs`:

- `lib/`
- `napi/v8/`
- `napi/src/`
- `napi/include/`

This records the containment policy that QuickJS-only changes should not live in
shared EdgeJS library code, V8 provider code, or common N-API code.

## Status

Local status: completed.

## Verification

These comparisons passed after rollback:

```sh
diff -qr ~/src/dev/wasmer-io/edgejs/lib ~/src/dev/edgejs/lib
diff -qr ~/src/dev/wasmer-io/edgejs/napi/v8 ~/src/dev/edgejs/napi/v8
diff -qr ~/src/dev/wasmer-io/edgejs/napi/src ~/src/dev/edgejs/napi/src
diff -qr ~/src/dev/wasmer-io/edgejs/napi/include ~/src/dev/edgejs/napi/include
```

## Notes

The remaining `git status` modifications under `lib/` are expected because the
local branch differs from its own git base; the acceptance check for this task is
the donor-tree `diff -qr`, not a clean git diff.
