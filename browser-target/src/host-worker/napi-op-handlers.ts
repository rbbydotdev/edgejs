// F-4: napi op handler factories.  Each factory takes a napi function
// from `napiModule.imports.napi` and returns an RPC handler that
// decodes the request payload, calls the underlying function, and
// returns the napi_status.  Out-parameters are written to wasm memory
// directly by the underlying emnapi function (we share the memory).
//
// Argument-shape conventions (encoded little-endian in the request
// payload, after the 8-byte request header):
//
//   "two-arg":   (env: u32, resultPtr: u32)
//                examples: napi_get_undefined, napi_get_null, napi_get_global
//   "three-arg": (env: u32, valueHandle: u32, resultPtr: u32)
//                examples: napi_typeof, napi_get_value_int32, napi_is_array
//   "four-arg":  (env: u32, recvHandle: u32, valueHandle: u32, resultPtr: u32)
//                examples: napi_get_named_property (with name+receiver),
//                          napi_strict_equals (a, b, result)
//   "five-arg":  (env: u32, a: u32, b: u32, c: u32, resultPtr: u32)
//                examples: napi_create_object-with-properties (rare)
//
// Handlers return { payload: empty, status: napiStatus }.  All actual
// data writes happen through shared memory at the resultPtr address.

import type { RpcServer, HandlerContext } from "./rpc-server";
import {
  OP_NAPI_CALL_FUNCTION,
  OP_NAPI_NEW_INSTANCE,
  OP_NAPI_CREATE_REFERENCE,
  OP_NAPI_GET_BOOLEAN,
  OP_NAPI_TYPEOF, OP_NAPI_GET_ARRAY_LENGTH,
  OP_NAPI_IS_ARRAY, OP_NAPI_IS_TYPEDARRAY, OP_NAPI_IS_BUFFER,
  OP_NAPI_IS_DATE, OP_NAPI_IS_PROMISE, OP_NAPI_IS_ERROR,
  OP_NAPI_IS_EXCEPTION_PENDING,
  OP_NAPI_GET_VALUE_INT32, OP_NAPI_GET_VALUE_UINT32,
  OP_NAPI_GET_VALUE_DOUBLE, OP_NAPI_GET_VALUE_BOOL,
  OP_NAPI_GET_VALUE_BIGINT_INT64, OP_NAPI_GET_VALUE_BIGINT_UINT64,
  OP_NAPI_GET_DATE_VALUE,
  OP_NAPI_GET_PROTOTYPE, OP_NAPI_GET_PROPERTY_NAMES,
  OP_NAPI_GET_PROPERTY, OP_NAPI_GET_NAMED_PROPERTY,
  OP_NAPI_HAS_PROPERTY, OP_NAPI_HAS_NAMED_PROPERTY,
  OP_NAPI_STRICT_EQUALS,
  OP_NAPI_DELETE_REFERENCE, OP_NAPI_GET_REFERENCE_VALUE,
  OP_NAPI_REFERENCE_REF, OP_NAPI_REFERENCE_UNREF,
  OP_NAPI_CREATE_OBJECT, OP_NAPI_CREATE_ARRAY,
  OP_NAPI_CREATE_ARRAY_WITH_LENGTH,
  OP_NAPI_SET_ELEMENT, OP_NAPI_GET_ELEMENT,
  OP_NAPI_SET_PROPERTY, OP_NAPI_DELETE_PROPERTY,
  OP_NAPI_HAS_OWN_PROPERTY, OP_NAPI_OBJECT_FREEZE,
  OP_NAPI_INSTANCEOF,
  // Lever B batch (0x0140–0x0149):
  OP_NAPI_CREATE_INT32, OP_NAPI_CREATE_UINT32,
  OP_NAPI_GET_VALUE_INT64, OP_NAPI_GET_VALUE_EXTERNAL,
  OP_NAPI_IS_ARRAYBUFFER, OP_NAPI_IS_DATAVIEW,
  OP_NAPI_IS_DETACHED_ARRAYBUFFER, OP_NAPI_GET_NEW_TARGET,
  OP_NAPI_GET_AND_CLEAR_LAST_EXCEPTION,
  OP_NAPI_GET_ALL_PROPERTY_NAMES,
  // Lever B batch (0x0150–0x0159): coerce + buffer-introspection ops.
  OP_NAPI_COERCE_TO_BOOL, OP_NAPI_COERCE_TO_NUMBER,
  OP_NAPI_COERCE_TO_OBJECT, OP_NAPI_COERCE_TO_STRING,
  OP_NAPI_GET_ARRAYBUFFER_INFO, OP_NAPI_GET_BUFFER_INFO,
  OP_NAPI_GET_DATAVIEW_INFO,
  OP_NODE_API_SET_PROTOTYPE,
  // Lever B batch 2 (0x0170–0x0175): error-create + throw + deferred ops.
  OP_NAPI_CREATE_ERROR, OP_NAPI_CREATE_TYPE_ERROR, OP_NAPI_CREATE_RANGE_ERROR,
  OP_NAPI_RESOLVE_DEFERRED, OP_NAPI_REJECT_DEFERRED, OP_NAPI_THROW,
  // Lever B batch 2 (0x0160–0x016B): buffer/typed-array/value-creation ops.
  OP_NAPI_CREATE_ARRAYBUFFER, OP_NAPI_CREATE_BUFFER, OP_NAPI_CREATE_BUFFER_COPY,
  OP_NAPI_CREATE_TYPEDARRAY, OP_NAPI_CREATE_DATE, OP_NAPI_CREATE_SYMBOL,
  OP_NAPI_CREATE_PROMISE, OP_NODE_API_CREATE_SHAREDARRAYBUFFER,
  OP_NODE_API_IS_SHAREDARRAYBUFFER, OP_NAPI_RUN_SCRIPT, OP_NAPI_GET_CB_INFO,
  OP_NAPI_CREATE_DOUBLE,
  // Lever B batch 3 (0x0180–0x018E): string/property/error/int64 ops.
  OP_NAPI_CREATE_STRING_UTF8, OP_NAPI_CREATE_STRING_LATIN1,
  OP_NAPI_CREATE_STRING_UTF16,
  OP_NAPI_GET_VALUE_STRING_LATIN1, OP_NAPI_GET_VALUE_STRING_UTF16,
  OP_NAPI_THROW_ERROR, OP_NAPI_THROW_TYPE_ERROR, OP_NAPI_THROW_RANGE_ERROR,
  OP_NAPI_SET_NAMED_PROPERTY, OP_NAPI_DEFINE_PROPERTIES,
  OP_NAPI_GET_TYPEDARRAY_INFO,
  OP_NAPI_CREATE_INT64, OP_NAPI_CREATE_BIGINT_UINT64,
  OP_NAPI_ADJUST_EXTERNAL_MEMORY,
  // Lever B batch 4 cluster A (0x01A0–0x01A1): env cleanup hooks.
  OP_NAPI_ADD_ENV_CLEANUP_HOOK, OP_NAPI_REMOVE_ENV_CLEANUP_HOOK,
  // Lever B batch 4 cluster B (0x01B0–0x01B2): external-data with finalizers.
  OP_NAPI_CREATE_EXTERNAL, OP_NAPI_CREATE_EXTERNAL_ARRAYBUFFER,
  OP_NAPI_CREATE_EXTERNAL_BUFFER,
  // Lever B batch 4 cluster C (0x01C0–0x01C3): object wrap lifecycle.
  OP_NAPI_WRAP, OP_NAPI_UNWRAP, OP_NAPI_REMOVE_WRAP, OP_NAPI_ADD_FINALIZER,
  REPLY_STATUS_INVALID_ARGS,
} from "./rpc-protocol";
import {
  makeHostSideCallbackClosure,
  CALLBACK_SHAPE_CLEANUP_HOOK,
  CALLBACK_SHAPE_FINALIZER,
} from "./callback-dispatch";
import { getHostSideReverseSyncClient } from "./host-worker";

const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();

function err(msg: string, status = REPLY_STATUS_INVALID_ARGS) {
  return { payload: enc.encode(msg), status };
}

type NapiFn = (...args: number[]) => number;

/** Make a handler for two-u32 ops (env, resultPtr). */
function makeTwoU32(napiFn: NapiFn | undefined, opName: string) {
  return async (_ctx: HandlerContext, args: Uint8Array) => {
    if (typeof napiFn !== "function") return err(`napi handler: ${opName} not found`);
    if (args.byteLength < 8) return err("napi handler: args too short for two-u32");
    const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const env = dv.getUint32(0, true);
    const ptr = dv.getUint32(4, true);
    return { payload: EMPTY, status: napiFn(env, ptr) };
  };
}

/** Make a handler for three-u32 ops (env, value, resultPtr). */
function makeThreeU32(napiFn: NapiFn | undefined, opName: string) {
  return async (_ctx: HandlerContext, args: Uint8Array) => {
    if (typeof napiFn !== "function") return err(`napi handler: ${opName} not found`);
    if (args.byteLength < 12) return err("napi handler: args too short for three-u32");
    const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const env = dv.getUint32(0, true);
    const a = dv.getUint32(4, true);
    const ptr = dv.getUint32(8, true);
    return { payload: EMPTY, status: napiFn(env, a, ptr) };
  };
}

/** Make a handler for four-u32 ops (env, a, b, resultPtr). */
function makeFourU32(napiFn: NapiFn | undefined, opName: string) {
  return async (_ctx: HandlerContext, args: Uint8Array) => {
    if (typeof napiFn !== "function") return err(`napi handler: ${opName} not found`);
    if (args.byteLength < 16) return err("napi handler: args too short for four-u32");
    const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const env = dv.getUint32(0, true);
    const a = dv.getUint32(4, true);
    const b = dv.getUint32(8, true);
    const ptr = dv.getUint32(12, true);
    return { payload: EMPTY, status: napiFn(env, a, b, ptr) };
  };
}

/** Make a handler for five-u32 ops (env, a, b, c, resultPtr).
 *  Example: napi_new_instance(env, constructor, argc, argv_ptr, result). */
function makeFiveU32(napiFn: NapiFn | undefined, opName: string) {
  return async (_ctx: HandlerContext, args: Uint8Array) => {
    if (typeof napiFn !== "function") return err(`napi handler: ${opName} not found`);
    if (args.byteLength < 20) return err("napi handler: args too short for five-u32");
    const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    return {
      payload: EMPTY,
      status: napiFn(
        dv.getUint32(0, true),
        dv.getUint32(4, true),
        dv.getUint32(8, true),
        dv.getUint32(12, true),
        dv.getUint32(16, true),
      ),
    };
  };
}

/** Make a handler for six-u32 ops (env, a, b, c, d, resultPtr).
 *  Example: napi_call_function(env, recv, fn, argc, argv_ptr, result). */
function makeSixU32(napiFn: NapiFn | undefined, opName: string) {
  return async (_ctx: HandlerContext, args: Uint8Array) => {
    if (typeof napiFn !== "function") return err(`napi handler: ${opName} not found`);
    if (args.byteLength < 24) return err("napi handler: args too short for six-u32");
    const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    return {
      payload: EMPTY,
      status: napiFn(
        dv.getUint32(0, true),
        dv.getUint32(4, true),
        dv.getUint32(8, true),
        dv.getUint32(12, true),
        dv.getUint32(16, true),
        dv.getUint32(20, true),
      ),
    };
  };
}

/** Make a handler for seven-u32 ops (env, a, b, c, d, e, resultPtr).
 *  Example: napi_get_typedarray_info(env, typedarray, &type, &length, &data,
 *           &arraybuffer, &byte_offset). */
function makeSevenU32(napiFn: NapiFn | undefined, opName: string) {
  return async (_ctx: HandlerContext, args: Uint8Array) => {
    if (typeof napiFn !== "function") return err(`napi handler: ${opName} not found`);
    if (args.byteLength < 28) return err("napi handler: args too short for seven-u32");
    const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    return {
      payload: EMPTY,
      status: napiFn(
        dv.getUint32(0, true),
        dv.getUint32(4, true),
        dv.getUint32(8, true),
        dv.getUint32(12, true),
        dv.getUint32(16, true),
        dv.getUint32(20, true),
        dv.getUint32(24, true),
      ),
    };
  };
}

/** Make a handler for napi_get_boolean (env, bool_value: u32, resultPtr).
 *  Same shape as three-u32; just clarifies intent. */
const makeGetBoolean = makeThreeU32;

export interface NapiOpRegistry {
  register: (server: RpcServer) => void;
  count: number;
}

/** Register all F-4 read-only napi op handlers against the given server.
 *  `napi` is the populated `napiModule.imports.napi` object. */
export function makeNapiOpRegistry(napi: Record<string, NapiFn>): NapiOpRegistry {
  // Op → (factory, namespace-name) table.
  // Most ops follow predictable shapes from napi.h.
  const TWO_U32: Array<[number, string]> = [
    // OP_NAPI_GET_UNDEFINED etc. are registered by the caller (host-worker.ts)
    // because they came in F-1 already.  Listing here for completeness only
    // if we want to RE-register; we don't — the caller skips these via the
    // `excludeAlreadyRegistered` set.
    [OP_NAPI_CREATE_OBJECT, "napi_create_object"],
    [OP_NAPI_CREATE_ARRAY, "napi_create_array"],
    // Lever B batch.
    [OP_NAPI_GET_AND_CLEAR_LAST_EXCEPTION, "napi_get_and_clear_last_exception"],
  ];

  const THREE_U32: Array<[number, string]> = [
    [OP_NAPI_TYPEOF, "napi_typeof"],
    [OP_NAPI_GET_ARRAY_LENGTH, "napi_get_array_length"],
    [OP_NAPI_IS_ARRAY, "napi_is_array"],
    [OP_NAPI_IS_TYPEDARRAY, "napi_is_typedarray"],
    [OP_NAPI_IS_BUFFER, "napi_is_buffer"],
    [OP_NAPI_IS_DATE, "napi_is_date"],
    [OP_NAPI_IS_PROMISE, "napi_is_promise"],
    [OP_NAPI_IS_ERROR, "napi_is_error"],
    [OP_NAPI_IS_EXCEPTION_PENDING, "napi_is_exception_pending"],
    [OP_NAPI_GET_VALUE_INT32, "napi_get_value_int32"],
    [OP_NAPI_GET_VALUE_UINT32, "napi_get_value_uint32"],
    [OP_NAPI_GET_VALUE_DOUBLE, "napi_get_value_double"],
    [OP_NAPI_GET_VALUE_BOOL, "napi_get_value_bool"],
    [OP_NAPI_GET_VALUE_BIGINT_INT64, "napi_get_value_bigint_int64"],
    [OP_NAPI_GET_VALUE_BIGINT_UINT64, "napi_get_value_bigint_uint64"],
    [OP_NAPI_GET_DATE_VALUE, "napi_get_date_value"],
    [OP_NAPI_GET_PROTOTYPE, "napi_get_prototype"],
    [OP_NAPI_GET_PROPERTY_NAMES, "napi_get_property_names"],
    [OP_NAPI_GET_BOOLEAN, "napi_get_boolean"],
    [OP_NAPI_GET_REFERENCE_VALUE, "napi_get_reference_value"],
    [OP_NAPI_REFERENCE_REF, "napi_reference_ref"],
    [OP_NAPI_REFERENCE_UNREF, "napi_reference_unref"],
    [OP_NAPI_CREATE_ARRAY_WITH_LENGTH, "napi_create_array_with_length"],
    // Lever B batch.  napi_create_int32/uint32 receive the value as a u32
    // arg slot; emnapi's JS impl coerces to int32/uint32 internally.  JS
    // numbers fit either range exactly so passing through makeThreeU32 is
    // lossless.  napi_get_value_int64 writes 8 bytes to memory at
    // resultPtr — the factory just forwards the pointer, no JS-side
    // deserialization of the result.
    [OP_NAPI_CREATE_INT32, "napi_create_int32"],
    [OP_NAPI_CREATE_UINT32, "napi_create_uint32"],
    [OP_NAPI_GET_VALUE_INT64, "napi_get_value_int64"],
    [OP_NAPI_GET_VALUE_EXTERNAL, "napi_get_value_external"],
    [OP_NAPI_IS_ARRAYBUFFER, "napi_is_arraybuffer"],
    [OP_NAPI_IS_DATAVIEW, "napi_is_dataview"],
    [OP_NAPI_IS_DETACHED_ARRAYBUFFER, "napi_is_detached_arraybuffer"],
    [OP_NAPI_GET_NEW_TARGET, "napi_get_new_target"],
    // Lever B batch (0x0150–0x0153): coerce-to-* ops, all three-u32.
    [OP_NAPI_COERCE_TO_BOOL, "napi_coerce_to_bool"],
    [OP_NAPI_COERCE_TO_NUMBER, "napi_coerce_to_number"],
    [OP_NAPI_COERCE_TO_OBJECT, "napi_coerce_to_object"],
    [OP_NAPI_COERCE_TO_STRING, "napi_coerce_to_string"],
    // Lever B batch 2 (0x0164–0x016B subset): three-u32 creation/query ops.
    // napi_create_date/create_double take a double; the factory passes the
    // JS-number arg through, and JS numbers ARE doubles, so this is lossless.
    // napi_create_promise has TWO out-pointers (deferred, promise) packed
    // into the (a, ptr) slots; arity-shaped not semantics-shaped.
    [OP_NAPI_CREATE_DATE, "napi_create_date"],
    [OP_NAPI_CREATE_SYMBOL, "napi_create_symbol"],
    [OP_NAPI_CREATE_PROMISE, "napi_create_promise"],
    [OP_NODE_API_IS_SHAREDARRAYBUFFER, "node_api_is_sharedarraybuffer"],
    [OP_NAPI_RUN_SCRIPT, "napi_run_script"],
    [OP_NAPI_CREATE_DOUBLE, "napi_create_double"],
    // Lever B batch 4 cluster C (0x01C1, 0x01C2): napi_unwrap / napi_remove_wrap
    // — (env, js_object, &result); pure THREE_U32 shape, no callback.
    [OP_NAPI_UNWRAP, "napi_unwrap"],
    [OP_NAPI_REMOVE_WRAP, "napi_remove_wrap"],
  ];

  const FOUR_U32: Array<[number, string]> = [
    [OP_NAPI_GET_PROPERTY, "napi_get_property"],
    [OP_NAPI_GET_NAMED_PROPERTY, "napi_get_named_property"],
    [OP_NAPI_HAS_PROPERTY, "napi_has_property"],
    [OP_NAPI_HAS_NAMED_PROPERTY, "napi_has_named_property"],
    [OP_NAPI_STRICT_EQUALS, "napi_strict_equals"],
    // makeFourU32 passes (env, a, b, ptr) to napiFn.  For these two ops the
    // 4th u32 is the VALUE being assigned, not a resultPtr — the factory is
    // arity-shaped, not semantics-shaped, so the wiring is correct.
    [OP_NAPI_SET_ELEMENT, "napi_set_element"],
    [OP_NAPI_SET_PROPERTY, "napi_set_property"],
    // These four DO have a real resultPtr as the 4th u32.
    [OP_NAPI_GET_ELEMENT, "napi_get_element"],
    [OP_NAPI_DELETE_PROPERTY, "napi_delete_property"],
    [OP_NAPI_HAS_OWN_PROPERTY, "napi_has_own_property"],
    [OP_NAPI_INSTANCEOF, "napi_instanceof"],
    // Lever B batch (0x0154–0x0155): buffer-introspection ops.  Both have
    // two out-pointers; the factory's "a, b, ptr" arg slots map to
    // (buffer_handle, &data, &length) — arity-shaped, not semantics-shaped.
    [OP_NAPI_GET_ARRAYBUFFER_INFO, "napi_get_arraybuffer_info"],
    [OP_NAPI_GET_BUFFER_INFO, "napi_get_buffer_info"],
    // Lever B batch 2 (0x0170–0x0172): error-create ops.  code+msg are
    // already-existing napi_value handles (NOT C strings), so they fit the
    // four-u32 shape directly: (env, code, msg, &result).
    [OP_NAPI_CREATE_ERROR, "napi_create_error"],
    [OP_NAPI_CREATE_TYPE_ERROR, "napi_create_type_error"],
    [OP_NAPI_CREATE_RANGE_ERROR, "napi_create_range_error"],
    // Lever B batch 2 (0x0160, 0x0161, 0x0167): buffer/arraybuffer creation.
    // Each has two out-pointers (&data, &result); arity-shaped factory.
    [OP_NAPI_CREATE_ARRAYBUFFER, "napi_create_arraybuffer"],
    [OP_NAPI_CREATE_BUFFER, "napi_create_buffer"],
    [OP_NODE_API_CREATE_SHAREDARRAYBUFFER, "node_api_create_sharedarraybuffer"],
    // Lever B batch 3 (0x0180–0x0182): string-creation ops.  The `str` arg
    // is a pointer into shared wasm memory; emnapi reads the bytes through
    // it.  Arity-shaped factory: (env, str, length, &result).
    [OP_NAPI_CREATE_STRING_UTF8, "napi_create_string_utf8"],
    [OP_NAPI_CREATE_STRING_LATIN1, "napi_create_string_latin1"],
    [OP_NAPI_CREATE_STRING_UTF16, "napi_create_string_utf16"],
    // Lever B batch 3 (0x0188): set_named_property's 4th u32 is the assigned
    // value handle, not a resultPtr; arity-shaped (4 args to napi fn).
    [OP_NAPI_SET_NAMED_PROPERTY, "napi_set_named_property"],
    // Lever B batch 3 (0x0189): define_properties has 4 args, no resultPtr;
    // the property-descriptor array lives in shared wasm memory and emnapi
    // reads it through the pointer.  Arity-shaped.
    [OP_NAPI_DEFINE_PROPERTIES, "napi_define_properties"],
    // Lever B batch 3 (0x018c–0x018e): int64-taking ops.  emnapi v1's JS-side
    // wrappers receive int64 as (low: int32, high: int32) pairs, so the
    // (env, low, high, &result) shape packs into four-u32 exactly.  See
    // vendor/emnapi/packages/emnapi/src/value/convert2napi.ts and
    // emscripten/memory.ts for the wrapper signatures.
    [OP_NAPI_CREATE_INT64, "napi_create_int64"],
    [OP_NAPI_CREATE_BIGINT_UINT64, "napi_create_bigint_uint64"],
    [OP_NAPI_ADJUST_EXTERNAL_MEMORY, "napi_adjust_external_memory"],
  ];

  // napi_delete_reference is two-arg (env, ref_handle); no result_ptr.
  // We treat it as two-u32 by passing 0 for the unused ptr arg.
  // The actual semantics: just calls napi_delete_reference(env, ref).
  function makeNoResult(napiFn: NapiFn | undefined, opName: string) {
    return async (_ctx: HandlerContext, args: Uint8Array) => {
      if (typeof napiFn !== "function") return err(`napi handler: ${opName} not found`);
      if (args.byteLength < 8) return err("napi handler: args too short");
      const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
      const env = dv.getUint32(0, true);
      const a = dv.getUint32(4, true);
      return { payload: EMPTY, status: napiFn(env, a) };
    };
  }

  void makeGetBoolean; // alias retained for documentation; same as makeThreeU32

  return {
    // +1 delete_reference, +1 object_freeze, +3 callback ops (call/new/create_ref),
    // +1 napi_get_all_property_names (Lever B six-u32),
    // +1 napi_get_dataview_info (Lever B six-u32),
    // +1 node_api_set_prototype (Lever B three-u32 no-result, inline).
    // +1 napi_throw (Lever B batch 2 makeNoResult),
    // +2 napi_resolve_deferred / napi_reject_deferred (batch 2 three-u32 no-result, inline).
    // +1 napi_create_buffer_copy (batch 2 five-u32, inline),
    // +1 napi_create_typedarray (batch 2 six-u32, inline),
    // +1 napi_get_cb_info (batch 2 six-u32, inline).
    // Lever B batch 3 inline registrations:
    // +2 napi_get_value_string_latin1/utf16 (five-u32, inline),
    // +3 napi_throw_error/type_error/range_error (three-u32 no-result, inline),
    // +1 napi_get_typedarray_info (seven-u32, inline).
    // Lever B batch 4 cluster A inline registrations:
    // +2 napi_add_env_cleanup_hook / napi_remove_env_cleanup_hook
    //    (three-u32 no-result, JS-closure substitution via callback-dispatch).
    // Lever B batch 4 cluster C inline registrations:
    // +2 napi_wrap / napi_add_finalizer (FINALIZER-shape).
    //    napi_unwrap and napi_remove_wrap are counted in THREE_U32.length.
    count: TWO_U32.length + THREE_U32.length + FOUR_U32.length + 14 + 6 + 2 + 2,
    register(server: RpcServer): void {
      for (const [op, name] of TWO_U32) {
        server.register(op, makeTwoU32(napi[name], name));
      }
      for (const [op, name] of THREE_U32) {
        server.register(op, makeThreeU32(napi[name], name));
      }
      for (const [op, name] of FOUR_U32) {
        server.register(op, makeFourU32(napi[name], name));
      }
      // delete_reference is special: no result ptr.
      server.register(
        OP_NAPI_DELETE_REFERENCE,
        makeNoResult(napi["napi_delete_reference"], "napi_delete_reference"),
      );
      // napi_object_freeze(env, object): no result ptr, same shape as delete_reference.
      server.register(
        OP_NAPI_OBJECT_FREEZE,
        makeNoResult(napi["napi_object_freeze"], "napi_object_freeze"),
      );
      // F-5 callback ops.
      server.register(OP_NAPI_CALL_FUNCTION, makeSixU32(napi["napi_call_function"], "napi_call_function"));
      server.register(OP_NAPI_NEW_INSTANCE, makeFiveU32(napi["napi_new_instance"], "napi_new_instance"));
      server.register(OP_NAPI_CREATE_REFERENCE, makeFourU32(napi["napi_create_reference"], "napi_create_reference"));
      // Lever B batch: six-u32 op (env, object, key_mode, key_filter,
      // key_conversion, &result).
      server.register(
        OP_NAPI_GET_ALL_PROPERTY_NAMES,
        makeSixU32(napi["napi_get_all_property_names"], "napi_get_all_property_names"),
      );
      // Lever B batch (0x0157): napi_get_dataview_info has six args
      // (env, dataview, &byte_length, &data, &arraybuffer, &byte_offset) —
      // fits the makeSixU32 factory shape exactly.
      server.register(
        OP_NAPI_GET_DATAVIEW_INFO,
        makeSixU32(napi["napi_get_dataview_info"], "napi_get_dataview_info"),
      );
      // Lever B batch (0x0159): node_api_set_prototype(env, object, prototype)
      // — three args, no resultPtr.  No "three-u32 no result" factory exists;
      // register inline.  Pattern mirrors makeNoResult but with one more arg.
      {
        const fn = napi["node_api_set_prototype"];
        const opName = "node_api_set_prototype";
        server.register(OP_NODE_API_SET_PROTOTYPE, async (_ctx, args) => {
          if (typeof fn !== "function") return err(`napi handler: ${opName} not found`);
          if (args.byteLength < 12) return err("napi handler: args too short for three-u32-no-result");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          return {
            payload: EMPTY,
            status: fn(
              dv.getUint32(0, true),
              dv.getUint32(4, true),
              dv.getUint32(8, true),
            ),
          };
        });
      }
      // Lever B batch 2 (0x0175): napi_throw(env, error) — two args, no resultPtr.
      // Same shape as napi_delete_reference / napi_object_freeze.
      server.register(
        OP_NAPI_THROW,
        makeNoResult(napi["napi_throw"], "napi_throw"),
      );
      // Lever B batch 2 (0x0173): napi_resolve_deferred(env, deferred, resolution)
      // — three args, no resultPtr.  Same shape as node_api_set_prototype.
      {
        const fn = napi["napi_resolve_deferred"];
        const opName = "napi_resolve_deferred";
        server.register(OP_NAPI_RESOLVE_DEFERRED, async (_ctx, args) => {
          if (typeof fn !== "function") return err(`napi handler: ${opName} not found`);
          if (args.byteLength < 12) return err("napi handler: args too short for three-u32-no-result");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          return {
            payload: EMPTY,
            status: fn(
              dv.getUint32(0, true),
              dv.getUint32(4, true),
              dv.getUint32(8, true),
            ),
          };
        });
      }
      // Lever B batch 2 (0x0174): napi_reject_deferred(env, deferred, rejection)
      // — three args, no resultPtr.  Same shape as resolve_deferred.
      {
        const fn = napi["napi_reject_deferred"];
        const opName = "napi_reject_deferred";
        server.register(OP_NAPI_REJECT_DEFERRED, async (_ctx, args) => {
          if (typeof fn !== "function") return err(`napi handler: ${opName} not found`);
          if (args.byteLength < 12) return err("napi handler: args too short for three-u32-no-result");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          return {
            payload: EMPTY,
            status: fn(
              dv.getUint32(0, true),
              dv.getUint32(4, true),
              dv.getUint32(8, true),
            ),
          };
        });
      }
      // Lever B batch 2 (0x0162): napi_create_buffer_copy(env, length, data,
      // &result_data, &result) — five-u32; matches makeFiveU32 arity exactly.
      server.register(
        OP_NAPI_CREATE_BUFFER_COPY,
        makeFiveU32(napi["napi_create_buffer_copy"], "napi_create_buffer_copy"),
      );
      // Lever B batch 2 (0x0163): napi_create_typedarray(env, type, length,
      // arraybuffer, byte_offset, &result) — six-u32; matches makeSixU32.
      server.register(
        OP_NAPI_CREATE_TYPEDARRAY,
        makeSixU32(napi["napi_create_typedarray"], "napi_create_typedarray"),
      );
      // Lever B batch 2 (0x016a): napi_get_cb_info(env, cbinfo, &argc, argv,
      // &this_arg, &data) — six-u32; matches makeSixU32.
      server.register(
        OP_NAPI_GET_CB_INFO,
        makeSixU32(napi["napi_get_cb_info"], "napi_get_cb_info"),
      );
      // Lever B batch 3 (0x0183, 0x0184): get_value_string_latin1/utf16
      // — (env, value, buf, bufsize, &result_length); five-u32.
      server.register(
        OP_NAPI_GET_VALUE_STRING_LATIN1,
        makeFiveU32(napi["napi_get_value_string_latin1"], "napi_get_value_string_latin1"),
      );
      server.register(
        OP_NAPI_GET_VALUE_STRING_UTF16,
        makeFiveU32(napi["napi_get_value_string_utf16"], "napi_get_value_string_utf16"),
      );
      // Lever B batch 3 (0x018b): napi_get_typedarray_info(env, typedarray,
      // &type, &length, &data, &arraybuffer, &byte_offset) — seven-u32.
      server.register(
        OP_NAPI_GET_TYPEDARRAY_INFO,
        makeSevenU32(napi["napi_get_typedarray_info"], "napi_get_typedarray_info"),
      );
      // Lever B batch 3 (0x0185, 0x0186, 0x0187): napi_throw_{error,type_error,
      // range_error}(env, code:char*, msg:char*) — three args, no resultPtr.
      // code/msg are POINTERS into shared wasm memory; emnapi reads through
      // them.  Same inline pattern as OP_NAPI_RESOLVE_DEFERRED.
      for (const [op, name] of [
        [OP_NAPI_THROW_ERROR, "napi_throw_error"],
        [OP_NAPI_THROW_TYPE_ERROR, "napi_throw_type_error"],
        [OP_NAPI_THROW_RANGE_ERROR, "napi_throw_range_error"],
      ] as Array<[number, string]>) {
        const fn = napi[name];
        const opName = name;
        server.register(op, async (_ctx, args) => {
          if (typeof fn !== "function") return err(`napi handler: ${opName} not found`);
          if (args.byteLength < 12) return err("napi handler: args too short for three-u32-no-result");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          return {
            payload: EMPTY,
            status: fn(
              dv.getUint32(0, true),
              dv.getUint32(4, true),
              dv.getUint32(8, true),
            ),
          };
        });
      }

      // ── Lever B batch 4 cluster A (env cleanup hooks) ──
      //
      // 0x01A0 napi_add_env_cleanup_hook(env, fun, arg)
      // 0x01A1 napi_remove_env_cleanup_hook(env, fun, arg)
      //
      // `fun` is a wasm-table funcref index; `arg` is opaque data passed
      // to the callback at env destroy.  We substitute `fun` with a JS
      // closure that round-trips back to wasm via the reverse channel,
      // built by makeHostSideCallbackClosure.  emnapi's CleanupQueue
      // accepts a JS callable (CleanupHookCallbackFunction = number |
      // ((arg: number) => void), see vendor/emnapi/packages/runtime/
      // src/Context.ts:22) and stores it for invocation at runCleanup.
      //
      // CleanupQueue.{add,remove} match by reference equality on
      // (envObject, fn, arg) — so for remove() to find the entry we
      // added, we must produce the SAME closure reference.  We keep
      // a Map<key, closure> keyed by `${env}:${cbPtr}:${dataPtr}` so
      // remove can look it up.  add() rejects duplicates (emnapi
      // throws "Can not add same fn and arg twice") so the keying
      // matches emnapi's own dedup semantics.
      //
      // Known dispatcher debt (NOT this batch's problem): the wasm-side
      // dispatcher in callback-dispatch.ts invokes the funcref with
      // `(env, 0)` per the napi_callback ABI.  Cleanup-hook funcrefs
      // have signature `void(*)(void* arg)` (single i32 arg) — calling
      // them with two args traps under WebAssembly's indirect-call
      // type-check.  Since cleanup hooks fire only at env destroy
      // (shutdown), this is non-blocking for normal operation; the
      // dispatcher will need a per-call-shape hook before the closure
      // is actually invoked.  See callback-dispatch.ts:#!~debt.
      {
        const cleanupClosures = new Map<string, (arg: number) => void>();
        const addFn = napi["napi_add_env_cleanup_hook"];
        const removeFn = napi["napi_remove_env_cleanup_hook"];

        const decodeThreeU32 = (args: Uint8Array): { env: number; cbPtr: number; dataPtr: number } | null => {
          if (args.byteLength < 12) return null;
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          return {
            env: dv.getUint32(0, true),
            cbPtr: dv.getUint32(4, true),
            dataPtr: dv.getUint32(8, true),
          };
        };

        const keyOf = (env: number, cbPtr: number, dataPtr: number): string =>
          `${env >>> 0}:${cbPtr >>> 0}:${dataPtr >>> 0}`;

        server.register(OP_NAPI_ADD_ENV_CLEANUP_HOOK, async (_ctx, args) => {
          if (typeof addFn !== "function") return err("napi handler: napi_add_env_cleanup_hook not found");
          const decoded = decodeThreeU32(args);
          if (!decoded) return err("napi handler: args too short for three-u32-no-result");
          const { env, cbPtr, dataPtr } = decoded;

          const reverseClient = getHostSideReverseSyncClient();
          if (!reverseClient) {
            return err("napi handler: reverse sync client not ready for add_env_cleanup_hook");
          }

          const key = keyOf(env, cbPtr, dataPtr);
          // emnapi rejects duplicate (env, fn, arg) — keep the existing
          // closure mapping aligned so a re-add reuses the same closure
          // reference and emnapi's own throw fires deterministically.
          let closure = cleanupClosures.get(key);
          if (!closure) {
            const hostClosure = makeHostSideCallbackClosure({
              reverseClient,
              cbPtr,
              dataPtr,
              env,
              shape: CALLBACK_SHAPE_CLEANUP_HOOK,
            });
            // CleanupHookCallbackFunction is `(arg: number) => void` on
            // the JS-callable branch.  Our closure returns the wasm
            // return handle (unknown), which we discard.
            closure = (arg: number) => { void hostClosure(arg); };
            cleanupClosures.set(key, closure);
          }

          // emnapi's napi_add_env_cleanup_hook is typed as
          // (env, fun: number, arg: number) → status, but its body just
          // forwards `fun` into addCleanupHook which accepts a JS
          // callable too.  Cast through unknown to bypass the int-typed
          // signature.
          const status = (addFn as unknown as (
            env: number,
            fun: (arg: number) => void,
            arg: number,
          ) => number)(env, closure, dataPtr);
          return { payload: EMPTY, status };
        });

        server.register(OP_NAPI_REMOVE_ENV_CLEANUP_HOOK, async (_ctx, args) => {
          if (typeof removeFn !== "function") return err("napi handler: napi_remove_env_cleanup_hook not found");
          const decoded = decodeThreeU32(args);
          if (!decoded) return err("napi handler: args too short for three-u32-no-result");
          const { env, cbPtr, dataPtr } = decoded;

          const key = keyOf(env, cbPtr, dataPtr);
          const closure = cleanupClosures.get(key);
          if (!closure) {
            // No matching add() — emnapi's remove is a no-op in that
            // case (silent for-loop fall-through in CleanupQueue.remove).
            // Mirror that by reporting napi_ok without calling emnapi
            // (we can't anyway — we don't have the original closure to
            // satisfy emnapi's reference-equality match).
            return { payload: EMPTY, status: 0 };
          }

          const status = (removeFn as unknown as (
            env: number,
            fun: (arg: number) => void,
            arg: number,
          ) => number)(env, closure, dataPtr);
          // Drop the mapping once removed so re-add gets a fresh closure
          // (and the wire matches emnapi's own dedup invariant).
          cleanupClosures.delete(key);
          return { payload: EMPTY, status };
        });
      }

      // ── Lever B batch 4 cluster B (external-data with finalizers) ────
      //
      // Three FINALIZER-shape ops:
      //   OP_NAPI_CREATE_EXTERNAL              (env, data, cb, hint, &result)
      //   OP_NAPI_CREATE_EXTERNAL_ARRAYBUFFER  (env, ext_data, len, cb, hint, &result)
      //   OP_NAPI_CREATE_EXTERNAL_BUFFER       (env, len, data, cb, hint, &result)
      //
      // Each builds a host-side JS closure via `makeHostSideCallbackClosure`
      // with shape=FINALIZER, keyed in a Map so the same `(env, cbPtr,
      // dataPtr=finalize_hint)` tuple reuses the same closure reference.
      //
      // #!~debt cluster-b-finalizers-noop — emnapi's Finalizer.callFinalizer
      // (vendor/emnapi/packages/runtime/src/Finalizer.ts:52-66) coerces
      // `finalize_callback` via `Number(cb)` and dispatches through
      // `bridge.makeDynCall_vppp(fini)` with NO `typeof === 'function'`
      // branch (cf. CleanupQueue.drain at Context.ts:86-90 which DOES
      // branch).  So even if we pass a JS closure to emnapi's
      // `napi_create_external{,_arraybuffer,_buffer}`, the closure will
      // never be invoked at finalize time — the host-worker stub table
      // also can't resolve any non-zero funcref index.
      //
      // The handlers therefore pass `finalize_cb=0` to emnapi (creating
      // the external/arraybuffer/buffer cleanly with no finalize hook)
      // while still building and caching the closure for the day the
      // host bridge can dispatch it.  This matches the guest-side
      // behavior (napi/src/guest/napi.rs:2246 also drops _finalize_cb),
      // so there's no net regression vs. native edge.
      //
      // Long-term fix paths (NOT this batch's work):
      //   (a) Patch emnapi's Finalizer to mirror CleanupQueue's
      //       JS-callable branch.
      //   (b) Wire a host-side FinalizationRegistry keyed on the
      //       external handle that calls the cached closure on GC.
      {
        const finalizerClosures = new Map<string, (env: number, data: number, hint: number) => void>();
        const createExtFn = napi["napi_create_external"];
        const createExtABFn = napi["napi_create_external_arraybuffer"];
        const createExtBufFn = napi["napi_create_external_buffer"];

        const keyOf = (env: number, cbPtr: number, hintPtr: number): string =>
          `${env >>> 0}:${cbPtr >>> 0}:${hintPtr >>> 0}`;

        const ensureClosure = (
          env: number,
          cbPtr: number,
          finalizeHint: number,
        ): boolean => {
          // Returns true iff a closure was built (or already cached) for
          // a non-zero cbPtr.  cbPtr=0 means "no finalizer", skip.
          if (cbPtr === 0) return false;
          const key = keyOf(env, cbPtr, finalizeHint);
          if (finalizerClosures.has(key)) return true;
          const reverseClient = getHostSideReverseSyncClient();
          if (!reverseClient) return false;
          const hostClosure = makeHostSideCallbackClosure({
            reverseClient,
            cbPtr,
            dataPtr: finalizeHint,
            env,
            shape: CALLBACK_SHAPE_FINALIZER,
          });
          const finalizer = (envArg: number, data: number, hint: number) => {
            void hostClosure(data, hint);
            void envArg;
          };
          finalizerClosures.set(key, finalizer);
          return true;
        };

        server.register(OP_NAPI_CREATE_EXTERNAL, async (_ctx, args) => {
          if (typeof createExtFn !== "function") return err("napi handler: napi_create_external not found");
          if (args.byteLength < 20) return err("napi handler: args too short for napi_create_external");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const env       = dv.getUint32(0,  true);
          const data      = dv.getUint32(4,  true);
          const cbPtr     = dv.getUint32(8,  true);
          const finalizeHint = dv.getUint32(12, true);
          const resultPtr = dv.getUint32(16, true);
          ensureClosure(env, cbPtr, finalizeHint);
          // See cluster-b-finalizers-noop debt above: pass 0 for
          // finalize_cb so emnapi doesn't try to resolve a wasm funcref
          // index against the host-worker's stub table.  The cached
          // closure is dormant until a future host-side finalization
          // path picks it up.
          const status = createExtFn(env, data, 0, 0, resultPtr);
          return { payload: EMPTY, status };
        });

        server.register(OP_NAPI_CREATE_EXTERNAL_ARRAYBUFFER, async (_ctx, args) => {
          if (typeof createExtABFn !== "function") return err("napi handler: napi_create_external_arraybuffer not found");
          if (args.byteLength < 24) return err("napi handler: args too short for napi_create_external_arraybuffer");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const env          = dv.getUint32(0,  true);
          const externalData = dv.getUint32(4,  true);
          const byteLength   = dv.getUint32(8,  true);
          const cbPtr        = dv.getUint32(12, true);
          const finalizeHint = dv.getUint32(16, true);
          const resultPtr    = dv.getUint32(20, true);
          ensureClosure(env, cbPtr, finalizeHint);
          // See cluster-b-finalizers-noop debt above.
          const status = createExtABFn(env, externalData, byteLength, 0, 0, resultPtr);
          return { payload: EMPTY, status };
        });

        server.register(OP_NAPI_CREATE_EXTERNAL_BUFFER, async (_ctx, args) => {
          if (typeof createExtBufFn !== "function") return err("napi handler: napi_create_external_buffer not found");
          if (args.byteLength < 24) return err("napi handler: args too short for napi_create_external_buffer");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const env          = dv.getUint32(0,  true);
          const length       = dv.getUint32(4,  true);
          const data         = dv.getUint32(8,  true);
          const cbPtr        = dv.getUint32(12, true);
          const finalizeHint = dv.getUint32(16, true);
          const resultPtr    = dv.getUint32(20, true);
          ensureClosure(env, cbPtr, finalizeHint);
          // See cluster-b-finalizers-noop debt above.
          const status = createExtBufFn(env, length, data, 0, 0, resultPtr);
          return { payload: EMPTY, status };
        });
      }

      // ── Lever B batch 4 cluster C (object wrap lifecycle) ────────────
      //
      // Two FINALIZER-shape ops in this block:
      //   OP_NAPI_WRAP            (env, value, native_obj, cb, hint, &result_optional)
      //   OP_NAPI_ADD_FINALIZER   (env, value, data, cb, hint, &result_optional)
      //
      // napi_unwrap and napi_remove_wrap are 3-u32 reads (no callback)
      // wired via the THREE_U32 factory table at the top of this function.
      //
      // #!~debt cluster-c-finalizers-noop — emnapi's Finalizer dispatches
      // finalize_cb through `bridge.makeDynCall_vppp(fini)`, which on the
      // host-worker is wired to a noop factory (`(() => () => undefined)`
      // — see napi-host/unofficial.ts dyncall-before-table-ready).  So
      // the funcref index we pass to emnapi is never actually invoked
      // at finalize-time; the finalizer is dormant.  We still build a
      // host-side closure via makeHostSideCallbackClosure and cache it
      // in a Map keyed by `(env, cbPtr, finalizeHint)` so a future
      // FinalizationRegistry-based wiring (or emnapi patch) can pick
      // it up without re-allocating closures.
      //
      // Unlike cluster B (which passes 0 to emnapi for finalize_cb),
      // cluster C passes the ORIGINAL cbPtr through:
      //   - napi_wrap with non-zero result requires non-zero finalize_cb
      //     (internal.ts:118 returns napi_invalid_arg otherwise).
      //   - napi_add_finalizer always requires non-zero finalize_cb
      //     ($CHECK_ARG at wrap.ts:187).
      // Pass-through is safe precisely because makeDynCall_vppp is a noop
      // — no funcref resolution is ever attempted on the host worker.
      // This matches guest-side native edge (drops _finalize_cb), so no
      // net regression.
      {
        const wrapFinalizerClosures = new Map<string, (env: number, data: number, hint: number) => void>();
        const wrapFn = napi["napi_wrap"];
        const addFinFn = napi["napi_add_finalizer"];

        const keyOf = (env: number, cbPtr: number, hintPtr: number): string =>
          `${env >>> 0}:${cbPtr >>> 0}:${hintPtr >>> 0}`;

        const ensureClosure = (
          env: number,
          cbPtr: number,
          finalizeHint: number,
        ): void => {
          // Cache a FINALIZER-shape closure for the (env, cbPtr, hint)
          // tuple.  cbPtr=0 means "no finalizer" — nothing to cache.
          if (cbPtr === 0) return;
          const key = keyOf(env, cbPtr, finalizeHint);
          if (wrapFinalizerClosures.has(key)) return;
          const reverseClient = getHostSideReverseSyncClient();
          if (!reverseClient) return;
          const hostClosure = makeHostSideCallbackClosure({
            reverseClient,
            cbPtr,
            dataPtr: finalizeHint,
            env,
            shape: CALLBACK_SHAPE_FINALIZER,
          });
          const finalizer = (envArg: number, data: number, hint: number) => {
            void hostClosure(data, hint);
            void envArg;
          };
          wrapFinalizerClosures.set(key, finalizer);
        };

        server.register(OP_NAPI_WRAP, async (_ctx, args) => {
          if (typeof wrapFn !== "function") return err("napi handler: napi_wrap not found");
          if (args.byteLength < 24) return err("napi handler: args too short for napi_wrap");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const env          = dv.getUint32(0,  true);
          const jsObject     = dv.getUint32(4,  true);
          const nativeObj    = dv.getUint32(8,  true);
          const cbPtr        = dv.getUint32(12, true);
          const finalizeHint = dv.getUint32(16, true);
          const resultPtr    = dv.getUint32(20, true);
          ensureClosure(env, cbPtr, finalizeHint);
          // Pass cbPtr through (see cluster-c-finalizers-noop): emnapi's
          // makeDynCall_vppp is a noop on the host-worker so the funcref
          // index is never resolved at finalize-time.  Passing 0 instead
          // would break the (result != 0 && finalize_cb == 0) → invalid_arg
          // branch in internal.ts:118.
          const status = wrapFn(env, jsObject, nativeObj, cbPtr, finalizeHint, resultPtr);
          return { payload: EMPTY, status };
        });

        server.register(OP_NAPI_ADD_FINALIZER, async (_ctx, args) => {
          if (typeof addFinFn !== "function") return err("napi handler: napi_add_finalizer not found");
          if (args.byteLength < 24) return err("napi handler: args too short for napi_add_finalizer");
          const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
          const env           = dv.getUint32(0,  true);
          const jsObject      = dv.getUint32(4,  true);
          const finalizeData  = dv.getUint32(8,  true);
          const cbPtr         = dv.getUint32(12, true);
          const finalizeHint  = dv.getUint32(16, true);
          const resultPtr     = dv.getUint32(20, true);
          ensureClosure(env, cbPtr, finalizeHint);
          // emnapi $CHECK_ARG! rejects finalize_cb=0 unconditionally for
          // napi_add_finalizer (wrap.ts:187).  Pass cbPtr through — safe
          // because of cluster-c-finalizers-noop.
          const status = addFinFn(env, jsObject, finalizeData, cbPtr, finalizeHint, resultPtr);
          return { payload: EMPTY, status };
        });
      }
    },
  };
}
