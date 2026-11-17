-- ccsim finer-peripherals: Finer Peripherals 1.20.1-0.6.1 (Fabric 1.20.1): chat box, geo explorer, player finder,
-- event relayer, holographic item display, and the compass, ender chest and debug upgrades.
--
-- Written from minecraftbossdj/FinerPeripherals at b217ea8 (27 Aug 2025, the day 0.6.1 was published; the repository
-- has no tags) and checked against finerperipherals-1.20.1-0.6.1.jar with javap: the string constants match. Files
-- followed, relative to src/main/java/com/awesoft/finerperipherals/:
--   FinerPeripherals (which blocks have peripherals), TurtleRegistry, PocketRegistry and
--   resources/data/finerperipherals/computercraft/{turtle,pocket}_upgrades/*.json (the upgrades and their items),
--   peripherals/chatbox/{chatBoxPeripheral, pocket/chatBoxPeripheralPocket, turtle/chatBoxTurtle, chatBoxAttachedManager},
--   events/ChatEvent, peripherals/geoexplorer/{geoExplorerPeripheral, pocket/geoExplorerPeripheralPocket,
--   turtle/geoExplorerTurtle}, peripherals/playerfinder/playerFinderPeripheral,
--   peripherals/eventrelayer/{eventRelayerPeripheral, eventRelayerAttachedManager}, peripherals/holoitemdisplay/*,
--   peripherals/compass/{CompassPeripheral, compassTurtle}, peripherals/enderChestTurtle/enderChestPeripheral,
--   peripherals/debugPocket/DebugPeripheral, lib/LuaConverter.
-- CC:Tweaked's side follows cc-tweaked v1.20.1-1.117.0. docs/finer-peripherals.md lists every rule and the gaps.
return function(core, host)
  local floor = math.floor
  local cfg = core.world.finerPeripherals or {}

  -- ===== CC:Tweaked and Java =====

  local TWO32, TWO31 = 4294967296, 2147483648
  local function i32(n)
    n = n % TWO32
    if n >= TWO31 then n = n - TWO32 end
    return n
  end
  local function trunc(d) if d >= 0 then return floor(d) end return -floor(-d) end
  local function typeName(v) return v == nil and "nil" or type(v) end
  local function bad(i, expected, v)
    error(("bad argument #%d (%s expected, got %s)"):format(i, expected, typeName(v)), 0)
  end
  local function argString(i, v) if type(v) ~= "string" then bad(i, "string", v) end return v end
  local function argInt(i, v)
    if type(v) ~= "number" then bad(i, "number", v) end
    if v ~= v then error(("bad argument #%d (number expected, got nan)"):format(i), 0) end
    if v == math.huge or v == -math.huge then
      error(("bad argument #%d (number expected, got %s)"):format(i, v > 0 and "inf" or "-inf"), 0)
    end
    return i32(trunc(v))
  end
  local function java(class, message)
    error("Java Exception Thrown: " .. class .. (message and (": " .. message) or ""), 0)
  end

  -- ===== game data and the block world =====

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

  local function tagList(kind, id, fixture)
    local out = {}
    if type(fixture) == "table" then
      for i, t in ipairs(fixture) do out[i] = t end
      return out
    end
    for i, t in ipairs(kind == "block" and data().blockTags(id) or data().itemTags(id)) do out[i] = "minecraft:" .. kind .. "/" .. t end
    return out
  end

  --- geoExplorerPeripheral.convertToBlockId(block.getName().toString()): the block's translation key, so the wall
  --- forms of torches, signs, banners and heads read as their standing item (their getDescriptionId is the item's).
  local function blockDescId(id)
    local ns, path = id:match("^([^:]+):(.+)$")
    if not ns then ns, path = "minecraft", id end
    if ns == "minecraft" then
      path = path:gsub("^wall_torch$", "torch")
        :gsub("_wall_torch$", "_torch")
        :gsub("_wall_hanging_sign$", "_hanging_sign")
        :gsub("_wall_sign$", "_sign")
        :gsub("_wall_banner$", "_banner")
        :gsub("_wall_skull$", "_skull")
        :gsub("_wall_head$", "_head")
    end
    return ns .. ":" .. path
  end
  --- LuaConverter.convertToID(item.getName(item.getDefaultInstance()).toString())
  local POTION_DEFAULT = { potion = "water", splash_potion = "water", lingering_potion = "water", tipped_arrow = "poison" }
  local function itemDescId(id)
    local ns, path = id:match("^([^:]+):(.+)$")
    if ns == "minecraft" and POTION_DEFAULT[path] then return ns .. ":" .. path .. ".effect." .. POTION_DEFAULT[path] end
    return id
  end

  -- ===== items =====

  local function copyTable(v)
    if type(v) ~= "table" then return v end
    local out = {}
    for k, x in pairs(v) do out[k] = copyTable(x) end
    return out
  end
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
    if type(a.nbt) == "string" or type(b.nbt) == "string" then return a.nbt == b.nbt end
    if ta == nil or tb == nil then return ta == nil and tb == nil end
    return nbtHash(ta) == nbtHash(tb)
  end
  local function basicDetails(item)
    local d = { name = item.name, count = item.count }
    local tag = nbtOf(item)
    if type(item.nbt) == "string" then d.nbt = item.nbt elseif tag then d.nbt = nbtHash(tag) end
    return d
  end
  --- LuaConverter.stackToObject (Finer's own): tags, name (from the translation key), count, displayName, maxStackSize,
  --- nbt; {} for an empty stack
  local function stackToObject(item)
    if not item then return {} end
    return {
      tags = tagList("item", item.name, item.tags),
      name = itemDescId(item.name),
      count = item.count,
      displayName = "[" .. (item.displayName or data().displayName(item.name)) .. "]",
      maxStackSize = maxStack(item),
      nbt = nbtOf(item) or {},
    }
  end

  -- ===== players =====

  local function onlinePlayers()
    local out = {}
    for _, p in ipairs(core.players) do if p.online then out[#out + 1] = p end end
    return out
  end
  --- PlayerList.getPlayerByName: online players, the name ignoring case
  local function playerByName(name)
    for _, p in ipairs(onlinePlayers()) do if p.name:lower() == name:lower() then return p end end
    return nil
  end
  local function charAt(s, i)
    if #s <= i then java("java.lang.StringIndexOutOfBoundsException", "String index out of range: " .. i) end
    return s:sub(i + 1, i + 1)
  end

  -- ===== shared state =====

  local chatBoxes = {}       -- attached chat boxes (each gets its own chat event)
  local holo = {}            -- holographic displays by peripheral name: the stored item id
  local geoLast, holoLast = {}, {} -- the static lastCalledMap of geoExplorerPeripheral / holoItemDisplayPeripheral
  local relayed = 0
  local computerId = os.getComputerID()
  local function nowMs() return os.epoch("utc") % 2147483647 end
  local function remaining(map)
    local elapsed = nowMs() - (map[computerId] or 0)
    if elapsed < 0 then elapsed = elapsed + 2147483647 end
    return math.max(0, 2000 - elapsed)
  end

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

  -- ===== a turtle upgrade's block entity =====
  -- The chat box, geo explorer and compass upgrades keep the block entity of the turtle where they were made. When the
  -- turtle moves it gets a new one, so the upgrade goes on reading the old one: its position, and the facing the
  -- turtle had when it left.

  local origins = {}
  local hooked = false
  local function hookTurtle()
    if hooked or not core.turtle or not core.turtle.world then return end
    hooked = true
    local w = core.turtle.world
    local before = w.onChange
    w.onChange = function(x, y, z, ...)
      local pos = core.position
      for _, o in ipairs(origins) do
        if o.frozen == nil and x == o.x and y == o.y and z == o.z and not (pos.x == o.x and pos.y == o.y and pos.z == o.z) then
          o.frozen = core.turtle.state.facing
        end
      end
      if before then return before(x, y, z, ...) end
    end
  end
  local function newOrigin()
    local p = core.position
    local o = { x = floor(p.x), y = floor(p.y), z = floor(p.z) }
    origins[#origins + 1] = o
    hookTurtle()
    return o
  end
  local function turtleFacing()
    if core.turtle then return core.turtle.state.facing end
    return (type(core.world.turtle) == "table" and core.world.turtle.facing) or "north"
  end
  local function liveFacing(o)
    if o.frozen then return o.frozen end
    return turtleFacing()
  end

  local function blockPos(def)
    if def.x and def.y and def.z then return floor(def.x), floor(def.y), floor(def.z) end
    local p = core.position
    return floor(p.x), floor(p.y), floor(p.z)
  end

  -- ===== the peripherals =====

  local function chatMethods()
    return {
      sendMessage = function(msg, username, brackets)
        msg, username, brackets = argString(1, msg), argString(2, username), argString(3, brackets)
        for _, p in ipairs(onlinePlayers()) do
          core.say(p, charAt(brackets, 0) .. username .. charAt(brackets, 1) .. " " .. msg, { kind = "finerperipherals" })
        end
        return true
      end,
      sendMessageToPlayer = function(msg, plr, username, brackets)
        msg, plr, username, brackets = argString(1, msg), argString(2, plr), argString(3, username), argString(4, brackets)
        local p = playerByName(plr)
        if not p then java("java.lang.NullPointerException") end
        core.say(p, charAt(brackets, 0) .. username .. charAt(brackets, 1) .. " " .. msg, { kind = "finerperipherals" })
        return true
      end,
      tellraw = function(msg)
        msg = argString(1, msg)
        for _, p in ipairs(onlinePlayers()) do core.say(p, msg, { kind = "finerperipherals" }) end
        return true
      end,
      tellrawToPlayer = function(msg, plr)
        msg, plr = argString(1, msg), argString(2, plr)
        local p = playerByName(plr)
        if not p then java("java.lang.NullPointerException") end
        core.say(p, msg, { kind = "finerperipherals" })
        return true
      end,
    }
  end

  --- geoExplorerPeripheral.scan: the cube of side 2r+1 around `cx, cy, cz`, x then y then z, every non-air block
  local function scan(cx, cy, cz, radius)
    local out = {}
    for ox = cx - radius, cx + radius do
      for oy = cy - radius, cy + radius do
        for oz = cz - radius, cz + radius do
          local b = blockAt(ox, oy, oz)
          if b and not AIR[b.name] then
            local d = { x = ox - cx, y = oy - cy, z = oz - cz, name = blockDescId(b.name), tags = tagList("block", b.name, b.def and b.def.tags) }
            local st, props = b.state or {}, data().blockProperties(b.name) or {}
            local function values(p) return props[p] and table.concat(props[p], ",") or nil end
            if st.facing and values("facing") == "north,south,west,east" then d.direction = st.facing end
            if st.vertical_direction then d.direction_vertical = st.vertical_direction end
            if st.half == "top" or st.half == "bottom" then d.half = st.half end
            if st.axis and values("axis") == "x,y,z" then d.axis = st.axis end
            if st.powered ~= nil then d.powered = st.powered == "true" or st.powered == true end
            if st.power ~= nil then d.powerlvl = tonumber(st.power) end
            out[#out + 1] = d
          end
        end
      end
    end
    return out
  end

  local function geoMethods(center)
    return {
      scan = function(r)
        if remaining(geoLast) > 0 then return nil, "On cooldown!" end
        geoLast[computerId] = nowMs()
        local radius = argInt(1, r)
        local x, y, z = center()
        return scan(x, y, z, radius)
      end,
      getOperationCooldown = function() return remaining(geoLast) end,
    }
  end

  local function relayMethods()
    return {
      relayEvent = function(target, message)
        target, message = argInt(1, target), argString(2, message)
        -- eventRelayerAttachedManager: the first attached computer with that id gets it. Only this one is here.
        if target == computerId then os.queueEvent("secure_message", computerId, message) end
        relayed = relayed + 1
        return true
      end,
    }
  end

  local function enderOwner()
    local name = cfg.owner
    if type(name) ~= "string" then return nil end
    for _, p in ipairs(core.players) do
      if p.online and (p.name == name or p.uuid == name) then return p end
    end
    return nil
  end
  local enderSlots = {}
  for key, v in pairs(type(cfg.ender) == "table" and cfg.ender or {}) do
    local i = tonumber(key)
    if i and i >= 0 and i < 27 then enderSlots[i] = normItem(v) end
  end
  -- bounds-checked containers (SimpleContainer, CC's BasicContainer), 0-based
  local ENDER = {
    size = 27,
    get = function(i) if i < 0 or i >= 27 then return nil end return enderSlots[i] end,
    set = function(i, item) if i >= 0 and i < 27 then enderSlots[i] = item end end,
  }
  local function turtleContainer()
    local t = core.turtle and core.turtle.state
    return {
      size = 16,
      get = function(i) if not t or i < 0 or i >= 16 then return nil end return t.slots[i + 1] end,
      set = function(i, item) if t and i >= 0 and i < 16 then t.slots[i + 1] = item end end,
    }
  end

  --- enderChestPeripheral.moveTo (no clamping: a slot out of range is an empty stack)
  local function moveTo(from, to, fromSlot, limit, toSlot)
    local fi, ti = fromSlot - 1, toSlot - 1
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
  local function assertBetween(v, lo, hi, message)
    if v < lo or v > hi then error(message:format("between " .. lo .. " and " .. hi), 0) end
  end

  local function enderMethods()
    return {
      getInventory = function()
        local c, out = turtleContainer(), {}
        for i = 0, 15 do
          local item = c.get(i)
          if item then out[i + 1] = stackToObject(item) end
        end
        return out
      end,
      list = function()
        if not enderOwner() then return false, "Player isn't present" end
        local out = {}
        for i = 0, 26 do if enderSlots[i] then out[i + 1] = basicDetails(enderSlots[i]) end end
        return out
      end,
      size = function()
        if not enderOwner() then return false, "Player isn't present" end
        return 27
      end,
      getItemLimit = function(slot)
        slot = argInt(1, slot)
        if not enderOwner() then return false, "Player isn't present" end
        return maxStack(ENDER.get(slot - 1))
      end,
      pushItems = function(a, b, c)
        local fromSlot, limit, toSlot = argInt(1, a), argInt(2, b), argInt(3, c)
        if not enderOwner() then return false, "Player isn't present" end
        local turtleInv = turtleContainer()
        assertBetween(fromSlot, 1, 27, "From slot out of range (%s)")
        assertBetween(toSlot, 1, 16, "To slot out of range (%s)")
        assertBetween(limit, 1, maxStack(ENDER.get(fromSlot - 1)), "Stack Size out of range (%s)")
        return moveTo(ENDER, turtleInv, fromSlot, limit, toSlot)
      end,
      pullItems = function(a, b, c)
        local fromSlot, limit, toSlot = argInt(1, a), argInt(2, b), argInt(3, c)
        if not enderOwner() then return false, "Player isn't present" end
        return moveTo(turtleContainer(), ENDER, fromSlot, limit, toSlot)
      end,
    }
  end

  local function compassMethods(o)
    return {
      getDirection = function() return liveFacing(o) end,
      getDirectionInHub = function()
        -- the block entity now at the upgrade's first position
        local pos = core.position
        if pos.x == o.x and pos.y == o.y and pos.z == o.z then return turtleFacing() end
        local b = blockAt(o.x, o.y, o.z)
        local hasEntity = b and (b.blockEntity ~= nil or b.inventory ~= nil or (b.def and (b.def.items ~= nil or b.def.blockEntity ~= nil)))
        if not hasEntity then java("java.lang.NullPointerException") end
        local props = data().blockProperties(b.name) or {}
        local f = props.facing and table.concat(props.facing, ",") == "north,south,west,east" and b.state.facing
        if not f then
          java("java.lang.IllegalArgumentException", "Cannot get property DirectionProperty{name=facing, clazz=class " ..
            "net.minecraft.core.Direction, values=[north, south, west, east]} as it does not exist in Block{" .. b.name .. "}")
        end
        return f
      end,
    }
  end

  local THREAD = {
    chat = { sendMessage = true, sendMessageToPlayer = true, tellraw = true, tellrawToPlayer = true },
    finder = { getOnlinePlayers = true, getPlayerPos = true },
    compass = { getDirection = true, getDirectionInHub = true },
    ender = { getInventory = true },
  }

  local function build(def)
    local ty = def.type
    local p = { exactReturns = true }
    if ty == "finerperipherals:chatbox" or ty == "finerperipherals:chatbox_turtle" or ty == "finerperipherals:chatbox_pocket" then
      p.types = { ty == "finerperipherals:chatbox_pocket" and "chatbox" or "chatBox" }
      p.methods = chatMethods()
      p.computerThread = THREAD.chat
      local entry = { name = def.name }
      chatBoxes[#chatBoxes + 1] = entry
      p.detach = function()
        for i, e in ipairs(chatBoxes) do if e == entry then table.remove(chatBoxes, i) break end end
      end
    elseif ty == "finerperipherals:geoexplorer" then
      p.types = { "geoExplorer" }
      p.methods = geoMethods(function() return blockPos(def) end)
    elseif ty == "finerperipherals:geoexplorer_turtle" then
      p.types = { "geoExplorer" }
      local o = newOrigin()
      p.methods = geoMethods(function() return o.x, o.y, o.z end)
    elseif ty == "finerperipherals:geoexplorer_pocket" then
      p.types = { "geoExplorer" }
      local last = 0 -- this peripheral's own lastInvocationTimes
      p.methods = {
        scan = function(r)
          local now = os.epoch("utc")
          if now - last < 2000 then return false, "On cooldown!" end
          last = now
          local radius = argInt(1, r)
          local x, y, z = blockPos(def) -- the holder's blockPosition()
          return scan(x, y, z, radius)
        end,
      }
    elseif ty == "finerperipherals:player_finder" then
      p.types = { "playerFinder" }
      p.computerThread = THREAD.finder
      p.methods = {
        getOnlinePlayers = function()
          local names = {}
          for _, pl in ipairs(onlinePlayers()) do names[#names + 1] = pl.name end
          return true, names
        end,
        getPlayerPos = function(name)
          local pl = playerByName(argString(1, name))
          if not pl then return false, "Player not online!" end
          local d = { x = pl.x, y = pl.y, z = pl.z, dimension = pl.dimension or "minecraft:overworld" }
          local spawn = pl.respawn or (type(cfg.respawn) == "table" and cfg.respawn[pl.name])
          if type(spawn) == "table" then
            d.respawnPos = { x = floor(spawn.x or 0), y = floor(spawn.y or 0), z = floor(spawn.z or 0),
              dimension = spawn.dimension or "minecraft:overworld" }
          end
          return true, d
        end,
      }
    elseif ty == "finerperipherals:eventrelayer" or ty == "finerperipherals:eventrelayer_turtle" or ty == "finerperipherals:eventrelayer_pocket" then
      p.types = { "eventRelayer" }
      p.methods = relayMethods()
    elseif ty == "finerperipherals:holoitemdisplay" then
      p.types = { "holographic_item_display" }
      holo[def.name] = def.item
      p.methods = {
        setItem = function(id)
          id = argString(1, id)
          if remaining(holoLast) > 0 then return nil, "On cooldown!" end
          holoLast[computerId] = nowMs()
          local rl = resourceLocation(id)
          if data().isItem(rl) or (type(cfg.items) == "table" and cfg.items[rl]) then
            holo[def.name] = id
            return true
          end
          return false, "Not a real item id!"
        end,
        getOperationCooldown = function() return remaining(holoLast) end,
      }
      p.state = function() return { item = holo[def.name] } end
    elseif ty == "finerperipherals:compass_turtle" then
      p.types = { "compass" }
      p.computerThread = THREAD.compass
      local o = newOrigin()
      p.methods = compassMethods(o)
    elseif ty == "finerperipherals:enderchest_turtle" then
      p.types = { "enderchest" }
      p.computerThread = THREAD.ender
      p.methods = enderMethods()
    elseif ty == "finerperipherals:debug_pocket" then
      p.types = { "debug" }
      p.methods = { periphList = function() return false, "lil bro this shit dont exist anymore, lock in" end }
    end
    return p
  end

  -- the turtle upgrades, by the item that equips them (turtle_upgrades/*.json)
  core.turtleUpgrades = core.turtleUpgrades or {}
  core.turtleUpgrades["finerperipherals:chatbox"] = { peripheral = "finerperipherals:chatbox_turtle" }
  core.turtleUpgrades["minecraft:compass"] = { peripheral = "finerperipherals:compass_turtle" }
  core.turtleUpgrades["finerperipherals:geoexplorer"] = { peripheral = "finerperipherals:geoexplorer_turtle" }
  core.turtleUpgrades["finerperipherals:eventrelayer"] = { peripheral = "finerperipherals:eventrelayer_turtle" }
  core.turtleUpgrades["minecraft:ender_chest"] = { peripheral = "finerperipherals:enderchest_turtle" }

  -- ===== sim commands =====

  local handlers = {}
  --- events/ChatEvent: a player chats; every attached chat box queues chat, <name>, <message>, <uuid>
  function handlers.finerChat(cmd)
    local p = core.findPlayer(cmd.player)
    if not p then return false, "unknown player" end
    if type(cmd.message) ~= "string" then return false, "message must be a string" end
    for _ in ipairs(chatBoxes) do os.queueEvent("chat", p.name, cmd.message, p.uuid) end
    return true
  end
  function handlers.finerSetEnder(cmd)
    local slot = tonumber(cmd.slot)
    if not slot or slot < 0 or slot > 26 then return false, "slot must be 0..26" end
    enderSlots[slot] = normItem(cmd.item)
    core.touch()
    return true
  end
  function handlers.finerSetOwner(cmd)
    cfg.owner = cmd.owner
    return true
  end

  return {
    peripheral = build,
    handlers = handlers,
    catchUp = function() hookTurtle() end,
    state = function()
      local ender = {}
      for i = 0, 26 do if enderSlots[i] then ender[tostring(i)] = copyTable(enderSlots[i]) end end
      return { ender = ender, relayed = relayed, chatBoxes = #chatBoxes }
    end,
  }
end
