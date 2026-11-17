-- ccsim: the simulated world around a computer (peripherals from other mods, modems, turtles).
-- Loaded from rom/startup.lua when /results/world.json exists (the runner always writes it).
-- Programs do not see rom/ccsim; every module loads through the simulation's own fs (rom/ccsim/env.lua).
local dofile = dofile("/rom/ccsim/env.lua").dofile
local core = dofile("/rom/ccsim/core.lua")
core.load()
core.restore()
core.installEventHook()
core.installRedstone()

dofile("/rom/ccsim/peripherals.lua")(core)

-- A turtle: the native API, then the ROM's turtle API on top of it, as bios.lua loads it on a real turtle.
-- A computer placed in a block world (`placed`) gets the same world and the blocks around it as peripherals.
core.periphemu = periphemu -- taken before emulator.hide(): blocks a turtle places can be drives and monitors
if type(core.world.turtle) == "table" or type(core.world.placed) == "table" then
  local brain = dofile("/rom/ccsim/turtle/brain.lua")(core)
  core.turtle = brain
  if type(core.world.turtle) == "table" then
    _G.turtle = brain.api
    os.loadAPI("/rom/apis/turtle/turtle.lua")
  end
end

core.save()
