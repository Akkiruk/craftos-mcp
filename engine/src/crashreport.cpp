/*
 * crashreport.cpp
 * craftos-agent: the crash report every platform's crash handler writes (crashreport.hpp).
 */

#include "crashreport.hpp"
#include <Computer.hpp>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <thread>
#include <filesystem>
#include "runtime.hpp"
#include "util.hpp"
#ifdef _WIN32
#include <Windows.h>
#include <process.h>
#define getpid _getpid
#else
#include <unistd.h>
#endif

extern "C" {
#include <lua.h>
}

#ifndef CRAFTOS_AGENT_COMMIT
#define CRAFTOS_AGENT_COMMIT "unknown"
#endif

const char * const crashreport::issuesUrl = "https://github.com/Akkiruk/craftos-mcp/issues";
thread_local Computer * crashreport::currentComputer = NULL;
extern int selectedRenderer;
extern const char * lastCFunction;

bool crashreport::headless() {
    // 0 and 5 are the SDL window renderers; everything else (raw, headless, CLI, TRoR) has no window to show a dialog in
    return selectedRenderer != 0 && selectedRenderer != 5;
}

std::string crashreport::directory() {
    std::filesystem::path dir;
    const char * env = getenv("CRAFTOS_CRASH_DIR");
    if (env != NULL && *env) dir = env;
    else {
#ifdef _WIN32
        const char * base = getenv("LOCALAPPDATA");
        dir = std::filesystem::path(base != NULL ? base : ".") / "craftos-mcp" / "crashes";
#else
        const char * xdg = getenv("XDG_CACHE_HOME");
        const char * home = getenv("HOME");
        dir = xdg != NULL && *xdg ? std::filesystem::path(xdg) / "craftos-mcp" / "crashes"
            : std::filesystem::path(home != NULL ? home : ".") / ".cache" / "craftos-mcp" / "crashes";
#endif
    }
    std::error_code e;
    std::filesystem::create_directories(dir, e);
    return dir.string();
}

std::string crashreport::newBase() {
    const std::time_t now = std::time(NULL);
    char stamp[32];
    std::strftime(stamp, sizeof(stamp), "%Y%m%d-%H%M%S", std::localtime(&now));
    return (std::filesystem::path(directory()) / (std::string("craftos-") + stamp + "-" + std::to_string(getpid()))).string();
}

// The Lua stack of the computer's top coroutine as far as it can be read; in plain C with no allocation, so a broken
// state at worst ends the walk (on Windows inside __try)
static void luaStack(lua_State * L, char * out, size_t size) {
    size_t used = 0;
    out[0] = 0;
    lua_Debug ar;
    for (int level = 0; level < 32 && lua_getstack(L, level, &ar); level++) {
        if (!lua_getinfo(L, "Sl", &ar)) break;
        const int n = snprintf(out + used, size - used, "    %s:%d\n", ar.short_src, ar.currentline);
        if (n < 0 || (size_t)n >= size - used) break;
        used += n;
    }
}

static void safeLuaStack(lua_State * L, char * out, size_t size) {
#ifdef _WIN32
    __try {luaStack(L, out, size);}
    __except (EXCEPTION_EXECUTE_HANDLER) {strncpy(out, "    (could not be read)\n", size);}
#else
    luaStack(L, out, size);
#endif
}

std::string crashreport::writeReport(const std::string& base, const std::string& reason, const std::string& nativeStack, const std::string& dumpPath) {
    const std::string path = base + ".txt";
    FILE * fp = fopen(path.c_str(), "w");
    if (fp == NULL) return "";
    const std::time_t now = std::time(NULL);
    char when[64];
    std::strftime(when, sizeof(when), "%Y-%m-%d %H:%M:%S", std::localtime(&now));
    fprintf(fp, "craftos-mcp engine crash report\n");
    fprintf(fp, "Report it at %s with this file (and the .dmp beside it, if there is one).\n\n", issuesUrl);
    fprintf(fp, "time:            %s\n", when);
    fprintf(fp, "engine:          CraftOS-PC %s, craftos-agent commit %s\n", CRAFTOSPC_VERSION, CRAFTOS_AGENT_COMMIT);
    fprintf(fp, "mode:            %s%s\n", headless() ? "headless" : "window", rawPoolMode ? " (pool)" : "");
    fprintf(fp, "crash:           %s\n", reason.c_str());
    fprintf(fp, "last C function: %s\n", lastCFunction != NULL ? lastCFunction : "(none)");
    if (!dumpPath.empty()) fprintf(fp, "minidump:        %s\n", dumpPath.c_str());
    Computer * comp = currentComputer;
    if (comp != NULL) {
        fprintf(fp, "computer:        id %d", comp->id);
        if (comp->config != NULL && !comp->config->label.empty()) fprintf(fp, ", label \"%s\"", comp->config->label.c_str());
        if (comp->poolSlot >= 0) fprintf(fp, ", pool slot %d", comp->poolSlot);
        fprintf(fp, "\n");
        if (comp->coro != NULL && comp->L != NULL) {
            static char stack[4096];
            safeLuaStack(comp->coro, stack, sizeof(stack));
            fprintf(fp, "Lua stack (the computer's top coroutine):\n%s", stack[0] ? stack : "    (empty)\n");
        }
    } else fprintf(fp, "computer:        none (the crash was not on a computer's thread)\n");
    if (!nativeStack.empty()) fprintf(fp, "\nnative stack:\n%s", nativeStack.c_str());
    fclose(fp);
    return path;
}

void crashreport::announce(const std::string& reason, const std::string& reportPath) {
    fprintf(stderr, "engine crashed: %s; report at %s\n", reason.c_str(), reportPath.empty() ? "(none: the crash folder could not be written)" : reportPath.c_str());
    fflush(stderr);
}

std::string crashreport::dialogText(const std::string& reason, const std::string& reportPath) {
    return "The emulator has crashed (" + reason + ").\n\nA crash report was saved to:\n" + reportPath +
        "\n\nPlease report this at " + issuesUrl + " and attach that file and the .dmp file beside it. The emulator will now close.";
}

#ifndef _WIN32
#include <execinfo.h>
#include <csignal>
// Linux and macOS: the signal handlers (platform/linux.cpp, platform/darwin.cpp) hand over their backtrace
void crashreport::posixCrash(const std::string& reason, void ** frames, int count) {
    // several computers' threads crashing at once in a shared engine: the first reports, the others wait for it to
    // end the process (a crash while reporting, on that same thread, just ends it)
    static std::atomic<bool> crashing(false);
    static std::atomic<std::thread::id> reporter;
    if (crashing.exchange(true)) {
        if (reporter.load() != std::this_thread::get_id()) std::this_thread::sleep_for(std::chrono::seconds(30));
        _exit(3);
    }
    reporter = std::this_thread::get_id();
    std::string stack;
    char ** names = backtrace_symbols(frames, count);
    for (int i = 0; i < count; i++) {
        stack += "    #" + std::to_string(i) + " " + (names != NULL ? names[i] : "?") + "\n";
    }
    free(names);
    const std::string report = writeReport(newBase(), reason, stack, "");
    announce(reason, report);
}
#endif
