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
#include <vector>
#include "../main.hpp"
#include "../runtime.hpp"
#include "../util.hpp"
#include "../termsupport.hpp"

// Virtual clock: --time-scale N makes clocks, dates and timers run N times faster than real time.
static const std::chrono::system_clock::time_point processStart = std::chrono::system_clock::now();
// os.__ccsimAdvance(seconds) jumps the virtual clock forward and fires the timers that fall due in the jump.
static std::atomic<long long> timeOffsetMs(0);
static std::chrono::system_clock::time_point vnow() {
    const auto real = std::chrono::system_clock::now();
    const auto offset = std::chrono::milliseconds(timeOffsetMs.load());
    if (timeScale == 1.0) return real + offset;
    return processStart + std::chrono::duration_cast<std::chrono::system_clock::duration>((real - processStart) * timeScale) + offset;
}
static Uint32 scaledMs(Uint32 ms) {
    if (timeScale == 1.0) return ms;
    const Uint32 scaled = (Uint32)(ms / timeScale);
    return scaled == 0 ? 1 : scaled;
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

// Test harness hook: advance the virtual clock by N seconds and fire every timer that falls due within the
// jump, earliest first. Timers due later keep their real deadline. The overlay (ccsim.core) takes this
// function out of the os table at boot, so programs never see it.
static int os_advance(lua_State *L) {
    lastCFunction = __func__;
    const double seconds = luaL_checknumber(L, 1);
    if (seconds <= 0) return 0;
    const double realMs = seconds * 1000.0 / timeScale;
    const auto limit = std::chrono::steady_clock::now() + std::chrono::microseconds((long long)(realMs * 1000.0));
    std::vector<timer_data_t*> due;
    {
        LockGuard lock(runningTimerData);
        for (const auto& i : *runningTimerData) if (i.second->due <= limit) due.push_back(i.second);
    }
    std::sort(due.begin(), due.end(), [](timer_data_t * a, timer_data_t * b) {return a->due < b->due;});
    timeOffsetMs += (long long)(seconds * 1000.0);
    for (timer_data_t * data : due) {
        const SDL_TimerID id = data->timer;
        SDL_RemoveTimer(id);
        notifyEvent(0, data);
    }
    return 0;
}

// os.__ccsimServerWork(): the sim did the server's own work on this computer's thread (a machine catching up on the
// ticks a jump of the clock skipped). In the game that work runs on the server thread and never counts towards the
// computer's 7 s "Too long without yielding" limit, so it starts the computer's limit again from now, as getNextEvent
// does. The overlay (ccsim.core) takes it out of the os table at boot.
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
        lua_pushnumber(L, floor((double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow() - get_comp(L)->system_start).count() + 300000LL) % 1200000LL) / 50.0) / 1000.0);
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
        const double m_time = (double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow() - get_comp(L)->system_start).count() + 300000LL) % 1200000LL) / 50000.0;
        const double m_day = std::chrono::duration_cast<std::chrono::minutes>(vnow() - get_comp(L)->system_start).count() / 20 + 1;
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
        lua_pushinteger(L, std::chrono::duration_cast<std::chrono::minutes>(vnow() - get_comp(L)->system_start).count() / 20 + 1);
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
    const double current_time = floor((double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow() - computer->system_start).count() + 300000LL) % 1200000LL) / 50.0) / 1000.0;
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
    {"__ccsimNative", os_native},
    {"__ccsimServerWork", os_serverWork},
    {NULL, NULL}
};

library_t os_lib = {"os", os_reg, nullptr, nullptr};