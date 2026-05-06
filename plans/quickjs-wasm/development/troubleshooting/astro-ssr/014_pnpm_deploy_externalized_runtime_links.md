# Astro SSR: pnpm Deploy Externalized Runtime Links

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed in the app deploy preparation step; later Wasmer deploy packaging work materialized the runtime package graph into a symlink-free `.deploy` artifact. |
| **Severity** | Medium | The full app works from the source tree, but the pruned `.deploy` artifact failed at startup without addressable runtime packages. |

## Issue

The `stackmachine.com` Astro SSR app can run under Wasmer from the full project
tree, but the smaller `.deploy` directory prepared with `pnpm deploy --prod`
failed immediately:

```sh
cd /Users/sadhbh/src/dev/stackmachine.com
npm run edge:prepare-deploy
cd .deploy
wasmer run --net .
```

Observed failure:

```text
file:///app/dist/server/entry.mjs:1
import { renderers } from './renderers.mjs';

ReferenceError: could not load module 'piccolore'
```

## Diagnosis

The missing `piccolore` package exists inside the pnpm virtual store in the
deploy artifact:

```text
.deploy/node_modules/.pnpm/piccolore@0.1.3/node_modules/piccolore
```

However, `pnpm deploy --prod --legacy` only materializes top-level
`node_modules` links for packages that are reachable as deployed package
dependencies. Astro's generated server chunks still contain bare runtime
imports for packages that were externalized into `dist/server`, including
`piccolore`.

That means the runtime starts resolving from `/app/dist/server/...`, walks up
to `/app/node_modules`, and expects a top-level link:

```text
/app/node_modules/piccolore
```

The package was present in the virtual store but not addressable from the
standard Node-style package lookup path. This differs from the earlier WASIX
pnpm symlink issue: QuickJS symlink and package resolution were already working
once a top-level package entry existed.

The first generated top-level `piccolore` link still failed because it pointed
at Astro's dependency symlink:

```text
.pnpm/astro@.../node_modules/piccolore
```

Rebuilding the link against the resolved package directory fixed that part:

```text
.pnpm/piccolore@0.1.3/node_modules/piccolore
```

After the server started, the first route render exposed a second packaging
issue: `graphql-ws` imported `graphql` at runtime, but `graphql` was listed only
under app `devDependencies`. Since `pnpm deploy --prod --legacy` correctly
omits dev dependencies, the deploy artifact did not include `graphql`.

## Plan

- Keep the standard pnpm deploy flow so the artifact remains much smaller than
  the full project tree.
- Copy the Astro `dist`, `wasmer.toml`, optional `app.yaml`, and deployed production
  `node_modules` into `.deploy`.
- Scan `.deploy/dist/server` for bare `import`, dynamic `import(...)`, and
  `require(...)` specifiers.
- For each bare server-runtime package that is absent from
  `.deploy/node_modules`, find the matching package under the pnpm virtual
  store and make it addressable from the deploy root `node_modules`.
- Move packages needed by runtime peers into production dependencies so
  `pnpm deploy --prod` includes them normally.
- Treat this as app deploy packaging glue rather than an Edge QuickJS runtime
  change.

## Resolution

`/Users/sadhbh/src/dev/stackmachine.com/scripts/prepare-edge-deploy.cjs` first
fixed this local `.deploy` failure by building the Astro app, running
`pnpm deploy --prod --legacy`, assembling `.deploy`, and making externalized
runtime packages from the generated server bundle addressable at the deploy
root `node_modules`.

`graphql` was moved from `devDependencies` to `dependencies` in
`/Users/sadhbh/src/dev/stackmachine.com/package.json`, because it is imported
at runtime through `stackmachine` / `graphql-ws`.

The first fixed prepare run added access to:

```text
@oslojs/encoding, cookie, cssesc, destr, devalue, es-module-lexer,
html-escaper, mrmime, piccolore, send, server-destroy, sharp
```

That symlink-based local fix was later superseded by
`../wasmer-deploy/001_pnpm_directory_symlinks_webc.md`, after `wasmer deploy`
showed that the cloud package path can lose pnpm directory symlink contents.
The current deploy preparation step builds a runtime package closure, prunes
unimported packages, materializes package links as real directories, removes
`.pnpm`, rewrites virtual-store source imports, and asserts the final artifact
contains no symlinks or nested module stores.

The current deploy directory is:

```text
347M	/Users/sadhbh/src/dev/stackmachine.com/.deploy
```

## Validation

Prepare command:

```sh
cd /Users/sadhbh/src/dev/stackmachine.com
npm run edge:prepare-deploy
```

Runtime check:

```sh
cd /Users/sadhbh/src/dev/stackmachine.com/.deploy
wasmer run --net --env PORT=3311 --env HOST=127.0.0.1 .
curl -i http://127.0.0.1:3311/
```

Observed result:

```text
[@astrojs/node] Server listening on http://127.0.0.1:3311
HTTP/1.1 200 OK
content-type: text/html
```

The generated HTML rendered the StackMachine landing page from the `.deploy`
artifact.

The later flattened artifact also passed the Wasmer deploy packaging invariants:
no symlinks, only one root `node_modules`, no `.pnpm` directory, and no source
imports targeting `node_modules/.pnpm/.../node_modules/...`.
