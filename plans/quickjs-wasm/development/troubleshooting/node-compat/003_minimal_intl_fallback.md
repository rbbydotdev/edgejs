# Compatibility Adapter: Minimal `Intl.DateTimeFormat` fallback

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Unblocks frameworks but can misrepresent ECMA-402 support. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/004_missing_intl.md`
- `plans/quickjs-wasm/development/dev_001_pr_cleanup_containment/003_intl_fallback_module.md`

## What Is The Compatibility Adapter

When QuickJS has no real `globalThis.Intl`, Edge installs a deliberately tiny
`Intl.DateTimeFormat` fallback. It covers enough timestamp formatting for Astro
bootstrap paths.

## Why It Is Suspect

It looks like `Intl`, but it is not full ECMA-402. It does not do real locale
negotiation, calendars, numbering systems, time-zone rules, or ICU-backed
formatting. Code can easily infer more support than exists.

## How To Do It Better

Either link a real ECMA-402/ICU provider or expose `Intl` as an explicit
unsupported capability. If a fallback remains, make its subset explicit in a
support matrix and add tests proving unsupported options do not silently pretend
to work.
