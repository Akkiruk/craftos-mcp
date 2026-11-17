-- ccsim cc-link: CC: Link 6.2.1 (Forge 1.20.1), the Link cores a player wears and the link_armor pocket upgrade.
--
-- Written from minecraftbossdj/CC-Link at b24e027 (9 Mar 2026, the commit the 6.2.1 jar was built from; the repository
-- has no tags) and checked against cclink-6.2.1-1.20.1.jar with javap: every string constant of the classes below is
-- the same. Files followed, relative to src/main/java/com/awesoft/cclink/:
--   registration/APIRegistry (which computer gets which global), item/linkCore/LinkAPI (`link` on a Link core),
--   item/linkCore/integrated/IntegratedLinkAPI (`link` on an Integrated Link core), block/LinkTurtle/TurtleLinkAPI
--   (`link_turtle`), peripherals/linkArmorManager/LinkArmorManagerPeripheral (`link_armor`),
--   upgrades/luaFunctions/* (the tables getUpgradeFunctions and getArmorFunctions hand out), libs/LuaConverter,
--   libs/RaycastingUtil, libs/ComputerLib (where the upgrade slots are read), libs/MiscLib.toEquipSlot,
--   libs/ModularArmorLib, libs/PacketCooldownManager, modularArmor/ModularArmorEnergy, events/ChatEvent,
--   hudoverlay/packets/HUDOverlayUpdatePacket (what the client does with an overlay packet), CCLinkConfig (defaults).
-- CC:Tweaked's side (argument checks, main-thread tasks, Java exceptions, nil for a nested MethodResult) follows
-- cc-tweaked v1.20.1-1.117.0, the version the mod is built against. docs/cc-link.md has every rule and what is not
-- simulated.
return function(core, host)
  local floor, abs, sqrt, sin, cos, atan2 = math.floor, math.abs, math.sqrt, math.sin, math.cos, math.atan2 or math.atan
  local cfgWorld = core.world.ccLink or {}
  local conf = cfgWorld.config or {}
  local CONFIG = {
    kineticLinkEnabled = conf.kineticLinkEnabled ~= false,               -- kineticLinkEnabled, default true
    kineticEnergyMultiplier = tonumber(conf.kineticEnergyMultiplier) or 5000,
    packetCooldownTicks = tonumber(conf.packetCooldownTicks) or 1,
    tier1MaxEnergy = tonumber(conf.tier1MaxEnergy) or 10000,
    tier2MaxEnergy = tonumber(conf.tier2MaxEnergy) or 50000,
    tier3MaxEnergy = tonumber(conf.tier3MaxEnergy) or 100000,
  }

  -- ===== Java and CC:Tweaked =====

  local TWO32, TWO31 = 4294967296, 2147483648
  local function i32(n)
    n = n % TWO32
    if n >= TWO31 then n = n - TWO32 end
    return n
  end
  local function trunc(d) if d >= 0 then return floor(d) end return -floor(-d) end

  --- (float) x: round to the nearest IEEE single
  local function f32(x)
    if x ~= x or x == math.huge or x == -math.huge or x == 0 then return x end
    local m, e = math.frexp(x)
    local bits = 24
    if e < -125 then bits = 24 - (-125 - e) end
    if bits < 1 then return 0 * x end
    local s = m * 2 ^ bits
    local r = floor(s + 0.5)
    if r - s == 0.5 and r % 2 == 1 then r = r - 1 end
    local out = r * 2 ^ (e - bits)
    if abs(out) > 3.4028234663852886e38 then return out > 0 and math.huge or -math.huge end
    return out
  end
  local PI_F = f32(math.pi)

  local function typeName(v) return v == nil and "nil" or type(v) end
  local function bad(i, expected, v)
    error(("bad argument #%d (%s expected, got %s)"):format(i, expected, typeName(v)), 0)
  end
  local function numType(v)
    if v ~= v then return "nan" elseif v == math.huge then return "inf" elseif v == -math.huge then return "-inf" end
    return "number"
  end
  -- IArguments (1.117.0): getString takes only strings, getInt truncates a finite number, getDouble any number.
  local function argString(i, v) if type(v) ~= "string" then bad(i, "string", v) end return v end
  local function argBool(i, v) if type(v) ~= "boolean" then bad(i, "boolean", v) end return v end
  local function argDouble(i, v) if type(v) ~= "number" then bad(i, "number", v) end return v end
  local function argInt(i, v)
    if type(v) ~= "number" then bad(i, "number", v) end
    if v ~= v or v == math.huge or v == -math.huge then
      error(("bad argument #%d (number expected, got %s)"):format(i, numType(v)), 0)
    end
    return i32(trunc(v))
  end

  --- An unchecked Java exception (not a LuaException): reported as "Java Exception Thrown: <class>: <message>".
  local JAVA = {}
  local function java(class, message)
    error(setmetatable({ text = class .. (message and (": " .. message) or "") }, JAVA), 0)
  end
  local function isJava(e) return getmetatable(e) == JAVA end
  -- The JVM's helpful NullPointerException text names obfuscated (SRG) methods; only the class is reproduced.
  local function npe() java("java.lang.NullPointerException") end

  --- A @LuaFunction(mainThread = true): arguments are read inside the task, which runs on the next server tick; any
  --- error comes back through task_complete and is raised at the caller (TaskCallback: new LuaException(message)).
  local function mainThread(fn)
    return function(...)
      local args = table.pack(...)
      local r = core.waitForServerTick(function() return fn(table.unpack(args, 1, args.n)) end)
      if not r[1] then
        local e = r[2]
        if isJava(e) then e = "Java Exception Thrown: " .. e.text end
        error(e, 2)
      end
      core.touch()
      return table.unpack(r, 2, r.n)
    end
  end

  --- An ILuaFunction from an upgrade table: runs at once on the computer thread. A LuaException is positioned at the
  --- caller; any other exception becomes LuaError("Java Exception Thrown: " + t, 0), with no position
  --- (ResultInterpreterFunction.invoke).
  local function luaFunction(fn)
    return function(...)
      local r = table.pack(pcall(fn, ...))
      if not r[1] then
        local e = r[2]
        if isJava(e) then error("Java Exception Thrown: " .. e.text, 0) end
        error(e, 2)
      end
      core.touch()
      return table.unpack(r, 2, r.n)
    end
  end

  -- ===== game data =====

  local gameData, gameItems, NBT
  local function data()
    if core.gameData then return core.gameData end
    gameData = gameData or dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)
    return gameData
  end
  local function itemsData()
    if core.turtle and core.turtle.items then return core.turtle.items end
    gameItems = gameItems or dofile("/rom/ccsim/turtle/items.lua")(data(), core.world.gameData)
    return gameItems
  end
  local function nbtHash(value)
    NBT = NBT or dofile("/rom/ccsim/turtle/nbt.lua")()
    if type(value) == "string" and NBT.isHash(value) and #value == 32 then return value end
    local ok, hash = pcall(NBT.hash, value)
    if ok then return hash end
    return NBT.md5(tostring(value))
  end

  local sharedWorld
  local function hasWorld(w) return type(w) == "table" and (w.blocks ~= nil or w.fills ~= nil or w.ground ~= nil) end
  --- The block at x, y, z (nil for air): the turtle's block world, else one read from world.blocks / fills / ground.
  local function blockAt(x, y, z)
    if core.turtle then return core.turtle.blockAt(x, y, z) end
    if not hasWorld(core.world) then return nil end
    if not sharedWorld then
      sharedWorld = dofile("/rom/ccsim/turtle/world.lua")(core, data())
      sharedWorld.load(core.world)
    end
    return sharedWorld.get(x, y, z)
  end
  local AIR = { ["minecraft:air"] = true, ["minecraft:cave_air"] = true, ["minecraft:void_air"] = true }
  local FLUIDS = { ["minecraft:water"] = true, ["minecraft:lava"] = true }
  local function solidAt(x, y, z)
    local b = blockAt(x, y, z)
    if not b or AIR[b.name] then return nil end
    return b
  end

  -- LuaConverter.tagsToList / ScannerUpgradeFunctions.tagsToList: "<registry>/<tag>"
  local function tagList(kind, id, fixture)
    local out = {}
    if type(fixture) == "table" then
      for i, t in ipairs(fixture) do out[i] = t end
      return out
    end
    local list = kind == "block" and data().blockTags(id) or data().itemTags(id)
    for i, t in ipairs(list) do out[i] = "minecraft:" .. kind .. "/" .. t end
    return out
  end

  -- ===== items =====

  local function copyTable(v)
    if type(v) ~= "table" then return v end
    local out = {}
    for k, x in pairs(v) do out[k] = copyTable(x) end
    return out
  end

  --- A fixture item ({ name, count?, nbt?, displayName?, modules?, energy?, damage? }) as the sim holds it, or nil.
  local function normItem(def)
    if type(def) == "string" then def = { name = def } end
    if type(def) ~= "table" or not def.name then return nil end
    local item = copyTable(def)
    item.name = data().id(def.name)
    item.count = tonumber(def.count) or 1
    if item.count <= 0 or AIR[item.name] then return nil end
    return item
  end
  local function maxStack(item)
    if not item then return 64 end
    return item.maxCount or itemsData().maxCount(item.name)
  end
  --- The item's NBT as NBTUtil.toLua shows it (a damageable item always carries Damage), or nil for none.
  local function nbtOf(item)
    local tag = type(item.nbt) == "table" and copyTable(item.nbt) or nil
    if itemsData().maxDamage(item.name) > 0 then
      tag = tag or {}
      if tag.Damage == nil then tag.Damage = item.damage or 0 end
    end
    return tag
  end
  local function sameTag(a, b)
    local ta, tb = nbtOf(a), nbtOf(b)
    if ta == nil or tb == nil then return ta == nil and tb == nil end
    return nbtHash(ta) == nbtHash(tb)
  end
  local function hoverName(item) return item.displayName or data().displayName(item.name) end

  --- VanillaDetailRegistries.ITEM_STACK.getBasicDetails (CC 1.117 ItemDetails.fillBasic): name, count, nbt hash
  local function basicDetails(item)
    if not item then return { name = "minecraft:air", count = 0 } end
    local d = { name = item.name, count = item.count }
    local tag = nbtOf(item)
    if type(item.nbt) == "string" then d.nbt = item.nbt elseif tag then d.nbt = nbtHash(tag) end
    return d
  end

  --- LuaConverter.stackToObject: tags, count, displayName ("[Name]", ItemStack.getDisplayName), maxStackSize, nbt
  --- (getOrCreateTag: an empty table for an item without one), name; {} for an empty stack.
  local function stackToObject(item)
    if not item then return {} end
    return {
      tags = tagList("item", item.name, item.tags),
      count = item.count,
      displayName = "[" .. hoverName(item) .. "]",
      maxStackSize = maxStack(item),
      nbt = nbtOf(item) or {},
      name = item.name,
    }
  end
  local function stackWithSlot(item, slot)
    if not item then return {} end
    local o = stackToObject(item)
    o.slot = slot + 1
    return o
  end

  -- Foods.java (Minecraft 1.20.1): nutrition and saturation modifier of every vanilla food item
  local FOODS = {
    apple = { 4, 0.3 }, baked_potato = { 5, 0.6 }, beef = { 3, 0.3 }, beetroot = { 1, 0.6 }, beetroot_soup = { 6, 0.6 },
    bread = { 5, 0.6 }, carrot = { 3, 0.6 }, chicken = { 2, 0.3 }, chorus_fruit = { 4, 0.3 }, cod = { 2, 0.1 },
    cooked_beef = { 8, 0.8 }, cooked_chicken = { 6, 0.6 }, cooked_cod = { 5, 0.6 }, cooked_mutton = { 6, 0.8 },
    cooked_porkchop = { 8, 0.8 }, cooked_rabbit = { 5, 0.6 }, cooked_salmon = { 6, 0.8 }, cookie = { 2, 0.1 },
    dried_kelp = { 1, 0.3 }, enchanted_golden_apple = { 4, 1.2 }, golden_apple = { 4, 1.2 }, golden_carrot = { 6, 1.2 },
    honey_bottle = { 6, 0.1 }, melon_slice = { 2, 0.3 }, mushroom_stew = { 6, 0.6 }, mutton = { 2, 0.3 },
    poisonous_potato = { 2, 0.3 }, porkchop = { 3, 0.3 }, potato = { 1, 0.3 }, pufferfish = { 1, 0.1 },
    pumpkin_pie = { 8, 0.3 }, rabbit = { 3, 0.3 }, rabbit_stew = { 10, 0.6 }, rotten_flesh = { 4, 0.1 },
    salmon = { 2, 0.1 }, spider_eye = { 2, 0.8 }, suspicious_stew = { 6, 0.6 }, sweet_berries = { 2, 0.1 },
    glow_berries = { 2, 0.1 }, tropical_fish = { 1, 0.1 },
  }
  local function foodOf(item)
    if not item then return nil end
    if type(item.food) == "table" then return { tonumber(item.food.nutrition) or 0, tonumber(item.food.saturation) or 0 } end
    if item.food == false then return nil end
    local path = item.name:match("^minecraft:(.+)$")
    return path and FOODS[path] or nil
  end

  -- ===== containers =====

  --- A Java Container over a slot table (0-based). `kind`: "inventory" (the player's Inventory: 36 main, 4 armor, 1
  --- off hand, out-of-range negative indexes throw like NonNullList.get), else a SimpleContainer (bounds-checked).
  local function container(slots, size, kind)
    local c = { slots = slots, size = size }
    local function check(i)
      if kind == "inventory" and i < 0 then
        java("java.lang.ArrayIndexOutOfBoundsException", ("Index %d out of bounds for length 36"):format(i))
      end
    end
    function c.get(i)
      check(i)
      if i < 0 or i >= size then return nil end
      return slots[i]
    end
    function c.set(i, item)
      check(i)
      if i < 0 or i >= size then return end
      if item and item.count <= 0 then item = nil end
      slots[i] = item
    end
    function c.hasAnyOf(id)
      for i = 0, size - 1 do if slots[i] and slots[i].name == id then return true end end
      return false
    end
    return c
  end

  local function loadSlots(def, size)
    local out = {}
    if type(def) == "table" then
      for key, v in pairs(def) do
        local i = tonumber(key)
        if i and i >= 0 and i < size then out[i] = normItem(v) end
      end
    end
    return out
  end
  local function listOf(def)
    -- an array of upgrade ids or items, in slot order
    local out = {}
    for _, v in ipairs(type(def) == "table" and def or {}) do
      local item = normItem(v)
      if item then out[#out + 1] = item end
    end
    return out
  end

  -- ===== the wearer =====

  local pdef = type(cfgWorld.player) == "table" and cfgWorld.player or {}
  if type(cfgWorld.player) == "string" then pdef = { name = cfgWorld.player } end
  local P = pdef.name and core.findPlayer(pdef.name) or (not pdef.name and core.players[1]) or nil
  if not P then P = core.addPlayer({ name = pdef.name or "Player" }) end
  for _, k in ipairs({ "x", "y", "z", "yaw", "pitch", "dimension", "health", "maxHealth", "uuid" }) do
    if pdef[k] ~= nil then P[k] = pdef[k] end
  end
  P.online = true
  local W = {
    food = tonumber(pdef.food) or 20,
    saturation = tonumber(pdef.saturation) or 5,
    air = tonumber(pdef.air) or 300,
    armorValue = tonumber(pdef.armorValue) or 0,
    speed = tonumber(pdef.speed) or f32(0.1), -- Player.aiStep: the movement speed attribute, 0.1 walking
    headYaw = tonumber(pdef.headYaw) or P.yaw,
    inWater = pdef.inWater == true, inPowderSnow = pdef.inPowderSnow == true,
    creative = pdef.creative == true, spectator = pdef.spectator == true,
    fallFlying = pdef.fallFlying == true,
    eyeHeight = tonumber(pdef.eyeHeight) or 1.62,
    motion = { x = 0, y = 0, z = 0 }, fallDistance = tonumber(pdef.fallDistance) or 0,
    swings = 0,
  }
  W.inventory = loadSlots(pdef.inventory, 41)
  W.ender = loadSlots(pdef.ender, 27)
  local INV = container(W.inventory, 41, "inventory")
  local ENDER = container(W.ender, 27, "simple")

  -- The Link core: "link", "link_command" (both LinkAPI), "integrated" (IntegratedLinkAPI), "turtle" (a Link
  -- Turtle: link_turtle), or "none" (no Link core worn: a pocket computer with only the link_armor upgrade).
  local kind = cfgWorld.core
  if kind == nil then kind = cfgWorld.player ~= nil and "link" or "none" end
  local KINDS = { link = true, link_command = true, integrated = true, turtle = true, none = true }
  if not KINDS[kind] then error("ccsim: ccLink.core must be link, link_command, integrated, turtle or none, not " .. tostring(kind), 0) end
  local upgradeSlots = {}
  for i, item in ipairs(listOf(cfgWorld.upgrades)) do upgradeSlots[i - 1] = item end
  local UPGRADE_SLOTS = math.max(tonumber(cfgWorld.upgradeSlots) or 8, #listOf(cfgWorld.upgrades))
  local linkInv = container(upgradeSlots, UPGRADE_SLOTS, "simple")

  --- ComputerLib.getContainerFromLinkHolder / getContainerFromIntegratedLinkHolder: the upgrade slots of the core
  --- the player wears, or nil (Java null) when there is none of that family.
  local function linkContainer(integrated)
    if integrated then return kind == "integrated" and linkInv or nil end
    if kind == "link" or kind == "link_command" then return linkInv end
    return nil
  end

  -- ===== world: weather, biome, entities =====

  local env = type(cfgWorld.world) == "table" and copyTable(cfgWorld.world) or {}
  local function biome()
    local b = type(env.biome) == "table" and env.biome or {}
    if type(env.biome) == "string" then b = { name = env.biome } end
    return {
      name = b.name or "minecraft:plains",
      canSnow = b.canSnow == true,
      canRain = b.canRain ~= false and b.canSnow ~= true,
      fogColor = tonumber(b.fogColor) or 12638463,
      -- Biome.getFoliageColor without an override reads the client's colour map: 0 on a dedicated server
      foliageColor = tonumber(b.foliageColor) or 0,
      precipitation = b.precipitation ~= false,
    }
  end

  local DIMS = {
    ["minecraft:player"] = { 0.6, 1.8 }, ["minecraft:zombie"] = { 0.6, 1.95 }, ["minecraft:skeleton"] = { 0.6, 1.99 },
    ["minecraft:creeper"] = { 0.6, 1.7 }, ["minecraft:spider"] = { 1.4, 0.9 }, ["minecraft:enderman"] = { 0.6, 2.9 },
    ["minecraft:cow"] = { 0.9, 1.4 }, ["minecraft:pig"] = { 0.9, 0.9 }, ["minecraft:sheep"] = { 0.9, 1.3 },
    ["minecraft:chicken"] = { 0.4, 0.7 }, ["minecraft:wolf"] = { 0.6, 0.85 }, ["minecraft:villager"] = { 0.6, 1.95 },
    ["minecraft:item"] = { 0.25, 0.25 }, ["minecraft:experience_orb"] = { 0.5, 0.5 }, ["minecraft:horse"] = { 1.3964844, 1.6 },
  }
  local ANIMALS = {}
  for _, n in ipairs({ "cow", "pig", "sheep", "chicken", "horse", "donkey", "mule", "skeleton_horse", "zombie_horse", "llama",
    "trader_llama", "rabbit", "wolf", "cat", "ocelot", "fox", "panda", "polar_bear", "bee", "turtle", "goat", "axolotl", "frog",
    "camel", "sniffer", "mooshroom", "hoglin", "strider", "parrot" }) do ANIMALS["minecraft:" .. n] = true end
  local NOT_LIVING = { ["minecraft:item"] = true, ["minecraft:experience_orb"] = true, ["minecraft:arrow"] = true,
    ["minecraft:boat"] = true, ["minecraft:minecart"] = true, ["minecraft:item_frame"] = true, ["minecraft:painting"] = true,
    ["minecraft:falling_block"] = true, ["minecraft:tnt"] = true, ["minecraft:snowball"] = true, ["minecraft:egg"] = true }
  local NOT_PICKABLE = { ["minecraft:item"] = true, ["minecraft:experience_orb"] = true, ["minecraft:arrow"] = true,
    ["minecraft:snowball"] = true, ["minecraft:egg"] = true, ["minecraft:painting"] = false }

  --- Every other entity in the wearer's dimension: online players, then world.entities, as the sim lists them.
  local function others()
    local out = {}
    for _, p in ipairs(core.players) do
      if p ~= P and p.online and (p.dimension or "minecraft:overworld") == (P.dimension or "minecraft:overworld") then
        out[#out + 1] = { type = "minecraft:player", player = p, x = p.x, y = p.y, z = p.z, name = p.name, uuid = p.uuid,
          yaw = p.yaw, pitch = p.pitch, health = p.health, maxHealth = p.maxHealth, tags = p.tags }
      end
    end
    for index, e in ipairs(core.world.entities or {}) do
      if (e.dimension or "minecraft:overworld") == (P.dimension or "minecraft:overworld") and e.x and e.y and e.z then
        e.__n = e.__n or index
        out[#out + 1] = e
      end
    end
    return out
  end
  local function entityId(e) return data().id(e.type or e.id or "minecraft:pig") end
  local function entityUuid(e)
    if e.uuid then return e.uuid end
    return ("00000000-0000-4000-9000-%012x"):format(e.__n or 0)
  end
  local function entityName(e)
    if e.player then return e.player.name end
    return e.name or data().displayName(entityId(e))
  end
  local function bbOf(e)
    local d = DIMS[entityId(e)] or { 0.6, 1.8 }
    local w, h = tonumber(e.width) or d[1], tonumber(e.height) or d[2]
    return { e.x - w / 2, e.y, e.z - w / 2, e.x + w / 2, e.y + h, e.z + w / 2 }
  end
  local function intersects(a, b)
    return a[1] < b[4] and a[4] > b[1] and a[2] < b[5] and a[5] > b[2] and a[3] < b[6] and a[6] > b[3]
  end

  --- LuaConverter.completeEntityToLua (itemInHand is air, so never "shareable")
  local function entityToLua(e)
    local d = { id = entityId(e), uuid = entityUuid(e), name = entityName(e), tags = copyTable(e.tags or {}) }
    local animal = e.animal
    if animal == nil then animal = ANIMALS[d.id] == true end
    if animal and not e.player then
      d.baby = e.baby == true
      d.inLove = e.inLove == true
      d.aggressive = e.aggressive == true
    end
    return d
  end

  -- ===== geometry =====

  local function onPos()
    -- Entity.getOnPos(): the block 0.2F below the feet
    return floor(P.x), floor(P.y - 0.20000000298023224), floor(P.z)
  end
  local function eye() return P.x, P.y + W.eyeHeight, P.z end
  -- Mth.sin / Mth.cos: a 65536-entry table of (float) Math.sin
  local TABLE_SCALE = f32(10430.378)
  local function msinIndex(i) return f32(sin(i * math.pi * 2 / 65536)) end
  local function msin(x) return msinIndex(i32(trunc(f32(x * TABLE_SCALE))) % 65536) end
  local function mcos(x) return msinIndex(i32(trunc(f32(f32(x * TABLE_SCALE) + 16384))) % 65536) end
  local DEG_F = f32(PI_F / 180)
  --- Entity.calculateViewVector(xRot, yRot)
  local function viewVector(pitch, yaw)
    local fp, fy = f32(f32(pitch) * DEG_F), f32(f32(-yaw) * DEG_F)
    local h, i, j, k = mcos(fy), msin(fy), mcos(fp), msin(fp)
    return f32(i * j), -k, f32(h * j)
  end

  local function sign(d) if d == 0 then return 0 elseif d > 0 then return 1 end return -1 end
  local function frac(d) return d - floor(d) end
  local function lerp(t, a, b) return a + t * (b - a) end

  --- BlockGetter.traverseBlocks: visit each block the segment crosses, in order, until `hit` returns something.
  local function traverse(fx, fy, fz, tx, ty, tz, hit)
    if fx == tx and fy == ty and fz == tz then return nil end
    local d, e, f = lerp(-1.0E-7, tx, fx), lerp(-1.0E-7, ty, fy), lerp(-1.0E-7, tz, fz)
    local g, h, i = lerp(-1.0E-7, fx, tx), lerp(-1.0E-7, fy, ty), lerp(-1.0E-7, fz, tz)
    local j, k, l = floor(g), floor(h), floor(i)
    local r0 = hit(j, k, l)
    if r0 ~= nil then return r0 end
    local m, n, o = d - g, e - h, f - i
    local p, q, r = sign(m), sign(n), sign(o)
    local BIG = 1.7976931348623157e308
    local s = p == 0 and BIG or p / m
    local t = q == 0 and BIG or q / n
    local u = r == 0 and BIG or r / o
    local v = s * (p > 0 and 1 - frac(g) or frac(g))
    local w = t * (q > 0 and 1 - frac(h) or frac(h))
    local x = u * (r > 0 and 1 - frac(i) or frac(i))
    while v <= 1 or w <= 1 or x <= 1 do
      if v < w then
        if v < x then j = j + p; v = v + s else l = l + r; x = x + u end
      elseif w < x then
        k = k + q; w = w + t
      else
        l = l + r; x = x + u
      end
      local res = hit(j, k, l)
      if res ~= nil then return res end
    end
    return nil
  end

  --- AABB.clip: where the segment enters the box, as a fraction of it (0 < t < 1), or nil.
  local function clipBox(box, fx, fy, fz, tx, ty, tz)
    local dx, dy, dz = tx - fx, ty - fy, tz - fz
    local best = 1
    local found = false
    local function face(begin, start, dA, sA, dB, sB, d, minA, maxA, minB, maxB)
      local t = (begin - start) / d
      local a, b = sA + t * dA, sB + t * dB
      if 0 < t and t < best and minA - 1.0E-7 < a and a < maxA + 1.0E-7 and minB - 1.0E-7 < b and b < maxB + 1.0E-7 then
        best, found = t, true
      end
    end
    if dx > 1.0E-7 then face(box[1], fx, dy, fy, dz, fz, dx, box[2], box[5], box[3], box[6])
    elseif dx < -1.0E-7 then face(box[4], fx, dy, fy, dz, fz, dx, box[2], box[5], box[3], box[6]) end
    if dy > 1.0E-7 then face(box[2], fy, dx, fx, dz, fz, dy, box[1], box[4], box[3], box[6])
    elseif dy < -1.0E-7 then face(box[5], fy, dx, fx, dz, fz, dy, box[1], box[4], box[3], box[6]) end
    if dz > 1.0E-7 then face(box[3], fz, dx, fx, dy, fy, dz, box[1], box[4], box[2], box[5])
    elseif dz < -1.0E-7 then face(box[6], fz, dx, fx, dy, fy, dz, box[1], box[4], box[2], box[5]) end
    if not found then return nil end
    return best
  end

  --- Level.clip with every block a full cube (its outline and collision shape), fluids as full blocks when `fluids`.
  --- Returns the block position and the hit point, or nil.
  local function clipBlocks(fx, fy, fz, tx, ty, tz, fluids)
    return traverse(fx, fy, fz, tx, ty, tz, function(x, y, z)
      local b = solidAt(x, y, z)
      if not b then return nil end
      if FLUIDS[b.name] and not fluids then return nil end
      local dx, dy, dz = tx - fx, ty - fy, tz - fz
      if dx * dx + dy * dy + dz * dz < 1.0E-7 then return nil end
      -- VoxelShape.clip: a start inside the shape hits at once, 0.001 along the ray
      local ix, iy, iz = fx + dx * 0.001, fy + dy * 0.001, fz + dz * 0.001
      if ix >= x and ix <= x + 1 and iy >= y and iy <= y + 1 and iz >= z and iz <= z + 1 then
        return { x = x, y = y, z = z, block = b, hx = ix, hy = iy, hz = iz }
      end
      local t = clipBox({ x, y, z, x + 1, y + 1, z + 1 }, fx, fy, fz, tx, ty, tz)
      if not t then return nil end
      return { x = x, y = y, z = z, block = b, hx = fx + dx * t, hy = fy + dy * t, hz = fz + dz * t }
    end)
  end

  local function blockInfo(b, x, y, z)
    return {
      id = b.name,
      name = "[" .. data().displayName(b.name) .. "]", -- new ItemStack(block).getDisplayName()
      x = x, y = y, z = z,
    }
  end

  --- RaycastingUtil.raycastEntity: the nearest pickable entity whose box (grown by 0.3) the look ray crosses, the
  --- ray stopped at the first colliding block.
  local function raycastEntity(distance)
    local sx, sy, sz = eye()
    local vx, vy, vz = viewVector(P.pitch or 0, P.yaw or 0)
    local ex, ey, ez = sx + vx * distance, sy + vy * distance, sz + vz * distance
    local hit = clipBlocks(sx, sy, sz, ex, ey, ez, false)
    if hit then
      local hd = sqrt((hit.hx - sx) ^ 2 + (hit.hy - sy) ^ 2 + (hit.hz - sz) ^ 2)
      if hd < distance then ex, ey, ez = hit.hx, hit.hy, hit.hz end
    end
    local area = { math.min(sx, ex) - 1, math.min(sy, ey) - 1, math.min(sz, ez) - 1, math.max(sx, ex) + 1, math.max(sy, ey) + 1, math.max(sz, ez) + 1 }
    local closest, closestDistance = nil, distance
    for _, e in ipairs(others()) do
      local bb = bbOf(e)
      local pickable = e.pickable
      if pickable == nil then pickable = not NOT_PICKABLE[entityId(e)] and not (e.player and e.player.spectator) end
      if pickable and intersects(bb, area) then
        local grown = { bb[1] - 0.3, bb[2] - 0.3, bb[3] - 0.3, bb[4] + 0.3, bb[5] + 0.3, bb[6] + 0.3 }
        local t = clipBox(grown, sx, sy, sz, ex, ey, ez)
        if t then
          local px, py, pz = sx + (ex - sx) * t, sy + (ey - sy) * t, sz + (ez - sz) * t
          local d = sqrt((px - sx) ^ 2 + (py - sy) ^ 2 + (pz - sz) ^ 2)
          if d < closestDistance then closest, closestDistance = e, d end
        end
      end
    end
    return closest
  end

  local function entityInfo(e, floored)
    local info = { id = entityId(e), uuid = entityUuid(e) }
    info.dimension = P.dimension or "minecraft:overworld"
    if floored then
      info.x, info.y, info.z = floor(e.x), floor(e.y), floor(e.z)
    else
      info.x, info.y, info.z = e.x, e.y, e.z
    end
    info.yaw = f32(e.yaw or 0)
    info.pitch = f32(e.pitch or 0)
    local living = e.living
    if living == nil then living = not NOT_LIVING[info.id] end
    if living then
      info.health = f32(e.health or 20)
      info.maxHealth = f32(e.maxHealth or 20)
      info.air = e.air or 300
      info.maxAir = e.maxAir or 300
      info.armor = e.armor or 0
      info.speed = f32(e.speed or (e.player and 0.1 or 0))
      info.isInPowderedSnow = e.inPowderSnow == true
      if e.player then
        info.hunger = e.food or 20
        info.saturation = f32(e.saturation or 5)
        info.isHungry = (e.food or 20) < 20
        info.creative = e.player.creative == true or e.creative == true
        info.spectator = e.player.spectator == true or e.spectator == true
      end
    end
    info.name = entityName(e)
    return info
  end

  --- Entity.lookAt(EYES, target): yaw and pitch from the eyes to the point
  local function lookAtPoint(x, y, z)
    local ex, ey, ez = eye()
    local dx, dy, dz = x - ex, y - ey, z - ez
    local horiz = sqrt(dx * dx + dz * dz)
    local function wrap(deg) -- Mth.wrapDegrees(float): Java's % keeps the dividend's sign
      local d = f32(math.fmod(deg, 360))
      if d >= 180 then d = f32(d - 360) end
      if d < -180 then d = f32(d + 360) end
      return d
    end
    P.pitch = wrap(f32(-(atan2(dy, horiz) * 57.2957763671875)))
    P.yaw = wrap(f32(f32(atan2(dz, dx) * 57.2957763671875) - 90))
    W.headYaw = P.yaw
  end

  -- ===== the upgrade tables (upgrades/luaFunctions) =====

  local scannerLast, sensorLast = {}, {}   -- per computer id: the static lastCalledMap of each class
  local packetLast = {}                    -- PacketCooldownManager, per player uuid
  local hud = { text = {}, rightbound = {}, item = {}, rect = {} }
  local packets = {}                       -- every overlay packet sent, newest last (state.json keeps the last 20)
  local function nowMs() return os.epoch("utc") % 2147483647 end
  local function remaining(map, id)
    local elapsed = nowMs() - (map[id] or 0)
    if elapsed < 0 then elapsed = elapsed + 2147483647 end
    return math.max(0, 2000 - elapsed)
  end
  local computerId = os.getComputerID()

  --- UpgradeFunctionsBase.checkUpgrade: the upgrade must sit in the Link core's slots (the Link family's, or the
  --- Integrated family's). No such core worn: getLinkInventory() is null and hasAnyOf throws.
  local function checker(upgrade, integrated)
    return function()
      local c = linkContainer(integrated)
      if not c then npe() end
      return c.hasAnyOf(upgrade)
    end
  end
  local NOT = "Upgrade not equipped!"

  local function scannerFunctions(integrated)
    local has = checker("cclink:scanner_upgrade", integrated)
    return {
      scan = luaFunction(function(r)
        if not has() then return false, NOT end
        if remaining(scannerLast, computerId) > 0 then return nil, "On cooldown!" end
        scannerLast[computerId] = nowMs()
        if argInt(1, r) > 8 then return false, "Cannot be bigger than 8 block radius!" end
        local radius = argInt(1, r)
        local cx, cy, cz = onPos()
        local out = {}
        for ox = cx - radius, cx + radius do
          for oy = cy - radius, cy + radius do
            for oz = cz - radius, cz + radius do
              local b = solidAt(ox, oy, oz)
              if b then
                local d = { x = ox - cx, y = oy - cy, z = oz - cz, name = b.name, tags = tagList("block", b.name, b.def and b.def.tags) }
                local st, props = b.state or {}, data().blockProperties(b.name) or {}
                local function values(p) return props[p] and table.concat(props[p], ",") or nil end
                if st.facing and values("facing") == "north,south,west,east" then d.direction = st.facing end
                if st.vertical_direction then d.direction_vertical = st.vertical_direction end
                if st.half and (st.half == "top" or st.half == "bottom") then d.half = st.half end
                if st.axis and values("axis") == "x,y,z" then d.axis = st.axis end
                if st.powered ~= nil then d.powered = st.powered == "true" or st.powered == true end
                if st.power ~= nil then d.powerlvl = tonumber(st.power) end
                out[#out + 1] = d
              end
            end
          end
        end
        return out
      end),
      getOperationCooldown = luaFunction(function()
        if not has() then return false, NOT end
        return remaining(scannerLast, computerId)
      end),
    }
  end

  local function sensorFunctions(integrated)
    local has = checker("cclink:sensor_upgrade", integrated)
    return {
      sense = luaFunction(function(r)
        if not has() then return false, NOT end
        if remaining(sensorLast, computerId) > 0 then return nil, "On cooldown!" end
        sensorLast[computerId] = nowMs()
        if argInt(1, r) > 16 then return false, "Cannot be bigger than 16 block radius!" end
        local radius = argInt(1, r)
        local x, y, z = onPos()
        -- new AABB(...) keeps min below max, so a negative radius reads like a positive one
        local box = { math.min(x - radius, x + radius), math.min(y - radius, y + radius), math.min(z - radius, z + radius),
          math.max(x - radius, x + radius), math.max(y - radius, y + radius), math.max(z - radius, z + radius) }
        local out = {}
        for _, e in ipairs(others()) do
          if intersects(bbOf(e), box) then out[#out + 1] = entityToLua(e) end
        end
        return out
      end),
      getOperationCooldown = luaFunction(function()
        if not has() then return false, NOT end
        return remaining(sensorLast, computerId)
      end),
    }
  end

  local function introspectionFunctions(integrated)
    local has = checker("cclink:introspection_upgrade", integrated)
    local function which(s)
      if s:lower() == "inv" then return INV end
      if s:lower() == "ender" then return ENDER end
      return nil
    end
    local function moveItemTo(from, to, fromSlot, limit, toSlot)
      local fi, ti = math.max(0, fromSlot - 1), math.max(0, toSlot - 1)
      local fromItem, toItem = from.get(fi), to.get(ti)
      if not fromItem then return false, "From slot is empty!" end
      if not toItem then
        if fromItem.count < limit then return false, "From slot has too few items!" end
        local moved = copyTable(fromItem)
        moved.count = limit
        fromItem.count = fromItem.count - limit
        from.set(fi, fromItem.count > 0 and fromItem or nil)
        to.set(ti, moved.count > 0 and moved or nil)
        return true, limit
      end
      if toItem.name ~= fromItem.name then return false, "To slot doesn't contain the same item!" end
      if not sameTag(toItem, fromItem) then return false, "Both items' NBT do not match." end
      local amount = math.min(math.min(limit, fromItem.count), maxStack(toItem) - toItem.count)
      fromItem.count = fromItem.count - amount
      toItem.count = toItem.count + amount
      from.set(fi, fromItem.count > 0 and fromItem or nil)
      to.set(ti, toItem.count > 0 and toItem or nil)
      return true, amount
    end
    return {
      list = luaFunction(function(a)
        if not has() then return false, NOT end
        local c = which(argString(1, a))
        if not c then return false, 'Invalid Inventory type! Please use "inv" or "ender"!' end
        local out = {}
        for i = 0, c.size - 1 do
          if c.slots[i] then out[i + 1] = basicDetails(c.slots[i]) end
        end
        return out
      end),
      moveItems = luaFunction(function(a, b, c3, d, e)
        if not has() then return false, NOT end
        local from, to = which(argString(1, a)), which(argString(2, b))
        if not from or not to then return false, 'Invalid Inventories! Please use "inv" or "ender"!' end
        local fromSlot, limit, toSlot = argInt(3, c3), argInt(4, d), argInt(5, e)
        moveItemTo(from, to, fromSlot, limit, toSlot)
        -- MethodResult.of(result) with a MethodResult inside: CC converts that object to nil
        return nil
      end),
      getItemDetail = luaFunction(function(s, inv)
        if not has() then return false, NOT end
        local c = which(argString(2, inv))
        if not c then return false, 'Invalid Inventory type! Please use "inv" or "ender"!' end
        local slot = math.max(0, math.min(c.size, argInt(1, s) - 1))
        return basicDetails(c.get(slot))
      end),
      getItemLimit = luaFunction(function(s, inv)
        if not has() then return false, NOT end
        local c = which(argString(2, inv))
        if not c then return false, 'Invalid Inventory type! Please use "inv" or "ender"!' end
        local slot = math.max(0, math.min(c.size, argInt(1, s) - 1))
        return maxStack(c.get(slot))
      end),
      size = luaFunction(function(a)
        if not has() then return false, NOT end
        local c = which(argString(1, a))
        if not c then return false, "Invalid Inventory type! Please use 'inv', 'ender' or 'curios'!" end
        return c.size
      end),
    }
  end

  local function worldFunctions(integrated)
    local has = checker("cclink:world_upgrade", integrated)
    return {
      getWeather = luaFunction(function()
        if not has() then return false, NOT end
        -- Level.isRainingAt(getOnPos()): raining, sky light at that block (env.canSeeSky), a biome that rains
        local b = biome()
        if env.raining == true and env.canSeeSky == true and b.precipitation and b.canRain then
          if env.thundering == true then return "thundering" end
          return "raining"
        end
        return "clear"
      end),
      getDimension = luaFunction(function()
        if not has() then return false, NOT end
        return P.dimension or "minecraft:overworld"
      end),
      getBiome = luaFunction(function()
        if not has() then return false, NOT end
        local b = biome()
        return { name = b.name, canSnow = b.canSnow, canRain = b.canRain, fogColor = b.fogColor, foliageColor = b.foliageColor }
      end),
      canSeeSky = luaFunction(function()
        if not has() then return false, NOT end
        return env.canSeeSky == true
      end),
      isDay = luaFunction(function()
        if not has() then return false, NOT end
        return env.day ~= false
      end),
    }
  end

  local function applyPacket(entries)
    for _, e in ipairs(entries) do
      local map = hud[e.kind]
      if e.action == "removeAll" then
        hud[e.kind] = {}
      elseif e.action == "remove" then
        map[e.id] = nil
      else
        map[e.id] = copyTable(e.element)
      end
    end
  end

  local function overlayFunctions(integrated)
    local has = checker("cclink:overlay_upgrade", integrated)
    local entries = {} -- never cleared: every send sends them all again
    local function add(kind, action, elementId, element)
      entries[#entries + 1] = { kind = kind, action = action, id = elementId, element = element }
      return true
    end
    local function textAdd(kind)
      return luaFunction(function(a, b, c3, d, e, f)
        if not has() then return false, NOT end
        local el = { id = argString(1, a) }
        el.text, el.x, el.y, el.color, el.scale = argString(2, b), argInt(3, c3), argInt(4, d), argInt(5, e), f32(argDouble(6, f))
        return add(kind, "add", el.id, { text = el.text, x = el.x, y = el.y, color = el.color, scale = el.scale })
      end)
    end
    local function remove(kind)
      return luaFunction(function(a)
        if not has() then return false, NOT end
        return add(kind, "remove", argString(1, a))
      end)
    end
    local function clear(kind)
      return luaFunction(function()
        if not has() then return false, NOT end
        return add(kind, "removeAll")
      end)
    end
    return {
      addOrUpdateTextElement = textAdd("text"),
      removeTextElement = remove("text"),
      clearText = clear("text"),
      addOrUpdateRightboundTextElement = textAdd("rightbound"),
      removeRightboundTextElement = remove("rightbound"),
      clearRightboundText = clear("rightbound"),
      addOrUpdateRectElement = luaFunction(function(a, b, c3, d, e, f, g)
        if not has() then return false, NOT end
        local key = argString(1, a)
        local x1, y1, x2, y2, color, alpha = argInt(2, b), argInt(3, c3), argInt(4, d), argInt(5, e), argInt(6, f), argInt(7, g)
        return add("rect", "add", key, { x1 = x1, y1 = y1, x2 = x2, y2 = y2, color = color, transparency = alpha })
      end),
      removeRectElement = remove("rect"),
      clearRect = clear("rect"),
      addOrUpdateItemElement = luaFunction(function(a, b, c3, d)
        if not has() then return false, NOT end
        local key = argString(1, a)
        local item, x, y = argString(2, b), argInt(3, c3), argInt(4, d)
        return add("item", "add", key, { item = item, x = x, y = y })
      end),
      removeItemElement = remove("item"),
      clearItem = clear("item"),
      clearAll = luaFunction(function()
        if not has() then return false, NOT end
        add("text", "removeAll"); add("rightbound", "removeAll"); add("rect", "removeAll"); add("item", "removeAll")
        return true
      end),
      send = luaFunction(function()
        if not has() then return false, NOT end
        local cooldown = CONFIG.packetCooldownTicks
        if cooldown > 0 then
          local now = os.epoch("utc")
          if now - (packetLast[P.uuid] or 0) < cooldown * 50 then return false, "On cooldown!" end
          packetLast[P.uuid] = now
        end
        local copy = copyTable(entries)
        packets[#packets + 1] = { entries = #copy, time = os.epoch("utc") }
        applyPacket(copy)
        return true
      end),
    }
  end

  --- KineticUpgradeFunctions.launch (static): add the push to the player's motion
  local function launch(yaw, pitch, power)
    local a, b = f32(f32(yaw / 180) * PI_F), f32(f32(pitch / 180) * PI_F)
    local mx = f32(-sin(a) * cos(b))
    local mz = f32(cos(a) * cos(b))
    local my = f32(-sin(b))
    power = f32(power / f32(sqrt(f32(f32(f32(mx * mx) + f32(my * my)) + f32(mz * mz)))))
    if W.fallFlying then power = f32(power * f32(0.4)) end
    W.motion.x = W.motion.x + f32(mx * power)
    W.motion.y = W.motion.y + f32(my * power) * 0.5
    W.motion.z = W.motion.z + f32(mz * power)
    if my > 0 then
      local vy = W.motion.y
      if vy > 0 then W.fallDistance = 0 elseif vy > -2 then W.fallDistance = f32(W.fallDistance * (vy / -2)) end
    end
  end

  local function kineticFunctions(isLink, integrated)
    local has = checker("cclink:kinetic_upgrade", integrated)
    return {
      launch = luaFunction(function(yaw, pitch, pow)
        if not has() then return false, NOT end
        local legs
        if not isLink then
          local item = INV.get(37)
          if item and item.name == "cclink:link_leggings" then legs = item end
          if not legs then
            -- `return null` from an ILuaFunction: CC calls getCallback() on it outside its try block
            error("ccsim: not emulated: CC: Link's kinetic launch returns null here (no modular leggings worn)", 0)
          end
        end
        local power = f32(argDouble(3, pow))
        local canRun = isLink
        if not isLink then
          local amount = i32(trunc(f32(power * f32(CONFIG.kineticEnergyMultiplier))))
          local stored = tonumber(legs.energy) or 0
          if stored >= amount then
            legs.energy = stored - math.min(stored, amount) -- ModularArmorEnergy.extractEnergy
            canRun = true
          end
        end
        if power <= 4 and canRun then
          launch(f32(argDouble(1, yaw)), f32(argDouble(2, pitch)), f32(argDouble(3, pow)))
          return true
        end
        if power > 4 then return false, "Power cannot be above 4!" end
        return false, "Not Enough Energy!"
      end),
    }
  end

  local function online(name)
    for _, p in ipairs(core.players) do
      if p.online and p.name:lower() == name:lower() then return p end
    end
    return nil
  end
  local function bracket(s, i)
    if #s < i then java("java.lang.StringIndexOutOfBoundsException", "String index out of range: " .. (i - 1)) end
    return s:sub(i, i)
  end

  local function chattyFunctions(integrated)
    local has = checker("cclink:chatty_upgrade", integrated)
    return {
      sendMessage = luaFunction(function(a, b, c3)
        if not has() then return false, NOT end
        local msg, username, brackets = argString(1, a), argString(2, b), argString(3, c3)
        for _, p in ipairs(core.players) do
          if p.online then
            local text = bracket(brackets, 1) .. username .. bracket(brackets, 2) .. " " .. msg
            core.say(p, text, { kind = "cclink", from = P.name })
          end
        end
        return true
      end),
      sendMessageToPlayer = luaFunction(function(a, b, c3, d)
        if not has() then return false, NOT end
        local msg, plr, username, brackets = argString(1, a), argString(2, b), argString(3, c3), argString(4, d)
        local target = online(plr)
        if not target then return false, "Player not online!" end
        core.say(target, bracket(brackets, 1) .. username .. bracket(brackets, 2) .. " " .. msg, { kind = "cclink", from = P.name })
        return true
      end),
    }
  end

  -- ===== a ResourceLocation, as BuiltInRegistries.ITEM.get(new ResourceLocation(id)) reads it =====

  local function resourceLocation(s)
    local ns, path
    local i = s:find(":", 1, true)
    if i then
      path = s:sub(i + 1)
      ns = i > 1 and s:sub(1, i - 1) or "minecraft"
    else
      ns, path = "minecraft", s
    end
    if ns:find("[^a-z0-9_.%-]") then
      java("net.minecraft.ResourceLocationException", "Non [a-z0-9_.-] character in namespace of location: " .. ns .. ":" .. path)
    end
    if path:find("[^a-z0-9/._%-]") then
      java("net.minecraft.ResourceLocationException", "Non [a-z0-9/._-] character in path of location: " .. ns .. ":" .. path)
    end
    return ns .. ":" .. path
  end

  -- ===== the link API (LinkAPI and IntegratedLinkAPI) =====

  local function upgradeList(c)
    local out = {}
    for i = 0, c.size - 1 do if c.slots[i] then out[#out + 1] = c.slots[i].name end end
    return out
  end

  local function linkApi(integrated)
    local reach = integrated and 10 or 5
    local api = {}
    local function inv() return linkContainer(integrated) end

    api.listUpgrades = mainThread(function() return true, upgradeList(inv()) end)
    api.hasUpgrade = mainThread(function(s)
      local rl = resourceLocation(argString(1, s))
      return inv().hasAnyOf(rl)
    end)
    api.getUpgradeFunctions = mainThread(function()
      local c, out = inv(), {}
      if c.hasAnyOf("cclink:scanner_upgrade") then out.scanner = scannerFunctions(integrated) end
      if c.hasAnyOf("cclink:sensor_upgrade") then out.sensor = sensorFunctions(integrated) end
      if c.hasAnyOf("cclink:introspection_upgrade") then out.introspection = introspectionFunctions(integrated) end
      if c.hasAnyOf("cclink:world_upgrade") then out.world = worldFunctions(integrated) end
      if c.hasAnyOf("cclink:overlay_upgrade") then out.overlay = overlayFunctions(integrated) end
      if CONFIG.kineticLinkEnabled and c.hasAnyOf("cclink:kinetic_upgrade") then out.kinetic = kineticFunctions(true, integrated) end
      if c.hasAnyOf("cclink:chatty_upgrade") then out.chatty = chattyFunctions(integrated) end
      return out
    end)
    api.getInfo = mainThread(function()
      local info = { name = P.name }
      if integrated then info.x, info.y, info.z = floor(P.x), floor(P.y), floor(P.z) end
      info.dimension = P.dimension or "minecraft:overworld"
      info.health = f32(P.health or 20)
      info.hunger = W.food
      info.saturation = f32(W.saturation)
      info.air = W.air
      info.armor = W.armorValue
      info.speed = f32(W.speed)
      info.yaw = f32(P.yaw or 0)
      info.pitch = f32(P.pitch or 0)
      info.isInPowderedSnow = W.inPowderSnow
      info.isInWater = W.inWater
      info.isHungry = W.food < 20
      return info
    end)
    api.swingMainHand = mainThread(function()
      W.swings = W.swings + 1
      return true
    end)
    api.raycastBlock = mainThread(function(r, fluids)
      argDouble(1, r)
      fluids = argBool(2, fluids)
      -- the reach is clamped and then not used: Player.pick(5.0, 0, hitFluids)
      local sx, sy, sz = eye()
      local vx, vy, vz = viewVector(P.pitch or 0, P.yaw or 0)
      local hit = clipBlocks(sx, sy, sz, sx + vx * 5, sy + vy * 5, sz + vz * 5, fluids)
      if not hit then return {} end
      return blockInfo(hit.block, hit.x, hit.y, hit.z)
    end)
    api.raycastEntity = mainThread(function(r)
      local distance = math.min(reach, math.max(1, argDouble(1, r)))
      local e = raycastEntity(distance)
      if not e then return {} end
      return entityInfo(e, not integrated)
    end)
    api.consume = mainThread(function(s)
      local slot = argInt(1, s) - 1
      local item = INV.get(slot)
      local food = foodOf(item)
      if not food then return false, "Item isnt edible!" end
      if W.food >= 20 then return false, "Player isnt hungry!" end
      -- FoodData.eat, then LivingEntity.eat takes one unless the player is in creative
      local nutrition, mod = food[1], food[2]
      W.food = math.min(W.food + nutrition, 20)
      W.saturation = math.min(f32(W.saturation + f32(f32(nutrition * f32(mod)) * 2)), W.food)
      if not W.creative then
        item.count = item.count - 1
        INV.set(slot, item.count > 0 and item or nil)
      end
      return true
    end)
    api.lookAtBlock = mainThread(function(x, y, z)
      lookAtPoint(argDouble(1, x), argDouble(2, y), argDouble(3, z))
      return true
    end)
    api.lookAt = mainThread(function(x, y)
      x, y = argDouble(1, x), argDouble(2, y)
      local fx, fy = f32(x), f32(y)
      if fx == fx and fx ~= math.huge and fx ~= -math.huge then P.pitch = fx end -- Entity.setXRot ignores non-finite
      W.headYaw = fy -- setYHeadRot: getInfo's yaw (getViewYRot) does not change
      return true
    end)
    if not integrated then
      api.list = mainThread(function()
        local out = {}
        for i = 0, 40 do out[#out + 1] = stackWithSlot(INV.get(i), i) end
        return out
      end)
      api.getSlot = mainThread(function(s)
        return stackToObject(INV.get(argInt(1, s) - 1))
      end)
      api.moveItem = mainThread(function(a, b, c3)
        local fromSlot, count, toSlot = argInt(1, a) - 1, argInt(2, b), argInt(3, c3) - 1
        if count <= 0 then error("Count cant be below zero!", 0) end
        local from, to = INV.get(fromSlot), INV.get(toSlot)
        if not from then return false end -- Inventory.contains(EMPTY)
        if from.count < count then return false end
        if not to then
          local moved = copyTable(from)
          moved.count = count
          INV.set(toSlot, moved)
          from.count = from.count - count
          if from.count <= 0 then INV.set(fromSlot, nil) end
          return true
        elseif to.name == from.name then
          if to.count + count > maxStack(to) then error("Cannot be above max stack size!", 0) end
          to.count = to.count + count
          from.count = from.count - count
          if from.count <= 0 then INV.set(fromSlot, nil) end
          return true
        end
        return false
      end)
    end
    return api
  end

  -- ===== link_turtle (TurtleLinkAPI) =====

  local DIRS = { north = { 0, 0, -1 }, south = { 0, 0, 1 }, east = { 1, 0, 0 }, west = { -1, 0, 0 }, up = { 0, 1, 0 }, down = { 0, -1, 0 } }
  local function turtleApi()
    local function brain()
      if not core.turtle then error("Turtle isn't present", 0) end
      return core.turtle
    end
    local function raycast(r, dirName)
      local reach = math.min(5, math.max(1, argDouble(1, r)))
      local t = brain()
      local pos = core.position
      local d = DIRS[dirName or t.state.facing]
      local sx, sy, sz = pos.x + 0.5 + d[1] * 0.5, pos.y + 0.5 + d[2] * 0.5, pos.z + 0.5 + d[3] * 0.5
      local ex, ey, ez = sx + d[1] * reach, sy + d[2] * reach, sz + d[3] * reach
      local hit = clipBlocks(sx, sy, sz, ex, ey, ez, false)
      if not hit then return {} end
      local dx, dy, dz = hit.x - pos.x, hit.y - pos.y, hit.z - pos.z
      return { id = hit.block.name, x = hit.x, y = hit.y, z = hit.z, distance = sqrt(dx * dx + dy * dy + dz * dz) }
    end
    return {
      raycast = mainThread(function(r) return raycast(r) end),
      raycastUp = mainThread(function(r) return raycast(r, "up") end),
      raycastDown = mainThread(function(r) return raycast(r, "down") end),
      list = mainThread(function()
        local t = brain()
        local out = {}
        for i = 1, 16 do
          local item = t.state.slots[i]
          out[i] = stackWithSlot(item and normItem(item) or nil, i - 1)
        end
        return out
      end),
      getDirection = mainThread(function() return brain().state.facing end),
    }
  end

  if kind == "link" or kind == "link_command" then
    _G.link = linkApi(false)
  elseif kind == "integrated" then
    _G.link = linkApi(true)
  elseif kind == "turtle" then
    if type(core.world.turtle) ~= "table" then error("ccsim: ccLink.core \"turtle\" needs world.turtle (a Link Turtle)", 0) end
    _G.link_turtle = turtleApi()
  end

  -- ===== link_armor (LinkArmorManagerPeripheral, the link_armor_pocket upgrade) =====

  local ARMOR = { helmet = 39, chestplate = 38, leggings = 37, boots = 36 }
  local MODULAR = { [39] = "cclink:link_helmet", [38] = "cclink:link_chestplate", [37] = "cclink:link_leggings", [36] = "cclink:link_boots" }

  --- ModularArmorLib.getCombinedArmorModules: the modules of every modular piece, feet first (getArmorSlots order)
  local function armorModules()
    local out = {}
    for slot = 36, 39 do
      local item = INV.get(slot)
      if item and item.name == MODULAR[slot] then
        for _, m in ipairs(listOf(item.modules)) do out[#out + 1] = m end
      end
    end
    return out
  end
  local function maxEnergy(item)
    local bonus = 0
    for _, m in ipairs(listOf(item.modules)) do
      if m.name == "cclink:battery_upgrade_tier1" then bonus = bonus + CONFIG.tier1MaxEnergy end
      if m.name == "cclink:battery_upgrade_tier2" then bonus = bonus + CONFIG.tier2MaxEnergy end
      if m.name == "cclink:battery_upgrade_tier3" then bonus = bonus + CONFIG.tier3MaxEnergy end
    end
    return 100 + bonus
  end

  local function armorPeripheral()
    local function hasModule(rl)
      for _, m in ipairs(armorModules()) do if m.name == rl then return true end end
      return false
    end
    local function piece(s)
      local slot = ARMOR[s:lower()]
      if not slot then return nil end
      local item = INV.get(slot)
      if item and item.name == MODULAR[slot] then return item end
      return false
    end
    local methods = {
      listUpgrades = function()
        local out = {}
        for _, m in ipairs(armorModules()) do out[#out + 1] = m.name end
        return true, out
      end,
      hasUpgrade = function(s)
        local rl = resourceLocation(argString(1, s))
        return hasModule(rl)
      end,
      getArmorFunctions = function()
        local out = {}
        if hasModule("cclink:scanner_upgrade") then out.scanner = scannerFunctions(false) end
        if hasModule("cclink:sensor_upgrade") then out.sensor = sensorFunctions(false) end
        if hasModule("cclink:introspection_upgrade") then out.introspection = introspectionFunctions(false) end
        if hasModule("cclink:world_upgrade") then out.world = worldFunctions(false) end
        if hasModule("cclink:overlay_upgrade") then out.overlay = overlayFunctions(false) end
        if hasModule("cclink:kinetic_upgrade") then out.kinetic = kineticFunctions(false, false) end
        return out
      end,
      getEnergy = function(s)
        local item = piece(argString(1, s))
        if not item then return 0 end
        return math.min(tonumber(item.energy) or 0, 2147483647)
      end,
      getMaxEnergy = function(s)
        local item = piece(argString(1, s))
        if not item then return 0 end
        return maxEnergy(item)
      end,
    }
    -- every method is mainThread: arguments are read in the task, Java exceptions come back as task errors
    local wrapped = {}
    for name, fn in pairs(methods) do
      wrapped[name] = function(...)
        local r = table.pack(pcall(fn, ...))
        if not r[1] then
          local e = r[2]
          if isJava(e) then error("Java Exception Thrown: " .. e.text, 0) end
          error(e, 0)
        end
        return table.unpack(r, 2, r.n)
      end
    end
    return wrapped
  end

  -- ===== sim commands =====

  local handlers = {}
  local function setFields(target, cmd, keys)
    for _, k in ipairs(keys) do if cmd[k] ~= nil then target[k] = cmd[k] end end
  end
  function handlers.ccLinkSetPlayer(cmd)
    setFields(P, cmd, { "x", "y", "z", "yaw", "pitch", "dimension", "health", "maxHealth" })
    setFields(W, cmd, { "food", "saturation", "air", "armorValue", "speed", "headYaw", "inWater", "inPowderSnow", "creative",
      "spectator", "fallFlying", "eyeHeight" })
    if cmd.motion then W.motion = { x = cmd.motion.x or 0, y = cmd.motion.y or 0, z = cmd.motion.z or 0 } end
    core.touch()
    return true
  end
  function handlers.ccLinkSetItem(cmd)
    local c = cmd.inventory == "ender" and ENDER or INV
    local slot = tonumber(cmd.slot)
    if not slot or slot < 0 or slot >= c.size then return false, "slot must be 0.." .. (c.size - 1) end
    c.slots[slot] = normItem(cmd.item)
    core.touch()
    return true
  end
  function handlers.ccLinkSetUpgrades(cmd)
    for i = 0, UPGRADE_SLOTS - 1 do upgradeSlots[i] = nil end
    for i, item in ipairs(listOf(cmd.upgrades)) do
      if i > UPGRADE_SLOTS then return false, "the Link core has " .. UPGRADE_SLOTS .. " upgrade slots" end
      upgradeSlots[i - 1] = item
    end
    core.touch()
    return true
  end
  function handlers.ccLinkSetWorld(cmd)
    setFields(env, cmd, { "raining", "thundering", "day", "canSeeSky", "biome" })
    if cmd.dimension then P.dimension = cmd.dimension end
    core.touch()
    return true
  end
  function handlers.ccLinkSetEntities(cmd)
    core.world.entities = type(cmd.entities) == "table" and cmd.entities or {}
    return true
  end
  function handlers.ccLinkChat(cmd)
    -- events/ChatEvent: the wearer's own chat reaches the core when it has the chatty upgrade
    if type(cmd.message) ~= "string" then return false, "message must be a string" end
    local c = linkContainer(kind == "integrated")
    if c and c.hasAnyOf("cclink:chatty_upgrade") then os.queueEvent("chat_message", P.name, cmd.message) end
    return true
  end

  local function slotState(c)
    local out = {}
    for i = 0, c.size - 1 do if c.slots[i] then out[tostring(i)] = copyTable(c.slots[i]) end end
    return out
  end

  return {
    peripheral = function(def)
      return {
        methods = armorPeripheral(),
        exactReturns = true,
      }
    end,
    handlers = handlers,
    state = function()
      local recent = {}
      for i = math.max(1, #packets - 19), #packets do recent[#recent + 1] = packets[i] end
      return {
        core = kind,
        upgrades = upgradeList(linkInv),
        player = {
          name = P.name, x = P.x, y = P.y, z = P.z, yaw = P.yaw, pitch = P.pitch, headYaw = W.headYaw,
          dimension = P.dimension, food = W.food, saturation = W.saturation, swings = W.swings,
          motion = copyTable(W.motion), fallDistance = W.fallDistance,
          inventory = slotState(INV), ender = slotState(ENDER),
        },
        hud = copyTable(hud),
        packets = recent,
        packetCount = #packets,
      }
    end,
  }
end
