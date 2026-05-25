// e34 task #13: cycle detection in marshal walker.
//
// Pre-fix: a value with a circular reference passed through
// MessagePort.postMessage triggered a stack overflow in
// PrepareTransferableDataForStructuredClone's recursive walker
// (binding_messaging.cc) — the helper had no seen-set.
//
// Post-fix: walker threads an unordered_map<napi_value, napi_value>
// that lets revisited nodes resolve to the previously-allocated clone,
// matching HTML structured-clone semantics (cycles preserved as
// identity-shared in the output).
const { MessageChannel } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

const ch = new MessageChannel();
let received = null;
let messageError = null;
ch.port2.on('message', (m) => { received = m; });
ch.port2.on('messageerror', (e) => { messageError = e; });

// Self-cycle: object that references itself
const cyclic = { name: 'root', children: [] };
cyclic.self = cyclic;
cyclic.children.push(cyclic);

// Send — should NOT throw a stack overflow.
let postThrew = null;
try {
  ch.port1.postMessage(cyclic);
} catch (e) {
  postThrew = e;
}

setTimeout(() => {
  ok('post_did_not_throw', postThrew === null);
  ok('no_message_error', messageError === null);
  ok('received_object', received !== null && typeof received === 'object');
  ok('received_name', received && received.name === 'root');
  ok('received_self_is_self', received && received.self === received);
  ok('received_child_is_self', received && Array.isArray(received.children)
    && received.children[0] === received);
  ch.port2.close();
  process.exit(0);
}, 500);
