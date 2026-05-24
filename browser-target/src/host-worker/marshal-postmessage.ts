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

import { packValue, unpackValue, IdentityMap } from "./cross-context-marshal";

export function packPostMessage(value: unknown): Uint8Array {
  try {
    return packValue(value, "host", new IdentityMap());
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    throw new Error(
      `worker_threads postMessage: failed to clone value — ${msg}. ` +
      `Functions, Symbols, and class instances cannot cross worker boundaries.`,
    );
  }
}

export function unpackPostMessage(bytes: Uint8Array): unknown {
  const { value } = unpackValue(bytes, 0, new IdentityMap());
  return value;
}
