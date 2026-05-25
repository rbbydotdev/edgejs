#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/build-wasix"
TOOLCHAIN_FILE="${PROJECT_ROOT}/wasix/wasix-toolchain.cmake"
OPENSSL_WASIX_DIR="${PROJECT_ROOT}/deps/openssl-wasix"

export WASIXCC_WASM_EXCEPTIONS="${WASIXCC_WASM_EXCEPTIONS:-yes}"

if ! command -v wasixcc >/dev/null 2>&1 && [[ -x "${HOME}/.wasixcc/bin/wasixcc" ]]; then
  export PATH="${HOME}/.wasixcc/bin:${PATH}"
fi

# Cross-building to WASIX must not inherit host include/link search paths from
# the shell environment, or CMake will persist them into linker flags.
for host_toolchain_var in \
  CPPFLAGS \
  LDFLAGS \
  LIBRARY_PATH \
  CPATH \
  C_INCLUDE_PATH \
  CPLUS_INCLUDE_PATH \
  OBJC_INCLUDE_PATH \
  SDKROOT
do
  unset "${host_toolchain_var}" || true
done
unset host_toolchain_var

optimize_wasm() {
  local input="$1"
  local output="$2"
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt --emit-exnref -o "${output}" "${input}"
    return
  fi
  echo "warning: wasm-opt not found in PATH; copying ${input} to ${output}" >&2
  cp "${input}" "${output}"
}

if [[ "${SKIP_DEPS_UPDATE:-0}" == "1" ]]; then
  echo "SKIP_DEPS_UPDATE=1: skipping wasix/setup-wasix-deps.sh"
elif [[ -d "${PROJECT_ROOT}/deps/libuv-wasix/.git" && -d "${PROJECT_ROOT}/deps/openssl-wasix/.git" ]]; then
  # Deps already present — skip the fetch/checkout dance. The setup script
  # tries `git remote set-url ... https://...` then `git fetch`, but a
  # global `url.git@github.com:.insteadof https://github.com/` rewrite in
  # the user's gitconfig silently undoes the HTTPS switch, causing SSH
  # auth failures. If you actually need to update deps, run the setup
  # script directly with SKIP_DEPS_UPDATE unset and ensure SSH is set up.
  echo "Deps already present at ${PROJECT_ROOT}/deps/{libuv-wasix,openssl-wasix} — skipping setup. Set SKIP_DEPS_UPDATE=0 to force."
else
  "${PROJECT_ROOT}/wasix/setup-wasix-deps.sh"
fi

if [[ -f "${BUILD_DIR}/CMakeCache.txt" ]]; then
  rm -f "${BUILD_DIR}/CMakeCache.txt"
fi
if [[ -d "${BUILD_DIR}/CMakeFiles" ]]; then
  rm -rf "${BUILD_DIR}/CMakeFiles"
fi

if [[ ! -f "${OPENSSL_WASIX_DIR}/libcrypto.a" || ! -f "${OPENSSL_WASIX_DIR}/libssl.a" ]]; then
  echo "Building OpenSSL static libraries for WASIX..."
  (
    cd "${OPENSSL_WASIX_DIR}"
    make distclean >/dev/null 2>&1 || true
    CC=wasixcc \
    CXX=wasixcc++ \
    AR=wasixar \
    RANLIB=wasixranlib \
    NM=wasixnm \
    LD=wasixld \
    CFLAGS="--target=wasm32-wasix -matomics -mbulk-memory -mmutable-globals -pthread -mthread-model posix -ftls-model=local-exec -fno-trapping-math -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -DUSE_TIMEGM -DOPENSSL_NO_SECURE_MEMORY -DOPENSSL_NO_DGRAM -DOPENSSL_THREADS -O2" \
    LDFLAGS="-Wl,--allow-undefined" \
    ./Configure linux-generic32 -static no-shared no-pic no-asm no-tests no-apps no-afalgeng -DUSE_TIMEGM -DOPENSSL_NO_SECURE_MEMORY -DOPENSSL_NO_DGRAM -DOPENSSL_THREADS
    make build_generated
    make -j4 libcrypto.a libssl.a
    wasixranlib libcrypto.a || true
    wasixranlib libssl.a || true
  )
fi

cmake \
  -S "${PROJECT_ROOT}" \
  -B "${BUILD_DIR}" \
  -U CMAKE_C_FLAGS \
  -U CMAKE_CXX_FLAGS \
  -U CMAKE_EXE_LINKER_FLAGS \
  -U CMAKE_SHARED_LINKER_FLAGS \
  -U CMAKE_MODULE_LINKER_FLAGS \
  -DCMAKE_TOOLCHAIN_FILE="${TOOLCHAIN_FILE}" \
  -DEDGE_NAPI_PROVIDER=imports \
  -DEDGE_BUILD_CLI=ON \
  -DBUILD_TESTING=OFF

cmake --build "${BUILD_DIR}" -j4

if [[ -f "${BUILD_DIR}/edge" ]]; then
  optimize_wasm "${BUILD_DIR}/edge" "${BUILD_DIR}/edge.wasm"
  cp "${BUILD_DIR}/edge.wasm" "${BUILD_DIR}/edgejs.wasm"
elif [[ -f "${BUILD_DIR}/ubi" ]]; then
  optimize_wasm "${BUILD_DIR}/ubi" "${BUILD_DIR}/edgejs.wasm"
  cp "${BUILD_DIR}/edgejs.wasm" "${BUILD_DIR}/edge.wasm"
else
  echo "error: expected ${BUILD_DIR}/edge or ${BUILD_DIR}/ubi after build" >&2
  exit 1
fi

cp "${BUILD_DIR}/edgejs.wasm" "${PROJECT_ROOT}/browser-target/edgejs.wasm"

echo "Built WASIX targets at ${BUILD_DIR}/edge.wasm and ${BUILD_DIR}/edgejs.wasm"
echo "Deployed to ${PROJECT_ROOT}/browser-target/edgejs.wasm (read by Vite/browser-test-runner)"
