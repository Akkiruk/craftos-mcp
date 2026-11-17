#!/usr/bin/env bash
# Build the browser engine (WebAssembly, Emscripten) into engine/build-web: engine\build-web.cmd for Linux and macOS
# (the VS Code extension's publish workflow runs it on ubuntu-latest).
#   1. emsdk pinned to EMSDK_VERSION below: installed and activated in $EMSDK when it holds another version
#      (EMSDK defaults to ~/emsdk; get it with: git clone https://github.com/emscripten-core/emsdk). An emsdk that
#      is already on PATH at that version (EMSDK set by emsdk_env.sh or a CI action) is used as it is.
#   2. Poco 1.15.4 for wasm32 (Foundation, JSON, Net), built once into <build dir>/poco: engine/web/poco.cmake
#      downloads it, checks its sha256 and applies the two Emscripten patches. POCO_WEB_PREFIX skips this and uses
#      an install you made yourself.
#   3. The engine (engine/web/web.cmake): <build dir>/craftos.js and craftos.wasm.
# Then "node web/build-runtime.mjs" copies them, the ROM and the font into web/dist/runtime, and the VS Code
# extension's build (apps/vscode/web-assets.mjs) takes them from CRAFTOS_WEB_BUILD_DIR or engine/build-web.
# Needs cmake (3.21+), ninja and git. Extra arguments go to "cmake --build". CRAFTOS_WEB_BUILD_DIR overrides the
# build dir.
set -euo pipefail
EMSDK_VERSION=7.0.0
E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${CRAFTOS_WEB_BUILD_DIR:-$E/build-web}"
EMSDK="${EMSDK:-$HOME/emsdk}"

if [ ! -x "$EMSDK/emsdk" ]; then
  echo "build-web.sh: no emsdk at '$EMSDK'; clone https://github.com/emscripten-core/emsdk there or set EMSDK" >&2
  exit 1
fi
version_file="$EMSDK/upstream/emscripten/emscripten-version.txt"
if ! grep -q "$EMSDK_VERSION" "$version_file" 2>/dev/null; then
  echo "build-web.sh: installing emsdk $EMSDK_VERSION into '$EMSDK'"
  "$EMSDK/emsdk" install "$EMSDK_VERSION"
  "$EMSDK/emsdk" activate "$EMSDK_VERSION"
fi
if ! grep -q "$EMSDK_VERSION" "$version_file" 2>/dev/null; then
  echo "build-web.sh: emsdk at '$EMSDK' is not $EMSDK_VERSION" >&2
  exit 1
fi
# shellcheck disable=SC1091
EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh"

FLAGS="-pthread -fwasm-exceptions -DPOCO_NO_INOTIFY"
if [ -z "${POCO_WEB_PREFIX:-}" ]; then
  POCO_DIR="$BUILD_DIR/poco"
  POCO_WEB_PREFIX="$POCO_DIR/install"
  if [ ! -f "$POCO_WEB_PREFIX/lib/libPocoFoundation.a" ]; then
    cmake "-DOUT=$POCO_DIR" -P "$E/web/poco.cmake"
    emcmake cmake -S "$POCO_DIR/src" -B "$POCO_DIR/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF "-DCMAKE_INSTALL_PREFIX=$POCO_WEB_PREFIX" \
      "-DCMAKE_C_FLAGS=$FLAGS" "-DCMAKE_CXX_FLAGS=$FLAGS" -DPOCO_UNBUNDLED=OFF \
      -DENABLE_FOUNDATION=ON -DENABLE_JSON=ON -DENABLE_NET=ON -DENABLE_XML=OFF -DENABLE_UTIL=OFF \
      -DENABLE_NETSSL=OFF -DENABLE_NETSSL_WIN=OFF -DENABLE_CRYPTO=OFF -DENABLE_JWT=OFF -DENABLE_DATA=OFF \
      -DENABLE_DATA_SQLITE=OFF -DENABLE_DATA_MYSQL=OFF -DENABLE_DATA_POSTGRESQL=OFF -DENABLE_DATA_ODBC=OFF \
      -DENABLE_MONGODB=OFF -DENABLE_REDIS=OFF -DENABLE_PDF=OFF -DENABLE_ZIP=OFF -DENABLE_SEVENZIP=OFF \
      -DENABLE_APACHECONNECTOR=OFF -DENABLE_CPPPARSER=OFF -DENABLE_ENCODINGS=OFF -DENABLE_PAGECOMPILER=OFF \
      -DENABLE_PAGECOMPILER_FILE2PAGE=OFF -DENABLE_POCODOC=OFF -DENABLE_PROMETHEUS=OFF -DENABLE_ACTIVERECORD=OFF \
      -DENABLE_ACTIVERECORD_COMPILER=OFF -DENABLE_DNSSD=OFF -DENABLE_TESTS=OFF -DENABLE_SAMPLES=OFF \
      -DENABLE_BENCHMARK=OFF -DENABLE_FASTLOGGER=OFF -DENABLE_TRACE=OFF
    cmake --build "$POCO_DIR/build"
    cmake --install "$POCO_DIR/build"
  fi
fi

if [ ! -f "$BUILD_DIR/build.ninja" ]; then
  emcmake cmake -S "$E" -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release "-DPOCO_WEB_PREFIX=$POCO_WEB_PREFIX"
fi
cmake --build "$BUILD_DIR" "$@"
