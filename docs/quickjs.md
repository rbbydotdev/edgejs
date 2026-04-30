# Edge.js with QuickJS and WASIX

This document describes the architecture, setup, and build process for running Edge.js with the QuickJS engine compiled as a native WASIX WebAssembly module.

## Architecture

The QuickJS integration for Edge.js follows the standard Node-API (N-API) provider pattern. Instead of using a host-provided N-API bridge, the QuickJS engine is compiled directly into the guest WebAssembly binary.

### Key Components

*   **N-API Provider (`napi/quickjs`)**: A custom implementation of the Node-API surface area using QuickJS-NG. It maps N-API types (`napi_env`, `napi_value`, etc.) to QuickJS types (`JSContext*`, `JSValue`).
*   **Embedded Engine**: QuickJS-NG is fetched and linked as a static library during the build process.
*   **Unified Lifecycle**: Uses `EDGE_EMBEDDED_NAPI_PROVIDER` to enable embedded-specific lifecycle hooks in Edge.js (e.g., environment attachment, cleanup, and promise rejection handling).
*   **WASM/WASIX**: The final binary is a WASIX-compatible module that can be executed by Wasmer.

## Prerequisites

*   **Nix**: Recommended for a reproducible build environment.
*   **Wasmer**: To run the resulting WASIX modules.
*   **wasixcc**: The WASIX toolchain (provided via Nix or manual installation).

## Build Instructions

### 1. Setup WASIX Dependencies

Before building, you must populate the WASIX-specific dependencies (libuv and OpenSSL):

```bash
./wasix/setup-wasix-deps.sh
```

### 2. Native Build (for testing/development)

To build the QuickJS provider for your host system:

```bash
nix develop --command cmake -S . -B build-quickjs-native \
  -DEDGE_NAPI_PROVIDER=quickjs \
  -DEDGE_BUILD_CLI=OFF \
  -DBUILD_TESTING=OFF

nix develop --command cmake --build build-quickjs-native --target napi_quickjs -j$(nproc)
```

### 3. WASIX Build

The primary build script for the QuickJS WASIX package is located at `quickjs-wasm/build.sh`. It handles CMake configuration, building, and WASM optimization.

```bash
nix develop --command ./quickjs-wasm/build.sh
```

The build produces:
*   `build-quickjs-wasix/edge.wasm`: The raw WASIX binary.
*   `build-quickjs-wasix/edgejs.wasm`: The optimized WASIX binary (used by the package).

## Running with Wasmer

### Using the Local Package

You can run the QuickJS-backed Edge.js directly from the `quickjs-wasm` directory:

```bash
# Check version
wasmer run quickjs-wasm/ -- --version

# Run a script string
wasmer run quickjs-wasm/ -- -e "console.log('hello from quickjs')"
```

### Sample Application (Echo Server)

A sample application is provided in the `echo-server/` directory. It demonstrates how to depend on the published `christoph/edgejs-quickjs` package.

```bash
# From the repository root
wasmer run echo-server/
```

## Implementation Details

### Node-API Mapping

*   **Values**: `napi_value` is a wrapper around a QuickJS `JSValue`. To prevent memory leaks and maintain identity, the provider uses an identity-preserving map for objects and functions.
*   **Callbacks**: Native callbacks are bridged through a rooted callback registry to ensure GC safety.
*   **Contextify**: Implements `unofficial_napi_contextify_compile_function` to support Node.js builtins and eval-style execution.

### Known Limitations

*   **ESM Support**: Currently focused on CommonJS and builtin modules.
*   **Advanced VM Features**: Sandbox contexts and cached data are currently unsupported.
*   **Stack Size**: WASIX stack size may need adjustment for deeply nested JS execution (use `wasmer run --stack-size <size>`).

## Nix Integration

The `flake.nix` in the root directory provides a complete development environment with all necessary tools (cmake, ninja, wasixcc, etc.).

```bash
# Enter the development shell
nix develop

# Run a command within the shell
nix develop --command <command>
```
