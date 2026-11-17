/*
 * debug_server.hpp
 * craftos-agent
 *
 * The debugger a debug adapter drives over a socket (--debug-connect host:port). The engine connects out to the
 * adapter, says hello with the token it was given (CRAFTOS_DEBUG_TOKEN), and then speaks JSON, one object a line:
 * requests {"seq":n,"cmd":"..."} answered by {"seq":n,"ok":true,...}, and events {"event":"stopped",...}.
 *
 * Nothing here runs unless --debug-connect was given: no hook is installed, and the calls below are one branch on
 * a bool. With it, the computer's coroutines carry a line hook whose fast path is a flag and a bitmap test.
 *
 * While the program is stopped (a breakpoint, a step, a pause, an error) the computer thread waits inside the hook:
 * the "too long without yielding" timer is taken away and starts again from zero on resume, and the virtual clock
 * (os.clock, os.epoch, os.time, timers, sleep) stands still, so a program sees no time pass at a breakpoint.
 *
 * The protocol. Paths are files on the computer, "/dir/prog.lua". Frames are numbered from 0, the innermost, on
 * through each coroutine that resumed the one before, down to the BIOS.
 *
 *   engine -> adapter, on its own:
 *     hello    {token, protocol, ccVersion, computer}   first thing; the computer then waits for "run"
 *     started  {}                                       the computer boots (again after a reboot)
 *     stopped  {reason, text, breakpoints}              reason: breakpoint, step, pause, entry, exception
 *     continued {}                                      the program goes on
 *     output   {category, text, path, line}             a logpoint, or a breakpoint condition that failed
 *     ended    {}                                       the program named by configure.entry returned or failed
 *     exited   {}                                       the computer's Lua state is closing
 *
 *   adapter -> engine, at any time:
 *     setBreakpoints {path, breakpoints: [{id, line, condition?, log?, hitOp?, hitN?}]}   all of one file's
 *     setErrorMode   {mode: none | uncaught | all}
 *     configure      {entry, stopOnEntry, stepIntoRom}
 *     run            let the computer start (once, after the hello)
 *     pause          stop at the program's next line, or where the computer next waits for an event
 *     detach         forget everything and run on
 *
 *   adapter -> engine, while stopped (otherwise answered ok: false):
 *     stack    {start?, count?}   -> {frames: [{i, thread, what, name?, path, line, user, defined}], total}
 *     locals, upvalues, globals {frame} -> {variables: [{name, value, type, ref?, ek?}]}
 *     children {ref}              -> the same, for a table's entries; refs last until the program goes on
 *     eval     {frame, expr, raw?} -> {value, type, ref?} or {text} with raw; statements work too (x = 5)
 *     continue, next, stepIn, stepOut
 *
 * This code is licensed under the MIT license.
 */

#ifndef DEBUG_SERVER_HPP
#define DEBUG_SERVER_HPP
#include <atomic>
#include <string>

struct Computer;
struct lua_State;

namespace debugsrv {
#ifndef __EMSCRIPTEN__
    /** Whether --debug-connect was given. Everything else is skipped when it was not. */
    extern std::atomic<bool> enabled;
    /** Whether the program is stopped right now. */
    extern std::atomic<bool> stopped;
    /** Whether a pause was asked for and has not happened yet. */
    extern std::atomic<bool> pauseAsked;
    /** The computer being debugged: the first one of the process to start. */
    extern std::atomic<Computer*> debugged;

    /** --debug-connect host:port. The token comes from the environment (CRAFTOS_DEBUG_TOKEN). */
    void configure(const std::string& hostport);
    /**
     * A computer's Lua state is ready and nothing has run yet: connect (the first time), wait for the adapter to
     * say "run" so its breakpoints are in before the first line, and put the hook on the top coroutine (every
     * coroutine made from it inherits the hook). Only the first computer of the process is debugged. True when the
     * hook is on.
     */
    bool computerStarting(Computer * comp, lua_State * coro);
    /** The computer's Lua state is about to close. */
    void computerStopping(Computer * comp);
    /** Stop a computer that is waiting for an event (called from getNextEvent when pausePending). */
    void idlePause(Computer * comp);
    /**
     * The debugged computer is about to wait for its next event, every coroutine has yielded: tell the adapter if
     * the debugged program has ended, and do a pause that found no line of the program to stop at.
     */
    void roundStart(Computer * comp);
    /** Microseconds the virtual clock has been held back so far, counting a stop still going on. */
    long long frozenMicros();

    inline bool isDebugged(Computer * comp) {return enabled.load(std::memory_order_relaxed) && comp == debugged.load(std::memory_order_relaxed);}
    inline bool pausePending(Computer * comp) {return isDebugged(comp) && pauseAsked.load(std::memory_order_relaxed);}
    inline void eventRound(Computer * comp) {if (isDebugged(comp)) roundStart(comp);}
    inline bool isStopped() {return enabled.load(std::memory_order_relaxed) && stopped.load(std::memory_order_relaxed);}
    inline long long clockHeldMicros() {return enabled.load(std::memory_order_relaxed) ? frozenMicros() : 0;}
#else
    // The browser build has no sockets and no debugger.
    inline void configure(const std::string&) {}
    inline bool computerStarting(Computer *, lua_State *) {return false;}
    inline void computerStopping(Computer *) {}
    inline void idlePause(Computer *) {}
    inline void eventRound(Computer *) {}
    inline bool pausePending(Computer *) {return false;}
    inline bool isStopped() {return false;}
    inline long long clockHeldMicros() {return 0;}
#endif
}

#endif
