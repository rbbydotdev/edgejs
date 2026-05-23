// Callback dispatch — the Lever B reverse-channel layer for napi callbacks.
//
// Context (Lever B / F-9 batch 4):
//   - Callback-bound napi ops (napi_create_function, napi_add_finalizer,
//     napi_define_class, napi_wrap, napi_add_env_cleanup_hook, …) need
//     to invoke a wasm-side function pointer when JS code on the host
//     side fires the callback.
//   - The host has no direct access to the wasm function table.  Instead
//     we use the reverse channel: host sends OP_INVOKE_WASM_CALLBACK
//     downstream into the wasm runtime worker; wasm looks up the funcref
//     in its table and invokes it.
//   - The wasm runtime worker may already be blocked inside Atomics.wait
//     for a forward sync RPC reply.  R6a (experiments/r6-nested-sync-rpc/
//     FINDINGS.md) proved the SyncRpcClient wait loop is re-entrant: a
//     reverse-request publish bumps the shared-wake counter, the wait
//     loop wakes, drains the reverse queue, recursively calls back into
//     callSync, returns, resumes the outer wait.  E4 measured ~31 µs
//     median per fire, bundled-args path.
//
// This module:
//   - HOST side: `makeHostSideCallbackClosure` returns a JS function that
//     the host's emnapi will call (e.g. when JS user code invokes a
//     function created via napi_create_function).  The closure marshals
//     the call into a reverse-RPC and returns the wasm-side return value
//     (or throws if the wasm callback threw).
//   - WASM side: `registerWasmCallbackInvoker` wires the reverse-RPC
//     handler that runs in the wasm runtime worker, looks up the funcref
//     in `wasmTable`, invokes it with the emnapi callback ABI
//     (env, callback_info) → napi_value, and returns the result.
//
// Analytical choices (locked in for this batch):
//
//   Exception marshalling format
//   ────────────────────────────
//   Mirrors the existing REPLY_STATUS_HOST_ERROR pattern from
//   rpc-server.ts:111-129.  Reverse-reply payload layout:
//
//     [4 bytes : status     u32 little-endian]
//     [4 bytes : returnHandle u32 (when status == 0; else ignored)]
//     [N bytes : utf8 message bytes (when status != 0; else ignored)]
//
//   status == 0 means clean return; the 4 bytes after it are the
//   napi_value handle returned by the wasm callback (uninterpreted
//   u32 — emnapi's value space).  status != 0 means the wasm callback
//   threw; the bytes after the status are the UTF-8 message we should
//   re-throw on the host side.  The 4-byte returnHandle slot is
//   present-but-zero on errors so the layout is fixed-prefix; cheap to
//   decode.
//
//   Re-entrancy depth bound
//   ───────────────────────
//   32.  R6a tested cleanly to depth 16 in Node 24's JSPI engine; 32 is
//   the production safety bound — twice the empirical limit, well below
//   the slot-width ceiling (32-slot rings in HOST_RPC_RING_CONFIG).
//   Tracked per-invoker via a depth counter passed in by the wasm
//   runtime worker; if the handler sees depth >= 32 it returns
//   status != 0 with "callback re-entrancy depth exceeded".  The host
//   surfaces that as a thrown Error in the caller's frame, matching how
//   real Node would explode if your napi C extension recursed forever.
//
// Per-op handler pattern (for the per-op agents):
//   See `CALLBACK-DISPATCH-SPEC.md` co-located with this file.

import type { SyncRpcClient } from "./rpc-client-sync";
import type { RpcClient } from "./rpc-client";
import type { RpcServer, HandlerContext } from "./rpc-server";
import type { Context, Env } from "../napi-host";
import { IdentityMap, packValue, unpackValue } from "./cross-context-marshal";
import {
  OP_INVOKE_WASM_CALLBACK,
  REPLY_STATUS_OK,
  REPLY_STATUS_HOST_ERROR,
} from "./rpc-protocol";

// Type narrowing for the `callbackInfo` field on HandleScope.  All
// other emnapi runtime methods we touch (openScope/closeScope) exist
// in the published `.d.ts`; the marshaling helpers live in
// cross-context-marshal.ts and don't need any Context internals here.
interface CallbackInfoR7 {
  thiz: unknown;
  data: number | bigint;
  args: ArrayLike<unknown>;
  fn: Function;
  /** Present in vendor source (HandleScope.ts:7); absent from
   *  published .d.ts.  Cleared by HandleScope.dispose. */
  holder: unknown;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

// ─── Callback ABI shapes ────────────────────────────────────────────
//
// The 11 callback-bound napi ops span THREE distinct wasm-side ABIs.
// The wasm-side invoker dispatches by shape so the indirect_function_table
// type check matches the funcref's actual signature:
//
//   NAPI_CALLBACK   `(env, cbinfo) → napi_value`        2 i32 in,  1 i32 out
//     Used by: napi_create_function, napi_define_class
//
//   CLEANUP_HOOK    `(arg) → void`                      1 i32 in,  0 out
//     Used by: napi_add_env_cleanup_hook, napi_remove_env_cleanup_hook
//
//   FINALIZER       `(env, data, hint) → void`           3 i32 in,  0 out
//     Used by: napi_wrap, napi_add_finalizer,
//              napi_create_external{,_arraybuffer,_buffer}
//
// Without per-shape dispatch, all callbacks were invoked as
// `fn(env, 0)` (the NAPI_CALLBACK shape), which traps the wasm
// indirect-call type check for the other two shapes — silent until
// the callback actually fires.  Per-shape dispatch fixes that.
export const CALLBACK_SHAPE_NAPI_CALLBACK = 0;
export const CALLBACK_SHAPE_CLEANUP_HOOK = 1;
export const CALLBACK_SHAPE_FINALIZER = 2;

export type CallbackShape =
  | typeof CALLBACK_SHAPE_NAPI_CALLBACK
  | typeof CALLBACK_SHAPE_CLEANUP_HOOK
  | typeof CALLBACK_SHAPE_FINALIZER;

// ─── Reverse-RPC payload layout ────────────────────────────────────
//
// Request (host → wasm) for OP_INVOKE_WASM_CALLBACK:
//   [u32 shape]             : CallbackShape — drives wasm-side ABI dispatch
//   [u32 cbPtr]             : funcref index into the wasm __indirect_function_table
//   [u32 dataPtr]           : opaque data pointer (3rd capture from napi_create_function;
//                            also doubles as the `arg` for CLEANUP_HOOK)
//   [u32 env]               : napi_env handle (host's view)
//   [u32 argc]              : number of u32 args bundled below
//   [u32 × argc] : args     : raw u32s — interpretation depends on shape:
//                              NAPI_CALLBACK: napi_value handles (passed via cbinfo)
//                              CLEANUP_HOOK : ignored (arg comes from dataPtr)
//                              FINALIZER    : argv[0]=data, argv[1]=hint
//
// Reply (wasm → host) for OP_INVOKE_WASM_CALLBACK:
//   [u32 status]            : 0 = ok, nonzero = wasm callback threw
//   [u32 returnHandle]      : napi_value returned (NAPI_CALLBACK only); else 0
//   [N bytes utf8 message]  : present iff status != 0
const REQ_HEADER_U32_COUNT = 5; // shape, cbPtr, dataPtr, env, argc
const REPLY_HEADER_U32_COUNT = 2; // status, returnHandle

// ─── Public types ──────────────────────────────────────────────────

export interface MakeHostSideCallbackClosureOpts {
  /** SyncRpcClient over the REVERSE channel (host → wasm). */
  reverseClient: SyncRpcClient;
  /** Funcref index into the wasm __indirect_function_table. */
  cbPtr: number;
  /** Opaque data pointer.  For CLEANUP_HOOK this is also the `arg`
   *  passed to the cleanup callback at env destroy. */
  dataPtr: number;
  /** napi_env handle as seen by the host.  Unused for CLEANUP_HOOK
   *  shape. */
  env: number;
  /** ABI shape of the wasm-side funcref.  Drives which arg count +
   *  return-value contract the wasm-side invoker uses.  Defaults to
   *  NAPI_CALLBACK (the most common). */
  shape?: CallbackShape;
  /** For NAPI_CALLBACK shape only: IdentityMap shared with the wasm-
   *  side invoker for object marshaling.  Not yet effective across
   *  worker boundaries (separate JS heaps) — primitives work fine,
   *  object args throw with a clear message.  See R8 FINDINGS. */
  idMap?: IdentityMap;
  /** hostWorkerId for the reverse RPC.  Currently always 0. */
  hostWorkerId?: number;
  /** contextId for the reverse RPC.  Currently 0. */
  contextId?: number;
}

/** Returns a JS function that, when called from host's emnapi (e.g. as
 *  the value returned by napi_create_function), invokes the wasm
 *  callback via reverse RPC and returns its napi_value result.
 *
 *  Arguments are the host's napi_value handles.  Caller of the returned
 *  function is responsible for the lifetime of those handles for the
 *  duration of the call (emnapi's `withScope` already does the right
 *  thing — handles are scoped to the function frame).
 *
 *  Throws (synchronously) if the wasm callback threw; the throw is a
 *  plain `Error` whose `message` is the wasm-side error message. */
export function makeHostSideCallbackClosure(
  opts: MakeHostSideCallbackClosureOpts,
): (...args: unknown[]) => unknown {
  const { reverseClient, cbPtr, dataPtr, env } = opts;
  const shape: CallbackShape = opts.shape ?? CALLBACK_SHAPE_NAPI_CALLBACK;
  const idMap = opts.idMap ?? new IdentityMap();
  const hostWorkerId = opts.hostWorkerId ?? 0;
  const contextId = opts.contextId ?? 0;

  return function hostSideCallbackClosure(...args: unknown[]): unknown {
    let payload: Uint8Array;
    if (shape === CALLBACK_SHAPE_NAPI_CALLBACK) {
      // R7+R8 path: args are JS values; marshal via packValue.
      // Wire format: [u32 shape][u32 cbPtr][u32 dataPtr][u32 env]
      //              [u32 argc][packed values concatenated]
      const packedArgs: Uint8Array[] = [];
      let packedLen = 0;
      for (const a of args) {
        const p = packValue(a, "host", idMap);
        packedArgs.push(p);
        packedLen += p.byteLength;
      }
      payload = new Uint8Array(REQ_HEADER_U32_COUNT * 4 + packedLen);
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      dv.setUint32(0,  shape >>> 0, true);
      dv.setUint32(4,  cbPtr >>> 0, true);
      dv.setUint32(8,  dataPtr >>> 0, true);
      dv.setUint32(12, env >>> 0, true);
      dv.setUint32(16, args.length >>> 0, true);
      let off = REQ_HEADER_U32_COUNT * 4;
      for (const p of packedArgs) {
        payload.set(p, off);
        off += p.byteLength;
      }
    } else {
      // CLEANUP_HOOK / FINALIZER: args are raw u32s (pointers etc.),
      // not napi_values; keep the original raw encoding.
      const argc = args.length;
      const totalU32 = REQ_HEADER_U32_COUNT + argc;
      payload = new Uint8Array(totalU32 * 4);
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      dv.setUint32(0,  shape >>> 0, true);
      dv.setUint32(4,  cbPtr >>> 0, true);
      dv.setUint32(8,  dataPtr >>> 0, true);
      dv.setUint32(12, env >>> 0, true);
      dv.setUint32(16, argc >>> 0, true);
      for (let i = 0; i < argc; i++) {
        const a = args[i];
        const u32 = (typeof a === "number" ? a : Number(a)) >>> 0;
        dv.setUint32(20 + i * 4, u32, true);
      }
    }

    const reply = reverseClient.callSync(
      OP_INVOKE_WASM_CALLBACK,
      hostWorkerId,
      contextId,
      payload,
    );

    // Two-layer status:
    //   reply.status is the RPC-transport status (REPLY_STATUS_OK /
    //   REPLY_STATUS_HOST_ERROR).  We treat any nonzero RPC status as
    //   a thrown error (transport-level failure surfaces as a thrown
    //   Error too — the wasm callback never ran).
    //
    //   The callback-result status lives in the FIRST u32 of the reply
    //   payload (our own layered protocol).  Nonzero means the wasm
    //   callback ran and threw.
    if (reply.status !== REPLY_STATUS_OK) {
      const msg = reply.payload.byteLength > 0
        ? utf8Decoder.decode(reply.payload)
        : `callback transport error: status=${reply.status}`;
      throw new Error(msg);
    }
    if (reply.payload.byteLength < REPLY_HEADER_U32_COUNT * 4) {
      throw new Error("callback dispatch: reply payload too short");
    }
    const rdv = new DataView(
      reply.payload.buffer,
      reply.payload.byteOffset,
      reply.payload.byteLength,
    );
    const cbStatus = rdv.getUint32(0, true);
    const returnHandle = rdv.getUint32(4, true);
    if (cbStatus !== 0) {
      const msgBytes = reply.payload.subarray(REPLY_HEADER_U32_COUNT * 4);
      const msg = msgBytes.byteLength > 0
        ? utf8Decoder.decode(msgBytes)
        : "wasm callback threw (no message)";
      throw new Error(msg);
    }
    return returnHandle;
  };
}

// ─── Wasm-side reverse-RPC handler registration ────────────────────

export interface RegisterWasmCallbackInvokerOptions {
  /** The wasm `__indirect_function_table`.  Funcref lookup via .get(idx). */
  wasmTable: WebAssembly.Table;
  /** Mutable per-runtime depth counter.  Caller owns lifetime.
   *  Layout: a single-element box so the dispatcher can read/mutate
   *  it.  We use a `{ depth: number }` holder (vs. a closure cell)
   *  so a future tracing layer can inspect it. */
  depthCounter: { depth: number };
  /** Wasm-side emnapi Context.  Used by the NAPI_CALLBACK shape to
   *  synthesize a `napi_callback_info` per R7
   *  (experiments/r7-cbinfo-synthesis/FINDINGS.md): we openScope on the
   *  wasm-side context, mutate `scope.callbackInfo`, pass `scope.id` to
   *  the funcref as cbinfo, then closeScope on return. */
  wasmCtx: Context;
  /** Wasm-side emnapi Env.  Accepts either a stable `Env` reference OR
   *  an accessor function — at registration time the wasm-side env may
   *  not yet exist (envs are created during `_start` by
   *  `unofficial_napi_create_env`), so callers typically pass an
   *  accessor that resolves lazily at dispatch.  See
   *  `getWasmEnv` in `napi-host/index.ts`. */
  wasmEnv: Env | (() => Env | undefined);
  /** R8 IdentityMap for NAPI_CALLBACK arg unmarshaling.  In a
   *  single-heap deployment (dev: page+worker via vite) this is the
   *  same instance used by host-side closures, so object identity is
   *  preserved.  In a true split-worker topology objects throw
   *  "marshal: identity reference collected" (separate JS heaps), which
   *  is the correct failure mode until cross-heap object marshaling is
   *  implemented.  Primitives work in both deployments. */
  idMap?: IdentityMap;
  /** Optional: max re-entrancy depth.  Defaults to 32 per the brief
   *  (R6a measured to 16 cleanly; 32 is production safety). */
  maxDepth?: number;
}

/** Maximum re-entrancy depth for nested OP_INVOKE_WASM_CALLBACK
 *  invocations.  R6a measured 16 as safe; 32 is the production cap. */
export const CALLBACK_REENTRANCY_MAX_DEPTH = 32;

/** Register the OP_INVOKE_WASM_CALLBACK handler on the wasm runtime
 *  worker's reverse-RPC server.  After this returns, the host can
 *  invoke wasm callbacks via `makeHostSideCallbackClosure`. */
export function registerWasmCallbackInvoker(
  server: RpcServer,
  options: RegisterWasmCallbackInvokerOptions,
): void {
  const { wasmTable, depthCounter, wasmCtx } = options;
  const wasmEnvOpt = options.wasmEnv;
  const resolveWasmEnv = (): Env | undefined =>
    typeof wasmEnvOpt === "function" ? wasmEnvOpt() : wasmEnvOpt;
  const idMap = options.idMap ?? new IdentityMap();
  const maxDepth = options.maxDepth ?? CALLBACK_REENTRANCY_MAX_DEPTH;

  server.register(OP_INVOKE_WASM_CALLBACK, (_ctx: HandlerContext, args: Uint8Array) => {
    // ── 1. Decode request header (5 u32: shape, cbPtr, dataPtr, env, argc).
    if (args.byteLength < REQ_HEADER_U32_COUNT * 4) {
      return makeErrorReply("invoke-wasm-callback: request too short");
    }
    const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const shape = dv.getUint32(0,  true) as CallbackShape;
    const cbPtr   = dv.getUint32(4,  true);
    const dataPtr = dv.getUint32(8,  true);
    const env     = dv.getUint32(12, true);
    const argc    = dv.getUint32(16, true);

    // ── 2. Depth-bound check.
    if (depthCounter.depth >= maxDepth) {
      return makeErrorReply(
        `callback re-entrancy depth exceeded (max=${maxDepth})`,
      );
    }

    // ── 3. Funcref lookup.
    let fn: Function | null;
    try {
      fn = wasmTable.get(cbPtr) as Function | null;
    } catch (e) {
      return makeErrorReply(
        `wasm table lookup failed for cbPtr=${cbPtr}: ${(e as Error).message}`,
      );
    }
    if (typeof fn !== "function") {
      return makeErrorReply(`wasm table entry at ${cbPtr} is not a function`);
    }

    // ── 4. Per-shape decode + invoke (argv layout depends on shape).
    depthCounter.depth += 1;
    let returnHandle = 0;
    let threwMessage: string | null = null;
    try {
      switch (shape) {
        case CALLBACK_SHAPE_NAPI_CALLBACK: {
          // `(env, cbinfo) → napi_value`.  Args are R8-packed JS
          // values starting at the end of the header (offset 20).
          //
          // R7 synthesis: open a wasm-side emnapi scope, mutate
          // `scope.callbackInfo`, pass `scope.id` as cbinfo.  Funcref's
          // `napi_get_cb_info` resolves cbinfo via
          // `_scopeStore.deref(cbinfo).callbackInfo`, hitting our
          // synthesized args.  emnapi internally calls
          // `napiValueFromJsValue` on each element of cbi.args at
          // get_cb_info time, so no manual handle minting needed here.
          const wasmEnv = resolveWasmEnv();
          if (!wasmEnv) {
            threwMessage = "invoke-wasm-callback: wasm-side env not yet created (NAPI_CALLBACK)";
            break;
          }
          const unpackedArgs: unknown[] = new Array(argc);
          let cursor = REQ_HEADER_U32_COUNT * 4;
          for (let i = 0; i < argc; i++) {
            const { value, byteLength } = unpackValue(args, cursor, idMap);
            unpackedArgs[i] = value;
            cursor += byteLength;
          }
          const scope = wasmCtx.openScope(wasmEnv);
          const cbi = scope.callbackInfo as CallbackInfoR7;
          cbi.args = unpackedArgs;
          cbi.thiz = undefined;    // R8 will replace with marshaled thisArg
          cbi.data = dataPtr;
          cbi.fn = fn;
          cbi.holder = undefined;
          try {
            const ret = (fn as (env: number, info: number) => number).call(undefined, env, scope.id);
            returnHandle = (typeof ret === "number" ? ret : 0) >>> 0;
          } finally {
            wasmCtx.closeScope(wasmEnv, scope);
          }
          break;
        }
        case CALLBACK_SHAPE_CLEANUP_HOOK: {
          // `void(*)(void* arg)` — one i32.  arg comes from dataPtr
          // (which is what host's emnapi stored for this cleanup hook).
          (fn as (arg: number) => void).call(undefined, dataPtr);
          break;
        }
        case CALLBACK_SHAPE_FINALIZER: {
          // `void(*)(env, finalize_data, finalize_hint)` — three i32.
          // Raw u32 argv layout: argv[0] = finalize_data,
          // argv[1] = finalize_hint.
          const argsNeeded = (REQ_HEADER_U32_COUNT + argc) * 4;
          if (args.byteLength < argsNeeded) {
            threwMessage = `invoke-wasm-callback: short argv (argc=${argc} need=${argsNeeded} got=${args.byteLength})`;
            break;
          }
          const finalizeData = argc > 0 ? dv.getUint32(20, true) : 0;
          const finalizeHint = argc > 1 ? dv.getUint32(24, true) : 0;
          (fn as (env: number, data: number, hint: number) => void).call(
            undefined,
            env,
            finalizeData,
            finalizeHint,
          );
          break;
        }
        default:
          threwMessage = `invoke-wasm-callback: unknown shape ${shape}`;
      }
    } catch (e) {
      threwMessage = (e instanceof Error ? e.message : String(e)) || "wasm callback threw";
    } finally {
      depthCounter.depth -= 1;
    }

    if (threwMessage !== null) {
      return makeErrorReply(threwMessage);
    }
    return makeOkReply(returnHandle);
  });
}

// ─── Reply encoders ────────────────────────────────────────────────

function makeOkReply(returnHandle: number): { payload: Uint8Array; status: number } {
  const payload = new Uint8Array(REPLY_HEADER_U32_COUNT * 4);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 0, true); // cbStatus = ok
  dv.setUint32(4, returnHandle >>> 0, true);
  return { payload, status: REPLY_STATUS_OK };
}

function makeErrorReply(message: string): { payload: Uint8Array; status: number } {
  const msgBytes = utf8Encoder.encode(message);
  const payload = new Uint8Array(REPLY_HEADER_U32_COUNT * 4 + msgBytes.byteLength);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 1, true); // cbStatus = error
  dv.setUint32(4, 0, true); // returnHandle = 0
  payload.set(msgBytes, REPLY_HEADER_U32_COUNT * 4);
  // REPLY_STATUS_OK at the RPC-transport layer; the in-band cbStatus
  // is the truth.  The host-side closure decodes the in-band status
  // and throws.  Using REPLY_STATUS_HOST_ERROR at the transport layer
  // would also work but conflates protocol-level transport failure
  // with user-throw-from-callback — they're separate failure modes
  // and surfacing them distinctly helps debugging.
  void REPLY_STATUS_HOST_ERROR; // documented choice, see above
  return { payload, status: REPLY_STATUS_OK };
}

// ─── Helper: construct a depth counter ─────────────────────────────

/** Constructs a per-runtime depth counter.  Pass the same instance to
 *  every `registerWasmCallbackInvoker` call on the same wasm runtime
 *  worker so nested invocations across different reverse-RPC servers
 *  (we currently only have one, but the shape allows growth) share
 *  the bound. */
export function createCallbackDepthCounter(): { depth: number } {
  return { depth: 0 };
}

// ─── Type re-exports for convenience ───────────────────────────────

export type { SyncRpcClient, RpcClient };
