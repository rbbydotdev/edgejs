// E12: verifies the wasm-compile-via-host policy is in effect AND that
// compile()/instantiate() still work end-to-end through the host snapshot.
//
// The prelude swaps `WebAssembly.compile` (etc.) with thin wrappers that
// route to `globalThis.__edgeHostWebAssembly.<name>` and tag themselves
// with `__edgeViaHost = true` + `__edgeRoute = <name>`.  We verify:
//
// 1. The wrappers are in place (the routing actually applied).
// 2. compile() still returns a real WebAssembly.Module.
// 3. instantiate() against bytes still returns a usable Instance — a
//    tiny module exporting a `pi(): i32` function returning 314.
//
// Smallest module with an export: 30 bytes.
//   magic + version (8)
//   type section: () -> i32 (6)
//   function section: 1 fn of type 0 (3)
//   export section: "pi" → fn 0 (8)
//   code section: 1 fn body: i32.const 314, end (5+)
const bytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  // type section: 1 type, () -> i32
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
  // function section: 1 fn, type 0
  0x03, 0x02, 0x01, 0x00,
  // export section: 1 export, "pi" (name len 2, bytes 'p','i'), kind=0 (func), idx 0
  0x07, 0x06, 0x01, 0x02, 0x70, 0x69, 0x00, 0x00,
  // code section: 1 fn body, len 7, locals 0, i32.const 314 (LEB128: 0xba 0x02), end
  0x0a, 0x07, 0x01, 0x05, 0x00, 0x41, 0xba, 0x02, 0x0b,
]);

// Routing check.  The prelude tags wrappers with `__edgeViaHost` so tests
// can verify the policy actually installed without depending on perf or
// observable side effects.  If this is false the policy didn't apply.
const routed = (typeof WebAssembly.compile === 'function')
  && WebAssembly.compile.__edgeViaHost === true
  && WebAssembly.compile.__edgeRoute === 'compile';
console.log('routed:', routed);

WebAssembly.compile(bytes).then(function (mod) {
  console.log('compiled-mod:', mod instanceof WebAssembly.Module);
  return WebAssembly.instantiate(mod);
}).then(function (instance) {
  const pi = instance.exports.pi;
  const value = (typeof pi === 'function') ? pi() : -1;
  console.log('pi:', value);
  process.exit(0);
}).catch(function (e) {
  console.log('failed:', (e && e.message) || String(e));
  process.exit(1);
});
