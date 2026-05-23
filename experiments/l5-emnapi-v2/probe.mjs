// L5 experiment probe #1 — basic emnapi v2 in-process sanity check.
//
// Question: can we createContext() + createNapiModule() and get a
// fully-populated `imports.napi` table?  This is the baseline before
// we attempt the split-worker topology in probe-remote.mjs.
//
// Approach: don't load any wasm.  Just instantiate the JS-side context
// and inspect what emnapi v2 exposes.

import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

const ctx = createContext();
console.log("createContext OK:", typeof ctx);
console.log("ctx.isolate:", typeof ctx.isolate);
console.log("ctx.features:", Object.keys(ctx.features).slice(0, 5));

const napiModule = createNapiModule({
  context: ctx,
  childThread: false,
  // The asyncWorkPoolSize: 0 disables async work entirely; we don't
  // need it for the JS-only probe and it skips needing a real
  // worker spawn function.
  asyncWorkPoolSize: 0,
});

console.log("\ncreateNapiModule OK:", typeof napiModule);
console.log("napiModule.imports keys:", Object.keys(napiModule.imports));
const napiImports = napiModule.imports.napi ?? {};
console.log("napiModule.imports.napi count:", Object.keys(napiImports).length);
console.log("napiModule.imports.napi sample:", Object.keys(napiImports).slice(0, 8));

// Try one of the simpler ops: napi_get_undefined (most synchronous, no args).
const napi_get_undefined = napiImports.napi_get_undefined;
if (typeof napi_get_undefined === "function") {
  console.log("\nnapi_get_undefined exists, signature:", napi_get_undefined.length, "args");
}

// Inspect what each function expects.  Most napi functions are written
// against an env (napi_env) handle and write to a result pointer in
// linear memory.  Without a wasm memory we can't actually call them.
// But we CAN see the SHAPE.
const counts = {};
for (const k of Object.keys(napiImports)) {
  const fn = napiImports[k];
  const arity = typeof fn === "function" ? fn.length : "?";
  counts[arity] = (counts[arity] ?? 0) + 1;
}
console.log("\nnapi function arity distribution:", counts);

// What about the env binding setup?  emnapi's pattern is that wasm
// calls `unofficial_napi_create_env` which gives back a handle the
// other napi calls reference.  Let's see what's there.
console.log("\nimports.env keys count:", Object.keys(napiModule.imports.env ?? {}).length);
console.log("imports.env sample:", Object.keys(napiModule.imports.env ?? {}).slice(0, 8));
console.log("imports.emnapi keys count:", Object.keys(napiModule.imports.emnapi ?? {}).length);
console.log("imports.emnapi keys:", Object.keys(napiModule.imports.emnapi ?? {}));

console.log("\n--- probe.mjs: OK ---");
