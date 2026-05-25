// Marshaling wrapper for worker_threads phase 2 postMessage.
//
// `packPostMessage` / `unpackPostMessage` wrap `cross-context-marshal`'s
// `packValue` / `unpackValue` with FRESH `IdentityMap`s per call.  That
// gives us pure by-value semantics — no shared object identity across
// the parent ↔ child boundary, matching Node's `worker_threads`
// postMessage contract (which is structuredClone-equivalent).
//
// We don't share an IdentityMap because parent wasm and child wasm are
// separate V8 isolates; the `MARSHAL_TAG_OBJECT_BYREF` path (which
// requires a shared map) would never resolve anyway.  Plain objects,
// arrays, typed arrays, ArrayBuffers, Date, Map, Set, RegExp, and
// circular refs within a single value all round-trip correctly via
// the wire-format tags documented in `cross-context-marshal.ts`.
//
// Symbols / Functions / BigInts hit MARSHAL_TAG_UNSUPPORTED (255) and
// `packValue` throws; the wrapper re-throws with a clearer message.
//
// Phase 4 (e33): cross-worker MessagePort transfer.  Optional
// transferList parameter on pack and portFactory on unpack route
// transferable MessagePort instances through MARSHAL_TAG_PORT_REF
// tagged with caller-assigned port-IDs.  The caller manages port-ID
// allocation and the receiver-side stub materialization.  When
// transferList is omitted, behavior is unchanged from phase 2.

import {
  packValue,
  unpackValue,
  IdentityMap,
  type PackHooks,
  type UnpackHooks,
} from "./cross-context-marshal";

/** Pack a value for cross-worker delivery.
 *
 *  @param value          The user payload.
 *  @param transferList   Optional array of objects to transfer (mark as
 *                        ports for receiver-side materialization).
 *                        Currently only MessagePort-shaped objects are
 *                        supported; entries the caller can't ID-map are
 *                        ignored (fall through to default encoding).
 *  @param assignPortId   Optional callback that returns a port-ID for a
 *                        transferable.  Called once per entry in
 *                        transferList.  Returning null skips that entry
 *                        (it'll fall through to default encoding, which
 *                        likely throws if it's a class instance).
 *                        Defaults to a stub allocator that throws —
 *                        callers MUST provide this when transferList
 *                        is non-empty.
 */
export function packPostMessage(
  value: unknown,
  transferList?: unknown[],
  assignPortId?: (port: object) => number | null,
): Uint8Array {
  // Build a map: each transferable object → its port-ID (assigned by
  // the caller).  The map lookup powers the encodeObject hook.
  const portIdByObj = new Map<object, number>();
  if (transferList && transferList.length > 0) {
    if (assignPortId === undefined) {
      throw new Error(
        "worker_threads postMessage: transferList provided without an assignPortId callback (caller bug)",
      );
    }
    for (const entry of transferList) {
      if (entry === null || typeof entry !== "object") continue;
      const id = assignPortId(entry as object);
      if (id !== null) {
        portIdByObj.set(entry as object, id);
      }
    }
  }
  const hooks: PackHooks = {
    encodeObject(v) {
      const id = portIdByObj.get(v);
      if (id === undefined) return null;
      const buf = new Uint8Array(5);
      buf[0] = 16; // MARSHAL_TAG_PORT_REF (avoid import cycle in the literal)
      new DataView(buf.buffer).setUint32(1, id, true);
      return buf;
    },
  };
  try {
    return packValue(value, "host", new IdentityMap(), hooks);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    throw new Error(
      `worker_threads postMessage: failed to clone value — ${msg}. ` +
      `Functions, Symbols, and class instances cannot cross worker boundaries.`,
    );
  }
}

/** Unpack a value received from cross-worker delivery.
 *
 *  @param bytes        Wire bytes from a matching pack call.
 *  @param decodePort   Optional factory that materializes a port stub
 *                      for a given port-ID.  Required if the bytes
 *                      contain MARSHAL_TAG_PORT_REF entries (otherwise
 *                      decoder throws).
 */
export function unpackPostMessage(
  bytes: Uint8Array,
  decodePort?: (portId: number) => unknown,
): unknown {
  const hooks: UnpackHooks | undefined =
    decodePort !== undefined ? { decodePort } : undefined;
  const { value } = unpackValue(bytes, 0, new IdentityMap(), hooks);
  return value;
}
