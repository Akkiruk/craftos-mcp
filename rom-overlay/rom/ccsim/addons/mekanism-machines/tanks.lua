-- ccsim addons/mekanism-machines/tanks: the Fluid Tanks and Chemical Tanks, every tier (see engine.lua, blocks.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/TileEntityFluidTank (getStored/Capacity/Needed/FilledPercentage, the container edit mode, emits down at the
--   tier's output while active), capabilities/fluid/FluidTankFluidTank (a creative tank never changes),
--   tile/TileEntityChemicalTank (one chemical at a time, dumping: DUMPING storage / 400 a tick, DUMPING_EXCESS down
--   to 90 % at the output rate; config GAS, INFUSION, PIGMENT, SLURRY then ITEM), tier/FluidTankTier,
--   tier/ChemicalTankTier, registries/MekanismBlockTypes (fluid tank: no facing, no redstone; neither takes upgrades).
return function(E)
  local B, J, C = E.B, E.J, E.C
  local min, floor = math.min, math.floor

  J.ENUMS.ContainerEditMode = { "BOTH", "FILL", "EMPTY" }
  J.ENUMS.GasMode = J.ENUMS.GasMode or { "IDLE", "DUMPING_EXCESS", "DUMPING" }

  local FLUID = { basic = { 32000, 1000 }, advanced = { 64000, 4000 }, elite = { 128000, 16000 },
    ultimate = { 256000, 64000 }, creative = { 2147483647, 1073741823 } }
  local CHEMICAL = { basic = { 64000, 1000 }, advanced = { 256000, 16000 }, elite = { 1024000, 128000 },
    ultimate = { 8192000, 512000 }, creative = { 9.2233720368547758e18, 4.6116860184273879e18 } }

  local K = { kind = "tank" }
  K.rates = { fluidInput = true, fluidOutput = true, chemicalInput = true, chemicalOutput = true }
  B.kindDefaults(K)
  K.defaultFluid = { fluid = "minecraft:water", chemical = "mekanism:hydrogen" }

  local FLUID_O = { comparator = function(mb) return E.redstoneLevel(mb.tank.amount, mb.tank.cap()) end }
  local IO = { "INPUT", "OUTPUT", "INPUT_OUTPUT" }
  local CHEM_O = {
    directional = true, redstone = true, ejector = true,
    config = {
      { type = "GAS", modes = IO, fill = "INPUT", sides = { FRONT = "OUTPUT" }, ejecting = true },
      { type = "INFUSION", modes = IO, fill = "INPUT", sides = { FRONT = "OUTPUT" }, ejecting = true },
      { type = "PIGMENT", modes = IO, fill = "INPUT", sides = { FRONT = "OUTPUT" }, ejecting = true },
      { type = "SLURRY", modes = IO, fill = "INPUT", sides = { FRONT = "OUTPUT" }, ejecting = true },
      { type = "ITEM", modes = IO, fill = "INPUT", sides = { FRONT = "OUTPUT" }, canEject = false },
    },
    comparator = function(mb) return E.redstoneLevel(mb.tank.amount, mb.tank.cap()) end,
  }

  local function tierOf(spec, suffix, tiers)
    local t = spec.type and K.types[spec.type]
    local name = t and t.tierName or tostring(spec.tier or "basic"):lower()
    if not tiers[name] then error("ccsim: unknown " .. suffix .. " tier '" .. name .. "'", 0) end
    return name, t and t.fluid or spec.fluidTank == true
  end

  function K.init(mb, spec)
    local isFluid = spec.type and K.types[spec.type] and K.types[spec.type].fluid
    if spec.type == nil then isFluid = spec.chemical == nil end
    mb.isFluid = isFluid
    local name = tierOf(spec, isFluid and "fluid tank" or "chemical tank", isFluid and FLUID or CHEMICAL)
    local tier = (isFluid and FLUID or CHEMICAL)[name]
    mb.tier, mb.creative = tier, name == "creative"
    B.newBlock(spec, mb, isFluid and FLUID_O or CHEM_O)
    mb.tank = E.tank(not isFluid, function() return tier[1] end)
    E.fill(mb.tank, isFluid and spec.fluid or spec.chemical, K.defaultFluid[isFluid and "fluid" or "chemical"])
    mb.tanks = { [isFluid and "fluid" or "chemical"] = mb.tank }
    if isFluid then
      mb.editMode = B.enumOf(J.ENUMS.ContainerEditMode, spec.editMode, "BOTH", "edit mode")
      mb.block.active = spec.active == true
    else
      mb.dumping = B.enumOf(J.ENUMS.GasMode, spec.dumpingMode, "IDLE", "dumping mode")
    end
    mb.inputItem, mb.outputItem = spec.inputItem, spec.outputItem
    mb.after = B.after
  end

  function K.tick(mb)
    if mb.isFluid or mb.creative or mb.dumping == "IDLE" or mb.tank.amount <= 0 then return end
    if mb.dumping == "DUMPING" then
      E.shrink(mb.tank, floor(mb.tier[1] / 400))
    else
      local target = E.toLong(mb.tank.cap() * C.dumpExcessKeepRatio)
      if target < mb.tank.amount then E.shrink(mb.tank, min(mb.tank.amount - target, mb.tier[2])) end
    end
  end

  --- Pipes: `fluidInput` / `chemicalInput` mB/t in; out at most the tier's output to a load of `fluidOutput` /
  --- `chemicalOutput` (a fluid tank only while active, a chemical tank while its front ejects and it can function).
  function K.transfer(mb)
    local s, t = mb.spec, mb.tank
    local r = E.rate(mb.isFluid and s.fluidInput or s.chemicalInput)
    if r and r > 0 and not mb.creative then
      E.insert(t, t.name or K.defaultFluid[mb.isFluid and "fluid" or "chemical"], min(r, t.cap()))
    end
    r = E.rate(mb.isFluid and s.fluidOutput or s.chemicalOutput)
    local can = mb.isFluid and mb.block.active or
      (not mb.isFluid and B.canFunction(mb.block) and B.ejects(mb.block, "GAS"))
    if r and r > 0 and can and t.amount > 0 then
      local n = min(r, mb.tier[2], t.amount)
      if not mb.creative then E.shrink(t, n) end
    end
  end

  function K.redstoneLevel(mb) return E.redstoneLevel(mb.tank.amount, mb.tank.cap()) end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    extra.editMode = function(v) mb.editMode = B.enumOf(J.ENUMS.ContainerEditMode, v, "BOTH", "edit mode") end
    extra.dumpingMode = function(v) mb.dumping = B.enumOf(J.ENUMS.GasMode, v, "IDLE", "dumping mode") end
    extra.active = function(v) mb.block.active = v == true end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    return B.state(mb, { stored = E.tankState(mb.tank), capacity = mb.tank.cap(), editMode = mb.editMode, dumpingMode = mb.dumping })
  end

  local FLUID_OWN = {
    getInputItem = B.slot(function(mb) return mb.inputItem end),
    getOutputItem = B.slot(function(mb) return mb.outputItem end),
    getContainerEditMode = { {}, function(c) return c.mb.editMode end },
    setContainerEditMode = E.void({ "ContainerEditMode" }, function(c, m) B.requirePublic(c.mb.block); c.mb.editMode = m end),
    incrementContainerEditMode = E.void({}, function(c)
      B.requirePublic(c.mb.block)
      c.mb.editMode = E.cycle(J.ENUMS.ContainerEditMode, c.mb.editMode, 1)
    end),
    decrementContainerEditMode = E.void({}, function(c)
      B.requirePublic(c.mb.block)
      c.mb.editMode = E.cycle(J.ENUMS.ContainerEditMode, c.mb.editMode, -1)
    end),
  }
  local function tankFour(out)
    out.getStored = { {}, function(c) return E.stack(c.mb.tank) end }
    out.getCapacity = { {}, function(c) return c.mb.tank.cap() end }
    out.getNeeded = { {}, function(c) return E.needed(c.mb.tank) end }
    out.getFilledPercentage = { {}, function(c) return c.mb.tank.amount / c.mb.tank.cap() end }
  end
  tankFour(FLUID_OWN)

  local CHEM_OWN = {
    getDumpingMode = { {}, function(c) return c.mb.dumping end },
    getDrainItem = B.slot(function(mb) return mb.inputItem end),
    getFillItem = B.slot(function(mb) return mb.outputItem end),
    setDumpingMode = E.void({ "GasMode" }, function(c, m) B.requirePublic(c.mb.block); c.mb.dumping = m end),
    incrementDumpingMode = E.void({}, function(c)
      B.requirePublic(c.mb.block)
      c.mb.dumping = E.cycle(J.ENUMS.GasMode, c.mb.dumping, 1)
    end),
    decrementDumpingMode = E.void({}, function(c)
      B.requirePublic(c.mb.block)
      c.mb.dumping = E.cycle(J.ENUMS.GasMode, c.mb.dumping, -1)
    end),
  }
  tankFour(CHEM_OWN)

  local fluidGroups = B.groups(B.tileMethods(FLUID_OWN, FLUID_O), FLUID_O)
  local chemGroups = B.groups(B.tileMethods(CHEM_OWN, CHEM_O), CHEM_O)

  K.types = {}
  for tier in pairs(FLUID) do
    K.types[tier .. "FluidTank"] = { groups = fluidGroups, tierName = tier, fluid = true,
      newBlock = function(_, mb) return mb.block end, blockState = function(c, s) B.state(c.mb, s) end }
    K.types[tier .. "ChemicalTank"] = { groups = chemGroups, tierName = tier, fluid = false,
      newBlock = function(_, mb) return mb.block end, blockState = function(c, s) B.state(c.mb, s) end }
  end
  return K
end
