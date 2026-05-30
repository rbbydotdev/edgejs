// compose: bridge between the typed edge-env world and the legacy
// `{ builtinOverrides, userScriptPrelude }` shape the napi-host
// expects today.
//
// We keep napi-host's input shape stable during migration — once
// every old policy is migrated into the new edge-env framework, we
// can revisit whether to refactor napi-host's input shape too.

import type { ModuleOverride } from "../policies";
import type { ResolvedEnvironment } from "./types";

export interface LegacyComposedShape {
  builtinOverrides: Record<string, ModuleOverride>;
  userScriptPrelude: string;
  applied: string[];
}

/**
 * Fold a {@link ResolvedEnvironment} into the legacy shape the napi-host
 * already consumes.  When `alias` and `patch` BOTH target the same module,
 * alias wins (a whole-body replacement implies you don't want surgical
 * patches stacked on top of it).  This matches how the old framework
 * resolved similar conflicts.
 */
export function toLegacyShape(env: ResolvedEnvironment): LegacyComposedShape {
  const builtinOverrides: Record<string, ModuleOverride> = {};

  // Apply aliases first (whole-body replacements).
  for (const [id, src] of env.alias) {
    builtinOverrides[id] = src;
  }

  // Then patches — but only if no alias claimed that module.  An alias
  // by definition discards the original body, so a `{post}` patch that
  // refers to body locals would break.
  for (const [id, p] of env.patch) {
    if (id in builtinOverrides) continue;
    builtinOverrides[id] = p;
  }

  return {
    builtinOverrides,
    userScriptPrelude: env.inject,
    applied: env.appliedPresets,
  };
}
