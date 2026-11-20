-- ccsim addons/mekanism-generators/fusion: the Fusion Reactor (see ../mekanism-machines/engine.lua).
--
-- Mekanism Generators 10.2.5 source, src/generators/java/mekanism/generators/common/:
--   content/fusion/FusionReactorMultiblockData (tick, injectFuel, burnFuel, transferHeat, the formula methods,
--   setInjectionRate), tile/fusion/TileEntityFusionReactorLogicAdapter (logic modes, active cooling),
--   tile/fusion/TileEntityFusionReactorPort (eject mode, energy containers, exposesMultiblockToComputer false),
--   config/GeneratorsConfig (fusion and hohlraum defaults).
return function(E)
  local J, C, FL = E.J, E.C, E.FL
  local floor, min, max, ceil = math.floor, math.min, math.max, math.ceil

  J.ENUMS.FusionReactorLogic = { "DISABLED", "READY", "CAPACITY", "DEPLETED" }

  local MAX_ENERGY = 1000000000
  local MAX_WATER = 1000 * 1000
  local MAX_STEAM = MAX_WATER * 100
  local MAX_FUEL = 1000
  local MAX_INJECTION = 98
  local BURN_TEMPERATURE, BURN_RATIO = 100000000, 1
  local PLASMA_HEAT_CAPACITY, CASE_HEAT_CAPACITY = 100, 1
  local PLASMA_CASE_CONDUCTIVITY = 0.2
  local D, T, DT = "mekanismgenerators:deuterium", "mekanismgenerators:tritium", "mekanismgenerators:fusion_fuel"
  local STEAM, WATER = "mekanism:steam", "minecraft:water"
  local HOHLRAUM = "mekanismgenerators:hohlraum"

  local K = { kind = "fusion", defaults = { length = 5, width = 5, height = 5 } }
  K.defaultFluid = { deuterium = D, tritium = T, dtFuel = DT, water = WATER, steam = STEAM }
  K.rates = { deuteriumInput = true, tritiumInput = true, waterInput = true, steamOutput = true, steamTo = true,
    energyOutput = true, energyTo = true }

  function K.init(mb, spec)
    mb.injectionRate = floor(tonumber(spec.injectionRate) or 2)
    mb.deuterium = E.tank(true, function() return MAX_FUEL end, function(n) return n == D end)
    mb.tritium = E.tank(true, function() return MAX_FUEL end, function(n) return n == T end)
    mb.dtFuel = E.tank(true, function() return MAX_FUEL end, function(n) return n == DT end)
    mb.steam = E.tank(true, function() return MAX_STEAM * mb.injectionRate end, function(n) return n == STEAM end)
    mb.water = E.tank(false, function() return MAX_WATER * mb.injectionRate end, function(n) return E.WATER[n] == true end)
    mb.tanks = { deuterium = mb.deuterium, tritium = mb.tritium, dtFuel = mb.dtFuel, steam = mb.steam, water = mb.water }
    for name, t in pairs(mb.tanks) do E.fill(t, spec[name], K.defaultFluid[name]) end
    mb.energy = E.energyContainer(function() return MAX_ENERGY end)
    mb.energy.stored = FL.create(min(tonumber(spec.energy) or 0, MAX_ENERGY))
    -- the casing: heat capacity 1, inverse conduction 1 / casingThermalConductivity, inverse insulation 100000
    mb.heat = E.capacitor(CASE_HEAT_CAPACITY, mb.ambient)
    if spec.caseTemperature then mb.heat.heat = CASE_HEAT_CAPACITY * tonumber(spec.caseTemperature) end
    mb.plasmaTemperature = tonumber(spec.plasmaTemperature) or mb.ambient
    mb.lastPlasmaTemperature = mb.plasmaTemperature
    mb.lastCaseTemperature = E.temp(mb.heat)
    mb.burning = spec.burning == true
    mb.hohlraum = spec.hohlraum == true or spec.hohlraum == "filled"
  end

  local function isBurning(mb) return mb.burning end

  local function injectFuel(mb)
    local needed = E.needed(mb.dtFuel)
    local available = 2 * min(mb.deuterium.amount, mb.tritium.amount)
    local toInject = min(needed, min(available, mb.injectionRate))
    toInject = toInject - toInject % 2
    local half = toInject / 2
    E.shrink(mb.deuterium, half)
    E.shrink(mb.tritium, half)
    E.insert(mb.dtFuel, DT, toInject)
  end

  local function burnFuel(mb)
    local burned = E.toLong(min(mb.dtFuel.amount, max(0, mb.lastPlasmaTemperature - BURN_TEMPERATURE) * BURN_RATIO))
    E.shrink(mb.dtFuel, burned)
    mb.plasmaTemperature = mb.plasmaTemperature + FL.divide(FL.multiply(C.energyPerFusionFuel, burned), PLASMA_HEAT_CAPACITY)
    return burned
  end

  local function transferHeat(mb)
    local h = mb.heat
    local plasmaCaseHeat = PLASMA_CASE_CONDUCTIVITY * (mb.lastPlasmaTemperature - mb.lastCaseTemperature)
    mb.plasmaTemperature = mb.plasmaTemperature - plasmaCaseHeat / PLASMA_HEAT_CAPACITY
    h.pending = h.pending + plasmaCaseHeat
    local caseWaterHeat = C.fusionWaterHeatingRatio * (mb.lastCaseTemperature - mb.ambient)
    local toVaporize = E.toInt(E.STEAM_ENERGY_EFFICIENCY * caseWaterHeat / C.maxEnergyPerSteam)
    toVaporize = min(toVaporize, min(mb.water.amount, E.toInt(E.needed(mb.steam))))
    if toVaporize > 0 then
      E.shrink(mb.water, toVaporize)
      E.insert(mb.steam, STEAM, toVaporize)
      h.pending = h.pending - toVaporize * C.maxEnergyPerSteam / E.STEAM_ENERGY_EFFICIENCY
    end
    local caseAirHeat = C.fusionCasingThermalConductivity * (mb.lastCaseTemperature - mb.ambient)
    h.pending = h.pending - caseAirHeat
    mb.energy:insert(FL.create(caseAirHeat * C.fusionThermocoupleEfficiency))
  end

  function K.tick(mb)
    if mb.plasmaTemperature >= BURN_TEMPERATURE then
      if not mb.burning and mb.hohlraum then
        -- vaporiseHohlraum: its DT-Fuel goes in and the reaction starts
        E.insert(mb.dtFuel, DT, C.hohlraumMaxGas)
        mb.lastPlasmaTemperature = mb.plasmaTemperature
        mb.hohlraum = false
        mb.burning = true
      end
      if isBurning(mb) then
        injectFuel(mb)
        if burnFuel(mb) == 0 then mb.burning = false end
      end
    else
      mb.burning = false
    end
    transferHeat(mb)
    E.update(mb.heat)
    mb.lastPlasmaTemperature = mb.plasmaTemperature
    mb.lastCaseTemperature = E.temp(mb.heat)
  end

  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.deuteriumInput)
    if r and r > 0 then E.insert(mb.deuterium, D, r) end
    r = E.rate(s.tritiumInput)
    if r and r > 0 then E.insert(mb.tritium, T, r) end
    r = E.rate(s.waterInput)
    if r and r > 0 then E.insert(mb.water, WATER, r) end
    -- ports in eject mode emit steam and energy (TileEntityFusionReactorPort.onUpdateServer)
    local eject = E.portAllows(mb, "output")
    local to = E.link(mb, "steamTo")
    r = E.rate(s.steamOutput) or (to and math.huge)
    if eject and r and r > 0 and mb.steam.amount > 0 then
      local n = min(r, mb.steam.amount)
      if to then n = to.K.accept and to.K.accept(to, STEAM, n) or 0 end
      E.shrink(mb.steam, n)
    end
    to = E.link(mb, "energyTo")
    r = E.rate(s.energyOutput) or (to and math.huge)
    if eject and r and r > 0 and mb.energy.stored > 0 then
      local n = min(r, mb.energy.stored)
      if to then n = to.K.acceptEnergy and to.K.acceptEnergy(to, n) or 0 end
      mb.energy:extract(n)
    end
  end

  function K.redstoneLevel(mb) return E.redstoneLevel(mb.dtFuel.amount, mb.dtFuel.cap()) end

  -- the formula methods
  local function k(active) return active and C.fusionWaterHeatingRatio or 0 end
  local function minInjectionRate(active)
    local kk, air = k(active), C.fusionCasingThermalConductivity
    local aMin = BURN_TEMPERATURE * BURN_RATIO * PLASMA_CASE_CONDUCTIVITY * (kk + air) /
      (C.energyPerFusionFuel * BURN_RATIO * (PLASMA_CASE_CONDUCTIVITY + kk + air) - PLASMA_CASE_CONDUCTIVITY * (kk + air))
    return E.toInt(2 * ceil(aMin / 2))
  end
  local function maxPlasmaTemperature(mb, active)
    local kk, air = k(active), C.fusionCasingThermalConductivity
    return mb.injectionRate * C.energyPerFusionFuel / PLASMA_CASE_CONDUCTIVITY * (PLASMA_CASE_CONDUCTIVITY + kk + air) / (kk + air)
  end
  local function maxCasingTemperature(mb, active)
    return FL.divide(FL.multiply(C.energyPerFusionFuel, mb.injectionRate), FL.create(k(active) + C.fusionCasingThermalConductivity))
  end
  local function ignitionTemperature(active)
    local kk, air = k(active), C.fusionCasingThermalConductivity
    local e = C.energyPerFusionFuel
    return BURN_TEMPERATURE * e * BURN_RATIO * (PLASMA_CASE_CONDUCTIVITY + kk + air) /
      (e * BURN_RATIO * (PLASMA_CASE_CONDUCTIVITY + kk + air) - PLASMA_CASE_CONDUCTIVITY * (kk + air))
  end
  local function passiveGeneration(mb, active)
    return FL.create(C.fusionThermocoupleEfficiency * C.fusionCasingThermalConductivity * maxCasingTemperature(mb, active))
  end

  local function setInjectionRate(mb, rate)
    if mb.injectionRate ~= rate then
      mb.injectionRate = rate
      -- the tanks shrink with it
      if mb.water.amount > mb.water.cap() then E.setAmount(mb.water, mb.water.cap()) end
      if mb.steam.amount > mb.steam.cap() then E.setAmount(mb.steam, mb.steam.cap()) end
    end
  end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), MAX_ENERGY)) end,
      plasmaTemperature = function(v) mb.plasmaTemperature = tonumber(v); mb.lastPlasmaTemperature = mb.plasmaTemperature end,
      caseTemperature = function(v) mb.heat.heat, mb.heat.pending = tonumber(v), 0; mb.lastCaseTemperature = tonumber(v) end,
      injectionRate = function(v) setInjectionRate(mb, floor(tonumber(v))) end,
      burning = function(v) mb.burning = v == true end,
      hohlraum = function(v) mb.hohlraum = v == true or v == "filled" end,
    })
  end

  K.handlers = {}
  --- Laser energy into the plasma (addTemperatureFromEnergyInput): ten times as much heat while not burning.
  function K.handlers.mekFusionLaser(mb, cmd)
    local energy = tonumber(cmd.energy)
    if not energy or energy <= 0 then return false, "mekFusionLaser needs energy (joules)" end
    local dT = FL.divide(FL.create(energy), PLASMA_HEAT_CAPACITY)
    if not mb.burning then dT = FL.multiply(dT, 10) end
    mb.plasmaTemperature = mb.plasmaTemperature + dT
    return true
  end
  --- A player puts a hohlraum in the controller (filled: 10 mB of DT-Fuel, the one ignition needs).
  function K.handlers.mekInsertHohlraum(mb, cmd)
    mb.hohlraum = cmd.filled ~= false
    mb.emptyHohlraum = cmd.filled == false
    return true
  end

  function K.state(mb)
    return {
      plasmaTemperature = mb.plasmaTemperature, caseTemperature = E.temp(mb.heat), burning = mb.burning,
      injectionRate = mb.injectionRate, energy = mb.energy.stored, hohlraum = mb.hohlraum or nil,
      deuterium = E.tankState(mb.deuterium), tritium = E.tankState(mb.tritium), dtFuel = E.tankState(mb.dtFuel),
      water = E.tankState(mb.water), steam = E.tankState(mb.steam),
    }
  end

  -- ===== computer methods =====

  local function err(msg) J.computerError(msg) end

  local MB = {}
  E.tankMethods(MB, "Water", function(mb) return mb.water end)
  E.tankMethods(MB, "Steam", function(mb) return mb.steam end)
  MB.getPlasmaTemperature = { {}, function(c) return c.mb.lastPlasmaTemperature end }
  MB.getCaseTemperature = { {}, function(c) return c.mb.lastCaseTemperature end }
  E.tankMethods(MB, "Deuterium", function(mb) return mb.deuterium end)
  E.tankMethods(MB, "Tritium", function(mb) return mb.tritium end)
  E.tankMethods(MB, "DTFuel", function(mb) return mb.dtFuel end)
  --- getHohlraum: the controller's slot as an ItemStack (an empty slot is air, count 0)
  MB.getHohlraum = { {}, function(c)
    if c.mb.hohlraum or c.mb.emptyHohlraum then return { name = HOHLRAUM, count = 1 } end
    return { name = "minecraft:air", count = 0 }
  end }
  MB.getInjectionRate = { {}, function(c) return c.mb.injectionRate end }
  MB.getMinInjectionRate = { { "boolean" }, function(_, active) return minInjectionRate(active) end }
  MB.getMaxPlasmaTemperature = { { "boolean" }, function(c, active) return maxPlasmaTemperature(c.mb, active) end }
  MB.getMaxCasingTemperature = { { "boolean" }, function(c, active) return maxCasingTemperature(c.mb, active) end }
  MB.getIgnitionTemperature = { { "boolean" }, function(_, active) return ignitionTemperature(active) end }
  MB.setInjectionRate = E.void({ "int" }, function(c, rate)
    if rate < 0 or rate > MAX_INJECTION then
      err(("Injection Rate '%d' is out of range must be an even number between 0 and %d. (Inclusive)"):format(rate, MAX_INJECTION))
    elseif rate % 2 ~= 0 then
      err(("Injection Rate '%d' must be an even number between 0 and %d. (Inclusive)"):format(rate, MAX_INJECTION))
    end
    setInjectionRate(c.mb, rate)
  end)
  MB.getPassiveGeneration = { { "boolean" }, function(c, active) return passiveGeneration(c.mb, active) end }
  MB.getProductionRate = { {}, function(c) return passiveGeneration(c.mb, false) end }
  if E.J.NEW then
    -- 10.4+: lastEnvironmentLoss / lastTransferLoss of the reactor's simulate(). The emulator moves the case's heat
    -- only through water, steam and the casing's air loss above, so both read 0 (docs/mekanism-versions.md)
    MB.getEnvironmentalLoss = { {}, function() return 0 end }
    MB.getTransferLoss = { {}, function() return 0 end }
  end
  if E.J.V21 then
    MB.isIgnited = { {}, function(c) return c.mb.burning == true end } -- 10.7 isBurning, as isIgnited
  end
  E.shapeMethods(MB)

  --- READY / CAPACITY / DEPLETED: whether the adapter emits redstone (checkMode)
  local function outputting(c)
    local mb, b = c.mb, c.block
    if not mb.formed or mb.destroyed then return false end
    if b.logic == "READY" then return mb.lastPlasmaTemperature >= ignitionTemperature(b.activeCooled) end
    if b.logic == "CAPACITY" then return mb.lastPlasmaTemperature >= maxPlasmaTemperature(mb, b.activeCooled) end
    if b.logic == "DEPLETED" then
      local half = floor(mb.injectionRate / 2)
      return mb.deuterium.amount < half or mb.tritium.amount < half
    end
    return false
  end

  local ADAPTER = {
    isActiveCooledLogic = { {}, function(c) return c.block.activeCooled end },
    getLogicMode = { {}, function(c) return c.block.logic end },
    setLogicMode = E.void({ "FusionReactorLogic" }, function(c, mode) c.block.logic = mode end),
    setActiveCooledLogic = E.void({ "boolean" }, function(c, v) c.block.activeCooled = v end),
    isFormed = E.T.isFormed,
  }

  local PORT = {
    getMode = { {}, function(c) return c.block.portMode == "output" end },
    setMode = E.void({ "boolean" }, function(c, v) c.block.portMode = v and "output" or "input" end),
  }
  E.energyMethods(PORT, function(mb) return { mb.energy } end)

  local function logicOf(v)
    v = type(v) == "string" and v:upper() or "DISABLED"
    for _, x in ipairs(J.ENUMS.FusionReactorLogic) do if x == v then return v end end
    error("ccsim: '" .. v .. "' is not a fusion logic mode", 0)
  end

  K.types = {
    fusionReactorLogicAdapter = {
      tile = ADAPTER, multiblock = MB,
      newBlock = function(def) return { logic = logicOf(def.logicMode), activeCooled = def.activeCooled == true } end,
      blockState = function(c, s) s.logicMode, s.activeCooled, s.outputting = c.block.logic, c.block.activeCooled, outputting(c) end,
    },
    fusionReactorPort = {
      tile = PORT,
      newBlock = function(def) return { portMode = (def.mode == true or def.mode == "output") and "output" or "input" } end,
      blockState = function(c, s) s.mode = c.block.portMode == "output" end,
    },
  }

  return K
end
