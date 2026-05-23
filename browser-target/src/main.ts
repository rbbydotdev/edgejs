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
    hostHandle = spawnHostWorker();
    hostHandle.worker.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data as { kind?: string; text?: string; level?: string };
      if (data?.kind === "host-log") {
        append(data.text ?? "", (data.level as "info" | "warn" | "err") ?? "info");
      }
    });
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
  // L5 spike: run a user script via host eval.  Bypasses edge.js
  // entirely; useful for validating that microtasks drain correctly
  // when user JS runs on host V8.
  if (l5UserScript && hostHandle) {
    await runL5UserScript(l5UserScript);
  }
  // L9 spike: spawn a second host worker, ping both, verify replies
  // come back to the right one.  Validates the multi-host topology
  // and the contextId/hostWorkerId routing we baked in from L1.
  if (l9MultiHost) {
    await runL9MultiHostSpike();
  }
}

async function runL9MultiHostSpike(): Promise<void> {
  const { spawnHostWorker } = await import("./host-worker/worker-pool");
  const { attachRing } = await import("./wasi-shim/sab-ring");
  const { RpcClient } = await import("./host-worker/rpc-client");
  const { OP_PING, OP_HOST_ECHO } = await import("./host-worker/rpc-protocol");
  const ringConfig = { numSlots: 32, slotSize: 4 * 1024 };
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

async function runL5UserScript(source: string): Promise<void> {
  if (!hostHandle) return;
  const { attachRing } = await import("./wasi-shim/sab-ring");
  const { RpcClient } = await import("./host-worker/rpc-client");
  const { OP_RUN_USER_SCRIPT } = await import("./host-worker/rpc-protocol");
  const ringConfig = { numSlots: 32, slotSize: 4 * 1024 };
  const reqRing = attachRing(hostHandle.requestSab, ringConfig);
  const replyRing = attachRing(hostHandle.replySab, ringConfig);
  const client = new RpcClient(reqRing, replyRing);
  const payload = new TextEncoder().encode(source);
  try {
    const reply = await client.call(OP_RUN_USER_SCRIPT, 0, 0, payload);
    const text = new TextDecoder().decode(reply.payload);
    append(`l5-script-result: ${text}`, "info");
    append(`l5-script-status: ${reply.status}`, reply.status === 0 ? "info" : "err");
  } catch (e) {
    append(`l5-script-error: ${(e as Error).message}`, "err");
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
  const ringConfig = { numSlots: 32, slotSize: 4 * 1024 };
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
postToRuntime({ kind: "start", memSnapshotSymbols, diagnoseSabAliasing, watchByteLength, userScript, spinLimit, traceDisabled, extraPolicies });
