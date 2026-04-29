# Edge.js QuickJS WASIX Scaffold

This directory contains the package scaffold for the experimental
`EDGE_NAPI_PROVIDER=quickjs` WASIX build.

## Build

Run from the repository root with the WASIX toolchain on `PATH`:

```sh
quickjs-wasm/build.sh
```

The build uses `build-quickjs-wasix/` and writes:

```text
build-quickjs-wasix/edge.wasm
build-quickjs-wasix/edgejs.wasm
```

The build script verifies that the final wasm module does not import N-API
symbols such as `napi_*`, `node_api_*`, or `unofficial_napi_*`.

## Smoke Commands

```sh
cmake -S . -B build-quickjs-wasix \
  -DCMAKE_TOOLCHAIN_FILE=wasix/wasix-toolchain.cmake \
  -DEDGE_NAPI_PROVIDER=quickjs \
  -DEDGE_BUILD_CLI=ON \
  -DBUILD_TESTING=OFF

wasmer run quickjs-wasm/wasmer.toml -- --version
```

The QuickJS provider is only a CMake scaffold in this phase. A complete N-API
implementation is expected in the next phase.
