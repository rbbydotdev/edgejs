// e33 step 1: same-isolate roundtrip of MARSHAL_TAG_PORT_REF.
//
// Verifies the marshal layer's new transferList plumbing:
// - packPostMessage(value, [port], assignId) walks the value tree, emits
//   MARSHAL_TAG_PORT_REF for objects matched by assignId.
// - unpackPostMessage(bytes, decodePort) materializes a stub via the
//   factory when it encounters MARSHAL_TAG_PORT_REF.
//
// This is a UNIT test of the marshal layer — no cross-worker delivery,
// no main-thread routing, no MessageChannel C++ binding involvement.
// Subsequent e33 steps wire this into Worker.prototype.postMessage and
// add the main-thread port routing.

const { MessageChannel } = require('worker_threads');

const pack = globalThis.__edgePackPostMessage;
const unpack = globalThis.__edgeUnpackPostMessage;

if (typeof pack !== 'function' || typeof unpack !== 'function') {
  console.log('FAIL: marshal globals not installed');
  process.exit(1);
}

function check(label, ok) {
  console.log(`${label}:${ok ? 'PASS' : 'FAIL'}`);
}

const ch = new MessageChannel();
const port1 = ch.port1;
const port2 = ch.port2;

const value = {
  greeting: 'hello',
  port: port1,
  nested: { otherPort: port2, scalar: 42 },
  list: [1, 'two', port1],
};

// Allocator: hand out fresh IDs per object.  Use a Map so we get the
// SAME id when the same port appears twice in the value tree (per
// transferList spec).
const portIds = new Map();
let nextId = 100;
const assignId = (obj) => {
  if (portIds.has(obj)) return portIds.get(obj);
  const id = nextId++;
  portIds.set(obj, id);
  return id;
};

let bytes;
try {
  bytes = pack(value, [port1, port2], assignId);
  check('pack_returned', bytes instanceof Uint8Array && bytes.byteLength > 0);
} catch (e) {
  console.log('pack:THREW=' + e.message);
  process.exit(1);
}

// Factory: build a deterministic stub per ID so we can verify identity.
const decodePort = (id) => ({ __edgeStub: true, portId: id });

let recovered;
try {
  recovered = unpack(bytes, decodePort);
} catch (e) {
  console.log('unpack:THREW=' + e.message);
  process.exit(1);
}

check('top_is_object', recovered && typeof recovered === 'object');
check('greeting', recovered.greeting === 'hello');
check('top_port_is_stub', recovered.port && recovered.port.__edgeStub === true);
check('top_port_id_is_100', recovered.port && recovered.port.portId === 100);
check('nested_otherPort_is_stub', recovered.nested && recovered.nested.otherPort && recovered.nested.otherPort.__edgeStub === true);
check('nested_otherPort_id_is_101', recovered.nested && recovered.nested.otherPort && recovered.nested.otherPort.portId === 101);
check('nested_scalar', recovered.nested && recovered.nested.scalar === 42);
check('list_len', Array.isArray(recovered.list) && recovered.list.length === 3);
check('list_0', recovered.list[0] === 1);
check('list_1', recovered.list[1] === 'two');
check('list_2_is_stub_id_100', recovered.list[2] && recovered.list[2].__edgeStub === true && recovered.list[2].portId === 100);

ch.port1.close();
ch.port2.close();
process.exit(0);
