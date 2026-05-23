// R8 — cross-context napi_value handle marshaling between host's emnapi
// and wasm's emnapi during Lever B reverse-channel callback dispatch.
//
// Question we're answering (R7's surfaced caveat #1, last unknown
// before the final 2 napi ops can ship):
//
//   In production, host has its own emnapi context (hostCtx); the wasm
//   runtime worker has ITS OWN emnapi context (wasmCtx).  Handle ID 14
//   in hostCtx points to a DIFFERENT JS value than handle ID 14 in
//   wasmCtx.  When `makeHostSideCallbackClosure` bundles host-context
//   handles as u32s into OP_INVOKE_WASM_CALLBACK and the wasm-side
//   handler feeds them into `napi_get_cb_info` (which derefs through
//   wasmCtx), the IDs are misinterpreted.  Same issue for the return
//   value: funcref returns a wasm-context handle; host receives a u32
//   and would try to use it as a host-context handle.  Crash, or worse,
//   silent corruption.
//
// Three candidate strategies:
//
//   1. Primitives serialized inline.  At the marshaling boundary,
//      deref each handle → JS value; serialize the value as tagged
//      bytes; receiver decodes and mints a fresh handle in its own
//      context via `ctx.napiValueFromJsValue(value)`.  Cheap, simple,
//      doesn't handle non-trivial objects.
//
//   2. Shared identity map for objects.  Marshal `(serialized_value,
//      identity_id)` so receiver can `get-or-create` a stable
//      wasm-side handle for each host-side object.  Preserves
//      `===`-identity across the boundary.
//
//   3. Hybrid.  1 for primitives (covers ~90%), 2 for objects.
//      One-byte tag prefix per arg disambiguates.
//
// This probe boots TWO independent emnapi contexts in the same Node
// process (the production shape — same wiring as host-worker.ts and
// runtime worker) and exercises a value-marshaling layer between them.
// We then measure per-call latency by value kind, identity-map
// behaviour, and the end-to-end "host JS function → marshal argv →
// wasm funcref → marshal return → host" loop.

import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

// ─── Boot one emnapi context (factored) ─────────────────────────────
//
// Mirrors R7's boot.  We boot two of these and treat one as the host
// context and the other as the wasm context.  In production these
// live on separate workers; here they live in the same process but
// are independent JS objects with independent handle stores, which is
// exactly the marshaling property we need to test.

function bootEmnapiContext(label) {
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

  // open a root handle scope so napi_create_* work
  const SCOPE_OUT = 1020;
  const status = napi.napi_open_handle_scope(1, SCOPE_OUT);
  if (status !== 0) throw new Error(`[${label}] napi_open_handle_scope failed: ${status}`);

  const envObject = ctx.getEnv(1);
  if (!envObject) throw new Error(`[${label}] envObject for env id=1 is null`);

  return { label, ctx, napi, memory, memU32, envObject };
}

const hostCtx  = bootEmnapiContext("host");
const wasmCtx  = bootEmnapiContext("wasm");

// Confirm independence of the two contexts: the same handle id in each
// derefs to different values.  Mint a string in host; check that in
// wasm that same numeric id is unrelated.
function showIndependence() {
  const hostId = hostCtx.ctx.napiValueFromJsValue("HOST-ONLY-STRING-12345");
  const wasmDeref = wasmCtx.ctx.jsValueFromNapiValue(Number(hostId));
  console.log(`[probe] independence check: host minted '${hostCtx.ctx.jsValueFromNapiValue(Number(hostId))}' at id=${hostId}; wasm deref of same id = ${JSON.stringify(wasmDeref)}`);
  if (wasmDeref === "HOST-ONLY-STRING-12345") {
    throw new Error("FATAL: contexts share state — probe is invalid");
  }
}
showIndependence();

// ─── Strategy 3 — Hybrid marshaling ───────────────────────────────
//
// One-byte tag prefix per arg:
//
//   TAG  VALUE             PAYLOAD
//   0    undefined         (none)
//   1    null              (none)
//   2    false             (none)
//   3    true              (none)
//   4    number (f64)      8 bytes (LE float64)
//   5    int32             4 bytes (LE int32)  — small-int fast path
//   6    string            4 bytes length + N bytes utf8
//   7    object (by id)    4 bytes identityId  + 4 bytes flags
//                          flags bit 0: 1 if array, else plain object
//
// Tag selection prioritizes the common cases.  Tag 5 (int32) is a fast
// path that avoids an 8-byte float64 encode for the most common arg
// type in napi (most napi_create_int32 callers).  Tag 4 (general
// number) covers everything else.  Tag 7 routes through a shared
// identity map.  Anything we can't tag falls through to error (tag 255).

const TAG_UNDEFINED = 0;
const TAG_NULL      = 1;
const TAG_FALSE     = 2;
const TAG_TRUE      = 3;
const TAG_NUMBER    = 4;
const TAG_INT32     = 5;
const TAG_STRING    = 6;
const TAG_OBJECT    = 7;
const TAG_UNSUPPORTED = 255;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

// ─── Shared identity map ──────────────────────────────────────────
//
// One process-wide identity registry that both contexts can consult.
// Keyed by JS object identity (WeakMap).  Each entry stores an
// auto-assigned identity id; reverse lookup id→object is via a sparse
// array indexed by id.
//
// Lifetime semantics:
//   - WeakMap holds an object → id.  When the object is GC'd in the
//     "owning" context, the WeakMap entry can be reaped; however we
//     ALSO need to look up id → object on the receiver side, which
//     requires keeping the object alive.  Two options:
//       a) Strong reference on the receiver side until the receiver
//          explicitly releases (caller responsibility).
//       b) Both sides hold WeakRefs; if either GCs, identity is lost.
//   - For this probe we use a simple Map (strong refs both ways) so
//     we can measure growth.  Production would use FinalizationRegistry
//     + WeakRef to make either side's GC trigger eviction.
//
// We also store a side-tag indicating which context owns the canonical
// JS object — host or wasm.  For host→wasm marshaling, the owner is
// host; the wasm side will see the same object reference.

class IdentityMap {
  constructor() {
    this.objToId = new WeakMap();
    this.idToObj = new Map();   // id → { obj, owner }
    this.nextId = 1;
  }
  put(obj, owner) {
    const existing = this.objToId.get(obj);
    if (existing !== undefined) return existing;
    const id = this.nextId++;
    this.objToId.set(obj, id);
    this.idToObj.set(id, { obj, owner });
    return id;
  }
  get(id) {
    return this.idToObj.get(id);
  }
  size() {
    return this.idToObj.size;
  }
}

const identityMap = new IdentityMap();

// ─── Encoder: JS value → tagged bytes ─────────────────────────────
//
// Returns a Uint8Array.  Owner is the context tag ('host' or 'wasm')
// for use when stashing objects in the identity map.
function encodeValue(value, owner) {
  if (value === undefined) return new Uint8Array([TAG_UNDEFINED]);
  if (value === null)      return new Uint8Array([TAG_NULL]);
  if (value === false)     return new Uint8Array([TAG_FALSE]);
  if (value === true)      return new Uint8Array([TAG_TRUE]);
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      const buf = new Uint8Array(5);
      buf[0] = TAG_INT32;
      new DataView(buf.buffer).setInt32(1, value, true);
      return buf;
    }
    const buf = new Uint8Array(9);
    buf[0] = TAG_NUMBER;
    new DataView(buf.buffer).setFloat64(1, value, true);
    return buf;
  }
  if (typeof value === "string") {
    const bytes = utf8Encoder.encode(value);
    const buf = new Uint8Array(5 + bytes.byteLength);
    buf[0] = TAG_STRING;
    new DataView(buf.buffer).setUint32(1, bytes.byteLength, true);
    buf.set(bytes, 5);
    return buf;
  }
  if (typeof value === "object") {
    const id = identityMap.put(value, owner);
    const isArray = Array.isArray(value) ? 1 : 0;
    const buf = new Uint8Array(9);
    buf[0] = TAG_OBJECT;
    const dv = new DataView(buf.buffer);
    dv.setUint32(1, id, true);
    dv.setUint32(5, isArray, true);
    return buf;
  }
  // unsupported (functions, symbols, bigints — out of scope for this
  // probe; tag-255 lets the receiver throw cleanly)
  return new Uint8Array([TAG_UNSUPPORTED]);
}

// ─── Decoder: tagged bytes → JS value (in receiver's identity space) ─
//
// Returns { value, byteLength } so a caller can decode several
// concatenated args.
function decodeValue(buf, offset) {
  const tag = buf[offset];
  switch (tag) {
    case TAG_UNDEFINED: return { value: undefined, byteLength: 1 };
    case TAG_NULL:      return { value: null,      byteLength: 1 };
    case TAG_FALSE:     return { value: false,     byteLength: 1 };
    case TAG_TRUE:      return { value: true,      byteLength: 1 };
    case TAG_INT32: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      return { value: dv.getInt32(0, true), byteLength: 5 };
    }
    case TAG_NUMBER: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 8);
      return { value: dv.getFloat64(0, true), byteLength: 9 };
    }
    case TAG_STRING: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const len = dv.getUint32(0, true);
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset + offset + 5, len);
      return { value: utf8Decoder.decode(bytes), byteLength: 5 + len };
    }
    case TAG_OBJECT: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 8);
      const id = dv.getUint32(0, true);
      const entry = identityMap.get(id);
      if (!entry) throw new Error(`identity map miss: id=${id}`);
      return { value: entry.obj, byteLength: 9 };
    }
    case TAG_UNSUPPORTED:
      throw new Error("decode: unsupported tag (function/symbol/bigint)");
    default:
      throw new Error(`decode: unknown tag ${tag}`);
  }
}

// ─── Marshal an argv from one context to another ─────────────────
//
// srcCtx's handles[] → bytes (carrying values + identity ids) →
// dstCtx's freshly minted handles[].
function marshalArgv(srcCtx, dstCtx, srcHandles, srcOwner) {
  // 1. Pack on sender side.
  const buffers = srcHandles.map((h) => {
    const v = srcCtx.jsValueFromNapiValue(h);
    return encodeValue(v, srcOwner);
  });
  const total = buffers.reduce((acc, b) => acc + b.byteLength, 0);
  const out = new Uint8Array(total + 4);
  new DataView(out.buffer).setUint32(0, srcHandles.length, true);
  let off = 4;
  for (const b of buffers) { out.set(b, off); off += b.byteLength; }

  // 2. Unpack on receiver side.
  const dv = new DataView(out.buffer);
  const argc = dv.getUint32(0, true);
  let cursor = 4;
  const dstHandles = [];
  const dstValues = [];
  for (let i = 0; i < argc; i++) {
    const { value, byteLength } = decodeValue(out, cursor);
    cursor += byteLength;
    dstHandles.push(Number(dstCtx.napiValueFromJsValue(value)));
    dstValues.push(value);
  }
  return { dstHandles, dstValues, payload: out };
}

// ─── Test cases ───────────────────────────────────────────────────

function assertEq(a, b, label) {
  const ok = (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b))
    ? true
    : a === b;
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label} — got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

function assertDeepEq(a, b, label) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label} — got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

console.log("\n[probe] === primitives marshaling ===");
{
  // Mint each kind of primitive as a handle in hostCtx, marshal to
  // wasmCtx, and verify the wasm-side value matches.
  const hostHandles = [
    Number(hostCtx.ctx.napiValueFromJsValue(undefined)),
    Number(hostCtx.ctx.napiValueFromJsValue(null)),
    Number(hostCtx.ctx.napiValueFromJsValue(false)),
    Number(hostCtx.ctx.napiValueFromJsValue(true)),
    Number(hostCtx.ctx.napiValueFromJsValue(42)),
    Number(hostCtx.ctx.napiValueFromJsValue(-1)),
    Number(hostCtx.ctx.napiValueFromJsValue(2_147_483_647)),
    Number(hostCtx.ctx.napiValueFromJsValue(-2_147_483_648)),
    Number(hostCtx.ctx.napiValueFromJsValue(3.14159)),
    Number(hostCtx.ctx.napiValueFromJsValue(Number.MAX_VALUE)),
    Number(hostCtx.ctx.napiValueFromJsValue("")),
    Number(hostCtx.ctx.napiValueFromJsValue("hello")),
    Number(hostCtx.ctx.napiValueFromJsValue("ünïcödé 世界 🌍")),
  ];
  const expected = [undefined, null, false, true, 42, -1, 2147483647, -2147483648,
                    3.14159, Number.MAX_VALUE, "", "hello", "ünïcödé 世界 🌍"];
  const { dstValues } = marshalArgv(hostCtx.ctx, wasmCtx.ctx, hostHandles, "host");
  for (let i = 0; i < expected.length; i++) {
    assertEq(dstValues[i], expected[i], `primitive[${i}] (${typeof expected[i]})`);
  }
}

console.log("\n[probe] === objects: plain object, array, nested ===");
{
  const plain = { a: 1, b: "x" };
  const arr = [1, 2, "x"];
  const nested = { inner: { deep: [1, [2, [3]]] } };

  // Mint object handles in host; marshal to wasm.
  const hostHandles = [
    Number(hostCtx.ctx.napiValueFromJsValue(plain)),
    Number(hostCtx.ctx.napiValueFromJsValue(arr)),
    Number(hostCtx.ctx.napiValueFromJsValue(nested)),
  ];
  const { dstValues } = marshalArgv(hostCtx.ctx, wasmCtx.ctx, hostHandles, "host");

  // Identity preservation: the receiver should get the SAME JS object
  // references — we share them via the identity map, so === holds.
  assertEq(dstValues[0], plain,  "plain object identity preserved");
  assertEq(dstValues[1], arr,    "array identity preserved");
  assertEq(dstValues[2], nested, "nested object identity preserved");
  // Sanity-check structural equality too:
  assertDeepEq(dstValues[0], { a: 1, b: "x" }, "plain object content");
  assertDeepEq(dstValues[1], [1, 2, "x"],      "array content");
}

console.log("\n[probe] === object identity preservation across two calls ===");
{
  // Call host closure twice with the SAME host object.  Verify
  // wasm side gets the same wasm-context handle both times.
  const sharedObj = { shared: true, count: 0 };
  const hostHandle = Number(hostCtx.ctx.napiValueFromJsValue(sharedObj));

  const r1 = marshalArgv(hostCtx.ctx, wasmCtx.ctx, [hostHandle], "host");
  const r2 = marshalArgv(hostCtx.ctx, wasmCtx.ctx, [hostHandle], "host");

  assertEq(r1.dstValues[0], sharedObj, "call 1: wasm sees shared host object");
  assertEq(r2.dstValues[0], sharedObj, "call 2: wasm sees same host object");
  // Note: r1.dstHandles[0] vs r2.dstHandles[0] are FRESH wasm handles
  // each call (they're allocated on whatever scope is current in
  // wasmCtx).  Identity preservation is at the JS-value layer, not the
  // handle-id layer.  This matches Node's real behaviour: a fresh
  // handle per call, but the underlying object identity is preserved.
  console.log(`  [info] r1.dstHandle=${r1.dstHandles[0]} r2.dstHandle=${r2.dstHandles[0]} (fresh handles per call, object identity preserved)`);
}

console.log("\n[probe] === return value: wasm → host ===");
{
  // Simulate the funcref returning a wasm-context handle for each
  // value kind, marshal that handle back to host, verify host can
  // deref the resulting host-context handle to the same value.
  const cases = [
    ["int32", 7],
    ["string", "result"],
    ["null", null],
    ["object", { result: true }],
    ["array", [10, 20, 30]],
  ];
  for (const [label, value] of cases) {
    const wasmHandle = Number(wasmCtx.ctx.napiValueFromJsValue(value));
    const { dstValues, dstHandles } = marshalArgv(wasmCtx.ctx, hostCtx.ctx, [wasmHandle], "wasm");
    // dstHandles[0] is now a HOST-context handle.  Deref via hostCtx.
    const hostDeref = hostCtx.ctx.jsValueFromNapiValue(dstHandles[0]);
    if (typeof value === "object" && value !== null) {
      assertEq(hostDeref, value, `return ${label} (identity)`);
    } else {
      assertEq(hostDeref, value, `return ${label}`);
    }
  }
}

// ─── Per-call latency by value kind ───────────────────────────────

console.log("\n[probe] === per-call latency by value kind ===");
{
  const ITER = 10000;
  const kinds = [
    ["undefined", undefined],
    ["null",      null],
    ["bool",      true],
    ["int32",     42],
    ["double",    3.14159],
    ["string-7",  "hello!!"],
    ["string-100", "x".repeat(100)],
    ["object",    { a: 1, b: "y", c: [1, 2, 3] }],
    ["array-10",  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ];
  console.log(`  | kind        | per-call ns | per-call µs |`);
  console.log(`  |-------------|------------:|------------:|`);
  for (const [name, value] of kinds) {
    // Mint once on host; marshal repeatedly host→wasm
    const hostHandle = Number(hostCtx.ctx.napiValueFromJsValue(value));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) {
      marshalArgv(hostCtx.ctx, wasmCtx.ctx, [hostHandle], "host");
    }
    const t1 = process.hrtime.bigint();
    const perCallNs = Number(t1 - t0) / ITER;
    console.log(`  | ${name.padEnd(11)} | ${String(Math.round(perCallNs)).padStart(11)} | ${(perCallNs / 1000).toFixed(2).padStart(11)} |`);
  }

  // Bundled argv of 4 args (typical realistic napi callback):
  {
    const handles = [
      Number(hostCtx.ctx.napiValueFromJsValue(42)),
      Number(hostCtx.ctx.napiValueFromJsValue("event")),
      Number(hostCtx.ctx.napiValueFromJsValue(true)),
      Number(hostCtx.ctx.napiValueFromJsValue({ ts: Date.now() })),
    ];
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) {
      marshalArgv(hostCtx.ctx, wasmCtx.ctx, handles, "host");
    }
    const t1 = process.hrtime.bigint();
    const perCallNs = Number(t1 - t0) / ITER;
    console.log(`  | argv-4-mixed | ${String(Math.round(perCallNs)).padStart(10)} | ${(perCallNs / 1000).toFixed(2).padStart(11)} |`);
  }
}

// ─── Identity-map growth over 10k calls ───────────────────────────

console.log("\n[probe] === identity-map memory growth ===");
{
  // Use a fresh identity map so we don't conflate prior probe state.
  const localMap = new IdentityMap();
  const origMap = identityMap;
  // Temporarily rebind by monkey-patching put/get -- but cleaner: just
  // measure the size before/after and the distinct-object growth.
  const beforeSize = identityMap.size();

  const N_DISTINCT = 500;
  const distinctObjects = [];
  for (let i = 0; i < N_DISTINCT; i++) {
    distinctObjects.push({ idx: i, name: `obj-${i}` });
  }

  const handles = distinctObjects.map((o) => Number(hostCtx.ctx.napiValueFromJsValue(o)));

  // 10k marshal calls, picking a random distinct object each time.
  const ITER = 10_000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i++) {
    const k = i % N_DISTINCT;
    marshalArgv(hostCtx.ctx, wasmCtx.ctx, [handles[k]], "host");
  }
  const t1 = process.hrtime.bigint();
  const afterSize = identityMap.size();
  const perCallNs = Number(t1 - t0) / ITER;

  const newEntries = afterSize - beforeSize;
  console.log(`  | ${ITER} marshal calls of ${N_DISTINCT} distinct objects |`);
  console.log(`  | identity-map entries added: ${newEntries}`);
  console.log(`  | per-call ns: ${Math.round(perCallNs)}`);
  console.log(`  | expected entries: ${N_DISTINCT} (one per distinct object, regardless of call count)`);
  const ok = newEntries === N_DISTINCT;
  console.log(`  ${ok ? "PASS" : "FAIL"}: identity-map deduplicates`);
  if (!ok) process.exitCode = 1;
}

// ─── End-to-end: host JS closure → wasm funcref → return ──────────
//
// This is the full reverse-RPC roundtrip shape, minus the actual
// SAB wire (we test marshaling logic, not transport).

console.log("\n[probe] === full host-closure → wasm-funcref → return ===");
{
  // The wasm-side funcref takes (env, cbinfo) → napi_value.  In the
  // production wiring (per R7's spec), the wasm-side handler will
  //   1. decode the marshaled argv bytes → JS values
  //   2. mint fresh wasm-context handles via napiValueFromJsValue
  //   3. openScope; set cbinfo.args = those wasm handles' JS values
  //   4. invoke fn(env, scope.id)
  //   5. fn returns a wasm-context handle
  //   6. deref → JS value, marshal back to host
  // We exercise the marshal layer here.
  function wasmSideFuncref(args) {
    // emulate: sum int32 args, append "ok", return as array
    const sum = args.filter((a) => typeof a === "number").reduce((s, a) => s + a, 0);
    return { sum, label: "ok", got: args };
  }

  function hostSideClosure(...hostHandles) {
    // 1. Marshal argv from host → wasm
    const fwd = marshalArgv(hostCtx.ctx, wasmCtx.ctx, hostHandles.map(Number), "host");
    // 2. Invoke the funcref with wasm-context values (production:
    //    wasm-side handler mints scope.callbackInfo.args from these)
    const returnedValue = wasmSideFuncref(fwd.dstValues);
    // 3. Re-mint the return as a wasm-context handle (production:
    //    funcref returns a wasm handle directly)
    const wasmReturnHandle = Number(wasmCtx.ctx.napiValueFromJsValue(returnedValue));
    // 4. Marshal return wasm → host
    const back = marshalArgv(wasmCtx.ctx, hostCtx.ctx, [wasmReturnHandle], "wasm");
    return back.dstHandles[0]; // host-context handle
  }

  const h1 = Number(hostCtx.ctx.napiValueFromJsValue(10));
  const h2 = Number(hostCtx.ctx.napiValueFromJsValue(20));
  const h3 = Number(hostCtx.ctx.napiValueFromJsValue("ignored"));

  const returnedHostHandle = hostSideClosure(h1, h2, h3);
  const hostSeesReturn = hostCtx.ctx.jsValueFromNapiValue(returnedHostHandle);
  assertEq(hostSeesReturn.sum, 30, "end-to-end: sum int32 args");
  assertEq(hostSeesReturn.label, "ok", "end-to-end: label");
  assertEq(hostSeesReturn.got.length, 3, "end-to-end: argc");
  assertEq(hostSeesReturn.got[2], "ignored", "end-to-end: string arg preserved");
}

console.log("\n[probe] " + (process.exitCode ? "FAILED" : "PASSED"));
