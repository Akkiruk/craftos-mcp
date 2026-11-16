/*
 * platform/emscripten.cpp
 * CraftOS-PC 2
 *
 * This file implements functions specific to the Emscripten/WASM platform.
 * Restored from upstream (deleted in 1159aca) for the browser build, engine/web/web.cmake.
 *
 * This code is licensed under the MIT license.
 * Copyright (c) 2019-2024 JackMacWindows.
 */

#ifdef __EMSCRIPTEN__
#include <cstdio>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>
#include "../platform.hpp"

void setThreadName(std::thread &t, const std::string& name) {}

static path_t webBasePath = "/user-data";
static path_t webROMPath = "/craftos";

void setBasePath(path_t path) {webBasePath = path;}

void setROMPath(path_t path) {webROMPath = path;}

path_t getBasePath() {
    return webBasePath;
}

path_t getROMPath() {
    return webROMPath;
}

path_t getPlugInPath() {
    return webBasePath / "plugins";
}

path_t getMCSavePath() {
    return "";
}

void updateNow(const std::string& tag_name, const Poco::JSON::Object::Ptr root) {}

void migrateOldData() {}

void copyImage(SDL_Surface* surf, SDL_Window* win) {}

void setupCrashHandler() {}

void setFloating(SDL_Window* win, bool state) {}

void platformExit() {}

void addSystemCertificates(Poco::Net::Context::Ptr context) {}

void unblockInput() {}

#endif
