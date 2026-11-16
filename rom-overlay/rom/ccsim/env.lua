-- The simulation's own view of the files. CC:Tweaked's ROM has no rom/ccsim, so programs do not see this folder
-- (hideEmulator in scripts/rom-patches/startup-emulator.lua hides it). The simulation still loads modules while the
-- computer runs (an addon on first use, a scanner's block data, ...), so it keeps the fs taken here, when it starts
-- before any program, and every module it loads runs with it: `fs`, `loadfile` and `dofile` below, everything else
-- from _G, and globals it sets go to _G as before.
local computerFs = fs
local rawFs = {}
for k, v in pairs(computerFs) do rawFs[k] = v end
-- What the simulation sets on fs is the computer's too (lockdown.lua wraps fs.open for every program).
local simFs = setmetatable({}, {
  __index = rawFs,
  __newindex = function(_, k, v)
    rawFs[k] = v
    computerFs[k] = v
  end,
})

local env
-- bios.lua's loadfile and dofile, on the simulation's fs; a chunk gets the simulation's globals unless given others
local function simLoadfile(filename, mode, fenv)
  if type(mode) == "table" and fenv == nil then mode, fenv = nil, mode end
  local file = rawFs.open(filename, "r")
  if not file then return nil, "File not found" end
  local func, err = load(file.readAll(), "@/" .. rawFs.combine(filename), mode, fenv or env)
  file.close()
  return func, err
end

local function simDofile(filename)
  local fn, e = simLoadfile(filename, nil, env)
  if fn then return fn() end
  error(e, 2)
end

env = setmetatable({ fs = simFs, loadfile = simLoadfile, dofile = simDofile }, { __index = _G, __newindex = _G })
return env
