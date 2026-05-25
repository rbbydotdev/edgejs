// e34 fix #3: swapArrayBufferRefs handles arbitrarily deep trees +
// TypedArrays/DataView whose underlying buffer is transferred.
//
// Three scenarios:
//   (a) AB nested under hundreds of object levels — no depth bound
//   (b) TypedArray view in clone tree whose .buffer is in transfer list
//   (c) DataView view, same scenario
const { MessageChannel } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

// (a) Deep nesting
const ch1 = new MessageChannel();
const ab1 = new ArrayBuffer(8);
new Uint8Array(ab1)[0] = 42;
// 100-level nesting exceeds the prior 64-depth bound; bounded by wasm
// C++ stack (separate recursion in PrepareTransferable+RestoreTransferable;
// those are recursive C++ functions and 100-150 frames is well within
// wasm's typical 1 MB stack).
let nested = { ab: ab1 };
for (let i = 0; i < 100; i++) nested = { inner: nested };
let recv1 = null;
ch1.port2.on('message', (m) => { recv1 = m; });
ch1.port1.postMessage(nested, [ab1]);

// (b) TypedArray view transfer
const ch2 = new MessageChannel();
const ab2 = new ArrayBuffer(16);
const view2 = new Uint16Array(ab2);
view2[0] = 0xBEEF;
view2[1] = 0xCAFE;
let recv2 = null;
ch2.port2.on('message', (m) => { recv2 = m; });
ch2.port1.postMessage({ view: view2 }, [ab2]);

// (c) DataView transfer
const ch3 = new MessageChannel();
const ab3 = new ArrayBuffer(8);
const dv3 = new DataView(ab3);
dv3.setUint32(0, 0xDEADBEEF, true);
let recv3 = null;
ch3.port2.on('message', (m) => { recv3 = m; });
ch3.port1.postMessage({ dv: dv3 }, [ab3]);

setTimeout(() => {
  // (a) deep nesting unwraps + transfers AB
  let cur = recv1;
  for (let i = 0; i < 100; i++) cur = cur && cur.inner;
  ok('deep_a_unwrapped', cur && cur.ab instanceof ArrayBuffer);
  ok('deep_a_ab_content', cur && cur.ab && new Uint8Array(cur.ab)[0] === 42);
  ok('deep_a_source_detached', ab1.byteLength === 0);

  // (b) TypedArray's .buffer is the cloned AB (not the detached source)
  ok('typedarray_received', recv2 && recv2.view instanceof Uint16Array);
  ok('typedarray_content', recv2 && recv2.view && recv2.view[0] === 0xBEEF && recv2.view[1] === 0xCAFE);
  ok('typedarray_source_detached', ab2.byteLength === 0);

  // (c) DataView preserves byteOffset/byteLength
  ok('dataview_received', recv3 && recv3.dv instanceof DataView);
  ok('dataview_content', recv3 && recv3.dv && recv3.dv.getUint32(0, true) === 0xDEADBEEF);
  ok('dataview_source_detached', ab3.byteLength === 0);

  ch1.port2.close(); ch2.port2.close(); ch3.port2.close();
  process.exit(0);
}, 700);
