-- ccsim: ROM files that come with a mod. A mod jar can put Lua into CC's ROM (data/computercraft/lua/rom/...): APIs,
-- modules, programs, autorun files, help. An addon module that ships such files keeps them in its own folder,
-- rom/ccsim/addons/<module>/rom/, and names that folder in types.lua (`rom = true`, or `rom = "<folder>"`). When the
-- addon is on they show at /rom/... as if they were part of the ROM: fs.list, fs.find, fs.exists, fs.open, require,
-- shell programs, completion. When it is off they do not exist at all.
--
-- Mounted from ccsim's start, at the top of rom/startup.lua, so the shell's autorun loop sees them. bios.lua loaded
-- the ROM's APIs before that, so mounted rom/apis files are loaded here with os.loadAPI, by bios's own rules.
-- A file the real ROM has as well is shadowed by the mod's, as a datapack's file wins over CC's in game.
local M = {}
-- The computer's fs (this file runs in the simulation's env, rom/ccsim/env.lua, where `fs` is the simulation's own)
local cfs = _G.fs

local mounted = {} -- "rom/apis/x.lua" -> sim path, the canonical (fs.combine) ROM path of every mounted file
local dirs = {} -- "rom/modules/main/x" -> true, every directory the mounted files sit in (and "rom")
local children = {} -- dir -> { name = true }
local installed = false

local function addChild(dir, name)
  local set = children[dir]
  if not set then set = {}; children[dir] = set end
  set[name] = true
end

local function walk(rawFs, simDir, romDir)
  for _, name in ipairs(rawFs.list(simDir)) do
    local simPath, romPath = simDir .. "/" .. name, romDir .. "/" .. name
    addChild(romDir, name)
    if rawFs.isDir(simPath) then
      dirs[romPath] = true
      walk(rawFs, simPath, romPath)
    else
      mounted[romPath] = simPath
    end
  end
end

local function canonical(path)
  if type(path) ~= "string" then return nil end
  local ok, p = pcall(fs.combine, "", path)
  return ok and p or nil
end

--- A glob of fs.find: * and ? stay inside one path part.
local function globPattern(glob)
  local out = { "^" }
  for ch in glob:gmatch(".") do
    if ch == "*" then out[#out + 1] = "[^/]*"
    elseif ch == "?" then out[#out + 1] = "[^/]"
    elseif ch:match("%W") then out[#out + 1] = "%" .. ch
    else out[#out + 1] = ch end
  end
  out[#out + 1] = "$"
  return table.concat(out)
end

--- Call fn; an error it raises comes back out unchanged (level 0), with no position of this file in it.
local function call(fn, ...)
  local r = table.pack(pcall(fn, ...))
  if not r[1] then error(r[2], 0) end
  return table.unpack(r, 2, r.n)
end

local function install(rawFs)
  -- The engine's fs functions, called so their errors read as if the program had called them: without a position
  -- of this file (CC:Tweaked's own suite checks the exact messages).
  local raw = {}
  for _, name in ipairs({ "exists", "isDir", "list", "find", "open", "getSize", "attributes", "copy", "isReadOnly", "getDrive" }) do
    local fn = cfs[name]
    raw[name] = function(...) return call(fn, ...) end
  end
  local function file(path)
    local p = canonical(path)
    return p and mounted[p]
  end
  local function dir(path)
    local p = canonical(path)
    return p and dirs[p] and p or nil
  end
  local w = {}
  function w.exists(path)
    if file(path) or dir(path) then return true end
    return raw.exists(path)
  end
  function w.isDir(path)
    if file(path) then return false end
    if dir(path) then return true end
    return raw.isDir(path)
  end
  function w.list(path)
    local d = dir(path)
    if not d then return raw.list(path) end
    local seen, out = {}, {}
    if raw.isDir(path) then
      for _, name in ipairs(raw.list(path)) do seen[name] = true; out[#out + 1] = name end
    end
    for name in pairs(children[d] or {}) do
      if not seen[name] then seen[name] = true; out[#out + 1] = name end
    end
    table.sort(out)
    return out
  end
  function w.find(pattern)
    local found = raw.find(pattern)
    local p = canonical(pattern)
    if type(found) ~= "table" or not p then return found end
    local seen = {}
    for _, f in ipairs(found) do seen[f] = true end
    local lp = globPattern(p)
    for romPath in pairs(mounted) do if not seen[romPath] and romPath:match(lp) then seen[romPath] = true; found[#found + 1] = romPath end end
    for romPath in pairs(dirs) do if not seen[romPath] and romPath:match(lp) then seen[romPath] = true; found[#found + 1] = romPath end end
    table.sort(found)
    return found
  end
  function w.open(path, mode)
    local f = file(path)
    if f and type(mode) == "string" and not mode:find("[wa]") then return rawFs.open(f, mode) end
    return raw.open(path, mode)
  end
  function w.getSize(path)
    local f = file(path)
    if f then return rawFs.getSize(f) end
    if dir(path) and not raw.exists(path) then return 0 end
    return raw.getSize(path)
  end
  function w.attributes(path)
    local f = file(path)
    if f then
      local a = rawFs.attributes(f)
      a.isReadOnly = true
      return a
    end
    if dir(path) and not raw.exists(path) then return raw.attributes("rom") end
    return raw.attributes(path)
  end
  function w.isReadOnly(path)
    if file(path) or dir(path) then return true end
    return raw.isReadOnly(path)
  end
  function w.getDrive(path)
    if file(path) or dir(path) then return "rom" end
    return raw.getDrive(path)
  end
  function w.copy(from, to)
    local f = file(from)
    if not f then return raw.copy(from, to) end
    local src = rawFs.open(f, "rb")
    local data = src.readAll()
    src.close()
    local dest = raw.open(to, "wb")
    if not dest then return raw.copy(from, to) end -- the engine's own error for a bad destination
    dest.write(data)
    dest.close()
  end
  -- each wrapper raises at its caller's level, as the engine's own function would
  for name, fn in pairs(w) do
    local wrapped = function(...)
      local r = table.pack(pcall(fn, ...))
      if r[1] then return table.unpack(r, 2, r.n) end
      error(r[2], 2)
    end
    w[name] = wrapped
    cfs[name] = wrapped
  end
  -- fs.complete and fs.isDriveRoot (rom/apis/fs.lua) call the fs table that API was built in, not _G.fs
  for _, api in ipairs({ cfs.complete, cfs.isDriveRoot }) do
    for i = 1, math.huge do
      local name, value = debug.getupvalue(api, i)
      if name == nil then break end
      if name == "fs" and type(value) == "table" and value ~= cfs then
        for n, fn in pairs(w) do value[n] = fn end
      end
    end
  end
end

--- Mount module `module`'s ROM folder (relative to its addon folder) at /rom. rawFs: the simulation's own fs.
function M.mount(rawFs, module, folder)
  local simDir = "rom/ccsim/addons/" .. module .. "/" .. folder
  if not rawFs.isDir(simDir) then return end
  dirs["rom"] = true
  local before = {}
  for p in pairs(mounted) do before[p] = true end
  walk(rawFs, simDir, "rom")
  if not installed then install(rawFs); installed = true end
  -- bios.lua's load_apis for what this module added: rom/apis, then http, turtle and pocket when the computer has them
  local function loadApis(d)
    for _, name in ipairs(cfs.list(d)) do
      local p = d .. "/" .. name
      if mounted[p] and not before[p] and name:sub(1, 1) ~= "." then os.loadAPI(p) end
    end
  end
  if dirs["rom/apis"] then loadApis("rom/apis") end
  if http and dirs["rom/apis/http"] then loadApis("rom/apis/http") end
  if pocket and dirs["rom/apis/pocket"] then loadApis("rom/apis/pocket") end
end

--- The ROM path of a mounted file's sim copy, or nil (tests and addons that check what they mounted).
function M.source(path)
  local p = canonical(path)
  return p and mounted[p]
end

return M
