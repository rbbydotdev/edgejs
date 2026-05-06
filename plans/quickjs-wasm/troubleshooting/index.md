# Edge QuickJS troubleshooting index

This is the short index for QuickJS WASIX framework troubleshooting notes. Use
it to find issue-specific plans and findings before changing runtime code or
framework adapters.

## Astro SSR

For each new Astro SSR troubleshooting issue, create a plan under
[`astro-ssr/`](astro-ssr/) before changing code, then update the most recent
plan pointer in the repo root `AGENTS.md`.

### [plan-es-module-lexer-webassembly.md](astro-ssr/plan-es-module-lexer-webassembly.md): es-module-lexer WebAssembly import

Why: the Astro SSR native ESM entry resolved `es-module-lexer` to its default
WASM-backed build, which expects `globalThis.WebAssembly` and fails under the
QuickJS runtime.

What to investigate: QuickJS-only resolver compatibility for the bare
`es-module-lexer` specifier so it can resolve to the pure JS export already
known to work.

### [plan-depd-callsite-methods.md](astro-ssr/plan-depd-callsite-methods.md): depd CallSite method compatibility

Why: after moving past the `es-module-lexer` issue, Astro SSR reached `depd`,
which expects Node/V8-style structured stack CallSite methods.

What to investigate: whether QuickJS stack trace preparation should provide the
missing CallSite methods, or whether the Astro SSR path should continue using a
targeted `depd` compatibility stub.

### [plan-cjs-reexport-named-exports.md](astro-ssr/plan-cjs-reexport-named-exports.md): CommonJS re-export named exports

Why: React's public CommonJS entry delegates to another file, so QuickJS's
synthetic ESM facade did not declare named exports such as `createElement`
before module linking.

What to investigate: conservative recursive named-export discovery for literal
CommonJS re-export patterns, using the discovered names both for QuickJS export
declaration and evaluated export assignment.

## Vite App

For each new Vite app troubleshooting issue, create a plan under
[`vite-app/`](vite-app/) before changing code, then update the most recent plan
pointer in the repo root `AGENTS.md`.

### [findings_standalone-build.md](vite-app/findings_standalone-build.md): standalone build findings

Why: plain Vite SPA builds do not emit an Astro-style standalone HTTP server
entry, so the existing `server/router.cjs` adapter is real runtime plumbing.

What was found: `vite-plugin-standalone` may package an explicit server entry,
but a plain SPA still needs server semantics from an adapter, generated entry,
or different framework/runtime shape.

## Next App

For each new Next app troubleshooting issue, create a plan under
[`next-app/`](next-app/) before changing code, then update the most recent plan
pointer in the repo root `AGENTS.md`.

### [findings-standalone-v8-serdes.md](next-app/findings-standalone-v8-serdes.md): `require("v8")` / serdes findings

Why: the standard Next.js standalone server reaches `require("v8")`, and the
QuickJS `internalBinding("serdes")` currently returns an empty object.

What was found: `lib/v8.js` expects `Serializer` and `Deserializer`
constructors. A minimal QuickJS-backed serdes binding should let the public
`v8` builtin load cleanly before deeper standalone Next compatibility work.
