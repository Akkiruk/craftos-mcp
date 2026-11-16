# Fetch, check and patch the Poco source the browser build links against (engine/build-web.cmd runs it):
#
#   cmake -DOUT=<dir> -P engine/web/poco.cmake      -> <dir>/src, Poco 1.15.4 ready for emcmake
#
# Two patches, both because Emscripten has no epoll/eventfd: Foundation/CMakeLists.txt defines POCO_HAVE_FD_POLL
# instead of POCO_HAVE_FD_EPOLL under EMSCRIPTEN, and Net/include/Poco/Net/Net.h skips its epoll defines when
# POCO_EMSCRIPTEN is set. Each must match exactly once, so a different Poco fails here instead of building wrong.

cmake_minimum_required(VERSION 3.16)
if(NOT DEFINED OUT)
  message(FATAL_ERROR "usage: cmake -DOUT=<dir> -P poco.cmake")
endif()
file(TO_CMAKE_PATH "${OUT}" OUT)

set(POCO_VERSION 1.15.4)
set(POCO_URL "https://github.com/pocoproject/poco/archive/refs/tags/poco-${POCO_VERSION}-release.tar.gz")
set(POCO_SHA256 4635007f593646b3db8754bbb31ded34cd533487519d4d4a45c788dbff3fe07f)
set(TARBALL "${OUT}/poco-${POCO_VERSION}.tar.gz")
set(SRC "${OUT}/src")

if(EXISTS "${SRC}/.patched")
  message(STATUS "Poco ${POCO_VERSION}: already at ${SRC}")
  return()
endif()

file(MAKE_DIRECTORY "${OUT}")
if(NOT EXISTS "${TARBALL}")
  message(STATUS "Poco ${POCO_VERSION}: downloading ${POCO_URL}")
  file(DOWNLOAD "${POCO_URL}" "${TARBALL}" EXPECTED_HASH SHA256=${POCO_SHA256} STATUS status)
  list(GET status 0 code)
  if(NOT code EQUAL 0)
    file(REMOVE "${TARBALL}")
    message(FATAL_ERROR "Poco download failed: ${status}")
  endif()
endif()
file(SHA256 "${TARBALL}" got)
if(NOT got STREQUAL POCO_SHA256)
  message(FATAL_ERROR "${TARBALL}: sha256 ${got}, expected ${POCO_SHA256}")
endif()

file(REMOVE_RECURSE "${SRC}" "${OUT}/extract")
file(MAKE_DIRECTORY "${OUT}/extract")
execute_process(COMMAND ${CMAKE_COMMAND} -E tar xzf "${TARBALL}" WORKING_DIRECTORY "${OUT}/extract" RESULT_VARIABLE rc)
if(NOT rc EQUAL 0)
  message(FATAL_ERROR "could not extract ${TARBALL}")
endif()
file(RENAME "${OUT}/extract/poco-poco-${POCO_VERSION}-release" "${SRC}")
file(REMOVE_RECURSE "${OUT}/extract")

function(patch_once file find replace)
  file(READ "${SRC}/${file}" text)
  string(FIND "${text}" "${find}" first)
  string(FIND "${text}" "${find}" last REVERSE)
  if(first EQUAL -1 OR NOT first EQUAL last)
    message(FATAL_ERROR "${file}: patch pattern not found exactly once; Poco changed?")
  endif()
  string(REPLACE "${find}" "${replace}" text "${text}")
  file(WRITE "${SRC}/${file}" "${text}")
endfunction()

patch_once(Foundation/CMakeLists.txt
  "target_compile_definitions(Foundation PUBLIC _XOPEN_SOURCE=500 POCO_HAVE_FD_EPOLL)"
  "target_compile_definitions(Foundation PUBLIC _XOPEN_SOURCE=500 $<IF:$<BOOL:\${EMSCRIPTEN}>,POCO_HAVE_FD_POLL,POCO_HAVE_FD_EPOLL>)")
patch_once(Net/include/Poco/Net/Net.h
  "#if defined(POCO_OS_FAMILY_WINDOWS) || (POCO_OS == POCO_OS_LINUX) || (POCO_OS == POCO_OS_ANDROID) || defined(POCO_OS_FAMILY_BSD)"
  "#if !defined(POCO_EMSCRIPTEN) && defined(POCO_OS_FAMILY_WINDOWS) || (POCO_OS == POCO_OS_LINUX) || (POCO_OS == POCO_OS_ANDROID) || defined(POCO_OS_FAMILY_BSD)")
patch_once(Net/include/Poco/Net/Net.h
  "#if (POCO_OS == POCO_OS_LINUX) || (POCO_OS == POCO_OS_WINDOWS_NT) || (POCO_OS == POCO_OS_ANDROID)"
  "#if !defined(POCO_EMSCRIPTEN) && (POCO_OS == POCO_OS_LINUX) || (POCO_OS == POCO_OS_WINDOWS_NT) || (POCO_OS == POCO_OS_ANDROID)")
file(WRITE "${SRC}/.patched" "${POCO_VERSION}\n")
message(STATUS "Poco ${POCO_VERSION}: patched source at ${SRC}")
