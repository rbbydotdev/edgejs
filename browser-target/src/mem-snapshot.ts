// Memory snapshot wrapper for shim functions.  Wraps each call to capture
// N bytes around every pointer argument BEFORE the call (what the wasm
// passed in) and AFTER the call (what we wrote back).
//
// The wrapper does NOT call `trace()` itself — it stashes the captured
// before/after on `pendingMem` and lets the worker's trace recorder
// (passed to buildImports) read+attach it to the single canonical trace
// record.  Earlier version called trace twice (once from here, once from
// buildImports' wrapImpl) which duplicated every call in the trace dump.
//
// Off by default — only active when `enabledSymbols` is non-empty.
// Capturing every byte for 12k calls would balloon the trace.

export interface MemSnapshotOptions {
  /** Bytes to capture on each side of a pointer arg. */
  range: number;
  /** Only snapshot calls whose `name` is in this set. Empty = none. */
  enabledSymbols: Set<string>;
  /** Heuristic threshold — values >= this are treated as pointers. */
  ptrThreshold: number;
}

export const DEFAULT_MEM_OPTIONS: MemSnapshotOptions = {
  range: 32,
  enabledSymbols: new Set(),
  ptrThreshold: 65536, // anything below this is probably not a memory address
};

/** Captures `range*2` bytes centered on `ptr` (clamped to memory bounds). */
function snapshot(memory: WebAssembly.Memory, ptr: number, range: number): string {
  if (ptr < range) ptr = range;
  const mem = new Uint8Array(memory.buffer);
  const start = Math.max(0, ptr - range);
  const end = Math.min(mem.length, ptr + range);
  return Array.from(mem.subarray(start, end))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Single-slot side channel.  The wrapper writes `{before, after}` here
 * just before returning; the worker's trace recorder reads it on the
 * very next call (synchronous, so no concurrency).  Cleared on read.
 *
 * #!~debt unverified one-time anomaly: an earlier capture once showed
 * a `getcwd` write that didn't persist into `after` (bytes at bufPtr
 * stayed 0x00).  Subsequent runs all show writes correctly.  Not
 * reproducible at present.  If it returns, log here and bisect.
 */
export const pendingMem: { value: { before: Record<string, string>; after: Record<string, string> } | null } = {
  value: null,
};

/**
 * Wrap a host-side namespace (e.g. `shim.wasi_snapshot_preview1`) so that
 * each function call captures memory snapshots around pointer args, and
 * stashes them on `pendingMem` for the worker's trace recorder to attach
 * to the single canonical trace record.
 */
export function instrumentNamespace<T extends Record<string, Function>>(
  ns: T,
  _nsName: string,
  memory: WebAssembly.Memory,
  options: MemSnapshotOptions,
): T {
  const wrapped: Record<string, Function> = {};
  for (const [name, fn] of Object.entries(ns)) {
    if (!options.enabledSymbols.has(name)) {
      wrapped[name] = fn;
      continue;
    }
    wrapped[name] = (...args: unknown[]) => {
      const before: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (typeof a === "number" && a >= options.ptrThreshold) {
          before[`arg${i}`] = snapshot(memory, a, options.range);
        }
      }
      let ret: unknown;
      let threw = false;
      try {
        ret = (fn as Function)(...args);
      } catch (e) {
        threw = true;
        throw e;
      } finally {
        if (!threw) {
          const after: Record<string, string> = {};
          for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (typeof a === "number" && a >= options.ptrThreshold) {
              after[`arg${i}`] = snapshot(memory, a, options.range);
            }
          }
          pendingMem.value = { before, after };
        }
      }
      return ret;
    };
  }
  return wrapped as T;
}
