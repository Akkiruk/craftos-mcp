-- ccsim addons/mekanism-machines/factories: the factories, every tier (basic 3, advanced 5, elite 7, ultimate 9
-- processes) of every factory type (smelting, enriching, crushing, compressing, combining, purifying, injecting,
-- infusing, sawing). See engine.lua, blocks.lua.
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/factory/TileEntityFactory (onUpdateServer: sort, then every process's cached recipe in turn; lastUsage;
--   200 ticks; validateValidProcess; setAutoSort; sortInventory / addEmptySlotsAsTargets / distributeItems; config
--   ITEM then ENERGY with setupItemIOConfig and the extra slot at the bottom), tile/factory/TileEntityItemToItemFactory,
--   TileEntityItemStackToItemStackFactory (smelting, enriching, crushing), TileEntityItemStackGasToItemStackFactory
--   (compressing, purifying, injecting: 210 mB a process of gas, constant per-tick use spread over the operation, or
--   the statistical mean for purifying and injecting; config GAS input; dumpChemical), TileEntityMetallurgicInfuserFactory
--   (1000 mB a process of infuse type, config INFUSION io right, no eject; dumpInfuseType), TileEntityCombiningFactory
--   (the secondary input slot), TileEntitySawingFactory (getSecondaryOutput, chance outputs),
--   content/blocktype/Factory (energy: the machine's usage, storage max(storage / 2, usage) × processes),
--   content/blocktype/FactoryType, tier/FactoryTier, util/MekanismUtils (getTicks, getEnergyPerTick,
--   getGasPerTickMeanMultiplier, getBaseUsage), config/UsageConfig and StorageConfig (the pack's machine-usage.toml
--   and machine-storage.toml).
-- Recipes are fixtures: what an input item becomes (and how many it takes), not the recipe registry.
return function(E)
  local B, J, FL = E.B, E.J, E.FL
  local min, max, floor = math.min, math.max, math.floor

  local TIERS = { { "basic", 3 }, { "advanced", 5 }, { "elite", 7 }, { "ultimate", 9 } }
  local TICKS = 200 -- TileEntityFactory.BASE_TICKS_REQUIRED
  local MAX_GAS, MAX_INFUSE = 210, 1000 -- TileEntityAdvancedElectricMachine.MAX_GAS, TileEntityMetallurgicInfuser.MAX_INFUSE
  local U3 = { "SPEED", "ENERGY", "MUFFLING" }
  local U4 = { "SPEED", "ENERGY", "MUFFLING", "GAS" }
  -- the base machine of each type: usage (J/t), storage (J), extra resource
  local TYPES = {
    smelting = { usage = 50, storage = 20000, upgrades = U3 },
    enriching = { usage = 50, storage = 20000, upgrades = U3 },
    crushing = { usage = 50, storage = 20000, upgrades = U3 },
    compressing = { usage = 100, storage = 80000, upgrades = U3, gas = "constant", defaultGas = "mekanism:osmium" },
    combining = { usage = 50, storage = 40000, upgrades = U3, secondary = true },
    purifying = { usage = 200, storage = 80000, upgrades = U4, gas = "statistical", defaultGas = "mekanism:oxygen" },
    injecting = { usage = 400, storage = 160000, upgrades = U4, gas = "statistical", defaultGas = "mekanism:hydrogen_chloride" },
    infusing = { usage = 50, storage = 20000, upgrades = U3, infuse = true },
    sawing = { usage = 50, storage = 20000, upgrades = U3, sawing = true },
  }
  local ORDER = { "smelting", "enriching", "crushing", "compressing", "combining", "purifying", "injecting", "infusing", "sawing" }

  local K = { kind = "factory" }
  K.rates = { energyInput = true, chemicalInput = true, infuseInput = true }
  B.kindDefaults(K)
  K.defaultFluid = { chemical = "mekanism:osmium", infuse = "mekanism:redstone" }

  local function options(ft)
    local o = {
      directional = true, redstone = true, upgrades = ft.upgrades, ejector = true,
      config = { B.cfg.itemIO(ft.gas or ft.infuse or ft.secondary), B.cfg.input("ENERGY") },
      energy = function(mb) return { mb.energy } end,
    }
    if ft.gas then o.config[3] = B.cfg.input("GAS") end
    if ft.infuse then
      local c = B.cfg.io("INFUSION", "RIGHT")
      c.canEject = false
      o.config[3] = c
    end
    o.comparator = function(mb)
      local stacks = {}
      for i = 1, mb.processes do
        stacks[#stacks + 1] = mb.inputs[i]
        stacks[#stacks + 1] = mb.outputs[i]
        if ft.sawing then stacks[#stacks + 1] = mb.secondaryOutputs[i] end
      end
      stacks[#stacks + 1] = mb.energyItem
      if ft.gas or ft.infuse or ft.secondary then stacks[#stacks + 1] = mb.extraItem end
      return B.slotsLevel(stacks)
    end
    return o
  end

  --- The fixture's recipe for an input item: { output, count, input, secondary = {name, chance} }, or nil.
  local function resolve(mb, name)
    local r = mb.recipes[name]
    if r == nil and mb.recipeOutput then r = { output = mb.recipeOutput } end
    if r == nil and not mb.recipes._any then r = { output = name } end
    if r == nil then return nil end
    return {
      output = J.resourceLocation(r.output or name) or r.output, count = floor(tonumber(r.count) or 1),
      input = max(1, floor(tonumber(r.input) or 1)), secondary = r.secondary,
    }
  end
  local NONE = {}
  local function recipeFor(mb, name)
    if not name then return nil end
    local c = mb.recipeCache[name]
    if c == nil then c = resolve(mb, name) or NONE; mb.recipeCache[name] = c end
    if c == NONE then return nil end
    return c
  end

  function K.init(mb, spec)
    local def = K.types[spec.type]
    if not def then error("ccsim: unknown factory '" .. tostring(spec.type) .. "'", 0) end
    local ft = TYPES[def.factoryType]
    mb.ft, mb.factoryType, mb.processes = ft, def.factoryType, def.processes
    B.newBlock(spec, mb, def.o)
    local b = mb.block
    local storage = max(ft.storage * 0.5, ft.usage) * def.processes
    mb.storage = storage
    mb.energy = E.energyContainer(function() return B.maxEnergy(b, storage) end)
    mb.energy.stored = FL.create(min(tonumber(spec.energy) or 0, B.maxEnergy(b, storage)))
    mb.energyItem = B.stack(spec.energyItem)
    mb.extraItem = B.stack(spec.extraItem or spec.secondaryInput)
    mb.inputs, mb.outputs, mb.secondaryOutputs, mb.progress, mb.usedSoFar, mb.carry = {}, {}, {}, {}, {}, {}
    for i = 1, def.processes do
      local inp = type(spec.inputs) == "table" and spec.inputs[i] or nil
      local out = type(spec.outputs) == "table" and spec.outputs[i] or nil
      local sec = type(spec.secondaryOutputs) == "table" and spec.secondaryOutputs[i] or nil
      mb.inputs[i], mb.outputs[i], mb.secondaryOutputs[i] = B.stack(inp), B.stack(out), B.stack(sec)
      mb.progress[i], mb.usedSoFar[i], mb.carry[i] = 0, 0, 0
    end
    if spec.input and def.processes >= 1 and not spec.inputs then mb.inputs[1] = B.stack(spec.input) end
    mb.recipes = {}
    for k, v in pairs(type(spec.recipes) == "table" and spec.recipes or {}) do
      mb.recipes[J.resourceLocation(k) or k] = type(v) == "table" and v or { output = v }
      mb.recipes._any = true
    end
    mb.recipeOutput = spec.recipeOutput and (J.resourceLocation(spec.recipeOutput) or spec.recipeOutput)
    mb.recipeCache = {}
    mb.sorting = spec.sorting == true or spec.autoSort == true
    mb.sortingNeeded = true
    mb.lastUsage, mb.processed, mb.active = 0, 0, {}
    mb.tanks = {}
    if ft.gas then
      mb.chemical = E.tank(true, function() return MAX_GAS * def.processes end)
      E.fill(mb.chemical, spec.chemical, ft.defaultGas)
      mb.tanks.chemical = mb.chemical
      mb.chemicalPerTick = tonumber(spec.chemicalPerTick) or 1
    elseif ft.infuse then
      mb.infuse = E.tank(true, function() return MAX_INFUSE * def.processes end)
      E.fill(mb.infuse, spec.infuse, K.defaultFluid.infuse)
      mb.tanks.infuse = mb.infuse
      mb.infusePerOperation = floor(tonumber(spec.infusePerOperation) or 10)
    elseif ft.secondary then
      mb.secondaryPerOperation = floor(tonumber(spec.secondaryPerOperation) or 1)
    end
    mb.after = B.after
  end

  local function ticksRequired(mb) return B.ticks(mb.block, TICKS) end
  local function perTick(mb) return B.energyPerTick(mb.block, mb.ft.usage) end

  --- What one tick of the chemical a process needs (ChemicalUsageMultiplier × the recipe's per-tick amount).
  local function chemicalThisTick(mb, i)
    local b = mb.block
    if mb.ft.gas == "statistical" then
      -- StatUtils.inversePoisson(mean): the mean, its fraction carried to the next tick
      local mean = B.MAX_UPGRADE_MULTIPLIER ^ (2 * B.upgrades(b, "SPEED") / 8 - B.upgrades(b, "GAS") / 8)
      local want = mean * mb.chemicalPerTick + mb.carry[i]
      local n = floor(want)
      return n, want - n
    end
    -- the constant multiplier: baseTotalUsage spread over the remaining ticks
    local baseRemaining = TICKS - mb.usedSoFar[i]
    local remainingTicks = ticksRequired(mb) - mb.progress[i]
    local m
    if baseRemaining < remainingTicks then m = 0
    elseif baseRemaining == remainingTicks then m = 1
    else m = max(E.toLong(baseRemaining / remainingTicks), 0) end
    return m * mb.chemicalPerTick, 0, m
  end

  local function roomFor(slot, name, count)
    if not slot then return true end
    return slot.name == name and slot.count + count <= 64
  end
  local function addTo(mb, list, i, name, count)
    if list[i] then list[i].count = list[i].count + count else list[i] = { name = name, count = count } end
  end

  --- One process's cached recipe for this tick.
  local function processTick(mb, i)
    local b = mb.block
    local inp = mb.inputs[i]
    if not inp then
      mb.active[i] = false
      return
    end
    local r = recipeFor(mb, inp.name)
    local ok = r ~= nil and inp.count >= r.input and roomFor(mb.outputs[i], r.output, r.count) and B.canFunction(b)
    if ok and mb.ft.infuse then ok = mb.infuse.amount >= mb.infusePerOperation end
    if ok and mb.ft.secondary then ok = mb.extraItem ~= nil and mb.extraItem.count >= mb.secondaryPerOperation end
    local cost = ok and perTick(mb) or 0
    if ok then ok = mb.energy.stored >= cost end
    local gasNeed, carry, mult = 0, 0, 0
    if ok and mb.ft.gas then
      gasNeed, carry, mult = chemicalThisTick(mb, i)
      if gasNeed > mb.chemical.amount then ok = false end
    end
    if not ok then
      mb.active[i] = false
      return
    end
    mb.active[i] = true
    mb.energy:extract(cost)
    if mb.ft.gas then
      E.shrink(mb.chemical, gasNeed)
      mb.carry[i] = carry
      mb.usedSoFar[i] = mb.usedSoFar[i] + (mult or 0)
    end
    mb.progress[i] = mb.progress[i] + 1
    if mb.progress[i] >= ticksRequired(mb) then
      mb.progress[i], mb.usedSoFar[i] = 0, 0
      inp.count = inp.count - r.input
      if inp.count <= 0 then mb.inputs[i] = nil end
      mb.sortingNeeded = true
      addTo(mb, mb.outputs, i, r.output, r.count)
      if mb.ft.infuse then E.shrink(mb.infuse, mb.infusePerOperation) end
      if mb.ft.secondary then
        mb.extraItem.count = mb.extraItem.count - mb.secondaryPerOperation
        if mb.extraItem.count <= 0 then mb.extraItem = nil end
      end
      if mb.ft.sawing and type(r.secondary) == "table" and r.secondary.name then
        local chance = tonumber(r.secondary.chance) or 1
        if chance >= 1 or E.rand() <= chance then
          local name = J.resourceLocation(r.secondary.name) or r.secondary.name
          if roomFor(mb.secondaryOutputs[i], name, 1) then addTo(mb, mb.secondaryOutputs, i, name, floor(tonumber(r.secondary.count) or 1)) end
        end
      end
      mb.processed = mb.processed + 1
    end
  end

  --- TileEntityFactory.sortInventory: spread each input item evenly over its processes and the empty ones.
  local function sortInventory(mb)
    local groups, order, empty = {}, {}, {}
    for i = 1, mb.processes do
      local s = mb.inputs[i]
      if not s then empty[#empty + 1] = i
      else
        local g = groups[s.name]
        if not g then
          local r = recipeFor(mb, s.name)
          g = { name = s.name, processes = {}, total = 0, minPerSlot = r and r.input or 1 }
          groups[s.name] = g
          order[#order + 1] = g
        end
        g.processes[#g.processes + 1] = i
        g.total = g.total + s.count
      end
    end
    if #order == 0 then return end
    -- addEmptySlotsAsTargets
    for _, g in ipairs(order) do
      if #empty == 0 then break end
      local maxSlots = floor(g.total / g.minPerSlot)
      if maxSlots > 1 and maxSlots > #g.processes then
        local toAdd, added, keep = maxSlots - #g.processes, 0, {}
        local r = recipeFor(mb, g.name)
        for _, i in ipairs(empty) do
          local out = mb.outputs[i]
          if added < toAdd and r and (not out or out.name == r.output) then
            g.processes[#g.processes + 1] = i
            added = added + 1
          else
            keep[#keep + 1] = i
          end
        end
        empty = keep
      end
    end
    -- distributeItems
    for _, g in ipairs(order) do
      local n = #g.processes
      if n > 1 then
        local perSlot = floor(g.total / n)
        if perSlot ~= 64 then
          local remainder = g.total % n
          local minPerSlot = g.minPerSlot
          if minPerSlot > 1 then
            local r = perSlot % minPerSlot
            if r > 0 then perSlot = perSlot - r; remainder = remainder + r * n end
            if perSlot + minPerSlot > 64 then minPerSlot = 64 - perSlot end
          end
          for _, i in ipairs(g.processes) do
            local size = perSlot
            if remainder > 0 then
              if remainder > minPerSlot then size = size + minPerSlot; remainder = remainder - minPerSlot
              else size = size + remainder; remainder = 0 end
            end
            mb.inputs[i] = size > 0 and { name = g.name, count = size } or nil
          end
        end
      end
    end
  end

  function K.tick(mb)
    if mb.sortingNeeded and mb.sorting then
      mb.sortingNeeded = false
      sortInventory(mb)
    end
    local prev = mb.energy.stored
    local any = false
    for i = 1, mb.processes do
      processTick(mb, i)
      if mb.active[i] then any = true end
    end
    mb.block.active = any
    mb.lastUsage = any and FL.create(prev - mb.energy.stored) or 0
  end

  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.energyInput)
    if r and r > 0 then mb.energy:insert(min(r, 1.8e19)) end
    r = E.rate(s.chemicalInput)
    if mb.chemical and r and r > 0 then E.insert(mb.chemical, mb.chemical.name or mb.ft.defaultGas, r) end
    r = E.rate(s.infuseInput)
    if mb.infuse and r and r > 0 then E.insert(mb.infuse, mb.infuse.name or K.defaultFluid.infuse, r) end
    if B.canFunction(mb.block) and B.ejects(mb.block, "ITEM") then
      for i = 1, mb.processes do
        for _, list in ipairs({ mb.outputs, mb.secondaryOutputs }) do
          if list[i] then
            mb.ejected = (mb.ejected or 0) + list[i].count
            list[i] = nil
          end
        end
      end
    end
  end

  function K.redstoneLevel(mb) return mb.block.o.comparator(mb) end

  local function stackList(mb, list)
    local out = {}
    for i = 1, mb.processes do out[i] = list[i] and { name = list[i].name, count = list[i].count } or false end
    return out
  end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    extra.energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), mb.energy:max())) end
    extra.inputs = function(v)
      for i = 1, mb.processes do mb.inputs[i] = B.stack(v[i]) end
      mb.sortingNeeded = true
    end
    extra.outputs = function(v) for i = 1, mb.processes do mb.outputs[i] = B.stack(v[i]) end end
    extra.input = function(v)
      local i = floor(tonumber(v.process) or 0) + 1
      if i < 1 or i > mb.processes then error("no process " .. (i - 1), 0) end
      mb.inputs[i] = B.stack(v)
      mb.sortingNeeded = true
    end
    extra.extraItem = function(v) mb.extraItem = B.stack(v) end
    extra.secondaryInput = extra.extraItem
    extra.recipeOutput = function(v)
      mb.recipeOutput = v and (J.resourceLocation(v) or v)
      mb.recipeCache = {}
    end
    extra.sorting = function(v) mb.sorting = v == true end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    local s = {
      energy = mb.energy.stored, maxEnergy = mb.energy:max(), energyUsage = mb.lastUsage, processed = mb.processed,
      processes = mb.processes, ticksRequired = ticksRequired(mb), sorting = mb.sorting, ejected = mb.ejected,
      inputs = stackList(mb, mb.inputs), outputs = stackList(mb, mb.outputs), progress = {},
    }
    for i = 1, mb.processes do s.progress[i] = mb.progress[i] end
    if mb.ft.sawing then s.secondaryOutputs = stackList(mb, mb.secondaryOutputs) end
    if mb.chemical then s.chemical = E.tankState(mb.chemical) end
    if mb.infuse then s.infuse = E.tankState(mb.infuse) end
    if mb.extraItem then s.extraItem = { name = mb.extraItem.name, count = mb.extraItem.count } end
    return B.state(mb, s)
  end

  -- ===== computer methods =====

  local function process(c, p)
    if p < 0 or p >= c.mb.processes then
      J.computerError(("Process: '%d' is out of bounds, as this factory only has '%d' processes (zero indexed)."):format(p, c.mb.processes))
    end
    return p + 1
  end
  local COMMON = {
    getEnergyItem = B.slot(function(mb) return mb.energyItem end),
    isAutoSortEnabled = { {}, function(c) return c.mb.sorting end },
    getEnergyUsage = { {}, function(c) return c.mb.lastUsage end },
    getTicksRequired = { {}, function(c) return ticksRequired(c.mb) end },
    setAutoSort = E.void({ "boolean" }, function(c, v)
      B.requirePublic(c.mb.block)
      if c.mb.sorting ~= v then c.mb.sorting = v end
    end),
    getRecipeProgress = { { "int" }, function(c, p) return c.mb.progress[process(c, p)] end },
    getInput = { { "int" }, function(c, p) return B.item(c.mb.inputs[process(c, p)]) end },
    getOutput = { { "int" }, function(c, p) return B.item(c.mb.outputs[process(c, p)]) end },
  }
  local function own(ft)
    local t = {}
    for k, v in pairs(COMMON) do t[k] = v end
    if ft.gas then
      t.getChemicalItem = B.slot(function(mb) return mb.extraItem end)
      E.tankMethods(t, "Chemical", function(mb) return mb.chemical end)
      t.dumpChemical = E.void({}, function(c) B.requirePublic(c.mb.block); E.setAmount(c.mb.chemical, 0) end)
    elseif ft.infuse then
      t.getInfuseTypeItem = B.slot(function(mb) return mb.extraItem end)
      E.tankMethods(t, "InfuseType", function(mb) return mb.infuse end)
      t.getInfuseType = { {}, function(c)
        local tk = c.mb.infuse
        if tk.amount <= 0 then return { name = "mekanism:empty_infuse_type", amount = 0 } end
        return { name = tk.name, amount = tk.amount }
      end }
      t.dumpInfuseType = E.void({}, function(c) B.requirePublic(c.mb.block); E.setAmount(c.mb.infuse, 0) end)
    elseif ft.secondary then
      t.getSecondaryInput = B.slot(function(mb) return mb.extraItem end)
    elseif ft.sawing then
      t.getSecondaryOutput = { { "int" }, function(c, p) return B.item(c.mb.secondaryOutputs[process(c, p)]) end }
    end
    return t
  end

  K.types = {}
  K.typeNames = {}
  for _, tier in ipairs(TIERS) do
    for _, name in ipairs(ORDER) do
      local ft = TYPES[name]
      local o = options(ft)
      local ty = tier[1] .. name:sub(1, 1):upper() .. name:sub(2) .. "Factory"
      K.typeNames[#K.typeNames + 1] = ty
      K.types[ty] = {
        factoryType = name, processes = tier[2], o = o,
        groups = B.groups(B.tileMethods(own(ft), o), o),
        newBlock = function(_, mb) return mb.block end,
        blockState = function(c, s) B.state(c.mb, s) end,
      }
    end
  end
  return K
end
