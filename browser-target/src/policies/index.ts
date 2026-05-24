// Policy framework — deployment-time strategies for behaviors that can't be
// matched 1:1 with Node in a browser environment.
//
// The default stance is **Node-honest**: when a real Node behavior can't be
// reproduced (raw TCP, FS persistence, ...) the corresponding API throws a
// clear, codeable error.  Deployments opt into "shortcut" policies (e.g.
// fetch-tunnels for outbound HTTP, OPFS for persistence) explicitly.
//
// COMPOSITION
//
// Multiple policies compose into a single bundle.  Order matters: the array
// is processed front-to-back and later policies override earlier ones on
// conflict (last-wins).  This matches the way most layered systems work
// (CSS cascade, middleware chains, ...) and lets a deployment add a
// shortcut by appending to the default list.
//
// EXAMPLE
//
//   const { builtinOverrides, userScriptPrelude } = composePolicies([
//     ...defaultBrowserPolicies,        // SW-bridged inbound HTTPS, throws on outbound
//     myOutboundFetchTunnelPolicy,      // overrides outbound-throw with a real polyfill
//   ]);
//   createNapiHost({ memory, builtinOverrides });
//   // ...prepend `userScriptPrelude` to user `-e` scripts.
//
// SURFACES THE FRAMEWORK CURRENTLY EXPOSES
//
// - `builtinOverrides` — replaces compiled-in module source by id.  Plumbed
//   through `NapiHostOptions.builtinOverrides` → caught at both
//   `unofficial_napi_contextify_compile_function` (bootstrap modules) and
//   the `napi_run_script` wrapper (lazy-required builtins).
// - `userScriptPrelude` — JS source concatenated in front of the user's
//   `-e` script.  Used for runtime monkey-patches that can't be expressed
//   as a source override (e.g. patching `http.request` after `http` loads).
//
// Future surfaces (when needs surface): `napiOverrides`, `wasiHandlers`,
// `fsAdapters`, etc.  Add fields to `Policy` + the compose function.

/**
 * A built-in module override.  Four shapes:
 *
 * - `string` → replace the module body entirely with this source.
 * - `null` → stub with `module.exports = {}`.
 * - `{ post: string }` → keep edge's bundled body, APPEND `post` after it
 *   (inside the same function wrapper).  The post code sees all the
 *   module's locals + `module.exports` and can patch them surgically.
 * - `{ pre: string }` → PREPEND `pre` before edge's bundled body.  Use
 *   when the module's body freezes/snapshots state and the patch must
 *   run before that (e.g. `per_context/primordials.js` snapshots
 *   `ArrayBuffer.prototype.byteLength` then freezes — patching it after
 *   the freeze can't reach it; patching before reaches the snapshot).
 * - `{ pre, post }` → both, in that order.
 *
 * `pre` and `post` are the right shapes when you want to fix one piece of
 * a module without re-pasting hundreds of lines of vendored code.
 */
export type ModuleOverride =
  | string
  | null
  | { pre?: string; post?: string };

export interface Policy {
  /** Short identifier — used in logs and `--policies` CLI. */
  name: string;
  /** Human-readable, one-line summary of what this policy does. */
  description: string;
  /** Replacements / surgical patches for compiled-in module sources,
   *  keyed by `node:<id>` or `<id>`. */
  builtinOverrides?: Record<string, ModuleOverride>;
  /** JS source concatenated in front of every user `-e` script. */
  userScriptPrelude?: string;
}

export interface ComposedPolicies {
  builtinOverrides: Record<string, ModuleOverride>;
  userScriptPrelude: string;
  /** The policy names, in application order — useful for diagnostics. */
  applied: string[];
}

export function composePolicies(policies: Policy[]): ComposedPolicies {
  const builtinOverrides: Record<string, ModuleOverride> = {};
  const preludeParts: string[] = [];
  const applied: string[] = [];
  for (const p of policies) {
    applied.push(p.name);
    if (p.builtinOverrides) {
      for (const [k, v] of Object.entries(p.builtinOverrides)) {
        // Last-wins on conflict, EXCEPT when both shapes are pre/post
        // patches — then we concatenate so two policies can each contribute
        // a patch to the same module without stomping each other.  `pre`s
        // and `post`s compose in declaration order.
        const prev = builtinOverrides[k];
        if (isPatchOverride(prev) && isPatchOverride(v)) {
          builtinOverrides[k] = {
            pre: (prev.pre ?? "") + (v.pre ? "\n" + v.pre : ""),
            post: (prev.post ?? "") + (v.post ? "\n" + v.post : ""),
          };
        } else {
          builtinOverrides[k] = v;
        }
      }
    }
    if (p.userScriptPrelude) preludeParts.push(p.userScriptPrelude);
  }
  return { builtinOverrides, userScriptPrelude: preludeParts.join(""), applied };
}

function isPatchOverride(v: ModuleOverride | undefined): v is { pre?: string; post?: string } {
  return (
    typeof v === "object" && v !== null &&
    (typeof (v as { post?: unknown }).post === "string" || typeof (v as { pre?: unknown }).pre === "string")
  );
}

export { bufferPoolDisable } from "./buffer-pool-disable";
export { bufferWriteSync } from "./buffer-write-sync";
export { bufferWasmAliased } from "./buffer-wasm-aliased";
export { taskQueueEnqueueFix } from "./task-queue-enqueue-fix";
export { cryptoHostRandom } from "./crypto-host-random";
export { cryptoViaSubtle } from "./crypto-via-subtle";
export { compressionViaCompressionStream } from "./compression-via-compressionstream";
export { wasmCompileViaHost } from "./wasm-compile-via-host";
export { zlibWriteStateWasm } from "./zlib-writestate-wasm";
export { inboundHttpsViaSW } from "./inbound-https-via-sw";
export { outboundThrow } from "./outbound-throw";
export { outboundFetchTunnel } from "./outbound-fetch-tunnel";
export { fastReadFile } from "./fast-readfile";

import { bufferPoolDisable } from "./buffer-pool-disable";
import { bufferWriteSync } from "./buffer-write-sync";
import { bufferWasmAliased } from "./buffer-wasm-aliased";
import { taskQueueEnqueueFix } from "./task-queue-enqueue-fix";
import { cryptoHostRandom } from "./crypto-host-random";
import { cryptoViaSubtle } from "./crypto-via-subtle";
import { compressionViaCompressionStream } from "./compression-via-compressionstream";
import { wasmCompileViaHost } from "./wasm-compile-via-host";
import { zlibWriteStateWasm } from "./zlib-writestate-wasm";
import { inboundHttpsViaSW } from "./inbound-https-via-sw";
import { outboundThrow } from "./outbound-throw";
import { outboundFetchTunnel } from "./outbound-fetch-tunnel";
import { fastReadFile } from "./fast-readfile";

// =============================================================================
// SANE DEFAULTS
// =============================================================================
//
// Two named bundles — pick the one that matches your deployment shape, or
// compose your own array.  The two are intentionally separate (rather than
// one bundle with flags) so each is grep-able and a deployment can fork via
// `.filter(...)` / `.concat(...)` without reaching into a flags object.
//
// `minimalPolicies` — what you need for edge.js to behave correctly AT ALL,
//   regardless of host environment.  Currently just `bufferPoolDisable`
//   because edge's Buffer pool slicing diverges from our wasm-backed
//   ArrayBuffer model and breaks crypto if pooling isn't disabled.  This
//   is the node-harness default — it gives the rawest testable plumbing.
//
// `defaultBrowserPolicies` — minimal + the policies that reflect browser
//   constraints (no real TCP, SW terminates TLS).  This is the worker.ts
//   default — what end-user browser deployments get out of the box.
//
// Both expand as new constraints surface.  E.g. when OPFS persistence
// lands, the browser default will also include `opfsPersistence`; the
// minimal bundle stays alone.

/**
 * The smallest set of policies required for edge.js to behave correctly,
 * irrespective of host environment.  If you're going to apply ANY
 * policies, start here.
 */
export const minimalPolicies: Policy[] = [
  bufferPoolDisable,
  bufferWasmAliased,
  zlibWriteStateWasm,
];

/**
 * Recommended baseline for browser deployments.  Each entry is a separate
 * policy so callers can drop one (`defaultBrowserPolicies.filter(...)`)
 * or append more (e.g. an opt-in fetch-tunnel) without forking.
 *
 * Why each is here:
 * - bufferPoolDisable: see `minimalPolicies` — required for crypto.
 * - inboundHttpsViaSW: the SW IS the TLS endpoint to the browser, so wasm
 *   never sees encrypted bytes.  https.createServer delegates to http.
 * - outboundThrow: Node-honest default.  http.request/https.request throw
 *   ERR_BROWSER_NO_OUTBOUND rather than silently misbehaving.
 */
export const defaultBrowserPolicies: Policy[] = [
  bufferPoolDisable,
  bufferWasmAliased,
  zlibWriteStateWasm,
  inboundHttpsViaSW,
  outboundThrow,
];

/**
 * Name-keyed registry of every Policy this module exports.  Used by the
 * Node harness's `--policies a,b,c` flag and any tooling that needs to
 * resolve a policy by string name.  KEEP IN SYNC with the named exports
 * above when you add a Policy — the export itself doesn't auto-register
 * because TS module-shape introspection isn't ergonomic at runtime.
 */
export const policyRegistry: Record<string, Policy> = {
  [bufferPoolDisable.name]: bufferPoolDisable,
  [bufferWriteSync.name]: bufferWriteSync,
  [bufferWasmAliased.name]: bufferWasmAliased,
  [taskQueueEnqueueFix.name]: taskQueueEnqueueFix,
  [cryptoHostRandom.name]: cryptoHostRandom,
  [cryptoViaSubtle.name]: cryptoViaSubtle,
  [compressionViaCompressionStream.name]: compressionViaCompressionStream,
  [wasmCompileViaHost.name]: wasmCompileViaHost,
  [zlibWriteStateWasm.name]: zlibWriteStateWasm,
  [inboundHttpsViaSW.name]: inboundHttpsViaSW,
  [outboundThrow.name]: outboundThrow,
  [outboundFetchTunnel.name]: outboundFetchTunnel,
  [fastReadFile.name]: fastReadFile,
};
