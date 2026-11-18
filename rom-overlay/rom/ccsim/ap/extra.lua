-- ccsim ap/extra: geoScanner, blockReader, inventoryManager and the chunky turtle (Advanced Peripherals 0.7.31r).
--
-- Written from the 1.18.2-0.7.30r tag (there is no 0.7.31r tag) and checked against the 0.7.31r jar: the same methods,
-- signatures and strings. Files followed:
--   common/addons/computercraft/peripheral/GeoScannerPeripheral.java    scan, cost, chunkAnalyze
--   common/addons/computercraft/peripheral/BlockReaderPeripheral.java   getBlockName, getBlockData
--   common/addons/computercraft/peripheral/InventoryManagerPeripheral.java and blocks/blockentities/InventoryManagerEntity
--   common/addons/computercraft/peripheral/ChunkyPeripheral.java, turtles/TurtleChunkyUpgrade.java, util/ChunkManager
--   common/addons/computercraft/operations/SphereOperation.java (SCAN_BLOCKS 2000 ms, free radius 8, max 16, 0.17)
--   common/addons/computercraft/owner/OperationAbility.java, FuelAbility, TurtleFuelAbility, TileEntityFuelAbility
--   common/util/ScanUtils.java (a cube, not a sphere), common/util/CoordUtil.getDirection, common/util/LuaConverter
--   common/util/inventory/InventoryUtil.moveItem, ItemFilter.parse/test, ItemUtil.getFingerprint
--   Forge 40.2: ItemHandlerHelper.insertItem, InvWrapper, PlayerInvWrapper, PlayerArmorInvWrapper, RangedWrapper
-- Blocks come from the turtle block world (ccsim/turtle/world.lua) with the turtle's game data, so a scan sees what a
-- turtle placed. docs/advanced-peripherals.md ("Geo scanner, block reader, inventory manager, chunky turtle").
return function(core, B)
  local F = {}
  -- The vhcctweaks server the addon was measured on turns all four off in its config: with the addon on none of them
-- exists (docs/advanced-peripherals.md).
  if core.vhcc then return F end

  local floor = math.floor
  local SPHERE = "de.srendi.advancedperipherals.common.addons.computercraft.operations.SphereOperation"
  local scanCfg = B.config.scanBlocks or { cooldown = 2000, maxFreeRadius = 8, maxCostRadius = 16, extraBlockCost = 0.17 }
  B.config.scanBlocks = scanCfg

  -- ===== game data and the block world =====

  local gameData, gameItems
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

  local function hasWorld(w) return type(w) == "table" and (w.blocks ~= nil or w.fills ~= nil or w.ground ~= nil) end

  local sharedWorld
  --- The block world around this computer: the turtle's (or a placed computer's), else one read from world.blocks,
  --- fills and ground. nil when the world has no blocks at all.
  local function worldGet()
    if core.turtle then return core.turtle.blockAt, core.turtle.world end
    if not hasWorld(core.world) then return nil end
    if not sharedWorld then
      sharedWorld = dofile("/rom/ccsim/turtle/world.lua")(core, data())
      sharedWorld.load(core.world)
    end
    return sharedWorld.get, sharedWorld
  end

  --- A peripheral's own fixture world (`blocks`, `fills`, `ground` on the peripheral), for a world without blocks.
  local function ownWorld(def)
    if not hasWorld(def) then return nil end
    if not def.__world then
      local w = dofile("/rom/ccsim/turtle/world.lua")(core, data())
      w.load({ blocks = def.blocks, fills = def.fills, ground = def.ground })
      def.__world = w
    end
    return def.__world.get, def.__world
  end

  local function lookup(def)
    local get, w = worldGet()
    if get then return get, w end
    return ownWorld(def)
  end

  local AIR = { ["minecraft:air"] = true, ["minecraft:cave_air"] = true, ["minecraft:void_air"] = true }

  --- LuaConverter.tagsToList: "<registry>/<tag>", e.g. "minecraft:block/minecraft:mineable/pickaxe"
  local tagCache = { block = {}, item = {} }
  local function tagList(kind, name, fixture)
    if type(fixture) == "table" then
      local out = {}
      for i, t in ipairs(fixture) do out[i] = t end
      return out
    end
    local cached = tagCache[kind][name]
    if not cached then
      cached = {}
      local list = kind == "block" and data().blockTags(name) or data().itemTags(name)
      for i, t in ipairs(list) do cached[i] = "minecraft:" .. kind .. "/" .. t end
      tagCache[kind][name] = cached
    end
    local out = {}
    for i, t in ipairs(cached) do out[i] = t end
    return out
  end

  local function blockPos(def)
    local at = def.blockPos
    if at then return at.x, at.y, at.z end
    return floor(def.x or 0), floor(def.y or 64), floor(def.z or 0)
  end

  --- FrontAndTop of an AP block: `orientation` ("north_up", or { front, top }) on the fixture, else the block's own
  --- `orientation` state in the block world, else north/up.
  local function orientationOf(def)
    local o = def.orientation
    if type(o) == "table" then return o.front or "north", o.top or "up" end
    if type(o) == "string" then
      local f, t = o:match("^(%a+)_(%a+)$")
      if f then return f, t end
    end
    if def.blockPos then
      local get = worldGet()
      local b = get and get(def.blockPos.x, def.blockPos.y, def.blockPos.z)
      local s = b and b.state and b.state.orientation
      if type(s) == "string" then
        local f, t = s:match("^(%a+)_(%a+)$")
        if f then return f, t end
      end
    end
    if type(def.facing) == "string" then return def.facing, "up" end
    return "north", "up"
  end

  local STEP = { south = { 0, 0, 1 }, west = { -1, 0, 0 }, north = { 0, 0, -1 }, east = { 1, 0, 0 }, up = { 0, 1, 0 }, down = { 0, -1, 0 } }
  local OPP = { south = "north", north = "south", east = "west", west = "east", up = "down", down = "up" }
  local CW = { north = "east", east = "south", south = "west", west = "north" }
  local CCW = { north = "west", west = "south", south = "east", east = "north" }

  --- BasePeripheral.validateSide -> CoordUtil.getDirection(orientation, side.toUpperCase())
  local function validateSide(def, side)
    local upper = side:upper()
    local lower = upper:lower()
    if STEP[lower] then return lower end
    local front, top = orientationOf(def)
    if front == "up" or front == "down" then
      if upper == "FRONT" then return front end
      if upper == "BACK" then return OPP[front] end
      if upper == "TOP" then return top end
      if upper == "BOTTOM" then return OPP[top] end
      if upper == "RIGHT" then return CW[top] end
      if upper == "LEFT" then return CCW[top] end
    end
    if upper == "FRONT" then return front end
    if upper == "BACK" then return OPP[front] end
    if upper == "TOP" then return "up" end
    if upper == "BOTTOM" then return "down" end
    if upper == "RIGHT" then return CCW[front] end
    if upper == "LEFT" then return CW[front] end
    error(upper .. " is not a valid side", 0)
  end

  local function javaIndex(i, n)
    error(("Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index %d out of bounds for length %d"):format(i, n), 0)
  end

  -- ===== operations with a cost (OperationAbility.performOperation) =====

  --- `fuel` is the owner's FuelAbility: { consume(count) -> bool } or nil when the owner has none.
  local function perform(self, name, cooldown, cost, fuel, check, fn)
    if (self.cooldownUntil[name] or 0) > core.nowMs() then return nil, name .. " is on cooldown" end
    if check then
      local a, b = check()
      if a ~= nil or b ~= nil then return a, b end
    end
    if cost ~= 0 then
      if not fuel then return nil, "This peripheral has no fuel at all" end
      if not fuel.consume(cost) then return nil, "Not enough fuel for operation" end
      -- reduceCooldownAccordingToConsumptionRate divides by the rate, which is always 1 here (max rate 1)
    end
    local r1, r2 = fn()
    if cooldown > 0 then self.cooldownUntil[name] = core.nowMs() + cooldown end
    return r1, r2
  end

  --- SphereOperation.getCost
  local function sphereCost(radius)
    if radius <= scanCfg.maxFreeRadius then return 0 end
    local free = (2 * scanCfg.maxFreeRadius + 1) ^ 3
    local all = (2 * radius + 1) ^ 3
    return floor((all - free) * scanCfg.extraBlockCost)
  end

  --- The fuel of a block peripheral (TileEntityFuelAbility) or of the turtle the upgrade sits on (TurtleFuelAbility).
  local function attachFuel(self, def)
    B.addFuel(self) -- getFuelConsumptionRate / setFuelConsumptionRate, max rate 1 for both owners
    local m = self.methods
    if def.turtleUpgrade then
      local function brain() return core.turtle end
      local function needsFuel() return (core.world.turtleConfig or {}).needFuel ~= false end
      local function limit() local b = brain() return b and b.fuelLimit or 20000 end
      local function level() local b = brain() return b and math.min(b.state.fuel, limit()) or 0 end
      function m.getFuelLevel() return level() end
      function m.getMaxFuelLevel() return limit() end
      return {
        consume = function(count)
          if not needsFuel() then return true end
          local b = brain()
          if not b then return false end
          count = math.max(count, 0)
          if level() < count then return false end
          b.state.fuel = level() - count
          core.dirty = true
          return true
        end,
      }
    end
    local rate = B.config.energyToFuelRate
    local stored = def.energy or 0
    local capacity = def.energyCapacity or B.config.poweredPeripheralMaxEnergyStored
    local powered = B.config.enablePoweredPeripherals
    if powered then
      function m.getFuelLevel() return floor(stored / rate) end
      function m.getMaxFuelLevel() return floor(capacity / rate) end
    end
    return {
      consume = function(count)
        if not powered then return true end
        local energy = count * rate
        if stored < energy then return false end
        stored = stored - energy
        return true
      end,
    }
  end

  -- ===== geoScanner =====

  function F.geoScanner(def)
    local self = B.new(def)
    local m = self.methods
    local turtle = def.turtleUpgrade ~= nil
    if turtle then function m.getName() return nil end end
    B.addOperation(self, "scanBlocks", {
      name = "scanBlocks", type = SPHERE, cooldown = scanCfg.cooldown, maxFreeRadius = scanCfg.maxFreeRadius,
      maxCostRadius = scanCfg.maxCostRadius, extraBlockCost = scanCfg.extraBlockCost,
    })
    local fuel = attachFuel(self, def)
    self.computerThread = { getName = true, getConfiguration = true, cost = true }

    local function center()
      if turtle then return core.position.x, core.position.y, core.position.z end
      return blockPos(def)
    end

    --- The block at a position, with the scanner standing in it when the world has nothing there.
    local function getter()
      local get, w = lookup(def)
      local x0, y0, z0 = center()
      local own = { name = turtle and "computercraft:turtle_normal" or "advancedperipherals:geo_scanner" }
      return function(x, y, z)
        local b = get and get(x, y, z)
        if b == nil and x == x0 and y == y0 and z == z0 then return own end
        return b
      end, w
    end

    function m.cost(radius)
      radius = B.int(1, radius)
      if radius > scanCfg.maxCostRadius then return nil, "Radius is exceed max value" end
      return sphereCost(radius)
    end

    function m.scan(radius)
      radius = B.int(1, radius)
      return perform(self, "scanBlocks", scanCfg.cooldown, sphereCost(radius), fuel, function()
        if radius > scanCfg.maxCostRadius then return nil, "Radius is exceed max value" end
      end, function()
        local get = getter()
        local x0, y0, z0 = center()
        local out = {}
        -- ScanUtils.traverseBlocks: x, then y, then z, every non-air block of the cube, relative to the scanner
        for x = x0 - radius, x0 + radius do
          for y = y0 - radius, y0 + radius do
            for z = z0 - radius, z0 + radius do
              local b = get(x, y, z)
              if b and not AIR[b.name] then
                out[#out + 1] = { x = x - x0, y = y - y0, z = z - z0, name = b.name, tags = tagList("block", b.name) }
              end
            end
          end
        end
        return out
      end)
    end

    function m.chunkAnalyze()
      return perform(self, "scanBlocks", scanCfg.cooldown, sphereCost(scanCfg.maxFreeRadius), fuel, nil, function()
        local _, w = getter()
        local out = {}
        if not w then return out end
        local x0, _, z0 = center()
        local cx, cz = floor(x0 / 16), floor(z0 / 16)
        local lo, hi = w.limits(core.position.dimension)
        local top = hi - lo + 1 -- `y < dimensionType().height()`: the loop stops at the height, not at the top
        local d = data()
        local function ore(name) return d.blockHasTag(name, "forge:ores") end
        w.eachBlock(function(x, y, z, b)
          if floor(x / 16) == cx and floor(z / 16) == cz and y >= lo and y < top and ore(b.name) then
            out[b.name] = (out[b.name] or 0) + 1
          end
        end, ore)
        return out
      end)
    end

    return self
  end

  -- ===== blockReader =====

  function F.blockReader(def)
    local self = B.new(def)
    local m = self.methods
    self.computerThread = { getName = true, getConfiguration = true }

    local function front()
      if def.block ~= nil then
        local b = def.block
        if type(b) == "string" then b = { name = b } end
        return b and b.name and { name = data().id(b.name), blockEntity = b.blockEntity, def = b, fixture = true } or nil
      end
      local get = lookup(def)
      if not get then return nil end
      local dir = (orientationOf(def))
      local x, y, z = blockPos(def)
      local s = STEP[dir] or STEP.north
      x, y, z = x + s[1], y + s[2], z + s[3]
      return get(x, y, z), { x, y, z }
    end

    local function blockEntity(b)
      local inv
      if core.turtle and not b.fixture then inv = core.turtle.inventoryOf(b) end
      local items
      if inv then
        items = inv.__state()
      elseif b.def and (b.def.items or b.def.size) then
        items = core.normalizeItems(b.def.items)
      end
      if b.blockEntity == nil and items == nil then return nil end
      local out = B.copy(b.blockEntity) or {}
      if items then
        local list, slots = {}, {}
        for slot in pairs(items) do slots[#slots + 1] = slot end
        table.sort(slots)
        for _, slot in ipairs(slots) do
          local it = items[slot]
          local entry = { Slot = slot - 1, id = data().id(it.name), Count = it.count or 1 }
          if type(it.nbt) == "table" then entry.tag = B.copy(it.nbt) end
          list[#list + 1] = entry
        end
        out.Items = list
      end
      return out
    end

    function m.getBlockName()
      local b = front()
      if b == nil or b.name == "minecraft:air" then return "none" end
      return b.name
    end

    function m.getBlockData()
      local b = front()
      if b == nil or b.name == "minecraft:air" then return nil end
      return blockEntity(b)
    end

    return self
  end

  -- ===== inventoryManager =====

  -- Players' inventories, by name: items[0..35], armor[0..3] (feet, legs, chest, head), offhand, selected (0-8).
  local players = {}
  local ARMOR_NAMES = { feet = 0, legs = 1, chest = 2, head = 3 }

  local function normStack(item)
    if type(item) ~= "table" or not item.name then return nil end
    local out = B.copy(item)
    out.name = data().id(item.name)
    out.count = item.count or 1
    if out.count <= 0 then return nil end
    return out
  end

  local function slotTable(t)
    local out = {}
    for k, v in pairs(t or {}) do
      local i = tonumber(k)
      if i then out[i] = normStack(v) end
    end
    return out
  end

  local function fromSpec(spec)
    spec = spec or {}
    local p = { items = slotTable(spec.inventory), armor = {}, offhand = normStack(spec.offhand), selected = spec.selected or 0 }
    for k, v in pairs(spec.armor or {}) do
      local i = ARMOR_NAMES[k] or tonumber(k)
      if i and i >= 100 then i = i - 100 end
      if i then p.armor[i] = normStack(v) end
    end
    return p
  end

  local saved = type(core.savedState) == "table" and type(core.savedState.peripherals) == "table" and core.savedState.peripherals
  for _, s in pairs(saved or {}) do
    if type(s) == "table" and type(s.player) == "table" and type(s.player.name) == "string" and not players[s.player.name] then
      players[s.player.name] = fromSpec(s.player)
    end
  end

  local function playerInv(name)
    local p = players[name]
    if not p then
      p = fromSpec(((core.world.ap or {}).players or {})[name])
      players[name] = p
    end
    return p
  end

  local function invSnapshot(name)
    local p = playerInv(name)
    local out = { name = name, inventory = {}, armor = {}, selected = p.selected, offhand = p.offhand and B.copy(p.offhand) or nil }
    for i, it in pairs(p.items) do out.inventory[tostring(i)] = B.copy(it) end
    for i, it in pairs(p.armor) do out.armor[tostring(i)] = B.copy(it) end
    return out
  end

  local function displayName(item)
    return item.displayName or data().displayName(item.name)
  end

  local function maxStack(item)
    return item.maxCount or itemsData().maxCount(item.name)
  end

  --- ItemUtil.getFingerprint: md5(tag + registry name + ItemStack.getDisplayName(), which wraps the name in [ ])
  local function fingerprint(item)
    if item.fingerprint then return item.fingerprint end
    local nbt = item.nbtString or (type(item.nbt) ~= "table" and "{}" or textutils.serialize(item.nbt, { compact = true }))
    return B.md5(nbt .. item.name .. "[" .. displayName(item) .. "]")
  end

  --- LuaConverter.stackToObjectWithSlot (stackToObject when slot is nil). An empty stack is {}.
  local function stackObject(item, slot)
    if not item then return {} end
    return {
      name = item.name,
      tags = tagList("item", item.name, item.tags),
      count = item.count,
      displayName = "[" .. displayName(item) .. "]",
      maxStackSize = maxStack(item),
      nbt = type(item.nbt) == "table" and B.copy(item.nbt) or {},
      slot = slot,
    }
  end

  --- Mob.getEquipmentSlotForItem, from the item name (or `equipSlot` on a fixture item); nil for the main hand.
  local function equipSlotOf(item)
    if item.equipSlot then return item.equipSlot end
    local n = item.name
    if n:match("_helmet$") then return "head" end
    if n:match("_chestplate$") then return "chest" end
    if n:match("_leggings$") then return "legs" end
    if n:match("_boots$") then return "feet" end
    if n == "minecraft:elytra" then return "chest" end
    if n == "minecraft:carved_pumpkin" or n:match("_head$") or n:match("_skull$") then return "head" end
    return nil
  end

  local function isArmorItem(item)
    if item.armorItem ~= nil then return item.armorItem end
    return item.name:match("_helmet$") or item.name:match("_chestplate$") or item.name:match("_leggings$")
      or item.name:match("_boots$")
  end

  local function sameStack(a, b)
    return a.name == b.name and B.deepEqual(a.nbt, b.nbt) and (a.damage or 0) == (b.damage or 0)
      and a.displayName == b.displayName
  end

  local function copyCount(item, n)
    local c = B.copy(item)
    c.count = n
    return c
  end

  --- An IItemHandler over slot storage `get(i)`/`set(i, item)`, 0-based. `canPlace(i, item)` for the armour wrapper;
  --- `outOfRange(i)` is what a bad slot does (an exception for a chest, nothing for a ranged wrapper).
  local function handler(n, get, set, opts)
    opts = opts or {}
    local h = { n = n }
    local function check(i)
      if i < 0 or i >= n then
        if opts.outOfRange then opts.outOfRange(i) end
        return false
      end
      return true
    end
    function h.get(i)
      if not check(i) then return nil end
      return get(i)
    end
    --- InvWrapper.insertItem: returns the remainder (nil when all went in)
    function h.insert(i, stack)
      if not stack then return nil end
      if not check(i) then return stack end
      if opts.canPlace and not opts.canPlace(i, stack) then return stack end
      local here = get(i)
      local limit = 64
      if here then
        if here.count >= math.min(maxStack(here), limit) then return stack end
        if not sameStack(here, stack) then return stack end
        local room = math.min(maxStack(stack), limit) - here.count
        if stack.count <= room then
          here.count = here.count + stack.count
          set(i, here)
          return nil
        end
        here.count = here.count + room
        set(i, here)
        return copyCount(stack, stack.count - room)
      end
      local room = math.min(maxStack(stack), limit)
      if room < stack.count then
        set(i, copyCount(stack, room))
        return copyCount(stack, stack.count - room)
      end
      set(i, copyCount(stack, stack.count))
      return nil
    end
    --- InvWrapper.extractItem
    function h.extract(i, amount, simulate)
      if amount <= 0 then return nil end
      if not check(i) then return nil end
      local here = get(i)
      if not here then return nil end
      local n2 = math.min(here.count, amount)
      if simulate then return copyCount(here, n2) end
      local out = copyCount(here, n2)
      here.count = here.count - n2
      set(i, here.count > 0 and here or nil)
      return out
    end
    return h
  end

  --- CombinedInvWrapper: slots run through the parts in order; a slot past them all is an EmptyHandler.
  local function combined(parts)
    local total = 0
    for _, p in ipairs(parts) do total = total + p.n end
    local function find(i)
      local base = 0
      for _, p in ipairs(parts) do
        if i >= base and i < base + p.n then return p, i - base end
        base = base + p.n
      end
      return nil
    end
    return {
      n = total,
      get = function(i) local p, j = find(i) return p and p.get(j) or nil end,
      insert = function(i, stack) local p, j = find(i) if not p then return stack end return p.insert(j, stack) end,
      extract = function(i, amount, simulate) local p, j = find(i) if not p then return nil end return p.extract(j, amount, simulate) end,
    }
  end

  local EQUIP_INDEX = { feet = 0, legs = 1, chest = 2, head = 3 }

  local function playerHandlers(p)
    local main = handler(36, function(i) return p.items[i] end, function(i, v) p.items[i] = v core.dirty = true end)
    local armor = handler(4, function(i) return p.armor[i] end, function(i, v) p.armor[i] = v core.dirty = true end, {
      canPlace = function(i, stack) return EQUIP_INDEX[equipSlotOf(stack) or ""] == i end,
    })
    local offhand = handler(1, function() return p.offhand end, function(_, v) p.offhand = v core.dirty = true end)
    return main, armor, offhand, combined({ main, armor, offhand })
  end

  --- ItemHandlerHelper.insertItem: every slot in order, empty or not, until nothing is left
  local function insertAny(h, stack)
    for i = 0, h.n - 1 do
      stack = h.insert(i, stack)
      if not stack then return nil end
    end
    return stack
  end

  -- ----- ItemFilter -----

  local function truncate(v) return v >= 0 and floor(v) or -floor(-v) end

  --- ItemFilter.parse: filter, or nil and the error code
  local function parseFilter(map)
    local f = { count = 64, fingerprint = "", fromSlot = -1, toSlot = -1 }
    if next(map) == nil then return f end
    if map.name ~= nil then
      if type(map.name) ~= "string" then return nil, "NO_VALID_ITEM" end
      if map.name:sub(1, 1) == "#" then
        f.tag = map.name:sub(2)
        if not f.tag:find(":", 1, true) then f.tag = "minecraft:" .. f.tag end
      else
        local ok = map.name:match("^[a-z0-9_.%-]*:?[a-z0-9_./%-]+$")
        local id = ok and (map.name:find(":", 1, true) and map.name or ("minecraft:" .. map.name))
        if not id or not data().isItem(id) then return nil, "ITEM_NOT_FOUND" end
        if id ~= "minecraft:air" then f.item = id end
      end
    end
    if map.nbt ~= nil then
      if type(map.nbt) == "string" then
        f.nbt = B.snbt(map.nbt) -- TagParser: text that does not parse gives no NBT filter at all
        if type(f.nbt) ~= "table" then f.nbt = nil end
      elseif type(map.nbt) == "table" then
        -- the table's Java toString() is parsed: only an empty table ("{}") is valid SNBT
        if next(map.nbt) == nil then f.nbt = {} end
      else
        return nil, "NO_VALID_NBT"
      end
    end
    if map.fingerprint ~= nil then
      if type(map.fingerprint) ~= "string" then return nil, "NO_VALID_FINGERPRINT" end
      f.fingerprint = map.fingerprint
    end
    for _, key in ipairs({ "fromSlot", "toSlot", "count" }) do
      if map[key] ~= nil then
        if type(map[key]) ~= "number" or map[key] ~= map[key] or math.abs(map[key]) == math.huge then
          return nil, "NO_VALID_" .. key:upper()
        end
        f[key] = truncate(map[key])
      end
    end
    return f
  end

  local function hasItemTag(item, tag)
    if type(item.tags) == "table" then
      for _, t in ipairs(item.tags) do if t == tag or t == "minecraft:item/" .. tag then return true end end
      return false
    end
    return data().itemHasTag(item.name, tag)
  end

  --- ItemFilter.test. An empty slot is ItemStack.EMPTY: an empty filter accepts it, and so does every slot.
  local function filterTest(f, item)
    if f.fingerprint ~= "" then return item ~= nil and fingerprint(item) == f.fingerprint end
    if f.item and not f.tag and not f.nbt then return item ~= nil and item.name == f.item end
    if f.tag and (item == nil or not hasItemTag(item, f.tag)) then return false end
    if f.nbt then
      local tag = item and type(item.nbt) == "table" and item.nbt or {}
      if not B.deepEqual(tag, f.nbt) then return false end
    end
    return true
  end

  --- InventoryUtil.moveItem, line for line (the `amount -= remainder` quirk included)
  local function moveItem(from, to, f)
    if not from then return 0 end
    local fromSlot, toSlot = f.fromSlot, f.toSlot
    local amount, moved = f.count, 0
    local first = fromSlot == -1 and 0 or fromSlot
    local stop = fromSlot == -1 and from.n or fromSlot + 1
    for i = first, stop - 1 do
      if filterTest(f, from.get(i)) then
        local extracted = from.extract(i, amount - moved, true)
        local remainder
        if toSlot == -1 then remainder = insertAny(to, extracted) else remainder = to.insert(toSlot, extracted) end
        local rest = remainder and remainder.count or 0
        amount = amount - rest
        local taken = from.extract(i, (extracted and extracted.count or 0) - rest, false)
        moved = moved + (taken and taken.count or 0)
        if moved >= f.count then break end
      end
    end
    return moved
  end

  function F.inventoryManager(def)
    local self = B.new(def)
    local m = self.methods
    self.computerThread = { getName = true, getConfiguration = true, getOwner = true }
    local card = def.owner -- the name bound to the memory card in the manager; nil: no card, or an unbound one

    --- InventoryManagerEntity.getOwnerPlayer: the online player whose name is exactly the card's
    local function ownerPlayer()
      if type(card) ~= "string" then return nil end
      for _, p in ipairs(core.players) do
        if p.online and p.name == card then return p end
      end
      return nil
    end

    local function owner()
      local p = ownerPlayer()
      if not p then error("The Inventory Manager doesn't have a memory card or it isn't bound to a player.", 0) end
      return p
    end

    --- getHandlerFromSlot: 100-103 the armour, 36 the off hand, anything else the whole player inventory
    local function playerHandlerFor(slot)
      local p = playerInv(owner().name)
      local _, armor, offhand, all = playerHandlers(p)
      if slot >= 100 and slot <= 103 then return armor, slot - 100 end
      if slot == 36 then return offhand, 0 end
      return all, slot
    end

    --- The block's item handler on that side: `adjacent` on the fixture names a chest in `peripherals`, else the
    --- container beside the manager in the block world. nil when there is none.
    local function chestHandler(dir, side)
      local adj = def.adjacent or {}
      local name = adj[side:lower()] or adj[dir]
      local inv, onChange
      if name then
        local entry = core.peripherals[name]
        inv = entry and entry.inventory
      else
        local get = lookup(def)
        if get then
          local x, y, z = blockPos(def)
          local s = STEP[dir]
          x, y, z = x + s[1], y + s[2], z + s[3]
          local b = get(x, y, z)
          if b and core.turtle then
            inv = core.turtle.inventoryOf(b)
            if inv then onChange = function() core.turtle.share(x, y, z) end end
          elseif b and b.def and (b.def.items or b.def.size) then
            b.inventory = b.inventory or core.newInventory({ name = b.name, size = b.def.size, items = b.def.items })
            inv = b.inventory
          end
        end
      end
      if not inv then return nil end
      local items = inv.__state()
      return handler(inv.size(), function(i) return items[i + 1] end, function(i, v)
        items[i + 1] = v
        core.dirty = true
        if onChange then onChange() end
      end, { outOfRange = function(i) javaIndex(i, inv.size()) end })
    end

    local function itemFilter(map)
      local f, err = parseFilter(map)
      return f, err
    end

    local function addItemCommon(invDirection, f)
      local dir = validateSide(def, invDirection)
      local from = chestHandler(dir, invDirection)
      local to, slot = playerHandlerFor(f.toSlot)
      f.toSlot = slot
      return moveItem(from, to, f)
    end

    local function removeItemCommon(invDirection, f)
      local dir = validateSide(def, invDirection)
      local from, slot = playerHandlerFor(f.fromSlot)
      local to = chestHandler(dir, invDirection)
      if not to then return 0, "INVENTORY_TO_INVALID" end
      f.fromSlot = slot
      return moveItem(from, to, f)
    end

    function m.getOwner()
      local p = ownerPlayer()
      return p and p.name or nil
    end

    -- the deprecated forms: `slot` becomes toSlot, `item` the name
    local function deprecated(common)
      return function(invDirection, count, slot, item)
        invDirection = B.string(1, invDirection)
        count = B.int(2, count)
        slot = B.optInt(3, slot)
        item = B.optString(4, item)
        local map = { count = count }
        if item ~= nil then map.name = item end
        if slot ~= nil then map.toSlot = slot end
        local f, err = itemFilter(map)
        if not f then return 0, err end
        return common(invDirection, f)
      end
    end

    local function withNbt(common, two)
      return function(invDirection, count, slot, item)
        invDirection = B.string(1, invDirection)
        count = B.int(2, count)
        slot = B.optInt(3, slot)
        if item ~= nil then B.table(4, item) end
        local map = { count = count }
        if slot ~= nil then map.toSlot = slot end
        for k, v in pairs(item or {}) do map[k] = v end -- putAll: the item's own count wins
        local f, err = itemFilter(map)
        if not f then return 0, err end
        local moved, msg = common(invDirection, f)
        if two then return moved, nil end
        return moved, msg
      end
    end

    m.addItemToPlayer = deprecated(function(d, f) return addItemCommon(d, f) end)
    m.pullItems = m.addItemToPlayer
    m.addItemToPlayerNBT = withNbt(function(d, f) return addItemCommon(d, f) end, true)
    m.removeItemFromPlayer = deprecated(removeItemCommon)
    m.pushItems = m.removeItemFromPlayer
    m.removeItemFromPlayerNBT = withNbt(removeItemCommon)

    function m.getItems()
      local p = playerInv(owner().name)
      local out = {}
      for i = 0, 35 do
        if p.items[i] then out[#out + 1] = stackObject(p.items[i], i) end
      end
      return out
    end
    m.list = m.getItems

    function m.getItemsChest(target)
      target = B.string(1, target)
      local dir = validateSide(def, target)
      local h = chestHandler(dir, target)
      if not h then return nil, "INVENTORY_TO_INVALID" end
      local out = {}
      for i = 0, h.n - 1 do
        local it = h.get(i)
        if it then out[#out + 1] = stackObject(it, i) end
      end
      return out
    end
    m.listChest = m.getItemsChest

    function m.getArmor()
      local p = playerInv(owner().name)
      local out = {}
      for i = 0, 3 do
        local it = p.armor[i]
        if it then
          local slot = 0 -- ArmorSlot.getSlotForItem: a worn item that is no ArmorItem (a pumpkin, an elytra) is slot 0
          if isArmorItem(it) then slot = 100 + (EQUIP_INDEX[equipSlotOf(it) or ""] or -100) end
          if slot < 100 then slot = 0 end
          out[#out + 1] = stackObject(it, slot)
        end
      end
      return out
    end

    function m.isPlayerEquipped()
      local p = playerInv(owner().name)
      for i = 0, 3 do if p.armor[i] then return true end end
      return false
    end

    --- As the source has it: `index == i - 100` with i counting worn pieces from 0, so only -100 .. -97 can be true
    function m.isWearing(index)
      index = B.int(1, index)
      local p = playerInv(owner().name)
      local i = 0
      for s = 0, 3 do
        if p.armor[s] then
          if index == i - 100 then return true end
          i = i + 1
        end
      end
      return false
    end

    function m.getEmptySpace()
      local p = playerInv(owner().name)
      local n = 0
      for i = 0, 35 do if not p.items[i] then n = n + 1 end end
      return n
    end

    function m.isSpaceAvailable() return m.getEmptySpace() > 0 end

    function m.getFreeSlot()
      local p = playerInv(owner().name)
      for i = 0, 35 do if not p.items[i] then return i end end
      return -1
    end

    function m.getItemInHand()
      local p = playerInv(owner().name)
      return stackObject(p.items[p.selected or 0])
    end

    function m.getItemInOffHand()
      local p = playerInv(owner().name)
      return stackObject(p.offhand)
    end

    function self.state()
      local out = { owner = card }
      local p = ownerPlayer()
      if p then out.player = invSnapshot(p.name) end
      return out
    end
    self.setCard = function(name) card = name end

    return self
  end

  -- ===== chunky turtle =====

  -- Loaded chunks: each chunky upgrade forces the chunk its turtle stands in (ChunkManager.addForceChunk, a Forge
  -- ticket of distance 2), and moves the force when the turtle changes chunk (updateChunkState, every turtle tick).
  local chunkies = {}

  local function attached(self)
    local entry = core.peripherals[self.def.name]
    return entry ~= nil and entry.ap == self
  end

  local function loadedChunk(self)
    if not attached(self) then return nil end
    return { x = floor(core.position.x / 16), z = floor(core.position.z / 16), dimension = core.position.dimension or "minecraft:overworld" }
  end

  --- A chunk within two of a forced one is loaded: the ticket's level is 31, and chunks up to level 33 are loaded.
  function core.forcedChunkNear(cx, cz, dimension)
    for _, self in ipairs(chunkies) do
      local c = loadedChunk(self)
      if c and c.dimension == (dimension or "minecraft:overworld") and math.abs(c.x - cx) <= 2 and math.abs(c.z - cz) <= 2 then
        return true
      end
    end
    return false
  end

  function F.chunky(def)
    local self = B.new(def)
    self.def = def
    function self.methods.getName() return nil end -- TurtlePeripheralOwner.getCustomName
    self.computerThread = { getName = true, getConfiguration = true }
    chunkies[#chunkies + 1] = self
    function self.state() return { loadedChunk = loadedChunk(self) } end
    return self
  end

  -- What the turtle can equip and the blocks that are these peripherals when placed (turtle/brain.lua reads both)
  core.turtleUpgrades = core.turtleUpgrades or {}
  core.turtleUpgrades["advancedperipherals:geo_scanner"] = { peripheral = "geoScanner" }
  core.turtleUpgrades["advancedperipherals:chunk_controller"] = { peripheral = "chunky" }
  core.blockPeripherals = core.blockPeripherals or {}
  core.blockPeripherals["advancedperipherals:geo_scanner"] = "geoScanner"
  core.blockPeripherals["advancedperipherals:block_reader"] = "blockReader"
  core.blockPeripherals["advancedperipherals:inventory_manager"] = "inventoryManager"

  -- ===== sim commands =====

  core.extraHandlers = core.extraHandlers or {}

  --- setPlayerItem { player, slot, item|null }: slot 0-35 the inventory, 36 the off hand, 100-103 boots to helmet.
  --- { player, selected } picks the held hotbar slot (0-8).
  core.extraHandlers.setPlayerItem = function(cmd)
    if type(cmd.player) ~= "string" then return false, "setPlayerItem needs player" end
    local p = playerInv(cmd.player)
    if cmd.selected ~= nil then
      if type(cmd.selected) ~= "number" or cmd.selected < 0 or cmd.selected > 8 then return false, "selected is 0-8" end
      p.selected = floor(cmd.selected)
    end
    if cmd.slot ~= nil then
      local slot = tonumber(cmd.slot)
      local item = cmd.item ~= nil and normStack(cmd.item) or nil
      if slot and slot >= 0 and slot <= 35 then p.items[slot] = item
      elseif slot == 36 then p.offhand = item
      elseif slot and slot >= 100 and slot <= 103 then p.armor[slot - 100] = item
      else return false, "slot is 0-35, 36 or 100-103" end
    end
    core.dirty = true
    return true
  end

  --- setMemoryCard { peripheral, owner|null }: bind the manager's card to a player name, or take it out.
  core.extraHandlers.setMemoryCard = function(cmd)
    local entry = core.peripherals[cmd.peripheral]
    if not entry or not entry.ap or not entry.ap.setCard then return false, "no such inventory manager" end
    entry.ap.setCard(type(cmd.owner) == "string" and cmd.owner or nil)
    core.dirty = true
    return true
  end

  return F
end
