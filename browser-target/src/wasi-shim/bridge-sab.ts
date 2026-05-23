// HTTP bridge SAB.
//
// SW-intercepted HTTP requests flow Page → Worker via this SAB ring.  The
// Service Worker can't directly transfer SABs in postMessage (Chrome 148
// silently drops them — see `#!~debt sw-sab-relay` in main.ts), so the page
// is the producer that writes incoming requests into the ring and the
// runtime worker is the consumer that drains them.
//
// Why a ring (not single-slot).  Multiple concurrent HTTP requests can be
// in flight (browser fires several `fetch()` calls in parallel for assets,
// API requests, etc).  16 slots × 32KB each fits typical request payloads;
// the ring is full only if 16 requests pile up before the worker drains —
// hasn't been observed in practice.
//
// Wake protocol.  This ring uses the SHIM's `wakeView` (a separate SAB the
// wasi-shim creates internally for `Atomics.wait` inside `accept_v2`), NOT
// the sab-ring primitive's own wake counter.  The shim is already blocked
// on its wake SAB inside the wasm sync call; the page producer bumps both
// (the sab-ring counter for forward-compat with future async waiters, and
// the shim's wake SAB to actually unblock the wasm).  Worker-side drain is
// triggered via the shim's `setWakePoll` callback, so the bridge consumer
// never `waitAsync`s on the ring directly.
//
// Payload format.  JSON-encoded:
//   { reqId, method, path, headers, bodyB64? }
// reqId was a separate 4-byte field in the old hand-rolled layout; it now
// rides in the JSON to fit the standard sab-ring header (status + ids +
// payloadLen).  All other transport semantics preserved.

import {
  attachRing,
  createRing,
  drainRing,
  freeSlot,
  payloadBytes,
  payloadCapacity,
  publishSlot,
  tryClaimSlot,
  type RingConfig,
  type RingView,
} from "./sab-ring";
import type { BridgeRequest } from "../wasi-shim";

// Cache native intrinsics at module load — edge mutates globalThis during
// bootstrap (see NOTES.md globalthis-mutation debt).
const NativeAtomics = Atomics;
const NativeUint8Array = Uint8Array;
const NativeTextEncoder = TextEncoder;
const NativeTextDecoder = TextDecoder;

export const BRIDGE_NUM_SLOTS = 16;
export const BRIDGE_SLOT_SIZE = 32 * 1024;

// In L1 we only have one host worker / context.  Both ids are 0; they're
// reserved by sab-ring for L2+ (worker_threads, per-context routing).
const BRIDGE_HOST_WORKER_ID = 0;
const BRIDGE_CONTEXT_ID = 0;

const BRIDGE_RING_CONFIG: RingConfig = {
  numSlots: BRIDGE_NUM_SLOTS,
  slotSize: BRIDGE_SLOT_SIZE,
};

export function createBridgeRing(): RingView {
  return createRing(BRIDGE_RING_CONFIG);
}

export function attachBridgeRing(sab: SharedArrayBuffer): RingView {
  return attachRing(sab, BRIDGE_RING_CONFIG);
}

export function bridgePayloadCapacity(ring: RingView): number {
  return payloadCapacity(ring);
}

interface BridgePayload {
  reqId: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyB64?: string;
}

const encoder = new NativeTextEncoder();
const decoder = new NativeTextDecoder("utf-8", { fatal: false });

/** Page-side producer.  Encodes the request as JSON, claims a slot, writes
 *  the payload, publishes (which bumps the ring's internal wake counter),
 *  then bumps the shim's wakeI32 to unblock the worker's `Atomics.wait`.
 *
 *  Returns true on success, false if the ring is full (caller drops the
 *  request and logs).  The original implementation also spun up to 100
 *  passes over the ring before declaring "full" — we preserve that.
 */
export function publishBridgeRequest(
  ring: RingView,
  shimWakeI32: Int32Array,
  reqId: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  bodyB64: string | undefined,
): boolean {
  const payload: BridgePayload = { reqId, method, path, headers };
  if (bodyB64 !== undefined) payload.bodyB64 = bodyB64;
  const json = encoder.encode(JSON.stringify(payload));
  const cap = payloadCapacity(ring);
  if (json.length > cap) {
    return false;
  }
  // Spin a few times across the ring before giving up — the original
  // impl had `maxSpins=100` * 16 = 1600 cmpxchg attempts in the worst
  // case.  Worker drains all-at-once on each wake so backpressure is rare.
  let slot = -1;
  const maxSpins = 100;
  for (let spin = 0; spin < maxSpins; spin++) {
    slot = tryClaimSlot(ring, BRIDGE_HOST_WORKER_ID, BRIDGE_CONTEXT_ID);
    if (slot >= 0) break;
  }
  if (slot < 0) return false;
  const dst = payloadBytes(ring, slot);
  dst.set(json);
  publishSlot(ring, slot, json.length);
  // Wake the shim's `accept_v2` `Atomics.wait`.  publishSlot already
  // bumped the ring's own wake counter (harmless; nobody waits on it in
  // L1) — the shim wake SAB is the one that actually unblocks the wasm.
  NativeAtomics.add(shimWakeI32, 0, 1);
  NativeAtomics.notify(shimWakeI32, 0);
  return true;
}

/** Worker-side consumer.  Drains all currently-READY slots, decodes each
 *  payload back into a BridgeRequest, and frees each slot.  Concurrent
 *  drains across multiple consumers are safe (sab-ring cmpxchgs the
 *  status transition); in practice there's only one consumer worker.
 */
export function drainBridgeRing(ring: RingView): BridgeRequest[] {
  const messages = drainRing(ring);
  const out: BridgeRequest[] = [];
  for (const msg of messages) {
    // Copy payload bytes out of the SAB before we free the slot — the
    // subarray returned by drainRing aliases the SAB and is invalidated
    // by freeSlot.
    const jsonBytes = new NativeUint8Array(msg.payload.length);
    jsonBytes.set(msg.payload);
    freeSlot(ring, msg.slot);
    let parsed: BridgePayload;
    try {
      parsed = JSON.parse(decoder.decode(jsonBytes)) as BridgePayload;
    } catch {
      continue;
    }
    let body: ArrayBuffer | null = null;
    if (parsed.bodyB64) {
      const bin = atob(parsed.bodyB64);
      const buf = new NativeUint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      body = buf.buffer;
    }
    out.push({
      reqId: parsed.reqId,
      method: parsed.method,
      path: parsed.path,
      headers: parsed.headers,
      body,
    });
  }
  return out;
}
