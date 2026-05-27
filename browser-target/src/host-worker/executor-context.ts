// Shared builder for the executor-facing `opts` object that
// child-process-via-executor presents to user-installed executors.
//
// Two consumers share this:
//   * host-worker.ts startAsyncSpawn  (cooperative path)
//   * killable-executor-runner.ts handleRun  (hard-kill path)
//
// They differ ONLY in where outbound bytes/messages go (a sink) and
// where inbound bytes/messages come from (a source); the executor-
// facing surface (opts.stdin / opts.stdio / opts.ipc / opts.onStdout /
// opts.onStderr) is identical. Encapsulating that surface here
// prevents drift between the two paths whenever opts grows a new field.

export interface ChildProcExecResult {
  stdout?: Uint8Array | string | number[];
  stderr?: Uint8Array | string | number[];
  code?: number | null;
  signal?: string | null;
  error?: { code: string; message: string } | null;
}

/** Outbound: where the executor's output goes. The cooperative path
 *  routes to reverse-RPC OP_SPAWN_ASYNC_EVENT events; the killable
 *  path routes to runner-worker postMessage. */
export interface ExecutorEventSink {
  stdout(chunk: Uint8Array): void;
  stderr(chunk: Uint8Array): void;
  /** fd >= 3 (extra stdio pipes). The receiving side decodes the frame
   *  and pushes bytes back into the wasm-side fdN pipe. `end=true`
   *  signals EOF for that fd (separately from `chunk` if any). */
  stdioOut(fd: number, chunk: Uint8Array, end?: boolean): void;
  ipcSend(msg: unknown): void;
  ipcDisconnect(): void;
}

/** Inbound: how the producer feeds bytes into the executor. Returned
 *  by buildExecutorContext so the producer (RPC handler / message
 *  listener) can route specific kinds at the right fd / channel. */
export interface ExecutorEventSource {
  pushStdin(bytes: Uint8Array): void;
  endStdin(): void;
  pushStdio(fd: number, bytes: Uint8Array): void;
  endStdio(fd: number): void;
  pushIpcMessage(msg: unknown): void;
  pushIpcDisconnect(): void;
}

export interface BuildExecutorContextSpec {
  sink: ExecutorEventSink;
  ipcEnabled: boolean;
  signal: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
  input?: Uint8Array;
  timeout?: number;
  killSignal?: string;
  /** Pre-queue these bytes on fd 0 and close (Node's spawn({input})
   *  shortcut). Independent of `input` which the executor receives
   *  as a separate field on opts for legacy non-streaming readers. */
  initialStdin?: Uint8Array;
  initialStdinEnded?: boolean;
}

export interface ExecutorContext {
  opts: Record<string, unknown>;
  source: ExecutorEventSource;
  /** True after the executor calls opts.onStdout / opts.onStderr at
   *  least once. Callers use this to decide whether to ALSO emit
   *  result.stdout / result.stderr at exit (avoid double-emission). */
  usedStdoutStream(): boolean;
  usedStderrStream(): boolean;
}

interface FdPipe {
  buffered: Uint8Array[];
  ended: boolean;
  waiters: Array<(v: { value?: Uint8Array; done: boolean }) => void>;
}

function toBytes(v: Uint8Array | string | number[] | undefined): Uint8Array {
  if (v == null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (Array.isArray(v)) return new Uint8Array(v);
  return new TextEncoder().encode(String(v));
}

export function buildExecutorContext(spec: BuildExecutorContextSpec): ExecutorContext {
  const fdPipes = new Map<number, FdPipe>();
  function ensureFdPipe(fd: number): FdPipe {
    let p = fdPipes.get(fd);
    if (!p) { p = { buffered: [], ended: false, waiters: [] }; fdPipes.set(fd, p); }
    return p;
  }
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

  // Pre-queue initialStdin (Node's spawn({input}) shortcut) before
  // first executor read so iterators drain it cleanly.
  if (spec.initialStdin && spec.initialStdin.byteLength > 0) pushFd(0, spec.initialStdin);
  if (spec.initialStdinEnded) endFd(0);

  // ── opts.onStdout / onStderr (streaming output) ──────────────────
  let usedStdoutStream = false;
  let usedStderrStream = false;
  const onStdoutCb = (chunk: Uint8Array | string | number[]): void => {
    const b = toBytes(chunk);
    if (b.byteLength > 0) { usedStdoutStream = true; spec.sink.stdout(b); }
  };
  const onStderrCb = (chunk: Uint8Array | string | number[]): void => {
    const b = toBytes(chunk);
    if (b.byteLength > 0) { usedStderrStream = true; spec.sink.stderr(b); }
  };

  // ── opts.stdio[N] proxy ──────────────────────────────────────────
  // fd 0 = stdin AsyncIterable (alias for opts.stdin)
  // fd 1 = stdout writer (calls onStdoutCb)
  // fd 2 = stderr writer (calls onStderrCb)
  // fd N >= 3 = duplex (AsyncIterable + write/end) routed through sink.stdioOut
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
        spec.sink.stdioOut(fd, bytes);
        return true;
      },
      end(chunk?: Uint8Array | string | number[]): void {
        if (chunk != null) {
          const bytes = toBytes(chunk);
          if (bytes.byteLength > 0) spec.sink.stdioOut(fd, bytes);
        }
        spec.sink.stdioOut(fd, new Uint8Array(0), true);
      },
    };
  }
  const stdioProxy = new Proxy({}, {
    get(_t, prop): unknown {
      if (typeof prop !== "string") return undefined;
      if (prop === "0") return makeFdAsyncIterable(0);
      if (prop === "1") return stdoutWriter;
      if (prop === "2") return stderrWriter;
      const idx = Number(prop);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      let h = extraHandles.get(idx);
      if (!h) { h = buildExtraHandle(idx); extraHandles.set(idx, h); }
      return h;
    },
  });

  // ── opts.ipc ────────────────────────────────────────────────────
  const ipcState = {
    connected: spec.ipcEnabled,
    messageHandlers: [] as Array<(msg: unknown, handle?: unknown) => void>,
    disconnectHandlers: [] as Array<() => void>,
  };
  const ipcHandle = spec.ipcEnabled ? {
    send(msg: unknown): boolean {
      if (!ipcState.connected) return false;
      spec.sink.ipcSend(msg);
      return true;
    },
    on(event: "message" | "disconnect", cb: (...args: unknown[]) => void): void {
      if (event === "message") ipcState.messageHandlers.push(cb as (m: unknown, h?: unknown) => void);
      else if (event === "disconnect") ipcState.disconnectHandlers.push(cb as () => void);
    },
    disconnect(): void {
      if (!ipcState.connected) return;
      ipcState.connected = false;
      spec.sink.ipcDisconnect();
      for (const cb of ipcState.disconnectHandlers.splice(0)) {
        try { cb(); } catch (_e) { void _e; }
      }
    },
    get connected(): boolean { return ipcState.connected; },
  } : undefined;

  // ── Assemble opts ───────────────────────────────────────────────
  const opts: Record<string, unknown> = {
    signal: spec.signal,
    onStdout: onStdoutCb,
    onStderr: onStderrCb,
    stdin: makeFdAsyncIterable(0),
    stdio: stdioProxy,
  };
  if (spec.env) opts.env = spec.env;
  if (spec.cwd != null) opts.cwd = spec.cwd;
  if (spec.input) opts.input = spec.input;
  if (typeof spec.timeout === "number") opts.timeout = spec.timeout;
  if (spec.killSignal) opts.killSignal = spec.killSignal;
  if (ipcHandle) opts.ipc = ipcHandle;

  // ── Source: inbound feeds the producer wires up. ────────────────
  const source: ExecutorEventSource = {
    pushStdin(bytes) { pushFd(0, bytes); },
    endStdin() { endFd(0); },
    pushStdio(fd, bytes) { pushFd(fd, bytes); },
    endStdio(fd) { endFd(fd); },
    pushIpcMessage(msg) {
      if (!ipcState.connected) return;
      // Unwrap {__edgeSendHandle, msg, handle} envelope so executors
      // opting into the two-arg signature see (msg, handle), like Node.
      // Single-arg listeners still work -- extra arg ignored.
      let userMsg: unknown = msg;
      let handle: unknown = undefined;
      if (msg && typeof msg === "object" && (msg as { __edgeSendHandle?: boolean }).__edgeSendHandle === true) {
        userMsg = (msg as { msg: unknown }).msg;
        handle = (msg as { handle: unknown }).handle;
      }
      for (const cb of ipcState.messageHandlers) {
        try { cb(userMsg, handle); } catch (_e) { void _e; }
      }
    },
    pushIpcDisconnect() {
      if (!ipcState.connected) return;
      ipcState.connected = false;
      for (const cb of ipcState.disconnectHandlers.splice(0)) {
        try { cb(); } catch (_e) { void _e; }
      }
    },
  };

  return {
    opts,
    source,
    usedStdoutStream: () => usedStdoutStream,
    usedStderrStream: () => usedStderrStream,
  };
}
