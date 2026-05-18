# Astro SSR: Missing Intl Global

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Minimal runtime compatibility fallback implemented. |
| **Severity** | Medium | The fallback enables Astro startup but is intentionally incomplete compared with ECMA-402 Intl. |

## Issue

After the `depd` CallSite compatibility fix, the Astro standalone SSR entry for
`stackmachine.com` advances to a new QuickJS runtime failure:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Observed error:

```text
ReferenceError: Intl is not defined
    at ~/src/dev/stackmachine.com/dist/server/chunks/_@astrojs-ssr-adapter_BqW-NUXY.mjs:734:28
```

The generated Astro chunk creates a logger timestamp formatter at module load:

```js
const dateTimeFormat = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});
```

## Diagnosis

The native QuickJS Edge runtime currently exposes no `globalThis.Intl`. Astro's
SSR adapter expects at least `Intl.DateTimeFormat` to exist during module
evaluation.

This is separate from the `depd` stack compatibility issue: a focused
`require('depd')('x')` check now succeeds, and the Astro entry reaches this
later import-time failure.

## Current Status

Implemented the narrow runtime-level fallback option in `src/edge_runtime.cc`.
During early runtime bootstrap, before the `process` object is installed, EdgeJS
now checks for `globalThis.Intl.DateTimeFormat`. If a real implementation
already exists, it is left untouched. If it is missing, EdgeJS installs a small
JS fallback with:

- a callable/constructible `Intl.DateTimeFormat`;
- `format(value)` for local-time `HH:mm:ss` / `h:mm:ss AM|PM` output;
- `resolvedOptions()`;
- `supportedLocalesOf()`;
- `Symbol.toStringTag`.

This is intentionally not a full ECMA-402 implementation. It does not perform
real locale negotiation, ICU-backed calendar selection, numbering-system
formatting, or time-zone conversion. It exists to satisfy framework bootstrap
paths, including Astro's SSR logger timestamp formatter, without modifying app
code or generated output.

Choosing this minimal fallback keeps native QuickJS and WASIX QuickJS moving
while leaving the door open for a future real Intl provider.

## Constraints

- Do not modify the Astro app, `node_modules`, or generated `dist` files.
- Fix one behavior at a time and rerun the targeted Astro SSR entry before
  moving to any next failure.
- Avoid pretending to implement full ECMA-402 Intl unless the implementation is
  actually backed by a real formatter.

## Validation

Rebuild:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Focused Intl check:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "const f = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); console.log(typeof f.format(new Date(0)))"
```

Observed result:

```text
string
```

Then rerun the Astro SSR entry:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Expected result for this issue: the `Intl is not defined` failure disappears.

Observed result after the fix: Astro reaches a later runtime/server issue and
prints timestamped logger output, proving the fallback is being used:

```text
13:03:14 [ERROR] [@astrojs/node] Unhandled rejection while rendering undefined
Error: listen EPERM: operation not permitted ::1:4321
```

The later listen failure is captured in `005_listen_eperm.md`.
