// Regression: Response body consumption (text/arrayBuffer).
//
// Bug #1 from RABBIT_HOLE.md (sab-ab-body-read) had TWO underlying causes:
//
// 1. `internalBinding('task_queue').enqueueMicrotask` infinitely recursed:
//    edge's wasm-host `unofficial_napi_enqueue_microtask` requires an
//    isolate emnapi doesn't have, returns napi_invalid_arg, which fires
//    the C++ fallback that calls globalThis.queueMicrotask = lib's
//    wrapper = ... = back into enqueueMicrotask.  Fixed by the
//    `task-queue-enqueue-fix` policy (in minimalPolicies).
//
// 2. With wasm-aliased Buffer storage, every Buffer's `.buffer` is the
//    wasm SharedArrayBuffer.  Edge's vendored webstreams/crypto lib uses
//    the strict V8 primordials (`ArrayBufferPrototypeGetByteLength`,
//    `Transfer`, `Slice`, `GetDetached`) that throw on SAB receivers.
//    Fixed by the `buffer-wasm-aliased` policy's `{ pre }` patch on
//    `internal/per_context/primordials.js` — replaces the AB prototype
//    methods with polymorphic versions before primordials snapshot.
//
// Both fixes are in `minimalPolicies`, so this test runs with the
// default harness flags.

let textResult = '';
let abByteLen = -1;

new Response('hello world').text().then(t => { textResult = t; check(); });
new Response('eight!!!').arrayBuffer().then(ab => { abByteLen = ab.byteLength; check(); });

let done = 0;
function check() {
  done++;
  if (done === 2) {
    const ok = textResult === 'hello world' && abByteLen === 8;
    if (ok) console.log('response-body-consume-ok');
    else console.log('response-body-consume-bad: text=' + JSON.stringify(textResult) + ' ab=' + abByteLen);
  }
}
