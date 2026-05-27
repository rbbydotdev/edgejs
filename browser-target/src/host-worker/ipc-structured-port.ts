// Shared between worker.ts (wasm-runtime) and host-worker.ts.
// Both sides of a P3.9 structured-clone IPC MessageChannel run the
// same dispatch shape: receive { childId, msg, kind? } envelopes,
// route per-childId, fire either an onMessage or onDisconnect
// handler. Before extraction, both files had ~30 lines of nearly
// identical code. Now this module owns the protocol; the file-local
// adapters just supply how to register child handlers and what to
// expose as globals.

export interface IpcEnvelope {
  childId: number;
  msg?: unknown;
  kind?: "disconnect";
}

export interface IpcDispatcher {
  /** Inbound: structured-clone value for the named childId. */
  onMessage(childId: number, msg: unknown): void;
  /** Inbound: peer requested disconnect for the named childId. */
  onDisconnect(childId: number): void;
}

/** Attach a MessageChannel half (port) to a dispatcher. Returns the
 *  outbound API so the caller can hand it to local code that needs to
 *  send messages to the peer. */
export function attachIpcStructuredPort(
  port: MessagePort,
  dispatcher: IpcDispatcher,
): {
  send: (childId: number, msg: unknown, transfer?: Transferable[]) => boolean;
  disconnect: (childId: number) => boolean;
} {
  port.onmessage = (e: MessageEvent) => {
    const data = e.data as IpcEnvelope | undefined;
    if (!data || typeof data.childId !== "number") return;
    if (data.kind === "disconnect") {
      dispatcher.onDisconnect(data.childId);
      return;
    }
    dispatcher.onMessage(data.childId, data.msg);
  };
  port.start?.();
  return {
    send(childId, msg, transfer) {
      port.postMessage({ childId, msg } satisfies IpcEnvelope, transfer || []);
      return true;
    },
    disconnect(childId) {
      port.postMessage({ childId, kind: "disconnect" } satisfies IpcEnvelope);
      return true;
    },
  };
}
