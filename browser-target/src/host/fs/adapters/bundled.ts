// Bundled FileSystem adapter — serves read-only files from the page origin.
//
// ROLE: this is the ONLY file in the browser target that knows where
// bundled content lives and how to fetch it.  Everything downstream goes
// through the FileSystem interface in `../types.ts`.
//
// COVERAGE:
//
//   /node-lib/**   ← anything under this prefix is fetched from the page's
//                    `/node-lib/**` URL.  All 353 Node lib files are
//                    symlinked into `browser-target/public/node-lib/` by
//                    the dev setup, served by Vite.  We do NOT enumerate
//                    the tree — if edge asks for a path that 404s, we
//                    return NOENT, just like a real filesystem.
//
//   /node/deps/**  ← same pattern, served from `browser-target/public/
//                    node/deps/**` (symlink to the repo `deps/` tree).
//                    The full deps tree is huge but Vite only hits disk
//                    for files actually requested, so there's no startup
//                    cost.  Listing them in a manifest would be churn
//                    we don't need.
//
//   ANY OTHER PATH ← NOENT.  /dev/urandom and friends are still owned by
//                    wasi-shim (the FS facade is for real-content reads).
//
// SYNCHRONICITY:
//
//   WASI is synchronous; the shim cannot await.  We use synchronous
//   XMLHttpRequest from inside the dedicated worker, where it's still
//   supported (deprecated in main-thread contexts, allowed in workers).
//   The whole-file body is cached on first read.  This trades startup
//   latency for simpler shim code; the manifest of files edge actually
//   loads is small (~20-100 KB total per bootstrap).
//
// WHY NOT FETCH+AWAIT?
//
//   The wasm runs on the worker's main thread.  Once `_start` is called,
//   we don't get back into the JS event loop until the wasm yields
//   (which it doesn't, during bootstrap).  Any path that requires
//   awaiting a Promise during a syscall would have to use SAB+Atomics
//   .wait against a fetch worker — overkill for read-only static
//   content.  Sync XHR does the job in one line.
//
// TECH DEBT:
//   #!~debt sync-xhr-network-blocking: cold-cache requests block the
//   wasm thread for the duration of a network round-trip.  For LAN dev
//   this is sub-ms per file; for slow networks or production this
//   becomes a UX problem.  Real impl: pre-populate the cache via async
//   fetch before `_start`, OR move fs to a separate worker addressed
//   via SAB+Atomics.
//
//   #!~debt no-write-support: open(write:true) always returns ROFS.
//   Tests / userland that need /tmp scratch space will fail until an
//   OPFS adapter lands.
//
//   #!~debt no-readdir: readdir() on /node-lib/** and /node/deps/**
//   returns NOTDIR.  Vite has no directory-listing endpoint and we'd
//   need a server-side manifest.  Bootstrap doesn't readdir, but
//   `fs.readdirSync` from userland will fail.
//
//   #!~debt naïve-stat-via-fetch: stat() is implemented as a HEAD
//   request through fetch+sync-XHR.  No mtime/ctime are propagated
//   (the bundled tree's HTTP timestamps are wrong for our purposes —
//   they're symlink ctimes, not the original Node sources).

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

/** Prefixes this adapter serves; everything else is NOENT. */
const PREFIXES = ["/node-lib/", "/node/deps/", "/test/"];

/** Internal handle bookkeeping. */
interface OpenedFile {
  path: string;
  body: Uint8Array;
  cursor: number;
  stat: FileStat;
}

/**
 * Synchronous fetch using XHR.  Returns the body bytes on 200, or null
 * on 404/network error.  Other 2xx responses are also treated as success
 * (range responses are handled by readdir/stat callers).
 *
 * NOTE: the call is fully blocking — no event-loop turns happen during
 * the XHR.  See file header for why this is acceptable.
 */
function syncFetchBytes(url: string): { status: number; body: Uint8Array | null } {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, /* async */ false);
  xhr.responseType = "arraybuffer";
  try {
    xhr.send(null);
  } catch {
    return { status: 0, body: null };
  }
  if (xhr.status === 0) return { status: 0, body: null };
  if (xhr.status >= 400) return { status: xhr.status, body: null };
  // Vite's dev server has an SPA fallback that returns index.html (200 +
  // Content-Type: text/html) for any missing path. None of the files we
  // serve from this adapter are HTML, so treat text/html responses as
  // NOENT. Without this, /test/parallel/nonexistent.json would parse as
  // HTML and look "valid" to consumers (e.g. CJS package.json walk).
  const ct = (xhr.getResponseHeader("content-type") ?? "").toLowerCase();
  if (ct.startsWith("text/html")) return { status: 404, body: null };
  const buf = xhr.response as ArrayBuffer | null;
  if (!buf) return { status: xhr.status, body: new Uint8Array() };
  return { status: xhr.status, body: new Uint8Array(buf) };
}

/**
 * HEAD-style probe.  Sync XHR with method HEAD.  Returns true if the
 * resource exists.  Used by stat() so we don't have to fetch the whole
 * body just to confirm presence.
 */
function syncFetchExists(url: string): { exists: boolean; size: number } {
  const xhr = new XMLHttpRequest();
  xhr.open("HEAD", url, /* async */ false);
  try {
    xhr.send(null);
  } catch {
    return { exists: false, size: 0 };
  }
  if (xhr.status === 0 || xhr.status >= 400) return { exists: false, size: 0 };
  // Same Vite SPA-fallback guard as syncFetchBytes.
  const ct = (xhr.getResponseHeader("content-type") ?? "").toLowerCase();
  if (ct.startsWith("text/html")) return { exists: false, size: 0 };
  const cl = Number(xhr.getResponseHeader("content-length") ?? "0");
  return { exists: true, size: cl };
}

export interface BundledOptions {
  /**
   * Optional verbose logger.  Called once per real network read with the
   * URL and resolved status — useful for tracing during bootstrap.
   */
  log?: (line: string) => void;
}

/**
 * Construct a bundled FileSystem.  Stateless apart from the in-memory
 * body cache (one entry per opened file, keyed by absolute path).
 */
export function createBundledFs(opts: BundledOptions = {}): FileSystem {
  const handles = new Map<FsHandle, OpenedFile>();
  /** Cache: path → body (we never re-fetch the same file). */
  const bodyCache = new Map<string, Uint8Array>();
  /** Cache: path → exists/size, for stat. */
  const statCache = new Map<string, { exists: boolean; size: number }>();
  let nextHandle = 1;

  function isServed(path: string): boolean {
    // Match: full prefix (e.g. "/test/common/foo") AND the parent dirs
    // that lead to the prefix (e.g. "/test", "/" when prefix is "/test/").
    // Without the parent match, realpath walking up the tree from a
    // served file hits the parent dir, finds NOENT, and the whole
    // resolution chain breaks.
    return PREFIXES.some((p) => {
      if (path.startsWith(p)) return true;
      // p ends with "/"; check if path is a parent dir of the prefix
      // (e.g. p="/test/" → "/test" and "/" should be served as DIRECTORY).
      const pNoSlash = p.endsWith("/") ? p.slice(0, -1) : p;
      if (path === pNoSlash) return true;
      if (path === "/" && p.startsWith("/")) return true;
      return false;
    });
  }

  /** Best-effort: build a FileStat from the body length, or zeros. */
  function makeFileStat(path: string, size: number, fileType: FileType): FileStat {
    // ino: a stable hash of the path.  We use a tiny FNV-1a so two
    // accesses to the same path get the same ino without a global map.
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return {
      fileType,
      size,
      ino: h,
      atimNs: 0n,
      mtimNs: 0n,
      ctimNs: 0n,
    };
  }

  function fetchBody(path: string): Uint8Array | null {
    const cached = bodyCache.get(path);
    if (cached) return cached;
    const res = syncFetchBytes(path);
    opts.log?.(`[bundled-fs] GET ${path} → ${res.status}${res.body ? ` (${res.body.length}B)` : ""}`);
    if (res.body) bodyCache.set(path, res.body);
    return res.body;
  }

  function probeStat(path: string): { exists: boolean; size: number } {
    const cached = statCache.get(path);
    if (cached) return cached;
    // If we already have the body cached, no need to HEAD.
    const body = bodyCache.get(path);
    if (body) {
      const s = { exists: true, size: body.length };
      statCache.set(path, s);
      return s;
    }
    const res = syncFetchExists(path);
    opts.log?.(`[bundled-fs] HEAD ${path} → ${res.exists ? `200 (${res.size}B)` : "404"}`);
    statCache.set(path, res);
    return res;
  }

  return {
    open(path: string, options: OpenOptions = {}): FsResult<FsHandle> {
      if (options.write) return err(FsErrno.ROFS);
      if (!isServed(path)) return err(FsErrno.NOENT);
      const body = fetchBody(path);
      if (!body) return err(FsErrno.NOENT);
      // bundled adapter has no real directories — paths either resolve to
      // a regular file body or NOENT.  If the caller demanded directory
      // semantics, refuse.
      if (options.directory) return err(FsErrno.NOTDIR);
      const handle = nextHandle++;
      const stat = makeFileStat(path, body.length, FileType.REGULAR_FILE);
      handles.set(handle, { path, body, cursor: 0, stat });
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
      const remaining = f.body.length - f.cursor;
      if (remaining <= 0) return ok(0);
      const n = Math.min(remaining, dst.length);
      dst.set(f.body.subarray(f.cursor, f.cursor + n));
      f.cursor += n;
      return ok(n);
    },

    pread(handle: FsHandle, dst: Uint8Array, offset: number): FsResult<number> {
      const f = handles.get(handle);
      if (!f) return err(FsErrno.BADF);
      if (offset < 0) return err(FsErrno.INVAL);
      if (offset >= f.body.length) return ok(0);
      const n = Math.min(f.body.length - offset, dst.length);
      dst.set(f.body.subarray(offset, offset + n));
      return ok(n);
    },

    write(_handle: FsHandle, _src: Uint8Array): FsResult<number> {
      // Read-only adapter — see file-header #!~debt no-write-support.
      return err(FsErrno.ROFS);
    },

    fstat(handle: FsHandle): FsResult<FileStat> {
      const f = handles.get(handle);
      if (!f) return err(FsErrno.BADF);
      return ok(f.stat);
    },

    stat(path: string, _followSymlinks = true): FsResult<FileStat> {
      if (!isServed(path)) return err(FsErrno.NOENT);
      const probe = probeStat(path);
      if (probe.exists) return ok(makeFileStat(path, probe.size, FileType.REGULAR_FILE));
      // File not found, but the path may name a directory. Node's CJS
      // loader needs to recognize directories so it can fall back to
      // `<path>/index.js`. We don't have a listing API, so probe for
      // a common directory marker -- if `<path>/index.js` or
      // `<path>/package.json` exists, treat <path> as a directory.
      const idxProbe = probeStat(path + "/index.js");
      const pkgProbe = probeStat(path + "/package.json");
      if (idxProbe.exists || pkgProbe.exists) {
        return ok(makeFileStat(path, 0, FileType.DIRECTORY));
      }
      return err(FsErrno.NOENT);
    },

    readdir(_handle: FsHandle): FsResult<DirEntry[]> {
      // #!~debt no-readdir: see file header
      return err(FsErrno.NOTDIR);
    },
  };
}
