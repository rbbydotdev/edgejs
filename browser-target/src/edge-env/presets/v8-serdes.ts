// v8-serdes preset: pre-patch lib/v8.js with the V8-wire-format
// Serializer / Deserializer installer.
//
// WHY
//
// Without this, lib/v8.js's top-of-module destructure
//   const { Serializer, Deserializer } = internalBinding('serdes');
//   Serializer.prototype._getDataCloneError = Error;
// throws TypeError because our wasm-side `serdes` binding is empty.
// Any code path that does `require('node:test')` or `require('v8')`
// (directly or transitively — webpack's persistent cache does the latter)
// hits the failure at module-load time, before our code gets a chance
// to intercept.
//
// The shim implementation lives at
// `../../policies/child-process-via-executor/serdes-shim.runtime.js` (will
// move into this folder once child-process-via-executor is migrated too).
// It is idempotent — safe to load standalone OR alongside
// child-process-via-executor (which also installs it for its own IPC needs).
//
// Wire format matches V8's ValueSerializer exactly (kVersion=15), so bytes
// produced here are byte-for-byte interchangeable with Node's
// `v8.serialize()` output.

import type { Preset } from "../types";
// #!~debt cross-folder import — serdes-shim.runtime.js currently lives
// under policies/child-process-via-executor/ for historical reasons.  When
// child-process-via-executor migrates into edge-env, move the .runtime.js
// file alongside it (own folder) and update this import.
import serdesShimSrc from "../../policies/child-process-via-executor/serdes-shim.runtime.js?raw";

export const v8Serdes: Preset = {
  name: "v8-serdes",
  description:
    "Pre-patch lib/v8.js with V8-wire-format Serializer/Deserializer so " +
    "`require('node:test')`, `require('v8')`, webpack's persistent cache " +
    "and anything else that destructures from internalBinding('serdes') " +
    "doesn't crash at module load on the empty wasm binding.",
  patch: {
    v8: { pre: serdesShimSrc },
  },
};
