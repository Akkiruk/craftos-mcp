/*
 * apis/handles/fs_handle.cpp
 * CraftOS-PC 2
 * 
 * This file implements the methods for file handles.
 * 
 * This code is licensed under the MIT license.
 * Copyright (c) 2019-2024 JackMacWindows.
 */

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include "fs_handle.hpp"
#include "../../util.hpp"
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include "../../runtime.hpp"
#endif

#if defined(__EMSCRIPTEN__) && defined(CRAFTOS_WEB)
// the browser build keeps files in MEMFS for the page's lifetime: nothing to sync (and no window on a worker)
extern "C" void emsyncfs() {}
#elif defined(__EMSCRIPTEN__)
EM_JS(void, emsyncfs, (), {
    if (window.fsIsSyncing) return;
    window.fsIsSyncing = true;
    FS.syncfs(false, function(err) {
        window.fsIsSyncing = false;
        if (err != null) console.log('Error while syncing filesystem: ', err);
    });
})
#endif

/**
 * craftos-agent: whether a write of n bytes would go past what the floppy the file is on has left. CC's counting
 * channel refuses such a write whole, before any of it is written, and the handle raises "Out of space". Files on
 * the computer's own drive (or a disk with room) are not refused. CC:Tweaked 1.101.3's text handles buffer 8 KiB
 * first, so there the error comes later than here (docs/conformance/emulator-vs-real-deviations.md).
 */
static bool outOfSpace(std::iostream * fp, size_t n) {
    if (!floppyTracked(fp)) return false;
    const std::streampos pos = fp->rdbuf()->pubseekoff(0, std::ios::cur, std::ios::out);
    return !floppyMayWrite(fp, pos == std::streampos(-1) ? 0 : (long long)pos, n);
}

int fs_handle_close(lua_State *L) {
    lastCFunction = __func__;
    std::iostream ** fp = (std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (*fp == NULL)
        return luaL_error(L, "attempt to use a closed file");
    floppyForget(*fp);
    if (dynamic_cast<std::fstream*>(*fp) != NULL) delete (std::fstream*)*fp;
    else if (dynamic_cast<std::stringstream*>(*fp) != NULL) delete (std::stringstream*)*fp;
    else delete *fp;
    *fp = NULL;
    get_comp(L)->files_open--;
#ifdef __EMSCRIPTEN__
    queueTask([](void*)->void*{emsyncfs(); return NULL;}, NULL, true);
#endif
    return 0;
}

int fs_handle_gc(lua_State *L) {
    lastCFunction = __func__;
    std::iostream ** fp = (std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (*fp == NULL)
        return 0;
    floppyForget(*fp);
    if (dynamic_cast<std::fstream*>(*fp) != NULL) delete (std::fstream*)*fp;
    else if (dynamic_cast<std::stringstream*>(*fp) != NULL) delete (std::stringstream*)*fp;
    else delete *fp;
    *fp = NULL;
    get_comp(L)->files_open--;
#ifdef __EMSCRIPTEN__
    queueTask([](void*)->void*{emsyncfs(); return NULL;}, NULL, true);
#endif
    return 0;
}

int fs_handle_readAll(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    if (fp->eof()) {
        if (fp->tellg() < 1) return 0;
        lua_pushliteral(L, "");
        return 1;
    }
    if (fp->bad() || fp->fail()) return 0;
    const long pos = (long)fp->tellg();
    fp->seekg(0, std::ios::end);
    if (fp->bad() || fp->fail()) return 0;
    long size = (long)fp->tellg() - pos;
    char * retval = new char[size + 1];
    memset(retval, 0, size + 1);
    fp->seekg(pos);
    int i;
    for (i = 0; !fp->eof() && i < size; i++) {
        int c = fp->get();
        if (c == EOF && fp->eof()) { size = i; break; }
        if (c == '\n' && (i > 0 && retval[i-1] == '\r')) retval[--i] = '\n';
        else retval[i] = (char)c;
    }
    const std::string out = makeASCIISafe(retval, i - (i == size ? 0 : 1));
    delete[] retval;
    lua_pushlstring(L, out.c_str(), out.length());
    return 1;
}

std::string decodeTextFile(const std::string& raw) {
    std::string out;
    out.reserve(raw.size());
    for (size_t i = 0; i < raw.size();) {
        const unsigned char c = (unsigned char)raw[i];
        if (c < 0x80) { out += (char)c; i++; continue; }
        unsigned len = 0;
        unsigned long cp = 0;
        if ((c & 0xE0) == 0xC0) { len = 2; cp = c & 0x1F; }
        else if ((c & 0xF0) == 0xE0) { len = 3; cp = c & 0x0F; }
        else if ((c & 0xF8) == 0xF0) { len = 4; cp = c & 0x07; }
        bool ok = len > 0 && i + len <= raw.size();
        for (unsigned k = 1; ok && k < len; k++) {
            const unsigned char cc = (unsigned char)raw[i + k];
            if ((cc & 0xC0) != 0x80) ok = false;
            else cp = (cp << 6) | (cc & 0x3F);
        }
        if (!ok) { out += '?'; i++; continue; }
        out += cp < 256 ? (char)cp : '?';
        i += len;
    }
    return out;
}

std::string encodeTextString(const char * str, size_t len) {
    std::string out;
    out.reserve(len);
    for (size_t i = 0; i < len; i++) {
        const unsigned char c = (unsigned char)str[i];
        if (c < 0x80) out += (char)c;
        else { out += (char)(0xC0 | (c >> 6)); out += (char)(0x80 | (c & 0x3F)); }
    }
    return out;
}

std::string javaDoubleToString(double d) {
    if (std::isnan(d)) return "NaN";
    if (std::isinf(d)) return d > 0 ? "Infinity" : "-Infinity";
    if (d == 0.0) return std::signbit(d) ? "-0.0" : "0.0";
    // shortest digits that round-trip
    char buf[64];
    int prec = 1;
    for (; prec <= 17; prec++) {
        snprintf(buf, sizeof buf, "%.*e", prec - 1, d);
        if (strtod(buf, NULL) == d) break;
    }
    if (prec > 17) snprintf(buf, sizeof buf, "%.16e", d);
    std::string s(buf);  // like -1.2345e+05
    const bool neg = s[0] == '-';
    if (neg) s.erase(0, 1);
    const size_t epos = s.find('e');
    int exp10 = atoi(s.c_str() + epos + 1);
    std::string digits;
    for (size_t i = 0; i < epos; i++) if (s[i] != '.') digits += s[i];
    while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
    std::string out;
    const double a = d < 0 ? -d : d;
    if (a >= 1e-3 && a < 1e7) {
        if (exp10 >= 0) {
            std::string intPart = digits.substr(0, std::min<size_t>(digits.size(), exp10 + 1));
            while ((int)intPart.size() < exp10 + 1) intPart += '0';
            std::string frac = digits.size() > (size_t)exp10 + 1 ? digits.substr(exp10 + 1) : "0";
            out = intPart + "." + frac;
        } else {
            out = "0." + std::string(-exp10 - 1, '0') + digits;
        }
    } else {
        out = digits.substr(0, 1) + "." + (digits.size() > 1 ? digits.substr(1) : "0") + "E" + std::to_string(exp10);
    }
    return neg ? "-" + out : out;
}

/** Reads one line like Java's BufferedReader: \n, \r and \r\n all end a line. */
int fs_handle_readLine(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    if (fp->eof()) return 0;
    if (!fp->good()) return luaL_error(L, "Could not read file");
    std::string retval;
    bool terminated = false;
    for (;;) {
        const int c = fp->get();
        if (c == EOF) break;
        if (c == '\n') { terminated = true; break; }
        if (c == '\r') {
            if (fp->peek() == '\n') fp->get();
            terminated = true;
            break;
        }
        retval += (char)c;
    }
    if (!terminated && retval.empty()) return 0;
    if (!terminated) fp->setstate(std::ios::eofbit);
    if (lua_toboolean(L, 1) && terminated) retval += '\n';
    lua_pushlstring(L, retval.c_str(), retval.length());
    return 1;
}

/** Text-mode readAll: the remaining lines joined with "\n", without the final newline ("" at the end of the file). */
int fs_handle_readAllText(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    std::string out;
    bool any = false;
    std::string line;
    for (;;) {
        const int c = fp->get();
        if (c == EOF) break;
        if (c == '\n' || c == '\r') {
            if (c == '\r' && fp->peek() == '\n') fp->get();
            if (any) out += '\n';
            out += line;
            line.clear();
            any = true;
            continue;
        }
        line += (char)c;
    }
    fp->clear();
    fp->setstate(std::ios::eofbit);
    // `line` holds an unterminated last line; a final newline adds nothing
    if (!line.empty()) { if (any) out += '\n'; out += line; }
    lua_pushlstring(L, out.c_str(), out.length());
    return 1;
}

int fs_handle_readChar(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    if (fp->eof()) return 0;
    if (!fp->good()) luaL_error(L, "Could not read file");
    if (lua_isnumber(L, 1)) {
        if (lua_tointeger(L, 1) < 0) luaL_error(L, "Cannot read a negative number of characters");
        const size_t s = lua_tointeger(L, 1);
        if (s == 0) {
            if (fp->peek() == EOF || fp->eof()) return 0;
            lua_pushstring(L, "");
            return 1;
        }
        char* retval = new char[s];
        fp->read(retval, s);
        const size_t actual = fp->gcount();
        if (actual == 0) {delete[] retval; return 0;}
        lua_pushlstring(L, retval, actual);
        delete[] retval;
    } else {
        const int retval = fp->get();
        if (retval == EOF || fp->eof()) return 0;
        lua_pushlstring(L, (const char *)&retval, 1);
    }
    return 1;
}

int fs_handle_readByte(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    if (fp->eof()) return 0;
    if (!fp->good()) return luaL_error(L, "Could not read file");
    if (lua_isnumber(L, 1)) {
        if (lua_tointeger(L, 1) < 0) luaL_error(L, "Cannot read a negative number of bytes");
        const size_t s = lua_tointeger(L, 1);
        if (s == 0) {
            if (fp->peek() == EOF || fp->eof()) return 0;
            lua_pushstring(L, "");
            return 1;
        }
        char* retval = new char[s];
        fp->read(retval, s);
        const size_t actual = fp->gcount();
        if (actual == 0) {delete[] retval; return 0;}
        lua_pushlstring(L, retval, actual);
        delete[] retval;
    } else {
        const int retval = fp->get();
        if (retval == EOF || fp->eof()) return 0;
        lua_pushinteger(L, (unsigned char)retval);
    }
    return 1;
}

int fs_handle_readAllByte(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    if (fp->eof()) return 0;  // CC: readAll on a binary handle at the end of the file returns nil
    if (fp->bad() || fp->fail()) return luaL_error(L, "Could not read file");
    std::streampos pos = fp->tellg();
    fp->seekg(0, std::ios_base::end);
    size_t size = fp->tellg() - pos;
    fp->seekg(pos, std::ios_base::beg);
    char * str = (char*)malloc(size);
    if (str == NULL) return luaL_error(L, "failed to allocate memory");
    fp->read(str, size);
    size = fp->gcount();
    fp->setstate(std::ios::eofbit); // set EOF flag
    lua_pushlstring(L, str, size);
    free(str);
    return 1;
}

int fs_handle_writeString(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    if (lua_isnoneornil(L, 1)) return 0;
    else if (!lua_isstring(L, 1) && !lua_isnumber(L, 1)) return luaL_error(L, "bad argument #1 (string expected, got %s)", lua_typename(L, lua_type(L, 1)));
    if (fp->eof()) {
        fp->seekp(0, std::ios::end);
        fp->clear(fp->rdstate() & ~std::ios::eofbit);
    }
    if (!fp->good()) return luaL_error(L, "Could not write file");
    if (lua_type(L, 1) == LUA_TNUMBER) {
        const std::string text = javaDoubleToString(lua_tonumber(L, 1));
        if (outOfSpace(fp, text.length())) return luaL_error(L, "Out of space");
        fp->write(text.c_str(), text.length());
        return 0;
    }
    size_t sz = 0;
    const char * str = lua_tolstring(L, 1, &sz);
    const std::string encoded = encodeTextString(str, sz);
    if (outOfSpace(fp, encoded.length())) return luaL_error(L, "Out of space");
    fp->write(encoded.c_str(), encoded.length());
    return 0;
}

int fs_handle_writeLine(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    if (lua_isnoneornil(L, 1)) return 0;
    else if (!lua_isstring(L, 1) && !lua_isnumber(L, 1)) return luaL_error(L, "bad argument #1 (string expected, got %s)", lua_typename(L, lua_type(L, 1)));
    if (fp->eof()) {
        fp->seekp(0, std::ios::end);
        fp->clear(fp->rdstate() & ~std::ios::eofbit);
    }
    if (!fp->good()) return luaL_error(L, "Could not write file");
    if (lua_type(L, 1) == LUA_TNUMBER) {
        const std::string text = javaDoubleToString(lua_tonumber(L, 1)) + "\n";
        if (outOfSpace(fp, text.length())) return luaL_error(L, "Out of space");
        fp->write(text.c_str(), text.length());
        return 0;
    }
    size_t sz = 0;
    const char * str = lua_tolstring(L, 1, &sz);
    const std::string encoded = encodeTextString(str, sz);
    if (outOfSpace(fp, encoded.length() + 1)) return luaL_error(L, "Out of space");
    fp->write(encoded.c_str(), encoded.length());
    fp->put('\n');
    return 0;
}

int fs_handle_writeByte(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    if (fp->eof()) {
        fp->seekp(0, std::ios::end);
        fp->clear(fp->rdstate() & ~std::ios::eofbit);
    }
    if (!fp->good()) return luaL_error(L, "Could not write file");
    if (lua_type(L, 1) == LUA_TNUMBER) {
        const char b = (unsigned char)(lua_tointeger(L, 1) & 0xFF);
        if (outOfSpace(fp, 1)) return luaL_error(L, "Out of space");
        fp->put(b);
    } else if (lua_isstring(L, 1)) {
        size_t sz = 0;
        const char * str = lua_tolstring(L, 1, &sz);
        if (sz == 0) return 0;
        if (outOfSpace(fp, sz)) return luaL_error(L, "Out of space");
        fp->write(str, sz);
    } else return luaL_error(L, "bad argument #1 (number or string expected, got %s)", lua_typename(L, lua_type(L, 1)));
    return 0;
}

int fs_handle_flush(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    fp->flush();
#ifdef __EMSCRIPTEN__
    queueTask([](void*)->void*{emsyncfs(); return NULL;}, NULL, true);
#endif
    return 0;
}

/*
 * craftos-agent: CC:Tweaked 1.109.0+ file handles (ccAtLeast(comp, 1, 109, 0)). Every mode reads and writes raw
 * bytes (no UTF-8 decoding, no line-ending changes), r+ and w+ read and write the same handle, readAll returns ""
 * at the end of the file, and everything written is coerced to a string first (AbstractHandle in 1.121.0).
 * They work on the stream buffer directly and re-sync its position before each call, so reads and writes can be
 * mixed on one handle.
 */
static std::iostream * rawHandle(lua_State *L) {
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) { luaL_error(L, "attempt to use a closed file"); return NULL; }
    fp->clear();
    // a file stream must seek between reading and writing; seeking to where it already is does that
    // (an absolute seek: MSVC's filebuf skips the C-level seek for a zero relative one)
    if (dynamic_cast<std::fstream*>(fp) != NULL) {
        const std::streampos pos = fp->rdbuf()->pubseekoff(0, std::ios::cur, std::ios::in | std::ios::out);
        if (pos != std::streampos(-1)) fp->rdbuf()->pubseekpos(pos, std::ios::in | std::ios::out);
    }
    return fp;
}

/** What CC writes for a value: a string's own bytes, else Lua's tostring without __tostring ("nil" for none). */
static std::string coercedBytes(lua_State *L, int idx) {
    switch (lua_type(L, idx)) {
        case LUA_TSTRING: case LUA_TNUMBER: {
            lua_pushvalue(L, idx);  // a copy: lua_tolstring turns a number into a string in place
            size_t sz = 0;
            const char * s = lua_tolstring(L, -1, &sz);
            std::string out(s, sz);
            lua_pop(L, 1);
            return out;
        }
        case LUA_TBOOLEAN: return lua_toboolean(L, idx) ? "true" : "false";
        case LUA_TNIL: case LUA_TNONE: return "nil";
        default: {
            char buf[64];
            snprintf(buf, sizeof buf, "%s: %p", lua_typename(L, lua_type(L, idx)), lua_topointer(L, idx));
            return buf;
        }
    }
}

static int readRaw(lua_State *L, bool binary) {
    std::iostream * fp = rawHandle(L);
    std::streambuf * buf = fp->rdbuf();
    if (binary && lua_isnoneornil(L, 1)) {
        const int c = buf->sbumpc();
        if (c == EOF) return 0;
        lua_pushinteger(L, (unsigned char)c);
        return 1;
    }
    const lua_Integer count = lua_isnoneornil(L, 1) ? 1 : luaL_checkinteger(L, 1);
    if (count < 0) return luaL_error(L, "Cannot read a negative number of bytes");
    if (count == 0) {
        if (buf->sgetc() == EOF) return 0;
        lua_pushliteral(L, "");
        return 1;
    }
    std::string out;
    char chunk[8192];
    while ((lua_Integer)out.size() < count) {
        const std::streamsize want = (std::streamsize)std::min<lua_Integer>((lua_Integer)sizeof chunk, count - (lua_Integer)out.size());
        const std::streamsize got = buf->sgetn(chunk, want);
        if (got <= 0) break;
        out.append(chunk, (size_t)got);
        if (got < want) break;
    }
    if (out.empty()) return 0;
    lua_pushlstring(L, out.c_str(), out.size());
    return 1;
}

int fs_handle_readCharRaw(lua_State *L) { lastCFunction = __func__; return readRaw(L, false); }
int fs_handle_readByteRaw(lua_State *L) { lastCFunction = __func__; return readRaw(L, true); }

int fs_handle_readAllRaw(lua_State *L) {
    lastCFunction = __func__;
    std::streambuf * buf = rawHandle(L)->rdbuf();
    std::string out;
    char chunk[8192];
    std::streamsize got;
    while ((got = buf->sgetn(chunk, sizeof chunk)) > 0) out.append(chunk, (size_t)got);
    lua_pushlstring(L, out.c_str(), out.size());
    return 1;
}

/** AbstractHandle.readLine: ends at "\n" (a "\r" before it is dropped unless the separator is kept); a lone "\r" is text. */
int fs_handle_readLineRaw(lua_State *L) {
    lastCFunction = __func__;
    const bool withTrailing = lua_toboolean(L, 1);
    std::streambuf * buf = rawHandle(L)->rdbuf();
    std::string line;
    bool readAnything = false, readRc = false;
    for (;;) {
        const int c = buf->sbumpc();
        if (c == EOF) {
            if (readRc) line += '\r';
            if (!readAnything) return 0;
            break;
        }
        readAnything = true;
        if (c == '\n') {
            if (withTrailing) { if (readRc) line += '\r'; line += '\n'; }
            break;
        }
        if (readRc) line += '\r';
        readRc = c == '\r';
        if (!readRc) line += (char)c;
    }
    lua_pushlstring(L, line.c_str(), line.size());
    return 1;
}

static int writeRaw(lua_State *L, bool binary, bool newline) {
    std::iostream * fp = rawHandle(L);
    std::streambuf * buf = fp->rdbuf();
    if (binary && !newline && lua_type(L, 1) == LUA_TNUMBER) {
        if (outOfSpace(fp, 1)) return luaL_error(L, "Out of space");
        if (buf->sputc((char)(unsigned char)(lua_tointeger(L, 1) & 0xFF)) == EOF) return luaL_error(L, "Could not write file");
        return 0;
    }
    std::string text = coercedBytes(L, 1);
    if (newline) text += '\n';
    if (outOfSpace(fp, text.size())) return luaL_error(L, "Out of space");
    if (buf->sputn(text.c_str(), (std::streamsize)text.size()) != (std::streamsize)text.size()) return luaL_error(L, "Could not write file");
    return 0;
}

int fs_handle_writeStringRaw(lua_State *L) { lastCFunction = __func__; return writeRaw(L, false, false); }
int fs_handle_writeByteRaw(lua_State *L) { lastCFunction = __func__; return writeRaw(L, true, false); }
int fs_handle_writeLineRaw(lua_State *L) { lastCFunction = __func__; return writeRaw(L, false, true); }

int fs_handle_seek(lua_State *L) {
    lastCFunction = __func__;
    std::iostream * fp = *(std::iostream**)lua_touserdata(L, lua_upvalueindex(1));
    if (fp == NULL) return luaL_error(L, "attempt to use a closed file");
    const char * whence = luaL_optstring(L, 1, "cur");
    const size_t offset = luaL_optinteger(L, 2, 0);
    if (strcmp(whence, "set") == 0 && luaL_optinteger(L, 2, 0) < 0) {
        lua_pushnil(L);
        lua_pushliteral(L, "Position is negative");
        return 2;
    }
    std::ios::seekdir origin;
    if (strcmp(whence, "set") == 0) origin = std::ios::beg;
    else if (strcmp(whence, "cur") == 0) origin = std::ios::cur;
    else if (strcmp(whence, "end") == 0) origin = std::ios::end;
    else return luaL_error(L, "bad argument #1 to 'seek' (invalid option '%s')", whence);
    fp->clear();
    fp->seekg(offset, origin);
    if (fp->fail()) {
        lua_pushnil(L);
        lua_pushstring(L, strerror(errno));
        return 2;
    }
    lua_pushinteger(L, fp->tellg());
    return 1;
}
