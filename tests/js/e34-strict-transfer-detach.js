// e34 task #14: Phase 4b strict transferList detach.
//
// Per HTML structured-clone spec, when an ArrayBuffer is in the
// transferList of a postMessage call, its byteLength becomes 0 on the
// source side (it is detached / transferred to the destination).
//
// Pre-fix: edge's wasm-side `unofficial_napi_structured_clone_with_transfer`
// dropped the transferList (#!~debt marker), so the source AB stayed
// usable.  Post-fix: the wasm-side forwards the transferList to the
// browser-native structuredClone, which performs the detach.
//
// Exercised via in-process MessageChannel (same isolate); the C++
// binding path passes the transferList down to the napi serialize call.
const { MessageChannel } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

const ch = new MessageChannel();
const ab = new ArrayBuffer(32);
new Uint8Array(ab).fill(7);  // sentinel content

let received = null;
ch.port2.on('message', (m) => { received = m; });

// Verify pre-state: source AB is usable
ok('source_ab_pre_byteLength', ab.byteLength === 32);

ch.port1.postMessage(ab, [ab]);

setTimeout(() => {
  ok('source_ab_detached', ab.byteLength === 0);
  ok('received_arraybuffer', received instanceof ArrayBuffer);
  ok('received_ab_byteLength', received && received.byteLength === 32);
  ok('received_ab_content', received && new Uint8Array(received)[0] === 7);
  ch.port2.close();
  process.exit(0);
}, 500);
