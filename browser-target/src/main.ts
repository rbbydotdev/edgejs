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
  }
};
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
    const { port1, port2 } = new MessageChannel();
    sw.postMessage({ kind: "bridge-port", port: port1 }, [port1]);
    worker.postMessage({ kind: "bridge-port", port: port2 }, [port2]);
    append("bridge: SW registered, port handed to worker", "info");
  } catch (err) {
    append(`bridge: SW registration failed — ${(err as Error).message}`, "warn");
  }
}

setupBridge();
worker.postMessage({ kind: "start", memSnapshotSymbols, diagnoseSabAliasing, watchByteLength });
