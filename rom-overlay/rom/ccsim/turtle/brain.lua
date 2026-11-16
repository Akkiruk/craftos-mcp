-- ccsim turtle brain: a CC:Tweaked 1.101.3 turtle, written from its source (docs/turtle/cct-1.101.3-turtle-rules.md
-- has every rule with its Java line). Section numbers below ("spec 3.2") point into that file.
--
-- The turtle lives in the block world of ccsim/turtle/world.lua. Commands go through the real command queue: one
-- runs per server tick (a 0.05 s timer on the computer's own clock, so time-scaled runs stay right), a command with
-- an animation holds the next one back 8 ticks, and the call returns through a turtle_response event.
return function(core)
  local M = {}
  -- A turtle, or a computer block standing in the world (`placed`: { x, y, z, facing, block })
  local isTurtle = type(core.world.turtle) == "table"
  local placed = core.world.placed
  local spec = core.world.turtle or placed or {}
  M.isTurtle = isTurtle
  local floor, min, max = math.floor, math.min, math.max

  local data = dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData)
  local items = dofile("/rom/ccsim/turtle/items.lua")(data, core.world.gameData)
  local rules = dofile("/rom/ccsim/turtle/rules.lua")(data, core.world.gameData)
  local loot = dofile("/rom/ccsim/turtle/loot.lua")(data)
  local world = dofile("/rom/ccsim/turtle/world.lua")(core, data)
  local NBT = dofile("/rom/ccsim/turtle/nbt.lua")()
  local function nbtHash(value)
    local ok, hash = pcall(NBT.hash, value)
    if ok then return hash end
    return NBT.md5(tostring(value)) -- a tag the SNBT reader does not take: still one hash per text
  end
  M.data, M.items, M.rules, M.world = data, items, rules, world
  core.gameData = data

  local STEP, OPP, LEFT, RIGHT = world.STEP, world.OPPOSITE, world.LEFT, world.RIGHT
  local cfg = core.world.turtleConfig or {}
  local needsFuel = cfg.needFuel ~= false
  local turtlesCanPush = cfg.canPush ~= false
  local obeyProtection = cfg.obeyBlockProtection ~= false
  local advanced = spec.advanced == true
  local fuelLimit = advanced and (cfg.advancedFuelLimit or 100000) or (cfg.normalFuelLimit or 20000)
  local TURTLE_BLOCK = (placed and placed.block) or (advanced and "computercraft:turtle_advanced" or "computercraft:turtle_normal")

  -- ===== state =====

  local t = {
    facing = spec.facing or "north",
    fuel = spec.fuel or 0,
    selected = spec.selected or 1,
    slots = {},
    left = spec.left and data.id(spec.left) or nil,
    right = spec.right and data.id(spec.right) or nil,
  }
  for key in pairs({ x = 1, y = 1, z = 1, dimension = 1 }) do
    if spec[key] ~= nil then core.position[key] = spec[key] end
  end
  local pos = core.position

  local function normItem(def)
    if type(def) ~= "table" or not def.name then return nil end
    local item = {}
    for k, v in pairs(def) do item[k] = v end
    item.name = data.id(def.name)
    item.count = def.count or 1
    if item.count <= 0 then return nil end
    -- a tag given in full (a table or SNBT) is carried as its hash, as getItemDetail shows it
    if type(item.nbt) == "table" or (type(item.nbt) == "string" and item.nbt:match("^%s*{")) then
      item.nbt = nbtHash(item.nbt)
    end
    return item
  end
  M.normItem = normItem
  for key, def in pairs(spec.inventory or {}) do
    local slot = tonumber(key)
    if slot and slot >= 1 and slot <= 16 then t.slots[slot] = normItem(def) end
  end

  world.load(core.world)
  -- a placed turtle's world has its own block where it was turned on: the turtle carries that block with it
  if isTurtle and spec.x and spec.y and spec.z then world.forget(spec.x, spec.y, spec.z) end
  local saved = core.savedState
  if type(saved) == "table" then
    if type(saved.turtle) == "table" then
      local s = saved.turtle
      t.facing, t.fuel, t.selected = s.facing or t.facing, s.fuel or t.fuel, s.selected or t.selected
      t.left, t.right = s.left, s.right
      t.slots = {}
      for key, def in pairs(s.slots or {}) do t.slots[tonumber(key)] = normItem(def) end
      pos.x, pos.y, pos.z = s.x or pos.x, s.y or pos.y, s.z or pos.z
      pos.dimension = s.dimension or pos.dimension
    end
    world.restore(saved.blocks)
  end
  if isTurtle then world.forget(pos.x, pos.y, pos.z) end

  function core.turtleState()
    local slots = {}
    for i = 1, 16 do if t.slots[i] then slots[tostring(i)] = t.slots[i] end end
    return {
      x = pos.x, y = pos.y, z = pos.z, dimension = pos.dimension, facing = t.facing,
      fuel = t.fuel, selected = t.selected, slots = slots, left = t.left, right = t.right,
    }
  end
  core.blockState = world.state
  function core.droppedItemState()
    local list = world.itemEntityState()
    return #list > 0 and list or nil
  end

  -- ===== helpers =====

  local function isTurtleAt(x, y, z) return x == pos.x and y == pos.y and z == pos.z end
  local turtleBlock = { name = TURTLE_BLOCK, state = {} }
  local function blockAt(x, y, z)
    if isTurtleAt(x, y, z) then
      turtleBlock.state.facing = t.facing
      local be = turtleBlock.blockEntity
      if be and isTurtle then
        -- what a dug turtle keeps on its item (TileTurtle, TurtleItemFactory)
        be.Fuel, be.LeftUpgrade, be.RightUpgrade = t.fuel, t.left, t.right
      end
      return turtleBlock
    end
    return world.get(x, y, z)
  end
  M.blockAt = blockAt

  -- ===== protection, the world border and loaded chunks (spec 3.2 step 1) =====

  --- DedicatedServer.isUnderSpawnProtection, asked by TurtlePermissions when obey_block_protection is on. The world
  --- sets it with `spawnProtection = { radius, spawn = { x, z }, ops, ownerOp }`: off with no ops on the server or when
  --- the turtle's owner is one, and only in the overworld.
  local function isProtected(x, y, z)
    local sp = core.world.spawnProtection
    if not obeyProtection or type(sp) ~= "table" then return false end
    if (pos.dimension or "minecraft:overworld") ~= "minecraft:overworld" then return false end
    if sp.ops == false or sp.ownerOp == true then return false end
    local radius = sp.radius or 16
    if radius <= 0 then return false end
    local spawn = sp.spawn or {}
    return max(math.abs(x - (spawn.x or 0)), math.abs(z - (spawn.z or 0))) <= radius
  end
  M.isProtected = isProtected

  local function inChunks(list, cx, cz)
    for _, r in ipairs(list) do
      local a = r.from or r
      local b = r.to or a
      local x1, z1, x2, z2 = a[1] or a.x, a[2] or a.z, b[1] or b.x, b[2] or b.z
      if cx >= min(x1, x2) and cx <= max(x1, x2) and cz >= min(z1, z2) and cz <= max(z1, z2) then return true end
    end
    return false
  end

  --- Level.isLoaded: `loadedChunks` lists the only chunks that are loaded, `unloadedChunks` ones that are not
  --- (chunk coordinates, `[cx, cz]` or `{ from = [cx, cz], to = [cx, cz] }`).
  local function chunkLoaded(x, z)
    local cx, cz = floor(x / 16), floor(z / 16)
    local loaded, unloaded = core.world.loadedChunks, core.world.unloadedChunks
    if type(loaded) == "table" and not inChunks(loaded, cx, cz) then return false end
    if type(unloaded) == "table" and inChunks(unloaded, cx, cz) then return false end
    return true
  end

  --- WorldBorder.isWithinBounds for `worldBorder = { center = { x, z }, size }` (vanilla's is 59999968 wide).
  local function inBorder(x, z)
    local b = core.world.worldBorder
    if type(b) ~= "table" or not b.size then return true end
    local c = b.center or {}
    local cx, cz = c.x or c[1] or 0, c.z or c[2] or 0
    local half = b.size / 2
    return x + 1 > cx - half and x < cx + half and z + 1 > cz - half and z < cz + half
  end

  local function dirOf(interact) -- "forward" | "up" | "down" -> world direction
    if interact == "up" or interact == "down" then return interact end
    return t.facing
  end

  -- Server ticks fall on a fixed 50 ms grid from boot, as the server's own loop does: a command issued between two
  -- ticks runs at the next one, however long the computer took to issue it
  local tickZero = os.clock()
  local function nowTick() return floor((os.clock() - tickZero) * 20 + 1e-6) end
  M.nowTick = nowTick

  -- ===== items in the turtle (spec 6) =====

  local function maxOf(item) return min(item.maxCount or items.maxCount(item.name), 64) end
  local function same(a, b) return a.name == b.name and a.nbt == b.nbt and a.displayName == b.displayName and a.damage == b.damage end
  M.same = same

  local function copy(item, count)
    local c = {}
    for k, v in pairs(item) do c[k] = v end
    c.count = count or item.count
    return c
  end

  --- InventoryUtil.storeItems over the turtle, slots begin..16 then 1..begin-1. Returns what did not fit (nil: all).
  local function storeItems(stack, begin)
    local left = stack.count
    for i = 0, 15 do
      local slot = (begin - 1 + i) % 16 + 1
      local here = t.slots[slot]
      if not here then
        local n = min(left, maxOf(stack))
        t.slots[slot] = copy(stack, n)
        left = left - n
      elseif same(here, stack) and here.count < maxOf(here) then
        local n = min(left, maxOf(here) - here.count)
        here.count = here.count + n
        left = left - n
      end
      if left <= 0 then return nil end
    end
    return copy(stack, left)
  end
  M.storeItems = storeItems

  --- Take up to `count` from one slot (capped at the item's stack size).
  local function takeFrom(slot, count)
    local item = t.slots[slot]
    if not item or count <= 0 then return nil end
    local n = min(count, item.count, maxOf(item))
    local out = copy(item, n)
    item.count = item.count - n
    if item.count <= 0 then t.slots[slot] = nil end
    return out
  end

  --- Put items back into one slot only (transferTo's remainder).
  local function putBack(slot, stack)
    local here = t.slots[slot]
    if not here then t.slots[slot] = stack return nil end
    if same(here, stack) then
      local n = min(stack.count, maxOf(here) - here.count)
      here.count = here.count + n
      if stack.count - n > 0 then return copy(stack, stack.count - n) end
      return nil
    end
    return stack
  end

  local function snapshot()
    local parts = {}
    for i = 1, 16 do
      local s = t.slots[i]
      parts[i] = s and (s.name .. "#" .. s.count .. "#" .. tostring(s.nbt) .. "#" .. tostring(s.damage)) or "-"
    end
    return table.concat(parts, "|")
  end
  local lastSnapshot = snapshot()

  -- ===== dropped items (WorldUtil.dropItemStack) =====

  --- Throw a stack from a point with a velocity, and let it come to rest the way an ItemEntity does: gravity 0.04,
  --- drag 0.98, ground friction 0.6 x 0.98, stopped by blocks with a collision shape.
  local function throw(px, py, pz, vx, vy, vz, stack)
    local function solidAt(x, y, z)
      local b = blockAt(floor(x), floor(y), floor(z))
      return b ~= nil and rules.hasCollision(b)
    end
    for _ = 1, 200 do
      vy = vy - 0.04
      local nx, ny, nz = px + vx, py + vy, pz + vz
      if solidAt(nx, py, pz) then vx = 0 nx = px end
      if solidAt(nx, py, nz) then vz = 0 nz = pz end
      local onGround = false
      if solidAt(nx, ny, nz) then
        ny = floor(py) -- rests on the block below
        if vy < 0 then onGround = true end
        vy = 0
      end
      px, py, pz = nx, ny, nz
      local lo = world.limits(pos.dimension)
      if py < lo - 64 then return end -- fell out of the world
      local f = onGround and 0.6 * 0.98 or 0.98
      vx, vz, vy = vx * f, vz * f, vy * 0.98
      if onGround and math.abs(vx) < 0.003 and math.abs(vz) < 0.003 then break end
    end
    world.dropItem(floor(px), floor(py), floor(pz), stack)
  end

  local function jitter() return (math.random() * 0.2 - 0.1) end

  --- WorldUtil.dropItemStack(stack, world, turtle pos, direction): from turtle centre + 0.4 x dir, velocity dir x 0.7
  local function dropFromTurtle(stack, dir)
    local s = dir and STEP[dir] or { 0, 0, 0 }
    throw(pos.x + 0.5 + s[1] * 0.4, pos.y + 0.5 + s[2] * 0.4, pos.z + 0.5 + s[3] * 0.4,
      s[1] * 0.7 + jitter(), s[2] * 0.7 + jitter(), s[3] * 0.7 + jitter(), stack)
  end
  M.dropFromTurtle = dropFromTurtle

  --- Store into the turtle from the selected slot; what does not fit is thrown behind it (spec 4.4).
  local function capture(stacks)
    for _, stack in ipairs(stacks) do
      local rest = storeItems(stack, t.selected)
      if rest then dropFromTurtle(rest, OPP[t.facing]) end
    end
  end

  -- ===== inventories in the world (spec 6.2) =====

  local CONTAINER_SIZE = {
    ["minecraft:chest"] = 27, ["minecraft:trapped_chest"] = 27, ["minecraft:barrel"] = 27, ["minecraft:hopper"] = 5,
    ["minecraft:dispenser"] = 9, ["minecraft:dropper"] = 9, ["minecraft:furnace"] = 3, ["minecraft:blast_furnace"] = 3,
    ["minecraft:smoker"] = 3, ["minecraft:brewing_stand"] = 5,
    ["computercraft:disk_drive"] = 1, -- TileDiskDrive: one slot, which a turtle drops a disk into
  }
  local FURNACES = { ["minecraft:furnace"] = true, ["minecraft:blast_furnace"] = true, ["minecraft:smoker"] = true }

  local function containerSize(block)
    if block.def and block.def.size then return block.def.size end
    if CONTAINER_SIZE[block.name] then return CONTAINER_SIZE[block.name] end
    if block.name:find("shulker_box$") then return 27 end
    if block.def and block.def.items then return 27 end
    return nil
  end

  local function inventoryOf(block)
    if not block or block == turtleBlock then return nil end
    if block.inventory then return block.inventory end
    local size = containerSize(block)
    if not size then return nil end
    block.inventory = core.newInventory({ name = block.name, size = size, items = block.def and block.def.items or block.contents })
    return block.inventory
  end
  M.inventoryOf = inventoryOf

  -- WorldlyContainer faces of a furnace: top reaches the input, sides the fuel, the bottom the output
  local function sidedSlots(block, face)
    if FURNACES[block.name] then
      if face == "up" then return { 1 } elseif face == "down" then return { 3 } else return { 2 } end
    end
    return nil
  end

  --- The inventory a turtle reaches at `x,y,z` from `face` (the face toward the turtle), as slot-level ops.
  local function worldInventory(x, y, z, face)
    local block = blockAt(x, y, z)
    local inv = inventoryOf(block)
    if not inv then return nil end
    local list = sidedSlots(block, face)
    local size = inv.size()
    local slots = list or {}
    if not list then for i = 1, size do slots[i] = i end end
    local stateOf = inv.__state
    return {
      slots = slots,
      get = function(i) return stateOf()[i] end,
      set = function(i, item) stateOf()[i] = item core.dirty = true end,
    }
  end

  local function invInsert(target, stack)
    -- storeItems from slot 0 of the target
    local left = stack.count
    for _, slot in ipairs(target.slots) do
      local here = target.get(slot)
      local limit = min(stack.maxCount or items.maxCount(stack.name), 64)
      if not here then
        local n = min(left, limit)
        target.set(slot, copy(stack, n))
        left = left - n
      elseif same(here, stack) and here.count < limit then
        local n = min(left, limit - here.count)
        here.count = here.count + n
        left = left - n
        core.dirty = true
      end
      if left <= 0 then return nil end
    end
    return copy(stack, left)
  end

  local function invTake(target, count)
    -- takeItems: the first slot with anything decides the item; later slots only if they stack with it
    local taken
    for _, slot in ipairs(target.slots) do
      local here = target.get(slot)
      if here and (not taken or same(here, taken)) then
        if not taken then count = min(count, here.maxCount or items.maxCount(here.name), 64) end
        local n = min(count - (taken and taken.count or 0), here.count)
        if n > 0 then
          if taken then taken.count = taken.count + n else taken = copy(here, n) end
          here.count = here.count - n
          if here.count <= 0 then target.set(slot, nil) else core.dirty = true end
        end
        if taken and taken.count >= count then break end
      end
    end
    return taken
  end

  -- ===== peripherals on the turtle's sides (spec 9.2) =====

  local UPGRADES = {
    ["computercraft:wireless_modem_normal"] = { type = "modem", kind = "wireless" },
    ["computercraft:wireless_modem_advanced"] = { type = "modem", kind = "ender" },
    ["computercraft:speaker"] = { type = "speaker" },
    ["minecraft:crafting_table"] = { type = "workbench" },
  }
  for id in pairs(rules.TOOLS) do UPGRADES[id] = { tool = true } end
  M.UPGRADES = UPGRADES

  local LOCAL_SIDES = { "front", "back", "left", "right", "top", "bottom" }
  local function sideDir(side)
    if side == "front" then return t.facing
    elseif side == "back" then return OPP[t.facing]
    -- a computer's front faces the player, a turtle's faces away, so computers swap left and right (TileComputer)
    elseif side == "left" then return isTurtle and LEFT[t.facing] or RIGHT[t.facing]
    elseif side == "right" then return isTurtle and RIGHT[t.facing] or LEFT[t.facing]
    elseif side == "top" then return "up" end
    return "down"
  end

  -- ===== a shared world: other computers in the same block world (the runner relays the changes) =====

  local networked = core.world.modemLink == true
  local applyingRemote = false

  local function encode(b)
    if not b then return false end
    local out = { name = b.name, state = b.state, blockEntity = b.blockEntity }
    if b.inventory then
      local list = {}
      for slot, item in pairs(b.inventory.__state()) do list[tostring(slot)] = item end
      out.items = list
    elseif b.def and b.def.items then
      out.items = b.def.items
    end
    if b.def and b.def.peripheral then out.peripheral = b.def.peripheral end
    return out
  end

  local sent = {} -- key -> what was last shared, so an unchanged block is not sent again
  local function share(x, y, z)
    if not networked or applyingRemote or not core.sendHost then return end
    local k = world.key(x, y, z)
    local text = textutils.serializeJSON(encode(blockAt(x, y, z)))
    if sent[k] == text then return end
    sent[k] = text
    core.sendHost("W" .. k .. "\t" .. text)
  end
  M.share = share

  --- Chests and drives next to this computer: what is in them changes without the block changing
  local function shareNeighbours()
    if not networked then return end
    for _, d in ipairs({ "north", "south", "east", "west", "up", "down" }) do
      local x, y, z = world.offset(pos.x, pos.y, pos.z, d)
      local b = world.get(x, y, z)
      if b and b.inventory then share(x, y, z) end
    end
  end
  M.shareNeighbours = shareNeighbours

  local lastWorldSeq = 0
  local onScreen -- set below, once the screens are loaded

  function core.onWorld(seq, text)
    -- every coroutine's event loop sees the event: the first one deals with it
    if type(seq) == "number" then
      if seq <= lastWorldSeq then return end
      lastWorldSeq = seq
    end
    applyingRemote = true
    local woke = false
    for line in tostring(text):gmatch("[^\n]+") do
      local k, json = line:match("^([^\t]+)\t(.*)$")
      local x, y, z = (k or ""):match("^(-?%d+),(-?%d+),(-?%d+)$")
      local wall = k and k:match("^screen:(.+)$")
      if wall then
        if onScreen then onScreen(wall, json) end
      elseif x then
        x, y, z = tonumber(x), tonumber(y), tonumber(z)
        local def = textutils.unserializeJSON(json)
        local disk = type(def) == "table" and type(def.items) == "table" and def.items["1"]
        if M.askedDisk[k] and (type(disk) ~= "table" or disk.diskId ~= nil) then
          M.askedDisk[k] = nil -- numbered, or the disk went
          woke = true
        end
        sent[k] = json
        if not (x == pos.x and y == pos.y and z == pos.z) then
          local here = world.get(x, y, z)
          if type(def) == "table" and def.name and here and here.name == def.name and here.inventory and def.items then
            -- the same container with new contents: keep the inventory its peripheral already holds
            local held = here.inventory.__state()
            for slot in pairs(held) do held[slot] = nil end
            for slot, item in pairs(def.items) do held[tonumber(slot)] = item end
            here.state = def.state or here.state
            here.blockEntity = def.blockEntity
            M.peripheralsDirty = true
          elseif type(def) == "table" and def.name then
            local b = world.newBlock(def)
            world.set(x, y, z, b)
          else
            world.set(x, y, z, nil)
          end
        end
      end
    end
    applyingRemote = false
    if M.peripheralsDirty then
      M.peripheralsDirty = false
      M.refreshPeripherals(false)
    end
    if woke then os.queueEvent("ccsim_numbered") end
  end

  --- Wait in the program's coroutine for the host (a disk number). Other events are kept and queued again after.
  local function awaitHost(done, seconds)
    if done() then return end
    local timer = os.startTimer(seconds or 2)
    local kept = {}
    while not done() do
      local ev = table.pack(os.pullEventRaw())
      if ev[1] == "timer" and ev[2] == timer then break end
      if ev[1] ~= "ccsim_numbered" then kept[#kept + 1] = ev end
      if ev[1] == "terminate" then break end
    end
    os.cancelTimer(timer)
    for _, ev in ipairs(kept) do os.queueEvent(table.unpack(ev, 1, ev.n)) end
  end
  M.awaitHost = awaitHost

  local attached = {} -- side -> key of what is attached ("upgrade:<id>" or "block:x,y,z:<name>")
  local craftCommand -- set below

  local function upgradePeripheral(side, id)
    local up = UPGRADES[id]
    if up.type == "modem" then return { name = side, type = "modem", kind = up.kind } end
    if up.type == "speaker" then return { name = side, type = "speaker" } end
    if up.type == "workbench" then
      return { name = side, type = "workbench", __methods = { craft = function(limit) return craftCommand(limit) end } }
    end
  end

  -- ===== monitor walls (TileMonitor and Expander) =====
  -- Every monitor block keeps its place in its wall in its block entity (XIndex, YIndex, Width, Height), as the real
  -- ones do, so all computers see the same walls. A monitor a turtle places joins its neighbours the way Expander
  -- grows a wall; one that is dug splits the rest the way contractNeighbours does.

  local MONITOR_W = cfg.monitorWidth or 8
  local MONITOR_H = cfg.monitorHeight or 6
  local EDGES = { [0] = "none", [1] = "u", [2] = "d", [3] = "ud", [4] = "l", [5] = "lu", [6] = "ld", [7] = "lud", [8] = "r",
    [9] = "ru", [10] = "rd", [11] = "rud", [12] = "lr", [13] = "lru", [14] = "lrd", [15] = "lrud" }

  local function isMonitor(b)
    return b ~= nil and (b.name == "computercraft:monitor_normal" or b.name == "computercraft:monitor_advanced")
  end
  M.isMonitor = isMonitor
  local function wallData(b)
    local e = b.blockEntity or {}
    return tonumber(e.XIndex) or 0, tonumber(e.YIndex) or 0, tonumber(e.Width) or 1, tonumber(e.Height) or 1
  end
  --- getRight and getDown: down is world up on a wall, the far side on a monitor lying flat
  local function wallAxes(b)
    local face, orient = b.state.facing or "north", b.state.orientation or "north"
    local down = orient == "north" and "up" or (orient == "down" and face or OPP[face])
    return LEFT[face], down
  end
  local function compatible(a, b)
    return isMonitor(b) and a.name == b.name and (a.state.facing or "north") == (b.state.facing or "north")
      and (a.state.orientation or "north") == (b.state.orientation or "north")
  end
  local function walk(x, y, z, right, rn, down, dn)
    x, y, z = world.offset(x, y, z, right, rn)
    return world.offset(x, y, z, down, dn)
  end
  --- toWorldPos(ix, iy) of the monitor at x, y, z
  local function wallPos(x, y, z, b, ix, iy)
    local xi, yi = wallData(b)
    local right, down = wallAxes(b)
    return walk(x, y, z, right, ix - xi, down, iy - yi)
  end

  --- TileMonitor.resize, run on the new origin
  local function resizeWall(ox, oy, oz, origin, width, height)
    local right, down = wallAxes(origin)
    for ix = 0, width - 1 do
      for iy = 0, height - 1 do
        local x, y, z = walk(ox, oy, oz, right, ix, down, iy)
        local b = world.get(x, y, z)
        if compatible(origin, b) then
          local be = {}
          for k, v in pairs(b.blockEntity or {}) do be[k] = v end
          be.XIndex, be.YIndex, be.Width, be.Height = ix, iy, width, height
          local state = {}
          for k, v in pairs(b.state) do state[k] = v end
          local flags = (iy < height - 1 and 1 or 0) + (iy > 0 and 2 or 0) + (ix > 0 and 4 or 0) + (ix < width - 1 and 8 or 0)
          state.state = EDGES[flags]
          local nb = world.newBlock({ name = b.name, state = state, blockEntity = be })
          world.set(x, y, z, nb)
        end
      end
    end
  end

  --- Expander.expand from an origin
  local function growWall(ox, oy, oz, origin)
    local _, _, width, height = wallData(origin)
    local right, down = wallAxes(origin)
    local changed = 0
    local function expandIn(useX, positive)
      local offset = positive and (useX and width or height) or -1
      local x, y, z = world.offset(ox, oy, oz, useX and right or down, offset)
      local other = world.get(x, y, z)
      if not compatible(origin, other) then return false end
      local oxi, oyi, ow, oh = wallData(other)
      local w, h = width, height
      if useX then
        if oyi ~= 0 or oh ~= height then return false end
        w = w + ow
        if w > MONITOR_W then return false end
      else
        if oxi ~= 0 or ow ~= width then return false end
        h = h + oh
        if h > MONITOR_H then return false end
      end
      if not positive then
        local nx, ny, nz = wallPos(x, y, z, other, 0, 0)
        local nb = world.get(nx, ny, nz)
        if not compatible(origin, nb) then return false end
        ox, oy, oz, origin = nx, ny, nz, nb
      end
      width, height = w, h
      return true
    end
    while expandIn(true, false) or expandIn(true, true) or expandIn(false, false) or expandIn(false, true) do
      changed = changed + 1
      if changed > MONITOR_W * MONITOR_H + 1 then break end
    end
    if changed > 0 then resizeWall(ox, oy, oz, origin, width, height) end
  end

  --- TileMonitor.expand: the monitor's origin grows its wall
  local function expandAt(x, y, z)
    local b = world.get(x, y, z)
    if not isMonitor(b) then return end
    local ox, oy, oz = wallPos(x, y, z, b, 0, 0)
    local origin = world.get(ox, oy, oz)
    if compatible(b, origin) then
      local xi, yi = wallData(origin)
      if xi == 0 and yi == 0 then growWall(ox, oy, oz, origin) end
    end
  end
  M.expandMonitor = expandAt

  --- TileMonitor.contractNeighbours for a monitor `b` that was at x, y, z and is gone
  local function contractAround(x, y, z, b)
    local xi, yi, w, h = wallData(b)
    if w == 1 and h == 1 then return end
    local right, down = wallAxes(b)
    local ox, oy, oz = walk(x, y, z, right, -xi, down, -yi)
    local grown = {}
    local function tryResizeAt(px, py, pz, rw, rh)
      local m = world.get(px, py, pz)
      if compatible(b, m) then
        resizeWall(px, py, pz, m, rw, rh)
        grown[#grown + 1] = { px, py, pz }
      end
    end
    if xi > 0 then
      local lx, ly, lz = walk(x, y, z, right, -xi, down, 0)
      tryResizeAt(lx, ly, lz, xi, 1)
    end
    if yi > 0 then tryResizeAt(ox, oy, oz, w, yi) end
    if xi < w - 1 then
      local rx, ry, rz = walk(x, y, z, right, 1, down, 0)
      tryResizeAt(rx, ry, rz, w - xi - 1, 1)
    end
    if yi < h - 1 then
      local bx, by, bz = walk(ox, oy, oz, right, 0, down, yi + 1)
      tryResizeAt(bx, by, bz, w, h - yi - 1)
    end
    for _, p in ipairs(grown) do expandAt(p[1], p[2], p[3]) end
  end
  M.contractMonitor = contractAround

  --- The wall a monitor belongs to: its size in blocks and its origin's key, which names the shared screen.
  local function monitorWall(x, y, z, block)
    local _, _, w, h = wallData(block)
    local ox, oy, oz = wallPos(x, y, z, block, 0, 0)
    return w, h, world.key(ox, oy, oz)
  end

  local function computerMethods(x, y, z)
    local methods = {}
    local function be()
      local b = world.get(x, y, z)
      return b and b.blockEntity or {}, b
    end
    local function control(op)
      if core.sendHost then core.sendHost("C" .. textutils.serializeJSON({ op = op, pos = world.key(x, y, z) })) end
    end
    function methods.turnOn() control("turnOn") end
    function methods.shutdown() control("shutdown") end
    function methods.reboot() control("reboot") end
    -- ComputerProxy.getID: a computer that has never been on has no id yet (-1); its first boot gives it one
    function methods.getID() return tonumber(be().ComputerId) or -1 end
    function methods.isOn()
      local _, b = be()
      return b ~= nil and (b.state.state == "on" or b.state.state == "blinking" or (b.blockEntity ~= nil and b.blockEntity.on == true))
    end
    function methods.getLabel() return be().label end
    return methods
  end

  local askedDisk = {} -- drive key -> true while the host numbers the disk in it
  M.askedDisk = askedDisk

  local function diskIdOf(block, x, y, z)
    local inv = inventoryOf(block)
    local item = inv and inv.__state()[1]
    if not item then return nil, nil end
    if item.name ~= "computercraft:disk" and item.name ~= "computercraft:treasure_disk" then return false, item end
    if item.diskId == nil then
      -- ItemDisk.createDataMount: a fresh disk gets the world's next disk number (IDAssigner "disk": 0, 1, 2, ...)
      -- the first time a drive mounts it. The host keeps the one counter every computer shares.
      if networked and core.sendHost and x then
        local k = world.key(x, y, z)
        if not askedDisk[k] then
          askedDisk[k] = true
          share(x, y, z) -- the host must see the disk in the drive first
          core.sendHost("C" .. textutils.serializeJSON({ op = "diskId", pos = k }))
        end
        return nil, item -- mounted when the number comes back
      end
      item.diskId = core.world.nextDiskId or 0
      core.world.nextDiskId = item.diskId + 1
      core.dirty = true
    end
    return item.diskId, item
  end
  M.diskPending = function() return next(askedDisk) ~= nil end

  -- ===== wired modems on blocks: the host works out the network (blockworld.ts) and sends modemTopology =====

  local function cableModemFacing(b)
    if not b or b.name ~= "computercraft:cable" then return nil end
    local m = b.state.modem
    if not m or m == "none" then return nil end
    return m:match("^(%a+)_")
  end
  M.cableModemFacing = cableModemFacing

  local wiredTopology = {} -- modem block key -> what the host last said about it
  local wiredSide = {}     -- modem block key -> the side it is attached on here
  local baseTopology = core.extraHandlers and core.extraHandlers.modemTopology
  if baseTopology then
    -- modems named "@x,y,z" are block modems: give each to the side it is on
    core.extraHandlers.modemTopology = function(cmd)
      local modems = {}
      for name, update in pairs(cmd.modems or {}) do
        local k = type(name) == "string" and name:match("^@(.+)$")
        if k then
          wiredTopology[k] = update
          if wiredSide[k] then modems[wiredSide[k]] = update end
        else
          modems[name] = update
        end
      end
      return baseTopology({ cmd = cmd.cmd, modems = modems })
    end
  end

  --- What a block next to this computer is as a peripheral: a def (and a container), or an engine peripheral.
  local function blockPeripheral(side, block, x, y, z, dir)
    if not block or block == turtleBlock then return nil end
    local n = block.name
    if block.def and type(block.def.peripheral) == "table" then
      local def = {}
      for k, v in pairs(block.def.peripheral) do def[k] = v end
      def.name = side
      return def, nil, "p"
    end
    if n == "computercraft:disk_drive" then
      local id = diskIdOf(block, x, y, z)
      return { name = side, engine = "drive", disk = id }, nil, "d" .. tostring(id)
    end
    if n == "computercraft:monitor_normal" or n == "computercraft:monitor_advanced" then
      -- the same block stays the same peripheral when its wall changes: it resizes (monitor_resize)
      local w, h, wall = monitorWall(x, y, z, block)
      return { name = side, engine = "monitor", w = w, h = h, wall = wall, advanced = n == "computercraft:monitor_advanced" }, nil, "m"
    end
    if (n == "computercraft:cable" and cableModemFacing(block) == OPP[dir]) or n == "computercraft:wired_modem_full" then
      -- a cable's modem is on the face that points at the block it is stuck on; a full modem is on all six
      local k = world.key(x, y, z)
      local known = wiredTopology[k] or {}
      return {
        name = side, type = "modem", kind = "wired", key = core.computerId .. "@" .. k, net = known.net,
        on = known.on == true, localName = known.localName, peers = known.peers or {}, __block = k,
      }, nil, "wired"
    end
    if n:match("^computercraft:computer_") or n:match("^computercraft:turtle_") then
      local kind = n:match("^computercraft:turtle_") and "turtle" or "computer"
      return { name = side, type = kind, __methods = computerMethods(x, y, z) }, nil, "c"
    end
    if n == "computercraft:wireless_modem_normal" or n == "computercraft:wireless_modem_advanced" then
      -- a modem block belongs to the block it is stuck on: its facing points at it
      if block.state.facing ~= OPP[dir] then return nil end
      return { name = side, type = "modem", kind = n:find("advanced") and "ender" or "wireless", x = x, y = y, z = z }, nil, "w"
    end
    if n == "computercraft:speaker" then return { name = side, type = "speaker" }, nil, "s" end
    local inv = inventoryOf(block)
    if inv then return { name = side, type = n }, inv, "i" end
    return nil
  end

  local enginePeripherals = {} -- side -> true when the engine's own peripheral is there
  local monitorShown = {}      -- side -> { w, h, wall } of the monitor wall on it
  local screens = core.periphemu and dofile("/rom/ccsim/turtle/screens.lua")(core)
  M.screens = screens
  onScreen = screens and screens.onLine or nil

  local function attachEngine(def, quiet)
    local pe = core.periphemu
    if not pe then return end
    pe.create(def.name, def.engine)
    enginePeripherals[def.name] = true
    local raw = core.rawPeripheral
    if def.engine == "drive" and def.disk then
      pcall(raw.call, def.name, "insertDisk", def.disk)
    elseif def.engine == "monitor" then
      pcall(raw.call, def.name, "setBlockSize", def.w, def.h)
      monitorShown[def.name] = { w = def.w, h = def.h, wall = def.wall }
      if screens and networked then screens.show(def.name, def.wall, def.advanced) end
    end
  end

  --- A monitor still on its side whose wall grew, shrank or became another one
  local function updateMonitor(def)
    local shown = monitorShown[def.name]
    if not shown or (shown.w == def.w and shown.h == def.h and shown.wall == def.wall) then return end
    local raw = core.rawPeripheral
    local ok, w0, h0 = pcall(raw.call, def.name, "getSize")
    pcall(raw.call, def.name, "setBlockSize", def.w, def.h)
    monitorShown[def.name] = { w = def.w, h = def.h, wall = def.wall }
    if screens and networked then screens.show(def.name, def.wall, def.advanced, true) end
    local ok2, w1, h1 = pcall(raw.call, def.name, "getSize")
    if ok and ok2 and (w0 ~= w1 or h0 ~= h1) then os.queueEvent("monitor_resize", def.name) end
  end

  local function detachEngine(side)
    if core.periphemu and enginePeripherals[side] then
      -- unmount first, so the next drive gets "disk" again as it would in game
      if core.rawPeripheral.getType(side) == "drive" then pcall(core.rawPeripheral.call, side, "ejectDisk") end
      if screens then screens.hide(side) end
      monitorShown[side] = nil
      pcall(core.periphemu.remove, side)
      enginePeripherals[side] = nil
    end
  end

  local function refreshPeripherals(quiet)
    -- every side that changes lets go first, then the new ones attach: a drive that moved from the left to the
    -- front gives its "disk" mount back before it mounts again
    local attach = {}
    for _, side in ipairs(LOCAL_SIDES) do
      local up = (side == "left" and t.left) or (side == "right" and t.right) or nil
      local def, inv, key
      if up and UPGRADES[up] and not UPGRADES[up].tool then
        key = "upgrade:" .. up
        def = upgradePeripheral(side, up)
      else
        local dir = sideDir(side)
        local x, y, z = world.offset(pos.x, pos.y, pos.z, dir)
        local block = blockAt(x, y, z)
        local extra
        def, inv, extra = blockPeripheral(side, block, x, y, z, dir)
        if def then key = "block:" .. world.key(x, y, z) .. ":" .. block.name .. ":" .. tostring(extra) end
      end
      if attached[side] ~= key then
        if attached[side] then
          if enginePeripherals[side] then detachEngine(side) else core.detachSide(side, quiet) end
          for k, s in pairs(wiredSide) do if s == side then wiredSide[k] = nil end end
        end
        attached[side] = key
        if def then attach[#attach + 1] = { def = def, inv = inv } end
      elseif def and def.engine == "monitor" then
        updateMonitor(def)
      end
    end
    for _, a in ipairs(attach) do
      if a.def.engine then attachEngine(a.def, quiet) else core.attachSide(a.def, a.inv, quiet) end
      local k = a.def.__block
      if k then
        wiredSide[k] = a.def.name
        -- what the modem reaches: the remotes come with peripheral events, as the real network attaching them
        if wiredTopology[k] and core.extraHandlers and core.extraHandlers.modemTopology then
          core.extraHandlers.modemTopology({ cmd = "modemTopology", modems = { ["@" .. k] = wiredTopology[k] } })
        end
      end
    end
  end
  M.refreshPeripherals = refreshPeripherals

  world.onChange = function(x, y, z)
    local dx, dy, dz = math.abs(x - pos.x), math.abs(y - pos.y), math.abs(z - pos.z)
    if dx + dy + dz <= 8 then M.peripheralsDirty = true end -- a monitor wall can change from a few blocks away
    share(x, y, z)
  end

  -- ===== gravity (FallingBlock) =====

  local function isFree(b) return b == nil or rules.isAir(b) or rules.isLiquid(b) or rules.isReplaceable(b) end
  local checkFall
  function checkFall(x, y, z)
    local b = world.get(x, y, z)
    if not b or not rules.hasGravity(b) then return end
    if not isFree(blockAt(x, y - 1, z)) then return end
    -- FallingBlock.onPlace / neighborChanged schedule a tick 2 ticks out; then the entity falls
    core.after(0.1, function()
      local again = world.get(x, y, z)
      if again ~= b or not isFree(blockAt(x, y - 1, z)) then return end
      local lo = world.limits(pos.dimension)
      local ty = y - 1
      while ty - 1 >= lo and isFree(blockAt(x, ty - 1, z)) do ty = ty - 1 end
      world.set(x, y, z, nil)
      if isFree(blockAt(x, ty, z)) and ty >= lo then
        world.set(x, ty, z, b)
      end
      checkFall(x, y + 1, z)
      M.peripheralsDirty = true
    end)
  end

  local rawSet = world.set
  function world.set(x, y, z, block)
    rawSet(x, y, z, block)
    if block == nil or isFree(block) then checkFall(x, y + 1, z) end
    if block and rules.hasGravity(block) then checkFall(x, y, z) end
  end

  -- ===== the living world (water and lava, crops, furnaces, hoppers, dropped items; ccsim/turtle/living.lua) =====

  local living = dofile("/rom/ccsim/turtle/living.lua")(core, {
    world = world, rules = rules, data = data, items = items, blockAt = blockAt, inventoryOf = inventoryOf, nowTick = nowTick,
  })
  M.living = living
  living.scan()

  -- ===== the command queue (spec 1) =====

  local queue = {}
  local commandsIssued = 0
  local animation = 0 -- ticks of animation left
  local tickTimer
  local tickNumber = 0

  local function queueResponse(id, result)
    -- result = { ok, msg | results... }
    if result.ok then
      os.queueEvent("turtle_response", id, true, table.unpack(result, 1, result.n or #result))
    else
      os.queueEvent("turtle_response", id, false, result.msg)
    end
  end

  local scheduleTick
  local function onTick()
    tickTimer = nil
    tickNumber = tickNumber + 1
    living.catchUp()
    -- updateCommands: one command, only when no animation is running
    if animation == 0 and #queue > 0 then
      local entry = table.remove(queue, 1)
      local ok, result = pcall(entry.fn)
      if not ok then result = { ok = false, msg = tostring(result) } end
      if result.anim then
        animation = 8
        core.dirty = true
        -- a disk dropped into a drive, a chest emptied: what is beside the turtle may be a different peripheral now
        M.peripheralsDirty = true
      end
      queueResponse(entry.id, result)
    end
    -- updateAnimation
    if animation > 0 then animation = animation - 1 end
    if M.peripheralsDirty then
      M.peripheralsDirty = false
      refreshPeripherals(false)
    end
    -- the turtle_inventory check at the end of the tile's tick
    local snap = snapshot()
    shareNeighbours()
    if snap ~= lastSnapshot then
      lastSnapshot = snap
      os.queueEvent("turtle_inventory")
      core.dirty = true
    end
    if #queue > 0 or animation > 0 then scheduleTick() end
  end

  local lastTickRun = -1
  function scheduleTick()
    if tickTimer then return end
    -- the next grid tick this turtle has not run yet
    local nextTick = max(nowTick() + 1, lastTickRun + 1)
    local delay = tickZero + nextTick * 0.05 - os.clock()
    tickTimer = core.after(max(delay, 0), function()
      lastTickRun = max(nextTick, nowTick())
      onTick()
    end)
  end

  local pullEventRaw = os.pullEventRaw -- the sim's hooked version, taken before any program can replace it

  local function execute(fn)
    if #queue > 16 then return false, "Too many ongoing turtle commands" end
    commandsIssued = commandsIssued + 1
    local id = commandsIssued
    queue[#queue + 1] = { id = id, fn = fn }
    scheduleTick()
    while true do
      local ev = table.pack(pullEventRaw("turtle_response"))
      if ev[1] == "terminate" then error("Terminated", 0) end
      if ev[1] == "turtle_response" and ev.n >= 3 and ev[2] == id and type(ev[3]) == "boolean" then
        return table.unpack(ev, 3, ev.n)
      end
    end
  end
  M.execute = execute

  local function success(anim, ...) return { ok = true, anim = anim, n = select("#", ...), ... } end
  local function failure(msg) return { ok = false, msg = msg } end

  -- ===== argument checks (spec 1.5) =====

  local function typeName(v) return v == nil and "nil" or type(v) end
  local function toInt(v)
    local n = v < 0 and math.ceil(v) or floor(v)
    n = n % 4294967296
    if n >= 2147483648 then n = n - 4294967296 end
    return n
  end
  local function checkNumber(index, v)
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(index, typeName(v)), 3) end
    if v ~= v then error(("bad argument #%d (number expected, got nan)"):format(index), 3) end
    if v == math.huge or v == -math.huge then error(("bad argument #%d (number expected, got %s)"):format(index, v > 0 and "inf" or "-inf"), 3) end
    return toInt(v)
  end
  local function optInt(index, v)
    if v == nil or type(v) == "function" or type(v) == "thread" or type(v) == "userdata" then return nil end
    return checkNumber(index, v)
  end
  local function checkSlot(slot)
    if slot < 1 or slot > 16 then error("Slot number " .. slot .. " out of range", 3) end
    return slot
  end
  local function checkCount(index, v)
    local n = optInt(index, v)
    if n == nil then n = 64 end
    if n < 0 or n > 64 then error("Item count " .. n .. " out of range", 3) end
    return n
  end
  local function optSide(index, v)
    if v == nil or type(v) == "function" or type(v) == "thread" or type(v) == "userdata" then return nil end
    if type(v) ~= "string" then error(("bad argument #%d (string expected, got %s)"):format(index, type(v)), 3) end
    local s = v:lower()
    if s ~= "left" and s ~= "right" then error(("bad argument #%d (unknown option %s)"):format(index, v), 3) end
    return s
  end

  -- ===== movement (spec 3) =====

  local function move(direction)
    local dir = (direction == "forward" and t.facing) or (direction == "back" and OPP[t.facing]) or direction
    local x, y, z = world.offset(pos.x, pos.y, pos.z, dir)
    local lo, hi = world.limits(pos.dimension)
    if y < lo or y > hi then return failure(y < 0 and "Too low to move" or "Too high to move") end
    if math.abs(x) > 30000000 or math.abs(z) > 30000000 then return failure("Cannot leave the world") end
    if isProtected(x, y, z) then return failure("Cannot enter protected area") end
    if not chunkLoaded(x, z) then return failure("Cannot leave loaded world") end
    if not inBorder(x, z) then return failure("Cannot pass the world border") end
    local target = blockAt(x, y, z)
    if not (target == nil or rules.isAir(target) or rules.isLiquid(target) or rules.isReplaceable(target)) then
      return failure("Movement obstructed")
    end
    if target and target.name == "minecraft:snow" and tonumber(target.state.layers or 1) >= 2 then
      for _, e in ipairs(world.entities) do
        if floor(e.x) == x and floor(e.y) == y and floor(e.z) == z and (not turtlesCanPush or dir == "up" or dir == "down") then
          return failure("Movement obstructed")
        end
      end
    end
    if needsFuel and t.fuel < 1 then return failure("Out of fuel") end
    -- teleport: the turtle replaces what was there (grass, snow, fire go without drops)
    local waterSource = target and target.name == "minecraft:water" and tostring(target.state.level or "0") == "0"
    if target and not rules.isAir(target) then world.set(x, y, z, nil) end
    local fromX, fromY, fromZ = pos.x, pos.y, pos.z
    pos.x, pos.y, pos.z = x, y, z
    turtleBlock.state.waterlogged = waterSource and "true" or "false"
    share(x, y, z) -- the turtle block where it now stands, before its old place empties (the host follows it)
    world.onChange(fromX, fromY, fromZ)
    checkFall(fromX, fromY + 1, fromZ)
    -- push mobs standing where the turtle goes, one block on
    if turtlesCanPush then
      local s = STEP[dir]
      for _, e in ipairs(world.entities) do
        if floor(e.x) == x and floor(e.y) == y and floor(e.z) == z then
          e.x, e.y, e.z = e.x + s[1], e.y + s[2], e.z + s[3]
        end
      end
    end
    if needsFuel then t.fuel = t.fuel - 1 end
    refreshPeripherals(false)
    core.dirty = true
    return success(true)
  end

  local function turn(left)
    t.facing = left and LEFT[t.facing] or RIGHT[t.facing]
    refreshPeripherals(false)
    core.dirty = true
    return success(true)
  end

  -- ===== place (spec 5) =====

  local function lookFor(dir, back)
    local look = back and OPP[dir] or dir
    local pitch = (look == "down" and 90) or (look == "up" and -90) or 0
    return look, pitch
  end

  --- The four deploy attempts for a target direction: clicked block position and face, allowReplace, and how the
  --- fake player looks (spec 5.2).
  local function attempts(dir)
    local tx, ty, tz = world.offset(pos.x, pos.y, pos.z, dir)
    local out = {}
    local look, pitch = lookFor(dir)
    out[#out + 1] = { x = tx, y = ty, z = tz, face = OPP[dir], replace = true, look = look, pitch = pitch }
    local bx, by, bz = world.offset(tx, ty, tz, dir)
    out[#out + 1] = { x = bx, y = by, z = bz, face = OPP[dir], look = look, pitch = pitch }
    if dir ~= "up" and dir ~= "down" then
      out[#out + 1] = { x = tx, y = ty - 1, z = tz, face = "up", look = "down", pitch = 90 }
    end
    local dlook, dpitch = lookFor(dir, true)
    out[#out + 1] = { x = pos.x, y = pos.y, z = pos.z, face = dir, look = dlook, pitch = dpitch, turtle = true }
    return out, tx, ty, tz
  end

  local function canDeployOn(a, isBlockItem)
    local lo, hi = world.limits(pos.dimension)
    if a.y < lo or a.y > hi then return false end
    local b = blockAt(a.x, a.y, a.z)
    if b == nil or rules.isAir(b) then return false end
    if isBlockItem and rules.isLiquid(b) then return false end
    if not a.replace and rules.isReplaceable(b) and b ~= turtleBlock then return false end
    return true
  end

  local function mobIn(x, y, z)
    for _, e in ipairs(world.entities) do
      if floor(e.x) == x and floor(e.y) == y and floor(e.z) == z then return e end
    end
    return nil
  end

  --- Sign text (spec 5.4): Java split drops trailing empty strings; 1-2 lines start on row 2.
  local function signLines(text)
    local lines = {}
    local start = 1
    while true do
      local i = text:find("\n", start, true)
      if not i then lines[#lines + 1] = text:sub(start) break end
      lines[#lines + 1] = text:sub(start, i - 1)
      start = i + 1
    end
    while #lines > 1 and lines[#lines] == "" do lines[#lines] = nil end
    if #lines == 1 and lines[1] == "" and text ~= "" then lines = {} end
    local first = #lines <= 2 and 1 or 0
    local rows = {}
    for row = 0, 3 do rows[row + 1] = (lines[row - first + 1] or ""):sub(1, 15) end
    return rows
  end

  -- ===== cables and wired modems (BlockCable, ItemBlockCable) =====

  local CABLE = "computercraft:cable"
  local SIX = { "north", "south", "east", "west", "up", "down" }

  local function hasCable(b) return b ~= nil and b.name == CABLE and b.state.cable == "true" end
  --- a wired element on that face of the block: a full modem everywhere, a cable everywhere but its modem's face
  local function wiredIn(b, d)
    if not b then return false end
    if b.name == "computercraft:wired_modem_full" then return true end
    return hasCable(b) and cableModemFacing(b) ~= d
  end

  --- BlockCable.correctConnections: the six arms a cable shows
  local function correctConnections(x, y, z, b)
    for _, d in ipairs(SIX) do
      local on = false
      if hasCable(b) then
        if cableModemFacing(b) == d then on = true
        else
          local nx, ny, nz = world.offset(x, y, z, d)
          on = wiredIn(blockAt(nx, ny, nz), OPP[d])
        end
      end
      b.state[d] = on and "true" or "false"
    end
    return b
  end

  --- canSurvive: a modem needs the full face of the block it is stuck on
  local function cableSurvives(x, y, z, b)
    local f = cableModemFacing(b)
    if not f then return true end
    local sx, sy, sz = world.offset(x, y, z, f)
    local s = blockAt(sx, sy, sz)
    return s ~= nil and not rules.isAir(s) and not rules.isLiquid(s) and not rules.isReplaceable(s)
  end

  local function putCable(x, y, z, b)
    if not cableSurvives(x, y, z, b) then return false end
    world.set(x, y, z, b)
    -- the cables around redraw their arms (updateShape)
    for _, d in ipairs(SIX) do
      local nx, ny, nz = world.offset(x, y, z, d)
      local n = world.get(nx, ny, nz)
      if n and n.name == CABLE then
        local copy = world.newBlock({ name = CABLE, state = n.state })
        correctConnections(nx, ny, nz, copy)
        local same = true
        for _, k in ipairs(SIX) do if copy.state[k] ~= n.state[k] then same = false end end
        if not same then world.set(nx, ny, nz, copy) end
      end
    end
    return true
  end

  local function cableCopy(b)
    local state = {}
    for k, v in pairs(b.state) do state[k] = v end
    return world.newBlock({ name = CABLE, state = state })
  end

  --- ItemBlockCable.Cable.place and WiredModem.place: join what is already there, or put a new block down
  local function placeCable(stack, a, tx, ty, tz)
    local clicked = blockAt(a.x, a.y, a.z)
    -- BlockPlaceContext.getClickedPos: the clicked block if it can be replaced, else the one in front of its face
    local px, py, pz = a.x, a.y, a.z
    if not (clicked and rules.isReplaceable(clicked)) then px, py, pz = world.offset(a.x, a.y, a.z, a.face) end
    local isModem = stack.name == "computercraft:wired_modem"
    if isModem then
      local existing = blockAt(px, py, pz)
      if existing and existing.name == CABLE and not cableModemFacing(existing) then
        local side = OPP[a.face]
        local b = cableCopy(existing)
        b.state.modem = side .. "_off"
        b.state[side] = existing.state.cable == "true" and "true" or "false"
        if putCable(px, py, pz, b) then return true end
      end
    else
      local ix, iy, iz = world.offset(px, py, pz, OPP[a.face])
      for _, p in ipairs({ { ix, iy, iz }, { px, py, pz } }) do
        local existing = blockAt(p[1], p[2], p[3])
        if existing and existing ~= turtleBlock and existing.name == CABLE and existing.state.cable ~= "true" then
          local b = cableCopy(existing)
          b.state.cable = "true"
          correctConnections(p[1], p[2], p[3], b)
          if putCable(p[1], p[2], p[3], b) then return true end
        end
      end
    end
    -- BlockItem.place at the target
    if px ~= tx or py ~= ty or pz ~= tz then return false end
    local target = blockAt(tx, ty, tz)
    if target and not rules.isReplaceable(target) then return false end
    local inWater = target and target.name == "minecraft:water" and tostring(target.state.level or "0") == "0"
    local state = { waterlogged = inWater and "true" or "false" }
    for _, d in ipairs(SIX) do state[d] = "false" end
    if isModem then
      state.cable, state.modem = "false", OPP[a.face] .. "_off"
    else
      state.cable, state.modem = "true", "none"
    end
    local b = world.newBlock({ name = CABLE, state = state })
    correctConnections(tx, ty, tz, b)
    return putCable(tx, ty, tz, b)
  end

  local function placeBlock(stack, a, tx, ty, tz, text)
    if stack.name == "computercraft:cable" or stack.name == "computercraft:wired_modem" then
      return placeCable(stack, a, tx, ty, tz)
    end
    local name = rules.blockFor(stack.name, a.face)
    if not name then return false end
    local target = blockAt(tx, ty, tz)
    if target and not rules.isReplaceable(target) then return false end
    if target and target.name == "minecraft:snow" and tonumber(target.state.layers or 1) > 1 then return false end
    local inWater = target and target.name == "minecraft:water" and tostring(target.state.level or "0") == "0"
    local state, why = rules.placementState(name, {
      face = a.face, look = a.look, pitch = a.pitch, inWater = inWater,
      -- a vertical look keeps the turtle's yaw (DirectionUtil.toPitchAngle)
      yaw = (a.look == "up" or a.look == "down") and t.facing or a.look,
    })
    if not state then return false, why end
    if mobIn(tx, ty, tz) and rules.hasCollision({ name = name, state = state }) then return false end
    local support = function(d)
      local x, y, z = world.offset(tx, ty, tz, d)
      return blockAt(x, y, z)
    end
    if not rules.canSurvive(name, state, support) then return false end
    -- two-block things need their other half free
    local upper
    if state.half == "lower" or (data.blockProperties(name) or {}).half and name:find("_door$") then
      local above = blockAt(tx, ty + 1, tz)
      if above and not rules.isReplaceable(above) then return false end
      upper = true
    end
    local headX, headY, headZ
    if name:find("_bed$") then
      headX, headY, headZ = world.offset(tx, ty, tz, state.facing or t.facing)
      local head = blockAt(headX, headY, headZ)
      if head and not rules.isReplaceable(head) then return false end
      state.part = "foot"
    end
    local placed = world.newBlock({ name = name, state = state })
    for k, v in pairs(state) do placed.state[k] = v end
    if stack.__blockEntity then placed.blockEntity = stack.__blockEntity end
    if name:match("^computercraft:turtle_") or name:match("^computercraft:computer_") then
      -- BlockTurtle.setPlacedBy and the item's NBT: id, label, fuel and upgrades go onto the block
      local be = {}
      for k, v in pairs(placed.blockEntity or {}) do be[k] = v end
      if stack.computerId ~= nil and be.ComputerId == nil then be.ComputerId = stack.computerId end
      if stack.label ~= nil and be.label == nil then be.label = stack.label end
      if name:match("^computercraft:turtle_") then
        if stack.fuel ~= nil and be.Fuel == nil then be.Fuel = stack.fuel end
        if stack.left ~= nil and be.LeftUpgrade == nil then be.LeftUpgrade = stack.left end
        if stack.right ~= nil and be.RightUpgrade == nil then be.RightUpgrade = stack.right end
      end
      be.on = nil
      placed.blockEntity = next(be) and be or nil
    end
    if stack.displayName and stack.displayName ~= data.displayName(stack.name) then
      placed.blockEntity = placed.blockEntity or {}
      placed.blockEntity.CustomName = stack.displayName
    end
    if (name:find("_sign$") or name:find("_wall_sign$")) and type(text) == "string" then
      placed.blockEntity = placed.blockEntity or {}
      placed.blockEntity.text = signLines(text)
    end
    world.set(tx, ty, tz, placed)
    if upper then
      local top = world.newBlock({ name = name, state = state })
      for k, v in pairs(state) do top.state[k] = v end
      top.state.half = "upper"
      world.set(tx, ty + 1, tz, top)
    end
    if headX then
      local head = world.newBlock({ name = name, state = state })
      for k, v in pairs(state) do head.state[k] = v end
      head.state.part = "head"
      world.set(headX, headY, headZ, head)
    end
    -- BlockMonitor.setPlacedBy: placed by a fake player, the monitor joins its neighbours on its next tick
    if isMonitor(placed) then expandAt(tx, ty, tz) end
    return true
  end

  local function useItem(stack, a, tx, ty, tz, slot)
    local name = stack.name
    local target = blockAt(tx, ty, tz)
    local clicked = blockAt(a.x, a.y, a.z)
    if name == "minecraft:bucket" then
      -- BucketItem.use: the ray from the player meets the first fluid source along its look
      if a.turtle then return false end
      if target and (target.name == "minecraft:water" or target.name == "minecraft:lava")
        and tostring(target.state.level or "0") == "0" then
        world.set(tx, ty, tz, nil)
        local full = { name = target.name == "minecraft:water" and "minecraft:water_bucket" or "minecraft:lava_bucket", count = 1 }
        stack.count = stack.count - 1
        if stack.count <= 0 then t.slots[slot] = full
        else
          local rest = storeItems(full, t.selected)
          if rest then dropFromTurtle(rest, OPP[t.facing]) end
        end
        return true
      end
      return false
    elseif name == "minecraft:water_bucket" or name == "minecraft:lava_bucket" then
      if target == nil or rules.isAir(target) or rules.isReplaceable(target) then
        world.set(tx, ty, tz, world.newBlock({ name = name == "minecraft:water_bucket" and "minecraft:water" or "minecraft:lava", state = { level = "0" } }))
        t.slots[slot] = { name = "minecraft:bucket", count = 1 }
        return true
      end
      return false
    elseif name == "minecraft:flint_and_steel" or name == "minecraft:fire_charge" then
      if clicked and not rules.isAir(clicked) and (target == nil or rules.isAir(target)) and not a.replace then
        world.set(tx, ty, tz, world.newBlock({ name = "minecraft:fire" }))
        if name == "minecraft:fire_charge" then
          stack.count = stack.count - 1
          if stack.count <= 0 then t.slots[slot] = nil end
        else
          stack.damage = (stack.damage or 0) + 1
          if stack.damage >= items.maxDamage(name) then t.slots[slot] = nil end
        end
        return true
      end
      return false
    elseif name == "minecraft:bone_meal" then
      if clicked and living.boneMeal(clicked, a.x, a.y, a.z) then
        stack.count = stack.count - 1
        if stack.count <= 0 then t.slots[slot] = nil end
        return true
      end
      return false
    elseif name:find("_hoe$") or name:find("_shovel$") then
      return M.toolUse(name, a)
    end
    return false
  end

  --- Hoe tilling and shovel flattening on a clicked block (HoeItem.useOn, ShovelItem.useOn).
  function M.toolUse(name, a)
    local clicked = blockAt(a.x, a.y, a.z)
    if not clicked or a.face == "down" then return false end
    local above = blockAt(a.x, a.y + 1, a.z)
    local airAbove = above == nil or rules.isAir(above)
    if name:find("_hoe$") then
      if not airAbove then return false end
      local n = clicked.name
      if n == "minecraft:grass_block" or n == "minecraft:dirt" or n == "minecraft:dirt_path" then
        world.set(a.x, a.y, a.z, world.newBlock({ name = "minecraft:farmland", state = { moisture = "0" } }))
        return true
      elseif n == "minecraft:coarse_dirt" then
        world.set(a.x, a.y, a.z, world.newBlock({ name = "minecraft:dirt" }))
        return true
      end
    elseif name:find("_shovel$") then
      if clicked.name == "minecraft:campfire" or clicked.name == "minecraft:soul_campfire" then
        if clicked.state.lit == "true" then
          clicked.state.lit = "false"
          world.set(a.x, a.y, a.z, clicked)
          return true
        end
        return false
      end
      if airAbove and (clicked.name == "minecraft:grass_block" or clicked.name == "minecraft:dirt"
        or clicked.name == "minecraft:podzol" or clicked.name == "minecraft:coarse_dirt" or clicked.name == "minecraft:mycelium"
        or clicked.name == "minecraft:rooted_dirt") then
        world.set(a.x, a.y, a.z, world.newBlock({ name = "minecraft:dirt_path" }))
        return true
      end
    end
    return false
  end

  local function deploy(stack, slot, dir, text)
    local list, tx, ty, tz = attempts(dir)
    local isBlockItem = rules.blockFor(stack.name, "up") ~= nil or rules.blockFor(stack.name, "north") ~= nil
    local refused = false
    for _, a in ipairs(list) do
      local editable = true
      if canDeployOn(a, isBlockItem) then
        -- TurtlePlaceCommand.canDeployOnBlock: edit permission on the clicked block when it can be replaced, else
        -- on the block in front of the clicked face
        local clicked = blockAt(a.x, a.y, a.z)
        local ex, ey, ez = a.x, a.y, a.z
        if not (clicked and rules.isReplaceable(clicked)) then ex, ey, ez = world.offset(a.x, a.y, a.z, a.face) end
        if isProtected(ex, ey, ez) then editable, refused = false, true end
      end
      if editable and canDeployOn(a, isBlockItem) then
        local ok
        if isBlockItem then
          ok = placeBlock(stack, a, tx, ty, tz, text)
          if ok then
            stack.count = stack.count - 1
            if stack.count <= 0 then t.slots[slot] = nil end
          end
        else
          ok = useItem(stack, a, tx, ty, tz, slot)
        end
        if ok then return true end
      end
    end
    return false, isBlockItem, refused
  end
  M.deploy = deploy

  local function place(interact, text)
    local slot = t.selected
    local stack = t.slots[slot]
    if not stack then return failure("No items to place") end
    local dir = dirOf(interact)
    local ok, isBlockItem, refused = deploy(stack, slot, dir, type(text) == "string" and text or nil)
    if ok then
      M.peripheralsDirty = true
      return success(true)
    end
    if refused then return failure("Cannot place in protected area") end
    return failure(isBlockItem and "Cannot place block here" or "Cannot place item here")
  end

  -- ===== dig (spec 4.2) =====

  --- Blocks next to `x,y,z` that cannot stand once it is gone, popped like a broken support would pop them.
  local function popNeighbours(x, y, z, out)
    for _, d in ipairs({ "up", "north", "south", "east", "west", "down" }) do
      local nx, ny, nz = world.offset(x, y, z, d)
      local n = world.get(nx, ny, nz)
      if n and not isTurtleAt(nx, ny, nz) then
        local support = function(dd)
          local sx, sy, sz = world.offset(nx, ny, nz, dd)
          return blockAt(sx, sy, sz)
        end
        if not rules.canSurvive(n.name, n.state, support) then
          local drops = loot.drops(n, nil, function(ox, oy, oz) return blockAt(nx + ox, ny + oy, nz + oz) end)
          if drops == nil and data.isItem(rules.asItem(n)) then drops = { { name = rules.asItem(n), count = 1 } } end
          for _, s in ipairs(drops or {}) do out[#out + 1] = s end
          world.set(nx, ny, nz, nil)
        end
      end
    end
  end

  local function breakBlock(x, y, z, block, tool)
    local out = {}
    local canHarvest = not rules.requiresCorrectTool(block) or rules.isCorrectTool(tool, block)
    if canHarvest then
      local drops = loot.drops(block, { name = tool }, function(ox, oy, oz) return blockAt(x + ox, y + oy, z + oz) end)
      if drops == nil then
        -- no loot table in the data (a block with drops in code): it drops itself if it is an item
        local item = rules.asItem(block)
        if item ~= "minecraft:air" then drops = { { name = item, count = 1 } } end
      end
      for _, s in ipairs(drops or {}) do
        if (s.__nbt or s.nbtText) and not s.nbt then
          -- set_nbt's SNBT first, then what copy_nbt, copy_state and set_contents put in
          local tag = s.nbtText and NBT.tag(s.nbtText) or { t = "compound", v = {} }
          for k, v in pairs(s.__nbt or {}) do tag.v[k] = NBT.tag({ [k] = v }).v[k] end
          s.nbt = M.nbtHash(tag)
        end
        s.__nbt, s.nbtText = nil, nil
        out[#out + 1] = s
      end
    end
    -- a container spills what it holds (Containers.dropContents), and the capture box takes it
    if block.inventory then
      for _, item in pairs(block.inventory.__state()) do out[#out + 1] = copy(item) end
    elseif block.def and block.def.items and not block.name:find("shulker_box$") then
      for _, item in pairs(block.def.items) do out[#out + 1] = normItem(item) end
    end
    -- the other half of a door or tall plant
    if block.state.half == "lower" or block.state.half == "upper" then
      local oy = block.state.half == "lower" and y + 1 or y - 1
      local other = world.get(x, oy, z)
      if other and other.name == block.name then world.set(x, oy, z, nil) end
    end
    world.set(x, y, z, rules.leftBehind(block) and world.newBlock(rules.leftBehind(block)) or nil)
    if isMonitor(block) then contractAround(x, y, z, block) end -- TileMonitor.destroy
    popNeighbours(x, y, z, out)
    return out
  end

  local function useTool(side, tool, interact, verb)
    local dir = dirOf(interact)
    local x, y, z = world.offset(pos.x, pos.y, pos.z, dir)
    local info = rules.TOOLS[tool]
    if verb == "dig" then
      if info.flattens or info.tills then
        -- spec 4.2 step 1: a shovel or hoe tries to flatten or till before it digs
        local list = attempts(dir)
        for _, a in ipairs(list) do
          if canDeployOn(a, false) and M.toolUse(tool, a) then return { ok = true } end
        end
      end
      local block = blockAt(x, y, z)
      if block == nil or rules.isAir(block) or rules.isLiquid(block) then return { msg = "Nothing to dig here" } end
      if isProtected(x, y, z) then return { msg = "Cannot break protected block" } end
      if rules.isUnbreakable(block) then return { msg = "Cannot break unbreakable block" } end
      if block == turtleBlock then return { msg = "Cannot break unbreakable block" } end
      if info.breakable and not info.breakable(block) and not rules.alwaysBreakable(block) and not rules.isInstabreak(block) then
        return { msg = "Cannot break block with this tool" }
      end
      capture(breakBlock(x, y, z, block, tool))
      M.peripheralsDirty = true
      return { ok = true }
    end
    -- attack (spec 4.3)
    local target
    local s = STEP[dir]
    local ox, oy, oz = pos.x + 0.5 + s[1] * 0.48, pos.y + 0.5 + s[2] * 0.48, pos.z + 0.5 + s[3] * 0.48
    local best
    for _, e in ipairs(world.entities) do
      if (e.health == nil or e.health > 0) and e.type ~= "minecraft:item" and e.attackable ~= false and not e.player then
        local w, h = (e.width or 0.6) / 2, e.height or 1.8
        -- the ray runs 1.5 blocks along dir; a hit is any entity box (grown 0.375 sideways) it passes through
        for step = 0, 15 do
          local px, py, pz = ox + s[1] * step * 0.1, oy + s[2] * step * 0.1, oz + s[3] * step * 0.1
          if px >= e.x - w - 0.375 and px <= e.x + w + 0.375 and py >= e.y - 0.375 and py <= e.y + h + 0.375
            and pz >= e.z - w - 0.375 and pz <= e.z + w + 0.375 then
            if not best or step < best.step then best = { e = e, step = step } end
            break
          end
        end
      end
    end
    target = best and best.e
    if not target then return { msg = "Nothing to attack here" } end
    local damage = 1.0 * info.multiplier
    local tick = nowTick()
    -- LivingEntity.hurt: within 10 ticks of the last hit, only a harder hit lands
    if target.__lastHurt and tick - target.__lastHurt < 10 and damage <= (target.__lastDamage or 0) then
      return { msg = "Nothing to attack here" }
    end
    target.__lastHurt, target.__lastDamage = tick, damage
    target.health = (target.health or target.maxHealth or 20) - damage
    if target.health <= 0 then
      for i, e in ipairs(world.entities) do if e == target then table.remove(world.entities, i) break end end
      local drops = {}
      for _, d in ipairs(target.drops or {}) do drops[#drops + 1] = normItem(d) end
      capture(drops)
    end
    core.dirty = true
    return { ok = true }
  end

  local function toolCommand(verb, interact, side)
    local first
    local tried = false
    for _, s in ipairs({ "left", "right" }) do
      local up = t[s]
      if (side == nil or side == s) and up and UPGRADES[up] and UPGRADES[up].tool then
        tried = true
        local r = useTool(s, up, interact, verb)
        if r.ok then return success(true) end
        first = first or r.msg
      end
    end
    if not tried then return failure(verb == "dig" and "No tool to dig with" or "No tool to attack with") end
    return failure(first)
  end

  -- ===== detect, compare, inspect (spec 2.8-2.10, 2.15, 8.1) =====

  local function targetBlock(interact)
    local x, y, z = world.offset(pos.x, pos.y, pos.z, dirOf(interact))
    return blockAt(x, y, z), x, y, z
  end

  local function detect(interact)
    local b = targetBlock(interact)
    if b and not rules.isAir(b) and not rules.isLiquid(b) then return success(false) end
    return { ok = false }
  end

  local function compare(interact)
    local b = targetBlock(interact)
    local want = rules.asItem(b)
    local held = t.slots[t.selected]
    local have = held and held.name or "minecraft:air"
    if have == want then return success(false) end
    return { ok = false }
  end

  local function stateValue(v)
    if v == "true" then return true elseif v == "false" then return false end
    local n = tonumber(v)
    if n and tostring(n) == v then return n end
    return v
  end

  function M.blockDetail(b)
    local state = {}
    for k, v in pairs(b.state or {}) do state[k] = stateValue(tostring(v)) end
    local tags = {}
    for _, tag in ipairs(data.blockTags(b.name)) do tags[tag] = true end
    return { name = b.name, state = state, tags = tags }
  end

  local function inspect(interact)
    local b = targetBlock(interact)
    if b == nil or rules.isAir(b) then return failure("No block to inspect") end
    return success(false, M.blockDetail(b))
  end

  -- ===== items: getItemDetail (spec 8.2) =====

  --- NBTUtil.getNBTHash: MD5 of the tag written big-endian (ccsim/turtle/nbt.lua). A typed tag, SNBT or a Lua table.
  M.nbtHash = nbtHash

  function M.itemDetail(item, detailed)
    if not detailed then return { name = item.name, count = item.count } end
    local d = { name = item.name, count = item.count }
    local maxDamage = item.maxDamage or items.maxDamage(item.name)
    local nbt = item.nbt
    if not nbt and maxDamage > 0 then nbt = M.nbtHash({ Damage = item.damage or 0 }) end
    if not nbt and item.diskId ~= nil and (item.name == "computercraft:disk" or item.name == "computercraft:treasure_disk") then
      nbt = M.nbtHash({ DiskId = item.diskId }) -- ItemDisk.setDiskID
    end
    d.nbt = nbt
    d.displayName = item.displayName or data.displayName(item.name)
    d.maxCount = item.maxCount or items.maxCount(item.name)
    if maxDamage > 0 and not item.unbreakable then
      d.damage = item.damage or 0
      d.maxDamage = maxDamage
      if (item.damage or 0) > 0 then
        d.durability = floor(13 - (item.damage * 13 / maxDamage) + 0.5) / 13
      end
    end
    local tags = {}
    for _, tag in ipairs(data.itemTags(item.name)) do tags[tag] = true end
    d.tags = tags
    d.itemGroups = item.itemGroups or {}
    if item.lore then d.lore = item.lore end
    if item.enchantments then d.enchantments = item.enchantments end
    if item.unbreakable then d.unbreakable = true end
    for k, v in pairs(item) do
      if d[k] == nil and type(k) == "string" and k:sub(1, 2) ~= "__" and k ~= "damage" and k ~= "maxCount" then d[k] = v end
    end
    return d
  end

  -- ===== refuel (spec 7) =====

  local function refuel(limit)
    local slot = t.selected
    local stack = t.slots[slot]
    if not stack then return failure("No items to combust") end
    local perItem = floor(items.burnTime(stack.name) * 5 / 100)
    if perItem <= 0 then return failure("Items not combustible") end
    if limit == 0 then return success(false) end
    local space = fuelLimit - t.fuel
    local itemLimit = math.ceil(space / perItem)
    if itemLimit < 0 then itemLimit = 0 end
    limit = min(limit, itemLimit)
    local taken = takeFrom(slot, limit)
    if taken then
      t.fuel = min(fuelLimit, t.fuel + perItem * taken.count)
      local remainder = items.burnRemainder(taken.name)
      if remainder then
        local rest = storeItems({ name = remainder, count = taken.count }, t.selected)
        if rest then dropFromTurtle(rest, OPP[t.facing]) end
      end
    end
    core.dirty = true
    return success(true)
  end

  -- ===== drop and suck (spec 2.4, 2.5) =====

  local function drop(interact, count)
    if count == 0 then return success(true) end
    local taken = takeFrom(t.selected, count)
    if not taken then return failure("No items to drop") end
    local dir = dirOf(interact)
    local x, y, z = world.offset(pos.x, pos.y, pos.z, dir)
    local inv = worldInventory(x, y, z, OPP[dir])
    if inv then
      local rest = invInsert(inv, taken)
      if rest then
        local back = storeItems(rest, t.selected)
        if back then dropFromTurtle(back, OPP[t.facing]) end
      end
      if rest and rest.count == taken.count then return failure("No space for items") end
      return success(true)
    end
    dropFromTurtle(taken, dir)
    return success(true)
  end

  local function suck(interact, count)
    if count == 0 then return success(true) end
    local dir = dirOf(interact)
    local x, y, z = world.offset(pos.x, pos.y, pos.z, dir)
    local inv = worldInventory(x, y, z, OPP[dir])
    if inv then
      local taken = invTake(inv, count)
      if not taken then return failure("No items to take") end
      local rest = storeItems(taken, t.selected)
      if rest then
        local back = invInsert(inv, rest)
        if back then dropFromTurtle(back, OPP[t.facing]) end
      end
      if rest and rest.count == taken.count then return failure("No space for items") end
      return success(true)
    end
    local found = world.itemsIn(x, y, z, x + 1, y + 1, z + 1)
    if #found == 0 then return failure("No items to take") end
    for _, index in ipairs(found) do
      local e = world.itemEntities[index]
      local n = min(count, e.item.count)
      local rest = storeItems(copy(e.item, n), t.selected)
      local stored = n - (rest and rest.count or 0)
      if stored > 0 then
        e.item.count = e.item.count - stored
        if e.item.count <= 0 then table.remove(world.itemEntities, index) end
        core.dirty = true
        return success(true)
      end
    end
    return failure("No space for items")
  end

  -- ===== slots (spec 2.10, 2.11) =====

  local function transferTo(slot, count)
    local taken = takeFrom(t.selected, count)
    if not taken then return success(true) end
    local rest = putBack(slot, taken)
    if rest then
      local back = putBack(t.selected, rest)
      if back then
        local more = storeItems(back, t.selected)
        if more then dropFromTurtle(more, OPP[t.facing]) end
      end
      if rest.count == taken.count then return failure("No space for items") end
    end
    return success(true)
  end

  local function compareTo(slot)
    if slot == t.selected then return success(false) end
    local a, b = t.slots[t.selected], t.slots[slot]
    if a == nil and b == nil then return success(false) end
    if a and b and a.name == b.name and a.nbt == b.nbt and a.displayName == b.displayName and a.damage == b.damage then
      return success(false)
    end
    return { ok = false }
  end

  -- ===== equip (spec 9.3) =====

  local function validUpgrade(stack)
    local up = UPGRADES[stack.name]
    if not up then return false end
    if up.tool then
      if (stack.damage or 0) > 0 or stack.enchantments or (stack.displayName and stack.displayName ~= data.displayName(stack.name)) then
        return false
      end
    end
    return true
  end

  local function equip(side)
    local slot = t.selected
    local stack = t.slots[slot]
    if stack and not validUpgrade(stack) then return failure("Not a valid upgrade") end
    local old = t[side]
    local new = stack and stack.name or nil
    if stack then takeFrom(slot, 1) end
    if old then
      local rest = storeItems({ name = old, count = 1 }, t.selected)
      if rest then dropFromTurtle(rest, t.facing) end
    end
    t[side] = new
    refreshPeripherals(false)
    core.dirty = true
    return success(old ~= nil or new ~= nil)
  end

  -- ===== craft (spec 9.4) =====

  local function ingredientMatches(alts, item)
    if #alts == 0 then return item == nil end
    if item == nil then return false end
    for _, alt in ipairs(alts) do
      if alt.item and data.id(alt.item) == item.name then return true end
      if alt.tag and data.itemHasTag(item.name, alt.tag) then return true end
    end
    return false
  end

  local function window(x0, y0)
    for y = 0, 3 do
      for x = 0, 3 do
        local inside = x >= x0 and x < x0 + 3 and y >= y0 and y < y0 + 3
        if not inside and t.slots[x + 4 * y + 1] then return nil end
      end
    end
    local grid = {}
    for y = 0, 2 do
      grid[y + 1] = {}
      for x = 0, 2 do grid[y + 1][x + 1] = t.slots[(x0 + x) + 4 * (y0 + y) + 1] end
    end
    return grid
  end

  local function matchShaped(recipe, grid)
    local pattern = recipe.pattern
    local h = #pattern
    local w = 0
    for _, row in ipairs(pattern) do w = max(w, #row) end
    for oy = 0, 3 - h do
      for ox = 0, 3 - w do
        for mirror = 0, 1 do
          local ok = true
          for y = 1, 3 do
            for x = 1, 3 do
              local px, py = x - ox, y - oy
              local alts = {}
              if px >= 1 and px <= w and py >= 1 and py <= h then
                local cx = mirror == 1 and (w - px + 1) or px
                local ch = pattern[py]:sub(cx, cx)
                if ch ~= " " and ch ~= "" then alts = recipe.key[ch] or { { item = "?" } } end
              end
              if not ingredientMatches(alts, grid[y][x]) then ok = false break end
            end
            if not ok then break end
          end
          if ok then return true end
        end
      end
    end
    return false
  end

  local function matchShapeless(recipe, grid)
    local stacks = {}
    for y = 1, 3 do for x = 1, 3 do if grid[y][x] then stacks[#stacks + 1] = grid[y][x] end end end
    local ings = recipe.ingredients
    if #stacks ~= #ings then return false end
    local used = {}
    local function assign(i)
      if i > #ings then return true end
      for j, s in ipairs(stacks) do
        if not used[j] and ingredientMatches(ings[i], s) then
          used[j] = true
          if assign(i + 1) then return true end
          used[j] = false
        end
      end
      return false
    end
    return assign(1)
  end

  -- RecipeManager hands back the first match in its own map order; here vanilla goes first, then the rest by id,
  -- so a grid two mods both claim always crafts the same thing
  local recipeOrder
  local function orderedRecipes()
    if recipeOrder then return recipeOrder end
    local all = data.recipes()
    local ids = {}
    for id in pairs(all) do ids[#ids + 1] = id end
    table.sort(ids, function(a, b)
      local va, vb = a:sub(1, 10) == "minecraft:", b:sub(1, 10) == "minecraft:"
      if va ~= vb then return va end
      return a < b
    end)
    recipeOrder = {}
    for i, id in ipairs(ids) do recipeOrder[i] = { id = id, r = all[id] } end
    return recipeOrder
  end

  local function findRecipe()
    for _, w in ipairs({ { 0, 0 }, { 0, 1 }, { 1, 0 }, { 1, 1 } }) do
      local grid = window(w[1], w[2])
      if grid then
        local any = false
        for y = 1, 3 do for x = 1, 3 do if grid[y][x] then any = true end end end
        if any then
          for _, entry in ipairs(orderedRecipes()) do
            local r = entry.r
            if (r.type == "shaped" and matchShaped(r, grid)) or (r.type == "shapeless" and matchShapeless(r, grid)) then
              return r, w, entry.id
            end
          end
        end
      end
    end
    return nil
  end

  local REMAINDER = {
    ["minecraft:water_bucket"] = "minecraft:bucket", ["minecraft:lava_bucket"] = "minecraft:bucket",
    ["minecraft:milk_bucket"] = "minecraft:bucket", ["minecraft:powder_snow_bucket"] = "minecraft:bucket",
    ["minecraft:honey_bottle"] = "minecraft:glass_bottle", ["minecraft:dragon_breath"] = "minecraft:glass_bottle",
  }

  local function craft(limit)
    local recipe, w = findRecipe()
    if not recipe then return failure("No matching recipes") end
    if limit == 0 then return success(false) end
    local results = {}
    for _ = 1, limit do
      local grid = window(w[1], w[2])
      if not grid or not ((recipe.type == "shaped" and matchShaped(recipe, grid)) or (recipe.type == "shapeless" and matchShapeless(recipe, grid))) then
        break
      end
      local r = recipe.result
      results[#results + 1] = { name = data.id(r.item), count = r.count or 1, nbt = r.nbt and M.nbtHash(r.nbt) or nil }
      for y = 0, 2 do
        for x = 0, 2 do
          local slot = (w[1] + x) + 4 * (w[2] + y) + 1
          local item = t.slots[slot]
          if item then
            local remainder = REMAINDER[item.name]
            item.count = item.count - 1
            if item.count <= 0 then t.slots[slot] = nil end
            if remainder then
              local here = t.slots[slot]
              if not here then t.slots[slot] = { name = remainder, count = 1 }
              elseif here.name == remainder and here.count < maxOf(here) then here.count = here.count + 1
              else results[#results + 1] = { name = remainder, count = 1 } end
            end
          end
        end
      end
    end
    for _, stack in ipairs(results) do
      local rest = storeItems(stack, t.selected)
      if rest then dropFromTurtle(rest, t.facing) end
    end
    core.dirty = true
    return success(#results > 0)
  end

  function craftCommand(limit)
    local n = optInt(1, limit)
    if n == nil then n = 64 end
    if n < 0 or n > 64 then error("Crafting count " .. n .. " out of range", 0) end
    return execute(function() return craft(n) end)
  end

  -- ===== the turtle API (TurtleAPI.java) =====

  local api = {}
  local function cmd(fn) return function(...) local args = table.pack(...) return execute(function() return fn(table.unpack(args, 1, args.n)) end) end end

  api.forward = cmd(function() return move("forward") end)
  api.back = cmd(function() return move("back") end)
  api.up = cmd(function() return move("up") end)
  api.down = cmd(function() return move("down") end)
  api.turnLeft = cmd(function() return turn(true) end)
  api.turnRight = cmd(function() return turn(false) end)

  for _, v in ipairs({ { "dig", "forward" }, { "digUp", "up" }, { "digDown", "down" } }) do
    api[v[1]] = function(side)
      side = optSide(1, side)
      return execute(function() return toolCommand("dig", v[2], side) end)
    end
  end
  for _, v in ipairs({ { "attack", "forward" }, { "attackUp", "up" }, { "attackDown", "down" } }) do
    api[v[1]] = function(side)
      side = optSide(1, side)
      return execute(function() return toolCommand("attack", v[2], side) end)
    end
  end
  for _, v in ipairs({ { "place", "forward" }, { "placeUp", "up" }, { "placeDown", "down" } }) do
    api[v[1]] = function(text) return execute(function() return place(v[2], text) end) end
  end
  for _, v in ipairs({ { "drop", "forward" }, { "dropUp", "up" }, { "dropDown", "down" } }) do
    api[v[1]] = function(count)
      count = checkCount(1, count)
      local results = table.pack(execute(function() return drop(v[2], count) end))
      -- a blank floppy into a drive: the drive mounts it once the world has numbered it (the same server tick in game)
      if M.diskPending() then awaitHost(function() return not M.diskPending() end) end
      return table.unpack(results, 1, results.n)
    end
  end
  for _, v in ipairs({ { "suck", "forward" }, { "suckUp", "up" }, { "suckDown", "down" } }) do
    api[v[1]] = function(count)
      count = checkCount(1, count)
      return execute(function() return suck(v[2], count) end)
    end
  end
  for _, v in ipairs({ { "detect", "forward" }, { "detectUp", "up" }, { "detectDown", "down" } }) do
    api[v[1]] = function() return execute(function() return detect(v[2]) end) end
  end
  for _, v in ipairs({ { "compare", "forward" }, { "compareUp", "up" }, { "compareDown", "down" } }) do
    api[v[1]] = function() return execute(function() return compare(v[2]) end) end
  end
  for _, v in ipairs({ { "inspect", "forward" }, { "inspectUp", "up" }, { "inspectDown", "down" } }) do
    api[v[1]] = function() return execute(function() return inspect(v[2]) end) end
  end

  function api.select(slot)
    slot = checkSlot(checkNumber(1, slot))
    return execute(function()
      t.selected = slot
      core.dirty = true
      return success(false)
    end)
  end

  function api.getItemCount(slot)
    slot = optInt(1, slot)
    if slot then checkSlot(slot) else slot = t.selected end
    local item = t.slots[slot]
    return item and item.count or 0
  end

  function api.getItemSpace(slot)
    slot = optInt(1, slot)
    if slot then checkSlot(slot) else slot = t.selected end
    local item = t.slots[slot]
    if not item then return 64 end
    return maxOf(item) - item.count
  end

  function api.getFuelLevel()
    if not needsFuel then return "unlimited" end
    return min(t.fuel, fuelLimit)
  end

  function api.getFuelLimit()
    if not needsFuel then return "unlimited" end
    return fuelLimit
  end

  function api.refuel(count)
    local n = optInt(1, count)
    if n == nil then n = 2147483647 end
    if n < 0 then error("Refuel count " .. n .. " out of range", 2) end
    return execute(function() return refuel(n) end)
  end

  function api.compareTo(slot)
    slot = checkSlot(checkNumber(1, slot))
    return execute(function() return compareTo(slot) end)
  end

  function api.transferTo(slot, count)
    slot = checkSlot(checkNumber(1, slot))
    count = checkCount(2, count)
    return execute(function() return transferTo(slot, count) end)
  end

  function api.getSelectedSlot() return t.selected end

  function api.equipLeft() return execute(function() return equip("left") end) end
  function api.equipRight() return execute(function() return equip("right") end) end

  function api.getItemDetail(slot, detailed)
    slot = optInt(1, slot)
    if slot then checkSlot(slot) else slot = t.selected end
    if detailed ~= nil and type(detailed) ~= "boolean" and type(detailed) ~= "function" then
      error(("bad argument #2 (boolean expected, got %s)"):format(type(detailed)), 2)
    end
    if detailed == true then
      core.waitForServerTick() -- a main-thread task: answered on a later tick
    end
    local item = t.slots[slot]
    if not item then return nil end
    return M.itemDetail(item, detailed == true)
  end

  M.api = api
  M.state = t
  M.fuelLimit = fuelLimit

  -- This computer's own block, as the computers next to it see it (ComputerPeripheral: id, label, on)
  turtleBlock.blockEntity = { ComputerId = core.computerId, label = os.getComputerLabel(), on = true }
  if not isTurtle then turtleBlock.state.state = "on" end
  local rawSetLabel = os.setComputerLabel
  function os.setComputerLabel(label)
    rawSetLabel(label)
    turtleBlock.blockEntity.label = os.getComputerLabel()
    share(pos.x, pos.y, pos.z)
  end
  -- a chest next to this computer emptied through its peripheral: the others see it too
  local afterSave = core.afterSave
  core.afterSave = function()
    if afterSave then afterSave() end
    shareNeighbours()
  end

  -- Monitors the world file lists without their place in a wall (no XIndex/Width): they join up as if placed one by
  -- one in the order listed, so a hand-written world gets the walls it draws
  for _, def in ipairs(core.world.blocks or {}) do
    local name = def.name and data.id(def.name)
    if name == "computercraft:monitor_normal" or name == "computercraft:monitor_advanced" then
      local be = def.blockEntity
      if not (type(be) == "table" and be.Width) then
        local x, y, z = def.x or def[1], def.y or def[2], def.z or def[3]
        local b = world.get(x, y, z)
        if isMonitor(b) and not (b.blockEntity and b.blockEntity.Width) then
          local copy = world.newBlock({ name = b.name, state = b.state, blockEntity = { XIndex = 0, YIndex = 0, Width = 1, Height = 1 } })
          world.set(x, y, z, copy)
          expandAt(x, y, z)
        end
      end
    end
  end

  refreshPeripherals(true)
  share(pos.x, pos.y, pos.z)
  if networked and core.sendHost then
    -- the wired networks around this computer, now that it can take them
    core.sendHost("C" .. textutils.serializeJSON({ op = "topology", pos = world.key(pos.x, pos.y, pos.z) }))
  end
  return M
end
