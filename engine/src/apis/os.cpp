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
// Every piece of clock state lives in a domain (simclock.hpp): one for the whole engine as it always was, or one per
// computer in pool mode.
static const auto JUMP_BUDGET = std::chrono::seconds(30);
struct simclock::Domain {
    std::chrono::system_clock::time_point start = std::chrono::system_clock::now();
    // how far the clock was jumped, in system_clock ticks (whole milliseconds lost a little each jump, and a stepped
    // jump lands on each timer exactly)
    std::atomic<long long> timeOffsetTicks{0};
    // held: the real time spent held so far is taken off the clock; while held the clock reads the same to the tick
    std::mutex holdMu;
    int holdCount = 0;
    std::chrono::system_clock::duration heldTotal = std::chrono::system_clock::duration::zero();
    std::chrono::system_clock::time_point holdStarted;
    // scaled: vAnchor + (real - rAnchor) * timeScale; a change of speed moves the anchors, so the clock never jumps
    std::mutex anchorMu;
    std::chrono::system_clock::time_point vAnchor = start, rAnchor = start;
    double timeScale = 1.0;
    // os.time / os.day: from each computer's start, unless `worldtime` set one world clock for every computer
    std::atomic<bool> worldStartSet{false};
    std::atomic<long long> worldStartMs{0}; // virtual ms since the epoch
    // the controls (pause, step, speed, max, jump)
    std::atomic<bool> clockPaused{false}, clockStepping{false}, clockMax{false};
    std::atomic<bool> pauseHolding{false}; // the pause holds the clock (every computer reached its wait)
    std::atomic<long long> clockSeq{0};
    std::chrono::steady_clock::time_point stepDeadline;
    std::mutex gateMu, statusMu;
    std::condition_variable gateCv;
    // A person's jump (`advance`): the clock is held and moves from one timer to the next up to the target, and every
    // computer handles each one (and starts its next timer) before the clock moves again, so a loop of sleep(600) runs
    // six times in an hour's jump. One that would take more than JUMP_BUDGET of real time does the rest at once.
    std::atomic<bool> clockJumping{false};
    std::mutex jumpMu;
    std::chrono::system_clock::time_point jumpTarget;
    std::chrono::steady_clock::time_point jumpStageDeadline, jumpDeadline;
    // the watcher's own bookkeeping for this domain (watchLoop)
    bool watched = false; // a control came: the watcher looks after this domain from now on
    bool inUse = true;
    int idleRuns = 0;
    std::chrono::steady_clock::time_point lastWrite = std::chrono::steady_clock::now(), idleSince = lastWrite;
    std::string statusPath; // CRAFTOS_CLOCK_FILE for the default domain, the host's choice for a pooled computer
};
typedef simclock::Domain Domain;

static std::mutex domainsMu; // guards domainList (and inUse / watched of every domain)
static std::vector<Domain*> domainList;
Domain * simclock::defaultDomain() {
    static Domain * d = [](){
        Domain * nd = new Domain();
        nd->timeScale = ::timeScale;
        const char * path = getenv("CRAFTOS_CLOCK_FILE");
        if (path != NULL) nd->statusPath = path;
        std::lock_guard<std::mutex> lock(domainsMu);
        domainList.push_back(nd);
        return nd;
    }();
    return d;
}
Domain * simclock::acquire(double scale, const std::string& statusPath) {
    defaultDomain();
    std::lock_guard<std::mutex> lock(domainsMu);
    Domain * d = NULL;
    // a released domain is kept (never freed): a timer of its last computer may still look at it once, then finds
    // itself freed (notifyEvent)
    for (Domain * e : domainList) if (!e->inUse) {d = e; break;}
    if (d == NULL) {d = new Domain(); domainList.push_back(d);}
    else {
        // as new
        d->start = std::chrono::system_clock::now();
        d->timeOffsetTicks = 0;
        d->holdCount = 0;
        d->heldTotal = std::chrono::system_clock::duration::zero();
        d->vAnchor = d->rAnchor = d->start;
        d->worldStartSet = false;
        d->worldStartMs = 0;
        d->clockPaused = d->clockStepping = d->clockMax = d->pauseHolding = d->clockJumping = false;
        d->clockSeq = 0;
        d->watched = false;
        d->idleRuns = 0;
    }
    d->timeScale = scale > 0 ? scale : 1.0;
    d->statusPath = statusPath;
    d->inUse = true;
    return d;
}
void simclock::release(Domain * d) {
    if (d == NULL || d == defaultDomain()) return;
    std::lock_guard<std::mutex> lock(domainsMu);
    d->inUse = false;
    d->watched = false;
    d->gateCv.notify_all();
}
Domain * simclock::of(Computer * comp) {
    return comp != NULL && comp->clockDomain != NULL ? comp->clockDomain : defaultDomain();
}

/** Real time with the time held taken off: it stands still while held. */
static std::chrono::system_clock::time_point unheldNow(Domain& d) {
    std::lock_guard<std::mutex> lock(d.holdMu);
    return (d.holdCount > 0 ? d.holdStarted : std::chrono::system_clock::now()) - d.heldTotal;
}
static std::chrono::system_clock::time_point scaledNow(Domain& d, std::chrono::system_clock::time_point real) {
    if (d.timeScale == 1.0 && d.vAnchor == d.rAnchor) return real;
    return d.vAnchor + std::chrono::duration_cast<std::chrono::system_clock::duration>((real - d.rAnchor) * d.timeScale);
}
static std::chrono::system_clock::time_point vnow(Domain& d) {
    const auto real = unheldNow(d);
    const auto offset = std::chrono::system_clock::duration(d.timeOffsetTicks.load());
    std::lock_guard<std::mutex> lock(d.anchorMu);
    return scaledNow(d, real) + offset;
}
static std::chrono::system_clock::time_point vnow(Computer * comp) {return vnow(*simclock::of(comp));}
static std::chrono::system_clock::time_point vnow(lua_State *L) {return vnow(get_comp(L));}
static Uint32 scaledMs(Domain& d, Uint32 ms) {
    if (d.timeScale == 1.0) return ms;
    const Uint32 scaled = (Uint32)(ms / d.timeScale);
    return scaled == 0 ? 1 : scaled;
}
std::chrono::system_clock::time_point simclock::worldStart(Computer * comp) {
    Domain& d = *of(comp);
    if (d.worldStartSet.load()) return std::chrono::system_clock::time_point(std::chrono::milliseconds(d.worldStartMs.load()));
    return comp->system_start;
}
std::chrono::system_clock::time_point simclock::now(Computer * comp) {return vnow(comp);}
double simclock::scale(Computer * comp) {return of(comp)->timeScale;}
static void holdDomain(Domain& d, bool on) {
    std::lock_guard<std::mutex> lock(d.holdMu);
    if (on) {
        if (d.holdCount++ == 0) d.holdStarted = std::chrono::system_clock::now();
    } else if (d.holdCount > 0 && --d.holdCount == 0) {
        d.heldTotal += std::chrono::system_clock::now() - d.holdStarted;
    }
}
static bool heldDomain(Domain& d) {
    std::lock_guard<std::mutex> lock(d.holdMu);
    return d.holdCount > 0;
}
void simclock::hold(bool on) {holdDomain(*defaultDomain(), on);}
bool simclock::held() {return heldDomain(*defaultDomain());}

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
    setComputerConfig(comp->id, *comp->config, path_t(comp->basePath));
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
    lua_pushnumber(L, (double)std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L) - computer->system_start).count() / 1000.0);
    return 1;
}

struct timer_data_t {
    Computer * comp;
    SDL_TimerID timer;
    std::mutex * lock;
    bool isAlarm;
    std::chrono::steady_clock::time_point due; // real time the SDL timer fires, for os.__ccsimAdvance
    std::chrono::system_clock::time_point vdue; // virtual time (vnow) it is due: it never fires before
    Domain * dom; // the clock it runs on (its computer's); domains are never freed, so this outlives the computer
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

static Uint32 notifyLocked(Uint32 interval, timer_data_t * data);

static Uint32 notifyEvent(Uint32 interval, void* param) {
    struct timer_data_t * data = (timer_data_t*)param;
    bool found = false;
    LockGuard lock2(runningTimerData);
    for (const auto& i : *runningTimerData) if (i.second == param) { found = true; break; }
    if (!found) return 0;
    return notifyLocked(interval, data);
}

/** notifyEvent with runningTimerData already locked and `data` known to be in it. */
static Uint32 notifyLocked(Uint32 interval, timer_data_t * data) {
    // SDL counts whole milliseconds of its own clock, so a timer can go off a little before os.clock says its time
    // has passed (four 0.05 s timers in a row came to 0.199 s). In the game both move by the same ticks: never fire
    // early, wait out the rest. interval 0 is os.__ccsimAdvance firing it on purpose.
    if (interval != 0 && !exiting && data->comp != NULL) {
        // held (a debugger's stop, a pause): the clock stands still, so no timer falls due; look again shortly
        if (heldDomain(*data->dom)) return 20;
        const auto left = data->vdue - vnow(*data->dom);
        if (left > std::chrono::system_clock::duration::zero()) {
            const double leftMs = std::chrono::duration<double, std::milli>(left).count() / data->dom->timeScale;
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
    data->dom = simclock::of(computer);
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
        data->vdue = vnow(*data->dom) + std::chrono::milliseconds(time);
        data->due = std::chrono::steady_clock::now() + std::chrono::milliseconds(scaledMs(*data->dom, time));
        data->timer = SDL_AddTimer(scaledMs(*data->dom, time), notifyEvent, data);
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

/*
 * A computer is going away (Computer::~Computer): every timer and alarm still pointing at it goes too. One that had
 * already fired, with its event still in the queue the computer never read, was left in runningTimerData for good,
 * and not in freedTimers (its id had left timerIDs when it fired), holding a pointer to the freed computer. A single
 * clock never looked at it again, but in pool mode the clock domain goes to the next computer, whose
 * os.__ccsimAdvance found the old timer on "its" clock and fired it at the dead computer (a crash in notifyEvent).
 * Under the table's lock, so a timer callback running now finds its timer gone before it touches it.
 */
void osForgetTimers(Computer * comp) {
    std::vector<SDL_TimerID> ids;
    {
        LockGuard lock(runningTimerData);
        for (auto it = runningTimerData->begin(); it != runningTimerData->end();) {
            timer_data_t * data = it->second;
            if (data->comp != comp) {++it; continue;}
            ids.push_back(it->first);
            it = runningTimerData->erase(it);
            delete data->lock;
            delete data;
        }
    }
    for (SDL_TimerID id : ids) SDL_RemoveTimer(id);
    LockGuard lock(freedTimers);
    for (SDL_TimerID id : ids) freedTimers->erase(id);
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
static void advanceTo(Domain& d, std::chrono::system_clock::time_point limit) {
    const auto gap = limit - vnow(d);
    if (gap > std::chrono::system_clock::duration::zero()) d.timeOffsetTicks += gap.count();
    // ids and due times, not the timers themselves: one can be freed (handled, cancelled, its computer gone) while the
    // table is unlocked, so each is looked up again, by id, under the lock, as it fires
    std::vector<std::pair<std::chrono::system_clock::time_point, SDL_TimerID>> due;
    {
        LockGuard lock(runningTimerData);
        for (const auto& i : *runningTimerData) if (i.second->dom == &d && i.second->vdue <= limit) due.push_back(std::make_pair(i.second->vdue, i.first));
    }
    std::sort(due.begin(), due.end());
    for (const auto& entry : due) {
        const SDL_TimerID id = entry.second;
        SDL_RemoveTimer(id);
        LockGuard lock(runningTimerData);
        const auto it = runningTimerData->find(id);
        if (it != runningTimerData->end()) notifyLocked(0, it->second);
    }
}

// Jump the virtual clock forward by ms at once (os.__ccsimAdvance, a step, as fast as possible): the timers that fall
// due within the jump fire in order, but a timer the program starts on one of them does not (the person's jump,
// `advance`, is stepped: startJump).
static void advanceBy(Domain& d, double ms) {
    if (ms <= 0) return;
    advanceTo(d, vnow(d) + std::chrono::duration_cast<std::chrono::system_clock::duration>(std::chrono::duration<double, std::milli>(ms)));
}

// Test harness hook: advance the virtual clock by N seconds (advanceBy). The overlay (ccsim.core) takes this
// function out of the os table at boot, so programs never see it.
static int os_advance(lua_State *L) {
    lastCFunction = __func__;
    const double seconds = luaL_checknumber(L, 1);
    if (seconds <= 0) return 0;
    advanceBy(*simclock::of(get_comp(L)), seconds * 1000.0);
    return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The controls a person has over the clock (simclock.hpp): pause, step, speed, as fast as possible, jump. Each acts on
// one domain and the computers on it.

static std::mutex watcherMu;
static std::condition_variable watcherCv; // a control came: the watcher looks again now, not at its next round
static bool watcherStarted = false;

/** Not running any Lua now: waiting for an event (maybe with events queued behind a pause), or off. */
static bool atRest(Computer * c) {
    return c->running != 1 || c->L == NULL || c->getting_event;
}

/** Waiting for an event with none queued and no http request open: nothing will happen until a timer fires. */
static bool idleNow(Computer * c) {
    if (c->running != 1 || c->L == NULL) return true;
    if (!c->getting_event || !c->parked || !c->eventQueue.empty() || c->requests_open > 0) return false;
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

static void writeStatus(Domain& d) {
    if (d.statusPath.empty()) return;
    const auto v = vnow(d);
    long long clockMs = -1, worldMs = -1;
    {
        LockGuard lock(computers);
        for (Computer * c : *computers) {
            if (c->isDebugger || simclock::of(c) != &d) continue;
            clockMs = epochMs(v) - epochMs(c->system_start);
            worldMs = epochMs(v) - epochMs(simclock::worldStart(c));
            break;
        }
    }
    if (worldMs < 0 && d.worldStartSet.load()) worldMs = epochMs(v) - d.worldStartMs.load();
    char buf[512];
    snprintf(buf, sizeof(buf),
        "{\"seq\":%lld,\"paused\":%s,\"held\":%s,\"stepping\":%s,\"jumping\":%s,\"max\":%s,\"speed\":%g,\"virtualMs\":%lld,\"realMs\":%lld,\"clockMs\":%lld,\"worldMs\":%lld}\n",
        d.clockSeq.load(), d.clockPaused ? "true" : "false", heldDomain(d) ? "true" : "false",
        d.clockStepping ? "true" : "false", d.clockJumping ? "true" : "false", d.clockMax ? "true" : "false", d.timeScale, epochMs(v),
        epochMs(std::chrono::system_clock::now()), clockMs, worldMs);
    std::lock_guard<std::mutex> lock(d.statusMu);
    FILE * fp = fopen(d.statusPath.c_str(), "wb");
    if (fp == NULL) return;
    fputs(buf, fp);
    fclose(fp);
}

/** The earliest timer still to come on this clock; false when there is none. */
static bool nextTimer(Domain& d, std::chrono::system_clock::time_point& next) {
    bool any = false;
    LockGuard lock(runningTimerData);
    for (const auto& i : *runningTimerData) {
        if (i.second->dom != &d) continue;
        if (!any || i.second->vdue < next) next = i.second->vdue;
        any = true;
    }
    return any;
}

/** Jump to the earliest timer still to come (as fast as possible). */
static void jumpToNextTimer(Domain& d) {
    std::chrono::system_clock::time_point next;
    if (!nextTimer(d, next)) return;
    const double ms = std::chrono::duration<double, std::milli>(next - vnow(d)).count();
    advanceBy(d, (std::max)(ms, 1.0));
}

/** A person's jump of `ms`: see clockJumping. A jump while one runs goes on further. */
static void startJump(Domain& d, double ms) {
    if (!(ms > 0)) return;
    std::lock_guard<std::mutex> lock(d.jumpMu);
    const auto length = std::chrono::duration_cast<std::chrono::system_clock::duration>(std::chrono::duration<double, std::milli>(ms));
    if (d.clockJumping) {d.jumpTarget += length; return;}
    holdDomain(d, true);
    d.jumpTarget = vnow(d) + length;
    const auto now = std::chrono::steady_clock::now();
    d.jumpStageDeadline = now + std::chrono::seconds(5);
    d.jumpDeadline = now + JUMP_BUDGET;
    d.clockJumping = true;
    d.gateCv.notify_all();
}

/** Every computer has handled the last timer (or kept working 5 s): on to the next one, or the end of the jump. */
static void jumpStage(Domain& d, std::chrono::steady_clock::time_point now) {
    std::lock_guard<std::mutex> lock(d.jumpMu);
    if (!d.clockJumping) return;
    std::chrono::system_clock::time_point next;
    const bool any = nextTimer(d, next);
    if (any && next <= d.jumpTarget && now <= d.jumpDeadline) {
        advanceTo(d, next);
        d.jumpStageDeadline = now + std::chrono::seconds(5);
        return;
    }
    advanceTo(d, d.jumpTarget);
    d.clockJumping = false;
    holdDomain(d, false);
}

static bool domainNeeded(Domain& d) {
    return (d.clockPaused && !d.pauseHolding) || d.clockStepping || d.clockJumping || (d.clockMax && !d.clockPaused);
}

/** One round of the watcher for one domain (what the single-clock engine did every round). */
static void watchDomain(Domain& d, std::chrono::steady_clock::time_point now) {
    if (!domainNeeded(d)) {
        d.idleRuns = 0;
        // now and then, so the host's view follows reboots (each computer's clock starts again)
        if (now - d.lastWrite > std::chrono::seconds(1)) {writeStatus(d); d.lastWrite = now;}
        return;
    }
    bool rest = true, idle = true;
    {
        LockGuard lock(computers);
        for (Computer * c : *computers) {
            if (simclock::of(c) != &d) continue;
            if (!atRest(c)) rest = false;
            if (!idleNow(c)) idle = false;
        }
    }
    if (d.clockPaused && !d.pauseHolding && rest) {
        holdDomain(d, true);
        d.pauseHolding = true;
        writeStatus(d);
        d.lastWrite = now;
    }
    if (d.clockJumping) {
        // every computer still waiting, with nothing queued, half a millisecond on: it is done with the timer
        if (!idle) d.idleRuns = 0;
        else if (d.idleRuns++ == 0) d.idleSince = now;
        if ((d.idleRuns >= 3 && now - d.idleSince >= std::chrono::microseconds(500)) || now > d.jumpStageDeadline) {
            d.idleRuns = 0;
            jumpStage(d, now);
            if (!d.clockJumping) {writeStatus(d); d.lastWrite = now;}
        }
        if (now - d.lastWrite > std::chrono::milliseconds(100)) {writeStatus(d); d.lastWrite = now;}
    } else if (d.clockStepping) {
        d.idleRuns = idle ? d.idleRuns + 1 : 0;
        // done when every computer waits with nothing to do, or after 5 s of a computer that keeps working
        if (d.idleRuns >= 3 || now > d.stepDeadline) {
            d.clockStepping = false;
            d.idleRuns = 0;
            writeStatus(d);
            d.lastWrite = now;
        }
    } else if (d.clockMax && !d.clockPaused) {
        d.idleRuns = idle ? d.idleRuns + 1 : 0;
        if (d.idleRuns >= 3) {
            d.idleRuns = 0;
            jumpToNextTimer(d);
        }
        if (now - d.lastWrite > std::chrono::milliseconds(100)) {writeStatus(d); d.lastWrite = now;}
    }
}

// One thread looks after every domain that has had a control. While none of them needs watching (paused, stepping,
// jumping or as fast as possible) it waits for a control instead of looking every 2 ms, waking 4 times a second for
// the status writes (each domain still writes once a second, as before).
static void watchLoop() {
    std::vector<Domain*> watched;
    while (!exiting) {
        watched.clear();
        {
            std::lock_guard<std::mutex> lock(domainsMu);
            for (Domain * d : domainList) if (d->inUse && d->watched) watched.push_back(d);
        }
        bool needed = false, jumping = false;
        const auto now = std::chrono::steady_clock::now();
        for (Domain * d : watched) {
            watchDomain(*d, now);
            if (domainNeeded(*d)) needed = true;
            if (d->clockJumping) jumping = true;
        }
        // a jump looks often (a 1 s loop in an hour's jump is 3600 rounds); otherwise every 2 ms while needed
        if (jumping) std::this_thread::sleep_for(std::chrono::microseconds(100));
        else if (needed) std::this_thread::sleep_for(std::chrono::milliseconds(2));
        else {
            std::unique_lock<std::mutex> lock(watcherMu);
            watcherCv.wait_for(lock, std::chrono::milliseconds(250));
        }
    }
}

static void ensureWatcher(Domain& d) {
    {
        std::lock_guard<std::mutex> lock(domainsMu);
        d.watched = true;
    }
    std::lock_guard<std::mutex> lock(watcherMu);
    watcherCv.notify_all();
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
        if (heldDomain(*data->dom)) return 20;
        const auto left = data->vdue - vnow(*data->dom);
        if (left > std::chrono::system_clock::duration::zero())
            return (Uint32)(std::max)(1.0, ceil(std::chrono::duration<double, std::milli>(left).count() / data->dom->timeScale));
    }
    SDL_RemoveTimer(id);
    // looked up again: it may have gone while the table was unlocked
    LockGuard lock(runningTimerData);
    const auto it = runningTimerData->find(id);
    if (it != runningTimerData->end()) notifyLocked(0, it->second);
    return 0;
}

static void setSpeed(Domain& d, double x) {
    if (!(x > 0)) return;
    x = (std::min)((std::max)(x, 0.01), 1000.0);
    const double was = d.timeScale;
    {
        const auto real = unheldNow(d);
        std::lock_guard<std::mutex> lock(d.anchorMu);
        d.vAnchor = scaledNow(d, real);
        d.rAnchor = real;
        d.timeScale = x;
    }
    if (x <= was) return; // slower: a timer looks again when it goes off, and waits the rest
    std::vector<SDL_TimerID> ids;
    {
        LockGuard lock(runningTimerData);
        for (const auto& i : *runningTimerData) if (i.second->dom == &d) ids.push_back(i.first);
    }
    for (SDL_TimerID id : ids) SDL_AddTimer(1, speedHelper, (void*)(intptr_t)id);
}

static void resumeClock(Domain& d) {
    d.clockStepping = false;
    d.clockPaused = false;
    if (d.pauseHolding.exchange(false)) holdDomain(d, false);
    d.gateCv.notify_all();
}

void simclock::command(const std::string& text) {command(defaultDomain(), text);}

void simclock::command(Domain * dp, const std::string& text) {
    Domain& d = *dp;
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
        d.clockPaused = true;
    } else if (verb == "resume") {
        resumeClock(d);
    } else if (verb == "step") {
        d.clockPaused = true;
        d.stepDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        advanceBy(d, value > 0 ? value : 50.0);
        d.clockStepping = true;
        d.gateCv.notify_all();
    } else if (verb == "speed") {
        d.clockMax = false;
        setSpeed(d, value);
    } else if (verb == "max") {
        setSpeed(d, 1.0);
        d.clockMax = true;
    } else if (verb == "advance") {
        startJump(d, value);
    } else if (verb == "worldtime") {
        d.worldStartMs = epochMs(vnow(d)) - (long long)value;
        d.worldStartSet = true;
    }
    if (!seq.empty()) d.clockSeq = atoll(seq.c_str());
    ensureWatcher(d);
    writeStatus(d);
}

void simclock::waitWhilePaused(Computer * comp) {
    Domain& d = *of(comp);
    if (!d.clockPaused.load() || d.clockStepping.load() || d.clockJumping.load()) return;
    std::unique_lock<std::mutex> lock(d.gateMu);
    while (d.clockPaused.load() && !d.clockStepping.load() && !d.clockJumping.load() && comp->running == 1 && !exiting)
        d.gateCv.wait_for(lock, std::chrono::milliseconds(50));
}

std::string simclock::tag() {
    Domain& d = *defaultDomain();
    if (d.clockPaused) return "[Paused] ";
    if (d.clockMax) return "[Max speed] ";
    if (d.timeScale != 1.0) {
        char buf[32];
        snprintf(buf, sizeof(buf), "[%gx] ", d.timeScale);
        return buf;
    }
    return "";
}

bool simclock::hotkey(int sym, int mod) {
    Domain& d = *defaultDomain();
    // Alt and the key, nothing else held (Caps and Num Lock aside)
    const int held = mod & ~(KMOD_CAPS | KMOD_NUM);
    if (!(held & KMOD_ALT) || (held & ~(KMOD_ALT | KMOD_SHIFT))) return false;
    static const double speeds[] = {0.5, 1, 2, 5, 10};
    const int count = sizeof(speeds) / sizeof(speeds[0]);
    int at = 1;
    for (int i = 0; i < count; i++) if (d.timeScale >= speeds[i] - 1e-9) at = i;
    switch (sym) {
        case SDLK_p: command(d.clockPaused ? "0:resume" : "0:pause"); return true;
        case SDLK_PERIOD: command("0:step:50"); return true;
        case SDLK_RIGHTBRACKET:
            if (d.clockMax) return true;
            if (at + 1 < count) command("0:speed:" + std::to_string(speeds[at + 1]));
            else command("0:max");
            return true;
        case SDLK_LEFTBRACKET:
            if (d.clockMax) command("0:speed:" + std::to_string(speeds[count - 1]));
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
        Domain& d = *simclock::of(get_comp(L));
        startJump(d, seconds * 1000.0);
        ensureWatcher(d);
        writeStatus(d);
    }
    return 0;
}

// os.__ccsimHost(kind, text): the ccsim layer's channel to the host (RawTerminal.cpp rawHostSend; on with
// --host-channel). True when it went, false when there is no channel (then the sim writes its files as before);
// kind "?" only asks. The overlay (ccsim.core) takes it out of the os table at boot.
static int os_host(lua_State *L) {
    lastCFunction = __func__;
    size_t kindLen = 0, len = 0;
    const char * kind = luaL_checklstring(L, 1, &kindLen);
    const char * text = luaL_checklstring(L, 2, &len);
    if (kindLen != 1) return luaL_argerror(L, 1, "one character");
    if (kind[0] == '?') {
        lua_pushboolean(L, rawHostChannel && selectedRenderer == 3);
        return 1;
    }
    lua_pushboolean(L, rawHostSend(get_comp(L), kind[0], std::string(text, len)));
    return 1;
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
        lua_pushnumber(L, floor((double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L) - simclock::worldStart(get_comp(L))).count() + 300000LL) % 1200000LL) / 50.0) / 1000.0);
        return 1;
    } else if (tmp != "utc" && tmp != "local") luaL_error(L, "Unsupported operation");
    time_t t = std::chrono::system_clock::to_time_t(vnow(L));
    struct tm rightNow;
    if (tmp == "utc") rightNow = *gmtime(&t);
    else rightNow = *localtime(&t);
    const int hour = rightNow.tm_hour;
    const int minute = rightNow.tm_min;
    const int second = rightNow.tm_sec;
    const int milli = (int)std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L).time_since_epoch()).count() % 1000LL;
    lua_pushnumber(L, (double)hour + ((double)minute / 60.0) + ((double)second / 3600.0) + (milli / 3600000.0));
    return 1;
}

static int os_epoch(lua_State *L) {
    lastCFunction = __func__;
    std::string tmp(luaL_optstring(L, 1, "ingame"));
    std::transform(tmp.begin(), tmp.end(), tmp.begin(), [](unsigned char c) {return std::tolower(c); });
    if (tmp == "utc") {
#if PTRDIFF_MAX <= 0xFFFFFFFFFFFFLL
        lua_pushnumber(L, (double)std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L).time_since_epoch()).count());
#else
        lua_pushinteger(L, std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L).time_since_epoch()).count());
#endif
    } else if (tmp == "local") {
        time_t t = std::chrono::system_clock::to_time_t(vnow(L));
        const time_t utime = mktime(gmtime(&t));
        tm * ltime = localtime(&t);
        const long long off = (long long)mktime(ltime) - utime + (ltime->tm_isdst ? 3600LL : 0LL);
#if PTRDIFF_MAX <= 0xFFFFFFFFFFFFLL
        lua_pushnumber(L, (double)std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L).time_since_epoch()).count() + (off * 1000LL));
#else
        lua_pushinteger(L, std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L).time_since_epoch()).count() + (off * 1000LL));
#endif
    } else if (tmp == "ingame") {
        const double m_time = (double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L) - simclock::worldStart(get_comp(L))).count() + 300000LL) % 1200000LL) / 50000.0;
        const double m_day = std::chrono::duration_cast<std::chrono::minutes>(vnow(L) - simclock::worldStart(get_comp(L))).count() / 20 + 1;
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
    time_t t = std::chrono::system_clock::to_time_t(vnow(L));
    if (tmp == "ingame") {
        lua_pushinteger(L, std::chrono::duration_cast<std::chrono::minutes>(vnow(L) - simclock::worldStart(get_comp(L))).count() / 20 + 1);
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
    const double current_time = floor((double)((std::chrono::duration_cast<std::chrono::milliseconds>(vnow(L) - simclock::worldStart(computer)).count() + 300000LL) % 1200000LL) / 50.0) / 1000.0;
    double delta_time;
    if (time >= current_time) delta_time = time - current_time;
    else delta_time = (time + 24.0) - current_time;
    Uint32 real_time = (Uint32)(delta_time * 50000.0);
    struct timer_data_t * data = new struct timer_data_t;
    data->comp = computer;
    data->dom = simclock::of(computer);
    data->lock = new std::mutex;
    data->isAlarm = true;
    queueTask([real_time](void*a)->void* {
        struct timer_data_t * data = (timer_data_t*)a;
        Uint32 time = real_time;
        if (config.standardsMode) time = (Uint32)ceil(time / 50.0) * 50;
        LockGuard lock(runningTimerData);
        data->vdue = vnow(*data->dom) + std::chrono::milliseconds(time);
        data->due = std::chrono::steady_clock::now() + std::chrono::milliseconds(scaledMs(*data->dom, time) + 3);
        data->timer = SDL_AddTimer(scaledMs(*data->dom, time) + 3, notifyEvent, data);
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
    Computer * comp = get_comp(L);
    if (selectedRenderer == 3) {
        // pool mode: only this computer's own screens (its terminal and its monitors); the others run on. Its
        // monitors are listed first: the peripheral lock is never taken inside the render lock (a monitor going away
        // takes them the other way round).
        std::unordered_set<Terminal*> own;
        if (comp->poolSlot >= 0) {
            own.insert(comp->term);
            std::lock_guard<std::mutex> plock(comp->peripherals_mutex);
            for (const auto& p : comp->peripherals)
                if (p.second != NULL && strcmp(p.second->getMethods().name, "monitor") == 0) own.insert(((monitor*)p.second)->term);
        }
        std::lock_guard<std::mutex> lock(renderTargetsLock);
        for (Terminal * t : renderTargets)
            if (comp->poolSlot < 0 || own.count(t)) {t->render(); t->frozen = true;}
    }
    comp->running = 0;
    if (lua_isnumber(L, 1)) {
        comp->exitCode = (int)lua_tointeger(L, 1);
        if (comp->poolSlot < 0) returnValue = comp->exitCode;
    }
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
    {"__ccsimHost", os_host},
    {NULL, NULL}
};

library_t os_lib = {"os", os_reg, nullptr, nullptr};