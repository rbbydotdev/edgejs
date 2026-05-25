// Raw wasm wrapper for edge.js's libuv `uv_async_t` exports.  See
// experiments/e23-real-path-a-discovery/FINDINGS.md for the discovery
// that confirmed these symbols are exported and callable from host JS
// during JSPI suspension of `_start`.  JS-side keepalive (so the event
// loop doesn't exit while a handle is ref'd) is the policy's concern,
// not ours.

export interface UvAsyncRuntime {
  uvDefaultLoop(): number;
  uvAsyncInit(loop: number, handle: number, cb: number): number;
  uvAsyncSend(handle: number): number;
  uvAsyncClose(handle: number, closeCb: number): void;
  uvRef(handle: number): void;
  uvUnref(handle: number): void;
  /**
   * Factory: allocate a fresh `uv_async_t` (zero-init, registered with
   * the default loop) and wrap it in a `UvAsyncSlot`.  `cbFuncref` of 0
   * is the documented NULL-callback path (libuv skips dispatch — see
   * experiments/e23-real-path-a-discovery/FINDINGS.md, Q4); the wake-up
   * is what matters for keepalive + loop-iteration drive.
   *
   * Added so policy code (which can't `import` TS types) can construct
   * slots via `globalThis.__edgeNapiHost.uvAsync.acquireSlot(0)` without
   * needing a separate `__edgeUvAsyncSlot` global for the class itself.
   */
  acquireSlot(cbFuncref: number): UvAsyncSlot;
}

export interface UvAsyncRuntimeWithSize extends UvAsyncRuntime {
  uvHandleSize(type: number): number;
}

// UV_ASYNC = 1 in node/deps/uv/include/uv.h; uv_handle_size(UV_ASYNC) === 64.
const UV_ASYNC_SIZE = 64;

export class UvAsyncSlot {
  readonly handle: number;
  private readonly rt: UvAsyncRuntime;
  private readonly wasmMemory: WebAssembly.Memory;
  private closed = false;

  constructor(
    rt: UvAsyncRuntime,
    wasmMemory: WebAssembly.Memory,
    guestMalloc: (n: number) => number,
    cbFuncref: number,
  ) {
    this.rt = rt;
    this.wasmMemory = wasmMemory;
    this.handle = guestMalloc(UV_ASYNC_SIZE);
    if (!this.handle) throw new Error("UvAsyncSlot: guestMalloc returned null");
    // Re-read buffer each time; memory.grow can detach prior views.
    new Uint8Array(this.wasmMemory.buffer, this.handle, UV_ASYNC_SIZE).fill(0);
    const rc = rt.uvAsyncInit(rt.uvDefaultLoop(), this.handle, cbFuncref);
    if (rc !== 0) throw new Error(`uv_async_init failed: rc=${rc}`);
  }

  send(): void {
    if (this.closed) return;
    const rc = this.rt.uvAsyncSend(this.handle);
    if (rc !== 0) throw new Error(`uv_async_send failed: rc=${rc}`);
  }

  ref(): void {
    if (!this.closed) this.rt.uvRef(this.handle);
  }

  unref(): void {
    if (!this.closed) this.rt.uvUnref(this.handle);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rt.uvAsyncClose(this.handle, 0);
  }
}

export function createUvAsyncRuntime(
  instance: WebAssembly.Instance,
  guestMalloc: (n: number) => number,
): UvAsyncRuntimeWithSize {
  const exp = instance.exports as Record<string, unknown>;
  const bind = (name: string): ((...args: number[]) => number) => {
    const fn = exp[name];
    if (typeof fn !== "function") throw new Error(`uv-async: wasm export missing: ${name}`);
    return fn as (...args: number[]) => number;
  };
  // Edge.js's wasm imports shared memory rather than exporting its own,
  // so `instance.exports.memory` is typically undefined.  Resolve the
  // WebAssembly.Memory lazily at acquireSlot() time from the
  // host-published `__edgeNapiHost.wasmMemory` (set in bindInstance),
  // with the export as a fallback for builds that DO export memory.
  const resolveMemory = (): WebAssembly.Memory => {
    const exported = exp.memory as WebAssembly.Memory | undefined;
    if (exported) return exported;
    const host = (globalThis as { __edgeNapiHost?: { wasmMemory?: WebAssembly.Memory } })
      .__edgeNapiHost;
    if (host?.wasmMemory) return host.wasmMemory;
    throw new Error("uv-async: WebAssembly.Memory not resolvable (no exp.memory, no __edgeNapiHost.wasmMemory)");
  };
  const rt: UvAsyncRuntimeWithSize = {
    uvDefaultLoop: bind("uv_default_loop") as () => number,
    uvAsyncInit: bind("uv_async_init"),
    uvAsyncSend: bind("uv_async_send"),
    uvAsyncClose: (handle, cb) => void bind("uv_close")(handle, cb),
    uvRef: (handle) => void bind("uv_ref")(handle),
    uvUnref: (handle) => void bind("uv_unref")(handle),
    uvHandleSize: bind("uv_handle_size"),
    acquireSlot(cbFuncref: number): UvAsyncSlot {
      return new UvAsyncSlot(rt, resolveMemory(), guestMalloc, cbFuncref);
    },
  };
  return rt;
}
