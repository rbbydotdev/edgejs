# Astro SSR: React Remove Scroll Bar Constants Subpath

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in QuickJS package subpath directory entry resolution. |
| **Severity** | High | The Astro route could not render until this package subpath resolved correctly. |

## Issue

After the `@floating-ui/utils/dom` package exports subpath fix, the Astro SSR
server on `stackmachine.com` starts and the `/` route advances to a new module
load failure:

```text
13:16:26 [ERROR] [router] Error while trying to render the route /
13:16:26 [ERROR] ReferenceError: could not load module 'react-remove-scroll-bar/constants'
    at runMicrotasks (native)
    at processTicksAndRejections (<input>:105:5)
```

Focused route validation was run against a temporary server on port `4322`
because port `4321` was already occupied by another server instance.

## Diagnosis

This is separate from the Floating UI issue: the focused
`@floating-ui/utils/dom` import now loads successfully, and the route reaches a
later package subpath.

The failing specifier is:

```text
react-remove-scroll-bar/constants
```

The package publishes `constants` as a subdirectory with its own
`package.json`:

```json
{
  "main": "../dist/es5/constants.js",
  "module": "../dist/es2015/constants.js"
}
```

Native CommonJS resolution accepts this shape:

```text
require.resolve('react-remove-scroll-bar/constants')
=> .../node_modules/react-remove-scroll-bar/dist/es5/constants.js
```

Native ESM rejects the same bare directory import with
`ERR_UNSUPPORTED_DIR_IMPORT`, so this is a CommonJS-compatible package subpath
case rather than strict ESM package resolution.

The QuickJS resolver already had permissive CommonJS-style package resolution
for bare package entries and subpaths, but its directory handling only tried
`index` files. It did not inspect a package subpath directory's own
`package.json`, so it missed this published entrypoint.

## Current Status

Updated the QuickJS package resolver so `TryResolvePackageSubpath(...)` tries a
subpath directory's own package entry metadata when parent package `exports` do
not resolve the subpath. The current shared implementation lives in
`napi/quickjs/src/unofficial_module_loader.cc`. This keeps the compatibility
fallback narrow:

- parent package `exports` still win first;
- only actual directory subpaths get the nested package entry fallback;
- normal file and `index` fallback behavior remains unchanged.

## Status Notes

Investigated with narrow import checks before changing runtime code:

- inspected `react-remove-scroll-bar` package metadata and files in
  `~/src/dev/stackmachine.com/node_modules`;
- ran a focused QuickJS Edge import check for
  `react-remove-scroll-bar/constants`;
- compared against native Node CommonJS and ESM resolution;
- updated the QuickJS resolver for the CommonJS-compatible subpath directory
  entrypoint case.

## Constraints

- Do not modify the Astro app, `node_modules`, or generated `dist` files.
- Keep any fix in EdgeJS/QuickJS runtime code if a runtime fix is required.
- Fix one behavior at a time and rerun the focused import before rerendering the
  Astro route.

## Validation

Focused import check:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('react-remove-scroll-bar/constants').then(m=>console.log('loaded', Object.keys(m).length)).catch(e=>{ console.error(e && (e.stack || e.message || e)); process.exitCode = 1; })"
```

Then rerun the server and request `/`:

```sh
cd ~/src/dev/stackmachine.com
PORT=4322 ~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
curl -i http://localhost:4322/
```

Expected result for this issue: the `react-remove-scroll-bar/constants` module
loads, or the failure is narrowed to a different concrete module/runtime
behavior and captured in a follow-up note.

Observed focused import result after the fix:

```text
loaded 4
string string
```

With module tracing enabled, the resolver selected:

```text
~/src/dev/stackmachine.com/node_modules/react-remove-scroll-bar/dist/es2015/constants.js
```
