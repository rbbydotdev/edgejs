// Service Worker HTTP bridge for edgejs-in-browser.
//
// The dedicated worker running edge.js can host an HTTP server on a virtual
// "loopback" socket inside the wasm sandbox.  Browsers can't speak directly
// to that socket — fetch() goes to the network or to whatever the SW
// intercepts.  This SW intercepts /_edge/* and forwards the request to the
// edge worker via MessageChannel.
//
// Wiring:
//   1. page registers SW (main.ts)
//   2. page exchanges a MessagePort pair with SW once "controllerchange"
//      fires; one port goes to the dedicated worker, the other lives in
//      the SW.  SW now talks directly to the worker without page involvement.
//   3. SW translates fetch ↔ {req, res} JSON over the port.
//
// #!~debt one-port-one-worker: each page registers a single port; if the
// page spawns multiple edge workers we'd need port multiplexing.  Defer
// until #14 unblocks and we know which workloads need parallel hosting.

const BRIDGE_PREFIX = "/_edge/";
let workerPort = null;
const pending = new Map(); // requestId -> { resolve, reject }
let nextReqId = 1;

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("message", (e) => {
  // The page sends us a MessagePort that's connected to the edge worker.
  if (e.data?.kind === "bridge-port" && e.data.port) {
    workerPort = e.data.port;
    workerPort.onmessage = onWorkerMessage;
    workerPort.start?.();
  }
});

function onWorkerMessage(e) {
  const msg = e.data;
  if (msg?.kind !== "edge-res") return;
  const slot = pending.get(msg.reqId);
  if (!slot) return;
  pending.delete(msg.reqId);
  slot.resolve(msg);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(BRIDGE_PREFIX)) return; // pass-through

  event.respondWith((async () => {
    if (!workerPort) {
      return new Response("edge bridge not ready (worker port not registered)", {
        status: 503, headers: { "content-type": "text/plain" },
      });
    }
    const reqId = nextReqId++;
    const body = event.request.body ? await event.request.arrayBuffer() : null;
    const headers = {};
    event.request.headers.forEach((v, k) => { headers[k] = v; });

    const result = await new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      workerPort.postMessage({
        kind: "edge-req",
        reqId,
        method: event.request.method,
        path: url.pathname.slice(BRIDGE_PREFIX.length - 1) + url.search, // strip prefix, keep leading "/"
        headers,
        body,
      }, body ? [body] : []);
      // Watchdog — if the worker never responds, fall back to a 504.
      setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          reject(new Error("edge worker timed out"));
        }
      }, 30000);
    }).catch((err) => ({
      status: 504, headers: { "content-type": "text/plain" },
      body: new TextEncoder().encode(String(err)),
    }));

    // body precedence: bodyText (string), then body (ArrayBuffer/Blob), else null.
    const responseBody = result.bodyText ?? result.body ?? null;
    return new Response(responseBody, {
      status: result.status ?? 200,
      headers: result.headers ?? {},
    });
  })());
});
