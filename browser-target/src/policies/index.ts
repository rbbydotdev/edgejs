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

export interface Policy {
  /** Short identifier — used in logs and `--policies` CLI. */
  name: string;
  /** Human-readable, one-line summary of what this policy does. */
  description: string;
  /** Replacements for compiled-in module sources, keyed by `node:<id>` or `<id>`. */
  builtinOverrides?: Record<string, string | null>;
  /** JS source concatenated in front of every user `-e` script. */
  userScriptPrelude?: string;
}

export interface ComposedPolicies {
  builtinOverrides: Record<string, string | null>;
  userScriptPrelude: string;
  /** The policy names, in application order — useful for diagnostics. */
  applied: string[];
}

export function composePolicies(policies: Policy[]): ComposedPolicies {
  const builtinOverrides: Record<string, string | null> = {};
  const preludeParts: string[] = [];
  const applied: string[] = [];
  for (const p of policies) {
    applied.push(p.name);
    if (p.builtinOverrides) {
      for (const [k, v] of Object.entries(p.builtinOverrides)) {
        builtinOverrides[k] = v;
      }
    }
    if (p.userScriptPrelude) preludeParts.push(p.userScriptPrelude);
  }
  return { builtinOverrides, userScriptPrelude: preludeParts.join(""), applied };
}

export { bufferPoolDisable } from "./buffer-pool-disable";
export { inboundHttpsViaSW } from "./inbound-https-via-sw";
export { outboundThrow } from "./outbound-throw";
export { outboundFetchTunnel } from "./outbound-fetch-tunnel";

import { bufferPoolDisable } from "./buffer-pool-disable";
import { inboundHttpsViaSW } from "./inbound-https-via-sw";
import { outboundThrow } from "./outbound-throw";
import { outboundFetchTunnel } from "./outbound-fetch-tunnel";

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
  [inboundHttpsViaSW.name]: inboundHttpsViaSW,
  [outboundThrow.name]: outboundThrow,
  [outboundFetchTunnel.name]: outboundFetchTunnel,
};
