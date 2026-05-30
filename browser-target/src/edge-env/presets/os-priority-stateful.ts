// os-priority-stateful preset.
//
// Replaces internalBinding('os').{setPriority, getPriority} with JS
// implementations that keep priority state in a Map (the underlying
// uv_os_setpriority/uv_os_getpriority stubs in our WASI build are
// no-ops, breaking the documented set/get round-trip).
//
// Pre-patched on the `os` module so the wrapper is installed BEFORE
// lib/os.js destructures the binding at its top-level imports.
//
// See `os-priority-stateful.patch.js` for the full rationale + uv error
// ctx shape.

import type { Preset } from "../types";
import osPriorityPatchSrc from "./os-priority-stateful/os-priority-stateful.patch.js?raw";

export const osPriorityStateful: Preset = {
  name: "os-priority-stateful",
  description:
    "JS replacement for internalBinding('os').{setPriority, getPriority} " +
    "that stores priority per pid.  Fixes test-os-process-priority and " +
    "any user code that relies on set/get priority round-tripping.",
  patch: {
    // Pre-patch on lib/os.js — its top-of-file destructure captures
    // _setPriority / _getPriority, so the binding swap MUST land before
    // the module body runs.  Pre patches run inside the wrapper function
    // body at the very top, ahead of the destructure.
    os: { pre: osPriorityPatchSrc },
  },
};
