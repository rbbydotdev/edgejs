# Astro SSR: CommonJS Re-Export Named Exports

Status: planned CommonJS/ESM facade compatibility fix.

## Issue

The Astro standalone SSR entry for `stackmachine.com` starts under native Node
and native V8 EdgeJS, but fails under native QuickJS EdgeJS:

```sh
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Focused reproduction:

```sh
cd /Users/sadhbh/src/dev/stackmachine.com
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('./dist/server/entry.mjs').catch(e=>{ console.error(e && e.message); process.exitCode=1; })"
```

Observed error:

```text
Could not find export 'createElement' in module
'/Users/sadhbh/src/dev/stackmachine.com/node_modules/react/index'
```

## Diagnosis

The failing Astro renderer imports React as:

```js
import React__default, { createElement } from 'react';
```

Node and the V8-backed Edge runtime expose CommonJS named exports on the ESM
namespace for `react`. QuickJS EdgeJS currently creates a synthetic CommonJS
module facade by statically scanning only the immediate wrapper file. React's
public `index.js` delegates to another CommonJS file:

```js
module.exports = require('./cjs/react.development.js');
```

The real `exports.createElement = ...` assignment is in the delegated file, so
QuickJS declares only `default` and `module.exports` before module linking.
LLDB confirmed the failure is thrown before `QuickjsCommonJsModuleInit(...)`
runs, so this must be fixed in export-name declaration rather than later
evaluation.

## Plan

Move CommonJS named export discovery out of `unofficial_napi.cc` into a small
QuickJS source/helper file. Preserve the existing direct export patterns and add
recursive literal re-export discovery for patterns such as:

```js
module.exports = require('./target.js')
Object.assign(exports, require('./target.js'))
```

Use the resulting names both when declaring QuickJS C module exports and when
setting those exports after `require(...)` evaluates.

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
cd /Users/sadhbh/src/dev/stackmachine.com
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('react').then(m=>console.log(Object.prototype.hasOwnProperty.call(m,'createElement')))"
```

Then rerun the Astro SSR entry:

```sh
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Expected result for this issue: `createElement` links successfully. Any later
Astro SSR failure should be captured in a new issue-specific plan before
further code changes.
