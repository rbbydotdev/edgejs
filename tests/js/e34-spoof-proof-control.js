// e34: spoof-proof control envelope verification.
//
// Pre-e34, control discriminators (__edgePortMsg, __edgeWorkerTerminate,
// __edgeWorkerError) were detected by the in-band user-message
// dispatcher.  User code could spoof termination/error/port-message
// behavior by sending a value with the right property name.
//
// Post-e34, control envelopes ride a dedicated kind byte at the
// worker.ts bus layer (KIND_USER_DATA=0x00 vs KIND_PORT_MSG=0x01 vs
// KIND_TERMINATE=0x02 vs KIND_WORKER_ERROR=0x03).  User data is always
// kind=0x00, so user payloads cannot reach the control path.
//
// This test sends a user value containing every reserved property name
// and asserts the message arrives intact on the user 'message' channel
// — NOT interpreted as control.
const { Worker } = require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }

let receivedMessage = null;
let receivedError = null;
let receivedExit = null;

// Child relies on the policy's parentPort.on('message') keepalive —
// fix #19 (task #19) switched the keepalive to setInterval-based
// uv_timer_t so registering a message listener now reliably holds the
// loop open per Node spec.  No manual setInterval needed.
const childCode = `
  var wt = require('worker_threads');
  wt.parentPort.on('message', function(m) {
    // Echo the message right back so the parent can confirm the value
    // round-tripped intact AND that the child did NOT terminate
    // (which would happen if __edgeWorkerTerminate was misinterpreted).
    wt.parentPort.postMessage({ echoed: m, alive: true });
    // Remove listener so the loop can drain naturally.
    wt.parentPort.removeAllListeners('message');
  });
`;

const w = new Worker(childCode, { eval: true });
w.on('message', (m) => { receivedMessage = m; });
w.on('error', (e) => { receivedError = e; });
w.on('exit', (code) => { receivedExit = code; });

// Spoof attempt: send a value with every reserved key the old in-band
// envelope used.  None of these should be interpreted as control.
const spoofPayload = {
  __edgePortMsg: true,
  __edgeWorkerTerminate: true,
  __edgeWorkerError: true,
  targetPortId: 999999,
  payload: 'attacker-controlled',
  error: { name: 'Spoof', message: 'should-never-fire', stack: 'fake' },
};

setTimeout(() => {
  w.postMessage(spoofPayload);
}, 200);

setTimeout(() => {
  // Child SHOULD have echoed back (proving spoof didn't terminate it).
  // After echoing, the child cleared its keepalive and the loop drains
  // naturally — so receivedExit will be 0 by this point.  That's fine:
  // the spoof would have produced exit=1 (terminate) or 'error' fired
  // (worker-error), and neither happened.
  ok('message_round_tripped', receivedMessage !== null);
  ok('echo_alive_flag', receivedMessage && receivedMessage.echoed
    && receivedMessage.alive === true);
  ok('echoed_has_all_keys', receivedMessage && receivedMessage.echoed
    && receivedMessage.echoed.__edgePortMsg === true
    && receivedMessage.echoed.__edgeWorkerTerminate === true
    && receivedMessage.echoed.__edgeWorkerError === true
    && receivedMessage.echoed.payload === 'attacker-controlled');
  ok('no_error_fired', receivedError === null);
  ok('child_did_not_terminate', receivedExit !== 1);
  process.exit(0);
}, 1500);
