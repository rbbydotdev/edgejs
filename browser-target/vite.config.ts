import { defineConfig } from "vite";

export default defineConfig({
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
