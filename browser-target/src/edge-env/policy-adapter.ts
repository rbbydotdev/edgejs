// Migration adapter: convert a legacy `Policy` (src/policies/index.ts) into
// a typed `Preset` (this framework).
//
// Used during the policies→edge-env migration so the worker can hand a
// mixed list of old Policy objects + new Preset objects to defineEdgeEnv
// without bifurcating its bootstrap.  Delete once src/policies/ is empty.

import type { Policy, ModuleOverride } from "../policies";
import type { AliasSource, Patch, Preset } from "./types";

/**
 * Convert a {@link Policy} (legacy) to a {@link Preset} (edge-env).
 * Splits `builtinOverrides` into the two disjoint categories of the
 * new framework: `alias` (whole-body replacement) and `patch` (pre/post).
 */
export function policyToPreset(p: Policy): Preset {
  const alias: Record<string, AliasSource> = {};
  const patch: Record<string, Patch> = {};

  for (const [id, override] of Object.entries(p.builtinOverrides ?? {})) {
    if (override === undefined) continue;
    if (override === null || typeof override === "string") {
      alias[id] = override;
    } else {
      // ModuleOverride's {pre?, post?} shape — both fields optional but
      // at least one expected.  Pass through unchanged.
      patch[id] = override as Patch;
    }
  }

  return {
    name: p.name,
    description: p.description,
    alias: Object.keys(alias).length ? alias : undefined,
    patch: Object.keys(patch).length ? patch : undefined,
    inject: p.userScriptPrelude || undefined,
  };
}

/**
 * Accept either a legacy Policy or a native Preset and normalize to Preset.
 * Distinguishes by checking for `builtinOverrides` (old) vs `alias`/`patch`
 * (new).  Self-described — no flag needed.
 */
export function asPreset(p: Policy | Preset): Preset {
  if ("builtinOverrides" in p || "userScriptPrelude" in p) {
    return policyToPreset(p as Policy);
  }
  return p as Preset;
}

// Re-export ModuleOverride for callers that still need the legacy type.
export type { ModuleOverride };
