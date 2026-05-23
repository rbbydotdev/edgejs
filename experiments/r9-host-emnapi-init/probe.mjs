// R9 — isolate host-worker.ts's emnapi init pattern; reproduce the F-9
// sweep probe findings (null=0, create_object/int32/string fail);
// identify root cause; demonstrate a fix.
//
// We deliberately use browser-target's installed (node_modules) emnapi
// — same exact version host-worker.ts pulls — so any reproduction here
// translates directly to the production bug.

import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

// ─── Expected per @emnapi/runtime v1.10.0 (browser-target node_modules) ──
//   GlobalHandle.UNDEFINED = 1
//   GlobalHandle.NULL      = 2
//   GlobalHandle.FALSE     = 3
//   GlobalHandle.TRUE      = 4
//   GlobalHandle.GLOBAL    = 5
const EXPECTED = { UNDEFINED: 1, NULL: 2, GLOBAL: 5 };

function bootHostStyle({ openScope }) {
  // EXACT same init as host-worker.ts ensureNapiContext() does today.
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16, shared: true });
  const wasmModule = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ]));
  const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
  let poolNext = 16384;
  const stubInstance = {
    exports: {
      memory,
      malloc: (size) => { const ptr = poolNext; poolNext += (size + 7) & ~7; return ptr; },
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
  const memU32 = new Uint32Array(memory.buffer);

  let scopeStatus = "(none-opened)";
  if (openScope) {
    const SCOPE_OUT = 1020;
    const s = napi.napi_open_handle_scope(1, SCOPE_OUT);
    scopeStatus = `napi_open_handle_scope status=${s}`;
  }

  return { ctx, napi, napiModule, memory, memU32, scopeStatus, alloc: (n = 4) => { const p = poolNext; poolNext += (n + 7) & ~7; return p; } };
}

function sectionHeader(t) { console.log(`\n══════════════════ ${t} ══════════════════`); }

// ─── EXPERIMENT 1: REPRODUCE THE BUG (no scope opened) ────────────────
sectionHeader("EXPERIMENT 1: host-worker.ts pattern exactly (NO scope opened)");

const ENV = 1;
const RESULT_PTR_UNDEF = 100;
const RESULT_PTR_NULL = 200;
const RESULT_PTR_GLOBAL = 300;

const broken = bootHostStyle({ openScope: false });
console.log(`init: ${broken.scopeStatus}`);
console.log(`napi fns available: ${Object.keys(broken.napi).length}`);

// Inspect internal state.
console.log("\n── internal context state ──");
console.log(`envStore._size: ${broken.ctx.envStore._size}`);
console.log(`envStore.has(1): ${broken.ctx.envStore.has(1)}`);
console.log(`envStore._values: ${broken.ctx.envStore._values.slice(0, 4).map((v, i) => v ? `[${i}]=Env#${v.id}` : `[${i}]=undefined`).join(', ')}`);
const env1 = broken.ctx.envStore.get(1);
console.log(`envStore.get(1) is null? ${env1 == null}`);
if (env1) {
  console.log(`env1 ctor: ${env1.constructor.name}, env1.id=${env1.id}, env1.filename='${env1.filename}'`);
}
console.log(`scopeStore.currentScope: ${broken.ctx.scopeStore.currentScope ? `id=${broken.ctx.scopeStore.currentScope.id}` : "null"}`);

console.log("\n── direct napi calls (matching probe-f9-sweep symptom claim) ──");
const sU = broken.napi.napi_get_undefined(ENV, RESULT_PTR_UNDEF);
const wU = broken.memU32[RESULT_PTR_UNDEF / 4];
console.log(`napi_get_undefined(1, ${RESULT_PTR_UNDEF}) status=${sU} mem[ptr]=${wU} (expect ${EXPECTED.UNDEFINED})`);

const sN = broken.napi.napi_get_null(ENV, RESULT_PTR_NULL);
const wN = broken.memU32[RESULT_PTR_NULL / 4];
console.log(`napi_get_null(1, ${RESULT_PTR_NULL})      status=${sN} mem[ptr]=${wN} (expect ${EXPECTED.NULL})`);

const sG = broken.napi.napi_get_global(ENV, RESULT_PTR_GLOBAL);
const wG = broken.memU32[RESULT_PTR_GLOBAL / 4];
console.log(`napi_get_global(1, ${RESULT_PTR_GLOBAL})    status=${sG} mem[ptr]=${wG} (expect ${EXPECTED.GLOBAL})`);

console.log("\n── now try napi_create_object/int32/string (the F-9 sweep failures) ──");
function tryCall(label, fn) {
  try {
    const status = fn();
    return { ok: true, status };
  } catch (e) {
    return { ok: false, status: null, err: e };
  }
}

const objOut = broken.alloc();
const r1 = tryCall("create_object", () => broken.napi.napi_create_object(ENV, objOut));
const handleObj = broken.memU32[objOut / 4];
console.log(`napi_create_object   ${r1.ok ? `status=${r1.status}` : `THREW: ${r1.err.constructor.name}: ${r1.err.message}`} handle=${handleObj}`);
let sCreateObj = r1.status;

const intOut = broken.alloc();
const r2 = tryCall("create_int32", () => broken.napi.napi_create_int32(ENV, 42, intOut));
const handleInt = broken.memU32[intOut / 4];
console.log(`napi_create_int32    ${r2.ok ? `status=${r2.status}` : `THREW: ${r2.err.message}`} handle=${handleInt}`);

const strBytes = new TextEncoder().encode("hello");
const strPtr = broken.alloc(strBytes.byteLength + 4);
new Uint8Array(broken.memory.buffer, strPtr, strBytes.byteLength).set(strBytes);
const strOut = broken.alloc();
const r3 = tryCall("create_string_utf8", () => broken.napi.napi_create_string_utf8(ENV, strPtr, strBytes.byteLength, strOut));
const handleStr = broken.memU32[strOut / 4];
console.log(`napi_create_string   ${r3.ok ? `status=${r3.status}` : `THREW: ${r3.err.message}`} handle=${handleStr}`);

const typeofOut = broken.alloc();
const r4 = tryCall("typeof", () => broken.napi.napi_typeof(ENV, EXPECTED.GLOBAL, typeofOut));
const typeofVal = broken.memU32[typeofOut / 4];
console.log(`napi_typeof(GLOBAL)  ${r4.ok ? `status=${r4.status}` : `THREW: ${r4.err.message}`} typeof=${typeofVal} (expect 6 = napi_object)`);

// ─── EXPERIMENT 2: FIX — open a handle scope first ────────────────────
sectionHeader("EXPERIMENT 2: same setup but with napi_open_handle_scope FIRST");

const fixed = bootHostStyle({ openScope: true });
console.log(`init: ${fixed.scopeStatus}`);
console.log(`scopeStore.currentScope: ${fixed.ctx.scopeStore.currentScope ? `id=${fixed.ctx.scopeStore.currentScope.id}` : "null"}`);

console.log("\n── direct napi calls ──");
const fU = fixed.napi.napi_get_undefined(ENV, RESULT_PTR_UNDEF);
console.log(`napi_get_undefined  status=${fU} mem=${fixed.memU32[RESULT_PTR_UNDEF / 4]} (expect ${EXPECTED.UNDEFINED})`);
const fN = fixed.napi.napi_get_null(ENV, RESULT_PTR_NULL);
console.log(`napi_get_null       status=${fN} mem=${fixed.memU32[RESULT_PTR_NULL / 4]} (expect ${EXPECTED.NULL})`);
const fG = fixed.napi.napi_get_global(ENV, RESULT_PTR_GLOBAL);
console.log(`napi_get_global     status=${fG} mem=${fixed.memU32[RESULT_PTR_GLOBAL / 4]} (expect ${EXPECTED.GLOBAL})`);

const objOut2 = fixed.alloc();
const sCreateObj2 = fixed.napi.napi_create_object(ENV, objOut2);
const handleObj2 = fixed.memU32[objOut2 / 4];
console.log(`napi_create_object  status=${sCreateObj2} handle=${handleObj2}`);

const intOut2 = fixed.alloc();
const sCreateInt2 = fixed.napi.napi_create_int32(ENV, 42, intOut2);
const handleInt2 = fixed.memU32[intOut2 / 4];
console.log(`napi_create_int32   status=${sCreateInt2} handle=${handleInt2}`);

const strBytes2 = new TextEncoder().encode("hello");
const strPtr2 = fixed.alloc(strBytes2.byteLength + 4);
new Uint8Array(fixed.memory.buffer, strPtr2, strBytes2.byteLength).set(strBytes2);
const strOut2 = fixed.alloc();
const sCreateStr2 = fixed.napi.napi_create_string_utf8(ENV, strPtr2, strBytes2.byteLength, strOut2);
const handleStr2 = fixed.memU32[strOut2 / 4];
console.log(`napi_create_string  status=${sCreateStr2} handle=${handleStr2}`);

const typeofOut2 = fixed.alloc();
const sTypeof2 = fixed.napi.napi_typeof(ENV, handleObj2, typeofOut2);
console.log(`napi_typeof(object) status=${sTypeof2} typeof=${fixed.memU32[typeofOut2 / 4]} (expect 6 = napi_object)`);

const typeofOut3 = fixed.alloc();
const sTypeof3 = fixed.napi.napi_typeof(ENV, EXPECTED.GLOBAL, typeofOut3);
console.log(`napi_typeof(GLOBAL) status=${sTypeof3} typeof=${fixed.memU32[typeofOut3 / 4]} (expect 6)`);

// ─── EXPERIMENT 3: probe-f9-sweep memory layout (ptrs > 256, far apart) ───
sectionHeader("EXPERIMENT 3: replicate probe-f9-sweep memory layout exactly");
//
// probe-f9-sweep uses ptr starting at 400, alloc adds n bytes each call.
// Maybe the bug is memory-write-collision rather than scope-related.
// Replicate the exact pointer math to rule that out.

const sweepClone = bootHostStyle({ openScope: false });
let sweepPtr = 400;
const sweepAlloc = (n = 4) => { const p = sweepPtr; sweepPtr += n; return p; };

function tryAt(label, ptr, fn) {
  try {
    const status = fn();
    return { ok: true, status, handle: sweepClone.memU32[ptr / 4] };
  } catch (e) {
    return { ok: false, status: null, handle: sweepClone.memU32[ptr / 4], err: e };
  }
}

const outCreateObj = sweepAlloc();
const r5 = tryAt("create_object", outCreateObj, () => sweepClone.napi.napi_create_object(1, outCreateObj));
console.log(`create_object @${outCreateObj}: ${r5.ok ? `status=${r5.status}` : `THREW: ${r5.err.message}`} handle=${r5.handle}`);

const outArr = sweepAlloc();
const r6 = tryAt("create_array_with_length", outArr, () => sweepClone.napi.napi_create_array_with_length(1, 5, outArr));
console.log(`create_array_with_length @${outArr}: ${r6.ok ? `status=${r6.status}` : `THREW: ${r6.err.message}`} handle=${r6.handle}`);

const outInt32 = sweepAlloc();
const r7 = tryAt("create_int32", outInt32, () => sweepClone.napi.napi_create_int32(1, 42, outInt32));
console.log(`create_int32 @${outInt32}: ${r7.ok ? `status=${r7.status}` : `THREW: ${r7.err.message}`} handle=${r7.handle}`);

// Now ALSO with scope opened — same memory layout.
sectionHeader("EXPERIMENT 3b: probe-f9-sweep layout WITH scope");
const sweepFixed = bootHostStyle({ openScope: true });
let fPtr = 400;
const fAlloc = (n = 4) => { const p = fPtr; fPtr += n; return p; };
const fObjOut = fAlloc();
const fObj = sweepFixed.napi.napi_create_object(1, fObjOut);
console.log(`create_object @${fObjOut}: status=${fObj} handle=${sweepFixed.memU32[fObjOut / 4]}`);
const fArrOut = fAlloc();
const fArr = sweepFixed.napi.napi_create_array_with_length(1, 5, fArrOut);
console.log(`create_array_with_length @${fArrOut}: status=${fArr} handle=${sweepFixed.memU32[fArrOut / 4]}`);
const fIntOut = fAlloc();
const fInt = sweepFixed.napi.napi_create_int32(1, 42, fIntOut);
console.log(`create_int32 @${fIntOut}: status=${fInt} handle=${sweepFixed.memU32[fIntOut / 4]}`);

// ─── EXPERIMENT 4: napi_get_null specifically @ different ptrs ────────
sectionHeader("EXPERIMENT 4: napi_get_null at many different ptrs (bug-specific)");
//
// The user's claim was undefined/global=correct but null=0.  That is
// surprising because the three functions are identical.  Let's call
// null at many different memory addresses to see if there's an offset
// effect or a state issue.

const nullProbe = bootHostStyle({ openScope: false });
for (const ptr of [100, 200, 300, 400, 800, 1024, 2048, 4096]) {
  const s = nullProbe.napi.napi_get_null(1, ptr);
  const v = nullProbe.memU32[ptr / 4];
  console.log(`napi_get_null(1, ${ptr}) status=${s} mem=${v}`);
}

// ─── EXPERIMENT 5: what does typeof(handle=0) yield? ──────────────────
sectionHeader("EXPERIMENT 5: napi_typeof reading from raw memory zero");
//
// In probe-f9-sweep, the message says 'napi_typeof of supposedly-valid
// global handle returns 0 (undefined)'.  If the wasm-side memU32 read
// returned 0 because the host wrote to host-local memory not shared,
// then typeof(0) might also explain.  But here we read host-side, so
// it should work.

const typeProbe = bootHostStyle({ openScope: true });
const tOut = typeProbe.alloc();
const sTyp = typeProbe.napi.napi_typeof(1, 5, tOut);  // 5 = GLOBAL
console.log(`napi_typeof(env=1, value=GLOBAL=5) status=${sTyp} typeof=${typeProbe.memU32[tOut / 4]} (expect 6)`);

const tOut2 = typeProbe.alloc();
const sTyp0 = typeProbe.napi.napi_typeof(1, 0, tOut2);
console.log(`napi_typeof(env=1, value=0)        status=${sTyp0} typeof=${typeProbe.memU32[tOut2 / 4]}`);

// ─── EXPERIMENT 6: try without root scope but with napi_create on it ──
sectionHeader("EXPERIMENT 6: rerun the broken get_null - does scope matter?");

// At this point we've already done many calls on `broken` (no scope).
// Bug claim was null=0. Let's re-call after global succeeded.
const reN = broken.napi.napi_get_null(1, 600);
console.log(`napi_get_null AFTER undef+global succeeded: status=${reN} mem=${broken.memU32[600 / 4]} (expect 2)`);

// ─── Summary ──────────────────────────────────────────────────────────
sectionHeader("VERDICT");
const reproUndef = wU === EXPECTED.UNDEFINED;
const reproNullBroken = wN !== EXPECTED.NULL;
const reproGlobal = wG === EXPECTED.GLOBAL;
const reproCreateObjFail = !r1.ok || r1.status !== 0 || handleObj === 0;
const fixWorks = sCreateObj2 === 0 && handleObj2 !== 0
              && sCreateInt2 === 0 && handleInt2 !== 0
              && sCreateStr2 === 0 && handleStr2 !== 0;

console.log(`undefined returns 1 (correct): ${reproUndef ? "YES" : "NO"} (got ${wU})`);
console.log(`null bug reproduces (not 2):   ${reproNullBroken ? "YES" : "NO"} (got ${wN})`);
console.log(`global returns 5 (correct):    ${reproGlobal ? "YES" : "NO"} (got ${wG})`);
console.log(`create_object fails without scope: ${reproCreateObjFail ? "YES" : "NO"} (${r1.ok ? `status=${r1.status}` : `THREW: ${r1.err.message}`}, handle=${handleObj})`);
console.log(`opening scope fixes everything:    ${fixWorks ? "YES" : "NO"}`);
