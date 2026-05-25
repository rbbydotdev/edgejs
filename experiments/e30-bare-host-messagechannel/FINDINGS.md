# e30 — Bare-host MessageChannel probe: FINDINGS

## Verdict: **GREEN — Web API foundation confirmed**

`globalThis.MessageChannel` works to spec inside our DedicatedWorker
context (host=1 path through `OP_RUN_USER_SCRIPT`).  All probed
behavior matches Web Platform expectations.  Phase 4 implementation
plan (wrap browser-native MessageChannel rather than mirror Node's
`node_messaging.cc`) is validated.

## 5-run table

| Run | Result | Stdout                                                           |
|-----|--------|------------------------------------------------------------------|
| 1   | ok     | `exists,ports,p2_recv=hello,p1_ab_byte=42,ab_detached=true,closed` |
| 2   | ok     | (same)                                                           |
| 3   | ok     | (same)                                                           |
| 4   | ok     | (same)                                                           |
| 5   | ok     | (same)                                                           |

Zero flake, zero deviation from expected output.

## What this proves

- ✅ `MessageChannel` is a constructor in DedicatedWorker scope (Vite + COOP/COEP + isolation don't strip the global).
- ✅ `new MessageChannel()` returns `{port1, port2}` per spec.
- ✅ Bidirectional message delivery (port1 → port2 string + port2 → port1 ArrayBuffer).
- ✅ `onmessage` fires asynchronously inside the worker's event loop.
- ✅ Transferables: `postMessage(ab, [ab])` detaches `ab` on the sender side (`ab.byteLength === 0` post-transfer) — structured-clone with transfer works natively.
- ✅ `close()` is synchronous, doesn't throw, doesn't hang.

## What this doesn't yet prove

- Cross-worker MessagePort transfer (port object itself as transferable) — that's e32.
- Wasm-side lib facade routing through napi → host MessageChannel — that's e31.
- Behavior under large message floods / simultaneous close — that's e34.

## Recommendation

Proceed to **e31: wasm-side lib `MessageChannel` facade → napi → host
MessageChannel roundtrip**.  e30 confirms the host-side primitive is
solid; e31 builds the JS facade and napi bridge to expose it to
wasm-side user code.

## Files state

- `tests/js/e30-*` — created, run, removed.  No tree pollution.
- `experiments/e30-bare-host-messagechannel/` — this FINDINGS + README.

No source changes.  No commits needed for this probe (research only).
