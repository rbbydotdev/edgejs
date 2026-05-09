# Astro SSR: depd CallSite Method Compatibility

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in the vendored QuickJS CallSite and stack trace implementation. |
| **Severity** | High | Astro SSR stopped during startup when depd could not use Node-style CallSite methods. |

## Issue

After aliasing `es-module-lexer` to its pure-JS export, the Astro SSR native ESM
entry advances to a new failure under the QuickJS Edge CLI:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "import('./dist/server/entry.mjs')"
```

Observed error:

```text
TypeError: not a function
    at callSiteLocation (<input>:270:23)
    at depd (<input>:111:31)
```

The failure was first reproduced from:

```text
~/src/dev/christoph/astro-app
```

It was later reproduced from:

```text
~/src/dev/stackmachine.com
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

The QuickJS-backed runtime had two compatibility gaps:

- Node bootstrap replaces `Error.prepareStackTrace` with a writable data
  property, but QuickJS stack construction still read only its hidden
  `ctx->error_prepare_stack` slot. Userland assignments such as `depd`'s
  temporary `Error.prepareStackTrace = prepareObjectStackTrace` were ignored,
  so `Error.captureStackTrace(obj)` produced a string instead of `CallSite[]`.
- The native QuickJS `CallSite` prototype exposed only a small method subset.
  `depd` also expects methods such as `isEval()`, `getEvalOrigin()`,
  `getThis()`, `getTypeName()`, and `getMethodName()`.

This is separate from the earlier `es-module-lexer` WebAssembly issue, which no
longer appears after the resolver alias.

The existing bundled CJS Astro path has already avoided this dependency behavior
by using `edge-depd-stub.cjs`, but the native ESM SSR entry currently imports
the real `depd` package.

## Current Status

Updated `quickjs/quickjs.c` so `build_backtrace(...)` reads the public
`Error.prepareStackTrace` property at stack-build time, falling back to the
hidden QuickJS slot only when the public property is not callable.

Also extended the native QuickJS `CallSite` prototype with conservative
Node/V8-compatible methods:

```text
isEval
isConstructor
isToplevel
isAsync
isPromiseAll
getMethodName
getTypeName
getThis
getEvalOrigin
getScriptNameOrSourceURL
getPromiseIndex
toString
```

Where QuickJS does not currently track the exact V8 metadata, these methods
return stable conservative values (`false`, `null`, or `undefined`) instead of
throwing.

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

Focused `depd` check:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "try { require('depd')('x'); console.log('depd ok') } catch(e) { console.error(e && (e.stack || e.message || e)); process.exitCode=1 }"
```

Observed result after the fix:

```text
depd ok
```

Rerun the focused import:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  ./dist/server/entry.mjs
```

Observed result after the fix:

```text
ReferenceError: Intl is not defined
    at ~/src/dev/stackmachine.com/dist/server/chunks/_@astrojs-ssr-adapter_BqW-NUXY.mjs:734:28
```

This is a later, different Astro SSR failure captured in
`004_missing_intl.md`.
