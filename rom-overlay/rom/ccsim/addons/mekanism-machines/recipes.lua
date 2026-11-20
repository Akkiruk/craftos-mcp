-- ccsim addons/mekanism-machines/recipes: the other recipe machines, on one engine (see engine.lua, blocks.lua):
-- Precision Sawmill, Osmium Compressor, Purification Chamber, Chemical Injection Chamber, Combiner, Pressurized
-- Reaction Chamber, Chemical Crystallizer, Chemical Dissolution Chamber, Chemical Infuser, Chemical Oxidizer,
-- Chemical Washer, Rotary Condensentrator, Isotopic Centrifuge, Nutritional Liquifier, Antiprotonic
-- Nucleosynthesizer, Pigment Extractor, Pigment Mixer, Painting Machine, Solar Neutron Activator.
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/prefab/TileEntityProgressMachine (getRecipeProgress, getTicksRequired = getTicks(base)),
--   tile/prefab/TileEntityAdvancedElectricMachine (210 mB gas, constant per-tick gas use spread over the operation,
--   statistical for purifying and injecting; config ITEM with extra, GAS, ENERGY), tile/machine/TileEntityPrecisionSawmill,
--   TileEntityCombiner, TileEntityPressurizedReactionChamber (10000 mB tanks, duration and extra energy from the
--   recipe), TileEntityChemicalCrystallizer, TileEntityChemicalDissolutionChamber (100 ticks), TileEntityChemicalInfuser,
--   TileEntityChemicalOxidizer (100 ticks), TileEntityChemicalWasher, TileEntityRotaryCondensentrator (mode:
--   isCondensentrating = !mode), TileEntityIsotopicCentrifuge, TileEntityNutritionalLiquifier (100 ticks),
--   TileEntityAntiprotonicNucleosynthesizer (400 ticks, MUFFLING only), TileEntityPigmentExtractor (100 ticks, 20000 mB),
--   TileEntityPigmentMixer (1000 / 1000 / 2000 mB), TileEntityPaintingMachine (15000 mB), TileEntitySolarNeutronActivator
--   (peak = maxSolarNeutronActivatorRate × (1 + 0.3 × (0.8 − temperature) − 0.3 × downfall), × sun brightness, × 0.2
--   in rain; below 1 one operation every ceil(1 / rate) ticks) — each constructor's side config and ejector, and
--   getEnergyUsage (progress machines: the energy per tick while active; the others: the energy used last tick);
--   their recipe machines run 2^speed operations a tick (setBaselineMaxOperations). config/UsageConfig and
--   StorageConfig: the pack's machine-usage.toml and machine-storage.toml.
-- Recipes are fixtures (`recipe`): what one operation takes and gives, defaulting to a common recipe of each machine.
return function(E)
  local B, J, FL = E.B, E.J, E.FL
  local floor, min, max, ceil, cos, pi = math.floor, math.min, math.max, math.ceil, math.cos, math.pi

  -- ===== the sky (vanilla, as ../mekanism-generators/generators.lua has it) =====
  if not E.skyDarken then
    local function timeOfDay(dayTime)
      local d0 = dayTime / 24000 - 0.25
      d0 = d0 - floor(d0)
      local d1 = 0.5 - cos(d0 * pi) / 2
      return (d0 * 2 + d1) / 3
    end
    local function rainLevel() return E.sky.raining and 1 or 0 end
    local function thunderLevel() return (E.sky.raining and E.sky.thundering) and 1 or 0 end
    E.skyDarken = function()
      local d0 = 1 - rainLevel() * 5 / 16
      local d1 = 1 - thunderLevel() * 5 / 16
      local d2 = 0.5 + 2 * max(-0.25, min(0.25, cos(timeOfDay(E.sky.dayTime) * pi * 2)))
      return E.toInt((1 - d2 * d0 * d1) * 11)
    end
    E.sunBrightness = function()
      local f1 = 1 - (cos(timeOfDay(E.sky.dayTime) * pi * 2) * 2 + 0.2)
      f1 = 1 - max(0, min(1, f1))
      f1 = f1 * (1 - rainLevel() * 5 / 16)
      f1 = f1 * (1 - thunderLevel() * 5 / 16)
      return f1 * 0.8 + 0.2
    end
  end

  local U3, U4, MUFFLING = { "SPEED", "ENERGY", "MUFFLING" }, { "SPEED", "ENERGY", "MUFFLING", "GAS" }, { "MUFFLING" }
  local cfg = B.cfg
  local function eject(c) c.ejecting = true return c end

  -- A machine: usage / storage (J), ticks (progress machines) or none (2^speed operations a tick), upgrades,
  -- slots (comparator order), tanks { name = { kind, cap, default } }, config, ins / outs (what an operation uses
  -- and makes: { slot | tank, amount, name, perTick = "constant" | "statistical" }), methods (the tile's own).
  local M = {}
  M.precisionSawmill = { usage = 50, storage = 20000, ticks = 200, upgrades = U3,
    slots = { "input", "output", "secondaryOutput", "energyItem" },
    config = { cfg.itemIO(), cfg.input("ENERGY") },
    ins = { { slot = "input", amount = 1 } },
    outs = { { slot = "output", name = "minecraft:oak_planks", amount = 6 }, { slot = "secondaryOutput", name = "mekanism:sawdust", amount = 1, chance = 0.25 } },
    items = { getInput = "input", getOutput = "output", getSecondaryOutput = "secondaryOutput", getEnergyItem = "energyItem" } }
  local function advanced(usage, storage, upgrades, gas, statistical)
    return { usage = usage, storage = storage, ticks = 200, upgrades = upgrades,
      slots = { "input", "chemicalItem", "output", "energyItem" },
      tanks = { chemical = { kind = "GAS", cap = 210, default = gas } },
      config = { cfg.itemIO(true), cfg.input("GAS"), cfg.input("ENERGY") },
      ins = { { slot = "input", amount = 1 }, { tank = "chemical", amount = 1, perTick = statistical and "statistical" or "constant" } },
      outs = { { slot = "output", amount = 1 } },
      items = { getInput = "input", getOutput = "output", getChemicalItem = "chemicalItem", getEnergyItem = "energyItem" },
      tankMethods = { Chemical = "chemical" }, dump = { dumpChemical = "chemical" } }
  end
  M.osmiumCompressor = advanced(100, 80000, U3, "mekanism:osmium", false)
  M.purificationChamber = advanced(200, 80000, U4, "mekanism:oxygen", true)
  M.chemicalInjectionChamber = advanced(400, 160000, U4, "mekanism:hydrogen_chloride", true)
  M.combiner = { usage = 50, storage = 40000, ticks = 200, upgrades = U3,
    slots = { "mainInput", "secondaryInput", "output", "energyItem" },
    config = { cfg.itemIO(true), cfg.input("ENERGY") },
    ins = { { slot = "mainInput", amount = 8 }, { slot = "secondaryInput", amount = 1 } },
    outs = { { slot = "output", amount = 1 } },
    items = { getMainInput = "mainInput", getSecondaryInput = "secondaryInput", getOutput = "output", getEnergyItem = "energyItem" } }
  M.pressurizedReactionChamber = { usage = 5, storage = 2000, ticks = 100, upgrades = U3,
    slots = { "inputItem", "outputItem", "energyItem" },
    tanks = { inputFluid = { kind = "FLUID", cap = 10000, default = "minecraft:water" },
      inputGas = { kind = "GAS", cap = 10000, default = "mekanism:hydrogen" },
      outputGas = { kind = "GAS", cap = 10000, default = "mekanism:ethene" } },
    config = { cfg.itemIO(), cfg.input("ENERGY"), cfg.input("FLUID"), eject(cfg.io("GAS", "RIGHT")) },
    ins = { { slot = "inputItem", amount = 2 }, { tank = "inputFluid", amount = 10 }, { tank = "inputGas", amount = 100 } },
    outs = { { slot = "outputItem", name = "mekanism:substrate", amount = 1 } },
    items = { getInputItem = "inputItem", getOutputItem = "outputItem", getEnergyItem = "energyItem" },
    tankMethods = { InputFluid = "inputFluid", InputGas = "inputGas", OutputGas = "outputGas" } }
  -- the crystallizer's input is a merged tank: gas, infusion, pigment or slurry
  M.chemicalCrystallizer = { usage = 400, storage = 160000, ticks = 200, upgrades = U3,
    slots = { "inputItem", "output", "energyItem" },
    tanks = { input = { kind = "SLURRY", cap = 10000, default = "mekanism:clean_iron" } },
    config = { cfg.itemIO(), cfg.input("ENERGY"), cfg.input("GAS"), cfg.input("INFUSION"), cfg.input("PIGMENT"), cfg.input("SLURRY") },
    ins = { { tank = "input", amount = 200 } },
    outs = { { slot = "output", name = "mekanism:crystal_iron", amount = 1 } },
    items = { getInputItem = "inputItem", getOutput = "output", getEnergyItem = "energyItem" },
    tankMethods = { Input = "input" } }
  M.chemicalDissolutionChamber = { usage = 400, storage = 160000, ticks = 100, upgrades = U4,
    slots = { "inputGasItem", "inputItem", "outputItem", "energyItem" },
    tanks = { gasInput = { kind = "GAS", cap = 10000, default = "mekanism:sulfuric_acid" },
      output = { kind = "SLURRY", cap = 10000, default = "mekanism:dirty_iron" } },
    config = { cfg.itemIO(true), eject(cfg.io("GAS", "RIGHT")), cfg.output("INFUSION", "RIGHT"), cfg.output("PIGMENT", "RIGHT"),
      cfg.output("SLURRY", "RIGHT"), cfg.input("ENERGY") },
    ins = { { slot = "inputItem", amount = 1 }, { tank = "gasInput", amount = 1, perTick = "statistical" } },
    outs = { { tank = "output", amount = 1000 } },
    items = { getInputGasItem = "inputGasItem", getInputItem = "inputItem", getOutputItem = "outputItem", getEnergyItem = "energyItem" },
    tankMethods = { GasInput = "gasInput", Output = "output" } }
  M.chemicalInfuser = { usage = 200, storage = 80000, upgrades = U3,
    slots = { "leftInputItem", "outputItem", "rightInputItem", "energyItem" },
    tanks = { leftInput = { kind = "GAS", cap = 10000, default = "mekanism:hydrogen" },
      rightInput = { kind = "GAS", cap = 10000, default = "mekanism:chlorine" },
      output = { kind = "GAS", cap = 10000, default = "mekanism:hydrogen_chloride" } },
    config = { cfg.twoInputs("ITEM", true), cfg.twoInputs("GAS", false, true), cfg.input("ENERGY") },
    ins = { { tank = "leftInput", amount = 1 }, { tank = "rightInput", amount = 1 } },
    outs = { { tank = "output", amount = 1 } },
    items = { getLeftInputItem = "leftInputItem", getOutputItem = "outputItem", getRightInputItem = "rightInputItem", getEnergyItem = "energyItem" },
    tankMethods = { LeftInput = "leftInput", RightInput = "rightInput", Output = "output" } }
  M.chemicalOxidizer = { usage = 200, storage = 80000, ticks = 100, upgrades = U3,
    slots = { "input", "outputItem", "energyItem" },
    tanks = { output = { kind = "GAS", cap = 10000, default = "mekanism:sulfur_dioxide" } },
    config = { cfg.itemIO(), cfg.output("GAS", "RIGHT"), cfg.input("ENERGY") },
    ins = { { slot = "input", amount = 1 } },
    outs = { { tank = "output", amount = 100 } },
    items = { getInput = "input", getOutputItem = "outputItem", getEnergyItem = "energyItem" },
    tankMethods = { Output = "output" } }
  M.chemicalWasher = { usage = 200, storage = 80000, upgrades = U3,
    slots = { "fluidItemInput", "outputItem", "fluidItemOutput", "energyItem" },
    tanks = { fluid = { kind = "FLUID", cap = 10000, default = "minecraft:water" },
      slurryInput = { kind = "SLURRY", cap = 10000, default = "mekanism:dirty_iron" },
      slurryOutput = { kind = "SLURRY", cap = 10000, default = "mekanism:clean_iron" } },
    config = { cfg.itemIO(), eject(cfg.io("SLURRY", "RIGHT")), cfg.input("FLUID"), cfg.input("ENERGY") },
    ins = { { tank = "fluid", amount = 5 }, { tank = "slurryInput", amount = 1 } },
    outs = { { tank = "slurryOutput", amount = 1 } },
    items = { getFluidItemInput = "fluidItemInput", getFluidItemOutput = "fluidItemOutput", getOutputItem = "outputItem", getEnergyItem = "energyItem" },
    tankMethods = { Fluid = "fluid", SlurryInput = "slurryInput", SlurryOutput = "slurryOutput" } }
  M.rotaryCondensentrator = { usage = 50, storage = 20000, upgrades = U3, rotary = true,
    slots = { "gasItemInput", "gasItemOutput", "fluidItemInput", "fluidItemOutput", "energyItem" },
    tanks = { gas = { kind = "GAS", cap = 10000, default = "mekanism:hydrogen" },
      fluid = { kind = "FLUID", cap = 10000, default = "mekanism:hydrogen" } },
    config = { cfg.itemIO(), eject(cfg.io("GAS", "LEFT")), eject(cfg.io("FLUID", "RIGHT")), cfg.input("ENERGY") },
    ins = { { tank = "gas", amount = 1 } }, outs = { { tank = "fluid", amount = 1 } },
    items = { getGasItemInput = "gasItemInput", getGasItemOutput = "gasItemOutput", getFluidItemInput = "fluidItemInput",
      getFluidItemOutput = "fluidItemOutput", getEnergyItem = "energyItem" },
    tankMethods = { Gas = "gas", Fluid = "fluid" } }
  M.isotopicCentrifuge = { usage = 200, storage = 80000, upgrades = U3, disabledSides = { "TOP" },
    slots = { "inputItem", "outputItem", "energyItem" },
    tanks = { input = { kind = "GAS", cap = 10000, default = "mekanism:uranium_hexafluoride" },
      output = { kind = "GAS", cap = 10000, default = "mekanism:fissile_fuel" } },
    config = { cfg.itemIO(), eject(cfg.io("GAS", "FRONT")), cfg.input("ENERGY") },
    ins = { { tank = "input", amount = 1 } }, outs = { { tank = "output", amount = 1 } },
    items = { getInputItem = "inputItem", getOutputItem = "outputItem", getEnergyItem = "energyItem" },
    tankMethods = { Input = "input", Output = "output" } }
  M.nutritionalLiquifier = { usage = 200, storage = 40000, ticks = 100, upgrades = U3,
    slots = { "input", "containerFillItem", "outputItem", "energyItem" },
    tanks = { output = { kind = "FLUID", cap = 10000, default = "mekanism:nutritional_paste" } },
    config = { cfg.itemIO(), cfg.output("FLUID", "RIGHT"), cfg.input("ENERGY") },
    ins = { { slot = "input", amount = 1 } }, outs = { { tank = "output", amount = 200 } },
    items = { getInput = "input", getContainerFillItem = "containerFillItem", getOutputItem = "outputItem", getEnergyItem = "energyItem" },
    tankMethods = { Output = "output" } }
  if E.J.V21 then
    -- 10.7: a separate slot for the filled containers (getContainerOutputItem); getOutputItem is the item output
    local m = M.nutritionalLiquifier
    m.slots = { "input", "containerFillItem", "outputItem", "containerOutputItem", "energyItem" }
    m.items.getContainerOutputItem = "containerOutputItem"
  end
  M.antiprotonicNucleosynthesizer = { usage = 100000, storage = 1000000000, ticks = 400, upgrades = MUFFLING,
    slots = { "inputItem", "inputChemicalItem", "outputItem", "energyItem" },
    tanks = { inputChemical = { kind = "GAS", cap = 10000, default = "mekanism:antimatter" } },
    config = { cfg.itemIO(true), cfg.input("GAS"), cfg.input("ENERGY") },
    ins = { { slot = "inputItem", amount = 1 }, { tank = "inputChemical", amount = 1 } },
    outs = { { slot = "outputItem", amount = 1 } },
    items = { getInputChemicalItem = "inputChemicalItem", getInputItem = "inputItem", getOutputItem = "outputItem", getEnergyItem = "energyItem" },
    tankMethods = { InputChemical = "inputChemical" } }
  M.pigmentExtractor = { usage = 200, storage = 40000, ticks = 100, upgrades = U3,
    slots = { "input", "outputItem", "energyItem" },
    tanks = { output = { kind = "PIGMENT", cap = 20000, default = "mekanism:white" } },
    config = { cfg.itemIO(), cfg.output("PIGMENT", "RIGHT"), cfg.input("ENERGY") },
    ins = { { slot = "input", amount = 1 } }, outs = { { tank = "output", amount = 256 } },
    items = { getInput = "input", getOutputItem = "outputItem", getEnergyItem = "energyItem" },
    tankMethods = { Output = "output" } }
  M.pigmentMixer = { usage = 200, storage = 80000, upgrades = U3,
    slots = { "leftInputItem", "outputItem", "rightInputItem", "energyItem" },
    tanks = { leftInput = { kind = "PIGMENT", cap = 1000, default = "mekanism:white" },
      rightInput = { kind = "PIGMENT", cap = 1000, default = "mekanism:black" },
      output = { kind = "PIGMENT", cap = 2000, default = "mekanism:gray" } },
    config = { cfg.twoInputs("ITEM", true), cfg.twoInputs("PIGMENT", false, true), cfg.input("ENERGY") },
    ins = { { tank = "leftInput", amount = 1 }, { tank = "rightInput", amount = 1 } }, outs = { { tank = "output", amount = 2 } },
    items = { getLeftInputItem = "leftInputItem", getOutputItem = "outputItem", getRightInputItem = "rightInputItem", getEnergyItem = "energyItem" },
    tankMethods = { LeftInput = "leftInput", RightInput = "rightInput", Output = "output" } }
  M.paintingMachine = { usage = 100, storage = 40000, ticks = 200, upgrades = U3,
    slots = { "inputPigmentItem", "inputItem", "output", "energyItem" },
    tanks = { pigmentInput = { kind = "PIGMENT", cap = 15000, default = "mekanism:white" } },
    config = { cfg.itemIO(true), cfg.input("PIGMENT"), cfg.input("ENERGY") },
    ins = { { slot = "inputItem", amount = 1 }, { tank = "pigmentInput", amount = 256 } }, outs = { { slot = "output", amount = 1 } },
    items = { getInputPigmentItem = "inputPigmentItem", getInputItem = "inputItem", getOutput = "output", getEnergyItem = "energyItem" },
    tankMethods = { PigmentInput = "pigmentInput" } }
  M.solarNeutronActivator = { solar = true, noEnergy = true, disabledSides = { "TOP" },
    slots = { "inputItem", "outputItem" },
    tanks = { input = { kind = "GAS", cap = 10000, default = "mekanism:lithium" },
      output = { kind = "GAS", cap = 10000, default = "mekanism:tritium" } },
    config = { cfg.io("ITEM", "FRONT"), eject(cfg.io("GAS", "FRONT")) },
    ins = { { tank = "input", amount = 1 } }, outs = { { tank = "output", amount = 1 } },
    items = { getInputItem = "inputItem", getOutputItem = "outputItem" },
    tankMethods = { Input = "input", Output = "output" } }

  local SNA_MAX_RATE = 64 -- general.maxSolarNeutronActivatorRate

  local K = { kind = "recipeMachine" }
  -- rates: energyInput, and <tank>Input / <tank>Output for every tank
  K.rates = setmetatable({ energyInput = true }, { __index = function(_, k)
    return type(k) == "string" and (k:match("Input$") or k:match("Output$")) and true or nil
  end })
  B.kindDefaults(K)
  K.defaultFluid = {}

  local function optionsOf(m)
    local o = {
      directional = true, redstone = true, upgrades = m.upgrades, ejector = true, config = m.config,
      disabledSides = m.disabledSides,
    }
    if not m.noEnergy then o.energy = function(mb) return { mb.energy } end end
    o.comparator = function(mb)
      local stacks = {}
      for i, s in ipairs(m.slots) do stacks[i] = mb.items[s] or false end
      local count, limit = 0, 0
      for _, s in ipairs(stacks) do count = count + (s and s.count or 0); limit = limit + 64 end
      return E.redstoneLevel(count, limit)
    end
    return o
  end

  --- The fixture's recipe: ins and outs with the fixture's amounts and names, duration and extra energy.
  local function recipeOf(m, spec)
    local r = type(spec.recipe) == "table" and spec.recipe or {}
    local out = { ins = {}, outs = {}, duration = tonumber(r.duration), energy = tonumber(r.energy) or 0 }
    for _, list in ipairs({ { m.ins, out.ins }, { m.outs, out.outs } }) do
      for i, d in ipairs(list[1]) do
        local key = d.slot or d.tank
        local v = r[key]
        local e = { slot = d.slot, tank = d.tank, amount = d.amount, name = d.name, chance = d.chance, perTick = d.perTick }
        if type(v) == "number" then e.amount = v
        elseif type(v) == "table" then
          e.amount = tonumber(v.amount or v.count) or e.amount
          e.name = v.name and (J.resourceLocation(v.name) or v.name) or e.name
          e.chance = tonumber(v.chance) or e.chance
        elseif v == false then e.amount = 0 end
        list[2][i] = e
      end
    end
    return out
  end

  function K.init(mb, spec)
    local def = K.types[spec.type]
    if not def then error("ccsim: unknown machine '" .. tostring(spec.type) .. "'", 0) end
    local m = def.m
    mb.m = m
    B.newBlock(spec, mb, def.o)
    local b = mb.block
    if not m.noEnergy then
      mb.energy = E.energyContainer(function() return B.maxEnergy(b, m.storage) end)
      mb.energy.stored = FL.create(min(tonumber(spec.energy) or 0, B.maxEnergy(b, m.storage)))
    end
    mb.items = {}
    for _, s in ipairs(m.slots) do mb.items[s] = B.stack(spec[s]) end
    mb.tanks = {}
    local defaults = {}
    mb.K = setmetatable({ defaultFluid = defaults }, { __index = K }) -- each machine its own tank defaults (mekAddTank)
    for name, t in pairs(m.tanks or {}) do
      local tank = E.tank(t.kind ~= "FLUID", function() return t.cap end)
      tank.kind = t.kind
      E.fill(tank, spec[name], t.default)
      mb.tanks[name] = tank
      tank.default = t.default
      tank.inputKey, tank.outputKey = name .. "Input", name .. "Output"
      defaults[name] = t.default
    end
    mb.recipe = recipeOf(m, spec)
    mb.operatingTicks, mb.lastUsage, mb.processed, mb.usedSoFar, mb.carry = 0, 0, 0, 0, 0
    if m.rotary then mb.mode = spec.condensentrating == false end -- mode true: decondensentrating (fluid to gas)
    if m.solar then
      mb.canSeeSky = spec.canSeeSky ~= false
      mb.biomeTemperature = tonumber(spec.biomeTemperature) or 0.8
      mb.downfall = tonumber(spec.downfall) or 0.4
      mb.precipitation = spec.precipitation ~= false
      mb.peak = SNA_MAX_RATE * (1 + 0.3 * (0.8 - mb.biomeTemperature) + (mb.precipitation and -0.3 * mb.downfall or 0))
      mb.productionRate = 0
    end
    mb.after = B.after
  end

  local function ticksRequired(mb)
    return B.ticks(mb.block, mb.recipe.duration or mb.m.ticks or 1)
  end
  local function perTick(mb)
    if mb.m.noEnergy then return 0 end
    return B.energyPerTick(mb.block, mb.m.usage + mb.recipe.energy)
  end

  --- The ins and outs of this tick: the rotary condensentrator swaps them in decondensentrating mode.
  local function flow(mb)
    if mb.m.rotary and mb.mode then
      return { { tank = "fluid", amount = mb.recipe.ins[1].amount } }, { { tank = "gas", amount = mb.recipe.outs[1].amount } }
    end
    return mb.recipe.ins, mb.recipe.outs
  end

  local function available(mb, e)
    if e.slot then
      local s = mb.items[e.slot]
      if e.amount <= 0 then return math.huge end
      if not s or (e.name and s.name ~= e.name) then return 0 end
      return floor(s.count / e.amount)
    end
    local t = mb.tanks[e.tank]
    if e.amount <= 0 then return math.huge end
    if t.amount <= 0 or (e.name and t.name ~= e.name) then return 0 end
    return floor(t.amount / e.amount)
  end
  local function outName(mb, e, ins)
    if e.name then return e.name end
    if e.slot then
      local src = ins[1] and ins[1].slot and mb.items[ins[1].slot]
      return src and src.name or "minecraft:air"
    end
    local t = mb.tanks[e.tank]
    if t.name then return t.name end
    local src = ins[1] and ins[1].tank and mb.tanks[ins[1].tank]
    if mb.m.rotary and src then return src.name end
    return t.default
  end
  local function room(mb, e, name)
    if e.amount <= 0 then return math.huge end
    if e.slot then
      local s = mb.items[e.slot]
      if not s then return floor(64 / e.amount) end
      if s.name ~= name then return 0 end
      return floor((64 - s.count) / e.amount)
    end
    local t = mb.tanks[e.tank]
    if t.amount > 0 and t.name ~= name then return 0 end
    return floor(E.needed(t) / e.amount)
  end
  local function take(mb, e, ops)
    if e.amount <= 0 then return end
    if e.slot then
      local s = mb.items[e.slot]
      s.count = s.count - e.amount * ops
      if s.count <= 0 then mb.items[e.slot] = nil end
    else
      E.shrink(mb.tanks[e.tank], e.amount * ops)
    end
  end
  local function give(mb, e, name, ops)
    if e.amount <= 0 then return end
    local n = e.amount * ops
    if e.chance and e.chance < 1 then
      n = 0
      for _ = 1, ops do if E.rand() <= e.chance then n = n + e.amount end end
      if n == 0 then return end
    end
    if e.slot then
      local s = mb.items[e.slot]
      if s then s.count = s.count + n else mb.items[e.slot] = { name = name, count = n } end
    else
      E.insert(mb.tanks[e.tank], name, n)
    end
  end

  --- This tick's per-tick chemical: the constant multiplier or the statistical mean (its fraction carried).
  local function perTickChemical(mb, e)
    local b = mb.block
    if e.perTick == "statistical" then
      local mean = B.MAX_UPGRADE_MULTIPLIER ^ (2 * B.upgrades(b, "SPEED") / 8 - B.upgrades(b, "GAS") / 8)
      local want = mean * e.amount + mb.carry
      local n = floor(want)
      return n, want - n, 0
    end
    local base = mb.m.ticks or 200
    local baseRemaining = base - mb.usedSoFar
    local remainingTicks = ticksRequired(mb) - mb.operatingTicks
    local m
    if baseRemaining < remainingTicks then m = 0
    elseif baseRemaining == remainingTicks then m = 1
    else m = max(E.toLong(baseRemaining / remainingTicks), 0) end
    return m * e.amount, 0, m
  end

  local function progressTick(mb)
    local b = mb.block
    local ins, outs = flow(mb)
    local ok = B.canFunction(b)
    local perTickIn
    for _, e in ipairs(ins) do
      if e.perTick then perTickIn = e
      elseif ok and available(mb, e) < 1 then ok = false end
    end
    if not ok then
      b.active = false
      return
    end
    for _, e in ipairs(outs) do
      if ok and not e.chance and room(mb, e, outName(mb, e, ins)) < 1 then ok = false end
    end
    local cost = perTick(mb)
    if ok and mb.energy.stored < cost then ok = false end
    local need, carry, mult = 0, 0, 0
    if ok and perTickIn then
      need, carry, mult = perTickChemical(mb, perTickIn)
      local t = mb.tanks[perTickIn.tank]
      if need > t.amount then ok = false end
    end
    if not ok then
      b.active = false
      return
    end
    b.active = true
    mb.energy:extract(cost)
    if perTickIn then
      E.shrink(mb.tanks[perTickIn.tank], need)
      mb.carry, mb.usedSoFar = carry, mb.usedSoFar + mult
    end
    mb.operatingTicks = mb.operatingTicks + 1
    if mb.operatingTicks >= ticksRequired(mb) then
      mb.operatingTicks, mb.usedSoFar = 0, 0
      local names = {}
      for i, e in ipairs(outs) do names[i] = outName(mb, e, ins) end
      for _, e in ipairs(ins) do if not e.perTick then take(mb, e, 1) end end
      for i, e in ipairs(outs) do
        if not e.chance or room(mb, e, names[i]) >= 1 then give(mb, e, names[i], 1) end
      end
      mb.processed = mb.processed + 1
    end
  end

  --- SNA: WorldUtils.canSeeSun and the sun's brightness, 80 % less in rain.
  local function snaRate(mb)
    if not B.canFunction(mb.block) or not mb.canSeeSky or E.skyDarken() >= 4 then return 0 end
    local p = mb.peak * E.sunBrightness()
    if mb.precipitation and (E.sky.raining or E.sky.thundering) then p = p * 0.2 end
    return p
  end

  local function recipeTick(mb)
    local b = mb.block
    local ins, outs = flow(mb)
    local ops, required = 2 ^ B.upgrades(b, "SPEED"), 1
    if mb.m.solar then
      local rate = snaRate(mb)
      mb.productionRate = rate
      if rate > 0 and rate < 1 then ops, required = 1, ceil(1 / rate) else ops = E.toInt(rate) end
    end
    if not B.canFunction(b) then ops = 0 end
    for _, e in ipairs(ins) do
      if ops <= 0 then break end
      ops = min(ops, available(mb, e))
    end
    if ops <= 0 then
      b.active, mb.lastUsage = false, 0
      return
    end
    local names = {}
    for i, e in ipairs(outs) do
      names[i] = outName(mb, e, ins)
      ops = min(ops, room(mb, e, names[i]))
    end
    local cost = perTick(mb)
    if cost > 0 then ops = min(ops, floor(mb.energy.stored / cost)) end
    if ops <= 0 then
      b.active, mb.lastUsage = false, 0
      return
    end
    b.active = true
    if required > 1 then
      mb.operatingTicks = mb.operatingTicks + 1
      if mb.operatingTicks < required then mb.lastUsage = 0 return end
      mb.operatingTicks = 0
    end
    for _, e in ipairs(ins) do take(mb, e, ops) end
    for i, e in ipairs(outs) do give(mb, e, names[i], ops) end
    if cost > 0 then
      mb.energy:extract(cost * ops)
      mb.lastUsage = FL.multiply(cost, ops)
    end
    mb.processed = mb.processed + ops
  end

  function K.tick(mb)
    if mb.m.ticks then progressTick(mb) else recipeTick(mb) end
  end

  local CONFIG_OF = { GAS = "GAS", INFUSION = "INFUSION", PIGMENT = "PIGMENT", SLURRY = "SLURRY", FLUID = "FLUID" }
  function K.transfer(mb)
    local s = mb.spec
    if mb.energy then
      local r = E.rate(s.energyInput)
      if r and r > 0 then mb.energy:insert(min(r, 1.8e19)) end
    end
    for _, t in pairs(mb.tanks) do
      local r = E.rate(s[t.inputKey])
      if r and r > 0 then E.insert(t, t.name or t.default, r) end
      r = E.rate(s[t.outputKey])
      if r and r > 0 and t.amount > 0 and B.canFunction(mb.block) and B.ejects(mb.block, CONFIG_OF[t.kind]) then
        E.shrink(t, min(r, 1024))
      end
    end
    if B.canFunction(mb.block) and B.ejects(mb.block, "ITEM") then
      for _, e in ipairs(mb.recipe.outs) do
        if e.slot and mb.items[e.slot] then
          mb.ejected = (mb.ejected or 0) + mb.items[e.slot].count
          mb.items[e.slot] = nil
        end
      end
    end
  end

  function K.redstoneLevel(mb) return mb.block.o.comparator(mb) end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    extra.energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), mb.energy:max())) end
    extra.recipe = function(v) mb.recipe = recipeOf(mb.m, { recipe = v }) end
    extra.condensentrating = function(v) mb.mode = v == false end
    for _, sname in ipairs(mb.m.slots) do extra[sname] = function(v) mb.items[sname] = B.stack(v) end end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    local s = { processed = mb.processed, progress = mb.operatingTicks, ejected = mb.ejected, items = {}, tanks = {} }
    if mb.energy then s.energy, s.maxEnergy = mb.energy.stored, mb.energy:max() end
    s.energyUsage = mb.m.ticks and (mb.block.active and perTick(mb) or 0) or mb.lastUsage
    for k, v in pairs(mb.items) do s.items[k] = { name = v.name, count = v.count } end
    for k, t in pairs(mb.tanks) do s.tanks[k] = E.tankState(t) end
    if mb.m.solar then s.productionRate = mb.productionRate end
    if mb.m.rotary then s.condensentrating = not mb.mode end
    return B.state(mb, s)
  end

  -- ===== computer methods =====

  local function own(m)
    local t = {}
    for method, slot in pairs(m.items or {}) do t[method] = B.slot(function(mb) return mb.items[slot] end) end
    for prefix, tank in pairs(m.tankMethods or {}) do E.tankMethods(t, prefix, function(mb) return mb.tanks[tank] end) end
    for method, tank in pairs(m.dump or {}) do
      t[method] = E.void({}, function(c) B.requirePublic(c.mb.block); E.setAmount(c.mb.tanks[tank], 0) end)
    end
    if m.ticks then
      t.getRecipeProgress = { {}, function(c) return c.mb.operatingTicks end }
      t.getTicksRequired = { {}, function(c) return ticksRequired(c.mb) end }
      t.getEnergyUsage = { {}, function(c) return c.mb.block.active and perTick(c.mb) or 0 end }
    elseif not m.noEnergy then
      t.getEnergyUsage = { {}, function(c) return c.mb.lastUsage end }
    end
    if m.rotary then
      t.isCondensentrating = { {}, function(c) return not c.mb.mode end }
      t.setCondensentrating = E.void({ "boolean" }, function(c, v)
        B.requirePublic(c.mb.block)
        c.mb.mode = v
      end)
    end
    if m.solar then
      t.getPeakProductionRate = { {}, function(c) return c.mb.peak end }
      t.getProductionRate = { {}, function(c) return c.mb.productionRate end }
      if E.J.NEW then
        -- 10.4+ canSeeSun: WorldUtils.canSeeSun of the block above (sky light, skyDarken < 4, open sky)
        t.canSeeSun = { {}, function(c) return c.mb.canSeeSky == true and E.skyDarken() < 4 end }
      end
    end
    return t
  end

  K.types = {}
  for name, m in pairs(M) do
    local o = optionsOf(m)
    K.types[name] = {
      m = m, o = o,
      groups = B.groups(B.tileMethods(own(m), o), o),
      newBlock = function(_, mb) return mb.block end,
      blockState = function(c, s) B.state(c.mb, s) end,
    }
  end
  return K
end
