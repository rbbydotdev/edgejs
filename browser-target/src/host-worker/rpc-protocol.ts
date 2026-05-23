// RPC protocol over the SAB-ring primitive.
//
// Wire format on top of sab-ring:
//
//   payload[0..4]    opCode (u32 little-endian)
//   payload[4..8]    requestId (u32) — caller-allocated, matched in reply
//   payload[8..]     op-specific arguments (encoded per op)
//
// hostWorkerId + contextId come from the sab-ring slot header.
//
// Reply ring is separate from request ring — we use TWO sab-rings:
// requestRing (wasm → host) and replyRing (host → wasm).  Reply payload
// shares the same header (opCode echoed for sanity-check, requestId
// matches request).
//
// op codes are grouped by domain.  Each domain reserves a 16-bit range
// so we can route quickly without a giant switch.

// ── Domain ranges ───────────────────────────────────────────────────

export const OP_DOMAIN_CONTROL = 0x0000;   // 0x0000–0x00FF
export const OP_DOMAIN_NAPI_RO = 0x0100;   // 0x0100–0x01FF (read-only napi)
export const OP_DOMAIN_NAPI_CB = 0x0200;   // 0x0200–0x02FF (callback napi)
export const OP_DOMAIN_MICROTASK = 0x0300; // 0x0300–0x03FF
export const OP_DOMAIN_MODULE = 0x0400;    // 0x0400–0x04FF (lib/* source delivery, L5)
export const OP_DOMAIN_POLICY = 0x0500;    // 0x0500–0x05FF (policy hooks)

// ── Control ops (proof-of-life + lifecycle) ─────────────────────────

export const OP_PING = OP_DOMAIN_CONTROL | 0x0001;
// Request: empty.  Reply: empty.
// Used to verify the channel is up.

export const OP_HOST_READY = OP_DOMAIN_CONTROL | 0x0002;
// Sent by host → wasm at startup to signal it's accepting requests.

export const OP_SHUTDOWN = OP_DOMAIN_CONTROL | 0x0003;
// Sent by wasm → host to request graceful shutdown.

export const OP_HOST_ECHO = OP_DOMAIN_CONTROL | 0x0004;
// Request: arbitrary bytes.  Reply: same bytes.
// Used by L3 to benchmark RPC throughput and validate that the primitive
// scales to larger payloads (napi ops will need 100s of bytes per call).

export const OP_WASM_ECHO = OP_DOMAIN_CONTROL | 0x0005;
// Mirror of OP_HOST_ECHO; host → wasm direction.  L4 reverse-channel
// validation.  Used by finalizers (host signals wasm "this finalizer
// should fire") and threadsafe function dispatch in L5+.

export const OP_RUN_USER_SCRIPT = OP_DOMAIN_CONTROL | 0x0006;
// L5 spike: evaluate a user script on the HOST worker's native V8.
// Request payload: UTF-8 source bytes.
// Reply payload: UTF-8 captured stdout bytes (console.log output) +
//   any throw message tail-appended after a NUL sentinel.
// Status: OK on script completion, HOST_ERROR if eval throws.
// Microtasks queued by the script drain naturally on host V8 because
// the host worker's event loop turns after the eval's task ends.

// ── NAPI read-only ops (defined here; wired in L5) ──────────────────
//
// These are the ops L5 will route to the host worker once emnapi context
// lives there.  Op codes assigned here so the wire format is stable
// across L3 (echo bench) → L4 (callback channel) → L5 (real wiring).

export const OP_NAPI_TYPEOF = OP_DOMAIN_NAPI_RO | 0x0001;
export const OP_NAPI_GET_NAMED_PROPERTY = OP_DOMAIN_NAPI_RO | 0x0002;
export const OP_NAPI_GET_PROPERTY = OP_DOMAIN_NAPI_RO | 0x0003;
export const OP_NAPI_HAS_PROPERTY = OP_DOMAIN_NAPI_RO | 0x0004;
export const OP_NAPI_HAS_NAMED_PROPERTY = OP_DOMAIN_NAPI_RO | 0x0005;
export const OP_NAPI_STRICT_EQUALS = OP_DOMAIN_NAPI_RO | 0x0006;
export const OP_NAPI_GET_ARRAY_LENGTH = OP_DOMAIN_NAPI_RO | 0x0007;
export const OP_NAPI_IS_ARRAY = OP_DOMAIN_NAPI_RO | 0x0008;
export const OP_NAPI_IS_TYPEDARRAY = OP_DOMAIN_NAPI_RO | 0x0009;
export const OP_NAPI_IS_BUFFER = OP_DOMAIN_NAPI_RO | 0x000a;
export const OP_NAPI_IS_EXCEPTION_PENDING = OP_DOMAIN_NAPI_RO | 0x000b;
export const OP_NAPI_GET_VALUE_STRING_UTF8 = OP_DOMAIN_NAPI_RO | 0x000c;
export const OP_NAPI_GET_VALUE_INT32 = OP_DOMAIN_NAPI_RO | 0x000d;
export const OP_NAPI_GET_VALUE_UINT32 = OP_DOMAIN_NAPI_RO | 0x000e;
export const OP_NAPI_GET_VALUE_DOUBLE = OP_DOMAIN_NAPI_RO | 0x000f;
export const OP_NAPI_GET_VALUE_BOOL = OP_DOMAIN_NAPI_RO | 0x0010;
export const OP_NAPI_GET_UNDEFINED = OP_DOMAIN_NAPI_RO | 0x0011;
export const OP_NAPI_GET_NULL = OP_DOMAIN_NAPI_RO | 0x0012;
export const OP_NAPI_GET_GLOBAL = OP_DOMAIN_NAPI_RO | 0x0013;
export const OP_NAPI_GET_BOOLEAN = OP_DOMAIN_NAPI_RO | 0x0014;
export const OP_NAPI_GET_PROTOTYPE = OP_DOMAIN_NAPI_RO | 0x0015;
export const OP_NAPI_GET_PROPERTY_NAMES = OP_DOMAIN_NAPI_RO | 0x0016;
export const OP_NAPI_DELETE_REFERENCE = OP_DOMAIN_NAPI_RO | 0x0017;
export const OP_NAPI_GET_REFERENCE_VALUE = OP_DOMAIN_NAPI_RO | 0x0018;
export const OP_NAPI_IS_DATE = OP_DOMAIN_NAPI_RO | 0x0019;
export const OP_NAPI_IS_PROMISE = OP_DOMAIN_NAPI_RO | 0x001a;
export const OP_NAPI_IS_ERROR = OP_DOMAIN_NAPI_RO | 0x001b;
export const OP_NAPI_GET_VALUE_BIGINT_INT64 = OP_DOMAIN_NAPI_RO | 0x001c;
export const OP_NAPI_GET_VALUE_BIGINT_UINT64 = OP_DOMAIN_NAPI_RO | 0x001d;
export const OP_NAPI_GET_DATE_VALUE = OP_DOMAIN_NAPI_RO | 0x001e;
export const OP_NAPI_REFERENCE_REF = OP_DOMAIN_NAPI_RO | 0x001f;
export const OP_NAPI_REFERENCE_UNREF = OP_DOMAIN_NAPI_RO | 0x0020;
export const OP_NAPI_TYPE_TAG_OBJECT = OP_DOMAIN_NAPI_RO | 0x0021;
export const OP_NAPI_CHECK_OBJECT_TYPE_TAG = OP_DOMAIN_NAPI_RO | 0x0022;

// ── NAPI object/array creation + mutation ops (Lever B batch) ──────
//
// Most are read-only-from-RPC-shape POV (return a status; results go
// through shared memory at a resultPtr) so they live in the NAPI_RO
// domain alongside the existing ops.  `napi_set_element` and
// `napi_set_property` have no resultPtr; their fourth u32 is the value
// handle being assigned.  See napi-op-handlers.ts for the factory mapping.
export const OP_NAPI_CREATE_OBJECT = OP_DOMAIN_NAPI_RO | 0x0030;
export const OP_NAPI_CREATE_ARRAY = OP_DOMAIN_NAPI_RO | 0x0031;
export const OP_NAPI_CREATE_ARRAY_WITH_LENGTH = OP_DOMAIN_NAPI_RO | 0x0032;
export const OP_NAPI_SET_ELEMENT = OP_DOMAIN_NAPI_RO | 0x0033;
export const OP_NAPI_GET_ELEMENT = OP_DOMAIN_NAPI_RO | 0x0034;
export const OP_NAPI_SET_PROPERTY = OP_DOMAIN_NAPI_RO | 0x0035;
export const OP_NAPI_DELETE_PROPERTY = OP_DOMAIN_NAPI_RO | 0x0036;
export const OP_NAPI_HAS_OWN_PROPERTY = OP_DOMAIN_NAPI_RO | 0x0037;
export const OP_NAPI_OBJECT_FREEZE = OP_DOMAIN_NAPI_RO | 0x0038;
export const OP_NAPI_INSTANCEOF = OP_DOMAIN_NAPI_RO | 0x0039;

// ── Lever B batch: additional read-only napi ops (0x0140–0x0149) ────
// Allocated in range 0x0040–0x0049 under OP_DOMAIN_NAPI_RO.

export const OP_NAPI_CREATE_INT32 = OP_DOMAIN_NAPI_RO | 0x0040;
// napi_create_int32(env, value: int32, &result)  — three-u32 shape.
export const OP_NAPI_CREATE_UINT32 = OP_DOMAIN_NAPI_RO | 0x0041;
// napi_create_uint32(env, value: uint32, &result)  — three-u32 shape.
export const OP_NAPI_GET_VALUE_INT64 = OP_DOMAIN_NAPI_RO | 0x0042;
// napi_get_value_int64(env, value, &result: int64*)  — three-u32; emnapi
// writes 8 bytes to memory at resultPtr (host has direct memory access).
export const OP_NAPI_GET_VALUE_EXTERNAL = OP_DOMAIN_NAPI_RO | 0x0043;
// napi_get_value_external(env, value, &result)  — three-u32.
export const OP_NAPI_IS_ARRAYBUFFER = OP_DOMAIN_NAPI_RO | 0x0044;
// napi_is_arraybuffer(env, value, &result: bool*)  — three-u32.
export const OP_NAPI_IS_DATAVIEW = OP_DOMAIN_NAPI_RO | 0x0045;
// napi_is_dataview(env, value, &result: bool*)  — three-u32.
export const OP_NAPI_IS_DETACHED_ARRAYBUFFER = OP_DOMAIN_NAPI_RO | 0x0046;
// napi_is_detached_arraybuffer(env, value, &result: bool*)  — three-u32.
export const OP_NAPI_GET_NEW_TARGET = OP_DOMAIN_NAPI_RO | 0x0047;
// napi_get_new_target(env, cbinfo, &result)  — three-u32.
export const OP_NAPI_GET_AND_CLEAR_LAST_EXCEPTION = OP_DOMAIN_NAPI_RO | 0x0048;
// napi_get_and_clear_last_exception(env, &result)  — two-u32.
export const OP_NAPI_GET_ALL_PROPERTY_NAMES = OP_DOMAIN_NAPI_RO | 0x0049;
// napi_get_all_property_names(env, object, key_mode, key_filter,
//                             key_conversion, &result)  — six-u32.

// ── Lever B batch: coerce + buffer-introspection ops (0x0150–0x0159) ──
// Allocated in range 0x0050–0x0059 under OP_DOMAIN_NAPI_RO.
//
// 0x0056 (napi_get_typedarray_info, 7 args) is intentionally NOT allocated:
//   no makeSevenU32 factory exists in napi-op-handlers.ts.  Add later.
// 0x0058 (napi_adjust_external_memory) is intentionally NOT allocated:
//   it takes an int64 change-value that doesn't pack into u32 factory args.

export const OP_NAPI_COERCE_TO_BOOL = OP_DOMAIN_NAPI_RO | 0x0050;
// napi_coerce_to_bool(env, value, &result)  — three-u32 shape.
export const OP_NAPI_COERCE_TO_NUMBER = OP_DOMAIN_NAPI_RO | 0x0051;
// napi_coerce_to_number(env, value, &result)  — three-u32 shape.
export const OP_NAPI_COERCE_TO_OBJECT = OP_DOMAIN_NAPI_RO | 0x0052;
// napi_coerce_to_object(env, value, &result)  — three-u32 shape.
export const OP_NAPI_COERCE_TO_STRING = OP_DOMAIN_NAPI_RO | 0x0053;
// napi_coerce_to_string(env, value, &result)  — three-u32 shape.
export const OP_NAPI_GET_ARRAYBUFFER_INFO = OP_DOMAIN_NAPI_RO | 0x0054;
// napi_get_arraybuffer_info(env, arraybuffer, &data, &byte_length)  — four-u32.
export const OP_NAPI_GET_BUFFER_INFO = OP_DOMAIN_NAPI_RO | 0x0055;
// napi_get_buffer_info(env, value, &data, &length)  — four-u32.
export const OP_NAPI_GET_DATAVIEW_INFO = OP_DOMAIN_NAPI_RO | 0x0057;
// napi_get_dataview_info(env, dataview, &byte_length, &data, &arraybuffer,
//                       &byte_offset)  — six-u32.
export const OP_NODE_API_SET_PROTOTYPE = OP_DOMAIN_NAPI_RO | 0x0059;
// node_api_set_prototype(env, object, prototype)  — three args, no resultPtr.
// Registered inline (no factory for "three-u32 no result"); see
// napi-op-handlers.ts.

// ── NAPI callback-taking ops (F-5) ─────────────────────────────────
export const OP_NAPI_CALL_FUNCTION = OP_DOMAIN_NAPI_CB | 0x0001;
// napi_call_function(env, recv, fn, argc, argv_ptr, &result)
// 6 u32 args; emnapi reads argv array from shared memory at argv_ptr.

export const OP_NAPI_NEW_INSTANCE = OP_DOMAIN_NAPI_CB | 0x0002;
// napi_new_instance(env, constructor, argc, argv_ptr, &result)
// 5 u32 args.

export const OP_NAPI_CREATE_REFERENCE = OP_DOMAIN_NAPI_CB | 0x0003;
// napi_create_reference(env, value, initial_refcount, &result_ref)
// 4 u32 args.

// ── Reverse-channel ops (host → wasm; for callback invocation) ─────
//
// F-5: when host's emnapi calls a napi_callback (e.g., a JS function
// created via napi_create_function), the underlying wasm function
// pointer can't be invoked directly from host.  We use the L4 reverse
// channel: host sends OP_INVOKE_WASM_CALLBACK to wasm worker; wasm
// looks up the function in its table and calls it.
//
// Full wiring of this requires wasm-side cooperation (the wasm runs
// the callback against its emnapi state and returns a result).  L5
// F-7 cutover replaces edge.js's in-process napi-host with the RPC
// path, at which point this reverse channel becomes load-bearing.
export const OP_INVOKE_WASM_CALLBACK = OP_DOMAIN_NAPI_CB | 0x0100;

// ── Status codes for replies ────────────────────────────────────────

export const REPLY_STATUS_OK = 0;
export const REPLY_STATUS_INVALID_OP = 1;
export const REPLY_STATUS_INVALID_ARGS = 2;
export const REPLY_STATUS_HANDLE_GONE = 3;
export const REPLY_STATUS_HOST_ERROR = 4;
// All non-OK statuses carry a UTF-8 error message in the reply payload.

// ── Encoding helpers ────────────────────────────────────────────────

export const REQUEST_HEADER_SIZE = 8;
export const REPLY_HEADER_SIZE = 12; // +4 for replyStatus

export interface RequestHeader {
  opCode: number;
  requestId: number;
}

export interface ReplyHeader {
  opCode: number;
  requestId: number;
  status: number;
}

const LE = true;

export function writeRequestHeader(buf: Uint8Array, h: RequestHeader): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(0, h.opCode, LE);
  dv.setUint32(4, h.requestId, LE);
  return REQUEST_HEADER_SIZE;
}

export function readRequestHeader(buf: Uint8Array): RequestHeader {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    opCode: dv.getUint32(0, LE),
    requestId: dv.getUint32(4, LE),
  };
}

export function writeReplyHeader(buf: Uint8Array, h: ReplyHeader): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(0, h.opCode, LE);
  dv.setUint32(4, h.requestId, LE);
  dv.setUint32(8, h.status, LE);
  return REPLY_HEADER_SIZE;
}

export function readReplyHeader(buf: Uint8Array): ReplyHeader {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    opCode: dv.getUint32(0, LE),
    requestId: dv.getUint32(4, LE),
    status: dv.getUint32(8, LE),
  };
}
