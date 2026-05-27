// Dedicated per-spawn Worker that runs ONE executor invocation. The
// whole point is that the host can call `worker.terminate()` to halt
// the executor mid-run when the wasm side calls kill().
interface RunRequest {
  kind: "run";
  executorSrc: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  killSignal?: string;
}

interface RunReply {
  kind: "run-reply";
  stdout: Uint8Array;
  stderr: Uint8Array;
  code: number | null;
  signal: string | null;
  error?: { code: string; message: string };
}

interface ChildProcExecResult {
  stdout?: Uint8Array | string | number[];
  stderr?: Uint8Array | string | number[];
  code?: number | null;
  signal?: string | null;
  error?: { code: string; message: string } | null;
}

self.addEventListener("message", async (e: MessageEvent) => {
  const req = e.data as RunRequest;
  if (!req || req.kind !== "run") return;

  try { new Function(req.executorSrc)(); }
  catch (e2) {
    const err = e2 as Error;
    const reply: RunReply = {
      kind: "run-reply",
      stdout: new Uint8Array(0),
      stderr: new TextEncoder().encode("executor src eval failed: " + err.message),
      code: 1,
      signal: null,
      error: { code: "EEVAL", message: err.message },
    };
    self.postMessage(reply);
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
    const reply: RunReply = {
      kind: "run-reply",
      stdout: new Uint8Array(0),
      stderr: new TextEncoder().encode("no executor after src eval"),
      code: 1,
      signal: null,
      error: { code: "ENOEXECUTOR", message: "no __edgeChildProcessExecutor" },
    };
    self.postMessage(reply);
    return;
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const toBytes = (v: Uint8Array | string | number[] | undefined): Uint8Array => {
    if (v == null) return new Uint8Array(0);
    if (v instanceof Uint8Array) return v;
    if (typeof v === "string") return new TextEncoder().encode(v);
    if (Array.isArray(v)) return new Uint8Array(v);
    return new TextEncoder().encode(String(v));
  };
  const opts: Record<string, unknown> = {
    signal: new AbortController().signal,
    onStdout: (chunk: Uint8Array | string | number[]) => {
      const b = toBytes(chunk);
      if (b.byteLength > 0) stdoutChunks.push(b);
    },
    onStderr: (chunk: Uint8Array | string | number[]) => {
      const b = toBytes(chunk);
      if (b.byteLength > 0) stderrChunks.push(b);
    },
  };
  if (req.env) opts.env = req.env;
  if (req.cwd != null) opts.cwd = req.cwd;
  if (req.killSignal) opts.killSignal = req.killSignal;

  let result: ChildProcExecResult;
  try {
    result = await Promise.resolve(executor(req.command, req.args, opts));
  } catch (e2) {
    const err = e2 as Error;
    const reply: RunReply = {
      kind: "run-reply",
      stdout: concat(stdoutChunks),
      stderr: concat(stderrChunks),
      code: 1,
      signal: null,
      error: { code: "EEXEC", message: err.message },
    };
    self.postMessage(reply);
    return;
  }

  if (result.stdout != null) stdoutChunks.push(toBytes(result.stdout));
  if (result.stderr != null) stderrChunks.push(toBytes(result.stderr));

  const reply: RunReply = {
    kind: "run-reply",
    stdout: concat(stdoutChunks),
    stderr: concat(stderrChunks),
    code: typeof result.code === "number" ? result.code : 0,
    signal: result.signal != null ? String(result.signal) : null,
    error: result.error || undefined,
  };
  self.postMessage(reply);
});

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
