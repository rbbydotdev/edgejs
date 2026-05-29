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
// Concurrency: the SW keys pending requests by reqId in a Map, so
// multiple in-flight fetches are independent at this layer.  The worker
// bridge SAB on the other end is a ring of N slots; each request gets
// its own slot, so the whole pipeline is multi-request-capable.

const BRIDGE_PREFIX = "/_edge/";
const ESM_PREFIX = "/_edge_esm/";
const pending = new Map(); // reqId → { resolve, reject }
let nextReqId = 1;

// ESM source registry — keyed by ESM_PREFIX-prefixed pathname (the URL
// the browser fetches when it processes `import("/_edge_esm/<id>")`).
// Populated via `edge-esm-publish` messages from runtime workers ahead
// of the `import()` call.  Stable per-record URLs let us mint sources
// for cyclic ES module graphs without the blob-URL chicken-and-egg
// problem (blob URLs are immutable; we can't reserve a URL before
// the source that uses it is generated).
//
// Bounded LRU: Map iteration order is insertion order; we use that to
// evict the oldest entries when the registry grows past the cap.  Each
// `set` re-inserts (delete-then-set) so updates move entries to the end;
// each fetch hit also re-inserts to mark recently-used.  Long-running
// pages that churn many cyclic graphs (test runners, dev hot-reload,
// plugin sandboxes) get bounded memory.  Per-record `edge-esm-clear`
// teardown still works alongside the LRU bound.
const ESM_MAX = 4096;
const esmSources = new Map(); // path → source string
function esmTouch(path) {
  // Re-insert to move entry to most-recently-used position.
  const src = esmSources.get(path);
  if (typeof src === "string") {
    esmSources.delete(path);
    esmSources.set(path, src);
    return src;
  }
  return undefined;
}
function esmSet(path, source) {
  if (esmSources.has(path)) esmSources.delete(path);
  esmSources.set(path, source);
  while (esmSources.size > ESM_MAX) {
    // Map keys() is insertion order; first key is oldest.
    const oldest = esmSources.keys().next().value;
    if (oldest === undefined) break;
    esmSources.delete(oldest);
  }
}

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
    return;
  }
  if (e.data?.kind === "edge-esm-publish") {
    // Sources is an Array<[path, source]>.  Tuple form is portable
    // across postMessage's structured-clone without the Object key
    // ordering / non-string-key issues plain object would have.
    const sources = e.data.sources || [];
    for (let i = 0; i < sources.length; i++) {
      const entry = sources[i];
      if (entry && entry.length === 2) esmSet(entry[0], entry[1]);
    }
    // Reply on the MessagePort if provided (so the publisher can await
    // an ack before kicking off `import()` and guarantees the SW has
    // the source ready to serve).
    if (e.ports && e.ports[0]) {
      try { e.ports[0].postMessage({ kind: "edge-esm-published", token: e.data.token }); }
      catch (err) { void err; }
    } else if (e.source) {
      try { e.source.postMessage({ kind: "edge-esm-published", token: e.data.token }); }
      catch (err) { void err; }
    }
    return;
  }
  if (e.data?.kind === "edge-esm-clear") {
    // Optional teardown — runtime worker can drop stale registrations
    // (e.g. on `ModuleWrap.destroy`) to bound the registry size.
    const paths = e.data.paths || [];
    for (let i = 0; i < paths.length; i++) esmSources.delete(paths[i]);
    return;
  }
});

async function getClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all[0] ?? null;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // ESM source delivery: stable per-record URLs serve previously-
  // published source via `esmSources`.  Used by the cyclic-graph path
  // in `napi-host/esm-registry.ts` where blob URLs can't be pre-
  // allocated.  Missing entry → 404 (loud failure so the napi handler
  // surfaces it instead of silently hanging on a pending request).
  if (url.pathname.startsWith(ESM_PREFIX)) {
    const source = esmTouch(url.pathname);
    if (typeof source === "string") {
      event.respondWith(new Response(source, {
        status: 200,
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }));
    } else {
      event.respondWith(new Response(
        "edge ESM source not published: " + url.pathname, {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }));
    }
    return;
  }

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
