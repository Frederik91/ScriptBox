#!/bin/bash
# Builds both guest artifacts in the pinned container and writes them, with
# artifacts.json, into ScriptBox.Wasm. Needs only Docker with Linux containers.
#
#   bash ScriptBox.Wasm/docker-build.sh
#
# Set DOCKER to choose the client command, e.g. DOCKER="docker --context desktop-linux".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOCKER="${DOCKER:-docker}"

# shellcheck source=toolchain.env
source "${SCRIPT_DIR}/toolchain.env"

IMAGE="scriptbox-wasm-build:quickjs-${QUICKJS_COMMIT:0:12}-wasi-${WASI_SDK_VERSION}"

${DOCKER} build \
    --build-arg "BUILD_IMAGE=${BUILD_IMAGE}" \
    --build-arg "WASI_SDK_URL=${WASI_SDK_URL}" \
    --build-arg "WASI_SDK_SHA256=${WASI_SDK_SHA256}" \
    --build-arg "QUICKJS_REPO=${QUICKJS_REPO}" \
    --build-arg "QUICKJS_COMMIT=${QUICKJS_COMMIT}" \
    -t "${IMAGE}" \
    -f "${SCRIPT_DIR}/Dockerfile" \
    "${SCRIPT_DIR}"

# Git Bash on Windows rewrites /src unless told not to.
MSYS_NO_PATHCONV=1 ${DOCKER} run --rm \
    --network none \
    -v "${REPO_DIR}:/src" \
    -w /src \
    "${IMAGE}" \
    bash ScriptBox.Wasm/build.sh
