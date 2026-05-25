// Ported from node/test/parallel/test-worker-beforeexit-throw-exit.js
//
// Verifies that when a Worker's process.on('beforeExit') handler throws,
// the parent receives BOTH an 'error' event AND an 'exit' event (with
// non-zero code), and SharedArrayBuffer-backed workerData mutations
// from the child are visible to the parent.
//
// Minimal porting changes from the upstream test:
// 1. `const common = require('../common')` → `const common = globalThis.common;`
//    (loaded via the prelude=common-shim harness-arg)
// 2. Added a trailing `setTimeout(...process.exit(0)...)` so the browser
//    runner's sentinel fires.  Upstream relies on Node's natural
//    loop-drain to exit.
'use strict';
const common = globalThis.common;
const assert = require('assert');
const { Worker } = require('worker_threads');

// Test that 'exit' is emitted if 'beforeExit' throws, both inside the Worker.

const workerData = new Uint8Array(new SharedArrayBuffer(2));
const w = new Worker(`
  const { workerData } = require('worker_threads');
  process.on('exit', () => {
    workerData[0] = 100;
  });
  process.on('beforeExit', () => {
    workerData[1] = 200;
    throw new Error('banana');
  });
`, { eval: true, workerData });

w.on('error', common.mustCall((err) => {
  assert.strictEqual(err.message, 'banana');
}));

w.on('exit', common.mustCall((code) => {
  assert.strictEqual(code, 1);
  assert.strictEqual(workerData[0], 100);
  assert.strictEqual(workerData[1], 200);
}));

// e34 runner only: explicit exit so the browser runner's sentinel fires.
setTimeout(() => process.exit(0), 3000);
