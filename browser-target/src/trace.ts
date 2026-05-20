// Structured per-call trace.  Captures every host import invocation
// — both stubs and real implementations — into a flat array of records.
// At end-of-run we compress this into a summary that's easy to scan and
// also offer the raw stream as a downloadable JSON for offline analysis.

export interface TraceRecord {
  t: number;          // ms since trace start
  ns: string;
  sym: string;
  args: unknown[];
  ret: unknown;
  stub: boolean;
  /** Optional memory snapshots around pointer args (mem-snapshot.ts). */
  mem?: { before: Record<string, string>; after: Record<string, string> };
}

export interface CallSummary {
  ns: string;
  sym: string;
  count: number;
  firstT: number;
  lastT: number;
  stub: boolean;
  sampleArgs: unknown[];
  sampleRet: unknown;
}

// Capture performance.now() at module load — edge mutates globalThis during
// bootstrap and can shadow it mid-run.
const now = performance.now.bind(performance);

export class Trace {
  private records: TraceRecord[] = [];
  private startNow = now();

  record(
    ns: string,
    sym: string,
    args: unknown[],
    ret: unknown,
    stub: boolean,
    mem?: { before: Record<string, string>; after: Record<string, string> },
  ): void {
    this.records.push({
      t: now() - this.startNow,
      ns, sym,
      // BigInt isn't JSON-safe; coerce for the trace.
      args: args.map(coerce),
      ret: coerce(ret),
      stub,
      ...(mem ? { mem } : {}),
    });
  }

  all(): TraceRecord[] { return this.records; }

  /** Top-N most-called symbols, sorted by count descending. */
  topByCount(n: number): CallSummary[] {
    return this.summarize().sort((a, b) => b.count - a.count).slice(0, n);
  }

  /** Distinct call sites grouped by namespace + symbol. */
  summarize(): CallSummary[] {
    const map = new Map<string, CallSummary>();
    for (const r of this.records) {
      const key = `${r.ns}.${r.sym}`;
      const cur = map.get(key);
      if (cur) {
        cur.count++;
        cur.lastT = r.t;
      } else {
        map.set(key, {
          ns: r.ns, sym: r.sym,
          count: 1,
          firstT: r.t, lastT: r.t,
          stub: r.stub,
          sampleArgs: r.args,
          sampleRet: r.ret,
        });
      }
    }
    return [...map.values()];
  }

  /** Most-recent N records — useful as "what was happening just before exit". */
  tail(n: number): TraceRecord[] {
    return this.records.slice(-n);
  }

  /** Counts per namespace. */
  byNamespace(): Map<string, { total: number; distinct: number }> {
    const out = new Map<string, { total: number; distinct: number }>();
    const seen = new Map<string, Set<string>>();
    for (const r of this.records) {
      const ns = out.get(r.ns) ?? { total: 0, distinct: 0 };
      ns.total++;
      let symSet = seen.get(r.ns);
      if (!symSet) { symSet = new Set(); seen.set(r.ns, symSet); }
      if (!symSet.has(r.sym)) { symSet.add(r.sym); ns.distinct++; }
      out.set(r.ns, ns);
    }
    return out;
  }
}

function coerce(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString() + "n";
  return v;
}

/**
 * Map our browser-side namespace to the same "category" the native
 * napi_wasmer trace layer emits.  This is the join key for browser ↔ native
 * trace diffing.
 *
 * Mirrors the categorize logic in `napi/src/cli/trace_layer.rs`.
 */
export function categorize(ns: string): string {
  switch (ns) {
    case "wasi_snapshot_preview1":
    case "wasi":
      return "wasi";
    case "wasix_32v1":
      return "wasix";
    case "napi":
    case "env":
    case "emnapi":
      return ns;
    default:
      return ns;
  }
}

/**
 * Serialize the trace into the same JSONL shape napi_wasmer emits via
 * --trace-wasi.  One record per line; each record has `t_ms`, `category`,
 * `name`, `fields` (raw args + ret).  The two files diff cleanly.
 */
export function toUnifiedJsonl(trace: Trace): string {
  const lines: string[] = [];
  for (const r of trace.all()) {
    const record = {
      t_ms: r.t,
      category: categorize(r.ns),
      name: r.sym,
      target: `${r.ns}.${r.sym}`,
      fields: {
        // Browser stores positional args; native stores named fields.  Until
        // we record arg-name mappings on the browser side, expose positional
        // args under arg0..argN and the return under `ret`.
        ...Object.fromEntries(r.args.map((a, i) => [`arg${i}`, a])),
        ret: r.ret,
        stub: r.stub,
        ...(r.mem ? { mem: r.mem } : {}),
      },
    };
    lines.push(JSON.stringify(record));
  }
  return lines.join("\n") + "\n";
}
