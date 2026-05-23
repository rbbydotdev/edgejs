// R5 — per-op diff-test harness pattern.
//
// Goal: prove a harness pattern that, for every napi op in the lever-b
// cutover, can run the op BOTH WAYS (in-process emnapi vs via-RPC to a
// host worker) with the SAME logical input and assert outputs match.
//
// Why two contexts?  The diff is between transports, not between
// implementations.  We instantiate emnapi TWICE so each side owns an
// independent handle store / scope chain / wasm memory.  That mirrors
// the production reality where the in-process path lives in the wasm
// worker and the RPC path lives on the host worker.
//
// Why fake the RPC?  The transport is validated separately (see
// l5-real-roundtrip).  Here we isolate the COMPARISON pattern: how do
// you express "run this op through transport X" once and diff the
// outputs cleanly?  The fake transport is a closure that performs the
// op on the "host" context — same shape, no SAB, no workers.
//
// Diff boundary: napi_status (the integer return code) PLUS the bytes
// the op wrote into the result_ptr region of wasm memory.  Higher
// boundaries (JS value equality) are tempting but break down for ops
// that return handle IDs — those legitimately differ across contexts.
// Lower boundaries (the emnapi internals) overfit to a specific
// implementation and would couple tests to upstream emnapi changes.
//
// Non-determinism handling:
//   - HANDLE IDs:   normalized via a per-context renumbering table.
//                   First time a handle appears on side A → "h1"; same
//                   logical handle on side B → "h1" too.  Mismatch in
//                   the renumbered stream = real divergence.
//   - POINTERS:     not surfaced in result bytes for the ops we test
//                   here (read-only ops write u32 handle IDs, ints,
//                   bools, or enum values).  Ops that DO return raw
//                   wasm pointers (napi_get_buffer_info etc.) need a
//                   pointer-normalization pass — sketched in the
//                   `normalize` helper but not exercised by this probe.
//   - GC values:    n/a for read-only ops; finalizer-bearing ops are
//                   flagged as out-of-scope (see FINDINGS.md).

import { createContext } from "@emnapi/runtime";
import { createNapiModule } from "@emnapi/core";

// ─────────────────────────────────────────────────────────────────────
// Stub-wasm boilerplate.  Both sides need a minimal "wasm" environment
// so emnapi's `init()` doesn't throw.  Identical setup per side.
// ─────────────────────────────────────────────────────────────────────
function makeSide(label) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const wasmModule = new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ]));
  const stubTable = new WebAssembly.Table({ initial: 1, element: "anyfunc" });

  let bumpNext = 1024; // simple bump allocator for result-ptr slots
  const instance = {
    exports: {
      memory,
      malloc: (size) => {
        const p = bumpNext;
        bumpNext += (size + 7) & ~7;
        return p;
      },
      free: () => {},
      __indirect_function_table: stubTable,
      emnapi_create_env: () => 1,
      emnapi_delete_env: () => 0,
      emnapi_runtime_init: () => {},
      emnapi_runtime_finalize: () => {},
      napi_register_wasm_v1: () => 0,
    },
  };

  const ctx = createContext();
  const napiModule = createNapiModule({
    context: ctx,
    childThread: false,
    asyncWorkPoolSize: 0,
  });
  napiModule.init({ instance, module: wasmModule, memory, table: stubTable });
  const napi = napiModule.imports.napi;

  // Create a real napi env + open a handle scope.  Without an open
  // scope, `napi_create_int32` etc. throw because emnapi has nowhere
  // to store the new handle.  Mirrors the production
  // `unofficial_napi_create_env` flow in browser-target/.
  const envObj = ctx.createEnv(
    label,
    8,
    (() => () => undefined),
    (() => () => undefined),
    (msg) => { throw new Error(`napi abort (${label}): ${msg ?? "(no message)"}`); },
    undefined,
  );
  const scope = ctx.openScope(envObj);
  void scope; // kept open for the duration of the probe
  const env = envObj.id;

  // Each side gets its own scratch region of wasm memory to write
  // result bytes into.  `alloc(n)` returns a pointer.  Side A and side
  // B addresses may differ — that's fine, we only diff bytes AT the
  // pointer, never the pointer itself.
  function alloc(n) {
    const p = bumpNext;
    bumpNext += (n + 7) & ~7;
    return p;
  }

  function readBytes(ptr, n) {
    return new Uint8Array(memory.buffer.slice(ptr, ptr + n));
  }

  // Stash a JS value as a napi handle so we can hand its handle id to
  // napi ops.  Mirrors what wasm-internal would do via napi_create_*.
  // We bypass the napi_create_* round-trip because some types (arrays,
  // null) don't have a direct create-fn — and our goal is the diff
  // pattern, not input-handle creation.
  function stash(value) {
    return ctx.napiValueFromJsValue(value);
  }

  return { label, ctx, napi, memory, env, alloc, readBytes, stash };
}

const A = makeSide("in-process"); // simulates the wasm-internal path
const B = makeSide("via-rpc");    // simulates the host-worker path

// ─────────────────────────────────────────────────────────────────────
// Faked RPC transport.  Real production code packs args into a SAB,
// notifies the host, blocks on a reply.  Here we just call the host
// side's napi fn directly — SAME SHAPE, no wire encoding.  Wire-level
// encoding bugs are out of scope; that's what l5-real-roundtrip covers.
// ─────────────────────────────────────────────────────────────────────
function fakeRpc(opName, ...args) {
  const fn = B.napi[opName];
  if (typeof fn !== "function") throw new Error(`fakeRpc: ${opName} not in host napi`);
  return fn(...args);
}

// ─────────────────────────────────────────────────────────────────────
// Handle normalization.  Each side has its own handle ID space.  When
// an op writes a handle id into result bytes, both sides will write
// DIFFERENT integers for the same logical value (e.g. side A's
// `undefined` is handle 4, side B's is handle 7).  We map each side's
// stream of "handle-shaped" u32s into a canonical sequence (h1, h2, …)
// so two correct runs produce identical canonical streams.
//
// We don't know a priori which bytes in the result are handle IDs vs
// pointers vs raw integers — the harness needs that hint per-op via a
// `resultShape` descriptor.  See test cases below.
// ─────────────────────────────────────────────────────────────────────
function normalizeResult(sideLabel, ptr, shape, readBytes, ctx) {
  if (shape.kind === "u32" || shape.kind === "i32" || shape.kind === "bool") {
    const bytes = readBytes(ptr, 4);
    const dv = new DataView(bytes.buffer);
    const raw = shape.kind === "i32" ? dv.getInt32(0, true) : dv.getUint32(0, true);
    return { kind: shape.kind, value: raw };
  }
  if (shape.kind === "handle") {
    const bytes = readBytes(ptr, 4);
    const dv = new DataView(bytes.buffer);
    const handleId = dv.getUint32(0, true);
    // Canonical form: resolve to JS value + its typeof — that's
    // comparable across contexts.  For object-typed handles we fall
    // back to a structural tag.
    const value = ctx.jsValueFromNapiValue(handleId);
    const t = typeof value;
    if (value === null) return { kind: "handle", canon: "null" };
    if (value === undefined) return { kind: "handle", canon: "undefined" };
    if (t === "boolean" || t === "number" || t === "string") {
      return { kind: "handle", canon: `${t}:${value}` };
    }
    return { kind: "handle", canon: `${t}:<opaque>` };
  }
  if (shape.kind === "enum") {
    const bytes = readBytes(ptr, 4);
    const dv = new DataView(bytes.buffer);
    return { kind: "enum", value: dv.getUint32(0, true) };
  }
  throw new Error(`normalizeResult: unknown shape ${shape.kind}`);
}

// ─────────────────────────────────────────────────────────────────────
// Test-case DSL.  Each case names the op, supplies a thunk that
// produces the input handles ON A GIVEN SIDE (so the same JS value
// gets stashed into each side's handle store independently), and
// declares the result shape.  Status + normalized result are diffed.
// ─────────────────────────────────────────────────────────────────────
const cases = [
  {
    op: "napi_get_undefined",
    // No input handles; just call (env, result_ptr).
    setup: () => ({ args: [] }),
    call: (side, _args, resultPtr) => side.napi.napi_get_undefined(side.env, resultPtr),
    resultShape: { kind: "handle" },
  },
  {
    op: "napi_typeof",
    // Input: a JS string → its handle.  Same JS value stashed on each
    // side gives different handle ids; diff on the typeof RESULT, not
    // on the input handle id.
    setup: (side) => ({ args: [side.stash("hello")] }),
    call: (side, args, resultPtr) =>
      side.napi.napi_typeof(side.env, args[0], resultPtr),
    resultShape: { kind: "enum" }, // napi_valuetype enum (string=4)
  },
  {
    op: "napi_is_array",
    setup: (side) => ({ args: [side.stash([1, 2, 3])] }),
    call: (side, args, resultPtr) =>
      side.napi.napi_is_array(side.env, args[0], resultPtr),
    resultShape: { kind: "bool" },
  },
  {
    op: "napi_get_value_int32",
    setup: (side) => ({ args: [side.stash(42)] }),
    call: (side, args, resultPtr) =>
      side.napi.napi_get_value_int32(side.env, args[0], resultPtr),
    resultShape: { kind: "i32" },
  },
  {
    op: "napi_strict_equals",
    // Two handles to the SAME logical value.  Result is a bool.  We
    // don't expect handle equality across stashes (each `stash` is a
    // fresh handle), so the answer here is FALSE — but it's the same
    // false on both sides, which is what we care about.
    setup: (side) => ({
      args: [side.stash("xyz"), side.stash("xyz")],
    }),
    call: (side, args, resultPtr) =>
      side.napi.napi_strict_equals(side.env, args[0], args[1], resultPtr),
    resultShape: { kind: "bool" },
  },
];

// ─────────────────────────────────────────────────────────────────────
// Diff runner.
// ─────────────────────────────────────────────────────────────────────
function diffOne(c) {
  // SIDE A — in-process
  const aSetup = c.setup(A);
  const aPtr = A.alloc(8);
  const aStatus = c.call(A, aSetup.args, aPtr);
  const aResult = normalizeResult(A.label, aPtr, c.resultShape, A.readBytes, A.ctx);

  // SIDE B — via fake RPC.  The setup runs against the B context so
  // handles live in B's store.  The call goes through fakeRpc, which
  // dispatches to B.napi[opName] — same shape as the production RPC.
  const bSetup = c.setup(B);
  const bPtr = B.alloc(8);
  const bStatus = fakeRpc(c.op, B.env, ...bSetup.args, bPtr);
  const bResult = normalizeResult(B.label, bPtr, c.resultShape, B.readBytes, B.ctx);

  const statusMatch = aStatus === bStatus;
  const resultMatch = JSON.stringify(aResult) === JSON.stringify(bResult);
  const ok = statusMatch && resultMatch;
  return { op: c.op, ok, aStatus, bStatus, aResult, bResult };
}

const results = cases.map(diffOne);
let passed = 0;
for (const r of results) {
  const tag = r.ok ? "PASS" : "FAIL";
  console.log(
    `[${tag}] ${r.op}  ` +
    `status A=${r.aStatus} B=${r.bStatus}  ` +
    `result A=${JSON.stringify(r.aResult)} B=${JSON.stringify(r.bResult)}`,
  );
  if (r.ok) passed++;
}

const total = results.length;
console.log(`\n${passed}/${total} ops diffed clean.`);
process.exit(passed === total ? 0 : 1);
