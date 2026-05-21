import type { Policy } from "./index";

// Re-implements `http.request`, `http.get`, `https.request`, `https.get`
// on top of `globalThis.fetch`, so user code that makes outbound HTTP/HTTPS
// calls works without a real TCP stack (which the browser doesn't expose).
//
// USAGE
//
//   composePolicies([
//     bufferPoolDisable,
//     inboundHttpsViaSW,
//     outboundFetchTunnel,    // ← instead of outboundThrow
//   ]);
//
// LIMITATIONS (where Node semantics quietly diverge)
//
// - Request body must be fully buffered before fetch fires.  No streaming
//   uploads — ReadableStream upload support isn't broadly available across
//   browsers as of 2026-05.  User code that does `req.write(bigChunk)`
//   followed by `req.end()` works; piping a Readable into req with
//   `req.on('drain')` backpressure semantics works but never blocks.
// - `req.abort()` / `req.destroy()` are no-ops.  The in-flight fetch is
//   not actually cancelled.  Could be fixed with AbortController; skipped
//   in v1 because most user code doesn't depend on cancellation.
// - `req.setTimeout()` is a no-op.
// - Response is fully exposed as a Readable (chunks come from
//   `response.body.getReader()`), but `IncomingMessage`-specific events
//   beyond `'data'`/`'end'`/`'error'` are not synthesized (no
//   `'aborted'`, `'close'` may fire late).
// - `'socket'` event never fires (there is no Socket).  Code that probes
//   the underlying socket breaks.
// - CORS still applies in the browser — outbound calls to public APIs
//   typically need server-side CORS headers.  In node-harness this works
//   freely.
//
// The trade-off is intentional: most real-world apps (`fetch`-like usage,
// JSON APIs, simple GETs/POSTs) work unmodified; edge-case socket code
// breaks loudly when it hits an unsupported event.

const PRELUDE = `try {
  // Force lazy bootstrap paths NOW, before any await microtask boundary.
  // See NOTES.md lazy-load-from-microtask debt: edge's compileFunction
  // for internal builtins returns non-function ("fn is not a function")
  // when first invoked from a microtask continuation post-await.  Symptoms:
  //   - console.log() with multiple args fails (lazyUtilColors)
  //   - process.stdout access from callback fails (createWritableStdioStream)
  //
  // The fetch-tunnel necessarily resolves to user callbacks from a
  // microtask continuation (fetch().then → emit('response') → user cb),
  // so we pre-prime everything synchronously here.  Pre-priming console.log
  // is done by swapping stdout/stderr write to no-ops, calling console.log
  // with multi-args (triggers lazyUtilColors + lazyInspect), then restoring.
  try {
    process.stdout.fd; process.stderr.fd;
    const __w1 = process.stdout.write, __w2 = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try { console.log('', ''); console.error('', ''); } catch (eC) { void eC; }
    process.stdout.write = __w1;
    process.stderr.write = __w2;
  } catch (eInit) { void eInit; }

  const { Readable, Writable } = require('stream');
  const __URL = require('url').URL;

  // IncomingMessage is buffered (whole body in memory before "response"
  // fires) and emits via a simple EventEmitter-style protocol rather than
  // by extending Readable.  See NOTES.md microtasks-starved debt: edge's
  // wasm event loop drops pending microtasks when sync code finishes (no
  // way to keep the loop alive without a real syscall), so Readable's
  // flowing-mode pumping never fires after the response callback returns.
  // Doing the data/end emission directly the moment a listener attaches
  // works in all scheduling regimes.
  const __EventEmitter = require('events');
  class __IncomingMessage extends __EventEmitter {
    constructor(response, bodyBuf) {
      super();
      this.statusCode = response.status;
      this.statusMessage = response.statusText || '';
      this.httpVersion = '1.1';
      this.httpVersionMajor = 1;
      this.httpVersionMinor = 1;
      this.headers = {};
      this.rawHeaders = [];
      try {
        for (const [k, v] of response.headers) {
          this.headers[k.toLowerCase()] = v;
          this.rawHeaders.push(k, v);
        }
      } catch {}
      this._body = bodyBuf;
      this._consumed = false;
    }
    // EventEmitter override: fire 'data' the moment a 'data' listener attaches,
    // fire 'end' the moment an 'end' listener attaches.  Most user code
    // attaches both in the response callback synchronously, so this order
    // ensures the data listener receives the body and the end listener
    // receives end without races.
    on(event, listener) {
      const ret = super.on(event, listener);
      if (event === 'data' && !this._dataFired) {
        this._dataFired = true;
        if (this._body && this._body.length) this.emit('data', Buffer.from(this._body));
      }
      if (event === 'end' && !this._endFired) {
        this._endFired = true;
        this.emit('end');
      }
      return ret;
    }
    once(event, listener) { return this.on(event, listener); }
    pause() { return this; }
    resume() { return this; }
    // Minimal Readable-shape stubs so code that probes for .read() or
    // .pipe() does not crash; both no-op for the buffered model.
    read() { return null; }
    pipe(dst) { try { if (this._body) dst.write(Buffer.from(this._body)); dst.end(); } catch {} return dst; }
    setEncoding() { return this; }
  }

  class __ClientRequest extends Writable {
    constructor(opts, callback) {
      super();
      this._chunks = [];
      if (typeof opts === 'string') {
        try { opts = new __URL(opts); } catch {}
      }
      this._opts = opts || {};
      this._method = String((opts && opts.method) || 'GET').toUpperCase();
      this._headers = (opts && opts.headers) ? Object.assign({}, opts.headers) : {};
      if (typeof callback === 'function') this.once('response', callback);
      this._fired = false;
      this.once('finish', () => this._fire());
    }
    _write(chunk, enc, cb) {
      this._chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, enc || 'utf8') : Buffer.from(chunk));
      cb();
    }
    setHeader(name, value) { this._headers[name] = value; }
    getHeader(name) { return this._headers[name]; }
    removeHeader(name) { delete this._headers[name]; }
    abort() {}
    destroy(err) { super.destroy(err); }
    setTimeout(/* ms, cb */) { return this; }
    _buildUrl() {
      const o = this._opts;
      if (o instanceof __URL) return o.toString();
      if (typeof o === 'string') return o;
      if (o.href) return o.href;
      const proto = o.protocol || ((o.port === 443 || String(o.port) === '443') ? 'https:' : 'http:');
      const host = o.hostname || o.host || 'localhost';
      const port = o.port ? (':' + o.port) : '';
      const path = o.path || '/';
      return proto + '//' + host + port + path;
    }
    async _fire() {
      if (this._fired) return; this._fired = true;
      const url = this._buildUrl();
      const init = { method: this._method, headers: this._headers };
      if (this._chunks.length && this._method !== 'GET' && this._method !== 'HEAD') {
        init.body = Buffer.concat(this._chunks);
      }
      try {
        const resp = await fetch(url, init);
        let bodyBuf;
        if (typeof resp.arrayBuffer === 'function') {
          try { bodyBuf = Buffer.from(await resp.arrayBuffer()); }
          catch { bodyBuf = Buffer.alloc(0); }
        } else if (resp._buffer) {
          bodyBuf = Buffer.from(resp._buffer);
        } else {
          bodyBuf = Buffer.alloc(0);
        }
        const im = new __IncomingMessage(resp, bodyBuf);
        this.emit('response', im);
      } catch (e) {
        const err = (e instanceof Error) ? e : new Error(String(e));
        err.code = err.code || 'ERR_FETCH_TUNNEL_FAILED';
        this.emit('error', err);
      }
    }
  }

  const __req = (opts, cb) => new __ClientRequest(opts, cb);
  const __get = (opts, cb) => {
    const r = __req(opts, cb);
    r.end();
    return r;
  };

  for (const modId of ['http', 'https']) {
    const m = require(modId);
    m.request = __req;
    m.get = __get;
    m.IncomingMessage = __IncomingMessage;
    m.ClientRequest = __ClientRequest;
  }

} catch (e) {
  try { process.stderr.write('[outbound-fetch-tunnel] prelude failed: ' + (e && e.message) + '\\n'); } catch {}
};`;

export const outboundFetchTunnel: Policy = {
  name: "outbound-fetch-tunnel",
  description: "Re-implements http.request / https.request on top of globalThis.fetch. Replaces outbound-throw.",
  userScriptPrelude: PRELUDE,
};
