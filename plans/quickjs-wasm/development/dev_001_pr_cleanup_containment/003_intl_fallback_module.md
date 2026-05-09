# Intl fallback module

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Minimal Intl fallback exists with known ECMA-402 limits. |
| **Severity** | Medium | Framework bootstrap can depend on `Intl.DateTimeFormat`, but the fallback is partial. |

## Scope

Keep the minimal `Intl.DateTimeFormat` fallback isolated in
`edge_intl_fallback.cc`, implemented with N-API instead of raw JavaScript
evaluation.

## Current Implementation

- Added `src/edge_intl_fallback.h`.
- Added `src/edge_intl_fallback.cc`.
- Added the source file to `edge_runtime` in `CMakeLists.txt`.
- Replaced the old `InstallMinimalIntlFallback(...)` string-eval block in
  `src/edge_runtime.cc` with `EdgeInstallMinimalIntlFallback(...)`.

## Intended Behavior

If a real `globalThis.Intl.DateTimeFormat` function exists, leave it untouched.
Otherwise install a deliberately minimal fallback that supports:

- `new Intl.DateTimeFormat(locales, options)`
- `.format(value)`
- `.resolvedOptions()`
- `Intl.DateTimeFormat.supportedLocalesOf()`

This fallback is only meant to unblock framework bootstrap formatting, not to
claim full ECMA-402 compatibility.

## Verification Status

After rebuild, run:

```sh
./build-edge-quickjs-cli/edge -e "const f = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); console.log(typeof f.format(new Date(0)), f.resolvedOptions().hour)"
```

Expected shape:

```text
string 2-digit
```

## Ownership

Code ownership for this subtask is `src/edge_intl_fallback.{h,cc}`,
`src/edge_runtime.cc`, and the `edge_runtime` source list in `CMakeLists.txt`.

## Status Notes

2026-05-07 source inspection, with no source edits:

- The fallback has been split into `src/edge_intl_fallback.{h,cc}` and wired
  into the `edge_runtime` target.
- `src/edge_runtime.cc` now delegates to
  `EdgeInstallMinimalIntlFallback(...)` instead of keeping a local string-eval
  fallback block.
- The fallback implementation uses N-API calls to inspect/install
  `globalThis.Intl.DateTimeFormat`; no raw JavaScript evaluation appears in
  `src/edge_intl_fallback.cc`.
- The implemented minimal behavior covers the current subtask's documented
  `new Intl.DateTimeFormat(locales, options)` path, `.format(value)`,
  `.resolvedOptions()`, and static `supportedLocalesOf()`.
- Caveat: the earlier Astro troubleshooting note described the fallback as
  "callable/constructible", but this subtask's intended behavior only names the
  `new Intl.DateTimeFormat(...)` constructor path. If call-without-`new`
  compatibility is part of the review ask, it should be verified separately
  because the current N-API class constructor path is not explicitly shaped for
  that behavior.
