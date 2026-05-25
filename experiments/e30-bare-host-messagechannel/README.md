# e30 — Bare-host MessageChannel probe

## Hypothesis to confirm/deny

`globalThis.MessageChannel` is a Web Platform API available in
DedicatedWorker contexts.  Our browser-target runs user code (under
`host=1` mode) in a DedicatedWorker, so the API *should* be available
and behave per spec.

Before scoping the phase-4 implementation of `worker_threads.MessageChannel`
as a thin facade over browser-native `MessageChannel`, we need to verify
the Web API actually works in our specific setup:

- Vite dev server
- COOP/COEP isolation headers
- DedicatedWorker context (the host worker)
- Whatever other harness quirks the runner has

**Probe:** can host JS create a `MessageChannel`, exchange messages on
both ports, and transfer an ArrayBuffer cleanly?

## Why this matters

Phase 4 of worker_threads needs `new MessageChannel()` to work on the
user side.  Our planned implementation wraps `globalThis.MessageChannel`
on the host side (per design notes in conversation after e29 close).
If the Web API doesn't behave as expected here, the whole approach is
suspect and we need a different design before any implementation work.

If it DOES work cleanly (highly expected — it's a stable Web API), then
phase 4 scoping is confirmed and we can move to e31 (bridging
wasm-side lib MessageChannel through napi to host MessageChannel).

## Test design

Run as a `host=1` test (user code runs directly on the host worker's
V8, not inside wasm).  This isolates the Web API check from any
wasm/napi/lib complications.

`probe.js`:
```js
const out = [];

if (typeof MessageChannel !== 'function') {
  console.log('FAIL: MessageChannel not a function');
  process.exit(1);
}
out.push('exists');

const ch = new MessageChannel();
if (!ch.port1 || !ch.port2) {
  console.log('FAIL: ports missing');
  process.exit(1);
}
out.push('ports');

// String message port1 -> port2
ch.port2.onmessage = (e) => {
  out.push('p2_recv=' + e.data);

  // ArrayBuffer transfer port2 -> port1
  const ab = new ArrayBuffer(8);
  new Uint8Array(ab)[0] = 42;
  ch.port1.onmessage = (e2) => {
    const arr = new Uint8Array(e2.data);
    out.push('p1_ab_byte=' + arr[0]);
    out.push('ab_detached=' + (ab.byteLength === 0));

    // Close
    ch.port1.close();
    ch.port2.close();
    out.push('closed');

    console.log(out.join(','));
    process.exit(0);
  };
  ch.port2.postMessage(ab, [ab]);
};

ch.port1.postMessage('hello');

setTimeout(() => {
  out.push('TIMEOUT');
  console.log(out.join(','));
  process.exit(1);
}, 3000);
```

Expected output: `exists,ports,p2_recv=hello,p1_ab_byte=42,ab_detached=true,closed`

## Methodology

1. Write `tests/js/e30-bare-host-messagechannel.js` with the probe.
2. Write `tests/js/e30-bare-host-messagechannel.stdout` with expected.
3. Write `tests/js/e30-bare-host-messagechannel.harness-args` with
   `host=1` (forces user code onto host worker, not wasm).
4. Run via browser-test-runner 5 times.
5. Remove test files after.

## Success criteria

- 5/5 pass with expected output → Web API foundation confirmed; proceed
  to e31 (wasm-side lib facade).
- Any failure → document precisely what fails.  Possibilities:
  - `MessageChannel` undefined in DedicatedWorker (unlikely; would
    invalidate the whole design)
  - Transferables don't detach (would mean structured-clone is
    misbehaving — probably env issue)
  - Messages don't arrive (would suggest some event-loop weirdness)
  - Close throws/hangs (would suggest race in cleanup)

## Output

`FINDINGS.md` in this directory with verdict + 5-run table + any
deviations from expected output.
