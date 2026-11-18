/*
 * debug_server.cpp
 * craftos-agent
 *
 * The debugger behind --debug-connect (see debug_server.hpp for what it is and what it costs).
 *
 * Threads: the computer thread runs Lua and the hook, and while the program is stopped it waits in stopLoop and
 * answers the requests that need the Lua state (stack, variables, evaluate). The reader thread reads the socket and
 * handles what needs no Lua state itself (breakpoints, pause, the error mode), so those work while the program runs.
 *
 * This code is licensed under the MIT license.
 */

#ifndef __EMSCRIPTEN__
#include "debug_server.hpp"
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>
#include <Computer.hpp>
#include <configuration.hpp>
#include <Poco/Dynamic/Var.h>
#include <Poco/JSON/Array.h>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Parser.h>
#include <Poco/Net/SocketAddress.h>
#include <Poco/Net/StreamSocket.h>
#include "main.hpp"
#include "runtime.hpp"
#include "simclock.hpp"
#include "util.hpp"

extern Uint32 eventTimeoutEvent(Uint32 interval, void* param);
extern void cobaltHook(lua_State *L, lua_Debug *ar);
extern std::string ccVersionString;

namespace debugsrv {

std::atomic<bool> enabled(false);
std::atomic<bool> stopped(false);
std::atomic<bool> pauseAsked(false);
std::atomic<Computer*> debugged(NULL);

namespace {

typedef Poco::JSON::Object::Ptr Request;
typedef std::chrono::steady_clock steady;

enum {STEP_NONE = 0, STEP_IN, STEP_OVER, STEP_OUT};
enum {ERRORS_NONE = 0, ERRORS_UNCAUGHT, ERRORS_ALL};

/**
 * A pause stops at the next line of the program's own code, or when the computer next waits for an event. A
 * computer doing neither for this long (a busy loop in the ROM) stops wherever it is.
 */
const int PAUSE_ANYWHERE_MS = 1000;
/** How many waiting coroutines a pause can choose from (the shell's program, rednet, each side of a parallel). */
const int IDLE_SLOTS = 8;
/** An expression typed into the debug console or a watch may run this long. */
const int EVAL_SECONDS = 5;
const int MAX_CHILDREN = 5000;
const int MAX_FRAMES = 1000;
const size_t MAX_RAW = 4 * 1024 * 1024;
const int BP_WORDS = 2048; // 65536 lines; a longer file wraps around, which only costs a false positive

struct Breakpoint {
    int id = 0;
    std::string path; // the file on the computer, "/dir/prog.lua", as sourcePath gives a chunk's
    int line = 0;
    std::string condition;
    std::string log; // a Lua expression giving the text to print instead of stopping
    std::string hitOp; // "", "==", ">=", ">", "%"
    int hitN = 0;
    int hits = 0;
};

struct Frame {
    lua_State * thread;
    int level;
    int chain;
};

struct State {
    std::string host;
    int port = 0;
    std::string token;
    Poco::Net::StreamSocket sock;
    std::atomic<bool> connected{false};
    bool everConnected = false;
    std::mutex writeMu;
    std::thread reader;
    Computer * comp = NULL;

    // shared with the reader thread, under mu
    std::mutex mu;
    std::condition_variable cv;
    bool runReceived = false;
    bool acceptingRequests = false;
    std::deque<Request> queue;
    std::vector<Breakpoint> bps;
    std::string entryPath; // the program being debugged, to tell when it starts and when it has ended
    bool stopOnEntry = false;
    /** The adapter left (Disconnect, or its socket closed): stop nowhere any more. */
    std::atomic<bool> detached{false};

    std::atomic<uint32_t> bpBits[BP_WORDS];
    std::atomic<int> errorMode{ERRORS_NONE};
    std::atomic<bool> stepIntoRom{false};
    std::atomic<long long> pauseAskedAtMs{0};
    /** A step is going on or the entry stop is still to come: the line hook has work to do on every line. */
    std::atomic<bool> attention{false};

    // the computer thread's own
    bool entryPending = false; // the program's first line is still to come
    bool stopOnEntryNow = false;
    std::string entryNow;
    lua_State * progThread = NULL; // the coroutine the program's file runs on, and how deep its own code sits
    int progDepth = 0;
    int stepMode = STEP_NONE;
    lua_State * stepThread = NULL;
    int stepDepth = 0;
    bool leafCandidate = false;
    struct IdleSlot {
        lua_State * leaf = NULL;
        int len = 0;
        unsigned long long stamp = 0;
    } idle[IDLE_SLOTS];
    unsigned long long idleStamp = 0;
    bool haveBuiltins = false;
    lua_CFunction pcallFn = NULL, xpcallFn = NULL, loadFn = NULL, loadstringFn = NULL, resumeFn = NULL;
    int hookMask = 0, hookCount = 0; // what the debugger's hook is set with on every coroutine
    std::vector<lua_State*> chain; // while stopped: the coroutine that stopped, then the ones that resumed it
    std::vector<Frame> frames;
    bool framesBuilt = false;
    int nextRef = 0;
    std::string lastErrText;
    lua_State * lastErrThread = NULL;
    int lastErrDepth = 0;

    // the virtual clock
    std::mutex clockMu;
    long long frozenTotalUs = 0;
    steady::time_point stopStarted;
    bool clockHeld = false;
};

// Never destroyed: the reader thread may still be using it while the process exits.
State& S = *new State;

long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(steady::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------------------------------------------------------
// JSON out. Lua strings are bytes (CC shows them as Latin-1), JSON is UTF-8: bytes over 127 go out as that code point.

void jsonString(std::string& out, const char * s, size_t n) {
    out += '"';
    for (size_t i = 0; i < n; i++) {
        const unsigned char c = (unsigned char)s[i];
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (c < 0x20 || c == 0x7f) {
            char buf[8];
            snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
        } else if (c < 0x80) out += (char)c;
        else {
            out += (char)(0xC0 | (c >> 6));
            out += (char)(0x80 | (c & 0x3F));
        }
    }
    out += '"';
}

/** The reverse, for what the adapter sends: code points up to 255 become one byte, the rest a question mark. */
std::string fromUtf8(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ) {
        const unsigned char c = (unsigned char)in[i];
        if (c < 0x80) {out += (char)c; i++;}
        else if ((c & 0xE0) == 0xC0 && i + 1 < in.size()) {
            const unsigned cp = ((c & 0x1Fu) << 6) | ((unsigned char)in[i + 1] & 0x3Fu);
            out += cp < 256 ? (char)cp : '?';
            i += 2;
        } else if ((c & 0xF0) == 0xE0) {out += '?'; i += 3;}
        else if ((c & 0xF8) == 0xF0) {out += '?'; i += 4;}
        else {out += '?'; i++;}
    }
    return out;
}

class Json {
    std::string s = "{";
    void key(const char * k) {
        if (s.size() > 1) s += ',';
        jsonString(s, k, strlen(k));
        s += ':';
    }
public:
    Json& str(const char * k, const std::string& v) {key(k); jsonString(s, v.c_str(), v.size()); return *this;}
    Json& num(const char * k, long long v) {key(k); s += std::to_string(v); return *this;}
    Json& boolean(const char * k, bool v) {key(k); s += v ? "true" : "false"; return *this;}
    Json& raw(const char * k, const std::string& json) {key(k); s += json; return *this;}
    std::string done() const {return s + "}";}
};

// Linux: a send to an adapter that has gone must fail, not end the engine with SIGPIPE
#ifdef MSG_NOSIGNAL
const int SEND_FLAGS = MSG_NOSIGNAL;
#else
const int SEND_FLAGS = 0;
#endif

void sendLine(const std::string& line) {
    if (!S.connected) return;
    std::lock_guard<std::mutex> lock(S.writeMu);
    try {
        std::string data = line + "\n";
        size_t sent = 0;
        while (sent < data.size()) {
            const int n = S.sock.sendBytes(data.data() + sent, (int)(data.size() - sent), SEND_FLAGS);
            if (n <= 0) throw std::runtime_error("socket closed");
            sent += (size_t)n;
        }
    } catch (...) {
        S.connected = false;
    }
}

void reply(int seq, Json body = Json()) {
    sendLine(body.num("seq", seq).boolean("ok", true).done());
}

void replyError(int seq, const std::string& why) {
    sendLine(Json().num("seq", seq).boolean("ok", false).str("error", why).done());
}

// ---------------------------------------------------------------------------------------------------------------
// Sources

/**
 * "@/dir/prog.lua" -> "/dir/prog.lua": a file on the computer, named as the ROM's loadfile names it. "@bios.lua" ->
 * "bios.lua" and "@startup.lua" (the emulator's boot script) keep having no slash, which tells them from the
 * computer's own /startup.lua. A chunk that is no file gives "".
 */
std::string sourcePath(const char * source) {
    if (source == NULL || source[0] != '@') return "";
    return source + 1;
}

/** The program's own code: a file on the computer that is not the ROM or the test library. */
bool isUserPath(const std::string& path) {
    if (path.empty() || path[0] != '/') return false;
    if (path.compare(0, 5, "/rom/") == 0) return false;
    if (path.compare(0, 8, "/ccunit/") == 0) return false;
    return true;
}

/** A path from the adapter with exactly one slash in front, as sourcePath gives a file's. */
std::string computerPath(std::string path) {
    while (!path.empty() && path[0] == '/') path.erase(0, 1);
    return path.empty() ? path : "/" + path;
}

// ---------------------------------------------------------------------------------------------------------------
// Values

std::string quoteLua(const char * s, size_t n, size_t limit) {
    std::string out = "\"";
    const size_t shown = n > limit ? limit : n;
    for (size_t i = 0; i < shown; i++) {
        const unsigned char c = (unsigned char)s[i];
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (c < 0x20 || c == 0x7f) {
            char buf[8];
            snprintf(buf, sizeof(buf), "\\%d", c);
            out += buf;
        } else out += (char)c;
    }
    out += '"';
    if (n > limit) out += "... (" + std::to_string(n) + " bytes)";
    return out;
}

std::string formatNumber(lua_Number n) {
    char buf[64];
    if (n == std::floor(n) && std::fabs(n) < 1e15) snprintf(buf, sizeof(buf), "%.0f", n);
    else snprintf(buf, sizeof(buf), "%.14g", n);
    return buf;
}

bool isIdentifier(const char * s, size_t n) {
    static const char * const keywords[] = {"and", "break", "do", "else", "elseif", "end", "false", "for", "function",
        "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while", NULL};
    if (n == 0 || !(isalpha((unsigned char)s[0]) || s[0] == '_')) return false;
    for (size_t i = 1; i < n; i++) if (!(isalnum((unsigned char)s[i]) || s[i] == '_')) return false;
    for (const char * const * k = keywords; *k; k++) if (strlen(*k) == n && memcmp(*k, s, n) == 0) return false;
    return true;
}

/** What a value looks like in the Variables view. `depth` 1 gives a table a short preview of what is in it. */
std::string describe(lua_State * L, int idx, int depth) {
    idx = lua_absindex(L, idx);
    switch (lua_type(L, idx)) {
        case LUA_TNIL: return "nil";
        case LUA_TBOOLEAN: return lua_toboolean(L, idx) ? "true" : "false";
        case LUA_TNUMBER: return formatNumber(lua_tonumber(L, idx));
        case LUA_TSTRING: {
            size_t n = 0;
            const char * s = lua_tolstring(L, idx, &n);
            return quoteLua(s, n, depth > 0 ? 400 : 40);
        }
        case LUA_TTABLE: {
            if (depth <= 0) return "{...}";
            if (!lua_checkstack(L, 4)) return "{...}";
            std::string out = "{";
            int count = 0;
            bool more = false;
            lua_pushnil(L);
            while (lua_next(L, idx)) {
                if (count >= 6 || out.size() > 80) {more = true; lua_pop(L, 2); break;}
                if (count > 0) out += ", ";
                if (lua_type(L, -2) == LUA_TSTRING) {
                    size_t n = 0;
                    const char * k = lua_tolstring(L, -2, &n);
                    if (isIdentifier(k, n)) out += std::string(k, n);
                    else out += "[" + quoteLua(k, n, 20) + "]";
                    out += " = ";
                } else if (!(lua_type(L, -2) == LUA_TNUMBER && lua_tonumber(L, -2) == count + 1)) {
                    out += "[" + describe(L, -2, 0) + "] = ";
                }
                out += describe(L, -1, 0);
                count++;
                lua_pop(L, 1);
            }
            if (more) out += ", ...";
            return out + "}";
        }
        case LUA_TFUNCTION: {
            if (lua_iscfunction(L, idx)) return "function: builtin";
            if (!lua_checkstack(L, 2)) return "function";
            lua_Debug ar;
            lua_pushvalue(L, idx);
            lua_getinfo(L, ">S", &ar);
            const std::string path = sourcePath(ar.source);
            return "function: " + (path.empty() ? std::string(ar.short_src) : path) + ":" + std::to_string(ar.linedefined);
        }
        default: {
            char buf[64];
            snprintf(buf, sizeof(buf), "%s: %p", lua_typename(L, lua_type(L, idx)), lua_topointer(L, idx));
            return buf;
        }
    }
}

/** Keep a table for the Variables view to open later (registry._dbg_refs, emptied when the program goes on). */
int makeRef(lua_State * L, int idx) {
    idx = lua_absindex(L, idx);
    if (!lua_checkstack(L, 3)) return 0;
    lua_getfield(L, LUA_REGISTRYINDEX, "_dbg_refs");
    if (!lua_istable(L, -1)) {
        lua_pop(L, 1);
        lua_newtable(L);
        lua_pushvalue(L, -1);
        lua_setfield(L, LUA_REGISTRYINDEX, "_dbg_refs");
    }
    lua_pushvalue(L, idx);
    lua_rawseti(L, -2, ++S.nextRef);
    lua_pop(L, 1);
    return S.nextRef;
}

/** One variable as JSON. `ek`: the name can be put after its parent's in an expression (x.name, x[1]). */
std::string variableJson(lua_State * L, int idx, const std::string& name, bool ek) {
    Json j;
    j.str("name", name).str("value", describe(L, idx, 1)).str("type", lua_typename(L, lua_type(L, idx)));
    if (lua_type(L, idx) == LUA_TTABLE) j.num("ref", makeRef(L, idx));
    if (ek) j.boolean("ek", true);
    return j.done();
}

// ---------------------------------------------------------------------------------------------------------------
// The stack: the frames of the coroutine that stopped, then those of each coroutine that resumed it, down to the BIOS.

void buildFrames() {
    if (S.framesBuilt) return;
    S.framesBuilt = true;
    S.frames.clear();
    for (size_t c = 0; c < S.chain.size(); c++) {
        lua_Debug ar;
        for (int level = 0; lua_getstack(S.chain[c], level, &ar) && (int)S.frames.size() < MAX_FRAMES; level++)
            S.frames.push_back({S.chain[c], level, (int)c});
    }
}

const Frame * frameAt(int index) {
    buildFrames();
    if (index < 0 || index >= (int)S.frames.size()) return NULL;
    return &S.frames[index];
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluate: the code runs on a coroutine of its own whose globals are a proxy that reads and writes the frame's
// locals, then its upvalues, then its environment. It cannot yield (no sleep, no os.pullEvent) and is stopped after
// EVAL_SECONDS.

struct EvalFrame {
    lua_State * thread = NULL;
    int level = 0;
};
EvalFrame evalFrame;
steady::time_point evalDeadline;
bool inEval = false;

void hook(lua_State * L, lua_Debug * ar);

void evalGuard(lua_State *L, lua_Debug *ar) {
    if (!inEval) {
        // A coroutine made while an expression was being evaluated took this hook from its maker, and the program
        // kept it. It is the program's now: give it the debugger's hook, as every other coroutine has.
        lua_sethook(L, hook, S.hookMask, S.hookCount);
        return;
    }
    if (steady::now() > evalDeadline) luaL_error(L, "evaluation took more than %d seconds", EVAL_SECONDS);
}

/** Push the environment of the frame's function: its _ENV upvalue, else that of the nearest caller that has one. */
void pushFrameEnv(lua_State * E) {
    lua_State * T = evalFrame.thread;
    if (T != NULL && lua_checkstack(T, 2) && lua_checkstack(E, 4)) {
        lua_Debug ar;
        for (int level = evalFrame.level; lua_getstack(T, level, &ar) && level < evalFrame.level + 50; level++) {
            lua_getinfo(T, "f", &ar);
            lua_xmove(T, E, 1);
            const char * name;
            for (int i = 1; (name = lua_getupvalue(E, -1, i)) != NULL; i++) {
                if (strcmp(name, "_ENV") == 0 && lua_istable(E, -1)) {
                    lua_remove(E, -2);
                    return;
                }
                lua_pop(E, 1);
            }
            lua_pop(E, 1);
        }
    }
    lua_pushglobaltable(E);
}

/** Find a name in the frame: 1 with the local's index, 2 with the upvalue's index (the function is then on E). */
int findName(lua_State * E, const char * key, lua_Debug * ar, int * index) {
    lua_State * T = evalFrame.thread;
    if (T == NULL || !lua_checkstack(T, 2) || !lua_getstack(T, evalFrame.level, ar)) return 0;
    const char * name;
    int found = 0;
    for (int i = 1; (name = lua_getlocal(T, ar, i)) != NULL; i++) {
        lua_pop(T, 1);
        if (strcmp(name, key) == 0) found = i; // the last one of a name is the one in scope
    }
    if (found) {*index = found; return 1;}
    lua_getinfo(T, "f", ar);
    lua_xmove(T, E, 1);
    for (int i = 1; (name = lua_getupvalue(E, -1, i)) != NULL; i++) {
        lua_pop(E, 1);
        if (strcmp(name, key) == 0) {*index = i; return 2;}
    }
    lua_pop(E, 1);
    return 0;
}

int evalIndex(lua_State * E) {
    lua_settop(E, 2);
    if (lua_type(E, 2) == LUA_TSTRING) {
        lua_Debug ar;
        int index = 0;
        const int where = findName(E, lua_tostring(E, 2), &ar, &index);
        if (where == 1) {
            lua_getlocal(evalFrame.thread, &ar, index);
            lua_xmove(evalFrame.thread, E, 1);
            return 1;
        } else if (where == 2) {
            lua_getupvalue(E, -1, index);
            return 1;
        }
    }
    // the frame's environment as it was when the expression was evaluated (a function the expression made may
    // still be asking long after)
    lua_pushvalue(E, 2);
    lua_gettable(E, lua_upvalueindex(1));
    return 1;
}

int evalNewindex(lua_State * E) {
    lua_settop(E, 3);
    if (lua_type(E, 2) == LUA_TSTRING) {
        lua_Debug ar;
        int index = 0;
        const int where = findName(E, lua_tostring(E, 2), &ar, &index);
        if (where == 1) {
            lua_pushvalue(E, 3);
            lua_xmove(E, evalFrame.thread, 1);
            lua_setlocal(evalFrame.thread, &ar, index);
            return 0;
        } else if (where == 2) {
            lua_pushvalue(E, 3);
            lua_setupvalue(E, -2, index);
            return 0;
        }
    }
    lua_pushvalue(E, 2);
    lua_pushvalue(E, 3);
    lua_settable(E, lua_upvalueindex(1));
    return 0;
}

/**
 * Run `code` as an expression (or, failing that, as statements) in a frame. Pushes the coroutine it ran on onto
 * `B` and returns it with the results on its stack, or NULL with the error in `err` (nothing is left on B then).
 */
lua_State * evaluate(lua_State * B, lua_State * thread, int level, const std::string& code, std::string& err) {
    if (!lua_checkstack(B, 2)) {err = "out of stack"; return NULL;}
    lua_State * E = lua_newthread(B);
    lua_sethook(E, evalGuard, LUA_MASKCOUNT, 100000);
    const std::string asExpression = "return " + code;
    int status = luaL_loadbuffer(E, asExpression.c_str(), asExpression.size(), "=(debug)");
    if (status != LUA_OK) {
        lua_settop(E, 0);
        status = luaL_loadbuffer(E, code.c_str(), code.size(), "=(debug)");
    }
    if (status != LUA_OK) {
        err = lua_isstring(E, -1) ? lua_tostring(E, -1) : "syntax error";
        lua_pop(B, 1);
        return NULL;
    }
    // The code's globals are a proxy: a name is the frame's local, else its upvalue, else its environment's. The
    // environment is found now and kept with the proxy; locals and upvalues are only there while this runs.
    evalFrame.thread = thread;
    evalFrame.level = level;
    lua_newtable(E);
    lua_newtable(E);
    pushFrameEnv(E);
    lua_pushvalue(E, -1);
    lua_pushcclosure(E, evalIndex, 1);
    lua_setfield(E, -3, "__index");
    lua_pushcclosure(E, evalNewindex, 1);
    lua_setfield(E, -2, "__newindex");
    lua_setmetatable(E, -2);
    if (lua_setupvalue(E, -2, 1) == NULL) lua_pop(E, 1);
    evalDeadline = steady::now() + std::chrono::seconds(EVAL_SECONDS);
    inEval = true;
    status = lua_pcall(E, 0, LUA_MULTRET, 0);
    inEval = false;
    evalFrame.thread = NULL;
    if (status != LUA_OK) {
        if (lua_isstring(E, -1)) err = lua_tostring(E, -1);
        else err = "error: " + describe(E, -1, 1);
        lua_pop(B, 1);
        return NULL;
    }
    return E;
}

// ---------------------------------------------------------------------------------------------------------------
// Requests answered while the program is stopped

int intOf(const Request& r, const char * key, int def) {
    try {
        if (r->has(key)) return r->getValue<int>(key);
    } catch (...) {}
    return def;
}

std::string strOf(const Request& r, const char * key) {
    try {
        if (r->has(key) && !r->isNull(key)) return fromUtf8(r->getValue<std::string>(key));
    } catch (...) {}
    return "";
}

bool boolOf(const Request& r, const char * key) {
    try {
        if (r->has(key)) return r->getValue<bool>(key);
    } catch (...) {}
    return false;
}

void cmdStack(const Request& r, int seq) {
    buildFrames();
    const int start = intOf(r, "start", 0);
    int count = intOf(r, "count", 0);
    if (count <= 0) count = MAX_FRAMES;
    std::string list = "[";
    for (int i = start; i < (int)S.frames.size() && i < start + count; i++) {
        const Frame& f = S.frames[i];
        lua_Debug ar;
        if (!lua_getstack(f.thread, f.level, &ar)) continue;
        lua_getinfo(f.thread, "nSl", &ar);
        const std::string path = sourcePath(ar.source);
        Json j;
        j.num("i", i).num("thread", f.chain).str("what", ar.what ? ar.what : "").num("line", ar.currentline);
        if (ar.name != NULL) j.str("name", ar.name);
        j.str("path", path).boolean("user", isUserPath(path));
        if (path.empty() && ar.source != NULL && ar.what != NULL && ar.what[0] != 'C') j.str("chunk", std::string(ar.short_src));
        j.num("defined", ar.linedefined);
        if (list.size() > 1) list += ',';
        list += j.done();
    }
    list += "]";
    reply(seq, Json().raw("frames", list).num("total", (long long)S.frames.size()));
}

void cmdLocals(const Request& r, int seq) {
    const Frame * f = frameAt(intOf(r, "frame", 0));
    lua_State * B = S.comp->L;
    const int top = lua_gettop(B);
    std::string list = "[";
    lua_Debug ar;
    if (f != NULL && lua_checkstack(f->thread, 2) && lua_checkstack(B, 6) && lua_getstack(f->thread, f->level, &ar)) {
        const char * name;
        for (int i = 1; (name = lua_getlocal(f->thread, &ar, i)) != NULL; i++) {
            lua_xmove(f->thread, B, 1);
            if (name[0] != '(') {
                if (list.size() > 1) list += ',';
                list += variableJson(B, -1, name, true);
            }
            lua_pop(B, 1);
        }
        for (int i = 1; (name = lua_getlocal(f->thread, &ar, -i)) != NULL && i <= 200; i++) {
            lua_xmove(f->thread, B, 1);
            if (list.size() > 1) list += ',';
            list += variableJson(B, -1, "(...)[" + std::to_string(i) + "]", false);
            lua_pop(B, 1);
        }
    }
    list += "]";
    lua_settop(B, top);
    reply(seq, Json().raw("variables", list));
}

void cmdUpvalues(const Request& r, int seq) {
    const Frame * f = frameAt(intOf(r, "frame", 0));
    lua_State * B = S.comp->L;
    const int top = lua_gettop(B);
    std::string list = "[";
    lua_Debug ar;
    if (f != NULL && lua_checkstack(f->thread, 2) && lua_checkstack(B, 6) && lua_getstack(f->thread, f->level, &ar)) {
        lua_getinfo(f->thread, "f", &ar);
        lua_xmove(f->thread, B, 1);
        const int fn = lua_gettop(B);
        const char * name;
        for (int i = 1; (name = lua_getupvalue(B, fn, i)) != NULL; i++) {
            if (strcmp(name, "_ENV") != 0 && name[0] != '\0') {
                if (list.size() > 1) list += ',';
                list += variableJson(B, -1, name, true);
            }
            lua_pop(B, 1);
        }
    }
    list += "]";
    lua_settop(B, top);
    reply(seq, Json().raw("variables", list));
}

void childrenOf(lua_State * B, int table, int seq) {
    table = lua_absindex(B, table);
    std::string list = "[";
    int count = 0;
    bool more = false;
    if (lua_checkstack(B, 8)) {
        lua_pushnil(B);
        while (lua_next(B, table)) {
            if (count >= MAX_CHILDREN) {more = true; lua_pop(B, 2); break;}
            std::string name;
            bool ek = true;
            switch (lua_type(B, -2)) {
                case LUA_TSTRING: {
                    size_t n = 0;
                    const char * k = lua_tolstring(B, -2, &n);
                    name = isIdentifier(k, n) ? std::string(k, n) : "[" + quoteLua(k, n, 200) + "]";
                    if (n > 200) ek = false;
                    break;
                }
                case LUA_TNUMBER: name = "[" + formatNumber(lua_tonumber(B, -2)) + "]"; break;
                case LUA_TBOOLEAN: name = lua_toboolean(B, -2) ? "[true]" : "[false]"; break;
                default: name = "[" + describe(B, -2, 0) + "]"; ek = false; break;
            }
            if (list.size() > 1) list += ',';
            list += variableJson(B, -1, name, ek);
            count++;
            lua_pop(B, 1);
        }
        if (lua_getmetatable(B, table)) {
            if (list.size() > 1) list += ',';
            list += variableJson(B, -1, "(metatable)", false);
            lua_pop(B, 1);
        }
    }
    list += "]";
    reply(seq, Json().raw("variables", list).boolean("more", more));
}

void cmdGlobals(const Request& r, int seq) {
    const Frame * f = frameAt(intOf(r, "frame", 0));
    lua_State * B = S.comp->L;
    const int top = lua_gettop(B);
    evalFrame.thread = f ? f->thread : NULL;
    evalFrame.level = f ? f->level : 0;
    pushFrameEnv(B);
    evalFrame.thread = NULL;
    childrenOf(B, -1, seq);
    lua_settop(B, top);
}

void cmdChildren(const Request& r, int seq) {
    lua_State * B = S.comp->L;
    const int top = lua_gettop(B);
    const int ref = intOf(r, "ref", 0);
    lua_getfield(B, LUA_REGISTRYINDEX, "_dbg_refs");
    if (lua_istable(B, -1)) lua_rawgeti(B, -1, ref);
    if (!lua_istable(B, -1)) replyError(seq, "that value is gone: the program has run on since");
    else childrenOf(B, -1, seq);
    lua_settop(B, top);
}

void cmdEval(const Request& r, int seq) {
    const Frame * f = frameAt(intOf(r, "frame", 0));
    lua_State * B = S.comp->L;
    const int top = lua_gettop(B);
    std::string err;
    lua_State * E = evaluate(B, f ? f->thread : NULL, f ? f->level : 0, strOf(r, "expr"), err);
    if (E == NULL) {
        lua_settop(B, top);
        replyError(seq, err);
        return;
    }
    const int n = lua_gettop(E);
    Json j;
    if (boolOf(r, "raw")) {
        // the whole string, for the adapter's own questions (a file's text)
        if (n >= 1 && lua_type(E, 1) == LUA_TSTRING) {
            size_t len = 0;
            const char * s = lua_tolstring(E, 1, &len);
            j.str("text", std::string(s, len > MAX_RAW ? MAX_RAW : len));
        }
    } else if (n == 0) {
        j.str("value", "nil").str("type", "nil").boolean("none", true);
    } else {
        std::string value = describe(E, 1, 1);
        for (int i = 2; i <= n && i <= 8; i++) value += ", " + describe(E, i, 0);
        j.str("value", value).str("type", lua_typename(E, lua_type(E, 1)));
        if (n == 1 && lua_type(E, 1) == LUA_TTABLE) j.num("ref", makeRef(E, 1));
    }
    lua_settop(B, top);
    reply(seq, j);
}

void updateAttention() {
    S.attention = S.stepMode != STEP_NONE || S.entryPending;
}

int depthOf(lua_State * L) {
    lua_Debug ar;
    int d = 0;
    while (lua_getstack(L, d, &ar)) d++;
    return d;
}

void startStep(int mode) {
    S.stepMode = mode;
    S.stepThread = S.chain.empty() ? NULL : S.chain[0];
    S.stepDepth = S.stepThread ? depthOf(S.stepThread) : 0;
    if (S.stepThread == NULL) S.stepMode = STEP_IN;
    else {
        // keep the coroutine alive for as long as the step watches it
        lua_State * B = S.comp->L;
        lua_pushthread(S.stepThread);
        lua_xmove(S.stepThread, B, 1);
        lua_setfield(B, LUA_REGISTRYINDEX, "_dbg_step");
    }
    updateAttention();
}

/** Answer one request while stopped. True when the program should go on. */
bool handleStopped(const Request& r) {
    const std::string cmd = strOf(r, "cmd");
    const int seq = intOf(r, "seq", 0);
    try {
        if (cmd == "stack") cmdStack(r, seq);
        else if (cmd == "locals") cmdLocals(r, seq);
        else if (cmd == "upvalues") cmdUpvalues(r, seq);
        else if (cmd == "globals") cmdGlobals(r, seq);
        else if (cmd == "children") cmdChildren(r, seq);
        else if (cmd == "eval") cmdEval(r, seq);
        else if (cmd == "continue") {reply(seq); return true;}
        else if (cmd == "stepIn") {startStep(STEP_IN); reply(seq); return true;}
        else if (cmd == "next") {startStep(STEP_OVER); reply(seq); return true;}
        else if (cmd == "stepOut") {startStep(STEP_OUT); reply(seq); return true;}
        else replyError(seq, "unknown command: " + cmd);
    } catch (std::exception &e) {
        replyError(seq, e.what());
    }
    return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Stopping

void stopLoop(const char * reason, const std::string& text, const std::vector<int>& ids) {
    Computer * comp = S.comp;
    // The 7 s "too long without yielding" timer does not run while the program is stopped
    if (comp->eventTimeout != 0) SDL_RemoveTimer(comp->eventTimeout);
    comp->eventTimeout = 0;
    {
        std::lock_guard<std::mutex> lock(S.clockMu);
        S.stopStarted = steady::now();
        S.clockHeld = true;
        simclock::hold(true); // one hold for the debugger and a pause (simclock.hpp): the clock never counts one twice
    }
    S.frames.clear();
    S.framesBuilt = false;
    stopped = true;
    {
        std::lock_guard<std::mutex> lock(S.mu);
        S.acceptingRequests = true;
    }
    std::string idList = "[";
    for (size_t i = 0; i < ids.size(); i++) idList += (i ? "," : "") + std::to_string(ids[i]);
    idList += "]";
    sendLine(Json().str("event", "stopped").str("reason", reason).str("text", text).raw("breakpoints", idList).done());
    while (true) {
        Request request;
        {
            std::unique_lock<std::mutex> lock(S.mu);
            S.cv.wait_for(lock, std::chrono::milliseconds(200), []{return !S.queue.empty() || !S.connected || S.detached;});
            if (S.queue.empty()) {
                if (!S.connected || S.detached || exiting || comp->running != 1) break;
                continue;
            }
            request = S.queue.front();
            S.queue.pop_front();
        }
        if (handleStopped(request)) break;
    }
    {
        std::lock_guard<std::mutex> lock(S.mu);
        S.acceptingRequests = false;
        for (const Request& r : S.queue) replyError(intOf(r, "seq", 0), "the program is running");
        S.queue.clear();
    }
    // what the Variables view was holding goes with the stop
    if (comp->L != NULL) {
        lua_pushnil(comp->L);
        lua_setfield(comp->L, LUA_REGISTRYINDEX, "_dbg_refs");
    }
    S.nextRef = 0;
    S.chain.clear();
    S.frames.clear();
    S.framesBuilt = false;
    {
        std::lock_guard<std::mutex> lock(S.clockMu);
        S.frozenTotalUs += std::chrono::duration_cast<std::chrono::microseconds>(steady::now() - S.stopStarted).count();
        S.clockHeld = false;
        simclock::hold(false);
    }
    // a pause that came in just as this stop began was for this stop
    pauseAsked = false;
    stopped = false;
    comp->timeoutCheckCount = 0;
    comp->last_event = std::chrono::high_resolution_clock::now();
    if (config.abortTimeout > 0 || config.standardsMode) comp->eventTimeout = SDL_AddTimer(config.standardsMode ? 7000 : config.abortTimeout, eventTimeoutEvent, comp);
    sendLine(Json().str("event", "continued").done());
}

/** Stop on a running coroutine (from the hook). */
void stopAt(lua_State * L, const char * reason, const std::string& text = "", const std::vector<int>& ids = {}) {
    S.stepMode = STEP_NONE;
    pauseAsked = false;
    updateAttention();
    if (S.detached || !S.connected) return; // the adapter left while this stop was being decided on
    lua_State * B = S.comp->L;
    const int top = lua_gettop(B);
    S.chain.clear();
    S.chain.push_back(L);
    if (lua_checkstack(B, 3)) {
        lua_getfield(B, LUA_REGISTRYINDEX, "_coroutine_stack");
        if (lua_istable(B, -1)) {
            for (int i = (int)lua_rawlen(B, -1); i >= 1; i--) {
                lua_rawgeti(B, -1, i);
                lua_State * T = lua_tothread(B, -1);
                lua_pop(B, 1);
                if (T != NULL && T != L && lua_checkstack(T, 4)) S.chain.push_back(T);
            }
        }
    }
    lua_settop(B, top);
    if (L != S.comp->coro) S.chain.push_back(S.comp->coro);
    stopLoop(reason, text, ids);
}

bool stepThreadDead() {
    lua_State * T = S.stepThread;
    if (T == NULL) return true;
    const int status = lua_status(T);
    if (status == LUA_YIELD) return false;
    if (status != LUA_OK) return true;
    lua_Debug ar;
    return !lua_getstack(T, 0, &ar);
}

bool truthy(lua_State * L, const std::string& code, bool& failed, std::string& text, bool wantText) {
    lua_State * B = S.comp->L;
    const int top = lua_gettop(B);
    std::string err;
    lua_State * E = evaluate(B, L, 0, code, err);
    bool result = true;
    failed = E == NULL;
    if (E == NULL) text = err;
    else {
        result = lua_gettop(E) >= 1 && lua_toboolean(E, 1);
        if (wantText) {
            if (lua_gettop(E) >= 1 && lua_type(E, 1) == LUA_TSTRING) {
                size_t n = 0;
                const char * s = lua_tolstring(E, 1, &n);
                text.assign(s, n);
            } else text = lua_gettop(E) >= 1 ? describe(E, 1, 1) : "";
        }
    }
    lua_settop(B, top);
    return result;
}

void output(const std::string& category, const std::string& text, const std::string& path, int line) {
    sendLine(Json().str("event", "output").str("category", category).str("text", text).str("path", path).num("line", line).done());
}

void onLine(lua_State * L, lua_Debug * ar, bool maybeBreakpoint) {
    if (stopped || inEval) return;
    if (S.detached.load(std::memory_order_relaxed) || !S.connected.load(std::memory_order_relaxed)) {
        // nobody to stop for: drop what was being watched for, so the hook goes back to its fast path
        S.stepMode = STEP_NONE;
        S.entryPending = false;
        pauseAsked = false;
        updateAttention();
        return;
    }
    const int line = ar->currentline;
    bool haveInfo = false, haveSource = false, user = false;
    std::string path;
    auto needInfo = [&]() {
        if (haveInfo) return;
        haveInfo = true;
        lua_getinfo(L, "S", ar);
    };
    auto needSource = [&]() {
        if (haveSource) return;
        haveSource = true;
        needInfo();
        path = sourcePath(ar->source);
        user = isUserPath(path);
    };
    if (maybeBreakpoint) {
        // Some file has a breakpoint on a line of this number. Most often it is another file (a loop in the ROM
        // passing its own line 12), so the check allocates nothing until a breakpoint is really here.
        needInfo();
        std::vector<Breakpoint> here;
        if (ar->source != NULL && ar->source[0] == '@') {
            std::lock_guard<std::mutex> lock(S.mu);
            for (const Breakpoint& b : S.bps) if (b.line == line && b.path == ar->source + 1) here.push_back(b);
        }
        if (!here.empty()) needSource();
        std::vector<int> ids;
        for (const Breakpoint& b : here) {
            if (!b.condition.empty()) {
                bool failed = false;
                std::string text;
                const bool yes = truthy(L, b.condition, failed, text, false);
                if (failed) output("stderr", "breakpoint condition failed: " + text + "\n", path, line);
                else if (!yes) continue;
            }
            int hits = 0;
            {
                std::lock_guard<std::mutex> lock(S.mu);
                for (Breakpoint& mine : S.bps) if (mine.id == b.id) hits = ++mine.hits;
            }
            if (b.hitOp == "==" && hits != b.hitN) continue;
            if (b.hitOp == ">=" && hits < b.hitN) continue;
            if (b.hitOp == ">" && hits <= b.hitN) continue;
            if (b.hitOp == "%" && (b.hitN <= 0 || hits % b.hitN != 0)) continue;
            if (!b.log.empty()) {
                bool failed = false;
                std::string text;
                truthy(L, b.log, failed, text, true);
                output(failed ? "stderr" : "console", (failed ? "logpoint failed: " : "") + text + "\n", path, line);
                continue;
            }
            ids.push_back(b.id);
        }
        if (!ids.empty()) {stopAt(L, "breakpoint", "", ids); return;}
    }
    if (S.entryPending) {
        needSource();
        if (path == S.entryNow) {
            // The program's first line. Remember where its code sits, to tell later that it has ended (programWatch)
            S.entryPending = false;
            S.progThread = L;
            S.progDepth = depthOf(L);
            lua_pushthread(L);
            lua_setfield(L, LUA_REGISTRYINDEX, "_dbg_prog");
            updateAttention();
            if (S.stopOnEntryNow) {
                stopAt(L, "entry");
                return;
            }
        }
    }
    if (pauseAsked.load(std::memory_order_relaxed)) {
        needSource();
        if (user || nowMs() - S.pauseAskedAtMs > PAUSE_ANYWHERE_MS) {stopAt(L, "pause"); return;}
    }
    if (S.stepMode != STEP_NONE) {
        bool candidate = false;
        lua_Debug probe;
        if (S.stepMode == STEP_IN) candidate = true;
        else if (L == S.stepThread) {
            // over: no deeper than where the step began; out: shallower
            const int level = S.stepMode == STEP_OVER ? S.stepDepth : S.stepDepth - 1;
            candidate = level < 0 || !lua_getstack(L, level, &probe);
        } else if (stepThreadDead()) {
            // the coroutine being stepped ended: stop at the next line of the program, wherever it is
            S.stepMode = STEP_IN;
            candidate = true;
        }
        if (candidate) {
            needSource();
            if (user || S.stepIntoRom) {stopAt(L, "step"); return;}
        }
    }
}

void findBuiltins(lua_State * L) {
    if (S.haveBuiltins) return;
    S.haveBuiltins = true;
    const struct {const char * name; lua_CFunction * out;} wanted[] = {
        {"pcall", &S.pcallFn}, {"xpcall", &S.xpcallFn}, {"load", &S.loadFn}, {"loadstring", &S.loadstringFn}};
    lua_pushglobaltable(L);
    for (const auto& w : wanted) {
        lua_getfield(L, -1, w.name);
        *w.out = lua_iscfunction(L, -1) ? lua_tocfunction(L, -1) : NULL;
        lua_pop(L, 1);
    }
    lua_getfield(L, -1, "coroutine");
    if (lua_istable(L, -1)) {
        lua_getfield(L, -1, "resume");
        S.resumeFn = lua_iscfunction(L, -1) ? lua_tocfunction(L, -1) : NULL;
        lua_pop(L, 1);
    }
    lua_pop(L, 2);
}

lua_CFunction cfunctionAt(lua_State * L, lua_Debug * ar) {
    lua_getinfo(L, "f", ar);
    const lua_CFunction fn = lua_iscfunction(L, -1) ? lua_tocfunction(L, -1) : NULL;
    lua_pop(L, 1);
    return fn;
}

/**
 * Whether an error is one the program does not handle itself. Going up the coroutine's stack from where it was
 * raised: a pcall before any of the program's own frames means the ROM raised and caught it among itself (not the
 * program's business); past the program's frame, a pcall called by the program means the program catches it. What
 * is left ends up with the shell or the test library printing it, or ends the coroutine.
 */
bool uncaught(lua_State * L) {
    findBuiltins(L);
    // the coroutine that raised it, then each one that resumed the one before, down to the BIOS
    std::vector<lua_State*> threads;
    threads.push_back(L);
    lua_getfield(L, LUA_REGISTRYINDEX, "_coroutine_stack");
    if (lua_istable(L, -1)) {
        for (int i = (int)lua_rawlen(L, -1); i >= 1; i--) {
            lua_rawgeti(L, -1, i);
            lua_State * T = lua_tothread(L, -1);
            lua_pop(L, 1);
            if (T != NULL && T != L && lua_checkstack(T, 4)) threads.push_back(T);
        }
    }
    lua_pop(L, 1);
    if (L != S.comp->coro) threads.push_back(S.comp->coro);

    bool seenUser = false;
    for (size_t t = 0; t < threads.size(); t++) {
        lua_State * T = threads[t];
        lua_Debug ar;
        int level = 0;
        if (t > 0) {
            // T resumed the coroutine the error is coming out of: on top of its stack is what resumed it
            if (!lua_getstack(T, 0, &ar)) return seenUser;
            lua_getinfo(T, "S", &ar);
            if (ar.what != NULL && ar.what[0] == 'C' && cfunctionAt(T, &ar) == S.resumeFn) {
                // coroutine.resume hands the error back as false, message, to whoever called it
                lua_Debug caller;
                if (!lua_getstack(T, 1, &caller)) return seenUser;
                lua_getinfo(T, "S", &caller);
                const std::string path = sourcePath(caller.source);
                if (isUserPath(path)) return false; // the program looks at the result itself
                // parallel raises it again in T; anything else in the ROM (the shell) reports it and goes on
                if (path != "/rom/apis/parallel.lua") return seenUser;
            }
            // coroutine.wrap and parallel raise it again here: go on up this stack
            level = 1;
        }
        for (; lua_getstack(T, level, &ar) && level < 200; level++) {
            lua_getinfo(T, "S", &ar);
            if (ar.what != NULL && ar.what[0] == 'C') {
                const lua_CFunction fn = cfunctionAt(T, &ar);
                if (t == 0 && level == 0 && fn != NULL && (fn == S.loadFn || fn == S.loadstringFn)) return false; // load returns nil, message
                if (fn != NULL && (fn == S.pcallFn || fn == S.xpcallFn)) {
                    if (!seenUser) return false;
                    lua_Debug caller;
                    if (!lua_getstack(T, level + 1, &caller)) return true;
                    lua_getinfo(T, "S", &caller);
                    return !isUserPath(sourcePath(caller.source));
                }
            } else if (!seenUser && isUserPath(sourcePath(ar.source))) seenUser = true;
        }
    }
    return seenUser;
}

void onError(lua_State * L, lua_Debug * ar) {
    if (stopped || inEval) return;
    const int mode = S.errorMode.load(std::memory_order_relaxed);
    if (mode == ERRORS_NONE || !lua_checkstack(L, 6)) return;
    std::string text;
    if (lua_gettop(L) < 1) text = "error";
    else if (lua_type(L, -1) == LUA_TSTRING) {
        size_t n = 0;
        const char * s = lua_tolstring(L, -1, &n);
        text.assign(s, n);
    } else if (lua_type(L, -1) == LUA_TTABLE) {
        // CC 1.109+'s parallel raises a caught error again as {message = ..., thread = ...}: the same error, by its
        // message (raw, so no metamethod runs here)
        lua_pushliteral(L, "message");
        lua_rawget(L, -2);
        if (lua_type(L, -1) == LUA_TSTRING) {
            size_t n = 0;
            const char * s = lua_tolstring(L, -1, &n);
            text.assign(s, n);
        }
        lua_pop(L, 1);
        if (text.empty()) text = "error: " + describe(L, -1, 1);
    } else text = "error: " + describe(L, -1, 1);
    if (mode == ERRORS_UNCAUGHT && !uncaught(L)) return;
    // the same error going up (parallel and coroutine.wrap raise it again in the coroutine above): one stop
    const int depth = depthOf(L);
    if (text == S.lastErrText && (L != S.lastErrThread || depth < S.lastErrDepth)) {
        S.lastErrThread = L;
        S.lastErrDepth = depth;
        return;
    }
    S.lastErrText = text;
    S.lastErrThread = L;
    S.lastErrDepth = depth;
    stopAt(L, "exception", text);
}

/**
 * The chain of coroutines as an innermost one yields, kept for a pause while the computer waits for an event: every
 * coroutine is suspended then, and nothing says which ones were waiting inside which. One chain is kept for each of
 * the last IDLE_SLOTS coroutines that yielded with nothing running inside them (registry._dbg_idle[slot], which
 * also keeps them alive to be looked at).
 */
void onLeafYield(lua_State * L) {
    if (stopped || inEval || !lua_checkstack(L, 5)) return;
    int slot = 0;
    for (int i = 0; i < IDLE_SLOTS; i++) {
        if (S.idle[i].leaf == L) {slot = i; break;}
        if (S.idle[i].stamp < S.idle[slot].stamp) slot = i;
    }
    lua_getfield(L, LUA_REGISTRYINDEX, "_dbg_idle");
    if (!lua_istable(L, -1)) {lua_pop(L, 1); return;}
    lua_rawgeti(L, -1, slot + 1);
    if (!lua_istable(L, -1)) {lua_pop(L, 2); return;}
    lua_getfield(L, LUA_REGISTRYINDEX, "_coroutine_stack");
    const int n = lua_istable(L, -1) ? (int)lua_rawlen(L, -1) : 0;
    for (int i = 1; i <= n; i++) {
        lua_rawgeti(L, -1, i);
        lua_rawseti(L, -3, i);
    }
    for (int i = n + 1; i <= S.idle[slot].len; i++) {
        lua_pushnil(L);
        lua_rawseti(L, -3, i);
    }
    // the coroutine itself too: one resumed from C++ (not by coroutine.resume) is not in the list above
    lua_pushthread(L);
    lua_rawseti(L, -3, 0);
    S.idle[slot].leaf = L;
    S.idle[slot].len = n;
    S.idle[slot].stamp = ++S.idleStamp;
    lua_pop(L, 3);
}

bool hasUserFrame(lua_State * T) {
    lua_Debug ar;
    for (int level = 0; lua_getstack(T, level, &ar) && level < 200; level++) {
        lua_getinfo(T, "S", &ar);
        if (isUserPath(sourcePath(ar.source))) return true;
    }
    return false;
}

void hook(lua_State * L, lua_Debug * ar) {
    switch (ar->event) {
        case LUA_HOOKLINE: {
            const unsigned line = (unsigned)ar->currentline;
            const bool bp = (S.bpBits[(line >> 5) % BP_WORDS].load(std::memory_order_relaxed) >> (line & 31)) & 1;
            if (!bp && !S.attention.load(std::memory_order_relaxed) && !pauseAsked.load(std::memory_order_relaxed)) return;
            onLine(L, ar, bp);
            return;
        }
        case LUA_HOOKCOUNT: cobaltHook(L, ar); return;
        case LUA_HOOKERROR: onError(L, ar); return;
        case LUA_HOOKRESUME: S.leafCandidate = true; return;
        case LUA_HOOKYIELD:
            if (S.leafCandidate) {
                S.leafCandidate = false;
                onLeafYield(L);
            }
            return;
        default: return;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The reader thread

void rebuildBits() {
    // under S.mu
    std::vector<uint32_t> bits(BP_WORDS, 0);
    for (const Breakpoint& b : S.bps) {
        const unsigned line = (unsigned)b.line;
        bits[(line >> 5) % BP_WORDS] |= 1u << (line & 31);
    }
    for (int i = 0; i < BP_WORDS; i++) S.bpBits[i].store(bits[i], std::memory_order_relaxed);
}

void forgetEverything() {
    {
        std::lock_guard<std::mutex> lock(S.mu);
        S.bps.clear();
        rebuildBits();
        S.runReceived = true;
    }
    S.errorMode = ERRORS_NONE;
    S.detached = true;
    pauseAsked = false;
    S.cv.notify_all();
}

void handleLine(const std::string& line) {
    Request r;
    try {
        Poco::JSON::Parser parser;
        r = parser.parse(line).extract<Request>();
    } catch (...) {
        return;
    }
    if (r.isNull()) return;
    const std::string cmd = strOf(r, "cmd");
    const int seq = intOf(r, "seq", 0);
    if (cmd == "setBreakpoints") {
        const std::string path = computerPath(strOf(r, "path"));
        std::vector<Breakpoint> added;
        try {
            Poco::JSON::Array::Ptr list = r->getArray("breakpoints");
            for (size_t i = 0; list && i < list->size(); i++) {
                Request b = list->getObject((unsigned)i);
                if (b.isNull()) continue;
                Breakpoint bp;
                bp.id = intOf(b, "id", 0);
                bp.path = path;
                bp.line = intOf(b, "line", 0);
                bp.condition = strOf(b, "condition");
                bp.log = strOf(b, "log");
                bp.hitOp = strOf(b, "hitOp");
                bp.hitN = intOf(b, "hitN", 0);
                added.push_back(bp);
            }
        } catch (...) {}
        {
            std::lock_guard<std::mutex> lock(S.mu);
            std::vector<Breakpoint> kept;
            for (const Breakpoint& b : S.bps) if (b.path != path) kept.push_back(b);
            for (const Breakpoint& b : added) kept.push_back(b);
            S.bps.swap(kept);
            rebuildBits();
        }
        reply(seq);
    } else if (cmd == "setErrorMode") {
        const std::string mode = strOf(r, "mode");
        S.errorMode = mode == "all" ? ERRORS_ALL : mode == "uncaught" ? ERRORS_UNCAUGHT : ERRORS_NONE;
        reply(seq);
    } else if (cmd == "configure") {
        S.stepIntoRom = boolOf(r, "stepIntoRom");
        {
            std::lock_guard<std::mutex> lock(S.mu);
            S.entryPath = computerPath(strOf(r, "entry"));
            S.stopOnEntry = boolOf(r, "stopOnEntry");
        }
        reply(seq);
    } else if (cmd == "run") {
        {
            std::lock_guard<std::mutex> lock(S.mu);
            S.runReceived = true;
        }
        S.cv.notify_all();
        reply(seq);
    } else if (cmd == "pause") {
        if (!stopped) {
            S.pauseAskedAtMs = nowMs();
            pauseAsked = true;
            // wake it if it is waiting for an event (unless the computer is gone: its memory may be too)
            if (S.comp != NULL && freedComputers.find(S.comp) == freedComputers.end()) S.comp->event_lock.notify_all();
        }
        reply(seq);
    } else if (cmd == "detach") {
        forgetEverything();
        reply(seq);
        std::lock_guard<std::mutex> lock(S.mu);
        if (S.acceptingRequests) {
            // go on as if "continue" had been sent
            Request go = new Poco::JSON::Object;
            go->set("cmd", "continue");
            go->set("seq", 0);
            S.queue.push_back(go);
            S.cv.notify_all();
        }
    } else {
        std::lock_guard<std::mutex> lock(S.mu);
        if (S.acceptingRequests) {
            S.queue.push_back(r);
            S.cv.notify_all();
        } else replyError(seq, "the program is running");
    }
}

void readerLoop() {
    std::string buffer;
    char chunk[8192];
    try {
        while (true) {
            const int n = S.sock.receiveBytes(chunk, sizeof(chunk));
            if (n <= 0) break;
            buffer.append(chunk, (size_t)n);
            size_t nl;
            while ((nl = buffer.find('\n')) != std::string::npos) {
                const std::string line = buffer.substr(0, nl);
                buffer.erase(0, nl + 1);
                if (!line.empty()) handleLine(line);
            }
        }
    } catch (...) {}
    // the adapter is gone: the program runs on as if no debugger had been there
    S.connected = false;
    forgetEverything();
}

bool connectToAdapter() {
    try {
        S.sock.connect(Poco::Net::SocketAddress(S.host, (Poco::UInt16)S.port), Poco::Timespan(5, 0));
        S.sock.setNoDelay(true);
    } catch (Poco::Exception &e) {
        fprintf(stderr, "debugger: could not connect to %s:%d: %s\n", S.host.c_str(), S.port, e.displayText().c_str());
        return false;
    } catch (std::exception &e) {
        fprintf(stderr, "debugger: could not connect to %s:%d: %s\n", S.host.c_str(), S.port, e.what());
        return false;
    }
    S.connected = true;
    S.reader = std::thread(readerLoop);
    S.reader.detach();
    return true;
}

} // namespace

// ---------------------------------------------------------------------------------------------------------------

void configure(const std::string& hostport) {
    const size_t colon = hostport.rfind(':');
    if (colon == std::string::npos) {
        fprintf(stderr, "debugger: --debug-connect needs host:port, got '%s'\n", hostport.c_str());
        return;
    }
    S.host = hostport.substr(0, colon);
    try {
        S.port = std::stoi(hostport.substr(colon + 1));
    } catch (...) {
        fprintf(stderr, "debugger: --debug-connect needs host:port, got '%s'\n", hostport.c_str());
        return;
    }
    const char * token = getenv("CRAFTOS_DEBUG_TOKEN");
    S.token = token ? token : "";
    for (int i = 0; i < BP_WORDS; i++) S.bpBits[i] = 0;
    enabled = true;
}

bool computerStarting(Computer * comp, lua_State * coro) {
    if (!enabled) return false;
    // the first computer to start is the one debugged, and stays it across its reboots
    Computer * none = NULL;
    if (!debugged.compare_exchange_strong(none, comp) && none != comp) return false;
    S.comp = comp;
    // nothing of the last Lua state (a reboot) is left to point at
    S.stepMode = STEP_NONE;
    S.stepThread = NULL;
    S.leafCandidate = false;
    for (State::IdleSlot& slot : S.idle) slot = State::IdleSlot();
    S.idleStamp = 0;
    S.haveBuiltins = false;
    S.chain.clear();
    S.frames.clear();
    S.framesBuilt = false;
    S.nextRef = 0;
    S.lastErrText.clear();
    S.lastErrThread = NULL;
    if (!S.everConnected) {
        S.everConnected = true;
        if (!connectToAdapter()) {
            enabled = false;
            return false;
        }
        sendLine(Json().str("event", "hello").str("token", S.token).num("protocol", 1).str("ccVersion", ccVersionString).num("computer", comp->id).done());
        // the adapter sends its breakpoints, then "run": nothing of the computer runs before that
        std::unique_lock<std::mutex> lock(S.mu);
        if (!S.cv.wait_for(lock, std::chrono::seconds(30), []{return S.runReceived || !S.connected;}))
            fprintf(stderr, "debugger: the adapter never said run; starting anyway\n");
    }
    if (!S.connected) return false;
    {
        std::lock_guard<std::mutex> lock(S.mu);
        S.entryNow = S.entryPath;
        S.stopOnEntryNow = S.stopOnEntry;
        S.entryPending = !S.entryNow.empty();
    }
    S.progThread = NULL;
    updateAttention();
    lua_createtable(coro, IDLE_SLOTS, 0);
    for (int i = 1; i <= IDLE_SLOTS; i++) {
        lua_newtable(coro);
        lua_rawseti(coro, -2, i);
    }
    lua_setfield(coro, LUA_REGISTRYINDEX, "_dbg_idle");
    S.hookMask = LUA_MASKLINE | LUA_MASKERROR | LUA_MASKRESUME | LUA_MASKYIELD;
    S.hookCount = 0;
    if (cobaltSlowdown > 1.0) {S.hookMask |= LUA_MASKCOUNT; S.hookCount = 1000;}
    lua_sethook(coro, hook, S.hookMask, S.hookCount);
    // the program's own debug.sethook goes on top of this one, and both run (ldblib.c), as on a server where the
    // debugger is not there to take the hook: the cide addon's agent hooks itself
    lua_setbasehook(coro, hook, S.hookMask, S.hookCount);
    sendLine(Json().str("event", "started").done());
    return true;
}

void computerStopping(Computer * comp) {
    if (!enabled || comp != S.comp) return;
    S.stepMode = STEP_NONE;
    S.stepThread = NULL;
    S.progThread = NULL;
    for (State::IdleSlot& slot : S.idle) slot = State::IdleSlot();
    updateAttention();
    sendLine(Json().str("event", "exited").done());
}

/** Tell the adapter once the debugged program has ended (its file's code is on no coroutine any more). */
static void programWatch(Computer * comp) {
    if (S.progThread == NULL || comp->L == NULL) return;
    // Every coroutine has yielded or ended by now. The program is still going if its coroutine is suspended with
    // at least as many frames as when the program's first line ran: its own code is then still among them.
    lua_Debug ar;
    lua_State * T = S.progThread;
    if (lua_status(T) == LUA_YIELD && lua_getstack(T, S.progDepth - 1, &ar)) return;
    S.progThread = NULL;
    lua_pushnil(comp->L);
    lua_setfield(comp->L, LUA_REGISTRYINDEX, "_dbg_prog");
    // What it left behind is not where the computer is any more: a step still waiting on one of its coroutines,
    // and the coroutines it abandoned mid-wait (the loser of a parallel.waitForAny), which a pause would show.
    S.stepMode = STEP_NONE;
    updateAttention();
    for (State::IdleSlot& slot : S.idle) slot = State::IdleSlot();
    sendLine(Json().str("event", "ended").done());
}

void roundStart(Computer * comp) {
    if (comp != S.comp) return;
    // no error is on its way up between two rounds: the next one with the same words is a new one
    S.lastErrText.clear();
    S.lastErrThread = NULL;
    programWatch(comp);
    if (pauseAsked.load(std::memory_order_relaxed)) idlePause(comp);
}

void idlePause(Computer * comp) {
    if (comp != S.comp) return; // another computer of this process: the pause is not for it
    pauseAsked = false;
    if (!enabled || S.detached || !S.connected || comp->L == NULL || stopped) return;
    S.stepMode = STEP_NONE;
    updateAttention();
    lua_State * B = comp->L;
    const int top = lua_gettop(B);
    S.chain.clear();
    // The waiting coroutine to show: the one that yielded last among those with the program's own code on their
    // stack, else the one that yielded last.
    std::vector<lua_State*> best;
    bool bestUser = false;
    unsigned long long bestStamp = 0;
    if (lua_checkstack(B, 4)) {
        lua_getfield(B, LUA_REGISTRYINDEX, "_dbg_idle");
        for (int i = 0; i < IDLE_SLOTS && lua_istable(B, -1); i++) {
            const State::IdleSlot& slot = S.idle[i];
            if (slot.leaf == NULL || slot.stamp == 0 || lua_status(slot.leaf) != LUA_YIELD) continue;
            std::vector<lua_State*> chain;
            bool user = false;
            if (slot.leaf != comp->coro && lua_checkstack(slot.leaf, 4)) {
                chain.push_back(slot.leaf);
                user = hasUserFrame(slot.leaf);
            }
            lua_rawgeti(B, -1, i + 1);
            for (int k = slot.len; k >= 1 && lua_istable(B, -1); k--) {
                lua_rawgeti(B, -1, k);
                lua_State * T = lua_tothread(B, -1);
                lua_pop(B, 1);
                if (T == NULL || T == comp->coro || T == slot.leaf || !lua_checkstack(T, 4)) continue;
                chain.push_back(T);
                user = user || hasUserFrame(T);
            }
            lua_pop(B, 1);
            if (chain.empty()) continue;
            if (best.empty() || (user && !bestUser) || (user == bestUser && slot.stamp > bestStamp)) {
                best.swap(chain);
                bestUser = user;
                bestStamp = slot.stamp;
            }
        }
    }
    lua_settop(B, top);
    S.chain = best;
    S.chain.push_back(comp->coro);
    stopLoop("pause", "", {});
}

long long frozenMicros() {
    std::lock_guard<std::mutex> lock(S.clockMu);
    long long total = S.frozenTotalUs;
    if (S.clockHeld) total += std::chrono::duration_cast<std::chrono::microseconds>(steady::now() - S.stopStarted).count();
    return total;
}

}
#endif
