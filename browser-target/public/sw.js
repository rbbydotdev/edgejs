// Service Worker HTTP bridge for edgejs-in-browser.
//
// The dedicated worker hosts edge.js inside a wasm sandbox.  Browsers
// can't speak directly to the virtual sockets edge has open — fetch()
// goes to the network or to whatever the SW intercepts.  This SW
// intercepts /_edge/* and forwards the request to the *page* (which
// has direct access to the SAB transport shared with the worker).
//
// Why the page-mediated relay (not SW-direct):
//   SharedArrayBuffer payloads silently fail to cross postMessage hops
//   into a Service Worker on Chrome 148 — empirically verified:
//   plain-object messages on the same channel arrive fine, anything
//   containing a SAB does not (no error, no event).  So the SW stays
//   "stateless" relative to SABs: it forwards the request to the page
//   via Clients.postMessage, the page does the SAB write +
//   Atomics.notify, then the page reports the response back, and the
//   SW resolves the fetch.
//
// #!~debt single-flight: one inflight request at a time per SW
// instance.  Fine for the bring-up roundtrip; serving real concurrent
// load needs a per-request channel or a ring buffer.

const BRIDGE_PREFIX = "/_edge/";
const pending = new Map(); // reqId → { resolve, reject }
let nextReqId = 1;

async function swLog(msg) {
  console.log(msg);
  try {
    const clients = await self.clients.matchAll();
    for (const c of clients) c.postMessage({ kind: "sw-log", text: msg });
  } catch {}
}

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("message", (e) => {
  if (e.data?.kind === "edge-res") {
    const slot = pending.get(e.data.reqId);
    if (!slot) return;
    pending.delete(e.data.reqId);
    slot.resolve(e.data);
  }
});

async function getClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all[0] ?? null;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(BRIDGE_PREFIX)) return; // pass-through

  event.respondWith((async () => {
    const reqId = nextReqId++;
    swLog("[sw] fetch intercept reqId=" + reqId + " path=" + url.pathname);
    const body = event.request.body ? await event.request.arrayBuffer() : null;
    const headers = {};
    event.request.headers.forEach((v, k) => { headers[k] = v; });
    const req = {
      method: event.request.method,
      path: url.pathname.slice(BRIDGE_PREFIX.length - 1) + url.search,
      headers,
    };
    const client = await getClient();
    if (!client) {
      return new Response("edge bridge: no client to relay through", {
        status: 503, headers: { "content-type": "text/plain" },
      });
    }
    const result = await new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      client.postMessage({
        kind: "edge-req",
        reqId,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body,
      }, body ? [body] : []);
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

    const responseBody = result.bodyText ?? result.body ?? null;
    return new Response(responseBody, {
      status: result.status ?? 200,
      headers: result.headers ?? {},
    });
  })());
});
