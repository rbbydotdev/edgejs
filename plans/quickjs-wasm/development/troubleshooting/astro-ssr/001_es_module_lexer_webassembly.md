# Astro SSR: es-module-lexer WebAssembly Import

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned runtime compatibility investigation. |
| **Severity** | High | The Astro SSR entry cannot start if the WebAssembly-dependent lexer path is selected. |

## Issue

Running the Astro SSR native ESM entry directly with the QuickJS Edge CLI fails:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Observed error:

```text
ReferenceError: WebAssembly is not defined
    at <anonymous> (.../node_modules/es-module-lexer/dist/lexer.js:2:356)
```

Node can run the same entry:

```sh
node ./dist/server/entry.mjs
```

## Diagnosis

Astro's server output imports `es-module-lexer`.

QuickJS currently resolves the bare package import to:

```text
node_modules/es-module-lexer/dist/lexer.js
```

That is the package's default ESM/WASM build. It expects
`globalThis.WebAssembly`, which the QuickJS runtime does not currently expose.

The existing bundled CJS path already avoids this by aliasing:

```js
'es-module-lexer': 'es-module-lexer/js'
```

The `es-module-lexer/js` export resolves to the pure JS build and has already
been verified to import successfully under the QuickJS Edge CLI.

## Status Notes

Implement a QuickJS-only resolver compatibility alias in:

```text
napi/quickjs/src/unofficial_napi.cc
```

When resolving the bare specifier:

```text
es-module-lexer
```

resolve it as:

```text
es-module-lexer/js
```

This should route through the package `exports["./js"]` target and load:

```text
node_modules/es-module-lexer/dist/lexer.asm.js
```

## Constraints

- Only modify files under `napi/quickjs/`.
- Do not modify the Astro app, `node_modules`, or non-QuickJS Edge runtime code.
- Do not implement a fake `WebAssembly` global for this issue.
- Keep the alias narrow and package-specific.

## Validation

Rebuild:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Smoke test resolver behavior:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('es-module-lexer').then(m=>console.log(typeof m.parse))"
```

Expected output:

```text
function
```

Then rerun the Astro SSR entry:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

If a new failure appears, capture it as the next issue-specific plan in this
directory before making further changes.
