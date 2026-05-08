# Wasmer Deploy: CI safe-mode missing QuickJS artifact

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | QuickJS-specific CI wiring fixed locally; full WASIX execution still needs the GitHub Actions toolchain. |
| **Severity** | High | Blocks the WASIX Linux job before the safe-mode smoke tests can start. |

## Issue

The `build-wasix-linux` workflow builds the legacy WASIX artifact through:

```sh
make build-wasix
```

That writes:

```text
build-wasix/edgejs.wasm
```

At the time this issue was first diagnosed, the active workflow/package path had
the root `wasmer.toml` describing the embedded QuickJS package and pointing at:

```text
build-quickjs-wasix/edgejs.wasm
```

The safe-mode smoke test therefore failed before executing JavaScript:

```text
Unable to read the "edge" module's file from "./build-quickjs-wasix/edgejs.wasm"
No such file or directory
```

## Action Plan

1. Add a Makefile target for the current QuickJS WASIX build script so CI does
   not need to know the script path directly.
2. Update the `build-wasix-linux` workflow to build the embedded QuickJS WASIX
   artifact before running `wasmer run .`.
3. Update WASIX dist packaging so `BUILD_DIR=build-quickjs-wasix` is treated as
   a wasm distribution directory, not as a native Edge build.
4. Remove or bypass the legacy `napi_wasmer` smoke path from this job because it
   belongs to `EDGE_NAPI_PROVIDER=imports`, while this package now embeds the
   QuickJS provider.
5. Verify the edited Makefile targets and safe-mode test script syntax locally;
   full WASIX execution still requires the CI Wasmer/WASIX toolchain.

## Fix

The root `wasmer.toml` has since been restored to the main V8 Edge package and
must stay that way. QuickJS packaging now belongs to the separate
`.github/workflows/test-and-build-quickjs.yml` workflow and the
`quickjs-wasm/wasmer.toml` manifest.

The Makefile now exposes:

```sh
make build-quickjs-wasix
```

That target runs `quickjs-wasm/build.sh`, producing the
`build-quickjs-wasix/edgejs.wasm` artifact referenced by the QuickJS package
manifest.

The QuickJS `build-wasix-linux` workflow now builds the QuickJS WASIX artifact
before the safe-mode smoke test and packages `BUILD_DIR=build-quickjs-wasix` for
the WASIX zip. The pre-packaging smoke test uses
`WASIX_PACKAGE_DIR="$(pwd)/quickjs-wasm"`, and the packaged WASIX dist is
rehydrated with `quickjs-wasm/wasmer.toml`, then rewrites the module source to
`./bin/edgejs` and the SSL certificate mount to `./ssl-certs`, so the root V8
manifest is not used for the QuickJS artifact. The legacy `napi_wasmer` smoke
path was removed from this job because it tests the host-import N-API artifact,
not the embedded QuickJS package.

The separate `.github/workflows/napi-wasmer-quickjs.yml` workflow also follows
the QuickJS path: native jobs build and test `napi-quickjs`, and its WASIX job
builds `build-quickjs-wasix` before running Wasmer directly against
`quickjs-wasm/wasmer.toml`.

`make dist-only` now treats both `build-wasix` and `build-quickjs-wasix` as
WASIX distribution directories, so it copies `edgejs.wasm`, `wasmer.toml`, and
certificates instead of looking for native `edge` and `edgeenv` binaries.

## Verification

Local structural checks passed:

```sh
make -n build-quickjs-wasix
make -n dist-only BUILD_DIR=build-quickjs-wasix ZIP_NAME=edge-wasix.zip
python3 -m py_compile scripts/test-wasix-safe-mode.py
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/test-and-build.yml')"
git diff --check
```

The full `make build-quickjs-wasix` and `make test-wasix-safe-mode` flow was not
run locally because it depends on the WASIX/Wasmer CI toolchain.

## Follow-Up: Native Linux Job

The native `build-linux` job in the QuickJS workflow still built the V8 N-API
test target and default V8-backed Edge binary. It now follows the same provider
direction as the WASIX job:

```sh
make build-napi-quickjs CMAKE_BUILD_TYPE=Release JOBS=4
make test-napi-quickjs-only TEST_JOBS=4
make build-edge-quickjs-cli CMAKE_BUILD_TYPE=Release JOBS=4
make dist-only BUILD_DIR=build-edge-quickjs-cli JOBS=4 ZIP_NAME=edge-linux-amd64.zip
make test-only BUILD_DIR=build-edge-quickjs-cli TEST_JOBS=4
```

`make build-edge-quickjs-cli` now builds both the `edge` and `edgeenv` targets
so native dist packaging has the executables expected by `dist-only`.

### May 7, 2026 Native QuickJS N-API Release Build Follow-Up

The Linux `make build-napi-quickjs CMAKE_BUILD_TYPE=Release JOBS=4` job failed
under Ubuntu 24.04 / Clang 18.1.3 because
`napi/quickjs/src/js_native_api_quickjs.cc` used `INT_MAX` without directly
including `<climits>`. The V8 backend already includes `<climits>` for the same
`INT_MAX` checks, so the QuickJS backend now includes it explicitly.

Reproducing the job in an Ubuntu 24.04 Docker container with Clang 18.1.3 also
exposed a second libstdc++/Clang compile issue in
`napi/quickjs/src/unofficial_module_loader.cc`: the recursive `JsonValue` type
instantiated `std::vector<std::pair<std::string, JsonValue>>` special-member
machinery while `JsonValue` was still incomplete. `JsonValue` now declares its
special members and `Get(...)` in the struct and defaults/defines them
out-of-line after the type is complete.

Verification:

```sh
CC=clang CXX=clang++ make build-napi-quickjs CMAKE_BUILD_TYPE=Release JOBS=4
```

Result: passed in the Ubuntu 24.04 / Clang 18.1.3 Docker container.

### May 7, 2026 QuickJS Workflow Split Follow-Up

The main `.github/workflows/test-and-build.yml` workflow and root `wasmer.toml`
were restored to their main/V8 behavior. The QuickJS-specific copy at
`.github/workflows/test-and-build-quickjs.yml` now keeps all active build/test
targets on the QuickJS provider:

```sh
make build-napi-quickjs CMAKE_BUILD_TYPE=Release JOBS=4
make test-napi-quickjs-only TEST_JOBS=4
make build-edge-quickjs-cli CMAKE_BUILD_TYPE=Release JOBS=4
make dist-only BUILD_DIR=build-edge-quickjs-cli JOBS=4 ZIP_NAME=edge-<platform>.zip
make test-only BUILD_DIR=build-edge-quickjs-cli TEST_JOBS=4
make build-quickjs-wasix
make dist-only BUILD_DIR=build-quickjs-wasix JOBS=4 ZIP_NAME=edge-wasix.zip
```

The macOS job was updated to match the Linux QuickJS native job. The inactive
Windows smoke scaffold was also changed to use `-DEDGE_NAPI_PROVIDER=quickjs`
if it is re-enabled later.
