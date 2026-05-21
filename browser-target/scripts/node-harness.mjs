#!/usr/bin/env node
// Node-side harness for fast iteration on the napi/wasi host layer.
//
// What this gives you: run edge.js with arbitrary `-e` scripts in ~3s on the
// command line, see stdout/stderr immediately.  Same wasi-shim + napi-host
// code paths the browser uses — only the FS adapter differs (fs.readFileSync
// instead of sync XHR).
//
// Usage:
//   node browser-target/scripts/node-harness.mjs -e "log('hi')"
//   node browser-target/scripts/node-harness.mjs -e "const c=require('crypto'); log(c.createHash('sha256').update('hello').digest('hex'))"
//
// Requires:  Node 19+ (for globalThis.crypto.getRandomValues + randomUUID).
// Built via tsx so the .ts files load directly — no separate compile step.

import { readFileSync, statSync, existsSync, writeSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer as NodeBuffer } from "node:buffer";
import { performance as nodePerformance } from "node:perf_hooks";

// Capture Node globals BEFORE edge.js runs.  Edge mutates many globalThis
// objects during bootstrap (performance, console, process, internalBinding)
// — those are supposed to live inside the wasm, but in Node they leak into
// the host and break Node's lazy-loaded internals next time we touch them.
//
// Use direct fd writes (writeSync to fd 1/2) for output so we don't hit
// the lazy-loaded console module after edge runs.
const nowMs = nodePerformance.now.bind(nodePerformance);
// --quiet suppresses `[harness] ...` diagnostic lines so test-runner can
// compare clean user output.  User script's own stdout/stderr (routed via
// wasi-shim → postLog with level "out"/"warn"/"err") still flows through.
const QUIET = process.argv.includes("--quiet");
const log = (msg) => { if (!QUIET) writeSync(1, msg + "\n"); };
const errlog = (msg) => { if (!QUIET) writeSync(2, msg + "\n"); };

// Match the browser globals-shim — emnapi captures globalThis.Buffer at
// module load.  Node has Buffer globally already, but assign for parity.
if (typeof globalThis.Buffer !== "function") {
  globalThis.Buffer = NodeBuffer;
}

const here = dirname(fileURLToPath(import.meta.url));
const browserTarget = resolve(here, "..");
const projectRoot = resolve(browserTarget, "..");

// CLI: forward `-e <script>` to edge's worker args.  Default: simple hello.
const args = process.argv.slice(2);
const eIdx = args.indexOf("-e");
const userScript = (eIdx >= 0 && eIdx + 1 < args.length)
  ? args[eIdx + 1]
  : "console.log('hello from edgejs in node-harness')";

// Lazy-import the shim modules through tsx so .ts files work directly.
// (`node --import tsx` registers the loader.)
const { createWasiShim, ExitSignal } = await import(`file://${browserTarget}/src/wasi-shim.ts`);
const { createNapiHost } = await import(`file://${browserTarget}/src/napi-host/index.ts`);
const { Trace } = await import(`file://${browserTarget}/src/trace.ts`);
const policiesMod = await import(`file://${browserTarget}/src/policies/index.ts`);

// Policy selection: --policies a,b,c picks the explicit list, replacing the
// harness default.  Harness defaults to `[buffer-pool-disable]` only — that's
// the minimum needed for crypto correctness.  The browser worker uses a
// richer default (`defaultBrowserPolicies`) that also bakes in
// inbound-https-via-sw + outbound-throw; the harness keeps those OFF so the
// raw TLS plumbing remains testable in isolation.
const policiesIdx = args.indexOf("--policies");
const policyNames = (policiesIdx >= 0 && policiesIdx + 1 < args.length)
  ? args[policiesIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
  : ["buffer-pool-disable"];
const policiesByName = {
  "buffer-pool-disable": policiesMod.bufferPoolDisable,
  "inbound-https-via-sw": policiesMod.inboundHttpsViaSW,
  "outbound-throw": policiesMod.outboundThrow,
};
const selectedPolicies = policyNames.map((n) => {
  const p = policiesByName[n];
  if (!p) { errlog(`[harness] unknown policy: ${n}`); process.exit(2); }
  return p;
});
const { builtinOverrides: policyOverrides, userScriptPrelude, applied: appliedPolicyNames } =
  policiesMod.composePolicies(selectedPolicies);
if (appliedPolicyNames.length > 0) log(`[harness] policies: ${appliedPolicyNames.join(", ")}`);

const edgeArgs = ["edgejs", "-e", userScriptPrelude + userScript];

// Node-side FileSystem adapter.  Same interface as the bundled adapter, but
// reads from the local filesystem — paths that start with /node-lib/** map
// to <project>/lib/**, /node/deps/** to <project>/deps/**.  Read-only.
//
// Per project facade rule, this is the only file in the codebase that
// reaches into the project's lib/ and deps/ trees.
function createNodeFs() {
  const handles = new Map();
  let nextHandle = 1;
  const PREFIX_NODE_LIB = "/node-lib/";
  const PREFIX_NODE_DEPS = "/node/deps/";
  function resolvePath(p) {
    if (p.startsWith(PREFIX_NODE_LIB)) return resolve(projectRoot, "lib", p.slice(PREFIX_NODE_LIB.length));
    if (p.startsWith(PREFIX_NODE_DEPS)) return resolve(projectRoot, "deps", p.slice(PREFIX_NODE_DEPS.length));
    return null;
  }
  function fnv1a(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
  }
  return {
    open(path, opts = {}) {
      if (opts.write) return { ok: false, errno: 69 }; // ROFS
      const real = resolvePath(path);
      if (!real || !existsSync(real)) return { ok: false, errno: 44 }; // NOENT
      const body = readFileSync(real);
      const handle = nextHandle++;
      handles.set(handle, { path, body: new Uint8Array(body), cursor: 0 });
      return { ok: true, value: handle };
    },
    close(handle) {
      if (!handles.has(handle)) return { ok: false, errno: 8 };
      handles.delete(handle);
      return { ok: true, value: undefined };
    },
    read(handle, dst) {
      const f = handles.get(handle);
      if (!f) return { ok: false, errno: 8 };
      const remaining = f.body.length - f.cursor;
      if (remaining <= 0) return { ok: true, value: 0 };
      const n = Math.min(remaining, dst.length);
      dst.set(f.body.subarray(f.cursor, f.cursor + n));
      f.cursor += n;
      return { ok: true, value: n };
    },
    pread(handle, dst, offset) {
      const f = handles.get(handle);
      if (!f) return { ok: false, errno: 8 };
      if (offset < 0) return { ok: false, errno: 28 };
      if (offset >= f.body.length) return { ok: true, value: 0 };
      const n = Math.min(f.body.length - offset, dst.length);
      dst.set(f.body.subarray(offset, offset + n));
      return { ok: true, value: n };
    },
    write() { return { ok: false, errno: 69 }; },
    fstat(handle) {
      const f = handles.get(handle);
      if (!f) return { ok: false, errno: 8 };
      return { ok: true, value: { fileType: 4, size: f.body.length, ino: fnv1a(f.path), atimNs: 0n, mtimNs: 0n, ctimNs: 0n } };
    },
    stat(path) {
      const real = resolvePath(path);
      if (!real || !existsSync(real)) return { ok: false, errno: 44 };
      try {
        const s = statSync(real);
        return { ok: true, value: { fileType: 4, size: s.size, ino: fnv1a(path), atimNs: 0n, mtimNs: 0n, ctimNs: 0n } };
      } catch { return { ok: false, errno: 29 }; }
    },
    readdir() { return { ok: false, errno: 54 }; },
  };
}

const wasmPath = resolve(browserTarget, "edgejs.wasm");
if (!existsSync(wasmPath)) {
  errlog(`ERROR: ${wasmPath} not found.  See browser-target/.gitignore — it's a build artifact.`);
  process.exit(2);
}

log(`[harness] loading ${wasmPath}`);
const wasmBytes = readFileSync(wasmPath);
log(`[harness] ${(wasmBytes.byteLength / 1_000_000).toFixed(1)} MB`);

// Mirror browser worker.ts: shared memory + napi host + wasi shim composition.
const memory = new WebAssembly.Memory({ initial: 337, maximum: 65536, shared: true });
// Parse --override flags BEFORE creating the napi host so we can pass them
// as builtinOverrides — that hook catches compiled-in builtins via
// `BuiltinsCompileFunctionCallback` in edge's C++.  The FS-layer override
// only catches modules edge loads via WASI; this catches everything.
// Seed with the active policies' overrides first; --override flags layer on
// top (last-wins) so a user can override what a policy installed.
const overrideEntries = { ...policyOverrides };
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--override") continue;
  const spec = args[i + 1];
  if (!spec) continue;
  const colon = spec.indexOf(":");
  if (colon < 0) continue;
  const key = spec.slice(0, colon);
  const value = spec.slice(colon + 1);
  if (value === "null") overrideEntries[key] = null;
  else if (existsSync(value)) overrideEntries[key] = readFileSync(value, "utf8");
  else overrideEntries[key] = value;
}
const haveOverrides = Object.keys(overrideEntries).length > 0;
const napi = createNapiHost({
  memory,
  builtinOverrides: overrideEntries,
  postLog: (line, level) => {
    if (level === "out") writeSync(1, line + "\n");
    else if (level === "debug") { if (!QUIET) writeSync(2, line + "\n"); }
    else writeSync(2, line + "\n");
  },
});
if (haveOverrides) log(`[harness] builtin overrides: ${Object.keys(overrideEntries).join(", ")}`);

// --override flags are already parsed above into overrideEntries and passed
// to createNapiHost (which intercepts edge's BuiltinsCompileFunctionCallback
// → unofficial_napi_contextify_compile_function path).  The FS-layer
// overrides combinator is left for /node/deps/** swaps (rarely needed).
const fs = createNodeFs();
const shim = createWasiShim({
  memory,
  args: edgeArgs,
  env: {},
  fs,
  postLog: (line, level) => {
    if (level === "out") writeSync(1, line + "\n");
    else if (level === "warn" || level === "err") writeSync(2, line + "\n");
    // else: drop debug lines to keep harness output clean
  },
  postExit: () => {},
});

const trace = new Trace();
const overrides = {
  napi: napi.imports.napi,
  env: napi.imports.env,
  wasi_snapshot_preview1: shim.wasi_snapshot_preview1,
  wasix_32v1: shim.wasix_32v1,
  wasi: shim.wasi,
};

// Build the imports object exactly like buildImports() does (we replicate
// here so we don't have to load all of browser worker.ts's bridge code).
const { buildImports } = await import(`file://${browserTarget}/src/imports-generated.ts`);
let callCount = 0;
const wasmImports = buildImports(memory, overrides, (ns, sym, args, ret, stub) => {
  trace.record(ns, sym, args, ret, stub);
  if (++callCount === 100_000) throw new Error("CALL_LIMIT reached — spin loop likely");
});
wasmImports.env.memory = memory;

log(`[harness] compiling…`);
const mod = await WebAssembly.compile(wasmBytes);
log(`[harness] instantiating…`);
const instance = await WebAssembly.instantiate(mod, wasmImports);
log(`[harness] binding emnapi…`);
napi.bindInstance(instance, mod);
log(`[harness] running _start — args=${JSON.stringify(edgeArgs)}`);

const t0 = nowMs();
let exitCode = 0;
try {
  instance.exports._start();
} catch (e) {
  if (e instanceof ExitSignal) {
    log(`[harness] _start exit=${e.code}`);
    exitCode = typeof e.code === "number" ? e.code : 0;
  } else {
    errlog(`[harness] _start threw: ${e.stack ?? e}`);
    exitCode = 3;
  }
}
log(`[harness] ${(nowMs() - t0).toFixed(0)}ms, ${callCount} host calls`);
// Force exit before Node's finalization phase — emnapi finalizers trip the
// `dynCall before table ready` placeholders we left in unofficial.ts (the
// `dyncall-before-table-ready` debt in NOTES).  Those throws happen during
// RefTracker.finalizeAll on process tear-down, after the user script has
// already completed successfully.  Skipping finalizers is safe here because
// we're about to exit the process anyway.
process.exit(exitCode);
