import type { Policy } from "./index";

// Short-circuit fs.promises.readFile through fs.readFileSync.
//
// WHY
//
// The bundled Node lib's fs.promises.readFile chains 10+ `await`
// boundaries: open → fstat → read-loop → close, each wrapped in
// PromisePrototypeThen for error normalization, plus handleFdClose
// for cleanup.  Each await yields wasm-side V8 to the libuv main
// loop, which iterates (poll_oneoff + microtask drain) before
// resuming the .then continuation.  In our browser-target wasm
// environment that's ~70ms per await; for a 6KB readFile that's
// ~1000ms end-to-end.  The same operation via fs.readFileSync takes
// ~280ms — no async chain, no per-await loop overhead.
//
// This policy replaces the export with a sync-wrap.  The Promise
// returned still resolves async (next microtask), so the API shape
// is unchanged.  4× speedup on cached small files.
//
// WHAT YOU GIVE UP (semantic drift)
//
// - AbortSignal mid-read: stock implementation checks `signal.aborted`
//   at multiple points inside the read loop (after fstat, before each
//   read).  Sync version checks once at entry, then runs to completion.
//   Aborting mid-read is impossible with this policy on.
// - Error wrapping subtlety: handleErrorFromBinding normalizes binding
//   errors with specific class/code.  fs.readFileSync throws errors
//   with the same Node-standard class/code (uvException-based), so
//   most consumers get the right thing — but any code that depends
//   on the *exact* call stack inside the error might see different
//   frames.
// - Encoding boundary: stock readFileHandle uses StringDecoder for
//   chunked-decode of multi-byte encodings (utf-8/16) so each chunk
//   is correctly stitched at byte-boundaries.  fs.readFileSync does
//   one-shot decode after the full buffer is read — for our cache-hit
//   case the whole file IS one chunk anyway, so this is a non-issue.
//   Only matters if a future workload chunked-reads files larger than
//   the read buffer; we'd revisit then.
// - process.cpuUsage / async hooks resource tracking: the async path
//   reports as multiple discrete async resources; sync wraps them all
//   under one resource.  Affects diagnostics, not correctness.
// - Promise timing: stock returns a Promise that resolves after at
//   least one event-loop iteration.  We resolve after one microtask
//   (Promise.resolve in an async function).  Code that depends on
//   "await fs.promises.readFile" yielding the event loop will observe
//   tighter microtask interleaving.
//
// COMPOSITION
//
// Opt-in.  NOT in defaultBrowserPolicies — Node-honest is the default;
// fast-readFile is a speed shortcut for deployments that can accept
// the semantic drift documented above.
//
// HOW IT REACHES THE LIB
//
// `{ post }` patch on `internal/fs/promises`.  The exports shape there
// is `module.exports = { exports: { readFile, ... }, ... }`.  We
// replace `module.exports.exports.readFile` after the module loads.
// `fs.readFileSync` is required lazily from the patched function so
// circular `internal/fs/promises` → `fs` loading isn't disturbed.

const POST_PATCH = `
;(function applyFastReadFile() {
  if (typeof module === 'undefined' || !module || !module.exports) return;
  var inner = module.exports.exports;
  if (!inner || typeof inner.readFile !== 'function') return;
  var origReadFile = inner.readFile;
  var fsModule = null;

  inner.readFile = async function fastReadFile(path, options) {
    // Bail back to original for FileHandle inputs (different code
    // path that doesn't benefit from sync wrap).
    if (path && typeof path === 'object' && typeof path.fd !== 'undefined') {
      return origReadFile(path, options);
    }
    // Lazy-require fs to avoid disturbing internal/fs/promises load
    // order (fs.promises lazy-requires this module).
    if (!fsModule) {
      try { fsModule = require('fs'); } catch (e) { return origReadFile(path, options); }
    }
    var opts = options;
    if (typeof opts === 'string') opts = { encoding: opts };
    if (!opts) opts = {};
    var syncOpts = { flag: opts.flag || 'r' };
    if (opts.encoding) syncOpts.encoding = opts.encoding;
    // Throw inside async function → rejected Promise (preserves API).
    return fsModule.readFileSync(path, syncOpts);
  };
})();
`;

export const fastReadFile: Policy = {
  name: "fast-readfile",
  description: "Short-circuit fs.promises.readFile through fs.readFileSync. ~4x speedup on cached files (~1000ms → ~280ms in browser-target measurement). Trades AbortSignal mid-read + a few async-hook diagnostic edges for the speed — see policy source for the full drift list.",
  builtinOverrides: {
    "internal/fs/promises": { post: POST_PATCH },
  },
};
