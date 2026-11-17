-- ccsim unlimited-peripheral-works: UnlimitedPeripheralWorks 1.9.2 (Minecraft 1.20.1 and 1.21.1).
--
-- Written from SirEdvin/UnlimitedPeripheralWorks at the tags v1.20.1-1.9.2 and v1.21.1-1.9.2, and the libraries that
-- release bundles (SirEdvin/Minecraft-Modding-Libs, branch 1.20 at "release Tweakium 1.4.10": Tweakium 1.4.10,
-- Peripheralium 1.4.5, Broccolium 1.4.5, the same versions as the jars inside peripheralworks-forge-1.20.1-1.9.2.jar).
-- Source files, relative to projects/core/src/main/kotlin/site/siredvin/peripheralworks/:
--   computercraft/peripherals/{UniversalScanner,UltimateSensor,ItemPedestal,DisplayPedestal,Pluggable}Peripheral.kt;
--   computercraft/plugins/PedestalInventoryPlugin.kt; computercraft/plugins/specific/{NoteBlock,Jukebox,Beacon,
--   Lectern}Plugin.kt, SpecificPluginProviders.kt; computercraft/operations/{Sphere,UnconditionalFree}Operations.kt;
--   utils/SensorCollection.kt; common/configuration/PeripheralWorksConfig.kt (defaults); mixins/LecternMixin.java.
-- Tweakium: modules/peripheral/{OwnedPeripheral,boon/OperationBoon,boon/ScanningBoon,representation/LuaRepresentation,
--   util/ValidationHelpers}.kt; modules/plugins/{AbstractRudimentInventoryPlugin,AbstractInventoryPlugin,
--   PeripheralPluginUtils}.kt. Broccolium: util/world/ScanUtils.kt, ext/BlockPosExt.kt, util/TextBookUtils.kt.
-- The 1.21.1 source of every peripheral here does the same as 1.20.1's (the differences are data components).
-- docs/unlimited-peripheral-works.md lists what is emulated, the fixture, the sim commands and what is not.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local floor = math.floor
  local upw = core.world.upw or {}
  local conf = upw.config or {}
  local gameData = core.gameData or dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)
  local NB = dofile("/rom/ccsim/turtle/nbt.lua")()
  local Q = dofile("/rom/ccsim/addons/unlimited-peripheral-works/query.lua")(core, C, gameData)

  local U = { C = C, Q = Q, NB = NB, N = NB.N, gameData = gameData, host = host, core = core, upw = upw }
  function U.num(key, default) return tonumber(conf[key]) or default end
  function U.bool(key, default)
    if conf[key] == nil then return default end
    return conf[key] == true
  end
  function U.now() return os.epoch("utc") end

  U.COOLDOWN_THRESHOLD = U.num("cooldownTreshholdLevel", 100)
  U.TRANSFER_LIMIT = U.num("itemStorageTransferLimit", 1024)

  -- ===== the block world the scanner and the sensor look at =====
  -- A turtle or a placed computer already has one (ccsim/turtle/world.lua); otherwise it is built the same way from
  -- the world file's top-level blocks, fills, ground, items and entities (docs/turtle.md).
  local ownWorld
  function U.world()
    if core.turtle and core.turtle.world then return core.turtle.world end
    if not ownWorld then
      ownWorld = dofile("/rom/ccsim/turtle/world.lua")(core, gameData)
      ownWorld.load(core.world)
    end
    return ownWorld
  end

  --- CC's BlockDetails (BLOCK_IN_WORLD): name, state, tags (and the map colour on 1.121.0), as turtle.inspect gives
  local function stateValue(v)
    if v == "true" then return true elseif v == "false" then return false end
    local n = tonumber(v)
    if n and tostring(n) == v then return n end
    return v
  end
  function U.blockDetail(b)
    local state = {}
    for k, v in pairs(b.state or {}) do state[k] = stateValue(tostring(v)) end
    local tags = {}
    if b.name ~= "minecraft:air" then
      for _, tag in ipairs(gameData.blockTags(b.name)) do tags[tag] = true end
    end
    local d = { name = b.name, state = state, tags = tags }
    if core.cc121 and b.name ~= "minecraft:air" then
      local colour = gameData.mapColour(b.name, b.state)
      if colour then d.mapColor, d.mapColour = colour, colour end
    end
    return d
  end

  -- ===== items =====

  --- LuaRepresentation.forItemStack: BASE is CC's basic details (name, count, nbt), DETAILED its full details, FULL
  --- adds rawNBT (NBTUtil.toLua of the stack's tag) when the stack has one.
  function U.itemRepr(item, mode)
    if mode == "BASE" then
      local out = { name = item.name, count = item.count }
      if item.nbt then out.nbt = item.nbt end
      return out
    end
    local d = host.itemDetail(item)
    d.__raw = nil
    if mode == "FULL" and item.__raw then d.rawNBT = U.N.toLua(item.__raw) end
    return d
  end

  function U.copyItem(item, count)
    local out = {}
    for k, v in pairs(item) do out[k] = v end
    if count then out.count = count end
    return out
  end

  --- computer.getAvailablePeripheral(name) and the storage behind it (AgnosticItemStorageLookup.extractFromUnknown)
  function U.findStorage(name, missing, notStorage)
    local entry = host.find(name)
    if not entry then error(missing, 0) end
    local inv = entry.inventory
    if not inv or not inv.__state then error(notStorage, 0) end
    return inv
  end

  --- AgnosticStorage.take(predicate, limit): the first stack that matches, at most `limit` of it; nil when none
  function U.take(inv, predicate, limit)
    local items = inv.__state()
    for slot = 1, inv.size() do
      local item = items[slot]
      if item and item.count > 0 and predicate(item) then
        local n = math.min(limit, item.count)
        local out = U.copyItem(item, n)
        item.count = item.count - n
        if item.count <= 0 then items[slot] = nil end
        core.save()
        return out
      end
    end
    return nil
  end

  --- AgnosticSink.store(stack): what did not fit
  function U.store(inv, item)
    local moved = inv.__insert(item, item.count)
    core.save()
    return item.count - moved
  end

  -- ===== Java's HashMap order (String keys) =====

  function U.hashOrder(keys, cap)
    cap = cap or 16
    while #keys > cap * 0.75 do cap = cap * 2 end
    local rows = {}
    for i, k in ipairs(keys) do
      local h = 0
      for j = 1, #k do h = (h * 31 + k:byte(j)) % 4294967296 end
      h = bit32.bxor(h, bit32.rshift(h, 16))
      rows[i] = { k = k, i = i, b = bit32.band(h, cap - 1) }
    end
    table.sort(rows, function(a, b)
      if a.b ~= b.b then return a.b < b.b end
      return a.i < b.i
    end)
    local out = {}
    for i, r in ipairs(rows) do out[i] = r.k end
    return out
  end

  -- ===== operations (Tweakium OperationBoon) =====

  --- IConfigHandler.settingsName: STATIONARY_UNIVERSAL_SCAN -> stationaryUniversalScan
  local function settingsName(enum)
    local parts = {}
    for word in enum:lower():gmatch("[^_]+") do parts[#parts + 1] = word:sub(1, 1):upper() .. word:sub(2) end
    local s = table.concat(parts)
    return s:sub(1, 1):lower() .. s:sub(2)
  end

  local SPHERE = "site.siredvin.peripheralworks.computercraft.operations.SphereOperations"
  local FREE = "site.siredvin.peripheralworks.computercraft.operations.UnconditionalFreeOperations"

  --- SphereOperations: cooldown, max free radius, max cost radius, extra block cost
  function U.sphereOperation(enum, cooldown, free, cost, extra)
    local name = settingsName(enum)
    local op = {
      name = name,
      cooldown = U.num(name .. "Cooldown", cooldown),
      maxFreeRadius = U.num(name .. "MaxFreeRadius", free),
      maxCostRadius = U.num(name .. "MaxCostRadius", cost),
      extraBlockCost = U.num(name .. "ExtraBlockCost", extra),
    }
    function op.cost(radius)
      if radius <= op.maxFreeRadius then return 0 end
      local freeCount = (2 * op.maxFreeRadius + 1) ^ 3
      local all = (2 * radius + 1) ^ 3
      return floor((all - freeCount) * op.extraBlockCost)
    end
    function op.describe()
      return {
        name = name, type = SPHERE, cooldown = op.cooldown, maxFreeRadius = op.maxFreeRadius,
        maxCostRadius = op.maxCostRadius, extraBlockCost = op.extraBlockCost,
      }
    end
    return op
  end

  function U.freeOperation(enum, cooldown)
    local name = settingsName(enum)
    local op = { name = name, cooldown = U.num(name .. "Cooldown", cooldown) }
    function op.cost() return 0 end
    function op.describe() return { name = name, type = FREE, cooldown = op.cooldown } end
    return op
  end

  --- One block's OperationBoon. Cooldowns are kept as the epoch millisecond they end at (the block entity's NBT keeps
  --- them, so they survive a reboot).
  function U.newOperations(saved)
    local ops = { allowed = {}, names = {}, cooldowns = {} }
    for k, v in pairs(saved or {}) do ops.cooldowns[k] = v end
    function ops.register(op)
      if not ops.allowed[op.name] then ops.names[#ops.names + 1] = op.name end
      ops.allowed[op.name] = op
    end
    function ops.remaining(op)
      local ends = ops.cooldowns[op.name]
      if not ends then return 0 end
      return C.toInt(math.max(0, ends - U.now()))
    end
    --- performOperation: on cooldown or not enough fuel gives (nil, message); otherwise the method's results, and the
    --- cooldown starts when it is over the threshold. A block owner has no fuel, so anything that costs fails.
    function ops.perform(op, context, fn)
      if ops.remaining(op) > 0 then return nil, op.name .. " is on cooldown" end
      if op.cost(context) ~= 0 then return nil, "This peripheral has no fuel at all" end
      local results = table.pack(fn())
      local cooldown = floor(op.cooldown * 1.0)
      if cooldown > U.COOLDOWN_THRESHOLD and cooldown > 0 then
        ops.cooldowns[op.name] = U.now() + cooldown
        core.save()
      end
      return table.unpack(results, 1, results.n)
    end
    -- the boon's own Lua methods
    function ops.getCooldown(name)
      name = C.str(1, name)
      local op = ops.allowed[name]
      if not op then return nil, "Cannot find this operation" end
      return ops.remaining(op)
    end
    function ops.getOperations()
      return U.hashOrder(ops.names)
    end
    function ops.configure(data)
      for _, name in ipairs(ops.names) do data[name] = ops.allowed[name].describe() end
    end
    return ops
  end

  -- ===== a peripheral =====

  --- What the peripheral saved last boot (state.json: peripherals.<name>.restore)
  function U.saved(name)
    local s = core.savedState
    local p = s and s.peripherals and s.peripherals[name]
    return p and type(p.restore) == "table" and p.restore or nil
  end

  --- The peripheral the sim registers. `methods` are the Lua methods; `computerThread` the ones without
  --- mainThread = true. peripheral.getMethods is CC's HashMap of every name.
  function U.peripheral(def, methods, computerThread, extra)
    local names = {}
    for name in pairs(methods) do names[#names + 1] = name end
    table.sort(names)
    local p = {
      methods = methods,
      methodOrder = C.hashMapOrder(names),
      computerThread = computerThread,
      exactReturns = true,
    }
    for k, v in pairs(extra or {}) do p[k] = v end
    if p.state then
      -- state.json cannot hold one table twice (the restore copy and the live one)
      local live = p.state
      p.state = function() return C.deepCopy(live()) end
    end
    return p
  end

  --- The block's position (fixture x, y, z; the computer's own when left out) and horizontal facing.
  function U.position(def)
    local pos = core.position
    return {
      x = tonumber(def.x) or pos.x or 0,
      y = tonumber(def.y) or pos.y or 64,
      z = tonumber(def.z) or pos.z or 0,
    }
  end

  -- ===== the world the sensor reads =====

  local env = {
    dayTime = tonumber(upw.dayTime) or 6000,
    raining = upw.raining == true,
    thundering = upw.thundering == true,
    started = U.now(),
  }
  U.env = env
  --- Level.dayTime: one a tick (50 ms of the virtual clock) unless world.upw.daylightCycle is false
  function U.dayTime()
    if upw.daylightCycle == false then return env.dayTime end
    return env.dayTime + floor((U.now() - env.started) / 50)
  end

  local M = { handlers = {} }
  local builders = {}
  U.builders = builders
  U.handlers = M.handlers
  U.blocks = {} -- peripheral name -> its block object, for sim commands

  dofile("/rom/ccsim/addons/unlimited-peripheral-works/own.lua")(U)
  dofile("/rom/ccsim/addons/unlimited-peripheral-works/vanilla.lua")(U)

  function M.peripheral(def)
    local build = builders[def.type]
    if not build then error("ccsim: unlimited-peripheral-works has no " .. tostring(def.type), 0) end
    return build(def)
  end

  function U.block(cmd)
    local name = cmd.peripheral
    local b = type(name) == "string" and U.blocks[name] or nil
    if not b then return nil, "unknown peripheral " .. tostring(name) end
    return b
  end

  -- ===== sim commands: the world around the blocks =====

  function M.handlers.upwSetBlock(cmd)
    local x, y, z = tonumber(cmd.x), tonumber(cmd.y), tonumber(cmd.z)
    if not (x and y and z) then return false, "x, y and z are needed" end
    local w = U.world()
    if cmd.name == nil or gameData.id(cmd.name) == "minecraft:air" then
      w.set(x, y, z, nil)
    else
      w.set(x, y, z, w.newBlock({ name = cmd.name, state = cmd.state }))
    end
    return true
  end

  function M.handlers.upwAddEntity(cmd)
    local e = cmd.entity
    if type(e) ~= "table" or not (e.x and e.y and e.z and (e.type or e.name)) then
      return false, "entity needs type, x, y and z"
    end
    local list = U.world().entities
    list[#list + 1] = e
    return true
  end

  function M.handlers.upwRemoveEntity(cmd)
    local list = U.world().entities
    for i = #list, 1, -1 do
      local e = list[i]
      if (cmd.uuid and e.uuid == cmd.uuid) or (cmd.type and (e.type or e.name) == cmd.type) then table.remove(list, i) end
    end
    return true
  end

  function M.handlers.upwSetPlayer(cmd)
    local p = cmd.player
    if type(p) ~= "table" or type(p.name) ~= "string" then return false, "player needs a name" end
    U.players = U.players or {}
    for i, q in ipairs(U.players) do
      if q.name == p.name then
        if cmd.remove then table.remove(U.players, i) else U.players[i] = p end
        return true
      end
    end
    if not cmd.remove then U.players[#U.players + 1] = p end
    return true
  end

  function M.handlers.upwSetWorld(cmd)
    if cmd.dayTime ~= nil then
      env.dayTime = tonumber(cmd.dayTime) or env.dayTime
      env.started = U.now()
    end
    if cmd.raining ~= nil then env.raining = cmd.raining == true end
    if cmd.thundering ~= nil then env.thundering = cmd.thundering == true end
    for _, key in ipairs({ "biome", "light", "dimensions", "slimeChunks" }) do
      if cmd[key] ~= nil then upw[key] = cmd[key] end
    end
    return true
  end

  function M.state()
    return { dayTime = U.dayTime(), raining = env.raining, thundering = env.thundering }
  end

  return M
end
