// Sets up Node-style globals that emnapi expects to find at module-load time.
//
// Specifically: `globalThis.Buffer`.  emnapi's runtime captures
// `_Buffer = typeof Buffer === 'function' ? Buffer : require('buffer').Buffer`
// at module evaluation.  In a browser worker context, neither path resolves,
// so `napi_create_buffer_copy` and friends throw `NotSupportBufferError`.
//
// This file MUST be imported BEFORE `@emnapi/*` to ensure the capture sees
// our shim.  In `worker.ts` and `napi-host/index.ts` we list it as the first
// import.
//
// Implementation: vendored `buffer` (npm), the canonical Node Buffer polyfill.
// MIT licensed, ~6KB minified.  Per project rule: vendored deps sit behind a
// single project-owned facade — this file is that facade.  Downstream code
// must NOT `import 'buffer'` directly.

import { Buffer as BufferPolyfill } from "buffer";

if (typeof (globalThis as { Buffer?: unknown }).Buffer !== "function") {
  (globalThis as { Buffer: unknown }).Buffer = BufferPolyfill;
}
