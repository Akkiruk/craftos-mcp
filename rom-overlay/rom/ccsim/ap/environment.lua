-- ccsim ap/environment: environmentDetector (AdvancedPeripherals 0.7.30r source; on 1.20.1 and 1.21.1 the 0.7.48r and
-- 0.7.62b tags: getDimension in place of the three registry-name methods, full biome and dimension ids, real moon
-- phases, "Radius exceeds max value", and health and more on scanned entities).
--
-- The environment comes from world.environment (global) merged with the peripheral's own
-- `environment` table: time, raining, thunder, biome, skyLight, blockLight, moonPhase,
-- dimensions, entities, seed. isSlimeChunk always returns false while vhcctweaks is on: its mixin forces it. With the
-- mod off it is vanilla's answer for the detector's chunk and the world `seed` (default 0).
return function(core, B)
  local F = {}

  -- ===== slime chunks: WorldgenRandom.seedSlimeChunk(x, z, seed, 987234911L).nextInt(10) == 0 =====
  -- Only the low 48 bits of the seed reach java.util.Random, so everything is worked mod 2^48, exactly, in doubles.
  local P16, P24, P32, P48 = 2 ^ 16, 2 ^ 24, 2 ^ 32, 2 ^ 48

  --- (a * b) mod 2^32 for a, b in [0, 2^32): Java int multiplication, unsigned
  local function mul32(a, b)
    local bh, bl = math.floor(b / P16), b % P16
    return (a * bl + ((a * bh) % P16) * P16) % P32
  end

  --- an int result (mod 2^32) widened to long, mod 2^48
  local function intToLong48(v)
    v = v % P32
    if v >= 2 ^ 31 then v = v - P32 end
    return v % P48
  end

  --- (a * b) mod 2^48 for a in [0, 2^48), b in [0, 2^24)
  local function mul48(a, b)
    local ah, al = math.floor(a / P24), a % P24
    return (((ah * b) % P24) * P24 + al * b) % P48
  end

  local function xor48(a, b)
    local hi = bit32.bxor(math.floor(a / P32), math.floor(b / P32))
    return (hi % P16) * P32 + bit32.bxor(a % P32, b % P32)
  end

  --- A world seed (number, or a decimal string for a long past 2^53) mod 2^48
  local function seed48(seed)
    if type(seed) == "number" then return math.floor(seed) % P48 end
    local text = tostring(seed or "0")
    local negative, digits = text:match("^%s*(%-?)(%d+)%s*$")
    if not digits then return 0 end
    local v = 0
    for d in digits:gmatch("%d") do v = (v * 10 + tonumber(d)) % P48 end
    if negative == "-" then v = (P48 - v) % P48 end
    return v
  end

  local MULT_HI, MULT_LO = 1502, 15525485 -- 0x5DEECE66D = MULT_HI * 2^24 + MULT_LO
  local function slimeChunk(seed, x, z)
    local xu, zu = x % P32, z % P32
    local s = seed48(seed)
    s = s + intToLong48(mul32(mul32(xu, xu), 4987142))
    s = s + intToLong48(mul32(xu, 5947611))
    s = s + mul48(intToLong48(mul32(zu, zu)), 4392871)
    s = s + intToLong48(mul32(zu, 389711))
    s = xor48(s % P48, 987234911)
    s = xor48(s, 0x5DEECE66D) -- new Random(seed): the scramble
    while true do
      local sh, sl = math.floor(s / P24), s % P24
      s = ((((sh * MULT_LO + sl * MULT_HI) % P24) * P24 + sl * MULT_LO) + 11) % P48
      local bits = math.floor(s / 2 ^ 17) -- next(31)
      local value = bits % 10
      if bits - value + 9 <= 2147483647 then return value == 0 end
    end
  end

  local function envOf(def)
    local env = {}
    for k, v in pairs(core.world.environment or {}) do env[k] = v end
    for k, v in pairs(def.environment or {}) do env[k] = v end
    return env
  end

  local function clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end

  function F.environmentDetector(def)
    local self = B.new(def)
    local m = self.methods
    local cfg = B.config.scanEntities
    local origin = {
      x = math.floor(def.x or 0), y = math.floor(def.y or 64), z = math.floor(def.z or 0),
    }
    local dimension = def.dimension or "minecraft:overworld"
    local provider, path = dimension:match("^([^:]+):(.+)$")
    if not provider then provider, path = "minecraft", dimension end

    B.addOperation(self, "scanEntities", {
      name = "scanEntities", type = "de.srendi.advancedperipherals.common.addons.computercraft.operations.SphereOperation",
      cooldown = cfg.cooldown, maxFreeRadius = cfg.maxFreeRadius, maxCostRadius = cfg.maxCostRadius,
      extraBlockCost = cfg.extraBlockCost,
    })
    B.addFuel(self)

    local function env() return envOf(def) end
    local function raining() return env().raining and 1 or 0 end
    local function thunder() return env().thunder and 1 or 0 end
    local function dayTime() return env().time or 1000 end

    --- Dimension.timeOfDay: vanilla's smoothed sun angle fraction.
    local function timeOfDay()
      local d0 = (dayTime() / 24000 - 0.25) % 1
      local d1 = 0.5 - math.cos(d0 * math.pi) / 2
      return (d0 * 2 + d1) / 3
    end

    --- Level.getSkyDarken (rounded as computed in updateSkyBrightness).
    local function skyDarken()
      local f = timeOfDay()
      local d0 = 1 - (raining() * 5) / 16
      local d1 = 1 - (thunder() * 5) / 16
      local d2 = 0.5 + 2 * clamp(math.cos(f * math.pi * 2), -0.25, 0.25)
      return math.floor((1 - d2 * d0 * d1) * 11)
    end

    local function skyLight() return env().skyLight or 15 end

    local function isDay() return skyDarken() < 4 end

    --- the biome's path on 0.7.30r ("plains"), its whole id from 0.7.48r ("minecraft:plains")
    function m.getBiome()
      local biome = env().biome or "plains"
      if B.V18 then return (biome:match(":(.+)$") or biome) end
      return biome:find(":", 1, true) and biome or ("minecraft:" .. biome)
    end
    function m.getSkyLightLevel() return skyLight() end
    function m.getBlockLightLevel() return env().blockLight or 0 end

    function m.getDayLightLevel()
      local i = skyLight() - skyDarken()
      local f = timeOfDay() * math.pi * 2
      if i > 0 then
        local f1 = f < math.pi and 0 or (math.pi * 2)
        f = f + (f1 - f) * 0.2
        i = math.floor(i * math.cos(f) + 0.5)
      end
      return clamp(i, 0, 15)
    end

    function m.getTime() return dayTime() end
    function m.isSlimeChunk()
      if core.vhcc then return false end -- vhcctweaks' mixin forces it
      return slimeChunk(env().seed, math.floor(origin.x / 16), math.floor(origin.z / 16))
    end
    -- Measured on the real block: Advanced Peripherals reads the name of the dimension *registry*, not of the
    -- dimension, so every dimension calls itself "dimension". A script comparing against "overworld" is always false.
    if B.V18 then
      function m.getDimensionProvider() return "minecraft" end
      function m.getDimensionName() return "dimension" end
      function m.getDimensionPaN() return "minecraft:dimension" end

      function m.isDimension(name)
        return B.string(1, name) == "dimension"
      end
    else
      -- 0.7.48r on: the level's own key, so the names are right
      local id = provider .. ":" .. path
      function m.getDimension() return id end
      function m.isDimension(name) return B.string(1, name) == id end
    end

    function m.getRadiation()
      return { radiation = env().radiation or "99.9999", unit = env().radiationUnit or "nSv" }
    end
    function m.getRadiationRaw() return env().radiationRaw or 1e-7 end

    function m.listDimensions()
      local out = {}
      local default = B.V18 and { "dimension" } or { "overworld", "the_nether", "the_end" } -- the paths, from 0.7.48r
      for _, name in ipairs(env().dimensions or default) do
        out[#out + 1] = name
      end
      return out
    end

    -- The moon table is behind the same broken dimension check, so the real block never reads the phase (measured on
    -- real moon phases 0, 3 and 4 in the overworld).
    local MOONS = { [0] = "Full moon", "Waning gibbous", "Third quarter", "Wanning crescent", "New moon",
      "Waxing crescent", "First quarter", "Waxing gibbous" }
    local function moon()
      -- from 0.7.48r the overworld check works: Level.getMoonPhase there, the easter egg elsewhere
      if B.NEW and dimension == "minecraft:overworld" then
        local phase = env().moonPhase or (math.floor(dayTime() / 24000) % 8)
        return phase, MOONS[phase] or "What is a moon"
      end
      return 0, "Moon.exe not found..."
    end

    function m.getMoonId() return (moon()) end
    function m.isMoon(phase) return B.int(1, phase) == (moon()) end
    function m.getMoonName() return select(2, moon()) end

    function m.isRaining() return raining() > 0 end
    function m.isThunder() return thunder() > 0 end
    function m.isSunny() return thunder() < 1 and raining() < 1 end

    local TOO_FAR = B.V18 and "Radius is exceed max value" or "Radius exceeds max value"

    local function estimateCost(radius)
      if radius <= cfg.maxFreeRadius then return 0 end
      if radius > cfg.maxCostRadius then return -1 end
      local free = (2 * cfg.maxFreeRadius + 1) ^ 3
      local all = (2 * radius + 1) ^ 3
      return math.floor((all - free) * cfg.extraBlockCost)
    end

    function m.scanCost(radius)
      radius = B.int(1, radius)
      local cost = estimateCost(radius)
      if cost < 0 then return nil, TOO_FAR end
      return cost
    end

    function m.scanEntities(radius)
      radius = B.int(1, radius)
      return B.perform(self, "scanEntities", cfg.cooldown, function()
        if radius > cfg.maxCostRadius then return nil, TOO_FAR end
      end, function()
        local entities = {}
        local function inside(x, y, z)
          return x >= origin.x - radius and x < origin.x + 1 + radius
            and y >= origin.y - radius and y < origin.y + 1 + radius
            and z >= origin.z - radius and z < origin.z + 1 + radius
        end
        --- LuaConverter.entityToLua / livingEntityToLua of 0.7.48r on (scanEntities only lists living entities)
        local function living(entry, src)
          entry.canFreeze = src.canFreeze ~= false
          entry.isGlowing = src.isGlowing == true
          entry.isInWall = src.isInWall == true
          entry.health = src.health or 20
          entry.maxHealth = src.maxHealth or src.health or 20
          entry.lastDamageSource = src.lastDamageSource
        end
        local function add(entry, relative)
          entry.x, entry.y, entry.z = relative.x - origin.x, relative.y - origin.y, relative.z - origin.z
          entities[#entities + 1] = entry
        end
        for _, p in ipairs(core.players) do
          if p.online and p.dimension == dimension and inside(p.x, p.y, p.z) then
            local entry = { id = 0, uuid = p.uuid, name = p.name, tags = {} }
            if B.NEW then living(entry, p) end
            add(entry, p)
          end
        end
        for index, e in ipairs(core.world.entities or {}) do
          if (e.dimension or "minecraft:overworld") == dimension and inside(e.x, e.y, e.z) then
            local entry = { id = e.id or (1000 + index), uuid = e.uuid or ("00000000-0000-4000-9000-%012x"):format(index),
              name = e.name or B.titleCase(e.type or "entity"), tags = e.tags or {} }
            if B.NEW then living(entry, e) end
            if e.animal then
              entry.baby = e.baby or false
              entry.inLove = e.inLove or false
              entry.aggressive = e.aggressive or false
            end
            add(entry, e)
          end
        end
        return entities
      end)
    end

    function m.canSleepHere()
      return not isDay()
    end

    function m.canSleepPlayer(playerName)
      playerName = B.string(1, playerName)
      local p = core.byName[playerName:lower()]
      if not p or not p.online then return false, "player_not_online" end
      if (p.dimension or "minecraft:overworld") ~= "minecraft:overworld" then
        return false, "not_allowed_in_dimension"
      end
      return not isDay()
    end

    return self
  end

  return F
end
