-- ccsim addons/mekanism-generators/fission: the Fission Reactor (see ../mekanism-machines/engine.lua).
--
-- Mekanism Generators 10.2.5 source, src/generators/java/mekanism/generators/common/:
--   content/fission/FissionReactorMultiblockData (tick, burnFuel, handleCoolant, simulateEnvironment, handleDamage,
--   meltdownHappened, every computer method), content/fission/FissionReactorValidator (fuel assemblies, surface area),
--   tile/fission/TileEntityFissionReactorLogicAdapter (logic modes, redstone status, Activation), ...Port (port modes,
--   exposesMultiblockToComputer false), config/GeneratorsConfig (fission defaults);
--   Mekanism: lib/radiation/Meltdown (the explosion), util/UnitDisplayUtils.roundDecimals.
return function(E)
  local J, C, FL = E.J, E.C, E.FL
  local floor, min, max = math.floor, math.min, math.max

  J.ENUMS.FissionReactorLogic = { "DISABLED", "ACTIVATION", "TEMPERATURE", "EXCESS_WASTE", "DAMAGED", "DEPLETED" }
  J.ENUMS.FissionPortMode = { "INPUT", "OUTPUT_WASTE", "OUTPUT_COOLANT" }

  local INVERSE_INSULATION, INVERSE_CONDUCTION = 10000, 10
  local WATER_CONDUCTIVITY = 0.5
  local COOLANT_PER_VOLUME, HEATED_COOLANT_PER_VOLUME, FUEL_PER_ASSEMBLY = 100000, 1000000, 8000
  local MIN_DAMAGE_TEMPERATURE, MAX_DAMAGE_TEMPERATURE, MAX_DAMAGE = 1200, 1800, 100
  local EXPLOSION_CHANCE = 1 / 512000
  local FUEL, WASTE, STEAM, WATER = "mekanism:fissile_fuel", "mekanism:nuclear_waste", "mekanism:steam", "minecraft:water"
  local WASTE_RADIOACTIVITY = 0.01

  local K = { kind = "fission", defaults = { length = 5, width = 5, height = 5 } }
  K.defaultFluid = { fuel = FUEL, waste = WASTE, coolant = WATER, gasCoolant = "mekanism:sodium", heatedCoolant = STEAM }
  K.rates = { fuelInput = true, coolantInput = true, wasteOutput = true, heatedCoolantOutput = true, heatedCoolantTo = true }

  function K.init(mb, spec)
    mb.fuelAssemblies = floor(tonumber(spec.fuelAssemblies) or 8)
    mb.surfaceArea = floor(tonumber(spec.surfaceArea) or (mb.fuelAssemblies * 5)) -- columns of two: 4n + 2 each
    local fluidCoolant, gasCoolant
    fluidCoolant = E.tank(false, function() return mb.volume * COOLANT_PER_VOLUME end,
      function(name) return E.WATER[name] and E.isEmpty(gasCoolant) end)
    gasCoolant = E.tank(true, function() return mb.volume * COOLANT_PER_VOLUME end,
      function(name) return E.COOLED[name] ~= nil and E.isEmpty(fluidCoolant) end)
    mb.fluidCoolant, mb.gasCoolant = fluidCoolant, gasCoolant
    mb.fuel = E.tank(true, function() return mb.fuelAssemblies * FUEL_PER_ASSEMBLY end, function(n) return n == FUEL end)
    mb.waste = E.tank(true, function() return mb.fuelAssemblies * FUEL_PER_ASSEMBLY end, function(n) return n == WASTE end)
    mb.heatedCoolant = E.tank(true, function() return mb.volume * HEATED_COOLANT_PER_VOLUME end,
      function(n) return n == STEAM or E.HEATED[n] ~= nil end)
    mb.tanks = { fuel = mb.fuel, waste = mb.waste, coolant = fluidCoolant, gasCoolant = gasCoolant, heatedCoolant = mb.heatedCoolant }
    E.fill(mb.fuel, spec.fuel, FUEL)
    E.fill(mb.waste, spec.waste, WASTE)
    if type(spec.coolant) == "table" and E.COOLED[J.resourceLocation(spec.coolant.name or "") or ""] then
      E.fill(gasCoolant, spec.coolant)
    else
      E.fill(fluidCoolant, spec.coolant, WATER)
    end
    E.fill(gasCoolant, spec.gasCoolant, "mekanism:sodium")
    E.fill(mb.heatedCoolant, spec.heatedCoolant, STEAM)
    -- onCreated: heat capacity = casingHeatCapacity * the shell's blocks, at the biome's temperature
    mb.heat = E.capacitor(C.fissionCasingHeatCapacity * mb.casings, mb.ambient)
    if spec.temperature then mb.heat.heat = mb.heat.capacity * tonumber(spec.temperature) end
    mb.damage = tonumber(spec.damage) or 0
    mb.rateLimit = tonumber(spec.burnRate) or C.defaultBurnRate
    mb.active = spec.active == true
    mb.forceDisabled = spec.forceDisabled == true
    mb.burnRemaining, mb.partialWaste = 0, 0
    mb.lastEnvironmentLoss, mb.lastBoilRate, mb.lastBurnRate = 0, 0, 0
    mb.radiated = 0 -- Sv released to the world (waste that did not fit, meltdowns)
    mb.meltdowns = 0
    mb.after = K.after
  end

  local function maxBurnRate(mb) return mb.fuelAssemblies * C.burnPerAssembly end
  local function boilEfficiency(mb)
    return min(1, (mb.surfaceArea / mb.fuelAssemblies) / C.fissionSurfaceAreaTarget)
  end

  local function setActive(mb, active)
    if mb.active ~= active and (not active or not mb.forceDisabled) then mb.active = active end
  end
  local function setForceDisable(mb, v)
    if mb.forceDisabled ~= v then
      mb.forceDisabled = v
      if v then setActive(mb, false) end
    end
  end

  local function burnFuel(mb)
    local stored = mb.fuel.amount + mb.burnRemaining
    local toBurn = min(min(mb.rateLimit, stored), maxBurnRate(mb))
    stored = stored - toBurn
    E.setAmount(mb.fuel, E.toLong(stored))
    if mb.fuel.amount > 0 then mb.fuel.name = FUEL end
    mb.burnRemaining = E.fmod(stored, 1)
    mb.heat.pending = mb.heat.pending + toBurn * C.energyPerFissionFuel
    mb.partialWaste = mb.partialWaste + toBurn
    local newWaste = floor(mb.partialWaste)
    if newWaste > 0 then
      mb.partialWaste = E.fmod(mb.partialWaste, 1)
      local leftover = max(0, newWaste - E.needed(mb.waste))
      E.insert(mb.waste, WASTE, newWaste)
      if leftover > 0 then mb.radiated = mb.radiated + leftover * WASTE_RADIOACTIVITY end
    end
    mb.lastBurnRate = toBurn
  end

  local function handleCoolant(mb)
    local h = mb.heat
    local temp = E.temp(h)
    local heat = boilEfficiency(mb) * (temp - E.BASE_BOIL_TEMP) * h.capacity
    local heated = 0
    if not E.isEmpty(mb.fluidCoolant) then
      local caseCoolantHeat = heat * WATER_CONDUCTIVITY
      heated = E.toInt(E.STEAM_ENERGY_EFFICIENCY * caseCoolantHeat / C.maxEnergyPerSteam)
      heated = max(0, min(heated, mb.fluidCoolant.amount))
      if heated > 0 then
        E.shrink(mb.fluidCoolant, heated)
        E.insert(mb.heatedCoolant, STEAM, heated) -- extra steam is dumped
        h.pending = h.pending - heated * C.maxEnergyPerSteam / E.STEAM_ENERGY_EFFICIENCY
      end
    elseif not E.isEmpty(mb.gasCoolant) then
      local coolant = E.COOLED[mb.gasCoolant.name]
      if coolant then
        local caseCoolantHeat = heat * coolant.conductivity
        heated = E.toInt(caseCoolantHeat / coolant.enthalpy)
        heated = max(0, min(heated, mb.gasCoolant.amount))
        if heated > 0 then
          E.shrink(mb.gasCoolant, heated)
          E.insert(mb.heatedCoolant, coolant.heated, heated)
          h.pending = h.pending - heated * coolant.enthalpy
        end
      end
    end
    mb.lastBoilRate = heated
  end

  local function simulateEnvironment(mb)
    local h = mb.heat
    local invConduction = E.AIR_INVERSE_COEFFICIENT + (INVERSE_INSULATION + INVERSE_CONDUCTION)
    local tempToTransfer = (E.temp(h) - mb.ambient) / invConduction
    h.pending = h.pending - tempToTransfer * h.capacity
    return max(tempToTransfer, 0)
  end

  local function createMeltdown(mb)
    -- RadiationManager.createMeltdown: one more Meltdown each tick the condition holds; magnitude is the heat
    mb.meltdownQueue = mb.meltdownQueue or {}
    mb.meltdownQueue[#mb.meltdownQueue + 1] = { age = 0, magnitude = mb.heat.heat }
  end

  local function handleDamage(mb)
    local temp = E.temp(mb.heat)
    if temp > MIN_DAMAGE_TEMPERATURE then
      mb.damage = mb.damage + min(temp, MAX_DAMAGE_TEMPERATURE) / (MIN_DAMAGE_TEMPERATURE * 10)
    else
      mb.damage = max(0, mb.damage - (MIN_DAMAGE_TEMPERATURE - temp) / (MIN_DAMAGE_TEMPERATURE * 100))
    end
    if mb.damage >= MAX_DAMAGE and temp >= MIN_DAMAGE_TEMPERATURE then
      if mb.forceDisabled and C.fissionMeltdownsEnabled then
        setForceDisable(mb, false)
        createMeltdown(mb)
      elseif E.rand() < (mb.damage / MAX_DAMAGE) * C.fissionMeltdownChance then
        if C.fissionMeltdownsEnabled then createMeltdown(mb) else setForceDisable(mb, true) end
      end
    elseif mb.damage < MAX_DAMAGE and temp < MIN_DAMAGE_TEMPERATURE then
      setForceDisable(mb, false)
    end
  end

  function K.tick(mb)
    if mb.active then burnFuel(mb) else mb.lastBurnRate = 0 end
    handleCoolant(mb)
    mb.lastEnvironmentLoss = simulateEnvironment(mb)
    E.update(mb.heat)
    handleDamage(mb)
  end

  --- meltdownHappened, then the explosion takes the structure (and the computer's blocks on it) away.
  local function meltdownHappened(mb)
    local radiation = 0
    if mb.waste.amount > 0 or mb.partialWaste > 0 then
      radiation = (mb.waste.amount + mb.partialWaste) * WASTE_RADIOACTIVITY
      E.setAmount(mb.waste, 0)
    end
    mb.radiated = mb.radiated + radiation * 50 -- fissionMeltdownRadiationMultiplier
    E.setAmount(mb.heatedCoolant, 0)
    mb.active = false
    mb.damage = C.fissionPostMeltdownDamage
    mb.burnRemaining, mb.partialWaste = 0, 0
    mb.heat.heat, mb.heat.pending = mb.heat.capacity * mb.ambient, 0
    mb.meltdowns = mb.meltdowns + 1
    mb.meltedDown = true
    mb.meltdownQueue = nil
    E.destroy(mb)
  end

  --- RadiationManager ticks the meltdowns after the block entities: Meltdown.update, 1 in 10 ticks an explosion
  --- when magnitude * chance wins, for 100 ticks.
  function K.after(mb)
    local q = mb.meltdownQueue
    if not q or mb.destroyed then return end
    for i = #q, 1, -1 do
      local m = q[i]
      m.age = m.age + 1
      if E.rand() < 0.1 and E.rand() < m.magnitude * EXPLOSION_CHANCE then
        meltdownHappened(mb)
        return
      end
      if m.age >= 100 then table.remove(q, i) end
    end
  end

  --- Pipes on the ports: what comes in, what goes out, and the heated coolant to a linked turbine or boiler.
  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.fuelInput)
    if r and r > 0 then E.insert(mb.fuel, FUEL, r) end
    r = E.rate(s.coolantInput)
    if r and r > 0 then
      if not E.isEmpty(mb.gasCoolant) then E.insert(mb.gasCoolant, mb.gasCoolant.name, r)
      else E.insert(mb.fluidCoolant, WATER, r) end
    end
    r = E.rate(s.wasteOutput)
    if r and r > 0 and E.portAllows(mb, "OUTPUT_WASTE") then E.shrink(mb.waste, r) end
    local to = E.link(mb, "heatedCoolantTo")
    r = E.rate(s.heatedCoolantOutput) or (to and math.huge)
    if r and r > 0 and mb.heatedCoolant.amount > 0 and E.portAllows(mb, "OUTPUT_COOLANT") then
      local n = min(r, mb.heatedCoolant.amount)
      if to then n = to.K.accept and to.K.accept(to, mb.heatedCoolant.name, n) or 0 end
      E.shrink(mb.heatedCoolant, n)
    end
  end

  --- Cooled coolant from a boiler (cooledCoolantTo) comes in here.
  function K.accept(mb, name, amount)
    if not mb.formed or mb.destroyed then return 0 end
    if E.COOLED[name] then return E.insert(mb.gasCoolant, name, amount) end
    if E.WATER[name] then return E.insert(mb.fluidCoolant, name, amount) end
    return 0
  end

  function K.redstoneLevel(mb) return E.redstoneLevel(mb.fuel.amount, mb.fuel.cap()) end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      temperature = function(v) mb.heat.heat, mb.heat.pending = mb.heat.capacity * tonumber(v), 0 end,
      damage = function(v) mb.damage = tonumber(v) end,
      burnRate = function(v) mb.rateLimit = max(min(maxBurnRate(mb), tonumber(v)), 0) end,
      active = function(v) mb.active = v == true end,
      forceDisabled = function(v) mb.forceDisabled = v == true end,
      fuelAssemblies = function(v) mb.fuelAssemblies = floor(tonumber(v)) end,
      surfaceArea = function(v) mb.surfaceArea = floor(tonumber(v)) end,
    })
  end

  function K.state(mb)
    return {
      temperature = E.temp(mb.heat), damage = mb.damage, active = mb.active, forceDisabled = mb.forceDisabled,
      burnRate = mb.rateLimit, actualBurnRate = mb.lastBurnRate, heatingRate = mb.lastBoilRate,
      fuel = E.tankState(mb.fuel), waste = E.tankState(mb.waste), coolant = E.tankState(mb.fluidCoolant),
      gasCoolant = E.tankState(mb.gasCoolant), heatedCoolant = E.tankState(mb.heatedCoolant),
      radiated = mb.radiated, meltdowns = mb.meltdowns, meltdownPending = mb.meltdownQueue ~= nil or nil,
    }
  end

  -- ===== computer methods =====

  local function err(msg) J.computerError(msg) end

  local MB = {}
  MB.getFuelAssemblies = { {}, function(c) return c.mb.fuelAssemblies end }
  MB.getFuelSurfaceArea = { {}, function(c) return c.mb.surfaceArea end }
  E.tankMethods(MB, "Fuel", function(mb) return mb.fuel end)
  E.tankMethods(MB, "HeatedCoolant", function(mb) return mb.heatedCoolant end)
  E.tankMethods(MB, "Waste", function(mb) return mb.waste end)
  MB.getTemperature = { {}, function(c) return E.temp(c.mb.heat) end }
  MB.getEnvironmentalLoss = { {}, function(c) return c.mb.lastEnvironmentLoss end }
  MB.getHeatingRate = { {}, function(c) return c.mb.lastBoilRate end }
  MB.getActualBurnRate = { {}, function(c) return c.mb.lastBurnRate end }
  MB.getBurnRate = { {}, function(c) return c.mb.rateLimit end }
  MB.isForceDisabled = { {}, function(c) return c.mb.forceDisabled end }
  MB.getStatus = { {}, function(c) return c.mb.active end }
  MB.getBoilEfficiency = { {}, function(c) return boilEfficiency(c.mb) end }
  MB.getMaxBurnRate = { {}, function(c) return maxBurnRate(c.mb) end }
  MB.getDamagePercent = { {}, function(c) return floor(c.mb.damage / MAX_DAMAGE * 100 + 0.5) end } -- Math.round
  MB.activate = E.void({}, function(c)
    if c.mb.active then err("Reactor is already active.")
    elseif c.mb.forceDisabled then err("Reactor must reach safe damage and temperature levels before it can be reactivated.") end
    setActive(c.mb, true)
  end)
  MB.scram = E.void({}, function(c)
    if not c.mb.active then err("Scram requires the reactor to be active.") end
    setActive(c.mb, false)
  end)
  MB.setBurnRate = E.void({ "double" }, function(c, rate)
    rate = E.toLong(rate * 100) / 100 -- UnitDisplayUtils.roundDecimals(rate, 2)
    local maxRate = maxBurnRate(c.mb)
    if rate < 0 or rate > maxRate then
      -- ComputerException("Burn Rate '%d' ...", double, long): String.format throws on %d with a Double, and
      -- BoundComputerMethod.run passes the IllegalFormatConversionException's message on
      err("d != java.lang.Double")
    end
    c.mb.rateLimit = max(min(maxRate, rate), 0)
  end)
  local function gasCoolantShown(mb) return E.isEmpty(mb.fluidCoolant) and not E.isEmpty(mb.gasCoolant) end
  MB.getCoolant = { {}, function(c)
    return E.stack(gasCoolantShown(c.mb) and c.mb.gasCoolant or c.mb.fluidCoolant)
  end }
  MB.getCoolantCapacity = { {}, function(c) return (gasCoolantShown(c.mb) and c.mb.gasCoolant or c.mb.fluidCoolant).cap() end }
  MB.getCoolantNeeded = { {}, function(c) return E.needed(gasCoolantShown(c.mb) and c.mb.gasCoolant or c.mb.fluidCoolant) end }
  MB.getCoolantFilledPercentage = { {}, function(c)
    local t = gasCoolantShown(c.mb) and c.mb.gasCoolant or c.mb.fluidCoolant
    return t.amount / t.cap()
  end }
  MB.getHeatCapacity = { {}, function(c) return c.mb.heat.capacity end }
  E.shapeMethods(MB)

  --- getRedstoneLogicStatus (TileEntityFissionReactorLogicAdapter.getStatus)
  local function logicStatus(c)
    local mb, b = c.mb, c.block
    if mb.formed and not mb.destroyed then
      local l = b.logic
      if l == "ACTIVATION" then
        if b.powered then return "POWERED" end
      elseif l == "TEMPERATURE" then
        if E.temp(mb.heat) >= MIN_DAMAGE_TEMPERATURE then return "OUTPUTTING" end
      elseif l == "EXCESS_WASTE" then
        if E.needed(mb.waste) == 0 then return "OUTPUTTING" end
      elseif l == "DAMAGED" then
        if mb.damage >= MAX_DAMAGE then return "OUTPUTTING" end
      elseif l == "DEPLETED" then
        if E.isEmpty(mb.fuel) then return "OUTPUTTING" end
      end
    end
    return "IDLE"
  end

  local ADAPTER = {
    getLogicMode = { {}, function(c) return c.block.logic end },
    getRedstoneLogicStatus = { {}, logicStatus },
    setLogicMode = E.void({ "FissionReactorLogic" }, function(c, mode) c.block.logic = mode end),
    isFormed = E.T.isFormed,
    getRedstoneMode = { {}, function(c) return c.block.redstoneControl end },
    setRedstoneMode = E.void({ "RedstoneControl" }, function(c, mode)
      if mode == "PULSE" then err("Unsupported redstone control mode: PULSE") end -- canPulse() is false
      c.block.redstoneControl = mode
    end),
  }

  local PORT_MODES = J.ENUMS.FissionPortMode
  local PORT = {
    getMode = { {}, function(c) return c.block.portMode end },
    setMode = E.void({ "FissionPortMode" }, function(c, mode) c.block.portMode = mode end),
    incrementMode = E.void({}, function(c) c.block.portMode = E.cycle(PORT_MODES, c.block.portMode, 1) end),
    decrementMode = E.void({}, function(c) c.block.portMode = E.cycle(PORT_MODES, c.block.portMode, -1) end),
  }

  local function upperEnum(list, v, default)
    v = type(v) == "string" and v:upper() or default
    for _, x in ipairs(list) do if x == v then return v end end
    error("ccsim: '" .. tostring(v) .. "' is not one of " .. table.concat(list, ", "), 0)
  end

  K.types = {
    fissionReactorLogicAdapter = {
      tile = ADAPTER, multiblock = MB,
      newBlock = function(def)
        return {
          logic = upperEnum(J.ENUMS.FissionReactorLogic, def.logicMode, "DISABLED"),
          redstoneControl = upperEnum(J.ENUMS.RedstoneControl, def.redstoneMode, "DISABLED"),
          powered = def.powered == true,
        }
      end,
      blockState = function(c, s)
        s.logicMode, s.redstoneMode, s.powered, s.redstoneStatus = c.block.logic, c.block.redstoneControl, c.block.powered, logicStatus(c)
      end,
      -- onPowerChange: in Activation mode the redstone signal turns the reactor on and off
      onPowerChange = function(c)
        if c.mb.formed and not c.mb.destroyed and c.block.logic == "ACTIVATION" then setActive(c.mb, c.block.powered) end
      end,
    },
    fissionReactorPort = {
      tile = PORT,
      newBlock = function(def) return { portMode = upperEnum(PORT_MODES, def.mode, "INPUT") } end,
      blockState = function(c, s) s.mode = c.block.portMode end,
    },
  }

  return K
end
