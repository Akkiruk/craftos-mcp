-- ccsim addons/extreme-reactors: Extreme Reactors 2 reactor and turbine computer ports.
--
-- Written from ExtremeReactors2 tag 1.18.2-2.0.71 and ZeroCore2 tag 1.18.2-2.1.39 (the library its computer code
-- lives in), and checked against those two jars with javap. The mod is not in the pack, so nothing here could be
-- measured in game. Source files, relative to src/main/java/it/zerono/mods/:
--   zerocore/lib/compat/computer/ConnectorComputerCraft, ComputerPeripheral, ComputerMethod, LuaHelper,
--     MultiblockComputerPeripheral; zerocore/lib/multiblock/AbstractMultiblockPart; zerocore/lib/CodeHelper
--     (formatAsHumanReadableNumber); zerocore/lib/data/WideAmount; zerocore/lib/energy/WideEnergyBuffer;
--   extremereactors/gamecontent/multiblock/reactor/computer/ReactorComputerPeripheral,
--     .../reactor/MultiblockReactor, ReactorLogic, FuelContainer, FuelRodsMap, FuelRodsLayout, Heat, Stats,
--     .../reactor/part/ReactorFuelRodEntity, ReactorControlRodEntity, AbstractReactorEntity,
--     .../reactor/variant/ReactorVariant, .../common/FluidContainer, gamecontent/ReactorGameData;
--   extremereactors/gamecontent/multiblock/turbine/computer/TurbineComputerPeripheral,
--     .../turbine/MultiblockTurbine, TurbineLogic, TurbineData, VentSetting, variant/TurbineVariant,
--     gamecontent/TurbineGameData; extremereactors/api/reactor/* (Moderator, FuelProperties, IHeatEntity,
--     radiation/EnergyConversion, radiation/IrradiationData); extremereactors/config/*.
-- docs/extreme-reactors.md lists every behaviour with its line, and what could not be confirmed.
--
-- Every computer method of both ports runs on the computer thread (ZeroCore's IDynamicPeripheral has no main-thread
-- methods). The setters are queued for the next server tick and return nothing at once; whatever goes wrong in them
-- there is only logged. The machines run on the virtual clock: each 50 ms is a server tick, simulated tick by tick
-- (with Java's float arithmetic where the mod uses floats) whenever anything looks.
return function(core, host)
  local floor, abs, exp, cos, min, max, huge = math.floor, math.abs, math.exp, math.cos, math.min, math.max, math.huge
  local log10 = math.log10 or function(x) return math.log(x, 10) end
  local PI = math.pi

  local cfg = core.world.extremeReactors or {}

  -- ===== Java float arithmetic =====

  local frexp = math.frexp
  if not frexp then
    frexp = function(x)
      if x == 0 then return 0, 0 end
      local e = floor(math.log(abs(x)) / math.log(2)) + 1
      local m = x / 2 ^ e
      while abs(m) >= 1 do m, e = m / 2, e + 1 end
      while abs(m) < 0.5 do m, e = m * 2, e - 1 end
      return m, e
    end
  end

  local function roundHalfEven(v)
    local f = floor(v)
    local d = v - f
    if d > 0.5 then return f + 1 elseif d < 0.5 then return f end
    return (f % 2 == 0) and f or f + 1
  end

  --- The nearest IEEE single (Java's (float) cast, round half to even).
  local function F(x)
    if x ~= x or x == 0 or x == huge or x == -huge then return x end
    local m, e = frexp(x)
    if e < -125 then
      local q = 2 ^ -149
      return roundHalfEven(x / q) * q
    end
    local r = roundHalfEven(m * 16777216) * 2 ^ (e - 24)
    if abs(r) > 3.4028234663852886e38 then return r > 0 and huge or -huge end
    return r
  end

  --- (int)/(long) of a double: toward zero, NaN is 0.
  local function trunc(x)
    if x ~= x then return 0 end
    if x >= 0 then return floor(x) end
    return -floor(-x)
  end

  local function toInt32(n)
    n = n % 4294967296
    if n >= 2147483648 then n = n - 4294967296 end
    return n
  end

  --- Math.round(double) then (int), as LuaHelper.getIntFromArgs does.
  local function javaRoundInt(x)
    if x ~= x then return 0 end
    local r = floor(x + 0.5)
    if r > 9.2233720368547758e18 then r = 9.2233720368547758e18 elseif r < -9.2233720368547758e18 then r = -9.2233720368547758e18 end
    return toInt32(r)
  end

  --- Java's String.format("%.2f", v): the shortest decimal that reads back as v, rounded half up.
  local function javaFixed2(v)
    if v ~= v then return "NaN" end
    if v == huge then return "Infinity" elseif v == -huge then return "-Infinity" end
    local s
    for p = 1, 17 do
      s = ("%." .. p .. "g"):format(v)
      if tonumber(s) == v then break end
    end
    local neg = s:sub(1, 1) == "-"
    if neg then s = s:sub(2) end
    local mant, ex = s:match("^([%d%.]+)e([-+]%d+)$")
    mant = mant or s
    ex = tonumber(ex) or 0
    local ip, fp = mant:match("^(%d*)%.?(%d*)$")
    local digits = ip .. fp
    local point = #ip + ex
    if point <= 0 then digits = ("0"):rep(1 - point) .. digits; point = 1 end
    if #digits < point + 3 then digits = digits .. ("0"):rep(point + 3 - #digits) end
    local keep = digits:sub(1, point + 2)
    local nextDigit = tonumber(digits:sub(point + 3, point + 3)) or 0
    local n = {}
    for i = 1, #keep do n[i] = tonumber(keep:sub(i, i)) end
    if nextDigit >= 5 then
      local i = #n
      while i >= 1 do
        if n[i] == 9 then n[i] = 0; i = i - 1 else n[i] = n[i] + 1; break end
      end
      if i < 1 then table.insert(n, 1, 1); point = point + 1 end
    end
    local str = table.concat(n)
    local intPart = str:sub(1, point):gsub("^0+(%d)", "%1")
    if intPart == "" then intPart = "0" end
    local out = intPart .. "." .. str:sub(point + 1, point + 2)
    if neg and out:match("[1-9]") then out = "-" .. out end
    return out
  end

  local SI = { [24] = "Y", [21] = "Z", [18] = "E", [15] = "P", [12] = "T", [9] = "G", [6] = "M", [3] = "k", [0] = "",
    [-3] = "m", [-6] = "?", [-9] = "n", [-12] = "p", [-15] = "f", [-18] = "a", [-21] = "z", [-24] = "y" }
  -- [-6]: CodeHelper writes U+03BC (Greek mu); CC turns a char above 255 into "?" (not confirmed in game)

  --- CodeHelper.formatAsHumanReadableNumber(double, unit)
  local function humanReadable(value, unit)
    local order = 0
    if value ~= 0 then
      while value > 1000.0 do value = value / 1000.0; order = order + 3 end
      while value < 1.0 do value = value * 1000.0; order = order - 3 end
    end
    return javaFixed2(value) .. " " .. tostring(SI[order] or "null") .. unit
  end

  -- ===== constants (floats as Java widens them) =====

  local F001, F01, F02, F05, F025 = F(0.01), F(0.1), F(0.2), F(0.5), F(0.25)
  local AMBIENT_HEAT = F(20.0)                     -- IHeatEntity.AMBIENT_HEAT
  local CONDUCTIVITY_AIR, CONDUCTIVITY_IRON = F(0.05), F(0.6)
  local ENERGY_PER_RADIATION_UNIT = 10             -- EnergyConversion
  local ENERGY_PER_C_PER_VOLUME = 10
  local REACTOR_HEAT_LOSS_CONDUCTIVITY = F(0.001)  -- MultiblockReactor
  local FUEL_CAPACITY_PER_FUEL_ROD = 4000          -- ReactorFuelRodEntity: 4 ingots of 1000 mB
  local SOLID_REACTANT_AMOUNT = 1000
  local COOLANT_BOILING_POINT = F(100.0)           -- ReactorGameData: water
  local COOLANT_ENTHALPY = F(4.0)
  local STEAM_ENERGY_DENSITY = F(10.0)
  local INDUCTOR_BASE_DRAG = F(F(0.1) * 1.0)       -- TurbineData, turbineCoilDragMultiplier 1.0
  local BASE_BLADE_DRAG = F(0.00025)

  local general = cfg.config or {}
  local FUEL_USAGE_MULT = F(tonumber(general.fuelUsageMultiplier) or 1.0)
  local POWER_MULT = tonumber(general.powerProductionMultiplier) or 1.0
  local REACTOR_POWER_MULT = tonumber(general.reactorPowerProductionMultiplier) or 1.0
  local TURBINE_POWER_MULT = tonumber(general.turbinePowerProductionMultiplier) or 1.0
  local TURBINE_AERO_MULT = F(tonumber(general.turbineAeroDragMultiplier) or 1.0)
  local TURBINE_MASS_MULT = F(tonumber(general.turbineMassDragMultiplier) or 1.0)
  local TURBINE_FLUID_PER_BLADE_MULT = tonumber(general.turbineFluidPerBladeMultiplier) or 1.0

  local REACTOR_VARIANTS = {
    basic = { partEnergyCapacity = 10000, energyEfficiency = F(0.8), maxExtract = 50000, partFluidCapacity = 0,
      maxFluidCapacity = 0, vaporEfficiency = F(0) },
    reinforced = { partEnergyCapacity = 30000, energyEfficiency = F(0.85), maxExtract = 5000000, partFluidCapacity = 1000,
      maxFluidCapacity = 200000, vaporEfficiency = F(0.85) },
  }
  local TURBINE_VARIANTS = {
    basic = { partEnergyCapacity = 10000, maxExtract = 50000, maxFlow = 1000, fluidPerBlade = 15, dragCoefficient = F(0.01),
      bladeMass = 8, shaftMass = 8, partFluidCapacity = 250, maxFluidCapacity = 10000 },
    reinforced = { partEnergyCapacity = 20000, maxExtract = 5000000, maxFlow = 2000, fluidPerBlade = 25,
      dragCoefficient = F(0.01), bladeMass = 10, shaftMass = 10, partFluidCapacity = 500, maxFluidCapacity = 300000 },
  }

  -- Fuels: FuelProperties(moderationFactor, absorptionCoefficient, hardnessDivisor, fissionEventsPerFuelUnit,
  -- fuelUnitsPerFissionEvent) and the reaction's reactivity and waste (ReactorGameData).
  local FUELS = {
    yellorium = { props = { F(1.5), F(0.5), F(1.0), F(0.01), F(0.0007) }, reactivity = F(1.05), waste = "cyanite" },
    blutonium = { props = { F(2.23), F(0.6), F(2.0), F(0.0137), F(0.0006) }, reactivity = F(1.0871), waste = "magentite" },
    verderium = { props = { F(3.74), F(0.8741), F(2.0049), F(0.0312), F(0.0081) }, reactivity = F(1.0984), waste = "rossinite" },
  }

  -- Moderators: absorption, heat efficiency, moderation, conductivity (Moderator.AIR/WATER, ReactorGameData).
  local C_STONE, C_WATER, C_GLASS, C_COPPER, C_SILVER, C_GOLD, C_EMERALD, C_DIAMOND =
    0.15, 0.1, 0.3, 1, 1.5, 2, 2.5, 3
  local MOD = {
    air = { 0.1, 0.25, 1.1, 0.05 }, water = { 0.33, 0.5, 1.33, C_WATER },
    apatite = { 0.48, 0.73, 1.30, C_STONE }, cinnabar = { 0.48, 0.75, 1.32, C_STONE },
    iron = { 0.50, 0.75, 1.40, 0.6 }, manasteel = { 0.60, 0.75, 1.50, 0.6 }, elementium = { 0.61, 0.77, 1.52, C_EMERALD },
    nickel = { 0.51, 0.77, 1.40, 0.6 }, gold = { 0.52, 0.80, 1.45, C_GOLD }, diamond = { 0.55, 0.85, 1.50, C_DIAMOND },
    netherite = { 0.55, 0.95, 1.65, C_DIAMOND }, terrasteel = { 0.57, 0.87, 1.52, C_DIAMOND },
    emerald = { 0.55, 0.85, 1.50, C_EMERALD }, glass = { 0.20, 0.25, 1.10, C_GLASS }, copper = { 0.50, 0.75, 1.40, C_COPPER },
    brass = { 0.52, 0.78, 1.42, C_COPPER }, osmium = { 0.51, 0.77, 1.41, C_COPPER },
    refined_obsidian = { 0.53, 0.79, 1.42, C_COPPER }, refined_glowstone = { 0.54, 0.79, 1.44, C_EMERALD },
    bronze = { 0.51, 0.77, 1.41, C_COPPER }, zinc = { 0.51, 0.77, 1.41, C_COPPER }, aluminum = { 0.50, 0.78, 1.42, 0.6 },
    steel = { 0.50, 0.78, 1.42, 0.6 }, invar = { 0.50, 0.79, 1.43, 0.6 }, tin = { 0.50, 0.73, 1.38, C_SILVER },
    silver = { 0.51, 0.79, 1.43, C_SILVER }, signalum = { 0.51, 0.75, 1.42, C_COPPER }, lumium = { 0.51, 0.79, 1.45, C_SILVER },
    lead = { 0.75, 0.75, 1.75, C_SILVER }, electrum = { 0.53, 0.82, 1.47, 2.2 }, platinum = { 0.57, 0.86, 1.58, C_EMERALD },
    enderium = { 0.60, 0.88, 1.60, C_DIAMOND }, graphite = { 0.10, 0.50, 2.00, C_GOLD }, ice = { 0.33, 0.33, 1.15, C_WATER },
    dry_ice = { 0.42, 0.52, 1.32, C_WATER }, cryomisi = { 0.75, 0.55, 1.60, C_EMERALD }, tangerium = { 0.90, 0.75, 2.00, C_GOLD },
    redfrigium = { 0.66, 0.95, 6.00, C_DIAMOND }, liquid_starlight = { 0.92, 0.80, 2.00, C_DIAMOND },
    sodium = { 0.28, 0.60, 1.70, C_COPPER }, ethene = { 0.45, 0.65, 1.90, C_SILVER },
  }
  for k, v in pairs(MOD) do
    -- Moderator's setters clamp: absorption and efficiency to 0..1, moderation >= 1, conductivity >= 0
    MOD[k] = { absorption = F(v[1]), efficiency = F(v[2]), moderation = F(v[3]), conductivity = F(v[4]), name = k }
  end

  -- Turbine coils: efficiency, bonus, energy extraction rate (TurbineGameData).
  local COILS = {
    iron = { 1.0, 1.0, 1.0 }, manasteel = { 1.2, 1.03, 1.23 }, elementium = { 1.3, 1.05, 1.23 }, nickel = { 1.15, 1.06, 1.0 },
    gold = { 2.0, 1.0, 1.75 }, netherite = { 2.2, 1.02, 1.8 }, terrasteel = { 2.1, 1.01, 1.75 }, copper = { 1.2, 1.0, 1.2 },
    tin = { 1.1, 1.0, 1.1 }, osmium = { 1.2, 1.0, 1.2 }, refined_obsidian = { 1.2, 1.03, 1.28 },
    refined_glowstone = { 1.25, 1.05, 1.28 }, cobalt = { 1.2, 1.0, 1.2 }, zinc = { 1.35, 1.0, 1.3 }, ardite = { 1.35, 1.0, 1.3 },
    lead = { 1.35, 1.01, 1.3 }, brass = { 1.4, 1, 1.2 }, bronze = { 1.4, 1.0, 1.2 }, aluminum = { 1.5, 1.0, 1.3 },
    steel = { 1.5, 1.0, 1.3 }, invar = { 1.5, 1.0, 1.4 }, silver = { 1.7, 1.0, 1.5 }, signalum = { 1.6, 1.0, 1.4 },
    lumium = { 1.7, 1.02, 1.7 }, electrum = { 2.5, 1.0, 2.0 }, platinum = { 3.0, 1.0, 2.5 }, manyullyn = { 3.5, 1, 2.5 },
    enderium = { 3.0, 1.02, 3.0 }, ludicrite = { 5.23, 1.03939, 3.45 }, ridiculite = { 7.47, 1.2055, 3.46 },
    inanite = { 9.76, 1.3, 6.9328 }, insanite = { 13.74, 1.41, 6.9328 },
  }
  for k, v in pairs(COILS) do COILS[k] = { efficiency = F(v[1]), bonus = F(v[2]), extraction = F(v[3]) } end

  --- "minecraft:gold_block", "forge:storage_blocks/gold", "gold" all name the gold moderator/coil.
  local function materialKey(name)
    local s = tostring(name):lower()
    s = s:gsub("^forge:storage_blocks?/", ""):gsub("^forge:glass/colorless$", "glass"):gsub("^[%w_]+:", "")
    s = s:gsub("_block$", ""):gsub("^block_", ""):gsub("^flowing_", ""):gsub("_flowing$", ""):gsub("_fluid$", "")
    if s == "cave_air" or s == "void_air" then s = "air" end
    return s
  end

  -- ===== the clock =====

  local bootMs = core.nowMs()
  local startTick = tonumber(cfg.gameTime) or 0
  local lastTick = startTick - 1
  local function currentTick() return startTick + floor((core.nowMs() - bootMs) / 50) end

  local machines, byName = {}, {}
  local pending = {} -- { at = tick, fn = function } in call order

  local function fail(msg) error(msg, 0) end

  -- ===== arguments (LuaHelper, ComputerMethod, ConnectorComputerCraft) =====
  -- CC hands ZeroCore arguments.getAll(): numbers are Doubles, tables Maps. Indices in messages are 0-based.

  local function argAt(a, i)
    if i >= a.n then fail(("Index %d out of bounds for length %d"):format(i, a.n)) end
    return a[i + 1]
  end
  local function argDouble(a, i)
    local v = argAt(a, i)
    if type(v) ~= "number" then fail(("Invalid argument %d, expected Number"):format(i)) end
    return v
  end
  local function argInt(a, i) return javaRoundInt(argDouble(a, i)) end
  local function argIntRange(a, i, lo, hi)
    local v = argInt(a, i)
    if v < lo or v > hi then fail(("Invalid argument %d, valid range is %d : %d"):format(i, lo, hi)) end
    return v
  end
  local function argBool(a, i)
    local v = argAt(a, i)
    if type(v) ~= "boolean" then fail(("Invalid argument %d, expected Boolean"):format(i)) end
    return v
  end
  local function argString(a, i)
    local v = argAt(a, i)
    if type(v) ~= "string" then fail(("Invalid argument %d, expected String"):format(i)) end
    return v
  end

  -- ===== the energy buffer (WideEnergyBuffer of WideAmount: an integer part and 4 decimal digits) =====

  local function newBuffer(capacity, maxExtract, stored)
    local b = { units = 0, capacityUnits = capacity * 10000, maxExtract = maxExtract }
    function b.value() return floor(b.units / 10000) + (b.units % 10000) / 10000 end
    function b.grow(v)
      if not (v > 0) then return end
      local ip = floor(v)
      local dec = roundHalfEven(v * 10000) % 10000 -- DecimalFormat keeps 4 digits; a carry into the integer is lost
      b.units = min(b.capacityUnits, b.units + ip * 10000 + dec)
    end
    function b.shrink(units) b.units = max(0, b.units - units) end
    b.grow(tonumber(stored) or 0)
    return b
  end

  -- ===== machines =====

  local function numberOr(v, d) v = tonumber(v); if v == nil then return d end return v end

  local function supplySpec(v, default)
    if v == nil then return default end
    if v == "full" or v == "all" or v == true then return "full" end
    if v == false then return 0 end
    return max(0, tonumber(v) or 0)
  end

  local function dims(def, dx, dy, dz)
    local s = def.dimensions or def.size -- outside size, casing included: { x, y, z }
    if type(s) == "table" then
      return tonumber(s[1] or s.x) or dx, tonumber(s[2] or s.y) or dy, tonumber(s[3] or s.z) or dz
    end
    return dx, dy, dz
  end

  local function shellCount(X, Y, Z) return X * Y * Z - (X - 2) * (Y - 2) * (Z - 2) end

  local function position(def)
    local p = def.position or {}
    return { tonumber(p[1] or p.x) or 0, tonumber(p[2] or p.y) or 0, tonumber(p[3] or p.z) or 0 }
  end

  -- ----- reactor -----

  local function buildReactor(def)
    local legend = { ["."] = "air", [" "] = "air", W = "water", G = "graphite", I = "iron", O = "gold", D = "diamond",
      E = "emerald", C = "copper", L = "lead", S = "glass" }
    for k, v in pairs(def.legend or {}) do legend[k] = v end
    local X, Y, Z
    local cells = {} -- cells[x][z] (interior, 1-based): "rod" or a moderator
    local rodCols = {}
    if type(def.layout) == "table" then
      Z = #def.layout + 2
      X = 0
      for _, row in ipairs(def.layout) do X = max(X, #row) end
      X = X + 2
      local _, dy = dims(def, X, 5, Z)
      Y = dy
      for x = 1, X - 2 do cells[x] = {} end
      for z, row in ipairs(def.layout) do
        for x = 1, X - 2 do
          local ch = row:sub(x, x)
          if ch == "" then ch = "." end
          if ch == "X" or ch == "R" then
            cells[x][z] = "rod"
            rodCols[#rodCols + 1] = { x = x, z = z }
          else
            local name = legend[ch]
            if not name then fail("ccsim: extreme-reactors layout has an unknown cell '" .. ch .. "' (add it to legend)") end
            local m = MOD[materialKey(name)]
            if not m then fail("ccsim: '" .. tostring(name) .. "' is not a valid reactor moderator") end
            cells[x][z] = m
          end
        end
      end
    else
      X, Y, Z = dims(def, 5, 5, 5)
      local fill = MOD[materialKey(def.moderator or "air")]
      if not fill then fail("ccsim: '" .. tostring(def.moderator) .. "' is not a valid reactor moderator") end
      for x = 1, X - 2 do
        cells[x] = {}
        for z = 1, Z - 2 do cells[x][z] = fill end
      end
      local cx, cz = floor((X - 1) / 2), floor((Z - 1) / 2)
      cells[cx][cz] = "rod"
      rodCols[1] = { x = cx, z = cz }
    end
    if X < 3 or Y < 3 or Z < 3 then fail("ccsim: an extreme-reactors reactor is at least 3x3x3") end
    if #rodCols == 0 then fail("ccsim: an extreme-reactors reactor needs at least one control rod (X in layout)") end

    local variantName = tostring(def.variant or "basic"):lower()
    local variant = REACTOR_VARIANTS[variantName]
    if not variant then fail("ccsim: extreme-reactors reactor variant must be basic or reinforced") end
    local activeCooling = def.cooling == "active" or def.activelyCooled == true
    if activeCooling and variantName == "basic" then fail("ccsim: a basic reactor has no coolant ports, so it cannot be actively cooled") end
    local fuelType = tostring(def.fuelType or "yellorium"):lower()
    if not FUELS[fuelType] then fail("ccsim: fuelType must be yellorium, blutonium or verderium") end

    local ix, iy, iz = X - 2, Y - 2, Z - 2
    local m = { kind = "reactor", name = def.name, X = X, Y = Y, Z = Z, ix = ix, iy = iy, iz = iz, cells = cells,
      variantName = variantName, variant = variant, activeCooling = activeCooling, pos = position(def) }
    m.connected = def.connected ~= false
    m.assembled = def.assembled ~= false
    m.active = def.active == true
    m.rods = {}
    for i, c in ipairs(rodCols) do
      local spec = (def.controlRods or {})[i] or {}
      local level = spec.level or def.rodLevel or 0
      m.rods[i] = { x = c.x, z = c.z, name = tostring(spec.name or ""), insertion = max(0, min(100, floor(tonumber(level) or 0))) }
      cells[c.x][c.z] = { rod = m.rods[i] }
    end
    -- FuelRodsMap: vertical slices, bottom up, each slice in the rods' order
    m.fuelRods = {}
    for y = 1, iy do
      for _, r in ipairs(m.rods) do m.fuelRods[#m.fuelRods + 1] = { rod = r, y = y } end
    end
    m.cursor = 0
    m.fuelRodCount = #m.fuelRods
    m.volume = ix * iy * iz
    m.fuelCapacity = m.fuelRodCount * FUEL_CAPACITY_PER_FUEL_ROD
    m.parts = shellCount(X, Y, Z) + m.fuelRodCount
    m.energy = newBuffer(variant.partEnergyCapacity * m.parts, variant.maxExtract, def.energy)
    m.fluidCapacity = activeCooling and max(0, min(variant.maxFluidCapacity, shellCount(X, Y, Z) * variant.partFluidCapacity)) or 0

    -- ReactorFuelRodEntity.getHeatTransferRate, summed over every fuel rod (FuelRodsMap.getHeatTransferRate)
    local rate = 0.0
    for _, fr in ipairs(m.fuelRods) do
      local x, z = fr.rod.x, fr.rod.z
      for _, d in ipairs({ { 0, 1 }, { -1, 0 }, { 0, -1 }, { 1, 0 } }) do
        local nx, nz = x + d[1], z + d[2]
        if nx < 1 or nx > ix or nz < 1 or nz > iz then
          rate = rate + CONDUCTIVITY_IRON -- a casing: AbstractReactorEntity.getThermalConductivity
        else
          local c = cells[nx][nz]
          if c.rod then rate = rate + CONDUCTIVITY_AIR -- another fuel rod is no moderator: Moderator.AIR's conductivity
          else rate = rate + c.conductivity end
        end
      end
    end
    m.fuelToReactorCoef = F(rate)
    m.reactorToCoolantCoef = F(CONDUCTIVITY_IRON * (2 * (ix * iy + ix * iz + iy * iz)))
    m.heatLossCoef = F(REACTOR_HEAT_LOSS_CONDUCTIVITY * (2 * (X * Y + X * Z + Y * Z)))

    m.fuelType = fuelType
    m.fuel = max(0, floor(numberOr(def.fuel, 0)))
    m.waste = max(0, floor(numberOr(def.waste, 0)))
    if m.fuel + m.waste > m.fuelCapacity then
      m.fuel = min(m.fuel, m.fuelCapacity); m.waste = min(m.waste, m.fuelCapacity - m.fuel)
    end
    m.wasteType = m.waste > 0 and FUELS[fuelType].waste or nil
    m.radiationFuelUsage = F(numberOr(def.radiationFuelUsage, 0))
    m.fertility = F(numberOr(def.fertility, 1))
    m.fuelHeat = numberOr(def.fuelHeat, 0)
    m.reactorHeat = numberOr(def.casingHeat, 0)
    m.amountGenerated = 0.0
    m.fuelConsumed = F(0)
    m.liquidVaporizedLastTick = 0
    m.liquid = activeCooling and max(0, min(m.fluidCapacity, floor(numberOr(def.coolant, 0)))) or 0
    m.gas = activeCooling and max(0, min(m.fluidCapacity, floor(numberOr(def.steam, 0)))) or 0
    m.steamFluid = tostring(def.steamFluid or "bigreactors:steam")
    m.wasteAuto = def.wasteEjection ~= "manual"
    m.wasteOutlet = def.wasteOutlet == true
    m.fuelInlet = def.fuelInlet == true
    m.wasteEjected, m.fuelEjected = 0, 0
    m.load = max(0, numberOr(def.load, 0))
    m.steamTo = def.steamTo
    m.coolantSupply = supplySpec(def.coolantSupply, def.steamTo and 0 or "full")
    m.steamDrain = supplySpec(def.steamDrain, "full")
    m.energyOut = 0
    return m
  end

  local function reactorFuelProps(m)
    if m.fuel <= 0 then return { F(1.0), F(0.0), F(1.0), F(0.0), F(0.0) } end -- FuelProperties.INVALID
    return FUELS[m.fuelType].props
  end

  local function cellAt(m, x, z)
    if x < 0 or x > m.ix + 1 or z < 0 or z > m.iz + 1 then return nil end -- outside the bounding box: no moderator
    if x == 0 or z == 0 or x == m.ix + 1 or z == m.iz + 1 then return "casing" end
    return m.cells[x][z]
  end

  --- ReactorLogic.radiate and the moderators it reaches (MultiblockReactor.applyModerator,
  --- ReactorFuelRodEntity.moderateRadiation, AbstractReactorEntity.moderateRadiation).
  local function radiate(m, source)
    if m.fuel <= 0 then return nil end
    local props = reactorFuelProps(m)
    local moderationFactor, absorptionCoef, hardnessDivisor, fissionEvents, fuelPerFission =
      props[1], props[2], props[3], props[4], props[5]
    local fuelHeat = m.fuelHeat
    local numControlRods = #m.rods
    local radiationPenaltyBase = exp(-15 * exp(-0.0025 * fuelHeat))
    local baseFuelAmount = m.fuel + trunc(m.waste / 100)
    local fuelReactivity = FUELS[m.fuelType].reactivity
    local rawRadIntensity = F(baseFuelAmount * fissionEvents)
    local scaled = F(rawRadIntensity ^ fuelReactivity)
    scaled = F(F(F(scaled / numControlRods) ^ fuelReactivity) * numControlRods)
    local controlRodModifier = F((100 - source.rod.insertion) / 100)
    scaled = F(scaled * controlRodModifier)
    rawRadIntensity = F(rawRadIntensity * controlRodModifier)
    local effective = F(scaled * F(1 + F(-F(0.95) * exp(-10 * exp(-F(0.0012) * fuelHeat)))))
    local radHardness = F(F02 + F(0.8 * radiationPenaltyBase))
    local fertMod = m.fertility <= 1 and 1 or F(log10(m.fertility) + 1)
    local rawFuelUsage = F(F(F(fuelPerFission * rawRadIntensity) / fertMod) * FUEL_USAGE_MULT)
    local envEnergy = 0.0
    local fuelEnergy = F(ENERGY_PER_RADIATION_UNIT * effective)
    local fuelAbsorbedRadiation = F(0)
    effective = F(effective * F025)
    -- FuelRodsLayout RADIATE_DIRECTIONS_Y_AXIS: SOUTH, WEST, NORTH, EAST
    for _, d in ipairs({ { 0, 1 }, { -1, 0 }, { 0, -1 }, { 1, 0 } }) do
      local hardness, intensity = radHardness, effective
      local ttl = 4
      local x, z = source.rod.x, source.rod.z
      while ttl > 0 and intensity > F(0.0001) do
        ttl = ttl - 1
        x, z = x + d[1], z + d[2]
        local c = cellAt(m, x, z)
        if c == "casing" then
          intensity = F(0) -- "Discard all remaining radiation"
        elseif c == nil then
          -- MODERATOR_NONE
        elseif c.rod then
          local ins = min(1, max(0, F(c.rod.insertion / 100)))
          local baseAbs = F(F(1.0 - 0.95 * exp(-10 * exp(-0.0022 * fuelHeat))) * F(1 - F(hardness / hardnessDivisor)))
          local scaledAbs = min(1, F(baseAbs * absorptionCoef))
          local bonus = F(F(F(1 - scaledAbs) * ins) * F05)
          local penalty = F(F(scaledAbs * ins) * F05)
          local radAbs = F(F(scaledAbs + bonus) * intensity)
          local fertAbs = F(F(scaledAbs - penalty) * intensity)
          local fmf = F(moderationFactor + F(F(moderationFactor * ins) + ins))
          intensity = max(0, F(intensity - radAbs))
          hardness = F(hardness / fmf)
          fuelEnergy = fuelEnergy + F(radAbs * ENERGY_PER_RADIATION_UNIT)
          fuelAbsorbedRadiation = F(fuelAbsorbedRadiation + fertAbs)
        else
          local absorbed = F(F(intensity * c.absorption) * F(1 - hardness))
          intensity = max(0, F(intensity - absorbed))
          hardness = F(hardness / c.moderation)
          envEnergy = envEnergy + F(F(c.efficiency * absorbed) * ENERGY_PER_RADIATION_UNIT)
        end
      end
    end
    m.fertility = F(m.fertility + fuelAbsorbedRadiation)
    -- FuelContainer.onIrradiation
    if rawFuelUsage == rawFuelUsage and rawFuelUsage ~= huge then
      m.radiationFuelUsage = F(m.radiationFuelUsage + rawFuelUsage)
      if m.radiationFuelUsage >= 1 then
        local convert = min(m.fuel, trunc(m.radiationFuelUsage))
        if convert > 0 then
          m.radiationFuelUsage = max(0, F(m.radiationFuelUsage - convert))
          m.fuel = m.fuel - convert
          m.waste = m.waste + convert
          m.wasteType = m.wasteType or FUELS[m.fuelType].waste
        end
      end
    end
    return fuelEnergy, envEnergy, rawFuelUsage
  end

  local function heatAdd(v, amount)
    if amount ~= amount then return v end
    v = v + amount
    if -0.00001 < v and v < 0.00001 then v = 0 end
    return v
  end
  local function heatSet(v) if v ~= v then return 0 end return v end

  local function energyOf(volume, t) return t * volume * ENERGY_PER_C_PER_VOLUME end
  local function tempOf(volume, e) return e / (volume * ENERGY_PER_C_PER_VOLUME) end

  --- FluidContainer.onAbsorbHeat for water to steam: the energy left over
  local function absorbHeat(m, e)
    if e <= 0 or m.liquid <= 0 then return e end
    local maxVapor = m.fluidCapacity - m.gas
    local lv = min(maxVapor, m.liquid)
    local vg = min(lv, trunc(e / COOLANT_ENTHALPY))
    lv = vg
    vg = trunc(F(vg * m.variant.vaporEfficiency))
    if lv < 1 then return e end
    m.liquidVaporizedLastTick = lv
    m.liquid = m.liquid - lv
    m.gas = min(m.fluidCapacity, m.gas + vg)
    return max(0.0, e - lv * COOLANT_ENTHALPY)
  end

  local function ejectWaste(m)
    if m.wasteOutlet and m.waste >= SOLID_REACTANT_AMOUNT then
      local n = floor(m.waste / SOLID_REACTANT_AMOUNT) * SOLID_REACTANT_AMOUNT
      m.waste = m.waste - n
      m.wasteEjected = m.wasteEjected + n
      if m.waste == 0 then m.wasteType = nil end
    end
  end
  local function ejectFuel(m)
    if m.fuelInlet and m.fuel >= SOLID_REACTANT_AMOUNT then
      local n = floor(m.fuel / SOLID_REACTANT_AMOUNT) * SOLID_REACTANT_AMOUNT
      m.fuel = m.fuel - n
      m.fuelEjected = m.fuelEjected + n
    end
  end

  --- MultiblockReactor.updateServer -> ReactorLogic.update
  local function reactorTick(m)
    if not (m.connected and m.assembled) then return end
    if m.reactorHeat ~= m.reactorHeat then m.reactorHeat = 0 end
    m.amountGenerated = 0.0
    m.fuelConsumed = F(0)
    -- irradiation, from the next fuel rod
    if m.active then
      m.cursor = m.cursor % m.fuelRodCount + 1
      local fuelEnergy, envEnergy, usage = radiate(m, m.fuelRods[m.cursor])
      if fuelEnergy then
        m.fuelHeat = heatAdd(m.fuelHeat, tempOf(m.fuelRodCount, fuelEnergy))
        m.reactorHeat = heatAdd(m.reactorHeat, tempOf(m.volume, envEnergy))
        m.fuelConsumed = F(m.fuelConsumed + usage)
      end
    end
    -- radiation decay
    local denominator = m.active and F(20) or F(F(20) * F(200))
    m.fertility = max(0, F(m.fertility - max(F01, F(m.fertility / denominator))))
    -- refuelling cycle: automatic waste ejection; input cycle: coolant
    if m.wasteAuto then ejectWaste(m) end
    if m.activeCooling then
      local free = m.fluidCapacity - m.liquid
      local add = m.coolantSupply == "full" and free or min(free, floor(m.coolantSupply))
      if add > 0 then m.liquid = m.liquid + add end
    end
    -- fuel <> reactor
    local diff = m.fuelHeat - m.reactorHeat
    if diff > 0.01 then
      local e = diff * m.fuelToReactorCoef
      local fuelE = energyOf(m.fuelRodCount, m.fuelHeat) - e
      local reactE = energyOf(m.volume, m.reactorHeat) + e
      m.fuelHeat = heatSet(tempOf(m.fuelRodCount, fuelE))
      m.reactorHeat = heatSet(tempOf(m.volume, reactE))
    end
    -- reactor <> coolant system
    local coolantT
    if not m.activeCooling then coolantT = AMBIENT_HEAT
    else coolantT = m.liquid > 0 and min(m.reactorHeat, COOLANT_BOILING_POINT) or m.reactorHeat end
    diff = m.reactorHeat - coolantT
    if diff > F001 then
      local e = diff * m.reactorToCoolantCoef
      local reactE = energyOf(m.volume, m.reactorHeat)
      if not m.activeCooling then
        e = e * F02
        local raw = e * F05 * POWER_MULT * REACTOR_POWER_MULT * m.variant.energyEfficiency
        m.energy.grow(raw)
        m.amountGenerated = m.amountGenerated + raw
      else
        e = e - absorbHeat(m, e)
        m.amountGenerated = m.liquidVaporizedLastTick
      end
      reactE = reactE - e
      m.reactorHeat = heatSet(tempOf(m.volume, reactE))
    end
    -- passive heat loss
    diff = m.reactorHeat - AMBIENT_HEAT
    if diff > F(0.000001) then
      local lost = max(1, diff * m.heatLossCoef)
      local newE = max(0, energyOf(m.volume, m.reactorHeat) - lost)
      m.reactorHeat = heatSet(tempOf(m.volume, newE))
    end
    if m.reactorHeat < 0 then m.reactorHeat = 0 end
    if m.fuelHeat < 0 then m.fuelHeat = 0 end
    -- output cycle
    m.energyOut = 0
    if not m.activeCooling then
      if m.load > 0 and m.energy.units > 0 then
        local units = min(m.energy.units, floor(m.load * 10000))
        m.energy.shrink(units)
        m.energyOut = units / 10000
      end
    elseif m.gas > 0 then
      local target = m.steamTo and byName[m.steamTo]
      if target and target.kind == "turbine" then
        local moved = min(m.gas, target.fluidCapacity - target.gas)
        if moved > 0 then m.gas = m.gas - moved; target.gas = target.gas + moved end
      else
        local moved = m.steamDrain == "full" and m.gas or min(m.gas, floor(m.steamDrain))
        m.gas = m.gas - moved
      end
    end
  end

  -- ----- turbine -----

  local function buildTurbine(def)
    local X, Y, Z = dims(def, 5, 7, 5)
    if X < 5 or Z < 5 or Y < 4 then fail("ccsim: an extreme-reactors turbine is at least 5x4x5 (x, y, z)") end
    local variantName = tostring(def.variant or "basic"):lower()
    local variant = TURBINE_VARIANTS[variantName]
    if not variant then fail("ccsim: extreme-reactors turbine variant must be basic or reinforced") end
    local iy = Y - 2
    local m = { kind = "turbine", name = def.name, X = X, Y = Y, Z = Z, variantName = variantName, variant = variant,
      pos = position(def) }
    m.connected = def.connected ~= false
    m.assembled = def.assembled ~= false
    m.active = def.active == true
    m.shafts = max(1, floor(numberOr(def.shafts, iy)))
    m.blades = max(0, floor(numberOr(def.blades, 4 * min(m.shafts, 2))))
    -- TurbineData.update: mass and coils
    m.rotorMass = m.blades * variant.bladeMass + m.shafts * variant.shaftMass
    m.bladeSurfaceArea = m.blades
    local eff, bonus, drag, size = F(0), F(0), F(0), 0
    local coils = def.coils
    if coils == nil then coils = { gold = 8 } end
    local names = {}
    for name in pairs(coils) do names[#names + 1] = name end
    table.sort(names)
    for _, name in ipairs(names) do
      local c = COILS[materialKey(name)]
      if not c then fail("ccsim: '" .. tostring(name) .. "' is not a turbine coil material") end
      for _ = 1, floor(tonumber(coils[name]) or 0) do
        eff = F(eff + c.efficiency); bonus = F(bonus + c.bonus); drag = F(drag + c.extraction); size = size + 1
      end
    end
    m.frictionalDrag = F(F(m.rotorMass * variant.dragCoefficient) * TURBINE_MASS_MULT)
    m.bladeDrag = F(F(BASE_BLADE_DRAG * m.bladeSurfaceArea) * TURBINE_AERO_MULT)
    if size <= 0 then
      m.inductionEfficiency, m.inductionBonus, m.inductorDrag = F(0), F(1), F(0)
    else
      m.inductionEfficiency = F(F(eff * F(0.33)) / size)
      m.inductionBonus = max(F(1), F(bonus / size))
      m.inductorDrag = F(F(drag / size) * INDUCTOR_BASE_DRAG)
    end
    m.coilSize = size
    m.fluidPerBlade = floor(variant.fluidPerBlade * TURBINE_FLUID_PER_BLADE_MULT)
    m.parts = shellCount(X, Y, Z) + m.shafts + m.blades
    m.energy = newBuffer(variant.partEnergyCapacity * m.parts, variant.maxExtract, def.energy)
    m.fluidCapacity = max(0, min(variant.maxFluidCapacity, shellCount(X, Y, Z) * variant.partFluidCapacity))
    m.vent = ({ none = "DoNotVent", overflow = "VentOverflow", all = "VentAll" })[tostring(def.vent or "overflow"):lower()]
      or "VentOverflow"
    m.inductor = def.inductor == true or def.inductorEngaged == true
    m.maxIntake = min(variant.maxFlow, max(0, floor(numberOr(def.flowRate, variant.maxFlow))))
    m.rotorEnergy = F(numberOr(def.rotorEnergy, 0))
    if def.rotorSpeed and m.blades > 0 and m.rotorMass > 0 then m.rotorEnergy = F(def.rotorSpeed * m.blades * m.rotorMass) end
    m.gas = max(0, min(m.fluidCapacity, floor(numberOr(def.steam, 0))))
    m.liquid = max(0, min(m.fluidCapacity, floor(numberOr(def.water, def.coolant or 0))))
    m.energyGenerated = 0.0
    m.fluidConsumed = 0
    m.rotorEfficiency = F(1)
    m.load = max(0, numberOr(def.load, 0))
    m.steamSupplyDef = def.steamSupply
    m.waterDrain = supplySpec(def.waterDrain, "full")
    m.energyOut = 0
    return m
  end

  local function rotorSpeed(m)
    if m.blades <= 0 or m.rotorMass <= 0 then return F(0) end
    return F(m.rotorEnergy / (m.blades * m.rotorMass))
  end

  --- MultiblockTurbine.updateServer -> TurbineLogic.update
  local function turbineTick(m)
    if not (m.connected and m.assembled) then return end
    -- input cycle: vapor from the input ports
    local supply = m.steamSupply
    if supply ~= 0 then
      local free = m.fluidCapacity - m.gas
      local add = supply == "full" and free or min(free, floor(supply))
      if add > 0 then m.gas = m.gas + add end
    end
    -- TurbineLogic.update
    m.energyGenerated = 0.0
    m.fluidConsumed = 0
    m.rotorEfficiency = F(1)
    local vapor = 0
    if m.active then
      vapor = min(m.maxIntake, m.gas)
      if m.vent == "DoNotVent" then vapor = min(vapor, m.fluidCapacity - m.liquid) end
    end
    if vapor > 0 or m.rotorEnergy > 0 then
      local speed = rotorSpeed(m)
      local aero = F(speed * m.bladeDrag)
      local lift = F(0)
      if vapor > 0 then
        local density = m.gas > 0 and STEAM_ENERGY_DENSITY or F(0)
        local steam = min(m.bladeSurfaceArea * m.fluidPerBlade, vapor)
        lift = F(steam * density)
        if steam < vapor then
          steam = vapor - steam
          local needed = floor(vapor / m.fluidPerBlade)
          local missing = needed - m.bladeSurfaceArea
          local bladeEff = F(1 - F(F(missing) / F(needed)))
          lift = F(lift + F(F(steam * density) * bladeEff))
          m.rotorEfficiency = F(lift / F(vapor * density))
        end
      end
      local induction = m.inductor and F(F(speed * m.inductorDrag) * m.coilSize) or F(0)
      local energy = F(F(induction ^ m.inductionBonus) * m.inductionEfficiency)
      if energy > 0 then
        local efficiency = F(F(0.25 * cos(speed / (45.5 * PI))) + F(0.75))
        if speed < 500 then efficiency = min(F05, efficiency) end
        local raw = F(energy * efficiency) * POWER_MULT * TURBINE_POWER_MULT
        m.energy.grow(raw)
        m.energyGenerated = m.energyGenerated + raw
      end
      local delta = F(F(F(lift + F(-1 * induction)) + F(-1 * aero)) + F(-1 * m.frictionalDrag))
      local newE = F(m.rotorEnergy + delta)
      if newE == newE and newE ~= huge and newE ~= -huge then m.rotorEnergy = max(0, newE) end
      if vapor > 0 then
        -- FluidContainer.onCondensation
        if m.gas > 0 then
          m.gas = m.gas - vapor
          if m.vent ~= "VentAll" then m.liquid = min(m.fluidCapacity, m.liquid + vapor) end
        end
        m.fluidConsumed = vapor
      end
    end
    -- output cycle: power, then coolant
    m.energyOut = 0
    if m.load > 0 and m.energy.units > 0 then
      local units = min(m.energy.units, floor(m.load * 10000))
      m.energy.shrink(units)
      m.energyOut = units / 10000
    end
    if m.liquid > 0 then
      local back = m.returnTo and byName[m.returnTo]
      if back then
        local moved = min(m.liquid, back.fluidCapacity - back.liquid)
        if moved > 0 then m.liquid = m.liquid - moved; back.liquid = back.liquid + moved end
      end
      if m.liquid > 0 and not back then
        local moved = m.waterDrain == "full" and m.liquid or min(m.liquid, floor(m.waterDrain))
        m.liquid = m.liquid - moved
      end
    end
  end

  -- ===== catching up =====

  local function signature(m)
    if m.kind == "reactor" then
      return { m.active, m.fuel, m.waste, m.radiationFuelUsage, m.fertility, m.fuelHeat, m.reactorHeat, m.energy.units,
        m.liquid, m.gas, m.amountGenerated, m.fuelConsumed, m.liquidVaporizedLastTick, m.wasteEjected, m.energyOut }
    end
    return { m.active, m.rotorEnergy, m.gas, m.liquid, m.energy.units, m.energyGenerated, m.fluidConsumed,
      m.rotorEfficiency, m.energyOut }
  end

  local function sameSig(a, b)
    for i = 1, #a do if a[i] ~= b[i] then return false end end
    return true
  end

  local function linkUp()
    for _, m in ipairs(machines) do
      if m.kind == "turbine" then
        m.returnTo = nil
        for _, r in ipairs(machines) do
          if r.kind == "reactor" and r.steamTo == m.name then m.returnTo = r.name end
        end
        if m.steamSupplyDef ~= nil then m.steamSupply = supplySpec(m.steamSupplyDef, 0)
        else m.steamSupply = m.returnTo and 0 or "full" end
      end
    end
  end

  local function catchUp()
    local last = currentTick() - 1
    local t = lastTick + 1
    while t <= last do
      local due = false
      for i = 1, #pending do if pending[i].at <= t then due = true break end end
      if due then
        local keep = {}
        for _, p in ipairs(pending) do
          if p.at <= t then pcall(p.fn) else keep[#keep + 1] = p end -- exceptions on the server thread are only logged
        end
        pending = keep
      end
      local before = {}
      for i, m in ipairs(machines) do before[i] = signature(m) end
      for _, m in ipairs(machines) do
        if m.kind == "reactor" then reactorTick(m) else turbineTick(m) end
      end
      local changed = false
      for i, m in ipairs(machines) do
        if not sameSig(before[i], signature(m)) then changed = true break end
      end
      if not changed then
        -- a fixed point: every tick until the next queued action is the same one
        local stop = last
        for _, p in ipairs(pending) do if p.at - 1 < stop then stop = max(t, p.at - 1) end end
        local skipped = stop - t
        if skipped > 0 then
          for _, m in ipairs(machines) do
            if m.kind == "reactor" and m.active and m.connected and m.assembled then
              m.cursor = (m.cursor - 1 + skipped) % m.fuelRodCount + 1
            end
          end
        end
        t = stop + 1
      else
        t = t + 1
      end
    end
    if last > lastTick then lastTick = last end
  end

  --- Queue a setter for the next server tick (ComputerMethod with runOnServerThread = true).
  local function later(fn)
    pending[#pending + 1] = { at = currentTick(), fn = fn }
  end

  -- ===== the computer ports =====

  local REACTOR_ORDER = { "mbIsConnected", "getEnergyProducedLastTick", "getHotFluidAmountMax", "getHotFluidProducedLastTick",
    "mbGetMinimumCoordinate", "getFuelAmount", "mbIsPaused", "getNumberOfControlRods", "getEnergyStats", "mbIsAssembled",
    "doEjectWaste", "getFuelTemperature", "getFuelStats", "setControlRodName", "setAllControlRodLevels", "getHotFluidStats",
    "isMethodAvailable", "getCoolantAmount", "isActivelyCooled", "getControlRodName", "getFuelAmountMax",
    "mbGetMaximumCoordinate", "getCasingTemperature", "getFuelConsumedLastTick", "getHotFluidAmount",
    "mbGetMultiblockControllerTypeName", "getEnergyCapacity", "getHotFluidType", "getCoolantType", "getEnergyStored",
    "getVariant", "getWasteAmount", "getEnergyStoredAsText", "getCoolantFluidStats", "help", "setControlRodsLevels",
    "getControlRodLevel", "getControlRodsLevels", "setActive", "getCoolantAmountMax", "getFuelReactivity",
    "setControlRodLevel", "doEjectFuel", "getActive", "mbIsDisassembled", "getControlRodLocation" }
  local TURBINE_ORDER = { "mbIsConnected", "getEnergyProducedLastTick", "getOutputType", "mbGetMinimumCoordinate",
    "getInputType", "mbIsPaused", "getEnergyStats", "mbIsAssembled", "setVentOverflow", "getNumberOfBlades",
    "getFluidAmountMax", "getInductorEngaged", "setVentAll", "getFluidFlowRate", "isMethodAvailable", "getFluidFlowRateMax",
    "setFluidFlowRateMax", "mbGetMaximumCoordinate", "mbGetMultiblockControllerTypeName", "setInductorEngaged",
    "getEnergyCapacity", "setVentNone", "getEnergyStored", "getVariant", "getRotorSpeed", "getRotorMass",
    "getEnergyStoredAsText", "help", "getInputAmount", "getFluidFlowRateMaxMax", "setActive", "getBladeEfficiency",
    "getActive", "mbIsDisassembled", "getOutputAmount" }

  local CONTROLLER_CLASS = {
    reactor = "it.zerono.mods.extremereactors.gamecontent.multiblock.reactor.MultiblockReactor",
    turbine = "it.zerono.mods.extremereactors.gamecontent.multiblock.turbine.MultiblockTurbine",
  }

  --- Build the method table. `spec[name] = { min = n, server = bool, part = bool, fn = function(m, a) }`.
  local function bind(m, spec, order)
    local methods, threads = {}, {}
    local known = {}
    for _, n in ipairs(order) do known[n] = true end
    for name, s in pairs(spec) do
      threads[name] = true
      methods[name] = function(...)
        local a = table.pack(...)
        if a.n < (s.min or 0) then fail(("Insufficient number of arguments, expected %d"):format(s.min)) end
        if s.server then
          later(function() if m.connected then s.fn(m, a) end end)
          return
        end
        if s.part then return s.fn(m, a) end
        if not m.connected then return {} end -- evalOnController's default: ComputerMethod.EMPTY_RESULT, a table
        return s.fn(m, a)
      end
    end
    methods.help = function() return "The help() method is not implemented yet" end
    methods.isMethodAvailable = function(...)
      local a = table.pack(...)
      return known[argString(a, 0)] == true
    end
    threads.help, threads.isMethodAvailable = true, true
    return methods, threads
  end

  local function commonSpec(m)
    return {
      mbIsConnected = { part = true, fn = function() return m.connected end },
      mbIsAssembled = { part = true, fn = function() return m.connected and m.assembled end },
      mbIsDisassembled = { part = true, fn = function() return m.connected and not m.assembled end },
      mbIsPaused = { part = true, fn = function() return false end },
      mbGetMultiblockControllerTypeName = { part = true, fn = function() return CONTROLLER_CLASS[m.kind] end },
      mbGetMinimumCoordinate = { fn = function() return { m.pos[1], m.pos[2], m.pos[3] } end },
      mbGetMaximumCoordinate = { fn = function()
        return { m.pos[1] + m.X - 1, m.pos[2] + m.Y - 1, m.pos[3] + m.Z - 1 }
      end },
      getVariant = { fn = function() return m.variantName end },
      getActive = { fn = function() return m.active end },
      getEnergyStored = { fn = function() return m.energy.value() end },
      getEnergyStoredAsText = { fn = function() return humanReadable(m.energy.value(), "FE") end },
      getEnergyCapacity = { fn = function() return m.energy.capacityUnits / 10000 end },
      setActive = { min = 1, server = true, fn = function(_, a) m.active = argBool(a, 0) end },
    }
  end

  --- MultiblockReactor.getControlRodByIndex: index < 0 or > count is empty, index == count throws (LinkedList.get).
  local function rodByIndex(m, i)
    if i < 0 or i > #m.rods then return nil end
    if i == #m.rods then fail(("Index: %d, Size: %d"):format(i, #m.rods)) end
    return m.rods[i + 1]
  end

  local function reactorPeripheral(m)
    local spec = commonSpec(m)
    local function passive() return not m.activeCooling end
    spec.getNumberOfControlRods = { fn = function() return #m.rods end }
    spec.getFuelTemperature = { fn = function() return m.fuelHeat end }
    spec.getCasingTemperature = { fn = function() return m.reactorHeat end }
    spec.getFuelAmount = { fn = function() return m.fuel end }
    spec.getWasteAmount = { fn = function() return m.waste end }
    spec.getFuelAmountMax = { fn = function() return m.fuelCapacity end }
    spec.getControlRodName = { min = 1, fn = function(_, a)
      local r = rodByIndex(m, argInt(a, 0)); if r then return r.name end
    end }
    spec.getControlRodLevel = { min = 1, fn = function(_, a)
      local r = rodByIndex(m, argInt(a, 0)); if r then return r.insertion end
    end }
    spec.getEnergyProducedLastTick = { fn = function() return passive() and m.amountGenerated or 0.0 end }
    spec.getHotFluidProducedLastTick = { fn = function() return passive() and 0.0 or m.amountGenerated end }
    spec.isActivelyCooled = { fn = function() return m.activeCooling end }
    spec.getCoolantAmount = { fn = function() return m.liquid end }
    spec.getCoolantAmountMax = { fn = function() return m.fluidCapacity end }
    spec.getCoolantType = { fn = function() return m.liquid > 0 and "minecraft:water" or "" end }
    spec.getHotFluidAmount = { fn = function() return m.gas end }
    spec.getHotFluidAmountMax = { fn = function() return m.fluidCapacity end }
    spec.getHotFluidType = { fn = function() return m.gas > 0 and m.steamFluid or "" end }
    spec.getFuelReactivity = { fn = function() return F(m.fertility * 100) end }
    spec.getFuelConsumedLastTick = { fn = function() return m.fuelConsumed end }
    -- the rod's position comes back as a BlockPos, which CC cannot convert: nil
    spec.getControlRodLocation = { min = 1, fn = function(_, a) rodByIndex(m, argInt(a, 0)); return nil end }
    spec.getControlRodsLevels = { fn = function()
      local t = {}
      for i, r in ipairs(m.rods) do t[i - 1] = r.insertion end
      return t
    end }
    spec.setControlRodsLevels = { min = 1, server = true, fn = function(_, a)
      local levels = a[1]
      if type(levels) ~= "table" then return end
      local count = 0
      for _ in pairs(levels) do count = count + 1 end
      if count ~= #m.rods then fail("Invalid levels count in a call to setControlRodsLevels()") end
      local new = {}
      for i = 0, #m.rods - 1 do
        local v = levels[i]
        if v == nil then fail("Invalid table key in a call to setControlRodsLevels()") end
        if type(v) ~= "number" then fail("class java.lang.String cannot be cast to class java.lang.Double") end
        new[i] = javaRoundInt(v)
        if new[i] < 0 or new[i] > 100 then fail(("Invalid argument %d, valid range is %d : %d"):format(i, 0, 100)) end
      end
      for i = 0, #m.rods - 1 do m.rods[i + 1].insertion = new[i] end
    end }
    spec.getEnergyStats = { fn = function()
      return { energyStored = m.energy.value(), energyCapacity = m.energy.capacityUnits / 10000,
        energyProducedLastTick = m.amountGenerated, energySystem = "FE" }
    end }
    spec.getFuelStats = { fn = function()
      return { fuelAmount = m.fuel, fuelCapacity = m.fuelCapacity, fuelTemperature = m.fuelHeat,
        fuelConsumedLastTick = m.fuelConsumed, fuelReactivity = F(m.fertility * 100), wasteAmount = m.waste }
    end }
    -- fluidType is an Optional, which CC turns into nil, so the key is never there
    spec.getHotFluidStats = { fn = function()
      return { fluidAmount = m.gas, fluidCapacity = m.fluidCapacity,
        fluidProducedLastTick = passive() and 0.0 or m.amountGenerated }
    end }
    spec.getCoolantFluidStats = { fn = function()
      return { fluidAmount = m.liquid, fluidCapacity = m.fluidCapacity }
    end }
    spec.setControlRodLevel = { min = 2, server = true, fn = function(_, a)
      local r = rodByIndex(m, argInt(a, 0))
      if r then r.insertion = argIntRange(a, 1, 0, 100) end
    end }
    spec.setAllControlRodLevels = { min = 1, server = true, fn = function(_, a)
      local v = argIntRange(a, 0, 0, 100)
      if m.assembled then for _, r in ipairs(m.rods) do r.insertion = v end end
    end }
    spec.setControlRodName = { min = 2, server = true, fn = function(_, a)
      local r = rodByIndex(m, argInt(a, 0))
      if r then
        local name = argString(a, 1)
        if name ~= "" then r.name = name end
      end
    end }
    spec.doEjectWaste = { server = true, fn = function() ejectWaste(m) end }
    spec.doEjectFuel = { server = true, fn = function() ejectFuel(m) end }
    return spec
  end

  local function turbinePeripheral(m)
    local spec = commonSpec(m)
    spec.getEnergyProducedLastTick = { fn = function() return m.energyGenerated end }
    spec.getFluidAmountMax = { fn = function() return m.fluidCapacity end }
    spec.getFluidFlowRate = { fn = function() return m.fluidConsumed end }
    spec.getFluidFlowRateMax = { fn = function() return m.maxIntake end }
    spec.getFluidFlowRateMaxMax = { fn = function() return m.variant.maxFlow end }
    spec.getInputAmount = { fn = function() return m.gas end }
    spec.getInputType = { fn = function() return m.gas > 0 and "Steam" or "" end }
    spec.getOutputAmount = { fn = function() return m.liquid end }
    spec.getOutputType = { fn = function() return m.liquid > 0 and "Water" or "" end }
    spec.getRotorSpeed = { fn = function() return rotorSpeed(m) end }
    spec.getNumberOfBlades = { fn = function() return m.blades end }
    spec.getBladeEfficiency = { fn = function() return F(m.rotorEfficiency * 100) end }
    spec.getRotorMass = { fn = function() return m.rotorMass end }
    spec.getInductorEngaged = { fn = function() return m.inductor end }
    spec.getEnergyStats = { fn = function()
      return { energyStored = m.energy.value(), energyCapacity = m.energy.capacityUnits / 10000,
        energyProducedLastTick = m.energyGenerated, energySystem = "FE" }
    end }
    spec.setFluidFlowRateMax = { min = 1, server = true, fn = function(_, a)
      local v = argInt(a, 0)
      if m.assembled then m.maxIntake = min(m.variant.maxFlow, max(0, v)) end
    end }
    spec.setVentNone = { server = true, fn = function() m.vent = "DoNotVent" end }
    spec.setVentOverflow = { server = true, fn = function() m.vent = "VentOverflow" end }
    spec.setVentAll = { server = true, fn = function() m.vent = "VentAll" end }
    spec.setInductorEngaged = { min = 1, server = true, fn = function(_, a)
      local v = argBool(a, 0)
      if m.assembled then m.inductor = v end
    end }
    return spec
  end

  local function machineState(m)
    if m.kind == "reactor" then
      local rods = {}
      for i, r in ipairs(m.rods) do rods[i] = { name = r.name, level = r.insertion } end
      return { kind = "reactor", variant = m.variantName, connected = m.connected, assembled = m.assembled,
        active = m.active, activelyCooled = m.activeCooling, fuel = m.fuel, waste = m.waste, fuelCapacity = m.fuelCapacity,
        fuelHeat = m.fuelHeat, casingHeat = m.reactorHeat, fertility = m.fertility, energy = m.energy.value(),
        energyCapacity = m.energy.capacityUnits / 10000, producedLastTick = m.amountGenerated,
        fuelConsumedLastTick = m.fuelConsumed, coolant = m.liquid, steam = m.gas, fluidCapacity = m.fluidCapacity,
        wasteEjected = m.wasteEjected, fuelEjected = m.fuelEjected, load = m.load, controlRods = rods }
    end
    return { kind = "turbine", variant = m.variantName, connected = m.connected, assembled = m.assembled,
      active = m.active, rotorSpeed = rotorSpeed(m), rotorEnergy = m.rotorEnergy, steam = m.gas, water = m.liquid,
      fluidCapacity = m.fluidCapacity, flowRate = m.maxIntake, flowLastTick = m.fluidConsumed, inductor = m.inductor,
      vent = m.vent, energy = m.energy.value(), energyCapacity = m.energy.capacityUnits / 10000,
      producedLastTick = m.energyGenerated, bladeEfficiency = F(m.rotorEfficiency * 100), load = m.load }
  end

  -- ===== sim commands =====

  local function target(cmd, kind)
    local m = byName[cmd.peripheral or cmd.name or ""]
    if not m then return nil, "no extreme-reactors machine named " .. tostring(cmd.peripheral) end
    if kind and m.kind ~= kind then return nil, tostring(cmd.peripheral) .. " is not a " .. kind end
    catchUp()
    return m
  end

  local handlers = {}
  function handlers.erAddFuel(cmd)
    local m, err = target(cmd, "reactor"); if not m then return false, err end
    local amount = max(0, floor(tonumber(cmd.amount) or 0))
    if cmd.fuelType and m.fuel == 0 then
      local ft = tostring(cmd.fuelType):lower()
      if not FUELS[ft] then return false, "unknown fuelType " .. ft end
      m.fuelType = ft
    end
    m.fuel = m.fuel + max(0, min(amount, m.fuelCapacity - m.fuel - m.waste))
    return true
  end
  function handlers.erAddWaste(cmd)
    local m, err = target(cmd, "reactor"); if not m then return false, err end
    local amount = max(0, floor(tonumber(cmd.amount) or 0))
    local add = max(0, min(amount, m.fuelCapacity - m.fuel - m.waste))
    m.waste = m.waste + add
    if add > 0 then m.wasteType = m.wasteType or FUELS[m.fuelType].waste end
    return true
  end
  function handlers.erSetLoad(cmd)
    local m, err = target(cmd); if not m then return false, err end
    m.load = max(0, tonumber(cmd.rate) or 0)
    return true
  end
  function handlers.erDrainEnergy(cmd)
    local m, err = target(cmd); if not m then return false, err end
    -- extractEnergy: no more than the buffer's max extract per call
    local units = min(m.energy.units, floor(min(tonumber(cmd.amount) or 0, m.variant.maxExtract) * 10000))
    m.energy.shrink(max(0, units))
    return true
  end
  function handlers.erAddCoolant(cmd)
    local m, err = target(cmd); if not m then return false, err end
    if m.kind == "reactor" and not m.activeCooling then return false, "a passively cooled reactor has no coolant tank" end
    m.liquid = min(m.fluidCapacity, m.liquid + max(0, floor(tonumber(cmd.amount) or 0)))
    return true
  end
  function handlers.erAddSteam(cmd)
    local m, err = target(cmd); if not m then return false, err end
    if m.kind == "reactor" and not m.activeCooling then return false, "a passively cooled reactor has no steam tank" end
    m.gas = min(m.fluidCapacity, m.gas + max(0, floor(tonumber(cmd.amount) or 0)))
    return true
  end
  function handlers.erSetCoolantSupply(cmd)
    local m, err = target(cmd, "reactor"); if not m then return false, err end
    m.coolantSupply = supplySpec(cmd.rate, 0)
    return true
  end
  function handlers.erSetSteamSupply(cmd)
    local m, err = target(cmd, "turbine"); if not m then return false, err end
    m.steamSupplyDef = cmd.rate == nil and 0 or cmd.rate
    m.steamSupply = supplySpec(m.steamSupplyDef, 0)
    return true
  end
  function handlers.erSetActive(cmd)
    local m, err = target(cmd); if not m then return false, err end
    m.active = cmd.active == true
    return true
  end
  function handlers.erSetAssembled(cmd)
    local m, err = target(cmd); if not m then return false, err end
    local on = cmd.assembled ~= false
    if m.assembled and not on then
      m.active = false -- onMachineDisassembled
      if m.kind == "turbine" then m.rotorEnergy = F(0) end -- TurbineData.onTurbineDisassembled
    end
    m.assembled = on
    return true
  end
  function handlers.erSetConnected(cmd)
    local m, err = target(cmd); if not m then return false, err end
    m.connected = cmd.connected ~= false
    return true
  end

  -- ===== the module =====

  return {
    peripheral = function(def)
      local m
      if def.type == "BigReactors-Reactor" then m = buildReactor(def) else m = buildTurbine(def) end
      catchUp()
      if byName[def.name] then
        for i, other in ipairs(machines) do if other.name == def.name then table.remove(machines, i) break end end
      end
      machines[#machines + 1] = m
      byName[def.name] = m
      linkUp()
      local spec = m.kind == "reactor" and reactorPeripheral(m) or turbinePeripheral(m)
      local methods, threads = bind(m, spec, m.kind == "reactor" and REACTOR_ORDER or TURBINE_ORDER)
      return {
        methods = methods,
        methodOrder = m.kind == "reactor" and REACTOR_ORDER or TURBINE_ORDER,
        computerThread = threads,
        exactReturns = true, -- each method returns what its Java does: one nil for a null, none for an empty result
        state = function() catchUp(); return machineState(m) end,
        detach = function()
          for i, other in ipairs(machines) do if other == m then table.remove(machines, i) break end end
          if byName[m.name] == m then byName[m.name] = nil end
          linkUp()
        end,
      }
    end,
    handlers = handlers,
    catchUp = catchUp,
    state = function()
      catchUp()
      return { gameTime = lastTick + 1 }
    end,
  }
end
