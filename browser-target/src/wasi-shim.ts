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

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
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
} {
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
    return (fd >= 0 && fd <= 2) || PREOPEN_FDS.has(fd) || vfds.has(fd) || sockets.has(fd);
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
          crypto.getRandomValues(slice);
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

  // ---- wasi_snapshot_preview1 ----
  const wasi_snapshot_preview1: Record<string, Function> = {
    proc_exit(code: number) {
      flushBuf(stdoutBuf, "out");
      flushBuf(stderrBuf, "warn");
      ctx.postExit(code >>> 0);
      throw new ExitSignal(code >>> 0);
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
        crypto.getRandomValues(slice);
        dst.set(slice, off);
        off += chunk;
      }
      return ERRNO_SUCCESS;
    },

    sched_yield() {
      return ERRNO_SUCCESS;
    },

    // poll_oneoff — Reads the subscription array, walks each one, and
    // writes any events that are immediately ready.  Sleeps (via
    // Atomics.wait on the accept slot) if every sub is blocked AND the
    // earliest clock-deadline is non-zero.
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
      const dv = view(ctx.memory);
      const SUB_SIZE = 48;
      const EVT_SIZE = 32;
      let nWritten = 0;
      let minTimeoutNs = -1; // -1 = no clock sub seen
      for (let i = 0; i < nsubs; i++) {
        const base = inPtr + i * SUB_SIZE;
        const userdata = dv.getBigUint64(base + 0, true);
        const ty = dv.getUint8(base + 8);
        let ready = false;
        let nbytes = 0n;
        let evtType = ty;
        let errno = 0;
        if (ty === 0) {
          // Clock: union at base+16: clock_id(u32) timeout(u64) prec(u64) flags(u16)
          const timeoutNs = dv.getBigUint64(base + 24, true);
          // Track min for the post-loop sleep.
          const asNum = Number(timeoutNs);
          if (minTimeoutNs < 0 || asNum < minTimeoutNs) minTimeoutNs = asNum;
        } else if (ty === 1 || ty === 2) {
          // FdRead / FdWrite: union at base+16: file_descriptor (u32)
          const fd = dv.getUint32(base + 16, true);
          const sock = sockets.get(fd);
          if (sock) {
            if (ty === 1) {
              // Read-ready: a listener with queued requests OR a connection
              // with unread bytes.
              if (sock.state === SOCK_STATE_LISTEN) {
                ready = sock.pendingReqs.length > 0;
                nbytes = ready ? 1n : 0n;
              } else if (sock.state === SOCK_STATE_CONNECTED) {
                const avail = sock.recvBuf.length - sock.recvOff;
                ready = avail > 0;
                nbytes = BigInt(avail);
              }
            } else {
              // Write-ready: always ready for connection sockets.
              ready = sock.state === SOCK_STATE_CONNECTED;
              nbytes = ready ? 65536n : 0n;
            }
          } else {
            const vfd = vfds.get(fd);
            if (vfd?.fsHandle !== undefined) {
              // Regular file — always ready for read.
              ready = true;
              nbytes = 0n;
            } else if (vfd) {
              // Pipe / virtual fd: not ready (no producer in this run).
              // Reporting "ready" here turns into a spin loop because the
              // subsequent fd_read returns 0 bytes and libuv re-polls.
              ready = false;
            } else if (fd <= 2 || PREOPEN_FDS.has(fd)) {
              // stdio / preopens: report ready.
              ready = true;
              nbytes = 0n;
            } else {
              errno = ERRNO_BADF;
              ready = true;
            }
          }
        }
        if (ready) {
          const eb = outPtr + nWritten * EVT_SIZE;
          dv.setBigUint64(eb + 0, userdata, true);
          dv.setUint16(eb + 8, errno, true);
          dv.setUint8(eb + 10, evtType);
          // pad through 16
          for (let p = 11; p < 16; p++) dv.setUint8(eb + p, 0);
          // event_fd_readwrite { nbytes: u64; flags: u16 }
          dv.setBigUint64(eb + 16, nbytes, true);
          dv.setUint16(eb + 24, 0, true);
          for (let p = 26; p < EVT_SIZE; p++) dv.setUint8(eb + p, 0);
          nWritten++;
        }
      }
      // Check if any sub is on a socket fd — if so we should block until
      // a request arrives (Atomics.wait on the wake slot), not return 0
      // and spin.
      let hasSocketSub = false;
      for (let i = 0; i < nsubs && !hasSocketSub; i++) {
        const base = inPtr + i * SUB_SIZE;
        const ty = dv.getUint8(base + 8);
        if (ty === 1 || ty === 2) {
          const fd = dv.getUint32(base + 16, true);
          if (sockets.has(fd)) hasSocketSub = true;
        }
      }
      if (nWritten === 0 && (minTimeoutNs >= 0 || hasSocketSub)) {
        // Block until either the timeout expires or a request lands.
        // If no clock sub provided, fall back to a 30s poll window
        // (matches wasmer-wasix accept-timeout default).
        const idx = WAKE_ACCEPT_IDX;
        const seen = NativeAtomics.load(wake, idx);
        const ms = minTimeoutNs >= 0
          ? Math.max(0, Math.min(60_000, Math.ceil(minTimeoutNs / 1_000_000)))
          : 30_000;
        NativeAtomics.wait(wake, idx, seen, ms);
        if (wakePoll) wakePoll();
        // If wakePoll dropped a request onto a listening socket, surface
        // a corresponding fd-ready event for any matching subscription.
        for (let i = 0; i < nsubs; i++) {
          const base = inPtr + i * SUB_SIZE;
          const userdata = dv.getBigUint64(base + 0, true);
          const ty = dv.getUint8(base + 8);
          if (ty !== 1) continue; // FdRead only
          const fd = dv.getUint32(base + 16, true);
          const s = sockets.get(fd);
          if (s && s.state === SOCK_STATE_LISTEN && s.pendingReqs.length > 0) {
            const eb = outPtr + nWritten * EVT_SIZE;
            dv.setBigUint64(eb + 0, userdata, true);
            dv.setUint16(eb + 8, 0, true);
            dv.setUint8(eb + 10, ty);
            for (let p = 11; p < 16; p++) dv.setUint8(eb + p, 0);
            dv.setBigUint64(eb + 16, 1n, true);
            dv.setUint16(eb + 24, 0, true);
            for (let p = 26; p < EVT_SIZE; p++) dv.setUint8(eb + p, 0);
            nWritten++;
          }
        }
        // After waking, surface any clock subscriptions as fired.  Same
        // walk but emit Clock events.
        for (let i = 0; i < nsubs; i++) {
          const base = inPtr + i * SUB_SIZE;
          const userdata = dv.getBigUint64(base + 0, true);
          const ty = dv.getUint8(base + 8);
          if (ty !== 0) continue;
          const eb = outPtr + nWritten * EVT_SIZE;
          dv.setBigUint64(eb + 0, userdata, true);
          dv.setUint16(eb + 8, 0, true);
          dv.setUint8(eb + 10, 0);
          for (let p = 11; p < EVT_SIZE; p++) dv.setUint8(eb + p, 0);
          nWritten++;
          break; // emit one clock; the rest fold in next call
        }
      }
      dv.setUint32(neventsPtr, nWritten, true);
      return ERRNO_SUCCESS;
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

    // fd_pipe — allocate a pipe pair.  Read end pulls bytes the write
    // end pushed.  No SAB/blocking — synchronous semantics are sufficient
    // because pipes are used during bootstrap as a sync-fd contract that
    // mostly carries small metadata.
    //
    // #!~debt no-blocking-pipe: a reader that reads-before-write returns
    // 0 (EOF-ish).  Real impl would block on Atomics.wait like the socket
    // recv path.  Fine for bootstrap probes; userland child_process I/O
    // would need the upgrade.
    fd_pipe(fdReadOutPtr: number, fdWriteOutPtr: number) {
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

  return { wasi_snapshot_preview1, wasix_32v1, wasi, bus };
}

export class ExitSignal {
  constructor(public readonly code: number) {}
  toString() { return `ExitSignal(code=${this.code})`; }
}
