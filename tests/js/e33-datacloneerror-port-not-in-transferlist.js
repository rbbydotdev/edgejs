// Item 5 (e33): MessagePort in value tree but not in transferList
// must throw DataCloneError synchronously on the sender side.
//
// Pre-fix: produced bytes that threw "marshal: identity reference
// collected" on the receiver — async, wrong name, useless message.
// Post-fix: throws DataCloneError synchronously with .name set.
const { MessageChannel } = require('worker_threads');

function ok(label, cond) { console.log(label + ':' + (cond ? 'PASS' : 'FAIL')); }

const pack = globalThis.__edgePackPostMessage;
if (typeof pack !== 'function') {
  console.log('FAIL: marshal global not installed');
  process.exit(1);
}

const ch = new MessageChannel();

// Case A: port directly as the value (no transferList).
let caughtA = null;
try {
  pack({ leakedPort: ch.port1 });
} catch (e) {
  caughtA = e;
}
ok('A_threw', caughtA !== null);
ok('A_name_is_DataCloneError', caughtA && caughtA.name === 'DataCloneError');
ok('A_message_mentions_transferList', caughtA && /transferList/.test(caughtA.message || ''));

// Case B: port nested deep in value tree.
let caughtB = null;
try {
  pack({ a: { b: { c: [1, 2, { hidden: ch.port2 }] } } });
} catch (e) {
  caughtB = e;
}
ok('B_threw', caughtB !== null);
ok('B_name_is_DataCloneError', caughtB && caughtB.name === 'DataCloneError');

// Case C: port that IS in transferList should NOT throw.
let caughtC = null;
let bytesC = null;
try {
  const id = 555;
  const assign = (obj) => (obj === ch.port1 ? id : null);
  bytesC = pack({ port: ch.port1 }, [ch.port1], assign);
} catch (e) {
  caughtC = e;
}
ok('C_did_not_throw', caughtC === null);
ok('C_bytes_returned', bytesC instanceof Uint8Array && bytesC.byteLength > 0);

ch.port1.close();
ch.port2.close();
process.exit(0);
