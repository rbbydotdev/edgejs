import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// L0 Lever B — vendored emnapi swap.
//
// Default (flag OFF): imports resolve to npm-published @emnapi/* in
// node_modules.  This is the production path.
//
// Flag ON (`EDGE_USE_VENDORED_EMNAPI=true`): imports resolve to the
// vendored copy under ../vendor/emnapi/packages/*/dist/*.  Used for
// probing emnapi internals + future L5 patches.
//
// Single facade file `src/napi-host/emnapi.ts` imports `@emnapi/*`;
// this alias config redirects those imports at bundle time so call
// sites don't change between flag states.
//
// Caveat: vendored copy is v2.0.0-alpha.1 (vs npm 1.10.0).  Major
// version delta; flag-ON may currently break.  See NOTES.md
// "vendored-emnapi-flag" for current status.
const __dirname = dirname(fileURLToPath(import.meta.url));
// V2 cutover (2026-05-25): vendored v2 is now the default runtime.
// The cutover landed the env=bridge.address bridge + plugin wiring +
// codemod rewrites in src/napi-host/ that map v1 Context internals
// (handleStore/ensureHandle/addToCurrentScope) to v2's public API
// (napiValueFromJsValue/jsValueFromNapiValue).  Those rewrites are
// v2-only at runtime — v1 npm @emnapi/* lacks these methods on
// Context — so we no longer ship a working v1 path.
//
// Opt OUT with `EDGE_USE_VENDORED_EMNAPI=false` for diagnosis only;
// expect failures on flag-OFF until v1 support is restored (which is
// not currently a goal — see NOTES.md vendored-emnapi-flag, now
// inverted).  Default ON.
const useVendoredEmnapi = process.env.EDGE_USE_VENDORED_EMNAPI !== "false";

// `@emnapi/core/plugins` subpath always resolves to vendored (v2-only).
// V1's npm package doesn't export this subpath; vendored plugins are
// loaded by createNapiModule when v2 is the active runtime.  V1 ignores
// the `plugins:` option entirely.  Listed FIRST so the more-specific
// subpath alias takes precedence over the `@emnapi/core` alias below.
const pluginsAlias = {
  find: "@emnapi/core/plugins",
  replacement: resolve(
    __dirname,
    "../vendor/emnapi/packages/core/dist/plugins/index.js",
  ),
};

const vendoredAliases = useVendoredEmnapi
  ? [
      pluginsAlias,
      {
        find: "@emnapi/runtime",
        replacement: resolve(
          __dirname,
          "../vendor/emnapi/packages/runtime/dist/emnapi.js",
        ),
      },
      {
        find: "@emnapi/core",
        replacement: resolve(
          __dirname,
          "../vendor/emnapi/packages/core/dist/emnapi-core.js",
        ),
      },
      {
        find: "@emnapi/wasi-threads",
        replacement: resolve(
          __dirname,
          "../vendor/emnapi/packages/wasi-threads/dist/wasi-threads.js",
        ),
      },
    ]
  : [pluginsAlias];

if (useVendoredEmnapi) {
  // Visible in vite stdout so test runners log this clearly.
  // eslint-disable-next-line no-console
  console.log("[vite] EDGE_USE_VENDORED_EMNAPI=true — aliasing @emnapi/* to vendor/emnapi");
}

export default defineConfig({
  resolve: {
    alias: vendoredAliases,
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    fs: {
      strict: false,
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@wasmer/sdk"],
  },
});
