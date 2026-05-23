// SAB-backed request ring primitive.
//
// One primitive backing the cross-worker request/reply channels: today's
// HTTP bridge, the FS cold-miss request ring inside fs-snapshot-sab, and
// (L3+) the napi RPC channel.  pipes-sab keeps its own per-slot ring
// buffers (different shape — bidirectional streams, not request/reply)
// but uses this header layout where it can.
//
// SAB layout
//
//   [0..G)                global header
//                            +0   wakeCounter (i32 atomic; writer notifies)
//                            +4   reserved (3 × i32) — for caller use
//   [G..G+N*S)            slots (N × S bytes each)
//                            slot header (16 bytes):
//                              +0   status (i32 atomic): EMPTY / WRITING / READY / READING
//                              +4   contextId (u32)      — emnapi context selector
//                              +8   hostWorkerId (u32)   — host worker context selector
//                              +12  payloadLen (u32)
//                            payload follows directly after header
//
// State machine
//
//   EMPTY ──tryClaim──> WRITING ──publish──> READY ──tryConsume──> READING ──free──> EMPTY
//
// Writers cmpxchg from EMPTY→WRITING to claim, fill payload, then store
// status=READY and increment+notify wakeCounter.  Readers waitAsync on
// wakeCounter, then drainRing() returns all currently-READY slots; the
// drain pass cmpxchgs each from READY→READING so two concurrent readers
// don't double-consume.  Reader calls freeSlot after handling.
//
// Wake protocol
//
// Writers always Atomics.add(wakeCounter, 1) + Atomics.notify(...,1).
// Readers waitAsync(wakeCounter, lastSeen) and re-load lastSeen after
// drain so they don't miss racing writes.
//
// contextId + hostWorkerId reservation
//
// Both fields are present even when N=1; they let future worker_threads
// work route messages to the right host worker / emnapi context without
// changing the protocol.

const HEADER_RESERVED_WORDS = 4; // 16 bytes; +0 wakeCounter, +4/+8/+12 reserved

export const WAKE_COUNTER_OFFSET = 0;
export const GLOBAL_HEADER_SIZE = HEADER_RESERVED_WORDS * 4;

export const SLOT_HEADER_SIZE = 16;
export const SLOT_HEADER_STATUS = 0;
export const SLOT_HEADER_CONTEXT_ID = 4;
export const SLOT_HEADER_HOST_WORKER_ID = 8;
export const SLOT_HEADER_PAYLOAD_LEN = 12;

export const STATUS_EMPTY = 0;
export const STATUS_WRITING = 1;
export const STATUS_READY = 2;
export const STATUS_READING = 3;

export interface RingConfig {
  /** Number of slots in the ring. */
  numSlots: number;
  /** Bytes per slot (must be >= SLOT_HEADER_SIZE; payload is slotSize - 16). */
  slotSize: number;
}

export interface RingView {
  readonly sab: SharedArrayBuffer;
  readonly i32: Int32Array;
  readonly u8: Uint8Array;
  readonly config: RingConfig;
  readonly totalSize: number;
}

export interface RingMessage {
  slot: number;
  contextId: number;
  hostWorkerId: number;
  /** Subarray view; ONLY valid until freeSlot(slot) is called. */
  payload: Uint8Array;
}

// Cache native intrinsics at module load — edge mutates globalThis
// during bootstrap (see NOTES.md globalthis-mutation debt).
const NativeAtomics = Atomics;
const NativeInt32Array = Int32Array;
const NativeUint8Array = Uint8Array;

export function ringByteSize(config: RingConfig): number {
  if (config.slotSize < SLOT_HEADER_SIZE) {
    throw new RangeError(`sab-ring: slotSize ${config.slotSize} < SLOT_HEADER_SIZE ${SLOT_HEADER_SIZE}`);
  }
  return GLOBAL_HEADER_SIZE + config.numSlots * config.slotSize;
}

export function createRing(config: RingConfig): RingView {
  const totalSize = ringByteSize(config);
  const sab = new SharedArrayBuffer(totalSize);
  return {
    sab,
    i32: new NativeInt32Array(sab),
    u8: new NativeUint8Array(sab),
    config,
    totalSize,
  };
}

export function attachRing(sab: SharedArrayBuffer, config: RingConfig): RingView {
  const expected = ringByteSize(config);
  if (sab.byteLength < expected) {
    throw new RangeError(`sab-ring: attached SAB ${sab.byteLength} < expected ${expected}`);
  }
  return {
    sab,
    i32: new NativeInt32Array(sab),
    u8: new NativeUint8Array(sab),
    config,
    totalSize: sab.byteLength,
  };
}

function slotByteOffset(ring: RingView, slot: number): number {
  return GLOBAL_HEADER_SIZE + slot * ring.config.slotSize;
}

function slotI32Idx(ring: RingView, slot: number, fieldByteOff: number): number {
  return (slotByteOffset(ring, slot) + fieldByteOff) >>> 2;
}

/** Try to claim an empty slot for writing.  Returns slot index, or -1 on full.
 *
 * Caller writes contextId + hostWorkerId headers and payload, then calls
 * publishSlot() to make it READY.  If the caller never publishes, the
 * slot stays in WRITING state — at most numSlots are wasted; cleanup
 * happens via freeSlot in the publish path.
 *
 * Scans linearly from slot 0; if you want fairness across hot writers,
 * pass a hint in the optional `startHint` arg (default 0).
 */
export function tryClaimSlot(
  ring: RingView,
  hostWorkerId: number,
  contextId: number,
  startHint = 0,
): number {
  const { numSlots } = ring.config;
  for (let i = 0; i < numSlots; i++) {
    const slot = (startHint + i) % numSlots;
    const statusIdx = slotI32Idx(ring, slot, SLOT_HEADER_STATUS);
    const prev = NativeAtomics.compareExchange(ring.i32, statusIdx, STATUS_EMPTY, STATUS_WRITING);
    if (prev === STATUS_EMPTY) {
      // Header fields (relaxed stores OK — status==WRITING fences for us).
      ring.i32[slotI32Idx(ring, slot, SLOT_HEADER_CONTEXT_ID)] = contextId;
      ring.i32[slotI32Idx(ring, slot, SLOT_HEADER_HOST_WORKER_ID)] = hostWorkerId;
      ring.i32[slotI32Idx(ring, slot, SLOT_HEADER_PAYLOAD_LEN)] = 0;
      return slot;
    }
  }
  return -1;
}

/** Get the payload byte range for a claimed (WRITING) or ready (READY/READING) slot.
 *  Writer fills, sets payloadLen, then calls publishSlot. */
export function payloadBytes(ring: RingView, slot: number): Uint8Array {
  const start = slotByteOffset(ring, slot) + SLOT_HEADER_SIZE;
  const cap = ring.config.slotSize - SLOT_HEADER_SIZE;
  return ring.u8.subarray(start, start + cap);
}

export function payloadCapacity(ring: RingView): number {
  return ring.config.slotSize - SLOT_HEADER_SIZE;
}

/** Mark a slot as READY and wake the reader.  Caller must have set
 *  payload bytes BEFORE calling this — the status store fences our write. */
export function publishSlot(ring: RingView, slot: number, payloadLen: number): void {
  if (payloadLen < 0 || payloadLen > payloadCapacity(ring)) {
    throw new RangeError(`sab-ring: publishSlot payloadLen ${payloadLen} out of range`);
  }
  ring.i32[slotI32Idx(ring, slot, SLOT_HEADER_PAYLOAD_LEN)] = payloadLen;
  NativeAtomics.store(ring.i32, slotI32Idx(ring, slot, SLOT_HEADER_STATUS), STATUS_READY);
  // Wake the reader.  Wake counter at fixed offset 0 of global header.
  NativeAtomics.add(ring.i32, WAKE_COUNTER_OFFSET >>> 2, 1);
  NativeAtomics.notify(ring.i32, WAKE_COUNTER_OFFSET >>> 2, /* count */ 1);
}

/** Scan all slots and return any that are READY, atomically transitioning
 *  them to READING.  Caller must call freeSlot(slot) on each returned
 *  message after processing the payload.  Payload views are aliased into
 *  the SAB — only valid until freeSlot is called.
 *
 *  Safe to call concurrently from multiple readers; cmpxchg ensures only
 *  one reader claims each slot.
 */
export function drainRing(ring: RingView): RingMessage[] {
  const { numSlots } = ring.config;
  const out: RingMessage[] = [];
  for (let slot = 0; slot < numSlots; slot++) {
    const statusIdx = slotI32Idx(ring, slot, SLOT_HEADER_STATUS);
    const prev = NativeAtomics.compareExchange(ring.i32, statusIdx, STATUS_READY, STATUS_READING);
    if (prev !== STATUS_READY) continue;
    const contextId = ring.i32[slotI32Idx(ring, slot, SLOT_HEADER_CONTEXT_ID)] >>> 0;
    const hostWorkerId = ring.i32[slotI32Idx(ring, slot, SLOT_HEADER_HOST_WORKER_ID)] >>> 0;
    const payloadLen = ring.i32[slotI32Idx(ring, slot, SLOT_HEADER_PAYLOAD_LEN)] >>> 0;
    const start = slotByteOffset(ring, slot) + SLOT_HEADER_SIZE;
    out.push({
      slot,
      contextId,
      hostWorkerId,
      payload: ring.u8.subarray(start, start + payloadLen),
    });
  }
  return out;
}

/** Return a slot to the EMPTY pool.  Must be called after processing
 *  a drained message; otherwise the slot stays WRITING/READING forever. */
export function freeSlot(ring: RingView, slot: number): void {
  NativeAtomics.store(ring.i32, slotI32Idx(ring, slot, SLOT_HEADER_STATUS), STATUS_EMPTY);
}

/** Read current wake-counter value (snapshot before waiting). */
export function readWakeCounter(ring: RingView): number {
  return NativeAtomics.load(ring.i32, WAKE_COUNTER_OFFSET >>> 2);
}

/** Async wait for the wake counter to advance past `lastSeen`.
 *  Resolves to either "ok" (woken) or "timed-out".  If Atomics.waitAsync
 *  is unavailable, falls back to sync wait (BLOCKS thread).
 */
export function waitForReadyAsync(
  ring: RingView,
  lastSeen: number,
  timeoutMs?: number,
): Promise<"ok" | "timed-out"> {
  const idx = WAKE_COUNTER_OFFSET >>> 2;
  const waitAsync = (NativeAtomics as unknown as {
    waitAsync?: (i32: Int32Array, idx: number, val: number, timeout: number) =>
      { async: boolean; value: Promise<"ok" | "timed-out"> | "not-equal" };
  }).waitAsync;
  if (!waitAsync) {
    // No waitAsync available — fall back to sync.  Will block thread.
    const result = NativeAtomics.wait(ring.i32, idx, lastSeen, timeoutMs ?? Infinity);
    return Promise.resolve(result === "timed-out" ? "timed-out" : "ok");
  }
  const result = waitAsync(ring.i32, idx, lastSeen, timeoutMs ?? Infinity);
  if (!result.async) {
    // Counter already advanced or invalid.  Return immediately.
    return Promise.resolve("ok");
  }
  return result.value as Promise<"ok" | "timed-out">;
}

/** Sync wait variant.  BLOCKS the calling thread.  Only safe in workers
 *  that don't host user JS or other responsive responsibilities (e.g.,
 *  pool workers).  Main / host worker should use waitForReadyAsync. */
export function waitForReadySync(
  ring: RingView,
  lastSeen: number,
  timeoutMs?: number,
): "ok" | "timed-out" | "not-equal" {
  const result = NativeAtomics.wait(
    ring.i32,
    WAKE_COUNTER_OFFSET >>> 2,
    lastSeen,
    timeoutMs ?? Infinity,
  );
  return result;
}
