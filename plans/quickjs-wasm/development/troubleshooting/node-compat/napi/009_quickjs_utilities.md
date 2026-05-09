# Known Issue: QuickJS utility ownership

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Shared utilities moved to `napi_util__` under `napi/quickjs/src/internal`. |
| **Severity** | Low | Shared helpers are not a feature by themselves, but mistakes here spread widely. |

## Current State

Shared QuickJS helpers live in:

- `napi/quickjs/src/internal/napi_util.h`
- `napi/quickjs/src/internal/napi_util.cc`

The helpers were renamed to lower_case style, redundant code was removed, and
call sites now use the internal utility class instead of removed compatibility
files.

## Known Incompatibility

This is not a user-visible Node compatibility issue by itself. The risk is that
path handling, value conversion, atom handling, or source loading can drift if
each subsystem invents its own QuickJS boilerplate.

## Current Status

Keep `napi_util__` deliberately boring. General QuickJS mechanics can live
there, while Node policy should stay in EdgeJS runtime/bootstrap code or in the
focused subsystem that owns the behavior. Avoid turning utilities into a policy
dumping ground.
