// OPFS-backed (ish) writable FileSystem adapter.
//
// ROLE: this adapter owns the "scratch / writable" layer of the FS facade.
// In its eventual form it persists bytes to OPFS via
// `FileSystemSyncAccessHandle` (only available in worker contexts — we run
// in a dedicated worker, so the platform supports it).
//
// CURRENT STATUS (v1):
//
//   #!~debt opfs-not-yet-persistent — this adapter is currently a pure
//   in-memory `Map<path, Uint8Array>`.  Persistence to OPFS is deferred
//   to chunk B-2.  The writable-layer architecture (FileSystem facade
//   + layered combinator + this file's slot in the layering) is in
//   place; only the byte-storage implementation is a stand-in.
//
//   The factory is still async (`createOpfsFs`) so chunk B-2 can swap
//   the body for a real OPFS pre-walk without touching worker.ts or
//   wasi-shim.ts.  Sites that need real persistence ship through the
//   same factory boundary.
//
// WHY IN-MEMORY FIRST:
//
//   The shim contract is synchronous (WASI calls don't yield).  OPFS's
//   `FileSystemSyncAccessHandle` IS sync, but obtaining one requires an
//   async `getFileHandle({create:true})` first.  Resolving that
//   synchronously at call time would need either:
//     (a) a fixed mount-point pre-walk (bounded — can't host arbitrary
//         `/tmp/<dynamic>.txt` writes), or
//     (b) a SAB+Atomics.wait bridge to a sister worker that holds the
//         OPFS handles.  Workable but complex.
//
//   Both are real designs for chunk B-2.  For chunk B (this one) we
//   want the writable-layer architecture proven end-to-end with the
//   simplest possible storage, so userland workloads can rely on
//   `fs.writeFileSync` / `fs.readFileSync` round-tripping.  Reloading
//   the tab loses the scratch state — acceptable until B-2 lands.
//
// COVERAGE:
//
//   ANY absolute path the layered combinator routes here.  The combinator
//   is responsible for sending read-only system paths (e.g. /node-lib/**)
//   to other adapters first.  This adapter happily accepts any path
//   given to it.
//
// SEMANTICS:
//
//   - open(path, {write:true, create:true}) — creates a fresh empty
//     entry if missing; returns a handle with cursor at 0.
//   - open(path, {truncate:true}) — clears existing contents.
//   - write() appends/replaces at the cursor (which advances).
//   - read() reads from the cursor onward.
//   - stat()/fstat() report current size.
//   - Directories aren't modeled explicitly; the in-memory store is flat.
//     readdir() returns entries that share a prefix with the directory
//     path (so `/tmp` lists every entry starting with `/tmp/`).  Good
//     enough for most fs.readdirSync workloads.
//
// HARD RULES OBSERVED:
//   - Native globals captured at module load (NOTES.md 2026-05-20 attempt #6).
//   - Adapter never throws — all failure modes return FsResult.

import {
  type DirEntry,
  type FileStat,
  type FileSystem,
  type FsHandle,
  type FsResult,
  type OpenOptions,
  FsErrno,
  FileType,
  err,
  ok,
} from "../types";

// Cache native globals — edge mutates globalThis at bootstrap; resolving
// these through the global object in hot paths is a tested-and-shipped
// bug pattern (NOTES.md 2026-05-20 attempt #6).
const NativeUint8Array = Uint8Array;

/** Per-path stored bytes.  Cursor + handle bookkeeping lives in OpenedFile. */
interface StoredFile {
  body: Uint8Array;
  ino: number;
  /** ns timestamps — we only update mtim on write. */
  atimNs: bigint;
  mtimNs: bigint;
  ctimNs: bigint;
}

/** Per-open-handle state: which file + cursor position + write-mode flag. */
interface OpenedFile {
  path: string;
  cursor: number;
  writable: boolean;
}

export interface OpfsOptions {
  /** Optional logger used during init + on each path resolution. */
  log?: (line: string) => void;
}

/**
 * Construct the writable adapter.  Async so chunk B-2 can do the real
 * OPFS pre-walk here without touching the call site.
 *
 * #!~debt opfs-not-yet-persistent: returns an in-memory map for now.
 * Reloading the tab loses state.  Real OPFS persistence lands in B-2.
 */
export async function createOpfsFs(opts: OpfsOptions = {}): Promise<FileSystem> {
  // Storage: absolute path → bytes + metadata.  Survives for the
  // lifetime of the worker; tab reload starts fresh.
  const store = new Map<string, StoredFile>();
  const handles = new Map<FsHandle, OpenedFile>();
  let nextHandle = 1;
  let nextIno = 1_000_000;

  opts.log?.(`[opfs-fs] in-memory writable layer ready (persistence deferred)`);

  /** FNV-1a over the path so two opens of the same file see the same ino. */
  function inoFor(path: string): number {
    const existing = store.get(path);
    if (existing) return existing.ino;
    return ++nextIno;
  }

  function statOf(_path: string, body: Uint8Array, ino: number, mtim: bigint, ctim: bigint): FileStat {
    return {
      fileType: FileType.REGULAR_FILE,
      size: body.length,
      ino,
      atimNs: 0n,
      mtimNs: mtim,
      ctimNs: ctim,
    };
  }

  function isDirPath(path: string): boolean {
    // A path "is a directory" if it equals a known prefix of any stored
    // entry.  This is purely advisory for readdir/stat fallbacks.
    for (const p of store.keys()) {
      if (p.startsWith(path + "/")) return true;
    }
    return false;
  }

  return {
    open(path: string, options: OpenOptions = {}): FsResult<FsHandle> {
      if (options.directory) {
        // Directories are virtual here.  If anything under the path
        // exists, we synthesize a directory handle.  Otherwise NOENT.
        if (!isDirPath(path) && path !== "/") return err(FsErrno.NOENT);
        const handle = nextHandle++;
        handles.set(handle, { path, cursor: 0, writable: false });
        return ok(handle);
      }

      const exists = store.has(path);
      const wantWrite = options.write === true;
      const wantCreate = options.create === true;

      if (!exists && !wantCreate) return err(FsErrno.NOENT);

      if (!exists && wantCreate) {
        const now = BigInt(Date.now()) * 1_000_000n;
        store.set(path, {
          body: new NativeUint8Array(0),
          ino: inoFor(path),
          atimNs: now,
          mtimNs: now,
          ctimNs: now,
        });
      }

      if (options.truncate && exists) {
        const f = store.get(path)!;
        f.body = new NativeUint8Array(0);
        f.mtimNs = BigInt(Date.now()) * 1_000_000n;
      }

      const handle = nextHandle++;
      handles.set(handle, { path, cursor: 0, writable: wantWrite });
      return ok(handle);
    },

    close(handle: FsHandle): FsResult<void> {
      if (!handles.has(handle)) return err(FsErrno.BADF);
      handles.delete(handle);
      return ok(undefined);
    },

    read(handle: FsHandle, dst: Uint8Array): FsResult<number> {
      const f = handles.get(handle);
      if (!f) return err(FsErrno.BADF);
      const stored = store.get(f.path);
      if (!stored) {
        // Directory handle or vanished file — return ISDIR for dir
        // handles, NOENT otherwise.  Best-effort: if isDirPath, dir.
        if (isDirPath(f.path) || f.path === "/") return err(FsErrno.ISDIR);
        return err(FsErrno.NOENT);
      }
      const remaining = stored.body.length - f.cursor;
      if (remaining <= 0) return ok(0);
      const n = Math.min(remaining, dst.length);
      dst.set(stored.body.subarray(f.cursor, f.cursor + n));
      f.cursor += n;
      return ok(n);
    },

    pread(handle: FsHandle, dst: Uint8Array, offset: number): FsResult<number> {
      const f = handles.get(handle);
      if (!f) return err(FsErrno.BADF);
      const stored = store.get(f.path);
      if (!stored) return err(FsErrno.NOENT);
      if (offset < 0) return err(FsErrno.INVAL);
      if (offset >= stored.body.length) return ok(0);
      const n = Math.min(stored.body.length - offset, dst.length);
      dst.set(stored.body.subarray(offset, offset + n));
      return ok(n);
    },

    write(handle: FsHandle, src: Uint8Array): FsResult<number> {
      const f = handles.get(handle);
      if (!f) return err(FsErrno.BADF);
      if (!f.writable) return err(FsErrno.ACCES);
      const stored = store.get(f.path);
      if (!stored) return err(FsErrno.NOENT);
      // Grow body if cursor + src.length > current size.  Replace in
      // place inside [cursor, cursor+src.length).
      const end = f.cursor + src.length;
      if (end > stored.body.length) {
        const grown = new NativeUint8Array(end);
        grown.set(stored.body);
        stored.body = grown;
      }
      // Need an Uint8Array view that's NOT backed by a SharedArrayBuffer
      // for some browser quirks — but stored.body IS plain, and src may
      // be a SAB view from wasm.  Uint8Array.set handles that mismatch.
      stored.body.set(src, f.cursor);
      f.cursor = end;
      stored.mtimNs = BigInt(Date.now()) * 1_000_000n;
      return ok(src.length);
    },

    fstat(handle: FsHandle): FsResult<FileStat> {
      const f = handles.get(handle);
      if (!f) return err(FsErrno.BADF);
      const stored = store.get(f.path);
      if (!stored) {
        // Directory handle?
        if (isDirPath(f.path) || f.path === "/") {
          return ok({
            fileType: FileType.DIRECTORY,
            size: 0,
            ino: 1,
            atimNs: 0n,
            mtimNs: 0n,
            ctimNs: 0n,
          });
        }
        return err(FsErrno.NOENT);
      }
      return ok(statOf(f.path, stored.body, stored.ino, stored.mtimNs, stored.ctimNs));
    },

    stat(path: string, _followSymlinks = true): FsResult<FileStat> {
      const stored = store.get(path);
      if (stored) return ok(statOf(path, stored.body, stored.ino, stored.mtimNs, stored.ctimNs));
      if (isDirPath(path)) {
        return ok({
          fileType: FileType.DIRECTORY,
          size: 0,
          ino: 1,
          atimNs: 0n,
          mtimNs: 0n,
          ctimNs: 0n,
        });
      }
      return err(FsErrno.NOENT);
    },

    readdir(handle: FsHandle): FsResult<DirEntry[]> {
      const f = handles.get(handle);
      if (!f) return err(FsErrno.BADF);
      // Enumerate direct children of f.path.  Flat store ⇒ scan all
      // keys with the prefix and take the next segment.
      const prefix = f.path === "/" ? "/" : f.path + "/";
      const seen = new Set<string>();
      const out: DirEntry[] = [];
      for (const [p, s] of store) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash < 0 ? rest : rest.slice(0, slash);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({
          name,
          fileType: slash < 0 ? FileType.REGULAR_FILE : FileType.DIRECTORY,
          ino: slash < 0 ? s.ino : 1,
        });
      }
      return ok(out);
    },
  };
}
