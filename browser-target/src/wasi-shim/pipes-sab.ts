// Cross-thread WASI pipes backed by SharedArrayBuffer.
//
// Why this exists.  Real POSIX pipes are kernel objects: any thread in the
// process can read or write the same pipe fd.  Our previous fd_pipe lived in
// a per-worker JS `Map`, so each Web Worker had its own pipe state.  When
// libuv's pool worker called `uv_async_send` to wake main (a pipe write
// internally), the bytes went into the pool worker's own JS map — main never
// saw them, and `fs.promises.readFile` hung after the pool dispatched the
// open call.
//
// This module fixes the primitive itself: pipe state lives in a SAB region
// allocated once at boot and shared with every worker (main + libuv pool +
// future child_process workers).  Any worker's wasi-shim can read or write
// any pipe by slot index.  poll_oneoff watches the per-pipe wake counter via
// Atomics.waitAsync so a write from any worker unblocks the reader.
//
// SAB layout
//   [0..HEADER_SIZE)        : per-slot fixed headers (NUM_SLOTS * SLOT_HDR_SIZE)
//   [HEADER_SIZE..TOTAL)    : per-slot ring buffers (NUM_SLOTS * BUFFER_SIZE)
//
// Slot header layout (32 bytes, all u32 little-endian):
//    0  alive          0=free, 1=in use (cmpxchg-allocated)
//    4  capacity       buffer size in bytes (== BUFFER_SIZE)
//    8  head           read cursor (monotonic, mod capacity for index)
//   12  tail           write cursor (monotonic, mod capacity for index)
//   16  wakeCounter    Atomics.waitAsync target, incremented on every write
//   20  bufferOffset   absolute offset into SAB for this slot's buffer
//   24  refCount       number of open fds referring to this pipe (read+write)
//   28  reserved
//
// FD numbering: PIPE_FD_BASE + slot * 2 + (writeEnd ? 1 : 0).  Using a high
// base (5000) avoids collision with the existing per-worker vfd numbering
// (path_open / urandom etc).  All pipe fds carry their own slot index in
// the fd number, so any worker can decode the slot without a side table.

// Global diagnostic header at the very start of the SAB.  Atomic u32
// counters incremented on every write/read by any worker — gives a
// single global view of pipe activity that's readable from any worker
// (including pool workers, whose JS event loop is starved by sync
// Atomics.wait and so can't drain a setInterval diagnostic).
const GLOBAL_HDR_SIZE = 32;
const G_OFF_W_COUNT = 0;
const G_OFF_R_COUNT = 4;
const G_OFF_W_BYTES = 8;
const G_OFF_R_BYTES = 12;

const NUM_SLOTS = 64;
const SLOT_HDR_SIZE = 32;
const BUFFER_SIZE = 4096;
const HEADER_TOTAL = NUM_SLOTS * SLOT_HDR_SIZE;
const BODY_TOTAL = NUM_SLOTS * BUFFER_SIZE;
const SAB_TOTAL = GLOBAL_HDR_SIZE + HEADER_TOTAL + BODY_TOTAL;

const OFF_ALIVE = 0;
const OFF_CAPACITY = 4;
const OFF_HEAD = 8;
const OFF_TAIL = 12;
const OFF_WAKE = 16;
const OFF_BUF_OFF = 20;
const OFF_REFCOUNT = 24;

export const PIPE_FD_BASE = 5000;
export const PIPE_FD_MAX = PIPE_FD_BASE + NUM_SLOTS * 2;

export function isPipeFd(fd: number): boolean {
  return fd >= PIPE_FD_BASE && fd < PIPE_FD_MAX;
}

export function pipeFdSlot(fd: number): number {
  return (fd - PIPE_FD_BASE) >>> 1;
}

export function pipeFdIsWrite(fd: number): boolean {
  return ((fd - PIPE_FD_BASE) & 1) === 1;
}

export interface PipePollHandle {
  /** i32 array view to pass to Atomics.waitAsync. */
  i32: Int32Array;
  /** Index in `i32` to wait on. */
  idx: number;
  /** Expected value — waitAsync resolves when this changes. */
  seen: number;
  /** Returns true iff the pipe has bytes ready to read right now. */
  ready(): boolean;
}

export class PipeRegistry {
  private readonly sab: SharedArrayBuffer;
  private readonly globalI32: Int32Array;
  private readonly hdrI32: Int32Array;
  private readonly bodyU8: Uint8Array;

  private constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.globalI32 = new Int32Array(sab, 0, GLOBAL_HDR_SIZE >>> 2);
    this.hdrI32 = new Int32Array(sab, GLOBAL_HDR_SIZE, HEADER_TOTAL >>> 2);
    this.bodyU8 = new Uint8Array(sab, GLOBAL_HDR_SIZE + HEADER_TOTAL, BODY_TOTAL);
  }

  /** Globally-visible counters (atomic across all workers).  Read this
   *  from any worker to see total pipe activity. */
  stats(): { wCount: number; wBytes: number; rCount: number; rBytes: number } {
    return {
      wCount: Atomics.load(this.globalI32, G_OFF_W_COUNT >>> 2),
      rCount: Atomics.load(this.globalI32, G_OFF_R_COUNT >>> 2),
      wBytes: Atomics.load(this.globalI32, G_OFF_W_BYTES >>> 2),
      rBytes: Atomics.load(this.globalI32, G_OFF_R_BYTES >>> 2),
    };
  }

  static create(): PipeRegistry {
    const sab = new SharedArrayBuffer(SAB_TOTAL);
    return new PipeRegistry(sab);
  }

  static attach(sab: SharedArrayBuffer): PipeRegistry {
    if (sab.byteLength !== SAB_TOTAL) {
      throw new Error(`PipeRegistry.attach: SAB size ${sab.byteLength} != expected ${SAB_TOTAL}`);
    }
    return new PipeRegistry(sab);
  }

  get sharedBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  private slotHdrI32Idx(slot: number, off: number): number {
    return ((slot * SLOT_HDR_SIZE) + off) >>> 2;
  }

  /** Allocate a new pipe pair.  Returns { readFd, writeFd } or null if the
   *  registry is full.  Caller's responsibility to release via `close()`
   *  when both ends are closed (refcounted). */
  allocate(): { readFd: number; writeFd: number } | null {
    for (let slot = 0; slot < NUM_SLOTS; slot++) {
      const aliveIdx = this.slotHdrI32Idx(slot, OFF_ALIVE);
      if (Atomics.compareExchange(this.hdrI32, aliveIdx, 0, 1) === 0) {
        // Won the slot.  Initialize the rest of the header.
        Atomics.store(this.hdrI32, this.slotHdrI32Idx(slot, OFF_CAPACITY), BUFFER_SIZE);
        Atomics.store(this.hdrI32, this.slotHdrI32Idx(slot, OFF_HEAD), 0);
        Atomics.store(this.hdrI32, this.slotHdrI32Idx(slot, OFF_TAIL), 0);
        Atomics.store(this.hdrI32, this.slotHdrI32Idx(slot, OFF_WAKE), 0);
        Atomics.store(this.hdrI32, this.slotHdrI32Idx(slot, OFF_BUF_OFF), GLOBAL_HDR_SIZE + HEADER_TOTAL + slot * BUFFER_SIZE);
        Atomics.store(this.hdrI32, this.slotHdrI32Idx(slot, OFF_REFCOUNT), 2);
        return {
          readFd: PIPE_FD_BASE + slot * 2,
          writeFd: PIPE_FD_BASE + slot * 2 + 1,
        };
      }
    }
    return null;
  }

  /** Decrement refcount for one fd.  When both ends are closed, mark slot
   *  free.  Returns true if the slot is now free. */
  close(fd: number): boolean {
    const slot = pipeFdSlot(fd);
    const refIdx = this.slotHdrI32Idx(slot, OFF_REFCOUNT);
    const after = Atomics.sub(this.hdrI32, refIdx, 1) - 1;
    if (after <= 0) {
      Atomics.store(this.hdrI32, this.slotHdrI32Idx(slot, OFF_ALIVE), 0);
      // Wake any reader still waiting so they see EOF.
      Atomics.add(this.hdrI32, this.slotHdrI32Idx(slot, OFF_WAKE), 1);
      Atomics.notify(this.hdrI32, this.slotHdrI32Idx(slot, OFF_WAKE));
      return true;
    }
    return false;
  }

  isAlive(slot: number): boolean {
    return Atomics.load(this.hdrI32, this.slotHdrI32Idx(slot, OFF_ALIVE)) === 1;
  }

  /** Bytes currently buffered (i.e. how much a reader could read).  Cheap
   *  load — call from pollOneoffWalkSubs to decide if the FdRead event is
   *  immediately ready. */
  available(slot: number): number {
    const head = Atomics.load(this.hdrI32, this.slotHdrI32Idx(slot, OFF_HEAD));
    const tail = Atomics.load(this.hdrI32, this.slotHdrI32Idx(slot, OFF_TAIL));
    // head/tail are monotonic; subtract for outstanding bytes.  Stays
    // correct as long as they don't wrap u32 (would take 4GB of writes).
    return (tail - head) | 0;
  }

  /** Read up to dst.length bytes.  Returns the number of bytes read; 0 if
   *  the pipe is empty (non-blocking semantics — callers that need to
   *  block use poll_oneoff first). */
  read(slot: number, dst: Uint8Array): number {
    if (!this.isAlive(slot)) return 0; // EOF when both ends closed
    const headIdx = this.slotHdrI32Idx(slot, OFF_HEAD);
    const tailIdx = this.slotHdrI32Idx(slot, OFF_TAIL);
    const head = Atomics.load(this.hdrI32, headIdx);
    const tail = Atomics.load(this.hdrI32, tailIdx);
    const available = (tail - head) | 0;
    if (available <= 0) return 0;
    const toRead = Math.min(available, dst.length);
    const bufStart = slot * BUFFER_SIZE;
    for (let i = 0; i < toRead; i++) {
      const physIdx = bufStart + ((head + i) % BUFFER_SIZE);
      dst[i] = this.bodyU8[physIdx]!;
    }
    Atomics.store(this.hdrI32, headIdx, head + toRead);
    if (toRead > 0) {
      Atomics.add(this.globalI32, G_OFF_R_COUNT >>> 2, 1);
      Atomics.add(this.globalI32, G_OFF_R_BYTES >>> 2, toRead);
    }
    return toRead;
  }

  /** Write up to src.length bytes.  Returns the number of bytes written; 0
   *  if the pipe is full (the caller — typically libuv's uv_async_send —
   *  treats this as EAGAIN, which it tolerates because async-send is a
   *  notification not a payload transport). */
  write(slot: number, src: Uint8Array): number {
    if (!this.isAlive(slot)) return -1;
    const headIdx = this.slotHdrI32Idx(slot, OFF_HEAD);
    const tailIdx = this.slotHdrI32Idx(slot, OFF_TAIL);
    const wakeIdx = this.slotHdrI32Idx(slot, OFF_WAKE);
    const head = Atomics.load(this.hdrI32, headIdx);
    const tail = Atomics.load(this.hdrI32, tailIdx);
    const used = (tail - head) | 0;
    // Leave a 1-byte gap so head==tail unambiguously means empty.
    const free = BUFFER_SIZE - used - 1;
    if (free <= 0) return 0;
    const toWrite = Math.min(free, src.length);
    const bufStart = slot * BUFFER_SIZE;
    for (let i = 0; i < toWrite; i++) {
      const physIdx = bufStart + ((tail + i) % BUFFER_SIZE);
      this.bodyU8[physIdx] = src[i]!;
    }
    Atomics.store(this.hdrI32, tailIdx, tail + toWrite);
    // Notify any reader waiting via Atomics.waitAsync on this slot's
    // wake counter.  We increment unconditionally so even readers that
    // sampled `wakeCounter` between our store and notify still see the
    // value change.
    Atomics.add(this.hdrI32, wakeIdx, 1);
    Atomics.notify(this.hdrI32, wakeIdx);
    if (toWrite > 0) {
      Atomics.add(this.globalI32, G_OFF_W_COUNT >>> 2, 1);
      Atomics.add(this.globalI32, G_OFF_W_BYTES >>> 2, toWrite);
    }
    return toWrite;
  }

  /** Snapshot the wake counter for `Atomics.waitAsync` from poll_oneoff.
   *  Caller is expected to: (1) check `ready()` first, (2) if not ready,
   *  spawn waitAsync(i32, idx, seen), (3) Promise.race with other waiters.
   *  When the wait resolves the caller re-evaluates readiness. */
  pollHandle(slot: number): PipePollHandle {
    const wakeIdx = this.slotHdrI32Idx(slot, OFF_WAKE);
    const seen = Atomics.load(this.hdrI32, wakeIdx);
    const headIdx = this.slotHdrI32Idx(slot, OFF_HEAD);
    const tailIdx = this.slotHdrI32Idx(slot, OFF_TAIL);
    const hdrI32 = this.hdrI32;
    return {
      i32: hdrI32,
      idx: wakeIdx,
      seen,
      ready: () => {
        const head = Atomics.load(hdrI32, headIdx);
        const tail = Atomics.load(hdrI32, tailIdx);
        return ((tail - head) | 0) > 0;
      },
    };
  }
}
