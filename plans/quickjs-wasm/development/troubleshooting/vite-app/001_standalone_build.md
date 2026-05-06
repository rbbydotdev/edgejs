# Vite App Standalone Build Findings

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Findings captured for the plain Vite standalone build shape. |
| **Severity** | Low | This is an architecture note; the current custom static server path remains viable. |

## Query

Can a plain Vite app use a standalone build shape like the Astro app, so the app
does not provide its own `server/router.cjs` and the server entry is produced as
part of the standard build?

## Summary

Not in the same way as the Astro app by default, but
`vite-plugin-standalone` is a relevant candidate if the Vite app has, or is
given, a server entrypoint.

The Astro app can use this shape because it is configured for Astro server
output with the Node adapter in standalone mode:

```js
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
});
```

That build emits a server entry under `dist/server/entry.mjs`. The local EdgeJS
compatibility step then bundles that emitted server entry into
`dist/server/entry.cjs`, which Wasmer can execute through Edge QuickJS.

The Vite app is a plain SPA build. Its standard build is only:

```sh
vite build
```

That emits static client files under `dist`; it does not emit an HTTP server
entrypoint equivalent to Astro's standalone `dist/server/entry.mjs`.

There is a third-party plugin, `vite-plugin-standalone`, whose README describes
it as a Vite plugin that uses `@vercel/nft` and esbuild to create a standalone
server build so deployment can copy only the build folder rather than
`node_modules`. The plugin supports an explicit `entry` option, including
multiple named entries:

```js
standalone({
  entry: {
    index: './server/index.ts',
    worker: './server/worker.js',
  },
});
```

The plugin source applies only to SSR builds (`env.isSsrBuild`), then finds the
Rollup bundle entries, rebundles them with esbuild for Node, and traces/copies
native or external dependencies with `@vercel/nft`. In other words, it packages
a server entry; it does not remove the need for server semantics to exist
somewhere.

Its examples also point in that direction:

- the Rakkas example uses `standalone()` alongside the Rakkas Vite plugin;
- the Vike example uses a server entry at `./src/server/index.ts` and
  `viteNode({ entry: './src/server/index.ts', standalone: true })`;
- that Vike server entry creates an Express app and listens on `PORT`.

For this reason, if the Vite app remains a plain SPA, its `server/router.cjs` is
currently real runtime plumbing, not incidental project code. It provides the
HTTP/static adapter that Vite's SPA build does not generate:

- serve files from `/dist`;
- support `GET` and `HEAD`;
- reject path traversal;
- map directories to `index.html`;
- fall back to `/dist/index.html` for client-side routes;
- send explicit content types and cache headers.

## Options For Next Work

1. Keep an app-owned `server/router.cjs`.
   This is the simplest shape and matches the current Vite static SPA adapter
   notes for Edge QuickJS WASIX.

2. Generate or bundle `server/router.cjs` during the app build.
   This can remove hand-maintained router code from the app, but it would still
   be an EdgeJS adapter/template rather than standard Vite output.

3. Try `vite-plugin-standalone` with an explicit minimal server entry.
   This may let the Vite app produce a build-contained server artifact, but it
   still needs compatibility testing under Edge QuickJS WASIX. The default
   plugin output is ESM and Node-targeted, and examples use Express/framework
   server code, so it may need an esbuild format/config adjustment or a small
   CJS wrapper for the current Edge QuickJS execution path.

4. Move the app to a framework/runtime that emits a standalone server adapter.
   Astro SSR, Rakkas, or Vike are examples. This is a larger migration and
   changes the app architecture.

5. Add a reusable EdgeJS static SPA adapter package or runtime entry.
   This is likely the cleanest longer-term direction: Vite apps could point at a
   shared adapter instead of carrying their own `server/router.cjs`.

## Conclusion

It is possible to remove app-owned `server/router.cjs`, but not by flipping a
Vite `standalone` option. Plain Vite does not currently provide an Astro-style
standalone HTTP server entry as part of `vite build`.

`vite-plugin-standalone` is worth a focused experiment. The experiment should
answer whether a minimal static SPA HTTP entry can be bundled into a
build-owned artifact that Edge QuickJS WASIX can execute. If that works, the app
can avoid carrying a bespoke router file. If it does not, the best next story is
probably a reusable EdgeJS static SPA adapter so Vite apps can keep the standard
`vite build` output while avoiding per-app router copies.
