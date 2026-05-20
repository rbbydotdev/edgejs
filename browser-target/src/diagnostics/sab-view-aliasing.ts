// Diagnostic for issue #14 (uv_cwd EIO at edge bootstrap), attempt #5.
//
// Hypothesis A under test: SharedArrayBuffer view caching aliases stale
// views.  Even though `new Uint8Array(memory.buffer)` returns a fresh
// object, internally Chrome may cache the underlying mapping per-view-
// construction, and writes done via one constructed view aren't visible
// to reads via another view on certain memory pages.
//
// Hypothesis B (cheap to test alongside): `WebAssembly.Memory.prototype.buffer`
// returns a NEW SharedArrayBuffer after `memory.grow()`, and any cached
// `memory.buffer` value points at the old SAB.  We don't have a stale
// reference in our code (audited) but we still log byteLength across
// the test to detect growth.
//
// The test is self-contained.  It does NOT run any wasm; only the JS-side
// memory model is exercised.  If we see a write-then-read miss in this
// pure-JS setup, that locks Hypothesis A as the root cause.

export interface Probe {
  /** Page index (in 64KB pages) the test wrote to. */
  pageIdx: number;
  /** Byte offset within the page where the marker was written. */
  offsetInPage: number;
  /** Absolute address derived from pageIdx*65536 + offsetInPage. */
  addr: number;
  /** Marker byte (0x2f for our cwd case, but arbitrary). */
  marker: number;
  /** Reads observed from independent view constructions. */
  reads: { method: string; value: number }[];
  /** True if every read saw the marker. */
  ok: boolean;
}

export interface DiagReport {
  scenario: string;
  initialPages: number;
  finalPages: number;
  bufferIdentityChanged: boolean;
  byteLengthBefore: number;
  byteLengthAfter: number;
  probes: Probe[];
  anyMiss: boolean;
}

const MARKER = 0x2f; // '/' — matches the byte our real getcwd writes

function readBack(
  memory: WebAssembly.Memory,
  addr: number,
  marker: number,
): { reads: Probe["reads"]; ok: boolean } {
  // Each path uses an INDEPENDENT view construction off memory.buffer.
  // If Chrome aliases views by mapping, these may disagree.
  const reads: Probe["reads"] = [];

  // Path 1: fresh Uint8Array
  reads.push({ method: "Uint8Array#1", value: new Uint8Array(memory.buffer)[addr] });

  // Path 2: another fresh Uint8Array
  reads.push({ method: "Uint8Array#2", value: new Uint8Array(memory.buffer)[addr] });

  // Path 3: fresh DataView.getUint8
  reads.push({
    method: "DataView.getUint8",
    value: new DataView(memory.buffer).getUint8(addr),
  });

  // Path 4: Uint8Array with explicit byteOffset+length window
  const windowed = new Uint8Array(memory.buffer, addr, 1);
  reads.push({ method: "Uint8Array(buf,off,1)", value: windowed[0] });

  // Path 5: Atomics.load on Int8Array view (forced atomicity — should
  // never be stale by definition; serves as the canonical answer).
  reads.push({
    method: "Atomics.load(Int8)",
    value: Atomics.load(new Int8Array(memory.buffer), addr) & 0xff,
  });

  // Path 6: subarray off a parent view
  const parent = new Uint8Array(memory.buffer);
  const sub = parent.subarray(addr, addr + 1);
  reads.push({ method: "subarray", value: sub[0] });

  const ok = reads.every((r) => r.value === marker);
  return { reads, ok };
}

function writeMarker(memory: WebAssembly.Memory, addr: number, marker: number): void {
  // Use the same path our real shim uses: `bytes(memory).set([marker], addr)`
  const mem = new Uint8Array(memory.buffer);
  mem[addr] = marker;
}

/**
 * Scenario 1: Allocate memory, write at various high page offsets that
 * the wasm allocator would manage (above what our shim has ever touched).
 * Don't grow; just write+read at addresses near the top of the initial
 * allocation.
 */
function scenarioWriteHighAddresses(initialPages: number, probeAddrs: number[]): DiagReport {
  const memory = new WebAssembly.Memory({
    initial: initialPages,
    maximum: 65536,
    shared: true,
  });
  const before = memory.buffer;
  const byteLengthBefore = before.byteLength;

  const probes: Probe[] = [];
  for (const addr of probeAddrs) {
    writeMarker(memory, addr, MARKER);
    const { reads, ok } = readBack(memory, addr, MARKER);
    probes.push({
      pageIdx: Math.floor(addr / 65536),
      offsetInPage: addr % 65536,
      addr,
      marker: MARKER,
      reads,
      ok,
    });
  }

  return {
    scenario: "write-then-read at high addresses (no grow)",
    initialPages,
    finalPages: memory.buffer.byteLength / 65536,
    bufferIdentityChanged: before !== memory.buffer,
    byteLengthBefore,
    byteLengthAfter: memory.buffer.byteLength,
    probes,
    anyMiss: probes.some((p) => !p.ok),
  };
}

/**
 * Scenario 2: Grow memory mid-test, then write+read at addresses that
 * land in the freshly-grown pages.  Tests whether buffer-identity change
 * is visible AND whether writes through pre-grow vs post-grow views work.
 */
function scenarioGrowThenWrite(initialPages: number, growBy: number, probeAddrs: number[]): DiagReport {
  const memory = new WebAssembly.Memory({
    initial: initialPages,
    maximum: 65536,
    shared: true,
  });
  const before = memory.buffer;
  const byteLengthBefore = before.byteLength;

  // Hold a stale view from BEFORE grow.  Some tests below may use it.
  // (Shared-memory: after grow, the OLD SAB stays valid and length grows
  // in-place.  Non-shared memory: OLD SAB is detached.  This is the spec
  // difference we want to confirm.)
  const staleView = new Uint8Array(memory.buffer);
  const staleViewByteLengthAtCreation = staleView.byteLength;

  memory.grow(growBy);

  const after = memory.buffer;
  const byteLengthAfter = after.byteLength;

  const probes: Probe[] = [];
  for (const addr of probeAddrs) {
    writeMarker(memory, addr, MARKER);
    const { reads, ok } = readBack(memory, addr, MARKER);
    probes.push({
      pageIdx: Math.floor(addr / 65536),
      offsetInPage: addr % 65536,
      addr,
      marker: MARKER,
      reads,
      ok,
    });
  }

  // Also probe whether the STALE view (constructed before grow) can see
  // writes done after grow at addresses that pre-existed.  Per spec, SAB
  // grow extends the buffer; the stale view's typed-array length is fixed
  // at construction but the underlying buffer is the same SAB.
  const lowAddr = (initialPages - 1) * 65536 + 100;
  writeMarker(memory, lowAddr, 0x55);
  const staleSawWrite = staleView[lowAddr] === 0x55;
  probes.push({
    pageIdx: Math.floor(lowAddr / 65536),
    offsetInPage: lowAddr % 65536,
    addr: lowAddr,
    marker: 0x55,
    reads: [
      { method: "stale Uint8Array (pre-grow)", value: staleView[lowAddr] },
      { method: "fresh Uint8Array", value: new Uint8Array(memory.buffer)[lowAddr] },
    ],
    ok: staleSawWrite,
  });

  return {
    scenario: `grow by ${growBy} pages then write at high addresses`,
    initialPages,
    finalPages: byteLengthAfter / 65536,
    bufferIdentityChanged: before !== after,
    byteLengthBefore,
    byteLengthAfter,
    probes,
    anyMiss: probes.some((p) => !p.ok),
    // tucked-on field for the stale-view question
    ...{ staleViewByteLengthAtCreation } as Record<string, unknown>,
  } as DiagReport;
}

/**
 * Scenario 3: Mirror the exact pattern of the real `getcwd` shim — write
 * 1 byte at a specific high address via Uint8Array.set, then read it back
 * via several view constructions.  Use addresses that match the
 * `__heap_base = 22060144` finding.  This is the closest pure-JS analog
 * to the production failure case.
 */
function scenarioMirrorGetcwd(initialPages: number, probeAddrs: number[]): DiagReport {
  const memory = new WebAssembly.Memory({
    initial: initialPages,
    maximum: 65536,
    shared: true,
  });
  const byteLengthBefore = memory.buffer.byteLength;

  const probes: Probe[] = [];
  for (const addr of probeAddrs) {
    // Mirror getcwd: zero a region, then mem.set the bytes.
    const enc = new TextEncoder().encode("/");
    const mem = new Uint8Array(memory.buffer);
    mem.fill(0, addr, addr + 64);
    mem.set(enc, addr);
    const { reads, ok } = readBack(memory, addr, MARKER);
    probes.push({
      pageIdx: Math.floor(addr / 65536),
      offsetInPage: addr % 65536,
      addr,
      marker: MARKER,
      reads,
      ok,
    });
  }
  return {
    scenario: "mirror real getcwd pattern (encode + fill + set)",
    initialPages,
    finalPages: memory.buffer.byteLength / 65536,
    bufferIdentityChanged: false,
    byteLengthBefore,
    byteLengthAfter: memory.buffer.byteLength,
    probes,
    anyMiss: probes.some((p) => !p.ok),
  };
}

export function runSabViewAliasingDiagnostic(): DiagReport[] {
  // Initial pages matches what edge uses (337) so addresses line up with
  // the real failure addresses observed in attempt #4.
  const initialPages = 337;
  const totalBytes = initialPages * 65536; // 22085632

  // High addresses spanning the suspected pages.  __heap_base = 22060144
  // is page 336, offset 60464.  Probe across pages 330..336 and into the
  // grown region (pages 337..341).
  const highAddrs: number[] = [];
  for (let p = 330; p < initialPages; p++) {
    highAddrs.push(p * 65536 + 100);
    highAddrs.push(p * 65536 + 32768);
    highAddrs.push(p * 65536 + 65535);
  }
  // Also probe near the very end of the initial buffer (the byte BEFORE
  // the boundary).
  highAddrs.push(totalBytes - 1);

  // For the grow-scenario probes, hit pages above the initial allocation.
  const grownAddrs: number[] = [];
  for (let p = initialPages; p < initialPages + 5; p++) {
    grownAddrs.push(p * 65536 + 100);
    grownAddrs.push(p * 65536 + 32768);
  }

  // Mirror-getcwd at the exact-page range we observed in attempt #4.
  const mirrorAddrs: number[] = [];
  for (let p = 335; p < initialPages; p++) {
    mirrorAddrs.push(p * 65536 + 1024);
  }

  return [
    scenarioWriteHighAddresses(initialPages, highAddrs),
    scenarioGrowThenWrite(initialPages, 5, grownAddrs),
    scenarioMirrorGetcwd(initialPages, mirrorAddrs),
  ];
}

export function formatReport(reports: DiagReport[]): string[] {
  const lines: string[] = [];
  lines.push("=== Hypothesis A diagnostic — SAB view aliasing ===");
  for (const r of reports) {
    lines.push("");
    lines.push(`[scenario] ${r.scenario}`);
    lines.push(
      `  pages: ${r.initialPages} → ${r.finalPages}  ` +
        `byteLength: ${r.byteLengthBefore} → ${r.byteLengthAfter}  ` +
        `buffer-identity-changed: ${r.bufferIdentityChanged}`,
    );
    const misses = r.probes.filter((p) => !p.ok);
    lines.push(`  probes: total=${r.probes.length}  misses=${misses.length}`);
    if (misses.length > 0) {
      // Print up to 5 miss details with all read paths.
      for (const m of misses.slice(0, 5)) {
        lines.push(`    MISS addr=${m.addr} (page ${m.pageIdx}, off ${m.offsetInPage}) marker=0x${m.marker.toString(16)}`);
        for (const r2 of m.reads) {
          const got = `0x${(r2.value & 0xff).toString(16).padStart(2, "0")}`;
          const tag = r2.value === m.marker ? "ok" : "MISS";
          lines.push(`      ${r2.method.padEnd(28)} → ${got}  [${tag}]`);
        }
      }
    } else {
      // Sample one passing probe so the reader sees the read paths exercised.
      const sample = r.probes[0];
      if (sample) {
        lines.push(`    sample passing probe at addr=${sample.addr}:`);
        for (const r2 of sample.reads) {
          lines.push(`      ${r2.method.padEnd(28)} → 0x${(r2.value & 0xff).toString(16).padStart(2, "0")}`);
        }
      }
    }
  }
  lines.push("");
  lines.push(
    `=== Verdict: ${reports.some((r) => r.anyMiss) ? "AT LEAST ONE MISS (Hypothesis A SUPPORTED)" : "all reads see all writes (Hypothesis A NOT SUPPORTED)"} ===`,
  );
  return lines;
}
