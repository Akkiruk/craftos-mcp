#!/usr/bin/env bash
# Configure (first run) and build the engine on Linux with GCC/Clang + Ninja + vcpkg (x64-linux).
# Needs cmake (3.21+), ninja, a C++17 compiler and a vcpkg checkout: set CRAFTOS_VCPKG or VCPKG_ROOT to it.
# vcpkg builds SDL2 and friends from source, which needs some system packages first. On Debian/Ubuntu:
#   sudo apt install build-essential cmake ninja-build pkg-config curl zip unzip tar git \
#     autoconf autoconf-archive automake libtool bison python3-venv python3-jinja2 linux-libc-dev \
#     libx11-dev libxft-dev libxext-dev libxrandr-dev libxi-dev libxcursor-dev libxss-dev libxtst-dev \
#     libwayland-dev libxkbcommon-dev libegl1-mesa-dev libibus-1.0-dev libltdl-dev
# Extra arguments go to "cmake --build". CRAFTOS_BUILD_DIR overrides the build directory (default engine/build).
set -euo pipefail
E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${CRAFTOS_BUILD_DIR:-$E/build}"

if [ ! -f "$BUILD_DIR/build.ninja" ]; then
  VCPKG="${CRAFTOS_VCPKG:-${VCPKG_ROOT:-}}"
  if [ -z "$VCPKG" ] || [ ! -f "$VCPKG/scripts/buildsystems/vcpkg.cmake" ]; then
    echo "build.sh: no vcpkg at '$VCPKG'" >&2
    echo "  Clone and bootstrap it: git clone https://github.com/microsoft/vcpkg && vcpkg/bootstrap-vcpkg.sh" >&2
    echo "  then set CRAFTOS_VCPKG or VCPKG_ROOT to that folder and run build.sh again." >&2
    exit 1
  fi
  # The first configure installs the packages from vcpkg.json into engine/vcpkg_installed; later ones reuse them.
  MANIFEST_INSTALL=ON
  [ -d "$E/vcpkg_installed/x64-linux/share" ] && MANIFEST_INSTALL=OFF
  cmake -S "$E" -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    "-DCMAKE_TOOLCHAIN_FILE=$VCPKG/scripts/buildsystems/vcpkg.cmake" \
    "-DVCPKG_MANIFEST_INSTALL=$MANIFEST_INSTALL" \
    "-DVCPKG_INSTALLED_DIR=$E/vcpkg_installed" \
    -DVCPKG_TARGET_TRIPLET=x64-linux
fi
cmake --build "$BUILD_DIR" "$@"
