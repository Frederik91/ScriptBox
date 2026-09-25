#!/bin/bash

# QuickJS WASM Module Build Script
# Compiles QuickJS + scriptbox_wrapper.c to WebAssembly

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
OUTPUT="${SCRIPT_DIR}/scriptbox.wasm"

echo "=========================================="
echo "QuickJS WASM Module Builder"
echo "=========================================="

# Configuration
# Try multiple possible SDK locations in order of preference
WASI_SDK_PATH="${WASI_SDK_PATH:-}"
if [ -z "$WASI_SDK_PATH" ]; then
    if [ -d "${HOME}/Downloads/wasi-sdk-28.0-arm64-macos" ]; then
        WASI_SDK_PATH="${HOME}/Downloads/wasi-sdk-28.0-arm64-macos"
    elif [ -d "${HOME}/wasi-sdk-28.0" ]; then
        WASI_SDK_PATH="${HOME}/wasi-sdk-28.0"
    elif [ -d "${HOME}/wasi-sdk-20.0" ]; then
        WASI_SDK_PATH="${HOME}/wasi-sdk-20.0"
    fi
fi

QUICKJS_REPO="${QUICKJS_REPO:-https://github.com/bellard/quickjs.git}"
QUICKJS_DIR="${SCRIPT_DIR}/quickjs"

# Check for WASI SDK
if [ ! -d "$WASI_SDK_PATH" ]; then
    echo "❌ WASI SDK not found at: $WASI_SDK_PATH"
    echo ""
    echo "Please download WASI SDK 28 from:"
    echo "  https://github.com/WebAssembly/wasi-sdk/releases/tag/v28.0"
    echo ""
    echo "For macOS ARM64, download:"
    echo "  https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-28/wasi-sdk-28.0-arm64-macos.tar.gz"
    echo ""
    echo "For macOS x86-64, download:"
    echo "  https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-28/wasi-sdk-28.0-x86_64-macos.tar.gz"
    echo ""
    echo "For Linux x86-64, download:"
    echo "  https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-28/wasi-sdk-28.0-x86_64-linux.tar.gz"
    echo ""
    echo "For Linux ARM64, download:"
    echo "  https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-28/wasi-sdk-28.0-arm64-linux.tar.gz"
    echo ""
    echo "Then extract and set WASI_SDK_PATH:"
    echo "  export WASI_SDK_PATH=/path/to/wasi-sdk-28.0"
    echo ""
    exit 1
fi

CLANG="${WASI_SDK_PATH}/bin/clang"
if [ ! -f "$CLANG" ]; then
    echo "❌ clang not found at: $CLANG"
    exit 1
fi

echo "✓ WASI SDK found at: $WASI_SDK_PATH"
echo "✓ Using clang: $CLANG"

# On macOS, remove quarantine attribute if present
if command -v xattr &> /dev/null; then
    if xattr "$CLANG" 2>/dev/null | grep -q "com.apple.quarantine"; then
        echo "🔓 Removing quarantine attribute from clang..."
        xattr -d com.apple.quarantine "$CLANG" 2>/dev/null || true
    fi
fi

# On macOS, remove quarantine attribute and fix code signatures for entire SDK
if [[ "$OSTYPE" == "darwin"* ]] && command -v xattr &> /dev/null; then
    echo "🔓 Preparing WASI SDK for execution on macOS..."
    
    # Recursively remove quarantine from all files
    echo "   Removing quarantine attributes from all SDK files..."
    find "$WASI_SDK_PATH" -type f -print0 2>/dev/null | xargs -0 xattr -d com.apple.quarantine 2>/dev/null || true
    
    # Ad-hoc sign dylib and executable files to fix code signature issues
    if command -v codesign &> /dev/null; then
        echo "   Ad-hoc signing dynamic libraries and executables..."
        find "$WASI_SDK_PATH/lib" -type f -name "*.dylib" -print0 2>/dev/null | xargs -0 codesign -s - 2>/dev/null || true
        find "$WASI_SDK_PATH/bin" -type f ! -name "*.a" -print0 2>/dev/null | xargs -0 codesign -s - 2>/dev/null || true
    fi
    
    echo "   ✓ macOS SDK preparation complete"
fi
if [ ! -d "$QUICKJS_DIR" ]; then
    echo ""
    echo "📥 Cloning QuickJS from: $QUICKJS_REPO"
    git clone "$QUICKJS_REPO" "$QUICKJS_DIR"
else
    echo "✓ QuickJS source found at: $QUICKJS_DIR"
fi

# Apply manual fixes to QuickJS for WASI compatibility
# These fixes replace the unreliable patch file with direct sed edits
echo "🔧 Applying WASI compatibility fixes..."
cd "$QUICKJS_DIR"

# Fix 1: Add __wasi__ conditional to js_def_malloc_usable_size
# This prevents WASI builds from trying to use platform-specific malloc_size functions
if ! grep -q "__wasi__" quickjs.c; then
    # Use sed to find the _WIN32 section and add __wasi__ case after it
    # Note: Using printf for cross-platform newline handling
    sed -i.bak '/#elif defined(_WIN32)/i\
#elif defined(__wasi__)\
    return 0;' quickjs.c || true
fi

# Fix 2: Fix the CONFIG_VERSION string concatenation issue
# The issue is: fprintf(fp, "QuickJS memory usage -- " CONFIG_VERSION " version, ...
# This fails because CONFIG_VERSION is a macro and can't be stringified inline
# Replace with a simpler format string that doesn't try to embed the macro
sed -i 's/fprintf(fp, "QuickJS memory usage -- " CONFIG_VERSION " version,/fprintf(fp, "QuickJS memory usage -- version,/g' quickjs.c || true

# Clean up backup files from sed
rm -f quickjs.c.bak

cd - > /dev/null

# Create build directory
mkdir -p "$BUILD_DIR"

echo ""
echo "🔨 Compiling QuickJS + scriptbox_wrapper.c to WASM..."
echo ""

# -O2 matters: QuickJS is an interpreter, so its speed is the script's speed.
# The 8 MB stack is what sb_init's JS_SetMaxStackSize is sized against.
$CLANG \
    --target=wasm32-wasi \
    -I "$QUICKJS_DIR" \
    -I "$WASI_SDK_PATH/include" \
    -O2 \
    -Wall \
    -Wno-error=implicit-function-declaration \
    -Wno-error=format \
    -Wno-format-pedantic \
    -mllvm -wasm-enable-sjlj \
    -D_WASI_EMULATED_MMAN \
    -D_WASI_EMULATED_SIGNAL \
    -D_WASI_EMULATED_GETPID \
    "$QUICKJS_DIR/quickjs.c" \
    "$QUICKJS_DIR/libregexp.c" \
    "$QUICKJS_DIR/libunicode.c" \
    "$QUICKJS_DIR/cutils.c" \
    "$QUICKJS_DIR/dtoa.c" \
    "$SCRIPT_DIR/scriptbox_wrapper.c" \
    -o "$OUTPUT" \
    -Wl,--export=sb_init \
    -Wl,--export=sb_eval \
    -Wl,--export=sb_alloc \
    -Wl,--export=sb_free \
    -Wl,-z,stack-size=8388608 \
    -Wl,--no-entry \
    -Wl,--strip-all

if [ $? -eq 0 ]; then
    SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT" 2>/dev/null)
    SIZE_KB=$((SIZE / 1024))
    echo ""
    echo "✅ Build successful!"
    echo "📦 Output: $OUTPUT"
    echo "📊 Size: ${SIZE_KB}KB"
    echo "🔧 WASI SDK: $WASI_SDK_PATH"
    echo ""
    echo "Next step: dotnet test ScriptBox.sln"
else
    echo ""
    echo "❌ Build failed!"
    exit 1
fi
