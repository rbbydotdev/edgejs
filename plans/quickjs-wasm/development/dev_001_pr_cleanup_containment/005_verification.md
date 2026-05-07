# Verification and remaining cleanup

## Scope

Tie together the rollback, native inspector fallback, Intl fallback split, and
compile-time trace diagnostics.

## Current Build State

A native QuickJS rebuild is currently running:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Earlier rebuilds passed before the Intl split and trace macro changes. The
current rebuild should be checked before final response.

## Required Smoke Tests

Run after rebuild:

```sh
./build-edge-quickjs-cli/edge --version
./build-edge-quickjs-cli/edge -e "console.log('hello from quickjs')"
./build-edge-quickjs-cli/edge -e "const inspector=require('inspector'); console.log(typeof inspector.Session, inspector.url()); try { inspector.open(); } catch (e) { console.log(e.code || e.message); } const s = new inspector.Session(); try { s.connect(); } catch (e) { console.log(e.code || e.message); }"
./build-edge-quickjs-cli/edge -e "const f = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); console.log(typeof f.format(new Date(0)), f.resolvedOptions().hour)"
```

Also rerun the donor-tree comparisons from `001_shared_runtime_rollback.md`.

## Known Unrelated Dirty State

`wasmer.toml` was already modified before this cleanup thread. Do not revert it
unless explicitly asked.
