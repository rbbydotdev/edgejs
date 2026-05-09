# Astro SSR: Zustand ESM Default Export

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in QuickJS module path canonicalization for pnpm symlinks. |
| **Severity** | High | The Astro route linked the wrong package instance until symlinked module paths were canonicalized. |

## Issue

After the Zustand package exports condition/wildcard fix, the Astro SSR server
on `stackmachine.com` starts and the `/` route advances to a new module linking
failure:

```text
13:24:35 [ERROR] [router] Error while trying to render the route /
13:24:35 [ERROR] SyntaxError: Could not find export 'default' in module '~/src/dev/stackmachine.com/node_modules/zustand/esm'
    at runMicrotasks (native)
    at processTicksAndRejections (<input>:105:5)
```

Focused route validation was run against a temporary server on port `4322`
because port `4321` was already occupied by another server instance.

## Diagnosis

This is separate from the earlier missing `create` export: after the 008 fix,
focused `import('zustand')` resolves to the ESM entry and exposes `create`.

The new failing resolved module path is:

```text
~/src/dev/stackmachine.com/node_modules/zustand/esm
```

The import site that exposed the failure is in `@react-three/fiber`:

```js
import create from 'zustand';
```

The app uses a pnpm-style dependency layout where
`node_modules/@react-three/fiber` is a symlink into `.pnpm/...`. Native Node
resolves the module filename through that symlink before resolving nested
dependencies, so `@react-three/fiber` finds its compatible Zustand version:

```text
.../node_modules/.pnpm/zustand@3.7.2_react@18.3.1/node_modules/zustand/esm/index.mjs
```

Before this fix, QuickJS preserved the symlinked module path:

```text
.../node_modules/@react-three/fiber/dist/react-three-fiber.esm.js
```

Its nested `import 'zustand'` then climbed the wrong `node_modules` tree and
selected top-level Zustand 5:

```text
.../node_modules/zustand/esm/index.mjs
```

Zustand 5 has named exports such as `create` but no default export, so the
default import from `@react-three/fiber` failed during module linking.

## Current Status

Updated the QuickJS module path helpers so resolved module filenames are
canonicalized with `std::filesystem::weakly_canonical(...)` before they are
returned to QuickJS. The current shared implementation lives in
`napi/quickjs/src/unofficial_module_loader.cc`. That makes later relative and
package resolution use the real pnpm package path, matching Node's dependency
lookup behavior for symlinked packages.

The considered causes were:

- an invalid generated import that expects a default export where none exists;
- directory resolution selecting `esm/index.mjs` for a specifier Node rejects;
- or an import-facade/export declaration mismatch in QuickJS.

The actual cause was non-canonical symlink paths causing package resolution to
choose the wrong installed dependency version.

## Status Notes

Investigated with narrow checks before changing runtime code:

- found the dependency import site that requests `default` from `zustand`;
- inspected top-level Zustand 5 and the compatible dependency-scoped Zustand 3
  package;
- compared native Node and QuickJS behavior for `import('@react-three/fiber')`;
- updated runtime code because the app is using a valid Node-compatible
  resolution/export shape that QuickJS mishandles.

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
  -e "import('@react-three/fiber').then(m=>console.log('fiber loaded', Object.keys(m).length))"
```

Observed result after the fix:

```text
quickjs-module normalize ... spec=@react-three/fiber -> .../node_modules/.pnpm/@react-three+fiber.../node_modules/@react-three/fiber/dist/react-three-fiber.esm.js
quickjs-module normalize ... spec=zustand -> .../node_modules/.pnpm/zustand@3.7.2_react@18.3.1/node_modules/zustand/esm/index.mjs
fiber loaded 31
```

Then rerun the server and request `/`:

```sh
cd ~/src/dev/stackmachine.com
PORT=4322 ~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
curl -i http://localhost:4322/
```

Expected result for this issue: the default export mismatch is explained or
fixed, or the failure is narrowed to a different concrete module/runtime
behavior and captured in a follow-up note.
