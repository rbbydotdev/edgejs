/// <reference types="vite/client" />

// `?raw` suffix imports return the file contents as a string.  Vite handles
// this at build time; we declare it here so TypeScript also recognizes the
// pattern.  Used heavily by edge-env presets that import `*.runtime.js`
// source files for surgical patches and vendored runtime code.
declare module "*?raw" {
  const content: string;
  export default content;
}
