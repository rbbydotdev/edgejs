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
export const OP_DOMAIN_HOST_API = 0x0600;  // 0x0600–0x06FF (host-API-bridge ops:
                                           // SubtleCrypto.digest, future host APIs
                                           // that policies route via worker+sync-RPC)

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

// ── Lever B batch 2: buffer/typed-array/value-creation ops (0x0160–0x016B) ──
// Allocated in range 0x0060–0x006B under OP_DOMAIN_NAPI_RO.

export const OP_NAPI_CREATE_ARRAYBUFFER = OP_DOMAIN_NAPI_RO | 0x0060;
// napi_create_arraybuffer(env, byte_length, &data, &result)  — four-u32.
export const OP_NAPI_CREATE_BUFFER = OP_DOMAIN_NAPI_RO | 0x0061;
// napi_create_buffer(env, length, &data, &result)  — four-u32.
export const OP_NAPI_CREATE_BUFFER_COPY = OP_DOMAIN_NAPI_RO | 0x0062;
// napi_create_buffer_copy(env, length, data, &result_data, &result)  — five-u32.
export const OP_NAPI_CREATE_TYPEDARRAY = OP_DOMAIN_NAPI_RO | 0x0063;
// napi_create_typedarray(env, type, length, arraybuffer, byte_offset, &result)
// — six-u32.
export const OP_NAPI_CREATE_DATE = OP_DOMAIN_NAPI_RO | 0x0064;
// napi_create_date(env, time:double, &result)  — three-u32; JS-number IS
// double on the JS-side factory wrapper, so makeThreeU32 works as-is.
export const OP_NAPI_CREATE_SYMBOL = OP_DOMAIN_NAPI_RO | 0x0065;
// napi_create_symbol(env, description, &result)  — three-u32.
export const OP_NAPI_CREATE_PROMISE = OP_DOMAIN_NAPI_RO | 0x0066;
// napi_create_promise(env, &deferred, &promise)  — three-u32 (two out-ptrs;
// factory is arity-shaped, not semantics-shaped).
export const OP_NODE_API_CREATE_SHAREDARRAYBUFFER = OP_DOMAIN_NAPI_RO | 0x0067;
// node_api_create_sharedarraybuffer(env, byte_length, &data, &result)  — four-u32.
export const OP_NODE_API_IS_SHAREDARRAYBUFFER = OP_DOMAIN_NAPI_RO | 0x0068;
// node_api_is_sharedarraybuffer(env, value, &result:bool*)  — three-u32.
export const OP_NAPI_RUN_SCRIPT = OP_DOMAIN_NAPI_RO | 0x0069;
// napi_run_script(env, script, &result)  — three-u32.
export const OP_NAPI_GET_CB_INFO = OP_DOMAIN_NAPI_RO | 0x006a;
// napi_get_cb_info(env, cbinfo, &argc, argv, &this_arg, &data)  — six-u32.
export const OP_NAPI_CREATE_DOUBLE = OP_DOMAIN_NAPI_RO | 0x006b;
// napi_create_double(env, value:double, &result)  — three-u32; JS-number
// IS double, factory passes through losslessly.

// ── Lever B batch 2: error-create + throw + deferred ops (0x0170–0x0175) ──
// Allocated in range 0x0070–0x0075 under OP_DOMAIN_NAPI_RO.
//
// The CREATE variants take napi_value handles for code/msg (already-existing
// values), so they pack into four-u32 directly.  The THROW variants of these
// errors (napi_throw_error/type_error/range_error) take C strings and need
// string-encoding work — those are NOT in this batch.

export const OP_NAPI_CREATE_ERROR = OP_DOMAIN_NAPI_RO | 0x0070;
// napi_create_error(env, code: napi_value, msg: napi_value, &result)  — four-u32.
export const OP_NAPI_CREATE_TYPE_ERROR = OP_DOMAIN_NAPI_RO | 0x0071;
// napi_create_type_error(env, code: napi_value, msg: napi_value, &result)  — four-u32.
export const OP_NAPI_CREATE_RANGE_ERROR = OP_DOMAIN_NAPI_RO | 0x0072;
// napi_create_range_error(env, code: napi_value, msg: napi_value, &result)  — four-u32.
export const OP_NAPI_RESOLVE_DEFERRED = OP_DOMAIN_NAPI_RO | 0x0073;
// napi_resolve_deferred(env, deferred, resolution)  — three args, no resultPtr.
// Registered inline (no factory for "three-u32 no result").
export const OP_NAPI_REJECT_DEFERRED = OP_DOMAIN_NAPI_RO | 0x0074;
// napi_reject_deferred(env, deferred, rejection)  — three args, no resultPtr.
// Registered inline (no factory for "three-u32 no result").
export const OP_NAPI_THROW = OP_DOMAIN_NAPI_RO | 0x0075;
// napi_throw(env, error)  — two args, no resultPtr; fits makeNoResult.

// ── Lever B batch 3: string/property/error/int64 ops (0x0180–0x018E) ──
// Allocated in range 0x0080–0x008E under OP_DOMAIN_NAPI_RO.
//
// String creation/extraction ops take C-string POINTERS into wasm linear
// memory.  Since the host and wasm workers share that memory (F-2), the
// host's emnapi JS impl can read/write those bytes directly through the
// pointer; we pass the pointer as a plain u32 in the factory args, no
// RPC payload encoding required.
//
// The THROW variants of error fns take C strings for code+msg; same
// shared-memory trick — pointers go through as u32 args.
//
// The int64-taking ops (create_int64, create_bigint_uint64,
// adjust_external_memory) receive their int64 as (low: int32, high: int32)
// pairs in the emnapi v1 emscripten JS-side wrappers (verified in
// vendor/emnapi/packages/emnapi/src/value/convert2napi.ts and
// emscripten/memory.ts).  So they pack into makeFourU32 naturally.

export const OP_NAPI_CREATE_STRING_UTF8 = OP_DOMAIN_NAPI_RO | 0x0080;
// napi_create_string_utf8(env, str:char*, length:size_t, &result)  — four-u32.
export const OP_NAPI_CREATE_STRING_LATIN1 = OP_DOMAIN_NAPI_RO | 0x0081;
// napi_create_string_latin1(env, str:char*, length:size_t, &result)  — four-u32.
export const OP_NAPI_CREATE_STRING_UTF16 = OP_DOMAIN_NAPI_RO | 0x0082;
// napi_create_string_utf16(env, str:char16_t*, length:size_t, &result)  — four-u32.
export const OP_NAPI_GET_VALUE_STRING_LATIN1 = OP_DOMAIN_NAPI_RO | 0x0083;
// napi_get_value_string_latin1(env, value, buf, bufsize, &result_length)  — five-u32.
export const OP_NAPI_GET_VALUE_STRING_UTF16 = OP_DOMAIN_NAPI_RO | 0x0084;
// napi_get_value_string_utf16(env, value, buf, bufsize, &result_length)  — five-u32.
export const OP_NAPI_THROW_ERROR = OP_DOMAIN_NAPI_RO | 0x0085;
// napi_throw_error(env, code:char*, msg:char*)  — three args, no resultPtr.
// Registered inline (no factory for "three-u32 no result").
export const OP_NAPI_THROW_TYPE_ERROR = OP_DOMAIN_NAPI_RO | 0x0086;
// napi_throw_type_error(env, code:char*, msg:char*)  — same shape.
export const OP_NAPI_THROW_RANGE_ERROR = OP_DOMAIN_NAPI_RO | 0x0087;
// napi_throw_range_error(env, code:char*, msg:char*)  — same shape.
export const OP_NAPI_SET_NAMED_PROPERTY = OP_DOMAIN_NAPI_RO | 0x0088;
// napi_set_named_property(env, object, name:char*, value)  — four-u32; the
// 4th u32 is the assigned value handle (not a resultPtr).  Arity-shaped.
export const OP_NAPI_DEFINE_PROPERTIES = OP_DOMAIN_NAPI_RO | 0x0089;
// napi_define_properties(env, object, property_count, properties:descriptor*)
// — four-u32, no resultPtr.  The descriptor array lives in shared wasm memory;
// emnapi reads it through the pointer.  Arity-shaped (4 args to napi fn).
// (0x008a reserved for parity with OP_NAPI_GET_VALUE_INT64 numbering; not used.)
export const OP_NAPI_GET_TYPEDARRAY_INFO = OP_DOMAIN_NAPI_RO | 0x008b;
// napi_get_typedarray_info(env, typedarray, &type, &length, &data,
//                          &arraybuffer, &byte_offset)  — seven-u32.
export const OP_NAPI_CREATE_INT64 = OP_DOMAIN_NAPI_RO | 0x008c;
// napi_create_int64(env, low:int32, high:int32, &result)  — four-u32; emnapi
// v1's JS wrapper splits int64 into (low,high) u32 pair.
export const OP_NAPI_CREATE_BIGINT_UINT64 = OP_DOMAIN_NAPI_RO | 0x008d;
// napi_create_bigint_uint64(env, low:int32, high:int32, &result)  — four-u32;
// same (low,high) pair encoding.
export const OP_NAPI_ADJUST_EXTERNAL_MEMORY = OP_DOMAIN_NAPI_RO | 0x008e;
// napi_adjust_external_memory(env, low:int32, high:int32, &adjusted)  — four-u32;
// same (low,high) pair encoding.

// ── Lever B batch 4 cluster A: env cleanup hooks (0x01A0–0x01A1) ────
// Allocated in range 0x00A0–0x00A1 under OP_DOMAIN_NAPI_RO.
//
// These are callback-taking ops but in the SIMPLEST cluster: no GC,
// no cbinfo, callback fires once at env destroy.  The wasm-side `fun`
// is a funcref index that we substitute with a host-side JS closure
// (built via makeHostSideCallbackClosure) before handing to emnapi —
// emnapi's CleanupQueue accepts a JS callable directly.
//
// `arg` is opaque data passed to the callback at env destroy.
// Both ops are three args, no resultPtr.

export const OP_NAPI_ADD_ENV_CLEANUP_HOOK = OP_DOMAIN_NAPI_RO | 0x00A0;
// napi_add_env_cleanup_hook(env, fun: funcref-idx, arg: void*)
//   — three args, no resultPtr.  We replace `fun` with a JS closure
//   that round-trips to wasm via the reverse channel.
export const OP_NAPI_REMOVE_ENV_CLEANUP_HOOK = OP_DOMAIN_NAPI_RO | 0x00A1;
// napi_remove_env_cleanup_hook(env, fun: funcref-idx, arg: void*)
//   — three args, no resultPtr.  Looks up the previously-registered
//   closure by (env, cbPtr, dataPtr) and passes that to emnapi so its
//   reference-equality match in CleanupQueue.remove succeeds.

// ── Lever B batch 4 cluster B: external-data with finalizers (0x01B0–0x01B2) ──
// Allocated in range 0x00B0–0x00B2 under OP_DOMAIN_NAPI_RO.
//
// FINALIZER-shape callback ops.  Unlike cluster A's cleanup hooks,
// emnapi's Finalizer machinery (vendor/emnapi/packages/runtime/src/
// Finalizer.ts:52-66) does NOT branch on `typeof cb === 'function'` —
// it always coerces via `Number(finalize_callback)` and dispatches
// through `bridge.makeDynCall_vppp(fini)`, which on the host-worker
// stub table cannot resolve a host-side JS closure.
//
// #!~debt cluster-b-finalizers-noop: these ops therefore create the
// external/arraybuffer/buffer successfully but the registered
// finalize_cb is NEVER invoked — emnapi sees finalize_cb=0.  This
// matches the guest-side native edge behavior today (napi/src/guest/
// napi.rs:2246 also ignores _finalize_cb), so no semantic regression.
// Long-term fix: extend emnapi's Finalizer with a JS-callable branch
// (mirroring CleanupQueue.drain at runtime/src/Context.ts:86-90) OR
// route finalization through a host-side FinalizationRegistry that
// invokes makeHostSideCallbackClosure on GC.

export const OP_NAPI_CREATE_EXTERNAL = OP_DOMAIN_NAPI_RO | 0x00B0;
// napi_create_external(env, data, finalize_cb: funcref-idx,
//                      finalize_hint, &result) — five args.
// finalize_cb currently dropped (see cluster-b-finalizers-noop debt).

export const OP_NAPI_CREATE_EXTERNAL_ARRAYBUFFER = OP_DOMAIN_NAPI_RO | 0x00B1;
// napi_create_external_arraybuffer(env, external_data, byte_length,
//                                   finalize_cb: funcref-idx,
//                                   finalize_hint, &result) — six args.

export const OP_NAPI_CREATE_EXTERNAL_BUFFER = OP_DOMAIN_NAPI_RO | 0x00B2;
// napi_create_external_buffer(env, length, data,
//                              finalize_cb: funcref-idx,
//                              finalize_hint, &result) — six args.

// ── Lever B batch 4 cluster C: object wrap lifecycle (0x01C0–0x01C3) ──
// Allocated in range 0x00C0–0x00C3 under OP_DOMAIN_NAPI_RO.
//
// Object-wrap (napi_wrap / napi_unwrap / napi_remove_wrap) attaches an
// opaque native pointer to a JS object and can run a finalizer when the
// JS object is collected.  napi_add_finalizer is the same machinery but
// without a wrapped data slot.
//
// napi_unwrap and napi_remove_wrap take no callback — pure object-binding
// reads/clears, dispatched via the THREE_U32 factory.
//
// napi_wrap and napi_add_finalizer carry a finalize_cb funcref index.
// Like cluster B, emnapi's Finalizer dispatches finalize_cb through
// `bridge.makeDynCall_vppp(fini)`, which on the host-worker is wired to
// a silent no-op factory (see napi-host/unofficial.ts dyncall-before-table-ready
// debt).  So storing the funcref index does no harm at finalize-time —
// the dispatcher swallows the call.
//
// #!~debt cluster-c-finalizers-noop: we build a host-side closure via
// makeHostSideCallbackClosure(shape=FINALIZER) and cache it in a Map,
// but emnapi receives only the integer funcref index — never the JS
// closure.  This mirrors cluster B's mitigation: the plumbing is in
// place for a future emnapi patch (or host-side FinalizationRegistry)
// to wire the cached closure to actual GC events.  Until then the
// finalizer is dormant; matches the guest-side native edge behavior
// (napi/src/guest/napi.rs drops _finalize_cb) so no net regression.
//
// napi_add_finalizer's emnapi impl rejects finalize_cb=0 with
// napi_invalid_arg ($CHECK_ARG! at wrap.ts:187).  So unlike cluster B
// (which can pass 0 freely), cluster C passes the original cbPtr
// through to emnapi for both napi_wrap (when caller supplied non-zero)
// and napi_add_finalizer (always).  Safe because makeDynCall_vppp is
// a noop factory.

export const OP_NAPI_WRAP = OP_DOMAIN_NAPI_RO | 0x00C0;
// napi_wrap(env, js_object, native_obj, finalize_cb: funcref-idx,
//           finalize_hint, &result_optional) — six args.
// result is optional (0 means "no userland ref returned").  emnapi
// requires non-zero finalize_cb iff result is non-zero (else returns
// napi_invalid_arg via internal.ts:118).

export const OP_NAPI_UNWRAP = OP_DOMAIN_NAPI_RO | 0x00C1;
// napi_unwrap(env, js_object, &result) — three args; THREE_U32 factory.

export const OP_NAPI_REMOVE_WRAP = OP_DOMAIN_NAPI_RO | 0x00C2;
// napi_remove_wrap(env, js_object, &result) — three args; THREE_U32 factory.

export const OP_NAPI_ADD_FINALIZER = OP_DOMAIN_NAPI_RO | 0x00C3;
// napi_add_finalizer(env, js_object, finalize_data,
//                    finalize_cb: funcref-idx,
//                    finalize_hint, &result_optional) — six args.
// emnapi requires finalize_cb != 0 always (wrap.ts:187).

// ── B / scope-op forwarding (0x01D0–0x01D2) ─────────────────────────
//
// These ops mirror the wasm-side `napi_open_handle_scope` /
// `napi_close_handle_scope` so the host's emnapi scope discipline
// matches the wasm-side's.  Without this, host-RPC ops that allocate
// napi_value handles (every `OP_NAPI_CREATE_*` etc.) leak handles
// into the host's long-lived root scope (R9 fix; see NOTES.md
// `host-emnapi-root-scope-accumulates`).
//
// Wire protocol:
//   OPEN  request: (env: u32) — wasm side has already opened its own
//         scope; this just asks the host to open a parallel scope.
//   OPEN  reply:   (hostScopeId: u32) — the host's scope id, returned
//         to the wasm side which maps it against its wasm-side id.
//   CLOSE request: (env: u32, hostScopeId: u32) — close the host
//         scope identified by hostScopeId.  Host releases all handles
//         allocated during that scope's lifetime.
//   CLOSE reply:   empty.
//
// napi_open_escapable_handle_scope is deferred — same shape but
// requires escape() bookkeeping.  Add when a workload exercises it.
//
// Probe op:
//   DEBUG_HANDLE_STORE_SIZE request: empty.
//   DEBUG_HANDLE_STORE_SIZE reply:   (size: u32) — current host
//         handleStore length.  Used by the scope-forwarding test to
//         assert bounded growth across a loop of host-RPC ops.

export const OP_NAPI_OPEN_HANDLE_SCOPE = OP_DOMAIN_NAPI_RO | 0x00D0;
export const OP_NAPI_CLOSE_HANDLE_SCOPE = OP_DOMAIN_NAPI_RO | 0x00D1;
export const OP_NAPI_DEBUG_HANDLE_STORE_SIZE = OP_DOMAIN_NAPI_RO | 0x00D2;

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

// ── F-9 batch 4 cluster D: napi_callback-shape ops ──────────────────
//
// These mint host-side JS closures via makeHostSideCallbackClosure
// (shape=NAPI_CALLBACK) and bind them to napi_values returned to the
// wasm caller.  Invocation goes through the reverse channel back to
// wasm via OP_INVOKE_WASM_CALLBACK.
export const OP_NAPI_CREATE_FUNCTION = OP_DOMAIN_NAPI_CB | 0x0004;
// napi_create_function(env, utf8name, length, cb_funcref, data, &result)
// 6 u32 args; utf8name/length name the function (best-effort decode).

export const OP_NAPI_DEFINE_CLASS = OP_DOMAIN_NAPI_CB | 0x0005;
// napi_define_class(env, utf8name, length, constructor_funcref,
//                   data, property_count, properties_ptr, &result)
// 8 u32 args.  properties_ptr points to an array of napi_property_descriptor
// structs in shared memory; each descriptor may carry its own funcref(s).

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

// ── Host-API bridge ops (E18) ───────────────────────────────────────
//
// These ops let wasm-side policies route Node sync APIs to host async
// APIs by parking the wasm thread on a sync RPC.  The host handler does
// `await` on the host-side async API and writes the bytes to the reply
// slot; wasm wakes via Atomics.wait and returns the bytes synchronously
// to the caller.
//
// Generic shape (request → reply):
//   Request:  arg-specific payload (see per-op layout below)
//   Reply:    raw result bytes; status = REPLY_STATUS_OK on success
//             or REPLY_STATUS_HOST_ERROR with UTF-8 error message.

export const OP_SUBTLE_DIGEST = OP_DOMAIN_HOST_API | 0x0001;
// Compute a one-shot crypto digest via host SubtleCrypto.digest().
// Request payload layout (LE u32 lengths, contiguous bytes):
//   [u32 algo_name_len][utf-8 algo_name][u32 data_len][data]
// Where algo_name is a WebCrypto algorithm identifier
// (e.g. "SHA-256", "SHA-384") — the policy is responsible for the
// Node↔WebCrypto naming mapping.
// Reply payload: raw digest bytes (length determined by algorithm —
// SHA-1=20, SHA-256=32, SHA-384=48, SHA-512=64).
// Status: REPLY_STATUS_OK on success; HOST_ERROR if SubtleCrypto
// throws (e.g. unknown algorithm).
//
// E18 caveat (resolved in E22): the data is framed into the SAME RPC
// slot as the algo name, capping input at ~4055 B post-framing.  E22
// adds OP_SUBTLE_DIGEST_VIA_NAPI_MEM that routes the data through the
// shared napi-host-memory SAB; this op is retained for the small-input
// fast path and for the Node test harness's simpler implementation.

// E22: digest staging region offset in the shared napi-host-memory
// SAB.  Both the host-worker (which reads input bytes from here) and
// the wasm runtime worker (which writes input bytes here before
// sending OP_SUBTLE_DIGEST_VIA_NAPI_MEM) reference this constant.
// 128 KiB places staging above the napi handle bump allocator (which
// grows from 16 KiB upward) and below the 256 KiB initial memory
// ceiling; ~128 KiB of input fits without growing napi memory.
export const DIGEST_STAGING_OFFSET = 128 * 1024;

export const OP_SUBTLE_HMAC = OP_DOMAIN_HOST_API | 0x0002;
// E21: HMAC via SubtleCrypto.sign({name:'HMAC'}, key, data).  Sync RPC
// pattern mirrors OP_SUBTLE_DIGEST; wire format extends with a key-bytes
// preamble.  Request: [u32 algo_name_len][algo_name][u32 key_len][key]
// [u32 data_len][data].  Reply: raw HMAC bytes.

export const OP_SUBTLE_DIGEST_VIA_NAPI_MEM = OP_DOMAIN_HOST_API | 0x0003;
// E22: same semantics as OP_SUBTLE_DIGEST, but the data bytes travel
// through the shared napi-host-memory SAB instead of the RPC slot.
// Lets us hash arbitrarily large inputs (bounded only by the napi
// memory size, currently up to ~1MB) without multi-slot framing.
//
// Request payload layout (LE u32, contiguous bytes):
//   [u32 algo_name_len][utf-8 algo_name][u32 data_offset][u32 data_len]
// Total request size is small (<100 B) regardless of data size — the
// data lives at `napiHostMemory.buffer[data_offset .. data_offset+data_len]`
// and is read directly by the host handler.
//
// Reply payload: raw digest bytes (same as OP_SUBTLE_DIGEST).
// Status: REPLY_STATUS_OK on success; HOST_ERROR if SubtleCrypto throws;
// INVALID_ARGS if the (offset, length) pair overruns the napi memory.
//
// Memory layout invariants (host-worker.ts):
//   - napi handle pool grows from 16 KiB upward (bump-allocated).
//   - Digest staging region reserved at offset DIGEST_STAGING_OFFSET
//     (128 KiB).  Caller writes input bytes there before sending RPC;
//     the staging region is reused per call because the wasm worker is
//     single-flight on this sync RPC (Atomics.wait blocks the thread).

export const OP_SUBTLE_HMAC_VIA_NAPI_MEM = OP_DOMAIN_HOST_API | 0x0004;
// E22-C: same semantics as OP_SUBTLE_HMAC, but the key AND data bytes
// travel through the shared napi-host-memory SAB.  Lets us HMAC inputs
// whose combined (key + data) size exceeds the ~4 KiB single-slot
// framing budget E21 inherited from E18.
//
// Request payload layout (LE u32, contiguous bytes):
//   [u32 algo_name_len][utf-8 algo_name]
//   [u32 key_offset][u32 key_len]
//   [u32 data_offset][u32 data_len]
// Total request size is small (<100 B) regardless of key/data size —
// both buffers live in `napiHostMemory.buffer` at their respective
// offsets and are read directly by the host handler.
//
// Reply payload: raw HMAC bytes (same as OP_SUBTLE_HMAC).
// Status: REPLY_STATUS_OK on success; HOST_ERROR if SubtleCrypto throws;
// INVALID_ARGS if either (offset, len) pair overruns the napi memory.
//
// Memory layout (shares the digest staging region — both ops are
// single-flight via sync RPC so no overlap):
//   - Key goes at DIGEST_STAGING_OFFSET (128 KiB).
//   - Data follows at DIGEST_STAGING_OFFSET + ((keyLen + 7) & ~7)
//     (8-byte aligned to keep the staging region clean).
//   - Combined region capped by napi memory size (4 pages = 256 KiB
//     initial → 128 KiB available; max 16 pages = 1 MiB).

export const OP_SPAWN_USER_WORKER = OP_DOMAIN_HOST_API | 0x0005;
// Worker_threads phase 1: spawn a new (host+wasm) pair to back a Node
// `new Worker(filename)` call.  Sync RPC from the parent wasm runtime
// (which got the call from lib's patched worker.js → globalThis.
// __edgeSpawnNodeWorker) to its host worker, which forwards to the
// main page via postMessage; main spawns the pair, returns a workerId.
//
// Request payload layout (LE u32 lengths, contiguous bytes):
//   [u32 src_path_len][utf-8 src_path]
//   [u32 worker_data_len][worker_data bytes — structured-clone-marshaled
//                         per cross-context-marshal.ts; empty if none]
// Reply payload: [u32 workerId] (little-endian).
// Status: REPLY_STATUS_OK on successful spawn; HOST_ERROR if the
//   spawn cap (16) is exceeded or main-side spawn throws.
//
// The actual Web Worker construction is asynchronous on main but the
// RPC is sync from wasm's view: lib's `new Worker()` returns the
// workerId before main has finished bootstrapping the child wasm.
// Per E25, pre-queued bootstrap messages survive the parent's next
// blocking call (JSPI suspend) so the child has time to wake up.

export const OP_DELIVER_USER_WORKER_EXIT = OP_DOMAIN_HOST_API | 0x0006;
// Reverse-channel op (host → wasm).  When a spawned user-worker's wasm
// runtime catches an ExitSignal, it posts {kind:'user-worker-exit',
// workerId, code} to its host; the child host posts to main; main
// forwards to the parent's host; parent's host fires this reverse RPC
// into parent's wasm runtime.  Parent's wasm handler invokes the JS
// callback that lib's `worker.on('exit', cb)` registered.
//
// Request payload layout (LE u32):
//   [u32 workerId][u32 exit_code]
// Reply payload: empty.
// Status: REPLY_STATUS_OK once the parent-side callback has been
//   queued (not necessarily invoked — invocation happens on parent's
//   event loop turn).

// ── Worker_threads phase 2: postMessage ─────────────────────────────
//
// Bidirectional structured-clone message passing between a parent
// (host+wasm) pair and its spawned user-worker pair.  Same chain shape
// as phase 1's spawn/exit ops: forward = wasm→host sync RPC, reverse =
// host→wasm via reverseRpcServer; main page routes between the host
// workers.  Marshaled bytes use the wire format from
// `cross-context-marshal.ts` (see `host-worker/marshal-postmessage.ts`
// for the wrapper).

export const OP_WORKER_POST_MESSAGE_TO_CHILD = OP_DOMAIN_HOST_API | 0x0007;
// Forward op (wasm → host).  Parent's wasm runtime calls this when
// user JS does `worker.postMessage(data)`.  The host handler fire-and-
// forget posts to main with the workerId + marshaled bytes; main routes
// to the child host which fires OP_DELIVER_MESSAGE_TO_CHILD.
//
// Request payload layout (LE u32):
//   [u32 workerId][u32 bytes_len][marshaled bytes]
// Reply payload: empty.
// Status: REPLY_STATUS_OK on enqueue (NOT on delivery — delivery is
//   asynchronous from the parent's perspective, matching Node's
//   postMessage semantics).

export const OP_WORKER_POST_MESSAGE_TO_PARENT = OP_DOMAIN_HOST_API | 0x0008;
// Forward op (wasm → host).  Child's wasm runtime calls this when user
// JS does `parentPort.postMessage(data)`.  Child host fire-and-forget
// posts to main; main looks up the parent host via the userWorkers
// registry and forwards via OP_DELIVER_MESSAGE_FROM_CHILD.
//
// Request payload layout (LE u32):
//   [u32 bytes_len][marshaled bytes]
// (No workerId field; child knows its own workerId implicitly — main
// derives the routing target from the source host's id.)
// Reply payload: empty.

export const OP_DELIVER_MESSAGE_TO_CHILD = OP_DOMAIN_HOST_API | 0x0009;
// Reverse op (host → wasm).  Fires from the child host's reverseClient
// into the child wasm runtime when a message arrives from the parent.
// Child wasm's handler invokes `globalThis.__edgeDispatchMessageToChild`
// which the policy patch (worker-threads-per-thread.ts) wires to
// `parentPort.emit('message', unpacked)`.
//
// Request payload layout (LE u32):
//   [u32 bytes_len][marshaled bytes]

export const OP_DELIVER_MESSAGE_FROM_CHILD = OP_DOMAIN_HOST_API | 0x000A;

// child-process-via-executor (async path): wasm spawnSync -> sync RPC
// here, host-worker postMessages main, main calls user-installed
// async executor (Promise-returning), result chain back to wasm.
//
// Why this op vs OP_RUN_USER_SCRIPT: that one runs JS on host-worker
// V8 (no Node API access). This one runs the USER'S registered
// executor on MAIN where they can call e.g. `await new Bash().exec(...)`
// or any async API. Sync wait happens at the wasm worker via
// Atomics.wait in the SAB-ring sync client (the existing mechanism
// OP_SPAWN_USER_WORKER uses).
//
// Request payload: utf-8 JSON of
//   { command: string, args: string[], env?: object, cwd?: string,
//     input?: number[] /* bytes */, timeout?: number }
// Reply payload: utf-8 JSON of
//   { stdout: number[], stderr: number[], code: number|null,
//     signal: string|null, error?: { code: string, message: string } }
// JSON keeps MVP simple; we can switch to a binary frame later for
// large stdio without changing call sites.
//
// `REPLY_STATUS_HOST_ERROR` is returned if main hasn't registered an
// executor; wasm side falls back to the default fake shell.
export const OP_RUN_CHILD_PROCESS = OP_DOMAIN_HOST_API | 0x000B;
// Reverse op (host → wasm).  Fires from the parent host's reverseClient
// into the parent wasm runtime when a message arrives from a child.
// Parent wasm's handler invokes `globalThis.__edgeDispatchMessageFromChild`
// which looks up the Worker instance in `workerById` and emits 'message'.
//
// Request payload layout (LE u32):
//   [u32 workerId][u32 bytes_len][marshaled bytes]
// E22-C: same semantics as OP_SUBTLE_HMAC, but the key AND data bytes
// travel through the shared napi-host-memory SAB.  Lets us HMAC inputs
// whose combined (key + data) size exceeds the ~4 KiB single-slot
// framing budget E21 inherited from E18.
//
// Request payload layout (LE u32, contiguous bytes):
//   [u32 algo_name_len][utf-8 algo_name]
//   [u32 key_offset][u32 key_len]
//   [u32 data_offset][u32 data_len]
// Total request size is small (<100 B) regardless of key/data size —
// both buffers live in `napiHostMemory.buffer` at their respective
// offsets and are read directly by the host handler.
//
// Reply payload: raw HMAC bytes (same as OP_SUBTLE_HMAC).
// Status: REPLY_STATUS_OK on success; HOST_ERROR if SubtleCrypto throws;
// INVALID_ARGS if either (offset, len) pair overruns the napi memory.
//
// Memory layout (shares the digest staging region — both ops are
// single-flight via sync RPC so no overlap):
//   - Key goes at DIGEST_STAGING_OFFSET (128 KiB).
//   - Data follows at DIGEST_STAGING_OFFSET + ((keyLen + 7) & ~7)
//     (8-byte aligned to keep the staging region clean).
//   - Combined region capped by napi memory size (4 pages = 256 KiB
//     initial → 128 KiB available; max 16 pages = 1 MiB).

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
