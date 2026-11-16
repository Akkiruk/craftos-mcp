-- ccsim addons/mekanism-generators/turbine: the Industrial Turbine (see ../mekanism-machines/engine.lua).
--
-- Mekanism Generators 10.2.5 source, src/generators/java/mekanism/generators/common/:
--   content/turbine/TurbineMultiblockData (tick, dumping, every computer method), content/turbine/TurbineGasTank
--   (steam input counted for getLastSteamInputRate), content/turbine/TurbineValidator (MAX_BLADES 28, lowerVolume,
--   blades, coils, vents), tile/turbine/TileEntityTurbineValve (energy containers, emits energy);
--   Mekanism: content/evaporation/EvaporationMultiblockData.FLUID_PER_TANK (64000 steam per lower block).
return function(E)
  local J, C, FL = E.J, E.C, E.FL
  local floor, min, max = math.floor, math.min, math.max

  J.ENUMS.GasMode = { "IDLE", "DUMPING_EXCESS", "DUMPING" }

  local GAS_PER_TANK, MAX_BLADES = 64000, 28
  local STEAM = "mekanism:steam"

  local K = { kind = "turbine", defaults = { length = 5, width = 5, height = 9 } }
  K.defaultFluid = { steam = STEAM }
  K.rates = { steamInput = true, energyOutput = true, energyTo = true }

  function K.init(mb, spec)
    mb.blades = floor(tonumber(spec.blades) or 6)
    mb.coils = floor(tonumber(spec.coils) or 2)
    mb.vents = floor(tonumber(spec.vents) or 12)
    mb.condensers = floor(tonumber(spec.condensers) or 0)
    -- lowerVolume: length * width * rotors, rotors = complex.y - min.y + 1 (the rotor blocks and the floor)
    mb.lowerVolume = floor(tonumber(spec.lowerVolume) or (mb.length * mb.width * (floor(mb.blades / 2) + 1)))
    mb.steam = E.tank(true, function() return mb.lowerVolume * GAS_PER_TANK end, function(n) return n == STEAM end)
    mb.tanks = { steam = mb.steam }
    E.fill(mb.steam, spec.steam, STEAM)
    mb.energy = E.energyContainer(function() return mb.volume * 16000000 end) -- 16 MJ per block of volume
    mb.energy.stored = FL.create(min(tonumber(spec.energy) or 0, mb.volume * 16000000))
    local dump = type(spec.dumpingMode) == "string" and spec.dumpingMode:upper() or "IDLE"
    mb.dumpMode = dump
    mb.lastSteamInput, mb.newSteamInput, mb.clientFlow = 0, 0, 0
    mb.vented = 0 -- water the condensers made, mB in total
  end

  local function dispersers(mb) return (mb.length - 2) * (mb.width - 2) - 1 end
  local function multiplier(mb)
    return FL.multiply(FL.divide(C.maxEnergyPerSteam, MAX_BLADES), min(mb.blades, mb.coils * C.turbineBladesPerCoil))
  end
  local function maxRate(mb)
    local rate = mb.lowerVolume * (dispersers(mb) * C.turbineDisperserGasFlow)
    return min(rate, mb.vents * C.turbineVentGasFlow)
  end

  local function dumpingAmount(mb, stored)
    return min(stored, max(floor(stored / 50), mb.lastSteamInput * 2))
  end

  function K.tick(mb)
    mb.lastSteamInput = mb.newSteamInput
    mb.newSteamInput = 0
    local stored = mb.steam.amount
    local needed = mb.energy:needed()
    if stored > 0 and needed > 0 then
      local mult = multiplier(mb)
      if mult == 0 then
        mb.clientFlow = 0
      else
        local rate = maxRate(mb)
        local proportion = stored / mb.steam.cap()
        rate = min(min(stored, rate), FL.divide(needed, mult)) * proportion
        mb.clientFlow = E.toLong(rate)
        if mb.clientFlow > 0 then
          mb.energy:insert(FL.multiply(mult, FL.create(rate)))
          E.shrink(mb.steam, mb.clientFlow)
          mb.vented = mb.vented + min(E.toInt(rate), mb.condensers * C.condenserRate)
        end
      end
    else
      mb.clientFlow = 0
    end
    if mb.dumpMode ~= "IDLE" and mb.steam.amount > 0 then
      local amount = mb.steam.amount
      if mb.dumpMode == "DUMPING" then
        E.shrink(mb.steam, dumpingAmount(mb, amount))
      else
        local targetLevel = E.toLong(mb.steam.cap() * C.dumpExcessKeepRatio)
        if targetLevel < amount then E.shrink(mb.steam, min(amount - targetLevel, dumpingAmount(mb, amount))) end
      end
    end
  end

  --- Steam from a linked reactor or boiler: TurbineGasTank.insert counts it toward the next tick's input rate.
  function K.accept(mb, name, amount)
    if not mb.formed or mb.destroyed or name ~= STEAM then return 0 end
    local n = E.insert(mb.steam, name, amount)
    mb.newSteamInput = mb.newSteamInput + n
    return n
  end

  --- The valves emit all the energy they can (CableUtils.emit), to a linked matrix or `energyOutput` J/t away.
  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.steamInput)
    if r and r > 0 then K.accept(mb, STEAM, r) end
    local to = E.link(mb, "energyTo")
    r = E.rate(s.energyOutput) or (to and math.huge)
    if r and r > 0 and mb.energy.stored > 0 then
      local n = min(r, mb.energy.stored)
      if to then n = to.K.acceptEnergy and to.K.acceptEnergy(to, n) or 0 end
      mb.energy:extract(n)
    end
  end

  function K.redstoneLevel(mb) return E.redstoneLevel(mb.steam.amount, mb.steam.cap()) end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), mb.energy:max())) end,
      dumpingMode = function(v) mb.dumpMode = tostring(v):upper() end,
      blades = function(v) mb.blades = floor(tonumber(v)) end,
      coils = function(v) mb.coils = floor(tonumber(v)) end,
      vents = function(v) mb.vents = floor(tonumber(v)) end,
      condensers = function(v) mb.condensers = floor(tonumber(v)) end,
    })
  end

  function K.state(mb)
    return {
      steam = E.tankState(mb.steam), energy = mb.energy.stored, flowRate = mb.clientFlow,
      productionRate = FL.multiply(multiplier(mb), mb.clientFlow), lastSteamInput = mb.lastSteamInput,
      dumpingMode = mb.dumpMode, water = mb.vented,
    }
  end

  -- ===== computer methods =====

  local MODES = J.ENUMS.GasMode
  local MB = {}
  E.tankMethods(MB, "Steam", function(mb) return mb.steam end)
  MB.getDumpingMode = { {}, function(c) return c.mb.dumpMode end }
  MB.getBlades = { {}, function(c) return c.mb.blades end }
  MB.getVents = { {}, function(c) return c.mb.vents end }
  MB.getCoils = { {}, function(c) return c.mb.coils end }
  MB.getCondensers = { {}, function(c) return c.mb.condensers end }
  MB.getLastSteamInputRate = { {}, function(c) return c.mb.lastSteamInput end }
  MB.getFlowRate = { {}, function(c) return c.mb.clientFlow end }
  MB.getDispersers = { {}, function(c) return dispersers(c.mb) end }
  MB.getProductionRate = { {}, function(c) return FL.multiply(multiplier(c.mb), c.mb.clientFlow) end }
  MB.getMaxProduction = { {}, function(c) return FL.multiply(multiplier(c.mb), FL.create(maxRate(c.mb))) end }
  MB.getMaxFlowRate = { {}, function(c) return E.toLong(maxRate(c.mb)) end }
  MB.getMaxWaterOutput = { {}, function(c) return c.mb.condensers * C.condenserRate end }
  MB.setDumpingMode = E.void({ "GasMode" }, function(c, mode) c.mb.dumpMode = mode end)
  MB.incrementDumpingMode = E.void({}, function(c) c.mb.dumpMode = E.cycle(MODES, c.mb.dumpMode, 1) end)
  MB.decrementDumpingMode = E.void({}, function(c) c.mb.dumpMode = E.cycle(MODES, c.mb.dumpMode, -1) end)
  E.shapeMethods(MB)

  local VALVE = { isFormed = E.T.isFormed, getComparatorLevel = E.T.getComparatorLevel }
  E.energyMethods(VALVE, function(mb) return { mb.energy } end)

  K.types = { turbineValve = { tile = VALVE, multiblock = MB } }
  return K
end
