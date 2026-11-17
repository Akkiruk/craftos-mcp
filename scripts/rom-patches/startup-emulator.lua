-- Spliced into the ROM's startup.lua by scripts/build-rom.mjs, just before "-- Run the user created startup".
-- CraftOS-PC has features CC:Tweaked does not (periphemu, config, mounter, term graphics, collectgarbage, ...).
-- A script that used one would pass here and fail on the server, so the harness's boot script gets them through
-- `emulator` and everything else sees the plain CC:Tweaked surface. hide() runs once the boot script is done
-- setting things up (the runner calls it before launching the program under test).
local emulatorHidden = false
local emulatorTools = { periphemu = periphemu, config = config, mounter = mounter, ccpc = ccpc }
local expectArg = dofile("rom/modules/main/cc/expect.lua").expect
-- Files under rom/ccsim a program may still reach: the `sim` program on a computer a person drives (sim_shell.lua)
local ccsimShown = {}

-- A Lua wrapper around an engine (Java in CC) function adds a stack frame, so the engine's error would name the
-- wrapper's line, and a tail call into the wrapper would lose its caller. native() makes the wrapper a C function
-- (os.__ccsimNative, engine/src/apis/os.cpp) that puts the caller's position in front of a plain error message, as
-- a Java function's error has; the wrapper raises plain messages, and engine errors through call() lose theirs.
local toNative = os.__ccsimNative
local function native(fn) return toNative and toNative(fn) or fn end
local getinfo = debug.getinfo
local function call(fn, ...)
    local r, here = table.pack(pcall(fn, ...)) if not r[1] then here = getinfo(1, "Sl") end -- one line: the pcall's
    if r[1] then return table.unpack(r, 2, r.n) end
    local err = r[2]
    -- positioned at its caller, the pcall here: "pcall: " on CC 1.101.3, this line (the nearest Lua caller) on 1.109+
    if type(err) == "string" and here then
        local at = here.short_src .. ":" .. here.currentline .. ": "
        if err:sub(1, 7) == "pcall: " then err = err:sub(8)
        elseif err:sub(1, #at) == at then err = err:sub(#at + 1) end
    end
    error(err, 0)
end

--- rom/ccsim is the emulator's world simulation. CC:Tweaked's ROM has no such folder, so programs do not see it: not
--- in fs.list, fs.find, completion or `ls`, and fs.exists, fs.open and the rest treat it as any missing path in the ROM.
--- The simulation reads its own files through the fs it took when it started (rom/ccsim/env.lua).
local function hideSimFolder()
    local combine = fs.combine
    local function canonical(path)
        if type(path) ~= "string" then return nil end
        local ok, p = pcall(combine, "", path)
        return ok and p or nil
    end
    local function hidden(path)
        local p = canonical(path)
        if not p or ccsimShown[p] then return false end
        return p == "rom/ccsim" or p:sub(1, 10) == "rom/ccsim/"
    end
    local function where(path) return "/" .. canonical(path) end
    local raw = {}
    for _, name in ipairs({ "exists", "isDir", "list", "find", "open", "getSize", "attributes", "getDrive", "copy" }) do
        raw[name] = fs[name]
    end
    -- every one raises plain messages; native() positions them at the caller
    local wrapped = {}
    function wrapped.exists(path)
        if hidden(path) then return false end
        return call(raw.exists, path)
    end
    function wrapped.isDir(path)
        if hidden(path) then return false end
        return call(raw.isDir, path)
    end
    -- The harness's two mounts, /ccunit (its Lua library) and /results (what a run reports back). A new computer's
    -- root holds only `rom`, and programs act on what they find there: a file manager shows it, an installer that
    -- wipes the disk deletes it, a backup copies it. So the two are not listed and wildcards do not find them; a
    -- path that names one still reaches it, which is how tests and the simulation use them.
    local mounts = { ccunit = true, results = true }
    function wrapped.list(path)
        if hidden(path) then error(where(path) .. ": Not a directory", 0) end
        local list = call(raw.list, path)
        local at = canonical(path)
        if at == "rom" and type(list) == "table" then
            for i = #list, 1, -1 do if list[i] == "ccsim" then table.remove(list, i) end end
        elseif at == "" and type(list) == "table" then
            for i = #list, 1, -1 do if mounts[list[i]] then table.remove(list, i) end end
        end
        return list
    end
    function wrapped.find(pattern)
        local found = call(raw.find, pattern)
        if type(found) == "table" then
            -- only a wildcard in the first part of the pattern can come across a mount by accident
            local first = type(pattern) == "string" and (canonical(pattern) or ""):match("^[^/]*") or ""
            local wild = first:find("[*?]") ~= nil
            for i = #found, 1, -1 do
                if hidden(found[i]) or (wild and mounts[found[i]:match("^[^/]*")]) then table.remove(found, i) end
            end
        end
        return found
    end
    function wrapped.open(path, mode)
        if hidden(path) and type(mode) == "string" and not mode:find("[wa]") then return nil, where(path) .. ": No such file" end
        return call(raw.open, path, mode)
    end
    function wrapped.getSize(path)
        if hidden(path) then error(where(path) .. ": No such file", 0) end
        return call(raw.getSize, path)
    end
    function wrapped.attributes(path)
        if hidden(path) then error(where(path) .. ": No such file", 0) end
        return call(raw.attributes, path)
    end
    function wrapped.getDrive(path)
        if hidden(path) then return nil end
        return call(raw.getDrive, path)
    end
    function wrapped.copy(from, to)
        if hidden(from) then error(where(from) .. ": No such file", 0) end
        return call(raw.copy, from, to)
    end
    for name, fn in pairs(wrapped) do wrapped[name] = native(fn) end
    for name, fn in pairs(wrapped) do fs[name] = fn end
    -- fs.complete and fs.isDriveRoot (rom/apis/fs.lua) call the fs table the API was built in, not _G.fs
    for _, api in ipairs({ fs.complete, fs.isDriveRoot }) do
        for i = 1, math.huge do
            local name, value = debug.getupvalue(api, i)
            if name == nil then break end
            if name == "fs" and type(value) == "table" then
                for n, fn in pairs(wrapped) do value[n] = fn end
            end
        end
    end
end
local function hideEmulator()
    if emulatorHidden then return end
    emulatorHidden = true
    for _, name in ipairs({ "periphemu", "config", "mounter", "ccpc", "collectgarbage", "__inext", "_CC_DISABLE_LUA51_FEATURES",
        "_CCPC_FIRST_RUN", "_CCPC_UPDATED_VERSION", "_CCPC_STARTUP_SCRIPT", "_CCPC_STARTUP_ARGS", "_CCPC_PLUGIN_ERRORS",
        "_HEADLESS", "" }) do
        _G[name] = nil
    end
    table.setn, os.about, os.__ccsimNative = nil, nil, nil
    -- CC:Tweaked 1.101.3's Cobalt 0.6 has neither; 1.109+ (Cobalt 0.8, Lua 5.2 and up) has both
    if _VERSION == "Lua 5.1" then table.move, coroutine.isyieldable = nil, nil end
    peripheral.__ccsimNamed = nil
    for _, name in ipairs({ "getuservalue", "setuservalue", "setbreakpoint", "unsetbreakpoint" }) do debug[name] = nil end
    -- Measured on the server, in a zone 5 hours from UTC: os.epoch("local") is the same number as "utc"
    local rawEpoch = os.epoch
    os.epoch = native(function(kind)
        if type(kind) == "string" and kind:lower() == "local" then kind = "utc" end
        return call(rawEpoch, kind)
    end)
    -- Lua 5.0 leftovers CC still has
    math.mod = math.mod or math.fmod
    string.gfind = string.gfind or string.gmatch

    local termExtras = { "drawPixels", "getFrozen", "getGraphicsMode", "getPixel", "getPixels", "relativeMouse", "screenshot",
        "setFrozen", "setGraphicsMode", "setPixel", "showMouse" }
    local function strip(t, names) if type(t) == "table" then for _, n in ipairs(names) do t[n] = nil end end end
    strip(term, termExtras)
    if term.native then strip(term.native(), termExtras) end

    local monitorExtras = { drawPixels = true, getPixel = true, getPixels = true, setGraphicsMode = true, getGraphicsMode = true,
        setFrozen = true, getFrozen = true, screenshot = true, setSize = true, setBlockSize = true, setPixel = true,
        -- a drive's insertDisk is the emulator's: in game a disk goes in by hand, a turtle or a hopper (ccsim/turtle)
        insertDisk = true }
    local rawWrap, rawGetMethods, rawCall = peripheral.wrap, peripheral.getMethods, peripheral.call
    local function isMonitor(name)
        local ty = peripheral.getType(name)
        return ty == "monitor" or ty == "drive"
    end
    -- CC's own argument checks (rom/apis/peripheral.lua) come first, so their errors name the caller, not this file
    function peripheral.getMethods(name)
        expectArg(1, name, "string")
        local methods = rawGetMethods(name)
        if methods and isMonitor(name) then
            local kept = {}
            for _, m in ipairs(methods) do if not monitorExtras[m] then kept[#kept + 1] = m end end
            return kept
        end
        return methods
    end
    function peripheral.call(name, method, ...)
        expectArg(1, name, "string")
        expectArg(2, method, "string")
        if monitorExtras[method] and isMonitor(name) then error("No such method " .. tostring(method), 0) end
        return rawCall(name, method, ...)
    end
    function peripheral.wrap(name)
        expectArg(1, name, "string")
        local p = rawWrap(name)
        if p and isMonitor(name) then for m in pairs(monitorExtras) do p[m] = nil end end
        return p
    end
    function peripheral.find(kind, filter)
        expectArg(1, kind, "string")
        expectArg(2, filter, "function", "nil")
        local found = {}
        for _, name in ipairs(peripheral.getNames()) do
            if peripheral.hasType(name, kind) then
                local wrapped = peripheral.wrap(name)
                if not filter or filter(name, wrapped) then found[#found + 1] = wrapped end
            end
        end
        return table.unpack(found)
    end
    hideSimFolder()
end
local bootEnv = setmetatable({ emulator = { hide = hideEmulator }, periphemu = emulatorTools.periphemu, config = emulatorTools.config,
    mounter = emulatorTools.mounter }, { __index = _ENV, __newindex = _ENV })

-- The emulator's `sim` shell program, only for a computer a person drives (world.simProgram; rom/ccsim/sim_shell.lua)
if shell and fs.exists("/rom/ccsim/sim_shell.lua") then
    local fn = loadfile("/rom/ccsim/sim_shell.lua", nil, _ENV)
    if fn then pcall(fn, function(path) ccsimShown[fs.combine("", path)] = true end) end
end

-- Run startup passed with --script if available
if _CCPC_STARTUP_SCRIPT then
    local fn, err = load(_CCPC_STARTUP_SCRIPT, "@startup.lua", "t", bootEnv)
    if fn then
        local args = {}
        if _CCPC_STARTUP_ARGS then for n in _CCPC_STARTUP_ARGS:gmatch("[^ ]+") do table.insert(args, n) end end
        local oldpath
        if shell then
            local dir = shell.dir()
            if dir:sub(1, 1) ~= "/" then dir = "/" .. dir end
            if dir:sub(-1) ~= "/" then dir = dir .. "/" end

            local strip_path = "?;?.lua;?/init.lua;"
            local path = package.path
            if path:sub(1, #strip_path) == strip_path then
                path = path:sub(#strip_path + 1)
            end

            oldpath = package.path
            package.path = dir .. "?;" .. dir .. "?.lua;" .. dir .. "?/init.lua;" .. path
        end
        fn(table.unpack(args))
        if oldpath then package.path = oldpath end
    else printError("Could not load startup script: " .. err) end
end
hideEmulator()
