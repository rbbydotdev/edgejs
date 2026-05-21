// Built-in module override: replaces `https` with a thin shim that
// delegates server work to `http`.
//
// WHY THIS EXISTS
//
// In the browser-target deployment, the Service Worker is the TLS
// endpoint to the user-agent — by the time bytes reach our SW from
// the page (via fetch()), the browser has already terminated TLS and
// we get pre-parsed HTTP.  The wasm never sees encrypted bytes from
// the network, so edge's in-wasm TLS layer has nothing to handshake
// against.  This matches the pattern StackBlitz/WebContainers use:
// HTTPS is "fake" inside the sandboxed runtime; the surrounding
// browser provides the real cert/encryption.
//
// SCOPE
//
// - Server-side (`https.createServer`, `https.Server`): full delegation
//   to `http`.  Cert/key/CA options are accepted and discarded — user
//   code keeps working unmodified.
// - Client-side (`https.request`, `https.get`): throw on call with a
//   clear message.  Outbound HTTPS from the wasm is a separate problem
//   (the runtime has no raw TCP; outbound TLS would need to tunnel
//   through `fetch()`, which is its own override).  Throwing lazily
//   is better than silently doing the wrong thing.
//
// This override is injected by `worker.ts` via the napi host's
// `builtinOverrides` hook (see browser-target/src/napi-host/index.ts).
// The node-harness leaves it OFF by default — harness users invoke it
// explicitly with `--override https:<path-to-source>` if they need it.

export const HTTPS_AS_HTTP_SOURCE = `'use strict';
const http = require('http');

function stripTlsOptions(args) {
  if (args.length === 0) return args;
  if (typeof args[0] === 'function') return args;
  const opts = args[0];
  if (opts && typeof opts === 'object') {
    const { key, cert, ca, passphrase, ciphers, secureProtocol,
            secureOptions, sessionIdContext, dhparam, ecdhCurve,
            requestCert, rejectUnauthorized, ALPNProtocols, NPNProtocols,
            SNICallback, sigalgs, minVersion, maxVersion, ...rest } = opts;
    void key; void cert; void ca; void passphrase; void ciphers;
    void secureProtocol; void secureOptions; void sessionIdContext;
    void dhparam; void ecdhCurve; void requestCert; void rejectUnauthorized;
    void ALPNProtocols; void NPNProtocols; void SNICallback;
    void sigalgs; void minVersion; void maxVersion;
    args = [rest, ...args.slice(1)];
  }
  return args;
}

exports.createServer = function createServer(...args) {
  return http.createServer.apply(http, stripTlsOptions(args));
};

exports.Server = http.Server;
exports.Agent = http.Agent;
exports.globalAgent = http.globalAgent;

function noOutboundTls() {
  const e = new Error(
    'https.request: outbound TLS is not available in the browser ' +
    'target. The wasm has no raw TCP and the Service Worker only ' +
    'intercepts inbound requests. Use the global fetch() API for ' +
    'outbound HTTPS instead.',
  );
  e.code = 'ERR_BROWSER_NO_OUTBOUND_TLS';
  throw e;
}
exports.request = noOutboundTls;
exports.get = noOutboundTls;
`;
