// Sets up Node-style globals that emnapi expects to find at module-load time.
//
// Specifically: `globalThis.Buffer`.  emnapi's runtime captures
// `_Buffer = typeof Buffer === 'function' ? Buffer : require('buffer').Buffer`
// at module evaluation.  In a browser worker context, neither path resolves,
// so `napi_create_buffer_copy` and friends throw `NotSupportBufferError`.
//
// This file MUST be imported BEFORE `@emnapi/*` to ensure the capture sees
// our shim.  In `worker.ts` and `napi-host/index.ts` we list it as the first
// import.
//
// Implementation: vendored `buffer` (npm), the canonical Node Buffer polyfill.
// MIT licensed, ~6KB minified.  Per project rule: vendored deps sit behind a
// single project-owned facade — this file is that facade.  Downstream code
// must NOT `import 'buffer'` directly.

import { Buffer as BufferPolyfill } from "buffer";

const g = globalThis as Record<string, unknown>;

if (typeof g.Buffer !== "function") {
  g.Buffer = BufferPolyfill;
}

// Snapshot the host's native WebCrypto (Node's or browser-worker's) before
// edge.js bootstraps and replaces `globalThis.crypto` with its own lib
// module.  Stored on a property edge doesn't touch so policies can reach
// it later via `globalThis.__edgeHostNativeCrypto`.
//
// Why needed: edge's `addBuiltinLibsToObject` installs `globalThis.crypto`
// pointing at edge's `lib/crypto.js` exports.  Any policy that wants to
// route to the *real* host WebCrypto (e.g. `crypto-host-random` offloading
// `randomBytes` to `crypto.getRandomValues`) needs the original reference.
//
// Snapshotted as `{ getRandomValues, randomUUID, subtle }` — not the
// `Crypto` object itself, because edge's lib uses property assignment
// patterns that don't survive whole-object replacement on some hosts.
const hostCrypto = (globalThis as { crypto?: { getRandomValues?: (a: ArrayBufferView) => ArrayBufferView; randomUUID?: () => string; subtle?: unknown } }).crypto;
if (hostCrypto && !g.__edgeHostNativeCrypto) {
  Object.defineProperty(g, "__edgeHostNativeCrypto", {
    value: {
      getRandomValues: hostCrypto.getRandomValues ? hostCrypto.getRandomValues.bind(hostCrypto) : undefined,
      randomUUID: hostCrypto.randomUUID ? hostCrypto.randomUUID.bind(hostCrypto) : undefined,
      subtle: hostCrypto.subtle ?? undefined,
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

// Tried intercepting globalThis.Buffer via a property descriptor to force
// Buffer.poolSize = 0 (which makes every Buffer.allocUnsafe un-pooled, so
// our wasm-backed napi_create_buffer/_arraybuffer overrides catch each
// allocation independently).  Edge.js's `addBuiltinLibsToObject` installs
// a lazy getter that does `delete object[name]; object[name] = val;` —
// the delete+assign races out our descriptor, so the intercept never sees
// the real Buffer class.
//
// Workaround that DOES work: prepend `Buffer.poolSize = 0;` to user code
// (the harness does this when crypto correctness matters).  Full
// architectural fix needs to set poolSize=0 inside edge's bootstrap, OR
// override Buffer.allocate() to ignore poolSize.  Documented in NOTES.md
// 2026-05-21 "Crypto digest works".
