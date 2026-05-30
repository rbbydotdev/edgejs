// edge-env: typed environment definition for edge.js browser target.
//
// Inspired by unenv's `defineEnv()` (https://github.com/unjs/unenv) but
// tailored to our needs:
//   - We are a runtime (not a bundler), so we don't need `inject`
//     (bundler-driven global auto-import) or `external` (bundler escape).
//   - We DO need a surgical `patch` category for `{pre, post}` hooks
//     around a Node built-in's body — unenv has no equivalent.
//   - `inject` in OUR vocabulary is unenv's `polyfill`: code prepended
//     to every user `-e` script.
//
// CATEGORIES
//
// `alias`  — replace a built-in module's compiled body entirely with the
//            given JS source.  Use when you want to swap a whole shim
//            (e.g. drop in a vendored impl).
//            `null` means "stub as `module.exports = {}`".
//
// `patch`  — surgical pre/post hooks around the built-in's body, inside
//            the same function wrapper (so the patch sees the module's
//            locals AND the wrapper args like `internalBinding`,
//            `primordials`, `module`).  Use when you need to mutate a
//            binding, wrap an export, or fix a specific line — without
//            re-pasting 1000 lines of vendored code.
//
// `inject` — JS source(s) prepended to every user `-e` script.  Use for
//            patches that have to mutate globalThis/Buffer AT user-script
//            time rather than at built-in-module load time (e.g. setting
//            `Buffer.poolSize = 0` in the user's realm — see
//            buffer-pool-disable preset).
//
// COMPOSITION
//
// Presets compose in declaration order.  For each category:
//   - alias: last-wins (a later preset overrides an earlier one)
//   - patch: ADDITIVE — multiple presets can each contribute pre/post
//            patches to the same module, concatenated in declaration
//            order.  This is the same behavior the old policies framework
//            had.
//   - inject: appended (all snippets run, in order)

/** A bare or `node:`-prefixed module identifier (e.g. `"buffer"`, `"node:fs"`,
 *  `"internal/buffer"`). Matched against the `//# sourceURL=node:<id>`
 *  comment emitted by edge's bootstrap. */
export type ModuleId = string;

/** Replacement source for a whole module body.
 *  - `string`: use this source as the module body.
 *  - `null`: stub the module as `module.exports = {}`. */
export type AliasSource = string | null;

/** Surgical patches around a module body. */
export interface Patch {
  /** JS source prepended INSIDE the module's function wrapper.
   *  Runs BEFORE the body — useful for mutating bindings before the
   *  body's top-level destructures pick them up. */
  pre?: string;
  /** JS source appended INSIDE the module's function wrapper.
   *  Runs AFTER the body — has access to all module locals AND
   *  `module.exports`.  Useful for wrapping exports. */
  post?: string;
}

/** A complete, resolved environment ready to hand to the napi-host. */
export interface ResolvedEnvironment {
  /** Module-id → replacement source (or null stub). */
  alias: Map<ModuleId, AliasSource>;
  /** Module-id → surgical patch. */
  patch: Map<ModuleId, Patch>;
  /** Joined user-script prelude (single string for easy concat). */
  inject: string;
  /** Names of every applied preset, in declaration order.  Diagnostic. */
  appliedPresets: string[];
}

/** A named bundle of overrides. */
export interface Preset {
  /** Short identifier — used in logs and `--policies` CLI compat. */
  name: string;
  /** Human-readable one-line summary. */
  description: string;
  /** Module-id → alias source. */
  alias?: Record<ModuleId, AliasSource>;
  /** Module-id → patch. */
  patch?: Record<ModuleId, Patch>;
  /** JS source(s) prepended to every user `-e` script. */
  inject?: string | string[];
}

/** Input to {@link defineEdgeEnv}. */
export interface DefineEdgeEnvOptions {
  /** Presets applied in declaration order.  Earlier presets are
   *  overridden by later ones for `alias`; `patch` and `inject` are
   *  additive. */
  presets?: Preset[];
  /** Inline overrides applied AFTER all presets — useful for one-off
   *  tweaks without making a preset. */
  overrides?: Partial<Pick<Preset, "alias" | "patch" | "inject">>;
}
