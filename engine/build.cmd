@echo off
setlocal
rem Configure (first run) and build the engine with MSVC + Ninja + vcpkg (x64-windows).
rem Needs Visual Studio 2022 or newer (any edition, with the "Desktop development with C++" workload), CMake and Ninja
rem (both come with that workload), and a vcpkg checkout: set CRAFTOS_VCPKG or VCPKG_ROOT to it.
rem Extra arguments go to "cmake --build". CRAFTOS_BUILD_DIR overrides the build directory (default engine\build).
set "E=%~dp0"
if not defined CRAFTOS_BUILD_DIR set "CRAFTOS_BUILD_DIR=%E%build"
rem vcvars points VCPKG_ROOT at Visual Studio's own read-only vcpkg, so remember the caller's first.
set "USER_VCPKG_ROOT=%VCPKG_ROOT%"

rem MSVC: use the current developer prompt if there is one, otherwise find Visual Studio with vswhere.
where cl.exe >nul 2>&1 && goto msvc_ready
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo build.cmd: vswhere.exe not found; install Visual Studio 2022 with the C++ workload 1>&2
  exit /b 1
)
set "VSDIR="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -version 17.0 -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
  echo build.cmd: no Visual Studio 2022+ with the x64 C++ tools found; add the "Desktop development with C++" workload 1>&2
  exit /b 1
)
rem vcvars looks for vswhere on PATH itself.
set "PATH=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer;%PATH%"
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
:msvc_ready

if exist "%CRAFTOS_BUILD_DIR%\build.ninja" goto build

rem vcpkg: CRAFTOS_VCPKG, then VCPKG_ROOT (unless it is the copy bundled with Visual Studio, which cannot install
rem packages for this manifest).
if defined USER_VCPKG_ROOT if exist "%USER_VCPKG_ROOT%\vcpkg-bundle.json" set "USER_VCPKG_ROOT="
if not defined CRAFTOS_VCPKG if defined USER_VCPKG_ROOT set "CRAFTOS_VCPKG=%USER_VCPKG_ROOT%"
if not defined CRAFTOS_VCPKG (
  echo build.cmd: no vcpkg; set CRAFTOS_VCPKG or VCPKG_ROOT to a vcpkg checkout 1>&2
  echo   Get one with: git clone https://github.com/microsoft/vcpkg ^&^& vcpkg\bootstrap-vcpkg.bat 1>&2
  exit /b 1
)
if not exist "%CRAFTOS_VCPKG%\scripts\buildsystems\vcpkg.cmake" (
  echo build.cmd: no vcpkg at "%CRAFTOS_VCPKG%" 1>&2
  echo   Clone and bootstrap it: git clone https://github.com/microsoft/vcpkg ^&^& vcpkg\bootstrap-vcpkg.bat 1>&2
  echo   then set CRAFTOS_VCPKG or VCPKG_ROOT to that folder and run build.cmd again. 1>&2
  exit /b 1
)
set "VCPKG_ROOT=%CRAFTOS_VCPKG%"
rem The first configure installs the packages from vcpkg.json into engine\vcpkg_installed; later ones reuse them.
set "MANIFEST_INSTALL=ON"
if exist "%E%vcpkg_installed\x64-windows\share" set "MANIFEST_INSTALL=OFF"
cmake -S "%E%." -B "%CRAFTOS_BUILD_DIR%" -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_TOOLCHAIN_FILE=%CRAFTOS_VCPKG%\scripts\buildsystems\vcpkg.cmake" -DVCPKG_MANIFEST_INSTALL=%MANIFEST_INSTALL% "-DVCPKG_INSTALLED_DIR=%E%vcpkg_installed" -DVCPKG_TARGET_TRIPLET=x64-windows || exit /b 1
:build
cmake --build "%CRAFTOS_BUILD_DIR%" %*
