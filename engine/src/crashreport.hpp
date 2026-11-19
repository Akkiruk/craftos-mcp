/*
 * crashreport.hpp
 * craftos-agent: what the engine leaves behind when it crashes.
 *
 * A crash writes a report folder entry instead of a dialog: craftos-<time>-<pid>.txt (engine version, commit, the
 * crash, the last C function, the computer the crashing thread ran and its Lua stack when it can be read, the native
 * stack) and, on Windows, craftos-<time>-<pid>.dmp, a minidump. It prints one line to stderr,
 *     engine crashed: <reason>; report at <path>
 * which the runner shows in its results, and the engine exits with a nonzero code. Only the windowed GUI shows a
 * dialog as well. The folder is CRAFTOS_CRASH_DIR, else %LOCALAPPDATA%\craftos-mcp\crashes on Windows and
 * ~/.cache/craftos-mcp/crashes elsewhere.
 */

#ifndef CRAFTOS_PC_CRASHREPORT_HPP
#define CRAFTOS_PC_CRASHREPORT_HPP
#include <string>

struct Computer;

namespace crashreport {
    /** Where to report a bug in this fork. */
    extern const char * const issuesUrl;
    /** The computer whose thread this is (set by computerThread), for the report. */
    extern thread_local Computer * currentComputer;
    /** No window to show anything in: raw, headless, CLI, pool, or any test or MCP run. */
    bool headless();
    /** The crash folder, made if it is not there. */
    std::string directory();
    /** A fresh file name base in the crash folder: <dir>/craftos-<time>-<pid> (no extension). */
    std::string newBase();
    /**
     * Write <base>.txt: the reason, `nativeStack` (may be empty), and what the engine knows (version, commit, last C
     * function, the crashing thread's computer and its Lua stack). Returns the path. Safe to call once in a crash.
     */
    std::string writeReport(const std::string& base, const std::string& reason, const std::string& nativeStack, const std::string& dumpPath);
    /** The one stderr line, and the wording a GUI dialog uses. */
    void announce(const std::string& reason, const std::string& reportPath);
    std::string dialogText(const std::string& reason, const std::string& reportPath);
#ifndef _WIN32
    /** A signal handler's report: the backtrace it took, written and announced (the caller then exits). */
    void posixCrash(const std::string& reason, void ** frames, int count);
#endif
}

#endif
