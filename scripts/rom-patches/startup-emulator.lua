-- Spliced into the ROM's startup.lua by scripts/build-rom.mjs, just before "-- Run the user created startup".
-- CraftOS-PC has features CC:Tweaked does not (periphemu, config, mounter, term graphics, collectgarbage, ...).
-- A script that used one would pass here and fail on the server, so the harness's boot script gets them through
-- `emulator` and everything else sees the plain CC:Tweaked surface. hide() runs once the boot script is done
-- setting things up (the runner calls it before launching the program under test).
local emulatorHidden = false
local emulatorTools = { periphemu = periphemu, config = config, mounter = mounter, ccpc = ccpc }
local function hideEmulator()
    if emulatorHidden then return end
    emulatorHidden = true
    for _, name in ipairs({ "periphemu", "config", "mounter", "ccpc", "collectgarbage", "__inext", "_CC_DISABLE_LUA51_FEATURES",
        "_CCPC_FIRST_RUN", "_CCPC_STARTUP_SCRIPT", "_CCPC_STARTUP_ARGS", "_CCPC_PLUGIN_ERRORS", "" }) do
        _G[name] = nil
    end
    table.move, table.setn, coroutine.isyieldable, os.about = nil, nil, nil, nil
    peripheral.__ccsimNamed = nil
    for _, name in ipairs({ "getuservalue", "setuservalue", "setbreakpoint", "unsetbreakpoint" }) do debug[name] = nil end
    -- Measured on the server, in a zone 5 hours from UTC: os.epoch("local") is the same number as "utc"
    local rawEpoch = os.epoch
    function os.epoch(kind)
        if type(kind) == "string" and kind:lower() == "local" then kind = "utc" end
        return rawEpoch(kind)
    end
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
    local rawWrap, rawGetMethods, rawCall, rawFind = peripheral.wrap, peripheral.getMethods, peripheral.call, peripheral.find
    local function isMonitor(name)
        local ty = peripheral.getType(name)
        return ty == "monitor" or ty == "drive"
    end
    function peripheral.getMethods(name)
        local methods = rawGetMethods(name)
        if methods and isMonitor(name) then
            local kept = {}
            for _, m in ipairs(methods) do if not monitorExtras[m] then kept[#kept + 1] = m end end
            return kept
        end
        return methods
    end
    function peripheral.call(name, method, ...)
        if monitorExtras[method] and isMonitor(name) then error("No such method " .. tostring(method), 0) end
        return rawCall(name, method, ...)
    end
    function peripheral.wrap(name)
        local p = rawWrap(name)
        if p and isMonitor(name) then for m in pairs(monitorExtras) do p[m] = nil end end
        return p
    end
    function peripheral.find(kind, filter)
        local found = {}
        for _, name in ipairs(peripheral.getNames()) do
            if peripheral.hasType(name, kind) then
                local wrapped = peripheral.wrap(name)
                if not filter or filter(name, wrapped) then found[#found + 1] = wrapped end
            end
        end
        return table.unpack(found)
    end
end
local bootEnv = setmetatable({ emulator = { hide = hideEmulator }, periphemu = emulatorTools.periphemu, config = emulatorTools.config,
    mounter = emulatorTools.mounter }, { __index = _ENV, __newindex = _ENV })

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
