-- ccsim addon: CC: Drones+ 0.2.0 (minecraftbossdj/CCDrones, commit c85ef36), a fork of CC: Drones. It is the
-- original's code (../cc-drones/drone.lua) with the fork's changes switched on.
return function(core, host)
  return dofile("/rom/ccsim/addons/cc-drones/drone.lua")(core, host, "plus")
end
