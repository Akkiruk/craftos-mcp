# The browser build: the engine compiled to WebAssembly with Emscripten (engine/build-web.cmd builds it into
# engine/build-web). Included from CMakeLists.txt when EMSCRIPTEN is set; everything here is web-only.
#
# What is in: the whole engine with the raw renderer, talking the raw protocol to JavaScript instead of stdout/stdin
# (src/web/web_io.cpp). What is out: http and websockets (src/apis/http_emscripten.cpp is a stub), SDL windows (the
# SDL terminals are compiled but never chosen), the speaker's SDL_mixer, PNG/WebP screenshots, PDF printing.
#
# Threads: real pthreads (Web Workers over a SharedArrayBuffer), with main() proxied to a worker (PROXY_TO_PTHREAD),
# so the engine keeps its native threading: one thread per computer, the render thread, the raw input thread, and
# SDL's timer thread for the 7 s "too long without yielding" abort. The page must be cross-origin isolated
# (Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp).
#
# Poco: Foundation, JSON and Net built for wasm32 with -pthread -fwasm-exceptions; POCO_WEB_PREFIX points at the
# install. Net is only there for headers and IPAddress; nothing opens a socket. Recipe used for the spike (Poco 1.15.4,
# vcpkg's source tarball): emcmake cmake with BUILD_SHARED_LIBS=OFF, only ENABLE_FOUNDATION/JSON/NET on, C/CXX flags
# "-pthread -fwasm-exceptions -DPOCO_NO_INOTIFY", and two patches: Foundation/CMakeLists.txt defines
# POCO_HAVE_FD_POLL instead of POCO_HAVE_FD_EPOLL under EMSCRIPTEN, and Net/include/Poco/Net/Net.h skips its
# POCO_HAVE_FD_EPOLL define when POCO_EMSCRIPTEN is set (Emscripten has no epoll/eventfd).

if(NOT DEFINED POCO_WEB_PREFIX)
  message(FATAL_ERROR "web build: set POCO_WEB_PREFIX to a wasm32 Poco install (Foundation, JSON, Net)")
endif()

set(WEB_FLAGS -pthread -fwasm-exceptions -sSUPPORT_LONGJMP=wasm)

add_library(lua52 STATIC ${LUA_SOURCES})
target_include_directories(lua52 PUBLIC ${LUA_DIR}/include PRIVATE ${LUA_DIR}/src)
target_compile_definitions(lua52 PRIVATE LUA_COMPAT_UNPACK LUA_COMPAT_LOADSTRING LUA_COMPAT_LOG10 LUA_COMPAT_MAXN)
target_compile_options(lua52 PRIVATE ${WEB_FLAGS})

set(WEB_ENGINE_SOURCES
  src/Computer.cpp
  src/configuration.cpp
  src/favicon.c
  src/font.c
  src/gif.cpp
  src/main.cpp
  src/plugin.cpp
  src/runtime.cpp
  src/termsupport.cpp
  src/util.cpp
  src/platform.cpp
  src/apis/config.cpp
  src/apis/fs.cpp
  src/apis/handles/fs_handle.cpp
  src/apis/http.cpp
  src/apis/mounter.cpp
  src/apis/os.cpp
  src/apis/periphemu.cpp
  src/apis/peripheral.cpp
  src/apis/redstone.cpp
  src/apis/term.cpp
  src/mem/cluster.cpp
  src/peripheral/chest.cpp
  src/peripheral/computer_p.cpp
  src/peripheral/debug_adapter.cpp
  src/peripheral/debugger.cpp
  src/peripheral/drive.cpp
  src/peripheral/energy.cpp
  src/peripheral/modem.cpp
  src/peripheral/monitor.cpp
  src/peripheral/printer.cpp
  src/peripheral/speaker.cpp
  src/peripheral/speaker_sounds.cpp
  src/peripheral/tank.cpp
  src/terminal/HardwareSDLTerminal.cpp
  src/terminal/RawTerminal.cpp
  src/terminal/SDLTerminal.cpp
  src/terminal/TRoRTerminal.cpp
  src/web/web_io.cpp
)

add_executable(craftos ${WEB_ENGINE_SOURCES})
set_target_properties(craftos PROPERTIES SUFFIX ".js")

# web/include first: stand-ins for the NetSSL headers the shared sources include (there is no OpenSSL here)
target_include_directories(craftos PRIVATE web/include api ${POCO_WEB_PREFIX}/include)
target_compile_definitions(craftos PRIVATE
  CRAFTOS_WEB
  NO_CLI
  NO_MIXER
  NO_PNG
  NO_WEBP
  PRINT_TYPE=1
  POCO_STATIC
  POCO_NO_AUTOMATIC_LIBS
)
# api/Terminal.hpp uses std::fill without <algorithm>; libstdc++ brings it in by accident, Emscripten's libc++ does not
target_compile_options(craftos PRIVATE ${WEB_FLAGS} -sUSE_SDL=2 -Wno-deprecated-declarations
  "$<$<COMPILE_LANGUAGE:CXX>:SHELL:-include algorithm>")

target_link_libraries(craftos PRIVATE
  lua52
  ${POCO_WEB_PREFIX}/lib/libPocoNet.a
  ${POCO_WEB_PREFIX}/lib/libPocoJSON.a
  ${POCO_WEB_PREFIX}/lib/libPocoFoundation.a
)
target_link_options(craftos PRIVATE
  ${WEB_FLAGS}
  -sUSE_SDL=2
  -sPROXY_TO_PTHREAD=1
  -sPTHREAD_POOL_SIZE=8
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=64MB
  -sSTACK_SIZE=1MB
  -sDEFAULT_PTHREAD_STACK_SIZE=2MB
  -sMODULARIZE=1
  -sEXPORT_NAME=CraftOS
  -sENVIRONMENT=web,worker
  -sFORCE_FILESYSTEM=1
  -sEXIT_RUNTIME=0
  -sINVOKE_RUN=0
  "-sEXPORTED_FUNCTIONS=_main,_craftos_web_attach,_craftos_web_input,_craftos_web_pause,_malloc,_free"
  "-sEXPORTED_RUNTIME_METHODS=FS,callMain,UTF8ToString,writeArrayToMemory"
)
