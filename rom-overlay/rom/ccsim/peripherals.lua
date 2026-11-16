-- ccsim peripherals: a virtual-peripheral layer over the `peripheral` API.
--
-- The engine only emulates vanilla CC:Tweaked peripherals. This layer adds fakes for
-- inventories (chests, barrels, ...) and the Advanced Peripherals types the scripts use
-- (playerDetector, chatBox), and all modems (ccsim/modem.lua). Definitions come from
-- world.peripherals; real engine peripherals (monitors, drives) keep working through the
-- original API.
--
-- Not emulated: ME/RS bridges, block reader, geo scanner, inventory manager, energy and
-- environment detectors, redstone integrator.
return function(core)
  local realPeripheral = peripheral
  local virtual = {}   -- name -> { types = {...}, methods = {...}, def = ... }
  local order = {}
  local wrappedNames = setmetatable({}, { __mode = "k" })

  local function fail(message) error(message, 0) end

  local function checkString(index, v)
    if type(v) == "string" then return v end
    if type(v) == "number" then return tostring(v) end
    error(("bad argument #%d (string expected, got %s)"):format(index, v == nil and "nil" or type(v)), 0)
  end

  local function checkInt(index, v)
    if type(v) ~= "number" then
      error(("bad argument #%d (number expected, got %s)"):format(index, v == nil and "nil" or type(v)), 0)
    end
    if v ~= math.floor(v) then
      error(("bad argument #%d (number has no integer representation)"):format(index), 0)
    end
    return v
  end

  -- ===== inventories =====

  local INVENTORY_TYPES = {
    ["minecraft:chest"] = true, ["minecraft:trapped_chest"] = true, ["minecraft:barrel"] = true,
    ["minecraft:hopper"] = true, ["minecraft:dispenser"] = true, ["minecraft:dropper"] = true,
    ["minecraft:shulker_box"] = true, ["minecraft:furnace"] = true, inventory = true,
  }

  local function titleCase(name)
    local path = name:match(":(.+)$") or name
    return (path:gsub("_", " "):gsub("(%a)([%w]*)", function(a, b) return a:upper() .. b end))
  end

  local function stackable(a, b)
    return a.name == b.name and a.nbt == b.nbt
  end

  local function typeName(v) return v == nil and "nil" or type(v) end

  --- What getItemDetail says about an item (also what 2.2.36's getPlayerEquipment says about worn ones).
  local function itemDetail(item)
    local detail = {
      name = item.name,
      count = item.count,
      displayName = titleCase(item.name),
      maxCount = 64,
      tags = {},
    }
    for k, v in pairs(item) do -- fixtures add enchantments, vaultData, ...; "__" fields are the sim's own
      if type(k) ~= "string" or k:sub(1, 2) ~= "__" then detail[k] = v end
    end
    return detail
  end
  core.itemDetail = itemDetail

  --- What pushItems/pullItems reach by name: an inventory, a linked computer's inventory, or an entangloporter's handler.
  --- `role` is how InventoryMethods names it: "Target" for pushItems (the default), "Source" for pullItems.
  local function resolveInventory(name, role)
    role = role or "Target"
    local other = virtual[name]
    if not other then fail(role .. " '" .. name .. "' does not exist") end
    if other.remoteInv then return other.remoteInv end
    if other.qeHandler then
      local handler = other.qeHandler()
      if handler then return handler end
      fail(role .. " '" .. name .. "' is not an inventory")
    end
    if not other.inventory then fail(role .. " '" .. name .. "' is not an inventory") end
    return other.inventory
  end

  --- How many slots an inventory, a linked computer's inventory or an entangloporter's handler has.
  local function slotsOf(inventory)
    if inventory.size then return inventory.size() end
    if inventory.__size then return inventory.__size() end
    return nil
  end

  --- ArgumentHelpers.assertBetween as InventoryMethods uses it: "From slot out of range (between 1 and 27)".
  local function slotInRange(slot, size, what)
    if size and (slot < 1 or slot > size) then
      error(("%s out of range (between 1 and %d)"):format(what, size), 0)
    end
  end

  --- One pushItems between inventories where at least one is on a linked computer (2.2.36). Nothing is taken out
  --- that has nowhere to go, and anything the target turns down after all goes back where it came from.
  local function transfer(src, fromSlot, dst, limit, toSlot)
    if not src.__peek then return src.__pull(fromSlot, limit, function() return 0 end) end -- read-only handler
    local item = src.__peek(fromSlot)
    if not item then return 0 end
    local want = math.min(limit or (item.maxCount or 64), item.count)
    if want <= 0 then return 0 end
    if not dst.__room then return dst.__insert(item, 0, toSlot) end -- read-only handler: nothing goes in
    local n = math.min(want, dst.__room(item, want, toSlot))
    if n <= 0 then return 0 end
    local taken = src.__take(fromSlot, n, item)
    if taken <= 0 then return 0 end
    local ok, moved = pcall(dst.__insert, item, taken, toSlot)
    if not ok then
      -- the target's computer went away mid-call: put the items back, then fail like the call would
      local back = src.__insert(item, taken, fromSlot)
      if back < taken then src.__insert(item, taken - back) end
      error(moved, 0)
    end
    if moved < taken then
      local back = src.__insert(item, taken - moved, fromSlot)
      if back < taken - moved then src.__insert(item, taken - moved - back) end
    end
    return moved
  end

  --- moveMany: each move is a pushItems; the batch stops once its time passes the budget (2.2.36).
  --- The moves table as the mod reads it (MoveBatch.parse): the moves are counted first (more than the limit raises
  --- `too many moves (max N)`), then every move is checked before any runs. A move is `{ fromSlot, to, toSlot?, limit? }`
  --- by name, or by position in that order; numbers are cut towards zero.
  local function parseMoves(moves)
    if type(moves) ~= "table" then
      error(("bad argument #1 (table expected, got %s)"):format(typeName(moves)), 0)
    end
    local count = 0
    while moves[count + 1] ~= nil do
      count = count + 1
      if count > core.config.maxBatchMoves then
        error(("too many moves (max %d)"):format(core.config.maxBatchMoves), 0)
      end
    end
    local function field(move, name, position)
      if move[name] ~= nil then return move[name] end
      return move[position]
    end
    local function whole(i, name, value)
      if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
        error(("bad move #%d (%s expected number)"):format(i, name), 0)
      end
      local n = value < 0 and math.ceil(value) or math.floor(value)
      return math.max(-2147483648, math.min(2147483647, n))
    end
    local parsed = {}
    for i = 1, count do
      local move = moves[i]
      if type(move) ~= "table" then error(("bad move #%d (table expected)"):format(i), 0) end
      local to = field(move, "to", 2)
      if type(to) ~= "string" then error(("bad move #%d (to expected string)"):format(i), 0) end
      local fromSlot = whole(i, "fromSlot", field(move, "fromSlot", 1))
      local toSlot = field(move, "toSlot", 3)
      if toSlot ~= nil then toSlot = whole(i, "toSlot", toSlot) end
      local limit = field(move, "limit", 4)
      if limit ~= nil then limit = whole(i, "limit", limit) end
      parsed[i] = { fromSlot = fromSlot, to = to, toSlot = toSlot, limit = limit }
    end
    return parsed
  end
  core.parseMoves = parseMoves

  local function moveMany(pushOne, moves)
    local parsed = parseMoves(moves)
    local count = #parsed
    local moved, done, spent = {}, 0, 0
    for i = 1, count do
      local move = parsed[i]
      moved[i] = pushOne(move.to, move.fromSlot, move.limit, move.toSlot)
      done = i
      spent = spent + core.config.batchMoveCostMicros
      if spent > core.config.batchTimeBudgetMicros then break end
    end
    return { moved = moved, done = done }
  end

  local function newInventory(def)
    local size = def.size or 27
    local items = core.normalizeItems(def.items)
    local inv = {}

    --- what: "Slot" (getItemDetail, getItemLimit), "From slot" or "To slot" (pushItems, pullItems)
    local function slotCheck(arg, slot, what)
      slot = checkInt(arg, slot)
      slotInRange(slot, size, what or "Slot")
      return slot
    end

    local function limitOf(item)
      return item.maxCount or 64
    end

    function inv.size() return size end

    function inv.list()
      local out = {}
      for slot, item in pairs(items) do
        out[slot] = { name = item.name, count = item.count }
        if item.nbt then out[slot].nbt = item.nbt end
      end
      return out
    end

    function inv.getItemDetail(slot)
      slot = slotCheck(1, slot)
      local item = items[slot]
      if not item then return nil end
      return itemDetail(item)
    end

    function inv.getItemLimit(slot)
      slot = slotCheck(1, slot)
      local item = items[slot]
      return item and limitOf(item) or 64
    end

    --- Try to insert up to `count` of `item` into this inventory; returns how many fit.
    local function insert(item, count, toSlot)
      local moved = 0
      local function put(slot)
        local existing = items[slot]
        if existing then
          if not stackable(existing, item) then return end
          local room = limitOf(existing) - existing.count
          local n = math.min(room, count - moved)
          if n > 0 then existing.count = existing.count + n moved = moved + n end
        else
          local n = math.min(limitOf(item), count - moved)
          if n > 0 then
            local copy = {}
            for k, v in pairs(item) do copy[k] = v end
            copy.count = n
            items[slot] = copy
            moved = moved + n
          end
        end
      end
      if toSlot then
        put(toSlot)
      else
        for slot = 1, size do
          if items[slot] and stackable(items[slot], item) then put(slot) end
          if moved >= count then return moved end
        end
        for slot = 1, size do
          if not items[slot] then put(slot) end
          if moved >= count then break end
        end
      end
      return moved
    end

    --- How many of `item` (up to `count`) would fit, changing nothing.
    local function room(item, count, toSlot)
      local n = 0
      local function fits(slot)
        local existing = items[slot]
        if existing then
          if not stackable(existing, item) then return end
          n = n + math.max(0, math.min(limitOf(existing) - existing.count, count - n))
        else
          n = n + math.max(0, math.min(limitOf(item), count - n))
        end
      end
      if toSlot then
        fits(toSlot)
      else
        for slot = 1, size do
          if items[slot] and stackable(items[slot], item) then fits(slot) end
          if n >= count then return n end
        end
        for slot = 1, size do
          if not items[slot] then fits(slot) end
          if n >= count then break end
        end
      end
      return n
    end

    local otherInventory = resolveInventory

    -- InventoryMethods.pushItems: the arguments are converted first, then the target is found, then both slots are checked
    local function push(save, toName, fromSlot, limit, toSlot)
      toName = checkString(1, toName)
      fromSlot = checkInt(2, fromSlot)
      if limit ~= nil then limit = checkInt(3, limit) end
      if toSlot ~= nil then toSlot = checkInt(4, toSlot) end
      local target = otherInventory(toName, "Target")
      slotInRange(fromSlot, size, "From slot")
      if toSlot ~= nil then slotInRange(toSlot, slotsOf(target), "To slot") end
      if limit ~= nil and limit <= 0 then return 0 end
      local item = items[fromSlot]
      if not item then return 0 end
      if target.__remote then
        local moved = transfer(inv, fromSlot, target, limit, toSlot)
        if save then core.save() end
        return moved
      end
      local want = math.min(limit or limitOf(item), item.count)
      local moved = target.__insert(item, want, toSlot)
      item.count = item.count - moved
      if item.count <= 0 then items[fromSlot] = nil end
      if save then core.save() end
      return moved
    end

    function inv.pushItems(toName, fromSlot, limit, toSlot)
      return push(true, toName, fromSlot, limit, toSlot)
    end

    function inv.pullItems(fromName, fromSlot, limit, toSlot)
      fromName = checkString(1, fromName)
      fromSlot = checkInt(2, fromSlot)
      if limit ~= nil then limit = checkInt(3, limit) end
      if toSlot ~= nil then toSlot = checkInt(4, toSlot) end
      local source = otherInventory(fromName, "Source")
      slotInRange(fromSlot, slotsOf(source), "From slot")
      if toSlot ~= nil then slotInRange(toSlot, size, "To slot") end
      if limit ~= nil and limit <= 0 then return 0 end
      if source.__remote then
        local moved = transfer(source, fromSlot, inv, limit, toSlot)
        core.save()
        return moved
      end
      local moved = source.__pull(fromSlot, limit, function(item, count)
        return insert(item, count, toSlot)
      end)
      core.save()
      return moved
    end

    -- 2.2.36 batch methods; build() adds them to inventory peripherals when the world turns 2.2.36 on
    function inv.__listDetailed()
      local out = {}
      for slot in pairs(items) do out[slot] = inv.getItemDetail(slot) end
      return out
    end

    function inv.__moveMany(moves)
      local result = moveMany(function(...) return push(false, ...) end, moves)
      core.save()
      return result
    end

    -- the other side of a transfer with a linked computer
    function inv.__peek(slot)
      slot = slotCheck(2, slot, "From slot")
      local item = items[slot]
      if not item then return nil end
      local copy = {}
      for k, v in pairs(item) do copy[k] = v end
      return copy
    end
    inv.__room = room
    function inv.__take(slot, count, like)
      local item = items[slot]
      if not item or not stackable(item, like) then return 0 end
      local n = math.min(count, item.count)
      item.count = item.count - n
      if item.count <= 0 then items[slot] = nil end
      return n
    end

    -- internal hooks used by the other side of a transfer (not exposed as Lua methods)
    inv.__insert = insert
    function inv.__pull(slot, limit, sink)
      slot = slotCheck(2, slot, "From slot")
      local item = items[slot]
      if not item then return 0 end
      local want = math.min(limit or limitOf(item), item.count)
      local moved = sink(item, want)
      item.count = item.count - moved
      if item.count <= 0 then items[slot] = nil end
      return moved
    end
    inv.__state = function() return items end
    return inv
  end

  local B_copy

  -- ===== fluid tanks (CC's generic fluid_storage peripheral) =====

  -- Generic blocks with a rate (energyRate, a tank's rate) change on the virtual clock, 50 ms per tick. Each is caught
  -- up to now before anything looks at the world (core.beforeObserve, wired below the registry).
  local ratedBlocks = {}
  local function gameTick() return math.floor(core.nowMs() / 50) end

  local INT_MAX = 2147483647
  local VANILLA_FLUIDS = {
    ["minecraft:water"] = true, ["minecraft:flowing_water"] = true, ["minecraft:lava"] = true,
    ["minecraft:flowing_lava"] = true, ["minecraft:empty"] = true,
  }

  --- ArgumentHelpers.getRegistryEntry for fluids: "Unknown fluid 'x'". The sim has no fluid registry: a vanilla
  --- fluid must be one of the five, any other namespace is taken as a real mod fluid. Returns the full name.
  local function fluidArgument(name)
    local ns, path = name:match("^([^:]*):(.*)$")
    if not ns then ns, path = "minecraft", name end
    local full = ns .. ":" .. path
    if not ns:match("^[a-z0-9_.-]+$") or not path:match("^[a-z0-9_./-]+$")
        or (ns == "minecraft" and not VANILLA_FLUIDS[full]) then
      fail("Unknown fluid '" .. name .. "'")
    end
    return full
  end

  --- A block's fluid tanks, as the Forge IFluidHandler behind CC's FluidMethods: any number of tanks, each holding one
  --- fluid. def.tanks = { { name?, amount?, capacity?, rate?, nbt? }, ... } (name is the fluid); the older single
  --- tank is def.fluid = { name, amount } with def.capacity (default 16000).
  local function newTank(def)
    local list = {}
    local function addTank(spec, fluidSpec)
      local t = { capacity = spec.capacity or def.capacity or 16000, rate = spec.rate }
      fluidSpec = fluidSpec or (spec.name and { name = spec.name, amount = spec.amount or 0, nbt = spec.nbt,
        displayName = spec.displayName, tags = spec.tags })
      if fluidSpec then
        t.fluid = B_copy(fluidSpec)
        t.rname = t.fluid.name
        if (t.fluid.amount or 0) <= 0 then t.fluid = nil end
      end
      list[#list + 1] = t
    end
    if def.tanks then
      for _, spec in ipairs(def.tanks) do addTank(spec) end
    else
      addTank(def, def.fluid)
    end
    if #list == 0 then addTank({}) end
    local tank = {}
    local last = gameTick()

    local function clampFluid(t)
      if t.fluid then
        if t.fluid.amount > t.capacity then t.fluid.amount = t.capacity end
        if t.fluid.amount <= 0 then t.fluid = nil end
      end
    end

    --- The rates, for the ticks that passed since the last look.
    local function advance()
      local now = gameTick()
      local ticks = now - last
      last = now
      if ticks <= 0 then return end
      for _, t in ipairs(list) do
        if t.rate and t.rate ~= 0 then
          if t.rate > 0 then
            local name = t.fluid and t.fluid.name or t.rname
            if name then
              if not t.fluid then t.fluid = { name = name, amount = 0 } end
              t.fluid.amount = math.min(t.capacity, t.fluid.amount + t.rate * ticks)
            end
          elseif t.fluid then
            t.fluid.amount = math.max(0, t.fluid.amount + t.rate * ticks)
          end
          clampFluid(t)
        end
      end
    end
    for _, t in ipairs(list) do
      if t.rate and t.rate ~= 0 then ratedBlocks[#ratedBlocks + 1] = advance break end
    end

    --- IFluidHandler.getFluidInTank for every tank: empty ones are left out of the table (FluidMethods.tanks).
    function tank.tanks()
      local out = {}
      for i, t in ipairs(list) do
        if t.fluid then out[i] = { name = t.fluid.name, amount = t.fluid.amount } end
      end
      return out
    end

    --- The fluid the first non-empty tank holds (what an unspecific drain would take).
    function tank.__contents()
      for _, t in ipairs(list) do if t.fluid then return t.fluid end end
      return nil
    end

    function tank.__list() return list end

    --- How much of `entry` (up to `amount`) would go in, changing nothing unless `execute`: tanks that already hold the
    --- fluid first, then empty ones, in order.
    local function fill(entry, amount, execute)
      if not entry or not entry.name or entry.name == "minecraft:empty" then return 0 end
      local taken = 0
      local function put(t)
        local n = math.min(t.capacity - (t.fluid and t.fluid.amount or 0), amount - taken)
        if n <= 0 then return end
        taken = taken + n
        if execute then
          if not t.fluid then
            t.fluid = { name = entry.name, amount = 0, nbt = entry.nbt, displayName = entry.displayName, tags = entry.tags }
          end
          t.fluid.amount = t.fluid.amount + n
          t.rname = entry.name
        end
      end
      for _, t in ipairs(list) do
        if t.fluid and t.fluid.name == entry.name then put(t) end
      end
      for _, t in ipairs(list) do
        if taken >= amount then break end
        if not t.fluid then put(t) end
      end
      return taken
    end

    function tank.__fill(entry, amount) return fill(entry, amount, true) end
    function tank.__fillable(entry, amount) return fill(entry, amount, false) end

    --- IFluidHandler.drain: the first non-empty tank (holding `name`, when given) says which fluid; every tank with that
    --- fluid gives, in order, up to `amount`. Returns what was (or would be, unless `execute`) taken: name and amount.
    local function drain(amount, name, execute)
      local source
      for _, t in ipairs(list) do
        if t.fluid and (not name or t.fluid.name == name) then source = t.fluid break end
      end
      if not source then return nil, 0 end
      local taken, fluid = 0, source
      for _, t in ipairs(list) do
        if t.fluid and t.fluid.name == fluid.name and taken < amount then
          local n = math.min(amount - taken, t.fluid.amount)
          taken = taken + n
          if execute then
            t.fluid.amount = t.fluid.amount - n
            if t.fluid.amount <= 0 then t.fluid = nil end
          end
        end
      end
      return fluid, taken
    end

    function tank.__drain(amount, name)
      local _, taken = drain(amount, name, true)
      return taken
    end
    function tank.__drainable(amount, name) return drain(amount, name, false) end

    --- FluidMethods.moveFluid: what the source can give, what the target takes of it, then the move itself.
    local function move(from, to, limit, name)
      local fluid, amount = from.__drainable(limit, name)
      if not fluid or amount <= 0 then return 0 end
      local filled = to.__fillable(fluid, amount)
      if filled <= 0 then return 0 end
      local entry = B_copy(fluid)
      local taken = from.__drain(filled, fluid.name)
      return to.__fill(entry, taken)
    end

    --- The target of pushFluid/pullFluid: FluidMethods checks the fluid name, the computer's view of the target, that it
    --- has a fluid handler, then the limit.
    local function otherTank(toName, limit, fluidName)
      toName = checkString(1, toName)
      if limit ~= nil then limit = checkInt(2, limit) end
      if fluidName ~= nil then fluidName = fluidArgument(checkString(3, fluidName)) end
      local other = virtual[toName]
      if not other then fail("Target '" .. toName .. "' does not exist") end
      if not other.tank then fail("Target '" .. toName .. "' is not an tank") end
      limit = limit or INT_MAX
      if limit <= 0 then fail("Limit must be > 0") end
      return other.tank, limit, fluidName
    end

    function tank.pushFluid(toName, limit, fluidName)
      local other, max, name = otherTank(toName, limit, fluidName)
      local moved = move(tank, other, max, name)
      core.save()
      return moved
    end

    function tank.pullFluid(fromName, limit, fluidName)
      local other, max, name = otherTank(fromName, limit, fluidName)
      local moved = move(other, tank, max, name)
      core.save()
      return moved
    end

    function tank.__advance() advance() end
    function tank.__setFluid(index, fluid)
      local t = list[index]
      if not t then return false end
      t.fluid = fluid and { name = fluid.name, amount = fluid.amount or 0, nbt = fluid.nbt, displayName = fluid.displayName, tags = fluid.tags } or nil
      if t.fluid then t.rname = t.fluid.name end
      clampFluid(t)
      return true
    end
    function tank.__state()
      local out = {}
      for i, t in ipairs(list) do
        out[i] = { fluid = t.fluid and B_copy(t.fluid) or nil, capacity = t.capacity, rate = t.rate }
      end
      return out
    end
    return tank
  end

  --- A block's energy buffer, as the Forge IEnergyStorage behind CC's EnergyMethods. def.energy is what it holds,
  --- def.energyCapacity what it can hold (default: what it holds), def.energyRate FE per tick in (or out when negative).
  local function newEnergy(def)
    local energy = {}
    local stored = def.energy or 0
    local capacity = def.energyCapacity or stored
    local rate = def.energyRate or 0
    local last = gameTick()

    local function advance()
      local now = gameTick()
      local ticks = now - last
      last = now
      if ticks > 0 and rate ~= 0 then stored = math.max(0, math.min(capacity, stored + rate * ticks)) end
    end
    if rate ~= 0 then ratedBlocks[#ratedBlocks + 1] = advance end

    function energy.getEnergy() return math.min(stored, INT_MAX) end
    function energy.getEnergyCapacity() return math.min(capacity, INT_MAX) end
    function energy.__advance() advance() end
    function energy.__set(value)
      stored = math.max(0, math.min(capacity, value))
    end
    function energy.__state() return { energy = stored, capacity = capacity, rate = rate } end
    return energy
  end

  -- ===== Advanced Peripherals (see ccsim/ap/) =====

  -- The speaker fake lives with them (ap/simple.lua) but is CC's own, so it stays when the addon is off.
  local ap = dofile("/rom/ccsim/ap/base.lua")(core)
  B_copy = ap.copy
  local apFactories = {}
  for _, module in ipairs({ "simple", "environment", "bridges", "ar", "extra" }) do
    for typeName, factory in pairs(dofile("/rom/ccsim/ap/" .. module .. ".lua")(core, ap)) do
      if typeName == "speaker" or core.addonOn("advanced-peripherals") then apFactories[typeName] = factory end
    end
  end

  -- Machines on the virtual clock catch up before anything looks at the world. Each addon adds its own.
  local catchUps = {}
  core.beforeObserve = function()
    for _, fn in ipairs(catchUps) do fn() end
  end
  catchUps[1] = function() for _, advance in ipairs(ratedBlocks) do advance() end end -- generic blocks with rates

  -- ===== Mekanism QIO (see ccsim/mek/) =====

  local qio, entangloporter = { TYPES = {}, handlers = {} }, { handlers = {} }
  if core.addonOn("mekanism") then
    qio = dofile("/rom/ccsim/mek/qio.lua")(core, {
      newInventory = function(def) return newInventory(def) end,
      findInventory = function(name)
        local entry = virtual[name]
        return entry and entry.inventory or nil
      end,
      md5 = ap.md5,
    })
    catchUps[#catchUps + 1] = function() qio.catchUp() end
    entangloporter = dofile("/rom/ccsim/mek/entangloporter.lua")(core, qio)
    core.qioState = function()
      local state = qio.state()
      state.entangloporter = entangloporter.state()
      return state
    end
  end

  -- ===== other addons (see ccsim/addons/README.md) =====
  -- Loaded the first time the world uses one of their types, so an addon nobody uses costs nothing at boot.

  local addonHost = {
    newInventory = function(def) return newInventory(def) end,
    newTank = function(def) return newTank(def) end,
    findInventory = function(name)
      local entry = virtual[name]
      return entry and entry.inventory or nil
    end,
    find = function(name) return virtual[name] end,
    md5 = ap.md5,
    copy = ap.copy,
    fail = fail,
    checkString = checkString,
    checkInt = checkInt,
    itemDetail = itemDetail,
  }
  local addonTypes, addonModules, addonLoaded = {}, {}, {}
  for _, module in ipairs(dofile("/rom/ccsim/addons/modules.lua")) do
    local info = dofile("/rom/ccsim/addons/" .. module .. "/types.lua")
    if core.addonOn(info.addon) then
      addonModules[module] = info
      for _, t in ipairs(info.types or {}) do addonTypes[t] = module end
    end
  end
  local function loadAddon(module)
    local loaded = addonLoaded[module]
    if loaded then return loaded end
    loaded = dofile("/rom/ccsim/addons/" .. module .. "/init.lua")(core, addonHost)
    addonLoaded[module] = loaded
    if loaded.catchUp then catchUps[#catchUps + 1] = loaded.catchUp end
    core.extraHandlers = core.extraHandlers or {}
    for cmdName, handler in pairs(loaded.handlers or {}) do core.extraHandlers[cmdName] = handler end
    return loaded
  end
  core.loadAddon = loadAddon
  core.addonState = function()
    local out = {}
    for module, loaded in pairs(addonLoaded) do
      if loaded.state then out[module] = loaded.state() end
    end
    return next(out) and out or nil
  end

  function core.hasPeripheralType(typeName)
    for _, entry in pairs(virtual) do
      for _, t in ipairs(entry.types or {}) do if t == typeName then return true end end
    end
    return false
  end

  -- ===== modems (see ccsim/modem.lua) =====

  local modemHost = {}
  local modems = dofile("/rom/ccsim/modem.lua")(core, modemHost)

  -- ===== one block on a cable shared by every computer on it (see ccsim/wiredrelay.lua) =====
  -- Plain CC:Tweaked does this, so it runs with the mod off too; only a 2.2.35 world keeps each computer its own copy.

  local linkHost = {}
  local relay = dofile("/rom/ccsim/wiredrelay.lua")(core, linkHost, modems)
  core.wired = relay


  local link = core.v36 and relay and dofile("/rom/ccsim/link.lua")(core, linkHost, modems, relay) or nil
  core.link = link

  -- ===== registry =====

  local function sortedMethods(methods)
    local names = {}
    for name, fn in pairs(methods) do
      if type(fn) == "function" and name:sub(1, 2) ~= "__" then names[#names + 1] = name end
    end
    table.sort(names)
    return names
  end

  local function build(def)
    local ty = def.type
    local entry = { name = def.name, def = def }
    if ty == "modem" then
      entry.modem = modems.add(def)
      entry.methods = entry.modem.methods
      entry.types = entry.modem.types
      entry.methodOrder = entry.modem.methodOrder
    elseif def.__methods then
      -- a peripheral the sim builds itself (a turtle's crafting table, a computer block next to this one)
      entry.methods = def.__methods
      entry.types = { ty }
    elseif ty == "computer" then
      entry.methods = modems.computerPeripheral(def)
      entry.types = { ty }
    elseif ty == entangloporter.TYPE then
      entry.mek = entangloporter.peripheral(def)
      entry.qeHandler = entry.mek.ccHandler -- what CC's pushItems/pullItems reach through getTarget()
      entry.methods = entry.mek.methods
      entry.types = { ty }
      entry.methodOrder = entry.mek.methodOrder
    elseif qio.TYPES[ty] then
      entry.mek = qio.peripheral(def)
      entry.methods = entry.mek.methods
      entry.types = { ty }
      entry.methodOrder = entry.mek.methodOrder
    elseif apFactories[ty] then
      entry.ap = apFactories[ty](def)
      entry.methods = entry.ap.methods
      entry.types = { ty }
      entry.computerThread = entry.ap.computerThread -- set by the ones that say which methods do not wait
    elseif addonTypes[ty] then
      -- An addon's block (ccsim/addons/README.md). Mekanism-style ones check arguments first (validate/run).
      local p = loadAddon(addonTypes[ty]).peripheral(def)
      entry.addon = p
      if p.validate and p.run then entry.mek = p end
      entry.methods = p.methods
      entry.types = p.types or { ty }
      entry.methodOrder = p.methodOrder
      entry.computerThread = p.computerThread
      if p.inventory then entry.inventory = p.inventory end
      if p.tank then entry.tank = p.tank end
    elseif ty == "fluid_storage" or ty == "energy_storage" or INVENTORY_TYPES[ty] or def.size or def.items
        or def.tanks or def.fluid or def.energy ~= nil or def.energyCapacity ~= nil then
      -- CC's generic peripherals: a block with an item, fluid or energy capability gets inventory, fluid_storage and
      -- energy_storage, any mix of them. The type is the block's own name, then the extra types as CC's HashSet lists
      -- them (inventory and energy_storage before fluid_storage when all three; see docs/generic-storage.md).
      local hasInv = INVENTORY_TYPES[ty] or def.size or def.items
      local hasTank = ty == "fluid_storage" or def.tanks or def.fluid
      local hasEnergy = ty == "energy_storage" or def.energy ~= nil or def.energyCapacity ~= nil
      local methods, groups = {}, {}
      local function addGroup(source)
        local names = sortedMethods(source)
        for _, name in ipairs(names) do methods[name] = source[name] end
        groups[#groups + 1] = names
      end
      local extra = {}
      if hasInv then
        local saved = core.savedInventories and core.savedInventories[def.name]
        if saved then def.items = saved end
        entry.inventory = newInventory(def)
        if link then
          -- 2.2.36's generic source: every inventory gains the batch methods and watches
          local inv, name = entry.inventory, def.name
          inv.listDetailed = inv.__listDetailed
          inv.moveMany = inv.__moveMany
          function inv.watch() link.watch(name) end
          function inv.unwatch() link.unwatch(name) end
        end
        addGroup(entry.inventory)
        extra[#extra + 1] = "inventory"
      end
      if hasEnergy then
        entry.energy = newEnergy(def)
        addGroup(entry.energy)
        extra[#extra + 1] = "energy_storage"
      end
      if hasTank then
        entry.tank = newTank(def)
        addGroup(entry.tank)
        extra[#extra + 1] = "fluid_storage"
      end
      entry.methods = methods
      entry.types = { ty }
      for _, t in ipairs(extra) do
        if t ~= ty then entry.types[#entry.types + 1] = t end
      end
      if #groups > 1 then
        entry.methodOrder = {}
        for _, names in ipairs(groups) do
          for _, name in ipairs(names) do entry.methodOrder[#entry.methodOrder + 1] = name end
        end
      end
    else
      error("ccsim: unsupported virtual peripheral type '" .. tostring(ty) .. "'", 0)
    end
    virtual[def.name] = entry
    core.peripherals[def.name] = entry
  end

  local function register(def)
    build(def)
    order[#order + 1] = def.name
  end

  for _, def in ipairs(core.world.peripherals or {}) do register(def) end
  -- An addon configured by a world key (world.create, ...) loads at boot even before any of its blocks is used
  for module, info in pairs(addonModules) do
    for _, key in ipairs(info.worldKeys or {}) do
      if core.world[key] ~= nil then loadAddon(module) end
    end
  end

  -- What a wired modem reaches is listed behind that modem, so it stays out of `order`
  local exportsCache -- what linked computers see of this one; rebuilt when the wired network changes
  function modemHost.attach(def)
    build(def)
    exportsCache = nil
  end
  function modemHost.detach(name)
    virtual[name] = nil
    core.peripherals[name] = nil
    exportsCache = nil
  end

  -- ===== turtles: blocks next to a moving computer come and go as peripherals (see ccsim/turtle) =====

  core.newInventory = newInventory
  core.rawPeripheral = realPeripheral -- the engine's own drives and monitors, insertDisk and setBlockSize included

  --- Put a peripheral on a side. `inventory` is a block's own inventory (newInventory), so what is in a chest stays
  --- with the chest when the turtle moves away. `quiet`: at boot, before the program runs, no event is queued.
  function core.attachSide(def, inventory, quiet)
    local name = def.name
    if inventory then
      local ty = def.type
      local entry = { name = name, def = def, inventory = inventory, methods = inventory, types = { ty, ty ~= "inventory" and "inventory" or nil } }
      if link then
        inventory.listDetailed = inventory.__listDetailed
        inventory.moveMany = inventory.__moveMany
        function inventory.watch() link.watch(name) end
        function inventory.unwatch() link.unwatch(name) end
      end
      virtual[name] = entry
      core.peripherals[name] = entry
    else
      build(def)
    end
    exportsCache = nil
    if not quiet then os.queueEvent("peripheral", name) end
  end

  function core.detachSide(name, quiet)
    if not virtual[name] then return end
    local entry = virtual[name]
    if entry.modem then modems.remove(name) end
    if entry.addon and entry.addon.detach then entry.addon.detach() end
    virtual[name] = nil
    core.peripherals[name] = nil
    exportsCache = nil
    if not quiet then os.queueEvent("peripheral_detach", name) end
  end

  function core.sidePeripheral(name) return virtual[name] end

  function core.inventoryState()
    local out = {}
    for name, entry in pairs(virtual) do
      if entry.inventory then
        local slots = {}
        for slot, item in pairs(entry.inventory.__state()) do slots[tostring(slot)] = item end
        out[name] = slots
      end
    end
    return next(out) and out or nil
  end

  --- State of every virtual peripheral that has any (redstone outputs, NBT, AR canvas,
  --- storage networks, tanks) for state.json.
  function core.peripheralState()
    local out = {}
    for name, entry in pairs(virtual) do
      if entry.addon then
        if entry.addon.state then out[name] = entry.addon.state() end
      elseif entry.ap and entry.ap.state then out[name] = entry.ap.state()
      elseif entry.mek then out[name] = entry.mek.state()
      elseif entry.tank or entry.energy then
        if entry.tank then entry.tank.__advance() end
        if entry.energy then entry.energy.__advance() end
        out[name] = {
          fluid = entry.tank and entry.tank.__contents() and B_copy(entry.tank.__contents()) or nil,
          tanks = entry.tank and entry.tank.__state() or nil,
          energy = entry.energy and entry.energy.__state() or nil,
        }
      elseif entry.modem then out[name] = modems.state(name) end
    end
    return next(out) and out or nil
  end

  core.extraHandlers = core.extraHandlers or {}

  local function setter(cmdName, field, args)
    core.extraHandlers[cmdName] = function(cmd)
      local entry = virtual[cmd.peripheral]
      if not entry or not entry.ap or not entry.ap.setters or not entry.ap.setters[field] then
        return false, "no such peripheral or setting"
      end
      local values = {}
      for i, key in ipairs(args) do values[i] = cmd[key] end
      local ok, result = pcall(entry.ap.setters[field], table.unpack(values, 1, #args))
      if not ok then return false, tostring(result) end
      return result ~= false
    end
  end
  setter("setEnergyTransferRate", "transferRate", { "rate" })
  setter("setRedstoneInput", "input", { "side", "level" })
  setter("completeCraft", "completeCraft", { "name" })
  setter("setNetworkConnected", "setConnected", { "connected" })

  function core.extraHandlers.setEnvironment(cmd)
    core.world.environment = core.world.environment or {}
    for key, value in pairs(cmd.values or {}) do core.world.environment[key] = value end
    return true
  end

  function core.extraHandlers.addEntity(cmd)
    core.world.entities = core.world.entities or {}
    core.world.entities[#core.world.entities + 1] = cmd.entity
    return true
  end

  for cmdName, handler in pairs(qio.handlers) do core.extraHandlers[cmdName] = handler end
  for cmdName, handler in pairs(entangloporter.handlers) do core.extraHandlers[cmdName] = handler end

  function core.extraHandlers.setItem(cmd)
    local entry = virtual[cmd.peripheral]
    if not entry or not entry.inventory then return false, "no such inventory" end
    local items = entry.inventory.__state()
    items[cmd.slot] = cmd.item
    return true
  end

  --- setEnergy { peripheral, energy }: what a generic energy_storage holds now (kept within its capacity).
  function core.extraHandlers.setEnergy(cmd)
    local entry = virtual[cmd.peripheral]
    if not entry or not entry.energy then return false, "no such energy_storage" end
    if type(cmd.energy) ~= "number" then return false, "setEnergy needs energy = a number" end
    entry.energy.__advance()
    entry.energy.__set(cmd.energy)
    return true
  end

  --- setFluid { peripheral, tank (1-based, default 1), fluid = { name, amount } | null }: what one tank holds now.
  function core.extraHandlers.setFluid(cmd)
    local entry = virtual[cmd.peripheral]
    if not entry or not entry.tank then return false, "no such fluid_storage" end
    if cmd.fluid ~= nil and (type(cmd.fluid) ~= "table" or type(cmd.fluid.name) ~= "string") then
      return false, "setFluid needs fluid = { name, amount } or null"
    end
    entry.tank.__advance()
    if not entry.tank.__setFluid(cmd.tank or 1, cmd.fluid) then return false, "no such tank" end
    return true
  end

  -- ===== peripheral API replacement =====

  local api = {}
  for k, v in pairs(realPeripheral) do api[k] = v end

  local function methodNames(name)
    local entry = virtual[name]
    if entry.methodOrder then
      local names = {}
      for i, method in ipairs(entry.methodOrder) do names[i] = method end
      return names
    end
    return sortedMethods(entry.methods)
  end

  -- Engine peripherals that are not on a side (a monitor named monitor_0): nothing lists them unless they are named
  -- here. The boot script does that, and hide() takes the function away before any program runs.
  local engineNamed = {}
  function api.__ccsimNamed(name)
    engineNamed[#engineNamed + 1] = name
    if relay then
      -- a monitor appeared after this computer told linked ones what it has: tell them again at the next event
      exportsCache = nil
      core.dirty = true
    end
  end

  -- As peripheral.getNames does it: the sides in order, each hub followed by what it reaches
  local SIDES = { "top", "bottom", "left", "right", "front", "back" }

  function api.getNames()
    local names, seen = {}, {}
    local function add(name)
      if not seen[name] then
        seen[name] = true
        names[#names + 1] = name
      end
    end
    local function addWithRemotes(name)
      add(name)
      for _, remote in ipairs(modems.remoteNames(name)) do add(remote) end
    end
    for _, side in ipairs(SIDES) do
      if virtual[side] or realPeripheral.isPresent(side) then addWithRemotes(side) end
    end
    for _, name in ipairs(realPeripheral.getNames()) do add(name) end
    for _, name in ipairs(engineNamed) do
      if realPeripheral.isPresent(name) then add(name) end
    end
    for _, name in ipairs(order) do addWithRemotes(name) end
    return names
  end

  function api.isPresent(name)
    if virtual[name] then return true end
    return realPeripheral.isPresent(name)
  end

  function api.getType(p)
    if type(p) == "table" and wrappedNames[p] then p = wrappedNames[p] end
    if type(p) == "string" and virtual[p] then
      local types = virtual[p].types
      return table.unpack(types, 1, #types)
    end
    return realPeripheral.getType(p)
  end

  function api.hasType(p, ty)
    if type(p) == "table" and wrappedNames[p] then p = wrappedNames[p] end
    if type(p) == "string" and virtual[p] then
      for _, t in ipairs(virtual[p].types) do if t == ty then return true end end
      return false
    end
    return realPeripheral.hasType(p, ty)
  end

  function api.getMethods(name)
    if virtual[name] then return methodNames(name) end
    return realPeripheral.getMethods(name)
  end

  function api.getName(p)
    if type(p) == "table" and wrappedNames[p] then return wrappedNames[p] end
    return realPeripheral.getName(p)
  end

  -- Methods that run on the computer thread. Everything else on an inventory or an Advanced Peripherals block runs
  -- on the server thread: measured with tools/conformance/peripheral_probe.lua (ME and RS bridges follow the same
  -- rule but could not be measured without a network). The caller then waits for the next server tick, and every
  -- event that arrives meanwhile is thrown away. That is how a real program loses timers and touches.
  local COMPUTER_THREAD = { getName = true, getConfiguration = true, scanCost = true }
  local COMPUTER_THREAD_BY_TYPE = {
    speaker = { playSound = true, playNote = true, playAudio = true, stop = true },
    redstoneIntegrator = { setOutput = true, setAnalogOutput = true, setAnalogueOutput = true },
  }
  -- No modem or computer method asks for the server thread (ModemPeripheral, ComputerPeripheral)
  -- A turtle's crafting table queues a turtle command, which waits for its own turtle_response (CraftingTablePeripheral)
  local COMPUTER_THREAD_TYPES = { modem = true, computer = true, workbench = true, turtle = true }
  -- A linked computer's engine peripherals: no monitor, drive or printer method waits for the server thread
  local REMOTE_COMPUTER_THREAD_TYPES = { monitor = true, drive = true, printer = true }

  local function onServerThread(entry, method)
    if entry.computerThread then return not entry.computerThread[method] end -- an addon says which of its own do not wait
    if COMPUTER_THREAD[method] or COMPUTER_THREAD_TYPES[entry.types[1]] then return false end
    if entry.remote and REMOTE_COMPUTER_THREAD_TYPES[entry.types[1]] then return false end
    local list = COMPUTER_THREAD_BY_TYPE[entry.types[1]]
    return not (list and list[method])
  end

  -- A main-thread call, as CC's LuaContext.executeMainThreadTask does it: the task is queued for the server, the caller
  -- waits, and the answer comes back as `task_complete, id, true, results...` (or `false, message`). That event goes
  -- to the whole computer, so every other coroutine in `parallel` hears it too. Every other event that reaches the
  -- caller meanwhile is thrown away: that is how a real program loses timers and touches. Ids count up from 1 per
  -- boot like CC's; the sim's own linked-computer tasks are negative (ccsim/link.lua).
  local lastTask = 0

  --- Handle what the sim itself needs from an event the caller would otherwise lose; true when it was the sim's.
  local function simEvent(ev, keep)
    if ev[1] == "ccsim_cmd" and (type(ev[2]) ~= "string" or core.world.simProgram == true) then
      keep[#keep + 1] = ev -- the harness's own commands (and the sim program's) are not part of the simulated world
    elseif ev[1] == "ccsim_net" then
      core.onNet(ev[2], ev[3]) -- turned into a modem_message, which this wait then loses like any other event
    elseif ev[1] == "ccsim_link" and core.onLink then
      core.onLink(ev[2], ev[3])
    elseif ev[1] == "ccsim_world" and core.onWorld then
      core.onWorld(ev[2], ev[3])
    elseif ev[1] == "timer" and core.simTimers[ev[2]] then
      local fn = core.simTimers[ev[2]]
      core.simTimers[ev[2]] = nil
      fn()
    else
      return false
    end
    return true
  end

  --- Wait for the next server tick and run `task` there (nothing: the task is only the wait). Returns
  --- table.pack(pcall(task)). `trim`: drop trailing nils from the answer, as a Java method never returns them.
  local function waitForServerTick(task, trim)
    local timer = os.startTimer(0.05)
    local keep = {}
    while true do
      local ev = table.pack(coroutine.yield())
      if ev[1] == "terminate" then
        error("Terminated", 0)
      elseif ev[1] == "timer" and ev[2] == timer then
        break
      else
        simEvent(ev, keep)
      end
    end
    local results = task and table.pack(pcall(task)) or { true, n = 1 }
    if trim and results[1] then
      while results.n > 1 and results[results.n] == nil do results.n = results.n - 1 end
    end
    lastTask = lastTask + 1
    local id = lastTask
    if results[1] then
      os.queueEvent("task_complete", id, true, table.unpack(results, 2, results.n))
    else
      os.queueEvent("task_complete", id, false, tostring(results[2]))
    end
    while true do
      local ev = table.pack(coroutine.yield())
      if ev[1] == "task_complete" and ev[2] == id then
        break
      elseif ev[1] == "terminate" then
        error("Terminated", 0)
      else
        simEvent(ev, keep)
      end
    end
    for _, ev in ipairs(keep) do os.queueEvent(table.unpack(ev, 1, ev.n)) end
    return results
  end

  core.waitForServerTick = waitForServerTick

  --- Run a virtual peripheral's method: true and its results, or false and the error.
  local function invoke(entry, method, ...)
    local fn = entry.methods[method]
    if type(fn) ~= "function" or tostring(method):sub(1, 2) == "__" then return false, "No such method " .. tostring(method) end
    if entry.mek then
      -- CCMethodCaller: the arguments are checked on the computer thread, before the call waits for the server tick.
      -- Every Mekanism QIO method is then queued as a main-thread task. Java returns exactly what it returns, nil included.
      local ok, args = pcall(entry.mek.validate, method, table.pack(...))
      if not ok then return false, args end
      local results = waitForServerTick(function()
        local out = entry.mek.run(method, args)
        return table.unpack(out, 1, out.n)
      end)
      if not results[1] then return false, results[2] end
      core.touch()
      return table.unpack(results, 1, results.n)
    end
    local results
    local exact = entry.addon and entry.addon.exactReturns
    if onServerThread(entry, method) then
      local args = table.pack(...)
      results = waitForServerTick(function()
        if core.beforeObserve and not entry.remote then core.beforeObserve() end
        return fn(table.unpack(args, 1, args.n))
      end, not exact)
    else
      if core.beforeObserve and not entry.remote then core.beforeObserve() end
      results = table.pack(pcall(fn, ...))
    end
    if not results[1] then return false, results[2] end
    core.touch()
    local n = results.n
    -- The older fakes return loose trailing nils, so they are trimmed. An addon written from its source returns
    -- exactly what Java does (`exactReturns`): MethodResult.of(null) is one nil, MethodResult.of() is none.
    if not exact then
      while n > 1 and results[n] == nil do n = n - 1 end
    end
    return table.unpack(results, 1, n)
  end

  function api.call(name, method, ...)
    local entry = virtual[name]
    if not entry then
      local ghost = link and link.ghost(name)
      if ghost then error(ghost, 2) end
      return realPeripheral.call(name, method, ...)
    end
    if type(entry.methods[method]) ~= "function" or tostring(method):sub(1, 2) == "__" then fail("No such method " .. tostring(method)) end
    local results = table.pack(invoke(entry, method, ...))
    if not results[1] then error(results[2], 2) end -- a Java exception is positioned at the caller
    return table.unpack(results, 2, results.n)
  end

  function modemHost.invoke(name, method, ...) return invoke(virtual[name], method, ...) end
  function modemHost.getType(name) return api.getType(name) end
  function modemHost.hasType(name, ty) return api.hasType(name, ty) end
  function modemHost.getMethods(name) return api.getMethods(name) end

  function api.wrap(name)
    local entry = virtual[name]
    if not entry then return realPeripheral.wrap(name) end
    local wrapped = {}
    for _, method in ipairs(methodNames(name)) do
      wrapped[method] = function(...) return api.call(name, method, ...) end
    end
    wrappedNames[wrapped] = name
    return wrapped
  end

  local expect = dofile("/rom/modules/main/cc/expect.lua").expect
  function api.find(ty, filter)
    expect(1, ty, "string")
    expect(2, filter, "function", "nil")
    local results = {}
    for _, name in ipairs(api.getNames()) do
      if api.hasType(name, ty) then
        local wrapped = api.wrap(name)
        if wrapped and (filter == nil or filter(name, wrapped)) then results[#results + 1] = wrapped end
      end
    end
    return table.unpack(results)
  end

  -- ===== a block placed or broken next to the computer while it runs (sim commands) =====

  local ENGINE_ATTACH = { monitor = true, drive = true }

  --- A peripheral appears: a virtual one is built from its spec and `peripheral` is queued; a monitor or a drive is the
  --- engine's own, whose attach queues `peripheral` itself. From then on peripheral.getNames lists it.
  function core.extraHandlers.attachPeripheral(cmd)
    local def = cmd.peripheral
    if type(def) ~= "table" or type(def.name) ~= "string" or type(def.type) ~= "string" then
      return false, "attachPeripheral needs peripheral = { name, type, ... }"
    end
    if api.isPresent(def.name) then return false, "a peripheral is already attached as " .. def.name end
    if ENGINE_ATTACH[def.type] then
      if not core.periphemu then return false, "the engine cannot attach peripherals here" end
      core.periphemu.create(def.name, def.type)
      if def.type == "monitor" then
        pcall(realPeripheral.call, def.name, "setBlockSize", def.blocksWide or 1, def.blocksHigh or 1)
      end
      local listed = false
      for _, name in ipairs(engineNamed) do if name == def.name then listed = true end end
      if not listed then engineNamed[#engineNamed + 1] = def.name end
    else
      local ok, err = pcall(register, def)
      if not ok then return false, tostring(err) end
      os.queueEvent("peripheral", def.name)
    end
    exportsCache = nil
    return true
  end

  --- A peripheral goes away: `peripheral_detach` is queued and peripheral.getNames stops listing it.
  function core.extraHandlers.detachPeripheral(cmd)
    local name = cmd.name
    if type(name) ~= "string" then return false, "detachPeripheral needs name" end
    local entry = virtual[name]
    if entry and not entry.remote then
      if entry.modem then modems.remove(name) end
      if entry.addon and entry.addon.detach then entry.addon.detach() end
      virtual[name] = nil
      core.peripherals[name] = nil
      for i = #order, 1, -1 do if order[i] == name then table.remove(order, i) end end
      os.queueEvent("peripheral_detach", name)
    elseif not entry and realPeripheral.isPresent(name) and core.periphemu then
      core.periphemu.remove(name) -- the engine queues peripheral_detach
      for i = #engineNamed, 1, -1 do if engineNamed[i] == name then table.remove(engineNamed, i) end end
    else
      return false, "no peripheral named " .. name
    end
    exportsCache = nil
    return true
  end

  --- Monitor blocks added to or taken off a wall: its size changes and the engine sends monitor_resize a tick later.
  function core.extraHandlers.resizeMonitor(cmd)
    local name = cmd.monitor
    if type(name) ~= "string" or realPeripheral.getType(name) ~= "monitor" then return false, "no monitor named " .. tostring(name) end
    local w, h = tonumber(cmd.blocksWide), tonumber(cmd.blocksHigh)
    -- term_sizes.monitor in the modpack's computercraft-server.toml: 8 wide, 6 high at most
    if not w or not h or w < 1 or h < 1 or w > 8 or h > 6 then return false, "a monitor wall is 1x1 to 8x6 blocks" end
    local ok, err = pcall(realPeripheral.call, name, "setBlockSize", w, h)
    if not ok then return false, tostring(err) end
    return true
  end

  -- ===== what the wired relay and 2.2.36 links need from this layer =====

  if link then
    function linkHost.hasEnder()
      for _, entry in pairs(virtual) do
        if entry.modem and entry.modem.kind == "ender" and not entry.remote then return true end
      end
      return false
    end
  end

  if relay then
    --- This computer's peripherals as a linked computer (or one sharing its cable) sees them, in peripheral.getNames order; links not passed on.
    function linkHost.exports()
      if exportsCache then return exportsCache end
      local out = {}
      for _, name in ipairs(api.getNames()) do
        local entry = virtual[name]
        if not (entry and entry.remote) then
          out[#out + 1] = { name = name, types = { api.getType(name) }, methods = api.getMethods(name) or {} }
        end
      end
      exportsCache = out
      return out
    end

    function linkHost.localInventory(name)
      local entry = virtual[name]
      return entry and not entry.remote and entry.inventory or nil
    end

    function linkHost.localTarget(name)
      local entry = virtual[name]
      if not entry or entry.remote then return nil end
      if entry.qeHandler then return entry.qeHandler() end
      return entry.inventory
    end

    --- A call from a linked computer: it already waited for the server tick, so this runs at once.
    function linkHost.invokeNow(name, method, ...)
      local entry = virtual[name]
      if entry and not entry.remote then
        local fn = entry.methods[method]
        if type(fn) ~= "function" or tostring(method):sub(1, 2) == "__" then return false, "No such method " .. tostring(method) end
        if entry.mek then
          local ok, args = pcall(entry.mek.validate, method, table.pack(...))
          if not ok then return false, args end
          local done, results = pcall(entry.mek.run, method, args)
          if not done then return false, results end
          core.touch()
          return true, table.unpack(results, 1, results.n)
        end
        if core.beforeObserve then core.beforeObserve() end
        local results = table.pack(pcall(fn, ...))
        if not results[1] then return false, results[2] end
        core.touch()
        local n = results.n
        while n > 1 and results[n] == nil do n = n - 1 end
        return table.unpack(results, 1, n)
      end
      if realPeripheral.isPresent(name) then return pcall(realPeripheral.call, name, method, ...) end
      return false, "No peripheral: " .. tostring(name)
    end

    linkHost.invoke = modemHost.invoke
    linkHost.getType = modemHost.getType
    linkHost.hasType = modemHost.hasType
    linkHost.getMethods = modemHost.getMethods

    local function hasType(types, wanted)
      for _, t in ipairs(types or {}) do if t == wanted then return true end end
      return false
    end

    --- The inventory side of a linked computer's chest, for transfers.
    local function remoteInventory(id, rname)
      local proxy = { __remote = id, __rname = rname }
      local function ask(op, fields)
        fields.kind, fields.op, fields.name = "req", op, rname
        return relay.request(id, fields, false)
      end
      function proxy.__peek(slot) return ask("peek", { slot = slot }) end
      function proxy.__room(item, count, toSlot) return ask("room", { item = item, count = count, toSlot = toSlot }) end
      function proxy.__take(slot, count, item) return ask("take", { slot = slot, count = count, item = item }) end
      function proxy.__insert(item, count, toSlot) return ask("insert", { item = item, count = count, toSlot = toSlot }) end
      function proxy.__size() return ask("size", {}) end
      return proxy
    end

    function linkHost.attachRemote(name, info, id, rname)
      local entry = {
        name = name, remote = { id = id, name = rname },
        types = info.types or {}, methodOrder = info.methods or {}, methods = {},
      }
      local function call(method, keep, ...)
        return relay.request(id, { kind = "req", op = "call", name = rname, method = method, args = table.pack(...) }, keep)
      end
      for _, method in ipairs(entry.methodOrder) do
        local keep = not onServerThread(entry, method)
        entry.methods[method] = function(...) return call(method, keep, ...) end
      end
      if hasType(entry.types, "inventory") then
        local proxy = remoteInventory(id, rname)
        entry.remoteInv = proxy
        local methods = entry.methods
        --- A target on the same linked computer: that computer does the whole move.
        local function sameComputer(target)
          local other = type(target) == "string" and virtual[target]
          return other and other.remote and other.remote.id == id and other.remote.name or nil
        end
        local function push(toName, fromSlot, limit, toSlot)
          toName = checkString(1, toName)
          fromSlot = checkInt(2, fromSlot)
          if limit ~= nil then limit = checkInt(3, limit) end
          local there = sameComputer(toName)
          if there then return call("pushItems", false, there, fromSlot, limit, toSlot) end
          if toSlot ~= nil then toSlot = checkInt(4, toSlot) end
          local target = resolveInventory(toName, "Target")
          if toSlot ~= nil then
            -- without a toSlot the from slot is checked where the chest is, as the move starts
            slotInRange(fromSlot, proxy.__size(), "From slot")
            slotInRange(toSlot, slotsOf(target), "To slot")
          end
          if limit ~= nil and limit <= 0 then return 0 end
          return transfer(proxy, fromSlot, target, limit, toSlot)
        end
        if methods.pushItems then methods.pushItems = push end
        if methods.pullItems then
          function methods.pullItems(fromName, fromSlot, limit, toSlot)
            fromName = checkString(1, fromName)
            fromSlot = checkInt(2, fromSlot)
            if limit ~= nil then limit = checkInt(3, limit) end
            local there = sameComputer(fromName)
            if there then return call("pullItems", false, there, fromSlot, limit, toSlot) end
            if toSlot ~= nil then toSlot = checkInt(4, toSlot) end
            local source = resolveInventory(fromName, "Source")
            if toSlot ~= nil then
              slotInRange(fromSlot, slotsOf(source), "From slot")
              slotInRange(toSlot, proxy.__size(), "To slot")
            end
            if limit ~= nil and limit <= 0 then return 0 end
            return transfer(source, fromSlot, proxy, limit, toSlot)
          end
        end
        if methods.moveMany then
          function methods.moveMany(moves)
            local parsed = core.parseMoves(moves) -- a bad table raises here, as it does in the mod
            local translated = {}
            for i = 1, #parsed do
              local move = parsed[i]
              local there = sameComputer(move.to)
              if not there then translated = nil break end
              translated[i] = { fromSlot = move.fromSlot, to = there, toSlot = move.toSlot, limit = move.limit }
            end
            if translated and #parsed > 0 then return call("moveMany", false, translated) end
            return moveMany(push, moves)
          end
        end
        if link and methods.watch then function methods.watch() link.watch(name, id, rname) end end
        if link and methods.unwatch then function methods.unwatch() link.unwatch(name, id, rname) end end
      end
      virtual[name] = entry
      core.peripherals[name] = entry
    end

    function linkHost.detachRemote(name)
      virtual[name] = nil
      core.peripherals[name] = nil
    end

    core.afterSave = function()
      exportsCache = nil
      relay.publish()
    end
    core.onUnload = relay.publish
    if link then core.onTouch = link.onTouch end
  end

  modems.start()
  if relay then relay.publish() end

  _G.peripheral = api
  return api
end
