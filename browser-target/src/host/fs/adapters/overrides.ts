// Module-override FileSystem adapter.
//
// Wraps `ModuleOverrides` (a user-provided map of bare specifiers to
// CJS source strings, `null` for empty stubs, or `undefined` to fall
// through) as a FileSystem.  Designed to layer via `layered()` ABOVE a
// real bundled/Node/OPFS FS — paths the consumer overrides return the
// override body, everything else returns NOENT and falls through.
//
// Use case: consumers swap Node built-ins ("crypto", "inspector", etc.)
// for browser-optimized polyfills, empty no-ops, or testing mocks
// without modifying edge.js itself.  Per the project's "consumer-pluggable
// runtime" goal.
//
// Path resolution: bare specifiers map deterministically to
// `/node-lib/<spec>.js` — both forms work as keys in the overrides map:
//
//   { "crypto":               "<src>" }
//   { "/node-lib/crypto.js":  "<src>" }
//
// Example:
//
//   const overrides = createOverridesFs({
//     // Swap with a Web Crypto-backed polyfill for perf:
//     "crypto": webCryptoPolyfillSource,
//     // Stub modules userland doesn't use:
//     "inspector": null,
//     // Default (fall through to edge's bundled version):
//     "fs": undefined,
//   });
//   const fs = layered(overrides, bundledFs);

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

export type ModuleOverride = string | null | undefined;

export interface ModuleOverrides {
  [pathOrSpecifier: string]: ModuleOverride;
}

const EMPTY_MODULE_SRC = "module.exports = {};\n";
const encoder = new TextEncoder();

/** Map a bare specifier ("crypto") to its bundled path ("/node-lib/crypto.js"). */
function pathForModule(specifier: string): string {
  if (specifier.startsWith("/")) return specifier;
  return `/node-lib/${specifier}.js`;
}

export function createOverridesFs(overrides: ModuleOverrides): FileSystem {
  // Pre-compute bytes for each override.  Cached for the lifetime of the FS.
  const bodies = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const src = value === null ? EMPTY_MODULE_SRC : value;
    bodies.set(pathForModule(key), encoder.encode(src));
  }

  interface Opened { path: string; body: Uint8Array; cursor: number; }
  const handles = new Map<FsHandle, Opened>();
  let nextHandle = 1;

  function ino(path: string): number {
    // FNV-1a for a deterministic ino per path.
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
  }

  function stat(path: string, body: Uint8Array): FileStat {
    return { fileType: FileType.REGULAR_FILE, size: body.length, ino: ino(path), atimNs: 0n, mtimNs: 0n, ctimNs: 0n };
  }

  return {
    open(path: string, opts: OpenOptions = {}): FsResult<FsHandle> {
      const body = bodies.get(path);
      if (!body) return err(FsErrno.NOENT);
      if (opts.directory) return err(FsErrno.NOTDIR);
      if (opts.write) return err(FsErrno.ROFS);
      const handle = nextHandle++;
      handles.set(handle, { path, body, cursor: 0 });
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
    write(): FsResult<number> { return err(FsErrno.ROFS); },
    fstat(handle: FsHandle): FsResult<FileStat> {
      const f = handles.get(handle);
      if (!f) return err(FsErrno.BADF);
      return ok(stat(f.path, f.body));
    },
    stat(path: string): FsResult<FileStat> {
      const body = bodies.get(path);
      if (!body) return err(FsErrno.NOENT);
      return ok(stat(path, body));
    },
    readdir(): FsResult<DirEntry[]> { return err(FsErrno.NOTDIR); },
  };
}
