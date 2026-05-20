// FileSystem facade — the only interface wasi-shim talks to for file I/O.
//
// Design choices:
//
// - SYNCHRONOUS.  WASI syscalls are sync (the wasm doesn't yield), so this
//   interface must be sync too.  Adapters that need network I/O (the
//   `bundled` adapter is the obvious one) use sync XHR from inside the
//   dedicated worker.  Sync XHR is supported in Worker scope.
//
// - PATH-FIRST.  Operations take absolute, normalized POSIX paths.  Path
//   normalization, "."/".." resolution, and dirfd-relative lookup happen
//   outside the FileSystem; the shim layer resolves a (dirfd, relpath) into
//   one absolute path before calling in.  This keeps adapters dumb and
//   composable.
//
// - HANDLE-BASED READS.  open() returns a numeric handle that's local to the
//   FileSystem (not a WASI fd).  The shim wraps that handle with a WASI fd
//   and tracks the mapping.  Adapters can therefore reuse a single FS for
//   multiple shim instances without sharing fd namespaces.
//
// - READ-ONLY by default.  Write operations exist in the contract but the
//   bundled adapter rejects them with FsErrno.ACCES.  An OPFS adapter
//   (later chunk) will implement them.
//
// All errnos here are WASI preview1 values (matching __WASI_ERRNO_* in
// wasi-libc) so the shim can pass them through unchanged.

export const FsErrno = {
  SUCCESS: 0,
  ACCES: 2,
  BADF: 8,
  EXIST: 20,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  NAMETOOLONG: 37,
  NOENT: 44,
  NOTDIR: 54,
  NOTEMPTY: 55,
  PERM: 63,
  ROFS: 69,
} as const;
export type FsErrno = typeof FsErrno[keyof typeof FsErrno];

// WASI filetype constants — exposed here so the shim doesn't need to
// re-declare them.
export const FileType = {
  UNKNOWN: 0,
  BLOCK_DEVICE: 1,
  CHARACTER_DEVICE: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4,
  SOCKET_DGRAM: 5,
  SOCKET_STREAM: 6,
  SYMBOLIC_LINK: 7,
} as const;
export type FileType = typeof FileType[keyof typeof FileType];

/** Metadata returned by stat-style calls. */
export interface FileStat {
  fileType: FileType;
  /** File size in bytes.  0 for directories. */
  size: number;
  /** Stable per-path identifier; need not survive across reboots. */
  ino: number;
  /** Nanosecond timestamps; 0 if unknown. */
  atimNs: bigint;
  mtimNs: bigint;
  ctimNs: bigint;
}

/** One entry in a directory listing. */
export interface DirEntry {
  name: string;
  fileType: FileType;
  /** Same identifier as FileStat.ino for the corresponding path. */
  ino: number;
}

/** Result type — discriminated union avoids "did this throw?" guessing. */
export type FsResult<T> =
  | { ok: true; value: T }
  | { ok: false; errno: FsErrno };

/** Convenience constructors. */
export const ok = <T>(value: T): FsResult<T> => ({ ok: true, value });
export const err = (errno: FsErrno): FsResult<never> => ({ ok: false, errno });

/** Opaque per-FS handle returned by open().  Adapter-local. */
export type FsHandle = number;

/** Open flags — subset of WASI's oflags + a "directory" hint. */
export interface OpenOptions {
  /** Caller wants a directory handle (for readdir). */
  directory?: boolean;
  /** Caller wants write access (will fail on read-only adapters). */
  write?: boolean;
  /** Create if missing.  Ignored when write=false. */
  create?: boolean;
  /** Truncate on open. */
  truncate?: boolean;
  /** Follow terminal symlinks (true) or fail with LOOP/return the link
   *  itself (false).  Default true. */
  followSymlinks?: boolean;
}

/**
 * The FileSystem contract.
 *
 * Every method is synchronous and returns FsResult.  Adapters MUST NOT
 * throw — they must return `err(...)`.  Throwing leaks adapter-specific
 * error semantics into the shim and forces wasi-shim to know how to
 * translate them.
 */
export interface FileSystem {
  /** Open a file or directory at an absolute POSIX path. */
  open(path: string, opts?: OpenOptions): FsResult<FsHandle>;

  /** Close a handle.  Closing an already-closed handle returns BADF. */
  close(handle: FsHandle): FsResult<void>;

  /**
   * Read up to `dst.length` bytes from `handle` into `dst`.
   * Returns the number of bytes actually read; 0 means EOF.  Reads from
   * a directory handle return ISDIR.
   */
  read(handle: FsHandle, dst: Uint8Array): FsResult<number>;

  /**
   * Read at an explicit offset (pread-style).  Some adapters back this
   * by an in-memory blob and ignore the handle's cursor; others advance
   * it.  Adapters must document which.  The shim uses this for fd_pread.
   */
  pread(handle: FsHandle, dst: Uint8Array, offset: number): FsResult<number>;

  /** stat by handle. */
  fstat(handle: FsHandle): FsResult<FileStat>;

  /** stat by path.  followSymlinks default true. */
  stat(path: string, followSymlinks?: boolean): FsResult<FileStat>;

  /**
   * Read directory entries.  Returns the entries; the caller is
   * responsible for cookie/offset bookkeeping.  Adapters that can't
   * enumerate (e.g. the bundled one for unlisted prefixes) return NOTDIR.
   */
  readdir(handle: FsHandle): FsResult<DirEntry[]>;
}
