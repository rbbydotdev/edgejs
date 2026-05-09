# Known Issue: Minimal `Intl.DateTimeFormat` fallback

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Minimal runtime fallback exists with known ECMA-402 limits. |
| **Severity** | Medium | Unblocks frameworks but can misrepresent ECMA-402 support. |

## Current State

This issue belongs to EdgeJS runtime/bootstrap code, not QuickJS N-API.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/004_missing_intl.md`
- `plans/quickjs-wasm/development/dev_001_pr_cleanup_containment/003_intl_fallback_module.md`

## Known Incompatibility

When QuickJS has no real `globalThis.Intl`, Edge installs a deliberately tiny
`Intl.DateTimeFormat` fallback. It covers enough timestamp formatting for Astro
bootstrap paths.

## Risk

It looks like `Intl`, but it is not full ECMA-402. It does not do real locale
negotiation, calendars, numbering systems, time-zone rules, or ICU-backed
formatting. Code can easily infer more support than exists.

## Current Status

Either link a real ECMA-402/ICU provider or expose `Intl` as an explicit
unsupported capability. If a fallback remains, make its subset explicit in a
support matrix and add tests proving unsupported options do not silently pretend
to work.
