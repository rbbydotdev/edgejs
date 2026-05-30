// edge-env: typed environment definition for the edge.js browser target.
//
// Replaces the old `src/policies/` framework — see types.ts for the
// design rationale.  Migration is incremental: presets can live in
// either framework, and the worker can compose from both via
// {@link toLegacyShape}.

export type {
  AliasSource,
  DefineEdgeEnvOptions,
  ModuleId,
  Patch,
  Preset,
  ResolvedEnvironment,
} from "./types";

export { defineEdgeEnv } from "./define-env";
export { toLegacyShape } from "./compose";
export type { LegacyComposedShape } from "./compose";
export { policyToPreset, asPreset } from "./policy-adapter";
