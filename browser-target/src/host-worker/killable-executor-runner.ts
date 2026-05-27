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
import { buildExecutorContext, type ChildProcExecResult } from "./executor-context";

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

function toBytes(v: Uint8Array | string | number[] | undefined): Uint8Array {
  if (v == null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (Array.isArray(v)) return new Uint8Array(v);
  return new TextEncoder().encode(String(v));
}

// One executor per runner instance, so we can stash the context at
// module level and route incoming messages through its source.
let ctx: ReturnType<typeof buildExecutorContext> | null = null;
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
  if (msg.kind === "stdin-chunk") { ctx?.source.pushStdin(msg.bytes); return; }
  if (msg.kind === "stdin-end")   { ctx?.source.endStdin(); return; }
  if (msg.kind === "stdio-chunk") { ctx?.source.pushStdio(msg.fd, msg.bytes); return; }
  if (msg.kind === "stdio-end")   { ctx?.source.endStdio(msg.fd); return; }
  if (msg.kind === "ipc-msg")     { ctx?.source.pushIpcMessage(msg.msg); return; }
  if (msg.kind === "ipc-disconnect") { ctx?.source.pushIpcDisconnect(); return; }
  if (msg.kind !== "run") return;
  if (started) return; // ignore double-start
  started = true;
  void handleRun(msg);
});

async function handleRun(req: RunRequest): Promise<void> {
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

  // Build the executor context. The sink routes outbound bytes/messages
  // via self.postMessage; host's runner-message handler translates those
  // into reverse-RPC OP_SPAWN_ASYNC_EVENT events toward wasm.
  ctx = buildExecutorContext({
    sink: {
      stdout(bytes) { self.postMessage({ kind: "stdout", bytes }); },
      stderr(bytes) { self.postMessage({ kind: "stderr", bytes }); },
      stdioOut(fd, bytes, end) {
        if (bytes.byteLength > 0) self.postMessage({ kind: "stdio-out", fd, bytes });
        if (end) self.postMessage({ kind: "stdio-out", fd, bytes: new Uint8Array(0) });
      },
      ipcSend(msg) { self.postMessage({ kind: "ipc-msg", msg }); },
      ipcDisconnect() { self.postMessage({ kind: "ipc-disconnect" }); },
    },
    ipcEnabled: req.ipc,
    signal: new AbortController().signal, // never aborts on hard-kill path; terminate() halts JS instead
    env: req.env,
    cwd: req.cwd,
    killSignal: req.killSignal,
    initialStdin: req.initialStdin,
    initialStdinEnded: req.initialStdinEnded,
  });

  let result: ChildProcExecResult;
  try {
    result = await Promise.resolve(executor(req.command, req.args, ctx.opts));
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
  const finalStdout = !ctx.usedStdoutStream() && result.stdout != null ? toBytes(result.stdout) : undefined;
  const finalStderr = !ctx.usedStderrStream() && result.stderr != null ? toBytes(result.stderr) : undefined;

  self.postMessage({
    kind: "done",
    code: typeof result.code === "number" ? result.code : 0,
    signal: result.signal != null ? String(result.signal) : null,
    error: result.error || undefined,
    finalStdout,
    finalStderr,
  });
}
