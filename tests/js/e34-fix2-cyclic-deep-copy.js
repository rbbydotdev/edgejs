// e34 fix #2: cyclic objects sent through in-process MessageChannel
// must produce an INDEPENDENT copy on the receiver (Node-spec
// structured clone — mutations on one side stay invisible to the
// other).  Pre-fix: receiver got the same reference (deepCycleClone
// fallback was missing; we silently fell back to the original).
const { MessageChannel } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

const ch = new MessageChannel();
let received = null;
ch.port2.on('message', (m) => { received = m; });

const source = { tag: 'A', payload: { count: 1 } };
source.self = source;

ch.port1.postMessage(source);

setTimeout(() => {
  ok('received_truthy', received !== null && typeof received === 'object');
  ok('received_not_same_ref_as_source', received !== source);
  ok('received_payload_not_same_ref', received && received.payload !== source.payload);
  ok('received_self_cycle_preserved', received && received.self === received);
  ok('received_tag_copied', received && received.tag === 'A');
  ok('received_payload_count', received && received.payload && received.payload.count === 1);
  // Spec-strict mutation isolation: changing receiver MUST NOT affect source.
  if (received) {
    received.tag = 'mutated';
    received.payload.count = 999;
  }
  ok('source_tag_unaffected', source.tag === 'A');
  ok('source_payload_unaffected', source.payload.count === 1);
  ch.port2.close();
  process.exit(0);
}, 500);
