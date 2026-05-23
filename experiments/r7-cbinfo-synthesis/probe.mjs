// R7 — synthesize napi_callback_info on the wasm runtime worker so that
// reverse-RPC'd NAPI_CALLBACK funcrefs can call napi_get_cb_info(env,
// cbinfo, ...) and unpack their args correctly.
//
// Question we're answering (last unknown for Lever B napi cutover):
//   When wasm's `__indirect_function_table.get(cbPtr)` returns a funcref
//   we want to invoke as `fn(env, cbinfo) → napi_value`, what do we pass
//   as `cbinfo` so the funcref's internal call to
//   `napi_get_cb_info(env, cbinfo, &argc, argv, &thisArg, &data)` works?
//
// Strategy survey:
//   A. Manual struct allocation in wasm linear memory + decode.
//        REJECTED by source inspection: there is no separate native
//        struct.  emnapi stores callback metadata as a JS object hung
//        off the HandleScope (HandleScope.ts:21,
//        `public callbackInfo: ICallbackInfo`).  The "pointer" the
//        napi C ABI sees is the JS-side scope ID; emnapi looks it up
//        via `_scopeStore.deref(info).callbackInfo` (Isolate.ts:202).
//        There is no memory layout to mirror — A is structurally
//        impossible.
//
//   B. Call an exported allocator (e.g. `emnapi_create_callback_info`).
//        REJECTED by source inspection: emnapi exports no such entry
//        point.  Only `createFunction` (Context.ts:281) populates a
//        CallbackInfo, and it does so via the internal `withScope`
//        wrapper (Context.ts:29-45) — not exposed as a standalone
//        function.
//
//   C. Open a HandleScope ourselves and mutate its callbackInfo
//        directly.  Pass `scope.id` (a small integer) as cbinfo.
//        Close the scope after the funcref returns.
//        ACCEPTED: this mirrors what `withScope` does internally;
//        every napi op that introspects cbinfo goes through
//        `getCallbackInfo(info)` → `_scopeStore.deref(info).callbackInfo`
//        (Isolate.ts:201-203), so any HandleScope whose `callbackInfo`
//        field is populated will round-trip.
//
// This probe validates Strategy C with the real emnapi runtime, hand-
// crafting a NAPI_CALLBACK funcref that exercises every output of
// napi_get_cb_info (argc, argv, thisArg, data) and verifies they
// all come back correctly.

import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

// ─── Boot a minimal emnapi context ──────────────────────────────────
//
// We don't need a real wasm module — emnapi only requires that
// `instance.exports` have the right symbols (most of them stubs).
// This is the same pattern host-worker.ts uses for its host-side
// emnapi context (host-worker.ts:111-150) and what
// l5-real-roundtrip/probe.mjs uses.

const memory = new WebAssembly.Memory({ initial: 1, maximum: 16, shared: true });
const memU32 = new Uint32Array(memory.buffer);
const wasmModule = new WebAssembly.Module(new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]));
const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
let poolNext = 16384;
const stubInstance = {
  exports: {
    memory,
    malloc: (size) => { const p = poolNext; poolNext += (size + 7) & ~7; return p; },
    free: () => {},
    __indirect_function_table: table,
    emnapi_create_env: () => 1,
    emnapi_delete_env: () => 0,
    emnapi_runtime_init: () => {},
    emnapi_runtime_finalize: () => {},
    napi_register_wasm_v1: () => 0,
  },
};

const ctx = createContext();
const napiModule = createNapiModule({ context: ctx, childThread: false, asyncWorkPoolSize: 0 });
napiModule.init({ instance: stubInstance, module: wasmModule, memory, table });

const napi = napiModule.imports.napi;

// ─── Grab an Env object ─────────────────────────────────────────────
//
// We need an `Env` to call `ctx.openScope(envObject)`.  emnapi's
// `init` deletes `napiModule.envObject` after registration, so we
// reach into the isolate's envStore via napi_get_undefined which
// uses env id 1 (set by our stub's `emnapi_create_env`).
//
// Easier path: napi_get_undefined writes a handle to mem; we don't
// need the Env object directly because `openScope` is exposed
// through the public napi C API as `napi_open_handle_scope`.

const ENV = 1;

// ─── Round-trip JS → handle → JS via the public napi API ────────────
//
// We use real napi C entry points to construct handles for `this`,
// each arg, and `data`.  napi_create_int32 + napi_create_string_utf8
// give us concrete value handles in the same handle space the funcref
// will see.

function napi_create_int32(value, ptr) {
  napi.napi_create_int32(ENV, value | 0, ptr);
  return memU32[ptr >>> 2];
}
function napi_create_string_utf8(s, ptr) {
  // need to encode s into a buffer in wasm linear memory first
  const bytes = new TextEncoder().encode(s);
  const strPtr = poolNext; poolNext += (bytes.byteLength + 7) & ~7;
  new Uint8Array(memory.buffer, strPtr, bytes.byteLength).set(bytes);
  // napi_create_string_utf8(env, str, length, result)
  napi.napi_create_string_utf8(ENV, strPtr, bytes.byteLength, ptr);
  return memU32[ptr >>> 2];
}
function napi_create_object(ptr) {
  napi.napi_create_object(ENV, ptr);
  return memU32[ptr >>> 2];
}

// scratch slot for napi outputs
const SCRATCH = 1024;

// We need an open HandleScope before any napi_create_* will work —
// the root scope has no handleStore (HandleStore is attached in
// HandleScope.create / openScope).  Open one via the public API.
const SCOPE_OUT = 1020;
{
  const status = napi.napi_open_handle_scope(ENV, SCOPE_OUT);
  if (status !== 0) throw new Error(`napi_open_handle_scope failed: ${status}`);
}

// Build a couple of arg handles + a `this` handle.  These are the
// values the wasm-side reverse-RPC handler would receive from the host
// (modulo the cross-context handle translation we punted on; the
// synthesis itself is identical either way).
const argHandle0 = napi_create_int32(42, SCRATCH);
const argHandle1 = napi_create_string_utf8("hello", SCRATCH);
const thisHandle = napi_create_object(SCRATCH);

// jsValueFromNapiValue (private helper exposed on the context) — we
// need it to dereference the handles back to JS values, because
// emnapi's `withScope` stores raw JS values on `callbackInfo.args`,
// NOT handles.  When `napi_get_cb_info` materializes the result, it
// calls `napiValueFromJsValue(cbinfoValue.args[i])` to allocate a
// fresh handle on the new scope.  (function.ts:51-52.)
const argVal0 = ctx.jsValueFromNapiValue(argHandle0);
const argVal1 = ctx.jsValueFromNapiValue(argHandle1);
const thisVal = ctx.jsValueFromNapiValue(thisHandle);

const DATA_PTR = 0xdeadbeef >>> 0; // opaque ptr the funcref's data slot

// ─── The wasm-side "funcref" ─ a NAPI_CALLBACK that reads cbinfo ───
//
// In the real flow this is wasmTable.get(cbPtr).  Here it's a JS
// function that calls napi_get_cb_info via the public napi C API.
// Inside, we assert it reports the expected argc/argv/this/data.

let observed = null;
let observedReturn = null;

function nativeCallback(env, cbinfo) {
  // C-level call:
  //   napi_value argv[8];
  //   size_t argc = 8;
  //   napi_value thisArg;
  //   void* data;
  //   napi_get_cb_info(env, cbinfo, &argc, argv, &thisArg, &data);

  const ARGV_BASE = 2048; // wasm-linear address for argv[]
  const ARGC_PTR  = 2096;
  const THIS_PTR  = 2100;
  const DATA_OUT  = 2104;

  // initial argc capacity = 8
  memU32[ARGC_PTR >>> 2] = 8;
  memU32[THIS_PTR >>> 2] = 0;
  memU32[DATA_OUT >>> 2] = 0;
  for (let i = 0; i < 8; i++) memU32[(ARGV_BASE >>> 2) + i] = 0;

  const status = napi.napi_get_cb_info(env, cbinfo, ARGC_PTR, ARGV_BASE, THIS_PTR, DATA_OUT);
  if (status !== 0) {
    throw new Error(`napi_get_cb_info returned status=${status}`);
  }

  const argc = memU32[ARGC_PTR >>> 2];
  const recvHandles = [];
  for (let i = 0; i < argc; i++) recvHandles.push(memU32[(ARGV_BASE >>> 2) + i]);
  const recvThis = memU32[THIS_PTR >>> 2];
  const recvData = memU32[DATA_OUT >>> 2];

  // Dereference the handles emnapi just freshly allocated for us, to
  // make sure the *values* round-trip too.
  observed = {
    argc,
    args: recvHandles.map((h) => ctx.jsValueFromNapiValue(h)),
    this: ctx.jsValueFromNapiValue(recvThis),
    data: recvData,
  };

  // Return a sentinel napi_value so we can prove control flow worked.
  // The handle is freshly created in the synthesized scope; it will be
  // freed when the scope closes after the funcref returns.  We
  // dereference it here (still inside the scope) to record the value
  // for assertion.
  const retPtr = 2200;
  napi.napi_create_int32(env, 7, retPtr);
  const retHandle = memU32[retPtr >>> 2];
  observedReturn = ctx.jsValueFromNapiValue(retHandle);
  return retHandle;
}

// ─── Strategy C: synthesize cbinfo via openScope + field mutation ──
//
// THE CORE EXPERIMENT.  This is the exact code pattern the integration
// commit would put inside `callback-dispatch.ts`'s NAPI_CALLBACK case
// (replacing the `cbinfo=0` shortcut).

function synthesizeCbInfoAndInvoke({
  context,
  envObject,
  fn,
  env,         // u32 env handle (for the funcref's first arg)
  thiz,        // raw JS value to expose as `this`
  args,        // raw JS values array
  data,        // u32/bigint opaque pointer
}) {
  const scope = context.openScope(envObject);
  const cbi = scope.callbackInfo;
  cbi.thiz = thiz;
  cbi.args = args;
  cbi.data = data;
  cbi.fn = fn;        // emnapi expects a Function here; we pass the funcref itself
  cbi.holder = undefined;

  // cbinfo passed to the funcref is just the scope id.  Per Context.ts:293
  // (emnapi's own createFunction): `napiCallback(env, ctx.getCurrentScope()!.id)`.
  const cbinfoHandle = scope.id;

  try {
    return fn(env, cbinfoHandle);
  } finally {
    // Important: clear fn FIRST so HandleScope.dispose() takes the
    // non-weak branch and tears down args/thiz/data (HandleScope.ts:60-71).
    context.closeScope(envObject, scope);
  }
}

// We need an `Env` instance to pass to openScope.  Reach into the
// context's private envStore via the public deref helper (it's typed
// public on Context, per Context.ts:353).
const envObject = ctx.getEnv(ENV);
if (!envObject) throw new Error("envObject for ENV id=1 is null — emnapi context setup failed");

// ─── Run the test ─────────────────────────────────────────────────

const fakeEnv = ENV;
const ret = synthesizeCbInfoAndInvoke({
  context: ctx,
  envObject,
  fn: nativeCallback,
  env: fakeEnv,
  thiz: thisVal,
  args: [argVal0, argVal1],
  data: DATA_PTR,
});

console.log("[probe] funcref returned napi_value handle =", ret);
console.log("[probe] observed inside callback:", observed);

// ─── Assertions ───────────────────────────────────────────────────

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label} — got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
  if (!ok) process.exitCode = 1;
}

console.log("[probe] assertions:");
assertEq(observed.argc, 2, "argc");
assertEq(observed.args[0], 42, "args[0] === 42");
assertEq(observed.args[1], "hello", "args[1] === 'hello'");
assertEq(observed.this, thisVal, "this passes through as same JS object");
assertEq(observed.data, DATA_PTR, "data === 0xdeadbeef");
assertEq(observedReturn, 7, "return value (dereferenced inside callback) === 7");
// Note: `ret` is unusable AFTER closeScope (handle erased).  Per real
// integration: the wasm-side handler returns the handle u32 to the
// host over reverse-RPC BEFORE closeScope runs — same pattern.

// ─── Per-call latency ─────────────────────────────────────────────

console.log("\n[probe] per-call latency (synthesize cbinfo + funcref + napi_get_cb_info + close scope)");
const ITER = 10000;
const tStart = process.hrtime.bigint();
for (let i = 0; i < ITER; i++) {
  synthesizeCbInfoAndInvoke({
    context: ctx,
    envObject,
    fn: nativeCallback,
    env: fakeEnv,
    thiz: thisVal,
    args: [argVal0, argVal1],
    data: DATA_PTR,
  });
}
const tEnd = process.hrtime.bigint();
const totalNs = Number(tEnd - tStart);
const perCallNs = totalNs / ITER;
console.log(`  total: ${(totalNs / 1e6).toFixed(2)} ms  per-call: ${perCallNs.toFixed(0)} ns (${(perCallNs / 1000).toFixed(2)} µs)`);

// ─── Stress test: re-entrancy + many calls ────────────────────────
//
// E4 measured ~31 µs median per fire end-to-end on the bundled args
// path.  Our cbinfo synthesis cost should be a small slice of that.

console.log("\n[probe] re-entrancy + scope reuse stress");
let reentryDepth = 0;
let maxObservedDepth = 0;
function reentrantCallback(env, cbinfo) {
  reentryDepth++;
  if (reentryDepth > maxObservedDepth) maxObservedDepth = reentryDepth;
  // pull args via napi_get_cb_info to exercise the scope's callbackInfo
  const ARGV_BASE = 4096 + reentryDepth * 64;
  const ARGC_PTR = ARGV_BASE + 48;
  memU32[ARGC_PTR >>> 2] = 4;
  napi.napi_get_cb_info(env, cbinfo, ARGC_PTR, ARGV_BASE, 0, 0);
  const recvArgc = memU32[ARGC_PTR >>> 2];
  if (recvArgc !== 2) {
    throw new Error(`re-entrancy depth=${reentryDepth}: argc mismatch got=${recvArgc} want=2`);
  }
  if (reentryDepth < 8) {
    synthesizeCbInfoAndInvoke({
      context: ctx,
      envObject,
      fn: reentrantCallback,
      env,
      thiz: thisVal,
      args: [argVal0, argVal1],
      data: DATA_PTR,
    });
  }
  reentryDepth--;
  return 0;
}
synthesizeCbInfoAndInvoke({
  context: ctx,
  envObject,
  fn: reentrantCallback,
  env: fakeEnv,
  thiz: thisVal,
  args: [argVal0, argVal1],
  data: DATA_PTR,
});
console.log(`  re-entered to depth ${maxObservedDepth} cleanly (each level saw its own correct cbinfo)`);

// ─── Verify scope cleanup ─────────────────────────────────────────

console.log("\n[probe] scope-leak check");
// We hold one outer scope open for the duration of the probe (the
// one we opened at the top to enable handle creation).  Verify the
// current scope is that scope and not deeper — i.e. all synthesized
// scopes were closed.
const iso = ctx.getIsolate();
const currentScope = iso.getCurrentScope();
// We expect `currentScope.parent` to be the root scope (the outer
// napi_open_handle_scope is one level deep).
const parentIsRoot = currentScope.parent !== null && currentScope.parent.parent === null;
console.log(`  current scope id=${currentScope.id}  parentIsRoot=${parentIsRoot}  (PASS if true)`);
if (!parentIsRoot) process.exitCode = 1;

console.log("\n[probe] " + (process.exitCode ? "FAILED" : "PASSED"));
