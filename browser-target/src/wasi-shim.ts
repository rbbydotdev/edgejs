// Minimal WASI / WASIX surface, just enough to reach `fd_write`.
// Anything not implemented here falls through to the generated logging
// stubs (return 0).  When edge.wasm crashes or hangs, the surrounding call
// log shows which symbol was the next blocker, and we promote that one
// from "stub" to "implemented" in this file.
//
// References:
//   https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md
//   https://wasix.org/docs/api-reference
//
// FILE I/O ROUTES THROUGH THE FileSystem FACADE (./host/fs/types.ts).
// This file MUST NOT know about HTTP, OPFS, or bundled content.  Adapters
// behind the facade own that.
//
// SOCKETS — see the "virtual socket table" block below.  The shim hosts
// a tiny in-memory loopback that the bridge port talks to via the
// SocketBus interface returned from createWasiShim.  No real network.

import {
  type FileStat,
  type FileSystem,
  type FsHandle,
  FsErrno,
  FileType,
} from "./host/fs/types";
import type { YieldStrategy } from "./wasi-shim/yield-strategy";
import { syncYieldStrategy } from "./wasi-shim/yield-sync";
import { PipeRegistry, isPipeFd, pipeFdSlot, pipeFdIsWrite, type PipePollHandle } from "./wasi-shim/pipes-sab";
import { FsSnapshotRegistry, isFsFd } from "./wasi-shim/fs-snapshot-sab";

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOMEM = 48;
const ERRNO_AGAIN = 6;
const ERRNO_NOSYS = 52;

// WASI oflags bit constants — what path_open / path_open2 pass us via the
// oflags arg.  We honor CREAT and TRUNC; DIRECTORY/EXCL are passed as
// hints (DIRECTORY rebinds to OpenOptions.directory; EXCL is ignored —
// adapters can layer their own create-exclusive semantics later).
const OFLAGS_CREAT = 0x1;
const OFLAGS_DIRECTORY = 0x2;
const OFLAGS_TRUNC = 0x8;

// WASI fd-rights bit constants we test on `rightsBase` to decide whether
// the caller asked for write access.  preview1 represents O_RDWR / O_WRONLY
// at open() time via rights bits, not via a separate flag.  These two are
// the only ones we care about for routing to a writable adapter.
const RIGHTS_FD_WRITE = 0x40n;

// Cache native globals at module load.  Edge mutates globalThis during
// bootstrap (TextEncoder, performance, possibly more); resolving these
// through the global object in hot paths is a tested-and-shipped bug
// pattern (NOTES.md 2026-05-20 attempt #6).
const NativeAtomics = Atomics;
const NativeInt32Array = Int32Array;
const NativeUint8Array = Uint8Array;

const WASI_STDOUT_FD = 1;
const WASI_STDERR_FD = 2;

// Preopens.  Three of them — matches what wasmer-wasix exposes natively
// (verified via comparative tracing).  wasi-libc walks fd=3..BADF to
// discover preopens; we need to match exactly or libc's cwd init goes off
// the rails.
//   fd 3 = "/"   (root; the runner's default add_preopen_dir)
//   fd 4 = "."   (current directory; seeds __wasilibc_cwd resolution)
//   fd 5 = "/"   (additional root mount from a host fs binding —
//                 wasmer-wasix emits this from `with_mount` calls)
// Then fd 6 returns BADF to terminate the walk.
const PREOPENS: { fd: number; path: string }[] = [
  { fd: 3, path: "/" },
  { fd: 4, path: "." },
  { fd: 5, path: "/" },
];
const PREOPEN_FDS = new Set(PREOPENS.map((p) => p.fd));

// Virtual fd allocator for opened paths (starts well above stdio + preopens).
let NEXT_VFD = 100;

const FILETYPE_CHARACTER_DEVICE = 2;
const PREOPEN_TYPE_DIR = 0;

interface VirtualFd {
  /** Bytes-on-demand source. nullable means EOF on read. */
  read(buf: Uint8Array): number;
  /** Optional sink for writes; absent ⇒ writes are accepted and discarded. */
  write?(data: Uint8Array): number;
  /** Optional FileSystem-backed handle.  When present, fd_read/fd_close
   *  route through the FileSystem facade instead of using `read` above. */
  fsHandle?: FsHandle;
}

export interface ShimContext {
  memory: WebAssembly.Memory;
  args: string[];
  env: Record<string, string>;
  /** File-backed reads (anything not /dev/*) route through here. */
  fs: FileSystem;
  postLog: (line: string, level?: string) => void;
  postExit: (code: number) => void;
  /** How blocking syscalls bridge to the host's async machinery.
   *  Defaults to `syncYieldStrategy` — wasm thread blocks on Atomics.wait,
   *  microtasks don't drain until `_start` returns.  Pass `jspiYieldStrategy`
   *  on Node v24+ / Chrome 137+ to use engine-native suspension so host
   *  microtasks drain during waits.  See `wasi-shim/yield-strategy.ts`. */
  yieldStrategy?: YieldStrategy;
  /** Cross-thread pipe registry.  Backed by a SAB so every worker (main +
   *  libuv pool + child workers) sees the same pipe state.  Required for
   *  uv_async_send (pool → main wakeup) and any future pipe-using libuv
   *  feature (child_process stdin/stdout, process.send IPC, etc.).  Falls
   *  back to per-worker local state when omitted — only enough to keep
   *  the smoke test happy, real workloads will need it. */
  pipeRegistry?: PipeRegistry;
  /** Cross-thread file snapshot.  Backed by a SAB so every worker can
   *  open + read + close files via globally consistent fd numbers.
   *  Lazy-cached: first open of a path enqueues a load request to main
   *  via the registry's in-SAB request ring; subsequent opens of the
   *  same path hit the cached data region directly.  Reads are SAB-
   *  direct on the data path. */
  fsSnapshot?: FsSnapshotRegistry;
  /** Snapshot role.  "loader" = this worker owns the layered FS adapter
   *  and drains the request ring (i.e. main worker).  "reader" = this
   *  worker reads from the snapshot only (i.e. libuv pool workers).
   *  The loader's own opens MUST bypass the snapshot — Atomics.wait
   *  would deadlock its own setInterval drainer.  Defaults to "reader"
   *  when omitted. */
  fsSnapshotRole?: "loader" | "reader";
}

/** Inbound HTTP request the bridge port wants edge to handle. */
export interface BridgeRequest {
  reqId: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

/** Outbound HTTP response edge produced for a previously-queued request. */
export interface BridgeResponse {
  reqId: number;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The bus exposed by the shim — the bridge port handler talks to this. */
export interface SocketBus {
  /** Push a request onto any listening socket and wake an accept() that's
   *  blocked.  Returns false when no listener exists (shouldn't happen
   *  once edge has called listen). */
  pushRequest(req: BridgeRequest): boolean;
  /** Register the responder; called whenever a connection socket closes
   *  with bytes accumulated in its send buffer.  The shim parses the
   *  raw HTTP/1.1 bytes and invokes this. */
  setResponder(fn: (res: BridgeResponse) => void): void;
  /** Install a poll hook the shim calls each time it wakes from
   *  Atomics.wait inside accept_v2 / poll_oneoff.  Lets the worker
   *  drain a SAB-backed transport (the only path to deliver messages
   *  while the wasm has the worker's event loop blocked). */
  setWakePoll(fn: () => void): void;
  /** The Int32Array view the shim uses for accept-wake notifications.
   *  External notifiers (the Service Worker, when it has a request
   *  ready) call Atomics.add+notify on index 0 of this view to wake
   *  the worker's blocked Atomics.wait. */
  wakeView: Int32Array;
}

function view(memory: WebAssembly.Memory): DataView {
  return new DataView(memory.buffer);
}

function bytes(memory: WebAssembly.Memory): Uint8Array {
  return new Uint8Array(memory.buffer);
}

// Capture native Web Crypto's getRandomValues at module load.  Same
// globalThis-mutation pattern as TextEncoder — edge replaces
// `globalThis.crypto` mid-bootstrap with its own object, and that one
// doesn't have a working getRandomValues from our perspective.  Without
// caching, our /dev/urandom shim writes zeros, which OpenSSL seeds with,
// which makes randomBytes / randomUUID return all-zero output.
const nativeGetRandomValues = crypto.getRandomValues.bind(crypto);

// Capture native text-codec instances at module load.  Edge's bootstrap
// replaces globalThis.TextEncoder/Decoder with its own polyfill (which
// goes through V8 string ops we don't host), so any `new TextEncoder()`
// constructed AFTER bootstrap returns the polyfill — and that polyfill's
// `.encode("/")` returns `[0]` instead of `[0x2f]`, which is the root
// cause of issue #14 (uv_cwd EIO).  See NOTES.md 2026-05-20 entry.
const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

// Cache native APIs at module load — edge mutates globalThis at bootstrap
// and can shadow them mid-run.
const captured = {
  now: performance.now.bind(performance),
  timeOrigin: performance.timeOrigin,
};


export function createWasiShim(ctx: ShimContext): {
  wasi_snapshot_preview1: Record<string, Function>;
  wasix_32v1: Record<string, Function>;
  wasi: Record<string, Function>;
  bus: SocketBus;
  /** E9: Called by napi-host when `unofficial_napi_terminate_execution`
   * fires (i.e. JS-side `process.exit()` ran).  Wakes any parked
   * poll_oneoff so it can throw ExitSignal instead of letting a
   * surviving setTimeout fire after exit was already requested.
   * See napi-host/unofficial.ts and experiments/e9-process-exit-in-fr. */
  requestExit: (code: number) => void;
} {
  // ---- E9: exit-requested state ----
  // Set by `requestExit()` when napi-host's `unofficial_napi_terminate_execution`
  // fires.  Checked by `pollOneoffAwaitTimer` after each engine-timer wake
  // so the wasm aborts with ExitSignal before libuv-wasix gets a chance to
  // service the surviving setTimeout that would otherwise fire and overwrite
  // the exit code.
  const exitState: { requested: boolean; code: number } = { requested: false, code: 0 };

  // ---- stdout/stderr buffering for postLog ----
  const stdoutBuf: number[] = [];
  const stderrBuf: number[] = [];
  function flushBuf(buf: number[], level: string) {
    while (buf.length) {
      const nl = buf.indexOf(10);
      if (nl < 0) break;
      const line = decoder.decode(new Uint8Array(buf.splice(0, nl + 1))).replace(/\n$/, "");
      ctx.postLog(line, level);
    }
  }

  function writeBytesToFd(fd: number, data: Uint8Array): number {
    if (fd === WASI_STDOUT_FD) {
      for (const b of data) stdoutBuf.push(b);
      flushBuf(stdoutBuf, "out");
      return data.length;
    }
    if (fd === WASI_STDERR_FD) {
      for (const b of data) stderrBuf.push(b);
      flushBuf(stderrBuf, "warn");
      return data.length;
    }
    if (isPipeFd(fd) && ctx.pipeRegistry) {
      // Cross-thread pipe.  Any worker can write — bytes go into the SAB
      // ring buffer and notify the reader's wake counter.
      if (!pipeFdIsWrite(fd)) {
        // Writing to a read end is undefined; libuv shouldn't do this.
        return -1;
      }
      return ctx.pipeRegistry.write(pipeFdSlot(fd), data);
    }
    if (isFsFd(fd) && ctx.fsSnapshot) {
      // Cross-thread writable file.  Routes to the SAB-backed data
      // region; atomic position advance.  Writable slots are pre-
      // allocated with a fixed buffer; ENOSPC if the file grows past.
      const n = ctx.fsSnapshot.write(fd, data);
      return n < 0 ? -1 : n;
    }
    // Socket fds buffer writes until close OR until the buffer holds a
    // complete HTTP response, whichever comes first.  Edge's HTTP server
    // doesn't call shutdown/close after writing the response — it expects
    // the client to close the connection.  In our virtual loopback there's
    // no real client; the "close" is implicit when the response is complete.
    // So we eagerly flush as soon as the sendBuf contains a full HTTP/1.1
    // message (status line + headers + Content-Length bytes of body).
    const sock = sockets.get(fd);
    if (sock && sock.state === SOCK_STATE_CONNECTED) {
      for (const b of data) sock.sendBuf.push(b);
      if (isHttpResponseComplete(sock.sendBuf)) {
        closeConnection(sock);
        sockets.delete(fd);
      }
      return data.length;
    }
    const vfd = vfds.get(fd);
    if (vfd) {
      // FS-backed fds: route to the FileSystem facade so writes land on the
      // backing adapter (opfs / in-memory / whatever the layered combinator
      // sent us to at open() time).
      if (vfd.fsHandle !== undefined) {
        const res = ctx.fs.write(vfd.fsHandle, data);
        if (!res.ok) return -1;
        return res.value;
      }
      // Pure-virtual fds (e.g. fd_pipe): route to the vfd's writer if it
      // has one; else accept and discard.
      return vfd.write ? vfd.write(data) : data.length;
    }
    return -1;
  }

  // Cwd is owned by wasi-libc (__wasilibc_cwd) — NOT by us.  The getcwd
  // syscall just reports what we know about the runtime's cwd, which is
  // always "/" for our preopen layout.  Earlier versions tracked cwd here
  // and a #!~debt chdir implementation mutated it; both were redundant
  // with wasi-libc's own resolver and risked diverging from libc state.
  //
  // Encode the bytes ONCE per shim-creation, before any wasm runs.  Edge
  // mutates `globalThis.TextEncoder` mid-boot to a polyfill that emits
  // [0] for "/" — see NOTES.md 2026-05-20 attempt#6.  The module-level
  // `encoder` was captured at module load (line 87) so it's still the
  // native one here.
  const FIXED_CWD_BYTES = encoder.encode("/");

  // ---- virtual file table ----
  // Per-shim: keyed by virtual fd, populated by path_open hits.
  const vfds = new Map<number, VirtualFd>();
  // Known fds are stdio (0/1/2), the root preopen (3), and any virtual fd
  // returned by path_open/fd_pipe.  Anything else → BADF, so the wasm
  // doesn't iterate forever thinking arbitrary fds are alive.
  function isKnownFd(fd: number): boolean {
    if (fd >= 0 && fd <= 2) return true;
    if (PREOPEN_FDS.has(fd)) return true;
    if (vfds.has(fd)) return true;
    if (sockets.has(fd)) return true;
    if (isPipeFd(fd) && ctx.pipeRegistry?.isAlive(pipeFdSlot(fd))) return true;
    if (isFsFd(fd) && ctx.fsSnapshot && ctx.fsSnapshot.fdSize(fd) >= 0) return true;
    return false;
  }

  function urandomFd(): VirtualFd {
    return {
      read(buf: Uint8Array): number {
        // crypto.getRandomValues refuses views backed by SharedArrayBuffer.
        // We fill into a plain buffer, then copy into the shared one.
        let off = 0;
        const tmpChunk = new Uint8Array(Math.min(65536, buf.length));
        while (off < buf.length) {
          const chunk = Math.min(tmpChunk.length, buf.length - off);
          const slice = chunk === tmpChunk.length ? tmpChunk : tmpChunk.subarray(0, chunk);
          nativeGetRandomValues(slice);
          buf.set(slice, off);
          off += chunk;
        }
        return buf.length;
      },
    };
  }

  // Same restriction applies to wasi.random_get's direct buffer fill.

  // ---- helpers shared between path_open / path_open2 / path_filestat_get ----

  function readPath(memory: WebAssembly.Memory, ptr: number, len: number): string {
    return decoder.decode(bytes(memory).slice(ptr, ptr + len));
  }

  function isVirtualUrandom(normalized: string): boolean {
    return (
      normalized === "/dev/urandom" ||
      normalized === "/dev/random" ||
      normalized === "dev/urandom" ||
      normalized === "dev/random"
    );
  }

  function openVirtualUrandom(path: string, openedFdPtr: number, syscall: string): number {
    const newFd = NEXT_VFD++;
    vfds.set(newFd, urandomFd());
    view(ctx.memory).setUint32(openedFdPtr, newFd, true);
    ctx.postLog(`[wasi] ${syscall} ${path} → fd ${newFd} (virtual urandom)`, "info");
    return ERRNO_SUCCESS;
  }

  function openViaFs(
    normalized: string,
    openedFdPtr: number,
    syscall: string,
    options: import("./host/fs/types").OpenOptions = {},
  ): number {
    // Writable opens always route through the SAB snapshot (when
    // available) so writes are visible across every worker.  Both
    // loader and reader paths use openWritable; no waiting involved.
    if (ctx.fsSnapshot && !options.directory && (options.write || options.create || options.truncate)) {
      const slot = ctx.fsSnapshot.openWritable(normalized, {
        create: options.create,
        truncate: options.truncate,
      });
      if (slot < 0) {
        ctx.postLog(`[wasi] ${syscall} ${normalized} (writable) → errno=${-slot}`, "warn");
        return -slot;
      }
      const fd = ctx.fsSnapshot.allocFd(slot);
      if (fd < 0) {
        ctx.postLog(`[wasi] ${syscall} ${normalized} → snapshot fd table full`, "warn");
        return FsErrno.NOENT;
      }
      view(ctx.memory).setUint32(openedFdPtr, fd, true);
      ctx.postLog(`[wasi] ${syscall} ${normalized} → fd ${fd} (snapshot/writable)`, "info");
      return ERRNO_SUCCESS;
    }

    // Read-only opens with a shared snapshot: route through the SAB-
    // backed file table.  Only readers (pool workers) use this — the
    // loader (main worker) MUST use its local FS adapter, because
    // Atomics.wait on a slot would deadlock the loader's own setInterval
    // request-drain handler.
    if (ctx.fsSnapshot && ctx.fsSnapshotRole !== "loader" && !options.write && !options.create && !options.truncate && !options.directory) {
      const lookup = ctx.fsSnapshot.lookup(normalized);
      let slotIdx: number;
      if (lookup.kind === "loaded") {
        slotIdx = lookup.slotIdx;
      } else {
        // Either no slot yet (miss) or another worker is loading.
        // If miss, enqueue and wait.  If loading, just wait.
        if (lookup.kind === "miss") {
          const requested = ctx.fsSnapshot.enqueueLoad(normalized);
          if (requested < 0) {
            ctx.postLog(`[wasi] ${syscall} ${normalized} → snapshot table full (ENOSPC)`, "warn");
            return FsErrno.NOENT;
          }
          slotIdx = requested;
        } else {
          slotIdx = lookup.slotIdx;
        }
        const status = ctx.fsSnapshot.waitOnSlot(slotIdx);
        if (status !== 2 /* PS_STATUS_LOADED */) {
          // Negative status = errno-coded failure.  Map common cases;
          // anything else falls through to ENOENT so wasm-side
          // path-probing keeps walking.
          return status < 0 ? -status : FsErrno.NOENT;
        }
      }
      const fd = ctx.fsSnapshot.allocFd(slotIdx);
      if (fd < 0) {
        ctx.postLog(`[wasi] ${syscall} ${normalized} → snapshot fd table full`, "warn");
        return FsErrno.NOENT;
      }
      view(ctx.memory).setUint32(openedFdPtr, fd, true);
      ctx.postLog(`[wasi] ${syscall} ${normalized} → fd ${fd} (snapshot)`, "info");
      return ERRNO_SUCCESS;
    }

    const res = ctx.fs.open(normalized, options);
    if (!res.ok) {
      // Quiet the noisy "ENOENT for paths the FS doesn't serve" log to keep
      // bootstrap log readable; the trace still records every call+errno.
      if (res.errno !== FsErrno.NOENT) {
        ctx.postLog(`[wasi] ${syscall} ${normalized} → errno=${res.errno}`, "warn");
      }
      return res.errno;
    }
    const newFd = NEXT_VFD++;
    vfds.set(newFd, {
      // The read fn is a no-op fallback; fd_read routes through fsHandle.
      read: () => 0,
      fsHandle: res.value,
    });
    view(ctx.memory).setUint32(openedFdPtr, newFd, true);
    const mode = options.write ? "rw" : "ro";
    ctx.postLog(`[wasi] ${syscall} ${normalized} → fd ${newFd} (fs/${mode})`, "info");
    return ERRNO_SUCCESS;
  }

  function oflagsToOpenOptions(
    oflags: number,
    rightsBase: bigint,
  ): import("./host/fs/types").OpenOptions {
    return {
      directory: (oflags & OFLAGS_DIRECTORY) !== 0,
      write: (rightsBase & RIGHTS_FD_WRITE) !== 0n,
      create: (oflags & OFLAGS_CREAT) !== 0,
      truncate: (oflags & OFLAGS_TRUNC) !== 0,
    };
  }

  function writeFileStat(dv: DataView, statPtr: number, stat: FileStat): void {
    // wasi filestat layout (64 bytes):
    //   u64 dev, u64 ino, u8 filetype, [pad to 8], u64 nlink, u64 size,
    //   u64 atim, u64 mtim, u64 ctim
    dv.setBigUint64(statPtr + 0, 0n, true);
    dv.setBigUint64(statPtr + 8, BigInt(stat.ino), true);
    dv.setUint8(statPtr + 16, stat.fileType);
    dv.setBigUint64(statPtr + 24, 1n, true);
    dv.setBigUint64(statPtr + 32, BigInt(stat.size), true);
    dv.setBigUint64(statPtr + 40, stat.atimNs, true);
    dv.setBigUint64(statPtr + 48, stat.mtimNs, true);
    dv.setBigUint64(statPtr + 56, stat.ctimNs, true);
  }

  // ---- virtual socket table ----
  //
  // The wasm runs synchronously; sockets are async by nature.  We model a
  // tiny in-memory loopback: edge calls sock_open → sock_bind → sock_listen
  // → sock_accept_v2 (blocks), the bridge port pushes an incoming HTTP
  // request which wakes accept_v2, hands edge a new "connection" fd that
  // exposes the request bytes via sock_recv_from / sock_recv, edge writes
  // response bytes via sock_send_to, then closes the fd.  fd_close parses
  // the accumulated send buffer and posts the response back through the
  // bridge.
  //
  // For wakeups we use a small SAB+Int32Array — one slot per socket fd.
  // Atomics.wait is allowed inside a dedicated worker.  When the bridge
  // pushes a request, we increment the slot and Atomics.notify it.
  //
  // #!~debt single-listener: any incoming edge-req goes to whatever
  // listening socket exists, regardless of the port edge bound to.  The
  // SW path is already /_edge/* so the port is irrelevant for routing.
  // Real impl would match the path/port to a specific listener.
  //
  // #!~debt no-ipv6 / no-real-addr-validation: sock_bind/sock_open only
  // honors TCP IPv4.  Anything else gets shunted into a NOTSUP-ish ack
  // (we still return SUCCESS to keep edge progressing, but no semantics).

  const SOCK_STATE_FRESH = 0;     // sock_open done, no bind yet
  const SOCK_STATE_BOUND = 1;     // sock_bind done
  const SOCK_STATE_LISTEN = 2;    // sock_listen done; queue may have requests
  const SOCK_STATE_CONNECTED = 3; // connection socket from accept
  const SOCK_STATE_CLOSED = 4;
  type SockState =
    | typeof SOCK_STATE_FRESH
    | typeof SOCK_STATE_BOUND
    | typeof SOCK_STATE_LISTEN
    | typeof SOCK_STATE_CONNECTED
    | typeof SOCK_STATE_CLOSED;

  interface Socket {
    fd: number;
    state: SockState;
    nonblock: boolean;
    /** For listening sockets: incoming requests awaiting accept. */
    pendingReqs: BridgeRequest[];
    /** For connection sockets: the request bytes edge will read. */
    recvBuf: Uint8Array;
    /** Read cursor into recvBuf. */
    recvOff: number;
    /** For connection sockets: bytes edge has written so far. */
    sendBuf: number[];
    /** Bind address (port only — we don't validate IP). */
    boundPort: number;
    /** Per-connection reqId so we can post the response back. */
    reqId: number;
  }

  // Wakeup memory — single SAB shared across all sockets.  Layout:
  //   [0] accept-ready counter (incremented when a request is pushed)
  //   [N>=1] recv-ready counter per connection fd (indexed by socket.fd)
  // Atomics.wait blocks on the relevant index; notify wakes it.
  const WAKE_SAB = new SharedArrayBuffer(4 * 256);
  const wake = new NativeInt32Array(WAKE_SAB);
  const WAKE_ACCEPT_IDX = 0;

  const sockets = new Map<number, Socket>();
  // The single listening socket fd — used by the bridge port to push
  // incoming requests.  Set on sock_listen; cleared on close.
  let listenFd: number | null = null;
  let responder: ((res: BridgeResponse) => void) | null = null;

  function nextSockFd(): number {
    const fd = NEXT_VFD++;
    return fd;
  }

  function wakeIndexFor(fd: number): number {
    // Map socket fds (typically 100+) onto a small ring of wake slots.
    // Slot 0 reserved for accept; the rest are per-connection recv.
    // #!~debt wake-slot-collisions: with only 255 conn slots, fds beyond
    // ~355 would alias.  Plenty for one-shot bootstraps; bounded later.
    return 1 + (fd % 255);
  }

  function parseAddrPort(addrPtr: number): { port: number } | null {
    // __wasi_addr_port_t: { u8 tag; u8 pad; [u8;18] octs }
    // Inet4 octs layout: [port_lo, port_hi, ip0, ip1, ip2, ip3, 0...]
    // (port is NE per the wasmer-wasix read_ip_port we mirrored.)
    if (addrPtr === 0) return null;
    const mem = bytes(ctx.memory);
    const tag = mem[addrPtr];
    if (tag !== 0 /* Unspec */ && tag !== 1 /* Inet4 */) {
      // Inet6 / other — accept the bind, port unused for routing.
      return { port: 0 };
    }
    const port = mem[addrPtr + 2] | (mem[addrPtr + 3] << 8);
    return { port };
  }

  function writePeerAddr(addrPtr: number): void {
    // Write a fake 127.0.0.1:0 into the out-addr so libc / node sees a
    // valid peer.  #!~debt fake-peer: no real peer info.
    if (addrPtr === 0) return;
    const mem = bytes(ctx.memory);
    mem[addrPtr] = 1; // Addressfamily::Inet4
    mem[addrPtr + 1] = 0; // pad
    // port (network order): 0
    mem[addrPtr + 2] = 0;
    mem[addrPtr + 3] = 0;
    // ip 127.0.0.1
    mem[addrPtr + 4] = 127;
    mem[addrPtr + 5] = 0;
    mem[addrPtr + 6] = 0;
    mem[addrPtr + 7] = 1;
    for (let i = 8; i < 20; i++) mem[addrPtr + i] = 0;
  }

  // Heuristic: does the byte buffer hold a complete HTTP/1.1 response?
  // Scan for "\r\n\r\n" header terminator, parse Content-Length if present,
  // and check the buffer has Content-Length body bytes past the header.
  // Returns true when the buffer is ready to ship as a complete response.
  // #!~debt no-chunked-encoding: assumes Content-Length is present.  HTTP
  // responses without CL (chunked or connection-close framing) are
  // misidentified.  Acceptable for HTTP server output that uses CL.
  function isHttpResponseComplete(buf: number[]): boolean {
    let headerEnd = -1;
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
        headerEnd = i + 4;
        break;
      }
    }
    if (headerEnd < 0) return false;
    // Parse headers naively to find Content-Length.
    let i = 0;
    let cl = -1;
    while (i < headerEnd) {
      let lineEnd = i;
      while (lineEnd < headerEnd && !(buf[lineEnd] === 13 && buf[lineEnd + 1] === 10)) lineEnd++;
      const line = decoder.decode(new NativeUint8Array(buf.slice(i, lineEnd)));
      const colon = line.indexOf(":");
      if (colon > 0) {
        const name = line.slice(0, colon).trim().toLowerCase();
        if (name === "content-length") {
          cl = parseInt(line.slice(colon + 1).trim(), 10);
        }
      }
      i = lineEnd + 2;
    }
    if (cl < 0) {
      // No Content-Length — assume the headers ARE the complete response
      // (e.g. 204 No Content).  Better than hanging forever.
      return true;
    }
    return buf.length >= headerEnd + cl;
  }

  function formatHttpRequest(req: BridgeRequest): Uint8Array {
    // Hand-rolled HTTP/1.1 formatter.  Avoids pulling in a parser dep —
    // the surface needed for one method/path/headers/body roundtrip is
    // a dozen lines.  #!~debt no-keep-alive: Connection: close is implied.
    // #!~debt no-chunked-encoding: body is forwarded as a single chunk
    // with explicit Content-Length.
    const bodyBytes = req.body ? new NativeUint8Array(req.body) : new NativeUint8Array(0);
    const headerLines: string[] = [];
    headerLines.push(`${req.method} ${req.path} HTTP/1.1`);
    // Synthesize Host if the client didn't provide one — Node's http
    // parser requires it for HTTP/1.1.
    let hasHost = false;
    let hasContentLength = false;
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "host") hasHost = true;
      if (k.toLowerCase() === "content-length") hasContentLength = true;
      headerLines.push(`${k}: ${v}`);
    }
    if (!hasHost) headerLines.push("Host: edge.local");
    if (!hasContentLength) headerLines.push(`Content-Length: ${bodyBytes.length}`);
    headerLines.push("Connection: close");
    const head = encoder.encode(headerLines.join("\r\n") + "\r\n\r\n");
    const out = new NativeUint8Array(head.length + bodyBytes.length);
    out.set(head, 0);
    out.set(bodyBytes, head.length);
    return out;
  }

  function parseHttpResponse(raw: Uint8Array): BridgeResponse {
    // Find header/body split.  #!~debt no-error-recovery: malformed
    // responses produce {status:500, body:""} so the bridge always
    // resolves.
    let split = -1;
    for (let i = 0; i + 3 < raw.length; i++) {
      if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
        split = i;
        break;
      }
    }
    if (split < 0) {
      return { reqId: 0, status: 500, headers: { "content-type": "text/plain" }, body: encoder.encode("malformed response from edge\n") };
    }
    const headBytes = raw.subarray(0, split);
    const bodyBytes = raw.subarray(split + 4);
    const headText = decoder.decode(headBytes);
    const lines = headText.split("\r\n");
    const statusLine = lines[0] ?? "HTTP/1.1 500";
    const m = statusLine.match(/^HTTP\/\d+\.\d+\s+(\d+)/);
    const status = m ? parseInt(m[1]!, 10) : 500;
    const headers: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const sep = line.indexOf(":");
      if (sep < 0) continue;
      const k = line.slice(0, sep).trim();
      const v = line.slice(sep + 1).trim();
      headers[k] = v;
    }
    return { reqId: 0, status, headers, body: bodyBytes };
  }

  function closeConnection(sock: Socket): void {
    // Connection closing — parse the accumulated send buffer as an HTTP
    // response and ship it back through the bridge.
    if (sock.state === SOCK_STATE_CONNECTED && sock.sendBuf.length > 0) {
      const raw = NativeUint8Array.from(sock.sendBuf);
      const parsed = parseHttpResponse(raw);
      parsed.reqId = sock.reqId;
      if (responder) responder(parsed);
    }
    sock.state = SOCK_STATE_CLOSED;
  }

  // External wake-poll hook: every time the shim wakes from Atomics.wait
  // (timeout or notify), this runs.  The worker uses it to drain a
  // SAB-backed inbox (writes from the Service Worker) and push fresh
  // requests onto pendingReqs.  Without it, accept_v2 spins until
  // shutdown because the worker can't read MessagePort traffic while
  // blocked inside a sync wasm call.
  let wakePoll: (() => void) | null = null;
  const bus: SocketBus = {
    pushRequest(req: BridgeRequest): boolean {
      if (listenFd === null) return false;
      const listener = sockets.get(listenFd);
      if (!listener) return false;
      listener.pendingReqs.push(req);
      NativeAtomics.add(wake, WAKE_ACCEPT_IDX, 1);
      NativeAtomics.notify(wake, WAKE_ACCEPT_IDX);
      return true;
    },
    setResponder(fn) {
      responder = fn;
    },
    setWakePoll(fn) {
      wakePoll = fn;
    },
    wakeView: wake,
  };

  function readFromSocket(sock: Socket, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
    const dvw = view(ctx.memory);
    const mem = bytes(ctx.memory);
    // Block until at least one byte is available (or socket closed).
    // #!~debt blocking-only-no-shutdown-signal: a closed-but-empty socket
    // returns 0 bytes (EOF).  Real impl distinguishes RST vs FIN.
    while (sock.recvOff >= sock.recvBuf.length && sock.state === SOCK_STATE_CONNECTED) {
      if (sock.nonblock) {
        dvw.setUint32(nreadPtr, 0, true);
        return ERRNO_AGAIN;
      }
      // Wait on the per-connection wake slot.
      const idx = wakeIndexFor(sock.fd);
      const seen = NativeAtomics.load(wake, idx);
      NativeAtomics.wait(wake, idx, seen, 5000);
      // For our loopback we stage all request bytes at accept time, so
      // the loop should exit immediately on first iteration.  This wait
      // path only fires if buffer was somehow empty post-accept.
      break;
    }
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const base = dvw.getUint32(iovsPtr + i * 8, true);
      const len = dvw.getUint32(iovsPtr + i * 8 + 4, true);
      if (len === 0) continue;
      const avail = sock.recvBuf.length - sock.recvOff;
      if (avail <= 0) break;
      const take = Math.min(len, avail);
      mem.set(sock.recvBuf.subarray(sock.recvOff, sock.recvOff + take), base);
      sock.recvOff += take;
      total += take;
      if (take < len) break;
    }
    dvw.setUint32(nreadPtr, total, true);
    return ERRNO_SUCCESS;
  }

  function writeIovsToSocket(sock: Socket, iovsPtr: number, iovsLen: number): number {
    const dvw = view(ctx.memory);
    const mem = bytes(ctx.memory);
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const base = dvw.getUint32(iovsPtr + i * 8, true);
      const len = dvw.getUint32(iovsPtr + i * 8 + 4, true);
      if (len === 0) continue;
      const slice = mem.subarray(base, base + len);
      for (let j = 0; j < slice.length; j++) sock.sendBuf.push(slice[j]!);
      total += len;
    }
    return total;
  }

  // ---- poll_oneoff helpers + sync/async impls ----
  //
  // The sync impl is the original behavior (Atomics.wait blocks the JS
  // thread).  The async-capable impl can return a Promise<number> for
  // the timer-only case; the chosen YieldStrategy decides which one is
  // exposed as the wasm import (and whether to wrap with
  // WebAssembly.Suspending).

  const POLL_SUB_SIZE = 48;
  const POLL_EVT_SIZE = 32;

  // First pass: walk subscriptions, emit any events that are immediately
  // ready, and report the wait parameters the caller needs to honor if no
  // events were ready.
  function pollOneoffWalkSubs(
    dv: DataView,
    inPtr: number,
    outPtr: number,
    nsubs: number,
  ): { nWritten: number; minTimeoutNs: number; hasSocketSub: boolean; pipeReadSubs: Array<{ slot: number; handle: PipePollHandle }> } {
    let nWritten = 0;
    let minTimeoutNs = -1;
    let hasSocketSub = false;
    const pipeReadSubs: Array<{ slot: number; handle: PipePollHandle }> = [];
    for (let i = 0; i < nsubs; i++) {
      const base = inPtr + i * POLL_SUB_SIZE;
      const userdata = dv.getBigUint64(base + 0, true);
      const ty = dv.getUint8(base + 8);
      let ready = false;
      let nbytes = 0n;
      const evtType = ty;
      let errno = 0;
      if (ty === 0) {
        const timeoutNs = dv.getBigUint64(base + 24, true);
        const asNum = Number(timeoutNs);
        if (minTimeoutNs < 0 || asNum < minTimeoutNs) minTimeoutNs = asNum;
      } else if (ty === 1 || ty === 2) {
        const fd = dv.getUint32(base + 16, true);
        const sock = sockets.get(fd);
        if (sock) {
          hasSocketSub = true;
          if (ty === 1) {
            if (sock.state === SOCK_STATE_LISTEN) {
              ready = sock.pendingReqs.length > 0;
              nbytes = ready ? 1n : 0n;
            } else if (sock.state === SOCK_STATE_CONNECTED) {
              const avail = sock.recvBuf.length - sock.recvOff;
              ready = avail > 0;
              nbytes = BigInt(avail);
            }
          } else {
            ready = sock.state === SOCK_STATE_CONNECTED;
            nbytes = ready ? 65536n : 0n;
          }
        } else if (isPipeFd(fd) && ctx.pipeRegistry) {
          // Pipe poll.  FdRead (ty=1): ready iff bytes buffered.  FdWrite
          // (ty=2): always ready for now — we don't track downstream pressure
          // beyond the simple "buffer not full" check at write time, which
          // is sufficient for libuv's uv_async_send + Node's pipe APIs.
          if (ty === 1) {
            const slot = pipeFdSlot(fd);
            const handle = ctx.pipeRegistry.pollHandle(slot);
            if (handle.ready()) {
              ready = true;
              nbytes = BigInt(ctx.pipeRegistry.available(slot));
            } else {
              pipeReadSubs.push({ slot, handle });
              ready = false;
            }
          } else {
            ready = true;
            nbytes = 4096n;
          }
        } else {
          const vfd = vfds.get(fd);
          if (vfd?.fsHandle !== undefined) {
            ready = true;
            nbytes = 0n;
          } else if (vfd) {
            ready = false;
          } else if (fd <= 2 || PREOPEN_FDS.has(fd)) {
            ready = true;
            nbytes = 0n;
          } else {
            errno = ERRNO_BADF;
            ready = true;
          }
        }
      }
      if (ready) {
        const eb = outPtr + nWritten * POLL_EVT_SIZE;
        dv.setBigUint64(eb + 0, userdata, true);
        dv.setUint16(eb + 8, errno, true);
        dv.setUint8(eb + 10, evtType);
        for (let p = 11; p < 16; p++) dv.setUint8(eb + p, 0);
        dv.setBigUint64(eb + 16, nbytes, true);
        dv.setUint16(eb + 24, 0, true);
        for (let p = 26; p < POLL_EVT_SIZE; p++) dv.setUint8(eb + p, 0);
        nWritten++;
      }
    }
    return { nWritten, minTimeoutNs, hasSocketSub, pipeReadSubs };
  }

  // After waking from a wait, scan subs and emit (a) any newly-ready socket
  // FdRead events and (b) one Clock event (the rest fold into the next call).
  function pollOneoffEmitPostWaitEvents(
    dv: DataView,
    inPtr: number,
    outPtr: number,
    initialNWritten: number,
    nsubs: number,
  ): number {
    let nWritten = initialNWritten;
    for (let i = 0; i < nsubs; i++) {
      const base = inPtr + i * POLL_SUB_SIZE;
      const userdata = dv.getBigUint64(base + 0, true);
      const ty = dv.getUint8(base + 8);
      if (ty !== 1) continue;
      const fd = dv.getUint32(base + 16, true);
      const s = sockets.get(fd);
      if (s && s.state === SOCK_STATE_LISTEN && s.pendingReqs.length > 0) {
        const eb = outPtr + nWritten * POLL_EVT_SIZE;
        dv.setBigUint64(eb + 0, userdata, true);
        dv.setUint16(eb + 8, 0, true);
        dv.setUint8(eb + 10, ty);
        for (let p = 11; p < 16; p++) dv.setUint8(eb + p, 0);
        dv.setBigUint64(eb + 16, 1n, true);
        dv.setUint16(eb + 24, 0, true);
        for (let p = 26; p < POLL_EVT_SIZE; p++) dv.setUint8(eb + p, 0);
        nWritten++;
      } else if (isPipeFd(fd) && ctx.pipeRegistry && !pipeFdIsWrite(fd)) {
        const slot = pipeFdSlot(fd);
        const avail = ctx.pipeRegistry.available(slot);
        if (avail > 0) {
          const eb = outPtr + nWritten * POLL_EVT_SIZE;
          dv.setBigUint64(eb + 0, userdata, true);
          dv.setUint16(eb + 8, 0, true);
          dv.setUint8(eb + 10, ty);
          for (let p = 11; p < 16; p++) dv.setUint8(eb + p, 0);
          dv.setBigUint64(eb + 16, BigInt(avail), true);
          dv.setUint16(eb + 24, 0, true);
          for (let p = 26; p < POLL_EVT_SIZE; p++) dv.setUint8(eb + p, 0);
          nWritten++;
        }
      }
    }
    for (let i = 0; i < nsubs; i++) {
      const base = inPtr + i * POLL_SUB_SIZE;
      const userdata = dv.getBigUint64(base + 0, true);
      const ty = dv.getUint8(base + 8);
      if (ty !== 0) continue;
      const eb = outPtr + nWritten * POLL_EVT_SIZE;
      dv.setBigUint64(eb + 0, userdata, true);
      dv.setUint16(eb + 8, 0, true);
      dv.setUint8(eb + 10, 0);
      for (let p = 11; p < POLL_EVT_SIZE; p++) dv.setUint8(eb + p, 0);
      nWritten++;
      break;
    }
    return nWritten;
  }

  // Dedicated 4-byte SAB slot for engine-driven timer waits via
  // Atomics.waitAsync.  We never call Atomics.notify on this slot
  // (other than to no-op cancel) — the wakeup comes from waitAsync's
  // built-in timeout, which the engine implements at the C++ layer
  // outside the JS macrotask queue.  Critical: setTimeout-driven
  // wakeups would deadlock here (the macrotask queue is blocked while
  // wasm is JSPI-suspended).
  const sleepSab = new SharedArrayBuffer(4);
  const sleepI32 = new NativeInt32Array(sleepSab);

  // The async helper that actually awaits the timer.  Defining it as a
  // proper `async` function — empirically (vs returning `new Promise(...)`
  // from the caller) — is what JSPI's Suspending wrapper needs to
  // recognize the yield.
  async function pollOneoffAwaitTimer(
    ms: number,
    dv: DataView,
    inPtr: number,
    outPtr: number,
    nWrittenSoFar: number,
    nsubs: number,
    neventsPtr: number,
  ): Promise<number> {
    // Engine-driven timeout via Atomics.waitAsync(view, 0, expectedVal, ms).
    // We pass expectedVal=0 and never write any other value to the slot,
    // so the wait NEVER matches "value differs"; the wakeup is exclusively
    // via the engine's internal timer subsystem at C++ layer — bypasses
    // the JS macrotask queue that JSPI suspension freezes.
    //
    // Spec: { async: bool, value: Promise<'ok'|'timed-out'> | 'not-equal' }
    // If async=true we await the Promise.  If async=false (rare — only
    // when the slot value already differs at call time, which we ensure
    // doesn't happen by leaving slot=0), nothing to wait on.
    const waitAsync = (NativeAtomics as unknown as {
      waitAsync?: (i32: Int32Array, idx: number, val: number, timeout: number) =>
        { async: boolean; value: Promise<string> | string };
    }).waitAsync;
    if (waitAsync) {
      const result = waitAsync(sleepI32, 0, 0, ms);
      if (result.async) await result.value;
    } else {
      // Fallback for engines without Atomics.waitAsync (none of our
      // current targets) — relies on macrotask queue, deadlocks under JSPI.
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
    // E9: if a FinalizationRegistry callback (or other JS that fires during
    // the JSPI suspend window) called process.exit(), napi-host set our
    // exit-requested flag.  Throw ExitSignal so the wasm unwinds back to
    // the harness instead of returning here, which would cause libuv-wasix
    // to dispatch the surviving setTimeout callback and overwrite the exit
    // code.  See experiments/e9-process-exit-in-fr/FINDINGS.md.
    if (exitState.requested) {
      flushBuf(stdoutBuf, "out");
      flushBuf(stderrBuf, "warn");
      ctx.postExit(exitState.code >>> 0);
      throw new ExitSignal(exitState.code >>> 0);
    }
    const dvAfter = view(ctx.memory);
    const finalN = pollOneoffEmitPostWaitEvents(dvAfter, inPtr, outPtr, nWrittenSoFar, nsubs);
    dvAfter.setUint32(neventsPtr, finalN, true);
    void dv;
    return ERRNO_SUCCESS;
  }

  function pollOneoffSyncImpl(
    inPtr: number,
    outPtr: number,
    nsubs: number,
    neventsPtr: number,
  ): number {
    const dv = view(ctx.memory);
    const r = pollOneoffWalkSubs(dv, inPtr, outPtr, nsubs);
    let nWritten = r.nWritten;
    const { minTimeoutNs, hasSocketSub } = r;
    // poll(fds, n, timeout=-1) must block until at least one fd is ready —
    // never return 0 with -1 timeout (libuv-wasix asserts this at
    // posix-poll.c:234).  We wait when there are subs (any kind) and
    // nothing's ready yet.  Wake source is the accept slot (HTTP bridge
    // pushRequest, future per-pipe notifies); timeout caps the wait so
    // genuinely stalled cases still release.
    if (nWritten === 0 && nsubs > 0) {
      const idx = WAKE_ACCEPT_IDX;
      const seen = NativeAtomics.load(wake, idx);
      const ms = minTimeoutNs >= 0
        ? Math.max(0, Math.min(60_000, Math.ceil(minTimeoutNs / 1_000_000)))
        : 30_000;
      NativeAtomics.wait(wake, idx, seen, ms);
      if (wakePoll) wakePoll();
      nWritten = pollOneoffEmitPostWaitEvents(dv, inPtr, outPtr, nWritten, nsubs);
    }
    void hasSocketSub;
    dv.setUint32(neventsPtr, nWritten, true);
    return ERRNO_SUCCESS;
  }

  // Async-capable variant.  Returns a sync number when no waiting is
  // needed (events ready immediately) so JSPI doesn't suspend wasm
  // unnecessarily.  Returns a Promise<number> when a wait is required;
  // the JSPI engine suspends the wasm caller for the duration, letting
  // host microtasks drain during the gap.
  //
  // BOTH timer-only AND socket waits use Atomics.waitAsync so the wasm
  // yields under JSPI.  Timer-only uses the engine-driven timeout
  // (no notify required — see pollOneoffAwaitTimer).  Socket waits use
  // the ACCEPT slot's expected/actual mismatch as the wake signal:
  // pushRequest() does Atomics.add+notify on that slot, which causes
  // waitAsync's value-check to differ and the Promise to resolve.
  function pollOneoffAsyncImpl(
    inPtr: number,
    outPtr: number,
    nsubs: number,
    neventsPtr: number,
  ): number | Promise<number> {
    // JSPI re-entry detection.  If we're being called from a JS-driven
    // wasm re-entry (microtask, napi callback, setImmediate handler),
    // there's no promising frame on the current call stack — returning
    // a Promise here would crash with "trying to suspend without
    // WebAssembly.promising".  Fall through to the sync impl which
    // blocks the JS thread on Atomics.wait.  napi callbacks that hit
    // this path are typically short waits (mutex contention), so the
    // block is bounded.
    const depthHolder = globalThis as { __edgePromisingDepth?: number };
    if ((depthHolder.__edgePromisingDepth ?? 0) <= 0) {
      return pollOneoffSyncImpl(inPtr, outPtr, nsubs, neventsPtr);
    }
    const dv = view(ctx.memory);
    const r = pollOneoffWalkSubs(dv, inPtr, outPtr, nsubs);
    let nWritten = r.nWritten;
    const { minTimeoutNs, hasSocketSub } = r;

    // Diagnostic: instrument the spin investigation.  Log every Nth
    // poll_oneoff call with its key shape.  If clock_time_get is
    // spinning, EITHER poll_oneoff is being skipped entirely (we'll
    // see large gaps in the counter) OR poll_oneoff is returning
    // immediately with nWritten>0 (events instantly ready — usually
    // means an always-ready sub).
    // Reset the clock_time_get-spin probe.  Reaching poll_oneoff means
    // libuv made it back to its I/O wait — anything spinning on
    // clock_time_get without poll_oneoff in between is a real wasm-side
    // tight loop (NOT the libuv main loop, which always hits us).
    const clockProbe = (globalThis as { __edgeClockProbe?: { streak: number; logged: boolean } }).__edgeClockProbe;
    if (clockProbe) clockProbe.streak = 0;

    const probe = (globalThis as { __edgePollProbe?: { n: number; lastT: number; tinyTimeoutCount: number; tinyTimeoutLogged: boolean } });
    const probeState = probe.__edgePollProbe ?? (probe.__edgePollProbe = { n: 0, lastT: 0, tinyTimeoutCount: 0, tinyTimeoutLogged: false });
    probeState.n++;
    // Count tiny (<1µs) timeouts and dump a stack on the 20th — that
    // identifies what wasm code is keeping libuv from suspending.
    if (minTimeoutNs >= 0 && minTimeoutNs < 1000) {
      probeState.tinyTimeoutCount++;
      if (probeState.tinyTimeoutCount === 20 && !probeState.tinyTimeoutLogged) {
        probeState.tinyTimeoutLogged = true;
        const stk = new Error("tiny-timeout-stack").stack ?? "(no stack)";
        ctx.postLog(`[poll-probe] tiny-timeout streak detected (count=${probeState.tinyTimeoutCount}, latest minTimeoutNs=${minTimeoutNs}, subs=${nsubs}) — stack:\n${stk}`, "warn");
      }
    }
    if (probeState.n <= 30 || probeState.n % 500 === 0) {
      const t = (typeof performance !== "undefined" ? performance.now() : 0);
      ctx.postLog(`[poll-probe] n=${probeState.n} subs=${nsubs} minTimeoutNs=${minTimeoutNs} hasSocket=${hasSocketSub} immReady=${nWritten} dt=${(t - probeState.lastT).toFixed(1)}ms tinyCount=${probeState.tinyTimeoutCount}`, "info");
      probeState.lastT = t;
    }

    if (nWritten > 0 || nsubs === 0) {
      // Events already ready, or genuinely nothing to wait for (caller
      // passed empty subscription list — a no-op poll).
      dv.setUint32(neventsPtr, nWritten, true);
      return ERRNO_SUCCESS;
    }

    if (minTimeoutNs >= 0 && !hasSocketSub && r.pipeReadSubs.length === 0) {
      // Timer-only wait: yield via Atomics.waitAsync with its built-in
      // timeout (see pollOneoffAwaitTimer).
      const ms = Math.max(0, Math.min(60_000, Math.ceil(minTimeoutNs / 1_000_000)));
      return pollOneoffAwaitTimer(ms, dv, inPtr, outPtr, nWritten, nsubs, neventsPtr);
    }

    // Any sub kind not immediately ready: race the wake sources.
    //   - HTTP bridge pushRequest() (Atomics.add+notify on wake[0])
    //   - Cross-thread pipe writes (Atomics.add+notify on per-pipe
    //     wakeCounter — see pipes-sab.ts).  PipeRegistry returns one
    //     PollHandle per not-yet-ready pipe-read sub; we waitAsync on
    //     each and Promise.race them with the bridge wake + the
    //     timeout.  First wake unblocks; we re-evaluate readiness and
    //     emit events for whatever is now ready.
    //
    // Without race-of-waiters, a pool-worker pipe write wouldn't unblock
    // a main-thread poll that was waiting on the bridge slot.  This
    // breaks `uv_async_send` and any other cross-thread pipe wake.
    const acceptIdx = WAKE_ACCEPT_IDX;
    const acceptSeen = NativeAtomics.load(wake, acceptIdx);
    const ms = minTimeoutNs >= 0
      ? Math.max(0, Math.min(60_000, Math.ceil(minTimeoutNs / 1_000_000)))
      : 30_000;
    const waitAsync = (NativeAtomics as unknown as {
      waitAsync?: (i32: Int32Array, idx: number, val: number, timeout: number) =>
        { async: boolean; value: Promise<string> | string };
    }).waitAsync;
    if (waitAsync) {
      const racers: Promise<unknown>[] = [];
      const bridgeRes = waitAsync(wake, acceptIdx, acceptSeen, ms);
      if (bridgeRes.async) racers.push(bridgeRes.value as Promise<unknown>);
      for (const { handle } of r.pipeReadSubs) {
        const pr = waitAsync(handle.i32, handle.idx, handle.seen, ms);
        if (pr.async) racers.push(pr.value as Promise<unknown>);
        else {
          // Sync return from waitAsync means "not-equal" — the wake
          // counter already changed.  The reader is ready now; skip the
          // race entirely.
          if (wakePoll) wakePoll();
          const finalN = pollOneoffEmitPostWaitEvents(dv, inPtr, outPtr, nWritten, nsubs);
          dv.setUint32(neventsPtr, finalN, true);
          return ERRNO_SUCCESS;
        }
      }
      if (racers.length > 0) {
        return (async () => {
          await Promise.race(racers);
          if (wakePoll) wakePoll();
          const finalN = pollOneoffEmitPostWaitEvents(dv, inPtr, outPtr, nWritten, nsubs);
          dv.setUint32(neventsPtr, finalN, true);
          return ERRNO_SUCCESS;
        })();
      }
    } else {
      NativeAtomics.wait(wake, acceptIdx, acceptSeen, ms);
    }
    if (wakePoll) wakePoll();
    nWritten = pollOneoffEmitPostWaitEvents(dv, inPtr, outPtr, nWritten, nsubs);
    dv.setUint32(neventsPtr, nWritten, true);
    return ERRNO_SUCCESS;
  }

  // ---- wasi_snapshot_preview1 ----
  const wasi_snapshot_preview1: Record<string, Function> = {
    proc_exit(code: number) {
      flushBuf(stdoutBuf, "out");
      flushBuf(stderrBuf, "warn");
      ctx.postExit(code >>> 0);
      const exitErr = new ExitSignal(code >>> 0);
      // Capture call site on the error so downstream (emnapi onError,
      // harness catch) can show which wasm function called proc_exit.
      try { Error.captureStackTrace?.(exitErr, undefined as never); } catch { /* */ }
      throw exitErr;
    },

    fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) {
      const dv = view(ctx.memory);
      const mem = bytes(ctx.memory);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = dv.getUint32(iovsPtr + i * 8, true);
        const len = dv.getUint32(iovsPtr + i * 8 + 4, true);
        if (len > 0) {
          const slice = mem.subarray(base, base + len);
          const written = writeBytesToFd(fd, slice);
          if (written < 0) {
            dv.setUint32(nwrittenPtr, total, true);
            return ERRNO_BADF;
          }
          total += written;
        }
      }
      dv.setUint32(nwrittenPtr, total, true);
      return ERRNO_SUCCESS;
    },

    fd_close(fd: number) {
      // Socket close: flush response and tear down.
      const sock = sockets.get(fd);
      if (sock) {
        closeConnection(sock);
        sockets.delete(fd);
        if (listenFd === fd) listenFd = null;
        return ERRNO_SUCCESS;
      }
      if (isPipeFd(fd) && ctx.pipeRegistry) {
        ctx.pipeRegistry.close(fd);
        return ERRNO_SUCCESS;
      }
      if (isFsFd(fd) && ctx.fsSnapshot) {
        ctx.fsSnapshot.close(fd);
        return ERRNO_SUCCESS;
      }
      const vfd = vfds.get(fd);
      if (vfd?.fsHandle !== undefined) {
        // Best-effort: release the FS handle, ignore errno (we're closing
        // either way, and the wasm doesn't care about cleanup errors).
        ctx.fs.close(vfd.fsHandle);
      }
      vfds.delete(fd);
      return ERRNO_SUCCESS;
    },

    // WASI preopen enumeration.  Runtime walks fd=3, 4, ... until BADF.
    // We expose two: "/" (fd 3, root) and "." (fd 4, current dir).
    fd_prestat_get(fd: number, bufPtr: number) {
      const preopen = PREOPENS.find((p) => p.fd === fd);
      if (!preopen) return ERRNO_BADF;
      const dvw = view(ctx.memory);
      const pathBytes = encoder.encode(preopen.path);
      // prestat layout: { u8 type; <padding>; u32 name_len }
      dvw.setUint8(bufPtr, PREOPEN_TYPE_DIR);
      dvw.setUint32(bufPtr + 4, pathBytes.length, true);
      return ERRNO_SUCCESS;
    },
    fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number) {
      const preopen = PREOPENS.find((p) => p.fd === fd);
      if (!preopen) return ERRNO_BADF;
      const pathBytes = encoder.encode(preopen.path);
      if (pathLen < pathBytes.length) return ERRNO_NOSYS;
      bytes(ctx.memory).set(pathBytes, pathPtr);
      return ERRNO_SUCCESS;
    },

    // Tiny filestat: stdio (fd 0/1/2) → character device.  FS-backed fds
    // get their real stat from the FileSystem facade.  Other virtual fds
    // (e.g. /dev/urandom) stay character-device.
    fd_filestat_get(fd: number, statPtr: number) {
      if (isFsFd(fd) && ctx.fsSnapshot) {
        const size = ctx.fsSnapshot.fdSize(fd);
        if (size < 0) return ERRNO_BADF;
        const dv = view(ctx.memory);
        dv.setBigUint64(statPtr +  0, 0n, true);
        dv.setBigUint64(statPtr +  8, BigInt(fd), true);
        dv.setUint8(statPtr + 16, 4); // FILETYPE_REGULAR_FILE
        dv.setBigUint64(statPtr + 24, 1n, true);
        dv.setBigUint64(statPtr + 32, BigInt(size), true);
        dv.setBigUint64(statPtr + 40, 0n, true);
        dv.setBigUint64(statPtr + 48, 0n, true);
        dv.setBigUint64(statPtr + 56, 0n, true);
        return ERRNO_SUCCESS;
      }
      if (fd > 2 && !vfds.has(fd) && !PREOPEN_FDS.has(fd)) return ERRNO_NOSYS;
      const vfd = vfds.get(fd);
      if (vfd?.fsHandle !== undefined) {
        const res = ctx.fs.fstat(vfd.fsHandle);
        if (!res.ok) return res.errno;
        writeFileStat(view(ctx.memory), statPtr, res.value);
        return ERRNO_SUCCESS;
      }
      const dv = view(ctx.memory);
      // wasi filestat layout: dev(u64) ino(u64) filetype(u8) [pad] nlink(u64) size(u64) atim/mtim/ctim(u64 each)
      dv.setBigUint64(statPtr +  0, 0n, true);  // dev
      dv.setBigUint64(statPtr +  8, BigInt(fd), true); // ino
      dv.setUint8(statPtr + 16, FILETYPE_CHARACTER_DEVICE);
      dv.setBigUint64(statPtr + 24, 1n, true); // nlink
      dv.setBigUint64(statPtr + 32, 0n, true); // size
      dv.setBigUint64(statPtr + 40, 0n, true); // atim
      dv.setBigUint64(statPtr + 48, 0n, true); // mtim
      dv.setBigUint64(statPtr + 56, 0n, true); // ctim
      return ERRNO_SUCCESS;
    },
    fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number) {
      // Socket fds: read from recv buffer.
      const sock = sockets.get(fd);
      if (sock) {
        return readFromSocket(sock, iovsPtr, iovsLen, nreadPtr);
      }
      if (isFsFd(fd) && ctx.fsSnapshot) {
        // Cross-thread snapshot read.  Atomic-bumps position; copies
        // bytes directly from SAB data region into wasm memory.
        const dvw = view(ctx.memory);
        const mem = bytes(ctx.memory);
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const base = dvw.getUint32(iovsPtr + i * 8, true);
          const len = dvw.getUint32(iovsPtr + i * 8 + 4, true);
          if (len === 0) continue;
          const n = ctx.fsSnapshot.read(fd, mem.subarray(base, base + len));
          if (n < 0) {
            dvw.setUint32(nreadPtr, total, true);
            return ERRNO_BADF;
          }
          total += n;
          if (n < len) break;
        }
        dvw.setUint32(nreadPtr, total, true);
        return ERRNO_SUCCESS;
      }
      if (isPipeFd(fd) && ctx.pipeRegistry) {
        // Cross-thread pipe read.  Reads what's currently in the SAB ring
        // buffer; returns 0 if empty (callers that need to block use
        // poll_oneoff first).
        if (pipeFdIsWrite(fd)) {
          view(ctx.memory).setUint32(nreadPtr, 0, true);
          return ERRNO_BADF;
        }
        const dvw = view(ctx.memory);
        const mem = bytes(ctx.memory);
        const slot = pipeFdSlot(fd);
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const base = dvw.getUint32(iovsPtr + i * 8, true);
          const len = dvw.getUint32(iovsPtr + i * 8 + 4, true);
          if (len === 0) continue;
          const n = ctx.pipeRegistry.read(slot, mem.subarray(base, base + len));
          total += n;
          if (n < len) break;
        }
        dvw.setUint32(nreadPtr, total, true);
        return ERRNO_SUCCESS;
      }
      const vfd = vfds.get(fd);
      if (!vfd) {
        view(ctx.memory).setUint32(nreadPtr, 0, true);
        return ERRNO_BADF;
      }
      const dvw = view(ctx.memory);
      const mem = bytes(ctx.memory);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = dvw.getUint32(iovsPtr + i * 8, true);
        const len = dvw.getUint32(iovsPtr + i * 8 + 4, true);
        if (len > 0) {
          // FS-backed: route to the facade.  Virtual-only: use the read fn.
          let n: number;
          if (vfd.fsHandle !== undefined) {
            const res = ctx.fs.read(vfd.fsHandle, mem.subarray(base, base + len));
            if (!res.ok) {
              dvw.setUint32(nreadPtr, total, true);
              return res.errno;
            }
            n = res.value;
          } else {
            n = vfd.read(mem.subarray(base, base + len));
          }
          total += n;
          if (n < len) break; // short read
        }
      }
      dvw.setUint32(nreadPtr, total, true);
      return ERRNO_SUCCESS;
    },

    // Open a path under a preopen.  Routes:
    //   - /dev/{urandom,random}  → virtual urandom fd
    //   - anything else          → FileSystem facade (bundled adapter)
    path_open(
      _dirfd: number,
      _dirflags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      rightsBase: bigint,
      _rightsInheriting: bigint,
      _fdflags: number,
      openedFdPtr: number,
    ) {
      const path = readPath(ctx.memory, pathPtr, pathLen);
      const normalized = path.startsWith("/") ? path : "/" + path;
      if (isVirtualUrandom(normalized)) {
        return openVirtualUrandom(path, openedFdPtr, "path_open");
      }
      return openViaFs(normalized, openedFdPtr, "path_open",
        oflagsToOpenOptions(oflags, rightsBase));
    },

    // path_filestat_get — stat a path.  Routes through the FS facade for
    // anything the adapter recognizes; falls back to a permissive "looks
    // like dir / looks like file" heuristic so libc directory probes (used
    // by cwd resolution and bootstrap fixture lookups) still pass.
    // #!~debt fake-fs-fallback: paths the FS doesn't serve still report
    // success.  Real impl needs adapters that own the entire path tree
    // (OPFS for userland, manifest for bundled).
    path_filestat_get(_dirfd: number, _flags: number, pathPtr: number, pathLen: number, statPtr: number) {
      const path = readPath(ctx.memory, pathPtr, pathLen);
      const dv = view(ctx.memory);
      const fsRes = ctx.fs.stat(path);
      if (fsRes.ok) {
        writeFileStat(dv, statPtr, fsRes.value);
        return ERRNO_SUCCESS;
      }
      // Fallback heuristic — see #!~debt above.
      const isDir = path === "/" || path === "" || path === "." || path.endsWith("/");
      writeFileStat(dv, statPtr, {
        fileType: isDir ? FileType.DIRECTORY : FileType.REGULAR_FILE,
        size: 0,
        ino: 1,
        atimNs: 0n,
        mtimNs: 0n,
        ctimNs: 0n,
      });
      return ERRNO_SUCCESS;
    },

    // Set the FD's non-blocking / append etc. flags.  Accept all settings as
    // no-op; we don't actually back fds with blocking semantics today.
    fd_fdstat_set_flags(_fd: number, _flags: number) {
      return ERRNO_SUCCESS;
    },

    fd_fdstat_get(fd: number, statPtr: number) {
      // wasi fdstat layout (24 bytes):
      //   u8  fs_filetype
      //   u16 fs_flags        (offset 2 due to padding)
      //   u64 fs_rights_base  (offset 8)
      //   u64 fs_rights_inheriting (offset 16)
      const dv = view(ctx.memory);
      const mem = bytes(ctx.memory);
      // Zero the 24-byte struct first.
      for (let i = 0; i < 24; i++) mem[statPtr + i] = 0;
      // Classify the fd.  Misclassifying a socket as a character device makes
      // edge's libuv treat it as a tty and skip recv() entirely — which was
      // why HTTP request bytes never reached edge after accept_v2 returned.
      const filetype = sockets.has(fd)
        ? 6 /* SOCKET_STREAM */
        : FILETYPE_CHARACTER_DEVICE;
      dv.setUint8(statPtr + 0, filetype);
      // Flags: 0 (default)
      dv.setUint16(statPtr + 2, 0, true);
      // Rights: grant everything so caller doesn't reject the fd
      dv.setBigUint64(statPtr + 8, ~0n, true);
      dv.setBigUint64(statPtr + 16, ~0n, true);
      return ERRNO_SUCCESS;
    },

    fd_seek(_fd: number, _offsetLo: bigint, _whence: number, newPosPtr: number) {
      view(ctx.memory).setBigUint64(newPosPtr, 0n, true);
      return ERRNO_SUCCESS;
    },

    args_sizes_get(countPtr: number, bufSizePtr: number) {
      const enc = encoder;
      let size = 0;
      for (const a of ctx.args) size += enc.encode(a).length + 1;
      const dv = view(ctx.memory);
      dv.setUint32(countPtr, ctx.args.length, true);
      dv.setUint32(bufSizePtr, size, true);
      return ERRNO_SUCCESS;
    },

    args_get(argvPtr: number, argvBufPtr: number) {
      const dv = view(ctx.memory);
      const mem = bytes(ctx.memory);
      const enc = encoder;
      let p = argvBufPtr;
      ctx.args.forEach((arg, i) => {
        dv.setUint32(argvPtr + i * 4, p, true);
        const b = enc.encode(arg);
        mem.set(b, p);
        mem[p + b.length] = 0;
        p += b.length + 1;
      });
      return ERRNO_SUCCESS;
    },

    environ_sizes_get(countPtr: number, bufSizePtr: number) {
      const enc = encoder;
      const entries = Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`);
      let size = 0;
      for (const e of entries) size += enc.encode(e).length + 1;
      const dv = view(ctx.memory);
      dv.setUint32(countPtr, entries.length, true);
      dv.setUint32(bufSizePtr, size, true);
      return ERRNO_SUCCESS;
    },

    environ_get(envPtr: number, envBufPtr: number) {
      const dv = view(ctx.memory);
      const mem = bytes(ctx.memory);
      const enc = encoder;
      const entries = Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`);
      let p = envBufPtr;
      entries.forEach((entry, i) => {
        dv.setUint32(envPtr + i * 4, p, true);
        const b = enc.encode(entry);
        mem.set(b, p);
        mem[p + b.length] = 0;
        p += b.length + 1;
      });
      return ERRNO_SUCCESS;
    },

    clock_res_get(_clockId: number, resPtr: number) {
      view(ctx.memory).setBigUint64(resPtr, 1000n, true);
      return ERRNO_SUCCESS;
    },

    clock_time_get(_clockId: number, _precision: bigint, timePtr: number) {
      // Diagnostic: detect "clock_time_get spin" by counting consecutive
      // calls without any other wasi import in between.  On the 1000th
      // consecutive call, dump a stack to identify the wasm caller —
      // that's the code path keeping libuv from blocking.
      const probe = (globalThis as { __edgeClockProbe?: { streak: number; logged: boolean } });
      const p = probe.__edgeClockProbe ?? (probe.__edgeClockProbe = { streak: 0, logged: false });
      p.streak++;
      if (p.streak === 1000 && !p.logged) {
        p.logged = true;
        const stk = new Error("clock-spin-stack").stack ?? "(no stack)";
        ctx.postLog(`[clock-probe] 1000 consecutive clock_time_get calls — wasm caller stack:\n${stk}`, "warn");
      }
      const ns = BigInt(Math.round(captured.timeOrigin + captured.now())) * 1_000_000n;
      view(ctx.memory).setBigUint64(timePtr, ns, true);
      return ERRNO_SUCCESS;
    },

    random_get(bufPtr: number, bufLen: number) {
      // crypto.getRandomValues doesn't accept SAB-backed views.  Same fill-
      // then-copy dance as urandomFd.
      const dst = bytes(ctx.memory).subarray(bufPtr, bufPtr + bufLen);
      const tmp = new Uint8Array(Math.min(65536, bufLen));
      let off = 0;
      while (off < bufLen) {
        const chunk = Math.min(tmp.length, bufLen - off);
        const slice = chunk === tmp.length ? tmp : tmp.subarray(0, chunk);
        nativeGetRandomValues(slice);
        dst.set(slice, off);
        off += chunk;
      }
      return ERRNO_SUCCESS;
    },

    sched_yield() {
      return ERRNO_SUCCESS;
    },

    // poll_oneoff — Reads the subscription array, walks each one, and
    // writes any events that are immediately ready.  Sleeps if every sub
    // is blocked AND the earliest clock-deadline is non-zero.
    //
    // The body is split into two impls (sync + async-capable) sharing
    // helpers, so the chosen YieldStrategy can pick which to expose as
    // the wasm import.  The sync version is the original (Atomics.wait);
    // the async version yields via setTimeout for timer-only waits so
    // host microtasks drain naturally during the suspend.  See
    // `wasi-shim/yield-strategy.ts`.
    //
    // Subscription layout (Wasix manual.rs:54): { u64 userdata; u8 type;
    // [pad]; union { Clock(clock_id:u32, timeout:u64, prec:u64, flags:u16),
    // FdReadwrite(fd:u32) } }.  size = 48 bytes (8 ud + 8 padded type +
    // 24 union + 8 trailing pad).
    //
    // Event layout: { u64 userdata; u16 error; u8 type; [pad]; union
    // { clock:u8, fd_readwrite:{ nbytes:u64, flags:u16 } } }.  size = 32.
    //
    // #!~debt rough-poll: we only honor Clock (sleep) and FdRead/FdWrite
    // (always ready for non-socket fds; for socket fds, ready iff there
    // are pending requests / recv bytes).  No multi-event coalescing,
    // no proper precision, no absolute-vs-relative clock distinction —
    // we treat all clock timeouts as relative-nanoseconds and clamp.
    poll_oneoff(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number) {
      // Placeholder — overwritten below the wasi_snapshot_preview1 object
      // declaration with the strategy-wrapped variant.  Kept here so the
      // returned object literally has a `poll_oneoff` property at type
      // declaration time.
      return pollOneoffSyncImpl(inPtr, outPtr, nsubs, neventsPtr);
    },

    // sock_shutdown(fd, how) — `how` is a bitmask: 1=RD, 2=WR, 3=BOTH.
    // Edge's HTTP server calls shutdown(WR) to signal "response complete"
    // after the last fd_write.  We treat any shutdown (WR or BOTH) on a
    // connection socket as the trigger to parse the accumulated sendBuf
    // and ship the response back through the bridge responder, then
    // close the connection.
    sock_shutdown(fd: number, how: number) {
      const sock = sockets.get(fd);
      if (!sock) return ERRNO_BADF;
      // RD-only shutdown: nothing to do (we already drained the recvBuf).
      if (how === 1) return ERRNO_SUCCESS;
      // WR or BOTH: flush response and tear down.
      closeConnection(sock);
      sockets.delete(fd);
      return ERRNO_SUCCESS;
    },

    // sock_recv (preview1).  Same as fd_read for socket fds, but writes
    // the message-flags out-pointer.
    sock_recv(fd: number, iovsPtr: number, iovsLen: number, _riFlags: number, nreadPtr: number, roFlagsPtr: number) {
      const sock = sockets.get(fd);
      if (!sock) {
        view(ctx.memory).setUint32(nreadPtr, 0, true);
        return ERRNO_BADF;
      }
      const errno = readFromSocket(sock, iovsPtr, iovsLen, nreadPtr);
      if (roFlagsPtr) view(ctx.memory).setUint16(roFlagsPtr, 0, true);
      return errno;
    },
  };

  // ---- futex_wait sync + async-capable impls ----
  //
  // Both are valid implementations of `wasix_32v1.futex_wait(futexPtr,
  // expected, timeoutPtr) -> errno`.  The yield strategy picks one:
  //   - sync: Atomics.wait blocks the calling thread.  Fine in CHILD
  //     workers (dedicated to their wasm thread).  Acceptable but
  //     event-loop-blocking in main worker if hit there (rare in
  //     normal operation).
  //   - jspi: Atomics.waitAsync returns a Promise; wrapped via
  //     `WebAssembly.Suspending` by the JSPI strategy, the wasm
  //     suspends without blocking the worker's event loop.

  // WASIX futex_wait signature (api_wasix.h:4013):
  //   __wasi_errno_t __wasi_futex_wait(
  //       uint32_t* futex, uint32_t expected,
  //       const __wasi_option_timestamp_t* timeout,
  //       __wasi_bool_t* retptr0  // OUT: true=woke, false=timed-out
  //   );
  // Earlier 3-arg shape was wrong — wasi-libc reads garbage from retptr0
  // and may abort.

  // Parse a WASIX `__wasi_option_timestamp_t*` (16-byte tagged union).
  // Layout: u8 tag at offset 0 (0=None, 1=Some), u64 timestamp at
  // offset 8 (aligned).  Returns the timeout in MS, or `undefined`
  // for "wait forever" (null pointer or None variant).
  function parseOptionTimeoutMs(timeoutPtr: number): number | undefined {
    if (timeoutPtr === 0) return undefined;
    const dv = view(ctx.memory);
    const tag = dv.getUint8(timeoutPtr);
    if (tag === 0) return undefined; // None = wait forever
    const ns = dv.getBigUint64(timeoutPtr + 8, true);
    return Math.max(0, Number(ns / 1_000_000n));
  }

  function futexWaitSyncImpl(futexPtr: number, expected: number, timeoutPtr: number, retPtr: number): number {
    const i32View = new NativeInt32Array(ctx.memory.buffer, futexPtr & ~3, 1);
    const timeoutMs = parseOptionTimeoutMs(timeoutPtr);
    const result = timeoutMs === undefined
      ? NativeAtomics.wait(i32View, 0, expected)
      : NativeAtomics.wait(i32View, 0, expected, timeoutMs);
    if (retPtr !== 0) {
      view(ctx.memory).setUint8(retPtr, result === "ok" ? 1 : 0);
    }
    return 0;
  }

  // Returns either a synchronous i32 (no suspend) OR a Promise<i32>
  // (engine suspends wasm).  JSPI-Suspending wrap interprets the
  // return type: i32 → continue, Promise → suspend.
  //
  // JS-driven re-entry (depth==0): we MUST return sync.  No promising
  // frame on the call stack means JSPI rejects any Promise return
  // with "trying to suspend without WebAssembly.promising".  Fall
  // through to plain Atomics.wait — which DOES block the JS thread for
  // the duration of the wait (host microtasks can't drain).  See
  // NOTES.md `jspi-re-entry-blocks-microtasks`.  In practice, almost
  // all re-entry futex_wait calls are µs-scale mutex contention; the
  // one historical long-wait case (libuv pool init) is pre-warmed via
  // the constructor in deps/libuv-wasix/src/threadpool.c.  If a future
  // workload hits a long re-entry wait, the warning log below leaves
  // the offending call site as the last line in the trace — fix it
  // *there*, don't clamp the wait at this layer (clamping would lie to
  // the wasm about the wait completing, corrupting any mutex protected
  // state).
  let reentryWaitWarned = false;
  function futexWaitAsyncImpl(futexPtr: number, expected: number, timeoutPtr: number, retPtr: number): number | Promise<number> {
    const depthHolder = globalThis as { __edgePromisingDepth?: number };
    if ((depthHolder.__edgePromisingDepth ?? 0) <= 0) {
      const requested = parseOptionTimeoutMs(timeoutPtr);
      if ((requested === undefined || requested > 100) && !reentryWaitWarned) {
        reentryWaitWarned = true; // once per shim — keep the log readable
        ctx.postLog(`[wasi] futex_wait in JSPI re-entry, sync-blocking JS thread (timeout=${requested ?? "forever"}ms). If the worker hangs, this is the last line before it — fix the call site that drove this re-entry into a Suspending import.`, "warn");
      }
      return futexWaitSyncImpl(futexPtr, expected, timeoutPtr, retPtr);
    }
    const i32View = new NativeInt32Array(ctx.memory.buffer, futexPtr & ~3, 1);
    const waitAsync = (NativeAtomics as unknown as {
      waitAsync?: (i32: Int32Array, idx: number, val: number, timeout?: number) =>
        { async: boolean; value: Promise<string> | string };
    }).waitAsync;
    if (!waitAsync) {
      return futexWaitSyncImpl(futexPtr, expected, timeoutPtr, retPtr);
    }
    const timeoutMs = parseOptionTimeoutMs(timeoutPtr);
    const r = timeoutMs === undefined
      ? waitAsync(i32View, 0, expected)
      : waitAsync(i32View, 0, expected, timeoutMs);
    if (!r.async) {
      // waitAsync resolved sync ("not-equal" — value didn't match
      // expected at call time).  Return sync.
      const woke = r.value === "ok";
      if (retPtr !== 0) view(ctx.memory).setUint8(retPtr, woke ? 1 : 0);
      return 0;
    }
    // Async path: return Promise that the engine suspends on.
    return (async () => {
      const settled = await r.value;
      if (retPtr !== 0) view(ctx.memory).setUint8(retPtr, settled === "ok" ? 1 : 0);
      return 0;
    })();
  }

  // ---- wasix_32v1 ----
  const wasix_32v1: Record<string, Function> = {
    proc_exit2(code: number) {
      flushBuf(stdoutBuf, "out");
      flushBuf(stderrBuf, "warn");
      ctx.postExit(code >>> 0);
      throw new ExitSignal(code >>> 0);
    },
    // WASIX getcwd contract (matches wasmer-wasix syscalls/wasix/getcwd.rs):
    //   - bufSizePtr is *in/out*: caller writes max buffer size; we overwrite
    //     with actual cwd length (always, even if not copying).
    //   - If bufPtr is null OR max is 0 → return INVAL after writing length.
    //   - If actual > max → return RANGE.
    //   - Else write a buffer of size max (zero-padded) with cwd bytes at the
    //     start.  The zero-padding is load-bearing: wasi-libc/libuv read the
    //     buffer expecting a null-terminated string, and an earlier version
    //     that wrote only the cwd bytes (without zeroing the rest) tripped
    //     uv_cwd into EIO when the residual buffer bytes weren't already \0.
    getcwd(bufPtr: number, bufSizePtr: number) {
      const dv = view(ctx.memory);
      const mem = bytes(ctx.memory);
      // FIXED_CWD_BYTES is computed at module load using the native
      // TextEncoder.  We cannot call `new TextEncoder()` here — edge's
      // bootstrap replaces `globalThis.TextEncoder` with a polyfill that
      // encodes "/" to [0] instead of [0x2f].  See NOTES.md 2026-05-20
      // attempt#6 entry.
      const enc = FIXED_CWD_BYTES;
      const maxLen = dv.getUint32(bufSizePtr, true);
      dv.setUint32(bufSizePtr, enc.length, true);
      if (bufPtr === 0 || maxLen === 0) return 28; // INVAL
      if (enc.length > maxLen) return 68;          // RANGE
      // Zero the full caller-provided buffer, then write cwd at the start.
      mem.fill(0, bufPtr, bufPtr + maxLen);
      mem.set(enc, bufPtr);
      return ERRNO_SUCCESS;
    },
    // chdir — wasi-libc owns `__wasilibc_cwd`.  Our job is to ACK the
    // call so libc's wrapper doesn't synthesize an error; libc updates
    // its own internal cwd via the surrounding wrapper code (which
    // doesn't go through this syscall).  See NOTES.md 2026-05-20 for
    // the long-form reasoning.  Returning SUCCESS with no side effect
    // matches what wasmer-wasix does on the native baseline.
    chdir(_pathPtr: number, _pathLen: number) {
      return ERRNO_SUCCESS;
    },
    thread_parallelism(outPtr: number) {
      view(ctx.memory).setUint32(outPtr, navigator.hardwareConcurrency ?? 4, true);
      return ERRNO_SUCCESS;
    },
    // #!~debt uv_cwd EIO: see NOTES.md 2026-05-20 — 3 attempts exhausted.
    // proc_id was the first lead (errno=1 in trace); fixing it was correct
    // but did not unblock the bigger EIO.  Parked for now.
    //
    // WASIX proc_id writes the pid to an outPtr and returns errno.  An earlier
    // version returned 1 with no args — the wasm read 1 as errno=EPERM and the
    // resulting libc state cascaded into uv_cwd's EIO surface.
    proc_id(outPtr: number) {
      view(ctx.memory).setUint32(outPtr, 1, true);
      return ERRNO_SUCCESS;
    },
    proc_parent(outPtr: number) {
      view(ctx.memory).setUint32(outPtr, 0, true);
      return ERRNO_SUCCESS;
    },

    // Signal table query — we expose an empty set.
    proc_signals_sizes_get(countPtr: number) {
      view(ctx.memory).setUint32(countPtr, 0, true);
      return ERRNO_SUCCESS;
    },
    proc_signals_get(_bufPtr: number) {
      return ERRNO_SUCCESS;
    },

    // File descriptor flag get/set.  We don't track flags meaningfully yet;
    // accept the set and report zero on get so non-blocking probes succeed.
    fd_fdflags_get(fd: number, flagsOutPtr: number) {
      if (!isKnownFd(fd)) return ERRNO_BADF;
      view(ctx.memory).setUint16(flagsOutPtr, 0, true);
      return ERRNO_SUCCESS;
    },
    fd_fdflags_set(fd: number, _flags: number) {
      if (!isKnownFd(fd)) return ERRNO_BADF;
      return ERRNO_SUCCESS;
    },

    // fd_pipe — allocate a cross-thread pipe pair.  Implementation lives
    // in `wasi-shim/pipes-sab.ts`: ring-buffer over a SharedArrayBuffer
    // region that every worker's wasi-shim attaches to.  Required so
    // libuv's `uv_async_send` (pool → main wakeup, a pipe write
    // internally) actually reaches the reader.
    //
    // The fd numbers we hand out encode the slot index directly, so any
    // worker that loads the fd from shared wasm memory can route reads
    // and writes without a side table — see `isPipeFd` / `pipeFdSlot`.
    fd_pipe(fdReadOutPtr: number, fdWriteOutPtr: number) {
      if (!ctx.pipeRegistry) {
        ctx.postLog("fd_pipe called with no pipeRegistry — falling back to per-worker local pipe", "warn");
        const buffer: number[] = [];
        const readFd = NEXT_VFD++;
        const writeFd = NEXT_VFD++;
        vfds.set(readFd, {
          read(buf) {
            const take = Math.min(buf.length, buffer.length);
            for (let i = 0; i < take; i++) buf[i] = buffer.shift()!;
            return take;
          },
        });
        vfds.set(writeFd, {
          read() { return 0; },
          write(data) {
            for (let i = 0; i < data.length; i++) buffer.push(data[i]!);
            return data.length;
          },
        });
        const dv = view(ctx.memory);
        dv.setUint32(fdReadOutPtr, readFd, true);
        dv.setUint32(fdWriteOutPtr, writeFd, true);
        return ERRNO_SUCCESS;
      }
      const alloc = ctx.pipeRegistry.allocate();
      if (!alloc) {
        ctx.postLog("fd_pipe: registry full (>64 in-flight pipes)", "warn");
        return ERRNO_NOMEM;
      }
      const dv = view(ctx.memory);
      dv.setUint32(fdReadOutPtr, alloc.readFd, true);
      dv.setUint32(fdWriteOutPtr, alloc.writeFd, true);
      return ERRNO_SUCCESS;
    },

    // path_open2 — WASIX's extended path_open.  Same semantics as
    // wasi_snapshot_preview1.path_open for our purposes, with one extra
    // `fd_flags_ext` parameter ignored.
    path_open2(
      _dirfd: number,
      _dirflags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      rightsBase: bigint,
      _rightsInheriting: bigint,
      _fdflags: number,
      _fdflagsExt: number,
      openedFdPtr: number,
    ) {
      const path = readPath(ctx.memory, pathPtr, pathLen);
      const normalized = path.startsWith("/") ? path : "/" + path;
      if (isVirtualUrandom(normalized)) {
        return openVirtualUrandom(path, openedFdPtr, "path_open2");
      }
      return openViaFs(normalized, openedFdPtr, "path_open2",
        oflagsToOpenOptions(oflags, rightsBase));
    },

    // Signal handler install / delivery.  In a browser worker there's no
    // OS signal infrastructure, so we ACK these calls without registering
    // anything and never actually deliver.  edge.js needs these to succeed
    // so it doesn't panic during early bootstrap.  When we eventually want
    // real abort behavior we'll wire SIGABRT-from-self specifically.
    callback_signal(_callbackPtr: number, _signo: number) {
      return ERRNO_SUCCESS;
    },
    thread_signal(_tid: number, _signo: number) {
      return ERRNO_SUCCESS;
    },
    proc_signal(_pid: number, _signo: number) {
      return ERRNO_SUCCESS;
    },

    // ---- futex (atomic wait/wake on shared memory) ----
    //
    // wasi-libc and the C++ ABI's __cxa_guard_acquire use futex_wait/wake
    // for thread synchronization (mutex contention, static init guards,
    // pthread_cond_wait, etc.).  WASIX signature:
    //
    //   futex_wait(futexPtr: *u32, expected: u32, timeoutPtr: *u64) -> errno
    //   futex_wake(futexPtr: *u32, count: u32) -> errno  (count=1 => wake one)
    //   futex_wake_all(futexPtr: *u32) -> errno
    //
    // futex_wait is a placeholder here — overwritten below the
    // wasix_32v1 declaration via `strategy.wrapFutexWait(syncImpl, asyncImpl)`.
    // Under JSPI the strategy returns a `WebAssembly.Suspending` wrap so
    // the wasm actually suspends instead of blocking the JS thread.
    futex_wait(inPtr: number, expected: number, timeoutPtr: number, retPtr: number) {
      return futexWaitSyncImpl(inPtr, expected, timeoutPtr, retPtr);
    },
    // WASIX futex_wake signature:
    //   __wasi_errno_t __wasi_futex_wake(uint32_t* futex, __wasi_bool_t* retptr0);
    //   retptr0: true if a thread was actually woken.
    futex_wake(futexPtr: number, retPtr: number) {
      const i32View = new NativeInt32Array(ctx.memory.buffer, futexPtr & ~3, 1);
      const woken = NativeAtomics.notify(i32View, 0, 1);
      if (retPtr !== 0) view(ctx.memory).setUint8(retPtr, woken > 0 ? 1 : 0);
      return ERRNO_SUCCESS;
    },
    // WASIX futex_wake_all signature: same as wake but wakes ALL waiters.
    futex_wake_all(futexPtr: number) {
      const i32View = new NativeInt32Array(ctx.memory.buffer, futexPtr & ~3, 1);
      NativeAtomics.notify(i32View, 0, Infinity);
      return ERRNO_SUCCESS;
    },
    // wasi-libc threads exit via this when wasi_thread_start's user
    // function returns.  Throwing the string "unwind" is emnapi's
    // documented sentinel: ThreadMessageHandler._start catches that
    // specific value as a clean unwind and proceeds to send the
    // cleanup-thread message back to the manager.  Other thrown values
    // re-propagate as fatal.
    thread_exit(_rval: number) {
      throw "unwind";
    },

    // ---- socket layer (TCP IPv4 loopback) ----

    // sock_open(af, ty, pt, ro_sock_ptr) — allocate a fresh socket fd.
    sock_open(_af: number, _ty: number, _pt: number, roSockPtr: number) {
      const fd = nextSockFd();
      sockets.set(fd, {
        fd,
        state: SOCK_STATE_FRESH,
        nonblock: false,
        pendingReqs: [],
        recvBuf: new NativeUint8Array(0),
        recvOff: 0,
        sendBuf: [],
        boundPort: 0,
        reqId: 0,
      });
      view(ctx.memory).setUint32(roSockPtr, fd, true);
      return ERRNO_SUCCESS;
    },

    sock_bind(sock: number, addrPtr: number) {
      const s = sockets.get(sock);
      if (!s) return ERRNO_BADF;
      const parsed = parseAddrPort(addrPtr);
      s.boundPort = parsed?.port ?? 0;
      s.state = SOCK_STATE_BOUND;
      return ERRNO_SUCCESS;
    },

    sock_listen(sock: number, _backlog: number) {
      const s = sockets.get(sock);
      if (!s) return ERRNO_BADF;
      s.state = SOCK_STATE_LISTEN;
      // Single-listener policy.  #!~debt single-listener (NOTES.md).
      listenFd = sock;
      return ERRNO_SUCCESS;
    },

    // sock_accept_v2(sock, fd_flags, ro_fd_ptr, ro_addr_ptr) — accept a
    // pending request, allocate a connection fd, stage the raw HTTP/1.1
    // bytes onto its recv buffer, return.  Blocks via Atomics.wait if
    // queue empty and fdflags lacks NONBLOCK.
    sock_accept_v2(sock: number, fdFlags: number, roFdPtr: number, roAddrPtr: number) {
      const listener = sockets.get(sock);
      if (!listener || listener.state !== SOCK_STATE_LISTEN) return ERRNO_BADF;
      const nonblock = (fdFlags & 0x0004) !== 0; // Fdflags::NONBLOCK = 1<<2

      while (listener.pendingReqs.length === 0) {
        if (nonblock) return ERRNO_AGAIN;
        // The worker's JS event loop is blocked while we're inside this
        // sync wasm call, so MessagePort messages won't be delivered.
        // The Service Worker writes incoming requests into a SAB-backed
        // inbox AND calls Atomics.notify on our `wake` view.  We then
        // wake from Atomics.wait, call wakePoll to drain the SAB into
        // listener.pendingReqs, and re-check.
        const idx = WAKE_ACCEPT_IDX;
        const seen = NativeAtomics.load(wake, idx);
        NativeAtomics.wait(wake, idx, seen);
        if (wakePoll) wakePoll();
      }
      const req = listener.pendingReqs.shift()!;
      const connFd = nextSockFd();
      const raw = formatHttpRequest(req);
      sockets.set(connFd, {
        fd: connFd,
        state: SOCK_STATE_CONNECTED,
        nonblock: false,
        pendingReqs: [],
        recvBuf: raw,
        recvOff: 0,
        sendBuf: [],
        boundPort: listener.boundPort,
        reqId: req.reqId,
      });
      view(ctx.memory).setUint32(roFdPtr, connFd, true);
      writePeerAddr(roAddrPtr);
      return ERRNO_SUCCESS;
    },

    sock_connect(_sock: number, _addrPtr: number) {
      // Outbound connections not supported in this chunk.
      // #!~debt no-outbound: any fs/http client inside edge will fail.
      return ERRNO_NOSYS;
    },

    sock_pair(_af: number, _ty: number, _pt: number, _ro1: number, _ro2: number) {
      // Socketpair not exercised by HTTP server bootstrap.
      // #!~debt no-socketpair: child_process etc. relies on this.
      return ERRNO_NOSYS;
    },

    sock_addr_local(sock: number, roAddrPtr: number) {
      const s = sockets.get(sock);
      if (!s) return ERRNO_BADF;
      // Write 127.0.0.1:port as the local addr.
      // #!~debt fake-local-addr: doesn't reflect what edge bound to (we
      // don't store the IP, only the port via parseAddrPort).
      const mem = bytes(ctx.memory);
      mem[roAddrPtr] = 1; // Inet4
      mem[roAddrPtr + 1] = 0;
      mem[roAddrPtr + 2] = s.boundPort & 0xff;
      mem[roAddrPtr + 3] = (s.boundPort >> 8) & 0xff;
      mem[roAddrPtr + 4] = 127;
      mem[roAddrPtr + 5] = 0;
      mem[roAddrPtr + 6] = 0;
      mem[roAddrPtr + 7] = 1;
      for (let i = 8; i < 20; i++) mem[roAddrPtr + i] = 0;
      return ERRNO_SUCCESS;
    },

    sock_addr_peer(sock: number, roAddrPtr: number) {
      const s = sockets.get(sock);
      if (!s) return ERRNO_BADF;
      writePeerAddr(roAddrPtr);
      return ERRNO_SUCCESS;
    },

    sock_recv_from(
      sock: number,
      iovsPtr: number,
      iovsLen: number,
      _riFlags: number,
      roDataLenPtr: number,
      roFlagsPtr: number,
      roAddrPtr: number,
    ) {
      const s = sockets.get(sock);
      if (!s) {
        view(ctx.memory).setUint32(roDataLenPtr, 0, true);
        return ERRNO_BADF;
      }
      const errno = readFromSocket(s, iovsPtr, iovsLen, roDataLenPtr);
      if (roFlagsPtr) view(ctx.memory).setUint16(roFlagsPtr, 0, true);
      if (roAddrPtr) writePeerAddr(roAddrPtr);
      return errno;
    },

    sock_send_to(
      sock: number,
      iovsPtr: number,
      iovsLen: number,
      _siFlags: number,
      _addrPtr: number,
      retDataLenPtr: number,
    ) {
      const s = sockets.get(sock);
      if (!s || s.state !== SOCK_STATE_CONNECTED) {
        view(ctx.memory).setUint32(retDataLenPtr, 0, true);
        return ERRNO_BADF;
      }
      const total = writeIovsToSocket(s, iovsPtr, iovsLen);
      view(ctx.memory).setUint32(retDataLenPtr, total, true);
      return ERRNO_SUCCESS;
    },

    sock_send_file(_sock: number, _inFd: number, _offset: bigint, _count: bigint, _retPtr: number) {
      // #!~debt no-sendfile: zero-copy file→socket not implemented.
      return ERRNO_NOSYS;
    },

    sock_get_opt_flag(_sock: number, _opt: number, outPtr: number) {
      view(ctx.memory).setUint8(outPtr, 0);
      return ERRNO_SUCCESS;
    },
    sock_get_opt_size(_sock: number, _opt: number, outPtr: number) {
      view(ctx.memory).setBigUint64(outPtr, 0n, true);
      return ERRNO_SUCCESS;
    },
    sock_get_opt_time(_sock: number, _opt: number, outPtr: number) {
      // option_timestamp { tag:u8, value:u64 }; write tag=0 (None).
      view(ctx.memory).setUint8(outPtr, 0);
      return ERRNO_SUCCESS;
    },
    sock_set_opt_flag(_sock: number, _opt: number, _flag: number) { return ERRNO_SUCCESS; },
    sock_set_opt_size(_sock: number, _opt: number, _size: bigint) { return ERRNO_SUCCESS; },
    sock_set_opt_time(_sock: number, _opt: number, _timePtr: number) { return ERRNO_SUCCESS; },
  };

  // ---- wasi.thread-spawn (orphan namespace) ----
  const wasi: Record<string, Function> = {
    "thread-spawn"(_startArgPtr: number) {
      return -1;
    },
  };

  // Apply the chosen yield strategy.  Default = sync (Atomics.wait,
  // microtasks drain only at end-of-_start).  The harness picks
  // jspiYieldStrategy at startup if WebAssembly.Suspending is available.
  const strategy = ctx.yieldStrategy ?? syncYieldStrategy;
  wasi_snapshot_preview1.poll_oneoff = strategy.wrapPollOneoff(
    pollOneoffSyncImpl,
    pollOneoffAsyncImpl,
  );
  wasix_32v1.futex_wait = strategy.wrapFutexWait(
    futexWaitSyncImpl,
    futexWaitAsyncImpl,
  );

  // E9: exposed to napi-host so `unofficial_napi_terminate_execution`
  // can wake a parked poll_oneoff before its timer expires.
  function requestExit(code: number) {
    exitState.requested = true;
    exitState.code = code >>> 0;
    // Force the value-check in Atomics.waitAsync(sleepI32, 0, 0, ms) to
    // differ from the expected value (0).  This causes the wait to
    // resolve immediately ("ok").  We restore to 0 immediately after so
    // subsequent waits on this slot still match expected=0.
    try {
      NativeAtomics.store(sleepI32, 0, 1);
      NativeAtomics.notify(sleepI32, 0);
      NativeAtomics.store(sleepI32, 0, 0);
    } catch { /* SAB may not be writable in odd test envs; skip */ }
    // Also wake any socket-accept / pipe-read parked waits, in case
    // poll_oneoff is on the socket path rather than timer-only.
    try {
      NativeAtomics.add(wake, WAKE_ACCEPT_IDX, 1);
      NativeAtomics.notify(wake, WAKE_ACCEPT_IDX);
    } catch { /* */ }
  }

  return { wasi_snapshot_preview1, wasix_32v1, wasi, bus, requestExit };
}

export class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`ExitSignal(code=${code})`);
    this.name = "ExitSignal";
  }
  override toString() { return `ExitSignal(code=${this.code})`; }
}
