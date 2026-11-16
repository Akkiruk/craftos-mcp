-- ccsim addons/mekanism-machines/miner: the Digital Miner (see engine.lua, blocks.lua, filters.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/machine/TileEntityDigitalMiner (onUpdateServer: while it can function, runs, has finished searching and
--   has blocks left, it takes its energy per tick, counts the delay down and mines one block when it reaches 0, then
--   waits getTicks(80); auto-eject every 10 ticks; start / stop / reset and the searcher states; the computer
--   methods and their range checks; 27 main slots; radius 10, min Y 0, max Y 60 by default),
--   capabilities/energy/MinerEnergyContainer (usage × silk 12 × (1 + radius cost) × (1 + height cost)),
--   content/miner/ThreadMinerSearch (IDLE, SEARCHING, PAUSED, FINISHED), config/GeneralConfig (the pack's
--   general.toml: silkMultiplier 12, maxRadius 32, ticksPerMine 80), config/UsageConfig and StorageConfig
--   (1000 J/t, 50 kJ), registries/MekanismBlockTypes (SPEED, ENERGY, ANCHOR, STONE_GENERATOR; no side config).
-- The world is not scanned: the fixture says how many blocks the search finds (`ores`) and what one drops (`drop`).
return function(E)
  local B, J, FL, F = E.B, E.J, E.FL, E.filters
  local floor, min, max = math.floor, math.min, math.max

  J.ENUMS.State = { "IDLE", "SEARCHING", "PAUSED", "FINISHED" }
  local SLOTS, DEFAULT_RADIUS, DEFAULT_HEIGHT_RANGE = 27, 10, 60
  local SILK, MAX_RADIUS, TICKS_PER_MINE, USAGE, STORAGE = 12, 32, 80, 1000, 50000

  local K = { kind = "miner" }
  K.rates = { energyInput = true }
  B.kindDefaults(K)

  local O = {
    directional = true, redstone = true, upgrades = { "SPEED", "ENERGY", "ANCHOR", "STONE_GENERATOR" },
    energy = function(mb) return { mb.energy } end,
    comparator = function(mb)
      local stacks = {}
      for i = 1, SLOTS do stacks[i] = mb.slots[i] or false end
      stacks[#stacks + 1] = mb.energyItem or false
      local count, limit = 0, 0
      for _, s in ipairs(stacks) do count = count + (s and s.count or 0); limit = limit + 64 end
      return E.redstoneLevel(count, limit)
    end,
  }

  function K.init(mb, spec)
    B.newBlock(spec, mb, O)
    local b = mb.block
    mb.energy = E.energyContainer(function() return B.maxEnergy(b, STORAGE) end)
    mb.energy.stored = FL.create(min(tonumber(spec.energy) or 0, B.maxEnergy(b, STORAGE)))
    mb.energyItem = B.stack(spec.energyItem)
    mb.minBuild, mb.maxBuild = floor(tonumber(spec.minBuildHeight) or -64), floor(tonumber(spec.maxBuildHeight) or 320)
    mb.radius = floor(tonumber(spec.radius) or DEFAULT_RADIUS)
    mb.minY = floor(tonumber(spec.minY) or 0)
    mb.maxY = floor(tonumber(spec.maxY) or (mb.minY + DEFAULT_HEIGHT_RANGE))
    mb.silkTouch, mb.doEject, mb.doPull = spec.silkTouch == true, spec.autoEject == true, spec.autoPull == true
    mb.inverse, mb.inverseRequiresReplacement = spec.inverse == true, spec.inverseRequiresReplacement == true
    mb.inverseReplaceTarget = spec.inverseReplaceTarget and (J.resourceLocation(spec.inverseReplaceTarget) or "minecraft:air") or "minecraft:air"
    mb.filters = {}
    for _, f in ipairs(type(spec.filters) == "table" and spec.filters or {}) do F.add(mb.filters, F.fromFixture("MINER", f)) end
    mb.slots = {}
    for i = 1, SLOTS do mb.slots[i] = B.stack(type(spec.items) == "table" and spec.items[i] or nil) end
    mb.ores = floor(tonumber(spec.ores) or 0)
    mb.drop = J.resourceLocation(spec.drop or "minecraft:cobblestone") or spec.drop
    mb.state, mb.running, mb.toMine, mb.found = "IDLE", false, 0, 0
    mb.delay, mb.delayTicks, mb.mined, mb.ejected = 0, 0, 0, 0
    if spec.running then
      mb.state, mb.running, mb.toMine = "FINISHED", true, mb.ores
    end
    mb.tanks = {}
    mb.after = B.after
  end

  --- MinerEnergyContainer.updateMinerEnergyPerTick
  local function perTick(mb)
    local e = B.energyPerTick(mb.block, USAGE)
    if mb.silkTouch then e = FL.multiply(e, SILK) end
    local radiusCost = max((mb.radius - DEFAULT_RADIUS) / (MAX_RADIUS - DEFAULT_RADIUS), 0)
    local heightRange = (mb.maxBuild - mb.minBuild) - 1 - DEFAULT_HEIGHT_RANGE
    local heightCost = heightRange == 0 and 0 or max((mb.maxY - mb.minY - DEFAULT_HEIGHT_RANGE) / heightRange, 0)
    return FL.multiply(e, (1 + radiusCost) * (1 + heightCost))
  end
  local function delayLength(mb) return B.ticks(mb.block, TICKS_PER_MINE) end

  --- tryMineBlock: one block's drop into the first slots with room; nothing is mined when it does not fit.
  local function mineOne(mb)
    local room = 0
    for i = 1, SLOTS do
      local s = mb.slots[i]
      if not s then room = room + 64 elseif s.name == mb.drop then room = room + 64 - s.count end
    end
    if room < 1 then return end
    mb.toMine = mb.toMine - 1
    for i = 1, SLOTS do
      local s = mb.slots[i]
      if not s then mb.slots[i] = { name = mb.drop, count = 1 } break end
      if s.name == mb.drop and s.count < 64 then s.count = s.count + 1 break end
    end
    mb.mined = mb.mined + 1
  end

  function K.tick(mb)
    local b = mb.block
    -- the search thread: one tick, in which getToMine reads what it has found so far
    if mb.state == "SEARCHING" then
      mb.state, mb.toMine, mb.found = "FINISHED", mb.ores, mb.ores
    end
    if B.canFunction(b) and mb.running and mb.state == "FINISHED" and mb.toMine > 0 then
      local cost = perTick(mb)
      if mb.energy.stored >= cost then
        b.active = true
        if mb.delay > 0 then mb.delay = mb.delay - 1 end
        mb.energy:extract(cost)
        if mb.delay == 0 then
          mineOne(mb)
          mb.delay = delayLength(mb)
        end
      else
        b.active = false
      end
    else
      b.active = false
    end
    if mb.doEject and mb.delayTicks == 0 then
      if mb.spec.ejectInventory ~= false then
        for i = 1, SLOTS do
          if mb.slots[i] then mb.ejected = mb.ejected + mb.slots[i].count; mb.slots[i] = nil end
        end
      end
      mb.delayTicks = 10
    elseif mb.delayTicks > 0 then
      mb.delayTicks = mb.delayTicks - 1
    end
  end

  function K.transfer(mb)
    local r = E.rate(mb.spec.energyInput)
    if r and r > 0 then mb.energy:insert(min(r, 1.8e19)) end
  end

  function K.redstoneLevel(mb) return O.comparator(mb) end

  local function reset(mb)
    mb.state, mb.running, mb.toMine, mb.found = "IDLE", false, 0, 0
    mb.block.active = false
  end
  local function start(mb)
    if mb.state == "IDLE" then mb.state, mb.found = "SEARCHING", 0 end
    mb.running = true
  end
  local function stop(mb)
    if mb.state == "SEARCHING" then reset(mb)
    elseif mb.state == "FINISHED" then mb.running = false end
  end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    extra.energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), mb.energy:max())) end
    extra.ores = function(v)
      mb.ores = floor(tonumber(v))
      if mb.state == "FINISHED" then mb.toMine = mb.ores end
    end
    extra.drop = function(v) mb.drop = J.resourceLocation(v) or v end
    extra.items = function(v) for i = 1, SLOTS do mb.slots[i] = B.stack(v[i]) end end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    local items = {}
    for i = 1, SLOTS do items[i] = mb.slots[i] and { name = mb.slots[i].name, count = mb.slots[i].count } or false end
    return B.state(mb, {
      energy = mb.energy.stored, maxEnergy = mb.energy:max(), energyUsage = mb.block.active and perTick(mb) or 0,
      state = mb.state, running = mb.running, toMine = mb.toMine, mined = mb.mined, ejected = mb.ejected,
      radius = mb.radius, minY = mb.minY, maxY = mb.maxY, silkTouch = mb.silkTouch, items = items,
      filters = F.list(mb.filters),
    })
  end

  -- ===== computer methods =====

  local function public(c) B.requirePublic(c.mb.block) end
  local function configurable(c)
    public(c)
    if c.mb.state ~= "IDLE" then J.computerError("Miner must be stopped and reset before its targeting configuration is changed.") end
  end
  local function getter(field) return { {}, function(c) return c.mb[field] end } end
  local OWN = {
    getEnergyItem = B.slot(function(mb) return mb.energyItem end),
    getSilkTouch = getter("silkTouch"),
    getRadius = getter("radius"),
    getMinY = getter("minY"),
    getMaxY = getter("maxY"),
    getInverseMode = getter("inverse"),
    getInverseModeRequiresReplacement = getter("inverseRequiresReplacement"),
    getInverseModeReplaceTarget = getter("inverseReplaceTarget"),
    getFilters = { {}, function(c) return F.list(c.mb.filters) end },
    getToMine = { {}, function(c) return c.mb.state == "SEARCHING" and c.mb.found or c.mb.toMine end },
    isRunning = getter("running"),
    getAutoEject = getter("doEject"),
    getAutoPull = getter("doPull"),
    getEnergyUsage = { {}, function(c) return c.mb.block.active and perTick(c.mb) or 0 end },
    getSlotCount = { {}, function() return SLOTS end },
    getItemInSlot = { { "int" }, function(c, slot)
      if slot < 0 or slot >= SLOTS then
        J.computerError(("Slot: '%d' is out of bounds, as this digital miner only has '%d' slots (zero indexed)."):format(slot, SLOTS))
      end
      return B.item(c.mb.slots[slot + 1])
    end },
    getState = getter("state"),
    setAutoEject = E.void({ "boolean" }, function(c, v) public(c); c.mb.doEject = v end),
    setAutoPull = E.void({ "boolean" }, function(c, v) public(c); c.mb.doPull = v end),
    setSilkTouch = E.void({ "boolean" }, function(c, v) public(c); c.mb.silkTouch = v end),
    start = E.void({}, function(c) public(c); start(c.mb) end),
    stop = E.void({}, function(c) public(c); stop(c.mb) end),
    reset = E.void({}, function(c) public(c); reset(c.mb) end),
    getMaxRadius = { {}, function() return MAX_RADIUS end },
    setRadius = E.void({ "int" }, function(c, r)
      configurable(c)
      if r < 0 or r > MAX_RADIUS then
        J.computerError(("Radius '%d' is out of range must be between 0 and %d. (Inclusive)"):format(r, MAX_RADIUS))
      end
      c.mb.radius = r
    end),
    setMinY = E.void({ "int" }, function(c, y)
      configurable(c)
      local mb = c.mb
      if y < mb.minBuild or y > mb.maxY then
        J.computerError(("Min Y '%d' is out of range must be between %d and %d. (Inclusive)"):format(y, mb.minBuild, mb.maxY))
      end
      mb.minY = y
    end),
    setMaxY = E.void({ "int" }, function(c, y)
      configurable(c)
      local mb = c.mb
      if y < mb.minY or y > mb.maxBuild - 1 then
        J.computerError(("Max Y '%d' is out of range must be between %d and %d. (Inclusive)"):format(y, mb.minY, mb.maxBuild - 1))
      end
      mb.maxY = y
    end),
    setInverseMode = E.void({ "boolean" }, function(c, v) configurable(c); c.mb.inverse = v end),
    setInverseModeRequiresReplacement = E.void({ "boolean" }, function(c, v) configurable(c); c.mb.inverseRequiresReplacement = v end),
    setInverseModeReplaceTarget = E.void({ "Item" }, function(c, v) configurable(c); c.mb.inverseReplaceTarget = v end),
    clearInverseModeReplaceTarget = E.void({}, function(c) configurable(c); c.mb.inverseReplaceTarget = "minecraft:air" end),
    addFilter = { { "MinerFilter" }, function(c, f) configurable(c); return F.add(c.mb.filters, f) end },
    removeFilter = { { "MinerFilter" }, function(c, f) configurable(c); return F.remove(c.mb.filters, f) end },
  }

  K.types = {
    digitalMiner = {
      groups = B.groups(B.tileMethods(OWN, O), O),
      newBlock = function(_, mb) return mb.block end,
      blockState = function(c, s) B.state(c.mb, s) end,
    },
  }
  return K
end
