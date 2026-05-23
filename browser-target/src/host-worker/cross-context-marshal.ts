// Cross-context napi_value marshaling — Strategy 3 (hybrid) from R8.
//
// CONTEXT
//
// The reverse-channel callback dispatcher in `callback-dispatch.ts` shuttles
// arguments between TWO independent emnapi contexts: the host worker's
// emnapi context (`hostCtx`) and the wasm runtime worker's emnapi context
// (`wasmCtx`).  Handle IDs are context-private — handle 14 in `hostCtx`
// resolves to a different JS value than handle 14 in `wasmCtx`.  Naïvely
// forwarding raw u32 napi_value handles across the channel is a bug:
// either a crash on deref or silent value corruption.
//
// This module is the marshaling boundary.  Sender derefs each src-context
// handle to a JS value via `srcCtx.jsValueFromNapiValue`, encodes value +
// type tag (plus an identity-map id for objects), ships the bytes across.
// Receiver decodes, mints fresh dst-context handles via
// `dstCtx.napiValueFromJsValue`.
//
// DESIGN (validated empirically in
// `experiments/r8-cross-context-marshaling/`):
//
//   - Primitives serialized inline (undefined/null/bool/int32/double/string).
//   - Objects routed through a shared `IdentityMap` keyed by JS identity.
//     The wire carries the identity id; both sides resolve to the SAME JS
//     object reference, preserving `===`-identity and prototypes across
//     the boundary, and handling circular refs trivially.
//   - One-byte tag prefix per value disambiguates the payload layout.
//
// WIRE FORMAT
//
//   per-value:  [u8 tag][payload...]
//   argv:       [u32 argc][value-bytes ...]
//
//   all multi-byte fields are little-endian.
//
//   | Tag | Value      | Payload                                              |
//   |----:|------------|------------------------------------------------------|
//   |   0 | undefined  | (none)                                               |
//   |   1 | null       | (none)                                               |
//   |   2 | false      | (none)                                               |
//   |   3 | true       | (none)                                               |
//   |   4 | double     | 8 bytes float64                                      |
//   |   5 | int32      | 4 bytes int32   (fast path for small ints)           |
//   |   6 | string     | 4 bytes len + N bytes utf-8                          |
//   |   7 | object     | 4 bytes identityId + 4 bytes flags (bit0 = isArray)  |
//   | 255 | unsupported| (none) — decoder throws                              |
//
// LIFETIME (objects)
//
// `IdentityMap.objToId` is a WeakMap; entries auto-collect when the object
// is GC'd.  `idToRef` holds `WeakRef<object>` registered with a
// `FinalizationRegistry` so cross-side GC reaps both halves.  If the object
// is GC'd between pack and unpack the decoder throws
// "marshal: identity reference collected".
//
// USAGE / ROUNDTRIP EXAMPLE
//
// ```ts
// const idMap = new IdentityMap();
//
// // Pack a single value (host context, owned by host):
// const bytes = packValue("hello", "host", idMap);
//
// // Unpack on the wasm side:
// const { value, byteLength } = unpackValue(bytes, 0, idMap);
// //  value === "hello", byteLength === 5 + utf8Len("hello")
//
// // Pack an argv of host-context handles, ship across, unpack into wasm
// // context, mint fresh wasm-context handles:
// const argvBytes = packArgv(hostCtx, [h1, h2, h3], "host", idMap);
// const { handles, values } = unpackArgv(wasmCtx, argvBytes, "host", idMap);
// //  `hostCtx` and `wasmCtx` are emnapi `Context` instances (passed in
// //  via the structural `MarshalCtx` interface — see note on the import).
// //  `handles[i]` are fresh wasm-context napi_value ids.
// //  `values[i]` are the JS values (caller may use directly, e.g. to set
// //  `cbinfo.args` without re-derefing).
// //
// // Object identity preserved: passing the same host object twice yields
// // the same JS reference on the receiver both times (handles differ per
// // call, as in Node).
// ```
//
// Symbols / BigInts / Functions tag as 255 and the decoder throws on
// deref — out of scope for the two remaining napi ops; extensible later.
//
// CITATIONS
//
//   - `experiments/r8-cross-context-marshaling/FINDINGS.md` — spec source
//     of truth; per-call latencies; tag table; framing.
//   - `experiments/r8-cross-context-marshaling/probe.mjs` — reference
//     implementation this module was ported from.

// The two methods we need (`jsValueFromNapiValue`, `napiValueFromJsValue`)
// exist on the runtime class but are missing from the published `.d.ts`.
// The narrow type is centralized in the facade per project rule
// (vendored deps behind facades).
import type { ContextRuntimeAccess } from "../napi-host/emnapi";
export type MarshalCtx = ContextRuntimeAccess;

// ─── Tag constants ──────────────────────────────────────────────────

export const MARSHAL_TAG_UNDEFINED = 0;
export const MARSHAL_TAG_NULL = 1;
export const MARSHAL_TAG_FALSE = 2;
export const MARSHAL_TAG_TRUE = 3;
export const MARSHAL_TAG_DOUBLE = 4;
export const MARSHAL_TAG_INT32 = 5;
export const MARSHAL_TAG_STRING = 6;
export const MARSHAL_TAG_OBJECT = 7;
export const MARSHAL_TAG_UNSUPPORTED = 255;

// ─── Identity map ───────────────────────────────────────────────────
//
// Maps JS object identity ↔ u32 identity id, used for objects/arrays.
// Both sides of the marshal boundary share a single `IdentityMap`
// instance (passed in by the caller); object identity (and therefore
// `===` and prototype chains) is preserved across contexts.

export type IdentityOwner = "host" | "wasm";

export class IdentityMap {
  private nextId = 1;
  private readonly objToId = new WeakMap<object, number>();
  private readonly idToRef = new Map<number, { ref: WeakRef<object>; owner: IdentityOwner }>();
  private readonly finalReg = new FinalizationRegistry<number>((id) => {
    this.idToRef.delete(id);
  });

  /** Assign (or retrieve) a stable u32 id for `obj`. */
  put(obj: object, owner: IdentityOwner): number {
    const existing = this.objToId.get(obj);
    if (existing !== undefined) return existing;
    const id = this.nextId++;
    this.objToId.set(obj, id);
    this.idToRef.set(id, { ref: new WeakRef(obj), owner });
    this.finalReg.register(obj, id);
    return id;
  }

  /** Resolve `id` to the underlying JS object + owner tag, or `undefined`. */
  get(id: number): { obj: object; owner: IdentityOwner } | undefined {
    const entry = this.idToRef.get(id);
    if (!entry) return undefined;
    const obj = entry.ref.deref();
    if (!obj) {
      this.idToRef.delete(id);
      return undefined;
    }
    return { obj, owner: entry.owner };
  }
}

// ─── Per-value pack / unpack ────────────────────────────────────────

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Pack a single JS value into tag+payload bytes. */
export function packValue(value: unknown, owner: IdentityOwner, idMap: IdentityMap): Uint8Array {
  if (value === undefined) return new Uint8Array([MARSHAL_TAG_UNDEFINED]);
  if (value === null) return new Uint8Array([MARSHAL_TAG_NULL]);
  if (value === false) return new Uint8Array([MARSHAL_TAG_FALSE]);
  if (value === true) return new Uint8Array([MARSHAL_TAG_TRUE]);
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX) {
      const buf = new Uint8Array(5);
      buf[0] = MARSHAL_TAG_INT32;
      new DataView(buf.buffer).setInt32(1, value, true);
      return buf;
    }
    const buf = new Uint8Array(9);
    buf[0] = MARSHAL_TAG_DOUBLE;
    new DataView(buf.buffer).setFloat64(1, value, true);
    return buf;
  }
  if (typeof value === "string") {
    const bytes = utf8Encoder.encode(value);
    const buf = new Uint8Array(5 + bytes.byteLength);
    buf[0] = MARSHAL_TAG_STRING;
    new DataView(buf.buffer).setUint32(1, bytes.byteLength, true);
    buf.set(bytes, 5);
    return buf;
  }
  if (typeof value === "object") {
    const id = idMap.put(value as object, owner);
    const flags = Array.isArray(value) ? 1 : 0;
    const buf = new Uint8Array(9);
    buf[0] = MARSHAL_TAG_OBJECT;
    const dv = new DataView(buf.buffer);
    dv.setUint32(1, id, true);
    dv.setUint32(5, flags, true);
    return buf;
  }
  // Functions, symbols, bigints — tag 255 / decoder throws.
  return new Uint8Array([MARSHAL_TAG_UNSUPPORTED]);
}

/**
 * Unpack a single value from `buf` starting at `offset`.  Returns the
 * decoded value and the number of bytes consumed.
 */
export function unpackValue(
  buf: Uint8Array,
  offset: number,
  idMap: IdentityMap,
): { value: unknown; byteLength: number } {
  const tag = buf[offset];
  switch (tag) {
    case MARSHAL_TAG_UNDEFINED:
      return { value: undefined, byteLength: 1 };
    case MARSHAL_TAG_NULL:
      return { value: null, byteLength: 1 };
    case MARSHAL_TAG_FALSE:
      return { value: false, byteLength: 1 };
    case MARSHAL_TAG_TRUE:
      return { value: true, byteLength: 1 };
    case MARSHAL_TAG_INT32: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      return { value: dv.getInt32(0, true), byteLength: 5 };
    }
    case MARSHAL_TAG_DOUBLE: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 8);
      return { value: dv.getFloat64(0, true), byteLength: 9 };
    }
    case MARSHAL_TAG_STRING: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const len = dv.getUint32(0, true);
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset + offset + 5, len);
      return { value: utf8Decoder.decode(bytes), byteLength: 5 + len };
    }
    case MARSHAL_TAG_OBJECT: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 8);
      const id = dv.getUint32(0, true);
      // flags at offset+4 currently only carries isArray (informational —
      // the actual object reference IS the array, so we don't need it for
      // correctness; reserved for future use such as Map/Set/Date hinting).
      const entry = idMap.get(id);
      if (!entry) {
        throw new Error("marshal: identity reference collected");
      }
      return { value: entry.obj, byteLength: 9 };
    }
    case MARSHAL_TAG_UNSUPPORTED:
      throw new Error("marshal: unsupported value type");
    default:
      throw new Error(`marshal: unknown tag ${tag}`);
  }
}

// ─── Argv pack / unpack ─────────────────────────────────────────────

/**
 * Pack an argv of src-context napi_value handles into wire bytes.
 *
 * Each handle is dereffed via `srcCtx.jsValueFromNapiValue` and the
 * resulting JS value is encoded with `packValue`.  Objects encountered
 * are registered in `idMap` with `srcOwner` as the owning side.
 */
export function packArgv(
  srcCtx: MarshalCtx,
  srcHandles: number[],
  srcOwner: IdentityOwner,
  idMap: IdentityMap,
): Uint8Array {
  const buffers: Uint8Array[] = new Array(srcHandles.length);
  let total = 0;
  for (let i = 0; i < srcHandles.length; i++) {
    const v = srcCtx.jsValueFromNapiValue(srcHandles[i]);
    const b = packValue(v, srcOwner, idMap);
    buffers[i] = b;
    total += b.byteLength;
  }
  const out = new Uint8Array(total + 4);
  new DataView(out.buffer).setUint32(0, srcHandles.length, true);
  let off = 4;
  for (const b of buffers) {
    out.set(b, off);
    off += b.byteLength;
  }
  return out;
}

/**
 * Unpack an argv from wire bytes into dst-context napi_value handles +
 * the JS values themselves (returned for callers that want to populate
 * cbinfo.args directly without a redundant deref).
 */
export function unpackArgv(
  dstCtx: MarshalCtx,
  bytes: Uint8Array,
  _srcOwner: IdentityOwner,
  idMap: IdentityMap,
): { handles: number[]; values: unknown[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const argc = dv.getUint32(0, true);
  const handles: number[] = new Array(argc);
  const values: unknown[] = new Array(argc);
  let cursor = 4;
  for (let i = 0; i < argc; i++) {
    const { value, byteLength } = unpackValue(bytes, cursor, idMap);
    cursor += byteLength;
    handles[i] = Number(dstCtx.napiValueFromJsValue(value));
    values[i] = value;
  }
  return { handles, values };
}
