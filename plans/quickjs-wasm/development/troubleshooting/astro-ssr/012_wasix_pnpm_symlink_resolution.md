# Astro SSR: WASIX pnpm Symlink Resolution

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed by shared QuickJS module path resolution and fs stat symlink fallback. |
| **Severity** | High | The Astro standalone server cannot start in Wasmer when `react` cannot resolve from `/app/node_modules`. |

## Issue

Running the `stackmachine.com` Astro standalone server through the Wasmer
package fails before the server starts:

```sh
cd ~/src/dev/stackmachine.com
wasmer run --net .
```

Observed failure:

```text
ReferenceError: could not load module 'react'
```

The failing import is in the generated Astro renderer:

```js
import React__default, { createElement } from 'react';
```

## Diagnosis

Native QuickJS can import `react` from the app:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('react').then(m=>console.log(Object.keys(m).length))"
```

The same app mounted at `/app` under Wasmer can see the pnpm symlink through
the JavaScript `fs` API:

```text
/app/node_modules/react lstat true false false
link .pnpm/react@18.3.1/node_modules/react
/app/node_modules/react/package.json lstat false false true
```

But the QuickJS C++ module normalizer misses the bare package:

```text
quickjs-module normalize base=file:///app/dist/server/entry.mjs spec=./renderers.mjs -> /app/dist/server/renderers.mjs
quickjs-module normalize-miss base=/app/dist/server/renderers.mjs spec=react
```

This points at the C++ resolver's `std::filesystem` checks across pnpm symlink
path components inside a Wasmer-mounted directory. The runtime should resolve
symlink components before checking candidate package files, so
`/app/node_modules/react/index.js` is tested through its real pnpm store path.

## Status Notes

- Keep the fix in the QuickJS runtime module resolver.
- Add a small path helper that follows symlink components lexically before
  `TryResolveAsFile(...)` checks candidates.
- Preserve native behavior and the existing package `exports` condition order.
- Do not modify the Astro app, `node_modules`, or generated `dist` files.

## Validation

Focused Wasmer checks:

```sh
cd /private/tmp/edge-wasmer-probe
wasmer run . -- -e "import('/app/dist/server/renderers.mjs').then(()=>console.log('renderers ok'))"
wasmer run --net . -- /app/dist/server/entry.mjs
```

Observed after the fix:

```text
renderers ok
/app/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js
[@astrojs/node] Server listening on http://127.0.0.1:3311
```

The targeted CJS peer dependency probe now resolves `react` from the real pnpm
package path when the parent module is under `react-dom`, and the generated
`dist/server/renderers.mjs` import succeeds under Wasmer. The standalone server
advances past this issue and reaches the next route-rendering failure captured
in `013_lucide_react_chevrondown_export.md`.
