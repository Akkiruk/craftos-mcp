-- ccsim addons/mekanism-machines: Mekanism 10.2.5's Thermoelectric Boiler valve and Induction Matrix port, and the
-- clock, sim commands and sim state of every Mekanism multiblock (the generators module's too).
--
-- The simulation is engine.lua (shared with ../mekanism-generators: a reactor feeds a turbine, a turbine charges a
-- matrix); the boiler is boiler.lua, the matrix matrix.lua. Their headers name the Mekanism source files followed.
-- docs/mekanism-multiblocks.md has the fixture, the sim commands and every behaviour with its source.
return function(core, host)
  core.mekMultiblocks = core.mekMultiblocks or dofile("/rom/ccsim/addons/mekanism-machines/engine.lua")(core, host)
  local E = core.mekMultiblocks
  return {
    peripheral = E.peripheral,
    handlers = E.handlers,
    catchUp = function() E.catchUp() end,
    state = function() return E.state() end,
  }
end
