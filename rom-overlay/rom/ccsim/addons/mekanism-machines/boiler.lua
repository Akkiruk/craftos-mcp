-- ccsim addons/mekanism-machines/boiler: the Thermoelectric Boiler (see engine.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   content/boiler/BoilerMultiblockData (tick: environment, coolant cooling, boiling; getBoilCapacity; the volumes),
--   tile/multiblock/TileEntityBoilerValve (valve modes), tile/multiblock/TileEntityBoilerCasing,
--   block/attribute/AttributeStateBoilerValveMode, config/GeneralConfig (boilerWaterConductivity,
--   superheatingHeatTransfer, maxEnergyPerSteam).
return function(E)
  local J, C = E.J, E.C
  local floor, min, max = math.floor, math.min, math.max

  J.ENUMS.BoilerValveMode = { "INPUT", "OUTPUT_STEAM", "OUTPUT_COOLANT" }

  local CASING_HEAT_CAPACITY = 50
  local CASING_INVERSE_INSULATION, CASING_INVERSE_CONDUCTION = 100000, 1
  local WATER_PER_VOLUME, STEAM_PER_VOLUME = 16000, 160000
  local SUPERHEATED_COOLANT_PER_VOLUME, COOLED_COOLANT_PER_VOLUME = 256000, 256000
  local COOLANT_COOLING_EFFICIENCY = 0.4
  local HEATED_COOLANT_TEMP = 100000
  local STEAM, WATER = "mekanism:steam", "minecraft:water"

  local K = { kind = "boiler", defaults = { length = 5, width = 5, height = 6 } }
  K.defaultFluid = { water = WATER, steam = STEAM, heatedCoolant = "mekanism:superheated_sodium", cooledCoolant = "mekanism:sodium" }
  K.rates = { waterInput = true, heatInput = true, steamOutput = true, steamTo = true, cooledCoolantOutput = true,
    cooledCoolantTo = true }

  function K.init(mb, spec)
    local inner = max(1, (mb.length - 2) * (mb.width - 2))
    -- the cavity below the dispersers holds water, the one above steam (BoilerValidator)
    mb.waterVolume = floor(tonumber(spec.waterVolume) or inner * 2)
    mb.steamVolume = floor(tonumber(spec.steamVolume) or inner * max(1, mb.height - 2 - 2 - 1))
    mb.superheaters = floor(tonumber(spec.superheaters) or 0)
    mb.water = E.tank(false, function() return mb.waterVolume * WATER_PER_VOLUME end, function(n) return E.WATER[n] == true end)
    mb.steam = E.tank(true, function() return mb.steamVolume * STEAM_PER_VOLUME end, function(n) return n == STEAM end)
    mb.heatedCoolant = E.tank(true, function() return mb.waterVolume * SUPERHEATED_COOLANT_PER_VOLUME end,
      function(n) return E.HEATED[n] ~= nil end)
    mb.cooledCoolant = E.tank(true, function() return mb.steamVolume * COOLED_COOLANT_PER_VOLUME end,
      function(n) return E.COOLED[n] ~= nil end)
    mb.tanks = { water = mb.water, steam = mb.steam, heatedCoolant = mb.heatedCoolant, cooledCoolant = mb.cooledCoolant }
    for name, t in pairs(mb.tanks) do E.fill(t, spec[name], K.defaultFluid[name]) end
    mb.heat = E.capacitor(CASING_HEAT_CAPACITY * mb.casings, mb.ambient)
    if spec.temperature then mb.heat.heat = mb.heat.capacity * tonumber(spec.temperature) end
    mb.lastEnvironmentLoss, mb.lastBoilRate, mb.lastMaxBoil = 0, 0, 0
  end

  local function heatAvailable(mb)
    local h = mb.heat
    local available = (E.temp(h) - E.BASE_BOIL_TEMP) * (h.capacity * C.boilerWaterConductivity)
    return min(available, C.superheatingHeatTransfer * mb.superheaters)
  end

  function K.tick(mb)
    local h = mb.heat
    -- heaters next to the valves (resistive heaters, a fuelwood heater) put their heat in during their own tick
    local heatIn = E.rate(mb.spec.heatInput)
    if heatIn and heatIn > 0 and heatIn < math.huge then h.pending = h.pending + heatIn end
    -- simulateEnvironment
    local invConduction = E.AIR_INVERSE_COEFFICIENT + (CASING_INVERSE_INSULATION + CASING_INVERSE_CONDUCTION)
    local tempToTransfer = (E.temp(h) - mb.ambient) / invConduction
    h.pending = h.pending - tempToTransfer * h.capacity
    mb.lastEnvironmentLoss = max(tempToTransfer, 0)
    E.update(h)
    -- heated coolant gives its heat up and comes out cooled
    if mb.heatedCoolant.amount > 0 then
      local coolant = E.HEATED[mb.heatedCoolant.name]
      if coolant then
        local toCool = floor(COOLANT_COOLING_EFFICIENCY * mb.heatedCoolant.amount + 0.5) -- Math.round
        toCool = E.toLong(toCool * (1 - E.temp(h) / HEATED_COOLANT_TEMP))
        if toCool > 0 then toCool = E.insert(mb.cooledCoolant, coolant.cooled, toCool) end
        if toCool > 0 then
          h.pending = h.pending + toCool * coolant.enthalpy
          E.shrink(mb.heatedCoolant, toCool)
        end
      end
    end
    -- water boils
    if E.temp(h) >= E.BASE_BOIL_TEMP and mb.water.amount > 0 then
      mb.lastMaxBoil = E.toInt(floor(E.STEAM_ENERGY_EFFICIENCY * heatAvailable(mb) / C.maxEnergyPerSteam))
      local amount = min(mb.lastMaxBoil, mb.water.amount)
      amount = min(amount, E.toInt(E.needed(mb.steam)))
      E.shrink(mb.water, amount)
      if amount > 0 then
        mb.steam.name = STEAM
        mb.steam.amount = mb.steam.amount + amount
      end
      h.pending = h.pending - amount * C.maxEnergyPerSteam / E.STEAM_ENERGY_EFFICIENCY
      mb.lastBoilRate = amount
    else
      mb.lastBoilRate, mb.lastMaxBoil = 0, 0
    end
  end

  --- Water and superheated coolant come in through the valves (a linked reactor sends its heated coolant here).
  function K.accept(mb, name, amount)
    if not mb.formed or mb.destroyed then return 0 end
    if E.HEATED[name] then return E.insert(mb.heatedCoolant, name, amount) end
    if E.WATER[name] then return E.insert(mb.water, name, amount) end
    return 0
  end

  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.waterInput)
    if r and r > 0 then E.insert(mb.water, WATER, r) end
    local to = E.link(mb, "steamTo")
    r = E.rate(s.steamOutput) or (to and math.huge)
    if r and r > 0 and mb.steam.amount > 0 and E.portAllows(mb, "OUTPUT_STEAM") then
      local n = min(r, mb.steam.amount)
      if to then n = to.K.accept and to.K.accept(to, STEAM, n) or 0 end
      E.shrink(mb.steam, n)
    end
    to = E.link(mb, "cooledCoolantTo")
    r = E.rate(s.cooledCoolantOutput) or (to and math.huge)
    if r and r > 0 and mb.cooledCoolant.amount > 0 and E.portAllows(mb, "OUTPUT_COOLANT") then
      local n = min(r, mb.cooledCoolant.amount)
      if to then n = to.K.accept and to.K.accept(to, mb.cooledCoolant.name, n) or 0 end
      E.shrink(mb.cooledCoolant, n)
    end
  end

  function K.redstoneLevel(mb) return E.redstoneLevel(mb.water.amount, mb.water.cap()) end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      temperature = function(v) mb.heat.heat, mb.heat.pending = mb.heat.capacity * tonumber(v), 0 end,
      superheaters = function(v) mb.superheaters = floor(tonumber(v)) end,
    })
  end

  function K.state(mb)
    return {
      temperature = E.temp(mb.heat), boilRate = mb.lastBoilRate, maxBoilRate = mb.lastMaxBoil,
      water = E.tankState(mb.water), steam = E.tankState(mb.steam), heatedCoolant = E.tankState(mb.heatedCoolant),
      cooledCoolant = E.tankState(mb.cooledCoolant),
    }
  end

  -- ===== computer methods =====

  local MB = {}
  E.tankMethods(MB, "HeatedCoolant", function(mb) return mb.heatedCoolant end)
  E.tankMethods(MB, "CooledCoolant", function(mb) return mb.cooledCoolant end)
  E.tankMethods(MB, "Water", function(mb) return mb.water end)
  E.tankMethods(MB, "Steam", function(mb) return mb.steam end)
  MB.getTemperature = { {}, function(c) return E.temp(c.mb.heat) end }
  MB.getEnvironmentalLoss = { {}, function(c) return c.mb.lastEnvironmentLoss end }
  MB.getBoilRate = { {}, function(c) return c.mb.lastBoilRate end }
  MB.getMaxBoilRate = { {}, function(c) return c.mb.lastMaxBoil end }
  MB.getSuperheaters = { {}, function(c) return c.mb.superheaters end }
  MB.getBoilCapacity = { {}, function(c)
    local capacity = C.superheatingHeatTransfer * c.mb.superheaters / C.maxEnergyPerSteam
    return E.toLong(capacity * E.STEAM_ENERGY_EFFICIENCY)
  end }
  E.shapeMethods(MB)

  local MODES = J.ENUMS.BoilerValveMode
  local VALVE = {
    getMode = { {}, function(c) return c.block.portMode end },
    setMode = E.void({ "BoilerValveMode" }, function(c, mode) c.block.portMode = mode end),
    incrementMode = E.void({}, function(c) c.block.portMode = E.cycle(MODES, c.block.portMode, 1) end),
    decrementMode = E.void({}, function(c) c.block.portMode = E.cycle(MODES, c.block.portMode, -1) end),
    isFormed = E.T.isFormed,
    getComparatorLevel = E.T.getComparatorLevel,
  }

  K.types = {
    boilerValve = {
      tile = VALVE, multiblock = MB,
      newBlock = function(def)
        local m = type(def.mode) == "string" and def.mode:upper() or "INPUT"
        for _, x in ipairs(MODES) do if x == m then return { portMode = m } end end
        error("ccsim: boiler valve mode '" .. m .. "' is not one of " .. table.concat(MODES, ", "), 0)
      end,
      blockState = function(c, s) s.mode = c.block.portMode end,
    },
  }
  return K
end
