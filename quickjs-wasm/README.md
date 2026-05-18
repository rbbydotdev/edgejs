# Edge.js QuickJS WASIX

This package builds Edge.js as a WASIX WebAssembly binary with QuickJS compiled
into the guest module as the N-API provider.

## Build

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

## Run

```sh
wasmer run quickjs-wasm/wasmer.toml -- --version
wasmer run quickjs-wasm/wasmer.toml -- -e "console.log('hello from quickjs')"
```
