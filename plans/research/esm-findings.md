# ESM in browser-Node runtimes — findings

Research conducted 2026-05-23. Full agent output in
`/private/tmp/claude-501/.../tasks/a5e42af50da0dd427.output`.

## Recommended strategy: three-layer combo

1. **Native browser import maps** (Baseline as of Jan 2026; Firefox shipped multiple-import-maps Feb 2026) — source of truth for `node:*` and bare specifier resolution
2. **es-module-shims polyfill mode** — 13 KB, wasm-based lexer. `source`/`fetch`/`resolve` hooks let us return virtual module bodies for `node:*`. Zero cost on capable browsers; only re-executes on detected static link errors.
3. **Service Worker fetch interceptor** for late-discovered deps, virtual modules, dynamic `import()` shapes that need rewriting

## Key library: `@jspm/generator`

[github.com/jspm/generator](https://github.com/jspm/generator) — pure JS, browser-runnable, implements full Node 24 + npm resolution algorithm (`exports`, `imports`, conditions, scopes, own-name). Outputs an import map. Supports providers: `nodemodules`, `jspm.io`, `jsdelivr`, `unpkg`, `esm.sh`.

**Use this directly.** Don't reimplement.

## Critical findings

### Multiple import maps now Baseline (Jan 2026)
Chromium + WebKit shipped; Firefox 147+ has multiple-map support. Merge algorithm guarantees no module's resolution changes after load — safe for incremental injection.

### `node:*` prefix mandatory in v1
Match Deno + Cloudflare posture. `import 'fs'` is ambiguous; `import 'node:fs'` is explicit. Saves us from disambiguation logic and matches modern practice.

### Don't use blob: URLs for user code
`blob:` and `data:` are not hierarchical → relative imports fail with `Failed to resolve module specifier`. Bare specifiers also fail. The only way to make blob-imports work is to pre-rewrite all child imports — which es-module-shims does internally anyway.

### Don't share one import map across host + wasm
Astro lesson: client vs. SSR environments need separate `optimizeDeps`. Treat the host worker as "client" and wasm worker as "SSR" — explicit translation at boundary, not one shared map.

### Service Worker `import()` is spec-unresolved
[w3c/ServiceWorker #1585](https://github.com/w3c/ServiceWorker/issues/1585). Don't rely on it inside the SW handler. Use static imports or `importScripts`.

### es-module-shims doesn't polyfill dynamic `import()` cleanly
By design (double-execution problem). For dynamic imports to work, the static graph must hit a bare specifier first so polyfill mode kicks in. Workaround: have the host bootstrap import one bare specifier.

## WebContainer's approach (for context, not for direct use)

They run a Custom TypeScript module loader inside the wasm-hosted Node. Resolves bare specifiers, honors package.json exports, ESM↔CJS bridging. Module-resolution edge cases have been a multi-year tar pit (issue #1137 unfixed since 2023). Their bare-specifier resolution happens via Vite-in-WASM doing dep-prebundling — we can't reuse this because our user code runs OUTSIDE wasm.

## Implementation cost

| Component | LOC estimate | Reuses |
|---|---|---|
| Import map builder (calls JSPM generator) | ~100 | `@jspm/generator` directly |
| SW handler for `/_edge/node-builtin/*` | ~200 | `policies/inbound-https-via-sw.ts` pattern |
| `node:*` bridge modules (~40 modules × ~30 LOC) | ~1200 | existing `host/fs/` |
| es-module-shims integration | ~50 | upstream package |
| Policy entry `policies/esm.ts` | ~80 | existing policy pattern |
| **Total** | **~1500–1800** | |

Plus: JSPM generator (~80 KB gzipped), es-module-shims (~13 KB).

## Perf budget

- Host worker startup: +50–150 ms (es-module-shims + first import-map parse)
- SW cold-start: +100–300 ms one-time (cached after)
- Per-import overhead post-warm: <1 ms on capable browsers, ~5–15 ms in polyfill path
- Multiple-import-maps: ~7–10 ms per map (use at most 2–3)

## Validation plan (3-day spike before committing)

1. Day 1: smoke fixture with `<script type="importmap">` mapping `node:fs` to a virtual module returning `{ readFileSync: () => 'hello' }`. Confirm `import fs from 'node:fs'` works across Chrome/Firefox/Safari.
2. Day 2: + es-module-shims + JSPM generator. Confirm map resolves React + 2 transitive deps.
3. Day 3: + SW interception for `/_edge/node-builtin/fs.mjs` synthesized response. Confirm host worker imports it. Confirm dynamic `import()` works. Confirm cross-worker IPC to napi-host.

## Fallback (if too hard)

**Plan B — dynamic-only:** require user to use `await edgeRequire('node:fs')` instead of static `import`. We control resolution entirely in JS — no import map needed. ~200 LOC. Ugly UX but works.

**Plan C — full bundle step:** require Vite/Rolldown build before deployment. We see pre-resolved code only. Punts the problem to the bundler ecosystem.

## Pitfalls

- Don't rely on `import()` inside Service Worker handler (#1585)
- `exports` whitelisting breaks deep imports — JSPM generator handles this; don't roll our own
- TypeScript stripping is free via es-module-shims v2 (uses Node's Amaro)

## Sources

- [es-module-shims v2.0 (Guy Bedford)](https://guybedford.com/es-module-shims-2.0)
- [Shopify — Resilient Import Maps](https://shopify.engineering/resilient-import-maps)
- [importmap.lock proposal (Jan 2026)](https://nesbitt.io/2026/01/19/importmap-lock.html)
- [Firefox bug 1916277 — multiple import maps](https://bugzilla.mozilla.org/show_bug.cgi?id=1916277)
- [w3c/ServiceWorker #1585](https://github.com/w3c/ServiceWorker/issues/1585)
- [web.dev — ES modules in service workers](https://web.dev/articles/es-modules-in-sw)
- [JSPM generator](https://github.com/jspm/generator)
- [Cloudflare Workers Node.js compat 2025-2026](https://blog.cloudflare.com/nodejs-workers-2025/)
- [Vite dependency pre-bundling](https://vite.dev/guide/dep-pre-bundling)
