// defineEdgeEnv: fold presets + inline overrides into a ResolvedEnvironment.
// See ./types.ts for the design rationale and category semantics.

import type {
  AliasSource,
  DefineEdgeEnvOptions,
  ModuleId,
  Patch,
  Preset,
  ResolvedEnvironment,
} from "./types";

export function defineEdgeEnv(opts: DefineEdgeEnvOptions): { env: ResolvedEnvironment } {
  const alias = new Map<ModuleId, AliasSource>();
  const patch = new Map<ModuleId, Patch>();
  const injectParts: string[] = [];
  const applied: string[] = [];

  // Treat inline overrides as a final synthetic preset so composition
  // logic is uniform.  Name it for diagnostics.
  const presetsAndOverrides: Preset[] = [...(opts.presets ?? [])];
  if (opts.overrides) {
    presetsAndOverrides.push({
      name: "<inline-overrides>",
      description: "Inline overrides passed to defineEdgeEnv()",
      ...opts.overrides,
    });
  }

  for (const p of presetsAndOverrides) {
    applied.push(p.name);

    if (p.alias) {
      // last-wins: a later preset replaces an earlier one entirely.
      for (const [id, src] of Object.entries(p.alias)) {
        alias.set(id, src);
      }
    }

    if (p.patch) {
      // additive: concatenate pre/post if a previous preset already
      // patched the same module.  Pre/post composability is what lets
      // process-methods-wasm-state and process-exit-terminates BOTH
      // patch internal/process/per_thread without clobbering each other.
      for (const [id, next] of Object.entries(p.patch)) {
        const prev = patch.get(id);
        if (prev) {
          patch.set(id, {
            pre: (prev.pre ?? "") + (next.pre ? "\n" + next.pre : ""),
            post: (prev.post ?? "") + (next.post ? "\n" + next.post : ""),
          });
        } else {
          patch.set(id, next);
        }
      }
    }

    if (p.inject) {
      const items = Array.isArray(p.inject) ? p.inject : [p.inject];
      for (const snippet of items) {
        if (snippet) injectParts.push(snippet);
      }
    }
  }

  return {
    env: {
      alias,
      patch,
      // Join with empty string — each snippet should be self-terminated
      // (lead `;` or wrap in IIFE).  Joining with `\n;\n` adds defensive
      // separators without trusting snippet hygiene.
      inject: injectParts.join("\n;\n"),
      appliedPresets: applied,
    },
  };
}
