# Astro SSR: depd CallSite Method Compatibility

Status: planned runtime compatibility investigation.

## Issue

After aliasing `es-module-lexer` to its pure-JS export, the Astro SSR native ESM
entry advances to a new failure under the QuickJS Edge CLI:

```sh
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('./dist/server/entry.mjs')"
```

Observed error:

```text
TypeError: not a function
    at callSiteLocation (<input>:270:23)
    at depd (<input>:111:31)
```

The failure was reproduced from:

```text
/Users/sadhbh/src/dev/christoph/astro-app
```

## Diagnosis

The failing dependency is `depd`.

Its `callSiteLocation(...)` helper expects V8/Node-style structured stack frame
objects with methods such as:

```js
callSite.getFileName()
callSite.getLineNumber()
callSite.getColumnNumber()
callSite.isEval()
callSite.getEvalOrigin()
callSite.getFunctionName()
```

The QuickJS-backed runtime appears to provide enough stack information for the
dependency to enter this path, but at least one expected CallSite method is not
callable. This is separate from the earlier `es-module-lexer` WebAssembly issue,
which no longer appears after the resolver alias.

The existing bundled CJS Astro path has already avoided this dependency behavior
by using `edge-depd-stub.cjs`, but the native ESM SSR entry currently imports
the real `depd` package.

## Plan

Investigate QuickJS stack trace preparation and CallSite compatibility before
changing code.

Likely options:

- provide missing Node/V8-compatible CallSite methods in the QuickJS error stack
  implementation if the runtime already models structured frames;
- or add a narrow QuickJS resolver compatibility alias/stub for `depd` if the
  dependency is only used for deprecation warnings in this SSR path.

Prefer a runtime-compatible CallSite fix if it is small and matches existing
QuickJS stack-frame data. Prefer a package-specific stub only if CallSite
emulation would be large, fragile, or misleading for embedders.

## Constraints

- Do not modify the Astro app, `node_modules`, or generated `dist` files.
- Keep any resolver compatibility aliases narrow and package-specific.
- Compare with the V8 backend or existing bundled adapter behavior before
  implementing.
- Fix one behavior at a time and rerun the targeted Astro SSR import before
  moving to any next failure.

## Validation

Rebuild:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Rerun the focused import:

```sh
cd /Users/sadhbh/src/dev/christoph/astro-app
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('./dist/server/entry.mjs').then(()=>console.log('loaded')).catch(e=>{ console.error(e && (e.stack || e.message || e)); process.exitCode = 1; })"
```

Expected result for this issue:

```text
loaded
```

or a later, different Astro SSR failure that should be captured in a new
issue-specific plan before further code changes.
