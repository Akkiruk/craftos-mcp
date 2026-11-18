-- ccsim: the simulated world around a computer (peripherals from other mods, modems, turtles).
-- Loaded from rom/startup.lua when /results/world.json exists (the runner always writes it).
-- Programs do not see rom/ccsim; every module loads through the simulation's own fs (rom/ccsim/env.lua).
local dofile = dofile("/rom/ccsim/env.lua").dofile
local core = dofile("/rom/ccsim/core.lua")
core.load()
-- ServerContext.getHostString: "ComputerCraft %s (Minecraft %s)". The engine's own names CraftOS-PC, and programs that
-- look for that name go on to use CraftOS-PC's `config` and `periphemu`, which a server does not have.
_G._HOST = ("ComputerCraft %s (Minecraft %s)"):format(core.version.cc, core.version.mc)
core.restore()
core.installEventHook()
core.installRedstone()
core.mounter = mounter -- taken before emulator.hide(): a mod's drive block mounts a folder (addons/crickets-peripherals)

dofile("/rom/ccsim/peripherals.lua")(core)

-- A pocket computer has the pocket API (PocketAPI.java): programs tell one by `if pocket then`, the shell adds
-- /rom/programs/pocket to its path, and bios.lua turns the message of the day off (`default = pocket == nil`, which
-- it read before this ran). Both methods run on the server thread. The upgrade is the peripheral named "back";
-- nobody's inventory is modelled, so there is never another upgrade to swap in.
if core.kind == "pocket" then
  local function onServer(task)
    local results = core.waitForServerTick(task, true)
    if not results[1] then error(results[2], 0) end
    return table.unpack(results, 2, results.n)
  end
  _G.pocket = {
    equipBack = function()
      return onServer(function() return false, "Cannot find a valid upgrade" end)
    end,
    unequipBack = function()
      return onServer(function()
        if not peripheral.isPresent("back") then return false, "Nothing to unequip" end
        core.extraHandlers.detachPeripheral({ name = "back" })
        return true
      end)
    end,
  }
  settings.define("motd.enable", {
    default = false,
    description = "Display a random message when the computer starts up.",
    type = "boolean",
  })
end

-- A turtle: the native API, then the ROM's turtle API on top of it, as bios.lua loads it on a real turtle.
-- A computer placed in a block world (`placed`) gets the same world and the blocks around it as peripherals.
core.periphemu = periphemu -- taken before emulator.hide(): blocks a turtle places can be drives and monitors
-- A mob with a computer in it (an android, a drone: core.mob, set by its addon through ccsim/mob.lua) stands in the
-- same world without being a block of it; its addon puts its API on top once the world is there.
if type(core.world.turtle) == "table" or type(core.world.placed) == "table" then core.mob = nil end
if type(core.world.turtle) == "table" or type(core.world.placed) == "table" or core.mob then
  local brain = dofile("/rom/ccsim/turtle/brain.lua")(core)
  core.turtle = brain
  if type(core.world.turtle) == "table" then
    _G.turtle = brain.api
    os.loadAPI("/rom/apis/turtle/turtle.lua")
  end
  if core.mob then core.mob.install(brain) end
end

-- CraftOS-PC's periphemu, config and mounter, only when the world asks for them (world.craftosPcApis): the emulator
-- hides its own, then puts these in (hideEmulator in scripts/rom-patches/startup-emulator.lua)
if core.world.craftosPcApis == true then
  _G.__ccsimCraftosPc = dofile("/rom/ccsim/craftospc_api.lua")(core, dofile)
end

core.save()
