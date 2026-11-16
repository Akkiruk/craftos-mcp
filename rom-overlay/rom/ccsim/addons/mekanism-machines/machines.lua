-- ccsim addons/mekanism-machines/machines: a few common processing machines (see engine.lua, blocks.lua):
-- Enrichment Chamber, Crusher, Energized Smelter, Metallurgic Infuser, Electrolytic Separator.
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/prefab/TileEntityElectricMachine (200 ticks, getEnergyUsage while active, config ITEM then ENERGY,
--   setupItemIOConfig defaults), tile/prefab/TileEntityProgressMachine (getRecipeProgress, getTicksRequired),
--   tile/machine/TileEntityMetallurgicInfuser (1000 mB infusion tank, ITEM/ENERGY/INFUSION config, dumpInfuseType),
--   tile/machine/TileEntityElectrolyticSeparator (24000 mB water, 2400 mB per gas tank, 2^speed operations a tick,
--   400 J per operation, dumping 8 × 2^speed or down to 90 % at 1024 mB/t, its side config),
--   capabilities/energy/MachineEnergyContainer, config/UsageConfig, config/StorageConfig (50 J/t, 20 kJ; the
--   separator 160 kJ), util/MekanismUtils.getTicks / getEnergyPerTick / getMaxEnergy.
-- Recipes are not looked up: the fixture says what one input item becomes.
return function(E)
  local B, J, C, FL = E.B, E.J, E.C, E.FL
  local min, max, floor = math.min, math.max, math.floor

  J.ENUMS.GasMode = J.ENUMS.GasMode or { "IDLE", "DUMPING_EXCESS", "DUMPING" }
  local FROM_H2 = 200
  local CHEMICAL_EJECT = 1024 -- general.chemicalAutoEjectRate

  local K = { kind = "machine" }
  K.rates = { energyInput = true, waterInput = true, leftOutput = true, rightOutput = true, infuseInput = true }
  B.kindDefaults(K)
  K.defaultFluid = { water = "minecraft:water", left = "mekanism:hydrogen", right = "mekanism:oxygen", infuse = "mekanism:redstone" }

  local UPGRADES = { "SPEED", "ENERGY", "MUFFLING" }
  local function slotsComparator(mb)
    local stacks = {}
    for _, f in ipairs(mb.slots) do stacks[#stacks + 1] = mb[f] end
    return B.slotsLevel(stacks)
  end
  local function energyOf(mb) return { mb.energy } end

  local ELECTRIC_O = {
    directional = true, redstone = true, upgrades = UPGRADES, ejector = true,
    config = {
      { type = "ITEM", modes = { "INPUT", "OUTPUT", "INPUT_OUTPUT", "ENERGY" }, fill = "INPUT",
        sides = { RIGHT = "OUTPUT", BACK = "ENERGY" } },
      { type = "ENERGY", modes = { "INPUT" }, fill = "INPUT", canEject = false },
    },
    comparator = slotsComparator, energy = energyOf,
  }
  local INFUSER_O = {
    directional = true, redstone = true, upgrades = UPGRADES, ejector = true,
    config = {
      { type = "ITEM", modes = { "INPUT", "OUTPUT", "INPUT_OUTPUT", "ENERGY", "EXTRA" }, fill = "INPUT",
        sides = { RIGHT = "OUTPUT", BOTTOM = "EXTRA", BACK = "ENERGY" } },
      { type = "ENERGY", modes = { "INPUT" }, fill = "INPUT", canEject = false },
      { type = "INFUSION", modes = { "INPUT", "OUTPUT", "INPUT_OUTPUT" }, fill = "INPUT", sides = { RIGHT = "OUTPUT" }, canEject = false },
    },
    comparator = slotsComparator, energy = energyOf,
  }
  local SEPARATOR_O = {
    directional = true, redstone = true, upgrades = UPGRADES, ejector = true,
    config = {
      { type = "ITEM", modes = { "INPUT", "OUTPUT_1", "OUTPUT_2", "INPUT_OUTPUT", "ENERGY" },
        sides = { FRONT = "INPUT", LEFT = "OUTPUT_1", RIGHT = "OUTPUT_2", BACK = "ENERGY" } },
      { type = "GAS", modes = { "OUTPUT_1", "OUTPUT_2" }, sides = { LEFT = "OUTPUT_1", RIGHT = "OUTPUT_2" }, ejecting = true },
      { type = "FLUID", modes = { "INPUT" }, fill = "INPUT", canEject = false },
      { type = "ENERGY", modes = { "INPUT" }, fill = "INPUT", canEject = false },
    },
    comparator = slotsComparator, energy = energyOf,
  }

  local MACHINES = {
    enrichmentChamber = { o = ELECTRIC_O, usage = 50, storage = 20000, ticks = 200 },
    crusher = { o = ELECTRIC_O, usage = 50, storage = 20000, ticks = 200 },
    energizedSmelter = { o = ELECTRIC_O, usage = 50, storage = 20000, ticks = 200 },
    metallurgicInfuser = { o = INFUSER_O, usage = 50, storage = 20000, ticks = 200, infuser = true },
    electrolyticSeparator = { o = SEPARATOR_O, usage = FROM_H2 * 2, storage = 160000, separator = true },
  }

  local function stack(spec) -- a fixture slot: { name, count } or nil
    if type(spec) ~= "table" or not spec.name or (tonumber(spec.count) or 1) <= 0 then return nil end
    return { name = J.resourceLocation(spec.name) or spec.name, count = floor(tonumber(spec.count) or 1) }
  end

  function K.init(mb, spec)
    local m = MACHINES[spec.type or spec.machine or ""]
    if not m then error("ccsim: unknown machine '" .. tostring(spec.type or spec.machine) .. "'", 0) end
    mb.m = m
    B.newBlock(spec, mb, m.o)
    local b = mb.block
    mb.energy = E.energyContainer(function() return B.maxEnergy(b, m.storage) end)
    mb.energy.stored = FL.create(min(tonumber(spec.energy) or 0, B.maxEnergy(b, m.storage)))
    mb.energyItem = stack(spec.energyItem)
    mb.tanks = {}
    mb.operatingTicks, mb.lastUsed, mb.processed = 0, 0, 0
    if m.separator then
      mb.slots = { "inputItem", "leftItem", "rightItem", "energyItem" }
      mb.water = E.tank(false, function() return 24000 end, function(n) return E.WATER[n] == true end)
      mb.left = E.tank(true, function() return 2400 end)
      mb.right = E.tank(true, function() return 2400 end)
      E.fill(mb.water, spec.water, "minecraft:water")
      E.fill(mb.left, spec.left, K.defaultFluid.left)
      E.fill(mb.right, spec.right, K.defaultFluid.right)
      mb.tanks = { water = mb.water, left = mb.left, right = mb.right }
      mb.dumpLeft = B.enumOf(J.ENUMS.GasMode, spec.leftDumpingMode, "IDLE", "dumping mode")
      mb.dumpRight = B.enumOf(J.ENUMS.GasMode, spec.rightDumpingMode, "IDLE", "dumping mode")
      -- one operation: 2 mB of water to 2 mB of hydrogen (left) and 1 mB of oxygen (right)
      mb.leftGas = J.resourceLocation(spec.leftGas or K.defaultFluid.left)
      mb.rightGas = J.resourceLocation(spec.rightGas or K.defaultFluid.right)
      mb.inputItem, mb.leftItem, mb.rightItem = stack(spec.inputItem), stack(spec.leftItem), stack(spec.rightItem)
    else
      mb.slots = { "input", "output", "energyItem" }
      mb.input, mb.output = stack(spec.input), stack(spec.output)
      mb.recipeOutput = spec.recipeOutput and (J.resourceLocation(spec.recipeOutput) or spec.recipeOutput)
      if m.infuser then
        mb.slots[#mb.slots + 1] = "infuseItem"
        mb.infuse = E.tank(true, function() return 1000 end)
        E.fill(mb.infuse, spec.infuse, K.defaultFluid.infuse)
        mb.tanks.infuse = mb.infuse
        mb.infusePerOperation = floor(tonumber(spec.infusePerOperation) or 10)
        mb.infuseItem = stack(spec.infuseItem)
      end
    end
    mb.after = B.after
  end

  local function usage(mb) return B.energyPerTick(mb.block, mb.m.usage) end
  local function ticksRequired(mb) return B.ticks(mb.block, mb.m.ticks or 1) end

  --- A processing machine's tick: a cached recipe, simplified to one input becoming one output.
  local function processTick(mb)
    local b = mb.block
    local outName = mb.recipeOutput or (mb.input and mb.input.name)
    local room = mb.input and (not mb.output or (mb.output.name == outName and mb.output.count < 64))
    local infuseOk = not mb.m.infuser or mb.infuse.amount >= mb.infusePerOperation
    local cost = usage(mb)
    if B.canFunction(b) and room and infuseOk and mb.energy.stored >= cost then
      b.active = true
      mb.energy:extract(cost)
      mb.lastUsed = cost
      mb.operatingTicks = mb.operatingTicks + 1
      if mb.operatingTicks >= ticksRequired(mb) then
        mb.operatingTicks = 0
        mb.input.count = mb.input.count - 1
        if mb.input.count <= 0 then mb.input = nil end
        if mb.output then mb.output.count = mb.output.count + 1 else mb.output = { name = outName, count = 1 } end
        if mb.m.infuser then E.shrink(mb.infuse, mb.infusePerOperation) end
        mb.processed = mb.processed + 1
      end
    else
      b.active = false
      mb.lastUsed = 0
    end
  end

  local function separatorTank(mb, tank, mode)
    if tank.amount <= 0 then return end
    if mode == "DUMPING" then
      E.shrink(tank, 8 * 2 ^ B.upgrades(mb.block, "SPEED"))
    elseif mode == "DUMPING_EXCESS" then
      local target = E.toLong(tank.cap() * C.dumpExcessKeepRatio)
      if target < tank.amount then E.shrink(tank, min(tank.amount - target, CHEMICAL_EJECT)) end
    end
  end

  local function separatorTick(mb)
    local b = mb.block
    local cost = usage(mb)
    local ops = 2 ^ B.upgrades(b, "SPEED")
    ops = min(ops, floor(mb.water.amount / 2), floor(E.needed(mb.left) / 2), E.needed(mb.right))
    if mb.left.amount > 0 and mb.left.name ~= mb.leftGas then ops = 0 end
    if mb.right.amount > 0 and mb.right.name ~= mb.rightGas then ops = 0 end
    if cost > 0 then ops = min(ops, floor(mb.energy.stored / cost)) end
    if B.canFunction(b) and ops > 0 then
      b.active = true
      E.shrink(mb.water, 2 * ops)
      E.insert(mb.left, mb.leftGas, 2 * ops)
      E.insert(mb.right, mb.rightGas, ops)
      mb.energy:extract(cost * ops)
      mb.lastUsed = FL.multiply(cost, ops)
      mb.processed = mb.processed + ops
    else
      b.active = false
      mb.lastUsed = 0
    end
    separatorTank(mb, mb.left, mb.dumpLeft)
    separatorTank(mb, mb.right, mb.dumpRight)
  end

  function K.tick(mb)
    if mb.m.separator then separatorTick(mb) else processTick(mb) end
  end

  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.energyInput)
    if r and r > 0 then mb.energy:insert(min(r, 1.8e19)) end
    if mb.m.separator then
      r = E.rate(s.waterInput)
      if r and r > 0 then E.insert(mb.water, "minecraft:water", r) end
      local ejecting = B.canFunction(mb.block) and B.ejects(mb.block, "GAS")
      for _, side in ipairs({ { "leftOutput", mb.left }, { "rightOutput", mb.right } }) do
        r = E.rate(s[side[1]])
        if ejecting and r and r > 0 then E.shrink(side[2], min(r, CHEMICAL_EJECT)) end
      end
    elseif mb.m.infuser then
      r = E.rate(s.infuseInput)
      if r and r > 0 then E.insert(mb.infuse, mb.infuse.name or K.defaultFluid.infuse, r) end
    end
    -- items: an ejecting item side sends the output away (to whatever is there)
    if not mb.m.separator and mb.output and B.canFunction(mb.block) and B.ejects(mb.block, "ITEM") then
      mb.ejected = (mb.ejected or 0) + mb.output.count
      mb.output = nil
    end
  end

  function K.redstoneLevel(mb) return slotsComparator(mb) end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    extra.energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), mb.energy:max())) end
    extra.input = function(v) mb.input = stack(v) end
    extra.output = function(v) mb.output = stack(v) end
    extra.recipeOutput = function(v) mb.recipeOutput = v and (J.resourceLocation(v) or v) end
    extra.leftDumpingMode = function(v) mb.dumpLeft = B.enumOf(J.ENUMS.GasMode, v, "IDLE", "dumping mode") end
    extra.rightDumpingMode = function(v) mb.dumpRight = B.enumOf(J.ENUMS.GasMode, v, "IDLE", "dumping mode") end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    local s = {
      energy = mb.energy.stored, maxEnergy = mb.energy:max(), energyUsage = mb.lastUsed, processed = mb.processed,
      progress = mb.operatingTicks, ejected = mb.ejected,
    }
    if mb.m.separator then
      s.water, s.left, s.right = E.tankState(mb.water), E.tankState(mb.left), E.tankState(mb.right)
    else
      s.input, s.output = mb.input, mb.output
      if mb.infuse then s.infuse = E.tankState(mb.infuse) end
    end
    return B.state(mb, s)
  end

  -- ===== computer methods =====

  local function energyUsage(c) return c.mb.block.active and usage(c.mb) or 0 end
  local ELECTRIC = {
    getInput = B.slot(function(mb) return mb.input end),
    getOutput = B.slot(function(mb) return mb.output end),
    getEnergyItem = B.slot(function(mb) return mb.energyItem end),
    getEnergyUsage = { {}, energyUsage },
    getRecipeProgress = { {}, function(c) return c.mb.operatingTicks end },
    getTicksRequired = { {}, function(c) return ticksRequired(c.mb) end },
  }
  local INFUSER = {}
  for k, v in pairs(ELECTRIC) do INFUSER[k] = v end
  E.tankMethods(INFUSER, "InfuseType", function(mb) return mb.infuse end)
  INFUSER.getInfuseType = { {}, function(c)
    local t = c.mb.infuse
    if t.amount <= 0 then return { name = "mekanism:empty_infuse_type", amount = 0 } end
    return { name = t.name, amount = t.amount }
  end }
  INFUSER.getInfuseTypeItem = B.slot(function(mb) return mb.infuseItem end)
  INFUSER.dumpInfuseType = E.void({}, function(c) B.requirePublic(c.mb.block); E.setAmount(c.mb.infuse, 0) end)

  local SEPARATOR = {
    getInputItem = B.slot(function(mb) return mb.inputItem end),
    getLeftOutputItem = B.slot(function(mb) return mb.leftItem end),
    getRightOutputItem = B.slot(function(mb) return mb.rightItem end),
    getEnergyItem = B.slot(function(mb) return mb.energyItem end),
    getEnergyUsage = { {}, function(c) return c.mb.lastUsed end }, -- the energy the last tick's operations used
    getLeftOutputDumpingMode = { {}, function(c) return c.mb.dumpLeft end },
    getRightOutputDumpingMode = { {}, function(c) return c.mb.dumpRight end },
  }
  E.tankMethods(SEPARATOR, "Input", function(mb) return mb.water end)
  E.tankMethods(SEPARATOR, "LeftOutput", function(mb) return mb.left end)
  E.tankMethods(SEPARATOR, "RightOutput", function(mb) return mb.right end)
  local MODES = J.ENUMS.GasMode
  for _, side in ipairs({ { "Left", "dumpLeft" }, { "Right", "dumpRight" } }) do
    local field = side[2]
    SEPARATOR["set" .. side[1] .. "OutputDumpingMode"] = E.void({ "GasMode" }, function(c, m)
      B.requirePublic(c.mb.block)
      c.mb[field] = m
    end)
    SEPARATOR["increment" .. side[1] .. "OutputDumpingMode"] = E.void({}, function(c)
      B.requirePublic(c.mb.block)
      c.mb[field] = E.cycle(MODES, c.mb[field], 1)
    end)
    SEPARATOR["decrement" .. side[1] .. "OutputDumpingMode"] = E.void({}, function(c)
      B.requirePublic(c.mb.block)
      c.mb[field] = E.cycle(MODES, c.mb[field], -1)
    end)
  end

  K.types = {}
  for name, m in pairs(MACHINES) do
    local own = m.separator and SEPARATOR or (m.infuser and INFUSER or ELECTRIC)
    K.types[name] = {
      groups = B.groups(B.tileMethods(own, m.o), m.o),
      newBlock = function(_, mb) return mb.block end,
      blockState = function(c, s) B.state(c.mb, s) end,
    }
  end
  return K
end
