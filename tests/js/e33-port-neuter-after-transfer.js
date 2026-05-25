// Item 4 (e33): after a port is transferred (via the policy's
// __edgeAllocPortId), the sender's reference is neutered — subsequent
// postMessage / start throw, hasRef returns false, ref/unref/close
// are no-ops.  Internal routing (via the saved deliver closure)
// continues to work.
const { MessageChannel } = require('worker_threads');

function ok(label, cond) { console.log(label + ':' + (cond ? 'PASS' : 'FAIL')); }

if (typeof globalThis.__edgeAllocPortId !== 'function') {
  console.log('FAIL: __edgeAllocPortId not installed (is worker-threads-per-thread policy enabled?)');
  process.exit(1);
}

const ch = new MessageChannel();
const portBefore = ch.port1;
const beforePostMessage = portBefore.postMessage;

// Allocate ID — should neuter the port
const id = globalThis.__edgeAllocPortId(ch.port1);
ok('id_returned', typeof id === 'number' && id > 0);

// Verify the entry is { port, deliver }
const entry = globalThis.__edgePortsByGlobalId.get(id);
ok('entry_exists', entry != null);
ok('entry_has_port', entry && entry.port === ch.port1);
ok('entry_has_deliver_fn', entry && typeof entry.deliver === 'function');

// Identity preserved (same object reference)
ok('port_identity_preserved', portBefore === ch.port1);

// __edgeNeutered marker
ok('neutered_marker', ch.port1.__edgeNeutered === true);

// postMessage throws
let caughtPM = null;
try { ch.port1.postMessage('should-throw'); }
catch (e) { caughtPM = e; }
ok('postMessage_throws', caughtPM !== null);
ok('postMessage_msg_mentions_transferred', caughtPM && /transferred/.test(caughtPM.message));

// postMessage was actually swapped (not same function ref)
ok('postMessage_swapped', ch.port1.postMessage !== beforePostMessage);

// start: no-op (doesn't throw, returns undefined)
let caughtStart = null;
let startResult = undefined;
try { startResult = ch.port1.start(); }
catch (e) { caughtStart = e; }
ok('start_no_op', caughtStart === null && startResult === undefined);

// hasRef returns false
ok('hasRef_returns_false', ch.port1.hasRef() === false);

// ref/unref return the port (chainable), no-op semantically
ok('ref_returns_port', ch.port1.ref() === ch.port1);
ok('unref_returns_port', ch.port1.unref() === ch.port1);

// close: no-op
let caughtClose = null;
try { ch.port1.close(); }
catch (e) { caughtClose = e; }
ok('close_no_throw', caughtClose === null);

// Internal routing: deliver still works (calls saved original postMessage,
// which routes to the sibling — ch.port2 — via the C++ binding).
let receivedOnPort2 = null;
ch.port2.on('message', (m) => { receivedOnPort2 = m; });

entry.deliver('via-saved-deliver');

setTimeout(() => {
  ok('deliver_reached_sibling', receivedOnPort2 === 'via-saved-deliver');
  ch.port2.close();
  process.exit(0);
}, 300);
