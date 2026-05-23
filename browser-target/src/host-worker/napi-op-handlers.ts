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
  ];

  const FOUR_U32: Array<[number, string]> = [
    [OP_NAPI_GET_PROPERTY, "napi_get_property"],
    [OP_NAPI_GET_NAMED_PROPERTY, "napi_get_named_property"],
    [OP_NAPI_HAS_PROPERTY, "napi_has_property"],
    [OP_NAPI_HAS_NAMED_PROPERTY, "napi_has_named_property"],
    [OP_NAPI_STRICT_EQUALS, "napi_strict_equals"],
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
    count: TWO_U32.length + THREE_U32.length + FOUR_U32.length + 1, // +1 for delete_reference
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
    },
  };
}
