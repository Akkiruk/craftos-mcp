-- ccsim addons/mekanism-generators/generators: the single-block generators (see ../mekanism-machines/engine.lua,
-- blocks.lua): Solar, Advanced Solar, Wind, Heat, Bio and Gas-Burning Generators.
--
-- Mekanism Generators 10.2.5 source, src/generators/java/mekanism/generators/common/:
--   tile/TileEntityGenerator (getMaxOutput, emits up to it while it can function), tile/TileEntitySolarGenerator
--   (SolarCheck: peak from biome temperature and downfall, sees the sun when the sky darkening is under 4, rain
--   costs 80 %), tile/TileEntityAdvancedSolarGenerator (nine positions, five must see the sun),
--   tile/TileEntityWindGenerator (multiplier from height every 20 ticks), tile/TileEntityHeatGenerator (lava 10 mB
--   for 200 J of heat, passive lava and nether boost, Carnot conversion up to 500 J/t, heat capacitor 10, 5, 100),
--   tile/TileEntityBioGenerator (1 mB bioethanol for 350 J), tile/TileEntityGasGenerator (Fuel attribute, burn
--   ticks, getToUse), config/GeneratorsConfig and GeneratorsStorageConfig, content/blocktype/Generator,
--   registries/GeneratorsBlockTypes (MUFFLING only); MekanismGenerators.commonSetup (ethylene: 40 ticks,
--   200 + 350 × 80 J); Mekanism util/WorldUtils.getSunBrightness, vanilla DimensionType.timeOfDay and
--   Level.updateSkyBrightness.
return function(E)
  local B, J, C, FL = E.B, E.J, E.C, E.FL
  local min, max, floor, abs, cos, pi = math.min, math.max, math.floor, math.abs, math.cos, math.pi

  local FROM_H2 = 200
  local FUELS = { -- Fuel: burn ticks, energy density
    ["mekanism:hydrogen"] = { ticks = 1, density = FROM_H2 },
    ["mekanism:ethene"] = { ticks = 40, density = FROM_H2 + 350 * 2 * 40 },
  }
  C.solarGeneration = C.solarGeneration or 50
  C.advancedSolarGeneration = C.advancedSolarGeneration or 300
  C.windGenerationMin, C.windGenerationMax = C.windGenerationMin or 60, C.windGenerationMax or 480
  C.heatGeneration, C.heatGenerationLava, C.heatGenerationNether = C.heatGeneration or 200, C.heatGenerationLava or 30, C.heatGenerationNether or 100
  C.bioGeneration = C.bioGeneration or 350

  local K = { kind = "generator" }
  K.rates = { energyOutput = true, lavaInput = true, bioFuelInput = true, fuelInput = true }
  B.kindDefaults(K)
  K.defaultFluid = { lava = "minecraft:lava", bioFuel = "mekanismgenerators:bioethanol", fuel = "mekanism:hydrogen" }

  local GENERATORS = {
    solarGenerator = { storage = 96000, output = 100 },
    advancedSolarGenerator = { storage = 200000, output = 600 },
    windGenerator = { storage = 200000, output = 960 },
    heatGenerator = { storage = 160000, output = 400 },
    bioGenerator = { storage = 160000, output = 700 },
    gasBurningGenerator = { storage = FROM_H2 * 1000, output = FROM_H2 * 2 },
  }

  local function energyOf(mb) return { mb.energy } end
  local function slots(mb)
    return B.slotsLevel({ mb.fuelItem, mb.energyItem })
  end

  -- ===== the sky (vanilla) =====

  local function timeOfDay(dayTime)
    local d0 = dayTime / 24000 - 0.25
    d0 = d0 - floor(d0)
    local d1 = 0.5 - cos(d0 * pi) / 2
    return (d0 * 2 + d1) / 3
  end
  local function rainLevel() return E.sky.raining and 1 or 0 end
  local function thunderLevel() return (E.sky.raining and E.sky.thundering) and 1 or 0 end
  --- Level.updateSkyBrightness: skyDarken
  local function skyDarken()
    local d0 = 1 - rainLevel() * 5 / 16
    local d1 = 1 - thunderLevel() * 5 / 16
    local d2 = 0.5 + 2 * math.max(-0.25, math.min(0.25, cos(timeOfDay(E.sky.dayTime) * pi * 2)))
    return E.toInt((1 - d2 * d0 * d1) * 11)
  end
  --- WorldUtils.getSunBrightness
  local function sunBrightness()
    local f1 = 1 - (cos(timeOfDay(E.sky.dayTime) * pi * 2) * 2 + 0.2)
    f1 = 1 - math.max(0, math.min(1, f1))
    f1 = f1 * (1 - rainLevel() * 5 / 16)
    f1 = f1 * (1 - thunderLevel() * 5 / 16)
    return f1 * 0.8 + 0.2
  end
  E.sunBrightness, E.skyDarken = sunBrightness, skyDarken

  local function solarPeak(mb)
    local tempEff = 0.3 * (0.8 - mb.biomeTemperature)
    local humidityEff = mb.precipitation and -0.3 * mb.downfall or 0
    return 1 + tempEff + humidityEff
  end
  local function seesSun(mb) return mb.hasSkyLight and skyDarken() < 4 and mb.canSeeSky end
  local function generationMultiplier(mb)
    if not seesSun(mb) then return 0 end
    if mb.precipitation and (E.sky.raining or E.sky.thundering) then return solarPeak(mb) * 0.2 end
    return solarPeak(mb)
  end

  -- ===== init =====

  function K.init(mb, spec)
    local name = spec.type or spec.generator
    local g = GENERATORS[name or ""]
    if not g then error("ccsim: unknown generator '" .. tostring(name) .. "'", 0) end
    mb.g, mb.gen = g, name
    local o = mb.K.types[name].o
    B.newBlock(spec, mb, o)
    mb.energy = E.energyContainer(function() return g.storage end)
    mb.energy.stored = FL.create(min(tonumber(spec.energy) or 0, g.storage))
    mb.output = g.output
    mb.tanks = {}
    mb.fuelItem, mb.energyItem = spec.fuelItem, spec.energyItem
    mb.production = 0
    mb.ticker = 0
    mb.after = B.after
    if name == "solarGenerator" or name == "advancedSolarGenerator" then
      mb.canSeeSky = spec.canSeeSky ~= false
      mb.hasSkyLight = spec.hasSkyLight ~= false
      mb.biomeTemperature = tonumber(spec.biomeTemperature) or 0.8
      mb.downfall = tonumber(spec.downfall) or 0.4
      mb.precipitation = spec.precipitation ~= false
      mb.configured = name == "solarGenerator" and C.solarGeneration or C.advancedSolarGeneration
    elseif name == "windGenerator" then
      mb.y = floor(tonumber(spec.y) or 64)
      mb.canSeeSky = spec.canSeeSky ~= false
      mb.blacklisted = spec.blacklistedDimension == true
      mb.minY, mb.maxY = tonumber(spec.minY) or 24, tonumber(spec.maxY) or 384 -- config minY, min(maxY, logical height)
      mb.multiplier = 0
    elseif name == "heatGenerator" then
      mb.lava = E.tank(false, function() return 24000 end, function(n) return n == "minecraft:lava" end)
      E.fill(mb.lava, spec.lava, "minecraft:lava")
      mb.tanks.lava = mb.lava
      mb.heat = E.capacitor(10, tonumber(spec.ambientTemperature) or 300)
      if spec.temperature then mb.heat.heat = 10 * tonumber(spec.temperature) end
      mb.lavaSides = floor(tonumber(spec.lavaSides) or 0)
      mb.ultraWarm = spec.nether == true
      mb.transferLoss, mb.environmentLoss = 0, 0
    elseif name == "bioGenerator" then
      mb.bioFuel = E.tank(false, function() return 24000 end, function(n) return n == "mekanismgenerators:bioethanol" end)
      E.fill(mb.bioFuel, spec.bioFuel, "mekanismgenerators:bioethanol")
      mb.tanks.bioFuel = mb.bioFuel
    else
      mb.fuel = E.tank(true, function() return 18000 end, function(n) return FUELS[n] ~= nil end)
      E.fill(mb.fuel, spec.fuel, "mekanism:hydrogen")
      mb.tanks.fuel = mb.fuel
      mb.burnTicks, mb.maxBurnTicks, mb.generationRate, mb.gasUsed = 0, 0, 0, 0
    end
  end

  -- ===== ticks =====

  local TICK = {}

  function TICK.solarGenerator(mb)
    local b = mb.block
    mb.seesSun = seesSun(mb)
    if mb.seesSun and B.canFunction(b) and mb.energy:needed() > 0 then
      b.active = true
      local production = FL.multiply(mb.configured, sunBrightness() * generationMultiplier(mb))
      mb.production = mb.energy:insert(production)
    else
      b.active = false
      mb.production = 0
    end
  end
  TICK.advancedSolarGenerator = TICK.solarGenerator -- nine positions alike: count 9 > 4, average of nine equal ones

  function TICK.windGenerator(mb)
    local b = mb.block
    if mb.blacklisted then return end
    if mb.ticker % 20 == 0 then
      if mb.canSeeSky then
        local clampedY = min(mb.maxY, max(mb.minY, mb.y + 4))
        local minG, maxG = C.windGenerationMin, C.windGenerationMax
        local slope = FL.divide(maxG - minG, mb.maxY - mb.minY)
        local toGen = FL.create(minG + FL.multiply(slope, clampedY - mb.minY))
        mb.multiplier = FL.divide(toGen, minG)
      else
        mb.multiplier = 0
      end
      b.active = B.canFunction(b) and mb.multiplier ~= 0
    end
    if mb.multiplier ~= 0 and B.canFunction(b) and mb.energy:needed() > 0 then
      mb.energy:insert(FL.multiply(C.windGenerationMin, mb.multiplier))
    end
  end

  function TICK.heatGenerator(mb)
    local b, h = mb.block, mb.heat
    local prev = mb.energy.stored
    local boost = C.heatGenerationLava * mb.lavaSides + (mb.ultraWarm and C.heatGenerationNether or 0)
    h.pending = h.pending + boost
    if B.canFunction(b) and mb.energy:needed() > 0 then
      local rate = 10 -- heatGenerationFluidRate
      if mb.lava.amount >= rate then
        b.active = true
        E.shrink(mb.lava, rate)
        h.pending = h.pending + C.heatGeneration
      else
        b.active = false
      end
    else
      b.active = false
    end
    -- simulate(): Carnot conversion, then the default heat simulation (no neighbour below here)
    local ambient = mb.ambient
    local temp = E.temp(h)
    local carnot = 1 - min(ambient, temp) / max(ambient, temp)
    local heatLost = 0.5 * (temp - ambient)
    h.pending = h.pending - heatLost
    mb.energy:insert(min(500, FL.create(abs(heatLost) * carnot)))
    local env = 0
    for side = 1, 6 do -- DOWN has no insulation
      local inv = E.AIR_INVERSE_COEFFICIENT + (side == 1 and 0 or 100) + 5
      local t = (temp - ambient) / inv
      h.pending = h.pending - t * h.capacity
      if t > 0 then env = env + t end
    end
    mb.transferLoss, mb.environmentLoss = 0, env
    E.update(h) -- the tile updates its heat after its server tick
    mb.production = FL.create(mb.energy.stored - prev)
  end

  function TICK.bioGenerator(mb)
    local b = mb.block
    if B.canFunction(b) and mb.bioFuel.amount > 0 and mb.energy:needed() >= C.bioGeneration then
      b.active = true
      E.shrink(mb.bioFuel, 1)
      mb.energy:insert(C.bioGeneration)
    else
      b.active = false
    end
  end

  function TICK.gasBurningGenerator(mb)
    local b, t = mb.block, mb.fuel
    local operate = (t.amount > 0 or mb.burnTicks > 0) and B.canFunction(b)
    if operate and mb.energy:needed() >= mb.generationRate then
      b.active = true
      local fuel = t.amount > 0 and FUELS[t.name]
      if fuel then
        mb.maxBurnTicks = max(1, fuel.ticks)
        mb.generationRate = FL.divide(fuel.density, fuel.ticks)
      end
      -- getToUse
      local toUse = 0
      if mb.generationRate ~= 0 and t.amount > 0 then
        toUse = E.toLong(math.ceil(256 * (t.amount / t.cap())))
        toUse = min(mb.maxBurnTicks * t.amount + mb.burnTicks, toUse)
        toUse = min(floor(mb.energy:needed() / mb.generationRate), toUse)
      end
      local generation = FL.multiply(mb.generationRate, toUse)
      mb.output = max(FROM_H2, generation) * 2
      local total = mb.burnTicks + t.amount * mb.maxBurnTicks - toUse
      mb.energy:insert(generation)
      if t.amount > 0 then E.setAmount(t, floor(total / mb.maxBurnTicks)) end
      mb.burnTicks = total % mb.maxBurnTicks
      mb.gasUsed = toUse / mb.maxBurnTicks
    else
      if not operate then
        mb.burnTicks, mb.maxBurnTicks, mb.generationRate, mb.output = 0, 0, 0, FROM_H2 * 2
      end
      mb.gasUsed = 0
      b.active = false
    end
  end

  local function maxOutput(mb)
    if mb.gen == "solarGenerator" or mb.gen == "advancedSolarGenerator" then
      return FL.multiply(mb.configured, solarPeak(mb)) -- peakOutput
    end
    return mb.output
  end

  function K.tick(mb)
    TICK[mb.gen](mb)
    mb.ticker = mb.ticker + 1
  end

  --- Cables: up to getMaxOutput a tick goes to a load of `energyOutput` J/t while the generator can function.
  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.energyOutput)
    if r and r > 0 and B.canFunction(mb.block) then mb.energy:extract(min(r, maxOutput(mb), mb.energy.stored)) end
    for field, tank in pairs({ lavaInput = mb.lava, bioFuelInput = mb.bioFuel, fuelInput = mb.fuel }) do
      r = E.rate(s[field])
      if tank and r and r > 0 then E.insert(tank, tank.name or K.defaultFluid[field:gsub("Input$", "")], r) end
    end
  end

  function K.redstoneLevel(mb)
    if mb.lava then return E.redstoneLevel(mb.lava.amount, mb.lava.cap()) end
    if mb.bioFuel then return E.redstoneLevel(mb.bioFuel.amount, mb.bioFuel.cap()) end
    if mb.fuel then return E.redstoneLevel(mb.fuel.amount, mb.fuel.cap()) end
    return slots(mb)
  end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    extra.energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), mb.g.storage)) end
    for _, f in ipairs({ "canSeeSky", "hasSkyLight", "precipitation", "blacklisted" }) do
      extra[f] = function(v) mb[f] = v == true end
    end
    extra.blacklistedDimension = extra.blacklisted
    for _, f in ipairs({ "biomeTemperature", "downfall", "y", "lavaSides" }) do
      extra[f] = function(v) mb[f] = tonumber(v) end
    end
    extra.nether = function(v) mb.ultraWarm = v == true end
    extra.temperature = function(v) if mb.heat then mb.heat.heat, mb.heat.pending = 10 * tonumber(v), 0 end end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    local s = { energy = mb.energy.stored, maxEnergy = mb.g.storage, production = mb.production }
    if mb.heat then s.temperature = E.temp(mb.heat) end
    if mb.multiplier then s.multiplier = mb.multiplier end
    if mb.seesSun ~= nil then s.seesSun = mb.seesSun end
    for name, t in pairs(mb.tanks) do s[name] = E.tankState(t) end
    return B.state(mb, s)
  end

  -- ===== computer methods =====

  local O_BASE = { directional = true, redstone = true, upgrades = { "MUFFLING" },
    comparator = function(mb) return K.redstoneLevel(mb) end, energy = energyOf }
  local function own(t)
    t.getMaxOutput = { {}, function(c) return maxOutput(c.mb) end }
    t.getEnergyItem = B.slot(function(mb) return mb.energyItem end)
    return t
  end
  local SOLAR = own({
    canSeeSun = { {}, function(c) return c.mb.seesSun == true end },
    getProductionRate = { {}, function(c) return c.mb.production end },
  })
  local WIND = own({
    isBlacklistedDimension = { {}, function(c) return c.mb.blacklisted end },
    getProductionRate = { {}, function(c)
      return c.mb.block.active and FL.multiply(C.windGenerationMin, c.mb.multiplier) or 0
    end },
  })
  local HEAT = own({
    getTemperature = { {}, function(c) return E.temp(c.mb.heat) end },
    getFuelItem = B.slot(function(mb) return mb.fuelItem end),
    getProductionRate = { {}, function(c) return c.mb.production end },
    getTransferLoss = { {}, function(c) return c.mb.transferLoss end },
    getEnvironmentalLoss = { {}, function(c) return c.mb.environmentLoss end },
  })
  E.tankMethods(HEAT, "Lava", function(mb) return mb.lava end)
  local BIO = own({
    getFuelItem = B.slot(function(mb) return mb.fuelItem end),
    getProductionRate = { {}, function(c) return c.mb.block.active and C.bioGeneration or 0 end },
  })
  E.tankMethods(BIO, "BioFuel", function(mb) return mb.bioFuel end)
  local function used(mb) return floor(mb.gasUsed * 100 + 0.5) / 100 end -- Math.round(x * 100) / 100D
  local GAS = own({
    getFuelItem = B.slot(function(mb) return mb.fuelItem end),
    getBurnRate = { {}, function(c) return used(c.mb) end },
    getProductionRate = { {}, function(c)
      return FL.multiply(FL.multiply(c.mb.generationRate, FL.create(used(c.mb))), c.mb.maxBurnTicks)
    end },
  })
  E.tankMethods(GAS, "Fuel", function(mb) return mb.fuel end)

  local OWN = { solarGenerator = SOLAR, advancedSolarGenerator = SOLAR, windGenerator = WIND, heatGenerator = HEAT,
    bioGenerator = BIO, gasBurningGenerator = GAS }
  K.types = {}
  for name, methods in pairs(OWN) do
    K.types[name] = {
      o = O_BASE, groups = B.groups(B.tileMethods(methods, O_BASE), O_BASE),
      newBlock = function(_, mb) return mb.block end,
      blockState = function(c, s) B.state(c.mb, s) end,
    }
  end
  return K
end
