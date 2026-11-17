-- ccsim addon: CC: Drones 0.0.1 (JSJBDEV/CCDrones, commit 5c8f4ed). All of it is in drone.lua, which CC: Drones+
-- shares.
return function(core, host)
  return dofile("/rom/ccsim/addons/cc-drones/drone.lua")(core, host, "original")
end
