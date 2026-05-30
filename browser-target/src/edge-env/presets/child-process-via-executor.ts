// child-process-via-executor preset.
//
// THE PROBLEM
//
// Node's `spawnSync` lands in edge's C++ `SpawnSync` binding which uses
// `uv_spawn` + `uv_run` to block waiting for the child. In browser-target
// `uv_run` ultimately calls a Suspending `poll_oneoff` wasm import. JSPI v2
// forbids suspending when there are JS frames between the promising entry
// (`_start`) and the Suspending import -- and the napi callback boundary IS
// a JS frame. So any sync wait-for-child from a JS-initiated `spawnSync`
// throws `SuspendError`.
//
// THE FIX
//
// Intercept `internalBinding('spawn_sync').spawn` with a JS implementation
// that calls a user-pluggable executor instead of going into C++ + libuv.
// The executor returns a synthetic process result; we shape it into what
// Node's `lib/internal/child_process.js` expects.
//
// MVP SCOPE
//
// - Executor interface is **synchronous**. Returns `{ output, exit }`
//   directly. Async support (real-thread executors, SAB + Atomics.wait
//   bridging) is a future extension; the interface accepts a sync return
//   today and can grow to also accept Promise<> later.
// - Default executor echoes the command name + args back as stdout (so
//   `spawnSync('echo', ['hi'])` returns `"echo hi\n"`). Enough to prove
//   the intercept works end-to-end.
// - Users plug in their own executor by setting
//   `globalThis.__edgeChildProcessExecutor` BEFORE the policy boots
//   (i.e. before edgejs.wasm runs the user script). Example use case:
//   a fake bash that interprets argv as shell commands and produces
//   string output.
//
// USER INTERFACE
//
//   type EdgeChildProcessSpawn = (
//     command: string,
//     args: string[],
//     options: {
//       env?: Record<string, string>;
//       cwd?: string;
//       input?: Uint8Array | string;
//       timeout?: number;
//     }
//   ) => EdgeChildProcessSyncResult;
//
//   interface EdgeChildProcessSyncResult {
//     stdout: Uint8Array | string;
//     stderr: Uint8Array | string;
//     code: number | null;       // null on signal exit
//     signal?: string | null;
//     error?: { code: string; message: string } | null;
//   }
//
// ARCHITECTURE (P3.5+)
//
// Two patch sites on `internal/child_process`:
//
//   1. PRE_PATCH installs four binding shims BEFORE lib's body runs:
//      - `spawn_sync.spawn`: sync executor (JSPI-safe; the rest of
//        this file)
//      - `stream_wrap`: streamBaseState typed array + indices +
//        WriteWrap class (required by stream_base_commons.js)
//      - `pipe_wrap.Pipe` + `.constants`: our EdgePipe class satisfies
//        net.Socket({handle, ...}) AND setupChannel(ipcPipe) (json mode)
//      - `process_wrap.Process`: our EdgeProcess class is what lib's
//        ChildProcess wraps. lib does ALL the user-facing surface
//        (.ref/.unref, .spawnfile, .spawnargs, .stdio[], setupChannel
//        for IPC, getValidStdio for stdio normalization, ...).
//
//   2. INTERNAL_POST_PATCH wraps spawnSync so our __edgeError marker
//      becomes a proper Error with the right code (sidesteps the
//      build-specific libuv error-number mapping).
//
// What lib drives natively (we removed our wholesale spawn/exec/execFile/
// fork override; lib's exports work because the bindings underneath are
// our shims):
//   - ref() / unref(): lib delegates to handle.ref()/unref()
//   - shell:true wrapping in /bin/sh -c (lib's normalizeSpawnArguments)
//   - argv0, detached, uid, gid (lib reads them; we accept silently)
//   - spawnfile / spawnargs (lib sets on ChildProcess)
//   - child.stdio[] composite array (lib builds it)
//   - stdio[3+] extra pipes (lib's getValidStdio creates per-fd Pipes;
//     each is bound by EdgeProcess.spawn and routes through our
//     OP_SPAWN_STDIO_WRITE / kind=7 events)
//   - stdio[N] as Stream / fd-number (lib's getValidStdio handles the
//     wrap/fd types)
//   - IPC channel (lib's setupChannel handles framing + serialization;
//     we just transport bytes through Pipe.writeUtf8String + onread)
//   - cp.fork() (lib's native fork → cp.spawn → ChildProcess → us)
//
// REMAINING DEBT
//
// - `#!~debt child-process-ipc-sendhandle`: sendHandle (passing fds/
//   sockets/servers via .send) is silently dropped. Real Node uses
//   kernel fd-passing; we have no equivalent. cluster.js needs this.
// - `#!~debt child-process-kill-cooperation`: kill() fires an
//   AbortSignal that the executor must poll. Real Node interrupts the
//   syscall the child is in -- impossible without a real OS process.
//
// IPC serialization (P3.9): 'json' (default) uses byte-stream RPC with
// JSON.stringify. 'advanced' uses a MessageChannel between wasm-runtime
// and host workers -- child.send / opts.ipc.send route through the
// port and the browser's native postMessage handles structured-clone
// for FREE (Map/Set/Date/ArrayBuffer/BigInt/circular refs all preserved).
//
// HOW TO TEST
//
// Set the executor on globalThis from your deployment code or test
// harness, then opt in via `?policies=child-process-via-executor`.
// See `tests/js/child-process-spawn-echo.js` for the default-executor
// smoke test.

import type { Preset } from "../types";
import { ASYNC_EVENT_KIND_PRELUDE } from "../../host-worker/rpc-protocol";

// Runtime patches live in sidecar .runtime.js files (P3 audit #7).
// Plain JS so they get syntax highlighting, typechecking-aware-by-tools,
// and linter coverage. Vite's `?raw` query returns the file contents as
// a string at bundle time.
//
// #!~debt cross-folder import — runtime files currently live under the
// legacy src/policies/child-process-via-executor/ folder.  When the
// migration finishes and src/policies/ is deleted, move the folder
// alongside this preset and update these paths.
import spawnSyncInterceptSrc from "../../policies/child-process-via-executor/spawn-sync-intercept.runtime.js?raw";
import bindingsShimSrc from "../../policies/child-process-via-executor/bindings-shim.runtime.js?raw";
import internalPostPatchSrc from "../../policies/child-process-via-executor/internal-post-patch.runtime.js?raw";
import serdesShimSrc from "../../policies/child-process-via-executor/serdes-shim.runtime.js?raw";

// serdes shim runs first so v8.js's `class DefaultSerializer extends
// Serializer` destructure succeeds regardless of which module triggers
// the pre-patch path.  Idempotent (no-ops if Serializer already exists).
const PRE_PATCH =
  serdesShimSrc +
  "\n" +
  spawnSyncInterceptSrc +
  "\n" +
  // bindings-shim has a sentinel that we replace with the runtime EK
  // declaration (so the IIFE can use `EK.STDOUT` etc. instead of magic ints).
  bindingsShimSrc.replace(
    "/* __EDGE_EVENT_KIND_PRELUDE__ */",
    ASYNC_EVENT_KIND_PRELUDE,
  );

const INTERNAL_POST_PATCH = internalPostPatchSrc;

export const childProcessViaExecutor: Preset = {
  name: "child-process-via-executor",
  description:
    "Intercepts the spawn_sync, process_wrap, pipe_wrap, and stream_wrap " +
    "bindings so lib's native ChildProcess / setupChannel / getValidStdio " +
    "drive the surface (ref/unref, spawnfile, child.stdio[], IPC, " +
    "shell:true, argv0, ...) while a user-pluggable executor handles the " +
    "actual work. Avoids the JSPI SuspendError from native spawn_sync's " +
    "uv_run loop.",
  patch: {
    "internal/child_process": { pre: PRE_PATCH, post: INTERNAL_POST_PATCH },
    // Also pre-patch v8 so direct `require('v8')` callers get the
    // structured-clone serializer without needing child_process to load
    // first.  Same idempotent shim, applied just-in-time.
    v8: { pre: serdesShimSrc },
  },
};
