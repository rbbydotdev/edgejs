# Compatibility Adapter: Minimal `Intl.DateTimeFormat` fallback

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Unblocks frameworks but can misrepresent ECMA-402 support. |

## Implementation Home

This note tracks compatibility behavior implemented in EdgeJS runtime source under `src/`. The related N-API compatibility adapters from this cleanup effort have been extracted into `napi/quickjs/src/compat` and are documented under `node-compat/napi`.

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
