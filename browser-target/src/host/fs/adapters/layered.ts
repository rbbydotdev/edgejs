// Layered FileSystem combinator — compose multiple adapters into one.
//
// ROLE: ordered fan-out for reads, single-writer for writes.  The
// canonical use case is:
//
//   layered(bundled, opfs)
//
//   = "reads check bundled first (covers /node-lib/** + /node/deps/**);
//      everything bundled doesn't claim falls through to opfs; writes
//      always go straight to opfs (the first writable layer)".
//
// READ PATH:
//
//   For path-based ops (open in read mode, stat), we try each adapter
//   in order until one returns ok or returns an errno other than NOENT.
//   NOENT means "this adapter doesn't have this path"; any other errno
//   (ACCES / IO / etc.) is a real failure we surface immediately.
//
// WRITE PATH:
//
//   open(write:true) is forwarded to the FIRST adapter in the list that
//   accepts it (i.e. returns ok OR returns an errno OTHER than ROFS).
//   Read-only adapters return ROFS, so they cleanly fall through.  This
//   means `layered(bundled, opfs).open('/tmp/x', {write:true})` lands
//   on opfs because bundled refuses with ROFS.
//
// HANDLE OWNERSHIP:
//
//   open() returns a wrapped handle that encodes which underlying
//   adapter owns the real handle.  Each subsequent operation
//   (read/write/close/etc.) is dispatched to the same adapter.  This
//   keeps adapters' fd namespaces independent.
//
//   We pack (adapterIndex, innerHandle) into a single number using
//   high bits for the index and low bits for the handle.  Adapter
//   handles are well under 2^24 in practice; 8 bits of index room
//   covers any layering we'd build.

import {
  type DirEntry,
  type FileStat,
  type FileSystem,
  type FsHandle,
  type FsResult,
  type OpenOptions,
  FsErrno,
  err,
  ok,
} from "../types";

/** Packing: high 8 bits = adapter index, low 24 bits = adapter-local handle. */
const INDEX_SHIFT = 24;
const HANDLE_MASK = (1 << INDEX_SHIFT) - 1;

function pack(index: number, inner: FsHandle): FsHandle {
  return ((index & 0xff) << INDEX_SHIFT) | (inner & HANDLE_MASK);
}

function unpack(handle: FsHandle): { index: number; inner: FsHandle } {
  return {
    index: (handle >>> INDEX_SHIFT) & 0xff,
    inner: handle & HANDLE_MASK,
  };
}

/**
 * Compose adapters.  Order matters: reads try each adapter in turn;
 * writes land on the first adapter that doesn't return ROFS.
 *
 * Pass adapters most-specific-first.  Typical: `layered(bundled, opfs)`.
 */
export function layered(...adapters: FileSystem[]): FileSystem {
  if (adapters.length === 0) {
    throw new Error("layered() requires at least one adapter");
  }
  if (adapters.length > 256) {
    throw new Error("layered() supports at most 256 adapters");
  }

  /**
   * Try `op` on each adapter in turn.  Returns the first success.  Returns
   * the first non-NOENT failure.  Returns NOENT (from the last adapter) if
   * every adapter said NOENT.
   */
  function tryEach<T>(op: (a: FileSystem, idx: number) => FsResult<T>): FsResult<T> & { idx?: number } {
    let lastErr: FsResult<T> & { idx?: number } = { ok: false, errno: FsErrno.NOENT };
    for (let i = 0; i < adapters.length; i++) {
      const r = op(adapters[i]!, i);
      if (r.ok) return Object.assign(r, { idx: i });
      lastErr = Object.assign(r, { idx: i });
      if (r.errno !== FsErrno.NOENT) return lastErr;
    }
    return lastErr;
  }

  return {
    open(path: string, options: OpenOptions = {}): FsResult<FsHandle> {
      const wantWrite = options.write === true;

      if (wantWrite) {
        // Writes: skip read-only adapters (ROFS) and use the first
        // that accepts.  NOENT is also a skip — that adapter doesn't
        // have a parent dir or refuses the path; let later ones try.
        for (let i = 0; i < adapters.length; i++) {
          const r = adapters[i]!.open(path, options);
          if (r.ok) return ok(pack(i, r.value));
          if (r.errno !== FsErrno.ROFS && r.errno !== FsErrno.NOENT) return r;
        }
        return err(FsErrno.ROFS);
      }

      // Reads: try each adapter in order; first non-NOENT wins.
      for (let i = 0; i < adapters.length; i++) {
        const r = adapters[i]!.open(path, options);
        if (r.ok) return ok(pack(i, r.value));
        if (r.errno !== FsErrno.NOENT) return r;
      }
      return err(FsErrno.NOENT);
    },

    close(handle: FsHandle): FsResult<void> {
      const { index, inner } = unpack(handle);
      const a = adapters[index];
      if (!a) return err(FsErrno.BADF);
      return a.close(inner);
    },

    read(handle: FsHandle, dst: Uint8Array): FsResult<number> {
      const { index, inner } = unpack(handle);
      const a = adapters[index];
      if (!a) return err(FsErrno.BADF);
      return a.read(inner, dst);
    },

    pread(handle: FsHandle, dst: Uint8Array, offset: number): FsResult<number> {
      const { index, inner } = unpack(handle);
      const a = adapters[index];
      if (!a) return err(FsErrno.BADF);
      return a.pread(inner, dst, offset);
    },

    write(handle: FsHandle, src: Uint8Array): FsResult<number> {
      const { index, inner } = unpack(handle);
      const a = adapters[index];
      if (!a) return err(FsErrno.BADF);
      return a.write(inner, src);
    },

    fstat(handle: FsHandle): FsResult<FileStat> {
      const { index, inner } = unpack(handle);
      const a = adapters[index];
      if (!a) return err(FsErrno.BADF);
      return a.fstat(inner);
    },

    stat(path: string, followSymlinks?: boolean): FsResult<FileStat> {
      const r = tryEach((a) => a.stat(path, followSymlinks));
      return r;
    },

    readdir(handle: FsHandle): FsResult<DirEntry[]> {
      const { index, inner } = unpack(handle);
      const a = adapters[index];
      if (!a) return err(FsErrno.BADF);
      return a.readdir(inner);
    },
  };
}
