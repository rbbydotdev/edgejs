// Rolldown-shape smoke: WebAssembly.compile(bytes).then(...).  Real-
// world tooling (Rolldown, Vite ssr, Wasm-based linters) load addons
// through this pattern.  In the wasm/edge path it exercises the
// WebAssembly host integration AND the microtask continuation —
// historically the second was the failure mode (`.then` callback
// silently dropped under JSPI suspend).  Here we use a minimal valid
// wasm module: an empty module is 8 bytes of magic + version.
const bytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,  // \0asm
  0x01, 0x00, 0x00, 0x00,  // version 1
]);
WebAssembly.compile(bytes).then((mod) => {
  console.log('compiled:', mod instanceof WebAssembly.Module);
}).catch((e) => {
  console.log('failed:', (e && e.message) || String(e));
  process.exit(1);
});
