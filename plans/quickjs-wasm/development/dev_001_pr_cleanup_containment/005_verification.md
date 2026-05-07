# Verification and remaining cleanup

## Scope

Tie together the rollback, native inspector fallback, Intl fallback split, and
compile-time trace diagnostics.

## Current Build State

The focused rebuilds have passed after the structured-clone API split and the
QuickJS WASIX `NAPI_EXTERN=` target fix:

```sh
make build
make build-edge-quickjs-cli
cd ~/src/dev/edgejs/quickjs-wasm && ./build.sh
```

The WASIX build produced `build-quickjs-wasix/edge.wasm` and `edgejs.wasm`, and
the script's final no-N-API-imports check passed.

## Required Smoke Tests

Run after rebuild:

```sh
./build-edge-quickjs-cli/edge --version
./build-edge-quickjs-cli/edge -e "console.log('hello from quickjs')"
./build-edge-quickjs-cli/edge -e "const inspector=require('inspector'); console.log(typeof inspector.Session, inspector.url()); try { inspector.open(); } catch (e) { console.log(e.code || e.message); } const s = new inspector.Session(); try { s.connect(); } catch (e) { console.log(e.code || e.message); }"
./build-edge-quickjs-cli/edge -e "const f = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); console.log(typeof f.format(new Date(0)), f.resolvedOptions().hour)"
```

Also rerun the donor-tree comparisons from `001_shared_runtime_rollback.md`.

When touching targets that include N-API headers and link into the embedded
QuickJS WASIX binary, verify the target gets `NAPI_EXTERN=` for
`EDGE_NAPI_PROVIDER=quickjs`; otherwise the final wasm link can fail with
`napi` versus `env` import module mismatches.

## Known Unrelated Dirty State

`wasmer.toml` was already modified before this cleanup thread. Do not revert it
unless explicitly asked.
