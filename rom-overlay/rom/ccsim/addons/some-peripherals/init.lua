-- ccsim some-peripherals: Some Peripherals 0.0.12 (Minecraft 1.18.2, Forge and Fabric) by SuperSpaceEye.
--
-- Written from SuperSpaceEye/Some-Peripherals, branch 1.18.2 at 955ec42 ("minor fix", 22 Jan 2024, the day 0.0.12
-- was published; the repository has no tags). Source files, relative to
-- common/src/main/kotlin/net/spaceeye/someperipherals/:
--   integrations/cc/{getPeripheral,CCTableConversions,makeErrorReturn}.kt;
--   integrations/cc/peripherals/{Radar,WorldScanner,BallisticAccelerator,Digitizer}Peripheral.kt;
--   stuff/radar/{scanInRadius,shipToMap}.kt; stuff/utils/{entityToMap,getEntitiesWithTimeout,linspace}.kt;
--   stuff/BallisticFunctions.kt; stuff/configToMap/Radar.kt; stuff/digitizer/{DigitalItemsSavedData,ItemData}.kt;
--   SomePeripheralsConfig.kt (defaults); SomePeripherals.kt (has_vs: Valkyrien Skies is installed).
-- docs/some-peripherals.md lists what is emulated, the fixture, the sim commands and what is not.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local floor, sqrt, abs = math.floor, math.sqrt, math.abs
  local band = bit32.band
  local cfg = core.world.somePeripherals or {}
  local conf = cfg.config or {}
  local hasVS = cfg.valkyrienSkies == true
  local gameData = core.gameData or dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)

  local function num(key, default) return tonumber(conf[key]) or default end
  local MAX_ENTITY_RADIUS = num("max_entity_search_radius", -1.0)
  local MAX_SHIP_RADIUS = num("max_ship_search_radius", -1.0)
  local SCANNER_RANGE = num("max_allowed_range", -1)

  local M = { handlers = {} }

  --- the error table the mod returns in place of a result (makeErrorReturn)
  local function errorReturn(message) return { error = message } end

  -- ===== CC's argument checks (IArguments) =====

  local function getDouble(args, i)
    local v = args[i]
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end
  local function optDouble(args, i, default)
    if args[i] == nil then return default end
    return getDouble(args, i)
  end
  local function optInt(args, i, default)
    if args[i] == nil then return default end
    return C.int(i, args[i])
  end
  local function optBool(args, i, default)
    if args[i] == nil then return default end
    return C.bool(i, args[i])
  end
  local function getTable(args, i)
    local v = args[i]
    if type(v) ~= "table" then error(("bad argument #%d (table expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end

  --- a Lua number as Kotlin prints a Double key ("1.0")
  local function doubleText(d)
    if d == floor(d) and abs(d) < 1e7 then return ("%d.0"):format(d) end
    return tostring(d)
  end

  --- CCTableConversions.tableToDoubleArray: keys 1.0 .. size (size counts every entry), each a number
  local function toDoubles(t, message)
    local size = C.count(t)
    local out = {}
    for i = 1, size do
      local v = t[i]
      if type(v) ~= "number" then error(message .. " " .. doubleText(i), 0) end
      out[i] = v
    end
    return out
  end
  local function toTables(t, message)
    local size = C.count(t)
    local out = {}
    for i = 1, size do
      local v = t[i]
      if type(v) ~= "table" then error(message .. " " .. doubleText(i), 0) end
      out[i] = v
    end
    return out
  end

  local function peripheral(def, methods, computerThread, extra)
    local names = {}
    for name in pairs(methods) do names[#names + 1] = name end
    table.sort(names)
    local p = { methods = methods, methodOrder = C.hashMapOrder(names), computerThread = computerThread, exactReturns = true }
    for k, v in pairs(extra or {}) do p[k] = v end
    return p
  end

  local function position(def)
    local pos = core.position
    return {
      x = C.toInt(tonumber(def.x) or pos.x or 0),
      y = C.toInt(tonumber(def.y) or pos.y or 64),
      z = C.toInt(tonumber(def.z) or pos.z or 0),
    }
  end

  -- ===== the world: blocks, entities, players, ships =====

  local ownWorld
  local function world()
    if core.turtle and core.turtle.world then return core.turtle.world end
    if not ownWorld then
      ownWorld = dofile("/rom/ccsim/turtle/world.lua")(core, gameData)
      ownWorld.load(core.world)
    end
    return ownWorld
  end

  local players = {}
  for i, p in ipairs(type(cfg.players) == "table" and cfg.players or {}) do players[i] = p end
  local ships = {}
  for i, s in ipairs(type(cfg.ships) == "table" and cfg.ships or {}) do ships[i] = s end

  local function dimension() return core.position.dimension or "minecraft:overworld" end

  --- Mth.sin / Mth.cos (a table of 65536 floats) and Entity.calculateViewVector
  local function mthSin(f)
    local i = band(C.toInt(C.float(f * C.float(10430.378))), 65535)
    return C.float(math.sin(i * math.pi * 2 / 65536))
  end
  local function mthCos(f)
    local i = band(C.toInt(C.float(f * C.float(10430.378) + 16384)), 65535)
    return C.float(math.sin(i * math.pi * 2 / 65536))
  end
  local RAD = C.float(math.pi / 180)
  local function viewVector(xRot, yRot)
    local f = C.float(xRot * RAD)
    local g = C.float(-yRot * RAD)
    local h, i, j, k = mthCos(g), mthSin(g), mthCos(f), mthSin(f)
    return C.float(i * j), -k, C.float(h * j)
  end

  --- Player.getXpNeededForNextLevel
  local function xpNeeded(level)
    if level >= 30 then return 112 + (level - 30) * 9 end
    if level >= 15 then return 37 + (level - 15) * 5 end
    return 7 + level * 2
  end

  --- entityToMapRadar with the default config (every field on)
  local function entityMap(e, isPlayer)
    local id = isPlayer and "minecraft:player" or gameData.id(e.type or e.name)
    local ns, path = id:match("^([^:]+):(.+)$")
    local living = isPlayer or e.living ~= false
    local eyeHeight = C.float(tonumber(e.eyeHeight) or (isPlayer and 1.62 or C.float((tonumber(e.height) or 1.8) * 0.85)))
    local xRot, yRot = tonumber(e.xRot) or 0, tonumber(e.yRot) or 0
    local yHead = tonumber(e.yHeadRot) or yRot
    local lx, ly, lz = viewVector(xRot, living and yHead or yRot)
    local item = {
      is_entity = true,
      pos = { e.x, e.y, e.z },
      eye_pos = { e.x, e.y + eyeHeight, e.z },
      eye_height = eyeHeight,
      look_angle = { lx, ly, lz },
      dimension = ("ResourceKey[minecraft:dimension / %s]"):format(e.dimension or dimension()),
      entity_type = "entity." .. ns .. "." .. path:gsub("/", "."),
      air_supply = C.toInt(tonumber(e.airSupply) or 300),
      max_air_supply = C.toInt(tonumber(e.maxAirSupply) or 300),
    }
    if living then
      item.health = C.float(tonumber(e.health) or 20)
      item.max_health = C.float(tonumber(e.maxHealth) or 20)
      item.armor_value = C.toInt(tonumber(e.armor) or 0)
      item.armor_cover_percentage = C.float(tonumber(e.armorCover) or 0)
      item.absorption_amount = C.float(tonumber(e.absorption) or 0)
      item.is_baby = e.baby == true
      item.is_blocking = e.blocking == true
      item.is_sleeping = e.sleeping == true
      item.is_fall_flying = e.fallFlying == true
      item.speed = C.float(tonumber(e.speed) or (isPlayer and 0.1 or 0))
      item.xRot = C.float(xRot)
      item.yHeadRot = C.float(yHead)
      item.yBodyRot = C.float(tonumber(e.yBodyRot) or yRot)
    end
    if isPlayer then
      local level = C.toInt(tonumber(e.experienceLevel) or 0)
      item.is_player = true
      item.nickname = e.name
      item.experience_level = level
      item.xp_needed_for_next_level = xpNeeded(level)
      item.experience_progress = C.float(tonumber(e.experienceProgress) or 0)
    end
    return item
  end

  --- shipToMap with the default config
  local function shipMap(s)
    local function v3(t, dx, dy, dz)
      t = type(t) == "table" and t or {}
      return { x = tonumber(t.x) or dx, y = tonumber(t.y) or dy, z = tonumber(t.z) or dz }
    end
    local mn, mx = s.shipyardMin or {}, s.shipyardMax or {}
    local inertia = type(s.inertia) == "table" and s.inertia or { { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 } }
    local rot = type(s.rotation) == "table" and s.rotation or {}
    return {
      is_ship = true,
      id = s.id,
      pos = v3(s.pos, 0, 0, 0),
      mass = tonumber(s.mass) or 0,
      rotation = { x = tonumber(rot.x) or 0, y = tonumber(rot.y) or 0, z = tonumber(rot.z) or 0, w = tonumber(rot.w) or 1 },
      velocity = v3(s.velocity, 0, 0, 0),
      size = {
        x = C.toInt((tonumber(mx.x) or 0) - (tonumber(mn.x) or 0)),
        y = C.toInt((tonumber(mx.y) or 0) - (tonumber(mn.y) or 0)),
        z = C.toInt((tonumber(mx.z) or 0) - (tonumber(mn.z) or 0)),
      },
      scale = v3(s.scale, 1, 1, 1),
      moment_of_inertia_tensor = inertia,
      center_of_mass_in_a_ship = v3(s.centerOfMass, 0, 0, 0),
    }
  end

  local function shipOf()
    if cfg.computerShip == nil then return nil end
    for _, s in ipairs(ships) do if s.id == cfg.computerShip then return s end end
    return nil
  end

  --- getScanPos: a radar on a ship scans from where it is in the world
  local function scanPos(pos)
    local ship = hasVS and shipOf() or nil
    if ship and type(ship.computerWorldPosition) == "table" then
      local p = ship.computerWorldPosition
      return { x = floor(tonumber(p.x) or 0), y = floor(tonumber(p.y) or 0), z = floor(tonumber(p.z) or 0) }
    end
    return pos
  end

  -- ===== radar =====

  local function boxAround(p, r) return p.x - r, p.y - r, p.z - r, p.x + r, p.y + r, p.z + r end

  local function scanEntities(r, pos)
    local p = scanPos(pos)
    local x1, y1, z1, x2, y2, z2 = boxAround(p, r)
    local out = {}
    -- the entity's box (its width and height from its feet) meets the scan box (AABB.intersects)
    local function meets(e, w, h)
      w, h = tonumber(e.width) or w, tonumber(e.height) or h
      return e.x - w / 2 < x2 and e.x + w / 2 > x1 and e.y < y2 and e.y + h > y1 and e.z - w / 2 < z2 and e.z + w / 2 > z1
    end
    for _, e in ipairs(world().entities) do
      if meets(e, 0.6, 1.8) then out[#out + 1] = entityMap(e, false) end
    end
    for _, it in ipairs(world().itemEntities) do
      local e = { type = "minecraft:item", x = it.x, y = it.y, z = it.z, living = false, height = 0.25, eyeHeight = C.float(0.2125) }
      if meets(e, 0.25, 0.25) then out[#out + 1] = entityMap(e, false) end
    end
    for _, pl in ipairs(players) do
      if (pl.dimension or dimension()) == dimension() and meets(pl, 0.6, 1.8) then out[#out + 1] = entityMap(pl, true) end
    end
    return out
  end

  local function scanPlayers(r, pos)
    local p = scanPos(pos)
    local x1, y1, z1, x2, y2, z2 = boxAround(p, r)
    local out = {}
    for _, pl in ipairs(players) do
      -- AABB.contains: the max side is open
      if (pl.dimension or dimension()) == dimension() and pl.x >= x1 and pl.x < x2 and pl.y >= y1 and pl.y < y2
          and pl.z >= z1 and pl.z < z2 then
        out[#out + 1] = entityMap(pl, true)
      end
    end
    return out
  end

  local function scanShips(r, pos)
    local p = scanPos(pos)
    local out = {}
    local current = shipOf()
    if current then out[#out + 1] = shipMap(current) end
    local x1, y1, z1, x2, y2, z2 = boxAround(p, r)
    for _, s in ipairs(ships) do
      local mn, mx = s.min or {}, s.max or {}
      if s ~= current and (tonumber(mn.x) or 0) <= x2 and (tonumber(mx.x) or 0) >= x1 and (tonumber(mn.y) or 0) <= y2
          and (tonumber(mx.y) or 0) >= y1 and (tonumber(mn.z) or 0) <= z2 and (tonumber(mx.z) or 0) >= z1 then
        out[#out + 1] = shipMap(s)
      end
    end
    return out
  end

  local function limited(radius, max)
    radius = math.max(radius, 1.0)
    if max <= 0 then return radius end
    return math.min(radius, max)
  end

  local function buildRadar(def)
    local pos = position(def)
    local methods = {}
    function methods.scan(radius)
      radius = getDouble({ radius }, 1)
      local results = scanEntities(limited(radius, MAX_ENTITY_RADIUS), pos)
      if hasVS then
        for _, s in ipairs(scanShips(limited(radius, MAX_SHIP_RADIUS), pos)) do results[#results + 1] = s end
      end
      return results
    end
    function methods.scanForEntities(radius)
      radius = getDouble({ radius }, 1)
      return scanEntities(limited(radius, MAX_ENTITY_RADIUS), pos)
    end
    function methods.scanForShips(radius)
      radius = getDouble({ radius }, 1)
      if not hasVS then return errorReturn("No Valkyrien Skies installed.") end
      return scanShips(limited(radius, MAX_SHIP_RADIUS), pos)
    end
    function methods.scanForPlayers(radius)
      radius = getDouble({ radius }, 1)
      return scanPlayers(limited(radius, MAX_ENTITY_RADIUS), pos)
    end
    function methods.getConfigInfo()
      return { max_entity_search_radius = MAX_ENTITY_RADIUS, max_ship_search_radius = MAX_SHIP_RADIUS }
    end
    return peripheral(def, methods, { getConfigInfo = true })
  end

  -- ===== world scanner =====

  --- a block's descriptionId: "block.<namespace>.<path>", slashes as dots
  local function descriptionId(id)
    local ns, path = id:match("^([^:]+):(.+)$")
    return "block." .. ns .. "." .. path:gsub("/", ".")
  end

  local function buildWorldScanner(def)
    local pos = position(def)
    local methods = {}
    function methods.getBlockAt(...)
      local args = table.pack(...)
      local x, y, z = getDouble(args, 1), getDouble(args, 2), getDouble(args, 3)
      if hasVS then optBool(args, 4, false) end
      if SCANNER_RANGE >= 0 and sqrt(x * x + y * y + z * z) > SCANNER_RANGE then
        return errorReturn("Block is outside of range")
      end
      -- new BlockPos(double, double, double) floors each coordinate
      local bx, by, bz = floor(x + pos.x), floor(y + pos.y), floor(z + pos.z)
      local b = world().get(bx, by, bz)
      return { block_type = descriptionId(b and b.name or "minecraft:air") }
    end
    return peripheral(def, methods, { getBlockAt = true })
  end

  -- ===== ballistic accelerator (BallisticFunctions) =====

  local B = {}
  function B.rad(deg) return deg * 0.017453292519943295 end

  --- utils/linspace.kt, with its quirks: below zero the values come out shifted, and the end is added once more
  function B.linspace(start, stop, n)
    local out = {}
    if n == 0 then return out end
    if n == 1 then return { start } end
    local displacement = 0.0
    if start <= 0 then displacement = abs(start) + 1 end
    local s, e = start + displacement, stop + displacement
    local delta = (e - s) / (n - 1)
    for i = 0, n - 1 do out[#out + 1] = (start + delta * i) - displacement end
    e = e - displacement
    out[#out + 1] = e
    return out
  end
  function B.flinspace(start, stop, n, lo, hi) return B.linspace(math.max(start, lo), math.min(stop, hi), n) end

  function B.getRoot(data, fromEnd)
    if fromEnd then
      for i = #data - 1, 1, -1 do if data[i][1] > data[i + 1][1] then return data[i + 1] end end
      return data[1]
    end
    for i = 2, #data do if data[i - 1][1] < data[i][1] then return data[i - 1] end end
    return data[#data]
  end

  local INT_MAX = 2147483647

  function B.timeInAir(y0, yTarget, vy, gravity, drag, maxSteps)
    local t, tBelow = 0, INT_MAX
    if y0 < yTarget then
      while t < maxSteps do
        local prev = y0
        y0 = y0 + vy
        vy = drag * vy - gravity
        t = t + 1
        if y0 > yTarget then tBelow = t - 1 break end
        if y0 - prev < 0 then return -1, -1 end
      end
    end
    while t < maxSteps do
      y0 = y0 + vy
      vy = drag * vy - gravity
      t = t + 1
      if y0 <= yTarget then return tBelow, t end
    end
    return tBelow, -1
  end

  function B.tryPitch(pitch, speed, length, distance, cannon, target, gravity, drag, maxSteps)
    local r = B.rad(pitch)
    local vw = math.cos(r) * speed
    local vy = math.sin(r) * speed
    local x2d = length * math.cos(r)
    if vw == 0.0 then return nil end
    local part = 1 - (distance - x2d) / (100 * vw)
    if part <= 0.0 then return nil end
    local horizontal = abs(math.log(part) / math.log(drag))
    local yEnd = cannon[2] + math.sin(r) * length
    local below, above = B.timeInAir(yEnd, target[2], vy, gravity, drag, maxSteps)
    if below < 0 then return nil end
    local dt = math.min(abs(horizontal - below), abs(horizontal - above))
    return { dt, pitch, dt + horizontal }
  end

  function B.tryPitches(list, speed, length, distance, cannon, target, gravity, drag, maxSteps)
    local out = {}
    for _, p in ipairs(list) do
      local r = B.tryPitch(p, speed, length, distance, cannon, target, gravity, drag, maxSteps)
      if r then out[#out + 1] = r end
    end
    return out
  end

  local function minBy(list)
    local best = list[1]
    for i = 2, #list do if list[i][1] < best[1] then best = list[i] end end
    return best
  end

  function B.calculatePitch(cannon, target, speed, length, amin, amax, gravity, drag, maxError, maxSteps, iterations, elements, checkImpossible)
    local dx, dz = cannon[1] - target[1], cannon[3] - target[3]
    local distance = sqrt(dx * dx + dz * dz)
    local pitches = {}
    for a = amax, amin, -1 do pitches[#pitches + 1] = a + 0.0 end
    local none = function() return { -1.0, -1.0, -1.0 }, { -1.0, -1.0, -1.0 } end
    local deltas = B.tryPitches(pitches, speed, length, distance, cannon, target, gravity, drag, maxSteps)
    if #deltas == 0 then return none() end
    local r1, r2 = B.getRoot(deltas, false), B.getRoot(deltas, true)
    local dT1, p1, at1 = r1[1], r1[2], r1[3]
    local dT2, p2, at2 = r2[1], r2[2], r2[3]
    local c1, c2 = true, p1 ~= p2
    local same = p1 == p2
    local dTs1, dTs2 = {}, {}
    for i = 0, iterations - 1 do
      local step = 10.0 ^ (-i)
      if c1 then dTs1 = B.tryPitches(B.flinspace(p1 - step, p1 + step, elements, amin, amax), speed, length, distance, cannon, target, gravity, drag, maxSteps) end
      if c2 then dTs2 = B.tryPitches(B.flinspace(p2 - step, p2 + step, elements, amin, amax), speed, length, distance, cannon, target, gravity, drag, maxSteps) end
      if c1 and #dTs1 == 0 then c1 = false end
      if c2 and #dTs2 == 0 then c2 = false end
      if not c1 and not c2 then return none() end
      if c1 then local t = minBy(dTs1) dT1, p1, at1 = t[1], t[2], t[3] end
      if c2 then local t = minBy(dTs2) dT2, p2, at2 = t[1], t[2], t[3] end
    end
    if same then dT2, p2, at2 = dT1, p1, at1 end
    local a, b = { dT1, p1, at1 }, { dT2, p2, at2 }
    if checkImpossible and dT1 > maxError then a = { -1.0, -1.0, -1.0 } end
    if checkImpossible and dT2 > maxError then b = { -1.0, -1.0, -1.0 } end
    return a, b
  end

  function B.getDrag(base, mult)
    if mult <= 1 then return 1.0 + mult * (base - 1.0) end -- Mth.lerp(mult, 1.0, base)
    local diff = base - 1
    local v = base + diff * (mult - 1)
    if v < 0.9 then return 0.9 end -- Mth.clamp(v, 0.9, base)
    return math.min(v, base)
  end
  M.B = B

  local function buildBallistic(def)
    local methods = {}
    function methods.timeInAir(...)
      local a = table.pack(...)
      local y0, yt, vy = getDouble(a, 1), getDouble(a, 2), getDouble(a, 3)
      local g, d, steps = optDouble(a, 4, 0.05), optDouble(a, 5, 0.99), optInt(a, 6, 1000000)
      local below, above = B.timeInAir(y0, yt, vy, g, d, steps)
      return { below + 0.0, above + 0.0 }
    end
    function methods.tryPitch(...)
      local a = table.pack(...)
      local pitch, speed, length, distance = getDouble(a, 1), getDouble(a, 2), getDouble(a, 3), getDouble(a, 4)
      local cannon = toDoubles(getTable(a, 5), "Can't convert cannon item at ")
      local target = toDoubles(getTable(a, 6), "Can't convert target item at ")
      local g, d, steps = optDouble(a, 7, 0.05), optDouble(a, 8, 0.99), optInt(a, 9, 1000000)
      return B.tryPitch(pitch, speed, length, distance, cannon, target, g, d, steps) or { -1, -1, -1 }
    end
    local function pitchArgs(a, first)
      local speed, length = getDouble(a, first), getDouble(a, first + 1)
      return speed, length, optInt(a, first + 2, -30), optInt(a, first + 3, 60), optDouble(a, first + 4, 0.05),
        optDouble(a, first + 5, 0.99), optDouble(a, first + 6, 1.0), optInt(a, first + 7, 1000000),
        optInt(a, first + 8, 5), optInt(a, first + 9, 20), optBool(a, first + 10, true)
    end
    function methods.calculatePitch(...)
      local a = table.pack(...)
      local cannon = toDoubles(getTable(a, 1), "Can't convert cannon item at ")
      local target = toDoubles(getTable(a, 2), "Can't convert target item at ")
      local r1, r2 = B.calculatePitch(cannon, target, pitchArgs(a, 3))
      return { r1, r2 }
    end
    function methods.batchCalculatePitches(...)
      local a = table.pack(...)
      local cannon = toDoubles(getTable(a, 1), "Can't convert cannon item at ")
      local targets = toTables(getTable(a, 2), "Can't convert targets at ")
      local rest = table.pack(pitchArgs(a, 3))
      local out = {}
      for i, t in ipairs(targets) do
        local r1, r2 = B.calculatePitch(cannon, toDoubles(t, "Can't convert target"), table.unpack(rest, 1, rest.n))
        out[i] = { r1, r2 }
      end
      return out
    end
    function methods.getDrag(base, mult)
      base = getDouble({ base }, 1)
      mult = getDouble({ nil, mult }, 2)
      return B.getDrag(base, mult)
    end
    -- none of these is mainThread
    return peripheral(def, methods, { timeInAir = true, tryPitch = true, calculatePitch = true,
      batchCalculatePitches = true, getDrag = true })
  end

  -- ===== digitizer (DigitalItemsSavedData is one store for the whole world) =====

  local saved = core.savedState and core.savedState.addons and core.savedState.addons["some-peripherals"] or {}
  local digital = {}
  for k, v in pairs(type(saved.digital) == "table" and saved.digital or {}) do digital[k] = v end
  for k, v in pairs(type(cfg.digitalItems) == "table" and cfg.digitalItems or {}) do
    if digital[k] == nil then digital[k] = v end
  end

  --- UUID.randomUUID().toString(): version 4, variant 10
  local function uuid()
    local function hex(n) local s = {} for i = 1, n do s[i] = ("%x"):format(math.random(0, 15)) end return table.concat(s) end
    local v = math.random(1, 4)
    return hex(8) .. "-" .. hex(4) .. "-4" .. hex(3) .. "-" .. ("89ab"):sub(v, v) .. hex(3) .. "-" .. hex(12)
  end

  --- UUID.fromString: five dash-separated hex groups (at most 36 chars), each cut to its width; nil when it is not one
  local WIDTH = { 8, 4, 4, 4, 12 }
  local function parseUUID(s)
    if type(s) ~= "string" or #s > 36 then return nil end
    local groups = {}
    for g in (s .. "-"):gmatch("([^-]*)-") do groups[#groups + 1] = g end
    if #groups ~= 5 then return nil end
    for i, g in ipairs(groups) do
      local digits = g:gsub("^%+", "")
      if digits == "" or digits:find("[^%x]") or #digits > 16 then return nil end
      digits = digits:lower():gsub("^0+", "")
      if #digits > WIDTH[i] then digits = digits:sub(-WIDTH[i]) end
      groups[i] = ("0"):rep(WIDTH[i] - #digits) .. digits
    end
    return table.concat(groups, "-")
  end

  local function stackable(a, b)
    if (a.maxCount or 64) <= 1 then return false end
    return a.name == b.name and a.nbt == b.nbt
  end

  local function buildDigitizer(def)
    local inv = host.newInventory({ name = def.name, size = 1, items = def.item and { [1] = def.item } or def.items })
    local function slot() return inv.__state()[1] end
    local LIMIT = 64 -- the slot's limit (ItemStackHandler)

    local methods = {}
    function methods.digitizeAmount(...)
      local a = table.pack(...)
      local amount = optInt(a, 1, INT_MAX)
      if amount <= 0 then return errorReturn("Invalid amount") end
      local item = slot()
      if not item or item.count == 0 then return errorReturn("Empty slot") end
      amount = math.min(amount, item.count)
      local id = uuid()
      local copy = {}
      for k, v in pairs(item) do copy[k] = v end
      copy.count = amount
      digital[id] = copy
      item.count = item.count - amount
      if item.count <= 0 then inv.__state()[1] = nil end
      core.save()
      return id
    end
    function methods.rematerializeAmount(...)
      local a = table.pack(...)
      local id = parseUUID(type(a[1]) == "number" and tostring(a[1]) or a[1])
      if not id then return errorReturn("First argument is not a UUID") end
      local amount = optInt(a, 2, INT_MAX)
      if amount <= 0 then return errorReturn("Invalid amount") end
      local stored = digital[id]
      if not stored then return errorReturn("UUID doesn't exist") end
      local current = slot()
      amount = math.min(math.min(amount, stored.count), LIMIT - (current and current.count or 0))
      if amount > 0 then
        local fits = current == nil or stackable(current, stored)
        local maxStack = math.min(LIMIT, stored.maxCount or 64)
        if not fits or (current and current.count or 0) + amount > maxStack then
          return errorReturn("Failed to merge item inside digitizer with already rematerialized items")
        end
        inv.__insert(stored, amount, 1)
      end
      stored.count = stored.count - amount
      if stored.count == 0 then digital[id] = nil end
      core.save()
      return true
    end
    function methods.mergeDigitalItems(...)
      local a = table.pack(...)
      local into = parseUUID(a[1])
      if not into then return errorReturn("First argument is not a UUID") end
      local from = parseUUID(a[2])
      if not from then return errorReturn("Second argument is not a UUID") end
      local amount = optInt(a, 3, INT_MAX)
      if amount <= 0 then return errorReturn("Invalid amount") end
      if into == from then return errorReturn("Items have same id") end
      if not digital[into] then return errorReturn("First id does not exists") end
      if not digital[from] then return errorReturn("Second id does not exists") end
      local i, f = digital[into], digital[from]
      if not stackable(i, f) then return errorReturn("Can't stack items") end
      if amount > f.count then amount = f.count end
      i.count = i.count + amount
      f.count = f.count - amount
      if f.count == 0 then digital[from] = nil end
      core.save()
      return true
    end
    function methods.separateDigitalItem(from, amount)
      from = C.str(1, from)
      amount = C.int(2, amount)
      local id = parseUUID(from)
      if not id then return errorReturn("First argument is not a UUID") end
      if amount <= 0 then return errorReturn("Invalid amount") end
      local f = digital[id]
      if not f then return errorReturn("id does not exists") end
      if (f.maxCount or 64) <= 1 then return errorReturn("Item is not stackable") end
      if f.count <= amount then return errorReturn("Cannot separate stack") end
      local copy = {}
      for k, v in pairs(f) do copy[k] = v end
      copy.count = amount
      f.count = f.count - amount
      local newId = uuid()
      digital[newId] = copy
      core.save()
      return newId
    end
    function methods.checkID(id)
      id = parseUUID(C.str(1, id))
      if not id then return errorReturn("First argument is not a UUID") end
      local stored = digital[id]
      if not stored then return errorReturn("UUID doesn't exist") end
      return { item = host.itemDetail(stored) }
    end
    function methods.getItemInSlot()
      local item = slot()
      if not item then return {} end
      return host.itemDetail(item)
    end
    function methods.getItemLimitInSlot() return LIMIT end
    return peripheral(def, methods, {}, {
      inventory = inv,
      state = function()
        local item = slot()
        return { item = item and C.deepCopy(item) or nil }
      end,
    })
  end

  local BUILDERS = {
    sp_radar = buildRadar,
    world_scanner = buildWorldScanner,
    ballistic_accelerator = buildBallistic,
    digitizer = buildDigitizer,
  }

  function M.peripheral(def)
    return BUILDERS[def.type](def)
  end

  function M.state()
    return { digital = C.deepCopy(digital) }
  end

  -- ===== sim commands =====

  function M.handlers.spSetPlayer(cmd)
    local p = cmd.player
    if type(p) ~= "table" or type(p.name) ~= "string" then return false, "player needs a name" end
    for i, q in ipairs(players) do
      if q.name == p.name then
        if cmd.remove then table.remove(players, i) else players[i] = p end
        return true
      end
    end
    if not cmd.remove then players[#players + 1] = p end
    return true
  end

  function M.handlers.spAddEntity(cmd)
    local e = cmd.entity
    if type(e) ~= "table" or not (e.x and e.y and e.z and (e.type or e.name)) then return false, "entity needs type, x, y and z" end
    local list = world().entities
    list[#list + 1] = e
    return true
  end

  function M.handlers.spRemoveEntity(cmd)
    local list = world().entities
    for i = #list, 1, -1 do
      local e = list[i]
      if (cmd.uuid and e.uuid == cmd.uuid) or (cmd.type and (e.type or e.name) == cmd.type) then table.remove(list, i) end
    end
    return true
  end

  function M.handlers.spSetBlock(cmd)
    local x, y, z = tonumber(cmd.x), tonumber(cmd.y), tonumber(cmd.z)
    if not (x and y and z) then return false, "x, y and z are needed" end
    local w = world()
    if cmd.name == nil or gameData.id(cmd.name) == "minecraft:air" then w.set(x, y, z, nil)
    else w.set(x, y, z, w.newBlock({ name = cmd.name, state = cmd.state })) end
    return true
  end

  function M.handlers.spSetShips(cmd)
    if type(cmd.ships) ~= "table" then return false, "ships must be a list" end
    ships = {}
    for i, s in ipairs(cmd.ships) do ships[i] = s end
    if cmd.computerShip ~= nil then cfg.computerShip = cmd.computerShip end
    if cmd.leaveShip then cfg.computerShip = nil end
    return true
  end

  return M
end
