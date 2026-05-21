// Regression: Buffer.from(string) + direct indexed access.
//
// Bug surfaced 2026-05-21: emnapi's `napi_create_external_arraybuffer`
// model (default) splits storage between JS-heap AB and wasm memory.  C++
// string encoders (utf8WriteStatic) wrote to the wasm side; JS-side AB
// stayed stale.  `buf[0]` immediately after construction read zeros.
//
// Fixed by `buffer-wasm-aliased` policy (minimalPolicies) which makes the
// JS-side AB literally BE wasm memory: `buf.buffer === wasmMemory.buffer`
// and `buf.byteOffset === wasm_ptr`.  No JS/wasm split → no sync needed.
//
// This test asserts indexed access works for small (≤64 fast path),
// boundary, and large sizes — all would have failed without the policy.
// Also asserts the structural property (buf.buffer is the wasm SAB).

const a = Buffer.from('hello', 'utf8');
const b = Buffer.from('a'.repeat(64), 'utf8');
const c = Buffer.from('z'.repeat(200), 'utf8');

// Direct indexed access — no napi-going op in between
const a0 = a[0]; const a4 = a[4];
const b0 = b[0]; const b63 = b[63];
const c0 = c[0]; const c199 = c[199];

const bytesOk = (
  a0 === 104 && a4 === 111 &&  // 'h', 'o'
  b0 === 97 && b63 === 97 &&   // 'a', 'a'
  c0 === 122 && c199 === 122   // 'z', 'z'
);

// Structural assertion — buf.buffer should be the wasm SAB (multi-MB),
// not a per-buffer JS-heap AB of size N.  Both small and large buffers
// share the same underlying storage.
const structuralOk = (
  typeof SharedArrayBuffer !== 'undefined' &&
  a.buffer instanceof SharedArrayBuffer &&
  a.buffer === b.buffer &&
  a.buffer === c.buffer &&
  a.buffer.byteLength > 1_000_000 &&
  a.byteOffset !== b.byteOffset &&
  a.length === 5 && b.length === 64 && c.length === 200
);

if (bytesOk && structuralOk) {
  console.log('buffer-from-string-ok');
} else {
  console.log('buffer-from-string-bad: bytes=' + bytesOk + ' struct=' + structuralOk
    + ' a0=' + a0 + ' a4=' + a4 + ' b0=' + b0 + ' b63=' + b63 + ' c0=' + c0 + ' c199=' + c199);
}
