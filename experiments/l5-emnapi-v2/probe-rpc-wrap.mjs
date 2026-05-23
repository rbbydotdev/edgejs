// L5 experiment probe #2 — RPC wrapping of napi imports.
//
// Question: can we wrap each napi function in a stub that simulates
// an RPC call, and get identical results to calling the function
// directly?  This validates the split-worker architecture WITHOUT
// real workers — pure JS proxy that proves the pattern.
//
// If this works, the path to production is: replace the direct call
// inside the stub with a SAB-RPC roundtrip (we have that primitive
// from L2-L4 already).  The interface stays the same.

import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

// "Host" side — owns the real emnapi context + napi module.
const hostCtx = createContext();
const hostModule = createNapiModule({
  context: hostCtx,
  childThread: false,
  asyncWorkPoolSize: 0,
});
const hostNapi = hostModule.imports.napi;
const hostEnv = hostModule.imports.env;

console.log("[host] napi functions:", Object.keys(hostNapi).length);
console.log("[host] env functions:", Object.keys(hostEnv).length);

// "Wasm" side — gets a proxy that wraps each napi function.
//
// In production:
//   - The stub serializes args (uint32s mostly) and sends a SAB-RPC
//     request to the host worker.
//   - Host worker invokes hostNapi[opName](...args) directly.
//   - Result + any out-param writes come back via SAB.
//
// For the experiment:
//   - The stub directly calls the host function (zero overhead).
//   - Tracks call counts to verify routing.

const callCounts = new Map();
function makeRpcStub(opName, realFn) {
  return function (...args) {
    callCounts.set(opName, (callCounts.get(opName) ?? 0) + 1);
    return realFn(...args);
  };
}

const wasmNapi = {};
for (const [opName, realFn] of Object.entries(hostNapi)) {
  if (typeof realFn === "function") {
    wasmNapi[opName] = makeRpcStub(opName, realFn);
  } else {
    wasmNapi[opName] = realFn;
  }
}

// Need to also wrap env (some functions are required for env setup).
const wasmEnv = {};
for (const [opName, realFn] of Object.entries(hostEnv)) {
  if (typeof realFn === "function") {
    wasmEnv[opName] = makeRpcStub(opName, realFn);
  } else {
    wasmEnv[opName] = realFn;
  }
}

console.log("\n[wasm] proxy built");
console.log("[wasm] napi proxy keys:", Object.keys(wasmNapi).length);
console.log("[wasm] env proxy keys:", Object.keys(wasmEnv).length);

// Now exercise the proxy.  To actually CALL napi functions, we need
// an env handle.  emnapi creates Envs via Context internally; we can
// access through the API but it's wasm-driven normally.
//
// For this experiment, we'll inspect the API surface and confirm the
// wrapping doesn't break it.  Validating actual function execution
// requires either a wasm module OR direct Context manipulation.

// Pick a function with no out-param: napi_strict_equals (just returns
// status, takes env + 2 napi_values + 1 result-ptr).  We can't easily
// execute without a wasm memory, so just verify the proxy is callable.

console.log("\n--- proxy callability check ---");
const sampleOps = ["napi_get_undefined", "napi_get_null", "napi_strict_equals", "napi_typeof"];
for (const op of sampleOps) {
  const fn = wasmNapi[op];
  console.log(`  ${op}: ${typeof fn} arity=${fn?.length ?? "?"}`);
}

// Now: a real call.  Drive through napiModule's exports if we can find
// a way that doesn't need wasm.  Actually — Context has methods we can
// poke directly (envStore, refStore).  Let's see Env creation.
console.log("\n--- context state ---");
console.log("  envStore size:", hostCtx.envStore?.size ?? "n/a");
console.log("  refStore size:", hostCtx.refStore?.size ?? "n/a");

// Try calling napi_get_undefined directly through the proxy.  Args:
// (env, result_out).  We need an env first.  Without wasm, we can
// make an Env via the Context's createEnv method if exposed.
console.log("\n--- attempting direct call without wasm ---");
try {
  // napi_get_undefined wants env + a u32 pointer to write to.
  // Without wasm memory, the pointer write would crash.  Let's just
  // call with env=0, ptr=0 to see what happens (probably an error).
  const status = wasmNapi.napi_get_undefined(0, 0);
  console.log("  napi_get_undefined(0, 0) returned status:", status);
} catch (e) {
  console.log("  napi_get_undefined threw:", (e && e.message) || e);
}

console.log("\n--- call counts ---");
for (const [op, n] of callCounts) {
  console.log(`  ${op}: ${n}`);
}

console.log("\n--- probe-rpc-wrap.mjs: OK ---");
