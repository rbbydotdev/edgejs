# Edge QuickJS framework standalone builds

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Historical standalone build findings. |
| **Severity** | Low | Current standalone issues are tracked under app-specific troubleshooting pages. |

## Current Status Note

This note records the earlier standalone-build investigation. Any CJS execution
paths described here should be read as historical: the QuickJS C++
CommonJS facade/module-loader hack has now been removed, and the backend must
live without CJS support until module loading is handled through Node's
JavaScript loaders/translators or another proper EdgeJS-owned runtime path.

## Context

`006_framework_app_adapters.md` captured the first working framework-app path for Edge QuickJS:
small app-owned adapters for Astro, Vite, and Next.js outputs.

The next goal was to remove as much app-specific server/router glue as possible
and prefer framework-standard standalone build outputs:

- Astro standalone Node adapter output;
- Vite SSR standalone packaging via `vite-plugin-standalone`;
- Next.js official `output: "standalone"` build.

The anonymized app paths used in notes are:

```text
~/src/astro-app
~/src/vite-app
~/src/next-app
```

## Astro standalone

Astro already has the cleanest standalone story. It can emit a server build
with the Node adapter in standalone mode:

```js
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
});
```

That build produces a server entry under:

```text
dist/server/entry.mjs
```

For Edge QuickJS compatibility, the local follow-up was to bundle that emitted
server entry into a CJS artifact that the current Edge CLI can execute:

```text
dist/server/entry.cjs
```

The `.mjs` entry is still not the working EdgeJS execution path; Astro
standalone currently works through the bundled CJS artifact.

The important point is that Astro owns the server semantics. The app does not
need to keep a bespoke HTTP router once the build emits the standalone server
entry.

One observed Astro app caveat was `astro-blog`, which failed because the
standalone dependency graph pulled in `sharp`. That failure appears tied to
`sharp`'s native / WebAssembly dependency shape rather than Astro standalone
itself.

## Vite standalone

Plain Vite SPA builds do not emit an HTTP server entry. A normal Vite build
only produces static client files under:

```text
dist/
```

So the earlier `vite-app` path used an app-owned static router to serve files,
handle `GET` / `HEAD`, prevent path traversal, set content types, and fall back
to `index.html` for client-side routes.

The standalone experiment found that `vite-plugin-standalone` is a useful fit
when the app provides a server entry for the plugin to package. The plugin uses
the SSR build path, esbuild, and `@vercel/nft` to produce a self-contained
server artifact.

The resulting `vite-app` direction is:

- use `vite-plugin-standalone`;
- keep the minimal server semantics as a build-owned entry;
- drop the old manually staged `server/router.cjs` / `server/router.php` style;
- execute the standalone output from the Wasmer package.

This is not the same as Astro, because Vite still does not invent HTTP server
semantics for a plain SPA. But it does let the project keep the standalone
version as the maintained path, with dependency tracing and packaging handled
by the Vite plugin instead of custom Edge staging scripts.

More detail is captured in:

```text
plans/quickjs-wasm/development/troubleshooting/vite-app/001_standalone_build.md
```

### Native CLI static-root caveat

The Vite standalone entry tested in the app used:

```js
var root = process.env.STATIC_ROOT || "/dist";
```

That default works under:

```sh
wasmer run --net .
```

because `/dist` is resolved inside the WASIX / Wasmer package filesystem, where
the packaged app assets are available.

It does not work the same way when running the host native QuickJS CLI directly:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/standalone-entry.js
```

In that mode, `/dist` means the host machine's absolute `/dist`, not the app's
local `dist/` directory. The server can start, but the first HTTP request falls
through to `fs.readFileSync("/dist/index.html")`, which fails in
`fs.openSync(...)` because the host path does not exist.

Two useful native-CLI fixes are:

```sh
STATIC_ROOT="$PWD/dist" ~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/standalone-entry.js
```

or make the entry default relative to the emitted server file:

```js
var root = process.env.STATIC_ROOT || path.resolve(__dirname, "..");
```

Since the entry is emitted under `dist/server/`, that resolves to the app's
`dist/` directory for native CLI runs and should still resolve to `/dist` in
the Wasmer package shape.

The accompanying `DEP0176` warning about `fs.F_OK` is separate from the failed
read. It is triggered by the fs shim's deprecated `fs.F_OK` getter path, likely
via `fs.existsSync(...)`.

## Next.js standalone

Next.js also has an official standalone build mode:

```ts
const nextConfig = {
  output: "standalone",
};
```

The app-level target is:

```text
.next/standalone/server.js
```

The old custom `server/` directory is not part of the intended path. The
standalone output works under stock Node:

```sh
node ./app/server.js
```

When copied into a test folder, the Edge QuickJS repro shape was:

```sh
cp -rf ./.next/standalone ./.testing/app/
cd ./.testing
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./app/server.js
```

That failed before the server could start.

### Native CLI main-entry caveat

Unlike the Vite standalone static server, the Next standalone server does not
use `STATIC_ROOT` as its primary asset root. Its generated entry starts with:

```js
const dir = path.join(__dirname)

process.env.NODE_ENV = 'production'
process.chdir(__dirname)
```

and then loads Next:

```js
require('next')
const { startServer } = require('next/dist/server/lib/start-server')
```

So this command is not fixed by pointing `STATIC_ROOT` at `.testing`:

```sh
STATIC_ROOT="$PWD/.testing" ~/src/dev/edgejs/build-edge-quickjs-cli/edge .next/standalone/server.js
```

The observed native QuickJS CLI failure was:

```text
Failed to execute builtin 'internal/main/run_main_module':
undefined    at normalizeRequirableId (<input>:302:35)
    at defaultResolveImpl (<input>:1061:36)
    at resolveForCJSWithHooks (<input>:1066:41)
    at wrapModuleLoad (<input>:247:34)
```

This is an earlier main-module / CJS resolution failure. A minimal native CLI
repro showed that direct script execution was not reliably placing the script
path in `process.argv[1]`; then `internal/main/run_main_module` reaches:

```js
require('internal/modules/cjs/loader').Module.runMain(mainEntry);
```

with `mainEntry` undefined. That eventually calls the CJS resolver with an
undefined request and fails in `BuiltinModule.normalizeRequirableId(...)`.

This should be tracked separately from static asset root handling. The runtime
fix is likely in the native QuickJS CLI argument / main-entry bootstrap path,
before continuing to the already-known Next blockers such as QuickJS `serdes`
support for `require("v8")`.

## Next.js runtime findings

The Next standalone output is valid, but it exposed two separate Edge runtime
gaps.

### Edge V8 inspector limitation

Edge V8 fails on the same standalone server because Next's startup path
eventually requires:

```js
require("inspector");
```

The runtime reports:

```text
Error: Inspector is not available
```

This is not a QuickJS branch regression. Comparing `main` with
`napi/quickjs-integration-int` showed the relevant inspector files are
unchanged:

```text
src/internal_binding/binding_config.cc
lib/inspector.js
src/builtin_catalog.cc
```

Both `main` and the QuickJS integration branch currently set:

```cpp
const bool has_inspector = false;
```

in `internalBinding("config")`, so `lib/inspector.js` throws as soon as it is
required.

The concrete native V8 standalone repro was:

```sh
~/src/dev/edgejs/build-edge/edge .next/standalone/server.js
```

with:

```text
Failed to execute builtin 'internal/main/run_main_module':
node:inspector:25
  throw new ERR_INSPECTOR_NOT_AVAILABLE();
  ^

Error: Inspector is not available
  code: 'ERR_INSPECTOR_NOT_AVAILABLE'
```

### Edge WASIX builtin failure formatting

The WASIX package path fails with a less specific wrapped builtin error:

```sh
wasmer run --net .
```

reported:

```text
undefined[Error: Failed to execute builtin 'internal/main/run_main_module':     at anonymous (<input>:331:1)
    at compileForInternalLoader (<input>:400:10)
    at compileForPublicLoader (<input>:339:10)
    at loadBuiltinModule (<input>:127:7)
    at loadBuiltinWithHooks (<input>:1197:33)
    at <anonymous> (<input>:1287:69)
    at traceSync (<input>:330:27)
    at wrapModuleLoad (<input>:247:34)
    at <anonymous> (<input>:1550:27)
]
```

This appears to be the WASIX runtime surfacing only the wrapped builtin failure
instead of the more specific underlying module/runtime error.

### Edge QuickJS `v8` / `serdes` blocker

Edge QuickJS fails earlier. The standalone failure reduces to:

```js
require("v8");
```

LLDB showed the original exception before Edge wrapped it:

```text
TypeError: cannot read property 'prototype' of undefined
```

The failing source is in `lib/v8.js`:

```js
Serializer.prototype._getDataCloneError = Error;
```

The V8 backend exports real `Serializer` and `Deserializer` constructors from
`internalBinding("serdes")`. The QuickJS backend currently returns an empty
object in:

```text
napi/quickjs/src/unofficial_napi.cc
```

So `require("v8")` fails because
`internalBinding("serdes").Serializer` is undefined.

The immediate QuickJS runtime fix is to implement a minimal serdes binding that
exports stable `Serializer` and `Deserializer` constructors. Full
`v8.serialize()` / `v8.deserialize()` behavior can use the existing QuickJS
structured clone helpers based on `JS_WriteObject(...)` and
`JS_ReadObject(...)`.

More detail is captured in:

```text
plans/quickjs-wasm/development/troubleshooting/next-app/001_standalone_v8_serdes.md
```

## Builtin error formatting

While debugging the Next standalone failure, native builtin execution failures
in:

```text
src/edge_module_loader.cc
```

were found to have regressed from Node-like formatting. The QuickJS debugging
path had changed builtin failures to clear the pending JS exception and throw a
new wrapper error:

```text
Failed to execute builtin 'internal/main/run_main_module': <original error>
```

That exposed hidden QuickJS builtin failures, but it made Edge V8 less
Node-like. The original Edge V8 output preserved Node's source frame and error
object formatting:

```text
node:inspector:25
  throw new ERR_INSPECTOR_NOT_AVAILABLE();
  ^

Error: Inspector is not available
```

The current fix preserves the pending JS exception for builtin call failures
and only prints one extra context line:

```text
Failed to execute builtin 'internal/main/run_main_module':
node:inspector:25
  throw new ERR_INSPECTOR_NOT_AVAILABLE();
  ^

Error: Inspector is not available
```

The rule is:

- add diagnostic context;
- do not clear and replace the original JS exception;
- let the normal fatal-exception path format the original error.

Synthetic `Failed to execute builtin ...` errors are still appropriate for
setup or compile failures where there is no pending JS exception to preserve.

## Verification

Both V8 and QuickJS binaries were rebuilt after the formatting change:

```sh
cmake --build build-edge --target edge -j4
cmake --build build-edge-quickjs-cli --target edge -j4
```

The V8 inspector repro now preserves original formatting with the added context:

```sh
build-edge/edge -e "require('inspector')"
```

The Next standalone repro under Edge V8 does the same:

```sh
build-edge/edge ./app/server.js
```

The QuickJS standalone repro still fails on the known `v8` / `serdes` path, but
the builtin failure path no longer replaces the original pending exception.

## Current standalone status

- Astro has a framework-owned standalone server output and works with EdgeJS
  when the emitted `.mjs` server is bundled to CJS. The `.mjs` entry itself is
  not the working path yet. The native QuickJS runtime now includes a minimal
  `Intl.DateTimeFormat` fallback for framework bootstrap code that only needs
  simple time formatting, such as Astro's SSR logger. This is deliberately not
  a full ECMA-402 Intl implementation. Astro apps that pull in `sharp` can still
  fail on the `sharp` native / WebAssembly dependency shape.
- Vite can keep a standalone build path with `vite-plugin-standalone`, provided
  the project supplies the server semantics the plugin packages. This path is
  believed to work for the tested Vite app shape.
- Next.js emits the correct official standalone output, but its EdgeJS status
  depends on which Edge runtime is used:
  - WASIX currently reports only a wrapped
    `Failed to execute builtin 'internal/main/run_main_module'` error from
    `wasmer run --net .`.
  - native V8 reaches the known inspector limitation because `require("inspector")`
    throws `ERR_INSPECTOR_NOT_AVAILABLE`.
  - native QuickJS has the native CLI main-entry issue above, then still needs
    QuickJS `serdes` support for `require("v8")`.

## Follow-up

The next runtime tasks for full Next standalone under Edge QuickJS are to fix
the native CLI main-entry bootstrap path and then implement the QuickJS `serdes`
surface needed by `require("v8")`.
