/*
 * simclock.hpp
 * craftos-agent: the virtual clock every computer of this engine shares, and the controls a person has over it.
 *
 * The clock (os.clock, os.epoch, os.time, os.day, timers and alarms) is real time, scaled (--time-scale or `speed`),
 * jumped forward (os.__ccsimAdvance or `advance`), and held still while something holds it: a debugger stopped on a
 * line, or the whole engine paused. The code is in apis/os.cpp, next to the timers it drives.
 *
 * Controls arrive as a raw event named "ccsim_clock:<seq>:<verb>[:<arg>]" (RawTerminal.cpp takes it before any
 * computer sees it) or from the desktop window's keys (SDLTerminal.cpp):
 *   pause            every computer stops at its next yield; once all of them wait, the clock stands still
 *   resume           the clock runs again from where it stood: no timer fires late in a burst
 *   step:<ms>        paused: move the clock on by ms (a tick is 50), fire what falls due, let every computer handle
 *                    its events until all of them wait again, then stand still once more
 *   speed:<x>        the clock runs x times faster (0.1 to 1000), ends `max`
 *   max              as fast as possible: whenever every computer waits, the clock jumps to the next timer
 *   advance:<ms>     jump forward (paused or not): the clock moves from one timer to the next up to ms on, and every
 *                    computer handles each one before it moves again, so a sleep loop runs as often as it would have;
 *                    `jumping` in the status is true until it is done. One that would take more than 30 s of real
 *                    time does the rest at once (the timers due in it still fire in order)
 *   worldtime:<ms>   the in-game time of day and day count (os.time, os.day, os.epoch "ingame", alarms) of every
 *                    computer: ms of world time since day 1, 06:00. Without it each computer counts from its own start
 *   status           only write the status file
 * With CRAFTOS_CLOCK_FILE set, the state is written there as JSON after every control and whenever it changes.
 */

#ifndef CRAFTOS_PC_SIMCLOCK_HPP
#define CRAFTOS_PC_SIMCLOCK_HPP
#include <chrono>
#include <string>

class Computer;

namespace simclock {
    /** The virtual time now. */
    std::chrono::system_clock::time_point now();
    /** Hold the clock still (on) or let it go again (off); holds nest (a debugger stop inside a pause). */
    void hold(bool on);
    /** Whether something holds the clock now. */
    bool held();
    /** One control, as in the header comment (without the "ccsim_clock:" prefix). */
    void command(const std::string& text);
    /** A computer is about to take its next event: while paused it waits here (getNextEvent). */
    void waitWhilePaused(Computer * comp);
    /**
     * A key in the desktop window: true when it was a clock key and is used up. Alt+P pause / resume, Alt+. one
     * tick, Alt+] faster, Alt+[ slower, Alt+\ normal speed, Alt+J a minute on, Alt+H an hour, Alt+N a Minecraft day.
     */
    bool hotkey(int sym, int mod);
    /** What the window title starts with: "[Paused] ", "[5x] ", "[Max speed] " or nothing. */
    std::string tag();
    /** The world clock's start for this computer: os.time / os.day count from here. */
    std::chrono::system_clock::time_point worldStart(Computer * comp);
}

#endif
