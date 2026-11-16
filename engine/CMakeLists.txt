cmake_minimum_required(VERSION 3.21)
project(craftos_engine LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Vendored Lua 5.2 fork with CraftOS-PC's coroutine/yield extensions.
set(LUA_DIR "${CMAKE_SOURCE_DIR}/craftos2-lua")
set(LUA_SOURCES
  error_info.c lapi.c lauxlib.c lbaselib.c lbitlib.c lcode.c lcorolib.c lctype.c ldblib.c
  ldebug.c ldo.c ldump.c lfunc.c lgc.c linit.c liolib.c llex.c llock.cpp lmathlib.c lmem.c
  loadlib.c lobject.c lopcodes.c loslib.c lparser.c lstate.c lstring.c lstrlib.c ltable.c
  ltablib.c ltm.c lundump.c lutf8lib.c lvm.c lzio.c)
list(TRANSFORM LUA_SOURCES PREPEND "${LUA_DIR}/src/")
add_library(lua52 SHARED ${LUA_SOURCES})
target_include_directories(lua52 PUBLIC ${LUA_DIR}/include PRIVATE ${LUA_DIR}/src)
target_compile_definitions(lua52 PRIVATE LUA_COMPAT_UNPACK LUA_COMPAT_LOADSTRING LUA_COMPAT_LOG10 LUA_COMPAT_MAXN)
if(WIN32)
  target_compile_definitions(lua52 PRIVATE LUA_BUILD_AS_DLL _CRT_SECURE_NO_WARNINGS)
endif()
set_target_properties(lua52 PROPERTIES OUTPUT_NAME lua52 WINDOWS_EXPORT_ALL_SYMBOLS OFF)

find_package(SDL2 CONFIG REQUIRED)
find_package(SDL2_mixer CONFIG REQUIRED)
find_package(Poco CONFIG REQUIRED COMPONENTS Foundation Net NetSSL JSON Util)
find_package(OpenSSL REQUIRED)
find_package(ZLIB REQUIRED)
find_package(PNG REQUIRED)
find_package(WebP CONFIG REQUIRED)
find_package(unofficial-libharu CONFIG REQUIRED)
find_path(PNGPP_INCLUDE png++/png.hpp REQUIRED)
find_path(DIRENT_INCLUDE dirent.h REQUIRED)

set(ENGINE_SOURCES
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
  src/apis/handles/http_handle.cpp
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
)

# src/platform.cpp includes the per-OS file from src/platform/ itself.

add_executable(craftos ${ENGINE_SOURCES})

target_include_directories(craftos PRIVATE
  api
  ${PNGPP_INCLUDE}
  ${DIRENT_INCLUDE}
)

target_compile_definitions(craftos PRIVATE
  NO_CLI
  PRINT_TYPE=1
)
if(MSVC)
  # MSVC's CRT has the Annex K *_s functions; glibc does not, so claiming them elsewhere would be wrong.
  target_compile_definitions(craftos PRIVATE
    HAVE_STRERROR_S
    __STDC_LIB_EXT1__
    _CRT_SECURE_NO_WARNINGS
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
endif()

if(WIN32)
  # The sources use the ANSI Win32 entry points and POSIX string helpers.
  target_compile_options(craftos PRIVATE /UUNICODE /U_UNICODE)
  target_compile_definitions(craftos PRIVATE strcasecmp=_stricmp strncasecmp=_strnicmp)
endif()

if(WIN32)
  target_link_libraries(craftos PRIVATE
    lua52
    shlwapi ws2_32 crypt32 normaliz iphlpapi comctl32 wer
  )
else()
  target_link_libraries(lua52 PRIVATE m)
  target_link_libraries(craftos PRIVATE lua52 pthread dl)
  # Find liblua52.so next to the binary, so the build folder can be zipped and moved.
  set_target_properties(craftos PROPERTIES BUILD_RPATH "\$ORIGIN")
endif()

target_link_libraries(craftos PRIVATE
  SDL2::SDL2
  SDL2_mixer::SDL2_mixer
  Poco::Foundation Poco::Net Poco::NetSSL Poco::JSON Poco::Util
  OpenSSL::SSL OpenSSL::Crypto
  ZLIB::ZLIB
  PNG::PNG
  WebP::webp WebP::libwebpmux
  unofficial::libharu::hpdf
)

if(TARGET SDL2::SDL2main)
  target_link_libraries(craftos PRIVATE SDL2::SDL2main)
endif()

if(MSVC)
  target_compile_options(craftos PRIVATE /W1 /wd4005 /wd26812 /Zc:__cplusplus /utf-8)
endif()
