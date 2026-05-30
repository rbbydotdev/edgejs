// v8-serdes-shim: install V8-wire-format Serializer / Deserializer onto
// internalBinding('serdes') as a pre-patch on lib/v8.js.
//
// Without this, lib/v8.js's
//   const { Serializer, Deserializer } = internalBinding('serdes');
//   Serializer.prototype._getDataCloneError = Error;
// throws TypeError because our C++ binding returns an empty object.
// Any code that does `require('node:test')` or `require('v8')`
// (directly or transitively) hits the failure before we get to do
// anything useful.
//
// The shim implementation lives at
// `child-process-via-executor/serdes-shim.runtime.js` and is
// idempotent — safe to load standalone OR alongside
// `child-process-via-executor` (which also installs it for its own
// IPC needs).  Default-on so the cost is paid once at lib boot
// before any node:test / node:v8 chain breaks.
//
// Wire format matches V8's ValueSerializer exactly (kVersion=15),
// so bytes are interchangeable with Node's `v8.serialize()`.

import type { Policy } from "./index";
import serdesShimSrc from "./child-process-via-executor/serdes-shim.runtime.js?raw";

export const v8SerdesShim: Policy = {
  name: "v8-serdes-shim",
  description:
    "Pre-patch lib/v8.js with the V8-wire-format Serializer/Deserializer installer. Required so `require('node:test')`, `require('v8')`, etc. don't crash at module load on the empty C++ binding.",
  builtinOverrides: {
    v8: { pre: serdesShimSrc, post: "" },
  },
};
