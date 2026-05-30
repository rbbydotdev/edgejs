# Vendored: unenv

Selectively vendored fragments of [unjs/unenv](https://github.com/unjs/unenv).

**DO NOT EDIT** these files. To update, re-vendor from upstream and refresh the
commit hash recorded in every file header (and in this README).

## Upstream

- Repo:    https://github.com/unjs/unenv
- License: MIT — https://github.com/unjs/unenv/blob/main/LICENSE
- Commit:  `f89b7ccb5c05da70b946319783acf1fa1f113e22`

## Files vendored

| Local file        | Upstream path                                                                                                    | Notes                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `base64.ts`       | `src/runtime/node/internal/buffer/base64.ts`                                                                     | Verbatim copy. base64-js implementation.                                           |
| `base64clean.ts`  | `src/runtime/node/internal/buffer/buffer.ts` (lines ~2292-2308: `INVALID_BASE64_RE` + `base64clean`)             | Extracted standalone; original function is module-private upstream, wrapped+exported here. |

## Consumers

Vendored code must not be imported directly outside the single project facade.
The only allowed importer is:

- `src/edge-env/vendor-adapters/unenv-base64.ts`

All other code consumes the typed facade instead. This keeps unenv swappable.

## Re-vendoring checklist

1. Fetch latest source at the new commit hash:
   - `https://raw.githubusercontent.com/unjs/unenv/<hash>/src/runtime/node/internal/buffer/base64.ts`
   - `https://raw.githubusercontent.com/unjs/unenv/<hash>/src/runtime/node/internal/buffer/buffer.ts`
2. Replace `base64.ts` verbatim; keep the local header.
3. Re-extract `INVALID_BASE64_RE` + `base64clean` into `base64clean.ts`; keep the
   `export { base64clean }` wrapper and the local header.
4. Update the commit hash in this README and in each file header.
5. Re-run `npx tsc -b --noEmit` from `browser-target/`.
