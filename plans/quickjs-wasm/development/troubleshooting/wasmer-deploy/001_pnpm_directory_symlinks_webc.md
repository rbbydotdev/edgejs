# Wasmer Deploy: pnpm Directory Symlinks In WEBC Package

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Deploy preparation now emits a symlink-free, flattened `.deploy` artifact and passes local `wasmer run --net .`; wasmer.io still needs a fresh deploy confirmation. |
| **Severity** | High | The app runs locally from `.deploy`, but the app deployed to wasmer.io exits during startup when bare `react` cannot resolve. |

## Issue

The prepared `stackmachine.com` deploy directory works locally:

```sh
cd ~/src/dev/stackmachine.com
npm run edge:prepare-deploy
cd .deploy
wasmer run --net .
```

The same app created by `wasmer deploy` on wasmer.io exits with:

```text
file:///app/dist/server/entry.mjs:1
import { renderers } from './renderers.mjs';

ReferenceError: could not load module 'react'
Instance exited with code ExitCode::1
```

This means the cloud runtime reached the Astro server entry, then failed while
resolving the bare `react` import from `/app/dist/server/renderers.mjs`.

## Source Findings

Wasmer has two different deploy/package paths that matter here.

Remote autobuild ZIP creation lives in:

```text
~/src/dev/wasmer/lib/sdk/src/app/deploy_remote_build.rs
```

`create_zip_archive(...)` configures the ignore walker with
`standard_filters(true)`, `.ignore(true)`, `.git_ignore(true)`,
`.git_exclude(true)`, `.git_global(true)`, `.require_git(true)`, and
`.follow_links(false)`. It also explicitly rejects symlinks:

```text
cannot deploy projects containing symbolic links
```

So if `wasmer deploy` takes the remote autobuild ZIP path for a tree containing
pnpm links, it should fail before runtime. This path also enables standard and
git ignore filtering, so hidden paths and ignored paths can be filtered there.

The local package publish path is used when the app manifest points at a local
package and a `wasmer.toml` is present. That path is in:

```text
~/src/dev/wasmer/lib/cli/src/commands/app/deploy.rs
~/src/dev/wasmer/lib/sdk/src/package/publish.rs
~/src/dev/wasmer/lib/package/src/package/package.rs
```

The package walker uses `standard_filters(false)`, `.follow_links(false)`,
`.parents(true)`, and `.add_custom_ignore_filename(".wasmerignore")`.
Therefore this path does not skip hidden directories merely because their names
begin with `.`. In the original pnpm-deployed artifact, the prepared app had no
`.deploy/.wasmerignore`, `.gitignore`, or `.ignore`, and
`.deploy/node_modules/.pnpm` existed locally.

The important remaining behavior is symlink handling. Package volumes are
created through:

```text
~/src/dev/wasmer/lib/package/src/package/volume/fs.rs
```

That calls WEBC's `Directory::from_path_with_walker(...)` with the same walker.
The WEBC crate code inspected locally is:

```text
/Users/sadhbh/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/webc-11.0.0/src/from_path_with_walker.rs
```

Because the walker has `follow_links(false)`, it sees pnpm top-level package
links but does not descend into linked directories. WEBC then classifies entries
from the path shape. A directory symlink such as:

```text
/app/node_modules/react -> .pnpm/react@18.3.1/node_modules/react
```

can become a directory entry without the package contents that live behind the
symlink.

## Diagnosis

This is not the same as the earlier WASIX local filesystem symlink issue. Local
`wasmer run --net .` sees the host `.deploy` tree and follows the real pnpm
symlinks, so QuickJS can resolve:

```text
/app/node_modules/react/package.json
```

The cloud package is serialized first. If the WEBC package contains
`/app/node_modules/react` as an empty directory, a non-followed symlink entry,
or otherwise not as the real React package directory, QuickJS correctly fails
Node-style bare package resolution and reports:

```text
ReferenceError: could not load module 'react'
```

The hidden `.pnpm` directory is less likely to be the primary issue for the
local package publish path, because that path disables standard filters. The
top-level `node_modules/react` directory symlink is the sharper suspect.

## Action Plan

- Keep the existing `.deploy` preparation flow as the starting point.
- Copy deploy manifests that Wasmer may need at upload time, including
  `wasmer.toml` and optional `app.yaml`.
- Build a runtime package closure from literal imports in `.deploy/dist/server`,
  then recursively scan included package source files for literal
  `import(...)`, static `import`/`export ... from`, and `require(...)`
  specifiers.
- Prune top-level packages outside that import closure.
- Materialize the remaining pnpm package links as real directories, skipping
  nested `node_modules` directories so every module exists only at the root
  `.deploy/node_modules` level.
- Remove pnpm runtime scaffolding (`.pnpm` and `.bin`) from the final artifact.
- Rewrite source references from:

```text
node_modules/.pnpm/<store-entry>/node_modules/<package>
```

to:

```text
node_modules/<package>
```

- Fail deploy preparation if any of these invariants are violated:
  no symlinks, no nested `node_modules`, no `.pnpm` directory, and no remaining
  source imports targeting pnpm virtual-store paths.
- Verify the deploy artifact before upload:

```sh
cd ~/src/dev/stackmachine.com/.deploy
find . -type l -print
find . -type d -name node_modules -print
find . -type d -name .pnpm -print
rg -n 'node_modules/\.pnpm/.+/node_modules/' .
```

## Current Status

`~/src/dev/stackmachine.com/scripts/prepare-edge-deploy.cjs` now
creates a flattened deploy artifact:

- builds Astro and runs `pnpm deploy --prod --legacy` into a temporary
  `.deploy-pnpm`;
- copies `dist`, `wasmer.toml`, optional `app.yaml`, `package.json`, and the deployed
  `node_modules`;
- links missing server-runtime bare imports from the pnpm virtual store;
- expands the runtime import closure by scanning included source files;
- prunes packages outside that closure;
- materializes the remaining package links as real directories;
- removes `.pnpm` and `.bin`;
- rewrites source references to materialized `node_modules/<package>` paths;
- asserts the final artifact has a single root `node_modules` tree and no
  symlinks.

The fresh local artifact now reports:

```text
Runtime package closure: 488 package(s)
Pruned 34 unimported top-level packages
Materialized 488 package links
347M	~/src/dev/stackmachine.com/.deploy
```

## Validation

Fresh prepare:

```sh
cd ~/src/dev/stackmachine.com
npm run edge:prepare-deploy
```

Final artifact checks:

```sh
find ~/src/dev/stackmachine.com/.deploy -type l -print
find ~/src/dev/stackmachine.com/.deploy -type d -name node_modules -print
find ~/src/dev/stackmachine.com/.deploy -type d -name .pnpm -print
rg -n 'node_modules/\.pnpm/.+/node_modules/' ~/src/dev/stackmachine.com/.deploy
```

Observed:

- no symlinks;
- only `~/src/dev/stackmachine.com/.deploy/node_modules`;
- no `.pnpm` directory;
- no pnpm virtual-store import paths;
- `~/src/dev/stackmachine.com/.deploy/app.yaml` exists when the
  source app has `app.yaml`, and matches the source file.

Runtime check:

```sh
cd ~/src/dev/stackmachine.com/.deploy
wasmer run --net .
curl -m 30 -s -o /tmp/stackmachine-deploy-check.html \
  -w '%{http_code} %{content_type} %{size_download}\n' \
  http://127.0.0.1:4321/
```

Observed:

```text
[@astrojs/node] Server listening on http://localhost:4321
200 text/html 167960
```

## Open Questions

- Whether Wasmer Cloud was reached through local package publish or remote
  autobuild for the reported run. The runtime failure suggests the local package
  path, because the remote ZIP path should reject symlinks during archive
  creation.
- Whether Wasmer should preserve directory symlinks in WEBC packages, reject
  them like the remote ZIP path, or document that publish inputs must be
  symlink-free.
