-- UnlimitedPeripheralWorks' own blocks: the universal scanner, the ultimate sensor, the item pedestal and the display
-- pedestal (see init.lua for the sources).
return function(U)
  local C, Q, core, host, gameData = U.C, U.Q, U.core, U.host, U.gameData
  local floor = math.floor
  local upw = U.upw

  local HORIZONTAL = { north = true, south = true, east = true, west = true }

  --- BlockPos.toRelative(facing) of (pos - center): NORTH turns clockwise, SOUTH counter-clockwise, WEST half way
  local function relative(dx, dy, dz, facing)
    if facing == "north" then return -dz, dy, dx end
    if facing == "south" then return dz, dy, -dx end
    if facing == "east" then return dx, dy, dz end
    if facing == "west" then return -dx, dy, -dz end
    C.java("java.lang.IllegalArgumentException", "This works only for horizontal facing")
  end

  local function facingOf(def, default)
    local f = def.facing or default
    if type(f) ~= "string" then f = default end
    return f:lower()
  end

  local function withPos(map, bx, by, bz, center, facing)
    local x, y, z = relative(bx - center.x, by - center.y, bz - center.z, facing)
    map.x, map.y, map.z = x, y, z
    return map
  end

  -- ===== entities (LuaRepresentation.forEntity / forLivingEntity / forPlayer) =====

  local CATEGORY = {}
  for _, n in ipairs({ "zombie", "husk", "drowned", "skeleton", "stray", "wither_skeleton", "creeper", "spider",
    "cave_spider", "enderman", "witch", "slime", "magma_cube", "blaze", "ghast", "phantom", "pillager", "vindicator",
    "evoker", "ravager", "vex", "silverfish", "endermite", "guardian", "elder_guardian", "shulker", "piglin",
    "piglin_brute", "zombified_piglin", "hoglin", "zoglin", "zombie_villager", "illusioner", "giant", "warden",
    "wither", "ender_dragon" }) do CATEGORY["minecraft:" .. n] = "MONSTER" end
  for _, n in ipairs({ "cow", "pig", "sheep", "chicken", "horse", "donkey", "mule", "llama", "wolf", "cat", "ocelot",
    "rabbit", "fox", "panda", "parrot", "polar_bear", "turtle", "bee", "goat", "frog", "camel", "sniffer", "mooshroom",
    "strider", "armadillo", "skeleton_horse", "zombie_horse", "trader_llama" }) do CATEGORY["minecraft:" .. n] = "CREATURE" end
  CATEGORY["minecraft:bat"] = "AMBIENT"
  CATEGORY["minecraft:squid"] = "WATER_CREATURE"
  CATEGORY["minecraft:dolphin"] = "WATER_CREATURE"
  CATEGORY["minecraft:glow_squid"] = "UNDERGROUND_WATER_CREATURE"
  CATEGORY["minecraft:axolotl"] = "AXOLOTLS"
  for _, n in ipairs({ "cod", "salmon", "tropical_fish", "pufferfish", "tadpole" }) do
    CATEGORY["minecraft:" .. n] = "WATER_AMBIENT"
  end

  local function titleCase(id)
    local path = id:match(":(.+)$") or id
    return (path:gsub("_", " "):gsub("(%a)([%w]*)", function(a, b) return a:upper() .. b end))
  end

  --- a uuid for a fixture entity that gives none: made from its place in the list, so it stays the same
  local function uuidOf(e, i, kind)
    if type(e.uuid) == "string" then return e.uuid end
    return ("00000000-0000-4000-8000-%s%08x"):format(kind == "player" and "0001" or "0000", i)
  end

  local function forEntity(e, i, kind)
    local id = gameData.id(e.type or e.name)
    local tags = {}
    for j, t in ipairs(type(e.tags) == "table" and e.tags or {}) do tags[j] = t end
    local ns, path = id:match("^([^:]+):(.+)$")
    return {
      name = id,
      uuid = uuidOf(e, i, kind),
      category = e.category or CATEGORY[id] or "MISC",
      type = "entity." .. ns .. "." .. path,
      displayName = e.displayName or e.customName or titleCase(id),
      tags = tags,
    }
  end

  --- the entity's bounding box (width x height from its feet); a fixture can give its own
  local function box(e, w, h)
    w, h = tonumber(e.width) or w, tonumber(e.height) or h
    return e.x - w / 2, e.y, e.z - w / 2, e.x + w / 2, e.y + h, e.z + w / 2
  end

  --- ScanUtils.getBox(pos, radius): the block's centre, radius + 0.5, inflated by 0.99; AABB.intersects
  local function inBox(center, radius, x1, y1, z1, x2, y2, z2)
    local r = radius + 0.5 + 0.99
    local cx, cy, cz = center.x + 0.5, center.y + 0.5, center.z + 0.5
    return x1 < cx + r and x2 > cx - r and y1 < cy + r and y2 > cy - r and z1 < cz + r and z2 > cz - r
  end

  local function players()
    if U.players == nil then
      U.players = {}
      for i, p in ipairs(type(upw.players) == "table" and upw.players or {}) do U.players[i] = p end
    end
    return U.players
  end

  -- ===== universal scanner =====

  local SCAN_METHODS = { "block", "entity", "item", "player" } -- ScanningBoon's LinkedHashMap, in attach order

  U.builders["universal_scanner"] = function(def)
    local saved = U.saved(def.name) or {}
    local ops = U.newOperations(saved.cooldowns)
    -- a block owner has no fuel boon: the stationary scan
    local op = U.sphereOperation("STATIONARY_UNIVERSAL_SCAN", 500, 24, 24, 0.0)
    ops.register(op)
    local maxRadius = op.maxCostRadius
    local center = U.position(def)
    local facing = facingOf(def, "north")
    if not HORIZONTAL[facing] then facing = "north" end

    local function scanBlocks(radius, filter)
      local predicate
      if filter ~= nil then
        predicate = Q.block(filter)
      else
        predicate = function(b) return b.name ~= "minecraft:air" end
      end
      local w = U.world()
      local out = {}
      local r = math.min(radius, maxRadius)
      local AIR = { name = "minecraft:air", state = {} }
      for x = center.x - r, center.x + r do
        for y = center.y - r, center.y + r do
          for z = center.z - r, center.z + r do
            local b = w.get(x, y, z) or AIR
            if predicate(b) then
              local d = U.blockDetail(b)
              d.displayName = gameData.displayName(b.name)
              out[#out + 1] = withPos(d, x, y, z, center, facing)
            end
          end
        end
      end
      return out
    end

    local function scanEntities(kind, radius)
      local r = math.min(radius, maxRadius)
      local out = {}
      if kind == "player" then
        for i, p in ipairs(players()) do
          if p.x and p.y and p.z and inBox(center, r, box(p, 0.6, 1.8)) then
            local d = forEntity({ type = "minecraft:player", uuid = p.uuid, displayName = p.name, tags = p.tags }, i, "player")
            d.health = C.float(tonumber(p.health) or 20)
            d.experienceLevel = tonumber(p.experienceLevel) or 0
            d.foodLevel = tonumber(p.foodLevel) or 20
            d.saturationLevel = C.float(tonumber(p.saturationLevel) or 5)
            d.isCreative = p.isCreative == true
            d.yRot = C.float(tonumber(p.yRot) or 0)
            d.xRot = C.float(tonumber(p.xRot) or 0)
            out[#out + 1] = withPos(d, floor(p.x), floor(p.y), floor(p.z), center, facing)
          end
        end
      elseif kind == "item" then
        for _, e in ipairs(U.world().itemEntities) do
          if inBox(center, r, box(e, 0.25, 0.25)) then
            local d = U.itemRepr(e.item, "DETAILED")
            out[#out + 1] = withPos(d, floor(e.x), floor(e.y), floor(e.z), center, facing)
          end
        end
      else
        for i, e in ipairs(U.world().entities) do
          if e.living ~= false and inBox(center, r, box(e, 0.6, 1.8)) then
            local d = forEntity(e, i, "entity")
            d.health = C.float(tonumber(e.health) or 20)
            out[#out + 1] = withPos(d, floor(e.x), floor(e.y), floor(e.z), center, facing)
          end
        end
      end
      return out
    end

    local methods = {}
    function methods.scan(...)
      local args = table.pack(...)
      local mode = C.str(1, args[1])
      local radius = args[2] == nil and maxRadius or C.int(2, args[2])
      if radius < 1 or radius > maxRadius then error(("radius should be between 1 and %d"):format(maxRadius), 0) end
      local known = false
      for _, m in ipairs(SCAN_METHODS) do if m == mode then known = true end end
      if not known then error("There is no scanning method " .. mode, 0) end
      return ops.perform(op, radius, function()
        if mode == "block" then return scanBlocks(radius, args[3]) end
        return scanEntities(mode, radius)
      end)
    end
    function methods.getConfiguration()
      local data = { maxRadius = maxRadius, scanMethods = { table.unpack(SCAN_METHODS) }, scanAPIVersion = { 1, 3 } }
      ops.configure(data)
      return data
    end
    methods.getCooldown = ops.getCooldown
    methods.getOperations = ops.getOperations

    local b = { def = def }
    U.blocks[def.name] = b
    return U.peripheral(def, methods, { getConfiguration = true, getOperations = true }, {
      state = function() return { restore = { cooldowns = ops.cooldowns } } end,
    })
  end

  -- ===== ultimate sensor (SensorCollection) =====

  local MOON = { "Full moon", "Waning gibbous", "Third quarter", "Waning crescent", "New moon", "Waxing crescent",
    "First quarter", "Waxing gibbous" }
  local ANGLE = { north = 0, south = 180, west = 270, east = 90 }

  U.builders["ultimate_sensor"] = function(def)
    local saved = U.saved(def.name) or {}
    local ops = U.newOperations(saved.cooldowns)
    local chunkOp = U.freeOperation("INSPECT_CHUNK", 10000)
    ops.register(chunkOp)
    local pos = U.position(def)
    local facing = facingOf(def, "north")

    local function dimension() return def.dimension or core.position.dimension or "minecraft:overworld" end

    local analyzers = {
      dimension = function()
        local list = upw.dimensions
        if type(list) ~= "table" then list = { "minecraft:overworld", "minecraft:the_nether", "minecraft:the_end" } end
        local out = {}
        for i, d in ipairs(list) do out[i] = d end
        return out
      end,
    }
    local analyzerNames = { "dimension" }

    local function chunkKey() return floor(pos.x / 16) .. "," .. floor(pos.z / 16) end

    local inspectors = {
      dimension = function() return dimension() end,
      biome = function() return def.biome or upw.biome or "minecraft:plains" end,
      weather = function()
        if U.env.thundering then return "thunder" end
        if U.env.raining then return "rain" end
        return "stable"
      end,
      orientation = function()
        local a = ANGLE[facing]
        if a == nil then return nil, "Cannot determinate angle to north pole" end
        return a
      end,
      time = function() return U.dayTime() end,
      light = function()
        local light = type(def.light) == "table" and def.light or type(upw.light) == "table" and upw.light or {}
        return { light = tonumber(light.block) or 0, sunlight = tonumber(light.sky) or 15 }
      end,
      calendar = function()
        local t = U.dayTime()
        local data = { day = floor(t / 24000) % 2147483647 }
        if dimension() == "minecraft:overworld" then data.moonPhase = MOON[floor(t / 24000) % 8 + 1] end
        return data
      end,
      chunk = function()
        return ops.perform(chunkOp, nil, function()
          local cx, cz = floor(pos.x / 16) * 16, floor(pos.z / 16) * 16
          local ores = {}
          U.world().eachBlock(function(x, y, z, b)
            if x >= cx and x < cx + 16 and z >= cz and z < cz + 16 and y >= -64 and y <= 320 then
              if gameData.blockHasTag(b.name, "forge:ores") or gameData.blockHasTag(b.name, "c:ores") then
                ores[b.name] = (ores[b.name] or 0) + 1
              end
            end
          end, function(name) return gameData.blockHasTag(name, "forge:ores") or gameData.blockHasTag(name, "c:ores") end)
          local slime = def.slimeChunk
          if slime == nil and type(upw.slimeChunks) == "table" then
            for _, k in ipairs(upw.slimeChunks) do if k == chunkKey() then slime = true end end
          end
          return { oresDistribution = ores, isSlime = slime == true }
        end)
      end,
    }
    local inspectorNames = { "dimension", "biome", "weather", "orientation", "time", "light", "calendar", "chunk" }

    local methods = {}
    function methods.analyze(name)
      name = C.str(1, name)
      local fn = analyzers[name]
      if not fn then error("There is no such analyzer", 0) end
      return fn()
    end
    function methods.inspect(name)
      name = C.str(1, name)
      local fn = inspectors[name]
      if not fn then error("There is no such inspector", 0) end
      return fn()
    end
    function methods.listAnalyzers() return { table.unpack(analyzerNames) } end
    function methods.listInspectors() return { table.unpack(inspectorNames) } end
    function methods.getConfiguration()
      local data = {}
      ops.configure(data)
      return data
    end
    methods.getCooldown = ops.getCooldown
    methods.getOperations = ops.getOperations

    U.blocks[def.name] = { def = def }
    return U.peripheral(def, methods, { getConfiguration = true, getOperations = true }, {
      state = function() return { restore = { cooldowns = ops.cooldowns } } end,
    })
  end

  -- ===== item pedestal (PedestalInventoryPlugin on AbstractInventoryPlugin) =====

  U.builders["item_pedestal"] = function(def)
    local saved = U.saved(def.name)
    local start = saved and saved.items or (def.item and { [1] = def.item }) or def.items
    local inv = host.newInventory({ name = def.name, size = 1, items = start })

    local methods = {}
    function methods.size() return 1 end
    function methods.list(...)
      local args = table.pack(...)
      local detailed = args[1]
      if detailed == nil then detailed = false else detailed = C.bool(1, detailed) end
      local filter = args[2] ~= nil and Q.item(args[2]) or function() return true end
      local out = {}
      local item = inv.__state()[1]
      if item and item.count > 0 and filter(item) then out[1] = U.itemRepr(item, detailed and "DETAILED" or "BASE") end
      return out
    end
    function methods.getItemDetail(slot)
      slot = C.int(1, slot)
      if slot < 1 or slot > 1 then error("slot should be between 1 and 1", 0) end
      local item = inv.__state()[1]
      if not item then return nil end
      return U.itemRepr(item, "FULL")
    end
    function methods.getItemLimit(slot)
      slot = C.int(1, slot)
      if slot < 1 or slot > 1 then error("slot should be between 1 and 1", 0) end
      local item = inv.__state()[1]
      return item and (item.maxCount or 64) or 64
    end
    function methods.pushItems(toName, fromSlot, limit, toSlot)
      toName = C.str(1, toName)
      limit = C.optInt(3, limit)
      toSlot = C.optInt(4, toSlot)
      local target = U.findStorage(toName, "Target '" .. toName .. "' does not exist", "Target '" .. toName .. "' is not an inventory")
      local actual = math.min(limit or 2147483647, U.TRANSFER_LIMIT)
      if actual <= 0 then return 0 end
      if toSlot ~= nil then
        local size = target.size()
        if toSlot < 1 or toSlot > size then error(("toSlot should be between 1 and %d"):format(size), 0) end
      end
      local predicate
      if type(fromSlot) == "number" then
        local s = C.toInt(fromSlot)
        if s < 1 or s > 1 then error("fromSlot should be between 1 and 1", 0) end
        predicate = function() return true end
      else
        predicate = Q.item(fromSlot)
      end
      local items = inv.__state()
      local item = items[1]
      if not item or not predicate(item) then return 0 end
      local moved = target.__insert(item, math.min(actual, item.count), toSlot)
      item.count = item.count - moved
      if item.count <= 0 then items[1] = nil end
      core.save()
      return moved
    end
    function methods.pullItems(fromName, fromSlot, limit, toSlot)
      fromName = C.str(1, fromName)
      limit = C.optInt(3, limit)
      toSlot = C.optInt(4, toSlot)
      local source = U.findStorage(fromName, "Source '" .. fromName .. "' does not exist", "Source '" .. fromName .. "' is not an inventory")
      local actual = math.min(limit or 2147483647, U.TRANSFER_LIMIT)
      if actual <= 0 then return 0 end
      local moved = 0
      if type(fromSlot) == "number" then
        local s = C.toInt(fromSlot)
        local size = source.size()
        if s < 1 or s > size then error(("fromSlot should be between 1 and %d"):format(size), 0) end
        local item = source.__state()[s]
        if item then
          moved = inv.__insert(item, math.min(actual, item.count))
          item.count = item.count - moved
          if item.count <= 0 then source.__state()[s] = nil end
        end
      else
        if toSlot ~= nil and (toSlot < 1 or toSlot > 1) then error("toSlot should be between 1 and 1", 0) end
        local predicate = Q.item(fromSlot)
        local items = source.__state()
        for s = 1, source.size() do
          local item = items[s]
          if item and predicate(item) then
            local n = inv.__insert(item, math.min(actual - moved, item.count))
            item.count = item.count - n
            if item.count <= 0 then items[s] = nil end
            moved = moved + n
            if moved >= actual or n == 0 then break end
          end
        end
      end
      core.save()
      return moved
    end
    function methods.getConfiguration()
      return { inventoryTransferLimit = U.TRANSFER_LIMIT, inventoryAPI = { 1, 1 } }
    end

    U.blocks[def.name] = { def = def, inventory = inv }
    local computer = { getConfiguration = true }
    return U.peripheral(def, methods, computer, {
      types = { "item_pedestal", "inventory", "inventory_extended" },
      inventory = inv, -- what other blocks' pushItems/pullItems reach
      state = function()
        local item = inv.__state()[1]
        return { item = item, restore = { items = item and { [1] = U.copyItem(item) } or {} } }
      end,
    })
  end

  -- ===== display pedestal =====

  U.builders["display_pedestal"] = function(def)
    local saved = U.saved(def.name) or {}
    local b = {
      item = saved.item or (type(def.item) == "table" and U.copyItem(def.item, def.item.count or 1) or nil),
      renderLabel = saved.renderLabel,
      renderItem = saved.renderItem,
    }
    if b.renderLabel == nil then b.renderLabel = def.renderLabel ~= false end
    if b.renderItem == nil then b.renderItem = def.renderItem ~= false end
    if b.item and b.item.name then b.item.name = gameData.id(b.item.name) end

    local methods = {}
    function methods.getItem()
      if not b.item then return nil end
      return U.itemRepr(b.item, "FULL")
    end
    function methods.setItem(id, name, nbtData)
      id = C.str(1, id)
      if name ~= nil then name = C.str(2, name) end
      if nbtData ~= nil then nbtData = C.str(3, nbtData) end
      if not Q.itemExists(id) then return nil, "Cannot find item with id " .. id end
      local item = { name = C.resourceLocation(id), count = 1 }
      local tag
      if nbtData ~= nil then
        local parsed, err = U.N.parseSnbt(nbtData)
        if not parsed then C.java("com.mojang.brigadier.exceptions.CommandSyntaxException", err) end
        if parsed.t ~= "compound" then
          C.java("com.mojang.brigadier.exceptions.CommandSyntaxException", "Expected '{' at position 0: <--[HERE]")
        end
        tag = parsed
      end
      if name ~= nil then
        tag = tag or { t = "compound", v = {} }
        local display = tag.v.display
        if not display or display.t ~= "compound" then
          display = { t = "compound", v = {} }
          tag.v.display = display
        end
        display.v.Name = { t = "string", v = textutils.serializeJSON({ text = name }) }
        item.displayName = name
      end
      if tag then
        item.__raw = tag
        item.nbt = U.NB.hash(tag)
      end
      b.item = item
      core.save()
      return true
    end
    function methods.isLabelRendered() return b.renderLabel end
    function methods.isItemRendered() return b.renderItem end
    function methods.setLabelRendered(value)
      b.renderLabel = C.bool(1, value)
      core.save()
    end
    function methods.setItemRendered(value)
      b.renderItem = C.bool(1, value)
      core.save()
    end
    function methods.getConfiguration() return {} end

    U.blocks[def.name] = b
    return U.peripheral(def, methods, { getConfiguration = true }, {
      state = function()
        return {
          item = b.item, renderLabel = b.renderLabel, renderItem = b.renderItem,
          restore = { item = b.item, renderLabel = b.renderLabel, renderItem = b.renderItem },
        }
      end,
    })
  end
end
