# vcpkg's own arm64-osx triplet, plus: a fixed oldest macOS (otherwise the binary needs the build machine's version
# or newer) and release builds only (the debug half doubles the build time and is never linked).
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_OSX_ARCHITECTURES arm64)
set(VCPKG_OSX_DEPLOYMENT_TARGET 11.0)
set(VCPKG_BUILD_TYPE release)
