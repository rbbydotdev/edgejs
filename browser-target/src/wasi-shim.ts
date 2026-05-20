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

import {
  type FileStat,
  type FileSystem,
  type FsHandle,
  FsErrno,
  FileType,
} from "./host/fs/types";

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;

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
    const vfd = vfds.get(fd);
    if (vfd) {
      // Route to the vfd's writer if it has one; else accept and discard.
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
    return (fd >= 0 && fd <= 2) || PREOPEN_FDS.has(fd) || vfds.has(fd);
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

  function openViaFs(normalized: string, openedFdPtr: number, syscall: string): number {
    const res = ctx.fs.open(normalized);
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
    ctx.postLog(`[wasi] ${syscall} ${normalized} → fd ${newFd} (fs)`, "info");
    return ERRNO_SUCCESS;
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
      _oflags: number,
      _rightsBase: bigint,
      _rightsInheriting: bigint,
      _fdflags: number,
      openedFdPtr: number,
    ) {
      const path = readPath(ctx.memory, pathPtr, pathLen);
      const normalized = path.startsWith("/") ? path : "/" + path;
      if (isVirtualUrandom(normalized)) {
        return openVirtualUrandom(path, openedFdPtr, "path_open");
      }
      return openViaFs(normalized, openedFdPtr, "path_open");
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
      // Filetype: stdio + virtual fds → CHARACTER_DEVICE
      dv.setUint8(statPtr + 0, FILETYPE_CHARACTER_DEVICE);
      // Flags: 0 (default)
      dv.setUint16(statPtr + 2, 0, true);
      // Rights: grant everything so caller doesn't reject the fd
      dv.setBigUint64(statPtr + 8, ~0n, true);
      dv.setBigUint64(statPtr + 16, ~0n, true);
      // Mark known fds as character devices; unknown still gets the default
      // character-device classification (good enough for libuv's checks).
      void fd;
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

    // #!~debt no-wait: returns "0 events ready" immediately regardless of
    // subscriptions.  Sufficient for one-shot scripts where libuv drains
    // and exits.  Blocks: setTimeout fires immediately, async I/O never
    // signals readiness, anything depending on FD events spins.  Real impl
    // needs SAB+Atomics.wait or proper Worker scheduling.
    poll_oneoff(_inPtr: number, _outPtr: number, _nsubs: number, neventsPtr: number) {
      view(ctx.memory).setUint32(neventsPtr, 0, true);
      return ERRNO_SUCCESS;
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

    // fd_pipe — allocate a pipe pair.  Returns two virtual fds.
    // #!~debt incomplete: read/write ends aren't actually connected.  The
    // read side has a buffer that NOTHING writes into (the write side
    // doesn't have a `write` impl that pushes to it).  Writes are accepted
    // and discarded by writeBytesToFd's default branch.  Real IPC will need
    // shared ring buffers, with reader blocking on Atomics.wait.
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
      _oflags: number,
      _rightsBase: bigint,
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
      return openViaFs(normalized, openedFdPtr, "path_open2");
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
  };

  // ---- wasi.thread-spawn (orphan namespace) ----
  const wasi: Record<string, Function> = {
    "thread-spawn"(_startArgPtr: number) {
      return -1;
    },
  };

  return { wasi_snapshot_preview1, wasix_32v1, wasi };
}

export class ExitSignal {
  constructor(public readonly code: number) {}
  toString() { return `ExitSignal(code=${this.code})`; }
}
