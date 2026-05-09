# Astro SSR: Zustand Ind Create Export

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in QuickJS package exports condition and wildcard resolution. |
| **Severity** | High | The Astro route could not link because Zustand resolved to a module without the required named export. |

## Issue

After the `react-remove-scroll-bar/constants` package subpath directory fix, the
Astro SSR server on `stackmachine.com` starts and the `/` route advances to a
new module linking failure:

```text
13:20:43 [ERROR] [router] Error while trying to render the route /
13:20:43 [ERROR] SyntaxError: Could not find export 'create' in module '~/src/dev/stackmachine.com/node_modules/zustand/ind'
    at runMicrotasks (native)
    at processTicksAndRejections (<input>:105:5)
```

Focused route validation was run against a temporary server on port `4322`
because port `4321` was already occupied by another server instance.

## Diagnosis

This is separate from the scroll-bar constants issue: the focused
`react-remove-scroll-bar/constants` import now loads successfully, and the
route reaches a later module export mismatch.

The failing resolved module path is:

```text
~/src/dev/stackmachine.com/node_modules/zustand/ind
```

Zustand's package metadata exposes the ESM entry via nested package `exports`
conditions:

```json
".": {
  "import": {
    "types": "./esm/index.d.mts",
    "default": "./esm/index.mjs"
  }
},
"./*": {
  "import": {
    "types": "./esm/*.d.mts",
    "default": "./esm/*.mjs"
  }
}
```

Native ESM resolves `import('zustand')` to:

```text
file://~/src/dev/stackmachine.com/node_modules/zustand/esm/index.mjs
```

Before this fix, QuickJS resolved the same import to:

```text
~/src/dev/stackmachine.com/node_modules/zustand/index.js
```

That CommonJS file re-exports values dynamically through
`Object.keys(...).forEach(...)`, a pattern the synthetic named export scanner
does not currently declare. The missing `create` export was therefore caused by
resolving the package to its CommonJS fallback instead of the ESM import target.

## Current Status

Updated the former QuickJS C++ package exports scanner so it handled the Zustand
export shape:

- when a condition value is an object, choose its nested `default` runtime
  target instead of treating nested metadata keys like `types` as targets;
- resolve the root `"."` package export before falling back to `main`;
- support the simple wildcard export key `"./*"` and substitute the requested
  subpath into targets such as `"./esm/*.mjs"`.

This keeps the fix focused on published package `exports` metadata rather than
adding synthetic named export support for broader dynamic CommonJS patterns.

Later cleanup removed the remaining QuickJS C++ CommonJS facade/module-loader
support, so this note is historical context rather than a pointer to live code.

The considered causes were:

- truncated or extensionless module resolution;
- CommonJS synthetic named export discovery missing a re-export pattern;
- ESM facade generation for a CommonJS entrypoint;
- or a genuinely invalid import emitted by the app build.

The actual cause was package export condition/wildcard resolution selecting the
CommonJS fallback.

## Status Notes

Investigated with the narrowest checks before changing runtime code:

- inspected Zustand package metadata and files in
  `~/src/dev/stackmachine.com/node_modules`;
- reproduced the issue with focused `import('zustand')` and
  `import('zustand/react')` probes;
- compared against native Node ESM resolution for the same specifier and import
  shape;
- updated the QuickJS resolver only because the package exposes a
  valid Node-compatible path/export shape that QuickJS misses.

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
  -e "import('zustand').then(m=>{ console.log('keys', Object.keys(m).join(',')); console.log('create', typeof m.create); })"
```

Observed result after the fix:

```text
quickjs-module normalize ... spec=zustand -> ~/src/dev/stackmachine.com/node_modules/zustand/esm/index.mjs
quickjs-module normalize ... spec=zustand/vanilla -> ~/src/dev/stackmachine.com/node_modules/zustand/esm/vanilla.mjs
quickjs-module normalize ... spec=zustand/react -> ~/src/dev/stackmachine.com/node_modules/zustand/esm/react.mjs
keys create,createStore,useStore
create function
```

Regression checks for the two previous module resolution fixes still pass:

```text
@floating-ui/utils/dom -> .../node_modules/@floating-ui/utils/dist/floating-ui.utils.dom.mjs
react-remove-scroll-bar/constants -> .../node_modules/react-remove-scroll-bar/dist/es2015/constants.js
```

Then rerun the server and request `/`:

```sh
cd ~/src/dev/stackmachine.com
PORT=4322 ~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
curl -i http://localhost:4322/
```

Expected result for this issue: the module exposes `create`, or the failure is
narrowed to a different concrete module/runtime behavior and captured in a
follow-up note.
