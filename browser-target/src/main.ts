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

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
// Holds the active SW once setupBridge resolves.  Used to forward edge
// responses (edge-res) back via sw.postMessage so the SW can resolve
// the pending fetch.
let activeSW: ServiceWorker | null = null;
// The SABs the worker exposes for the HTTP bridge transport.  Set when
// the worker posts "relay-bridge-sab" with the boot SAB pair.
let bridgeI32: Int32Array | null = null;
let bridgeU8: Uint8Array | null = null;
let wakeI32: Int32Array | null = null;
const BRIDGE_SAB_HEADER_BYTES = 16;
const bridgeEncoder = new TextEncoder();

worker.onmessage = (e) => {
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
    bridgeI32 = new Int32Array(e.data.bridgeSab);
    bridgeU8 = new Uint8Array(e.data.bridgeSab);
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
  if (!bridgeI32 || !bridgeU8 || !wakeI32) {
    append("bridge: edge-req arrived before SAB transport was ready", "warn");
    return;
  }
  append(`bridge: dispatchEdgeReq id=${reqId} wakeBefore=${Atomics.load(wakeI32, 0)} bridgeBefore=${Atomics.load(bridgeI32, 0)}`, "info");
  const payload = {
    method,
    path,
    headers,
    bodyB64: body && body.byteLength > 0 ? arrayBufferToBase64(body) : undefined,
  };
  const json = bridgeEncoder.encode(JSON.stringify(payload));
  if (json.length > bridgeU8.length - BRIDGE_SAB_HEADER_BYTES) {
    append("bridge: request too large for SAB", "warn");
    return;
  }
  bridgeU8.set(json, BRIDGE_SAB_HEADER_BYTES);
  Atomics.store(bridgeI32, 1, json.length);
  Atomics.store(bridgeI32, 2, reqId);
  Atomics.add(bridgeI32, 0, 1);
  Atomics.add(wakeI32, 0, 1);
  const notified = Atomics.notify(wakeI32, 0);
  append(`bridge: dispatchEdgeReq notified=${notified} wakeAfter=${Atomics.load(wakeI32, 0)} bridgeAfter=${Atomics.load(bridgeI32, 0)}`, "info");
}
worker.onerror = (e) => {
  append(`WORKER ERROR: ${e.message} (${e.filename}:${e.lineno})`, "err");
  statusEl.textContent = "worker crashed";
};

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
worker.postMessage({ kind: "start", memSnapshotSymbols, diagnoseSabAliasing, watchByteLength });
