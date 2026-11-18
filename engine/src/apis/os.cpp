/*
 * apis/os.cpp
 * CraftOS-PC 2
 *
 * This file implements the functions for the os API.
 *
 * This code is licensed under the MIT license.
 * Copyright (c) 2019-2024 JackMacWindows.
 */

#include <Computer.hpp>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>
#include "../debug_server.hpp"
#include "../main.hpp"
#include "../runtime.hpp"
#include "../simclock.hpp"
#include "../util.hpp"
#include "../termsupport.hpp"

// Virtual clock (simclock.hpp): --time-scale N or `speed` makes clocks, dates and timers run N times faster than real
// time; `advance` (and os.__ccsimAdvance) jumps it forward; a hold (a debugger's stop, a pause) keeps it still.
static const std::chrono::system_clock::time_point processStart = std::chrono::system_clock::now();
// how far the clock was jumped, in system_clock ticks (whole milliseconds lost a little each jump, and a stepped jump
// lands on each timer exactly)
static std::atomic<long long> timeOffsetTicks(0);
// held: the real time spent held so far is taken off the clock; while held the clock reads the same to the tick
static std::mutex holdMu;
static int holdCount = 0;
static std::chrono::system_clock::duration heldTotal = std::chrono::system_clock::duration::zero();
static std::chrono::system_clock::time_point holdStarted;
/** Real time with the time held taken off: it stands still while held. */
static std::chrono::system_clock::time_point unheldNow() {
    std::lock_guard<std::mutex> lock(holdMu);
    return (holdCount > 0 ? holdStarted : std::chrono::system_clock::now()) - heldTotal;
}
// scaled: vAnchor + (real - rAnchor) * timeScale; a change of speed moves the anchors, so the clock never jumps
static std::mutex anchorMu;
static std::chrono::system_clock::time_point vAnchor = processStart, rAnchor = processStart;
static std::chrono::system_clock::time_point scaledNow(std::chrono::system_clock::time_point real) {
    if (timeScale == 1.0 && vAnchor == rAnchor) return real;
    return vAnchor + std::chrono::duration_cast<std::chrono::system_clock::duration>((real - rAnchor) * timeScale);
}
static std::chrono::system_clock::time_point vnow() {
    const auto real = unheldNow();
    const auto offset = std::chrono::system_clock::duration(timeOffsetTicks.load());
    std::lock_guard<std::mutex> lock(anchorMu);
    return scaledNow(real) + offset;
}
static Uint32 scaledMs(Uint32 ms) {
    if (timeScale == 1.0) return ms;
    const Uint32 scaled = (Uint32)(ms / timeScale);
    return scaled == 0 ? 1 : scaled;
}
// os.time / os.day: from each computer's start, unless `worldtime` set one world clock for every computer
static std::atomic<bool> worldStartSet(false);
static std::atomic<long long> worldStartMs(0); // virtual ms since the epoch
std::chrono::system_clock::time_point simclock::worldStart(Computer * comp) {
    if (worldStartSet.load()) return std::chrono::system_clock::time_point(std::chrono::milliseconds(worldStartMs.load()));
    return comp->system_start;
}
std::chrono::system_clock::time_point simclock::now() {return vnow();}
void simclock::hold(bool on) {
    std::lock_guard<std::mutex> lock(holdMu);
    if (on) {
        if (holdCount++ == 0) holdStarted = std::chrono::system_clock::now();
    } else if (holdCount > 0 && --holdCount == 0) {
        heldTotal += std::chrono::system_clock::now() - holdStarted;
    }
}
bool simclock::held() {
    std::lock_guard<std::mutex> lock(holdMu);
    return holdCount > 0;
}

static int os_getComputerID(lua_State *L) { lastCFunction = __func__; lua_pushinteger(L, get_comp(L)->id); return 1; }

static int os_getComputerLabel(lua_State *L) {
    lastCFunction = __func__;
    struct computer_configuration * cfg = get_comp(L)->config;
    if (cfg->label.empty()) return 0;
    lua_pushstring(L, cfg->label.c_str());
    return 1;
}

static int os_setComputerLabel(lua_State *L) {
    lastCFunction = __func__;
    Computer * comp = get_comp(L);
    comp->config->label = tostring(L, 1, "");
    // craftos-agent: on disk at once, not only when the computer stops, so a world snapshot taken now has it
    setComputerConfig(comp->id, *comp->config);
    if (comp->term != NULL) comp->term->setLabel(comp->config->label.empty() ? "CraftOS Terminal: " + std::string(comp->isDebugger ? "Debugger" : "Computer") + " " + std::to_string(comp->id) : "CraftOS Terminal: " + asciify(comp->config->label));
    return 0;
}

/*
 * craftos-agent: copy the value at `idx` of `from` onto `to` the way CC's event arguments travel through Java
 * (CobaltLuaMachine.toObject, then toValue), on every CC:Tweaked version: booleans, numbers and strings as they are;
 * a table as a new table, the same table reached twice within one argument (or a cycle) staying one table (`memo`, a
 * table on `to` keyed by the source table). Functions, coroutines and userdata have no Java form: they become nil, and
 * a table entry whose key or value is one of them (or nil) is left out. Pushes nothing and returns false for those.
 */
static bool copyThroughJava(lua_State *from, int idx, lua_State *to, int memo) {
    idx = lua_absindex(from, idx);
    switch (lua_type(from, idx)) {
        case LUA_TBOOLEAN: lua_pushboolean(to, lua_toboolean(from, idx)); return true;
        case LUA_TNUMBER: lua_pushnumber(to, lua_tonumber(from, idx)); return true;
        case LUA_TSTRING: {
            size_t len = 0;
            const char * str = lua_tolstring(from, idx, &len);
            lua_pushlstring(to, str, len);
            return true;
        }
        case LUA_TTABLE: {
            void * key = const_cast<void*>(lua_topointer(from, idx));
            if (!lua_checkstack(to, 4) || !lua_checkstack(from, 3)) luaL_error(from, "stack overflow");
            lua_pushlightuserdata(to, key);
            lua_rawget(to, memo);
            if (!lua_isnil(to, -1)) return true;
            lua_pop(to, 1);
            lua_newtable(to);
            lua_pushlightuserdata(to, key);
            lua_pushvalue(to, -2);
            lua_rawset(to, memo);
            lua_pushnil(from);
            while (lua_next(from, idx) != 0) {
                if (copyThroughJava(from, -2, to, memo)) {
                    if (copyThroughJava(from, -1, to, memo)) lua_rawset(to, -3);
                    else lua_pop(to, 1);
                }
                lua_pop(from, 1);
            }
            return true;
        }
        default: return false;  // nil, function, thread, userdata
    }
}

static int os_queueEvent(lua_State *L) {
    lastCFunction = __func__;
    Computer * computer = get_comp(L);
    const std::string name = checkstring(L, 1);
    {
        // CC:Tweaked's queue holds 256 events and silently drops the rest (see queueEvent in runtime.cpp)
        std::lock_guard<std::mutex> lock(computer->event_provider_queue_mutex);
        if (computer->eventQueue.size() + computer->event_provider_queue.size() > 256) return 0; // the running event still counts here
    }
    if (!lua_checkstack(computer->paramQueue, 1)) luaL_error(L, "Could not allocate space for event");
    lua_State *param = lua_newthread(computer->paramQueue);
    lua_remove(L, 1);
    const int count = lua_gettop(L);
    lua_checkstack(param, count + 2);
    // CC copies each argument through Java on every version (1.121.0's os_spec: "clones objects", "does not
    // preserve references in separate args"): new tables, references shared inside one argument stay shared, across
    // arguments they do not, and functions and other values Java cannot hold arrive as nil (copyThroughJava)
    for (int i = 1; i <= count; i++) {
        lua_newtable(param);
        const int memo = lua_gettop(param);
        if (!copyThroughJava(L, i, param, memo)) lua_pushnil(param);
        lua_remove(param, memo);
    }
    lua_settop(L, 0);
    computer->eventQueue.push(name);
    computer->event_lock.notify_all();
    return 0;
}

static int os_clock(lua_State *L) {
    lastCFunction = __func__;
    Computer * computer = get_comp(L);
    lua_pushnumber(L, (double)std::chrono::duration_cast<std::chrono::milliseconds>(vnow() - computer->system_start).count() / 1000.0);
    return 1;
}

struct timer_data_t {
    Computer * comp;
    SDL_TimerID timer;
    std::mutex * lock;
    bool isAlarm;
    std::chrono::steady_clock::time_point due; // real time the SDL timer fires, for os.__ccsimAdvance
    std::chrono::system_clock::time_point vdue; // virtual time (vnow) it is due: it never fires before
};

template<typename T>
class PointerProtector {
    T* ptr;
public:
    PointerProtector(T* p) : ptr(p) {}
    ~PointerProtector() { delete ptr; }
};

static ProtectedObject<std::unordered_map<SDL_TimerID, struct timer_data_t*> > runningTimerData;

static std::string timer_event(lua_State *L, void* param) {
    struct timer_data_t * data = (timer_data_t*)param;
    bool found = false;
    LockGuard lock(runningTimerData);
    for (const auto& i : *runningTimerData) if (i.second == param) { found = true; break; }
    if (!found) return "";
    data->lock->lock();
    lua_pushinteger(L, data->timer);
    runningTimerData->erase(data->timer);
    data->lock->unlock();
    const bool isAlarm = data->isAlarm;
    delete data->lock;
    delete data;
    return isAlarm ? "alarm" : "timer";
}

static Uint32 notifyEvent(Uint32 interval, void* param) {
    struct timer_data_t * data = (timer_data_t*)param;
    bool found = false;
    LockGuard lock2(runningTimerData);
    for (const auto& i : *runningTimerData) if (i.second == param) { found = true; break; }
    if (!found) return 0;
    // SDL counts whole milliseconds of its own clock, so a timer can go off a little before os.clock says its time
    // has passed (four 0.05 s timers in a row came to 0.199 s). In the game both move by the same ticks: never fire
    // early, wait out the rest. interval 0 is os.__ccsimAdvance firing it on purpose.
    if (interval != 0 && !exiting && data->comp != NULL) {
        // held (a debugger's stop, a pause): the clock stands still, so no timer falls due; look again shortly
        if (simclock::held()) return 20;
        const auto left = data->vdue - vnow();
        if (left > std::chrono::system_clock::duration::zero()) {
            const double leftMs = std::chrono::duration<double, std::milli>(left).count() / timeScale;
            return (Uint32)(std::max)(1.0, ceil(leftMs));
        }
    }
    data->lock->lock();
    if (exiting || data->comp == NULL) {
        runningTimerData->erase(data->timer);
        data->lock->unlock();
        delete data->lock;
        delete data;
        return 0;
    }
    {
        LockGuard lock(freedTimers);
        if (freedTimers->find(data->timer) != freedTimers->end()) {
            freedTimers->erase(data->timer);
            runningTimerData->erase(data->timer);
            data->lock->unlock();
            delete data->lock;
            delete data;
            return 0;
        }
    }
    {
        std::lock_guard<std::mutex> lock(data->comp->timerIDsMutex);
        if (data->comp->timerIDs.find(data->timer) != data->comp->timerIDs.end()) data->comp->timerIDs.erase(data->timer);
    }
    queueEvent(data->comp, timer_event, data);
    data->comp->event_lock.notify_all();
    data->lock->unlock();
    return 0;
}

// imported by http.cpp:websocket_receive
int os_startTimer(lua_State *L) {
    lastCFunction = __func__;
    Computer * computer = get_comp(L);
    struct timer_data_t * data = new struct timer_data_t;
    data->comp = computer;
    data->lock = new std::mutex;
    data->isAlarm = false;
    lua_Number _time = luaL_checknumber(L, 1);
    if (_time < 0.001) _time = 0.001;
    queueTask([_time](void*a)->void* {
        struct timer_data_t * data = (timer_data_t*)a;
        Uint32 time = (Uint32)(_time * 1000);
        if (time == 0) time = 1;
        if (config.standardsMode) {
            if (time < 50) time = 50;
            else time = (Uint32)ceil(time / 50.0) * 50;
        }
        LockGuard lock(runningTimerData);
        data->vdue = vnow() + std::chrono::milliseconds(time);
        data->due = std::chrono::steady_clock::now() + std::chrono::milliseconds(scaledMs(time));
        data->timer = SDL_AddTimer(scaledMs(time), notifyEvent, data);
        if (data->timer) runningTimerData->insert(std::make_pair(data->timer, data));
        return NULL;
    }, data);
    if (!data->timer) {
        delete data->lock;
        delete data;
        return luaL_error(L, "Error occurred while creating timer: ", SDL_GetError());
    }
    lua_pushinteger(L, data->timer);
    std::lock_guard<std::mutex> lock(computer->timerIDsMutex);
    computer->timerIDs.insert(data->timer);
    return 1;
}

// imported by http.cpp:websocket_receive
int os_cancelTimer(lua_State *L) {
    lastCFunction = __func__;
    const SDL_TimerID id = (SDL_TimerID)luaL_checkinteger(L, 1);
    timer_data_t * data;
    {
        LockGuard lock(runningTimerData);
        if (runningTimerData->find(id) == runningTimerData->end()) return 0;
        data = (*runningTimerData)[id];
        runningTimerData->erase(id);
    } {
        std::lock_guard<std::mutex> lock(*data->lock);
    #ifdef __EMSCRIPTEN__
        queueTask([id](void*)->void* {SDL_RemoveTimer(id); return NULL; }, NULL);
    #else
        SDL_RemoveTimer(id);
    #endif
    }
    delete data->lock;
    delete data;
    return 0;
}

// Move the virtual clock on to `limit` (never back) and fire every timer due by then, earliest first (two due at once:
// the one started first). Timers due later keep their deadline on the clock. Works paused too: the clock is held, the
// jump moves it all the same.
static void advanceTo(std::chrono::system_clock::time_point limit) {
    const auto gap = limit - vnow();
    if (gap > std::chrono::system_clock::duration::zero()) timeOffsetTicks += gap.count();
    std::vector<timer_data_t*> due;
    {
        LockGuard lock(runningTimerData);
        for (const auto& i : *runningTimerData) if (i.second->vdue <= limit) due.push_back(i.second);
    }
    std::sort(due.begin(), due.end(), [](timer_data_t * a, timer_data_t * b) {return a->vdue < b->vdue || (a->vdue == b->vdue && a->timer < b->timer);});
    for (timer_data_t * data : due) {
        const SDL_TimerID id = data->timer;
        SDL_RemoveTimer(id);
        notifyEvent(0, data);
    }
}

// Jump the virtual clock forward by ms at once (os.__ccsimAdvance, a step, as fast as possible): the timers that fall
// due within the jump fire in order, but a timer the program starts on one of them does not (the person's jump,
// `advance`, is stepped: startJump).
static void advanceBy(double ms) {
    if (ms <= 0) return;
    advanceTo(vnow() + std::chrono::duration_cast<std::chrono::system_clock::duration>(std::chrono::duration<double, std::milli>(ms)));
}

// Test harness hook: advance the virtual clock by N seconds (advanceBy). The overlay (ccsim.core) takes this
// function out of the os table at boot, so programs never see it.
static int os_advance(lua_State *L) {
    lastCFunction = __func__;
    const double seconds = luaL_checknumber(L, 1);
    if (seconds <= 0) return 0;
    advanceBy(seconds * 1000.0);
    return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The controls a person has over the clock (simclock.hpp): pause, step, speed, as fast as possible, jump.

static std::atomic<bool> clockPaused(false), clockStepping(false), clockMax(false);
static std::atomic<bool> pauseHolding(false); // the pause holds the clock (every computer reached its wait)
static std::atomic<long long> clockSeq(0);
static std::chrono::steady_clock::time_point stepDeadline;
static std::mutex gateMu, statusMu, watcherMu;
static std::condition_variable gateCv;
static bool watcherStarted = false;
// A person's jump (`advance`): the clock is held and moves from one timer to the next up to the target, and every
// computer handles each one (and starts its next timer) before the clock moves again, so a loop of sleep(600) runs six
// times in an hour's jump. One that would take more than JUMP_BUDGET of real time does the rest at once.
static std::atomic<bool> clockJumping(false);
static std::mutex jumpMu;
static std::chrono::system_clock::time_point jumpTarget;
static std::chrono::steady_clock::time_point jumpStageDeadline, jumpDeadline;
static const auto JUMP_BUDGET = std::chrono::seconds(30);

/** Not running any Lua now: waiting for an event (maybe with events queued behind a pause), or off. */
static bool atRest(Computer * c) {
    return c->running != 1 || c->L == NULL || c->getting_event;
}

/** Waiting for an event with none queued and no http request open: nothing will happen until a timer fires. */
static bool idleNow(Computer * c) {
    if (c->running != 1 || c->L == NULL) return true;
    if (!c->getting_event || !c->eventQueue.empty() || c->requests_open > 0) return false;
    {
        std::lock_guard<std::mutex> lock(c->event_provider_queue_mutex);
        if (!c->event_provider_queue.empty()) return false;
    }
    std::lock_guard<std::mutex> lock(c->termEventQueueMutex);
    return c->termEventQueue.empty();
}

static long long epochMs(std::chrono::system_clock::time_point t) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(t.time_since_epoch()).count();
}

static void writeStatus() {
    static const char * path = getenv("CRAFTOS_CLOCK_FILE");
    if (path == NULL || !*path) return;
    const auto v = vnow();
    long long clockMs = -1, worldMs = -1;
    {
        LockGuard lock(computers);
        for (Computer * c : *computers) {
            if (c->isDebugger) continue;
            clockMs = epochMs(v) - epochMs(c->system_start);
            worldMs = epochMs(v) - epochMs(simclock::worldStart(c));
            break;
        }
    }
    if (worldMs < 0 && worldStartSet.load()) worldMs = epochMs(v) - worldStartMs.load();
    char buf[512];
    snprintf(buf, sizeof(buf),
        "{\"seq\":%lld,\"paused\":%s,\"held\":%s,\"stepping\":%s,\"jumping\":%s,\"max\":%s,\"speed\":%g,\"virtualMs\":%lld,\"realMs\":%lld,\"clockMs\":%lld,\"worldMs\":%lld}\n",
        clockSeq.load(), clockPaused ? "true" : "false", simclock::held() ? "true" : "false",
        clockStepping ? "true" : "false", clockJumping ? "true" : "false", clockMax ? "true" : "false", timeScale, epochMs(v),
        epochMs(std::chrono::system_clock::now()), clockMs, worldMs);
    std::lock_guard<std::mutex> lock(statusMu);
    FILE * fp = fopen(path, "wb");
    if (fp == NULL) return;
    fputs(buf, fp);
    fclose(fp);
}

/** Jump to the earliest timer still to come (as fast as possible). */
static void jumpToNextTimer() {
    bool any = false;
    std::chrono::system_clock::time_point next;
    {
        LockGuard lock(runningTimerData);
        for (const auto& i : *runningTimerData) {
            if (!any || i.second->vdue < next) next = i.second->vdue;
            any = true;
        }
    }
    if (!any) return;
    const double ms = std::chrono::duration<double, std::milli>(next - vnow()).count();
    advanceBy((std::max)(ms, 1.0));
}

/** A person's jump of `ms`: see clockJumping. A jump while one runs goes on further. */
static void startJump(double ms) {
    if (!(ms > 0)) return;
    std::lock_guard<std::mutex> lock(jumpMu);
    const auto length = std::chrono::duration_cast<std::chrono::system_clock::duration>(std::chrono::duration<double, std::milli>(ms));
    if (clockJumping) {jumpTarget += length; return;}
    simclock::hold(true);
    jumpTarget = vnow() + length;
    const auto now = std::chrono::steady_clock::now();
    jumpStageDeadline = now + std::chrono::seconds(5);
    jumpDeadline = now + JUMP_BUDGET;
    clockJumping = true;
    gateCv.notify_all();
}

/** Every computer has handled the last timer (or kept working 5 s): on to the next one, or the end of the jump. */
static void jumpStage(std::chrono::steady_clock::time_point now) {
    std::lock_guard<std::mutex> lock(jumpMu);
    if (!clockJumping) return;
    bool any = false;
    std::chrono::system_clock::time_point next;
    {
        LockGuard lock2(runningTimerData);
        for (const auto& i : *runningTimerData) {
            if (!any || i.second->vdue < next) next = i.second->vdue;
            any = true;
        }
    }
    if (any && next <= jumpTarget && now <= jumpDeadline) {
        advanceTo(next);
        jumpStageDeadline = now + std::chrono::seconds(5);
        return;
    }
    advanceTo(jumpTarget);
    clockJumping = false;
    simclock::hold(false);
}

static void watchLoop() {
    int idleRuns = 0;
    auto lastWrite = std::chrono::steady_clock::now();
    auto idleSince = lastWrite;
    while (!exiting) {
        // a jump looks often (a 1 s loop in an hour's jump is 3600 rounds); otherwise every 2 ms
        if (clockJumping) std::this_thread::sleep_for(std::chrono::microseconds(100));
        else std::this_thread::sleep_for(std::chrono::milliseconds(2));
        const auto now = std::chrono::steady_clock::now();
        const bool needed = (clockPaused && !pauseHolding) || clockStepping || clockJumping || (clockMax && !clockPaused);
        if (!needed) {
            idleRuns = 0;
            // now and then, so the host's view follows reboots (each computer's clock starts again)
            if (now - lastWrite > std::chrono::seconds(1)) {writeStatus(); lastWrite = now;}
            continue;
        }
        bool rest = true, idle = true;
        {
            LockGuard lock(computers);
            for (Computer * c : *computers) {
                if (!atRest(c)) rest = false;
                if (!idleNow(c)) idle = false;
            }
        }
        if (clockPaused && !pauseHolding && rest) {
            simclock::hold(true);
            pauseHolding = true;
            writeStatus();
            lastWrite = now;
        }
        if (clockJumping) {
            // every computer still waiting, with nothing queued, half a millisecond on: it is done with the timer
            if (!idle) idleRuns = 0;
            else if (idleRuns++ == 0) idleSince = now;
            if ((idleRuns >= 3 && now - idleSince >= std::chrono::microseconds(500)) || now > jumpStageDeadline) {
                idleRuns = 0;
                jumpStage(now);
                if (!clockJumping) {writeStatus(); lastWrite = now;}
            }
            if (now - lastWrite > std::chrono::milliseconds(100)) {writeStatus(); lastWrite = now;}
        } else if (clockStepping) {
            idleRuns = idle ? idleRuns + 1 : 0;
            // done when every computer waits with nothing to do, or after 5 s of a computer that keeps working
            if (idleRuns >= 3 || now > stepDeadline) {
                clockStepping = false;
                idleRuns = 0;
                writeStatus();
                lastWrite = now;
            }
        } else if (clockMax && !clockPaused) {
            idleRuns = idle ? idleRuns + 1 : 0;
            if (idleRuns >= 3) {
                idleRuns = 0;
                jumpToNextTimer();
            }
            if (now - lastWrite > std::chrono::milliseconds(100)) {writeStatus(); lastWrite = now;}
        }
    }
}

static void ensureWatcher() {
    std::lock_guard<std::mutex> lock(watcherMu);
    if (watcherStarted) return;
    watcherStarted = true;
    std::thread(watchLoop).detach();
}

/**
 * After the clock speeds up, a timer already waiting would still wait out the real time it was given at the old speed:
 * this goes off when it falls due at the new speed and fires it (the timer's own SDL timer stays, and finds it gone).
 */
static Uint32 speedHelper(Uint32, void* param) {
    const SDL_TimerID id = (SDL_TimerID)(intptr_t)param;
    timer_data_t * data;
    {
        LockGuard lock(runningTimerData);
        const auto it = runningTimerData->find(id);
        if (it == runningTimerData->end() || exiting) return 0;
        data = it->second;
        if (simclock::held()) return 20;
        const auto left = data->vdue - vnow();
        if (left > std::chrono::system_clock::duration::zero())
            return (Uint32)(std::max)(1.0, ceil(std::chrono::duration<double, std::milli>(left).count() / timeScale));
    }
    SDL_RemoveTimer(id);
    notifyEvent(0, data);
    return 0;
}

static void setSpeed(double x) {
    if (!(x > 0)) return;
    x = (std::min)((std::max)(x, 0.01), 1000.0);
    const double was = timeScale;
    {
        const auto real = unheldNow();
        std::lock_guard<std::mutex> lock(anchorMu);
        vAnchor = scaledNow(real);
        rAnchor = real;
        timeScale = x;
    }
    if (x <= was) return; // slower: a timer looks again when it goes off, and waits the rest
    std::vector<SDL_TimerID> ids;
    {
        LockGuard lock(runningTimerData);
        for (const auto& i : *runningTimerData) ids.push_back(i.first);
    }
    for (SDL_TimerID id : ids) SDL_AddTimer(1, speedHelper, (void*)(intptr_t)id);
}

static void resumeClock() {
    clockStepping = false;
    clockPaused = false;
    if (pauseHolding.exchange(false)) simclock::hold(false);
    gateCv.notify_all();
}

void simclock::command(const std::string& text) {
    // "<seq>:<verb>[:<arg>]"
    std::string seq, verb, arg;
    const size_t a = text.find(':');
    if (a == std::string::npos) verb = text;
    else {
        seq = text.substr(0, a);
        const size_t b = text.find(':', a + 1);
        verb = text.substr(a + 1, b == std::string::npos ? std::string::npos : b - a - 1);
        if (b != std::string::npos) arg = text.substr(b + 1);
    }
    const double value = arg.empty() ? 0.0 : atof(arg.c_str());
    if (verb == "pause") {
        clockPaused = true;
    } else if (verb == "resume") {
        resumeClock();
    } else if (verb == "step") {
        clockPaused = true;
        stepDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        advanceBy(value > 0 ? value : 50.0);
        clockStepping = true;
        gateCv.notify_all();
    } else if (verb == "speed") {
        clockMax = false;
        setSpeed(value);
    } else if (verb == "max") {
        setSpeed(1.0);
        clockMax = true;
    } else if (verb == "advance") {
        startJump(value);
    } else if (verb == "worldtime") {
        worldStartMs = epochMs(vnow()) - (long long)value;
        worldStartSet = true;
    }
    if (!seq.empty()) clockSeq = atoll(seq.c_str());
    ensureWatcher();
    writeStatus();
}

void simclock::waitWhilePaused(Computer * comp) {
    if (!clockPaused.load() || clockStepping.load() || clockJumping.load()) return;
    std::unique_lock<std::mutex> lock(gateMu);
    while (clockPaused.load() && !clockStepping.load() && !clockJumping.load() && comp->running == 1 && !exiting)
        gateCv.wait_for(lock, std::chrono::milliseconds(50));
}

std::string simclock::tag() {
    if (clockPaused) return "[Paused] ";
    if (clockMax) return "[Max speed] ";
    if (timeScale != 1.0) {
        char buf[32];
        snprintf(buf, sizeof(buf), "[%gx] ", timeScale);
        return buf;
    }
    return "";
}

bool simclock::hotkey(int sym, int mod) {
    // Alt and the key, nothing else held (Caps and Num Lock aside)
    const int held = mod & ~(KMOD_CAPS | KMOD_NUM);
    if (!(held & KMOD_ALT) || (held & ~(KMOD_ALT | KMOD_SHIFT))) return false;
    static const double speeds[] = {0.5, 1, 2, 5, 10};
    const int count = sizeof(speeds) / sizeof(speeds[0]);
    int at = 1;
    for (int i = 0; i < count; i++) if (timeScale >= speeds[i] - 1e-9) at = i;
    switch (sym) {
        case SDLK_p: command(clockPaused ? "0:resume" : "0:pause"); return true;
        case SDLK_PERIOD: command("0:step:50"); return true;
        case SDLK_RIGHTBRACKET:
            if (clockMax) return true;
            if (at + 1 < count) command("0:speed:" + std::to_string(speeds[at + 1]));
            else command("0:max");
            return true;
        case SDLK_LEFTBRACKET:
            if (clockMax) command("0:speed:" + std::to_string(speeds[count - 1]));
            else if (at > 0) command("0:speed:" + std::to_string(speeds[at - 1]));
            return true;
        case SDLK_BACKSLASH: command("0:speed:1"); return true;
        case SDLK_j: command("0:advance:60000"); return true;      // a minute
        case SDLK_h: command("0:advance:3600000"); return true;    // an hour
        case SDLK_n: command("0:advance:1200000"); return true;    // a Minecraft day (20 minutes)
        default: return false;
    }
}

// os.__ccsimServerWork(): the sim did the server's own work on this computer's thread (a machine catching up on the
// ticks a jump of the clock skipped). In the game that work runs on the server thread and never counts towards the
// computer's 7 s "Too long without yielding" limit, so it starts the computer's limit again from now, as getNextEvent
// does. The overlay (ccsim.core) takes it out of the os table at boot.
// os.__ccsimJump(seconds): a person's jump typed in the computer (`sim advance`), stepped as the time bar's is
// (startJump): it starts now and goes on while the computer waits. The overlay (ccsim.core) takes it out of os at boot.
static int os_jump(lua_State *L) {
    lastCFunction = __func__;
    const double seconds = luaL_checknumber(L, 1);
    if (seconds > 0) {
        startJump(seconds * 1000.0);
        ensureWatcher();
        writeStatus();
    }
    return 0;
}

static int os_serverWork(lua_State *L) {
    lastCFunction = __func__;
    Computer * computer = get_comp(L);
    computer->timeoutCheckCount = 0;
    computer->last_event = std::chrono::high_resolution_clock::now();
#ifdef __EMSCRIPTEN__
    queueTask([computer](void*)->void*{
#endif
    if (computer->eventTimeout != 0) SDL_RemoveTimer(computer->eventTimeout);
    if (config.abortTimeout > 0 || config.standardsMode) computer->eventTimeout = SDL_AddTimer(config.standardsMode ? 7000 : config.abortTimeout, eventTimeoutEvent, computer);
#ifdef __EMSCRIPTEN__
    return NULL;}, NULL);
#endif
    return 0;
}

// os.__ccsimNative(fn) wraps a Lua function in a C function, for the simulated Java APIs. A Lua function loses its
// caller to a tail call (return peripheral.call(...)), but a Java function never does: a real error reads
// "script:12: msg". So errors get the position of the caller here, and a C function keeps that caller on the stack.
static int nativeFinish(lua_State *L, int status) {
    if (status == LUA_OK || status == LUA_YIELD) return lua_gettop(L);
    if (lua_type(L, -1) == LUA_TSTRING) {
        luaL_where(L, 1);
        lua_insert(L, -2);
        lua_concat(L, 2);
    }
    return lua_error(L);
}

static int nativeContinue(lua_State *L) {
    return nativeFinish(L, lua_getctx(L, NULL));
}

static int nativeCall(lua_State *L) {
    const int nargs = lua_gettop(L);
    lua_pushvalue(L, lua_upvalueindex(1));
    lua_insert(L, 1);
    return nativeFinish(L, lua_pcallk(L, nargs, LUA_MULTRET, 0, 0, nativeContinue));
}

static int os_native(lua_State *L) {
    lastCFunction = __func__;
    luaL_checktype(L, 1, LUA_TFUNCTION);
    lua_settop(L, 1);
    lua_pushcclosure(L, nativeCall, 1);
    return 1;
}

static int getfield(lua_State *L, const char *key, int d) {
    int res;
    lua_getfield(L, -1, key);
    if (lua_isnumber(L, -1))
        res = (int)lua_tointeger(L, -1);
    else {
        if (d < 0)
            return luaL_error(L, "field \"%s\" missing in date table", key);
        res = d;
    }
    lua_pop(L, 1);
    return res;
}

static int getboolfield(lua_State *L, const char *key) {
    lua_getfield(L, -1, key);
    const int res = lua_isnil(L, -1) ? -1 : lua_toboolean(L, -1);
    lua_pop(L, 1);
    return res;
}

static int os_time(lua_State *L) {
    lastCFunction = __func__;
    if (lua_istable(L, 1)) {
        struct tm ts;
        lua_settop(L, 1);  /* make sure table is at the top */
        // CC reports the first missing field in this order (year, month, day)
        ts.tm_year = getfield(L, "year", -1) - 1900;
        ts.tm_mon = getfield(L, "month", -1) - 1;
        ts.tm_mday = getfield(L, "day", -1);
        // LuaDateTime.fromTable: a missing min or sec is 12 before CC 1.119 (a CC bug), 0 from 1.119 on
        const int clockDefault = ccAtLeast(get_comp(L), 1, 119, 0) ? 0 : 12;
        ts.tm_sec = getfield(L, "sec", clockDefault);
        ts.tm_min = getfield(L, "min", clockDefault);
        ts.tm_hour = getfield(L, "hour", 12);
        ts.tm_isdst = getboolfield(L, "isdst");
        lua_pushinteger(L, mktime(&ts));
        return 1;
    }
    std::string tmp(luaL_optstring(L, 1, "ingame"));
    std::transform(tmp.begin(), tmp.end(), tmp.begin(), [](unsigned char c) {return std::tolower(c); });
    if (tmp == "ingame") {
        lua_pushnumber(L, floor((double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow() - simclock::worldStart(get_comp(L))).count() + 300000LL) % 1200000LL) / 50.0) / 1000.0);
        return 1;
    } else if (tmp != "utc" && tmp != "local") luaL_error(L, "Unsupported operation");
    time_t t = std::chrono::system_clock::to_time_t(vnow());
    struct tm rightNow;
    if (tmp == "utc") rightNow = *gmtime(&t);
    else rightNow = *localtime(&t);
    const int hour = rightNow.tm_hour;
    const int minute = rightNow.tm_min;
    const int second = rightNow.tm_sec;
    const int milli = (int)std::chrono::duration_cast<std::chrono::milliseconds>(vnow().time_since_epoch()).count() % 1000LL;
    lua_pushnumber(L, (double)hour + ((double)minute / 60.0) + ((double)second / 3600.0) + (milli / 3600000.0));
    return 1;
}

static int os_epoch(lua_State *L) {
    lastCFunction = __func__;
    std::string tmp(luaL_optstring(L, 1, "ingame"));
    std::transform(tmp.begin(), tmp.end(), tmp.begin(), [](unsigned char c) {return std::tolower(c); });
    if (tmp == "utc") {
#if PTRDIFF_MAX <= 0xFFFFFFFFFFFFLL
        lua_pushnumber(L, (double)std::chrono::duration_cast<std::chrono::milliseconds>(vnow().time_since_epoch()).count());
#else
        lua_pushinteger(L, std::chrono::duration_cast<std::chrono::milliseconds>(vnow().time_since_epoch()).count());
#endif
    } else if (tmp == "local") {
        time_t t = std::chrono::system_clock::to_time_t(vnow());
        const time_t utime = mktime(gmtime(&t));
        tm * ltime = localtime(&t);
        const long long off = (long long)mktime(ltime) - utime + (ltime->tm_isdst ? 3600LL : 0LL);
#if PTRDIFF_MAX <= 0xFFFFFFFFFFFFLL
        lua_pushnumber(L, (double)std::chrono::duration_cast<std::chrono::milliseconds>(vnow().time_since_epoch()).count() + (off * 1000LL));
#else
        lua_pushinteger(L, std::chrono::duration_cast<std::chrono::milliseconds>(vnow().time_since_epoch()).count() + (off * 1000LL));
#endif
    } else if (tmp == "ingame") {
        const double m_time = (double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow() - simclock::worldStart(get_comp(L))).count() + 300000LL) % 1200000LL) / 50000.0;
        const double m_day = std::chrono::duration_cast<std::chrono::minutes>(vnow() - simclock::worldStart(get_comp(L))).count() / 20 + 1;
        lua_Integer epoch = (lua_Integer)(m_day * 86400000) + (lua_Integer)(m_time * 3600000.0);
        if (config.standardsMode) epoch = (lua_Integer)floor(epoch / 200) * 200;
        lua_pushinteger(L, epoch);
    } else if (tmp == "nano") {
#if PTRDIFF_MAX <= 0xFFFFFFFFFFFFLL
        lua_pushnumber(L, (double)(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::high_resolution_clock::now().time_since_epoch()).count() & 0x1FFFFFFFFFFFFFLL));
#else
        lua_pushinteger(L, std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::high_resolution_clock::now().time_since_epoch()).count() & 0x1FFFFFFFFFFFFFLL);
#endif
    } else luaL_error(L, "Unsupported operation");
    return 1;
}

static int os_day(lua_State *L) {
    lastCFunction = __func__;
    std::string tmp(luaL_optstring(L, 1, "ingame"));
    std::transform(tmp.begin(), tmp.end(), tmp.begin(), [](unsigned char c) {return std::tolower(c); });
    time_t t = std::chrono::system_clock::to_time_t(vnow());
    if (tmp == "ingame") {
        lua_pushinteger(L, std::chrono::duration_cast<std::chrono::minutes>(vnow() - simclock::worldStart(get_comp(L))).count() / 20 + 1);
        return 1;
    } else if (tmp == "local") t = mktime(localtime(&t));
    else if (tmp != "utc") luaL_error(L, "Unsupported operation");
    lua_pushinteger(L, t / (60 * 60 * 24));
    return 1;
}

static int os_setAlarm(lua_State *L) {
    lastCFunction = __func__;
    const double time = luaL_checknumber(L, 1);
    if (time < 0.0 || time >= 24.0) luaL_error(L, "Number out of range");
    Computer * computer = get_comp(L);
    const double current_time = floor((double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow() - simclock::worldStart(computer)).count() + 300000LL) % 1200000LL) / 50.0) / 1000.0;
    double delta_time;
    if (time >= current_time) delta_time = time - current_time;
    else delta_time = (time + 24.0) - current_time;
    Uint32 real_time = (Uint32)(delta_time * 50000.0);
    struct timer_data_t * data = new struct timer_data_t;
    data->comp = computer;
    data->lock = new std::mutex;
    data->isAlarm = true;
    queueTask([real_time](void*a)->void* {
        struct timer_data_t * data = (timer_data_t*)a;
        Uint32 time = real_time;
        if (config.standardsMode) time = (Uint32)ceil(time / 50.0) * 50;
        LockGuard lock(runningTimerData);
        data->vdue = vnow() + std::chrono::milliseconds(time);
        data->due = std::chrono::steady_clock::now() + std::chrono::milliseconds(scaledMs(time) + 3);
        data->timer = SDL_AddTimer(scaledMs(time) + 3, notifyEvent, data);
        runningTimerData->insert(std::make_pair(data->timer, data));
        return NULL;
    }, data);
    lua_pushinteger(L, data->timer);
    std::lock_guard<std::mutex> lock(computer->timerIDsMutex);
    computer->timerIDs.insert(data->timer);
    return 1;
}

static int os_cancelAlarm(lua_State *L) {
    lastCFunction = __func__;
    const SDL_TimerID id = (SDL_TimerID)luaL_checkinteger(L, 1);
    timer_data_t * data;
    {
        LockGuard lock(runningTimerData);
        if (runningTimerData->find(id) == runningTimerData->end()) return 0;
        data = (*runningTimerData)[id];
        runningTimerData->erase(id);
    } {
        std::lock_guard<std::mutex> lock(*data->lock);
    #ifdef __EMSCRIPTEN__
        queueTask([id](void*)->void* {SDL_RemoveTimer(id); return NULL; }, NULL);
    #else
        SDL_RemoveTimer(id);
    #endif
    }
    delete data->lock;
    delete data;
    return 0;
}

static int os_shutdown(lua_State *L) {
    lastCFunction = __func__;
    // Raw clients only see what was rendered; push the final screens before teardown.
    if (selectedRenderer == 3) {
        std::lock_guard<std::mutex> lock(renderTargetsLock);
        for (Terminal * t : renderTargets) {t->render(); t->frozen = true;}
    }
    get_comp(L)->running = 0;
    if (lua_isnumber(L, 1)) returnValue = (int)lua_tointeger(L, 1);
    return 0;
}

static int os_reboot(lua_State *L) {
    lastCFunction = __func__;
    get_comp(L)->running = 2;
    return 0;
}

static int os_about(lua_State *L) {
    lastCFunction = __func__;
    lua_pushstring(L, "CraftOS-PC " CRAFTOSPC_VERSION "\n\nCraftOS-PC 2 is licensed under the MIT License.\nMIT License\n\
\n\
Copyright (c) 2019-2024 JackMacWindows\n\
\n\
Permission is hereby granted, free of charge, to any person obtaining a copy\n\
of this software and associated documentation files (the \"Software\"), to deal\n\
in the Software without restriction, including without limitation the rights\n\
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n\
copies of the Software, and to permit persons to whom the Software is\n\
furnished to do so, subject to the following conditions:\n\
\n\
The above copyright notice and this permission notice shall be included in all\n\
copies or substantial portions of the Software.\n\
\n\
THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n\
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n\
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n\
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n\
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n\
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n\
SOFTWARE.\n\n\
Special thanks:\n\
* dan200 for creating the ComputerCraft mod and making it open source\n\
* SquidDev for picking up ComputerCraft after Dan left and creating CC: Tweaked\n\
* EveryOS for sending me a patched version of Lua that finally fixed issue #1\n\
* Everyone on the Minecraft Computer Mods Discord server for the support while developing CraftOS-PC 2");
    return 1;
}

static luaL_Reg os_reg[] = {
    {"getComputerID", os_getComputerID},
    {"computerID", os_getComputerID},
    {"getComputerLabel", os_getComputerLabel},
    {"computerLabel", os_getComputerLabel},
    {"setComputerLabel", os_setComputerLabel},
    {"queueEvent", os_queueEvent},
    {"clock", os_clock},
    {"startTimer", os_startTimer},
    {"cancelTimer", os_cancelTimer},
    {"time", os_time},
    {"epoch", os_epoch},
    {"day", os_day},
    {"setAlarm", os_setAlarm},
    {"cancelAlarm", os_cancelAlarm},
    {"shutdown", os_shutdown},
    {"reboot", os_reboot},
    {"about", os_about},
    {"__ccsimAdvance", os_advance},
    {"__ccsimJump", os_jump},
    {"__ccsimNative", os_native},
    {"__ccsimServerWork", os_serverWork},
    {NULL, NULL}
};

library_t os_lib = {"os", os_reg, nullptr, nullptr};