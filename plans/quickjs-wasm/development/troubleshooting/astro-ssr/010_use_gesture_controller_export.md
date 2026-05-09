# Astro SSR: Use Gesture Controller Export

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in QuickJS package exports condition preference. |
| **Severity** | High | The Astro route could not link until the ESM module target was preferred over the CommonJS default. |

## Issue

After the pnpm symlink canonicalization fix, the Astro SSR server on
`stackmachine.com` starts and the `/` route advances to a new module linking
failure:

```text
13:28:38 [ERROR] [router] Error while trying to render the route /
13:28:38 [ERROR] SyntaxError: Could not find export 'Controller' in module '~/src/dev/stackmachine.com/node_modules/.pnpm/@use-'
    at runMicrotasks (native)
    at processTicksAndRejections (<input>:105:5)
```

Focused route validation was run against a temporary server on port `4322`
because port `4321` was already occupied by another server instance.

## Diagnosis

This is separate from the Zustand default export issue: focused
`@react-three/fiber` imports now resolve through pnpm real paths and load.

The displayed module path was truncated at:

```text
~/src/dev/stackmachine.com/node_modules/.pnpm/@use-
```

The full package behind the path is `@use-gesture/core`. The import site that
exposed the failure is in `@use-gesture/react`:

```js
import { Controller, parseMergedHandlers } from '@use-gesture/core';
```

`@use-gesture/core` publishes package exports with both `module` and `default`
conditions:

```json
".": {
  "module": "./dist/use-gesture-core.esm.js",
  "default": "./dist/use-gesture-core.cjs.js"
}
```

Before this fix, QuickJS preferred `default` before `module`, resolving the ESM
import to the CommonJS wrapper:

```text
.../node_modules/@use-gesture/core/dist/use-gesture-core.cjs.js
```

That CommonJS wrapper then required environment-specific files and did not
provide the ESM export declarations expected by the importing ESM module. Native
Node also resolves this package to the CJS default because the package does not
declare an `import` condition, but this Astro/Vite SSR bundle uses the package's
legacy `module` condition as the ESM target.

## Current Status

Updated the QuickJS package exports scanner so it prefers runtime targets in
this order. The current shared implementation lives in
`napi/quickjs/src/unofficial_module_loader.cc`:

```text
import, module, default
```

The same order is used for legacy package entry candidates. This keeps the
runtime compatible with bundler-oriented packages that expose ESM through
`module` without an explicit `import` condition.

## Status Notes

Investigated with narrow checks before changing runtime code:

- searched the pnpm dependency tree for modules exporting or importing
  `Controller`;
- identified `@use-gesture/core` behind the truncated `@use-...` path;
- compared native Node and QuickJS import behavior for the exact package;
- updated runtime package condition preference for the bundler-compatible
  `module` export shape.

## Constraints

- Do not modify the Astro app, `node_modules`, or generated `dist` files.
- Keep any fix in EdgeJS/QuickJS runtime code if a runtime fix is required.
- Fix one behavior at a time and rerun the focused import before rerendering the
  Astro route.

## Validation

Focused import check:

```sh
cd ~/src/dev/stackmachine.com
EDGE_TRACE_QUICKJS_MODULES=1 \
  ~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('@use-gesture/core').then(m=>{ console.log('core', Object.keys(m).join(',')); console.log('Controller', typeof m.Controller); })"
```

Observed result after the fix:

```text
quickjs-module normalize ... spec=@use-gesture/core -> .../node_modules/@use-gesture/core/dist/use-gesture-core.esm.js
core Controller,parseMergedHandlers
Controller function
```

`import('@use-gesture/react')` also loads and resolves
`@use-gesture/core/actions`, `@use-gesture/core/utils`, and
`@use-gesture/core/types` to their ESM `module` targets.

Then rerun the server and request `/`:

```sh
cd ~/src/dev/stackmachine.com
PORT=4322 ~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
curl -i http://localhost:4322/
```

Expected result for this issue: the `Controller` export mismatch is explained
or fixed, or the failure is narrowed to a different concrete module/runtime
behavior and captured in a follow-up note.
