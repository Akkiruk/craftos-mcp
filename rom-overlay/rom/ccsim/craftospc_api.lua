-- CraftOS-PC's periphemu, config and mounter APIs, for programs written for CraftOS-PC. Off unless the world turns
-- them on (world.craftosPcApis): CC:Tweaked has none of them, so by default programs see none, as on a server.
-- When on, each call does what the real game would: periphemu.create places the block in the simulated world, live;
-- config and mounter answer, but nothing can change the computer's settings or mount a folder of the PC.
-- Loaded by rom/ccsim/init.lua; the globals go in after the emulator hides its own (scripts/rom-patches/startup-emulator.lua).
return function(core, dofile)
  local cpc = dofile("/rom/ccsim/craftospc_common.lua")
  local expect = dofile("/rom/modules/main/cc/expect.lua").expect

  local function run(handler, cmd)
    local fn = core.extraHandlers and core.extraHandlers[handler]
    if not fn then return false, "the simulated world cannot do that here" end
    local ok, a, b = pcall(fn, cmd)
    if not ok then return false, tostring(a) end
    if a then core.save() end
    return a and true or false, b
  end

  local periphemu = {}
  --- periphemu.create(side, type, ...): true when the block is there; false when the side is taken, or for a
  --- CraftOS-PC type that has no block here (computer, debugger), with why as a second value, so a startup
  --- that makes one goes on. A type nobody knows is an error, as in CraftOS-PC.
  function periphemu.create(side, kind, ...)
    expect(1, side, "string", "number")
    expect(2, kind, "string")
    if type(side) == "number" then side = kind .. "_" .. side end
    local def, why, disk = cpc.spec(side, kind, { ... })
    if not def then return false, why end
    local ok, err = run("attachPeripheral", { peripheral = def })
    if not ok then
      if peripheral.isPresent(side) then return false end
      error(err, 2)
    end
    if disk then run("insertDisk", { peripheral = def.name, disk = disk }) end
    return true
  end
  --- periphemu.remove(side): true when there was a peripheral to take away.
  function periphemu.remove(side)
    expect(1, side, "string")
    return (run("detachPeripheral", { name = side }))
  end
  function periphemu.names()
    local out = {}
    for i, t in ipairs(cpc.TYPES) do out[i] = t end
    return out
  end

  local config = {}
  function config.get(name)
    expect(1, name, "string")
    local s = cpc.settings[name]
    if not s then error(cpc.noCounterpart(name), 2) end
    return s.get()
  end
  function config.set(name)
    expect(1, name, "string")
    error(cpc.whereSet(name), 2)
  end
  function config.list() return cpc.settingNames() end
  function config.getType(name)
    expect(1, name, "string")
    local s = cpc.settings[name]
    return s and s.type or nil
  end

  local mounter = {}
  function mounter.mount() error(cpc.MOUNT[1], 2) end
  function mounter.unmount() error(cpc.MOUNT[1], 2) end
  function mounter.list()
    local out = {}
    for _, m in ipairs(cpc.mounts()) do out[m.path] = { m.drive } end
    return out
  end
  function mounter.isReadOnly(path)
    expect(1, path, "string")
    return fs.isReadOnly(path)
  end

  return { periphemu = periphemu, config = config, mounter = mounter }
end
