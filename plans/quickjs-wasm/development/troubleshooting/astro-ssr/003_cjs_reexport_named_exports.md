# Astro SSR: CommonJS Re-Export Named Exports

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed by recursive CommonJS named-export discovery and shared QuickJS module resolution helpers. |
| **Severity** | High | React named exports failed to link without this compatibility behavior. |

## Issue

The Astro standalone SSR entry for `stackmachine.com` starts under native Node
and native V8 EdgeJS, but fails under native QuickJS EdgeJS:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Focused reproduction:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('./dist/server/entry.mjs').catch(e=>{ console.error(e && e.message); process.exitCode=1; })"
```

Observed error:

```text
Could not find export 'createElement' in module
'~/src/dev/stackmachine.com/node_modules/react/index'
```

## Diagnosis

The failing Astro renderer imports React as:

```js
import React__default, { createElement } from 'react';
```

Node and the V8-backed Edge runtime expose CommonJS named exports on the ESM
namespace for `react`. QuickJS EdgeJS creates a synthetic CommonJS module facade
because QuickJS links ESM imports before a CommonJS file can execute and produce
`module.exports`.

The original QuickJS facade statically scanned only the immediate wrapper file.
React's public `index.js` delegates to another CommonJS file:

```js
module.exports = require('./cjs/react.development.js');
```

The real `exports.createElement = ...` assignment is in the delegated file, so
QuickJS declares only `default` and `module.exports` before module linking.
LLDB confirmed the failure is thrown before `QuickjsCommonJsModuleInit(...)`
runs, so this must be fixed in export-name declaration rather than later
evaluation.

## Why this compatibility layer exists

This is not because V8 has CommonJS and QuickJS does not. V8, like QuickJS, is a
JavaScript engine; Node implements CommonJS, ESM loading, and the CJS/ESM bridge
around the engine.

The difference is that Node's V8 path already has mature native `ModuleWrap`,
loader, and translator integration. The QuickJS N-API backend is implementing
that V8-shaped `unofficial_napi` surface over QuickJS. QuickJS asks the host C
module loader to normalize and load imports during `JS_ResolveModule`, and it
requires declared ESM export names before link time. CommonJS modules only know
their true export object after evaluation.

The facade/export-name logic is therefore a bridge for Node compatibility:

- resolve package and file specifiers in the QuickJS host module loader;
- decide whether a `.js` file should be compiled as ESM or evaluated through the
  CommonJS loader;
- predeclare conservative named exports for CommonJS facades so ESM imports can
  link;
- after `require(...)` evaluates the CommonJS file, copy the actual properties
  onto the declared QuickJS module exports.

This behavior is needed until QuickJS `ModuleWrap` can delegate more of the
flow back to Node's JS loaders/translators. The behavior is valid runtime
plumbing; the older ad hoc JSON/package parsing and broad CJS heuristics are
the pieces that should be treated as technical debt.

## Current Status

CommonJS named export discovery was moved out of `unofficial_napi.cc` into
`napi/quickjs/src/quickjs_cjs_exports.cc`. The scanner preserves the direct
export patterns and adds recursive literal re-export discovery for patterns such
as:

```js
module.exports = require('./target.js')
Object.assign(exports, require('./target.js'))
```

Use the resulting names both when declaring QuickJS C module exports and when
setting those exports after `require(...)` evaluates.

Related follow-up fixes moved path/package resolution into shared helpers in
`napi/quickjs/src/unofficial_module_loader.cc` and tightened `.js` CJS/ESM
classification so package metadata is parsed instead of matched with broad
string heuristics.

## Constraints

- Keep the fix in the QuickJS-backed N-API/runtime path.
- Do not modify the Astro app, `node_modules`, or generated `dist` files.
- Keep the scanner conservative; do not execute CommonJS while computing link
  names.
- Preserve `default` and `module.exports` behavior.

## Validation

Rebuild:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Check the focused namespace behavior:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('react').then(m=>console.log(Object.prototype.hasOwnProperty.call(m,'createElement')))"
```

Then rerun the Astro SSR entry:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Observed current state:

- `react` named exports such as `createElement` link successfully.
- Later Astro SSR failures were captured in subsequent issue-specific notes
  (`004` through `014`) rather than folded into this issue.
- The full Astro standalone path has since reached a Wasmer-served `200
  text/html` response after the later resolver, symlink, stack, and deploy
  packaging fixes.

Remaining design cleanup: reduce the QuickJS host-loader facades as
`ModuleWrap` support becomes closer to Node/V8, or keep the behavior but ensure
all resolver and package metadata handling lives in the shared QuickJS module
loader rather than local ad hoc parsers.
