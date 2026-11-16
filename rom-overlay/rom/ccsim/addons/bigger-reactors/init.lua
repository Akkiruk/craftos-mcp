-- ccsim addons/bigger-reactors: Bigger Reactors' reactor and turbine computer ports.
--
-- Bigger Reactors is not in the pack. Written from the latest Forge 1.18.2 release, biggerreactors-1.18.2-0.6.0-beta.1.4
-- (CurseForge), and its library phosphophyllite-1.18.2-0.6.0-beta.1.6: source from github.com/BiggerSeries/BiggerReactors
-- tag 0.6.0-beta.1.4 and github.com/BiggerSeries/Phosphophyllite tag 0.6.0-beta.1.6, checked against both jars with
-- javap. Nothing here could be measured in game. Source files, relative to src/main/java/net/roguelogix/biggerreactors/:
--   multiblocks/reactor/deps/ReactorPeripheral, multiblocks/turbine/deps/TurbinePeripheral (the computer API);
--   multiblocks/reactor/ReactorMultiblockController, .../tiles/ReactorControlRodTile, ReactorAccessPortTile,
--   ReactorCoolantPortTile, ReactorPowerTapTile, .../util/ReactorTransitionTank;
--   multiblocks/reactor/simulation/base/BaseReactorSimulation, Battery, CoolantTank, FuelTank, SimUtil;
--   multiblocks/reactor/simulation/cpu/TimeSlicedReactorSimulation (the default: useFullPassSimulation = false);
--   multiblocks/reactor/simulation/SimulationDescription; multiblocks/turbine/TurbineMultiblockController;
--   multiblocks/turbine/simulation/modern/ModernTurbineSimulation, Battery, FluidTank; util/FluidTransitionTank;
--   Config (defaults); data/biggerreactors/ebcr/moderators, ebest/coils, transitions (the jar's data).
--   Phosphophyllite: util/HeatBody; the repacked JOML Vector3d (ray tracing).
-- docs/bigger-reactors.md lists every behaviour with its line, and what could not be confirmed.
--
-- The API is object style: battery(), fuelTank(), coolantTank(), getControlRod(i), rotor() and fluidTank() return
-- tables of functions (CC's wrapLuaObject), made fresh on every call. Every method is a plain @LuaFunction, so every
-- one runs at once on the computer thread. The machines run on the virtual clock: every 50 ms is a server tick, and
-- they are caught up tick by tick whenever anything looks (a call, a state dump).
return function(core, host)
  local floor, ceil, min, max, abs, exp, sqrt, cos, sin, pi =
    math.floor, math.ceil, math.min, math.max, math.abs, math.exp, math.sqrt, math.cos, math.sin, math.pi
  local log10 = math.log10 or function(x) return math.log(x, 10) end
  local _ = host

  local cfg = core.world.biggerReactors or {}
  local API_VERSION = "0.6.0-beta.1.4" -- BiggerReactors.modVersion(): the mod file's version (mods.toml)

  local function fail(msg) error(msg, 0) end

  -- ===== Java helpers =====

  local function long(v) -- (long) of a double: toward zero, NaN is 0
    if v ~= v then return 0 end
    if v >= 0 then return floor(v) end
    return ceil(v)
  end
  local function int32(v) -- (int) of a long
    v = v % 4294967296
    if v >= 2147483648 then v = v - 4294967296 end
    return v
  end

  -- java.util.Random, for Collections.shuffle of the rods (the mod seeds it from the clock; the fixture seeds it here)
  local function javaRandom(seed)
    seed = floor(tonumber(seed) or 0) % 16777216
    local lo, hi = bit32.bxor(seed, 0xECE66D), bit32.bxor(0, 0x5DE)
    local r = {}
    local function nextBits(bits)
      local p0 = lo * 0xECE66D + 0xB
      local c0 = floor(p0 / 16777216)
      local p1 = hi * 0xECE66D + lo * 0x5DE + c0
      lo, hi = p0 % 16777216, p1 % 16777216
      return floor((hi * 16777216 + lo) / 2 ^ (48 - bits))
    end
    function r.nextInt(bound)
      if bit32.band(bound, bound - 1) == 0 then return floor(bound * nextBits(31) / 2147483648) end
      local u = nextBits(31)
      local v = u % bound
      while u - v + (bound - 1) >= 2147483648 do
        u = nextBits(31)
        v = u % bound
      end
      return v
    end
    return r
  end

  -- CC's IArguments (VarargArguments): messages count from 1, the type is Lua's
  local function badArg(i, want, v)
    fail(("bad argument #%d (%s expected, got %s)"):format(i, want, v == nil and "nil" or type(v)))
  end
  local function argDouble(i, v)
    if type(v) ~= "number" then badArg(i, "number", v) end
    return v
  end
  local function argLong(i, v)
    if type(v) ~= "number" then badArg(i, "number", v) end
    if v ~= v then fail(("bad argument #%d (number expected, got nan)"):format(i)) end
    if v == math.huge then fail(("bad argument #%d (number expected, got inf)"):format(i)) end
    if v == -math.huge then fail(("bad argument #%d (number expected, got -inf)"):format(i)) end
    return long(v)
  end
  local function argInt(i, v) return int32(argLong(i, v)) end
  local function argBool(i, v)
    if type(v) ~= "boolean" then badArg(i, "boolean", v) end
    return v
  end
  local function argString(i, v)
    if type(v) ~= "string" then badArg(i, "string", v) end
    return v
  end

  -- ===== config (Config.java defaults; a float literal widened to double keeps its float value) =====

  local C = {
    FuelUsageMultiplier = 1, OutputMultiplier = 1, PassiveOutputMultiplier = 0.5, ActiveOutputMultiplier = 1,
    FuelMBPerIngot = 1000, PerFuelRodCapacity = 4000,
    FuelFertilityMinimumDecay = 0.10000000149011612, -- 0.1f
    FuelFertilityDecayDenominator = 20, FuelFertilityDecayDenominatorInactiveMultiplier = 200,
    CasingHeatTransferRFMKT = 0.6, FuelToStackRFKTMultiplier = 1.0, StackToCoolantRFMKT = 0.6,
    StackToAmbientRFMKT = 0.001, PassiveBatteryPerExternalBlock = 100000,
    PassiveCoolingTransferEfficiency = 0.20000000298023224, -- 0.2f
    CoolantTankAmountPerFuelRod = 10000, RodFEPerUnitVolumeKelvin = 10,
    FuelReactivity = 1.0499999523162842, -- 1.05f
    FissionEventsPerFuelUnit = 0.10000000149011612, -- 0.1f
    FEPerRadiationUnit = 10, FuelPerRadiationUnit = 0.000699999975040555, -- 0.0007f
    IrradiationDistance = 4, FuelHardnessDivisor = 1, FuelAbsorptionCoefficient = 0.5, FuelModerationFactor = 1.5,
    RadIntensityScalingMultiplier = 0.949999988079071, -- 0.95f
    RadIntensityScalingRateExponentMultiplier = 1.2000000476837158, -- 1.2f
    RadIntensityScalingShiftMultiplier = 1, RadPenaltyShiftMultiplier = 15, RadPenaltyRateMultiplier = 2.5,
    FuelAbsorptionScalingMultiplier = 0.949999988079071, -- 0.95f
    FuelAbsorptionScalingShiftMultiplier = 1,
    FuelAbsorptionScalingRateExponentMultiplier = 2.200000047683716, -- 2.2f
    SimulationRays = 64,
    -- turbine
    FlowRatePerBlock = 5000, TankVolumePerBlock = 10000, FluidPerBladeLinerKilometre = 20,
    RotorAxialMassPerShaft = 100, RotorAxialMassPerBlade = 100, FrictionDragMultiplier = 0.0001,
    AerodynamicDragMultiplier = 0.0001, CoilDragMultiplier = 10, BatterySizePerCoilBlock = 300000,
  }
  local AMBIENT = 293.15 -- ReactorMultiblockController: simulationDescription.setAmbientTemperature(293.15)
  local MINUS_0_001F = -0.0010000000474974513 -- -0.001f in TimeSlicedReactorSimulation

  -- ===== data (the jar's data/biggerreactors/ebcr/moderators, ebest/coils, transitions) =====

  local function mod(a, e, m, c) return { absorption = a, heatEfficiency = e, moderation = m, heatConductivity = c } end
  local MODERATORS = {
    air = mod(0.1, 0.25, 1.1, 0.05), glass = mod(0.2, 0.25, 1.1, 0.3), ice = mod(0.33, 0.33, 1.15, 0.1),
    snow = mod(0.15, 0.33, 1.05, 0.05), water = mod(0.33, 0.5, 1.33, 0.1), lava = mod(0.33, 0.33, 1.15, 0.7),
    iron = mod(0.5, 0.75, 1.4, 0.6), gold = mod(0.52, 0.8, 1.45, 2), diamond = mod(0.55, 0.85, 1.5, 3),
    emerald = mod(0.55, 0.85, 1.5, 2.5), graphite = mod(0.1, 0.5, 2, 2), ludicrite = mod(0.6, 0.87, 3, 3),
    liquid_obsidian = mod(0.3, 0.7, 1.35, 0.75), copper = mod(0.5, 0.75, 1.4, 1), tin = mod(0.3, 0.7, 1.35, 0.75),
    lead = mod(0.75, 0.75, 1.75, 1.5), silver = mod(0.51, 0.79, 1.43, 1.5), nickel = mod(0.5, 0.82, 1.46, 0.6),
    platinum = mod(0.53, 0.86, 1.58, 2.5), aluminum = mod(0.5, 0.78, 1.42, 0.6), steel = mod(0.5, 0.78, 1.42, 0.6),
    bronze = mod(0.51, 0.77, 1.41, 1), zinc = mod(0.51, 0.77, 1.41, 1), osmium = mod(0.51, 0.77, 1.41, 1),
    electrum = mod(0.53, 0.82, 1.47, 2.2), enderium = mod(0.53, 0.88, 1.6, 3), invar = mod(0.5, 0.79, 1.43, 0.6),
    lumium = mod(0.75, 0.55, 1.5, 1.8), signalum = mod(0.63, 0.66, 1.5, 1.8),
  }
  local function coil(e, r, b) return { efficiency = e, extractionRate = r, bonus = b } end
  local COILS = {
    iron = coil(0.33, 0.1, 1), gold = coil(0.66, 0.175, 1), copper = coil(0.396, 0.12, 1),
    aluminum = coil(0.495, 0.13, 1), electrum = coil(0.825, 0.2, 1), enderium = coil(0.99, 0.3, 1.02),
    invar = coil(0.495, 0.14, 1), platinum = coil(0.99, 0.25, 1), silver = coil(0.561, 0.15, 1),
    osmium = coil(0.462, 0.12, 1), steel = coil(0.495, 0.13, 1), ludicrite = coil(1.15, 0.35, 1.02),
  }
  -- water_to_steam.json5: latentHeat 4 RF/mB, boilingPoint 373.15 K, liquid conductivity 0.6, turbine multiplier 2.5
  local WATER_TO_STEAM = { latentHeat = 4, boilingPoint = 373.15, liquidRFMKT = 0.6, turbineMultiplier = 2.5 }

  local function shortName(name)
    local s = tostring(name):lower()
    s = s:gsub("^forge:storage_blocks/", ""):gsub("^[%w_]+:", "")
    s = s:gsub("_block$", ""):gsub("^block_", "")
    if s == "cave_air" or s == "void_air" then s = "air" end
    return s
  end
  local function moderatorOf(spec, where)
    if type(spec) == "table" then
      return mod(tonumber(spec.absorption or spec[1]) or 0, tonumber(spec.efficiency or spec.heatEfficiency or spec[2]) or 0,
        tonumber(spec.moderation or spec[3]) or 1, tonumber(spec.conductivity or spec.heatConductivity or spec[4]) or 0)
    end
    local m = MODERATORS[shortName(spec)]
    if not m then fail("ccsim: " .. where .. ": " .. tostring(spec) .. " is not a Bigger Reactors moderator") end
    return m
  end

  -- ===== rays (SimUtil static block: a Fibonacci sphere of SimulationRays directions, traced through the grid) =====

  local RAYS
  local function buildRays()
    local TTL = C.IrradiationDistance
    local N = C.SimulationRays
    local nd = N - 1
    local phi = pi * (3.0 - sqrt(5))
    local function len2(x, y, z) return x * x + (y * y + z * z) end -- JOML: fma(x, x, fma(y, y, z * z))
    RAYS = {}
    for i = 0, N - 1 do
      local y = 1.0 - (i * 2.0 / nd)
      local radius = sqrt(1.0 - y * y)
      local theta = phi * i
      local x, z = cos(theta) * radius, sin(theta) * radius
      local inv = 1.0 / sqrt(len2(x, y, z))
      local dx, dy, dz = x * inv, y * inv, z * inv -- rayDirection.normalize()
      -- currentSegmentStart = direction scaled so its biggest component is 1, then halved
      local ax, ay, az = abs(dx), abs(dy), abs(dz)
      local big
      if ax >= ay and ax >= az then big = ax elseif ay >= az then big = ay else big = az end
      local sx, sy, sz = dx * (1 / big), dy * (1 / big), dz * (1 / big)
      sx, sy, sz = sx * 0.5, sy * 0.5, sz * 0.5
      local scale = TTL + sqrt(len2(sx, sy, sz))
      local rx, ry, rz = dx * scale, dy * scale, dz * scale -- radiationDirection.mul(TTL + start.length())
      local processed = 0
      local total = sqrt(len2(rx, ry, rz))
      local cx, cy, cz = 0, 0, 0
      local planes = { abs(rx) / rx * 0.5, abs(ry) / ry * 0.5, abs(rz) / rz * 0.5 }
      local dir = { rx, ry, rz }
      local steps = {}
      local first = true
      while true do
        local best, bestLen, ex, ey, ez = 0, math.huge, 0, 0, 0
        local hits = {}
        for k = 1, 3 do
          local f = planes[k] / dir[k]
          local hx, hy, hz = rx * f, ry * f, rz * f
          hits[k] = { hx, hy, hz }
          local l = len2(hx, hy, hz)
          if l < bestLen then best, bestLen = k, l end
        end
        planes[best] = planes[best] + (planes[best] / abs(planes[best]))
        ex, ey, ez = hits[best][1], hits[best][2], hits[best][3]
        local gx, gy, gz = ex - cx, ey - cy, ez - cz
        local bx = floor((ex - cx) * 0.5 + 0.5 + cx)
        local by = floor((ey - cy) * 0.5 + 0.5 + cy)
        local bz = floor((ez - cz) * 0.5 + 0.5 + cz)
        local segment = sqrt(len2(gx, gy, gz))
        local last = processed + segment >= total
        segment = min(total - processed, segment)
        if not first and segment ~= 0 then
          steps[#steps + 1] = bx + 0; steps[#steps + 1] = by + 0; steps[#steps + 1] = bz + 0; steps[#steps + 1] = segment
        end
        first = false
        processed = processed + segment
        if last then break end
        cx, cy, cz = ex, ey, ez
      end
      RAYS[#RAYS + 1] = steps
    end
  end

  -- ===== heat bodies (Phosphophyllite util/HeatBody) =====

  local function heat(rfPerKelvin, temperature, infinite)
    return { rfPerKelvin = rfPerKelvin, temperature = temperature, infinite = infinite or false }
  end
  local function absorbRF(body, rf)
    if not body.infinite then body.temperature = body.temperature + rf / body.rfPerKelvin end
    return rf
  end
  -- HeatBody.transferWith: this finite, other finite or infinite
  local function transfer(a, b, rfkt)
    if b.infinite then -- -other.transferWith(this): the infinite branch moves only this body
      local newTemp = a.temperature - b.temperature
      newTemp = newTemp * exp(-rfkt / a.rfPerKelvin)
      newTemp = newTemp + b.temperature
      a.temperature = newTemp
      return
    end
    local target = (a.rfPerKelvin * (a.temperature - b.temperature)) / (a.rfPerKelvin + b.rfPerKelvin)
    target = target + b.temperature
    local d = rfkt * (a.rfPerKelvin + b.rfPerKelvin)
    d = d / (a.rfPerKelvin * b.rfPerKelvin)
    d = exp(-d)
    local na = (a.temperature - target) * d + target
    local nb = (b.temperature - target) * d + target
    a.temperature, b.temperature = na, nb
  end

  -- ===== the clock =====

  local bootMs = core.nowMs()
  local startTick = tonumber(cfg.gameTime) or 0
  local lastTick = startTick - 1
  local function currentTick() return startTick + floor((core.nowMs() - bootMs) / 50) end

  local machines, byName = {}, {}
  local rng = javaRandom(cfg.seed)

  local function supplySpec(v)
    if v == "full" or v == "all" then return "full" end
    local n = tonumber(v)
    if n and n > 0 then return floor(n) end
    return nil
  end

  -- ===== reactor =====

  -- SimulationDescription + BaseReactorSimulation constructor: the grid, the rods, the heat transfer constants
  local function setupReactor(m)
    local X, Y, Z = m.x, m.y, m.z
    m.rods = {}
    m.rodXZ = {}
    for i = 0, X - 1 do m.rodXZ[i] = {} end
    for i = 0, X - 1 do
      for k = 0, Z - 1 do
        if m.layoutCells[i][k] == "rod" then
          local rod = { x = i, z = k, insertion = 0, name = "" }
          m.rodXZ[i][k] = rod
          m.rods[#m.rods + 1] = rod
        end
      end
    end
    local n = #m.rods
    local passive = not m.activeCooling
    local default = MODERATORS.air -- ReactorModeratorRegistry.blockModeratorProperties(Blocks.AIR)
    m.default = default
    local manifolds = 0
    -- the coolant tank as a moderator (CoolantTank.absorption etc.): air and the liquid, mixed by how full it is
    m.manifold = { absorption = 0, heatEfficiency = 0, moderation = 0, heatConductivity = 0, isManifold = true }
    m.cell = {}
    for i = 0, X - 1 do
      for j = 0, Y - 1 do
        for k = 0, Z - 1 do
          local c = m.layoutCells[i][k]
          local p
          if c == "rod" then
            p = false
          elseif c == "manifold" then
            if passive then p = default else p = m.manifold; manifolds = manifolds + 1 end
          else
            p = c or default
          end
          m.cell[(i * Y + j) * Z + k] = p
        end
      end
    end
    m.manifoldCount = manifolds
    if passive then
      m.batteryCapacity = ((X + 2) * (Y + 2) * (Z + 2) - X * Y * Z) * C.PassiveBatteryPerExternalBlock
      m.coolantCapacity = 0
    else
      m.coolantCapacity = n * Y * C.CoolantTankAmountPerFuelRod + manifolds * C.CoolantTankAmountPerFuelRod
      m.batteryCapacity = 0
    end
    m.fuelCapacity = C.PerFuelRodCapacity * n * Y

    local fuelToCasing, fuelToManifold = 0, 0
    local dirs = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
    for _, rod in ipairs(m.rods) do
      for j = 0, Y - 1 do
        for _, d in ipairs(dirs) do
          local nx, nz = rod.x + d[1], rod.z + d[2]
          if nx < 0 or nx >= X or nz < 0 or nz >= Z then
            fuelToCasing = fuelToCasing + C.CasingHeatTransferRFMKT
          else
            local p = m.cell[(nx * Y + j) * Z + nz]
            if p then
              if p.isManifold then fuelToManifold = fuelToManifold + 1 else fuelToCasing = fuelToCasing + p.heatConductivity end
            end
          end
        end
      end
    end
    fuelToCasing = fuelToCasing * C.FuelToStackRFKTMultiplier
    local stackToCoolant = 2 * (X * Y + X * Z + Z * Y)
    local axis = { { 1, 0, 0 }, { -1, 0, 0 }, { 0, 1, 0 }, { 0, -1, 0 }, { 0, 0, 1 }, { 0, 0, -1 } }
    for i = 0, X - 1 do
      for j = 0, Y - 1 do
        for k = 0, Z - 1 do
          local p = m.cell[(i * Y + j) * Z + k]
          if p and p.isManifold then
            for _, d in ipairs(axis) do
              local nx, ny, nz = i + d[1], j + d[2], k + d[3]
              if nx < 0 or nx >= X or ny < 0 or ny >= Y or nz < 0 or nz >= Z then
                stackToCoolant = stackToCoolant - 1
              else
                local q = m.cell[(nx * Y + ny) * Z + nz]
                if not (q and q.isManifold) then stackToCoolant = stackToCoolant + 1 end
              end
            end
          end
        end
      end
    end
    stackToCoolant = stackToCoolant * C.StackToCoolantRFMKT
    if passive then stackToCoolant = stackToCoolant * C.PassiveCoolingTransferEfficiency end
    m.casingToAmbientRFKT = 2 * ((X + 2) * (Y + 2) + (X + 2) * (Z + 2) + (Z + 2) * (Y + 2)) * C.StackToAmbientRFMKT
    m.fuelToCasingRFKT = fuelToCasing
    m.fuelToManifoldSurfaceArea = fuelToManifold
    m.stackToCoolantSystemRFKT = stackToCoolant
  end

  -- TimeSlicedReactorSimulation: Collections.shuffle(controlRods, new Random()), and its cursor
  local function newSimulation(m)
    local order = {}
    for i, rod in ipairs(m.rods) do order[i] = rod end
    for i = #order, 2, -1 do
      local j = rng.nextInt(i) + 1
      order[i], order[j] = order[j], order[i]
    end
    m.simRods = order
    m.currentRod, m.rodOffset = 0, 0
    m.burnedLastTick = 0
    m.generatedLastTick = 0
    m.transitionedLastTick, m.maxTransitionedLastTick = 0, 0
  end

  local function updateManifold(m)
    local mf = m.manifold
    local d = m.default
    local cap = m.coolantCapacity
    if cap == 0 or not m.liquidModerator then
      mf.absorption, mf.heatEfficiency, mf.moderation, mf.heatConductivity =
        d.absorption, d.heatEfficiency, d.moderation, d.heatConductivity
      return
    end
    local l, w = m.liquid, m.liquidModerator
    mf.absorption = (d.absorption * (cap - l) + w.absorption * l) / cap
    mf.heatEfficiency = (d.heatEfficiency * (cap - l) + w.heatEfficiency * l) / cap
    mf.moderation = (d.moderation * (cap - l) + w.moderation * l) / cap
    mf.heatConductivity = (d.heatConductivity * (cap - l) + w.heatConductivity * l) / cap
  end

  local function fertility(m)
    if m.fertility <= 1 then return 1 end
    return log10(m.fertility) + 1
  end

  -- TimeSlicedReactorSimulation.radiate: one rod, one layer, every ray
  local function radiate(m)
    if m.fuel <= 0 then return 0 end
    local n = #m.simRods
    local X, Y, Z = m.x, m.y, m.z
    m.currentRod = m.currentRod + 1
    if m.currentRod >= n then
      m.currentRod = 0
      m.rodOffset = m.rodOffset + 1
    end
    local yLevel = m.currentRod % Y
    local index = (m.currentRod + m.rodOffset) % n
    local T = m.fuelHeat.temperature
    local radiationPenaltyBase = exp(-C.RadPenaltyShiftMultiplier * exp(-0.001 * C.RadPenaltyRateMultiplier * (T - 273.15)))
    local baseFuelAmount = m.fuel + floor(m.waste / 100)
    local rawRadIntensity = baseFuelAmount * C.FissionEventsPerFuelUnit
    local scaledRadIntensity = ((rawRadIntensity ^ C.FuelReactivity) / n) ^ C.FuelReactivity * n
    local initialHardness = min(1.0, 0.20000000298023224 + (0.8 * radiationPenaltyBase))
    local rawIntensity = (1 + (-C.RadIntensityScalingMultiplier * exp(-10 * C.RadIntensityScalingShiftMultiplier *
      exp(MINUS_0_001F * C.RadIntensityScalingRateExponentMultiplier * (T - 273.15)))))
    local fuelAbsorptionTemperatureCoefficient = (1.0 - (C.FuelAbsorptionScalingMultiplier * exp(-10 *
      C.FuelAbsorptionScalingShiftMultiplier * exp(-0.001 * C.FuelAbsorptionScalingRateExponentMultiplier * (T - 273.15)))))
    local fuelHardnessMultiplier = 1 / C.FuelHardnessDivisor
    local FEPerRad = C.FEPerRadiationUnit
    local FAC, FMF = C.FuelAbsorptionCoefficient, C.FuelModerationFactor

    local rod = m.simRods[index + 1]
    local controlRodModifier = (100 - rod.insertion) / 100
    local effectiveRadIntensity = scaledRadIntensity * controlRodModifier
    local effectiveRawRadIntensity = rawRadIntensity * controlRodModifier
    local initialIntensity = effectiveRadIntensity * rawIntensity
    local rawFuelUsage = (C.FuelPerRadiationUnit * effectiveRawRadIntensity / fertility(m)) * C.FuelUsageMultiplier
    local fuelRFAdded = FEPerRad * initialIntensity
    local fuelRadAdded, caseRFAdded = 0, 0
    local rayMultiplier = 1.0 / #RAYS
    local cell, rodXZ = m.cell, m.rodXZ
    local rx, rz = rod.x, rod.z
    for j = 1, #RAYS do
      local steps = RAYS[j]
      local hardness = initialHardness
      local intensity = initialIntensity * rayMultiplier
      for s = 1, #steps, 4 do
        local cx, cy, cz = rx + steps[s], yLevel + steps[s + 1], rz + steps[s + 2]
        if cx < 0 or cx >= X or cy < 0 or cy >= Y or cz < 0 or cz >= Z then break end
        local length = steps[s + 3]
        local p = cell[(cx * Y + cy) * Z + cz]
        if p then
          local absorbed = intensity * p.absorption * (1 - hardness) * length
          intensity = max(0, intensity - absorbed)
          hardness = hardness / (((p.moderation - 1.0) * length) + 1.0)
          caseRFAdded = caseRFAdded + p.heatEfficiency * absorbed * FEPerRad
        else
          local insertion = rodXZ[cx][cz].insertion * .001
          local baseAbsorption = fuelAbsorptionTemperatureCoefficient * (1 - (hardness * fuelHardnessMultiplier))
          local scaledAbsorption = baseAbsorption * FAC * length
          local bonus = (1 - scaledAbsorption) * insertion * 0.5
          local penalty = scaledAbsorption * insertion * 0.5
          local radiationAbsorbed = (scaledAbsorption + bonus) * intensity
          local fertilityAbsorbed = (scaledAbsorption - penalty) * intensity
          local fuelModerationFactor = FMF + (FMF * insertion + insertion)
          intensity = max(0, intensity - (radiationAbsorbed))
          hardness = hardness / (((fuelModerationFactor - 1.0) * length) + 1.0)
          fuelRFAdded = fuelRFAdded + radiationAbsorbed * FEPerRad
          fuelRadAdded = fuelRadAdded + fertilityAbsorbed
        end
      end
    end
    if fuelRadAdded == fuelRadAdded then m.fertility = m.fertility + fuelRadAdded end
    if fuelRFAdded == fuelRFAdded then absorbRF(m.fuelHeat, fuelRFAdded) end
    if caseRFAdded == caseRFAdded then absorbRF(m.stackHeat, caseRFAdded) end
    return rawFuelUsage
  end

  -- FuelTank.burn
  local function burn(m, amount)
    if amount ~= amount or amount == math.huge or amount == -math.huge or amount == 0 then
      m.burnedLastTick = 0
      return
    end
    local toProcess = m.partialUsed + amount
    toProcess = min(toProcess, m.fuel)
    m.burnedLastTick = toProcess - m.partialUsed
    m.partialUsed = toProcess
    if toProcess >= 1 then
      local toBurn = long(toProcess)
      m.fuel = m.fuel - toBurn
      m.waste = m.waste + toBurn
      m.partialUsed = m.partialUsed - toBurn
    end
  end

  -- CoolantTank.absorbRF (the simulation's coolant tank)
  local function coolantAbsorb(m, rf)
    local t = m.transition
    if rf > 0 or not t then
      m.maxTransitionedLastTick, m.transitionedLastTick = 0, 0
      return 0
    end
    rf = abs(rf)
    local toTransition = long(rf / t.latentHeat)
    local maxTransitionable = min(m.liquid, m.coolantCapacity - m.vapor)
    local mult = C.OutputMultiplier * C.ActiveOutputMultiplier
    m.maxTransitionedLastTick = long(toTransition * mult)
    toTransition = min(maxTransitionable, toTransition)
    m.transitionedLastTick = long(toTransition * mult)
    m.liquid = m.liquid - m.transitionedLastTick
    m.vapor = m.vapor + m.transitionedLastTick
    rf = toTransition * t.latentHeat
    return -rf
  end

  -- the output body: Battery.transferWith (passive) or CoolantTank.transferWith (active), against the stack
  local function outputTransfer(m, rfkt)
    local body = m.stackHeat
    if not m.activeCooling then
      local newTemp = body.temperature - AMBIENT -- the battery's temperature is the ambient one
      newTemp = newTemp * exp(-rfkt / body.rfPerKelvin)
      newTemp = newTemp + AMBIENT
      local rfTransferred = (newTemp - body.temperature) * body.rfPerKelvin
      m.generatedLastTick = long(-rfTransferred * C.OutputMultiplier * C.PassiveOutputMultiplier)
      m.energy = m.energy + m.generatedLastTick
      if m.energy > m.batteryCapacity then m.energy = m.batteryCapacity end
      body.temperature = newTemp
      return
    end
    local t = m.transition
    if not t then
      m.maxTransitionedLastTick, m.transitionedLastTick = 0, 0
      return
    end
    rfkt = rfkt * t.liquidRFMKT
    local multiplier = m.liquid / m.coolantCapacity
    rfkt = rfkt * max(multiplier, 0.01)
    local newTemp = body.temperature - t.boilingPoint
    newTemp = newTemp * exp(-rfkt / body.rfPerKelvin)
    newTemp = newTemp + t.boilingPoint
    local toTransfer = newTemp - body.temperature
    toTransfer = toTransfer * body.rfPerKelvin
    toTransfer = coolantAbsorb(m, toTransfer)
    absorbRF(body, toTransfer)
  end

  -- ReactorTransitionTank / FluidTransitionTank.fill with water: the first fill picks the transition
  local function reactorFillWater(m, amount)
    if not m.activeCooling or not m.assembled then return 0 end
    local toFill = max(0, min(amount, m.coolantCapacity - m.liquid))
    if toFill > 0 or amount > 0 then
      if not m.transition then
        m.transition = WATER_TO_STEAM
        m.liquidModerator = MODERATORS.water -- transitionUpdate: the liquid's moderator properties
      end
    end
    m.liquid = m.liquid + toFill
    return toFill
  end

  local turbineFillSteam -- forward

  local function ejectWaste(m)
    -- ReactorMultiblockController.ejectWaste: whole ingots into the access ports that have an inventory
    if not m.wasteOutlet then return end
    local ingots = floor(int32(m.waste) / C.FuelMBPerIngot)
    if ingots > 0 then m.waste = m.waste - min(m.waste, ingots * C.FuelMBPerIngot) end
  end

  -- ReactorMultiblockController.tick
  local function reactorTick(m)
    if not m.assembled then return end
    if m.activeCooling and m.coolantSupply then
      reactorFillWater(m, m.coolantSupply == "full" and m.coolantCapacity or m.coolantSupply)
    end
    -- BaseReactorSimulation.tick
    local active = m.active
    local toBurn = 0
    if active then
      if #m.simRods > 0 then
        if m.activeCooling then updateManifold(m) end
        toBurn = radiate(m)
      end
    else
      burn(m, 0)
    end
    local denominator = C.FuelFertilityDecayDenominator
    if not active then denominator = denominator * C.FuelFertilityDecayDenominatorInactiveMultiplier end
    m.fertility = max(0, m.fertility - max(C.FuelFertilityMinimumDecay, m.fertility / denominator))
    if m.activeCooling then updateManifold(m) end
    local conductivity = (m.activeCooling and m.manifold or m.default).heatConductivity
    transfer(m.fuelHeat, m.stackHeat, m.fuelToCasingRFKT + m.fuelToManifoldSurfaceArea * conductivity)
    outputTransfer(m, m.stackToCoolantSystemRFKT)
    transfer(m.stackHeat, m.ambient, m.casingToAmbientRFKT)
    if active then burn(m, toBurn) end
    -- autoEjectWaste is on by default
    ejectWaste(m)
    -- power taps: what the load accepts, at most what is stored
    if not m.activeCooling and m.load > 0 then
      local take = min(m.load, m.energy)
      if take > 0 then m.energy = m.energy - take end
    end
    -- coolant ports push the vapor out
    if m.activeCooling and m.vapor > 0 then
      local target = m.steamTo and byName[m.steamTo]
      if target and target.kind == "turbine" then
        m.vapor = m.vapor - turbineFillSteam(target, m.vapor)
      elseif m.steamDrain then
        m.vapor = m.vapor - (m.steamDrain == "full" and m.vapor or min(m.vapor, m.steamDrain))
      end
    end
  end

  local function buildReactor(def)
    local dims = def.dimensions or { 5, 5, 5 }
    local m = { kind = "reactor", name = def.name, def = def }
    m.x, m.y, m.z = floor(tonumber(dims[1]) or 5) - 2, floor(tonumber(dims[2]) or 5) - 2, floor(tonumber(dims[3]) or 5) - 2
    if m.x < 1 or m.y < 1 or m.z < 1 then fail("ccsim: " .. tostring(def.name) .. ": dimensions are the outer size, at least 3 x 3 x 3") end
    m.activeCooling = def.cooling == "active"
    -- the interior columns: layout rows are x, characters z
    local legend = def.legend or {}
    m.layoutCells = {}
    local rods = 0
    for i = 0, m.x - 1 do
      m.layoutCells[i] = {}
      local row = def.layout and def.layout[i + 1]
      if def.layout and (type(row) ~= "string" or #row ~= m.z) then
        fail(("ccsim: %s: layout needs %d rows of %d characters (outer size %d x %d x %d)"):format(tostring(def.name), m.x, m.z,
          m.x + 2, m.y + 2, m.z + 2))
      end
      for k = 0, m.z - 1 do
        local c
        if row then c = row:sub(k + 1, k + 1) elseif (i + k) % 2 == 0 then c = "X" else c = "." end
        local cell
        if c == "X" then cell = "rod"; rods = rods + 1
        elseif c == "." then cell = nil
        elseif c == "M" and legend.M == nil then cell = "manifold"
        elseif legend[c] == "manifold" then cell = "manifold"
        elseif legend[c] ~= nil then cell = moderatorOf(legend[c], tostring(def.name) .. " legend " .. c)
        else fail("ccsim: " .. tostring(def.name) .. ": layout character " .. c .. " is not in the legend") end
        m.layoutCells[i][k] = cell
      end
    end
    if rods == 0 then fail("ccsim: " .. tostring(def.name) .. ": a reactor needs at least one fuel rod (X in the layout)") end
    setupReactor(m)
    m.assembled = def.assembled ~= false
    m.active = def.active == true
    m.fuel = max(0, floor(tonumber(def.fuel) or 0))
    m.waste = max(0, floor(tonumber(def.waste) or 0))
    if m.fuel + m.waste > m.fuelCapacity then m.fuel = max(0, m.fuelCapacity - m.waste) end
    m.partialUsed = 0
    m.fertility = tonumber(def.fertility) or 1
    m.fuelHeat = heat(#m.rods * m.y * C.RodFEPerUnitVolumeKelvin, tonumber(def.fuelHeat) or AMBIENT)
    m.stackHeat = heat(m.x * m.y * m.z * C.RodFEPerUnitVolumeKelvin, tonumber(def.stackHeat or def.casingHeat) or AMBIENT)
    m.ambient = heat(0, AMBIENT, true)
    m.energy = max(0, floor(tonumber(def.energy) or 0))
    if m.activeCooling then m.energy = 0 end
    m.liquid, m.vapor = 0, 0
    m.load = max(0, floor(tonumber(def.load) or 0))
    m.wasteOutlet = def.wasteOutlet == true
    m.coolantSupply = supplySpec(def.coolantSupply)
    m.steamTo = type(def.steamTo) == "string" and def.steamTo or nil
    m.steamDrain = supplySpec(def.steamDrain)
    newSimulation(m)
    if m.activeCooling then
      local water = max(0, floor(tonumber(def.coolant) or 0))
      if water > 0 then reactorFillWater(m, water) end
      m.vapor = min(m.coolantCapacity, max(0, floor(tonumber(def.steam) or 0)))
    end
    -- control rods in index order (x, then z); names and levels from the fixture
    local level = tonumber(def.rodLevel)
    for i, rod in ipairs(m.rods) do
      local spec = type(def.controlRods) == "table" and def.controlRods[i] or nil
      local l = type(spec) == "table" and tonumber(spec.level) or level
      if l then rod.insertion = max(0, min(100, l)) end
      if type(spec) == "table" and spec.name then rod.name = tostring(spec.name) end
    end
    m.rodObjects = {}
    m.rodGeneration = 1
    return m
  end

  -- ===== turbine (ModernTurbineSimulation) =====

  local VENTS = { overflow = "OVERFLOW", closed = "CLOSED", all = "ALL" }

  local function buildTurbine(def)
    local dims = def.dimensions or { 5, 10, 5 }
    local m = { kind = "turbine", name = def.name, def = def }
    -- the interior; y runs along the rotor
    m.x, m.y, m.z = floor(tonumber(dims[1]) or 5) - 2, floor(tonumber(dims[2]) or 10) - 2, floor(tonumber(dims[3]) or 5) - 2
    if m.x < 1 or m.y < 1 or m.z < 1 then fail("ccsim: " .. tostring(def.name) .. ": dimensions are the outer size, at least 5 x 4 x 5") end
    -- coils: { block = count } around the shaft in the first ring, or a list of { block, distance }
    local coilList = {}
    local coils = def.coils
    if coils == nil then coils = { ["minecraft:gold_block"] = 8 } end
    if type(coils) == "table" and coils[1] ~= nil then
      for _, c in ipairs(coils) do
        local data = COILS[shortName(type(c) == "table" and (c.block or c[1]) or c)]
        if not data then fail("ccsim: " .. tostring(def.name) .. ": " .. tostring(type(c) == "table" and (c.block or c[1]) or c) .. " is not a Bigger Reactors coil") end
        coilList[#coilList + 1] = { data = data, distance = type(c) == "table" and tonumber(c.distance or c[2]) or 1 }
      end
    elseif type(coils) == "table" then
      local names = {}
      for name in pairs(coils) do names[#names + 1] = name end
      table.sort(names)
      for _, name in ipairs(names) do
        local data = COILS[shortName(name)]
        if not data then fail("ccsim: " .. tostring(def.name) .. ": " .. tostring(name) .. " is not a Bigger Reactors coil") end
        for _ = 1, floor(tonumber(coils[name]) or 0) do coilList[#coilList + 1] = { data = data, distance = 1 } end
      end
    end
    local coilLayers = ceil(#coilList / 8)
    -- rotor: a list of { a, b, c, d } blade lengths per shaft block, or shafts + bladeLength
    local rotor = {}
    if type(def.rotor) == "table" then
      for _, s in ipairs(def.rotor) do
        rotor[#rotor + 1] = { floor(tonumber(s[1]) or 0), floor(tonumber(s[2]) or 0), floor(tonumber(s[3]) or 0), floor(tonumber(s[4]) or 0) }
      end
    else
      local shafts = floor(tonumber(def.shafts) or m.y)
      local bladeLength = floor(tonumber(def.bladeLength) or floor((min(m.x, m.z) - 1) / 2))
      local bladed = floor(tonumber(def.bladedShafts) or max(0, shafts - coilLayers))
      for i = 1, shafts do
        local l = i <= bladed and bladeLength or 0
        rotor[i] = { l, l, l, l }
      end
    end
    -- resize
    m.maxMaxFlowRate = ((m.x * m.z) - 1) * C.FlowRatePerBlock
    m.maxFlowRate = -1
    -- setRotorConfiguration
    local function tri(u) return floor(((1 + u) * u) / 2) end
    local mass, linear = 0, 0
    m.blades = 0
    for _, s in ipairs(rotor) do
      linear = linear + tri(s[1]) + tri(s[2]) + tri(s[3]) + tri(s[4])
      mass = mass + s[1] + s[2] + s[3] + s[4]
    end
    m.blades = mass
    m.linearBladeMetersPerRevolution = linear
    local capacityPerRPM = linear * C.FluidPerBladeLinerKilometre
    capacityPerRPM = capacityPerRPM / 1000
    m.rotorShafts = #rotor
    m.rotorAxialMass = m.rotorShafts * C.RotorAxialMassPerShaft + linear * C.RotorAxialMassPerBlade
    capacityPerRPM = capacityPerRPM * (2 * pi)
    m.rotorCapacityPerRPM = capacityPerRPM
    m.rotorMass = mass * C.RotorAxialMassPerBlade + m.rotorShafts * C.RotorAxialMassPerShaft
    local function setNominal(rate)
      m.maxFlowRate = min(m.maxMaxFlowRate, max(0, rate))
    end
    m.setNominal = setNominal
    setNominal(long(m.rotorCapacityPerRPM * 1800))
    -- setCoilData, updateInternalValues
    local eff, bonus, drag, size = 0, 0, 0, 0
    for _, c in ipairs(coilList) do
      eff = eff + c.data.efficiency
      bonus = bonus + c.data.bonus
      local d = c.distance
      drag = drag + c.data.extractionRate * (d < 1 and 1 or 2 / (d + 1))
      size = size + 1
    end
    drag = drag * C.CoilDragMultiplier
    m.batteryCapacity = (size + 1) * C.BatterySizePerCoilBlock
    if size <= 0 then
      eff, drag, bonus = 0, 0, 0
    else
      eff = (eff * 1) / size
      bonus = max(1, bonus / size)
      drag = drag / size
    end
    m.coilSize, m.inductionEfficiency, m.inductorDragCoefficient, m.inductionEnergyExponentBonus = size, eff, drag, bonus
    m.tankCapacity = ((m.x * m.y * m.z) - (m.rotorShafts + size)) * C.TankVolumePerBlock
    if def.flowRate ~= nil then setNominal(long(tonumber(def.flowRate) or 0)) end
    m.assembled = def.assembled ~= false
    m.active = def.active == true
    m.coilEngaged = def.coilEngaged ~= false
    m.vent = VENTS[tostring(def.vent or "overflow"):lower()] or "OVERFLOW"
    m.rotorEnergy = max(0, (tonumber(def.rpm) or 0) * m.rotorAxialMass)
    m.energy = min(m.batteryCapacity, max(0, floor(tonumber(def.energy) or 0)))
    m.steamFluid = type(def.steamFluid) == "string" and def.steamFluid or "biggerreactors:steam"
    m.steam, m.water = 0, 0
    m.inFluid, m.outFluid = nil, nil
    m.transitioned, m.maxTransitioned = 0, 0
    m.energyGeneratedLastTick, m.rotorEfficiencyLastTick = 0, 0
    m.load = max(0, floor(tonumber(def.load) or 0))
    m.steamSupply = supplySpec(def.steamSupply)
    m.waterDrain = supplySpec(def.waterDrain)
    local steam = max(0, floor(tonumber(def.steam) or 0))
    if steam > 0 then turbineFillSteam(m, steam) end
    m.water = min(m.tankCapacity, max(0, floor(tonumber(def.water) or 0)))
    if m.water > 0 then m.outFluid = "minecraft:water" end
    return m
  end

  -- FluidTransitionTank.fill (condenser): steam in, the out tank becomes water
  function turbineFillSteam(t, amount)
    if not t.assembled then return 0 end
    local toFill = max(0, min(amount, t.tankCapacity - t.steam))
    t.inFluid = t.steamFluid
    if not t.transition then
      t.transition = WATER_TO_STEAM
      t.outFluid = "minecraft:water"
    end
    t.steam = t.steam + toFill
    return toFill
  end

  -- FluidTank.flow
  local function flow(t, amount, ventExcess)
    local maxTransitionable = t.steam
    if not ventExcess then maxTransitionable = min(maxTransitionable, t.tankCapacity - t.water) end
    t.maxTransitioned = amount
    amount = min(maxTransitionable, amount)
    t.transitioned = amount
    t.steam = t.steam - amount
    t.water = t.water + amount
    if ventExcess then t.water = min(t.water, t.tankCapacity) end
    return amount
  end

  -- TurbineMultiblockController.tick
  local function turbineTick(t)
    if not t.assembled then return end
    if t.steamSupply then turbineFillSteam(t, t.steamSupply == "full" and t.tankCapacity or t.steamSupply) end
    local rpm = t.rotorEnergy / t.rotorAxialMass
    if t.active then
      local flowRate = flow(t, t.maxFlowRate, t.vent ~= "CLOSED")
      local effective = flowRate
      local rotorCapacity = t.rotorCapacityPerRPM * max(100, rpm)
      if flowRate > rotorCapacity then
        local excess = flowRate - rotorCapacity
        local excessEfficiency = rotorCapacity / flowRate
        effective = rotorCapacity + excess * excessEfficiency
      end
      if flowRate ~= 0 then t.rotorEfficiencyLastTick = effective / flowRate else t.rotorEfficiencyLastTick = 0 end
      if effective > 0 then
        t.rotorEnergy = t.rotorEnergy + t.transition.latentHeat * effective * t.transition.turbineMultiplier
      end
    else
      flow(t, 0, t.vent ~= "CLOSED")
      t.rotorEfficiencyLastTick = 0
    end
    if t.vent == "ALL" then t.water = 0 end
    if t.coilEngaged then
      local torque = rpm * t.inductorDragCoefficient * t.coilSize
      local energy = (torque ^ t.inductionEnergyExponentBonus) * t.inductionEfficiency
      local efficiency = 0.25 * cos(rpm / (45.5 * pi)) + 0.75
      if rpm < 450 then efficiency = min(0.5, efficiency) end
      if rpm > 2245 then
        efficiency = -rpm / 4490
        efficiency = efficiency + 1
      end
      if efficiency < 0 then efficiency = 0 end
      energy = energy * efficiency
      t.energyGeneratedLastTick = energy
      if energy > 1 then t.energy = t.energy + min(long(energy), t.batteryCapacity - t.energy) end
      t.rotorEnergy = t.rotorEnergy - torque
    else
      t.energyGeneratedLastTick = 0
    end
    local f = rpm * C.FrictionDragMultiplier
    t.rotorEnergy = t.rotorEnergy - t.rotorMass * (f * f)
    local a = rpm * C.AerodynamicDragMultiplier
    t.rotorEnergy = t.rotorEnergy - t.linearBladeMetersPerRevolution * (a * a)
    if t.rotorEnergy < 0 then t.rotorEnergy = 0 end
    -- power taps
    if t.load > 0 then
      local take = min(t.load, t.energy)
      if take > 0 then t.energy = t.energy - take end
    end
    -- fluid ports push the water out: back to a reactor that sends its steam here, or to a drain
    if t.water > 0 then
      local back
      for _, r in ipairs(machines) do
        if r.kind == "reactor" and r.steamTo == t.name and r.activeCooling and r.assembled then back = r break end
      end
      if back then
        t.water = t.water - reactorFillWater(back, t.water)
      elseif t.waterDrain then
        t.water = t.water - (t.waterDrain == "full" and t.water or min(t.water, t.waterDrain))
      end
    end
  end

  local function catchUp()
    local last = currentTick() - 1
    if last > lastTick and not RAYS then buildRays() end
    for _ = lastTick + 1, last do
      for _, m in ipairs(machines) do
        if m.kind == "reactor" then reactorTick(m) else turbineTick(m) end
      end
    end
    if last > lastTick then lastTick = last end
  end

  -- ===== the computer API =====

  local function controller(m)
    if not m.assembled then fail("Invalid multiblock controller") end
    return m
  end
  local function javaIndex(i, n)
    if i < 0 or i >= n then
      fail(("Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index %d out of bounds for length %d"):format(i, n))
    end
  end

  local function reactorRod(m, index)
    -- ReactorPeripheral.ControlRod: a handle on rod `index` that goes stale when the reactor is rebuilt
    local generation = m.rodGeneration
    local function check()
      if generation ~= m.rodGeneration then fail("Invalid control rod object") end
      catchUp()
      controller(m)
      javaIndex(index, #m.rods)
      return m.rods[index + 1]
    end
    return {
      valid = function() return generation == m.rodGeneration end,
      index = function() return index end,
      level = function() return check().insertion end,
      setLevel = function(v)
        v = argDouble(1, v)
        local rod = check()
        if v == v then rod.insertion = max(0, min(100, v)) end -- ReactorControlRodTile.setInsertion: NaN ignored
        core.save()
      end,
      name = function() return check().name end,
      setName = function(v)
        v = argString(1, v)
        check().name = v
        core.save()
      end,
    }
  end

  local function reactorPeripheral(m)
    local methods = {}
    local function sim() catchUp(); return controller(m) end
    function methods.apiVersion() return API_VERSION end
    function methods.connected() return m.assembled end
    function methods.active() return sim().active end
    function methods.setActive(v)
      v = argBool(1, v)
      sim().active = v
      core.save()
    end
    function methods.battery()
      if sim().activeCooling then return nil end
      return {
        stored = function() return sim().energy end,
        capacity = function() return sim().batteryCapacity end,
        producedLastTick = function() return sim().generatedLastTick end,
      }
    end
    function methods.coolantTank()
      if not sim().activeCooling then return nil end
      return {
        coldFluidAmount = function() return sim().liquid end,
        hotFluidAmount = function() return sim().vapor end,
        capacity = function() return sim().coolantCapacity end,
        transitionedLastTick = function() return sim().transitionedLastTick end,
        maxTransitionedLastTick = function() return sim().maxTransitionedLastTick end,
        dump = function()
          local r = sim()
          r.liquid, r.vapor = 0, 0
          core.save()
        end,
      }
    end
    function methods.fuelTank()
      return {
        capacity = function() return sim().fuelCapacity end,
        totalReactant = function() local r = sim(); return r.fuel + r.waste end,
        fuel = function() return sim().fuel end,
        waste = function() return sim().waste end,
        ejectWaste = function() ejectWaste(sim()); core.save() end,
        fuelReactivity = function() return fertility(sim()) end,
        burnedLastTick = function() return sim().burnedLastTick end,
      }
    end
    function methods.controlRodCount() return #m.rods end
    function methods.getControlRod(i)
      i = argInt(1, i)
      javaIndex(i, #m.rods)
      return reactorRod(m, i)
    end
    function methods.setAllControlRodLevels(v)
      v = argDouble(1, v)
      local r = sim()
      if v == v then for _, rod in ipairs(r.rods) do rod.insertion = max(0, min(100, v)) end end
      core.save()
    end
    function methods.fuelTemperature() return sim().fuelHeat.temperature end
    function methods.casingTemperature() return sim().stackHeat.temperature end
    function methods.stackTemperature() return sim().stackHeat.temperature end
    function methods.ambientTemperature() return sim().ambient.temperature end
    return methods
  end

  local function turbinePeripheral(t)
    local methods = {}
    local function sim() catchUp(); return controller(t) end
    function methods.apiVersion() return API_VERSION end
    function methods.connected() return t.assembled end
    function methods.active() return sim().active end
    function methods.setActive(v)
      v = argBool(1, v)
      sim().active = v
      core.save()
    end
    function methods.battery()
      return {
        stored = function() return sim().energy end,
        capacity = function() return sim().batteryCapacity end,
        producedLastTick = function() return long(sim().energyGeneratedLastTick) end,
      }
    end
    function methods.rotor()
      return {
        RPM = function() local s = sim(); return s.rotorEnergy / s.rotorAxialMass end,
        efficiencyLastTick = function() return sim().rotorEfficiencyLastTick end,
      }
    end
    local function tankFluid(which)
      return {
        name = function()
          local s = sim()
          local f = which == 0 and s.inFluid or s.outFluid
          return f or "minecraft:empty"
        end,
        amount = function() local s = sim(); return which == 0 and s.steam or s.water end,
        maxAmount = function() return sim().tankCapacity end,
      }
    end
    function methods.fluidTank()
      return {
        input = function() return tankFluid(0) end,
        output = function() return tankFluid(1) end,
        flowLastTick = function() return sim().transitioned end,
        nominalFlowRate = function() return sim().maxFlowRate end,
        setNominalFlowRate = function(v)
          v = argLong(1, v)
          sim().setNominal(v)
          core.save()
        end,
        flowRateLimit = function() return sim().maxMaxFlowRate end,
      }
    end
    function methods.coilEngaged() return sim().coilEngaged end
    function methods.setCoilEngaged(v)
      v = argBool(1, v)
      sim().coilEngaged = v
      core.save()
    end
    return methods
  end

  -- peripheral.getMethods: CC's HashMap of the @LuaFunction names (see the surface test)
  local REACTOR_ORDER = { "fuelTank", "active", "battery", "ambientTemperature", "connected", "setAllControlRodLevels",
    "stackTemperature", "apiVersion", "setActive", "coolantTank", "casingTemperature", "fuelTemperature",
    "controlRodCount", "getControlRod" }
  local TURBINE_ORDER = { "connected", "rotor", "coilEngaged", "apiVersion", "setActive", "setCoilEngaged", "fluidTank",
    "active", "battery" }

  local function machineState(m)
    if m.kind == "reactor" then
      local rods = {}
      for i, rod in ipairs(m.rods) do rods[i] = { name = rod.name, level = rod.insertion, x = rod.x, z = rod.z } end
      return {
        kind = "reactor", assembled = m.assembled, active = m.active, cooling = m.activeCooling and "active" or "passive",
        fuel = m.fuel, waste = m.waste, fuelCapacity = m.fuelCapacity, partialUsed = m.partialUsed,
        burnedLastTick = m.burnedLastTick, fertility = m.fertility, fuelReactivity = fertility(m),
        fuelHeat = m.fuelHeat.temperature, stackHeat = m.stackHeat.temperature,
        energy = m.energy, energyCapacity = m.batteryCapacity, producedLastTick = m.generatedLastTick,
        coolant = m.liquid, steam = m.vapor, coolantCapacity = m.coolantCapacity,
        transitionedLastTick = m.transitionedLastTick, maxTransitionedLastTick = m.maxTransitionedLastTick,
        controlRods = rods, load = m.load,
      }
    end
    return {
      kind = "turbine", assembled = m.assembled, active = m.active, coilEngaged = m.coilEngaged, vent = m.vent,
      rpm = m.rotorEnergy / m.rotorAxialMass, rotorEnergy = m.rotorEnergy, efficiencyLastTick = m.rotorEfficiencyLastTick,
      energy = m.energy, energyCapacity = m.batteryCapacity, producedLastTick = long(m.energyGeneratedLastTick),
      steam = m.steam, water = m.water, tankCapacity = m.tankCapacity, flowLastTick = m.transitioned,
      nominalFlowRate = m.maxFlowRate, flowRateLimit = m.maxMaxFlowRate, blades = m.blades, shafts = m.rotorShafts,
      coils = m.coilSize, load = m.load,
    }
  end

  -- ===== sim commands =====

  local function target(cmd, kind)
    local m = byName[cmd.peripheral or cmd.name or ""]
    if not m then return nil, "no bigger-reactors machine named " .. tostring(cmd.peripheral) end
    if kind and m.kind ~= kind then return nil, tostring(cmd.peripheral) .. " is not a " .. kind end
    catchUp()
    return m
  end
  local function amountOf(cmd) return max(0, floor(tonumber(cmd.amount) or 0)) end

  local handlers = {}
  function handlers.brAddFuel(cmd) -- an access port taking in fuel: FuelTank.insertFuel
    local m, err = target(cmd, "reactor"); if not m then return false, err end
    local total = m.fuel + m.waste
    if total < m.fuelCapacity then m.fuel = m.fuel + min(amountOf(cmd), m.fuelCapacity - total) end
    core.save()
    return true
  end
  function handlers.brAddWaste(cmd)
    local m, err = target(cmd, "reactor"); if not m then return false, err end
    local total = m.fuel + m.waste
    if total < m.fuelCapacity then m.waste = m.waste + min(amountOf(cmd), m.fuelCapacity - total) end
    core.save()
    return true
  end
  function handlers.brSetLoad(cmd)
    local m, err = target(cmd); if not m then return false, err end
    m.load = max(0, floor(tonumber(cmd.rate) or 0))
    core.save()
    return true
  end
  function handlers.brDrainEnergy(cmd)
    local m, err = target(cmd); if not m then return false, err end
    m.energy = m.energy - min(m.energy, amountOf(cmd))
    core.save()
    return true
  end
  function handlers.brAddCoolant(cmd)
    local m, err = target(cmd, "reactor"); if not m then return false, err end
    if not m.activeCooling then return false, "a passively cooled reactor has no coolant tank" end
    reactorFillWater(m, amountOf(cmd))
    core.save()
    return true
  end
  function handlers.brAddSteam(cmd)
    local m, err = target(cmd, "turbine"); if not m then return false, err end
    turbineFillSteam(m, amountOf(cmd))
    core.save()
    return true
  end
  function handlers.brSetCoolantSupply(cmd)
    local m, err = target(cmd, "reactor"); if not m then return false, err end
    m.coolantSupply = supplySpec(cmd.rate)
    return true
  end
  function handlers.brSetSteamSupply(cmd)
    local m, err = target(cmd, "turbine"); if not m then return false, err end
    m.steamSupply = supplySpec(cmd.rate)
    return true
  end
  function handlers.brSetActive(cmd)
    local m, err = target(cmd); if not m then return false, err end
    if m.assembled then m.active = cmd.active == true end
    core.save()
    return true
  end
  function handlers.brSetAssembled(cmd)
    local m, err = target(cmd); if not m then return false, err end
    local on = cmd.assembled ~= false
    if m.assembled and not on then
      m.active = false -- reactor: onDisassembled sets INACTIVE
    elseif on and not m.assembled then
      if m.kind == "reactor" then
        -- a new simulation loaded from the old one's save: tanks, heat and fertility stay; the rod handles go stale
        newSimulation(m)
        m.rodGeneration = m.rodGeneration + 1
      else
        m.rotorEnergy = 0 -- onAssembled: simulation.reset()
      end
    end
    m.assembled = on
    core.save()
    return true
  end

  -- ===== the module =====

  return {
    peripheral = function(def)
      catchUp()
      local m
      if def.type == "BiggerReactors_Reactor" then m = buildReactor(def) else m = buildTurbine(def) end
      if byName[def.name] then
        for i, other in ipairs(machines) do if other.name == def.name then table.remove(machines, i) break end end
      end
      machines[#machines + 1] = m
      byName[def.name] = m
      local isReactor = m.kind == "reactor"
      local methods = isReactor and reactorPeripheral(m) or turbinePeripheral(m)
      local thread = {}
      for name in pairs(methods) do thread[name] = true end
      return {
        methods = methods,
        methodOrder = isReactor and REACTOR_ORDER or TURBINE_ORDER,
        computerThread = thread,
        state = function() catchUp(); return machineState(m) end,
        detach = function()
          for i, other in ipairs(machines) do if other == m then table.remove(machines, i) break end end
          if byName[m.name] == m then byName[m.name] = nil end
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
