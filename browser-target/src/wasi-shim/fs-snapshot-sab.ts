// Cross-thread read-only file snapshot backed by SharedArrayBuffer.
//
// Why this exists.  Pool workers (libuv thread pool) need to do async fs
// ops, but file fds and FS-adapter state are JS-side objects that can't
// be shared across Web Workers.  Our previous setup had each worker
// instantiate its own bundled-fs — pool workers' opens failed because
// the wasm calls path_open via dirfd-relative paths and pool's adapter
// can't see main's cached fetches.  Even if they could open, the
// returned fd lived in the pool worker's local vfds Map, invisible to
// any other worker that subsequently reads or closes.
//
// This module makes file *data* live in SAB and gives every worker
// a shared view of "currently open files."  Reads are direct atomic
// SAB accesses with no RPC — the runtime backbone runs at memory speed.
// Only the cold-miss case (path first seen by any worker) requires
// coordination with main, which we handle via an in-SAB request ring.
//
// SAB layout
//   [0..GH)             global header: counters, ring head/tail, allocator next ptrs
//   [GH..RR)            request ring (cold-miss requests from pool → main)
//   [RR..PS)            path slots: metadata for each "known" file
//   [PS..PN)            path names region (variable-length UTF-8 strings, bump alloc)
//   [PN..FS)            FD slots: shared open-fd table
//   [FS..END)           data region (file contents, bump alloc)
//
// Lazy + cached.  First open of a path: pool worker enqueues a load
// request; main fetches via its layered FS adapter; main publishes the
// data into the data region and flips slot.status to LOADED; pool's
// Atomics.waitAsync on slot.status resolves; pool allocates an fd and
// returns.  All subsequent opens of the same path (from any worker)
// hit the loaded slot directly — no RPC, no notify.  fd_read is fully
// SAB-direct regardless of which worker.

// ---- Tunables ----

const NUM_PATH_SLOTS = 128;
const PATH_SLOT_SIZE = 32;
const PATH_NAMES_SIZE = 64 * 1024;        // 64KB for path strings
const NUM_FD_SLOTS = 256;
const FD_SLOT_SIZE = 16;
const DATA_REGION_SIZE = 24 * 1024 * 1024; // 24MB for file bytes
const REQUEST_RING_ENTRIES = 16;
const REQUEST_RING_ENTRY_SIZE = 512;
const REQUEST_RING_SIZE = REQUEST_RING_ENTRIES * REQUEST_RING_ENTRY_SIZE;

// ---- Layout offsets (computed from the above) ----

// Global header (64 bytes).
const GH_SIZE = 64;
const GH_OFF_DATA_NEXT   = 0;   // u32 atomic — bump allocator for data region
const GH_OFF_NAMES_NEXT  = 4;   // u32 atomic — bump allocator for path names
const GH_OFF_RING_HEAD   = 8;   // u32 atomic — main-side dequeue cursor
const GH_OFF_RING_TAIL   = 12;  // u32 atomic — pool-side enqueue cursor
const GH_OFF_RING_WAKE   = 16;  // u32 atomic — pool increments + notifies on enqueue
const GH_OFF_OPEN_COUNT  = 20;  // u32 atomic — total opens (all workers)
const GH_OFF_READ_COUNT  = 24;  // u32 atomic — total reads (all workers)
const GH_OFF_HIT_COUNT   = 28;  // u32 atomic — opens that hit a loaded slot
const GH_OFF_MISS_COUNT  = 32;  // u32 atomic — opens that needed an RPC load

const RR_OFFSET = GH_SIZE;
const PS_OFFSET = RR_OFFSET + REQUEST_RING_SIZE;
const PN_OFFSET = PS_OFFSET + NUM_PATH_SLOTS * PATH_SLOT_SIZE;
const FS_OFFSET = PN_OFFSET + PATH_NAMES_SIZE;
const DATA_OFFSET = FS_OFFSET + NUM_FD_SLOTS * FD_SLOT_SIZE;
const SAB_TOTAL = DATA_OFFSET + DATA_REGION_SIZE;

// Path slot fields (relative to slot base).
const PS_OFF_STATUS    = 0;   // u32 atomic — see PS_STATUS_*; negative = -errno
const PS_OFF_HASH      = 4;   // u32 — djb2 hash of the path (for fast prefilter)
const PS_OFF_NAME_OFF  = 8;   // u32 — byte offset into PATH_NAMES region
const PS_OFF_NAME_LEN  = 12;  // u32 — length of path string
const PS_OFF_DATA_OFF  = 16;  // u32 — byte offset into DATA region (relative to DATA_OFFSET)
const PS_OFF_DATA_SIZE = 20;  // u32 atomic — logical file size in bytes (≤ capacity)
const PS_OFF_REFCOUNT  = 24;  // u32 atomic — # of open fds against this slot
const PS_OFF_DATA_CAP  = 28;  // u32 — allocated buffer capacity (writable slots only)

const PS_STATUS_EMPTY    = 0;
const PS_STATUS_LOADING  = 1;  // read-only: main is fetching
const PS_STATUS_LOADED   = 2;  // read-only: data ready, immutable
const PS_STATUS_WRITABLE = 3;  // read-write: in-memory file with pre-allocated buffer

// Writable slot buffer size.  Fixed per slot — the data region is
// bump-allocated, so we can't grow a slot in place.  Most edge.js
// write workloads (small tmpfiles, OPFS-shim writes, log lines) fit
// in 1MB; anything larger returns ENOSPC.  Bumping this just costs
// SAB headroom up front (currently 24MB data region ÷ 1MB = up to
// 24 writable files concurrently before the bump allocator fails).
const WRITABLE_CAPACITY = 1024 * 1024;

// FD slot fields.
const FD_OFF_ALIVE     = 0;   // u32 atomic — 0=free, 1=in use
const FD_OFF_PATH_SLOT = 4;   // u32 — index into path slots
const FD_OFF_POSITION  = 8;   // u32 atomic — current read position (size < 4GB)

// Request ring entry layout (one record per slot in the ring):
//   [0..4)   u32 atomic status        0=pending, 1=published, 2=consumed
//   [4..8)   u32 path_slot_idx        pre-claimed slot index that main should populate
//   [8..12)  u32 path_len             length of path bytes
//   [12..)   path bytes (UTF-8)       up to REQUEST_RING_ENTRY_SIZE - 12 bytes
const RR_OFF_STATUS    = 0;
const RR_OFF_SLOT_IDX  = 4;
const RR_OFF_PATH_LEN  = 8;
const RR_OFF_PATH      = 12;
const RR_MAX_PATH = REQUEST_RING_ENTRY_SIZE - RR_OFF_PATH;
const RR_STATUS_PENDING   = 0;
const RR_STATUS_PUBLISHED = 1;
const RR_STATUS_CONSUMED  = 2;

// ---- FD numbering ----

export const FS_FD_BASE = 6000;
export const FS_FD_MAX = FS_FD_BASE + NUM_FD_SLOTS;

export function isFsFd(fd: number): boolean {
  return fd >= FS_FD_BASE && fd < FS_FD_MAX;
}
export function fsFdSlot(fd: number): number {
  return fd - FS_FD_BASE;
}

// ---- Hash ----

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ---- Path normalization (must match how wasi-shim normalizes) ----

function normalize(path: string): string {
  if (path.length === 0) return "/";
  return path.startsWith("/") ? path : "/" + path;
}

// ---- Public types ----

export interface OpenResult {
  fd: number;
  pathSlotIdx: number;
  dataSize: number;
}

export interface PendingRequest {
  ringIdx: number;
  slotIdx: number;
  path: string;
}

export class FsSnapshotRegistry {
  private readonly sab: SharedArrayBuffer;
  private readonly i32: Int32Array;
  private readonly u8: Uint8Array;
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder("utf-8");

  private constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.i32 = new Int32Array(sab);
    this.u8 = new Uint8Array(sab);
  }

  static create(): FsSnapshotRegistry {
    const sab = new SharedArrayBuffer(SAB_TOTAL);
    const reg = new FsSnapshotRegistry(sab);
    // Initialize the bump allocators so the first allocation hands out
    // offset 0 of each region.  Atomics.store handles the initial value
    // (also matches reattach semantics: 0 means "nothing allocated yet").
    Atomics.store(reg.i32, GH_OFF_DATA_NEXT >>> 2, 0);
    Atomics.store(reg.i32, GH_OFF_NAMES_NEXT >>> 2, 0);
    Atomics.store(reg.i32, GH_OFF_RING_HEAD >>> 2, 0);
    Atomics.store(reg.i32, GH_OFF_RING_TAIL >>> 2, 0);
    return reg;
  }

  static attach(sab: SharedArrayBuffer): FsSnapshotRegistry {
    if (sab.byteLength !== SAB_TOTAL) {
      throw new Error(`FsSnapshotRegistry.attach: SAB size ${sab.byteLength} != expected ${SAB_TOTAL}`);
    }
    return new FsSnapshotRegistry(sab);
  }

  get sharedBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  // ---- Stats ----

  stats(): { opens: number; reads: number; hits: number; misses: number } {
    return {
      opens: Atomics.load(this.i32, GH_OFF_OPEN_COUNT >>> 2),
      reads: Atomics.load(this.i32, GH_OFF_READ_COUNT >>> 2),
      hits: Atomics.load(this.i32, GH_OFF_HIT_COUNT >>> 2),
      misses: Atomics.load(this.i32, GH_OFF_MISS_COUNT >>> 2),
    };
  }

  // ---- Path-slot lookup / claim ----

  private psI32(slot: number, off: number): number {
    return (PS_OFFSET + slot * PATH_SLOT_SIZE + off) >>> 2;
  }
  private readSlotName(slot: number): string {
    const off = Atomics.load(this.i32, this.psI32(slot, PS_OFF_NAME_OFF));
    const len = Atomics.load(this.i32, this.psI32(slot, PS_OFF_NAME_LEN));
    if (len === 0) return "";
    // TextDecoder rejects SAB-backed views; copy to a plain ArrayBuffer.
    const copy = new Uint8Array(len);
    copy.set(this.u8.subarray(PN_OFFSET + off, PN_OFFSET + off + len));
    return this.dec.decode(copy);
  }

  /** Find any slot currently loading or already loaded for `path`.  Used by
   *  pool worker to coordinate with whoever else might be loading it. */
  private findAnyForPath(path: string, hash: number): number {
    for (let slot = 0; slot < NUM_PATH_SLOTS; slot++) {
      const status = Atomics.load(this.i32, this.psI32(slot, PS_OFF_STATUS));
      if (status === PS_STATUS_EMPTY) continue;
      const slotHash = Atomics.load(this.i32, this.psI32(slot, PS_OFF_HASH));
      if (slotHash !== hash) continue;
      if (this.readSlotName(slot) === path) return slot;
    }
    return -1;
  }

  /** Claim an empty path slot atomically.  Returns slot index or -1 if
   *  the table is full.  After claiming, caller must populate hash, path
   *  name and (later) data, then flip status to LOADED. */
  private claimEmptyPathSlot(): number {
    for (let slot = 0; slot < NUM_PATH_SLOTS; slot++) {
      const idx = this.psI32(slot, PS_OFF_STATUS);
      if (Atomics.compareExchange(this.i32, idx, PS_STATUS_EMPTY, PS_STATUS_LOADING) === PS_STATUS_EMPTY) {
        return slot;
      }
    }
    return -1;
  }

  /** Bump-allocate `len` bytes from a region (NAMES or DATA).  Returns
   *  the offset, or -1 if exhausted. */
  private bumpAlloc(nextOffField: number, capacity: number, len: number): number {
    // Round up to 4 bytes so subsequent atomic ops are aligned.
    const padded = (len + 3) & ~3;
    while (true) {
      const cur = Atomics.load(this.i32, nextOffField >>> 2);
      const after = cur + padded;
      if (after > capacity) return -1;
      if (Atomics.compareExchange(this.i32, nextOffField >>> 2, cur, after) === cur) {
        return cur;
      }
    }
  }

  // ---- Main-side: publish a load result ----

  /** Called by main after fetching a file's bytes.  Allocates a data
   *  region, copies bytes in, fills path slot fields, flips status to
   *  LOADED, and notifies any waiter.  Returns the slot index on
   *  success, or -1 on capacity exhaustion. */
  publishLoaded(path: string, bytes: Uint8Array, slotIdx: number): number {
    const nameBytes = this.enc.encode(path);
    const nameOff = this.bumpAlloc(GH_OFF_NAMES_NEXT, PATH_NAMES_SIZE, nameBytes.length);
    if (nameOff < 0) {
      Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_STATUS), -28); // ENOSPC-ish
      Atomics.notify(this.i32, this.psI32(slotIdx, PS_OFF_STATUS));
      return -1;
    }
    this.u8.set(nameBytes, PN_OFFSET + nameOff);
    const dataOff = this.bumpAlloc(GH_OFF_DATA_NEXT, DATA_REGION_SIZE, bytes.length);
    if (dataOff < 0) {
      Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_STATUS), -28);
      Atomics.notify(this.i32, this.psI32(slotIdx, PS_OFF_STATUS));
      return -1;
    }
    this.u8.set(bytes, DATA_OFFSET + dataOff);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_HASH), djb2(path));
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_NAME_OFF), nameOff);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_NAME_LEN), nameBytes.length);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_DATA_OFF), dataOff);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_DATA_SIZE), bytes.length);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_DATA_CAP), bytes.length);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_STATUS), PS_STATUS_LOADED);
    Atomics.notify(this.i32, this.psI32(slotIdx, PS_OFF_STATUS));
    return slotIdx;
  }

  // ---- Writable open / write ----
  //
  // Writable files live in the same SAB data region as read-only files
  // but each slot pre-allocates a fixed-size buffer (WRITABLE_CAPACITY).
  // The "logical size" (DATA_SIZE) starts at 0 (or at the imported
  // size on truncate-existing) and grows on write up to the capacity.
  // Concurrent fd_write on the same fd uses an atomic position FAA.

  /** Open or create a writable file at `path`.  If the path already
   *  has a slot:
   *   - LOADED (read-only) + truncate: error EROFS (won't promote a
   *     bundled file to writable — those are immutable).
   *   - WRITABLE: reuse the slot.  Optionally truncate.
   *   - LOADING / negative status: error.
   *  If no slot exists: claim an empty slot, allocate buffer, mark
   *  WRITABLE.  Returns slotIdx on success or -errno on failure. */
  openWritable(path: string, opts: { truncate?: boolean; create?: boolean }): number {
    const normalized = normalize(path);
    const hash = djb2(normalized);
    const existing = this.findAnyForPath(normalized, hash);
    if (existing >= 0) {
      const status = Atomics.load(this.i32, this.psI32(existing, PS_OFF_STATUS));
      if (status === PS_STATUS_WRITABLE) {
        if (opts.truncate) {
          Atomics.store(this.i32, this.psI32(existing, PS_OFF_DATA_SIZE), 0);
        }
        return existing;
      }
      if (status === PS_STATUS_LOADED) {
        return -30; // EROFS — bundled snapshot files are immutable
      }
      return -16; // EBUSY — slot is in some other state (loading, error)
    }
    if (!opts.create) {
      // O_RDWR without O_CREAT on a non-existent path: ENOENT.
      return -44;
    }
    const slotIdx = this.claimEmptyPathSlot();
    if (slotIdx < 0) return -28; // ENOSPC (slot table full)
    // Stamp name + hash before flipping status so concurrent lookups
    // see a consistent record.
    const nameBytes = this.enc.encode(normalized);
    const nameOff = this.bumpAlloc(GH_OFF_NAMES_NEXT, PATH_NAMES_SIZE, nameBytes.length);
    if (nameOff < 0) {
      Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_STATUS), PS_STATUS_EMPTY);
      return -28;
    }
    this.u8.set(nameBytes, PN_OFFSET + nameOff);
    const dataOff = this.bumpAlloc(GH_OFF_DATA_NEXT, DATA_REGION_SIZE, WRITABLE_CAPACITY);
    if (dataOff < 0) {
      Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_STATUS), PS_STATUS_EMPTY);
      return -28;
    }
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_HASH), hash);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_NAME_OFF), nameOff);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_NAME_LEN), nameBytes.length);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_DATA_OFF), dataOff);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_DATA_SIZE), 0);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_DATA_CAP), WRITABLE_CAPACITY);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_STATUS), PS_STATUS_WRITABLE);
    Atomics.notify(this.i32, this.psI32(slotIdx, PS_OFF_STATUS));
    return slotIdx;
  }

  /** Write bytes to a writable fd at its current position.  Atomically
   *  advances position by the number of bytes written.  Returns bytes
   *  written; 0 on capacity exhaustion (caller maps to ENOSPC).
   *  Updates the slot's DATA_SIZE if position+written exceeds it. */
  write(fd: number, src: Uint8Array): number {
    const slot = fsFdSlot(fd);
    if (slot < 0 || slot >= NUM_FD_SLOTS) return -1;
    if (Atomics.load(this.i32, this.fdI32(slot, FD_OFF_ALIVE)) !== 1) return -1;
    const pathSlot = Atomics.load(this.i32, this.fdI32(slot, FD_OFF_PATH_SLOT));
    const status = Atomics.load(this.i32, this.psI32(pathSlot, PS_OFF_STATUS));
    if (status !== PS_STATUS_WRITABLE) return -1; // read-only or invalid
    const capacity = Atomics.load(this.i32, this.psI32(pathSlot, PS_OFF_DATA_CAP));
    const dataOff = Atomics.load(this.i32, this.psI32(pathSlot, PS_OFF_DATA_OFF));
    const positionIdx = this.fdI32(slot, FD_OFF_POSITION);
    const sizeIdx = this.psI32(pathSlot, PS_OFF_DATA_SIZE);
    while (true) {
      const pos = Atomics.load(this.i32, positionIdx);
      if (pos >= capacity) return 0;
      const space = capacity - pos;
      const toWrite = Math.min(space, src.length);
      if (Atomics.compareExchange(this.i32, positionIdx, pos, pos + toWrite) === pos) {
        const start = DATA_OFFSET + dataOff + pos;
        for (let i = 0; i < toWrite; i++) this.u8[start + i] = src[i]!;
        // Bump logical size if our write extended it.  Other writers
        // racing on a different position might have already pushed it
        // further; only store-if-greater.
        while (true) {
          const curSize = Atomics.load(this.i32, sizeIdx);
          const want = pos + toWrite;
          if (want <= curSize) break;
          if (Atomics.compareExchange(this.i32, sizeIdx, curSize, want) === curSize) break;
        }
        return toWrite;
      }
    }
  }

  /** Called by main when a load fails.  Mark the slot with an errno
   *  encoded as -errno (negative status field).  Waiters wake and see
   *  the error. */
  publishError(slotIdx: number, errno: number): void {
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_STATUS), -errno);
    Atomics.notify(this.i32, this.psI32(slotIdx, PS_OFF_STATUS));
  }

  // ---- Pool-side: open a path ----

  /** Look up a path.  Returns one of:
   *  - { kind: "loaded", slotIdx, dataSize }
   *  - { kind: "loading", slotIdx }  — someone else is loading; wait
   *  - { kind: "miss" }              — need to enqueue a load request */
  lookup(path: string): { kind: "loaded"; slotIdx: number; dataSize: number }
                     | { kind: "loading"; slotIdx: number }
                     | { kind: "miss" } {
    const normalized = normalize(path);
    const hash = djb2(normalized);
    const slot = this.findAnyForPath(normalized, hash);
    if (slot < 0) return { kind: "miss" };
    const status = Atomics.load(this.i32, this.psI32(slot, PS_OFF_STATUS));
    // Both LOADED (immutable snapshot) and WRITABLE (in-memory file)
    // are "openable for read" — the rest of the slot fields are valid.
    if (status === PS_STATUS_LOADED || status === PS_STATUS_WRITABLE) {
      const dataSize = Atomics.load(this.i32, this.psI32(slot, PS_OFF_DATA_SIZE));
      Atomics.add(this.i32, GH_OFF_HIT_COUNT >>> 2, 1);
      return { kind: "loaded", slotIdx: slot, dataSize };
    }
    if (status === PS_STATUS_LOADING) {
      return { kind: "loading", slotIdx: slot };
    }
    if (status < 0) {
      // Negative status = errno.  Treat as "miss" so the pool worker
      // can retry (the slot will be claimed-fresh on retry — caller
      // doesn't need to know the failure was published).
      return { kind: "miss" };
    }
    return { kind: "miss" };
  }

  /** Enqueue a load request to main.  Claims an empty path slot atomically
   *  and writes the request into the ring.  Returns the slot index that
   *  the pool worker should wait on, or -1 if no slot/ring capacity. */
  enqueueLoad(path: string): number {
    const normalized = normalize(path);
    const slotIdx = this.claimEmptyPathSlot();
    if (slotIdx < 0) return -1;
    // Write the path bytes into the path-names region eagerly so other
    // workers can see what we're loading (matches findAnyForPath).
    const nameBytes = this.enc.encode(normalized);
    const nameOff = this.bumpAlloc(GH_OFF_NAMES_NEXT, PATH_NAMES_SIZE, nameBytes.length);
    if (nameOff < 0) {
      Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_STATUS), -28);
      return -1;
    }
    this.u8.set(nameBytes, PN_OFFSET + nameOff);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_HASH), djb2(normalized));
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_NAME_OFF), nameOff);
    Atomics.store(this.i32, this.psI32(slotIdx, PS_OFF_NAME_LEN), nameBytes.length);
    // Status is already LOADING (set by claimEmptyPathSlot's cmpxchg).

    // Enqueue request.  Ring is bounded; if full, fall back to error.
    const tail = Atomics.add(this.i32, GH_OFF_RING_TAIL >>> 2, 1);
    const ringIdx = tail % REQUEST_RING_ENTRIES;
    // Spin briefly if the slot we got is still in use by main.
    let spins = 0;
    while (true) {
      const status = Atomics.load(this.i32, (RR_OFFSET + ringIdx * REQUEST_RING_ENTRY_SIZE + RR_OFF_STATUS) >>> 2);
      if (status === RR_STATUS_PENDING || status === RR_STATUS_CONSUMED) break;
      if (spins++ > 1000) {
        // Ring is full or main is stuck.  Mark slot with error.
        this.publishError(slotIdx, 11); // EAGAIN
        return -1;
      }
    }
    const baseI32 = (RR_OFFSET + ringIdx * REQUEST_RING_ENTRY_SIZE) >>> 2;
    Atomics.store(this.i32, baseI32 + (RR_OFF_SLOT_IDX >>> 2), slotIdx);
    Atomics.store(this.i32, baseI32 + (RR_OFF_PATH_LEN >>> 2), Math.min(nameBytes.length, RR_MAX_PATH));
    const pathOff = RR_OFFSET + ringIdx * REQUEST_RING_ENTRY_SIZE + RR_OFF_PATH;
    this.u8.set(nameBytes.subarray(0, RR_MAX_PATH), pathOff);
    // Publish.
    Atomics.store(this.i32, baseI32 + (RR_OFF_STATUS >>> 2), RR_STATUS_PUBLISHED);
    Atomics.add(this.i32, GH_OFF_RING_WAKE >>> 2, 1);
    Atomics.notify(this.i32, GH_OFF_RING_WAKE >>> 2);
    Atomics.add(this.i32, GH_OFF_MISS_COUNT >>> 2, 1);
    return slotIdx;
  }

  /** Synchronously wait for a slot's status to become LOADED or an
   *  errno-error.  Returns the final status. */
  waitOnSlot(slotIdx: number, timeoutMs = 30_000): number {
    const idx = this.psI32(slotIdx, PS_OFF_STATUS);
    while (true) {
      const status = Atomics.load(this.i32, idx);
      if (status !== PS_STATUS_LOADING) return status;
      const result = Atomics.wait(this.i32, idx, PS_STATUS_LOADING, timeoutMs);
      if (result === "timed-out") return Atomics.load(this.i32, idx);
    }
  }

  // ---- Main-side: drain the request ring ----

  /** Read the next pending request.  Returns null if the ring is empty.
   *  Caller must call `markConsumed(ringIdx)` after processing. */
  drainNext(): PendingRequest | null {
    const head = Atomics.load(this.i32, GH_OFF_RING_HEAD >>> 2);
    const tail = Atomics.load(this.i32, GH_OFF_RING_TAIL >>> 2);
    if (head >= tail) return null;
    const ringIdx = head % REQUEST_RING_ENTRIES;
    const baseI32 = (RR_OFFSET + ringIdx * REQUEST_RING_ENTRY_SIZE) >>> 2;
    const status = Atomics.load(this.i32, baseI32 + (RR_OFF_STATUS >>> 2));
    if (status !== RR_STATUS_PUBLISHED) return null;
    const slotIdx = Atomics.load(this.i32, baseI32 + (RR_OFF_SLOT_IDX >>> 2));
    const pathLen = Atomics.load(this.i32, baseI32 + (RR_OFF_PATH_LEN >>> 2));
    const pathOff = RR_OFFSET + ringIdx * REQUEST_RING_ENTRY_SIZE + RR_OFF_PATH;
    const copy = new Uint8Array(pathLen);
    copy.set(this.u8.subarray(pathOff, pathOff + pathLen));
    const path = this.dec.decode(copy);
    return { ringIdx, slotIdx, path };
  }

  markConsumed(ringIdx: number): void {
    const baseI32 = (RR_OFFSET + ringIdx * REQUEST_RING_ENTRY_SIZE) >>> 2;
    Atomics.store(this.i32, baseI32 + (RR_OFF_STATUS >>> 2), RR_STATUS_CONSUMED);
    Atomics.add(this.i32, GH_OFF_RING_HEAD >>> 2, 1);
  }

  // ---- FD allocation / read / close ----

  private fdI32(slot: number, off: number): number {
    return (FS_OFFSET + slot * FD_SLOT_SIZE + off) >>> 2;
  }

  /** Allocate an fd against a loaded path slot.  Bumps the path slot's
   *  refcount.  Returns the fd number (FS_FD_BASE-relative) or -1 if
   *  the table is full. */
  allocFd(pathSlotIdx: number): number {
    for (let slot = 0; slot < NUM_FD_SLOTS; slot++) {
      const idx = this.fdI32(slot, FD_OFF_ALIVE);
      if (Atomics.compareExchange(this.i32, idx, 0, 1) === 0) {
        Atomics.store(this.i32, this.fdI32(slot, FD_OFF_PATH_SLOT), pathSlotIdx);
        Atomics.store(this.i32, this.fdI32(slot, FD_OFF_POSITION), 0);
        Atomics.add(this.i32, this.psI32(pathSlotIdx, PS_OFF_REFCOUNT), 1);
        Atomics.add(this.i32, GH_OFF_OPEN_COUNT >>> 2, 1);
        return FS_FD_BASE + slot;
      }
    }
    return -1;
  }

  read(fd: number, dst: Uint8Array): number {
    const slot = fsFdSlot(fd);
    if (slot < 0 || slot >= NUM_FD_SLOTS) return -1;
    if (Atomics.load(this.i32, this.fdI32(slot, FD_OFF_ALIVE)) !== 1) return -1;
    const pathSlot = Atomics.load(this.i32, this.fdI32(slot, FD_OFF_PATH_SLOT));
    const dataOff = Atomics.load(this.i32, this.psI32(pathSlot, PS_OFF_DATA_OFF));
    const dataSize = Atomics.load(this.i32, this.psI32(pathSlot, PS_OFF_DATA_SIZE));
    // Atomic fetch-add on position: POSIX-correct for concurrent fd_read
    // on the same fd (rare but well-defined).
    const positionIdx = this.fdI32(slot, FD_OFF_POSITION);
    while (true) {
      const pos = Atomics.load(this.i32, positionIdx);
      if (pos >= dataSize) return 0;
      const available = dataSize - pos;
      const toRead = Math.min(available, dst.length);
      if (Atomics.compareExchange(this.i32, positionIdx, pos, pos + toRead) === pos) {
        const start = DATA_OFFSET + dataOff + pos;
        for (let i = 0; i < toRead; i++) dst[i] = this.u8[start + i]!;
        Atomics.add(this.i32, GH_OFF_READ_COUNT >>> 2, 1);
        return toRead;
      }
    }
  }

  /** Return file size for fstat. */
  fdSize(fd: number): number {
    const slot = fsFdSlot(fd);
    if (slot < 0 || slot >= NUM_FD_SLOTS) return -1;
    if (Atomics.load(this.i32, this.fdI32(slot, FD_OFF_ALIVE)) !== 1) return -1;
    const pathSlot = Atomics.load(this.i32, this.fdI32(slot, FD_OFF_PATH_SLOT));
    return Atomics.load(this.i32, this.psI32(pathSlot, PS_OFF_DATA_SIZE));
  }

  close(fd: number): boolean {
    const slot = fsFdSlot(fd);
    if (slot < 0 || slot >= NUM_FD_SLOTS) return false;
    if (Atomics.compareExchange(this.i32, this.fdI32(slot, FD_OFF_ALIVE), 1, 0) !== 1) return false;
    const pathSlot = Atomics.load(this.i32, this.fdI32(slot, FD_OFF_PATH_SLOT));
    Atomics.sub(this.i32, this.psI32(pathSlot, PS_OFF_REFCOUNT), 1);
    return true;
  }
}
