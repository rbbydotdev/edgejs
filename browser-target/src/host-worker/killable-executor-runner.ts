// Dedicated per-spawn Worker that runs ONE executor invocation. The
// whole point is that the host can call `worker.terminate()` to halt
// the executor mid-run when the wasm side calls kill().
//
// Protocol (runner is symmetric, host postMessages in, runner posts back):
//
//   host -> runner
//     { kind:'run', executorSrc, command, args, env?, cwd?,
//       killSignal?, ipc, ipcAdvanced, initialStdin?, initialStdinEnded }
//     { kind:'stdin-chunk', bytes }
//     { kind:'stdin-end' }
//     { kind:'stdio-chunk', fd, bytes }    // fd >= 3 inbound (wasm -> executor)
//     { kind:'stdio-end', fd }
//     { kind:'ipc-msg', msg }              // msg goes through worker.postMessage's
//                                            structured-clone -- same wire as advanced
//                                            mode on the cooperative path
//     { kind:'ipc-disconnect' }
//
//   runner -> host
//     { kind:'stdout', bytes }            // streamed (opts.onStdout)
//     { kind:'stderr', bytes }
//     { kind:'stdio-out', fd, bytes }     // fd >= 3 outbound (executor.write -> wasm)
//     { kind:'ipc-msg', msg }             // executor opts.ipc.send(msg); host
//                                            re-routes to wasm via the structured
//                                            port when ipcAdvanced, else JSON-stringifies
//                                            and routes via EK.IPC_MESSAGE
//     { kind:'ipc-disconnect' }
//     { kind:'done', code, signal, error?, finalStdout?, finalStderr? }
//
// Why no separate MessageChannel: Worker.postMessage already runs the
// HTML structured-clone algorithm, so Map/Set/Date/ArrayBuffer/cycles
// round-trip through the runner's main channel without any extra port.
// Using a single channel also means no cross-channel ordering races
// between stdout chunks, ipc messages, and the final 'done' event.
//
// finalStdout/finalStderr carry the executor's RETURNED stdout/stderr
// (for executors that don't use the onStdout/onStderr callbacks); host
// emits them as one last chunk before EXIT so the wire-side semantics
// match the cooperative path.

interface RunRequest {
  kind: "run";
  executorSrc: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  killSignal?: string;
  ipc: boolean;
  ipcAdvanced?: boolean;
  initialStdin?: Uint8Array;
  initialStdinEnded: boolean;
}

interface ChildProcExecResult {
  stdout?: Uint8Array | string | number[];
  stderr?: Uint8Array | string | number[];
  code?: number | null;
  signal?: string | null;
  error?: { code: string; message: string } | null;
}

interface FdPipe {
  buffered: Uint8Array[];
  ended: boolean;
  waiters: Array<(v: { value?: Uint8Array; done: boolean }) => void>;
}

// fd 0 = stdin (always present). fd >= 3 = lazy per-fd read-side pipe
// (created on first inbound chunk OR first executor read).
const fdPipes = new Map<number, FdPipe>();
function ensureFdPipe(fd: number): FdPipe {
  let p = fdPipes.get(fd);
  if (!p) {
    p = { buffered: [], ended: false, waiters: [] };
    fdPipes.set(fd, p);
  }
  return p;
}
const stdinPipe = ensureFdPipe(0); // alias for the fd 0 entry

const ipcState = {
  connected: false,
  messageHandlers: [] as Array<(msg: unknown) => void>,
  disconnectHandlers: [] as Array<() => void>,
};

function pushFd(fd: number, bytes: Uint8Array): void {
  const pipe = ensureFdPipe(fd);
  if (pipe.ended) return;
  const w = pipe.waiters.shift();
  if (w) w({ value: bytes, done: false });
  else pipe.buffered.push(bytes);
}
function endFd(fd: number): void {
  const pipe = ensureFdPipe(fd);
  if (pipe.ended) return;
  pipe.ended = true;
  while (pipe.waiters.length > 0) pipe.waiters.shift()!({ done: true });
}
function pushStdin(bytes: Uint8Array): void { pushFd(0, bytes); }
function endStdin(): void { endFd(0); }

function makeFdAsyncIterable(fd: number): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const pipe = ensureFdPipe(fd);
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (pipe.buffered.length > 0) {
            const chunk = pipe.buffered.shift()!;
            return Promise.resolve({ value: chunk, done: false });
          }
          if (pipe.ended) {
            return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
          }
          return new Promise((resolve) => {
            pipe.waiters.push((v) => {
              if (v.done) resolve({ value: undefined as unknown as Uint8Array, done: true });
              else resolve({ value: v.value!, done: false });
            });
          });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          endFd(fd);
          return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        },
      };
    },
  };
}
function makeStdinAsyncIterable(): AsyncIterable<Uint8Array> { return makeFdAsyncIterable(0); }

function toBytes(v: Uint8Array | string | number[] | undefined): Uint8Array {
  if (v == null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (Array.isArray(v)) return new Uint8Array(v);
  return new TextEncoder().encode(String(v));
}

let started = false;

self.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as
    | RunRequest
    | { kind: "stdin-chunk"; bytes: Uint8Array }
    | { kind: "stdin-end" }
    | { kind: "stdio-chunk"; fd: number; bytes: Uint8Array }
    | { kind: "stdio-end"; fd: number }
    | { kind: "ipc-msg"; msg: unknown }
    | { kind: "ipc-disconnect" }
    | null;
  if (!msg) return;
  if (msg.kind === "stdin-chunk") { pushStdin(msg.bytes); return; }
  if (msg.kind === "stdin-end")   { endStdin(); return; }
  if (msg.kind === "stdio-chunk") { pushFd(msg.fd, msg.bytes); return; }
  if (msg.kind === "stdio-end")   { endFd(msg.fd); return; }
  if (msg.kind === "ipc-msg") {
    if (!ipcState.connected) return;
    // Unwrap {__edgeSendHandle, msg, handle} envelope so executors can
    // see (msg, handle) per the sendHandle support added in P4.5.
    let userMsg: unknown = msg.msg;
    let handle: unknown = undefined;
    if (userMsg && typeof userMsg === "object" && (userMsg as { __edgeSendHandle?: boolean }).__edgeSendHandle === true) {
      handle = (userMsg as { handle: unknown }).handle;
      userMsg = (userMsg as { msg: unknown }).msg;
    }
    for (const cb of ipcState.messageHandlers) {
      try { (cb as (m: unknown, h?: unknown) => void)(userMsg, handle); } catch (_e) { void _e; }
    }
    return;
  }
  if (msg.kind === "ipc-disconnect") {
    if (!ipcState.connected) return;
    ipcState.connected = false;
    for (const cb of ipcState.disconnectHandlers.splice(0)) {
      try { cb(); } catch (_e) { void _e; }
    }
    return;
  }
  if (msg.kind !== "run") return;
  if (started) return; // ignore double-start
  started = true;
  void handleRun(msg);
});

async function handleRun(req: RunRequest): Promise<void> {
  // Pre-queue one-shot stdin if provided (parity with cooperative path
  // and Node's spawn(..., {input:'...'}) shortcut).
  if (req.initialStdin && req.initialStdin.byteLength > 0) pushStdin(req.initialStdin);
  if (req.initialStdinEnded) endStdin();

  try { new Function(req.executorSrc)(); }
  catch (e) {
    const err = e as Error;
    self.postMessage({
      kind: "done",
      code: 1,
      signal: null,
      error: { code: "EEVAL", message: err.message },
      finalStderr: new TextEncoder().encode("executor src eval failed: " + err.message),
    });
    return;
  }

  type ExecutorFn = (
    command: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => ChildProcExecResult | Promise<ChildProcExecResult>;
  const executor = (self as unknown as { __edgeChildProcessExecutor?: ExecutorFn })
    .__edgeChildProcessExecutor;
  if (typeof executor !== "function") {
    self.postMessage({
      kind: "done",
      code: 1,
      signal: null,
      error: { code: "ENOEXECUTOR", message: "no __edgeChildProcessExecutor" },
      finalStderr: new TextEncoder().encode("no executor after src eval"),
    });
    return;
  }

  let usedStdoutStream = false;
  let usedStderrStream = false;

  const onStdoutCb = (chunk: Uint8Array | string | number[]): void => {
    const b = toBytes(chunk);
    if (b.byteLength > 0) { usedStdoutStream = true; self.postMessage({ kind: "stdout", bytes: b }); }
  };
  const onStderrCb = (chunk: Uint8Array | string | number[]): void => {
    const b = toBytes(chunk);
    if (b.byteLength > 0) { usedStderrStream = true; self.postMessage({ kind: "stderr", bytes: b }); }
  };
  // opts.stdio[N] accessor: mirrors the cooperative path's surface so
  // executors written against opts.stdio[3..N] work uniformly.
  // fd 0 = stdin AsyncIterable (alias for opts.stdin);
  // fd 1 = stdout writer (calls onStdout); fd 2 = stderr writer;
  // fd N >= 3 = duplex (AsyncIterable + write/end). Writes post
  // {kind:'stdio-out', fd, bytes} so the host can emit EK.STDIO_FDN
  // toward wasm. Reads come from inbound stdio-chunk messages.
  const stdoutWriter = {
    write(chunk: Uint8Array | string | number[]): boolean { onStdoutCb(chunk); return true; },
    end(chunk?: Uint8Array | string | number[]): void { if (chunk != null) onStdoutCb(chunk); },
  };
  const stderrWriter = {
    write(chunk: Uint8Array | string | number[]): boolean { onStderrCb(chunk); return true; },
    end(chunk?: Uint8Array | string | number[]): void { if (chunk != null) onStderrCb(chunk); },
  };
  const extraHandles = new Map<number, unknown>();
  function buildExtraHandle(fd: number): unknown {
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return makeFdAsyncIterable(fd)[Symbol.asyncIterator]();
      },
      write(chunk: Uint8Array | string | number[]): boolean {
        const bytes = toBytes(chunk);
        if (bytes.byteLength === 0) return true;
        self.postMessage({ kind: "stdio-out", fd, bytes });
        return true;
      },
      end(chunk?: Uint8Array | string | number[]): void {
        if (chunk != null) {
          const bytes = toBytes(chunk);
          if (bytes.byteLength > 0) self.postMessage({ kind: "stdio-out", fd, bytes });
        }
        // Zero-byte signal indicates end-of-stream for the wasm-side
        // reader (matches the cooperative path's STDIO_FDN convention).
        self.postMessage({ kind: "stdio-out", fd, bytes: new Uint8Array(0) });
      },
    };
  }
  const stdioProxy = new Proxy({}, {
    get(_t, prop): unknown {
      if (typeof prop !== "string") return undefined;
      if (prop === "0") return makeStdinAsyncIterable();
      if (prop === "1") return stdoutWriter;
      if (prop === "2") return stderrWriter;
      const idx = Number(prop);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      let h = extraHandles.get(idx);
      if (!h) { h = buildExtraHandle(idx); extraHandles.set(idx, h); }
      return h;
    },
  });

  const opts: Record<string, unknown> = {
    signal: new AbortController().signal, // never aborts on hard-kill path; terminate() halts JS instead
    onStdout: onStdoutCb,
    onStderr: onStderrCb,
    stdin: makeStdinAsyncIterable(),
    stdio: stdioProxy,
  };
  if (req.env) opts.env = req.env;
  if (req.cwd != null) opts.cwd = req.cwd;
  if (req.killSignal) opts.killSignal = req.killSignal;
  if (req.ipc) {
    ipcState.connected = true;
    // Single uniform path: post msg via worker's main channel. Browser
    // structured-clone preserves Map/Set/Date/etc., so advanced mode
    // gets fidelity for free. Host re-routes to wasm via the structured
    // port (advanced) or JSON-encoded EK.IPC_MESSAGE (json) -- the
    // mode-specific encoding decision lives on the host side.
    opts.ipc = {
      send(msg: unknown): boolean {
        if (!ipcState.connected) return false;
        self.postMessage({ kind: "ipc-msg", msg });
        return true;
      },
      on(event: "message" | "disconnect", cb: (...args: unknown[]) => void): void {
        if (event === "message") ipcState.messageHandlers.push(cb as (m: unknown) => void);
        else if (event === "disconnect") ipcState.disconnectHandlers.push(cb as () => void);
      },
      disconnect(): void {
        if (!ipcState.connected) return;
        ipcState.connected = false;
        self.postMessage({ kind: "ipc-disconnect" });
        for (const cb of ipcState.disconnectHandlers.splice(0)) {
          try { cb(); } catch (_e) { void _e; }
        }
      },
      get connected(): boolean { return ipcState.connected; },
    };
  }

  let result: ChildProcExecResult;
  try {
    result = await Promise.resolve(executor(req.command, req.args, opts));
  } catch (e) {
    const err = e as Error;
    self.postMessage({
      kind: "done",
      code: 1,
      signal: null,
      error: { code: "EEXEC", message: err.message },
    });
    return;
  }

  // Tail bytes from executors that return {stdout, stderr} instead of
  // (or in addition to) streaming via onStdout/onStderr. We send them
  // as finalStdout/finalStderr so host can emit them BEFORE the EXIT
  // event, preserving Node's "all data events fire before exit" ordering.
  const finalStdout = !usedStdoutStream && result.stdout != null ? toBytes(result.stdout) : undefined;
  const finalStderr = !usedStderrStream && result.stderr != null ? toBytes(result.stderr) : undefined;

  self.postMessage({
    kind: "done",
    code: typeof result.code === "number" ? result.code : 0,
    signal: result.signal != null ? String(result.signal) : null,
    error: result.error || undefined,
    finalStdout,
    finalStderr,
  });
}
