-- ccsim addons/mekanism-machines/evaporation: the Thermal Evaporation Plant, read through its controller and valves
-- (see engine.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   content/evaporation/EvaporationMultiblockData (tick: simulateEnvironment, updateHeatCapacitors, tempMultiplier
--   = (min(3000, T) - 300) × tempMultiplier × height / 18, then the recipe: below a multiplier of 1 one operation
--   every ceil(1 / m) ticks, above it floor(m) operations a tick; lastGain; input tank height × 4 × 64000 mB, output
--   10000 mB; heat capacity evaporationHeatCapacity × height; the four solar corners; the redstone level from the
--   input tank), tile/multiblock/TileEntityThermalEvaporationController (facing: getDirection),
--   TileEntityThermalEvaporationValve (Comparator attribute), recipe/lookup/cache (OneInputCachedRecipe.fluidToFluid),
--   config/GeneralConfig (the pack's general.toml: heatDissipation 0.02, tempMultiplier 0.4, solarMultiplier 0.2,
--   heatCapacity 100), the evaporating recipes in the jar (10 mB water to 1 mB brine, 10 mB brine to 1 mB lithium).
return function(E)
  local J = E.J
  local floor, min, max, sqrt, abs, ceil = math.floor, math.min, math.max, math.sqrt, math.abs, math.ceil

  local MAX_OUTPUT, MAX_HEIGHT, MAX_MULTIPLIER_TEMP, FLUID_PER_TANK = 10000, 18, 3000, 64000
  local HEAT_DISSIPATION, TEMP_MULTIPLIER, SOLAR_MULTIPLIER, HEAT_CAPACITY = 0.02, 0.4, 0.2, 100
  local AMBIENT = 300 -- HeatAPI.AMBIENT_TEMP
  -- the evaporating recipes (data/mekanism/recipes/evaporating): input tag -> { needed, output, amount }
  local RECIPES = {
    ["minecraft:water"] = { 10, "mekanism:brine", 1 },
    ["mekanism:brine"] = { 10, "mekanism:lithium", 1 },
  }

  local K = { kind = "evaporation", defaults = { length = 4, width = 4, height = MAX_HEIGHT } }
  K.rates = { inputRate = true, outputRate = true, heatInput = true }
  K.defaultFluid = { input = "minecraft:water", output = "mekanism:brine" }

  function K.init(mb, spec)
    mb.height = max(3, min(MAX_HEIGHT, mb.height))
    mb.input = E.tank(false, function() return mb.height * 4 * FLUID_PER_TANK end, function(n)
      return mb.recipes[n] ~= nil
    end)
    mb.output = E.tank(false, function() return MAX_OUTPUT end)
    mb.recipes = {}
    for k, v in pairs(RECIPES) do mb.recipes[k] = v end
    for k, v in pairs(type(spec.recipes) == "table" and spec.recipes or {}) do
      mb.recipes[J.resourceLocation(k) or k] = { floor(tonumber(v.input) or 10), J.resourceLocation(v.output) or v.output,
        floor(tonumber(v.amount) or 1) }
    end
    E.fill(mb.input, spec.input, K.defaultFluid.input)
    E.fill(mb.output, spec.output, K.defaultFluid.output)
    mb.tanks = { input = mb.input, output = mb.output }
    mb.biomeAmbient = tonumber(spec.ambientTemperature) or AMBIENT
    mb.heat = E.capacitor(HEAT_CAPACITY * mb.height, mb.biomeAmbient)
    if spec.temperature then mb.heat.heat = mb.heat.capacity * tonumber(spec.temperature) end
    mb.solars = max(0, min(4, floor(tonumber(spec.solars) or 0)))
    mb.lastGain, mb.lastEnvironmentLoss, mb.tempMultiplier, mb.operatingTicks, mb.produced = 0, 0, 0, 0, 0
    mb.inputItemInput, mb.inputItemOutput = spec.inputItemInput, spec.inputItemOutput
    mb.outputItemInput, mb.outputItemOutput = spec.outputItemInput, spec.outputItemOutput
  end

  --- IEvaporationSolar.canSeeSun of the advanced solar generators on the corners (the generators' sky).
  local function activeSolars(mb)
    if mb.solars == 0 then return 0 end
    if E.skyDarken and E.skyDarken() < 4 then return mb.solars end
    return 0
  end
  E.evaporationActiveSolars = activeSolars

  local function simulateEnvironment(mb)
    local h = mb.heat
    local current = E.temp(h)
    h.pending = h.pending + activeSolars(mb) * SOLAR_MULTIPLIER * h.capacity
    if abs(current - mb.biomeAmbient) < 0.001 then
      h.pending = h.pending + (mb.biomeAmbient * h.capacity - h.heat)
    else
      local incr = HEAT_DISSIPATION * sqrt(abs(current - mb.biomeAmbient))
      if current > mb.biomeAmbient then incr = -incr end
      h.pending = h.pending + h.capacity * incr
      if incr < 0 then return -incr end
    end
    return 0
  end

  function K.tick(mb)
    local h = mb.heat
    local heatIn = E.rate(mb.spec.heatInput)
    if heatIn and heatIn > 0 and heatIn < math.huge then h.pending = h.pending + heatIn end
    mb.lastEnvironmentLoss = simulateEnvironment(mb)
    E.update(h)
    local tm = (min(MAX_MULTIPLIER_TEMP, E.temp(h)) - AMBIENT) * TEMP_MULTIPLIER * (mb.height / MAX_HEIGHT)
    mb.tempMultiplier = tm
    -- the cached recipe
    local r = mb.input.amount > 0 and mb.recipes[mb.input.name]
    if not r then
      mb.lastGain, mb.operatingTicks = 0, 0
      return
    end
    local required = (tm > 0 and tm < 1) and ceil(1 / tm) or 1
    local ops = (tm > 0 and tm < 1) and 1 or E.toInt(tm)
    ops = min(ops, floor(mb.input.amount / r[1]))
    if mb.output.amount > 0 and mb.output.name ~= r[2] then ops = 0 end
    ops = min(ops, floor(E.needed(mb.output) / r[3]))
    if ops <= 0 then
      mb.lastGain = 0
      return
    end
    mb.lastGain = (tm > 0 and tm < 1) and 1 / ceil(1 / tm) or tm
    mb.operatingTicks = mb.operatingTicks + 1
    if mb.operatingTicks >= required then
      mb.operatingTicks = 0
      E.shrink(mb.input, ops * r[1])
      E.insert(mb.output, r[2], ops * r[3])
      mb.produced = mb.produced + ops * r[3]
    end
  end

  --- Pipes on the valves: `inputRate` mB/t in (the input fluid), `outputRate` mB/t out.
  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.inputRate)
    if r and r > 0 then E.insert(mb.input, mb.input.name or K.defaultFluid.input, r) end
    r = E.rate(s.outputRate)
    if r and r > 0 and mb.output.amount > 0 then E.shrink(mb.output, r) end
  end

  function K.redstoneLevel(mb) return E.redstoneLevel(mb.input.amount, mb.input.cap()) end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      temperature = function(v) mb.heat.heat, mb.heat.pending = mb.heat.capacity * tonumber(v), 0 end,
      solars = function(v) mb.solars = max(0, min(4, floor(tonumber(v)))) end,
      ambientTemperature = function(v) mb.biomeAmbient = tonumber(v) end,
    })
  end

  function K.state(mb)
    return {
      temperature = E.temp(mb.heat), productionAmount = mb.lastGain, environmentalLoss = mb.lastEnvironmentLoss,
      tempMultiplier = mb.tempMultiplier, activeSolars = activeSolars(mb), produced = mb.produced,
      input = E.tankState(mb.input), output = E.tankState(mb.output), height = mb.height,
    }
  end

  -- ===== computer methods =====

  local function slot(field) return { {}, function(c) return E.B.item(c.mb[field]) end } end
  local MB = {
    getTemperature = { {}, function(c) return E.temp(c.mb.heat) end },
    getProductionAmount = { {}, function(c) return c.mb.lastGain end },
    getEnvironmentalLoss = { {}, function(c) return c.mb.lastEnvironmentLoss end },
    getActiveSolars = { {}, function(c) return activeSolars(c.mb) end },
    getInputItemInput = slot("inputItemInput"),
    getInputItemOutput = slot("inputItemOutput"),
    getOutputItemInput = slot("outputItemInput"),
    getOutputItemOutput = slot("outputItemOutput"),
  }
  E.tankMethods(MB, "Input", function(mb) return mb.input end)
  E.tankMethods(MB, "Output", function(mb) return mb.output end)
  E.shapeMethods(MB)

  local DIRECTIONS = { NORTH = true, SOUTH = true, EAST = true, WEST = true }
  K.types = {
    thermalEvaporationController = {
      tile = { isFormed = E.T.isFormed, getDirection = { {}, function(c) return c.block.facing end } },
      multiblock = MB,
      newBlock = function(def)
        local f = def.facing and tostring(def.facing):upper() or "NORTH"
        if not DIRECTIONS[f] then error("ccsim: facing '" .. f .. "' is not a horizontal direction", 0) end
        return { facing = f }
      end,
      blockState = function(c, s) s.facing = c.block.facing end,
    },
    thermalEvaporationValve = {
      tile = { isFormed = E.T.isFormed, getComparatorLevel = E.T.getComparatorLevel },
      multiblock = MB,
    },
  }
  return K
end
