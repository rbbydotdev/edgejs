# Edge QuickJS runtime change containment rollback

## Goal

Rollback the shared EdgeJS runtime directories so they match the upstream
`wasmer-io/edgejs` tree again, and keep all QuickJS-specific compatibility work
contained in:

- `napi/quickjs/`
- optionally `src/`

The directories to restore from `~/src/dev/wasmer-io/edgejs` are:

- `lib/`
- `napi/v8/`
- `napi/src/`
- `napi/include/`

This keeps the QuickJS backend from carrying hidden changes in shared JavaScript
library files, the V8 provider, or the common N-API headers/sources.

## Rollback Surface

Initial comparison showed:

- `napi/src/` already matches the donor tree.
- `napi/include/` already matches the donor tree.
- `napi/v8/` only has an extra `.DS_Store` file in the QuickJS worktree.
- `lib/` differs in eight files:
  - `_http_server.js`
  - `inspector.js`
  - `internal/modules/esm/utils.js`
  - `internal/readline/emitKeypressEvents.js`
  - `internal/readline/interface.js`
  - `internal/repl/history.js`
  - `internal/stream_base_commons.js`
  - `internal/streams/readable.js`

Most `lib/` differences are diagnostics for `EDGE_TRACE_NET` or
`EDGE_TRACE_TTY`. Those should not remain in shared runtime files. If equivalent
diagnostics are still needed, move them to QuickJS-native stream, TTY, or HTTP
parser code under `napi/quickjs/` or to neutral native runtime tracing under
`src/`.

The functional risk is `lib/inspector.js`. The current QuickJS tree contains a
JavaScript fallback that makes `require("inspector")` return a stable unavailable
stub when the build has no inspector. After rollback, the shared library returns
to the upstream behavior of throwing `ERR_INSPECTOR_NOT_AVAILABLE` when
`internalBinding("config").hasInspector` is false. If framework code still needs
`require("inspector")` to be linkable under QuickJS, the fix should move below
the JavaScript library layer.

## Compatibility Strategy

1. Restore the requested directories from the donor tree exactly, including
   removing files that exist only in the QuickJS worktree under those paths.
2. Rebuild the native QuickJS Edge CLI and run focused smoke tests:
   - `./build-edge-quickjs-cli/edge --version`
   - `./build-edge-quickjs-cli/edge -e "console.log('hello from quickjs')"`
   - `./build-edge-quickjs-cli/edge ./quickjs-wasm/echo-server.js`
3. If `require("inspector")` is still needed by Next.js or another framework,
   keep `lib/inspector.js` upstream-clean and make the runtime expose a narrow
   native compatibility path in C/C++ instead of JavaScript. The chosen fallback
   is to report inspector module availability through `internalBinding("config")`
   and provide `internalBinding("inspector")` with unavailable/no-op behavior
   compatible with upstream `lib/inspector.js`. This allows imports to link
   while active debugger/session operations still fail explicitly.
4. If stream, REPL, or HTTP behavior regresses after losing JS tracing, diagnose
   from QuickJS-owned code and keep fixes in wrapper/native code rather than
   reintroducing shared `lib/` edits.
5. Rebuild WASIX after QuickJS-impacting fixes under `napi/quickjs/` or `src/`
   using:

   ```sh
   cd ~/src/dev/edgejs/quickjs-wasm/ && ./build.sh
   ```

   The QuickJS WASIX target links the embedded QuickJS N-API implementation into
   the final wasm. Edge targets that include N-API headers before linking
   `napi_quickjs`, such as `edge_environment_core`, must still define
   `NAPI_EXTERN=` for the QuickJS provider. Otherwise wasm objects can disagree
   on the import module for the same `napi_*` symbols (`napi` versus `env`) and
   fail at the final `wasm-ld` link.

## Current Result

The structured-clone API split required Edge messaging call sites to use the
three-argument `unofficial_napi_structured_clone(...)` for no-transfer clones
and `unofficial_napi_structured_clone_with_transfer(...)` when a transfer list
is present. After that source fix, the native root build and native QuickJS CLI
build passed.

The QuickJS WASIX build then failed at the final link because
`edge_environment_core` saw default WASM N-API imports from the common header.
Adding `NAPI_EXTERN=` for that target under `EDGE_NAPI_PROVIDER=quickjs`
resolved the mismatch. Verified:

```sh
make build
make build-edge-quickjs-cli
cd ~/src/dev/edgejs/quickjs-wasm && ./build.sh
```

`quickjs-wasm/build.sh` produced `build-quickjs-wasix/edge.wasm` and
`build-quickjs-wasix/edgejs.wasm`, and its final no-N-API-imports check passed.

The standalone N-API Cargo workflow also needs to stay on the standalone
release family instead of following the vendored path manifest blindly. The
vendored `napi/Cargo.toml` tracks local `0.702` / `7.2` path crates, but the
crates.io `7.2.0-alpha.2` graph requires Rust 1.92. With the default Rust 1.91
toolchain, `~/src/dev/edgejs/napi/cargo-standalone.sh test --lib -- --nocapture`
failed before tests started. Pinning `napi/Cargo.standalone.toml` to Wasmer
`7.1.0` and WASIX/virtual-fs `0.701.0` restores the standalone crates.io graph
and the library tests pass.

## Working Rule

From this rollback onward, changes needed only for Edge QuickJS should not be
made in `lib/`, `napi/v8/`, `napi/src/`, or `napi/include/`. Shared runtime
changes should happen only when they are correct for all providers and can be
justified independently of QuickJS.
