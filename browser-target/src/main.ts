import { attachBridgeRing, publishBridgeRequest } from "./wasi-shim/bridge-sab";

const logEl = document.getElementById("log") as HTMLPreElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const filterEl = document.getElementById("filter") as HTMLInputElement;

interface LogEntry { text: string; level: string; node: HTMLSpanElement; }
const allEntries: LogEntry[] = [];

function append(line: string, level: string = "info") {
  const span = document.createElement("span");
  span.className = `lvl-${level}`;
  span.textContent = line + "\n";
  logEl.appendChild(span);
  allEntries.push({ text: line, level, node: span });
  applyFilterToEntry(line, span);
}

function applyFilterToEntry(text: string, node: HTMLSpanElement) {
  const q = filterEl?.value.trim().toLowerCase() ?? "";
  if (!q) { node.style.display = ""; return; }
  node.style.display = text.toLowerCase().includes(q) ? "" : "none";
}

filterEl?.addEventListener("input", () => {
  for (const e of allEntries) applyFilterToEntry(e.text, e.node);
});

if (typeof SharedArrayBuffer === "undefined") {
  append("FATAL: SharedArrayBuffer unavailable. COOP/COEP headers must be set.", "err");
  statusEl.textContent = "cross-origin isolation missing";
  throw new Error("crossOriginIsolated required");
}
if (!crossOriginIsolated) {
  append("WARNING: crossOriginIsolated=false. Shared memory may fail.", "warn");
}

// Bridge worker — owns the layered FS adapter and the FS snapshot
// loader.  Spawned first so it can publish its SAB before the runtime
// worker tries to attach.  See bridge-worker.ts for rationale.
const bridgeWorker = new Worker(new URL("./bridge-worker.ts", import.meta.url), { type: "module" });
let fsSnapshotSab: SharedArrayBuffer | null = null;

// Runtime worker — hosts the wasm runtime + JSPI.  Spawned after the
// bridge worker publishes its SAB so we can hand it through on spawn.
let worker: Worker | null = null;
const pendingMessagesForRuntime: unknown[] = [];
function postToRuntime(msg: unknown, transfer?: Transferable[]) {
  if (worker) {
    if (transfer && transfer.length > 0) worker.postMessage(msg, transfer);
    else worker.postMessage(msg);
  } else {
    pendingMessagesForRuntime.push(msg);
  }
}

bridgeWorker.onmessage = (e) => {
  const { kind } = e.data ?? {};
  if (kind === "log") {
    append(e.data.text, e.data.level ?? "info");
  } else if (kind === "bridge-ready") {
    fsSnapshotSab = e.data.fsSnapshotSab as SharedArrayBuffer;
    append("bridge worker ready; spawning host + runtime workers", "info");
    spawnHostThenRuntime();
  }
};

// L2 host worker.  Spawned alongside the runtime worker so napi RPC can
// flow between them via the SAB rings handed to both at boot.
//
// L5 cutover will route user JS + Node lib/*.js execution here; today
// the host worker only handles a `ping` op (proof of life).
import { spawnHostWorker, type HostWorkerHandle } from "./host-worker/worker-pool";

let hostHandle: HostWorkerHandle | null = null;

async function spawnHostThenRuntime(): Promise<void> {
  // Spawn host worker first so its SABs are ready when the runtime
  // worker boots — runtime needs them at instantiate time to wire
  // the RPC client into the wasi-shim.
  try {
    // bootScript: forwarded from the `executor64` URL param. Runs
    // inside the host worker at init, used by the child-process-via-executor
    // policy to install its async executor in host-worker context
    // (NOT on main -- main has zero runtime responsibility).
    hostHandle = spawnHostWorker({ bootScript: hostWorkerBootScript });
    // Install full message handler: host-log + spawn-user-worker (for
    // user code in primary host that calls `new Worker()`) +
    // user-worker-exit (forwarded from a child host).  Same handler
    // installed on every user-spawned host worker too.
    attachHostWorkerMessageHandlers(hostHandle);
    await hostHandle.ready;
    append("host worker ready", "info");
  } catch (err) {
    append(`host worker spawn failed: ${(err as Error).message}`, "err");
    return;
  }
  // L3 echo benchmark: if URL has ?bench=echo&iters=N, run the bench
  // BEFORE spawning the runtime worker so we have an idle host worker
  // and don't compete with edge.js boot traffic.
  if (benchEcho) {
    await runEchoBench(benchEcho.iters, benchEcho.payload);
  }
  // F-6: in host-script mode, skip the wasm runtime worker entirely —
  // the user script runs directly on host V8 via OP_RUN_USER_SCRIPT and
  // we emit the test-runner-compatible sentinel from main.ts itself.
  if (scriptViaHost && userScript !== null) {
    await runUserScriptOnHost(userScript, "test-runner");
    return;
  }
  spawnRuntimeWorker();
  // L4 reverse-echo probe: after runtime worker spawns and attaches its
  // reverse-channel server, the host worker can echo via that channel.
  // Triggered via ?probe=reverse-echo URL param.
  if (probeReverseEcho && hostHandle) {
    // Defer until runtime worker is reasonably alive — 500ms is enough
    // for the SAB handoff in practice; tighter would race the reverse
    // RpcServer's start.
    setTimeout(() => {
      hostHandle!.worker.postMessage({ kind: "reverse-echo", bytes: 64 });
    }, 500);
  }
  // L5 spike URL `?l5script=` — debug-format wrapper around the same
  // host-worker path that `?script=&host=1` uses.  Kept for ad-hoc
  // page-log inspection; programmatic callers should use the latter.
  if (l5UserScript && hostHandle) {
    await runUserScriptOnHost(l5UserScript, "debug");
  }
  // L9 spike: spawn a second host worker, ping both, verify replies
  // come back to the right one.  Validates the multi-host topology
  // and the contextId/hostWorkerId routing we baked in from L1.
  if (l9MultiHost) {
    await runL9MultiHostSpike();
  }
  // F-1 probe: call napi_get_undefined via RPC and verify the handle
  // is written into host's napi memory.  This is the first end-to-end
  // proof that the host emnapi context + RPC server work in main project.
  if (f1NapiProbe) {
    await runF1NapiProbe();
  }
  if (f9SweepProbe) {
    await runF9SweepProbe();
  }
  if (scopeBoundedProbe) {
    await runScopeBoundedProbe();
  }
}

async function runF1NapiProbe(): Promise<void> {
  if (!hostHandle) {
    append("f1-napi-probe: hostHandle not ready", "err");
    return;
  }
  if (!hostHandle.napiMemorySab) {
    append("f1-napi-probe: host didn't post napiMemorySab", "err");
    return;
  }
  const { attachRing } = await import("./wasi-shim/sab-ring");
  const { RpcClient } = await import("./host-worker/rpc-client");
  const proto = await import("./host-worker/rpc-protocol");
  const ringConfig = { numSlots: 256, slotSize: 4 * 1024 };
  const reqRing = attachRing(hostHandle.requestSab, ringConfig);
  const replyRing = attachRing(hostHandle.replySab, ringConfig);
  const client = new RpcClient(reqRing, replyRing);
  const napiMemU32 = new Uint32Array(hostHandle.napiMemorySab);

  async function callTwoArg(op: number, name: string, resultPtr: number) {
    const args = new Uint8Array(8);
    const dv = new DataView(args.buffer);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, resultPtr, true);
    const reply = await client.call(op, 0, 0, args);
    return { name, status: reply.status, handle: napiMemU32[resultPtr / 4] };
  }
  async function callThreeArg(op: number, name: string, valueHandle: number, resultPtr: number) {
    const args = new Uint8Array(12);
    const dv = new DataView(args.buffer);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, valueHandle, true);
    dv.setUint32(8, resultPtr, true);
    const reply = await client.call(op, 0, 0, args);
    return { name, status: reply.status, result: napiMemU32[resultPtr / 4] };
  }

  // F-1 originals.
  const r1 = await callTwoArg(proto.OP_NAPI_GET_UNDEFINED, "napi_get_undefined", 256);
  const r2 = await callTwoArg(proto.OP_NAPI_GET_NULL,      "napi_get_null",      260);
  const r3 = await callTwoArg(proto.OP_NAPI_GET_GLOBAL,    "napi_get_global",    264);

  // F-4: try a three-arg op against one of the F-1 handles.
  // napi_typeof(env, value, &result) — writes a small int (0=undefined, 1=null, ...).
  const t1 = await callThreeArg(proto.OP_NAPI_TYPEOF, "napi_typeof(undefined)", r1.handle, 300);
  const t2 = await callThreeArg(proto.OP_NAPI_TYPEOF, "napi_typeof(null)",      r2.handle, 304);
  const t3 = await callThreeArg(proto.OP_NAPI_TYPEOF, "napi_typeof(global)",    r3.handle, 308);

  // napi_is_array(env, value, &result) against global (not an array → 0).
  const ia = await callThreeArg(proto.OP_NAPI_IS_ARRAY, "napi_is_array(global)", r3.handle, 312);

  append(
    `f1-napi-probe: ${r1.name}=${r1.handle} ${r2.name}=${r2.handle} ${r3.name}=${r3.handle}`,
    "info",
  );
  append(
    `f4-napi-probe: ${t1.name}=>type${t1.result} ${t2.name}=>type${t2.result} ${t3.name}=>type${t3.result} ${ia.name}=>${ia.result}`,
    "info",
  );

  // napi_valuetype: 0=undefined, 1=null, 2=boolean, 3=number, 4=string,
  // 5=symbol, 6=object, 7=function, 8=external, 9=bigint
  const allOk = r1.status === 0 && r2.status === 0 && r3.status === 0
    && t1.status === 0 && t2.status === 0 && t3.status === 0
    && r1.handle !== 0 && r1.handle !== r2.handle
    && t1.result === 0 && t2.result === 1 && t3.result === 6
    && ia.status === 0 && ia.result === 0;
  append(`f1-napi-probe: ${allOk ? "OK" : "FAIL"}`, allOk ? "info" : "err");
}

// F-9 sweep probe.  Picks one representative op per batch from F-9
// batches 1-3 + clusters A/B/C and exercises it via real SAB-RPC to
// the host worker.  Smoke test — catches gross wiring errors after
// the factory-pattern additions.  Each op is asserted to return
// status=0 and (where applicable) a non-zero handle.
async function runF9SweepProbe(): Promise<void> {
  if (!hostHandle) { append("f9-sweep: hostHandle not ready", "err"); return; }
  if (!hostHandle.napiMemorySab) { append("f9-sweep: napiMemorySab missing", "err"); return; }
  const { attachRing } = await import("./wasi-shim/sab-ring");
  const { RpcClient } = await import("./host-worker/rpc-client");
  const proto = await import("./host-worker/rpc-protocol");
  const ringConfig = { numSlots: 256, slotSize: 4 * 1024 };
  const client = new RpcClient(
    attachRing(hostHandle.requestSab, ringConfig),
    attachRing(hostHandle.replySab, ringConfig),
  );
  const memU8 = new Uint8Array(hostHandle.napiMemorySab);
  const memU32 = new Uint32Array(hostHandle.napiMemorySab);

  // Encode an args buffer of N u32s.
  function encodeArgs(values: number[]): Uint8Array {
    const buf = new Uint8Array(values.length * 4);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i] >>> 0, true);
    return buf;
  }
  async function callOp(op: number, name: string, argv: number[], outPtrs: number[] = []) {
    const reply = await client.call(op, 0, 0, encodeArgs(argv));
    const outs: Record<string, number> = {};
    for (const ptr of outPtrs) outs[`@${ptr}`] = memU32[ptr / 4];
    const errMsg = (reply.status !== 0 && reply.payload.byteLength > 0)
      ? new TextDecoder().decode(reply.payload) : "";
    return { name, status: reply.status, outs, errMsg };
  }

  const results: { name: string; status: number; ok: boolean; detail: string }[] = [];
  // Reserve memory layout for out-pointers (256+ to avoid F-1 probe's 256-312 range).
  let ptr = 400;
  const allocPtr = (n = 4) => {
    ptr = (ptr + 3) & ~3; // 4-byte align
    const p = ptr; ptr += n; return p;
  };

  // ── Batch 1 — object/array/property (0x0130-0x0139) ──
  // create_object(env, &result) — TwoU32
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_OBJECT, "create_object", [1, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_object", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }
  // create_array_with_length(env, length, &result) — ThreeU32
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_ARRAY_WITH_LENGTH, "create_array_with_length", [1, 5, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_array_with_length", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }

  // ── Batch 2 — numeric (0x0140-0x0149) ──
  // create_int32(env, value, &result) — ThreeU32.  Capture the handle for downstream coerce.
  const int32Out = allocPtr();
  {
    const r = await callOp(proto.OP_NAPI_CREATE_INT32, "create_int32", [1, 42, int32Out]);
    const handle = memU32[int32Out / 4];
    results.push({ name: "create_int32", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }
  const int32Handle = memU32[int32Out / 4];

  // ── Batch 2 — coerce (0x0150-0x0159) ──
  // coerce_to_bool(env, value, &result) — ThreeU32 on the int32 we just made.
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_COERCE_TO_BOOL, "coerce_to_bool", [1, int32Handle, out]);
    const handle = memU32[out / 4];
    results.push({ name: "coerce_to_bool", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }

  // ── Batch 2 — buffer/typedarray/value-creation (0x0160-0x016B) ──
  // create_date(env, time:double, &result) — ThreeU32.  Double passed via JS number.
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_DATE, "create_date", [1, 0, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_date", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }

  // ── Batch 3 — string (0x0180-0x018E) ──
  // create_string_utf8(env, str_ptr, length, &result) — FourU32, with the string bytes
  // in shared memory at strPtr.
  {
    const strBytes = new TextEncoder().encode("f9-sweep!");
    const strPtr = allocPtr(strBytes.byteLength + 4);
    memU8.set(strBytes, strPtr);
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_STRING_UTF8, "create_string_utf8",
      [1, strPtr, strBytes.byteLength, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_string_utf8", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }

  // ── EXTENDED SWEEP — additional ops across all batches ──
  // Goal: one representative per factory shape per batch, beyond the
  // 10 ops above, to confirm the entire 100-op surface works (not just
  // the sampled 10).  Stops once we hit ~24 ops total.

  // Batch 2 numeric — create_uint32 (ThreeU32)
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_UINT32, "create_uint32", [1, 0xfeedface, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_uint32", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }
  // Batch 2 predicate — is_arraybuffer on global (not an ArrayBuffer → result=false=0)
  {
    // need a value: use int32Handle from earlier
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_IS_ARRAYBUFFER, "is_arraybuffer", [1, int32Handle, out]);
    const result = memU32[out / 4];
    results.push({ name: "is_arraybuffer(int32)", status: r.status, ok: r.status === 0 && result === 0, detail: `status=${r.status} result=${result}` });
  }
  // Batch 2 coerce — coerce_to_string on int32 (ThreeU32)
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_COERCE_TO_STRING, "coerce_to_string(int32)", [1, int32Handle, out]);
    const handle = memU32[out / 4];
    results.push({ name: "coerce_to_string", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }
  // Batch 2 — create_symbol (ThreeU32 — description handle or 0 for anonymous)
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_SYMBOL, "create_symbol", [1, 0, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_symbol", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }
  // Batch 2 — create_promise (env, &deferred, &promise) — ThreeU32, BOTH are out-ptrs
  {
    const deferredOut = allocPtr();
    const promiseOut = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_PROMISE, "create_promise", [1, deferredOut, promiseOut]);
    const deferred = memU32[deferredOut / 4];
    const promise = memU32[promiseOut / 4];
    results.push({ name: "create_promise", status: r.status, ok: r.status === 0 && deferred !== 0 && promise !== 0, detail: `status=${r.status} deferred=${deferred} promise=${promise}` });
  }
  // Batch 2 — create_error(env, code_handle, msg_handle, &result) — FourU32.
  // Use the create_string_utf8 result handle (from earlier) as the message.
  // Get its handle from results array — but we need a sure-thing handle.
  // Create a fresh string here.
  {
    const msgBytes = new TextEncoder().encode("err-msg");
    const msgPtr = allocPtr(msgBytes.byteLength + 4);
    memU8.set(msgBytes, msgPtr);
    const strOut = allocPtr();
    const sr = await callOp(proto.OP_NAPI_CREATE_STRING_UTF8, "create_string_utf8(for_error)",
      [1, msgPtr, msgBytes.byteLength, strOut]);
    const msgHandle = memU32[strOut / 4];
    if (sr.status === 0 && msgHandle !== 0) {
      const errOut = allocPtr();
      const r = await callOp(proto.OP_NAPI_CREATE_ERROR, "create_error", [1, 0, msgHandle, errOut]);
      const handle = memU32[errOut / 4];
      results.push({ name: "create_error", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
    } else {
      results.push({ name: "create_error", status: sr.status, ok: false, detail: "couldn't create message string" });
    }
  }
  // Batch 3 — create_string_latin1 (FourU32) — same shape as utf8
  {
    const strBytes = new TextEncoder().encode("latin1-test");
    const strPtr = allocPtr(strBytes.byteLength + 4);
    memU8.set(strBytes, strPtr);
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_STRING_LATIN1, "create_string_latin1",
      [1, strPtr, strBytes.byteLength, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_string_latin1", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }
  // Batch 3 — set_named_property(env, obj, name_ptr, value) — FourU32, name is C string in memory
  {
    // need a fresh object + a value to set + a name string in memory
    const objOut = allocPtr();
    const cor = await callOp(proto.OP_NAPI_CREATE_OBJECT, "create_object(for_set_named)", [1, objOut]);
    const objH = memU32[objOut / 4];
    if (cor.status === 0 && objH !== 0) {
      const nameBytes = new TextEncoder().encode("k\0"); // null-terminated
      const namePtr = allocPtr(nameBytes.byteLength + 4);
      memU8.set(nameBytes, namePtr);
      const r = await callOp(proto.OP_NAPI_SET_NAMED_PROPERTY, "set_named_property", [1, objH, namePtr, int32Handle]);
      results.push({ name: "set_named_property", status: r.status, ok: r.status === 0, detail: `status=${r.status}` });
    } else {
      results.push({ name: "set_named_property", status: cor.status, ok: false, detail: "couldn't create owner object" });
    }
  }
  // Cluster B — create_external_arraybuffer.  Note: this op interacts
  // with emnapi state in a way that can leave a pending exception.  We
  // clear it after so subsequent sweep ops aren't poisoned.
  // SixU32: (env, ext_data, byte_length, finalize_cb, finalize_hint, &result)
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_EXTERNAL_ARRAYBUFFER, "create_external_arraybuffer",
      [1, 0xfeed1234, 256, 0xdead1234, 0xbeef1234, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_external_arraybuffer", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
    // Drain any pending exception so downstream ops aren't poisoned.
    const excOut = allocPtr();
    await callOp(proto.OP_NAPI_GET_AND_CLEAR_LAST_EXCEPTION, "(internal: clear last exception)", [1, excOut]);
  }
  // Cluster C — add_finalizer(env, value, finalize_data, finalize_cb, finalize_hint, &result_opt) — SixU32
  {
    const objOut = allocPtr();
    const cor = await callOp(proto.OP_NAPI_CREATE_OBJECT, "create_object(for_add_finalizer)", [1, objOut]);
    const objH = memU32[objOut / 4];
    if (cor.status === 0 && objH !== 0) {
      const refOut = allocPtr();
      const r = await callOp(proto.OP_NAPI_ADD_FINALIZER, "add_finalizer",
        [1, objH, 0xfeed5678, 0xdead5678, 0xbeef5678, refOut]);
      results.push({ name: "add_finalizer", status: r.status, ok: r.status === 0, detail: `status=${r.status} refOut=@${refOut}=${memU32[refOut/4]}` });
    } else {
      results.push({ name: "add_finalizer", status: cor.status, ok: false, detail: "couldn't create owner object" });
    }
  }

  // ── Cluster A — env cleanup hook (0x01A0-0x01A1) ──
  // add_env_cleanup_hook(env, cbPtr, dataPtr) — three-u32 no-result, custom inline.
  // Verifies the handler runs + closure is registered (we never trigger the cleanup,
  // so the closure stays dormant).
  {
    const r = await callOp(proto.OP_NAPI_ADD_ENV_CLEANUP_HOOK, "add_env_cleanup_hook", [1, 0xdead0001, 0xbeef0001]);
    results.push({ name: "add_env_cleanup_hook", status: r.status, ok: r.status === 0, detail: `status=${r.status}` });
  }

  // ── Cluster B — externals (0x01B0-0x01B2) ──
  // create_external(env, data, finalize_cb, finalize_hint, &result) — FiveU32.
  {
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_EXTERNAL, "create_external", [1, 0xfeed0001, 0xdead0002, 0xbeef0002, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_external", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle}` });
  }

  // ── Cluster C — wrap lifecycle (0x01C0-0x01C3) ──
  // Need a value to wrap.  Use create_object's handle from earlier — but it was scoped
  // and may be released; create a fresh one.
  {
    const objOut = allocPtr();
    const cr = await callOp(proto.OP_NAPI_CREATE_OBJECT, "create_object(for_wrap)", [1, objOut]);
    const objHandle = memU32[objOut / 4];
    if (cr.status === 0 && objHandle !== 0) {
      // wrap(env, value, native_obj, finalize_cb, finalize_hint, &result_opt) — 6 args
      const refOut = allocPtr();
      const wr = await callOp(proto.OP_NAPI_WRAP, "wrap", [1, objHandle, 0xfeed0003, 0xdead0003, 0xbeef0003, refOut]);
      results.push({ name: "wrap", status: wr.status, ok: wr.status === 0, detail: `status=${wr.status} refOut=@${refOut}=${memU32[refOut/4]}` });
      // unwrap(env, value, &result) — ThreeU32.  Should return the native_obj ptr we stored.
      const unwrapOut = allocPtr();
      const ur = await callOp(proto.OP_NAPI_UNWRAP, "unwrap", [1, objHandle, unwrapOut]);
      const got = memU32[unwrapOut / 4];
      results.push({ name: "unwrap", status: ur.status, ok: ur.status === 0 && got === 0xfeed0003, detail: `status=${ur.status} got=0x${got.toString(16)}` });
    } else {
      results.push({ name: "wrap", status: cr.status, ok: false, detail: "couldn't create object to wrap" });
    }
  }

  // ── Cluster D — napi_callback-shape ops (0x0204-0x0205) ──
  // create_function(env, utf8name, length, cbPtr, dataPtr, &result) — SixU32.
  // The probe verifies the handler mints a non-zero napi_value handle.
  // We don't trigger the closure (no live wasm worker to dispatch to),
  // so dormant registration is the assertion.
  {
    const fnNameBytes = new TextEncoder().encode("probeFn");
    const fnNamePtr = allocPtr(fnNameBytes.byteLength + 4);
    memU8.set(fnNameBytes, fnNamePtr);
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_CREATE_FUNCTION, "create_function",
      [1, fnNamePtr, fnNameBytes.byteLength, 0xfeed0100, 0xbeef0100, out]);
    const handle = memU32[out / 4];
    results.push({ name: "create_function", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle} ${r.errMsg ? `err=${r.errMsg}` : ""}` });
  }
  // define_class(env, name, length, ctorPtr, dataPtr, propCount=0, propsPtr=0, &result) — 8 u32.
  {
    const clsNameBytes = new TextEncoder().encode("ProbeCls");
    const clsNamePtr = allocPtr(clsNameBytes.byteLength + 4);
    memU8.set(clsNameBytes, clsNamePtr);
    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_DEFINE_CLASS, "define_class",
      [1, clsNamePtr, clsNameBytes.byteLength, 0xfeed0200, 0xbeef0200, 0, 0, out]);
    const handle = memU32[out / 4];
    results.push({ name: "define_class(empty)", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle} ${r.errMsg ? `err=${r.errMsg}` : ""}` });
  }
  // define_class with two property descriptors:
  //   - "doIt" (instance method, attrs = writable | configurable)
  //   - "Kind" (static accessor: getter only, attrs = configurable | static)
  // 32 bytes per descriptor: utf8name, name, method, getter, setter, value, attributes, data.
  {
    const clsNameBytes = new TextEncoder().encode("ProbeClsProps");
    const clsNamePtr = allocPtr(clsNameBytes.byteLength + 4);
    memU8.set(clsNameBytes, clsNamePtr);

    // Property name strings (nul-terminated for NAPI_AUTO_LENGTH path).
    const doItBytes = new TextEncoder().encode("doIt\0");
    const doItPtr = allocPtr(doItBytes.byteLength + 4);
    memU8.set(doItBytes, doItPtr);
    const kindBytes = new TextEncoder().encode("Kind\0");
    const kindPtr = allocPtr(kindBytes.byteLength + 4);
    memU8.set(kindBytes, kindPtr);

    // Descriptor array: 2 × 32B = 64B.  8-byte aligned by allocPtr.
    const propsPtr = allocPtr(64);
    const propsDv = new DataView(hostHandle.napiMemorySab as unknown as ArrayBuffer);
    // Desc 0 — "doIt" method, writable | configurable (1|4=5)
    propsDv.setUint32(propsPtr +  0, doItPtr,    true); // utf8name
    propsDv.setUint32(propsPtr +  4, 0,          true); // name
    propsDv.setUint32(propsPtr +  8, 0xfeedaaaa, true); // method funcref
    propsDv.setUint32(propsPtr + 12, 0,          true); // getter
    propsDv.setUint32(propsPtr + 16, 0,          true); // setter
    propsDv.setUint32(propsPtr + 20, 0,          true); // value
    propsDv.setUint32(propsPtr + 24, 5,          true); // attrs = writable | configurable
    propsDv.setUint32(propsPtr + 28, 0xbeefaaaa, true); // data
    // Desc 1 — "Kind" static accessor (getter only), configurable | static (4|1024=1028)
    propsDv.setUint32(propsPtr + 32, kindPtr,    true);
    propsDv.setUint32(propsPtr + 36, 0,          true);
    propsDv.setUint32(propsPtr + 40, 0,          true); // method
    propsDv.setUint32(propsPtr + 44, 0xfeedbbbb, true); // getter funcref
    propsDv.setUint32(propsPtr + 48, 0,          true); // setter
    propsDv.setUint32(propsPtr + 52, 0,          true); // value
    propsDv.setUint32(propsPtr + 56, 1028,       true); // attrs = configurable | static
    propsDv.setUint32(propsPtr + 60, 0xbeefbbbb, true); // data

    const out = allocPtr();
    const r = await callOp(proto.OP_NAPI_DEFINE_CLASS, "define_class(2props)",
      [1, clsNamePtr, clsNameBytes.byteLength, 0xfeed0300, 0xbeef0300, 2, propsPtr, out]);
    const handle = memU32[out / 4];
    results.push({ name: "define_class(2props)", status: r.status, ok: r.status === 0 && handle !== 0, detail: `status=${r.status} handle=${handle} ${r.errMsg ? `err=${r.errMsg}` : ""}` });
  }

  // ── Marshal roundtrip — by-value cross-heap deep-clone (no RPC) ──
  // The IdentityMap is per-instance; in a split-worker topology the
  // host and wasm hold DIFFERENT instances and cannot share by-ref.
  // The new by-value tags (object, array, typed array, ArrayBuffer,
  // Date, circular-ref) handle this case via deep clone.  This probe
  // packs in a "host" frame and unpacks in a "wasm" frame to simulate
  // cross-worker semantics.
  {
    const marshal = await import("./host-worker/cross-context-marshal");
    const hostMap = new marshal.IdentityMap();
    const wasmMap = new marshal.IdentityMap();
    function roundtrip<T>(value: T): T {
      const packed = marshal.packValue(value, "host", hostMap);
      const { value: out } = marshal.unpackValue(packed, 0, wasmMap);
      return out as T;
    }
    function deepEq(a: unknown, b: unknown): boolean {
      if (a === b) return true;
      if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
      if (a instanceof RegExp && b instanceof RegExp) {
        return a.source === b.source && a.flags === b.flags;
      }
      if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false;
        for (const [k, v] of a) {
          if (!b.has(k)) return false;
          if (!deepEq(v, b.get(k))) return false;
        }
        return true;
      }
      if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false;
        return true;
      }
      if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
        if (a.constructor !== b.constructor) return false;
        if (a.byteLength !== b.byteLength) return false;
        const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
        return true;
      }
      if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
        if (a.byteLength !== b.byteLength) return false;
        const ua = new Uint8Array(a); const ub = new Uint8Array(b);
        for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
        return true;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false;
        return true;
      }
      if (a && b && typeof a === "object" && typeof b === "object") {
        const ka = Object.keys(a as object); const kb = Object.keys(b as object);
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
          if (!deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
        }
        return true;
      }
      return false;
    }
    const cases: Array<{ name: string; value: unknown; assert?: (v: unknown) => boolean }> = [
      { name: "marshal: plain-obj", value: { a: 1, b: "two", c: true, d: null } },
      { name: "marshal: nested-obj", value: { outer: { inner: 42 }, list: [1, 2, 3] } },
      { name: "marshal: array-of-obj", value: [{ x: 1 }, { x: 2 }, { x: 3 }] },
      { name: "marshal: date", value: new Date(1700000000000) },
      { name: "marshal: uint8array", value: new Uint8Array([10, 20, 30, 40, 50]) },
      { name: "marshal: arraybuffer", value: (() => { const ab = new ArrayBuffer(4); new Uint8Array(ab).set([0xde, 0xad, 0xbe, 0xef]); return ab; })() },
      {
        name: "marshal: circular-self-ref",
        value: (() => { const o: Record<string, unknown> = { tag: "loop" }; o.self = o; return o; })(),
        // Custom assertion: round-tripped object has self-referential cycle.
        assert: (v: unknown) => {
          const o = v as Record<string, unknown>;
          return typeof o === "object" && o !== null && o.tag === "loop" && o.self === o;
        },
      },
      { name: "marshal: map", value: new Map<unknown, unknown>([["a", 1], ["b", "two"]]) },
      { name: "marshal: set", value: new Set<unknown>([1, "two", true]) },
      { name: "marshal: regexp", value: /hello\d+/gi },
    ];
    for (const c of cases) {
      let ok = false; let detail = "";
      try {
        const got = roundtrip(c.value);
        ok = c.assert ? c.assert(got) : deepEq(c.value, got);
        detail = ok ? "roundtrip ok" : `mismatch: ${JSON.stringify(got).slice(0, 80)}`;
      } catch (e) {
        detail = `threw: ${(e as Error).message}`;
      }
      results.push({ name: c.name, status: 0, ok, detail });
    }
  }

  // Emit per-op result + summary.
  for (const r of results) {
    append(`f9-sweep: ${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(28)} ${r.detail}`, r.ok ? "info" : "err");
  }
  const allOk = results.every((r) => r.ok);
  const passCount = results.filter((r) => r.ok).length;
  append(`f9-sweep: ${passCount}/${results.length} ops OK — ${allOk ? "OK" : "FAIL"}`, allOk ? "info" : "err");
}

// B / scope-op forwarding probe.  Verifies that wrapping the
// host-RPC alloc-heavy ops (OP_NAPI_CREATE_OBJECT etc.) inside
// scope-open / scope-close ops keeps the host's handleStore size
// BOUNDED across many iterations — the alternative is the
// `host-emnapi-root-scope-accumulates` debt's linear growth.
//
// Methodology:
//   baselineSize := DEBUG_HANDLE_STORE_SIZE before loop
//   for i in 1..N:
//     OP_NAPI_OPEN_HANDLE_SCOPE → hostScopeId
//     OP_NAPI_CREATE_OBJECT × ALLOCS_PER_ITER
//     OP_NAPI_CLOSE_HANDLE_SCOPE(hostScopeId)
//   afterSize := DEBUG_HANDLE_STORE_SIZE after loop
//
// Assertion: afterSize - baselineSize is bounded by a small
// constant (one iteration's-worth + emnapi-internal overhead),
// NOT linear in N.  If forwarding is broken, afterSize >=
// baselineSize + N * ALLOCS_PER_ITER (linear growth).
async function runScopeBoundedProbe(): Promise<void> {
  if (!hostHandle) { append("scope-bounded: hostHandle not ready", "err"); return; }
  const { attachRing } = await import("./wasi-shim/sab-ring");
  const { RpcClient } = await import("./host-worker/rpc-client");
  const proto = await import("./host-worker/rpc-protocol");
  const ringConfig = { numSlots: 256, slotSize: 4 * 1024 };
  const client = new RpcClient(
    attachRing(hostHandle.requestSab, ringConfig),
    attachRing(hostHandle.replySab, ringConfig),
  );

  async function readSize(): Promise<number> {
    const reply = await client.call(proto.OP_NAPI_DEBUG_HANDLE_STORE_SIZE, 0, 0, new Uint8Array(0));
    if (reply.status !== 0 || reply.payload.byteLength < 4) return -1;
    return new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength).getUint32(0, true);
  }

  async function openScope(): Promise<number> {
    const reply = await client.call(proto.OP_NAPI_OPEN_HANDLE_SCOPE, 0, 0, new Uint8Array(0));
    if (reply.status !== 0 || reply.payload.byteLength < 4) return -1;
    return new DataView(reply.payload.buffer, reply.payload.byteOffset, reply.payload.byteLength).getUint32(0, true);
  }

  async function closeScope(scopeId: number): Promise<number> {
    const args = new Uint8Array(4);
    new DataView(args.buffer).setUint32(0, scopeId, true);
    const reply = await client.call(proto.OP_NAPI_CLOSE_HANDLE_SCOPE, 0, 0, args);
    return reply.status;
  }

  async function createObject(): Promise<number> {
    // (env: 1, resultPtr: 4096) — resultPtr is unused for the assertion;
    // we don't dereference it.  4096 is well within the napi mem SAB.
    const args = new Uint8Array(8);
    const dv = new DataView(args.buffer);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, 4096, true);
    const reply = await client.call(proto.OP_NAPI_CREATE_OBJECT, 0, 0, args);
    return reply.status;
  }

  const ITERATIONS = 200;
  const ALLOCS_PER_ITER = 5;

  // ── Baseline (BEFORE the loop) ───────────────────────────────
  const baselineSize = await readSize();
  if (baselineSize < 0) {
    append("scope-bounded: baseline DEBUG_HANDLE_STORE_SIZE failed", "err");
    return;
  }

  // ── Loop: open scope, alloc many handles, close scope ────────
  let openFails = 0, closeFails = 0, createFails = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const sid = await openScope();
    if (sid < 0) { openFails++; continue; }
    for (let k = 0; k < ALLOCS_PER_ITER; k++) {
      const s = await createObject();
      if (s !== 0) createFails++;
    }
    const cs = await closeScope(sid);
    if (cs !== 0) closeFails++;
  }
  const afterSize = await readSize();

  // ── Counter-experiment: skip the open/close around the same ──
  // allocation pattern.  Confirms the leak would actually happen
  // without the fix (otherwise the test isn't meaningful).
  for (let i = 0; i < ITERATIONS; i++) {
    for (let k = 0; k < ALLOCS_PER_ITER; k++) {
      const s = await createObject();
      if (s !== 0) createFails++;
    }
  }
  const noScopeSize = await readSize();

  const totalAllocs = ITERATIONS * ALLOCS_PER_ITER;
  const scopedGrowth = afterSize - baselineSize;
  const unscopedGrowth = noScopeSize - afterSize;
  // The scoped variant SHOULD grow only by a small constant (one
  // scope's worth of handles or less, since the final close
  // releases all but possibly one set still pending in the loop
  // exit).  Bound: 2 * ALLOCS_PER_ITER + 16 (slack for emnapi
  // internal scope/cb info handles).
  const scopedOk = scopedGrowth <= 2 * ALLOCS_PER_ITER + 16;
  // The unscoped variant SHOULD grow linearly with totalAllocs.
  // Sanity check: at least 50% of totalAllocs (allows for slot
  // reuse but ensures the growth is dominated by the new allocs).
  const unscopedOk = unscopedGrowth >= totalAllocs / 2;

  append(`scope-bounded: baseline=${baselineSize} afterScoped=${afterSize} afterUnscoped=${noScopeSize}`, "info");
  append(`scope-bounded: totalAllocs=${totalAllocs} scopedGrowth=${scopedGrowth} unscopedGrowth=${unscopedGrowth}`, "info");
  append(`scope-bounded: openFails=${openFails} closeFails=${closeFails} createFails=${createFails}`, scopedOk && unscopedOk ? "info" : "warn");

  const verdict = scopedOk && unscopedOk && openFails === 0 && closeFails === 0 && createFails === 0;
  append(
    `scope-bounded: ${verdict ? "OK" : "FAIL"} ` +
    `(scoped <= ${2 * ALLOCS_PER_ITER + 16} ? ${scopedOk}; unscoped >= ${totalAllocs / 2} ? ${unscopedOk})`,
    verdict ? "info" : "err",
  );
}

async function runL9MultiHostSpike(): Promise<void> {
  const { spawnHostWorker } = await import("./host-worker/worker-pool");
  const { attachRing } = await import("./wasi-shim/sab-ring");
  const { RpcClient } = await import("./host-worker/rpc-client");
  const { OP_PING, OP_HOST_ECHO } = await import("./host-worker/rpc-protocol");
  const ringConfig = { numSlots: 256, slotSize: 4 * 1024 };
  // We already have hostHandle (id=0).  Spawn a second.
  const h1 = spawnHostWorker();
  await h1.ready;
  if (h1.id !== 1) {
    append(`l9-multi-host: FAIL expected id=1 got id=${h1.id}`, "err");
    return;
  }
  // Confirm SAB rings are distinct objects.
  if (h1.requestSab === hostHandle?.requestSab) {
    append("l9-multi-host: FAIL h1 SAB aliases hostHandle SAB", "err");
    return;
  }
  // Ping both hosts; each should get back exactly one reply.
  const c0 = new RpcClient(attachRing(hostHandle!.requestSab, ringConfig), attachRing(hostHandle!.replySab, ringConfig));
  const c1 = new RpcClient(attachRing(h1.requestSab, ringConfig), attachRing(h1.replySab, ringConfig));
  const tag0 = new TextEncoder().encode("hello-h0");
  const tag1 = new TextEncoder().encode("hello-h1");
  const [p0, p1] = await Promise.all([
    c0.call(OP_HOST_ECHO, 0, 0, tag0),
    c1.call(OP_HOST_ECHO, 1, 0, tag1),
  ]);
  const r0 = new TextDecoder().decode(p0.payload);
  const r1 = new TextDecoder().decode(p1.payload);
  if (r0 === "hello-h0" && r1 === "hello-h1") {
    append(`l9-multi-host: OK h0="${r0}" h1="${r1}"`, "info");
  } else {
    append(`l9-multi-host: FAIL h0="${r0}" h1="${r1}"`, "err");
  }
  // Also ping just for good measure.
  void c0.call(OP_PING, 0, 0, null);
  void c1.call(OP_PING, 1, 0, null);
}

// Run a user script via the host worker's OP_RUN_USER_SCRIPT.
//
// `format` chooses the DOM output shape:
//   "test-runner" (default for `?script=&host=1`): emits the
//     section marker, per-stdout-line `[stdout] ...` spans, and the
//     `_start ran <ms> ms (exit=N|returned|THREW)` sentinel — the
//     same signals browser-test-runner.mjs scrapes.  This is the
//     canonical user-script path for the regression net.
//   "debug" (for the legacy `?l5script=` URL): emits a single
//     `l5-script-result: <body>` + `l5-script-status: <N>` line
//     pair.  Kept for ad-hoc debugging via the page log only;
//     prefer `?script=&host=1` for anything programmatic.
async function runUserScriptOnHost(source: string, format: "test-runner" | "debug"): Promise<void> {
  if (!hostHandle) {
    append("host-script: host worker not ready", "err");
    return;
  }
  const { attachRing } = await import("./wasi-shim/sab-ring");
  const { RpcClient } = await import("./host-worker/rpc-client");
  const { OP_RUN_USER_SCRIPT } = await import("./host-worker/rpc-protocol");
  const ringConfig = { numSlots: 256, slotSize: 4 * 1024 };
  const reqRing = attachRing(hostHandle.requestSab, ringConfig);
  const replyRing = attachRing(hostHandle.replySab, ringConfig);
  const client = new RpcClient(reqRing, replyRing);
  const payload = new TextEncoder().encode(source);

  if (format === "test-runner") {
    append("", "info");
    append("── edgejs.wasm (emnapi + WASI host) ──", "info");
  }
  const tStart = performance.now();
  let exitCode: number | null = null;
  let threw = false;
  let body = "";
  let status = 0;
  try {
    const reply = await client.call(OP_RUN_USER_SCRIPT, 0, 0, payload);
    status = reply.status;
    const text = new TextDecoder().decode(reply.payload);
    threw = reply.status !== 0;
    const exitMatch = text.match(/\n?__EXIT_CODE__:(-?\d+)\s*$/u);
    body = exitMatch ? text.slice(0, text.length - exitMatch[0].length) : text;
    if (exitMatch) exitCode = Number(exitMatch[1]);
  } catch (e) {
    append(`host-script error: ${(e as Error).message}`, "err");
    threw = true;
  }
  if (format === "test-runner") {
    if (body.length > 0) {
      for (const line of body.split("\n")) {
        append(`[stdout] ${line}`, "out");
      }
    }
    const runMs = performance.now() - tStart;
    const tail = exitCode !== null ? `(exit=${exitCode})` : threw ? "(THREW)" : "(returned)";
    append(`_start ran ${runMs.toFixed(0)} ms ${tail}`, exitCode === 0 || exitCode === null ? "info" : "err");
  } else {
    append(`l5-script-result: ${body}${exitCode !== null ? `\n__EXIT_CODE__:${exitCode}` : ""}`, "info");
    append(`l5-script-status: ${status}`, status === 0 ? "info" : "err");
  }
}

async function runEchoBench(iters: number, payloadBytes: number): Promise<void> {
  if (!hostHandle) {
    append("bench-host-echo: host worker not ready", "err");
    return;
  }
  // Page-side RPC client over the same SABs.  Need a separate client
  // instance — the runtime worker will get its own when it boots.
  const { attachRing } = await import("./wasi-shim/sab-ring");
  const { RpcClient } = await import("./host-worker/rpc-client");
  const { OP_HOST_ECHO } = await import("./host-worker/rpc-protocol");
  const ringConfig = { numSlots: 256, slotSize: 4 * 1024 };
  const reqRing = attachRing(hostHandle.requestSab, ringConfig);
  const replyRing = attachRing(hostHandle.replySab, ringConfig);
  const client = new RpcClient(reqRing, replyRing);
  const payload = new Uint8Array(payloadBytes);
  for (let i = 0; i < payloadBytes; i++) payload[i] = i & 0xff;
  // Warm-up.
  for (let i = 0; i < 50; i++) await client.call(OP_HOST_ECHO, 0, 0, payload);
  // Timed run.
  const latencies = new Float64Array(iters);
  const tStart = performance.now();
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    const r = await client.call(OP_HOST_ECHO, 0, 0, payload);
    latencies[i] = performance.now() - t0;
    if (r.status !== 0 || r.payload.byteLength !== payloadBytes) {
      append(`bench-host-echo: bad reply at iter ${i} status=${r.status} bytes=${r.payload.byteLength}`, "err");
      return;
    }
  }
  const totalMs = performance.now() - tStart;
  const sorted = Float64Array.from(latencies).sort();
  const median = sorted[Math.floor(iters / 2)];
  const p99 = sorted[Math.floor(iters * 0.99)];
  const mean = totalMs / iters;
  const rps = (iters / totalMs) * 1000;
  append(
    `bench-host-echo: iters=${iters} payload=${payloadBytes}B totalMs=${totalMs.toFixed(1)} mean=${mean.toFixed(3)}ms median=${median.toFixed(3)}ms p99=${p99.toFixed(3)}ms throughput=${rps.toFixed(0)} ops/sec`,
    "info",
  );
}

function spawnRuntimeWorker() {
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  // Hand the FS snapshot SAB to runtime before any other message.
  worker.postMessage({ kind: "edge-fs-snapshot-sab", sab: fsSnapshotSab });
  // Hand the host worker's RPC SABs so the runtime can talk to it.
  if (hostHandle) {
    worker.postMessage({
      kind: "edge-host-rpc-sab",
      hostWorkerId: hostHandle.id,
      requestSab: hostHandle.requestSab,
      replySab: hostHandle.replySab,
      reverseRequestSab: hostHandle.reverseRequestSab,
      reverseReplySab: hostHandle.reverseReplySab,
      // F-9 path-a: single-shared-wake SAB so the runtime worker's
      // SyncRpcClient can Atomics.wait on an address the host's
      // reply-publisher AND reverse-request-publisher both bump.
      sharedWakeSab: hostHandle.sharedWakeSab,
      // F-2: forward host's napi memory SAB to the wasm runtime worker.
      // Wasm worker attaches a view so it can read what host's emnapi
      // wrote (e.g., napi result handles).  In F-7 this becomes the
      // PRIMARY memory edge.js's wasm sees; for F-2 it's a parallel
      // memory used only by host RPC napi ops.
      napiMemorySab: hostHandle.napiMemorySab,
    });
  }
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    append(`WORKER ERROR: ${e.message} (${e.filename}:${e.lineno})`, "err");
    statusEl.textContent = "worker crashed";
  };
  while (pendingMessagesForRuntime.length > 0) {
    const msg = pendingMessagesForRuntime.shift();
    if (msg !== undefined) worker.postMessage(msg);
  }
}

// Holds the active SW once setupBridge resolves.  Used to forward edge
// responses (edge-res) back via sw.postMessage so the SW can resolve
// the pending fetch.
let activeSW: ServiceWorker | null = null;
// The bridge ring + shim wake SAB the worker exposes for the HTTP
// bridge transport.  Set when the worker posts "relay-bridge-sab".
let bridgeRing: import("./wasi-shim/sab-ring").RingView | null = null;
let wakeI32: Int32Array | null = null;

function onWorkerMessage(e: MessageEvent) {
  const { kind } = e.data;
  if (kind === "log") {
    append(e.data.text, e.data.level ?? "info");
  } else if (kind === "section") {
    append("", "info");
    append(e.data.text, "info");
  } else if (kind === "status") {
    statusEl.textContent = e.data.text;
  } else if (kind === "report") {
    if (e.data.json) installDownload(e.data.json, "json");
    if (e.data.jsonl) installDownload(e.data.jsonl, "jsonl");
  } else if (kind === "relay-bridge-sab") {
    bridgeRing = attachBridgeRing(e.data.bridgeSab);
    wakeI32 = new Int32Array(e.data.wakeSab);
    append("bridge: SAB transport ready (page-mediated)", "info");
  } else if (kind === "page-edge-res") {
    // Worker → SW response relay.  See setupBridge handler comment.
    if (activeSW) {
      activeSW.postMessage({
        kind: "edge-res",
        reqId: e.data.reqId,
        status: e.data.status,
        headers: e.data.headers,
        body: e.data.body,
      });
    }
  }
};

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

function dispatchEdgeReq(reqId: number, method: string, path: string, headers: Record<string, string>, body: ArrayBuffer | null): void {
  if (!bridgeRing || !wakeI32) {
    append("bridge: edge-req arrived before SAB transport was ready", "warn");
    return;
  }
  const bodyB64 = body && body.byteLength > 0 ? arrayBufferToBase64(body) : undefined;
  const ok = publishBridgeRequest(bridgeRing, wakeI32, reqId, method, path, headers, bodyB64);
  if (!ok) {
    append(`bridge: dispatchEdgeReq reqId=${reqId} — ring full or payload too large, dropping`, "warn");
  }
}
// (worker.onerror is set inside spawnRuntimeWorker so we don't deref a null worker)

// ── Worker_threads phase 1: user-worker pair registry + spawner ─────
//
// Path B (see docs/worker-threads-design.md): a sync RPC arrives at the
// parent's host worker (OP_SPAWN_USER_WORKER), which postMessages us
// asking for a new (host+wasm) pair.  Main owns the user-workers
// registry, the cap, and the shared compiled WebAssembly.Module (E24
// mandate: compile once, postMessage to each child runtime).

interface UserWorkerEntry {
  workerId: number;
  parentHostWorkerId: number;
  childHostHandle: HostWorkerHandle;
  childWasmWorker: Worker;
  exited: boolean;
}

const MAX_USER_WORKERS = 16;
const userWorkers = new Map<number, UserWorkerEntry>();
let nextUserWorkerId = 1;
// E24-mandated shared compiled wasm Module.  Lazy-fetched and compiled
// on first spawn; postMessage'd to every child runtime worker so they
// skip the ~22 ms compile step (verified perfectly cloneable per E24).
let cachedWasmModulePromise: Promise<WebAssembly.Module> | null = null;

function getOrCompileSharedWasmModule(): Promise<WebAssembly.Module> {
  if (!cachedWasmModulePromise) {
    cachedWasmModulePromise = (async () => {
      const resp = await fetch("/edgejs.wasm");
      const bytes = await resp.arrayBuffer();
      const mod = await WebAssembly.compile(bytes);
      append(`worker-threads: shared wasm Module compiled (${(bytes.byteLength / 1_000_000).toFixed(1)} MB)`, "info");
      return mod;
    })();
  }
  return cachedWasmModulePromise;
}

// Module-scope: extraPolicies as parsed from the page URL at startup.
// spawnUserWorker reads this so children inherit the same policy set as
// the parent.  Hoisted out of the bootstrap-time `extraPolicies` const
// (declared at the very bottom of this file) via a module-level binding.
// Followup e33: previously, children booted with only defaultBrowserPolicies,
// so cross-child port-transfer tests had to inline ~3 KB of helpers into
// every child bootstrap.  Forwarding the parent's policy list closes the
// gap — real user code that spawns workers under a policy now gets the
// same policy patches active on the children.
const childInheritedPolicies: string[] = [];

async function spawnUserWorker(
  parentHostWorkerId: number,
  bootstrapScript: string,
  workerData: Uint8Array,
): Promise<number> {
  if (userWorkers.size >= MAX_USER_WORKERS) {
    throw new Error(`spawnUserWorker: cap reached (${MAX_USER_WORKERS}). Per E24, default cap protects against tab OOM.`);
  }
  const workerId = nextUserWorkerId++;
  const sharedModule = await getOrCompileSharedWasmModule();
  // Spawn child host worker -- same primitive as the primary host.
  // Pass the same bootScript so user-spawned worker_threads can also
  // call child_process.spawnSync and reach the deployment's executor.
  const childHostHandle = spawnHostWorker({ bootScript: hostWorkerBootScript });
  attachHostWorkerMessageHandlers(childHostHandle);
  await childHostHandle.ready;
  // Spawn child wasm runtime worker.  It must boot in user-worker mode
  // (init message carries the srcPath + preCompiledWasmModule).
  const childWasmWorker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  // Forward FS snapshot SAB (shared across all runtimes per R21 / WC
  // pattern).
  childWasmWorker.postMessage({ kind: "edge-fs-snapshot-sab", sab: fsSnapshotSab });
  // Forward RPC SABs paired with the child host worker.
  childWasmWorker.postMessage({
    kind: "edge-host-rpc-sab",
    hostWorkerId: childHostHandle.id,
    requestSab: childHostHandle.requestSab,
    replySab: childHostHandle.replySab,
    reverseRequestSab: childHostHandle.reverseRequestSab,
    reverseReplySab: childHostHandle.reverseReplySab,
    sharedWakeSab: childHostHandle.sharedWakeSab,
    napiMemorySab: childHostHandle.napiMemorySab,
  });
  // Phase 1: tell the child wasm runtime it's a user worker; carries the
  // pre-compiled Module (skip compile, E24) and the bootstrap script
  // to run as edge.js's `-e` user script after boot.  Per E25, this
  // message is queued on the child Worker's mailbox before its event
  // loop turns, so it's processed in order.
  childWasmWorker.postMessage({
    kind: "edge-user-worker-bootstrap",
    workerId,
    bootstrapScript,
    workerData,
    sharedWasmModule: sharedModule,
    // Followup e33: propagate the parent page's `?policies=...` so the
    // child wasm runtime applies the same policy patches.  Without
    // this, user code spawning workers under a policy (e.g.,
    // worker-threads-per-thread) would silently lose those patches
    // on the child.
    extraPolicies: childInheritedPolicies.slice(),
  });
  // Forward log + exit messages from the child wasm runtime.  When the
  // child catches ExitSignal in _start it posts `user-worker-exit` to
  // its parent (us); we route to the child's host worker so the host
  // forwards it through the chain to the parent's wasm.
  childWasmWorker.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { kind?: string; text?: string; level?: string; workerId?: number; exitCode?: number };
    if (d?.kind === "log" && typeof d.text === "string") {
      // Mangle the child's `_start ran X ms (exit=N)` sentinel so the
      // browser-test-runner's SENTINEL_RE doesn't match it (it would
      // otherwise pick up the child's exit code instead of the
      // parent's).  Also force level to "info" so child stdout doesn't
      // pollute parent's stdout — the test-runner only scrapes
      // `.lvl-out` for stdout comparison.
      const mangled = d.text.replace(/_start ran/g, "_start.ran");
      append(`[user-worker:${workerId}] ${mangled}`, "info");
      return;
    }
    if (d?.kind === "user-worker-exit") {
      if (typeof d.workerId !== "number" || typeof d.exitCode !== "number") return;
      const errBytes = (d as { errorBytes?: Uint8Array | null }).errorBytes;
      handleUserWorkerExit(d.workerId, d.exitCode, errBytes ?? null);
    }
  });
  const entry: UserWorkerEntry = {
    workerId,
    parentHostWorkerId,
    childHostHandle,
    childWasmWorker,
    exited: false,
  };
  userWorkers.set(workerId, entry);
  const preview = bootstrapScript.length > 60 ? bootstrapScript.slice(0, 60) + "..." : bootstrapScript;
  append(`worker-threads: spawned user worker #${workerId} (parent host #${parentHostWorkerId}, bootstrap=${JSON.stringify(preview)})`, "info");
  return workerId;
}

function attachHostWorkerMessageHandlers(handle: HostWorkerHandle): void {
  handle.worker.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as {
      kind?: string;
      text?: string;
      level?: string;
      requestId?: number;
      parentHostWorkerId?: number;
      bootstrapScript?: string;
      workerData?: Uint8Array;
      workerId?: number;
      exitCode?: number;
    };
    if (data?.kind === "host-log") {
      append(data.text ?? "", (data.level as "info" | "warn" | "err") ?? "info");
      return;
    }
    if (data?.kind === "spawn-user-worker") {
      const { requestId, parentHostWorkerId, bootstrapScript, workerData } = data as typeof data & { bootstrapScript?: string };
      if (typeof requestId !== "number" || typeof parentHostWorkerId !== "number" || typeof bootstrapScript !== "string") {
        handle.worker.postMessage({
          kind: "spawn-user-worker-reply",
          requestId,
          error: "spawn-user-worker: missing fields",
        });
        return;
      }
      const wd = workerData ?? new Uint8Array(0);
      spawnUserWorker(parentHostWorkerId, bootstrapScript, wd).then((workerId) => {
        handle.worker.postMessage({
          kind: "spawn-user-worker-reply",
          requestId,
          workerId,
        });
      }).catch((err: Error) => {
        handle.worker.postMessage({
          kind: "spawn-user-worker-reply",
          requestId,
          error: err.message,
        });
      });
      return;
    }
    // (Removed: run-child-process executor used to run here on main. It
    // now lives in the host worker itself per the main-thread-no-work
    // architectural rule. See memory/feedback-main-thread-no-execution
    // and host-worker.ts:runChildProcessInHostWorker.)
    // Phase 2: parent→child postMessage routing.
    // Parent host posts `worker-message-to-child {workerId, bytes}`; we
    // look up the child host by workerId in `userWorkers` and forward
    // via postMessage as `deliver-message-to-child`.
    if (data?.kind === "worker-message-to-child") {
      const wid = (data as { workerId?: number }).workerId;
      const bytes = (data as { bytes?: Uint8Array }).bytes;
      if (typeof wid !== "number" || !(bytes instanceof Uint8Array)) {
        append(`worker-threads: worker-message-to-child missing fields`, "warn");
        return;
      }
      const entry = userWorkers.get(wid);
      if (!entry) {
        append(`worker-threads: worker-message-to-child #${wid} but no such user worker`, "warn");
        return;
      }
      entry.childHostHandle.worker.postMessage({
        kind: "deliver-message-to-child",
        bytes,
      });
      return;
    }
    // Phase 2: child→parent postMessage routing.
    // Child host posts `worker-message-to-parent {childHostWorkerId, bytes}`;
    // we scan `userWorkers` to find the entry whose childHostHandle.id
    // matches, then forward to that entry's parent host as
    // `deliver-message-from-child {workerId, bytes}`.
    if (data?.kind === "worker-message-to-parent") {
      const chid = (data as { childHostWorkerId?: number }).childHostWorkerId;
      const bytes = (data as { bytes?: Uint8Array }).bytes;
      if (typeof chid !== "number" || !(bytes instanceof Uint8Array)) {
        append(`worker-threads: worker-message-to-parent missing fields`, "warn");
        return;
      }
      let entry: UserWorkerEntry | undefined;
      for (const e of userWorkers.values()) {
        if (e.childHostHandle.id === chid) { entry = e; break; }
      }
      if (!entry) {
        append(`worker-threads: worker-message-to-parent from host #${chid} but no matching user worker`, "warn");
        return;
      }
      // Find the parent host worker (same lookup pattern as
      // handleUserWorkerExit).  parentHostWorkerId=0 is the primary
      // host; otherwise scan userWorkers.
      let parentHostWorker: Worker | null = null;
      if (hostHandle && hostHandle.id === entry.parentHostWorkerId) {
        parentHostWorker = hostHandle.worker;
      } else {
        for (const e of userWorkers.values()) {
          if (e.childHostHandle.id === entry.parentHostWorkerId) {
            parentHostWorker = e.childHostHandle.worker;
            break;
          }
        }
      }
      if (!parentHostWorker) {
        append(`worker-threads: worker-message-to-parent #${entry.workerId} but parent host #${entry.parentHostWorkerId} not found`, "warn");
        return;
      }
      parentHostWorker.postMessage({
        kind: "deliver-message-from-child",
        workerId: entry.workerId,
        bytes,
      });
      return;
    }
  });
}

// Called when a child user-worker's wasm runtime exits.  The wasm
// posts `user-worker-exit` directly to main (us — its Worker spawner);
// we look up the parent host worker, forward via postMessage, and
// terminate the child's pair.
function handleUserWorkerExit(workerId: number, exitCode: number, errorBytes?: Uint8Array | null): void {
  const entry = userWorkers.get(workerId);
  if (!entry) return;
  if (entry.exited) return;
  entry.exited = true;
  // Find the parent's host worker by id.  Primary host (id=0) is
  // hostHandle; user-spawned hosts are entries in userWorkers
  // (indexed by workerId, not hostWorkerId — need to scan).
  let parentHostWorker: Worker | null = null;
  if (hostHandle && hostHandle.id === entry.parentHostWorkerId) {
    parentHostWorker = hostHandle.worker;
  } else {
    for (const e of userWorkers.values()) {
      if (e.childHostHandle.id === entry.parentHostWorkerId) {
        parentHostWorker = e.childHostHandle.worker;
        break;
      }
    }
  }
  if (!parentHostWorker) {
    append(`worker-threads: user-worker-exit #${workerId} but parent host #${entry.parentHostWorkerId} not found`, "warn");
    return;
  }
  parentHostWorker.postMessage({
    kind: "deliver-user-worker-exit",
    workerId,
    exitCode,
    // Phase 3c (e33+): forward error info if the child threw an uncaught
    // exception.  Parent host re-includes in the reverse-RPC payload to
    // the parent wasm, which fires 'error' before 'exit' per Node spec.
    errorBytes: errorBytes ?? null,
  });
  // Terminate the child workers — they've exited from user code's POV.
  entry.childWasmWorker.terminate();
  entry.childHostHandle.worker.terminate();
  userWorkers.delete(workerId);
  append(`worker-threads: user worker #${workerId} exited (code=${exitCode}), forwarded to parent host #${entry.parentHostWorkerId}`, "info");
}

function installDownload(payload: string, format: "json" | "jsonl") {
  const mime = format === "json" ? "application/json" : "application/x-ndjson";
  const blob = new Blob([payload], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `edgejs-trace-${Date.now()}.${format}`;
  const label = format === "jsonl" ? "download JSONL (diff vs native)" : "download full trace";
  link.textContent = `${label} (${(blob.size / 1024).toFixed(0)} KB)`;
  link.style.cssText = "display:inline-block;margin:8px 16px;color:#a5d8ff;";
  document.body.insertBefore(link, logEl);
}

// URL params for harness debugging:
//   ?mem=<sym1,sym2>  → enable memory snapshots for these wasi/wasix symbols
//                        (captures bytes around pointer args; surfaces in
//                         the trace under fields.mem.before / .after)
const params = new URLSearchParams(location.search);
const memParam = params.get("mem");
const memSnapshotSymbols = memParam ? memParam.split(",").map((s) => s.trim()).filter(Boolean) : [];
const diagnoseSabAliasing = params.get("diag") === "sab-aliasing";
const watchByteLength = params.get("diag") === "bytelen";
// `?script=<URL-encoded-edge-js-program>` — run a user script instead of
// the default HTTP server demo.  Used by the in-browser test harness for
// regression / JSPI validation.  Stdout/stderr flow through to the page log.
// URLSearchParams.get() already decodes percent-escaping, so the script
// is plain JS source by the time it gets here.
const userScript = params.get("script");
// F-6: ?host=1 routes the user script to host worker's V8 (via
// OP_RUN_USER_SCRIPT) instead of through edge.js inside the wasm
// runtime worker.  Unblocks the microtask-ordering regressions whose
// expected semantics are host V8's natural microtask drain; JSPI
// suspension in the wasm worker starves those microtasks.
const scriptViaHost = userScript !== null && params.get("host") === "1";

// L3 RPC throughput bench.  Triggered via ?bench=echo&iters=N[&payload=K].
// The wasm runtime worker doesn't need to participate — we run the bench
// here on the page using the same SAB rings the wasm worker would use.
// (For per-call RTT this is representative; postMessage hop from page to
// worker is roughly equivalent to the wasm worker's own dispatch.)
const benchEcho = params.get("bench") === "echo"
  ? { iters: parseInt(params.get("iters") ?? "1000", 10), payload: parseInt(params.get("payload") ?? "32", 10) }
  : null;
const probeReverseEcho = params.get("probe") === "reverse-echo";
const l5UserScript = params.get("l5script"); // L5 spike
const l9MultiHost = params.get("probe") === "l9-multi-host"; // L9 spike
const f1NapiProbe = params.get("probe") === "f1-napi";        // F-1 first napi op via RPC
const f9SweepProbe = params.get("probe") === "f9-sweep";      // F-9 one-op-per-batch sweep
const scopeBoundedProbe = params.get("probe") === "scope-bounded"; // B / scope-op forwarding

// Main-thread executor for child-process-via-executor async path.
// URL param `mainExecutor=<encoded JS source>` is eval'd here to
// install `globalThis.__edgeChildProcessExecutor` on main. Useful for
// tests that need to exercise the async path without setting up a
// full deployment-config file. Production deployments would install
// the executor in their own bootstrap code instead.
// `executor64=<base64 JS>` -- base64-encoded JS source forwarded to
// the host worker's init bootScript. Used by the child-process-via-executor
// policy's async path: the source runs INSIDE the host worker (not on
// main) and installs `globalThis.__edgeChildProcessExecutor` there.
// Base64 avoids the harness-args whitespace-splitter that would
// tokenize a raw JS source.
//
// Production deployments install via their own bootstrap code passed
// to `spawnHostWorker({ bootScript: ... })`; this URL hatch exists
// only for the browser test harness.
const executorB64 = params.get("executor64");
const hostWorkerBootScript = executorB64 ? (() => {
  try { return atob(executorB64); }
  catch (e) {
    append(`executor64 decode failed: ${(e as Error).message}`, "err");
    return undefined;
  }
})() : undefined;

append("page bootstrap ok. crossOriginIsolated=" + crossOriginIsolated, "info");
if (memSnapshotSymbols.length > 0) {
  append(`mem-snapshot symbols: ${memSnapshotSymbols.join(", ")}`, "info");
}
if (diagnoseSabAliasing) {
  append("diagnostic mode: SAB view aliasing — edge will NOT boot this run", "info");
}

// HTTP bridge: register the service worker and hand it a MessagePort that's
// connected to the edge worker.  This lets fetch('/_edge/...') from anywhere
// on the page reach an HTTP server hosted inside the wasm sandbox.
// Gated on edge actually running (#14) — until then, /_edge/* returns 503.
async function setupBridge() {
  if (!("serviceWorker" in navigator)) {
    append("bridge: service workers unsupported — skipping HTTP bridge", "warn");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const sw = reg.active ?? navigator.serviceWorker.controller;
    if (!sw) { append("bridge: no active SW after registration", "warn"); return; }
    activeSW = sw;
    // #!~debt sw-sab-relay: SharedArrayBuffer payloads silently fail to
    // cross postMessage hops into a Service Worker on Chrome 148 — even
    // direct page → SW with SAB in the payload doesn't deliver.  So the
    // SW never sees the SABs.  All per-request traffic flows:
    //
    //   SW (fetch intercept)
    //     ↓ postMessage(edge-req) to page (Client)
    //   page (here)
    //     ↓ writes JSON into bridgeSab, Atomics.notify(wakeSab, 0)
    //   worker (blocked in Atomics.wait inside accept_v2)
    //     ↓ reads JSON, runs through edge, writes response
    //     ↓ postMessage(page-edge-res) back to page
    //   page
    //     ↓ postMessage(edge-res) to SW
    //   SW resolves the original fetch
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.kind === "sw-log") {
        append(String(e.data.text), "info");
        return;
      }
      if (e.data?.kind === "edge-req") {
        append(`bridge: page got edge-req reqId=${e.data.reqId} path=${e.data.path}`, "info");
        dispatchEdgeReq(e.data.reqId, e.data.method, e.data.path, e.data.headers, e.data.body ?? null);
      }
    });
    append("bridge: SW registered", "info");
  } catch (err) {
    append(`bridge: SW registration failed — ${(err as Error).message}`, "warn");
  }
}

setupBridge();
// Defer the "start" message until the runtime worker exists — the
// bridge worker spawns it after publishing the FS snapshot SAB.
// ?spinLimit=N (0 disables) — override the wasi-call spin watchdog,
// useful for benchmarks or to chase a real spin without abort.
const spinLimitParam = params.get("spinLimit");
const spinLimit = spinLimitParam !== null ? Math.max(0, Number(spinLimitParam) | 0) : undefined;
// ?trace=0 disables per-call wasi import tracing.  Tracing allocates
// arg/return objects on every import (25k+ per HTTP request); skipping
// it is a real win for benchmarks and production deployments.
const traceDisabled = params.get("trace") === "0";
// ?policies=name1,name2 — opt-in extra policies appended to defaults.
// See policies/index.ts policyRegistry for available names.
const policiesParam = params.get("policies");
const extraPolicies = policiesParam ? policiesParam.split(",").map((s) => s.trim()).filter(Boolean) : [];
// Followup e33: stash parent policies for child workers spawned later.
for (const p of extraPolicies) childInheritedPolicies.push(p);
postToRuntime({ kind: "start", memSnapshotSymbols, diagnoseSabAliasing, watchByteLength, userScript, spinLimit, traceDisabled, extraPolicies });
