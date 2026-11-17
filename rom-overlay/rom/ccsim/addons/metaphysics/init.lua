-- ccsim metaphysics: Metaphysics 0.0.6 (mod id "cryptography", Forge 1.20.1) by fashaodesu.
--
-- Written from the released jar, cryptography-0.0.6.jar from Modrinth, decompiled with Vineflower 1.10.1 (the
-- repository KallenKas024/Metaphysics does not match that release). Classes, in com.example.cryptography:
--   mixin/TileComputerMixin (adds the three APIs to every ServerComputer), CryptographyAPI, CoordinateAPI, Database,
--   ModEvents (player_death), mixin/TurtleMoveCommandMixin, Cryptography (MAX_SCOPE 2500).
-- The mod has no peripherals: its APIs are globals (`globals` below), each under two names, on every computer.
-- CoordinateAPI calls Valkyrien Skies 2 in nearly every method without declaring it, so it works only with VS2
-- installed: the sim is a VS2 world whose ships come from the fixture. docs/metaphysics.md has the rest.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local X = dofile("/rom/ccsim/addons/metaphysics/crypto.lua")()
  local floor, ceil = math.floor, math.ceil
  local band, bor, lshift = bit32.band, bit32.bor, bit32.lshift
  local cfg = core.world.metaphysics or {}
  local gameData = core.gameData or dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)
  local rules = dofile("/rom/ccsim/turtle/rules.lua")(gameData, core.world.gameData)

  -- ===== Java strings =====

  --- a Lua string as CC hands it to Java (each byte one char), then String.getBytes(UTF_8)
  local function utf8Bytes(s)
    return (s:gsub("[\128-\255]", function(c)
      local b = c:byte()
      return string.char(0xC0 + floor(b / 64), 0x80 + b % 64)
    end))
  end

  --- new String(bytes, UTF_8) back to Lua: a char above 255 (or a broken sequence, U+FFFD) comes out as "?"
  local function fromUtf8(bytes)
    local out, i, n = {}, 1, #bytes
    while i <= n do
      local b = bytes:byte(i)
      local need, cp
      if b < 0x80 then need, cp = 0, b
      elseif b >= 0xC2 and b <= 0xDF then need, cp = 1, b - 0xC0
      elseif b >= 0xE0 and b <= 0xEF then need, cp = 2, b - 0xE0
      elseif b >= 0xF0 and b <= 0xF4 then need, cp = 3, b - 0xF0
      else need = -1 end
      if need < 0 then
        out[#out + 1] = "?"
        i = i + 1
      else
        local ok = true
        for j = 1, need do
          local c = bytes:byte(i + j)
          if not c or c < 0x80 or c > 0xBF then ok = false break end
          cp = cp * 64 + (c - 0x80)
        end
        if ok then
          out[#out + 1] = cp <= 255 and string.char(cp) or "?"
          i = i + need + 1
        else
          out[#out + 1] = "?"
          i = i + 1
        end
      end
    end
    return table.concat(out)
  end

  --- bytesToHexString: upper case; nothing (null) for no bytes
  local function hex(bytes)
    if #bytes == 0 then return nil end
    return (bytes:gsub(".", function(c) return ("%02X"):format(c:byte()) end))
  end

  --- hexStringToBytes: upper-cased, two chars a byte, an odd last char dropped; a char that is not hex counts as -1
  local function unhex(src)
    if src == "" then return nil end
    src = src:upper()
    local out = {}
    for i = 1, floor(#src / 2) do
      local a = ("0123456789ABCDEF"):find(src:sub(2 * i - 1, 2 * i - 1), 1, true)
      local b = ("0123456789ABCDEF"):find(src:sub(2 * i, 2 * i), 1, true)
      a = a and a - 1 or -1
      b = b and b - 1 or -1
      out[i] = string.char(band(bor(lshift(a, 4), b), 0xFF))
    end
    return table.concat(out)
  end

  local function randomBytes(n)
    local out = {}
    for i = 1, n do out[i] = string.char(math.random(0, 255)) end
    return table.concat(out)
  end

  -- ===== crypto / cryptography (CryptographyAPI) =====

  --- generateKey: SHA1PRNG seeded with the key's UTF-8 bytes, then KeyGenerator AES 256 draws 32 bytes from it
  local function aesKey(keyString) return X.sha1prng(utf8Bytes(keyString)).nextBytes(32) end

  local crypto = {}
  function crypto.SHA512HASH(...)
    -- the argument's LuaException is caught: no string hashes nothing
    local v = (...)
    local data = type(v) == "string" and v or type(v) == "number" and tostring(v) or ""
    return hex(X.sha3_512(utf8Bytes(data)))
  end
  function crypto.SHA256HASH(...)
    local data = C.str(1, (...))
    return hex(X.sha3_256(utf8Bytes(data)))
  end
  function crypto.AESGCMEncrypt(...)
    local args = table.pack(...)
    local iv = randomBytes(12)
    local key = aesKey(C.str(2, args[2])) -- the key is read first, when the cipher is set up
    local text = C.str(1, args[1])
    return hex(iv .. X.gcmEncrypt(key, iv, utf8Bytes(text)))
  end
  function crypto.AESGCMDecrypt(...)
    local args = table.pack(...)
    local bytes = unhex(C.str(1, args[1]))
    if bytes == nil then
      C.java("java.lang.NullPointerException", 'Cannot read the array length because "bytes" is null')
    end
    if #bytes < 12 then C.java("java.lang.NegativeArraySizeException", tostring(#bytes - 12)) end
    local key = aesKey(C.str(2, args[2]))
    -- a wrong key or a damaged message fails the tag check, which is caught: the result is empty
    local plain = X.gcmDecrypt(key, bytes:sub(1, 12), bytes:sub(13)) or ""
    return fromUtf8(plain)
  end
  function crypto.Salt() return hex(randomBytes(128)) end

  -- ===== the world the coordinate API reads =====

  local ownWorld
  local function world()
    if core.turtle and core.turtle.world then return core.turtle.world end
    if not ownWorld then
      ownWorld = dofile("/rom/ccsim/turtle/world.lua")(core, gameData)
      ownWorld.load(core.world)
    end
    return ownWorld
  end

  -- the highest y anything in the world file reaches: the sky is clear above it
  local ceiling = -64
  do
    local w = core.world
    if type(w.ground) == "table" then ceiling = math.max(ceiling, tonumber(w.ground.y) or 63) end
    for _, b in ipairs(w.blocks or {}) do ceiling = math.max(ceiling, tonumber(b.y or b[2]) or ceiling) end
    for _, f in ipairs(w.fills or {}) do
      local a, b = f.from or {}, f.to or {}
      ceiling = math.max(ceiling, tonumber(a[2] or a.y) or ceiling, tonumber(b[2] or b.y) or ceiling)
    end
  end
  local function raise(y) if y > ceiling then ceiling = y end end

  local function dimension() return core.position.dimension or "minecraft:overworld" end
  local function minY() return (world().limits(dimension())) end
  local function maxY() local _, hi = world().limits(dimension()) return hi end

  local AIR = { name = "minecraft:air", state = {} }
  local function blockAt(x, y, z) return world().get(x, y, z) or AIR end
  local function isAir(b) return rules.isAir(b) or b.name == "minecraft:air" end

  --- Level.canSeeSky(pos): sky light at full. Only a dimension with sky light has it; above the highest block of the
  --- world everything does, and below a block nothing does (the sim does not light the world: any block shades)
  local function skyVisible(x, y, z)
    if cfg.hasSkyLight == false or (cfg.hasSkyLight == nil and dimension() ~= "minecraft:overworld") then return false end
    for yy = y + 1, math.max(y, ceiling) do
      if not isAir(blockAt(x, yy, z)) then return false end
    end
    return true
  end

  -- ===== ships (Valkyrien Skies 2, from the fixture) =====

  local ships = {}
  for i, s in ipairs(type(cfg.ships) == "table" and cfg.ships or {}) do ships[i] = s end
  local function shipOf()
    -- the ship managing the computer's block, when it stands in a shipyard
    local id = cfg.computerShip
    if id == nil then return nil end
    for _, s in ipairs(ships) do if s.id == id then return s end end
    return nil
  end

  -- ===== the computer's position =====

  local pos = { x = C.toInt(core.position.x or 0), y = C.toInt(core.position.y or 64), z = C.toInt(core.position.z or 0) }

  local function coordinate()
    local ship = shipOf()
    if ship and type(ship.computerWorldPosition) == "table" then
      local p = ship.computerWorldPosition
      return { x = tonumber(p.x) or 0, y = tonumber(p.y) or 0, z = tonumber(p.z) or 0 }
    end
    return { x = pos.x, y = pos.y, z = pos.z }
  end

  -- ===== entities =====

  local CATEGORY = {}
  for _, n in ipairs({ "zombie", "husk", "drowned", "skeleton", "stray", "wither_skeleton", "creeper", "spider",
    "cave_spider", "enderman", "witch", "slime", "magma_cube", "blaze", "ghast", "phantom", "pillager", "vindicator",
    "evoker", "ravager", "vex", "silverfish", "endermite", "guardian", "elder_guardian", "shulker", "piglin",
    "piglin_brute", "zombified_piglin", "hoglin", "zoglin", "zombie_villager", "illusioner", "giant", "warden",
    "wither", "ender_dragon" }) do CATEGORY["minecraft:" .. n] = "monster" end
  for _, n in ipairs({ "cow", "pig", "sheep", "chicken", "horse", "donkey", "mule", "llama", "wolf", "cat", "ocelot",
    "rabbit", "fox", "panda", "parrot", "polar_bear", "turtle", "bee", "goat", "frog", "camel", "sniffer", "mooshroom",
    "strider", "skeleton_horse", "zombie_horse", "trader_llama" }) do CATEGORY["minecraft:" .. n] = "creature" end
  CATEGORY["minecraft:bat"] = "ambient"
  CATEGORY["minecraft:squid"] = "water_creature"
  CATEGORY["minecraft:dolphin"] = "water_creature"
  CATEGORY["minecraft:glow_squid"] = "underground_water_creature"
  CATEGORY["minecraft:axolotl"] = "axolotls"
  for _, n in ipairs({ "cod", "salmon", "tropical_fish", "pufferfish", "tadpole" }) do
    CATEGORY["minecraft:" .. n] = "water_ambient"
  end
  -- classes that extend Monster or FlyingMob, and the ender dragon (getMonster's instanceof checks)
  local MONSTER = {}
  for _, n in ipairs({ "zombie", "husk", "drowned", "zombie_villager", "zombified_piglin", "skeleton", "stray",
    "wither_skeleton", "creeper", "spider", "cave_spider", "enderman", "endermite", "silverfish", "witch", "blaze",
    "guardian", "elder_guardian", "vex", "pillager", "vindicator", "evoker", "illusioner", "ravager", "piglin",
    "piglin_brute", "zoglin", "giant", "warden", "wither", "ghast", "phantom", "ender_dragon" }) do
    MONSTER["minecraft:" .. n] = true
  end
  local NOT_A_MOB = { ["minecraft:armor_stand"] = true, ["minecraft:player"] = true }

  local function titleCase(id)
    local path = id:match(":(.+)$") or id
    return (path:gsub("_", " "):gsub("(%a)([%w]*)", function(a, b) return a:upper() .. b end))
  end

  --- Mth.sin / Mth.cos: a table of 65536 floats
  local function mthSin(f)
    local i = band(C.toInt(C.float(f * C.float(10430.378))), 65535)
    return C.float(math.sin(i * math.pi * 2 / 65536))
  end
  local function mthCos(f)
    local i = band(C.toInt(C.float(f * C.float(10430.378) + 16384)), 65535)
    return C.float(math.sin(i * math.pi * 2 / 65536))
  end
  local RAD = C.float(math.pi / 180)
  --- Entity.calculateViewVector(xRot, yRot), in floats
  local function viewVector(xRot, yRot)
    local f = C.float(xRot * RAD)
    local g = C.float(-yRot * RAD)
    local h, i, j, k = mthCos(g), mthSin(g), mthCos(f), mthSin(f)
    return C.float(i * j), -k, C.float(h * j)
  end

  local DIR2D = { [0] = "south", "west", "north", "east" }

  --- every entity of the computer's level: mobs (world.entities), item entities (world.items), players
  local function players()
    if not cfg.__players then
      cfg.__players = {}
      for i, p in ipairs(type(cfg.players) == "table" and cfg.players or {}) do cfg.__players[i] = p end
    end
    return cfg.__players
  end

  local function allEntities()
    local out = {}
    for i, e in ipairs(world().entities) do
      local id = gameData.id(e.type or e.name)
      out[#out + 1] = {
        e = e, id = id, uuid = e.uuid or ("00000000-0000-4000-8000-0000%08x"):format(i),
        living = e.living ~= false, player = false,
        name = e.displayName or e.customName or titleCase(id),
      }
    end
    for i, it in ipairs(world().itemEntities) do
      out[#out + 1] = {
        e = it, id = "minecraft:item", uuid = ("00000000-0000-4000-8000-0002%08x"):format(i),
        living = false, player = false, name = it.item.displayName or gameData.displayName(it.item.name),
      }
    end
    for i, p in ipairs(players()) do
      if (p.dimension or dimension()) == dimension() then
        out[#out + 1] = {
          e = p, id = "minecraft:player", uuid = p.uuid or ("00000000-0000-4000-8000-0001%08x"):format(i),
          living = true, player = true, name = p.name,
        }
      end
    end
    return out
  end

  local function health(e) return C.float(tonumber(e.health) or 20) end
  local function maxHealth(e) return C.float(tonumber(e.maxHealth) or 20) end
  local function armor(e) return C.toInt(tonumber(e.armor) or 0) end
  local function alive(e) return (tonumber(e.health) or 20) > 0 end

  --- getEntitiesRaw / getPlayersRaw / getMonster's box: corner (floor(x) + s, floor(y) + s, floor(z) + s) and
  --- ((int) (x - s), floor(y) - s, floor(z) - s); new AABB sorts them
  local function scopeBox(scope)
    local c = coordinate()
    local x1, y1, z1 = C.toInt(floor(c.x) + scope), C.toInt(floor(c.y) + scope), C.toInt(floor(c.z) + scope)
    local x2, y2, z2 = C.toInt(c.x - scope), C.toInt(floor(c.y) - scope), C.toInt(floor(c.z) - scope)
    return {
      minX = math.min(x1, x2), maxX = math.max(x1, x2), minY = math.min(y1, y2), maxY = math.max(y1, y2),
      minZ = math.min(z1, z2), maxZ = math.max(z1, z2),
    }
  end
  --- AABB.contains: the max side is open
  local function contains(b, x, y, z)
    return x >= b.minX and x < b.maxX and y >= b.minY and y < b.maxY and z >= b.minZ and z < b.maxZ
  end

  local function canSeeSkyD(x, y, z) return skyVisible(C.toInt(ceil(x)), C.toInt(ceil(y)), C.toInt(ceil(z))) end

  -- ===== coord / coordinate (CoordinateAPI) =====

  local coord = {}
  local function xyz(x, y, z) return C.int(1, x), C.int(2, y), C.int(3, z) end
  local function num(i, v)
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end

  function coord.getCoord() return coordinate() end

  function coord.getBlock(x, y, z)
    x, y, z = xyz(x, y, z)
    -- descriptionId "block.ns.path" less "block.", dots to colons
    local id = blockAt(x, y, z).name
    return (id:gsub("/", "."):gsub("%.", ":"))
  end

  function coord.canSeeSky(x, y, z)
    x, y, z = num(1, x), num(2, y), num(3, z)
    return canSeeSkyD(x, y, z)
  end

  function coord.getBlockIsReplaceable(x, y, z)
    x, y, z = xyz(x, y, z)
    local b = blockAt(x, y, z)
    return isAir(b) or gameData.blockHasTag(b.name, "minecraft:replaceable") or rules.isReplaceable(b)
  end

  function coord.getBlockIsSolid(x, y, z)
    x, y, z = xyz(x, y, z)
    local b = blockAt(x, y, z)
    if type(b.def) == "table" and b.def.solid ~= nil then return b.def.solid == true end
    return rules.hasCollision(b)
  end

  function coord.isBlockLoaded(x, y, z)
    x, y, z = xyz(x, y, z)
    if y < minY() or y > maxY() then return false end
    local key = floor(x / 16) .. "," .. floor(z / 16)
    for _, k in ipairs(type(cfg.unloadedChunks) == "table" and cfg.unloadedChunks or {}) do
      if k == key then return false end
    end
    return true
  end

  function coord.getSelfDimensionType()
    return dimension():match(":(.+)$") or dimension()
  end

  function coord.isBlockAir(x, y, z)
    x, y, z = xyz(x, y, z)
    return isAir(blockAt(x, y, z))
  end

  local function entitiesRaw(scope, flag)
    local all = scope == -1
    local box = scopeBox(scope)
    local result = {}
    for _, info in ipairs(allEntities()) do
      local e = info.e
      if (not flag or canSeeSkyD(e.x, e.y, e.z)) then
        local px, py, pz = C.toInt(e.x), C.toInt(e.y), C.toInt(e.z)
        if all or (px <= box.maxX and px >= box.minX and py <= box.maxY and py >= box.minY and pz <= box.maxZ and pz >= box.minZ) then
          local map = { x = e.x, y = e.y, z = e.z, uuid = info.uuid, name = info.name }
          if info.player then
            map.isPlayer = true
            map.playerInfo = { isCreative = e.isCreative == true, isSpectator = e.isSpectator == true }
          else
            map.isPlayer = false
            map.playerInfo = {}
          end
          map.type = info.id
          local yRot = tonumber(e.yRot) or 0
          map.direction = DIR2D[band(floor(yRot / 90 + 0.5), 3)]
          local m = type(e.motion) == "table" and e.motion or {}
          map.vector = { x = tonumber(m.x) or 0, y = tonumber(m.y) or 0, z = tonumber(m.z) or 0 }
          local lx, ly, lz = viewVector(tonumber(e.xRot) or 0, tonumber(info.living and e.yHeadRot or nil) or yRot)
          local yaw = math.atan2(lx, lz) * 180 / math.pi
          if yaw > 89.9 or yaw < -89.9 then yaw = math.atan2(ly, lz) * 180 / math.pi end
          map.yaw = yaw
          map.pitch = math.asin(ly) * 180 / math.pi
          map.raw_euler_x, map.raw_euler_y, map.raw_euler_z = lx, ly, lz
          if info.living then
            map.isLivingEntity = true
            map.maxHealth = maxHealth(e)
            map.health = health(e)
            map.armor = armor(e)
          else
            map.isLivingEntity = false
          end
          result[info.uuid] = map
        end
      end
    end
    return result
  end

  function coord.getEntities(scope) return entitiesRaw(C.int(1, scope), true) end
  function coord.getEntitiesAll(scope) return entitiesRaw(C.int(1, scope), false) end

  function coord.getBlockExplosionResistance(x, y, z)
    x, y, z = xyz(x, y, z)
    local b = blockAt(x, y, z)
    if isAir(b) then return 0 end
    local r = type(b.def) == "table" and b.def.explosionResistance
    if r == nil and type(cfg.explosionResistance) == "table" then r = cfg.explosionResistance[b.name] end
    if r == nil then
      error("ccsim: no explosion resistance for " .. b.name .. "; give it in world.metaphysics.explosionResistance", 0)
    end
    return C.toInt(floor(tonumber(r) or 0))
  end

  local function shipsRaw(scope, flag)
    if scope > 2500 then return {} end
    local box = scopeBox(scope)
    local out = {}
    for _, s in ipairs(ships) do
      local mn, mx = s.min or {}, s.max or {}
      local x1, y1, z1 = tonumber(mn.x) or 0, tonumber(mn.y) or 0, tonumber(mn.z) or 0
      local x2, y2, z2 = tonumber(mx.x) or 0, tonumber(mx.y) or 0, tonumber(mx.z) or 0
      local cx, cy, cz = x1 + (x2 - x1) / 2, y1 + (y2 - y1) / 2, z1 + (z2 - z1) / 2
      if (not flag or canSeeSkyD(cx, cy, cz)) and contains(box, cx, cy, cz) then
        out[tostring(s.id)] = {
          id = s.id, slug = s.slug, dimension = s.dimension or ("minecraft:dimension:" .. dimension()),
          x = cx, y = cy, z = cz, max_x = x2, max_y = y2, max_z = z2, min_x = x1, min_y = y1, min_z = z1,
        }
      end
    end
    return out
  end

  function coord.getShips(scope) return shipsRaw(C.int(1, scope), true) end
  function coord.getShipsAll(scope) return shipsRaw(C.int(1, scope), false) end
  function coord.isOnShipEntity() return shipOf() ~= nil end
  function coord.getAbsoluteCoordinates() return { x = pos.x, y = pos.y, z = pos.z } end
  function coord.getSlug()
    local ship = shipOf()
    if ship then return ship.slug end
    return "NoSlug"
  end
  function coord.setSlug(name)
    name = C.str(1, name)
    local ship = shipOf()
    if ship then ship.slug = name core.save() end
  end

  local function playersRaw(scope, all)
    local box = scopeBox(scope)
    local result = {}
    for i, p in ipairs(players()) do
      if (p.dimension or dimension()) == dimension() and alive(p) and contains(box, p.x, p.y, p.z) then
        local flag = true
        if dimension() == "minecraft:overworld" and not all then flag = canSeeSkyD(p.x, p.y, p.z) end
        if flag then
          local uuid = p.uuid or ("00000000-0000-4000-8000-0001%08x"):format(i)
          local vx, vy, vz = viewVector(tonumber(p.xRot) or 0, tonumber(p.yHeadRot or p.yRot) or 0)
          result[uuid] = {
            x = p.x, y = p.y, z = p.z, name = p.name, uuid = uuid,
            eyeHeight = C.float(tonumber(p.eyeHeight) or 1.62), health = health(p), maxHealth = maxHealth(p),
            armor = armor(p), viewVector = { x = vx, y = vy, z = vz }, pose = p.pose or "STANDING",
            isPassenger = p.isPassenger == true,
          }
        end
      end
    end
    return result
  end

  function coord.getPlayers(scope) return playersRaw(C.int(1, scope), false) end
  function coord.getPlayersAll(scope) return playersRaw(C.int(1, scope), true) end

  --- the y of the highest block in a column that `counts`, or the bottom - 1
  local function topOf(x, z, counts)
    for y = math.max(ceiling, minY()), minY(), -1 do
      local b = blockAt(x, y, z)
      if counts(b) then return y end
    end
    return minY() - 1
  end

  function coord.getMapColor(x, z, x2, z2)
    x, z, x2, z2 = C.int(1, x), C.int(2, z), C.int(3, x2), C.int(4, z2)
    local out = {}
    for i = x, x2 do
      for j = z, z2 do
        -- Heightmap WORLD_SURFACE is the first free block above the surface; the colour is that block's
        local k = topOf(i, j, function(b) return not isAir(b) end) + 1
        local b = blockAt(i, k, j)
        local colour = isAir(b) and 0 or (gameData.mapColour(b.name, b.state) or 0)
        out[{ i, k, j }] = colour
      end
    end
    return out
  end

  local function mobsOf(test, scope)
    local box = scopeBox(scope)
    local out = {}
    for _, info in ipairs(allEntities()) do
      local e = info.e
      if info.living and not info.player and alive(e) and test(info) and contains(box, e.x, e.y, e.z) then
        local flag = true
        if dimension() == "minecraft:overworld" then flag = canSeeSkyD(e.x, e.y, e.z) end
        if flag then
          out[info.uuid] = {
            uuid = info.uuid, name = e.category and tostring(e.category):lower() or CATEGORY[info.id] or "misc",
            displayName = info.name, x = e.x, y = e.y, z = e.z,
            health = health(e), maxHealth = maxHealth(e), armor = armor(e),
          }
        end
      end
    end
    return out
  end

  function coord.getMonster(scope)
    return mobsOf(function(info)
      if info.e.monster ~= nil then return info.e.monster == true end
      return MONSTER[info.id] == true
    end, C.int(1, scope))
  end

  function coord.getMobs(scope)
    return mobsOf(function(info)
      if info.e.mob ~= nil then return info.e.mob == true end
      return not NOT_A_MOB[info.id]
    end, C.int(1, scope))
  end

  --- Heightmap MOTION_BLOCKING: blocks that stop movement, or hold a fluid
  local function blocksMotion(b) return rules.hasCollision(b) or rules.isLiquid(b) end

  function coord.scanTopography(x, z, x2, z2)
    x, z, x2, z2 = C.int(1, x), C.int(2, z), C.int(3, x2), C.int(4, z2)
    local minX, maxX = math.min(x, x2), math.max(x, x2)
    local minZ, maxZ = math.min(z, z2), math.max(z, z2)
    local results = {}
    if maxX - minX > 256 or maxZ - minZ > 256 then
      -- the empty answer goes out, and the scan carries on anyway
      os.queueEvent("ComputerScanTopographyDone", {})
    end
    -- Java's % keeps the sign: below zero the corner it works out is a chunk too far west/north
    local function jmod(a, b) return a - b * (a < 0 and -floor(-a / b) or floor(a / b)) end
    local sx = minX
    while sx < maxX do
      local sz = minZ
      while sz < maxZ do
        local chunkX, chunkZ = floor(sx / 16) * 16, floor(sz / 16) * 16
        local ax = sx - jmod(sx, 16)
        if ax < 0 then ax = ax - 16 end
        local az = sz - jmod(sz, 16)
        if az < 0 then az = az - 16 end
        for ix = 0, 15 do
          for iz = 0, 15 do
            local fx, fz = ax + ix, az + iz
            if fx < maxX and fz < maxZ then
              -- the chunk's own column ix, iz, labelled with the corner worked out above
              results[#results + 1] = { fx, topOf(chunkX + ix, chunkZ + iz, blocksMotion), fz }
            end
          end
        end
        sz = sz + 16
      end
      sx = sx + 16
    end
    os.queueEvent("ComputerScanTopographyDone", results)
  end

  local M = {
    globals = {
      crypto = crypto, cryptography = crypto,
      coord = coord, coordinate = coord,
    },
    handlers = {},
  }

  -- ===== sim commands =====

  --- ModEvents.onPlayerDeath: every computer hears it
  function M.handlers.metaPlayerDeath(cmd)
    if type(cmd.name) ~= "string" then return false, "name is needed" end
    local tags = {}
    for i, t in ipairs(type(cmd.killerTags) == "table" and cmd.killerTags or {}) do tags[i] = t end
    local result = { name = cmd.name, source = ("DamageSource (%s)"):format(cmd.source or "generic"), tags = tags }
    if type(cmd.killer) == "string" then result.killer = cmd.killer end
    os.queueEvent("player_death", result)
    return true
  end

  function M.handlers.metaSetPlayer(cmd)
    local p = cmd.player
    if type(p) ~= "table" or type(p.name) ~= "string" then return false, "player needs a name" end
    local list = players()
    for i, q in ipairs(list) do
      if q.name == p.name then
        if cmd.remove then table.remove(list, i) else list[i] = p end
        return true
      end
    end
    if not cmd.remove then list[#list + 1] = p end
    return true
  end

  function M.handlers.metaSetBlock(cmd)
    local x, y, z = tonumber(cmd.x), tonumber(cmd.y), tonumber(cmd.z)
    if not (x and y and z) then return false, "x, y and z are needed" end
    local w = world()
    if cmd.name == nil or gameData.id(cmd.name) == "minecraft:air" then
      w.set(x, y, z, nil)
    else
      w.set(x, y, z, w.newBlock({ name = cmd.name, state = cmd.state, explosionResistance = cmd.explosionResistance, solid = cmd.solid }))
      raise(y)
    end
    return true
  end

  function M.handlers.metaAddEntity(cmd)
    local e = cmd.entity
    if type(e) ~= "table" or not (e.x and e.y and e.z and (e.type or e.name)) then return false, "entity needs type, x, y and z" end
    local list = world().entities
    list[#list + 1] = e
    return true
  end

  function M.handlers.metaRemoveEntity(cmd)
    local list = world().entities
    for i = #list, 1, -1 do
      local e = list[i]
      if (cmd.uuid and e.uuid == cmd.uuid) or (cmd.type and (e.type or e.name) == cmd.type) then table.remove(list, i) end
    end
    return true
  end

  function M.handlers.metaSetShips(cmd)
    if type(cmd.ships) ~= "table" then return false, "ships must be a list" end
    ships = {}
    for i, s in ipairs(cmd.ships) do ships[i] = s end
    if cmd.computerShip ~= nil then cfg.computerShip = cmd.computerShip end
    if cmd.leaveShip then cfg.computerShip = nil end
    return true
  end

  function M.state()
    local slugs = {}
    for _, s in ipairs(ships) do slugs[tostring(s.id)] = s.slug end
    return { ships = slugs }
  end

  return M
end
