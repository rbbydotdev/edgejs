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
  REPLY_STATUS_INVALID_ARGS,
} from "./rpc-protocol";

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
    count: TWO_U32.length + THREE_U32.length + FOUR_U32.length + 8,
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
    },
  };
}
