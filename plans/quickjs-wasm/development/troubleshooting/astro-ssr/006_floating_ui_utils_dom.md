# Astro SSR: Floating UI Utils DOM Subpath

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in QuickJS package exports subpath resolution. |
| **Severity** | High | The Astro route could not render while this dependency subpath failed to load. |

## Issue

After the Astro standalone SSR server starts successfully outside the Codex
local-bind sandbox, opening the site in Firefox triggers a route render failure:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Observed server output:

```text
(node:15190) [DEP0093] DeprecationWarning: The crypto.fips is deprecated. Please use crypto.getFips()
(node:15190) [DEP0176] DeprecationWarning: fs.F_OK is deprecated, use fs.constants.F_OK instead
13:10:51 [@astrojs/node] Server listening on http://localhost:4321
13:11:02 [ERROR] [router] Error while trying to render the route /
13:11:02 [ERROR] ReferenceError: could not load module '@floating-ui/utils/dom'
    at runMicrotasks (native)
    at processTicksAndRejections (<input>:105:5)
```

## Diagnosis

This is separate from the listen issue. The server starts and the failure
appears only when a request renders `/`.

The failing specifier is the package subpath:

```text
@floating-ui/utils/dom
```

QuickJS throws `ReferenceError: could not load module ...` from its module load
callback when it cannot resolve/load a module.

The package metadata is valid Node-style package `exports`:

```json
"./dom": {
  "import": {
    "types": "./dist/floating-ui.utils.dom.d.mts",
    "default": "./dist/floating-ui.utils.dom.mjs"
  },
  "types": "./dist/floating-ui.utils.dom.d.ts",
  "module": "./dist/floating-ui.utils.dom.esm.js",
  "default": "./dist/floating-ui.utils.dom.umd.js"
}
```

The QuickJS resolver's string scanner found the `import` condition but then
picked the nested key name `types` as though it were a target. It tried to
resolve a file named `types` and stopped before trying the nested `default`
runtime target.

## Current Status

Updated the QuickJS package resolver so `TryResolvePackageSubpath(...)` does
not stop after the first condition string if that candidate does not resolve to
a runtime file. The current shared implementation lives in
`napi/quickjs/src/unofficial_module_loader.cc` and tries runtime condition
targets in order, returning the first target that resolves.

This keeps the fix narrow: it does not add a full JSON parser or a complete
Node package exports implementation, but it handles the nested condition shape
that exposed this issue.

## Constraints

- Do not modify the Astro app, `node_modules`, or generated `dist` files.
- Keep the fix in EdgeJS/QuickJS runtime code if a runtime fix is required.
- Fix one behavior at a time and rerun the focused import before rerendering the
  Astro route.

## Validation

Focused import check:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('@floating-ui/utils/dom').then(m=>console.log('loaded', Object.keys(m).length)).catch(e=>{ console.error(e && (e.stack || e.message || e)); process.exitCode = 1; })"
```

Observed result after the fix:

```text
loaded 20
```

Then rerun the server and request `/`:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Expected result for this issue: the `@floating-ui/utils/dom` module loads, or
the failure is narrowed to a different concrete module/runtime behavior and
captured in a follow-up note.

Observed route result after the fix: the Floating UI error disappears and route
rendering reaches a later module resolution failure:

```text
ReferenceError: could not load module 'react-remove-scroll-bar/constants'
```

The later failure is captured in `007_react_remove_scroll_bar_constants.md`.
