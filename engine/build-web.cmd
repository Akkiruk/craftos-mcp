@echo off
setlocal
rem Build the browser engine (WebAssembly, Emscripten) into engine\build-web, the same way every time:
rem   1. emsdk pinned to EMSDK_VERSION below: installed and activated in %EMSDK% when it holds another version
rem      (EMSDK defaults to %USERPROFILE%\emsdk; get it with: git clone https://github.com/emscripten-core/emsdk).
rem   2. Poco 1.15.4 for wasm32 (Foundation, JSON, Net), built once into <build dir>\poco: engine\web\poco.cmake
rem      downloads it, checks its sha256 and applies the two Emscripten patches. POCO_WEB_PREFIX skips this and uses
rem      an install you made yourself.
rem   3. The engine (engine\web\web.cmake): <build dir>\craftos.js and craftos.wasm.
rem Then "node web\build-runtime.mjs" copies them, the ROM and the font into web\dist\runtime.
rem Needs CMake and Ninja on PATH. Extra arguments go to "cmake --build". CRAFTOS_WEB_BUILD_DIR overrides the build dir.
set "EMSDK_VERSION=7.0.0"
set "E=%~dp0"
if not defined CRAFTOS_WEB_BUILD_DIR set "CRAFTOS_WEB_BUILD_DIR=%E%build-web"
if not defined EMSDK set "EMSDK=%USERPROFILE%\emsdk"
if not exist "%EMSDK%\emsdk.bat" (
  echo build-web.cmd: no emsdk at "%EMSDK%"; clone https://github.com/emscripten-core/emsdk there or set EMSDK 1>&2
  exit /b 1
)
findstr /c:"%EMSDK_VERSION%" "%EMSDK%\upstream\emscripten\emscripten-version.txt" >nul 2>nul
if errorlevel 1 (
  echo build-web.cmd: installing emsdk %EMSDK_VERSION% into "%EMSDK%"
  call "%EMSDK%\emsdk.bat" install %EMSDK_VERSION% || exit /b 1
  call "%EMSDK%\emsdk.bat" activate %EMSDK_VERSION% || exit /b 1
)
findstr /c:"%EMSDK_VERSION%" "%EMSDK%\upstream\emscripten\emscripten-version.txt" >nul 2>nul
if errorlevel 1 (
  echo build-web.cmd: emsdk at "%EMSDK%" is not %EMSDK_VERSION% 1>&2
  exit /b 1
)
set "EM_CONFIG=%EMSDK%\.emscripten"
set "PATH=%EMSDK%\upstream\emscripten;%PATH%"
for /d %%n in ("%EMSDK%\node\*") do set "PATH=%%n\bin;%PATH%"
for /d %%p in ("%EMSDK%\python\*") do set "PATH=%%p;%PATH%"

if defined POCO_WEB_PREFIX goto engine
set "POCO_DIR=%CRAFTOS_WEB_BUILD_DIR%\poco"
set "POCO_WEB_PREFIX=%POCO_DIR%\install"
if exist "%POCO_WEB_PREFIX%\lib\libPocoFoundation.a" goto engine
cmake "-DOUT=%POCO_DIR%" -P "%E%web\poco.cmake" || exit /b 1
call emcmake cmake -S "%POCO_DIR%\src" -B "%POCO_DIR%\build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF "-DCMAKE_INSTALL_PREFIX=%POCO_WEB_PREFIX%" "-DCMAKE_C_FLAGS=-pthread -fwasm-exceptions -DPOCO_NO_INOTIFY" "-DCMAKE_CXX_FLAGS=-pthread -fwasm-exceptions -DPOCO_NO_INOTIFY" -DPOCO_UNBUNDLED=OFF -DENABLE_FOUNDATION=ON -DENABLE_JSON=ON -DENABLE_NET=ON -DENABLE_XML=OFF -DENABLE_UTIL=OFF -DENABLE_NETSSL=OFF -DENABLE_NETSSL_WIN=OFF -DENABLE_CRYPTO=OFF -DENABLE_JWT=OFF -DENABLE_DATA=OFF -DENABLE_DATA_SQLITE=OFF -DENABLE_DATA_MYSQL=OFF -DENABLE_DATA_POSTGRESQL=OFF -DENABLE_DATA_ODBC=OFF -DENABLE_MONGODB=OFF -DENABLE_REDIS=OFF -DENABLE_PDF=OFF -DENABLE_ZIP=OFF -DENABLE_SEVENZIP=OFF -DENABLE_APACHECONNECTOR=OFF -DENABLE_CPPPARSER=OFF -DENABLE_ENCODINGS=OFF -DENABLE_PAGECOMPILER=OFF -DENABLE_PAGECOMPILER_FILE2PAGE=OFF -DENABLE_POCODOC=OFF -DENABLE_PROMETHEUS=OFF -DENABLE_ACTIVERECORD=OFF -DENABLE_ACTIVERECORD_COMPILER=OFF -DENABLE_DNSSD=OFF -DENABLE_TESTS=OFF -DENABLE_SAMPLES=OFF -DENABLE_BENCHMARK=OFF -DENABLE_FASTLOGGER=OFF -DENABLE_TRACE=OFF || exit /b 1
cmake --build "%POCO_DIR%\build" || exit /b 1
cmake --install "%POCO_DIR%\build" || exit /b 1

:engine
if exist "%CRAFTOS_WEB_BUILD_DIR%\build.ninja" goto build
call emcmake cmake -S "%E%." -B "%CRAFTOS_WEB_BUILD_DIR%" -G Ninja -DCMAKE_BUILD_TYPE=Release "-DPOCO_WEB_PREFIX=%POCO_WEB_PREFIX%" || exit /b 1
:build
cmake --build "%CRAFTOS_WEB_BUILD_DIR%" %*
