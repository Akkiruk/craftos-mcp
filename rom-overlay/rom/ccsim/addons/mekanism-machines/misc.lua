-- ccsim addons/mekanism-machines/misc: the other Mekanism blocks with computer methods (see engine.lua, blocks.lua):
-- Electric Pump, Fluidic Plenisher, Resistive Heater, Fuelwood Heater, Seismic Vibrator, Laser, Laser Amplifier,
-- Laser Tractor Beam, Teleporter, Chargepad, Logistical Sorter, Oredictionificator, Formulaic Assemblicator,
-- Modification Station, Dimensional Stabilizer.
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/machine/TileEntityElectricPump (19 ticks, 10000 mB, 1000 mB a source block; reset),
--   TileEntityFluidicPlenisher (20 ticks, 10000 mB, 1000 mB a block placed; reset), TileEntityResistiveHeater (energy
--   per tick settable, × 0.6 into heat, 400 ticks of storage; BasicHeatCapacitor 100 / 5 / 100), TileEntityFuelwoodHeater
--   (400 heat a burn tick; capacitor 100 / 5 / 10), TileEntitySeismicVibrator, tile/laser/TileEntityBasicLaser
--   (fires what it holds, up to the usage, getDiggingPos), TileEntityLaserAmplifier (delay, min / max threshold,
--   redstone output mode; "Delay cannot be negative. Received: %d"), TileEntityLaserTractorBeam (27 slots),
--   tile/TileEntityTeleporter (public frequencies, colour, status codes 1-4), TileEntityChargepad,
--   TileEntityLogisticalSorter (default colour, auto, round robin, single item, filters),
--   tile/machine/TileEntityOredictionificator (filters), TileEntityFormulaicAssemblicator (9 grid, 18 input and 3 × 3
--   output slots; formula, stock control, auto mode and their errors), tile/TileEntityModificationStation,
--   tile/machine/TileEntityDimensionalStabilizer (5 × 5 chunks around it, usage × chunks loaded; offset range ±2),
--   capabilities/heat/BasicHeatCapacitor and ITileHeatHandler.simulate (environment loss only), the pack's
--   machine-usage.toml / machine-storage.toml / general.toml.
-- These keep their state and answer every method; what they do to the world (pumping, mining, teleporting,
-- sorting, crafting) is reduced to fixture counts. docs/mekanism-multiblocks.md says what each one models.
return function(E)
  local B, J, FL, F = E.B, E.J, E.FL, E.filters
  local floor, min, max = math.floor, math.min, math.max

  J.ENUMS.RedstoneOutput = { "OFF", "ENTITY_DETECTION", "ENERGY_CONTENTS" }
  local COLORS = J.ENUMS.EnumColor
  -- TransporterUtils.colors
  local TCOLORS = { "DARK_BLUE", "DARK_GREEN", "DARK_AQUA", "DARK_RED", "PURPLE", "INDIGO", "BRIGHT_GREEN", "AQUA", "RED",
    "PINK", "YELLOW", "BLACK" }
  local function indexOf(list, v) for i, x in ipairs(list) do if x == v then return i end end end

  local K = { kind = "misc" }
  K.rates = { energyInput = true, fluidInput = true, fluidOutput = true, heatOutput = true }
  B.kindDefaults(K)
  K.defaultFluid = { fluid = "minecraft:water" }

  local function slots(...)
    local names = { ... }
    return function(mb)
      local count, limit = 0, 0
      for _, n in ipairs(names) do
        local s = mb.items[n]
        if type(s) == "table" and s.n then
          for i = 1, s.n do count = count + (s[i] and s[i].count or 0); limit = limit + 64 end
        else
          count = count + (s and s.count or 0); limit = limit + 64
        end
      end
      return E.redstoneLevel(count, limit)
    end
  end

  -- usage (J/t), storage (J), o (block attributes), items (slot names; a number for a slot list), tank, heat
  local D = {}
  D.electricPump = { usage = 100, storage = 40000, ticks = 19, tank = 10000, pump = 1,
    o = { directional = true, redstone = true, upgrades = { "SPEED", "ENERGY", "FILTER" } }, items = { "inputItem", "outputItem", "energyItem" } }
  D.fluidicPlenisher = { usage = 100, storage = 40000, ticks = 20, tank = 10000, pump = -1,
    o = { directional = true, redstone = true, upgrades = { "SPEED", "ENERGY" } }, items = { "inputItem", "outputItem", "energyItem" } }
  D.resistiveHeater = { usage = 100, storage = 40000, heat = { 100, 5, 100 },
    o = { directional = true, redstone = true }, items = { "energyItem" } }
  D.fuelwoodHeater = { heat = { 100, 5, 10 }, o = { directional = true }, items = { "fuelItem" } }
  D.seismicVibrator = { usage = 50, storage = 20000, o = { directional = true, redstone = true }, items = { "energyItem" } }
  D.laser = { usage = 10000, storage = 2000000, laser = true, o = { directional = true }, items = {} }
  D.laserAmplifier = { usage = 0, storage = 5000000000, laser = true, amplifier = true,
    o = { directional = true, redstone = true, comparatorEnergy = true }, items = {} }
  D.laserTractorBeam = { usage = 0, storage = 5000000000, laser = true, tractor = true, o = { directional = true, comparatorSlots = true }, items = { "slots" } }
  D.teleporter = { usage = 1000, storage = 5000000, teleporter = true, o = { redstone = true, upgrades = { "ANCHOR" } }, items = { "energyItem" } }
  D.chargepad = { usage = 1024000, storage = 2048000, o = { directional = true, noSecurity = true }, items = {} }
  D.logisticalSorter = { sorter = true, o = { directional = true, redstone = true, upgrades = { "MUFFLING" } }, items = {} }
  D.oredictionificator = { ore = true, o = { directional = true, redstone = true, ejector = true, noComparator = true,
    config = { B.cfg.io("ITEM", "RIGHT") } }, items = { "inputItem", "outputItem" } }
  D.formulaicAssemblicator = { usage = 100, storage = 40000, ticks = 40, assembler = true,
    o = { directional = true, redstone = true, upgrades = { "SPEED", "ENERGY" }, ejector = true,
      config = { B.cfg.itemIO(true), B.cfg.input("ENERGY") } }, items = { "formulaItem", "energyItem", "grid", "inputs", "outputs" } }
  D.modificationStation = { usage = 100, storage = 40000, ticks = 40, o = { directional = true, redstone = true, noComparator = true },
    items = { "energyItem", "moduleItem", "containerItem" } }
  D.dimensionalStabilizer = { usage = 5000, storage = 40000, stabilizer = true,
    o = { redstone = true, upgrades = { "ENERGY" } }, items = { "energyItem" } }
  for _, d in pairs(D) do
    if d.storage then d.o.energy = function(mb) return { mb.energy } end end
    if d.o.comparatorEnergy then d.o.comparator = function(mb) return B.energyLevel(mb.energy.stored, mb.energy:max()) end
    elseif d.o.redstone and not d.o.noComparator then d.o.comparator = slots(table.unpack(d.items)) end
    if d.o.comparatorSlots then d.o.comparator = slots("slots") end
  end
  D.resistiveHeater.o.comparator = nil -- the Machine minus AttributeComparator
  D.seismicVibrator.o.comparator = nil

  local function list(spec, n)
    local out = { n = n }
    for i = 1, n do out[i] = B.stack(type(spec) == "table" and spec[i] or nil) end
    return out
  end

  -- teleporter frequencies (FrequencyType.TELEPORTER's public manager), per computer
  E.teleporterFrequencies = E.teleporterFrequencies or {}
  local function frequencyNamed(name)
    for _, f in ipairs(E.teleporterFrequencies) do if f.name == name then return f end end
  end
  do
    local cfgF = type(E.cfg) == "table" and E.cfg.teleporterFrequencies
    for _, f in ipairs(type(cfgF) == "table" and cfgF or {}) do
      local name = type(f) == "table" and f.name or f
      if not frequencyNamed(name) then
        E.teleporterFrequencies[#E.teleporterFrequencies + 1] = { name = tostring(name), color = type(f) == "table" and f.color and tostring(f.color):upper() or "PURPLE" }
      end
    end
  end

  function K.init(mb, spec)
    local d = K.types[spec.type] and K.types[spec.type].d
    if not d then error("ccsim: unknown block '" .. tostring(spec.type) .. "'", 0) end
    mb.d = d
    B.newBlock(spec, mb, d.o)
    local b = mb.block
    if d.storage then
      mb.usage = d.usage
      if spec.energyUsage and d.heat then mb.usage = FL.create(tonumber(spec.energyUsage)) end
      local function cap()
        if d.heat then return FL.multiply(mb.usage, 400) end
        return B.maxEnergy(b, d.storage)
      end
      mb.energy = E.energyContainer(cap)
      mb.energy.stored = FL.create(min(tonumber(spec.energy) or 0, cap()))
    end
    mb.items = {}
    for _, n in ipairs(d.items) do
      if n == "slots" then mb.items.slots = list(spec.slots, 27)
      elseif n == "grid" then mb.items.grid = list(spec.grid, 9)
      elseif n == "inputs" then mb.items.inputs = list(spec.inputs, 18)
      elseif n == "outputs" then mb.items.outputs = list(spec.outputs, 3)
      else mb.items[n] = B.stack(spec[n]) end
    end
    mb.tanks = {}
    if d.tank then
      mb.fluid = E.tank(false, function() return d.tank end)
      E.fill(mb.fluid, spec.fluid, "minecraft:water")
      mb.tanks.fluid = mb.fluid
      mb.blocks = floor(tonumber(spec.blocks) or 0) -- source blocks to pump, or air blocks to fill
      mb.fluidName = J.resourceLocation(spec.fluidType or "minecraft:water")
      mb.operatingTicks = 0
    end
    if d.heat then
      mb.heat = { capacity = d.heat[1], conduction = d.heat[2], insulation = d.heat[3], ambient = tonumber(spec.ambientTemperature) or 300 }
      mb.heat.heat = mb.heat.capacity * (tonumber(spec.temperature) or mb.heat.ambient)
      mb.heat.pending, mb.lastEnvironmentLoss = 0, 0
      mb.burnTime = floor(tonumber(spec.burnTime) or 0)
      mb.fuelBurnTime = floor(tonumber(spec.fuelBurnTime) or 300) -- one fuel item's burn time (ticks), e.g. charcoal 1600
    end
    if d.laser then
      mb.digging = type(spec.digging) == "table" and { x = floor(spec.digging.x), y = floor(spec.digging.y), z = floor(spec.digging.z) } or nil
      mb.delay, mb.ticks, mb.fired = floor(tonumber(spec.delay) or 0), 0, 0
      mb.minThreshold = FL.create(tonumber(spec.minThreshold) or 0)
      mb.maxThreshold = FL.create(tonumber(spec.maxThreshold) or d.storage)
      mb.outputMode = B.enumOf(J.ENUMS.RedstoneOutput, spec.redstoneOutputMode, "OFF", "redstone output mode")
    end
    if d.teleporter then
      mb.frequency = spec.frequency and tostring(spec.frequency) or nil
      if mb.frequency and not frequencyNamed(mb.frequency) then
        E.teleporterFrequencies[#E.teleporterFrequencies + 1] = { name = mb.frequency, color = "PURPLE" }
      end
      mb.frame = spec.frame ~= false
      mb.coord = { x = floor(tonumber(spec.x) or 0), y = floor(tonumber(spec.y) or 64), z = floor(tonumber(spec.z) or 0),
        dimension = J.resourceLocation(spec.dimension or "minecraft:overworld") }
    end
    if d.sorter then
      mb.color = spec.defaultColor and tostring(spec.defaultColor):upper() or nil
      mb.autoEject, mb.roundRobin, mb.single = spec.autoMode == true, spec.roundRobin == true, spec.single == true
    end
    if d.sorter or d.ore then
      mb.filters = {}
      for _, f in ipairs(type(spec.filters) == "table" and spec.filters or {}) do
        F.add(mb.filters, F.fromFixture(d.sorter and "SORTER" or "OREDICTIONIFICATOR", f))
      end
    end
    if d.assembler then
      mb.formula = spec.formula -- { valid = bool, encoded = bool }
      mb.hasRecipe = spec.hasRecipe == true
      mb.autoMode, mb.stockControl = spec.autoMode == true, spec.stockControl == true
      mb.operatingTicks, mb.crafted = 0, 0
      mb.remaining = {}
    end
    if d.stabilizer then
      mb.loading = {}
      for x = 1, 5 do mb.loading[x] = {} end
      mb.loading[3][3] = true
      for _, c in ipairs(type(spec.chunks) == "table" and spec.chunks or {}) do mb.loading[floor(c.x) + 3][floor(c.z) + 3] = true end
    end
    mb.processed = 0
    mb.after = B.after
  end

  local function chunksLoaded(mb)
    local n = 0
    for x = 1, 5 do for z = 1, 5 do if mb.loading[x][z] then n = n + 1 end end end
    return n
  end
  local function perTick(mb)
    if mb.d.heat then return mb.usage end
    local e = B.energyPerTick(mb.block, mb.d.usage)
    if mb.d.stabilizer then e = FL.multiply(e, chunksLoaded(mb)) end
    return e
  end

  --- ITileHeatHandler.simulate: the environment part (no neighbours; `heatOutput` J/t to a neighbour).
  local function heatTick(mb, heatIn)
    local h = mb.heat
    h.pending = h.pending + heatIn
    local out = E.rate(mb.spec.heatOutput)
    mb.lastTransferLoss = 0
    if out and out > 0 then
      local t = h.heat / h.capacity
      local give = min(out, max(0, (t - h.ambient) * h.capacity))
      h.pending = h.pending - give
      mb.lastTransferLoss = give / h.capacity -- 10.4+ getTransferLoss: the temperature handed to neighbours
    end
    local inv = E.AIR_INVERSE_COEFFICIENT + (h.insulation + h.conduction)
    local tempToTransfer = (h.heat / h.capacity - h.ambient) / inv
    h.pending = h.pending - tempToTransfer * h.capacity
    mb.lastEnvironmentLoss = max(tempToTransfer, 0)
    h.heat = h.heat + h.pending
    h.pending = 0
  end

  function K.tick(mb)
    local d, b = mb.d, mb.block
    if d.tank then
      local cost = perTick(mb)
      local room = d.pump > 0 and E.needed(mb.fluid) >= 1000 or mb.fluid.amount >= 1000
      if B.canFunction(b) and mb.energy.stored >= cost and room and mb.blocks > 0 then
        b.active = true
        mb.energy:extract(cost)
        mb.operatingTicks = mb.operatingTicks + 1
        if mb.operatingTicks >= B.ticks(b, d.ticks) then
          mb.operatingTicks = 0
          if d.pump > 0 then E.insert(mb.fluid, mb.fluidName, 1000) else E.shrink(mb.fluid, 1000) end
          mb.blocks = mb.blocks - 1
          mb.processed = mb.processed + 1
        end
      else
        b.active = false
      end
    elseif d.heat then
      local heatIn = 0
      if d.storage then
        local toUse = 0
        if B.canFunction(b) then toUse = min(mb.energy.stored, mb.usage) end
        if toUse > 0 then
          heatIn = FL.multiply(toUse, 0.6) -- resistiveHeaterEfficiency
          mb.energy:extract(toUse)
        end
        b.active = toUse > 0
        mb.energyUsed = toUse -- 10.4+ getEnergyUsed (clientEnergyUsed)
      else
        if mb.burnTime == 0 and mb.items.fuelItem then
          mb.burnTime = mb.fuelBurnTime
          mb.items.fuelItem.count = mb.items.fuelItem.count - 1
          if mb.items.fuelItem.count <= 0 then mb.items.fuelItem = nil end
        end
        if mb.burnTime > 0 then
          mb.burnTime = mb.burnTime - 1
          heatIn = 400 -- heatPerFuelTick × fuelwoodTickMultiplier 1
          b.active = true
        else
          b.active = false
        end
      end
      heatTick(mb, heatIn)
    elseif d.laser then
      if d.amplifier then
        mb.ticks = mb.ticks + 1
        local fire = mb.ticks >= mb.delay and mb.energy.stored >= mb.minThreshold and B.canFunction(b)
        local amount = fire and min(mb.energy.stored, mb.maxThreshold) or 0
        if amount > 0 then mb.energy:extract(amount); mb.fired = mb.fired + amount; mb.ticks = 0 end
        b.active = amount > 0
      elseif not d.tractor then
        local amount = min(mb.energy.stored, mb.d.usage)
        if amount > 0 then mb.energy:extract(amount); mb.fired = mb.fired + amount end
        b.active = amount > 0
      end
    elseif d.usage and d.storage and (d == D.seismicVibrator or d.stabilizer or d == D.chargepad) then
      local cost = perTick(mb)
      local on = B.canFunction(b) and mb.energy.stored >= cost and (d ~= D.chargepad or mb.spec.charging == true)
      if on then mb.energy:extract(cost) end
      b.active = on
    elseif d.assembler then
      if mb.autoMode and mb.formula and mb.formula.valid and mb.hasRecipe and B.canFunction(b) and mb.energy.stored >= perTick(mb) then
        mb.energy:extract(perTick(mb))
        mb.operatingTicks = mb.operatingTicks + 1
        if mb.operatingTicks >= B.ticks(b, d.ticks) then mb.operatingTicks = 0; mb.crafted = mb.crafted + 1 end
        b.active = true
      else
        b.active = false
      end
    end
  end

  function K.transfer(mb)
    local s = mb.spec
    if mb.energy then
      local r = E.rate(s.energyInput)
      if r and r > 0 then mb.energy:insert(min(r, 1.8e19)) end
    end
    if mb.fluid then
      local r = E.rate(s.fluidInput)
      if r and r > 0 then E.insert(mb.fluid, mb.fluid.name or mb.fluidName, r) end
      r = E.rate(s.fluidOutput)
      if r and r > 0 and mb.fluid.amount > 0 then E.shrink(mb.fluid, r) end
    end
  end

  function K.redstoneLevel(mb) return mb.block.o.comparator and mb.block.o.comparator(mb) or 0 end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    if mb.energy then extra.energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), mb.energy:max())) end end
    extra.blocks = function(v) mb.blocks = floor(tonumber(v)) end
    extra.temperature = function(v) mb.heat.heat = mb.heat.capacity * tonumber(v) end
    extra.frame = function(v) mb.frame = v ~= false end
    extra.hasRecipe = function(v) mb.hasRecipe = v == true end
    extra.formula = function(v) mb.formula = v end
    extra.charging = function(v) mb.spec.charging = v == true end
    extra.digging = function(v) mb.digging = type(v) == "table" and { x = floor(v.x), y = floor(v.y), z = floor(v.z) } or nil end
    for _, n in ipairs(mb.d.items) do
      if not extra[n] then extra[n] = function(v) mb.items[n] = B.stack(v) end end
    end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    local s = { processed = mb.processed }
    if mb.energy then s.energy, s.maxEnergy = mb.energy.stored, mb.energy:max() end
    if mb.heat then s.temperature, s.environmentalLoss = mb.heat.heat / mb.heat.capacity, mb.lastEnvironmentLoss end
    if mb.fluid then s.fluid, s.blocks = E.tankState(mb.fluid), mb.blocks end
    if mb.d.laser then s.fired = mb.fired end
    if mb.d.assembler then s.crafted = mb.crafted end
    if mb.d.stabilizer then s.chunksLoaded = chunksLoaded(mb) end
    if mb.d.teleporter then s.frequency = mb.frequency end
    return B.state(mb, s)
  end

  -- ===== computer methods =====

  local function public(c) B.requirePublic(c.mb.block) end
  local function slot(n) return B.slot(function(mb) return mb.items[n] end) end
  local function getter(field) return { {}, function(c) return c.mb[field] end } end
  local function heatMethods(t)
    t.getTemperature = { {}, function(c) return c.mb.heat.heat / c.mb.heat.capacity end }
    t.getEnvironmentalLoss = getter("lastEnvironmentLoss")
  end
  local function frequency(c)
    local f = c.mb.frequency and frequencyNamed(c.mb.frequency)
    if not f then J.computerError("No frequency is currently selected.") end
    return f
  end
  local function activeCoords(name)
    local out = {}
    for _, mb in ipairs(E.multiblocks) do
      if mb.d and mb.d.teleporter and mb.frequency == name and not mb.destroyed then
        out[#out + 1] = { x = mb.coord.x, y = mb.coord.y, z = mb.coord.z, dimension = mb.coord.dimension }
      end
    end
    return out
  end
  local function colorStep(color, step)
    if color == nil then return step > 0 and TCOLORS[1] or TCOLORS[#TCOLORS] end
    return TCOLORS[indexOf(TCOLORS, color) + step]
  end

  local OWN = {}
  OWN.electricPump = {
    getInputItem = slot("inputItem"), getOutputItem = slot("outputItem"), getEnergyItem = slot("energyItem"),
    reset = E.void({}, function(c) public(c); c.mb.operatingTicks = 0 end),
  }
  E.tankMethods(OWN.electricPump, "Fluid", function(mb) return mb.fluid end)
  OWN.fluidicPlenisher = {}
  for k, v in pairs(OWN.electricPump) do OWN.fluidicPlenisher[k] = v end
  OWN.resistiveHeater = {
    getEnergyItem = slot("energyItem"),
    getEnergyUsage = { {}, function(c) return c.mb.usage end },
    setEnergyUsage = E.void({ "FloatingLong" }, function(c, v)
      public(c)
      c.mb.usage = v
      c.mb.energy.stored = min(c.mb.energy.stored, FL.multiply(v, 400))
    end),
  }
  heatMethods(OWN.resistiveHeater)
  OWN.fuelwoodHeater = { getFuelItem = slot("fuelItem") }
  heatMethods(OWN.fuelwoodHeater)
  OWN.seismicVibrator = { getEnergyItem = slot("energyItem") }
  OWN.laser = { getDiggingPos = getter("digging") }
  OWN.laserAmplifier = {
    getDiggingPos = getter("digging"),
    getRedstoneOutputMode = getter("outputMode"),
    getDelay = getter("delay"),
    getMinThreshold = getter("minThreshold"),
    getMaxThreshold = getter("maxThreshold"),
    setRedstoneOutputMode = E.void({ "RedstoneOutput" }, function(c, m) public(c); c.mb.outputMode = m end),
    setDelay = E.void({ "int" }, function(c, v)
      public(c)
      if v < 0 then J.computerError(("Delay cannot be negative. Received: %d"):format(v)) end
      c.mb.delay = v
    end),
    setMinThreshold = E.void({ "FloatingLong" }, function(c, v)
      public(c)
      local mb = c.mb
      mb.minThreshold = min(v, mb.d.storage)
      if mb.minThreshold > mb.maxThreshold then mb.maxThreshold = mb.minThreshold end
    end),
    setMaxThreshold = E.void({ "FloatingLong" }, function(c, v)
      public(c)
      local mb = c.mb
      mb.maxThreshold = min(v, mb.d.storage)
      if mb.maxThreshold < mb.minThreshold then mb.minThreshold = mb.maxThreshold end
    end),
  }
  OWN.laserTractorBeam = {
    getDiggingPos = getter("digging"),
    getSlotCount = { {}, function() return 27 end },
    getItemInSlot = { { "int" }, function(c, i)
      if i < 0 or i >= 27 then
        J.computerError(("Slot: '%d' is out of bounds, as this laser amplifier only has '%d' slots (zero indexed)."):format(i, 27))
      end
      return B.item(c.mb.items.slots[i + 1])
    end },
  }
  OWN.teleporter = {
    getEnergyItem = slot("energyItem"),
    getFrequencies = { {}, function()
      local out = {}
      for i, f in ipairs(E.teleporterFrequencies) do out[i] = J.frequency(f.name, true, f.owner) end
      return out
    end },
    hasFrequency = { {}, function(c) return c.mb.frequency ~= nil and frequencyNamed(c.mb.frequency) ~= nil end },
    getFrequency = { {}, function(c) local f = frequency(c) return J.frequency(f.name, true, f.owner) end },
    setFrequency = E.void({ "String" }, function(c, name)
      public(c)
      if not frequencyNamed(name) then J.computerError(("No public teleporter frequency with name '%s' found."):format(name)) end
      c.mb.frequency = name
    end),
    createFrequency = E.void({ "String" }, function(c, name)
      public(c)
      if frequencyNamed(name) then
        J.computerError(("Unable to create public teleporter frequency with name '%s' as one already exists."):format(name))
      end
      E.teleporterFrequencies[#E.teleporterFrequencies + 1] = { name = name, color = "PURPLE" }
      c.mb.frequency = name
    end),
    getFrequencyColor = { {}, function(c) return frequency(c).color end },
    setFrequencyColor = E.void({ "EnumColor" }, function(c, color) public(c); frequency(c).color = color end),
    incrementFrequencyColor = E.void({}, function(c)
      public(c)
      local f = frequency(c)
      f.color = E.cycle(COLORS, f.color, 1)
    end),
    decrementFrequencyColor = E.void({}, function(c)
      public(c)
      local f = frequency(c)
      f.color = E.cycle(COLORS, f.color, -1)
    end),
    getActiveTeleporters = { {}, function(c) return activeCoords(frequency(c).name) end },
    getStatus = { {}, function(c)
      local mb = c.mb
      if not (mb.frequency and frequencyNamed(mb.frequency)) then return "no frequency" end
      if not mb.frame then return "no frame" end
      if #activeCoords(mb.frequency) < 2 then return "no link" end
      if mb.energy.stored < 1000 then return "needs energy" end -- teleporterBase, nobody on the pad
      return "ready"
    end },
  }
  OWN.chargepad = {}
  OWN.logisticalSorter = {
    getDefaultColor = getter("color"),
    getAutoMode = getter("autoEject"),
    isRoundRobin = getter("roundRobin"),
    isSingle = getter("single"),
    getFilters = { {}, function(c) return F.list(c.mb.filters) end },
    setSingle = E.void({ "boolean" }, function(c, v) public(c); c.mb.single = v end),
    setRoundRobin = E.void({ "boolean" }, function(c, v) public(c); c.mb.roundRobin = v end),
    setAutoMode = E.void({ "boolean" }, function(c, v) public(c); c.mb.autoEject = v end),
    clearDefaultColor = E.void({}, function(c) public(c); c.mb.color = nil end),
    incrementDefaultColor = E.void({}, function(c) public(c); c.mb.color = colorStep(c.mb.color, 1) end),
    decrementDefaultColor = E.void({}, function(c) public(c); c.mb.color = colorStep(c.mb.color, -1) end),
    setDefaultColor = E.void({ "EnumColor" }, function(c, color)
      public(c)
      if not indexOf(TCOLORS, color) then J.computerError(("Color '%s' is not a supported transporter color."):format(color)) end
      c.mb.color = color
    end),
    addFilter = { { "SorterFilter" }, function(c, f) public(c); return F.add(c.mb.filters, f) end },
    removeFilter = { { "SorterFilter" }, function(c, f) public(c); return F.remove(c.mb.filters, f) end },
  }
  OWN.oredictionificator = {
    getInputItem = slot("inputItem"), getOutputItem = slot("outputItem"),
    getFilters = { {}, function(c) return F.list(c.mb.filters) end },
    addFilter = { { "OredictionificatorItemFilter" }, function(c, f) public(c); return F.add(c.mb.filters, f) end },
    removeFilter = { { "OredictionificatorItemFilter" }, function(c, f) public(c); return F.remove(c.mb.filters, f) end },
  }
  local function validFormula(c, what)
    public(c)
    local f = c.mb.formula
    if not (type(f) == "table" and f.valid) then J.computerError(what .. " requires a valid formula.") end
  end
  local function canCraft(c)
    public(c)
    if not c.mb.hasRecipe then J.computerError("Unable to perform craft as there is currently no matching recipe in the grid.") end
    if c.mb.autoMode then J.computerError("Unable to perform craft as Auto-Mode is enabled.") end
  end
  local function listSlot(field, n, msg)
    return { { "int" }, function(c, i)
      if i < 0 or i >= n then J.computerError(msg:format(i, n)) end
      return B.item(c.mb.items[field][i + 1])
    end }
  end
  OWN.formulaicAssemblicator = {
    getExcessRemainingItems = { {}, function(c) return c.mb.remaining end },
    getFormulaItem = slot("formulaItem"),
    getEnergyItem = slot("energyItem"),
    hasRecipe = getter("hasRecipe"),
    getRecipeProgress = getter("operatingTicks"),
    getTicksRequired = { {}, function(c) return B.ticks(c.mb.block, 40) end },
    getCraftingInputSlot = listSlot("grid", 9, "Crafting Input Slot '%d' is out of bounds, must be between 0 and %d."),
    getCraftingOutputSlots = { {}, function() return 3 end },
    getCraftingOutputSlot = listSlot("outputs", 3, "Crafting Output Slot '%d' is out of bounds, must be between 0 and %d."),
    hasValidFormula = { {}, function(c) return type(c.mb.formula) == "table" and c.mb.formula.valid == true end },
    getSlots = { {}, function() return 18 end },
    getItemInSlot = listSlot("inputs", 18, "Slot '%d' is out of bounds, must be between 0 and %d."),
    encodeFormula = E.void({}, function(c)
      public(c)
      local mb = c.mb
      if not mb.items.formulaItem then J.computerError("No formula found.") end
      if (type(mb.formula) == "table" and mb.formula.valid) or (type(mb.formula) == "table" and mb.formula.encoded) then
        J.computerError("Formula has already been encoded.")
      end
      if not mb.hasRecipe then J.computerError("Encoding formulas require that there is a valid recipe to actually encode.") end
      mb.formula = { valid = true, encoded = true }
    end),
    fillOrEmptyGrid = not J.NEW and E.void({}, function(c)
      public(c)
      if c.mb.autoMode then J.computerError("Filling/Emptying the grid requires Auto-Mode to be disabled.") end
    end) or nil,
    -- 10.4+: two methods (TileEntityFormulaicAssemblicator.computerFillGrid / computerEmptyGrid)
    fillGrid = J.NEW and E.void({}, function(c)
      public(c)
      if c.mb.autoMode then J.computerError("Filling the grid requires Auto-Mode to be disabled.") end
    end) or nil,
    emptyGrid = J.NEW and E.void({}, function(c)
      public(c)
      if c.mb.autoMode then J.computerError("Emptying the grid requires Auto-Mode to be disabled.") end
    end) or nil,
    craftSingleItem = E.void({}, function(c) canCraft(c); c.mb.crafted = c.mb.crafted + 1 end),
    craftAvailableItems = E.void({}, function(c) canCraft(c); c.mb.crafted = c.mb.crafted + 1 end),
    getStockControl = { {}, function(c) validFormula(c, "Stock Control"); return c.mb.stockControl end },
    setStockControl = E.void({ "boolean" }, function(c, v) validFormula(c, "Stock Control"); c.mb.stockControl = v end),
    getAutoMode = { {}, function(c) validFormula(c, "Auto-Mode"); return c.mb.autoMode end },
    setAutoMode = E.void({ "boolean" }, function(c, v) validFormula(c, "Auto-Mode"); c.mb.autoMode = v end),
  }
  OWN.modificationStation = {
    getEnergyItem = slot("energyItem"), getModuleItem = slot("moduleItem"), getContainerItem = slot("containerItem"),
  }
  local function offset(v, isX)
    if v < -2 or v > 2 then
      J.computerError(("%s offset '%d' is not in range, must be between %d and %d inclusive."):format(isX and "X" or "Z", v, -2, 2))
    end
    return v + 3
  end
  OWN.dimensionalStabilizer = {
    getChunksLoaded = { {}, function(c) return chunksLoaded(c.mb) end },
    getEnergyItem = slot("energyItem"),
    isChunkLoadingAt = { { "int", "int" }, function(c, x, z)
      local i, k = offset(x, true), offset(z, false)
      return c.mb.loading[i][k] == true
    end },
    toggleChunkLoadingAt = E.void({ "int", "int" }, function(c, x, z)
      public(c)
      local i, k = offset(x, true), offset(z, false)
      if not (i == 3 and k == 3) then c.mb.loading[i][k] = not c.mb.loading[i][k] or nil end
    end),
    setChunkLoadingAt = E.void({ "int", "int", "boolean" }, function(c, x, z, v)
      public(c)
      local i, k = offset(x, true), offset(z, false)
      if not (i == 3 and k == 3) then c.mb.loading[i][k] = v or nil end
    end),
  }

  if J.NEW then
    -- ===== methods 10.4.16 added (same in 10.7.19) =====
    OWN.resistiveHeater.getEnergyUsed = { {}, function(c) return c.mb.energyUsed or 0 end }
    OWN.resistiveHeater.getTransferLoss = getter("lastTransferLoss")
    OWN.fuelwoodHeater.getTransferLoss = getter("lastTransferLoss")
    -- TileEntitySeismicVibrator: the blocks come from the fixture's `seismicBlocks` ({ ["x,y,z"] = name }, chunk
    -- relative x/z, world y); anything else reads as air. Overworld build height -64 to 319.
    local MIN_Y, MAX_Y = -64, 320
    local function vibrating(c)
      if not c.mb.block.active then J.computerError("Seismic Vibrator is not currently vibrating any chunks") end
    end
    local function checkXZ(x, z)
      if x < 0 or x > 15 then J.computerError(("Chunk Relative X '%d' is out of range must be between 0 and 15. (Inclusive)"):format(x)) end
      if z < 0 or z > 15 then J.computerError(("Chunk Relative Z '%d' is out of range must be between 0 and 15. (Inclusive)"):format(z)) end
    end
    local function blockAt(mb, x, y, z)
      local t = type(mb.spec.seismicBlocks) == "table" and mb.spec.seismicBlocks or {}
      local name = t[("%d,%d,%d"):format(x, y, z)]
      return { block = name and (J.resourceLocation(name) or name) or "minecraft:air" }
    end
    OWN.seismicVibrator.isVibrating = { {}, function(c) return c.mb.block.active == true end }
    OWN.seismicVibrator.getBlockAt = { { "int", "int", "int" }, function(c, x, y, z)
      vibrating(c)
      if y < MIN_Y or y >= MAX_Y then
        J.computerError(("Y '%d' is out of range must be between %d and %d. (Inclusive)"):format(y, MIN_Y, MAX_Y - 1))
      end
      checkXZ(x, z)
      return blockAt(c.mb, x, y, z)
    end }
    OWN.seismicVibrator.getColumnAt = { { "int", "int" }, function(c, x, z)
      vibrating(c)
      checkXZ(x, z)
      local out = {}
      for y = MIN_Y, MAX_Y do out[y] = blockAt(c.mb, x, y, z) end -- betweenClosed up to getMaxBuildHeight: 320 too
      return out
    end }
    -- TileEntityDimensionalStabilizer.adjustChunkLoadingRadius: the ring at that radius (not the centre)
    local function radius(c, r, load)
      public(c)
      if r <= 0 or r > 2 then J.computerError(("Radius '%d' is not in range, must be between 1 and %d inclusive."):format(r, 2)) end
      for x = -r, r do
        local inner = x > -r and x < r
        local z = -r
        while z <= r do
          if not (x == 0 and z == 0) then c.mb.loading[x + 3][z + 3] = load or nil end
          z = z + (inner and 2 * r or 1)
        end
      end
    end
    OWN.dimensionalStabilizer.enableChunkLoadingFor = E.void({ "int" }, function(c, r) radius(c, r, true) end)
    OWN.dimensionalStabilizer.disableChunkLoadingFor = E.void({ "int" }, function(c, r) radius(c, r, false) end)
  end

  K.types = {}
  for name, d in pairs(D) do
    K.types[name] = {
      d = d,
      groups = B.groups(B.tileMethods(OWN[name], d.o), d.o),
      newBlock = function(_, mb) return mb.block end,
      blockState = function(c, s) B.state(c.mb, s) end,
    }
  end
  return K
end
