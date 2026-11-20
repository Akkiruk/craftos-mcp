-- ccsim addons/mekanism-machines/engine: Mekanism's multiblocks on the virtual clock, shared by the "mekanism"
-- (boiler, induction matrix) and "mekanism-generators" (fission, turbine, fusion) modules. One engine per computer,
-- kept on `core.mekMultiblocks`, so a turbine can be fed by a reactor and charge a matrix.
--
-- Written from Mekanism 10.2.5 source (branch 1.18.x at a395daf "Bump version to 10.2.5", the code the pack's
-- 10.2.5.465 jars were built from) and checked against the jars with javap. Source files, relative to
-- src/main/java/mekanism/common/ unless named:
--   lib/multiblock/MultiblockData (tick, bounds, getLength/Width/Height/MinPos/MaxPos), tile/prefab/TileEntityMultiblock
--   (isFormed, getComputerMethods: the multiblock's methods exist only while formed), tile/base/TileEntityMekanism
--   (getComparatorLevel, getEnergy..., getRedstoneMode/setRedstoneMode and their restrictions),
--   integration/computer/ComputerMethodMapper (binding order: each class's methods sorted by name, parents merged),
--   integration/computer/SpecialComputerMethodWrapper (the four tank methods), computercraft/CCArgumentWrapper
--   (return values: stacks as {name, amount}, positions as {x, y, z}, enums as names), capabilities/heat/
--   BasicHeatCapacitor (heat is queued and applied in updateHeatCapacitors), api/math/FloatingLong (4 decimals).
-- The kinds are in their own files (boiler.lua, matrix.lua here; fission.lua, turbine.lua, fusion.lua in
-- ../mekanism-generators/). docs/mekanism-multiblocks.md lists every behaviour with its source line.
--
-- The clock: every 50 ms of os.epoch("utc") is a server tick. Everything is caught up tick by tick before a
-- peripheral call runs (a main-thread task runs at the start of a tick, before block entities) or the state is read.
return function(core, host)
  local J = dofile("/rom/ccsim/mek/java.lua")(core.version and core.version.mc)
  local floor, min, max, huge = math.floor, math.min, math.max, math.huge
  local band, bxor, rshift = bit32.band, bit32.bxor, bit32.rshift

  local E = { J = J }
  local world = core.world or {}
  local cfg = type(world.mekanism) == "table" and world.mekanism or {}
  E.cfg = cfg

  -- ===== Java number helpers =====

  --- (int) / (long) casts of a double: NaN is 0, out of range clamps, the rest truncates toward zero.
  function E.toInt(d)
    if d ~= d then return 0 end
    if d >= 2147483647 then return 2147483647 end
    if d <= -2147483648 then return -2147483648 end
    return d >= 0 and floor(d) or -floor(-d)
  end
  function E.toLong(d)
    if d ~= d then return 0 end
    if d >= 9.2233720368547758e18 then return 9.2233720368547758e18 end
    if d <= -9.2233720368547758e18 then return -9.2233720368547758e18 end
    return d >= 0 and floor(d) or -floor(-d)
  end
  --- Java's % on doubles (sign of the dividend).
  function E.fmod(a, b) return math.fmod(a, b) end

  --- FloatingLong: unsigned, four decimal places. Kept as a double rounded to 0.0001 (create/divide round half up,
  --- the way DecimalFormat("0.0000") and FloatingLong.divideEquals do for the values seen here).
  local FL = {}
  E.FL = FL
  function FL.create(d)
    if d ~= d or d <= 0 then return 0 end
    if d >= 1.8446744073709552e19 then return 1.8446744073709552e19 end
    local whole = floor(d)
    local dec = floor((d - whole) * 10000 + 0.5)
    if dec >= 10000 then whole, dec = whole + 1, dec - 10000 end
    return whole + dec / 10000
  end
  FL.divide = function(a, b) return FL.create(a / b) end
  FL.multiply = function(a, b) return FL.create(a * b) end
  --- divideToLevel: 1 when the divisor is zero or the value is bigger.
  function FL.toLevel(a, b)
    if b == 0 or a > b then return 1 end
    return FL.divide(a, b)
  end
  if J.V21 then
    -- Mekanism 10.7 has no FloatingLong: energy is a long of joules. What is stored goes through
    -- MathUtils.clampToLong (toward zero, Long.MAX_VALUE at most); the sums in between are doubles, and
    -- divideToLevel is a plain double division. The methods whose return type became long are cut to whole joules
    -- as they return (E.LONG_RETURNS).
    local LONG_MAX = 9.2233720368547758e18
    function FL.create(d)
      if d ~= d or d <= 0 then return 0 end
      if d >= LONG_MAX then return LONG_MAX end
      return floor(d)
    end
    FL.LONG_MAX = LONG_MAX
    FL.divide = function(a, b) return a / b end
    FL.multiply = function(a, b) return a * b end
    function FL.toLevel(a, b)
      if b == 0 or a > b then return 1 end
      return a / b
    end
  end
  FL.MAX = J.V21 and FL.LONG_MAX or 1.8446744073709552e19
  --- 10.7: the computer methods whose Java return type went from FloatingLong (10.4) to long, read from the two
  --- jars' ComputerHandlers (docs/mekanism-versions.md).
  E.LONG_RETURNS = J.V21 and {
    getEnergy = true, getMaxEnergy = true, getEnergyNeeded = true, getEnergyUsage = true, getEnergyUsed = true,
    getLastInput = true, getLastOutput = true, getTransferCap = true, getMinThreshold = true, getMaxThreshold = true,
    getBuffer = true, getCapacity = true, getNeeded = true, getPassiveGeneration = true, getProductionRate = true,
    getMaxOutput = true, getMaxProduction = true,
  } or nil

  -- ===== config (MekanismConfig.general, MekanismGeneratorsConfig.generators; defaults = the pack's toml) =====

  local C = {
    maxEnergyPerSteam = 10, boilerWaterConductivity = 0.7, superheatingHeatTransfer = 16000000, dumpExcessKeepRatio = 0.9,
    -- generators
    energyPerFissionFuel = 1000000, fissionCasingHeatCapacity = 1000, fissionSurfaceAreaTarget = 4,
    fissionMeltdownsEnabled = true, fissionMeltdownChance = 0.001, fissionPostMeltdownDamage = 75,
    defaultBurnRate = 0.1, burnPerAssembly = 1,
    turbineBladesPerCoil = 4, turbineVentGasFlow = 32000, turbineDisperserGasFlow = 1280, condenserRate = 64000,
    energyPerFusionFuel = 10000000, fusionThermocoupleEfficiency = 0.05, fusionCasingThermalConductivity = 0.1,
    fusionWaterHeatingRatio = 0.3, hohlraumMaxGas = 10,
  }
  for k, v in pairs(type(cfg.config) == "table" and cfg.config or {}) do
    if C[k] == nil then error("ccsim: unknown world.mekanism.config key '" .. tostring(k) .. "'", 0) end
    C[k] = v
  end
  E.C = C
  E.BASE_BOIL_TEMP = 373.15 -- HeatUtils.BASE_BOIL_TEMP: TemperatureUnit.CELSIUS.zeroOffset + 100
  E.STEAM_ENERGY_EFFICIENCY = 0.2 -- HeatUtils.getSteamEnergyEfficiency
  E.AIR_INVERSE_COEFFICIENT = 10000 -- HeatAPI

  -- Chemicals the multiblocks know: coolant attributes from MekanismGases (CooledCoolant/HeatedCoolant: enthalpy 5,
  -- conductivity 1), radioactivity from GasAttributes.Radiation.
  E.COOLED = { ["mekanism:sodium"] = { heated = "mekanism:superheated_sodium", enthalpy = 5, conductivity = 1 } }
  E.HEATED = { ["mekanism:superheated_sodium"] = { cooled = "mekanism:sodium", enthalpy = 5, conductivity = 1 } }
  E.WATER = { ["minecraft:water"] = true } -- MekanismTags.Fluids.WATER
  E.EMPTY_GAS, E.EMPTY_FLUID = "mekanism:empty", "minecraft:empty"

  -- ===== randomness (Level.random), private so programs' math.random is untouched =====

  local rngState = ((tonumber(cfg.seed) or 0) * 69069 + 1) % 2147483648
  function E.rand()
    rngState = (rngState * 1103515245 + 12345) % 2147483648
    return rngState / 2147483648
  end

  -- ===== tanks =====
  -- A tank: { gas = bool, name = string|nil, amount = n, cap = function() -> n, accepts = function(name) -> bool }.

  function E.tank(isGas, cap, accepts)
    return { gas = isGas, name = nil, amount = 0, cap = cap, accepts = accepts or function() return true end }
  end
  function E.isEmpty(t) return t.amount <= 0 end
  function E.needed(t) return max(0, t.cap() - t.amount) end
  function E.setAmount(t, n)
    if n <= 0 then t.amount, t.name = 0, nil else t.amount = n end
  end
  --- insert(stack) with AutomationType.INTERNAL: same type or empty, valid, up to the capacity. Returns what went in.
  function E.insert(t, name, amount)
    if amount <= 0 or not name then return 0 end
    if t.amount > 0 and t.name ~= name then return 0 end
    if t.amount <= 0 and not t.accepts(name) then return 0 end
    local n = min(amount, E.needed(t))
    if n <= 0 then return 0 end
    t.name = name
    t.amount = t.amount + n
    return n
  end
  function E.shrink(t, amount)
    local n = min(max(0, amount), t.amount)
    E.setAmount(t, t.amount - n)
    return n
  end
  --- The Java stack a tank method returns: ChemicalStack -> {name, amount}; FluidStack the same (no tag here).
  function E.stack(t)
    if t.amount <= 0 then return { name = t.gas and E.EMPTY_GAS or E.EMPTY_FLUID, amount = 0 } end
    return { name = t.name, amount = t.amount }
  end
  --- A fixture tank value: a number (amount of `default`) or { name, amount }.
  function E.fill(t, spec, default)
    if spec == nil then return end
    local name, amount
    if type(spec) == "number" then name, amount = default, spec
    elseif type(spec) == "table" then name, amount = J.resourceLocation(spec.name or default) or spec.name, tonumber(spec.amount) or 0
    else error("ccsim: a tank is a number or { name, amount }", 0) end
    t.amount, t.name = 0, nil
    if amount > 0 then
      t.name = name
      t.amount = min(amount, t.cap())
    end
  end
  --- The four ComputerChemicalTankWrapper / ComputerFluidTankWrapper methods for a tank, as `prefix`.
  function E.tankMethods(out, prefix, getTank)
    out["get" .. prefix] = { {}, function(c) return E.stack(getTank(c.mb)) end }
    out["get" .. prefix .. "Capacity"] = { {}, function(c) return getTank(c.mb).cap() end }
    out["get" .. prefix .. "Needed"] = { {}, function(c) return E.needed(getTank(c.mb)) end }
    out["get" .. prefix .. "FilledPercentage"] = { {}, function(c)
      local t = getTank(c.mb)
      return t.amount / t.cap()
    end }
  end

  --- MekanismUtils.redstoneLevelFromContents(long, long)
  function E.redstoneLevel(amount, capacity)
    local f = capacity == 0 and 0 or amount / capacity
    return floor(f * 14) + (f > 0 and 1 or 0)
  end

  -- ===== heat capacitor (BasicHeatCapacitor / MultiblockHeatCapacitor) =====

  function E.capacitor(heatCapacity, ambient)
    return { capacity = heatCapacity, heat = heatCapacity * ambient, pending = 0 }
  end
  function E.temp(h) return h.heat / h.capacity end
  function E.update(h)
    if h.pending ~= 0 then
      h.heat = h.heat + h.pending
      h.pending = 0
    end
  end

  -- ===== multiblocks =====

  local kinds = {}          -- kind name -> kind module
  local typeKind = {}       -- peripheral type -> kind name
  local multiblocks = {}    -- in world order
  local byId = {}
  E.multiblocks = multiblocks

  local function loadKind(path)
    local K = dofile(path)(E)
    kinds[K.kind] = K
    for ty in pairs(K.types) do typeKind[ty] = K.kind end
  end
  local generatorsOn = core.addonOn and core.addonOn("mekanism-generators")
  local GENERATOR_KINDS = { fission = true, turbine = true, fusion = true }

  local function pos(spec, default)
    spec = type(spec) == "table" and spec or default
    return { x = floor(tonumber(spec.x) or 0), y = floor(tonumber(spec.y) or 0), z = floor(tonumber(spec.z) or 0) }
  end

  --- Build a multiblock from its fixture. `id` names it in commands and state.
  local function newMultiblock(id, spec)
    local K = kinds[spec.kind]
    if not K then
      if GENERATOR_KINDS[spec.kind] and not generatorsOn then
        error("ccsim: multiblock '" .. id .. "' is a " .. spec.kind .. " from Mekanism Generators (addon \"mekanism-generators\"), which is switched off", 0)
      end
      error("ccsim: multiblock '" .. id .. "' has unknown kind '" .. tostring(spec.kind) .. "'", 0)
    end
    local d = K.defaults
    local mb = {
      id = id, kind = spec.kind, K = K, spec = spec, peripherals = {},
      formed = spec.formed ~= false,
      length = floor(tonumber(spec.length) or d.length), width = floor(tonumber(spec.width) or d.width),
      height = floor(tonumber(spec.height) or d.height),
    }
    mb.minPos = pos(spec.minPos, { x = 0, y = 64, z = 0 })
    mb.maxPos = { x = mb.minPos.x + mb.length - 1, y = mb.minPos.y + mb.height - 1, z = mb.minPos.z + mb.width - 1 }
    mb.volume = mb.length * mb.width * mb.height -- MultiblockData.setShape
    -- `locations`: every block of the shell (frame and walls) of the cuboid
    mb.casings = floor(tonumber(spec.casings) or
      (mb.volume - max(0, mb.length - 2) * max(0, mb.width - 2) * max(0, mb.height - 2)))
    mb.ambient = tonumber(spec.ambientTemperature) or 300 -- HeatAPI.getAmbientTemp of a 0.8 biome (plains)
    K.init(mb, spec)
    multiblocks[#multiblocks + 1] = mb
    byId[id] = mb
    return mb
  end

  function E.find(id) return byId[id] end

  --- A peripheral's multiblock: `multiblock` names one in world.mekanism.multiblocks, or is the fixture itself;
  --- left out, the peripheral's own fields are the fixture.
  local function multiblockFor(def)
    local kind = typeKind[def.type]
    local ref = def.multiblock
    local mb
    if type(ref) == "string" then
      mb = byId[ref]
      if not mb then error("ccsim: peripheral '" .. def.name .. "': no multiblock '" .. ref .. "' in world.mekanism.multiblocks", 0) end
    else
      local spec = type(ref) == "table" and ref or def
      local existing = byId[def.name]
      if existing and existing.inlineDef == spec then
        mb = existing -- the same block attached again
      elseif existing then
        error("ccsim: peripheral '" .. def.name .. "' has the id of a multiblock in world.mekanism.multiblocks; give it multiblock = \"" .. def.name .. "\"", 0)
      else
        local copy = {}
        for k, v in pairs(spec) do copy[k] = v end
        copy.kind = kind
        mb = newMultiblock(def.name, copy)
        mb.inlineDef = spec
      end
    end
    if mb.kind ~= kind then
      error("ccsim: peripheral '" .. def.name .. "' is a " .. def.type .. " but multiblock '" .. mb.id .. "' is a " .. mb.kind, 0)
    end
    return mb
  end

  -- ===== links between multiblocks (pipes and cables) =====

  --- The multiblock a fixture link names, checked when first used.
  function E.link(mb, field)
    local id = mb.spec[field]
    if id == nil then return nil end
    local target = byId[id]
    if not target then error("ccsim: multiblock '" .. mb.id .. "': " .. field .. " names no multiblock '" .. tostring(id) .. "'", 0) end
    return target
  end
  --- A rate from the fixture (per tick); nil when unset. "max" or a negative number is unlimited.
  function E.rate(v)
    if v == nil then return nil end
    if v == "max" or (type(v) == "number" and v < 0) then return huge end
    return tonumber(v)
  end

  -- ===== the clock =====

  -- The overworld's day and weather, for solar panels (world.mekanism.dayTime: 0 is sunrise, 6000 noon)
  E.sky = {
    dayTime = tonumber(cfg.dayTime) or 6000, daylightCycle = cfg.daylightCycle ~= false,
    raining = cfg.raining == true, thundering = cfg.thundering == true,
  }

  local bootMs = core.nowMs()
  local startTick = tonumber(cfg.gameTime) or 0
  local lastTick = startTick - 1
  local function currentTick() return startTick + floor((core.nowMs() - bootMs) / 50) end
  E.currentTick = currentTick

  local function tickAll(t)
    -- the world's clock: day time moves on (doDaylightCycle)
    if E.sky.daylightCycle then E.sky.dayTime = E.sky.dayTime + 1 end
    for i = 1, #multiblocks do
      local mb = multiblocks[i]
      if mb.formed and not mb.destroyed then mb.K.tick(mb, t) end
    end
    -- what the ports, valves and pipes move, after every structure has ticked
    for i = 1, #multiblocks do
      local mb = multiblocks[i]
      if mb.formed and not mb.destroyed and mb.K.transfer then mb.K.transfer(mb, t) end
    end
    for i = 1, #multiblocks do
      local mb = multiblocks[i]
      if mb.after then mb.after(mb) end
    end
  end

  --- Simulate every tick before `target`.
  function E.catchUp(target)
    target = target or currentTick()
    local last = target - 1
    E.ticksRun = E.ticksRun or 0
    while lastTick < last do
      lastTick = lastTick + 1
      tickAll(lastTick)
      E.ticksRun = E.ticksRun + 1
      -- the server's work, not the computer's: an hour of ticks must not trip the 7 s limit (core.serverWork)
      if lastTick % 512 == 0 and core.serverWork then core.serverWork() end
    end
  end
  function E.gameTime() return lastTick end

  -- ===== peripherals =====

  --- java.util.HashMap iteration order of String keys put in this order into new HashMap<>(#keys).
  local function hashOrder(keys)
    local n = #keys
    local cap = 1
    while cap < n do cap = cap * 2 end
    local threshold = floor(cap * 0.75)
    for size = 1, n do
      if size > threshold then cap = cap * 2; threshold = floor(cap * 0.75) end
    end
    local items = {}
    for i, k in ipairs(keys) do
      local h = 0
      for j = 1, #k do h = (h * 31 + k:byte(j)) % 4294967296 end
      items[i] = { k = k, i = i, b = band(bxor(h, rshift(h, 16)), cap - 1) }
    end
    table.sort(items, function(a, b)
      if a.b ~= b.b then return a.b < b.b end
      return a.i < b.i
    end)
    local out = {}
    for i, it in ipairs(items) do out[i] = it.k end
    return out
  end
  E.hashOrder = hashOrder

  local function sortedNames(t)
    local names = {}
    for name in pairs(t) do names[#names + 1] = name end
    table.sort(names)
    return names
  end

  local argContext = {
    filter = function() return nil end, knownItem = function() return true end,
    floatingLong = function(d) return FL.create(d) end,
    convert = function(expected, value, index)
      local f = E.convert and E.convert[expected]
      if f then return f(value, index) end
      return nil
    end,
  }

  --- The bound methods of a block right now: the tile's (sorted), then the multiblock's (sorted) while formed.
  local function bind(p)
    local spec = p.spec
    local bound, order = {}, {}
    -- 10.4+: BoundMethodHolder registers help() and help(methodName) before anything else
    if J.NEW then
      bound.help = J.HELP
      order[1] = "help"
    end
    -- single blocks: the tile, then its components (upgrade, security, side config, ejector), each sorted
    local groups = spec.groups or { spec.tile }
    if not spec.groups and spec.multiblock and p.mb.formed and not p.mb.destroyed then groups[2] = spec.multiblock end
    for _, group in ipairs(groups) do
      for _, name in ipairs(sortedNames(group)) do
        if not bound[name] then
          bound[name] = group[name]
          order[#order + 1] = name
        end
      end
    end
    p.bound = bound
    -- the tables peripherals.lua holds stay the same; their contents change
    for k in pairs(p.methods) do p.methods[k] = nil end
    for i = #p.methodOrder, 1, -1 do p.methodOrder[i] = nil end
    for i, name in ipairs(J.NEW and J.methodOrder(order) or hashOrder(order)) do p.methodOrder[i] = name end
    for name, m in pairs(bound) do
      p.methods[name] = function(...)
        local v = J.validate(name, m, table.pack(...), argContext)
        E.catchUp()
        local out = E.call(p, name, m, v)
        return table.unpack(out, 1, out.n)
      end
    end
  end

  --- Run a bound method with what J.validate returned: its results, packed (a void method's none).
  function E.call(p, name, m, validated)
    local args, o = J.prepare(m, validated, argContext)
    local out = table.pack(o[2](p.ctx, table.unpack(args, 1, args.n)))
    if o.void then return { n = 0 } end
    if out.n == 0 then out.n = 1 end -- a Java method with a return type returns one value, null included
    if E.LONG_RETURNS and E.LONG_RETURNS[name] and type(out[1]) == "number" then out[1] = FL.create(out[1]) end
    return out
  end

  local peripheralsByName = {}

  --- The peripheral for a world.peripherals entry of one of the multiblock types.
  function E.peripheral(def)
    E.catchUp()
    local K = kinds[typeKind[def.type]]
    if not K then error("ccsim: unknown Mekanism multiblock type '" .. tostring(def.type) .. "'", 0) end
    local mb = multiblockFor(def)
    local spec = K.types[def.type]
    local p = { methods = {}, methodOrder = {}, spec = spec, mb = mb, name = def.name }
    p.ctx = { mb = mb, block = spec.newBlock and spec.newBlock(def, mb) or {}, name = def.name }
    p.ctx.p = p
    bind(p)
    function p.validate(name, args)
      local m = p.bound[name]
      return J.validate(name, m, args, argContext)
    end
    function p.run(name, validated)
      E.catchUp()
      local m = p.bound[name]
      if not m then error("No such method " .. name, 0) end
      return E.call(p, name, m, validated)
    end
    function p.state()
      E.catchUp()
      local s = { multiblock = mb.id, formed = mb.formed and not mb.destroyed }
      if spec.blockState then spec.blockState(p.ctx, s) end
      return s
    end
    function p.detach()
      for i = #mb.peripherals, 1, -1 do if mb.peripherals[i] == p then table.remove(mb.peripherals, i) end end
      peripheralsByName[def.name] = nil
    end
    mb.peripherals[#mb.peripherals + 1] = p
    peripheralsByName[def.name] = p
    return p
  end

  --- Formation changed: Mekanism invalidates the capability, so CC detaches the peripheral and attaches it again
  --- with the new method list (TileEntityMultiblock.isComputerCapabilityPersistent is false when the multiblock is
  --- exposed). Ports that do not expose it keep theirs.
  function E.setFormed(mb, formed)
    if mb.formed == formed then return end
    mb.formed = formed
    if mb.K.onFormedChange then mb.K.onFormedChange(mb, formed) end
    for _, p in ipairs(mb.peripherals) do
      if p.spec.multiblock then
        bind(p)
        os.queueEvent("peripheral_detach", p.name)
        os.queueEvent("peripheral", p.name)
      end
    end
  end

  --- The structure is gone (a meltdown blew it up): every block of it leaves the computer.
  function E.destroy(mb)
    mb.destroyed = true
    mb.formed = false
    local names = {}
    for _, p in ipairs(mb.peripherals) do names[#names + 1] = p.name end
    for _, name in ipairs(names) do
      if core.detachSide then core.detachSide(name) else os.queueEvent("peripheral_detach", name) end
    end
  end

  -- ===== common tile methods (TileEntityMekanism, TileEntityMultiblock) =====

  E.T = {}
  E.T.isFormed = { {}, function(c) return c.mb.formed and not c.mb.destroyed end }
  --- getComparatorLevel: the valve's redstone level, the multiblock's getMultiblockRedstoneLevel (0 unformed)
  E.T.getComparatorLevel = { {}, function(c)
    local mb = c.mb
    if not mb.formed or mb.destroyed then return 0 end
    return mb.K.redstoneLevel(mb)
  end }
  --- The four ENERGY methods: the containers the tile exposes, which are the multiblock's while formed.
  function E.energyMethods(out, containers)
    local function sum(c, field)
      local total = 0
      if c.mb.formed and not c.mb.destroyed then
        for _, e in ipairs(containers(c.mb)) do total = total + e[field](e) end
      end
      return total
    end
    out.getEnergy = { {}, function(c) return sum(c, "get") end }
    out.getMaxEnergy = { {}, function(c) return sum(c, "max") end }
    out.getEnergyNeeded = { {}, function(c) return sum(c, "needed") end }
    out.getEnergyFilledPercentage = { {}, function(c) return FL.toLevel(sum(c, "get"), sum(c, "max")) end }
  end
  --- A BasicEnergyContainer of `capacity()` joules.
  function E.energyContainer(capacity)
    local e = { stored = 0 }
    e.get = function(self) return self.stored end
    e.max = function(self) return capacity() end
    e.needed = function(self) return max(0, capacity() - self.stored) end
    e.insert = function(self, amount)
      local n = min(FL.create(amount), self:needed())
      if n <= 0 then return 0 end
      self.stored = FL.create(self.stored + n)
      return n
    end
    e.extract = function(self, amount)
      local n = min(max(0, amount), self.stored)
      self.stored = FL.create(self.stored - n)
      return n
    end
    return e
  end
  --- MultiblockData's five shape methods
  function E.shapeMethods(out)
    out.getLength = { {}, function(c) return c.mb.length end }
    out.getWidth = { {}, function(c) return c.mb.width end }
    out.getHeight = { {}, function(c) return c.mb.height end }
    out.getMinPos = { {}, function(c) local p = c.mb.minPos return { x = p.x, y = p.y, z = p.z } end }
    out.getMaxPos = { {}, function(c) local p = c.mb.maxPos return { x = p.x, y = p.y, z = p.z } end }
  end
  --- A void method (Java returns nothing): marks the entry so run() returns no values.
  function E.void(params, fn) return { params, fn, void = true } end

  --- Whether an output flows: with no port peripherals on the multiblock the fixture's rates always flow; with some,
  --- only while one of them is in `mode` (its block.portMode), or the fixture has `hiddenField` ports more.
  function E.portAllows(mb, mode, hiddenField)
    local any = false
    for _, p in ipairs(mb.peripherals) do
      local m = p.ctx.block.portMode
      if m ~= nil then
        any = true
        if m == mode then return true end
      end
    end
    if hiddenField and (tonumber(mb.spec[hiddenField]) or 0) > 0 then return true end
    return not any
  end

  --- mekSet: fixture fields of a running multiblock. Tanks take a number or { name, amount }; `extra` has the
  --- kind's own fields (temperature, energy, ...); rates and links (K.rates) replace the fixture value.
  function E.applySet(mb, fields, extra)
    for k, v in pairs(fields) do
      if extra[k] then extra[k](v)
      elseif mb.tanks[k] then E.fill(mb.tanks[k], v, mb.K.defaultFluid[k])
      elseif mb.K.rates[k] then mb.spec[k] = v
      else error("unknown field '" .. tostring(k) .. "' for a " .. mb.kind, 0) end
    end
  end

  --- The fixed modes of a port or valve block state (getMode/setMode/incrementMode/decrementMode).
  function E.cycle(list, value, step)
    for i, v in ipairs(list) do
      if v == value then return list[(i - 1 + step) % #list + 1] end
    end
    return list[1]
  end

  -- ===== the kinds and the world's multiblocks =====

  loadKind("/rom/ccsim/addons/mekanism-machines/boiler.lua")
  loadKind("/rom/ccsim/addons/mekanism-machines/matrix.lua")
  E.B = dofile("/rom/ccsim/addons/mekanism-machines/blocks.lua")(E, core)
  loadKind("/rom/ccsim/addons/mekanism-machines/cube.lua")
  loadKind("/rom/ccsim/addons/mekanism-machines/tanks.lua")
  loadKind("/rom/ccsim/addons/mekanism-machines/machines.lua")
  dofile("/rom/ccsim/addons/mekanism-machines/filters.lua")(E)
  for _, f in ipairs({ "factories", "bins", "recipes", "dynamic", "evaporation", "sps", "miner", "misc", "transmitters", "added" }) do
    loadKind("/rom/ccsim/addons/mekanism-machines/" .. f .. ".lua")
  end
  if generatorsOn then
    loadKind("/rom/ccsim/addons/mekanism-generators/generators.lua")
    loadKind("/rom/ccsim/addons/mekanism-generators/fission.lua")
    loadKind("/rom/ccsim/addons/mekanism-generators/turbine.lua")
    loadKind("/rom/ccsim/addons/mekanism-generators/fusion.lua")
  end

  for id, spec in pairs(type(cfg.multiblocks) == "table" and cfg.multiblocks or {}) do
    if type(spec) ~= "table" then error("ccsim: world.mekanism.multiblocks." .. tostring(id) .. " must be a table", 0) end
  end
  do -- world order is the key order of a JSON object, which Lua loses: sort by id so ticks are deterministic
    local ids = {}
    for id in pairs(type(cfg.multiblocks) == "table" and cfg.multiblocks or {}) do ids[#ids + 1] = id end
    table.sort(ids)
    for _, id in ipairs(ids) do newMultiblock(id, cfg.multiblocks[id]) end
  end
  -- the world's own blocks (a peripheral that is its own fixture) exist from the first tick, in world order
  for _, def in ipairs(type(world.peripherals) == "table" and world.peripherals or {}) do
    if type(def) == "table" and typeKind[def.type] and type(def.multiblock) ~= "string" and type(def.name) == "string" then
      local ok = pcall(multiblockFor, def)
      if not ok then break end -- the peripheral's own build reports it
    end
  end

  -- ===== host commands =====

  local handlers = {}
  E.handlers = handlers

  local function target(cmd)
    local mb = cmd.multiblock and byId[cmd.multiblock]
    if not mb and cmd.peripheral then
      local p = peripheralsByName[cmd.peripheral]
      mb = p and p.mb
    end
    if not mb then return nil, "no such multiblock (give multiblock = id or peripheral = name)" end
    E.catchUp() -- what happened up to now happened with the old setting
    return mb
  end

  --- Form or unform a multiblock (a block broken or put back).
  function handlers.mekSetFormed(cmd)
    local mb, err = target(cmd)
    if not mb then return false, err end
    if mb.destroyed then return false, "the structure was destroyed" end
    E.setFormed(mb, cmd.formed ~= false)
    return true
  end

  --- Change fixture fields of a running multiblock: tanks, temperature, energy, rates and links.
  function handlers.mekSet(cmd)
    local mb, err = target(cmd)
    if not mb then return false, err end
    local fields = {}
    for k, v in pairs(cmd) do
      if k ~= "cmd" and k ~= "multiblock" and k ~= "peripheral" then fields[k] = v end
    end
    local ok, e = pcall(mb.K.set, mb, fields)
    if not ok then return false, tostring(e) end
    return true
  end

  --- Add to (or, negative, take from) one tank, as a pipe would: `tank`, `amount`, `name` for an empty tank.
  function handlers.mekAddTank(cmd)
    local mb, err = target(cmd)
    if not mb then return false, err end
    local t = mb.tanks and mb.tanks[cmd.tank or ""]
    if not t then return false, "no tank '" .. tostring(cmd.tank) .. "' (" .. table.concat(sortedNames(mb.tanks or {}), ", ") .. ")" end
    local amount = tonumber(cmd.amount) or 0
    if amount < 0 then
      E.shrink(t, -amount)
      return true
    end
    local name = cmd.name and (J.resourceLocation(cmd.name) or cmd.name) or t.name or mb.K.defaultFluid[cmd.tank]
    if not t.accepts(name) then return false, "tank '" .. cmd.tank .. "' does not take " .. tostring(name) end
    local n = E.insert(t, name, amount)
    if n < amount then return false, (amount - n) .. " did not fit" end
    return true
  end

  --- Redstone into a block (the fission logic adapter in Activation mode turns the reactor on and off with it).
  function handlers.mekSetRedstone(cmd)
    local p = peripheralsByName[cmd.peripheral or ""]
    if not p then return false, "no such Mekanism multiblock peripheral" end
    E.catchUp()
    local powered = cmd.powered == true
    if p.ctx.block.powered == powered then return true end
    p.ctx.block.powered = powered
    if p.spec.onPowerChange then p.spec.onPowerChange(p.ctx) end
    return true
  end

  --- Day time and weather.
  function handlers.mekSetWorld(cmd)
    E.catchUp()
    if cmd.dayTime ~= nil then E.sky.dayTime = tonumber(cmd.dayTime) or E.sky.dayTime end
    if cmd.raining ~= nil then E.sky.raining = cmd.raining == true end
    if cmd.thundering ~= nil then E.sky.thundering = cmd.thundering == true end
    if cmd.daylightCycle ~= nil then E.sky.daylightCycle = cmd.daylightCycle == true end
    return true
  end

  for name, K in pairs(kinds) do
    for cmdName, fn in pairs(K.handlers or {}) do
      handlers[cmdName] = function(cmd)
        local mb, err = target(cmd)
        if not mb then return false, err end
        if mb.kind ~= name then return false, "multiblock '" .. mb.id .. "' is a " .. mb.kind .. ", not a " .. name end
        return fn(mb, cmd)
      end
    end
  end

  -- ===== state =====

  --- Sim state of every multiblock.
  function E.state()
    E.catchUp()
    -- ticksRun: how many ticks this boot has simulated, each one once however they were caught up
    local out = { gameTime = lastTick, ticksRun = E.ticksRun or 0, dayTime = E.sky.dayTime, multiblocks = {} }
    local any = false
    for _, mb in ipairs(multiblocks) do
      do
        local s = mb.K.state(mb)
        s.kind, s.formed = mb.kind, mb.formed and not mb.destroyed
        if mb.destroyed then s.destroyed = true end
        out.multiblocks[mb.id] = s
        any = true
      end
    end
    return any and out or nil
  end

  --- Tank contents for state: { name, amount } or nil.
  function E.tankState(t)
    if t.amount <= 0 then return nil end
    return { name = t.name, amount = t.amount }
  end

  return E
end
