// Worker entry.  Runs two payloads in sequence:
//   1) hello.wasm — minimal WASI program; smoke-tests the worker + WASI shim.
//   2) edgejs.wasm — the real target; uses emnapi for standard napi_* and our
//      hand-rolled unofficial_napi_* layer + the WASI shim.

import { buildImports } from "./imports-generated";
import { createWasiShim, ExitSignal, type BridgeRequest } from "./wasi-shim";
import { PipeRegistry } from "./wasi-shim/pipes-sab";
import { FsSnapshotRegistry } from "./wasi-shim/fs-snapshot-sab";
import { syncYieldStrategy } from "./wasi-shim/yield-sync";
import type { YieldStrategy } from "./wasi-shim/yield-strategy";
import { WASIThreads, type WASIInstance } from "./napi-host/emnapi";
import { Trace, toUnifiedJsonl } from "./trace";
import { createNapiHost } from "./napi-host";
import { composePolicies, defaultBrowserPolicies, compressionViaCompressionStream } from "./policies";
import { createBundledFs } from "./host/fs/adapters/bundled";
// opfs + layered adapters now live on the bridge worker.  Runtime
// worker has only a minimal bundled-fs for any wasi-shim paths that
// don't go through the SAB snapshot (legacy / debug paths).
import { DEFAULT_MEM_OPTIONS, instrumentNamespace, pendingMem } from "./mem-snapshot";
import { runSabViewAliasingDiagnostic, formatReport as formatSabReport } from "./diagnostics/sab-view-aliasing";
import { createByteLengthWatcher, formatEvents as formatBlEvents } from "./diagnostics/byteLength-watcher";

declare const self: DedicatedWorkerGlobalScope;

// Edge's bootstrap mutates globalThis (it expects to own the global env).
// Capture native APIs we need *before* we hand control to the wasm so edge
// can't shadow them mid-run.
const nowMs = performance.now.bind(performance);

function post(kind: string, payload: Record<string, unknown> = {}) {
  self.postMessage({ kind, ...payload });
}

// FS snapshot SAB is sent to us by main.ts BEFORE the "start" message
// (main.ts spawns bridge worker first, waits for its `bridge-ready`,
// then spawns us and immediately hands us the SAB).  Bridge worker
// keeps draining the snapshot's request ring while our wasm runs —
// this is the core of the runtime-on-separate-worker split.
let fsSnapshotSab: SharedArrayBuffer | null = null;
self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as { kind?: string; sab?: SharedArrayBuffer } | null;
  if (data?.kind === "edge-fs-snapshot-sab" && data.sab) {
    fsSnapshotSab = data.sab;
  }
});

async function runHelloSmokeTest() {
  post("section", { text: "── hello.wasm (smoke test) ──" });
  const resp = await fetch("/hello.wasm");
  const wasmBytes = await resp.arrayBuffer();
  post("log", { text: `fetched hello.wasm (${wasmBytes.byteLength} bytes)`, level: "info" });

  const memoryHolder: { memory: WebAssembly.Memory | null } = { memory: null };

  const shim = createWasiShim({
    get memory() {
      if (!memoryHolder.memory) throw new Error("memory not ready");
      return memoryHolder.memory;
    },
    args: ["hello"],
    env: {},
    fs: createBundledFs(),
    postLog: (text: string, level?: string) => {
      if (level === "out") {
        post("log", { text: `[stdout] ${text}`, level: "out" });
      } else {
        post("log", { text, level: level ?? "info" });
      }
    },
    postExit: () => { /* handled via ExitSignal */ },
  } as never);

  const t0 = nowMs();
  const instance = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: shim.wasi_snapshot_preview1 as Record<string, WebAssembly.ImportValue>,
  });
  memoryHolder.memory = (instance.instance.exports as { memory: WebAssembly.Memory }).memory;
  post("log", { text: `instantiated in ${(nowMs() - t0).toFixed(0)} ms`, level: "info" });

  try {
    (instance.instance.exports._start as () => void)();
    post("log", { text: "_start returned without proc_exit", level: "warn" });
  } catch (e) {
    if (e instanceof ExitSignal) {
      post("log", { text: `✓ end-to-end success (exit=${e.code})`, level: e.code === 0 ? "out" : "info" });
    } else {
      post("log", { text: `threw: ${(e as Error).stack ?? e}`, level: "err" });
    }
  }
}

async function runEdgeWithEmnapi() {
  post("section", { text: "── edgejs.wasm (emnapi + WASI host) ──" });
  const trace = new Trace();
  // Page may opt out of per-call tracing via ?trace=0.  Tracing
  // allocates args/return objects on every wasi import (~25k+ per
  // HTTP request), so skipping it is a real perf win for benchmarks
  // and production.
  if (traceDisabled) {
    trace.disabled = true;
    post("log", { text: "[worker] tracing disabled (?trace=0)", level: "info" });
  }

  const resp = await fetch("/edgejs.wasm");
  const wasmBytes = await resp.arrayBuffer();
  post("log", { text: `fetched edgejs.wasm (${(wasmBytes.byteLength / 1_000_000).toFixed(1)} MB)`, level: "info" });

  const memory = new WebAssembly.Memory({ initial: 337, maximum: 65536, shared: true });
  post("log", {
    text: `memory: ${memory.buffer.byteLength / 65536} pages, shared=${memory.buffer instanceof SharedArrayBuffer}`,
    level: "info",
  });

  // emnapi host — provides standard napi_* + env helpers + our unofficial_napi_*.
  // Policies are the deployment-time strategy bundle: see policies/index.ts
  // for the framework and `defaultBrowserPolicies` for the rationale of each
  // member.  Worker-only deployments can fork this list — e.g. append an
  // outbound-fetch-tunnel policy to enable client-side http.request.
  // Feature-detect JSPI first so policy composition can opt into
  // host-async-dependent policies (compression-via-compressionstream).
  const hasJspi = typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending === "function"
    && typeof (WebAssembly as unknown as { promising?: unknown }).promising === "function";

  // Compose the browser policies.  Note: compression-via-compressionstream
  // is registered but NOT enabled by default — it triggers a JSPI
  // architectural issue (any async JS path that re-enters wasm needs
  // its caller wrapped with WebAssembly.promising).  Tracked separately.
  void compressionViaCompressionStream;
  const browserPolicies = defaultBrowserPolicies;
  const { builtinOverrides, userScriptPrelude, applied: appliedPolicies } =
    composePolicies(browserPolicies);
  void hasJspi;
  const napi = createNapiHost({ memory, builtinOverrides });
  post("log", { text: `policies applied: ${appliedPolicies.join(", ")}`, level: "info" });
  post("log", { text: `napi-host: ${Object.keys(napi.imports.napi).length} napi entries seeded`, level: "info" });

  // FileSystem facade.  Runtime worker only keeps a minimal bundled-fs
  // for legacy paths (mostly /dev/* probes during boot).  Real file I/O
  // routes through the SAB-backed snapshot — pool workers (and runtime
  // itself) open via the snapshot's reader path; the bridge worker
  // owns the layered (bundled + opfs) adapter and drives the loader.
  const fs = createBundledFs({
    log: (line) => post("log", { text: line, level: "info" }),
  });

  // Pick yield strategy: JSPI if WebAssembly.Suspending is available
  // (Chrome 137+, Node 24+ with flags), else sync (Atomics.wait).
  let yieldStrategy: YieldStrategy = syncYieldStrategy;
  let entryPointWrapper: (fn: Function) => Function = (fn) => fn;
  if (hasJspi) {
    const { jspiYieldStrategy } = await import("./wasi-shim/yield-jspi");
    yieldStrategy = jspiYieldStrategy;
    entryPointWrapper = (fn) => jspiYieldStrategy.wrapExport(fn);
    post("log", { text: "[worker] JSPI available — using jspiYieldStrategy", level: "info" });
  } else {
    post("log", { text: "[worker] JSPI unavailable — falling back to syncYieldStrategy (Atomics.wait)", level: "info" });
  }

  // Cross-thread pipe registry — SAB shared with every worker we spawn
  // so libuv's uv_async_send (pool → main wake, a pipe write internally)
  // actually reaches main.  See `wasi-shim/pipes-sab.ts`.
  const pipeRegistry = PipeRegistry.create();

  // Cross-thread file snapshot — SAB-backed read-only file table
  // shared with the bridge worker (loader) and pool workers (readers).
  // Runtime worker attaches as a reader only — it does NOT run the
  // drain loop (would deadlock its own wasm on Atomics.wait if a
  // re-entry triggered a cold-miss).  Bridge worker drives the
  // loader; see bridge-worker.ts.
  //
  // The SAB was created by the bridge worker and forwarded to us via
  // main.ts ("edge-fs-snapshot-sab" message).  Must be present before
  // we hit this point — main.ts spawns bridge first and waits for its
  // ready signal.
  if (!fsSnapshotSab) {
    post("log", { text: "[runtime] fs snapshot SAB not received from bridge worker", level: "err" });
    return;
  }
  const fsSnapshot = FsSnapshotRegistry.attach(fsSnapshotSab);

  // Diagnostic: dump main-side pipe activity periodically while we're
  // bringing this up.  Pool workers post their own stats via
  // thread-log.  Quiet when there's no activity — we only care that the
  // pipe primitive is exercised under the /_edge/* test paths.
  let _lastPipeStats = "";
  setInterval(() => {
    const s = pipeRegistry.stats();
    const tag = `w=${s.wCount}/${s.wBytes}B r=${s.rCount}/${s.rBytes}B`;
    if (tag !== _lastPipeStats && (s.wCount > 0 || s.rCount > 0)) {
      _lastPipeStats = tag;
      post("log", { text: `[pipes-main] ${tag}`, level: "info" });
    }
  }, 1500);

  // Wasi shim — provides wasi_snapshot_preview1, wasix_32v1, wasi.thread-spawn
  // and a SocketBus we wire to the HTTP bridge port below.
  const shim = createWasiShim({
    memory,
    yieldStrategy,
    pipeRegistry,
    fsSnapshot,
    // Runtime worker is a *reader* of the snapshot.  Bridge worker
    // owns the loader role; runtime's own opens that miss the cache
    // will Atomics.wait on the slot status — that's safe because the
    // notify comes from bridge worker (a different thread), so we
    // don't deadlock on our own loop.
    fsSnapshotRole: "reader",
    // Small HTTP server: opens a TCP listener on :3000, replies to any
    // request with "hi from edge\n".  The path/port are not used for
    // routing — the SW intercepts /_edge/* and pushes any request onto
    // whatever listener edge has open (single-listener policy, see
    // wasi-shim.ts).
    //
    // `userScriptPrelude` is prepended by the active policy set — at
    // minimum it contains the Buffer.poolSize=0 hack (see
    // policies/buffer-pool-disable.ts) plus any other monkey-patches the
    // active policies install.
    args: ["edgejs", "-e", userScriptPrelude + (userScript ?? `
      const http = require('http');
      const fs = require('fs');
      http.createServer((req, res) => {
        if (req.url === '/fs-cb') {
          fs.readFile('/node/deps/undici/src/package.json', (err, buf) => {
            if (err) { res.statusCode = 500; res.end('fs.readFile-cb err: ' + err.message + '\\n'); return; }
            res.end('fs.readFile-cb ok len=' + buf.length + '\\n');
          });
        } else if (req.url === '/fs') {
          fs.promises.readFile('/node/deps/undici/src/package.json')
            .then(buf => res.end('fs.readFile ok len=' + buf.length + '\\n'))
            .catch(err => { res.statusCode = 500; res.end('fs.readFile err: ' + err.message + '\\n'); });
        } else if (req.url === '/fs-sync') {
          try {
            const buf = fs.readFileSync('/node/deps/undici/src/package.json');
            res.end('fs.readFileSync ok len=' + buf.length + '\\n');
          } catch (err) {
            res.statusCode = 500;
            res.end('fs.readFileSync err: ' + err.message + '\\n');
          }
        } else if (req.url === '/fs-open') {
          fs.open('/node/deps/undici/src/package.json', 'r', (err, fd) => {
            if (err) { res.statusCode = 500; res.end('fs.open err: ' + err.message + '\\n'); return; }
            fs.close(fd, () => res.end('fs.open+close ok fd=' + fd + '\\n'));
          });
        } else if (req.url === '/fs-readonly') {
          // open sync, read async — isolates the cost of one async read
          // call (which should be fastfs short-circuited).
          let fd;
          try { fd = fs.openSync('/node/deps/undici/src/package.json', 'r'); } catch (e) { res.statusCode = 500; res.end('fs.openSync err: ' + e.message + '\\n'); return; }
          const buf = Buffer.alloc(8192);
          fs.read(fd, buf, 0, 8192, 0, (err, bytesRead) => {
            try { fs.closeSync(fd); } catch {}
            if (err) { res.statusCode = 500; res.end('fs.read err: ' + err.message + '\\n'); return; }
            res.end('fs.read async ok bytes=' + bytesRead + '\\n');
          });
        } else if (req.url === '/write') {
          const payload = 'hello-from-write-' + Date.now();
          fs.writeFile('/tmp/edge-write-test.txt', payload, (err) => {
            if (err) { res.statusCode = 500; res.end('writeFile err: ' + err.message + '\\n'); return; }
            fs.readFile('/tmp/edge-write-test.txt', 'utf-8', (e2, data) => {
              if (e2) { res.statusCode = 500; res.end('readBack err: ' + e2.message + '\\n'); return; }
              res.end('write+read ok wrote=' + payload.length + 'B read=' + data.length + 'B match=' + (data === payload) + '\\n');
            });
          });
        } else if (req.url === '/randomFill') {
          require('crypto').randomFill(Buffer.alloc(32), (err, buf) => {
            if (err) { res.statusCode = 500; res.end('randomFill err: ' + err.message + '\\n'); return; }
            res.end('randomFill ok hex=' + buf.toString('hex') + '\\n');
          });
        } else {
          res.end('hi from edge\\n');
        }
      }).listen(3000, () => console.log('listening'));
    `)],
    // Match native napi_wasmer baseline — wasmer-wasix passes no env by
    // default and edge boots fine.  Adding env vars made wasi-libc trigger
    // a different init path that breaks uv_cwd downstream.
    env: {},
    fs,
    postLog: (text, level) => {
      if (level === "out") post("log", { text: `[stdout] ${text}`, level: "out" });
      else if (level === "warn") post("log", { text: `[stderr] ${text}`, level: "warn" });
      else post("log", { text, level: level ?? "info" });
    },
    postExit: () => { /* via ExitSignal */ },
  });

  // Wire the bridge to the socket bus.  Two channels:
  //   1) The page (relaying for the SW) writes incoming HTTP requests
  //      into bridgeSab and calls Atomics.notify on the shim's wakeView.
  //      The shim blocks on wakeView[0] inside accept_v2; our wakePoll
  //      hook reads from bridgeSab and pushes the request through the
  //      bus once it wakes.
  //   2) The shim's responder fires when a connection closes with
  //      response bytes.  We post {kind:"page-edge-res"} to the main
  //      thread; main.ts forwards to the SW via sw.postMessage.
  shim.bus.setResponder((res) => {
    // res.body is a Uint8Array (subarray of recvBuf or fresh allocation).
    // Copy to a plain ArrayBuffer so postMessage doesn't drag in the SAB.
    const bodyCopy = new Uint8Array(res.body.length);
    bodyCopy.set(res.body);
    post("log", { text: `[worker] dispatching response reqId=${res.reqId} status=${res.status} bytes=${bodyCopy.length}`, level: "info" });
    self.postMessage({
      kind: "page-edge-res",
      reqId: res.reqId,
      status: res.status,
      headers: res.headers,
      body: bodyCopy.buffer,
    }, [bodyCopy.buffer]);
  });
  shim.bus.setWakePoll(() => {
    // Drain the SAB inbox.  Multiple requests can be ready in the same
    // wake — push each to the bus.  Bus assigns a new socket fd per
    // request, so concurrent requests get independent connections.
    const reqs = drainBridgeSab();
    for (const req of reqs) shim.bus.pushRequest(req);
  });
  // SAB doesn't survive MessagePort.postMessage to a Service Worker in
  // current Chrome; the message is silently dropped (verified — a plain
  // {kind:"ping"} on the same port arrives, a payload that includes a
  // SAB does not).  We relay through the page (main thread), which can
  // sw.postMessage() the SABs directly.
  self.postMessage({
    kind: "relay-bridge-sab",
    bridgeSab,
    wakeSab: shim.bus.wakeView.buffer,
  });
  post("log", { text: "[worker] relay-bridge-sab posted to page (SW-bound)", level: "info" });

  // If the page enabled memory-snapshot debugging for specific symbols,
  // wrap those namespaces so each call captures bytes around pointer args.
  // The wrapper stashes captures on `pendingMem`; the trace callback below
  // drains it on the matching call so we get one trace record per call.
  let wasiNs = memSnapshotSymbols.size > 0
    ? instrumentNamespace(shim.wasi_snapshot_preview1, "wasi_snapshot_preview1", memory,
        { ...DEFAULT_MEM_OPTIONS, enabledSymbols: memSnapshotSymbols })
    : shim.wasi_snapshot_preview1;
  let wasixNs = memSnapshotSymbols.size > 0
    ? instrumentNamespace(shim.wasix_32v1, "wasix_32v1", memory,
        { ...DEFAULT_MEM_OPTIONS, enabledSymbols: memSnapshotSymbols })
    : shim.wasix_32v1;
  if (memSnapshotSymbols.size > 0) {
    post("log", { text: `mem-snapshot enabled for: ${[...memSnapshotSymbols].join(", ")}`, level: "info" });
  }

  // #14 diagnostic: when watchByteLength is on, wrap the shim namespaces with
  // a byteLength/SAB-identity watcher.  Logs every change.  Helps test
  // Hypothesis B (memory.grow during bootstrap → stale buffer references).
  let blWatcher: ReturnType<typeof createByteLengthWatcher> | null = null;
  if (watchByteLength) {
    blWatcher = createByteLengthWatcher(memory);
    wasiNs = blWatcher.wrap(wasiNs, "wasi_snapshot_preview1");
    wasixNs = blWatcher.wrap(wasixNs, "wasix_32v1");
    post("log", { text: `byteLength watcher: armed on wasi/wasix namespaces`, level: "info" });
    post("log", { text: `byteLength initial: ${memory.buffer.byteLength}`, level: "info" });
  }

  // Edge's rebuilt wasm imports `unofficial_napi_*` under the
  // `napi_extension_wasmer_v0` module (per their `__import_module__`
  // attribute), not under `napi` like the older build did.  Our
  // napi-host still registers ALL napi_* impls in `napi.imports.napi`,
  // so split them across the two namespaces here.  Mirrors
  // scripts/node-harness.mjs.
  const napiAll = napi.imports.napi as Record<string, Function>;
  const napiStandard: Record<string, Function> = {};
  const napiExtension: Record<string, Function> = {};
  for (const k of Object.keys(napiAll)) {
    if (k.startsWith("unofficial_napi_")) napiExtension[k] = napiAll[k];
    else napiStandard[k] = napiAll[k];
  }

  // wasi-threads layer: real `wasi.thread-spawn` backed by a Worker pool.
  // Without this, edge.js's libuv thread spawn / OpenSSL / any C-side
  // pthread call shares TLS state (errno, __thread vars, OpenSSL per-thread
  // error stacks) across what should be separate threads.  See
  // architecture/worker-threads in NOTES.md.
  //
  // The shim returned by wasi-shim.ts has its own `thread-spawn` stub
  // returning -1.  We replace it with the ThreadManager's impl after
  // setup().  Pre-setup() calls (shouldn't happen during boot) keep the
  // stub.
  const wasiStub: WASIInstance = {
    wasiImport: undefined,
    initialize(_i: object) { void _i; },
    start(_i: object): number { void _i; return 0; },
    getImportObject(): { wasi: Record<string, Function> } { return { wasi: shim.wasi }; },
  };
  const wasiThreads = new WASIThreads({
    wasi: wasiStub,
    // CRITICAL for browsers: pre-spawn a pool so pthread_create doesn't
    // block on `Atomics.wait` for a worker that hasn't initialized yet.
    // Without `reuseWorker`, the main wasm thread calls wasi.thread-spawn
    // synchronously and waits for the new worker — but in a browser
    // DedicatedWorker context the worker can't initialize while we're
    // blocked in Atomics.wait.  Deadlock.
    //
    reuseWorker: { size: 4, strict: true },
    // Synchronous semantics: pthread_create returns only after the
    // thread actually started, matching real Node.  1000ms timeout
    // for safety; libuv expects sync creation.
    waitThreadStart: 1000,
    onCreateWorker: (_ctx) => {
      void _ctx;
      // Spawn the child-thread worker.  Vite imports it as a module worker.
      const childWorker = new Worker(new URL("./thread-worker.ts", import.meta.url), {
        type: "module",
        name: "edgejs-thread",
      });
      // Hand the pipe-registry + fs-snapshot SABs to the child
      // immediately so its wasi-shim can attach to the same
      // cross-thread state.  Post BEFORE emnapi's `load` message so
      // the child has the SABs stashed when it builds its shim.
      childWorker.postMessage({ kind: "edge-pipe-sab", sab: pipeRegistry.sharedBuffer });
      childWorker.postMessage({ kind: "edge-fs-snapshot-sab", sab: fsSnapshot.sharedBuffer });
      // Forward non-__emnapi__ messages (logs, debug breadcrumbs) from the
      // child to the page.  ThreadManager will attach its own listener for
      // __emnapi__-wrapped protocol messages; we co-exist on the same
      // worker via addEventListener (multiple message listeners allowed).
      childWorker.addEventListener("message", (e: MessageEvent) => {
        const data = e.data as { __emnapi__?: unknown; kind?: string; text?: string; level?: string } | null;
        if (!data || data.__emnapi__ !== undefined) return;
        if (data.kind === "thread-log") {
          post("log", { text: data.text ?? "", level: data.level ?? "info" });
        }
      });
      return childWorker;
    },
  });

  // Compose: emnapi's napi/env/emnapi + our wasi/wasix + wasi-threads.
  // The wasi-threads getImportObject() returns {wasi: {'thread-spawn': fn}}
  // which we merge OVER shim.wasi so the stub is replaced.
  const overrides = {
    napi: napiStandard,
    napi_extension_wasmer_v0: napiExtension,
    env: napi.imports.env as Record<string, Function>,
    wasi_snapshot_preview1: wasiNs,
    wasix_32v1: wasixNs,
    wasi: { ...shim.wasi, ...wasiThreads.getImportObject().wasi } as Record<string, Function>,
  };
  // Progress watchdog — abort wasm only if it's actually stuck.
  //
  // Old behavior was a flat CALL_LIMIT (100k wasi calls → abort) which
  // misfired the moment real workloads ran a few concurrent requests
  // (each easily emits 25k+ wasi calls).  New behavior: track
  // consecutive same-symbol calls.  A tight wasm loop spinning on
  // (say) clock_time_get manifests as 1000s of identical calls in a
  // row — that's what we catch.  Healthy traffic alternates between
  // many symbols (fd_read, poll_oneoff, clock_time_get, fd_write,
  // path_open, etc.) so the streak resets constantly.
  //
  // 200k threshold gives ~ms-scale slack on a 200ns/import budget;
  // misfires only on genuine spins.
  // Configurable spin threshold.  Page passes `?spinLimit=N` via the
  // start message; 0 disables entirely.  Default 2M (~tens of seconds
  // of real spin) is conservative — high enough that healthy traffic
  // doesn't trip even under load (typical bench saw 145+ dispatched
  // before the underlying clock_time_get spin pinned the counter),
  // low enough that genuinely stuck wasm aborts in a useful window.
  const SPIN_STREAK_LIMIT = spinStreakLimit;
  let lastSymKey = "";
  let consecutive = 0;
  const wasmImports = buildImports(memory, overrides, (ns, sym, args, ret, stub) => {
    // If the mem-snapshot wrapper just ran on this call, it left snapshots
    // on the side channel.  Pick them up and attach to this canonical record.
    const mem = pendingMem.value;
    if (mem) pendingMem.value = null;
    trace.record(ns, sym, args, ret, stub, mem ?? undefined);
    const key = ns + "." + sym;
    if (key === lastSymKey) {
      if (SPIN_STREAK_LIMIT > 0 && ++consecutive >= SPIN_STREAK_LIMIT) {
        throw new Error(`spin detected: ${SPIN_STREAK_LIMIT} consecutive ${key} calls — wasm is making no progress`);
      }
    } else {
      consecutive = 0;
      lastSymKey = key;
    }
    // Reset the clock_time_get-specific streak when any other wasi
    // import fires — the spin probe in clock_time_get tracks runs of
    // pure clock_time_get calls (no other wasi activity).
    if (key !== "wasi_snapshot_preview1.clock_time_get") {
      const cp = (globalThis as { __edgeClockProbe?: { streak: number; logged: boolean } }).__edgeClockProbe;
      if (cp) cp.streak = 0;
    }
  });

  // emnapi puts its own env.memory; make sure it's the one we want.
  (wasmImports.env as Record<string, unknown>).memory = memory;

  const t0 = nowMs();
  const module = await WebAssembly.compile(wasmBytes);
  post("log", { text: `compiled in ${(nowMs() - t0).toFixed(0)} ms`, level: "info" });

  let instance: WebAssembly.Instance;
  try {
    instance = await WebAssembly.instantiate(module, wasmImports);
  } catch (e) {
    post("log", { text: `INSTANTIATE FAILED: ${(e as Error).message}`, level: "err" });
    return;
  }
  post("log", { text: "instantiated; binding emnapi to instance…", level: "info" });

  try {
    napi.bindInstance(instance, module);
    post("log", { text: "emnapi bound; running _start…", level: "info" });
  } catch (e) {
    post("log", { text: `emnapi.bindInstance threw: ${(e as Error).message}`, level: "err" });
    // Continue anyway — see what _start does with whatever state we have.
  }

  // wasi-threads setup.  ThreadManager reads `instance.exports.malloc`
  // and `.free` directly when allocating thread arg slots.  Edge.js's
  // wasm exports them as `unofficial_napi_guest_malloc` /
  // `unofficial_napi_guest_free` (per WASIX naming).  Hand wasi-threads
  // a Proxy that aliases those to the names it expects.
  const threadInstanceProxy = new Proxy(instance, {
    get(target, key) {
      if (key === "exports") {
        const orig = target.exports as Record<string, unknown>;
        return new Proxy(orig, {
          get(t, k) {
            if (k === "malloc") return t["unofficial_napi_guest_malloc"] ?? t["malloc"];
            if (k === "free") return t["unofficial_napi_guest_free"] ?? t["free"] ?? (() => { /* leak */ });
            return Reflect.get(t, k);
          },
          has(t, k) {
            if (k === "malloc" || k === "free") return true;
            return Reflect.has(t, k);
          },
        });
      }
      return Reflect.get(target, key);
    },
  });
  try {
    wasiThreads.setup(threadInstanceProxy, module, memory);
    await wasiThreads.preloadWorkers();
    post("log", { text: "wasi-threads: ready to spawn (TLS-isolated child workers, pool preloaded)", level: "info" });
  } catch (e) {
    post("log", { text: `wasi-threads.setup threw: ${(e as Error).message}`, level: "warn" });
  }

  const start = (instance.exports as { _start?: () => void })._start;
  if (!start) { post("log", { text: "no _start export", level: "err" }); return; }

  // Under JSPI, entryPointWrapper turns _start into a Promise-returning
  // function so Suspending-wrapped imports (timer-only poll_oneoff) can
  // suspend the wasm without blocking the worker's event loop —
  // host microtasks (fetch, CompressionStream, etc.) drain during the
  // suspend window.  Under sync strategy, identity (sync call as before).
  const startFn = entryPointWrapper(start);
  let exitCode: number | null = null;
  let threwMsg: string | null = null;
  const tStart = nowMs();
  // Track depth of the promising-wrapped activation so Suspending
  // imports can detect when they're being called from a JS-driven
  // re-entry (depth=0) vs from inside _start (depth>0).  Re-entries
  // can't suspend (no promising frame on the current call stack), so
  // the Suspending impls do a sync Atomics.wait instead of returning
  // a Promise in that case.  See pollOneoffAsyncImpl / futexWaitAsyncImpl.
  type DepthHolder = { __edgePromisingDepth?: number };
  const dh = globalThis as DepthHolder;
  dh.__edgePromisingDepth = (dh.__edgePromisingDepth ?? 0) + 1;
  try { await startFn(); }
  catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else threwMsg = (e as Error).stack ?? String(e);
  }
  finally { dh.__edgePromisingDepth = (dh.__edgePromisingDepth ?? 1) - 1; }
  const runMs = nowMs() - tStart;

  post("log", {
    text: `_start ran ${runMs.toFixed(0)} ms ` +
      (exitCode !== null ? `(exit=${exitCode})` : threwMsg ? `(THREW)` : "(returned)"),
    level: exitCode === 0 ? "info" : exitCode !== null ? "err" : threwMsg ? "err" : "info",
  });
  if (blWatcher) {
    const events = blWatcher.drain();
    post("log", { text: `byteLength events: ${events.length}`, level: "info" });
    for (const line of formatBlEvents(events).slice(0, 50)) {
      post("log", { text: line, level: "info" });
    }
    post("log", {
      text: `byteLength final: ${memory.buffer.byteLength} (initial 22085632)`,
      level: "info",
    });
  }

  const summary: string[] = [];
  summary.push(`total calls: ${trace.all().length}`);
  summary.push("by namespace:");
  for (const [ns, s] of trace.byNamespace()) {
    summary.push(`  ${ns.padEnd(28)} total=${String(s.total).padStart(5)}  distinct=${s.distinct}`);
  }
  summary.push("ALL distinct calls (by count):");
  for (const s of trace.topByCount(100)) {
    const flag = s.stub ? "STUB" : "impl";
    summary.push(`  [${flag}]  ${String(s.count).padStart(5)}  ${s.ns}.${s.sym}`);
  }
  // Errno-proxy: every non-zero return from wasi/wasix sets libc's errno.
  // Listing them in order shows what errno value the wasm last saw before
  // any failure.  Filter out napi (return semantics differ — 0 is OK there too).
  summary.push("");
  summary.push("non-zero wasi/wasix returns (errno proxy):");
  const errnoEvents = trace.all().filter((r) =>
    (r.ns === "wasi_snapshot_preview1" || r.ns === "wasix_32v1" || r.ns === "wasi") &&
    typeof r.ret === "number" && r.ret !== 0,
  );
  if (errnoEvents.length === 0) {
    summary.push("  (none — every wasi syscall succeeded)");
  } else {
    for (const r of errnoEvents.slice(-20)) {
      summary.push(`  ${r.t.toFixed(1).padStart(7)}ms  ${r.ns}.${r.sym}(${r.args.map((a) => JSON.stringify(a)).join(", ")}) -> errno=${r.ret}`);
    }
  }
  summary.push("last 30 calls (closest to exit):");
  for (const r of trace.tail(30)) {
    const flag = r.stub ? "STUB" : "impl";
    const ret = typeof r.ret === "string" ? r.ret : JSON.stringify(r.ret);
    summary.push(`  ${r.t.toFixed(1).padStart(7)}ms  [${flag}]  ${r.ns}.${r.sym}(${r.args.map((a) => JSON.stringify(a)).join(", ")}) -> ${ret}`);
  }
  if (threwMsg) {
    summary.push("");
    summary.push("--- threw ---");
    summary.push(threwMsg.split("\n").slice(0, 8).join("\n"));
  }
  post("log", { text: "\n" + summary.join("\n"), level: "info" });

  const json = JSON.stringify({ exitCode, threw: threwMsg, runMs, summary: trace.summarize(), tail: trace.tail(200), all: trace.all() }, null, 2);
  const jsonl = toUnifiedJsonl(trace);
  post("report", { json, jsonl });
}

function runDiagnostics() {
  post("section", { text: "── #14 diagnostic: SAB view aliasing (Hypothesis A) ──" });
  try {
    const reports = runSabViewAliasingDiagnostic();
    for (const line of formatSabReport(reports)) {
      post("log", { text: line, level: "info" });
    }
  } catch (e) {
    post("log", { text: `diagnostic threw: ${(e as Error).stack ?? e}`, level: "err" });
  }
}

async function boot() {
  try {
    if (runDiagnosticsFirst) {
      runDiagnostics();
      post("status", { text: "diagnostic complete" });
      return;
    }
    await runHelloSmokeTest();
    await runEdgeWithEmnapi();
    post("status", { text: "done" });
  } catch (err) {
    post("log", { text: `FATAL: ${(err as Error).stack ?? err}`, level: "err" });
    post("status", { text: "crashed" });
  }
}

// Worker boot accepts a config payload so the page can pass URL-param-style
// options (e.g. memory snapshot symbols to instrument).
let memSnapshotSymbols: Set<string> = new Set();
let runDiagnosticsFirst = false;
let watchByteLength = false;
let userScript: string | null = null;
// Spin watchdog threshold — page can override via ?spinLimit=N (0
// disables).  Default 2M means "if 2 million consecutive identical
// wasi imports fire, abort."  Real workloads on healthy traffic
// shouldn't get anywhere near this; only genuine tight loops will.
let spinStreakLimit = 2_000_000;
// `?trace=0` from page disables per-call trace recording — saves the
// args/return object allocation on every wasi import.  Real perf win
// for steady-state traffic.
let traceDisabled = false;

// HTTP bridge: requests come in via a SharedArrayBuffer the SW writes
// directly into.  This is the only way to get data through to the worker
// while the wasm has it stuck inside Atomics.wait — a MessagePort message
// would queue but never get drained until the worker yields back to its
// event loop, which doesn't happen during a sync wasm call.
//
// Bridge SAB — ring of NUM_BRIDGE_SLOTS independent request slots, so
// the SW can have multiple HTTP requests in flight at once.  Was single-
// slot; concurrent requests piled up serially.
//
// SAB layout (Int32 indices):
//   [0..3]                  reserved (kept so older snapshots can attach;
//                           wake counter lives in the separate `wakeSab`
//                           the shim hands out via setWakePoll).
//   [16..16+NS*SS)          slot 0..N-1, each SLOT_SIZE bytes:
//     slot[0]   status      0=empty, 1=writing (page-claimed, not yet
//                           ready), 2=ready (worker may consume)
//     slot[4]   reqId       per-request id from the SW
//     slot[8]   payloadLen  byte length of JSON at slot+16
//     slot[12]  reserved
//     slot[16..] JSON {method,path,headers,bodyB64?}
//
// Concurrency.  Page-side dispatchEdgeReq scans for status==0 and
// cmpxchg-claims to status=1, writes, then stores status=2.  Worker
// drainBridgeSab loops, taking any status==2 slots and freeing them.
// 3-state status avoids reading partial writes.
//
// Responses still go back via self.postMessage (page-edge-res) keyed
// by reqId.  The SW already maps reqId → pending promise.
const NUM_BRIDGE_SLOTS = 16;
const BRIDGE_SLOT_SIZE = 32 * 1024;
const BRIDGE_SLOTS_OFFSET = 16; // bytes
const BRIDGE_SLOT_HEADER_BYTES = 16; // bytes within a slot before payload
const BRIDGE_SAB_SIZE = BRIDGE_SLOTS_OFFSET + NUM_BRIDGE_SLOTS * BRIDGE_SLOT_SIZE;
const bridgeSab = new SharedArrayBuffer(BRIDGE_SAB_SIZE);
const bridgeI32 = new Int32Array(bridgeSab);
const bridgeU8 = new Uint8Array(bridgeSab);
const bridgeDecoder = new TextDecoder("utf-8", { fatal: false });

const BRIDGE_SLOT_STATUS_EMPTY = 0;
const BRIDGE_SLOT_STATUS_WRITING = 1;
const BRIDGE_SLOT_STATUS_READY = 2;

function slotI32Idx(slot: number, byteOff: number): number {
  return ((BRIDGE_SLOTS_OFFSET + slot * BRIDGE_SLOT_SIZE + byteOff) >>> 2);
}
function slotByteOff(slot: number, byteOff: number): number {
  return BRIDGE_SLOTS_OFFSET + slot * BRIDGE_SLOT_SIZE + byteOff;
}

function drainBridgeSab(): BridgeRequest[] {
  // Called by the shim's wait-and-poll path when Atomics.wait returns.
  // Scans all slots, returning any that are READY.  Marks each EMPTY
  // before returning so a slow page-side write that races with our
  // scan can't lose data — the slot can only re-enter the WRITING
  // state via an explicit cmpxchg from EMPTY.
  const out: BridgeRequest[] = [];
  for (let slot = 0; slot < NUM_BRIDGE_SLOTS; slot++) {
    const statusIdx = slotI32Idx(slot, 0);
    if (Atomics.load(bridgeI32, statusIdx) !== BRIDGE_SLOT_STATUS_READY) continue;
    const reqId = Atomics.load(bridgeI32, slotI32Idx(slot, 4));
    const len = Atomics.load(bridgeI32, slotI32Idx(slot, 8));
    if (len <= 0 || len > BRIDGE_SLOT_SIZE - BRIDGE_SLOT_HEADER_BYTES) {
      Atomics.store(bridgeI32, statusIdx, BRIDGE_SLOT_STATUS_EMPTY);
      continue;
    }
    const payloadStart = slotByteOff(slot, BRIDGE_SLOT_HEADER_BYTES);
    const jsonBytes = new Uint8Array(len);
    jsonBytes.set(bridgeU8.subarray(payloadStart, payloadStart + len));
    Atomics.store(bridgeI32, statusIdx, BRIDGE_SLOT_STATUS_EMPTY);
    let parsed: { method: string; path: string; headers: Record<string, string>; bodyB64?: string };
    try {
      parsed = JSON.parse(bridgeDecoder.decode(jsonBytes));
    } catch {
      continue;
    }
    let body: ArrayBuffer | null = null;
    if (parsed.bodyB64) {
      const bin = atob(parsed.bodyB64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      body = buf.buffer;
    }
    out.push({
      reqId,
      method: parsed.method,
      path: parsed.path,
      headers: parsed.headers,
      body,
    });
  }
  return out;
}

function onBridgeMessage(_e: MessageEvent) {
  // Legacy MessagePort path — kept as a no-op for compatibility with the
  // earlier scaffold.  The SW now writes requests directly into bridgeSab;
  // this handler only fires for protocol messages we don't use yet.
  // (Responses go SW-bound via bridgePort.postMessage, so the SW does
  // listen to the port — but the WORKER does not need to receive port
  // messages for the request path.)
}

self.onmessage = (e) => {
  if (e.data?.kind === "bridge-port" && e.data.port instanceof MessagePort) {
    const port = e.data.port as MessagePort;
    port.onmessage = onBridgeMessage;
    port.start();
    return;
  }
  if (e.data?.kind === "start") {
    if (Array.isArray(e.data.memSnapshotSymbols)) {
      memSnapshotSymbols = new Set(e.data.memSnapshotSymbols);
    }
    if (e.data.diagnoseSabAliasing === true) {
      runDiagnosticsFirst = true;
    }
    if (e.data.watchByteLength === true) {
      watchByteLength = true;
    }
    if (typeof e.data.userScript === "string" && e.data.userScript.length > 0) {
      userScript = e.data.userScript;
    }
    if (typeof e.data.spinLimit === "number" && e.data.spinLimit >= 0) {
      spinStreakLimit = e.data.spinLimit;
    }
    if (e.data.traceDisabled === true) {
      traceDisabled = true;
    }
    boot();
  }
};
