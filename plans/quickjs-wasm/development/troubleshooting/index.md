# Edge QuickJS framework troubleshooting

This registry lives under the QuickJS WASIX development notes so framework
compatibility work stays attached to the development timeline. Use it to find
existing plans and findings before changing QuickJS runtime code or framework
adapters.

## Workflow

For every new Astro SSR, Vite app, or Next app troubleshooting issue:

- write an issue-specific plan in the matching subdirectory before changing
  code;
- name issue files with a numeric prefix, for example
  `001_<issue_name>.md`;
- keep the plan focused on one observed failure or behavior;
- update the most recent plan pointer in the repo root `AGENTS.md`;
- rerun the targeted reproduction before broadening the fix.

## Astro SSR

For each new Astro SSR troubleshooting issue, create a plan under
[`astro-ssr/`](astro-ssr/) before changing code.

### [001_es_module_lexer_webassembly.md](astro-ssr/001_es_module_lexer_webassembly.md): es-module-lexer WebAssembly import

Why: the Astro SSR native ESM entry resolved `es-module-lexer` to its default
WASM-backed build, which expects `globalThis.WebAssembly` and fails under the
QuickJS runtime.

What to investigate: QuickJS-only resolver compatibility for the bare
`es-module-lexer` specifier so it can resolve to the pure JS export already
known to work.

### [002_depd_callsite_methods.md](astro-ssr/002_depd_callsite_methods.md): depd CallSite method compatibility

Why: after moving past the `es-module-lexer` issue, Astro SSR reached `depd`,
which expects Node/V8-style structured stack CallSite methods.

What to investigate: whether QuickJS stack trace preparation should provide the
missing CallSite methods, or whether the Astro SSR path should continue using a
targeted `depd` compatibility stub.

### [003_cjs_reexport_named_exports.md](astro-ssr/003_cjs_reexport_named_exports.md): CommonJS re-export named exports

Why: React's public CommonJS entry delegates to another file, so QuickJS's
synthetic ESM facade did not declare named exports such as `createElement`
before module linking.

What to investigate: conservative recursive named-export discovery for literal
CommonJS re-export patterns, using the discovered names both for QuickJS export
declaration and evaluated export assignment.

## Vite App

For each new Vite app troubleshooting issue, create a plan under
[`vite-app/`](vite-app/) before changing code.

### [001_standalone_build.md](vite-app/001_standalone_build.md): standalone build findings

Why: plain Vite SPA builds do not emit an Astro-style standalone HTTP server
entry, so the existing `server/router.cjs` adapter is real runtime plumbing.

What was found: `vite-plugin-standalone` may package an explicit server entry,
but a plain SPA still needs server semantics from an adapter, generated entry,
or different framework/runtime shape.

## Next App

For each new Next app troubleshooting issue, create a plan under
[`next-app/`](next-app/) before changing code.

### [001_standalone_v8_serdes.md](next-app/001_standalone_v8_serdes.md): `require("v8")` / serdes findings

Why: the standard Next.js standalone server reaches `require("v8")`, and the
QuickJS `internalBinding("serdes")` currently returns an empty object.

What was found: `lib/v8.js` expects `Serializer` and `Deserializer`
constructors. A minimal QuickJS-backed serdes binding should let the public
`v8` builtin load cleanly before deeper standalone Next compatibility work.
