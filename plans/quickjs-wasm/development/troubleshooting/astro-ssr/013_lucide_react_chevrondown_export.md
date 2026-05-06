# Astro SSR: Lucide React ChevronDown Export

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed by precise package `"type": "module"` detection. |
| **Severity** | High | The Astro standalone server starts, but rendering `/` fails before a response can be produced. |

## Issue

After the WASIX pnpm symlink resolution fix, the `stackmachine.com` Astro
standalone server starts under Wasmer:

```sh
cd /Users/sadhbh/src/dev/stackmachine.com
wasmer run --net .
```

Observed route-rendering failure:

```text
[@astrojs/node] Server listening on http://localhost:4321
[ERROR] [router] Error while trying to render the route /
[ERROR] SyntaxError: Could not find export 'ChevronDown' in module
'/app/node_modules/.pnpm/lucide-react@0.462.0_react@18.3.1/node_'
```

## Diagnosis

The generated Astro route imports named icons from `lucide-react`, including
`ChevronDown`. The package exposes that name from its CommonJS entry:

```text
lucide-react/dist/cjs/lucide-react.js
exports.ChevronDown = ChevronDown;
```

Focused checks showed that the package itself can be required through
`createRequire(...)` and exposes thousands of named properties at runtime.

The failing path was:

```text
/app/node_modules/.pnpm/lucide-react@0.462.0_react@18.3.1/node_modules/lucide-react/dist/cjs/lucide-react.js
```

QuickJS incorrectly classified that `.js` file as ESM because
`FileLooksCommonJs(...)` used a substring check against the nearest
`package.json`: if the file contained both `"type"` and `"module"` anywhere, it
treated the package as ESM. `lucide-react/package.json` has
`"repository": { "type": "git" }` and a top-level `"module"` entry, but it does
not have top-level `"type": "module"`.

That made QuickJS compile the CommonJS bundle as ESM. The static linker then
could not see `exports.ChevronDown = ...`, so route linking failed before the
CommonJS runtime body could execute.

## Plan

- Reproduced the failure with a focused import of the generated layout chunk.
- Confirmed the resolver targets `lucide-react/dist/cjs/lucide-react.js`.
- Confirmed the CommonJS export scanner already handles
  `exports.ChevronDown = ...`; the bad behavior was earlier CJS/ESM
  classification.
- Moved package type detection to the shared parsed package metadata helper so
  only top-level `"type": "module"` affects `.js` classification.
- Kept the fix in the QuickJS runtime; no app, `node_modules`, or generated
  Astro output changes were needed.

## Validation

Focused checks:

```sh
cd /private/tmp/edge-wasmer-probe
wasmer run . -- -e "import('/app/dist/server/chunks/Layout_BoMatPJA.mjs').then(()=>console.log('layout ok'))"

cd /Users/sadhbh/src/dev/stackmachine.com
wasmer run --net .
```

Expected result: `lucide-react` named exports link successfully, and requesting
`/` advances past the `ChevronDown` missing export.

Observed after the fix:

```text
object
layout ok
200 text/html
```

Validation commands run:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
cd /Users/sadhbh/src/dev/edgejs/quickjs-wasm/ && ./build.sh
wasmer run . -- -e "import { ChevronDown } from '/app/node_modules/.pnpm/lucide-react@0.462.0_react@18.3.1/node_modules/lucide-react/dist/cjs/lucide-react.js'; console.log(typeof ChevronDown);"
wasmer run . -- -e "import('/app/dist/server/chunks/Layout_BoMatPJA.mjs').then(()=>console.log('layout ok'))"
wasmer run --net --env PORT=3311 --env HOST=127.0.0.1 .
```

The final app-level request to `http://127.0.0.1:3311/` returned `200
text/html`.
