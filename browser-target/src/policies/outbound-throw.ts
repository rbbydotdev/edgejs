import type { Policy } from "./index";

// Node-honest default for outbound HTTP/HTTPS.  Patches the four entry
// points (`http.request`, `http.get`, `https.request`, `https.get`) to
// throw `ERR_BROWSER_NO_OUTBOUND` with a message pointing users at the
// options that DO work in the browser.
//
// WHY A PRELUDE INSTEAD OF A SOURCE OVERRIDE
//
// We could replace the entire `http` / `https` module source via
// `builtinOverrides`, but that would lose the server-side implementation
// (createServer, Server, IncomingMessage, etc. — all the bits that DO
// work over the SW bridge).  Patching the four client-side functions
// after the modules load via a `-e` prelude keeps the server path
// untouched and is one-line per function.
//
// WHY NOT JUST USE globalThis.fetch INTERNALLY
//
// That would be the "outbound-fetch-tunnel" policy — explicit opt-in,
// not the default.  This policy errs on the side of telling the user
// loudly that their code hit a constraint, so they make an informed
// choice (rewrite to fetch, or apply the tunnel policy).

const PRELUDE = `try {
  const __makeOutboundThrow = (mod, fn) => () => {
    const e = new Error(mod + '.' + fn + '() is disabled by the outbound-throw policy. ' +
      'Outbound HTTP/HTTPS from the browser-target requires either globalThis.fetch ' +
      '(works for most cases) or an explicit fetch-tunnel / relay policy. See ' +
      'browser-target/src/policies/ for what to add.');
    e.code = 'ERR_BROWSER_NO_OUTBOUND';
    throw e;
  };
  const __http = require('http');
  __http.request = __makeOutboundThrow('http', 'request');
  __http.get = __makeOutboundThrow('http', 'get');
  const __https = require('https');
  __https.request = __makeOutboundThrow('https', 'request');
  __https.get = __makeOutboundThrow('https', 'get');
} catch {};`;

export const outboundThrow: Policy = {
  name: "outbound-throw",
  description: "http.request / https.request throw ERR_BROWSER_NO_OUTBOUND with a clear message.",
  userScriptPrelude: PRELUDE,
};
