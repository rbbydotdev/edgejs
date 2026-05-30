// worker-threads-per-thread preset.
//
// This is a thin shim that re-exports the legacy Policy via the
// policy-adapter — the legacy file's 5 large template literals
// (CONTROL_HELPERS_JS, KEEPALIVE_HELPER_JS, PRE_PATCH, POST_PATCH,
// WORKER_THREADS_POST_PATCH) total ~1200 LOC and extracting them into
// `.runtime.js` files is a separate cleanup pass.  The behavior under
// the new framework is identical because policy-adapter splits
// `builtinOverrides` into the same `alias`/`patch` categories the
// native presets use.
//
// See `../../policies/worker-threads-per-thread.ts` for the full design
// doc (phases 1-3, control envelope wire format, exit/message paths,
// IPC routing through host+main+host).
//
// #!~debt edge-env-migration-thin-shim
// Extract the 5 template literals into sibling `.runtime.js` files when
// touching this code substantively — same pattern as v8-serdes.ts.  The
// big block doc above moves into the new file.

import { policyToPreset } from "../policy-adapter";
import { workerThreadsPerThread as legacyWorkerThreadsPolicy } from "../../policies/worker-threads-per-thread";

export const workerThreadsPerThread = policyToPreset(legacyWorkerThreadsPolicy);
