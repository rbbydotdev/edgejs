# Edge QuickJS web app enablement for Astro, Vite, and Next.js

## Context

`001_merge_analysis.md` through `005_wasix_wasmer_http.md` cover the
provider integration, bootstrap debugging, REPL microtasks, WASIX atomics, and
the HTTP stream listener bug that prevented a simple echo server from handling
requests under Wasmer.

This note captures the next layer of work: using the published Edge QuickJS
Wasmer package to run real framework outputs:

- an Astro static site at `~/src/astro-app`;
- a Vite/React SPA at `~/src/vite-app`;
- a Next.js app at `~/src/next-app`.

The important distinction is that Edge QuickJS now runs the HTTP/static adapter
inside WASIX. Framework build systems still run outside the WASIX runtime during
the build step.

## Edge QuickJS package shape

The root package definition is:

```text
~/src/edgejs/wasmer.toml
```

Current package identity:

```toml
[package]
entrypoint = "edgejs-quickjs"
name = "sadhbh-c0d3/edgejs-quickjs"
description = "Edge.js with an embedded QuickJS N-API provider"
version = "0.0.1"
```

The command exports the built WASIX Edge binary as the `edge` command:

```toml
[[module]]
name = "edge"
source = "./build-quickjs-wasix/edgejs.wasm"

[[command]]
name = "edge"
module = "edge"
runner = "https://webc.org/runner/wasi"

[command.annotations.wasi]
atom = "edge"
```

The package also mounts SSL certificates:

```toml
[fs]
"/usr/local/ssl" = "./ssl-certs"
```

Applications consume it with:

```toml
[dependencies]
"sadhbh-c0d3/edgejs-quickjs" = "0.0.1"
```

or, where semver range is wanted:

```toml
[dependencies]
"sadhbh-c0d3/edgejs-quickjs" = "^0.0.1"
```

and point their command at:

```toml
module = "sadhbh-c0d3/edgejs-quickjs:edge"
runner = "https://webc.org/runner/wasi"
```

The app-specific `main-args` then name the JavaScript adapter file to execute.

## Runtime changes that made framework adapters possible

These are the Edge QuickJS fixes that matter for Astro, Vite, and Next.js.

### ContextifyScript must be a class

Node's `lib/internal/vm.js` constructs `ContextifyScript` with `new
ContextifyScript(...)`.

The original QuickJS path registered `ContextifyScript` with
`napi_create_function()`. That produced a callable function, but not a N-API
class shape compatible with Node's `new ContextifyScript(...)` path.

The fix was in:

```text
~/src/edgejs/src/edge_module_loader.cc
```

`ResolveContextifyBinding()` now defines `ContextifyScript` with
`napi_define_class(...)`.

This was necessary before `internal/vm`, CommonJS compilation, and user script
execution could work reliably.

### QuickJS promise hooks and microtasks

The REPL investigation showed that bytes reached the JS stream layer, but some
promise continuations did not run. The missing piece was QuickJS promise hook
integration plus proper microtask/job draining.

The fix is described in `004_promise_hooks_microtasks.md` and involved:

```text
~/src/edgejs/quickjs/quickjs.c
~/src/edgejs/napi/quickjs/src/unofficial_napi.cc
```

The relevant behavior:

- `unofficial_napi_set_promise_hooks(...)` stores Node's hook callbacks and
  registers a QuickJS runtime promise hook.
- `unofficial_napi_enqueue_microtask(...)` enqueues a real QuickJS job instead
  of relying on a fake callback path.
- `unofficial_napi_process_microtasks(...)` drains QuickJS pending jobs with
  `JS_ExecutePendingJob(...)`.
- The vendored QuickJS source emits before/after promise hook events around the
  internal promise reaction job.

This matters for web app adapters because framework code often relies on
Promise, async callbacks, stream scheduling, file reads, and server startup
continuations even when the final adapter looks like a simple static server.

### Atomics and SharedArrayBuffer under WASIX

Wasmer startup initially failed in `internal/per_context/primordials` because
QuickJS disabled atomics for every `__wasi__` target.

The fix is described in `005_wasix_wasmer_http.md` and lives in the QuickJS
submodule:

```text
~/src/edgejs/quickjs/quickjs.c
~/src/edgejs/quickjs/cutils.h
```

The important condition changed from excluding `__wasi__` unconditionally to
allowing atomics when the WASIX build defines wasm atomics:

```c
(!defined(__wasi__) || defined(__wasm_atomics__))
```

Without this, Node bootstrap can fail before any app adapter gets to run.

### HTTP stream listener attachment

The echo-server hang under Wasmer was caused by the HTTP parser listener being
attached to the wrapper address instead of the wrapper's `EdgeStreamBase`.

The fix is described in `005_wasix_wasmer_http.md` and touched:

```text
~/src/edgejs/src/edge_tcp_wrap.h
~/src/edgejs/src/edge_tcp_wrap.cc
~/src/edgejs/src/edge_pipe_wrap.h
~/src/edgejs/src/edge_pipe_wrap.cc
~/src/edgejs/src/edge_tty_wrap.h
~/src/edgejs/src/edge_tty_wrap.cc
~/src/edgejs/src/edge_stream_base.cc
```

The generic stream conversion now tries wrapper-specific unwrapping first:

- TCP;
- Pipe;
- TTY.

Those helpers validate the unwrapped native handle and return the exact
`EdgeStreamBase` used by libuv reads. Only after those checks does the generic
path fall back to raw external data.

This is the core networking fix that allowed:

```js
http.createServer(...)
```

to accept a connection, parse the request, call the JS request callback, and
write a response under Wasmer.

### Network tracing

The debug flag added during the HTTP work remains useful:

```sh
EDGE_TRACE_NET=1
```

It traces through native and JS layers:

```text
~/src/edgejs/src/edge_tcp_wrap.cc
~/src/edgejs/src/edge_stream_base.cc
~/src/edgejs/src/edge_stream_listener.cc
~/src/edgejs/src/edge_http_parser.cc
~/src/edgejs/lib/_http_server.js
~/src/edgejs/lib/internal/stream_base_commons.js
```

The useful success shape is:

```text
tcp bind/listen/accept/read_start ... OK
http_parser consume ... stream=<same EdgeStreamBase as uv_read>
http_parser consumed_read ... nread=<request bytes>
js http_server parserOnIncoming method= GET url= /
```

The old broken shape was `stream missing_onread` after bytes were read.

### QuickJS teardown is still not solved

The N-API QuickJS submodule currently has `JS_FreeRuntime(...)` commented out in
the env release path:

```text
~/src/edgejs/napi/quickjs/src/unofficial_napi.cc
```

The submodule commit is:

```text
a200c14 Disabling JS_FreeRuntime until gc leaks are solved
```

This prevents the known teardown assertion from aborting successful Wasmer app
runs:

```text
Assertion failed: list_empty(&rt->gc_obj_list)
```

This is intentionally not a real GC/leak fix. It is a current compatibility
workaround so the runtime can exit without aborting while the remaining QuickJS
object lifetime issues are investigated.

## Running static sites through Edge QuickJS

The common pattern for Astro and Vite is:

1. Build the framework output with its normal Node-based build tool.
2. Mount the generated static directory into WASIX.
3. Run a small CommonJS `http` + `fs` adapter under Edge QuickJS.
4. Pass `--net` to Wasmer when serving HTTP.

The adapter should be conservative:

- use CommonJS (`.cjs`) so Edge can execute it through the current CJS path;
- use Node builtins we know are working: `fs`, `path`, `http`, `url` where
  needed;
- avoid depending on the framework's dev server or native Node add-ons at
  runtime;
- normalize request paths and reject traversal;
- support `GET` and `HEAD` where possible;
- send explicit content types for JS, CSS, JSON, images, WASM, HTML, and RSC
  payloads.

## Astro: `~/src/astro-app`

Astro's build output can be served as static files. The adapter added there is:

```text
~/src/astro-app/server-edgejs.cjs
```

It is a minimal static server:

- root is `/app/dist`;
- port defaults to `process.env.PORT || 3000`;
- `/` maps to `index.html`;
- directories map to `index.html`;
- files are served with a small content type table;
- errors are logged and returned as `500`.

The working shape is:

```sh
cd ~/src/astro-app
npm run build
wasmer run \
  --net \
  --env PORT=3000 \
  --volume ./:/app \
  sadhbh-c0d3/edgejs-quickjs@0.0.1 \
  -- /app/server-edgejs.cjs
```

This uses the published Edge QuickJS package directly and mounts the project at
`/app`, so the adapter can read `/app/dist`.

This is static serving, not Astro SSR. It proves the Edge QuickJS WASIX package
can run a normal Node-style static HTTP server around Astro's generated output.

## Vite: `~/src/vite-app`

The Vite version was changed from a PHP/WinterJS package shape to an Edge
QuickJS package shape.

Important files:

```text
~/src/vite-app/wasmer.toml
~/src/vite-app/server/router.cjs
```

The package depends on the published runtime:

```toml
[dependencies]
"sadhbh-c0d3/edgejs-quickjs" = "^0.0.1"
```

The package mounts only app artifacts:

```toml
[fs]
"/dist" = "./dist"
"/server" = "./server"
```

The command executes the CJS router:

```toml
[[command]]
name = "run"
module = "sadhbh-c0d3/edgejs-quickjs:edge"
runner = "https://webc.org/runner/wasi"

[command.annotations.wasi]
main-args = ["/server/router.cjs"]
```

`server/router.cjs` is a Vite SPA static adapter:

- root is `/dist`;
- port defaults to `process.env.PORT || 8080`;
- supports `GET` and `HEAD`;
- rejects path traversal;
- serves existing files and directories;
- falls back to `/dist/index.html` for SPA routes;
- sends immutable cache headers for `/assets/`;
- has content types for `.html`, `.js`, `.mjs`, `.css`, `.json`, `.wasm`,
  common images, and `.xcf`.

The expected run flow is:

```sh
cd ~/src/vite-app
npm run build
wasmer run --net .
```

The Vite case mainly validated the published package consumption story:

- no local `~/src/edgejs/quickjs-wasm` path is needed;
- no `ssl-certs` package dependency is needed in the app;
- `wasmer.toml` should reference `sadhbh-c0d3/edgejs-quickjs@0.0.1` as a
  dependency and execute its `edge` atom.

## Next.js: `~/src/next-app`

Next.js needed a more specialized adapter than Astro/Vite because the app uses
App Router output, RSC payloads, static `_next` assets, public files, and a few
dynamic routes.

Important files:

```text
~/src/next-app/package.json
~/src/next-app/wasmer.toml
~/src/next-app/server/router.cjs
~/src/next-app/server/generate-next-dynamic-shells.cjs
~/src/next-app/server/build-edge-dist.cjs
```

### Package shape

The app package depends on Edge QuickJS:

```toml
[dependencies]
"sadhbh-c0d3/edgejs-quickjs" = "0.0.1"
```

The Wasmer package now mounts staged runtime files, not the full `.next`
directory:

```toml
[fs]
"/web" = ".dist/web"
"/public" = ".dist/public"
"/server" = ".dist/server"

[[command]]
name = "run"
module = "sadhbh-c0d3/edgejs-quickjs:edge"
runner = "https://webc.org/runner/wasi"

[command.annotations.wasi]
main-args = ["/server/router.cjs"]
```

The package scripts are:

```json
"edge:build": "next build && node server/generate-next-dynamic-shells.cjs && node server/build-edge-dist.cjs",
"edge:stage": "node server/build-edge-dist.cjs",
"edge:preview": "wasmer run --net ."
```

The correct build command is:

```sh
npm run edge:build
```

not:

```sh
npm run build edge:build
```

### Runtime router

`server/router.cjs` is the CJS adapter executed by Edge QuickJS.

It serves:

- `/_next/static/*` from `/web/static`;
- `/favicon.ico` from `/web/server/app/favicon.ico.body`;
- public files from `/public`;
- static App Router HTML/RSC files from `/web/server/app`;
- generated dynamic shells from `/server/generated`;
- `_not-found.html` as the 404 fallback.

It detects RSC requests with:

```js
req.headers.rsc === "1" || url.searchParams.has("_rsc")
```

and serves `text/x-component` for `.rsc` responses.

The dynamic routes currently handled are:

```text
/lobby/:id
/tables/:id?lobbyId=:lobbyId
```

Those routes use generated files with placeholders:

```text
/server/generated/lobby.html
/server/generated/lobby.rsc
/server/generated/table.html
/server/generated/table.rsc
```

At request time the router replaces:

```text
__EDGE_LOBBY_ID__
__EDGE_TABLE_ID__
```

with URL-safe route values.

`/local-rpc` is intentionally not implemented in the WASI static adapter and
returns `502`.

### Dynamic shell generation

`server/generate-next-dynamic-shells.cjs` runs after `next build` on the host
Node runtime, not inside Edge QuickJS.

It:

1. imports the emitted Next route module, for example
   `.next/server/app/(site)/lobby/[id]/page.js`;
2. starts a temporary localhost Node HTTP server;
3. calls the Next route module handler;
4. fetches both HTML and RSC variants;
5. writes placeholder-based generated shells into `server/generated`.

Routes currently generated:

```js
{
  modulePath: ".next/server/app/(site)/lobby/[id]/page.js",
  url: "/lobby/__EDGE_LOBBY_ID__",
  html: "lobby.html",
  rsc: "lobby.rsc",
}
{
  modulePath: ".next/server/app/tables/[id]/page.js",
  url: "/tables/__EDGE_TABLE_ID__?lobbyId=__EDGE_LOBBY_ID__",
  html: "table.html",
  rsc: "table.rsc",
}
```

The generator also installs `AsyncLocalStorage` on `globalThis` for the Next
route module:

```js
globalThis.AsyncLocalStorage = globalThis.AsyncLocalStorage || AsyncLocalStorage;
```

### Table route emission bug

The table dynamic shell was initially missing:

```text
Skipping /tables/__EDGE_TABLE_ID__?lobbyId=__EDGE_LOBBY_ID__:
.next/server/app/tables/[id]/page.js was not emitted by next build
```

and clicking Join opened:

```text
Next dynamic route shell is missing. Run `npm run edge:build`.
```

Root cause:

```text
~/src/next-app/app/tables/[id]/layout.js
```

had:

```js
export const runtime = 'edge';
```

Next emitted:

```json
{
  "/tables/[id]/page": "app-edge-has-no-entrypoint"
}
```

instead of `.next/server/app/tables/[id]/page.js`. The generator can only
render the Node server page module, so it skipped the table route.

Fix:

- remove the forced `runtime = 'edge'` from the table route layout;
- rebuild with `npm run edge:build`.

After that, Next reports:

```text
ƒ /tables/[id]
```

and emits:

```text
.next/server/app/tables/[id]/page.js
```

The lobby Join/Return URL was also changed to carry the current lobby:

```js
href={`/tables/${id}?lobbyId=${encodeURIComponent(lobbyId)}`}
```

so the generated table shell receives the right `searchParams.lobbyId`.

### `.dist` staging

Mounting the whole `.next` directory worked but was unnecessarily large:

```text
37M .next
```

The build now stages only the runtime files used by `server/router.cjs`:

```text
~/src/next-app/server/build-edge-dist.cjs
```

It copies:

- `.next/static` to `.dist/web/static`;
- selected `.next/server/app` files to `.dist/web/server/app`;
- `public` to `.dist/public`;
- `server/router.cjs` to `.dist/server/router.cjs`;
- `server/generated` to `.dist/server/generated`.

Only these Next app artifact extensions are kept:

```text
.body
.html
.rsc
```

The staging step excludes `.segments` directories because the current router
does not serve those paths.

Observed size after staging:

```text
37M  .next
8.6M .dist
6.9M .dist/web/static
256K .dist/web/server/app
1.3M .dist/public
68K  .dist/server
```

This is the directory Wasmer packages now mount.

### Next.js verification commands

Build:

```sh
cd ~/src/next-app
npm run edge:build
```

Package check:

```sh
wasmer package build --check .
```

Preview:

```sh
wasmer run --net --env PORT=3022 .
```

Useful probes:

```sh
curl -I http://127.0.0.1:3022/
curl -I http://127.0.0.1:3022/main-lobby
curl -i 'http://127.0.0.1:3022/tables/123?lobbyId=1'
curl -i -H 'rsc: 1' 'http://127.0.0.1:3022/lobby/1'
curl -i http://127.0.0.1:3022/_next/static/chunks/49dced3c3039a42d.css
```

The verified result was `200 OK` for the HTML, RSC, and CSS paths.

## What this does and does not prove

### Proven

- The published Edge QuickJS Wasmer package can run CommonJS HTTP server
  adapters.
- WASIX networking works for HTTP server workloads when run with `--net`.
- Static file serving with `fs.readFileSync`, `fs.statSync`, `path`, `Buffer`,
  content types, and headers works.
- Vite/React and Astro static outputs can be served directly.
- Next App Router static HTML/RSC output can be served by a custom adapter.
- Selected Next dynamic routes can be served by host-generated HTML/RSC shells
  plus placeholder replacement.

### Not proven

- Full Next.js server runtime execution inside Edge QuickJS WASIX.
- Next route handlers, middleware, API routes, streaming SSR, or per-request
  server component execution inside Edge QuickJS.
- Astro SSR inside Edge QuickJS.
- Vite dev server or HMR inside Edge QuickJS.
- Native Node add-ons inside the WASIX app package.
- The QuickJS runtime teardown leak/assertion fix.

For now the strategy is:

```text
framework build/SSR shell generation on host Node
small CJS HTTP adapter at runtime under Edge QuickJS WASIX
```

That is good enough for static and mostly-static sites, and it is a useful
pressure test for Edge QuickJS's Node compatibility surface.

## Practical app authoring rules

For a new static-ish app:

1. Build with the framework's normal command.
2. Add a small `.cjs` router using only stable Node builtins.
3. Mount generated artifacts explicitly in `wasmer.toml`.
4. Use `sadhbh-c0d3/edgejs-quickjs@0.0.1` as a dependency.
5. Run with `wasmer run --net .`.

For Next.js:

1. Avoid `export const runtime = 'edge'` on routes that the shell generator must
   import from `.next/server/app/.../page.js`.
2. Keep `server/generate-next-dynamic-shells.cjs` route list in sync with every
   dynamic route the adapter should serve.
3. Keep `server/router.cjs` route matching and placeholder replacement in sync
   with generated shells.
4. Run `npm run edge:build`, not plain `npm run build`, before `wasmer run`.
5. Package `.dist`, not the full `.next`, unless the router starts needing more
   Next internals.

## Remaining work

1. Fix QuickJS teardown properly so `JS_FreeRuntime(...)` can be restored.
2. Revisit QuickJS N-API object type reporting so constructed class instances do
   not look like plain `napi_external` values.
3. Decide whether `EDGE_TRACE_NET` and `EDGE_TRACE_TTY` should stay in-tree as
   supported diagnostics or be reduced before merging.
4. Add a tiny framework smoke-test matrix for:
   - `echo-server.js`;
   - Astro static;
   - Vite static SPA fallback;
   - Next static route;
   - Next generated dynamic HTML route;
   - Next generated dynamic RSC route.
5. Consider a reusable adapter template package once the static-server pattern
   repeats one more time.
6. For real SSR, investigate whether framework server bundles can be made
   QuickJS-compatible, or whether build-time shell generation remains the
   intended model for this runtime.
