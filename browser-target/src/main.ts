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
    append("bridge worker ready; spawning runtime worker", "info");
    spawnRuntimeWorker();
  }
};

function spawnRuntimeWorker() {
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  // Hand the FS snapshot SAB to runtime before any other message.
  worker.postMessage({ kind: "edge-fs-snapshot-sab", sab: fsSnapshotSab });
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
