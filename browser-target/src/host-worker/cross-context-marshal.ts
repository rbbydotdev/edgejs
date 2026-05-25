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
//   - Objects encoded BY VALUE — recursive deep-clone into the wire bytes
//     (plain objects, arrays, typed arrays, ArrayBuffer, Date).  Identity
//     is NOT preserved across calls; the same object packed twice produces
//     two distinct receiver-side objects.  Matches structuredClone /
//     postMessage semantics.
//   - Circular references handled via a per-frame `seen` map; second
//     visit emits MARSHAL_TAG_CIRCULAR_REF with the first-emit's frame-
//     local id.  Receiver patches via the symmetric `byFrameId` map.
//   - Identity-preserving by-ref (MARSHAL_TAG_OBJECT_BYREF / tag 7) is
//     retained for callers that explicitly share an IdentityMap across
//     pack + unpack (e.g. same-heap diagnostic probes).  Falls through
//     to by-ref for objects whose prototype isn't Object.prototype or
//     null (class instances) — receiver throws cleanly if it doesn't
//     hold the shared IdentityMap.
//   - One-byte tag prefix per value disambiguates the payload layout.
//
// WIRE FORMAT
//
//   per-value:  [u8 tag][payload...]
//   argv:       [u32 argc][value-bytes ...]
//
//   all multi-byte fields are little-endian.
//
//   | Tag | Value         | Payload                                              |
//   |----:|---------------|------------------------------------------------------|
//   |   0 | undefined     | (none)                                               |
//   |   1 | null          | (none)                                               |
//   |   2 | false         | (none)                                               |
//   |   3 | true          | (none)                                               |
//   |   4 | double        | 8 bytes float64                                      |
//   |   5 | int32         | 4 bytes int32   (fast path for small ints)           |
//   |   6 | string        | 4 bytes len + N bytes utf-8                          |
//   |   7 | object-by-ref | 4 bytes identityId + 4 bytes flags (shared IdentityMap) |
//   |   8 | plain object  | 4 bytes propCount + repeated [packed key, packed value] |
//   |   9 | array         | 4 bytes len + repeated [packed value]                |
//   |  10 | typed array   | 1 byte kind + 4 bytes byteLen + bytes                |
//   |  11 | arraybuffer   | 4 bytes byteLen + bytes                              |
//   |  12 | date          | 8 bytes float64 ms-since-epoch                       |
//   |  13 | map           | 4 bytes size + repeated [packed key, packed value]   |
//   |  14 | set           | 4 bytes size + repeated [packed value]               |
//   |  15 | regexp        | 4 bytes sourceLen + utf-8 source + 1 byte flagsBits  |
//   |  17 | circular-ref  | 4 bytes frameId (back-ref within this pack frame)    |
//   | 255 | unsupported   | (none) — decoder throws                              |
//
// RegExp flagsBits layout (low bit → high bit):
//   bit 0: g (global)        bit 4: u (unicode)
//   bit 1: i (ignoreCase)    bit 5: y (sticky)
//   bit 2: m (multiline)     bit 6: d (hasIndices)
//   bit 3: s (dotAll)        bit 7: v (unicodeSets)
//
// `lastIndex` is NOT preserved across the round-trip (matches
// structuredClone semantics — receivers see lastIndex == 0).
//
// LIFETIME (by-ref objects)
//
// `IdentityMap.objToId` is a WeakMap; entries auto-collect when the object
// is GC'd.  `idToRef` holds `WeakRef<object>` registered with a
// `FinalizationRegistry` so cross-side GC reaps both halves.  If the object
// is GC'd between pack and unpack the decoder throws
// "marshal: identity reference collected".
//
// LIMITATIONS
//
//   - Functions, symbols, bigints → tag 255 / decoder throws.
//   - Class instances (non-plain prototype) emit tag 7 by-ref; only
//     resolvable with a shared IdentityMap.
//   - Map / Set / RegExp supported by value (tags 13/14/15).  Maps and
//     Sets register in the per-frame `seen` map so circular references
//     through them resolve normally.  RegExp `lastIndex` is not
//     preserved (matches structuredClone).
//   - Recursion guarded by MARSHAL_MAX_DEPTH (32); cycles use the
//     per-frame `seen` map instead of depth counting.
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
/** Object-by-reference via IdentityMap.  Only resolvable when both
 *  sides share the same IdentityMap instance (same-heap / same
 *  per-pair shared map).  Cross-heap receivers throw
 *  "marshal: identity reference collected". */
export const MARSHAL_TAG_OBJECT_BYREF = 7;
/** Plain object — recursive [u32 propCount][repeated: packed-key, packed-value]. */
export const MARSHAL_TAG_OBJECT_PLAIN = 8;
/** Dense array — recursive [u32 len][repeated: packed-value]. */
export const MARSHAL_TAG_ARRAY = 9;
/** Typed array — [u8 kind][u32 byteLen][bytes].  Kind 0..10 per TYPED_ARRAY_KINDS. */
export const MARSHAL_TAG_TYPED_ARRAY = 10;
/** ArrayBuffer — [u32 byteLen][bytes]. */
export const MARSHAL_TAG_ARRAYBUFFER = 11;
/** Date — [f64 ms-since-epoch]. */
export const MARSHAL_TAG_DATE = 12;
/** Map — [u32 size][repeated: packed-key, packed-value].  Keys may be
 *  any marshalable value.  Insertion order is preserved by the
 *  emitter/decoder. */
export const MARSHAL_TAG_MAP = 13;
/** Set — [u32 size][repeated: packed-value].  Insertion order is
 *  preserved. */
export const MARSHAL_TAG_SET = 14;
/** RegExp — [u32 sourceLen][utf-8 source bytes][u8 flagsBits].
 *  flagsBits packs the JS flag characters (g/i/m/s/u/y/d/v) into one
 *  byte.  `lastIndex` is not preserved across the round-trip. */
export const MARSHAL_TAG_REGEXP = 15;
/** Cross-worker MessagePort transfer reference — [u32 portId].
 *  The pack-side caller marks specific values as transferable ports
 *  via a `PackHooks.encodeObject` callback (e.g. via the transferList
 *  in `packPostMessage`).  The unpack-side caller provides a
 *  `UnpackHooks.decodePort(id)` factory that materializes a port stub
 *  bound to the given ID.  Same wire format on both sides; the ID
 *  scheme is the caller's contract.  Added in e33 to replace the
 *  prior OBJECT_BYREF fallback for MessagePort instances (which threw
 *  "marshal: identity reference collected" on cross-isolate receive). */
export const MARSHAL_TAG_PORT_REF = 16;
/** Circular back-ref within the current pack frame.  [u32 frameId].
 *  frameId is the index of an already-emitted object in the
 *  pack-frame's `seen` map. */
export const MARSHAL_TAG_CIRCULAR_REF = 17;
/** Functions, symbols, bigints — decoder throws. */
export const MARSHAL_TAG_UNSUPPORTED = 255;

// ─── Pack / unpack hooks ────────────────────────────────────────────
//
// Optional callbacks the marshal layer invokes to override default
// encoding for specific object values, or to materialize values from
// custom tags on decode.  Used by `marshal-postmessage.ts` to handle
// MessagePort transfer (e33).
export interface PackHooks {
  /** Called for every typeof === "object" value AFTER the circular-ref
   *  check but BEFORE the typed-shape (Date/Map/Set/RegExp/AB/...)
   *  and BEFORE the plain-object/BYREF fallback.  Returning a
   *  Uint8Array overrides the default encoding for this value; returning
   *  null falls through. */
  encodeObject?: (value: object) => Uint8Array | null;
}
export interface UnpackHooks {
  /** Called when MARSHAL_TAG_PORT_REF is decoded.  Caller returns the
   *  materialized value (typically a JS-side MessagePort stub).  If not
   *  provided, decoder throws. */
  decodePort?: (portId: number) => unknown;
}

// ─── RegExp flag bits ───────────────────────────────────────────────
//
// Pack/unpack JS RegExp flags into a single byte.  Bit assignment is
// load-bearing wire format; future additions must use unused bits.
const REGEXP_FLAG_G = 1 << 0; // global
const REGEXP_FLAG_I = 1 << 1; // ignoreCase
const REGEXP_FLAG_M = 1 << 2; // multiline
const REGEXP_FLAG_S = 1 << 3; // dotAll
const REGEXP_FLAG_U = 1 << 4; // unicode
const REGEXP_FLAG_Y = 1 << 5; // sticky
const REGEXP_FLAG_D = 1 << 6; // hasIndices
const REGEXP_FLAG_V = 1 << 7; // unicodeSets

function regexpFlagsToBits(flags: string): number {
  let bits = 0;
  for (let i = 0; i < flags.length; i++) {
    switch (flags.charCodeAt(i)) {
      case 0x67: bits |= REGEXP_FLAG_G; break; // 'g'
      case 0x69: bits |= REGEXP_FLAG_I; break; // 'i'
      case 0x6d: bits |= REGEXP_FLAG_M; break; // 'm'
      case 0x73: bits |= REGEXP_FLAG_S; break; // 's'
      case 0x75: bits |= REGEXP_FLAG_U; break; // 'u'
      case 0x79: bits |= REGEXP_FLAG_Y; break; // 'y'
      case 0x64: bits |= REGEXP_FLAG_D; break; // 'd'
      case 0x76: bits |= REGEXP_FLAG_V; break; // 'v'
    }
  }
  return bits;
}

function regexpBitsToFlags(bits: number): string {
  // Order matches the canonical JS RegExp.prototype.flags ordering
  // (d, g, i, m, s, u, v, y).  RegExp itself canonicalizes the order
  // on construction so this is informational only — kept canonical for
  // wire-debug clarity.
  let out = "";
  if (bits & REGEXP_FLAG_D) out += "d";
  if (bits & REGEXP_FLAG_G) out += "g";
  if (bits & REGEXP_FLAG_I) out += "i";
  if (bits & REGEXP_FLAG_M) out += "m";
  if (bits & REGEXP_FLAG_S) out += "s";
  if (bits & REGEXP_FLAG_U) out += "u";
  if (bits & REGEXP_FLAG_V) out += "v";
  if (bits & REGEXP_FLAG_Y) out += "y";
  return out;
}

/** Maximum recursion depth for by-value encoding.  Guards against
 *  pathologically deep nesting; circular refs are detected separately
 *  via the per-frame `seen` map. */
const MARSHAL_MAX_DEPTH = 32;

// Typed-array kind table (index = wire byte; entry = constructor).
//
// Order is locked in — adding new entries must append, never insert.
type TypedArrayCtor =
  | typeof Uint8Array | typeof Int8Array | typeof Uint8ClampedArray
  | typeof Uint16Array | typeof Int16Array
  | typeof Uint32Array | typeof Int32Array
  | typeof Float32Array | typeof Float64Array
  | typeof BigUint64Array | typeof BigInt64Array;
const TYPED_ARRAY_KINDS: TypedArrayCtor[] = [
  Uint8Array, Int8Array, Uint8ClampedArray,
  Uint16Array, Int16Array,
  Uint32Array, Int32Array,
  Float32Array, Float64Array,
  BigUint64Array, BigInt64Array,
];
function typedArrayKindOf(value: ArrayBufferView): number {
  for (let i = 0; i < TYPED_ARRAY_KINDS.length; i++) {
    if (value instanceof TYPED_ARRAY_KINDS[i]) return i;
  }
  return -1;
}

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

/** Per-frame state for a pack() call.  Tracks already-emitted objects
 *  by identity so we can emit MARSHAL_TAG_CIRCULAR_REF on the second
 *  visit instead of looping. */
interface PackFrame {
  /** object → frame-local id of the first emission. */
  seen: Map<object, number>;
  /** next frame-local id to assign. */
  nextId: number;
  /** current recursion depth. */
  depth: number;
  /** caller-supplied hooks (e33: MessagePort transfer encoding). */
  hooks: PackHooks;
}
function newPackFrame(hooks?: PackHooks): PackFrame {
  return { seen: new Map(), nextId: 0, depth: 0, hooks: hooks ?? {} };
}

/** Pack a single JS value into tag+payload bytes.
 *
 *  By default, objects are serialized BY VALUE (recursive deep clone).
 *  Identity is NOT preserved across calls; the same object packed
 *  twice produces two distinct receiver-side objects.  This matches
 *  postMessage / structuredClone semantics.
 *
 *  Identity-preserving "by-ref" encoding (MARSHAL_TAG_OBJECT_BYREF /
 *  tag 7) is reserved for callers that explicitly share an
 *  IdentityMap across both pack and unpack (e.g. same-heap probes).
 *  In a cross-worker topology where pack and unpack hold distinct
 *  IdentityMap instances, by-ref is not resolvable and the receiver
 *  throws.  Today's `callback-dispatch.ts` integration uses
 *  by-value. */
export function packValue(
  value: unknown,
  owner: IdentityOwner,
  idMap: IdentityMap,
  hooks?: PackHooks,
): Uint8Array {
  return packValueWith(value, owner, idMap, newPackFrame(hooks));
}

function packValueWith(
  value: unknown,
  owner: IdentityOwner,
  idMap: IdentityMap,
  frame: PackFrame,
): Uint8Array {
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
    // Circular-ref check.
    const existing = frame.seen.get(value as object);
    if (existing !== undefined) {
      const buf = new Uint8Array(5);
      buf[0] = MARSHAL_TAG_CIRCULAR_REF;
      new DataView(buf.buffer).setUint32(1, existing, true);
      return buf;
    }
    if (frame.depth >= MARSHAL_MAX_DEPTH) {
      throw new Error(`marshal: max recursion depth (${MARSHAL_MAX_DEPTH}) exceeded`);
    }
    const frameId = frame.nextId++;
    frame.seen.set(value as object, frameId);

    // Hook: caller-supplied special-case encoding (e33: MessagePort
    // transfer).  Runs BEFORE the typed-shape checks so it can override
    // even types we'd otherwise know how to encode (e.g. transferable
    // ArrayBuffers in future experiments).
    if (frame.hooks.encodeObject !== undefined) {
      const overridden = frame.hooks.encodeObject(value as object);
      if (overridden !== null) {
        return overridden;
      }
    }

    // Date — 9 bytes total.
    if (value instanceof Date) {
      const buf = new Uint8Array(9);
      buf[0] = MARSHAL_TAG_DATE;
      new DataView(buf.buffer).setFloat64(1, value.getTime(), true);
      return buf;
    }
    // RegExp — [u32 sourceLen][utf-8 source][u8 flagsBits].
    // `lastIndex` is NOT preserved (matches structuredClone).
    if (value instanceof RegExp) {
      const sourceBytes = utf8Encoder.encode(value.source);
      const buf = new Uint8Array(6 + sourceBytes.byteLength);
      buf[0] = MARSHAL_TAG_REGEXP;
      new DataView(buf.buffer).setUint32(1, sourceBytes.byteLength, true);
      buf.set(sourceBytes, 5);
      buf[5 + sourceBytes.byteLength] = regexpFlagsToBits(value.flags);
      return buf;
    }
    // Map — [u32 size][repeated: packed key, packed value].  Registered
    // in `seen` above so circular references through the Map resolve.
    if (value instanceof Map) {
      frame.depth++;
      try {
        const packedPairs: Uint8Array[] = [];
        let total = 0;
        for (const [k, v] of value as Map<unknown, unknown>) {
          const pk = packValueWith(k, owner, idMap, frame);
          const pv = packValueWith(v, owner, idMap, frame);
          packedPairs.push(pk, pv);
          total += pk.byteLength + pv.byteLength;
        }
        const buf = new Uint8Array(5 + total);
        buf[0] = MARSHAL_TAG_MAP;
        new DataView(buf.buffer).setUint32(1, (value as Map<unknown, unknown>).size, true);
        let off = 5;
        for (const p of packedPairs) { buf.set(p, off); off += p.byteLength; }
        return buf;
      } finally {
        frame.depth--;
      }
    }
    // Set — [u32 size][repeated: packed value].
    if (value instanceof Set) {
      frame.depth++;
      try {
        const packed: Uint8Array[] = [];
        let total = 0;
        for (const v of value as Set<unknown>) {
          const p = packValueWith(v, owner, idMap, frame);
          packed.push(p);
          total += p.byteLength;
        }
        const buf = new Uint8Array(5 + total);
        buf[0] = MARSHAL_TAG_SET;
        new DataView(buf.buffer).setUint32(1, (value as Set<unknown>).size, true);
        let off = 5;
        for (const p of packed) { buf.set(p, off); off += p.byteLength; }
        return buf;
      } finally {
        frame.depth--;
      }
    }
    // ArrayBuffer — [u32 byteLen][bytes].
    if (value instanceof ArrayBuffer) {
      const byteLen = value.byteLength;
      const buf = new Uint8Array(5 + byteLen);
      buf[0] = MARSHAL_TAG_ARRAYBUFFER;
      new DataView(buf.buffer).setUint32(1, byteLen, true);
      buf.set(new Uint8Array(value), 5);
      return buf;
    }
    // Typed array — [u8 kind][u32 byteLen][bytes].
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const view = value as ArrayBufferView;
      const kind = typedArrayKindOf(view);
      if (kind < 0) return new Uint8Array([MARSHAL_TAG_UNSUPPORTED]);
      const byteLen = view.byteLength;
      const buf = new Uint8Array(6 + byteLen);
      buf[0] = MARSHAL_TAG_TYPED_ARRAY;
      buf[1] = kind;
      new DataView(buf.buffer).setUint32(2, byteLen, true);
      buf.set(
        new Uint8Array(view.buffer, view.byteOffset, byteLen),
        6,
      );
      return buf;
    }
    // Dense array — [u32 len][repeated: packed value].
    if (Array.isArray(value)) {
      frame.depth++;
      try {
        const packed: Uint8Array[] = new Array(value.length);
        let total = 0;
        for (let i = 0; i < value.length; i++) {
          const p = packValueWith(value[i], owner, idMap, frame);
          packed[i] = p;
          total += p.byteLength;
        }
        const buf = new Uint8Array(5 + total);
        buf[0] = MARSHAL_TAG_ARRAY;
        new DataView(buf.buffer).setUint32(1, value.length, true);
        let off = 5;
        for (const p of packed) { buf.set(p, off); off += p.byteLength; }
        return buf;
      } finally {
        frame.depth--;
      }
    }
    // Plain object — only those whose prototype is Object.prototype or
    // null.  Others (class instances) fall through to BYREF (which will
    // throw cleanly on cross-heap receive — the caller knows to wrap
    // via napi_wrap or to use a plain-object DTO).
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      frame.depth++;
      try {
        const keys = Object.keys(value as object);
        const packedPairs: Uint8Array[] = [];
        let total = 0;
        for (const k of keys) {
          const pk = packValueWith(k, owner, idMap, frame);
          const pv = packValueWith(
            (value as Record<string, unknown>)[k], owner, idMap, frame,
          );
          packedPairs.push(pk, pv);
          total += pk.byteLength + pv.byteLength;
        }
        const buf = new Uint8Array(5 + total);
        buf[0] = MARSHAL_TAG_OBJECT_PLAIN;
        new DataView(buf.buffer).setUint32(1, keys.length, true);
        let off = 5;
        for (const p of packedPairs) { buf.set(p, off); off += p.byteLength; }
        return buf;
      } finally {
        frame.depth--;
      }
    }
    // Fall-through: opt-in by-ref via IdentityMap (only resolvable when
    // both sides share the same idMap).
    const id = idMap.put(value as object, owner);
    const flags = 0;
    const buf = new Uint8Array(9);
    buf[0] = MARSHAL_TAG_OBJECT_BYREF;
    const dv = new DataView(buf.buffer);
    dv.setUint32(1, id, true);
    dv.setUint32(5, flags, true);
    return buf;
  }
  // Functions, symbols, bigints — tag 255 / decoder throws.
  return new Uint8Array([MARSHAL_TAG_UNSUPPORTED]);
}

/** Per-frame state for an unpack() call.  Frame-local id → constructed
 *  object map, used to resolve MARSHAL_TAG_CIRCULAR_REF back to the
 *  same instance built earlier in this frame. */
interface UnpackFrame {
  byFrameId: object[];
  hooks: UnpackHooks;
}
function newUnpackFrame(hooks?: UnpackHooks): UnpackFrame {
  return { byFrameId: [], hooks: hooks ?? {} };
}

/**
 * Unpack a single value from `buf` starting at `offset`.  Returns the
 * decoded value and the number of bytes consumed.
 *
 * SAB safety: when `buf` is backed by a SharedArrayBuffer, the decoder
 * copies bytes before calling TextDecoder (which rejects shared views)
 * and for typed-array payloads (so the produced object lives in a
 * regular ArrayBuffer, not SAB).
 */
export function unpackValue(
  buf: Uint8Array,
  offset: number,
  idMap: IdentityMap,
  hooks?: UnpackHooks,
): { value: unknown; byteLength: number } {
  return unpackValueWith(buf, offset, idMap, newUnpackFrame(hooks));
}

function isSharedBuffer(buf: ArrayBufferLike): boolean {
  return typeof SharedArrayBuffer !== "undefined" && buf instanceof SharedArrayBuffer;
}

function unpackValueWith(
  buf: Uint8Array,
  offset: number,
  idMap: IdentityMap,
  frame: UnpackFrame,
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
      const start = buf.byteOffset + offset + 5;
      let view: Uint8Array;
      if (isSharedBuffer(buf.buffer)) {
        // TextDecoder rejects SAB-backed views; copy first.
        view = new Uint8Array(len);
        view.set(new Uint8Array(buf.buffer, start, len));
      } else {
        view = new Uint8Array(buf.buffer, start, len);
      }
      return { value: utf8Decoder.decode(view), byteLength: 5 + len };
    }
    case MARSHAL_TAG_OBJECT_BYREF: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 8);
      const id = dv.getUint32(0, true);
      const entry = idMap.get(id);
      if (!entry) {
        throw new Error("marshal: identity reference collected");
      }
      frame.byFrameId.push(entry.obj);
      return { value: entry.obj, byteLength: 9 };
    }
    case MARSHAL_TAG_PORT_REF: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const portId = dv.getUint32(0, true);
      if (frame.hooks.decodePort === undefined) {
        throw new Error(`marshal: MARSHAL_TAG_PORT_REF (portId=${portId}) decoded without a decodePort hook`);
      }
      const stub = frame.hooks.decodePort(portId);
      // Stubs are typically objects — register in byFrameId for any
      // future circular refs through them.  Skip if the factory
      // returned a primitive.
      if (stub !== null && typeof stub === "object") {
        frame.byFrameId.push(stub as object);
      }
      return { value: stub, byteLength: 5 };
    }
    case MARSHAL_TAG_DATE: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 8);
      const date = new Date(dv.getFloat64(0, true));
      frame.byFrameId.push(date);
      return { value: date, byteLength: 9 };
    }
    case MARSHAL_TAG_REGEXP: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const sourceLen = dv.getUint32(0, true);
      const start = buf.byteOffset + offset + 5;
      let view: Uint8Array;
      if (isSharedBuffer(buf.buffer)) {
        view = new Uint8Array(sourceLen);
        view.set(new Uint8Array(buf.buffer, start, sourceLen));
      } else {
        view = new Uint8Array(buf.buffer, start, sourceLen);
      }
      const source = utf8Decoder.decode(view);
      const flagsBits = buf[offset + 5 + sourceLen];
      const flags = regexpBitsToFlags(flagsBits);
      const re = new RegExp(source, flags);
      // Register in byFrameId — the encoder assigns a frame id to every
      // typeof "object" value (see frame.nextId++ in packValueWith),
      // so the decoder must too or circular-ref ids will desync.
      frame.byFrameId.push(re);
      return { value: re, byteLength: 6 + sourceLen };
    }
    case MARSHAL_TAG_MAP: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const size = dv.getUint32(0, true);
      const m = new Map<unknown, unknown>();
      // Register before recursing — entries may reference the Map.
      frame.byFrameId.push(m);
      let cursor = 5;
      for (let i = 0; i < size; i++) {
        const kR = unpackValueWith(buf, offset + cursor, idMap, frame);
        cursor += kR.byteLength;
        const vR = unpackValueWith(buf, offset + cursor, idMap, frame);
        cursor += vR.byteLength;
        m.set(kR.value, vR.value);
      }
      return { value: m, byteLength: cursor };
    }
    case MARSHAL_TAG_SET: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const size = dv.getUint32(0, true);
      const s = new Set<unknown>();
      // Register before recursing — entries may reference the Set.
      frame.byFrameId.push(s);
      let cursor = 5;
      for (let i = 0; i < size; i++) {
        const r = unpackValueWith(buf, offset + cursor, idMap, frame);
        s.add(r.value);
        cursor += r.byteLength;
      }
      return { value: s, byteLength: cursor };
    }
    case MARSHAL_TAG_ARRAYBUFFER: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const byteLen = dv.getUint32(0, true);
      const ab = new ArrayBuffer(byteLen);
      new Uint8Array(ab).set(
        new Uint8Array(buf.buffer, buf.byteOffset + offset + 5, byteLen),
      );
      frame.byFrameId.push(ab);
      return { value: ab, byteLength: 5 + byteLen };
    }
    case MARSHAL_TAG_TYPED_ARRAY: {
      const kind = buf[offset + 1];
      const Ctor = TYPED_ARRAY_KINDS[kind];
      if (!Ctor) throw new Error(`marshal: unknown typed-array kind ${kind}`);
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 2, 4);
      const byteLen = dv.getUint32(0, true);
      // Always copy into a fresh ArrayBuffer (decoupled from sender's
      // memory + SAB-safe).
      const ab = new ArrayBuffer(byteLen);
      new Uint8Array(ab).set(
        new Uint8Array(buf.buffer, buf.byteOffset + offset + 6, byteLen),
      );
      const ta = new (Ctor as new (b: ArrayBuffer) => ArrayBufferView)(ab);
      frame.byFrameId.push(ta);
      return { value: ta, byteLength: 6 + byteLen };
    }
    case MARSHAL_TAG_ARRAY: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const len = dv.getUint32(0, true);
      const arr: unknown[] = new Array(len);
      // Register the array BEFORE recursing so child refs that point
      // back to it via CIRCULAR_REF resolve to this instance.
      frame.byFrameId.push(arr);
      let cursor = 5;
      for (let i = 0; i < len; i++) {
        const r = unpackValueWith(buf, offset + cursor, idMap, frame);
        arr[i] = r.value;
        cursor += r.byteLength;
      }
      return { value: arr, byteLength: cursor };
    }
    case MARSHAL_TAG_OBJECT_PLAIN: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const propCount = dv.getUint32(0, true);
      const obj: Record<string, unknown> = {};
      // Register before recursing for circular self-refs.
      frame.byFrameId.push(obj);
      let cursor = 5;
      for (let i = 0; i < propCount; i++) {
        const kR = unpackValueWith(buf, offset + cursor, idMap, frame);
        cursor += kR.byteLength;
        const vR = unpackValueWith(buf, offset + cursor, idMap, frame);
        cursor += vR.byteLength;
        if (typeof kR.value !== "string") {
          throw new Error("marshal: object key was not a string");
        }
        obj[kR.value as string] = vR.value;
      }
      return { value: obj, byteLength: cursor };
    }
    case MARSHAL_TAG_CIRCULAR_REF: {
      const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4);
      const frameId = dv.getUint32(0, true);
      const target = frame.byFrameId[frameId];
      if (target === undefined) {
        throw new Error(`marshal: circular-ref to unknown frameId ${frameId}`);
      }
      return { value: target, byteLength: 5 };
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
