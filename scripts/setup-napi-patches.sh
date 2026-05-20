#!/usr/bin/env bash
# Apply local edgejs mods on top of the pinned napi/ submodule commit.
# Run after `git submodule update --init` or whenever the submodule is reset.
#
# Patches live in patches/napi/*.patch.  They are generated from the working
# tree via:  cd napi && git diff HEAD -- . > ../patches/napi/0001-*.patch
#
# Pinned upstream commit: 1bcbf131187cb165053c615f6171eb58512b8014
# Local mods include:
#   - --trace-wasi flag + JsonlTraceLayer (src/bin/napi_wasmer.rs, src/cli/)
#   - permissive NapiVersion::is_compatible_with (src/lib.rs)
#   - namespace merge + structured_clone 3-arg adapter + compile_function CJS
#     adapter (src/guest/napi.rs)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAPI="$ROOT/napi"
PATCHES="$ROOT/patches/napi"

if [[ ! -d "$NAPI/.git" && ! -f "$NAPI/.git" ]]; then
  echo "error: $NAPI is not a git checkout (did you run \`git submodule update --init\`?)" >&2
  exit 1
fi

pushd "$NAPI" >/dev/null

# Refuse to apply on top of a dirty tree — would conflict with existing edits.
if ! git diff --quiet HEAD || ! git diff --cached --quiet; then
  echo "error: napi/ has uncommitted changes — clean it first or skip this script" >&2
  exit 1
fi

for patch in "$PATCHES"/*.patch; do
  echo "applying $(basename "$patch")"
  git apply --index "$patch"
done

popd >/dev/null
echo "done — napi/ has local edgejs mods applied."
