// Host worker — DedicatedWorker entry.
//
// This is the worker where user JS, Node lib/*.js, and emnapi context
// will live after the L5 cutover.  For L2, it just runs the RPC server
// and replies to `ping`.
//
// Bootstrap protocol (page → host worker):
//   1. Page spawns `new Worker(this file, { type: 'module' })`.
//   2. Page posts `{ kind: 'init', requestSab, replySab, hostWorkerId }`.
//      requestSab/replySab are SAB-backed sab-rings already allocated by
//      the page.  The wasm worker has the same SABs (handed to it
//      independently); pages bridges them via the SABs themselves —
//      after the init handshake, no postMessage traffic is needed for
//      RPC.
//   3. Host worker attaches to both rings, starts the RPC server.
//   4. Host worker posts `{ kind: 'ready' }` back to page.
//
// After ready, the page treats this host worker as "the host" and the
// wasm worker as "the wasm".  RPC flows over the SABs directly.

import {
  attachRing,
  RingView,
  type RingConfig,
} from "../wasi-shim/sab-ring";
import { RpcServer } from "./rpc-server";
import { RpcClient } from "./rpc-client";
import {
  OP_PING,
  OP_HOST_READY,
  OP_HOST_ECHO,
  REPLY_STATUS_OK,
} from "./rpc-protocol";

declare const self: DedicatedWorkerGlobalScope;

// Must match the producer's config (in worker-pool.ts).
const RING_CONFIG: RingConfig = {
  numSlots: 32,
  slotSize: 4 * 1024,
};

interface InitMessage {
  kind: "init";
  requestSab: SharedArrayBuffer;
  replySab: SharedArrayBuffer;
  reverseRequestSab: SharedArrayBuffer;
  reverseReplySab: SharedArrayBuffer;
  hostWorkerId: number;
}

interface ReadyMessage {
  kind: "ready";
  hostWorkerId: number;
}

interface ReverseEchoMessage {
  kind: "reverse-echo";
  bytes: number;
}

let hostWorkerId = -1;
let requestRing: RingView | null = null;
let replyRing: RingView | null = null;
let server: RpcServer | null = null;
// Reverse channel: host-side client for sending requests TO wasm
// (finalizers, threadsafe function dispatch, future host→wasm signals).
let reverseRequestRing: RingView | null = null;
let reverseReplyRing: RingView | null = null;
let reverseClient: RpcClient | null = null;
/** Exposed for L4 bench script and future L5 callers. */
export function getReverseClient(): RpcClient | null { return reverseClient; }

function log(text: string, level: "info" | "warn" | "err" = "info"): void {
  self.postMessage({ kind: "host-log", text: `[host-worker:${hostWorkerId}] ${text}`, level });
}

function registerHandlers(srv: RpcServer): void {
  // ping: round-trip with no payload.  Proof of life.
  srv.register(OP_PING, async () => ({
    payload: new Uint8Array(0),
    status: REPLY_STATUS_OK,
  }));

  // echo: round-trip a payload.  Used by L3 throughput bench.
  srv.register(OP_HOST_ECHO, async (_ctx, args) => {
    // Copy the args (they alias SAB; caller may free before reply lands).
    const copy = new Uint8Array(args.byteLength);
    copy.set(args);
    return { payload: copy, status: REPLY_STATUS_OK };
  });

  // OP_HOST_READY is host→wasm; host doesn't receive it.  No handler.
  void OP_HOST_READY;
}

async function runReverseEcho(bytes: number): Promise<void> {
  if (!reverseClient) {
    log("reverse-echo: reverseClient not ready", "err");
    return;
  }
  const { OP_WASM_ECHO } = await import("./rpc-protocol");
  const payload = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) payload[i] = i & 0xff;
  const t0 = performance.now();
  const res = await reverseClient.call(OP_WASM_ECHO, hostWorkerId, 0, payload);
  const dt = performance.now() - t0;
  if (res.status !== 0 || res.payload.byteLength !== bytes) {
    log(`reverse-echo FAILED: status=${res.status} bytes=${res.payload.byteLength}`, "err");
    return;
  }
  // Verify bytes round-tripped.
  for (let i = 0; i < bytes; i++) {
    if (res.payload[i] !== (i & 0xff)) {
      log(`reverse-echo: byte mismatch at index ${i}`, "err");
      return;
    }
  }
  log(`reverse-echo: ok ${bytes}B in ${dt.toFixed(3)}ms`);
}

self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as (Partial<InitMessage> | ReverseEchoMessage) | null;
  if (data?.kind === "reverse-echo") {
    void runReverseEcho(data.bytes ?? 32);
    return;
  }
  if (!data || data.kind !== "init") return;
  if (server !== null) {
    log("init received twice; ignoring second", "warn");
    return;
  }
  hostWorkerId = data.hostWorkerId ?? 0;
  if (!data.requestSab || !data.replySab || !data.reverseRequestSab || !data.reverseReplySab) {
    log("init missing one of (request|reply|reverseRequest|reverseReply)Sab", "err");
    return;
  }
  try {
    requestRing = attachRing(data.requestSab, RING_CONFIG);
    replyRing = attachRing(data.replySab, RING_CONFIG);
    reverseRequestRing = attachRing(data.reverseRequestSab, RING_CONFIG);
    reverseReplyRing = attachRing(data.reverseReplySab, RING_CONFIG);
  } catch (err) {
    log(`attachRing failed: ${(err as Error).message}`, "err");
    return;
  }
  server = new RpcServer(requestRing, replyRing);
  registerHandlers(server);
  // Reverse-channel client (host -> wasm).  Used by L5+ for finalizers
  // and threadsafe function dispatch.  No handlers needed on host's
  // side of this channel — replies route via requestId demux as usual.
  reverseClient = new RpcClient(reverseRequestRing, reverseReplyRing);
  // Start drain loop (fire-and-forget).
  void server.start().catch((err) => {
    log(`rpc-server crashed: ${(err as Error).stack ?? err}`, "err");
  });
  log("ready (forward + reverse channels both attached)");
  const ready: ReadyMessage = { kind: "ready", hostWorkerId };
  self.postMessage(ready);
});
