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

// Duck-type detector for edge.js MessagePort instances.  Used to
// catch ports that appear in the value tree but aren't listed in
// transferList — per spec, that should throw DataCloneError
// synchronously on the sender side (e33 item 5).
//
// The shape check requires ALL of postMessage/start/close/ref/unref/
// hasRef as own-instance functions.  Browser MessagePort has them
// too, which is fine — sending one cross-worker without transfer
// is also invalid.  Worker class has postMessage but lacks start/
// ref/unref/hasRef so it's not falsely matched.
function isPortShape(v: unknown): boolean {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.postMessage === "function"
    && typeof o.start === "function"
    && typeof o.close === "function"
    && typeof o.ref === "function"
    && typeof o.unref === "function"
    && typeof o.hasRef === "function"
  );
}

/** Construct a DataCloneError compatible with both Node and browser
 *  consumers.  Uses DOMException when available (browser/DedicatedWorker
 *  scope), falls back to a plain Error with .name set.  Either way,
 *  user code can `e.name === 'DataCloneError'` and check the message. */
function makeDataCloneError(msg: string): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(msg, "DataCloneError");
  }
  const e = new Error(msg);
  (e as Error & { name: string }).name = "DataCloneError";
  return e;
}

/** Result returned by an `assignPortId` callback.  A bare number
 *  defaults originWorkerId to 0 (parent — for backward compatibility
 *  with simpler callers).  Use the object form to carry an explicit
 *  origin (required for items 2-full and 3 cross-child routing). */
export type AssignPortIdResult =
  | number
  | { id: number; originWorkerId: number }
  | null;

/** Pack a value for cross-worker delivery.
 *
 *  @param value          The user payload.
 *  @param transferList   Optional array of objects to transfer (mark as
 *                        ports for receiver-side materialization).
 *                        Currently only MessagePort-shaped objects are
 *                        supported; entries the caller can't ID-map are
 *                        ignored (fall through to default encoding).
 *  @param assignPortId   Optional callback that returns a port-ID +
 *                        originWorkerId for a transferable.  Returning
 *                        null skips that entry.
 */
export function packPostMessage(
  value: unknown,
  transferList?: unknown[],
  assignPortId?: (port: object) => AssignPortIdResult,
): Uint8Array {
  // Build a map: each transferable object → { id, originWorkerId }.
  // The map lookup powers the encodeObject hook below.
  const portEntryByObj = new Map<object, { id: number; originWorkerId: number }>();
  if (transferList && transferList.length > 0) {
    if (assignPortId === undefined) {
      throw new Error(
        "worker_threads postMessage: transferList provided without an assignPortId callback (caller bug)",
      );
    }
    for (const entry of transferList) {
      if (entry === null || typeof entry !== "object") continue;
      const r = assignPortId(entry as object);
      if (r === null || r === undefined) continue;
      const normalized =
        typeof r === "number" ? { id: r, originWorkerId: 0 } : r;
      portEntryByObj.set(entry as object, normalized);
    }
  }
  const hooks: PackHooks = {
    encodeObject(v) {
      const entry = portEntryByObj.get(v);
      if (entry !== undefined) {
        const buf = new Uint8Array(9);
        buf[0] = 16; // MARSHAL_TAG_PORT_REF
        const dv = new DataView(buf.buffer);
        dv.setUint32(1, entry.id, true);
        dv.setUint32(5, entry.originWorkerId, true);
        return buf;
      }
      // Item 5 (e33): MessagePort in value tree but NOT in transferList
      // is invalid per spec — throw DataCloneError synchronously on the
      // sender side rather than producing bytes that throw "marshal:
      // identity reference collected" on the receiver later.
      if (isPortShape(v)) {
        throw makeDataCloneError(
          "MessagePort included in value but not in transferList; " +
          "add it to the transferList argument to transfer it.",
        );
      }
      return null;
    },
  };
  try {
    return packValue(value, "host", new IdentityMap(), hooks);
  } catch (e) {
    // Preserve DataCloneError from the encodeObject hook (item 5) —
    // re-throwing as a generic Error would lose the .name that callers
    // pattern-match on (per spec).
    if (e instanceof Error && e.name === "DataCloneError") throw e;
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
 *                      for a given (portId, originWorkerId).  Required
 *                      if the bytes contain MARSHAL_TAG_PORT_REF
 *                      entries (otherwise decoder throws).
 */
export function unpackPostMessage(
  bytes: Uint8Array,
  decodePort?: (portId: number, originWorkerId: number) => unknown,
): unknown {
  const hooks: UnpackHooks | undefined =
    decodePort !== undefined ? { decodePort } : undefined;
  const { value } = unpackValue(bytes, 0, new IdentityMap(), hooks);
  return value;
}
