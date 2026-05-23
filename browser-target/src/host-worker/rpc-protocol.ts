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

// ── Control ops (proof-of-life + lifecycle) ─────────────────────────

export const OP_PING = OP_DOMAIN_CONTROL | 0x0001;
// Request: empty.  Reply: empty.
// Used to verify the channel is up.

export const OP_HOST_READY = OP_DOMAIN_CONTROL | 0x0002;
// Sent by host → wasm at startup to signal it's accepting requests.

export const OP_SHUTDOWN = OP_DOMAIN_CONTROL | 0x0003;
// Sent by wasm → host to request graceful shutdown.

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
