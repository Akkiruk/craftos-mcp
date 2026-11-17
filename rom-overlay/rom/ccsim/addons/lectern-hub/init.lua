-- ccsim addon lectern-hub: CC: Lectern Hub 1.0.0-1.115.0 (Forge, Minecraft 1.20.1), by minecraftbossdj.
--
-- Written from the mod's source, github.com/minecraftbossdj/CC-Lectern-Hub at commit 566ba01 (the only release):
--   src/main/java/com/awesoft/lectern_hub/block/lectern/LecternPeripheral.java   (the peripheral, type "cc_lectern")
--   src/main/java/com/awesoft/lectern_hub/block/lectern/LecternPeripheralProvider.java (any CC lectern gets one)
--   src/main/java/com/awesoft/lectern_hub/mixin/CustomLecternBlockMixin.java     (a pocket's bottom side, see the doc)
-- and CC:Tweaked 1.121.0 for what the pocket computer does (Computer.turnOn/shutdown/reboot, ComputerExecutor).
--
-- The peripheral sits on CC:Tweaked's own lectern (CustomLecternBlockEntity), which exists only while the lectern holds
-- a CC item: a pocket computer or a printout. A vanilla lectern (empty, or with a book) is not a peripheral at all, so
-- taking the item off is detachPeripheral. Every method is a plain @LuaFunction: it runs at once on the computer thread.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua") -- CC's argument checks, Java exceptions
  local order = dofile("/rom/ccsim/addons/javamap.lua").order -- getMethods order on CC 1.121
  local M = {}
  local lecterns = {}

  local function now() return os.epoch("utc") end
  --- Computer.tick runs on the server tick: a requested start begins at the next one
  local function nextTick(t) return (math.floor(t / 50) + 1) * 50 end

  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end

  --- What sits on the lectern: { pocket = { id, label, on } } or { item = "<id>" } for a printout
  local function readItem(def)
    local s = saved(def.name)
    if s and type(s.pocket) == "table" then
      return { pocket = { id = s.pocket.id, label = s.pocket.label, on = s.pocket.on == true } }
    end
    if s and s.item then return { item = s.item } end
    if type(def.pocket) == "table" then
      local p = def.pocket
      return { pocket = { id = math.floor(tonumber(p.id) or 1), label = type(p.label) == "string" and p.label or nil,
        on = p.on == true } }
    end
    return { item = type(def.item) == "string" and def.item or "computercraft:printed_page" }
  end

  local function settle(o)
    local p = o.pocket
    if p and p.startAt and now() >= p.startAt then
      p.startAt = nil
      p.on = true
    end
  end

  local DECL = { "turnOn", "shutdown", "reboot", "getID", "isOn", "getLabel", "isPocket" }

  function M.peripheral(def)
    local o = readItem(def)
    lecterns[def.name] = o
    local m = {}
    -- isValid(): blkEntity.getItem().getItem() instanceof PocketComputerItem. The pocket's ServerComputer always
    -- exists while it sits on a lectern (the lectern ticks it: PocketComputerItem.tick makes its brain), so the
    -- null checks of getID/getLabel never trip here.
    function m.turnOn()
      settle(o)
      local p = o.pocket
      if not p then return end
      if not p.on and not p.startAt then p.startAt = nextTick(now()) end -- Computer.turnOn: startRequested
    end
    function m.shutdown()
      settle(o)
      local p = o.pocket
      if not p then return end
      p.on, p.startAt = false, nil -- queueStop(false): nothing when already off
    end
    function m.reboot()
      settle(o)
      -- queueStop(true): nothing when off; when on it shuts down and turns on again, and is on once more
    end
    function m.getID()
      settle(o)
      if not o.pocket then return -1 end
      return o.pocket.id
    end
    function m.isOn()
      settle(o)
      return o.pocket ~= nil and o.pocket.on
    end
    function m.getLabel()
      settle(o)
      if not o.pocket then return nil end
      return o.pocket.label
    end
    function m.isPocket() return o.pocket ~= nil end

    local computer = {}
    for _, name in ipairs(DECL) do computer[name] = true end
    return {
      methods = m,
      methodOrder = order(DECL),
      computerThread = computer,
      exactReturns = true,
      state = function()
        settle(o)
        if o.pocket then
          return { pocket = { id = o.pocket.id, label = o.pocket.label, on = o.pocket.on }, starting = o.pocket.startAt ~= nil }
        end
        return { item = o.item }
      end,
      detach = function() lecterns[def.name] = nil end,
    }
  end

  local handlers = {}
  --- lhSetPocket {peripheral, on?, label?, id?}: the pocket on the lectern changes (a player turns it on, relabels it)
  function handlers.lhSetPocket(cmd)
    local o = lecterns[tostring(cmd.peripheral)]
    if not o then return false, "no cc_lectern named " .. tostring(cmd.peripheral) end
    if not o.pocket then return false, tostring(cmd.peripheral) .. " holds a printout, not a pocket computer" end
    settle(o)
    if cmd.on ~= nil then o.pocket.on, o.pocket.startAt = cmd.on == true, nil end
    if cmd.label ~= nil then o.pocket.label = cmd.label ~= false and tostring(cmd.label) or nil end
    if cmd.id ~= nil then o.pocket.id = math.floor(tonumber(cmd.id) or o.pocket.id) end
    return true
  end
  M.handlers = handlers
  return M
end
