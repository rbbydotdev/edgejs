// Diagnostic for issue #14: watch memory.buffer.byteLength + SAB identity
// across host imports.  If the wasm calls `memory.grow` during bootstrap,
// the buffer identity changes and any code holding a pre-grow buffer
// reference would observe stale data.
//
// Wraps host import namespaces (one of `wasi_snapshot_preview1`,
// `wasix_32v1`, `wasi`, `napi`, `env`) with a before/after byteLength
// observer.  Logs whenever byteLength changes OR the SAB identity flips.
// Per-call overhead is small (one identity comparison + one length read).

export interface ByteLengthEvent {
  callIdx: number;
  ns: string;
  sym: string;
  byteLengthBefore: number;
  byteLengthAfter: number;
  identityFlipped: boolean;
}

export interface ByteLengthWatcher {
  /** Wrap a namespace so each fn observes byteLength before/after. */
  wrap<T extends Record<string, Function>>(ns: T, nsName: string): T;
  /** Read accumulated events.  Each call to read() clears the buffer. */
  drain(): ByteLengthEvent[];
  /** Read the most recent N events without clearing. */
  recent(n: number): ByteLengthEvent[];
}

export function createByteLengthWatcher(memory: WebAssembly.Memory): ByteLengthWatcher {
  const events: ByteLengthEvent[] = [];
  let callIdx = 0;
  let lastBuffer: ArrayBufferLike = memory.buffer;

  function snap(ns: string, sym: string) {
    const beforeBuf = memory.buffer;
    const beforeLen = beforeBuf.byteLength;
    return (record: boolean) => {
      const afterBuf = memory.buffer;
      const afterLen = afterBuf.byteLength;
      const identityFlipped = beforeBuf !== afterBuf;
      // Only push an event when something actually changed OR when the caller
      // explicitly requests it (e.g. final summary).  Otherwise we'd push
      // 12k+ no-op events.
      if (record || identityFlipped || beforeLen !== afterLen || beforeBuf !== lastBuffer) {
        events.push({
          callIdx: callIdx++,
          ns,
          sym,
          byteLengthBefore: beforeLen,
          byteLengthAfter: afterLen,
          identityFlipped,
        });
        lastBuffer = afterBuf;
      } else {
        callIdx++;
      }
    };
  }

  return {
    wrap<T extends Record<string, Function>>(ns: T, nsName: string): T {
      const wrapped: Record<string, Function> = {};
      for (const [name, fn] of Object.entries(ns)) {
        wrapped[name] = (...args: unknown[]) => {
          const finalize = snap(nsName, name);
          try {
            return (fn as Function)(...args);
          } finally {
            finalize(false);
          }
        };
      }
      return wrapped as T;
    },
    drain(): ByteLengthEvent[] {
      const out = events.slice();
      events.length = 0;
      return out;
    },
    recent(n: number): ByteLengthEvent[] {
      return events.slice(-n);
    },
  };
}

/** Format an event list for human consumption.  Skips no-ops; highlights
 *  identity flips. */
export function formatEvents(events: ByteLengthEvent[]): string[] {
  if (events.length === 0) return ["(no byteLength changes observed)"];
  return events.map((e) => {
    const flip = e.identityFlipped ? "  IDENTITY-FLIPPED" : "";
    const change = e.byteLengthBefore === e.byteLengthAfter
      ? `len=${e.byteLengthAfter}`
      : `len ${e.byteLengthBefore} → ${e.byteLengthAfter}`;
    return `  #${e.callIdx} ${e.ns}.${e.sym}  ${change}${flip}`;
  });
}
