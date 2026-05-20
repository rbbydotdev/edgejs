// Worker entry.  Runs two payloads in sequence:
//   1) hello.wasm — minimal WASI program; smoke-tests the worker + WASI shim.
//   2) edgejs.wasm — the real target; uses emnapi for standard napi_* and our
//      hand-rolled unofficial_napi_* layer + the WASI shim.

import { buildImports } from "./imports-generated";
import { createWasiShim, ExitSignal } from "./wasi-shim";
import { Trace, toUnifiedJsonl } from "./trace";
import { createNapiHost } from "./napi-host";
import { createBundledFs } from "./host/fs/adapters/bundled";
import { DEFAULT_MEM_OPTIONS, instrumentNamespace, pendingMem } from "./mem-snapshot";
import { runSabViewAliasingDiagnostic, formatReport as formatSabReport } from "./diagnostics/sab-view-aliasing";
import { createByteLengthWatcher, formatEvents as formatBlEvents } from "./diagnostics/byteLength-watcher";

declare const self: DedicatedWorkerGlobalScope;

// Edge's bootstrap mutates globalThis (it expects to own the global env).
// Capture native APIs we need *before* we hand control to the wasm so edge
// can't shadow them mid-run.
const nowMs = performance.now.bind(performance);

function post(kind: string, payload: Record<string, unknown> = {}) {
  self.postMessage({ kind, ...payload });
}

async function runHelloSmokeTest() {
  post("section", { text: "── hello.wasm (smoke test) ──" });
  const resp = await fetch("/hello.wasm");
  const wasmBytes = await resp.arrayBuffer();
  post("log", { text: `fetched hello.wasm (${wasmBytes.byteLength} bytes)`, level: "info" });

  const memoryHolder: { memory: WebAssembly.Memory | null } = { memory: null };

  const shim = createWasiShim({
    get memory() {
      if (!memoryHolder.memory) throw new Error("memory not ready");
      return memoryHolder.memory;
    },
    args: ["hello"],
    env: {},
    fs: createBundledFs(),
    postLog: (text: string, level?: string) => {
      if (level === "out") {
        post("log", { text: `[stdout] ${text}`, level: "out" });
      } else {
        post("log", { text, level: level ?? "info" });
      }
    },
    postExit: () => { /* handled via ExitSignal */ },
  } as never);

  const t0 = nowMs();
  const instance = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: shim.wasi_snapshot_preview1 as Record<string, WebAssembly.ImportValue>,
  });
  memoryHolder.memory = (instance.instance.exports as { memory: WebAssembly.Memory }).memory;
  post("log", { text: `instantiated in ${(nowMs() - t0).toFixed(0)} ms`, level: "info" });

  try {
    (instance.instance.exports._start as () => void)();
    post("log", { text: "_start returned without proc_exit", level: "warn" });
  } catch (e) {
    if (e instanceof ExitSignal) {
      post("log", { text: `✓ end-to-end success (exit=${e.code})`, level: e.code === 0 ? "out" : "info" });
    } else {
      post("log", { text: `threw: ${(e as Error).stack ?? e}`, level: "err" });
    }
  }
}

async function runEdgeWithEmnapi() {
  post("section", { text: "── edgejs.wasm (emnapi + WASI host) ──" });
  const trace = new Trace();

  const resp = await fetch("/edgejs.wasm");
  const wasmBytes = await resp.arrayBuffer();
  post("log", { text: `fetched edgejs.wasm (${(wasmBytes.byteLength / 1_000_000).toFixed(1)} MB)`, level: "info" });

  const memory = new WebAssembly.Memory({ initial: 337, maximum: 65536, shared: true });
  post("log", {
    text: `memory: ${memory.buffer.byteLength / 65536} pages, shared=${memory.buffer instanceof SharedArrayBuffer}`,
    level: "info",
  });

  // emnapi host — provides standard napi_* + env helpers + our unofficial_napi_*
  const napi = createNapiHost({ memory });
  post("log", { text: `napi-host: ${Object.keys(napi.imports.napi).length} napi entries seeded`, level: "info" });

  // FileSystem facade — bundled adapter serves /node-lib/** and /node/deps/**
  // out of the page origin via sync XHR.  Any other path returns NOENT.
  const bundledFs = createBundledFs({
    log: (line) => post("log", { text: line, level: "info" }),
  });

  // Wasi shim — provides wasi_snapshot_preview1, wasix_32v1, wasi.thread-spawn
  const shim = createWasiShim({
    memory,
    args: ["edgejs", "-e", "console.log('hello from edgejs in browser')"],
    // Match native napi_wasmer baseline — wasmer-wasix passes no env by
    // default and edge boots fine.  Adding env vars made wasi-libc trigger
    // a different init path that breaks uv_cwd downstream.
    env: {},
    fs: bundledFs,
    postLog: (text, level) => {
      if (level === "out") post("log", { text: `[stdout] ${text}`, level: "out" });
      else if (level === "warn") post("log", { text: `[stderr] ${text}`, level: "warn" });
      else post("log", { text, level: level ?? "info" });
    },
    postExit: () => { /* via ExitSignal */ },
  });

  // If the page enabled memory-snapshot debugging for specific symbols,
  // wrap those namespaces so each call captures bytes around pointer args.
  // The wrapper stashes captures on `pendingMem`; the trace callback below
  // drains it on the matching call so we get one trace record per call.
  let wasiNs = memSnapshotSymbols.size > 0
    ? instrumentNamespace(shim.wasi_snapshot_preview1, "wasi_snapshot_preview1", memory,
        { ...DEFAULT_MEM_OPTIONS, enabledSymbols: memSnapshotSymbols })
    : shim.wasi_snapshot_preview1;
  let wasixNs = memSnapshotSymbols.size > 0
    ? instrumentNamespace(shim.wasix_32v1, "wasix_32v1", memory,
        { ...DEFAULT_MEM_OPTIONS, enabledSymbols: memSnapshotSymbols })
    : shim.wasix_32v1;
  if (memSnapshotSymbols.size > 0) {
    post("log", { text: `mem-snapshot enabled for: ${[...memSnapshotSymbols].join(", ")}`, level: "info" });
  }

  // #14 diagnostic: when watchByteLength is on, wrap the shim namespaces with
  // a byteLength/SAB-identity watcher.  Logs every change.  Helps test
  // Hypothesis B (memory.grow during bootstrap → stale buffer references).
  let blWatcher: ReturnType<typeof createByteLengthWatcher> | null = null;
  if (watchByteLength) {
    blWatcher = createByteLengthWatcher(memory);
    wasiNs = blWatcher.wrap(wasiNs, "wasi_snapshot_preview1");
    wasixNs = blWatcher.wrap(wasixNs, "wasix_32v1");
    post("log", { text: `byteLength watcher: armed on wasi/wasix namespaces`, level: "info" });
    post("log", { text: `byteLength initial: ${memory.buffer.byteLength}`, level: "info" });
  }

  // Compose: emnapi's napi/env/emnapi + our wasi/wasix.  Anything not covered
  // here falls through to the generated logging stubs.
  const overrides = {
    napi: napi.imports.napi as Record<string, Function>,
    env: napi.imports.env as Record<string, Function>,
    wasi_snapshot_preview1: wasiNs,
    wasix_32v1: wasixNs,
    wasi: shim.wasi,
  };
  // Hard call cap — if edge gets stuck in an event-loop spin we want to see
  // the recent calls instead of a frozen page.  Reasonable bootstraps run
  // a few thousand calls; 20k is well beyond that.
  // #!~debt crude circuit breaker: a fixed call count is the wrong shape.
  // Real impl should be a watchdog timer (e.g. abort if >N seconds since
  // any new symbol fired) or progress-based (abort if call mix becomes
  // monotonous).  Count cap will misfire once we run real workloads.
  const CALL_LIMIT = 20000;
  let callCount = 0;
  const wasmImports = buildImports(memory, overrides, (ns, sym, args, ret, stub) => {
    // If the mem-snapshot wrapper just ran on this call, it left snapshots
    // on the side channel.  Pick them up and attach to this canonical record.
    const mem = pendingMem.value;
    if (mem) pendingMem.value = null;
    trace.record(ns, sym, args, ret, stub, mem ?? undefined);
    if (++callCount === CALL_LIMIT) {
      throw new Error(`CALL_LIMIT (${CALL_LIMIT}) reached — likely spin loop`);
    }
  });

  // emnapi puts its own env.memory; make sure it's the one we want.
  (wasmImports.env as Record<string, unknown>).memory = memory;

  const t0 = nowMs();
  const module = await WebAssembly.compile(wasmBytes);
  post("log", { text: `compiled in ${(nowMs() - t0).toFixed(0)} ms`, level: "info" });

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, wasmImports);
  } catch (e) {
    post("log", { text: `INSTANTIATE FAILED: ${(e as Error).message}`, level: "err" });
    return;
  }
  post("log", { text: "instantiated; binding emnapi to instance…", level: "info" });

  try {
    napi.bindInstance(instance, module);
    post("log", { text: "emnapi bound; running _start…", level: "info" });
  } catch (e) {
    post("log", { text: `emnapi.bindInstance threw: ${(e as Error).message}`, level: "err" });
    // Continue anyway — see what _start does with whatever state we have.
  }

  const start = (instance.exports as { _start?: () => void })._start;
  if (!start) { post("log", { text: "no _start export", level: "err" }); return; }

  let exitCode: number | null = null;
  let threwMsg: string | null = null;
  const tStart = nowMs();
  try { start(); }
  catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else threwMsg = (e as Error).stack ?? String(e);
  }
  const runMs = nowMs() - tStart;

  post("log", {
    text: `_start ran ${runMs.toFixed(0)} ms ` +
      (exitCode !== null ? `(exit=${exitCode})` : threwMsg ? `(THREW)` : "(returned)"),
    level: exitCode === 0 ? "info" : exitCode !== null ? "err" : threwMsg ? "err" : "info",
  });
  if (blWatcher) {
    const events = blWatcher.drain();
    post("log", { text: `byteLength events: ${events.length}`, level: "info" });
    for (const line of formatBlEvents(events).slice(0, 50)) {
      post("log", { text: line, level: "info" });
    }
    post("log", {
      text: `byteLength final: ${memory.buffer.byteLength} (initial 22085632)`,
      level: "info",
    });
  }

  const summary: string[] = [];
  summary.push(`total calls: ${trace.all().length}`);
  summary.push("by namespace:");
  for (const [ns, s] of trace.byNamespace()) {
    summary.push(`  ${ns.padEnd(28)} total=${String(s.total).padStart(5)}  distinct=${s.distinct}`);
  }
  summary.push("ALL distinct calls (by count):");
  for (const s of trace.topByCount(100)) {
    const flag = s.stub ? "STUB" : "impl";
    summary.push(`  [${flag}]  ${String(s.count).padStart(5)}  ${s.ns}.${s.sym}`);
  }
  // Errno-proxy: every non-zero return from wasi/wasix sets libc's errno.
  // Listing them in order shows what errno value the wasm last saw before
  // any failure.  Filter out napi (return semantics differ — 0 is OK there too).
  summary.push("");
  summary.push("non-zero wasi/wasix returns (errno proxy):");
  const errnoEvents = trace.all().filter((r) =>
    (r.ns === "wasi_snapshot_preview1" || r.ns === "wasix_32v1" || r.ns === "wasi") &&
    typeof r.ret === "number" && r.ret !== 0,
  );
  if (errnoEvents.length === 0) {
    summary.push("  (none — every wasi syscall succeeded)");
  } else {
    for (const r of errnoEvents.slice(-20)) {
      summary.push(`  ${r.t.toFixed(1).padStart(7)}ms  ${r.ns}.${r.sym}(${r.args.map((a) => JSON.stringify(a)).join(", ")}) -> errno=${r.ret}`);
    }
  }
  summary.push("last 30 calls (closest to exit):");
  for (const r of trace.tail(30)) {
    const flag = r.stub ? "STUB" : "impl";
    const ret = typeof r.ret === "string" ? r.ret : JSON.stringify(r.ret);
    summary.push(`  ${r.t.toFixed(1).padStart(7)}ms  [${flag}]  ${r.ns}.${r.sym}(${r.args.map((a) => JSON.stringify(a)).join(", ")}) -> ${ret}`);
  }
  if (threwMsg) {
    summary.push("");
    summary.push("--- threw ---");
    summary.push(threwMsg.split("\n").slice(0, 8).join("\n"));
  }
  post("log", { text: "\n" + summary.join("\n"), level: "info" });

  const json = JSON.stringify({ exitCode, threw: threwMsg, runMs, summary: trace.summarize(), tail: trace.tail(200), all: trace.all() }, null, 2);
  const jsonl = toUnifiedJsonl(trace);
  post("report", { json, jsonl });
}

function runDiagnostics() {
  post("section", { text: "── #14 diagnostic: SAB view aliasing (Hypothesis A) ──" });
  try {
    const reports = runSabViewAliasingDiagnostic();
    for (const line of formatSabReport(reports)) {
      post("log", { text: line, level: "info" });
    }
  } catch (e) {
    post("log", { text: `diagnostic threw: ${(e as Error).stack ?? e}`, level: "err" });
  }
}

async function boot() {
  try {
    if (runDiagnosticsFirst) {
      runDiagnostics();
      post("status", { text: "diagnostic complete" });
      return;
    }
    await runHelloSmokeTest();
    await runEdgeWithEmnapi();
    post("status", { text: "done" });
  } catch (err) {
    post("log", { text: `FATAL: ${(err as Error).stack ?? err}`, level: "err" });
    post("status", { text: "crashed" });
  }
}

// Worker boot accepts a config payload so the page can pass URL-param-style
// options (e.g. memory snapshot symbols to instrument).
let memSnapshotSymbols: Set<string> = new Set();
let runDiagnosticsFirst = false;
let watchByteLength = false;

// HTTP bridge: SW gives us a MessagePort.  Each {kind:"edge-req"} that
// arrives is an HTTP request the SW intercepted at /_edge/*; we translate
// it into a JS call against whatever HTTP server edge.js exposes inside
// the sandbox, then post the response back.
//
// Gated on #14 — until edge boots cleanly there's nothing to dispatch to.
// We still accept the port so the connection survives across edge restarts.
let bridgePort: MessagePort | null = null;
function onBridgeMessage(e: MessageEvent) {
  const msg = e.data as { kind: string; reqId: number; method: string; path: string; headers: Record<string, string>; body?: ArrayBuffer | null };
  if (msg?.kind !== "edge-req") return;
  // #!~debt stub responder: real impl dispatches to a JS-side handle on
  // the running edge instance (probably via an emnapi-exposed callback or
  // a virtual loopback socket pump).  Until #14 unblocks, just 501.
  const bodyText = `edge bridge stub — ${msg.method} ${msg.path}\n#14 must unblock first`;
  bridgePort?.postMessage({
    kind: "edge-res",
    reqId: msg.reqId,
    status: 501,
    headers: { "content-type": "text/plain" },
    bodyText,
  });
}

self.onmessage = (e) => {
  if (e.data?.kind === "bridge-port" && e.data.port instanceof MessagePort) {
    const port = e.data.port as MessagePort;
    bridgePort = port;
    port.onmessage = onBridgeMessage;
    port.start();
    return;
  }
  if (e.data?.kind === "start") {
    if (Array.isArray(e.data.memSnapshotSymbols)) {
      memSnapshotSymbols = new Set(e.data.memSnapshotSymbols);
    }
    if (e.data.diagnoseSabAliasing === true) {
      runDiagnosticsFirst = true;
    }
    if (e.data.watchByteLength === true) {
      watchByteLength = true;
    }
    boot();
  }
};
