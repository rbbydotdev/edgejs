// B / scope-op forwarding regression — exercise a hot napi-heavy loop
// to confirm the wasm-side wrappers around napi_open_handle_scope and
// napi_close_handle_scope don't break edge.js's normal crypto path.
//
// The actual "host scope size stays bounded" assertion runs in the
// dedicated probe (browser-target/scripts/probe-scope-bounded.mjs)
// because it requires direct OP_NAPI_DEBUG_HANDLE_STORE_SIZE access —
// not something user JS can do.  This test is the integration-side
// counterpart that catches gross wiring regressions from the wrapping.
const c = require('crypto');
for (let i = 0; i < 200; i++) {
  c.createHash('sha256').update('x' + i).digest('hex');
}
console.log('scope-forwarding-bounded-ok');
