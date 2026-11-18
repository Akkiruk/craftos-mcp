/*
 * fs.cpp
 * CraftOS-PC 2
 * 
 * This file implements the methods for the fs API.
 * 
 * This code is licensed under the MIT license.
 * Copyright (c) 2019-2024 JackMacWindows.
 */

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <codecvt>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <regex>
#include <sstream>
#include <chrono>
#include <mutex>
#include <set>
#include <unordered_map>
#include <Computer.hpp>
#include <configuration.hpp>
#include <dirent.h>
#include <FileEntry.hpp>
#include <sys/stat.h>
#include "handles/fs_handle.hpp"
#include "../peripheral/drive.hpp"
#include "../platform.hpp"
#include "../runtime.hpp"
#ifdef WIN32
#include <io.h>
#include <fcntl.h>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#define W_OK 0x02
#define access(p, m) _waccess(p, m)

/**
 * A file stream opened with FILE_SHARE_DELETE, so the file can be deleted or replaced while a handle is still open
 * (Java does this on the server; the plain fstream refuses with a sharing violation).
 */
class SharedFstream : public std::fstream {
    FILE * file;
public:
    explicit SharedFstream(FILE * f) : std::fstream(f), file(f) {}
    ~SharedFstream() override { if (is_open()) close(); if (file) fclose(file); }
};

static std::fstream * openSharedFstream(const path_t& path, bool read, bool write, bool truncate, bool atEnd) {
    const DWORD desired = (read ? GENERIC_READ : 0) | (write ? GENERIC_WRITE : 0);
    const DWORD disposition = write ? (truncate ? CREATE_ALWAYS : OPEN_ALWAYS) : OPEN_EXISTING;
    HANDLE h = CreateFileW(path.c_str(), desired, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, disposition, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    const int fd = _open_osfhandle((intptr_t)h, _O_BINARY);
    if (fd < 0) { CloseHandle(h); return NULL; }
    FILE * f = _fdopen(fd, read && write ? "r+b" : write ? "wb" : "rb");
    if (f == NULL) { _close(fd); return NULL; }
    if (atEnd) fseek(f, 0, SEEK_END);
    return new SharedFstream(f);
}
#else
#include <fcntl.h>
#include <libgen.h>
#include <unistd.h>
#endif
#if defined(__INTELLISENSE__) && !defined(S_ISDIR)
#define S_ISDIR(m) 1 // silence errors in IntelliSense (which isn't very intelligent for its name)
#define W_OK 2
#endif

static std::basic_regex<path_t::value_type> pathregex(const std::string& str) {return std::basic_regex<path_t::value_type>(path_t(str).native());};

#define err(L, idx, err) luaL_error(L, "/%s: %s", fixpath(get_comp(L), lua_tostring(L, idx), false, false).string().c_str(), err)

#ifdef STANDALONE_ROM
extern FileEntry standaloneROM;
extern FileEntry standaloneDebug;
extern std::string standaloneBIOS;
#endif

static path_t ignored_files[4] = {
    ".",
    "..",
    ".DS_Store",
    "desktop.ini"
};

static bool _nothrow(std::function<void()> f) { try { f(); return true; } catch (...) { return false; } }
#define nothrow(expr) _nothrow([&](){ expr ;})

inline bool isVFSPath(path_t path) {
    if (!std::isdigit(path.native()[0])) return false;
    for (const path_t::value_type& c : path.native()) {
        if (c == ':') return true;
        else if (!std::isdigit(c)) return false;
    }
    return false;
}

static std::vector<path_t> fixpath_multiple(Computer *comp, std::string path) {
    std::vector<path_t> retval;
    path.erase(std::remove_if(path.begin(), path.end(), [](char c)->bool {return c == '"' || c == '*' || c == ':' || c == '<' || c == '>' || c == '?' || c == '|' || (unsigned char)c < 32; }), path.end());
    std::vector<std::string> elems = split(path, "/\\");
    std::list<std::string> pathc;
    for (std::string s : elems) {
        if (!ccPathPart(comp, s)) continue;  // trim spaces as fixpath does (fs.list(" rom ") is fs.list("rom"))
        if (s == "..") {
            if (pathc.empty()) return retval;
            else pathc.pop_back();
        } else pathc.push_back(s);
    }
    while (!pathc.empty() && pathc.front().empty()) pathc.pop_front();
    if (comp->isDebugger && pathc.size() == 1 && pathc.front() == "bios.lua")
#ifdef STANDALONE_ROM
        return {path_t(":bios.lua", path_t::format::generic_format)};
#else
        return {getROMPath()/"bios.lua"};
#endif
    std::pair<size_t, std::vector<_path_t> > max_path = std::make_pair(0, std::vector<_path_t>(1, comp->dataDir));
    std::list<std::string> * mount_list = NULL;
    for (auto& m : comp->mounts) {
        std::list<std::string> &pathlist = std::get<0>(m);
        if (pathc.size() >= pathlist.size() && std::equal(pathlist.begin(), pathlist.end(), pathc.begin())) {
            if (pathlist.size() > max_path.first) {
                max_path = std::make_pair(pathlist.size(), std::vector<_path_t>(1, std::get<1>(m)));
                mount_list = &pathlist;
            } else if (pathlist.size() == max_path.first) {
                max_path.second.push_back(std::get<1>(m));
            }
        }
    }
    for (size_t i = 0; i < max_path.first; i++) pathc.pop_front();
    for (const _path_t& p : max_path.second) {
        path_t sstmp = p;
        std::error_code e;
        for (const std::string& s : pathc) sstmp /= ccPathName(s);
        if (
            (isVFSPath(p) && nothrow(comp->virtualMounts[(unsigned)std::stoul(p.substr(0, p.size()-1))]->path(sstmp.string()))) ||
            (fs::exists(sstmp, e))) {
            if (path_t::preferred_separator != (path_t::value_type)'/' && isVFSPath(sstmp)) {
                path_t::string_type str = sstmp.native();
                std::replace(str.begin(), str.end(), path_t::preferred_separator, (path_t::value_type)'/');
                sstmp = path_t(str);
            }
            retval.push_back(sstmp);
        }
    }
    return retval;
}

static std::string normalizePath(const path_t& basePath, bool allowWildcards = false) {
    path_t cleanPath;
    for (const auto& p : basePath) {
        path_t::string_type str = p.native();
        str.erase(std::remove_if(str.begin(), str.end(), [allowWildcards](path_t::string_type::value_type c)->bool {return c == '"' || (c == '*' && !allowWildcards) || c == ':' || c == '<' || c == '>' || (c == '?' && !allowWildcards) || c == '|' || c < 32;}), str.end());
        if (std::regex_match(str, pathregex("^\\.\\.\\.+$"))) cleanPath /= ".";
        else cleanPath /= path_t(str);
    }
    cleanPath = cleanPath.lexically_normal();
    if (path_t::preferred_separator != (path_t::value_type)'/') {
        path_t::string_type str = cleanPath.native();
        std::replace(str.begin(), str.end(), path_t::preferred_separator, (path_t::value_type)'/');
        cleanPath = path_t(str);
    }
    std::string retval = cleanPath.string();
    if (retval == ".") retval = "";
    if (!retval.empty() && retval[0] == '/') retval = retval.substr(1);
    if (!retval.empty() && retval[retval.size()-1] == '/') retval = retval.substr(0, retval.size()-1);
    return retval;
}

static fs::space_info getSpace(const path_t& path) {
    std::error_code e;
    fs::space_info retval;
    path_t p = path;
    do {
        retval = fs::space(p, e);
        p = p.parent_path();
    } while (((e && e.value() == ENOENT) || retval.capacity == -1) && p.has_parent_path());
    return retval;
}

static int fs_list(lua_State *L) {
    lastCFunction = __func__;
    std::string str = checkstring(L, 1);
    const std::vector<path_t> possible_paths = fixpath_multiple(get_comp(L), str);
    // CC:Tweaked 1.101.3 reports missing nodes the same way as files; 1.121.0 says "No such file".
    if (possible_paths.empty()) err(L, 1, ccAtLeast(get_comp(L), 1, 109, 0) ? "No such file" : "Not a directory");
    bool gotdir = false;
    std::set<std::string> entries;
    for (const path_t& path : possible_paths) {
        if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:"))) {
            try {
                const FileEntry &d = get_comp(L)->virtualMounts[(unsigned)std::stoul((*path.begin()).native())]->path(path.lexically_relative(*path.begin()));
                if (d.isDir) {
                    gotdir = true;
                    for (const auto& p : d.dir) entries.insert(p.first);
                }
            } catch (...) {continue;}
        } else {
            std::error_code e;
            if (fs::is_directory(path, e)) {
                gotdir = true;
                for (const auto& dir : fs::directory_iterator(path, e)) {
                    if (dir.path().filename() == ".DS_Store" || dir.path().filename() == "desktop.ini") continue;
                    entries.insert(ccNameString(dir.path().filename()));
                }
            }
        }
    }
    if (!gotdir) err(L, 1, "Not a directory");
    std::set<std::string> mounts = getMounts(get_comp(L), str);
    std::set<std::string> all;
    std::set_union(entries.begin(), entries.end(), mounts.begin(), mounts.end(), std::inserter(all, all.begin()));
    int i = 1;
    lua_createtable(L, all.size(), 0);
    for (const std::string& p : all) {
        lua_pushinteger(L, i++);
        lua_pushstring(L, p.c_str());
        lua_settable(L, -3);
    }
    return 1;
}

static int fs_exists(lua_State *L) {
    lastCFunction = __func__;
    const path_t path = fixpath(get_comp(L), checkstring(L, 1), true);
    if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:"))) {
        bool found = true;
        try {get_comp(L)->virtualMounts[(unsigned)std::stoul((*path.begin()).native())]->path(path.lexically_relative(*path.begin()));} catch (...) {found = false;}
        lua_pushboolean(L, found);
#ifdef STANDALONE_ROM
    } else if (path == ":bios.lua") {
        lua_pushboolean(L, true);
#endif
    } else {
        lua_pushboolean(L, !path.empty());
    }
    return 1;
}

static int fs_isDir(lua_State *L) {
    lastCFunction = __func__;
    const path_t path = fixpath(get_comp(L), checkstring(L, 1), true);
    if (path.empty()) {
        lua_pushboolean(L, false);
        return 1;
    }
    if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:"))) {
        try {lua_pushboolean(L, get_comp(L)->virtualMounts[(unsigned)std::stoul((*path.begin()).native())]->path(path.lexically_relative(*path.begin())).isDir);} 
        catch (...) {lua_pushboolean(L, false);}
    } else {
        std::error_code e;
        lua_pushboolean(L, fs::is_directory(path, e));
    }
    return 1;
}

static int fs_isReadOnly(lua_State *L) {
    lastCFunction = __func__;
    std::string str = checkstring(L, 1);
    if (fixpath_ro(get_comp(L), str)) {
        lua_pushboolean(L, true);
        return 1;
    }
    const path_t path = fixpath_mkdir(get_comp(L), str, false);
    std::error_code e;
    if (path.empty()) err(L, 1, "Invalid path"); // This should never happen
    if (!fs::exists(path, e)) lua_pushboolean(L, false);
#ifdef WIN32
    else if (e.clear(), fs::is_directory(path, e))
        lua_pushboolean(L, winFolderIsReadOnly(path));
#endif
    else lua_pushboolean(L, access(path.native().c_str(), W_OK) != 0);
    return 1;
}

/**
 * CC:Tweaked 1.121.0's FileSystem.sanitizePath: drop control and special characters, trim spaces around each part,
 * skip empty parts and any part made of dots and spaces (". .", "..." count as "."), and keep a ".." that has
 * nothing left to cancel. 1.101.3 computers use normalizePath above.
 */
static std::string ccSanitizePath(const std::string& path, bool allowWildcards) {
    std::string clean;
    for (char ch : path) {
        const unsigned char c = (unsigned char)(ch == '\\' ? '/' : ch);
        if (c < 32 || c == '"' || c == ':' || c == '<' || c == '>' || c == '|') continue;
        if (!allowWildcards && (c == '*' || c == '?')) continue;
        clean += (char)c;
    }
    std::vector<std::string> parts;
    size_t start = 0;
    for (;;) {
        const size_t slash = clean.find('/', start);
        std::string part = clean.substr(start, slash == std::string::npos ? std::string::npos : slash - start);
        const size_t first = part.find_first_not_of(' ');
        part = first == std::string::npos ? "" : part.substr(first, part.find_last_not_of(' ') - first + 1);
        if (part.size() > 255) {
            part = part.substr(0, 255);
            const size_t last = part.find_last_not_of(' ');
            part = last == std::string::npos ? "" : part.substr(0, last + 1);
        }
        if (part == "..") {
            if (parts.empty() || parts.back() == "..") parts.push_back("..");
            else parts.pop_back();
        } else if (!part.empty() && !(part[0] == '.' && part.find_first_not_of(". ") == std::string::npos)) {
            parts.push_back(part);
        }
        if (slash == std::string::npos) break;
        start = slash + 1;
    }
    std::string out;
    for (const std::string& p : parts) { if (!out.empty()) out += '/'; out += p; }
    return out;
}

static int fs_getName(lua_State *L) {
    lastCFunction = __func__;
    if (ccAtLeast(get_comp(L), 1, 117, 0)) {
        const std::string path = ccSanitizePath(checkstring(L, 1), true);
        if (path.empty()) { lua_pushliteral(L, "root"); return 1; }
        const size_t slash = path.find_last_of('/');
        pushstring(L, slash == std::string::npos ? path : path.substr(slash + 1));
        return 1;
    }
    std::string retval = path_t(normalizePath(checkstring(L, 1), true)).filename().string();
    if (retval.empty()) lua_pushliteral(L, "root");
    else pushstring(L, retval);
    return 1;
}

static int fs_getDrive(lua_State *L) {
    lastCFunction = __func__;
    std::string retval;
    Computer * comp = get_comp(L);
    if (fixpath(comp, checkstring(L, 1), true, true, &retval).empty()) return 0;
    // craftos-agent: a floppy's mount is labelled with its drive, not with where it is mounted: "left", not "disk"
    // (ComputerAccess.mount: fileSystem.mount(driveName, location, mount), driveName the attachment name)
    if (retval.compare(0, 4, "disk") == 0) {
        std::lock_guard<std::mutex> lock(comp->peripherals_mutex);
        for (const auto& p : comp->peripherals) {
            const drive * d = dynamic_cast<const drive*>(p.second);
            if (d != NULL && d->mountPath() == retval) { retval = p.first; break; }
        }
    }
    lua_pushstring(L, retval.c_str());
    return 1;
}

static int fs_getSize(lua_State *L) {
    lastCFunction = __func__;
    std::string str = checkstring(L, 1);
    const path_t path = fixpath(get_comp(L), str, true);
    std::error_code e;
    if (path.empty()) err(L, 1, "No such file");
    if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:"))) {
        try {
            const FileEntry &d = get_comp(L)->virtualMounts[(unsigned)std::stoul((*path.begin()).native())]->path(path.lexically_relative(*path.begin()));
            if (d.isDir) err(L, 1, "Is a directory");
            lua_pushinteger(L, d.data.size());
        } catch (...) {err(L, 1, "No such file");}
#ifdef STANDALONE_ROM
    } else if (path == ":bios.lua") {
        lua_pushinteger(L, standaloneBIOS.size());
#endif
    } else if (fs::is_directory(path, e)) {
        lua_pushinteger(L, 0);
    } else {
        lua_pushinteger(L, fs::file_size(path, e));
    }
    return 1;
}

// What the computer's own drive holds, kept between getFreeSpace calls instead of walking the whole folder each time
// (CC keeps a running count too). Every file is remembered with its size; the fs calls that change the drive mark the
// paths they touched, and only those are looked at again. Files opened for writing are looked at on every call, since
// their size moves with each write. Anything changed behind the computer's back is picked up by a full walk every 2 s.
namespace {
struct SpaceCache {
    bool valid = false;
    long long total = 0;
    std::chrono::steady_clock::time_point walked;
    std::unordered_map<path_t::string_type, long long> sizes;
    std::set<path_t::string_type> dirty;
    std::set<path_t::string_type> writing;
};
std::mutex spaceMutex;
std::unordered_map<path_t::string_type, SpaceCache> spaceCaches;

void spaceWalk(SpaceCache& cache, const path_t& path) {
    std::error_code e;
    if (fs::is_directory(path, e)) {
        for (const auto& dir : fs::directory_iterator(path, e)) spaceWalk(cache, dir.path());
    } else {
        e.clear();
        const auto size = fs::file_size(path, e);
        if (!e) {
            cache.sizes[path.native()] = (long long)size;
            cache.total += (long long)size;
        }
    }
}

void spaceForget(SpaceCache& cache, const path_t::string_type& key) {
    for (auto it = cache.sizes.begin(); it != cache.sizes.end();) {
        const auto& k = it->first;
        if (k == key || (k.size() > key.size() && k.compare(0, key.size(), key) == 0 && (k[key.size()] == '/' || k[key.size()] == '\\'))) {
            cache.total -= it->second;
            it = cache.sizes.erase(it);
        } else ++it;
    }
}

bool underRoot(const path_t::string_type& root, const path_t::string_type& p) {
    return p.size() >= root.size() && p.compare(0, root.size(), root) == 0;
}
}

/** A change to path (a file or a folder) on this computer: the next getFreeSpace looks at it again. */
static void spaceTouched(lua_State *L, const path_t& path, bool openForWrite = false) {
    if (path.empty()) return;
    const path_t::string_type root = fixpath(get_comp(L), "", true).native();
    const path_t::string_type p = path.native();
    std::lock_guard<std::mutex> lock(spaceMutex);
    auto it = spaceCaches.find(root);
    if (it == spaceCaches.end() || !underRoot(root, p)) return;
    SpaceCache& cache = it->second;
    if (openForWrite) {
        cache.writing.insert(p);
        // a program writing many different files: stop tracking them one by one and walk again
        if (cache.writing.size() > 256) cache.valid = false;
    } else cache.dirty.insert(p);
}

static long long spaceUsed(lua_State *L) {
    const path_t rootPath = fixpath(get_comp(L), "", true);
    const path_t::string_type root = rootPath.native();
    std::lock_guard<std::mutex> lock(spaceMutex);
    SpaceCache& cache = spaceCaches[root];
    const auto now = std::chrono::steady_clock::now();
    if (!cache.valid || now - cache.walked > std::chrono::seconds(2)) {
        cache.sizes.clear();
        cache.dirty.clear();
        if (!cache.valid) cache.writing.clear();
        cache.total = 0;
        spaceWalk(cache, rootPath);
        cache.walked = now;
        cache.valid = true;
        return cache.total;
    }
    for (const auto& p : cache.writing) cache.dirty.insert(p);
    for (const auto& p : cache.dirty) {
        spaceForget(cache, p);
        spaceWalk(cache, path_t(p));
    }
    cache.dirty.clear();
    return cache.total;
}

// craftos-agent: a floppy disk holds 125000 bytes (CC:Tweaked's floppySpaceLimit), counted like the computer's own
// drive. The drive peripheral mounts <computers>/disk/<id> at "disk", "disk2", ...: such a mount is a floppy. The
// engine answered with the host disk's free space and size instead, some terabytes.
static const long long FLOPPY_SPACE_LIMIT = 125000;

// Counted the way CC:Tweaked's FileMount (1.101.3) and WritableFileMount (1.121.0) count: every folder, the disk's
// own included, is 500 bytes, and every file max(its size, 500). The mount's capacity is the limit plus 500 for the
// root folder, so an empty disk has all 125000 free. A file open for writing counts as far as it has been written
// (its stream holds bytes the host's disk does not have yet).
static const long long MINIMUM_FILE_SIZE = 500;

namespace {
struct FloppyWrite {
    path_t root;          // the disk's folder on the host
    path_t file;          // the file being written
    long long extent;     // how far the file reaches, written bytes included
};
std::mutex floppyMutex;
std::unordered_map<const void*, FloppyWrite> floppyWrites;  // by the handle's stream
}

/** The folder of the floppy disk `real` (a host path) is on, or an empty path when it is on no floppy. */
static path_t floppyRootOf(Computer * comp, const path_t& real) {
    for (const auto& m : comp->mounts) {
        const std::list<std::string>& parts = std::get<0>(m);
        if (parts.size() != 1 || parts.front().compare(0, 4, "disk") != 0) continue;
        const path_t& root = std::get<1>(m);
        if (root.parent_path().filename() != path_t("disk")) continue;
        const auto mismatch = std::mismatch(root.begin(), root.end(), real.begin(), real.end());
        if (mismatch.first == root.end()) return root;
    }
    return path_t();
}

static long long ccSpaceWalk(const path_t& path, const std::unordered_map<path_t::string_type, long long>& open) {
    std::error_code e;
    if (fs::is_directory(path, e)) {
        long long total = MINIMUM_FILE_SIZE;
        for (const auto& entry : fs::directory_iterator(path, e)) total += ccSpaceWalk(entry.path(), open);
        return total;
    }
    const auto it = open.find(path.native());
    if (it != open.end()) return std::max(MINIMUM_FILE_SIZE, it->second);
    e.clear();
    const auto size = fs::file_size(path, e);
    return e ? 0 : std::max(MINIMUM_FILE_SIZE, (long long)size);
}

/** What the disk in folder `root` uses as CC counts it (500 for the folder of an empty or blank disk). */
static long long floppyUsedAt(const path_t& root) {
    std::unordered_map<path_t::string_type, long long> open;
    {
        std::lock_guard<std::mutex> lock(floppyMutex);
        for (const auto& w : floppyWrites) if (w.second.root == root) open[w.second.file.native()] = w.second.extent;
    }
    std::error_code e;
    if (!fs::exists(root, e)) return MINIMUM_FILE_SIZE;
    return ccSpaceWalk(root, open);
}

/** The bytes used on the floppy mounted at `mountPath`, or -1 when that mount is not a floppy disk. */
static long long floppyUsed(Computer * comp, const std::string& mountPath) {
    if (mountPath.compare(0, 4, "disk") != 0) return -1;
    for (const auto& m : comp->mounts) {
        const std::list<std::string>& parts = std::get<0>(m);
        if (parts.size() != 1 || parts.front() != mountPath) continue;
        const path_t& root = std::get<1>(m);
        if (root.parent_path().filename() != path_t("disk")) continue;
        return floppyUsedAt(root) - MINIMUM_FILE_SIZE;  // the root folder's 500 is on top of the limit
    }
    return -1;
}

/** How many folders makeDirectory(dir) creates: dir and each missing one above it, up to the disk's folder. */
static int floppyMissingDirs(const path_t& root, const path_t& dir) {
    int n = 0;
    std::error_code e;
    for (path_t p = dir; !p.empty() && p != root && !fs::exists(p, e); p = p.parent_path()) {
        n++;
        if (p == p.parent_path()) break;
    }
    return n;
}

/** The disk's free space as CC's getRemainingSpace has it. */
static long long floppyRemaining(const path_t& root) {
    return std::max<long long>(0, FLOPPY_SPACE_LIMIT + MINIMUM_FILE_SIZE - floppyUsedAt(root));
}

/** A handle writing to a file on a floppy: its writes are counted against the disk from now on. */
static void floppyTrack(const void * handle, const path_t& root, const path_t& file, long long extent) {
    std::lock_guard<std::mutex> lock(floppyMutex);
    floppyWrites[handle] = FloppyWrite{root, file, extent};
}

/** Whether the handle writes to a floppy (most never do: this is all the others pay). */
bool floppyTracked(const void * handle) {
    std::lock_guard<std::mutex> lock(floppyMutex);
    return !floppyWrites.empty() && floppyWrites.find(handle) != floppyWrites.end();
}

/** The handle is closed: its file is counted from the disk again. */
void floppyForget(const void * handle) {
    std::lock_guard<std::mutex> lock(floppyMutex);
    floppyWrites.erase(handle);
}

/**
 * The CountingChannel's check before a write of n bytes at the stream's position: the bytes past the end of the file
 * (past its first 500) must fit on the disk, or the write is refused whole with "Out of space". True when the
 * stream is on no floppy, or the bytes fit.
 */
bool floppyMayWrite(const void * handle, long long position, size_t n) {
    path_t root;
    long long extent;
    {
        std::lock_guard<std::mutex> lock(floppyMutex);
        const auto it = floppyWrites.find(handle);
        if (it == floppyWrites.end()) return true;
        root = it->second.root;
        extent = it->second.extent;
    }
    const long long reach = std::max(extent, position + (long long)n);
    const long long newBytes = std::max(MINIMUM_FILE_SIZE, reach) - std::max(MINIMUM_FILE_SIZE, extent);
    if (newBytes > 0 && floppyUsedAt(root) + newBytes > FLOPPY_SPACE_LIMIT + MINIMUM_FILE_SIZE) return false;
    std::lock_guard<std::mutex> lock(floppyMutex);
    const auto it = floppyWrites.find(handle);
    if (it != floppyWrites.end()) it->second.extent = reach;
    return true;
}

static int fs_getFreeSpace(lua_State *L) {
    lastCFunction = __func__;
    std::string mountPath;
    std::string str = checkstring(L, 1);
    const path_t path = fixpath(get_comp(L), str, false, true, &mountPath);
    // An unknown path counts as part of the computer's own drive, like CC.
    std::error_code existsErr;
    if (path.empty() || !fs::exists(path, existsErr)) mountPath = "hdd";
    const long long onFloppy = mountPath != "hdd" ? floppyUsed(get_comp(L), mountPath) : -1;
    if (!path.empty() && fs::exists(path, existsErr) && fixpath_ro(get_comp(L), str)) lua_pushinteger(L, 0);
    else if (onFloppy >= 0) lua_pushinteger(L, std::max<long long>(0, FLOPPY_SPACE_LIMIT - onFloppy));
    else if (mountPath != "hdd") lua_pushinteger(L, getSpace(path).free);
    else lua_pushinteger(L, std::max<long long>(0, (long long)config.computerSpaceLimit - spaceUsed(L)));
    return 1;
}

static int fs_makeDir(lua_State *L) {
    lastCFunction = __func__;
    std::string str = checkstring(L, 1);
    if (fixpath_ro(get_comp(L), str)) err(L, 1, "Access denied");
    const path_t path = fixpath_mkdir(get_comp(L), str);
    if (path.empty()) err(L, 1, "Could not create directory");
    if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:"))) err(L, 1, "Permission denied");
    std::error_code e;
    // A regular file in the way: CC reports "File exists" (the OS wording differs per platform).
    if (fs::exists(path, e) && !fs::is_directory(path, e)) err(L, 1, "File exists");
    // FileMount.makeDirectory: 500 bytes for each folder it makes, or "Out of space"
    const path_t floppyRoot = floppyRootOf(get_comp(L), path);
    if (!floppyRoot.empty() && floppyMissingDirs(floppyRoot, path) * MINIMUM_FILE_SIZE > floppyRemaining(floppyRoot))
        err(L, 1, "Out of space");
    e.clear();
    fs::create_directories(path, e);
    if (e) {
        if (e.value() == ENOTDIR) e.assign(EEXIST, std::generic_category());
        err(L, 1, e.message().c_str());
    }
    return 0;
}

static int fs_move(lua_State *L) {
    lastCFunction = __func__;
    std::string str1 = checkstring(L, 1);
    std::string str2 = checkstring(L, 2);
    if (fixpath_ro(get_comp(L), str1)) luaL_error(L, "Access denied");
    if (fixpath_ro(get_comp(L), str2)) luaL_error(L, "Access denied");
    bool isRoot = false;
    const path_t fromPath = fixpath(get_comp(L), str1, true, true, NULL, &isRoot);
    const path_t toPath = fixpath_mkdir(get_comp(L), str2);
    if (fromPath.empty()) luaL_error(L, "No such file");
    if (toPath.empty()) err(L, 2, "Invalid path");
    if (std::regex_search((*fromPath.begin()).native(), pathregex("^\\d+:"))) err(L, 1, "Permission denied");
    if (std::regex_search((*toPath.begin()).native(), pathregex("^\\d+:"))) err(L, 2, "Permission denied");
    if (std::mismatch(toPath.begin(), toPath.end(), fromPath.begin(), fromPath.end()).second == fromPath.end()) 
        luaL_error(L, "Can't move a directory inside itself");
    if (isRoot) luaL_error(L, "Cannot move mount");
    std::error_code e;
    if (fs::exists(toPath, e)) luaL_error(L, "File exists");
    e.clear();
    fs::create_directories(toPath.parent_path(), e);
    if (e) err(L, 2, e.message().c_str());
    fs::rename(fromPath, toPath, e);
    spaceTouched(L, fromPath);
    spaceTouched(L, toPath);
    if (e) err(L, 1, e.message().c_str());
    return 0;
}

// fs.__ccsimTryLock(path) creates path only if it does not exist yet, in one step no other process can split: true for
// the one caller that made it. Emulator-only (ccsim/core.lua takes it and removes it before any program runs): linked
// computers hold their one shared economy with it. A rename cannot do this on Windows, which renames through a handle
// opened first, so two computers that both opened the same file can both rename it.
static int fs_ccsimTryLock(lua_State *L) {
    lastCFunction = __func__;
    std::string str = checkstring(L, 1);
    if (fixpath_ro(get_comp(L), str)) luaL_error(L, "Access denied");
    const path_t path = fixpath_mkdir(get_comp(L), str);
    if (path.empty()) err(L, 1, "Invalid path");
#ifdef _WIN32
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    const bool made = h != INVALID_HANDLE_VALUE;
    if (made) CloseHandle(h);
#else
    const int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0644);
    const bool made = fd >= 0;
    if (made) ::close(fd);
#endif
    if (made) spaceTouched(L, path);
    lua_pushboolean(L, made);
    return 1;
}

static int fs_copy(lua_State *L) {
    lastCFunction = __func__;
    std::string str1 = checkstring(L, 1);
    std::string str2 = checkstring(L, 2);
    if (fixpath_ro(get_comp(L), str2)) luaL_error(L, "/%s: Access denied", fixpath(get_comp(L), str2, false, false).string().c_str());
    const path_t fromPath = fixpath(get_comp(L), str1, true);
    const path_t toPath = fixpath_mkdir(get_comp(L), str2);
    if (fromPath.empty()) err(L, 1, "No such file");
    if (toPath.empty()) err(L, 2, "Invalid path");
    if (std::regex_search((*toPath.begin()).native(), pathregex("^\\d+:"))) err(L, 2, "Permission denied");
    if (std::regex_search((*fromPath.begin()).native(), pathregex("^\\d+:"))) {
        try {
            const FileEntry &d = get_comp(L)->virtualMounts[(unsigned)std::stoul((*fromPath.begin()).c_str())]->path(fromPath.lexically_relative(*fromPath.begin()));
            if (d.isDir) err(L, 1, "Is a directory");
            std::ofstream tofp(toPath);
            if (!tofp.is_open()) return err(L, 2, "Cannot write file");
            tofp.write(d.data.c_str(), d.data.size());
            tofp.close();
            spaceTouched(L, toPath);
        } catch (...) {err(L, 1, "No such file");}
    } else {
        /*if (isFSCaseSensitive == -1) {
            struct_stat st;
            char* name = tmpnam(NULL);
            fclose(platform_fopen(name, "w"));
            std::transform(name, name + strlen(name), name, [](char c)->char{return isupper(c) ? tolower(c) : toupper(c);});
            isFSCaseSensitive = stat(name, &st);
            remove(name);
        }*/
        std::vector<std::string> fromElems = split(str1, "/\\"), toElems = split(str2, "/\\");
        while (!fromElems.empty() && fromElems.front().empty()) fromElems.erase(fromElems.begin());
        while (!toElems.empty() && toElems.front().empty()) toElems.erase(toElems.begin());
        while (!fromElems.empty() && fromElems.back().empty()) fromElems.pop_back();
        while (!toElems.empty() && toElems.back().empty()) toElems.pop_back();
        bool equal = true;
        for (unsigned i = 0; i < toElems.size() && equal; i++) {
            if (i >= fromElems.size()) err(L, 1, "Can't copy a directory inside itself");
            std::string lstrfrom = fromElems[i], lstrto = toElems[i];
            std::transform(lstrfrom.begin(), lstrfrom.end(), lstrfrom.begin(), [](unsigned char c) {return std::tolower(c);});
            std::transform(lstrto.begin(), lstrto.end(), lstrto.begin(), [](unsigned char c) {return std::tolower(c);});
            if (lstrfrom != lstrto) equal = false;
            else if ((i == fromElems.size() - 1 && i == toElems.size() - 1)) err(L, 1, "Can't copy a directory inside itself");
        }
        if (equal) err(L, 1, "Can't copy a directory inside itself");
        std::error_code e;
        fs::create_directories(toPath.parent_path(), e);
        if (e) err(L, 2, e.message().c_str());
        fs::copy(fromPath, toPath, fs::copy_options::recursive, e);
        spaceTouched(L, toPath);
        if (e == std::errc::file_exists) luaL_error(L, "/%s: File exists", fixpath(get_comp(L), str2, false, false).string().c_str());
        if (e) err(L, 1, e.message().c_str());
    }
    return 0;
}

static int fs_delete(lua_State *L) {
    lastCFunction = __func__;
    std::string str = checkstring(L, 1);
    if (fixpath_ro(get_comp(L), str)) err(L, 1, "Access denied");
    bool isRoot = false;
    const path_t path = fixpath(get_comp(L), str, true, true, NULL, &isRoot);
    if (isRoot) luaL_error(L, "Cannot delete mount, use mounter.unmount instead");
    if (path.empty()) return 0;
    if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:"))) err(L, 1, "Permission denied");
    std::error_code e;
    fs::remove_all(path, e);
    if (e) {
        // On Windows a file cannot be deleted while a handle is open. Handles that
        // Lua code dropped without closing are only released by the garbage
        // collector, so collect and retry once (CC's JVM deletes such files fine).
        lua_gc(L, LUA_GCCOLLECT, 0);
        e.clear();
        fs::remove_all(path, e);
    }
    spaceTouched(L, path);
    if (e) err(L, 1, e.message().c_str());
    return 0;
}

static int fs_combine(lua_State *L) {
    lastCFunction = __func__;
    if (ccAtLeast(get_comp(L), 1, 117, 0)) {
        // FSAPI.combine: sanitise each part, join with "/", sanitise the whole
        std::string result = ccSanitizePath(checkstring(L, 1), true);
        for (int i = 2; i <= lua_gettop(L); i++) {
            const std::string part = ccSanitizePath(checkstring(L, i), true);
            if (!result.empty() && !part.empty()) result += '/';
            result += part;
        }
        pushstring(L, ccSanitizePath(result, true));
        return 1;
    }
    path_t basePath = path_t(checkstring(L, 1), path_t::format::generic_format);
    for (int i = 2; i <= lua_gettop(L); i++) if (!checkstring(L, i).empty()) {
        std::string str = tostring(L, i);
        if (str[0] == '/' || str[0] == '\\') str = str.substr(1);
        basePath /= str;
    }
    pushstring(L, normalizePath(basePath, true));
    return 1;
}

static int fs_open(lua_State *L) {
    lastCFunction = __func__;
    Computer * computer = get_comp(L);
    const char * mode = luaL_checkstring(L, 2);
    // CC:Tweaked 1.101.3 knows r, w, a and their binary forms only ("w+" and friends are "Unsupported mode").
    // 1.109.0 adds r+ and w+ (and r+b, w+b), and its handles read and write raw bytes in every mode.
    const bool raw = ccAtLeast(computer, 1, 109, 0);
    if (raw) {
        if (strcmp(mode, "r") && strcmp(mode, "rb") && strcmp(mode, "w") && strcmp(mode, "wb") && strcmp(mode, "a") &&
            strcmp(mode, "ab") && strcmp(mode, "r+") && strcmp(mode, "r+b") && strcmp(mode, "w+") && strcmp(mode, "w+b"))
            luaL_error(L, "Unsupported mode");
    } else if (
        (mode[0] != 'r' && mode[0] != 'w' && mode[0] != 'a') ||
        !(mode[1] == '\0' || (mode[1] == 'b' && mode[2] == '\0'))
        ) luaL_error(L, "Unsupported mode");
    const bool plus = strchr(mode, '+') != NULL;
    const bool writable = mode[0] != 'r' || plus;
    // where 1.101.3 said "No such file" for a directory opened to read, 1.109.0+ says "Not a file"
    const char * dirReadMessage = raw ? "Not a file" : "No such file";
    std::string str = checkstring(L, 1);
    // Too many open files is a normal failure (nil, message) in CC, not an error.
    if (computer->files_open >= config.maximumFilesOpen) {
        lua_pushnil(L);
        lua_pushfstring(L, "/%s: Too many files already open", fixpath(computer, str, false, false).string().c_str());
        return 2;
    }
#ifdef WIN32
    {
        // Windows device names (CON, NUL, COM1, ...) open the device instead of a file, and the
        // "file" can then never be deleted. Refuse them like CC does on a failing open.
        const size_t slash = str.find_last_of("/\\");
        std::string stem = str.substr(slash == std::string::npos ? 0 : slash + 1);
        stem = stem.substr(0, stem.find('.'));
        std::string upper;
        for (char c : stem) upper += (char)toupper((unsigned char)c);
        const bool numbered = upper.size() == 4 && (upper.compare(0, 3, "COM") == 0 || upper.compare(0, 3, "LPT") == 0) && upper[3] >= '1' && upper[3] <= '9';
        if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL" || numbered) {
            lua_pushnil(L);
            lua_pushfstring(L, "/%s: Incorrect function.", fixpath(computer, str, false, false).string().c_str());
            return 2;
        }
    }
#endif
    const path_t path = mode[0] == 'r' ? fixpath(get_comp(L), str, true) : fixpath_mkdir(get_comp(L), str);
    if (path.empty()) {
        if (writable && fixpath_ro(computer, str)) {
            lua_pushnil(L);
            lua_pushfstring(L, "/%s: Access denied", fixpath(computer, str, false, false).string().c_str());
            return 2;
        } else {
            // a path that climbs out of the computer's root is invalid, not merely missing
            int depth = 0;
            bool escapes = false;
            for (const std::string& part : split(str, "/\\")) {
                if (part == "..") { if (--depth < 0) { escapes = true; break; } }
                else if (!part.empty() && part != ".") depth++;
            }
            lua_pushnil(L);
            if (escapes) lua_pushliteral(L, "/../x: Invalid Path");
            else lua_pushfstring(L, "/%s: No such file", fixpath(computer, str, false, false).string().c_str());
            return 2;
        }
    }
    int fpid;
    path_t floppyRoot;  // the disk the file is on, when it is on a floppy and opened to write
    long long floppyExtent = 0;
    if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:")) || path == ":bios.lua") {
        if (computer->files_open >= config.maximumFilesOpen) err(L, 1, "Too many files already open");
        std::stringstream ** fp = (std::stringstream**)lua_newuserdata(L, sizeof(std::stringstream**));
        fpid = lua_gettop(L);
#ifdef STANDALONE_ROM
        if (path == ":bios.lua") {
            *fp = new std::stringstream(standaloneBIOS);
        } else {
#endif
            try {
                const FileEntry &d = computer->virtualMounts[(unsigned)std::stoul((*path.begin()).native())]->path(path.lexically_relative(*path.begin()));
                if (d.isDir) {
                    lua_remove(L, fpid);
                    lua_pushnil(L);
                    if (strchr(mode, 'r') != NULL) lua_pushfstring(L, "/%s: %s", fixpath(computer, str, false, false).string().c_str(), dirReadMessage); // CC:Tweaked 1.101.3 reports directories as "No such file"
                    else lua_pushfstring(L, "/%s: Cannot write to directory", fixpath(computer, str, false, false).string().c_str());
                    return 2;
                }
                if (raw && writable) {  // virtual mounts are read-only
                    lua_remove(L, fpid);
                    lua_pushnil(L);
                    lua_pushfstring(L, "/%s: Access denied", fixpath(computer, str, false, false).string().c_str());
                    return 2;
                }
                *fp = new std::stringstream(mode[0] == 'r' && !strchr(mode, 'b') && !raw ? decodeTextFile(d.data) : d.data);
            } catch (...) {
                lua_remove(L, fpid);
                lua_pushnil(L);
                lua_pushfstring(L, "/%s: No such file", fixpath(computer, str, false, false).string().c_str());
                return 2;
            }
#ifdef STANDALONE_ROM
        }
#endif
    } else {
        std::error_code e;
        if (fs::is_directory(path, e)) { 
            lua_pushnil(L);
            if (strchr(mode, 'r') != NULL) lua_pushfstring(L, "/%s: %s", fixpath(computer, str, false, false).string().c_str(), dirReadMessage); // CC:Tweaked 1.101.3 reports directories as "No such file"
            else lua_pushfstring(L, "/%s: Cannot write to directory", fixpath(computer, str, false, false).string().c_str());
            return 2;
        }
        if (writable) {
            if (fixpath_ro(computer, str)) {
                lua_pushnil(L);
                lua_pushfstring(L, "/%s: Access denied", fixpath(computer, str, false, false).string().c_str());
                return 2;
            }
            // a floppy has room for so much: the missing folders first (MountWrapper.openForWrite makes them), then
            // 500 bytes for a file that is not there yet (FileMount.openForWrite)
            floppyRoot = floppyRootOf(computer, path);
            if (!floppyRoot.empty()) {
                const long long remaining = floppyRemaining(floppyRoot);
                const long long dirs = floppyMissingDirs(floppyRoot, path.parent_path()) * MINIMUM_FILE_SIZE;
                e.clear();
                const bool exists = fs::exists(path, e);
                const std::string shown = fixpath(computer, str, false, false).string();
                if (dirs > remaining || (!exists && remaining - dirs < MINIMUM_FILE_SIZE)) {
                    const std::string where = dirs > remaining ? path_t(shown).parent_path().generic_string() : shown;
                    lua_pushnil(L);
                    lua_pushfstring(L, "/%s: Out of space", where.c_str());
                    return 2;
                }
                floppyExtent = 0;
                if (exists && (mode[0] == 'a' || mode[0] == 'r')) floppyExtent = (long long)fs::file_size(path, e);
            }
            e.clear();
            fs::create_directories(path.parent_path(), e);
            if (e) {
                lua_pushnil(L);
                lua_pushfstring(L, "/%s: Cannot create directory", fixpath(computer, str, false, false).string().c_str());
                return 2;
            }
        }
        if (mode[0] == 'r' && !strchr(mode, 'b') && !raw) {
            // Text-mode reads see the file as UTF-8 decoded to 8-bit characters (CC's behaviour), so decode up front.
            std::ifstream in(path, std::ios::binary);
            if (!in.is_open()) {
                lua_pushnil(L);
                lua_pushfstring(L, "/%s: No such file", fixpath(computer, str, false, false).native().c_str());
                return 2;
            }
            const std::string rawBytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
            std::stringstream ** sp = (std::stringstream**)lua_newuserdata(L, sizeof(std::stringstream*));
            fpid = lua_gettop(L);
            *sp = new std::stringstream(decodeTextFile(rawBytes));
        } else {
        std::fstream ** fp = (std::fstream**)lua_newuserdata(L, sizeof(std::fstream*));
        fpid = lua_gettop(L);
        std::ios::openmode flags = std::ios::binary;
        if (strchr(mode, 'r')) {
            flags |= std::ios::in;
            if (plus) flags |= std::ios::out;  // r+: read and write, the file must exist
        } else if (strchr(mode, 'w')) {
            flags |= std::ios::out | std::ios::trunc;
            if (plus) flags |= std::ios::in;  // w+: read and write a new, empty file
        } else if (strchr(mode, 'a')) {
            flags |= std::ios::in | std::ios::out | std::ios::ate;
        }
#ifdef WIN32
        *fp = openSharedFstream(path, !!(flags & std::ios::in), !!(flags & std::ios::out), !!(flags & std::ios::trunc), !!(flags & std::ios::ate));
        if (*fp == NULL) *fp = new std::fstream();  // not open: handled below like a failed open
#else
        *fp = new std::fstream(path, flags);
#endif
        if (!(*fp)->is_open()) {
            bool ok = false;
            if (strchr(mode, 'a')) {
                (*fp)->open(path, (flags & ~std::ios::ate) | std::ios::trunc);
                ok = (*fp)->is_open();
            }
            if (!ok) {
                delete *fp;
                lua_remove(L, fpid);
                lua_pushnil(L);
                lua_pushfstring(L, "/%s: No such file", fixpath(computer, str, false, false).native().c_str());
                return 2;
            }
        }
        if (writable) spaceTouched(L, path, true);
        if (writable && !floppyRoot.empty()) floppyTrack(static_cast<std::iostream*>(*fp), floppyRoot, path, floppyExtent);
        }
    }
    lua_createtable(L, 0, 1);
    lua_pushvalue(L, fpid);
    lua_pushcclosure(L, fs_handle_gc, 1);
    lua_setfield(L, -2, "__gc");
    lua_setmetatable(L, -2);
    
    lua_createtable(L, 0, 4);
    lua_pushstring(L, "close");
    lua_pushvalue(L, fpid);
    lua_pushcclosure(L, fs_handle_close, 1);
    lua_settable(L, -3);

    if (raw) {
        // CC:Tweaked 1.109.0+: one kind of handle for every mode (ReadHandle, WriteHandle, ReadWriteHandle)
        const bool binary = strchr(mode, 'b') != NULL;
        const bool readable = mode[0] == 'r' || plus;
        const std::pair<const char *, lua_CFunction> methods[] = {
            {"read", readable ? (binary ? fs_handle_readByteRaw : fs_handle_readCharRaw) : NULL},
            {"readAll", readable ? fs_handle_readAllRaw : NULL},
            {"readLine", readable ? fs_handle_readLineRaw : NULL},
            {"write", writable ? (binary ? fs_handle_writeByteRaw : fs_handle_writeStringRaw) : NULL},
            {"writeLine", writable ? fs_handle_writeLineRaw : NULL},
            {"flush", writable ? fs_handle_flush : NULL},
            {"seek", mode[0] != 'a' ? fs_handle_seek : NULL},  // append handles cannot seek
        };
        for (const auto& m : methods) {
            if (m.second == NULL) continue;
            lua_pushstring(L, m.first);
            lua_pushvalue(L, fpid);
            lua_pushcclosure(L, m.second, 1);
            lua_settable(L, -3);
        }
        computer->files_open++;
        return 1;
    }

    if (strchr(mode, 'b')) {  // only binary handles can seek in CC
        lua_pushstring(L, "seek");
        lua_pushvalue(L, fpid);
        lua_pushcclosure(L, fs_handle_seek, 1);
        lua_settable(L, -3);
    }

    if (mode[0] == 'r' || strchr(mode, '+')) {
        if (strchr(mode, 'b')) {
            lua_pushstring(L, "read");
            lua_pushvalue(L, fpid);
            lua_pushcclosure(L, fs_handle_readByte, 1);
            lua_settable(L, -3);
        } else {
            lua_pushstring(L, "read");
            lua_pushvalue(L, fpid);
            lua_pushcclosure(L, fs_handle_readChar, 1);
            lua_settable(L, -3);
        }

        lua_pushstring(L, "readAll");
        lua_pushvalue(L, fpid);
        lua_pushcclosure(L, strchr(mode, 'b') ? fs_handle_readAllByte : fs_handle_readAllText, 1);
        lua_settable(L, -3);

        lua_pushstring(L, "readLine");
        lua_pushvalue(L, fpid);
        lua_pushcclosure(L, fs_handle_readLine, 1);
        lua_settable(L, -3);
    }

    if (mode[0] == 'w' || mode[0] == 'a' || strchr(mode, '+')) {
        if (strchr(mode, 'b')) {
            lua_pushstring(L, "write");
            lua_pushvalue(L, fpid);
            lua_pushcclosure(L, fs_handle_writeByte, 1);
            lua_settable(L, -3);
        } else {
            lua_pushstring(L, "write");
            lua_pushvalue(L, fpid);
            lua_pushcclosure(L, fs_handle_writeString, 1);
            lua_settable(L, -3);
        }

        lua_pushstring(L, "writeLine");
        lua_pushvalue(L, fpid);
        lua_pushcclosure(L, fs_handle_writeLine, 1);
        lua_settable(L, -3);

        lua_pushstring(L, "flush");
        lua_pushvalue(L, fpid);
        lua_pushcclosure(L, fs_handle_flush, 1);
        lua_settable(L, -3);
    }

    computer->files_open++;
    return 1;
}

static std::string replace_str(std::string data, const std::string& toSearch, const std::string& replaceStr) {
    size_t pos = data.find(toSearch);
    while (pos != std::string::npos) {
        data.replace(pos, toSearch.size(), replaceStr);
        pos = data.find(toSearch, pos + replaceStr.size());
    }
    return data;
}

static std::string regex_escape[] = {"\\", ".", "[", "]", "{", "}", "^", "$", "(", ")", "+", "?", "|"};

static std::list<std::string> matchWildcard(Computer * comp, const std::list<std::string>& options, std::list<std::string>::iterator pathc, const std::list<std::string>::iterator end) {
    if (pathc == end) return {};
    std::string pathc_regex = *pathc;
    for (const std::string& r : regex_escape) pathc_regex = replace_str(pathc_regex, r, "\\" + r);
    pathc_regex = replace_str(pathc_regex, "*", ".*");
    std::list<std::string> nextOptions;
    for (const std::string& opt : options) {
        std::vector<path_t> possible_paths = fixpath_multiple(comp, opt.c_str());
        if (possible_paths.empty()) continue;
        for (const path_t& path : possible_paths) {
            if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:"))) {
                try {
                    const FileEntry &d = comp->virtualMounts[(unsigned)std::stoul((*path.begin()).native())]->path(path.lexically_relative(*path.begin()));
                    if (d.isDir) for (auto p : d.dir) if (std::regex_match(p.first, std::regex(pathc_regex))) nextOptions.push_back(opt + (opt == "" ? "" : "/") + p.first);
                } catch (...) {continue;}
            } else {
                std::error_code e;
                if (fs::is_directory(path, e)) {
                    for (const auto& dir : fs::directory_iterator(path, e)) {
                        if (dir.path().filename() == ".DS_Store" || dir.path().filename() == "desktop.ini") continue;
                        if (std::regex_match(ccNameString(dir.path().filename()), std::regex(pathc_regex))) nextOptions.push_back(opt + (opt.empty() ? "" : "/") + ccNameString(dir.path().filename()));
                    }
                }
            }
        }
        for (const std::string& value : getMounts(comp, opt.c_str())) 
            if (*pathc == "*" || value == *pathc) nextOptions.push_back(opt + (opt.empty() ? "" : "/") + value);
    }
    if (++pathc == end) return nextOptions;
    else return matchWildcard(comp, nextOptions, pathc, end);
}

// Deprecated as of 1.105.0, but remains here for safety.
static int fs_find(lua_State *L) {
    lastCFunction = __func__;
    std::string str = checkstring(L, 1);
    std::vector<std::string> elems = split(str, "/\\");
    std::list<std::string> pathc;
    for (const std::string& s : elems) {
        if (s == "..") { 
            if (pathc.empty()) luaL_error(L, "Not a directory");
            else pathc.pop_back(); 
        }
        else if (!s.empty() && !std::all_of(s.begin(), s.end(), [](const char c)->bool{return c == '.';})) pathc.push_back(s);
    }
    while (!pathc.empty() && pathc.front().empty()) pathc.pop_front();
    while (!pathc.empty() && pathc.back().empty()) pathc.pop_back();
    if (pathc.empty()) {
        lua_createtable(L, 1, 0);
        lua_pushstring(L, "");
        lua_rawseti(L, -2, 1);
        return 1;
    }
    std::list<std::string> matches = matchWildcard(get_comp(L), {""}, pathc.begin(), pathc.end());
    matches.sort();
    matches.erase(std::unique(matches.begin(), matches.end()), matches.end());
    lua_createtable(L, matches.size(), 0);
    lua_Integer i = 0;
    for (const std::string& m : matches) {
        lua_pushinteger(L, ++i);
        lua_pushstring(L, m.c_str());
        lua_settable(L, -3);
    }
    return 1;
}

static int fs_getDir(lua_State *L) {
    lastCFunction = __func__;
    if (ccAtLeast(get_comp(L), 1, 117, 0)) {
        // FileSystem.getDirectory: a trailing ".." gets another one ("../.." for "..")
        const std::string p = ccSanitizePath(checkstring(L, 1), true);
        if (p.empty()) { lua_pushliteral(L, ".."); return 1; }
        const size_t slash = p.find_last_of('/');
        if (p.substr(slash == std::string::npos ? 0 : slash + 1) == "..") pushstring(L, p + "/..");
        else pushstring(L, slash == std::string::npos ? std::string() : p.substr(0, slash));
        return 1;
    }
    path_t path = path_t(normalizePath(checkstring(L, 1), true));
    if (path.empty() || path.string() == "/") {
        lua_pushliteral(L, "..");
        return 1;
    }
    if (!path.has_filename()) path = path.parent_path();
    pushstring(L, path.parent_path().string());
    return 1;
}

#if defined(__APPLE__) // macOS has ns-precise times in st_[x]timespec.tv_nsec
#define st_time_ms(st) ((st##timespec.tv_nsec / 1000000) + (st##timespec.tv_sec * 1000))
#elif defined(__linux__) // Linux has ns-precise times in st_[x]tim.tv_nsec
#define st_time_ms(st) ((st##tim.tv_nsec / 1000000) + (st##time * 1000))
#else // Other systems have only the standard s-precise times
#define st_time_ms(st) (st##time * 1000)
#endif

static int fs_attributes(lua_State *L) {
    lastCFunction = __func__;
    std::string str = checkstring(L, 1);
    const path_t path = fixpath(get_comp(L), str, true);
    if (path.empty()) err(L, 1, "No such file");
    if (std::regex_search((*path.begin()).native(), pathregex("^\\d+:"))) {
        try {
            const FileEntry &d = get_comp(L)->virtualMounts[(unsigned)std::stoul((*path.begin()).native())]->path(path.lexically_relative(*path.begin()));
            lua_createtable(L, 0, 6);
            lua_pushinteger(L, 0);
            lua_setfield(L, -2, "modification");
            lua_pushinteger(L, 0);
            lua_setfield(L, -2, "modified");
            lua_pushinteger(L, 0);
            lua_setfield(L, -2, "created");
            lua_pushinteger(L, d.isDir ? 0 : d.data.length());
            lua_setfield(L, -2, "size");
            lua_pushboolean(L, d.isDir);
            lua_setfield(L, -2, "isDir");
            lua_pushboolean(L, true);
            lua_setfield(L, -2, "isReadOnly");
        } catch (...) {
            lua_pushnil(L);
            return 1;
        }
    } else {
#ifdef _WIN32
        struct _stat st;
        if (_wstat(path.c_str(), &st) != 0) {
            lua_pushnil(L);
            return 1;
        }
#else
        struct stat st;
        if (stat(path.c_str(), &st) != 0) {
            lua_pushnil(L);
            return 1;
        }
#endif
        lua_createtable(L, 0, 6);
        lua_pushinteger(L, st_time_ms(st.st_m));
        lua_setfield(L, -2, "modification");
        lua_pushinteger(L, st_time_ms(st.st_m));
        lua_setfield(L, -2, "modified");
        lua_pushinteger(L, st_time_ms(st.st_c));
        lua_setfield(L, -2, "created");
        lua_pushinteger(L, S_ISDIR(st.st_mode) ? 0 : st.st_size);
        lua_setfield(L, -2, "size");
        lua_pushboolean(L, S_ISDIR(st.st_mode));
        lua_setfield(L, -2, "isDir");
        if (fixpath_ro(get_comp(L), str)) lua_pushboolean(L, true);
        else {
            std::error_code e;
            if (!fs::exists(path, e)) lua_pushboolean(L, false);
#ifdef WIN32
            else if (e.clear(), fs::is_directory(path, e))
                lua_pushboolean(L, winFolderIsReadOnly(path));
#endif
            else lua_pushboolean(L, access(path.c_str(), W_OK) != 0);
        }
        lua_setfield(L, -2, "isReadOnly");
    }
    return 1;
}

static int fs_getCapacity(lua_State *L) {
    lastCFunction = __func__;
    std::string mountPath;
    std::string str = checkstring(L, 1);
    const path_t path = fixpath(get_comp(L), str, false, true, &mountPath);
    if (mountPath == "rom") {
        lua_pushnil(L);
        return 1;
    } else if (mountPath == "hdd") {
        lua_pushinteger(L, config.computerSpaceLimit);
        return 1;
    }
    if (path.empty()) luaL_error(L, "%s: Invalid path", str.c_str());
    if (floppyUsed(get_comp(L), mountPath) >= 0) lua_pushinteger(L, FLOPPY_SPACE_LIMIT);
    else lua_pushinteger(L, getSpace(path).capacity);
    return 1;
}

static luaL_Reg fs_reg[] = {
    {"list", fs_list},
    {"exists", fs_exists},
    {"isDir", fs_isDir},
    {"isReadOnly", fs_isReadOnly},
    {"getName", fs_getName},
    {"getDrive", fs_getDrive},
    {"getSize", fs_getSize},
    {"getFreeSpace", fs_getFreeSpace},
    {"makeDir", fs_makeDir},
    {"move", fs_move},
    {"__ccsimTryLock", fs_ccsimTryLock},
    {"copy", fs_copy},
    {"delete", fs_delete},
    {"combine", fs_combine},
    {"open", fs_open},
    {"find", fs_find},
    {"getDir", fs_getDir},
    {"attributes", fs_attributes},
    {"getCapacity", fs_getCapacity},
    {NULL, NULL}
};

library_t fs_lib = {"fs", fs_reg, nullptr, nullptr};
