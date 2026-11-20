-- ccsim addons/mekanism-generators: Mekanism Generators 10.2.5's Fission Reactor (logic adapter, port), Industrial
-- Turbine valve and Fusion Reactor (logic adapter, port).
--
-- The simulation is ../mekanism-machines/engine.lua, shared with the boiler and the induction matrix; the kinds are
-- fission.lua, turbine.lua and fusion.lua here. Their headers name the Mekanism Generators source files followed.
-- docs/mekanism-multiblocks.md has the fixture, the sim commands and every behaviour with its source; on 1.20.1
-- (10.4.16) and 1.21.1 (10.7.19) the version's release is followed instead (docs/mekanism-versions.md).
--
-- The mekanism-machines module (always on with this one) holds the clock, the sim commands and the sim state of
-- every multiblock, under addons["mekanism-machines"].
return function(core, host)
  if core.loadAddon then core.loadAddon("mekanism-machines") end
  core.mekMultiblocks = core.mekMultiblocks or dofile("/rom/ccsim/addons/mekanism-machines/engine.lua")(core, host)
  return { peripheral = core.mekMultiblocks.peripheral, exactReturns = true }
end
