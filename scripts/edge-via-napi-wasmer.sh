#!/usr/bin/env bash
# Wrapper that lets `test/nodejs_test_harness` exec `edge.wasm` on macOS where
# binfmt registration isn't available. Resolves the project root, locates the
# napi_wasmer CLI, mounts the test tree, and forwards args. Used as
# NODE_TEST_RUNNER for the corpus path.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAPI_WASMER="${PROJECT_ROOT}/napi/target/debug/napi_wasmer"
EDGE_WASM="${PROJECT_ROOT}/build-wasix/edgejs.wasm"
TEST_ROOT="${PROJECT_ROOT}/test"

if [[ ! -x "${NAPI_WASMER}" ]]; then
  echo "edge-via-napi-wasmer: napi_wasmer not built at ${NAPI_WASMER}" >&2
  echo "  run: make build-napi-wasmer-cli" >&2
  exit 127
fi
if [[ ! -f "${EDGE_WASM}" ]]; then
  echo "edge-via-napi-wasmer: edgejs.wasm not built at ${EDGE_WASM}" >&2
  echo "  run: bash wasix/build-wasix.sh" >&2
  exit 127
fi

# Forward all args after rewriting absolute test paths to the mounted /test
# guest path. The harness passes paths like /Users/.../test/parallel/foo.js;
# inside the wasm those need to be /test/parallel/foo.js.
args=()
for arg in "$@"; do
  if [[ "$arg" == "${TEST_ROOT}"/* ]]; then
    args+=("/test/${arg#${TEST_ROOT}/}")
  else
    args+=("$arg")
  fi
done

exec "${NAPI_WASMER}" "${EDGE_WASM}" --mount "${TEST_ROOT}:/test" -- "${args[@]}"
