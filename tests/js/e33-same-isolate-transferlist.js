// Item 6: verify the existing C++ binding handles same-isolate
// transferList correctly when both ports are in the SAME wasm
// isolate.  No cross-worker hop; pure C++ binding territory.
//
// Scenario: two channels A and B in the same isolate.  Transfer
// B.port1 through A.port1's postMessage with [B.port1] as
// transferList.  A.port2 should receive { port: <B.port1 instance> }.
// The transferred port should be usable to communicate with B.port2.
const { MessageChannel } = require('worker_threads');

function ok(label, cond) { console.log(label + ':' + (cond ? 'PASS' : 'FAIL')); }

const A = new MessageChannel();
const B = new MessageChannel();

let aReceivedPort = null;
let bReceivedReply = null;

A.port2.on('message', (msg) => {
  // msg should contain the transferred B.port1 (as a MessagePort)
  aReceivedPort = msg && msg.transferred;
  if (aReceivedPort && typeof aReceivedPort.postMessage === 'function') {
    // Use it to talk to B.port2
    aReceivedPort.postMessage('hello-via-transferred-port');
  } else {
    finish();
  }
});

B.port2.on('message', (msg) => {
  bReceivedReply = msg;
  finish();
});

function finish() {
  ok('A_received_port_object', aReceivedPort && typeof aReceivedPort === 'object');
  ok('A_received_port_has_postMessage', aReceivedPort && typeof aReceivedPort.postMessage === 'function');
  ok('B_received_via_transferred', bReceivedReply === 'hello-via-transferred-port');
  A.port1.close();
  A.port2.close();
  // B.port1 was transferred — closing the received side
  if (aReceivedPort && typeof aReceivedPort.close === 'function') {
    try { aReceivedPort.close(); } catch (e) { void e; }
  }
  B.port2.close();
  process.exit(0);
}

// Kick off: send the transferred port from A.port1 to A.port2
A.port1.postMessage({ greeting: 'here-is-a-port', transferred: B.port1 }, [B.port1]);

setTimeout(() => {
  console.log('TIMEOUT a=' + !!aReceivedPort + ' b=' + JSON.stringify(bReceivedReply));
  process.exit(2);
}, 3000);
