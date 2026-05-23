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
const useVendoredEmnapi = process.env.EDGE_USE_VENDORED_EMNAPI === "true";

const vendoredAliases = useVendoredEmnapi
  ? [
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
  : [];

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
