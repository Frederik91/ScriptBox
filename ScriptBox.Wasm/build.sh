#!/bin/bash
# Builds the two guest artifacts from scriptbox_wrapper.c and the QuickJS
# revision pinned in toolchain.env, and records their digests in
# artifacts.json:
#
#   scriptbox.wasm        ABI 1, synchronous host calls (.NET host)
#   scriptbox-async.wasm  ABI 2, posted host calls and imported memory (Node host)
#
# docker-build.sh runs this in the pinned container, which is the supported way
# to produce artifacts that match the committed digests. Running it directly
# needs WASI_SDK_PATH (WASI SDK 28) and QUICKJS_DIR (a QuickJS clone that
# contains the pinned commit).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"

# shellcheck source=toolchain.env
source "${SCRIPT_DIR}/toolchain.env"

WASI_SDK_PATH="${WASI_SDK_PATH:-}"
QUICKJS_DIR="${QUICKJS_DIR:-${SCRIPT_DIR}/quickjs}"
CLANG="${WASI_SDK_PATH}/bin/clang"

if [ ! -x "${CLANG}" ]; then
    echo "clang not found at '${CLANG}'. Set WASI_SDK_PATH to WASI SDK ${WASI_SDK_VERSION}, or use docker-build.sh." >&2
    exit 1
fi

if ! git -C "${QUICKJS_DIR}" cat-file -e "${QUICKJS_COMMIT}^{commit}" 2>/dev/null; then
    echo "QuickJS commit ${QUICKJS_COMMIT} is not in '${QUICKJS_DIR}'. Clone ${QUICKJS_REPO} there, or use docker-build.sh." >&2
    exit 1
fi

# Build from a clean export of the pinned commit, so local edits to the clone
# never reach an artifact.
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}/quickjs"
git -C "${QUICKJS_DIR}" archive "${QUICKJS_COMMIT}" | tar -x -C "${BUILD_DIR}/quickjs"
QJS="${BUILD_DIR}/quickjs"

# Two edits to quickjs.c, both checked:
# - QuickJS's default allocator reports a usable size of 0 on WASI, as in
#   every artifact before this script pinned its inputs. The async guest
#   brings its own allocator (scriptbox_wrapper.c) and is not affected.
# - CONFIG_VERSION is normally defined by QuickJS's Makefile.
sed -i 's|^#elif defined(_WIN32)$|#elif defined(__wasi__)\n    return 0;\n&|' "${QJS}/quickjs.c"
sed -i 's/fprintf(fp, "QuickJS memory usage -- " CONFIG_VERSION " version,/fprintf(fp, "QuickJS memory usage -- version,/' "${QJS}/quickjs.c"
if [ "$(grep -c '^#elif defined(__wasi__)$' "${QJS}/quickjs.c")" != "1" ] || grep -q 'CONFIG_VERSION " version' "${QJS}/quickjs.c"; then
    echo "The QuickJS edits did not apply as expected; check them against commit ${QUICKJS_COMMIT}." >&2
    exit 1
fi

# -O2 matters: QuickJS is an interpreter, so its speed is the script's speed.
# The 8 MB stack is what sb_init's JS_SetMaxStackSize is sized against.
# The prefix maps keep build paths out of the artifacts.
COMMON_FLAGS=(
    --target=wasm32-wasi
    -I "${QJS}"
    -O2
    -Wall
    -Wno-error=implicit-function-declaration
    -Wno-error=format
    -Wno-format-pedantic
    -mllvm -wasm-enable-sjlj
    -D_WASI_EMULATED_MMAN
    -D_WASI_EMULATED_SIGNAL
    -D_WASI_EMULATED_GETPID
    "-ffile-prefix-map=${BUILD_DIR}=/scriptbox"
    "-ffile-prefix-map=${SCRIPT_DIR}=/scriptbox"
    "${QJS}/quickjs.c"
    "${QJS}/libregexp.c"
    "${QJS}/libunicode.c"
    "${QJS}/cutils.c"
    "${QJS}/dtoa.c"
    "${SCRIPT_DIR}/scriptbox_wrapper.c"
    -Wl,-z,stack-size=8388608
    -Wl,--no-entry
    -Wl,--strip-all
)

# The async guest imports its memory so the host can set the maximum. 16 MiB
# covers the 8 MB stack and static data; artifacts.json records it.
ASYNC_INITIAL_MEMORY=16777216

echo "Building scriptbox.wasm (ABI 1)"
"${CLANG}" "${COMMON_FLAGS[@]}" -o "${SCRIPT_DIR}/scriptbox.wasm"

echo "Building scriptbox-async.wasm (ABI 2)"
"${CLANG}" "${COMMON_FLAGS[@]}" \
    -DSB_ASYNC_HOST \
    -Wl,--import-memory \
    "-Wl,--initial-memory=${ASYNC_INITIAL_MEMORY}" \
    -o "${SCRIPT_DIR}/scriptbox-async.wasm"

SYNC_SHA="$(sha256sum "${SCRIPT_DIR}/scriptbox.wasm" | cut -d' ' -f1)"
ASYNC_SHA="$(sha256sum "${SCRIPT_DIR}/scriptbox-async.wasm" | cut -d' ' -f1)"
WRAPPER_SHA="$(sha256sum "${SCRIPT_DIR}/scriptbox_wrapper.c" | cut -d' ' -f1)"

cat > "${SCRIPT_DIR}/artifacts.json" <<EOF
{
  "quickjs": {
    "repository": "${QUICKJS_REPO}",
    "commit": "${QUICKJS_COMMIT}"
  },
  "wasiSdk": "${WASI_SDK_VERSION}",
  "wrapperSha256": "${WRAPPER_SHA}",
  "artifacts": {
    "scriptbox.wasm": {
      "abi": 1,
      "sha256": "${SYNC_SHA}"
    },
    "scriptbox-async.wasm": {
      "abi": 2,
      "sha256": "${ASYNC_SHA}",
      "initialMemoryBytes": ${ASYNC_INITIAL_MEMORY}
    }
  }
}
EOF

echo "scriptbox.wasm        ${SYNC_SHA}"
echo "scriptbox-async.wasm  ${ASYNC_SHA}"
