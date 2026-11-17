-- ccsim cc-shops: CC Shops (TechTastic) over Simple Shops (wolforce): the `shop` peripheral, its command-computer
-- variant and the `shop` turtle API.
--
-- Written from the released jars, checked with javap, and the source where it matches them:
--   1.18.2: ccshops-0.0.1.jar (Modrinth mTCrg0Ga, forge) with simpleshops 1.1.4 (CurseForge file 3806656).
--   1.20.1: ccshops-0.0.1.jar "0.0.1-fixed" (Modrinth XSzJW3ls) with simpleshops CurseForge file 4716851.
-- Both CC Shops jars hold the code of branch 1.20.x/main at 36f92f6 (TechTastic/CC-Shops): a turtle API of buy,
-- buyUp and buyDown only. The 1.18.x branch's restock/changePrice/profit/recall (d3fa015) never shipped.
-- Classes (io.github.techtastic.ccshops): peripheral/SimpleShopPeripheral, peripheral/SimpleShopCommandPeripheral,
-- forge/CCShopsForgePeripheralProvider, turtle/ShopAPI, mixin/MixinSimpleShopTileEntity, mixin/MixinTileTurtle;
-- Simple Shops: wolforce/simpleshops/SimpleShopTileEntity, SimpleShopBlock, StockBarItem.
-- docs/cc-shops.md has every rule and what is not simulated.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local MC = core.version and core.version.mc or "1.18.2"
  local NEW = MC ~= "1.18.2" -- Simple Shops for 1.20.1 matches items with ItemStack.is, 1.18.2 with sameItem
  local cfg = type(core.world.ccShops) == "table" and core.world.ccShops or {}
  local floor, min = math.floor, math.min

  local SHOP_BLOCK, CREATIVE_BLOCK = "simpleshops:simple_shop", "simpleshops:creative_simple_shop"
  local STOCKBARS = {
    ["simpleshops:wooden_stockbar"] = true, ["simpleshops:quartz_stockbar"] = true,
    ["simpleshops:green_stockbar"] = true, ["simpleshops:red_stockbar"] = true,
  }
  local OWN_ITEMS = { [SHOP_BLOCK] = true, [CREATIVE_BLOCK] = true }
  for k in pairs(STOCKBARS) do OWN_ITEMS[k] = true end
  local NIL_UUID = "00000000-0000-0000-0000-000000000000"

  local M = {}

  -- ===== Java and CC:Tweaked =====

  local function typeName(v) return v == nil and "nil" or type(v) end
  local function java(class, message) error("Java Exception Thrown: " .. class .. (message and (": " .. message) or ""), 0) end

  --- IArguments.getInt: getLong (finite, then Number.longValue: toward zero, saturating) cast to int (low 32 bits)
  local function getInt(i, v)
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, typeName(v)), 0) end
    if v ~= v then error(("bad argument #%d (number expected, got nan)"):format(i), 0) end
    if v == math.huge then error(("bad argument #%d (number expected, got inf)"):format(i), 0) end
    if v == -math.huge then error(("bad argument #%d (number expected, got -inf)"):format(i), 0) end
    if v >= 9223372036854775807 then return -1 end -- Long.MAX_VALUE's low 32 bits
    if v <= -9223372036854775808 then return 0 end
    local n = v >= 0 and floor(v) or -floor(-v)
    n = math.fmod(n, 4294967296)
    if n < 0 then n = n + 4294967296 end
    if n >= 2147483648 then n = n - 4294967296 end
    return n
  end

  local function getString(i, v)
    if type(v) ~= "string" then error(("bad argument #%d (string expected, got %s)"):format(i, typeName(v)), 0) end
    return v
  end

  local function getTable(i, v)
    if type(v) ~= "table" then error(("bad argument #%d (table expected, got %s)"):format(i, typeName(v)), 0) end
    return v
  end

  --- What a Lua value becomes in Java (CobaltLuaMachine.toObject): nil for what has no Java form
  local JAVA_CLASS = { number = "java.lang.Double", string = "java.lang.String", boolean = "java.lang.Boolean",
    table = "java.util.HashMap" }
  local function convertible(v) return JAVA_CLASS[type(v)] ~= nil end

  --- A checked cast that fails: ClassCastException as Java 17 words it (both classes are java.base's)
  local function cast(v, want)
    local have = JAVA_CLASS[type(v)]
    if have == want then return v end
    java("java.lang.ClassCastException", ("class %s cannot be cast to class %s (%s and %s are in module java.base of loader 'bootstrap')")
      :format(have, want, have, want))
  end

  --- (int) of a double
  local function d2i(d)
    if d ~= d then return 0 end
    if d >= 2147483647 then return 2147483647 end
    if d <= -2147483648 then return -2147483648 end
    return d >= 0 and floor(d) or -floor(-d)
  end

  -- ===== UUIDs (java.util.UUID.fromString, Java 17) =====

  local HEX = "0123456789abcdef"

  --- Long.parseLong(s, begin, end, 16), 1-based [b, e]. Returns sign and the magnitude as hex digits.
  local function parseHexLong(s, b, e)
    local function bad(at)
      java("java.lang.NumberFormatException", ('Error at index %d in: "%s"'):format(at - b, s:sub(b, e)))
    end
    if b > e then java("java.lang.NumberFormatException", 'For input string: "" under radix 16') end
    local i, negative = b, false
    local first = s:sub(i, i)
    if first:byte() < 48 then
      if first == "-" then negative = true elseif first ~= "+" then bad(i) end
      i = i + 1
      if i > e then bad(i) end
    end
    local limit = negative and "8000000000000000" or "7fffffffffffffff"
    local mag = ""
    while i <= e do
      local c = s:sub(i, i):lower()
      local d = HEX:find(c, 1, true)
      if not d or #c ~= 1 then bad(i) end
      mag = mag .. c
      mag = mag:gsub("^0+", "")
      if #mag > 16 or (#mag == 16 and mag > limit) then bad(i) end
      i = i + 1
    end
    return negative, mag
  end

  --- The low `n` hex digits of a two's complement long, as `value & mask` keeps them
  local function lowDigits(negative, mag, n)
    local digits = {}
    for k = 1, n do
      local pos = #mag - n + k
      digits[k] = pos >= 1 and (HEX:find(mag:sub(pos, pos), 1, true) - 1) or 0
    end
    if negative and mag ~= "" then
      -- 16^n - x: invert every digit, then add one
      for k = 1, n do digits[k] = 15 - digits[k] end
      local k = n
      while k >= 1 do
        digits[k] = digits[k] + 1
        if digits[k] < 16 then break end
        digits[k] = 0
        k = k - 1
      end
    end
    local out = {}
    for k = 1, n do out[k] = HEX:sub(digits[k] + 1, digits[k] + 1) end
    return table.concat(out)
  end

  --- UUID.fromString, then toString: the canonical lower-case form
  local function uuidOf(s)
    if #s > 36 then java("java.lang.IllegalArgumentException", "UUID string too large") end
    local dashes, from = {}, 1
    for k = 1, 5 do
      local at = s:find("-", from, true)
      dashes[k] = at or -1
      if not at then
        for j = k + 1, 5 do dashes[j] = -1 end
        break
      end
      from = at + 1
    end
    -- indexOf(-1 + 1) searches from the start again: a missing dash makes the later ones find earlier dashes, which
    -- the Java covers by checking dash4 and dash5 only; a missing dash before them leaves dash4 at -1 here too
    if dashes[4] < 0 or dashes[5] >= 0 then java("java.lang.IllegalArgumentException", "Invalid UUID string: " .. s) end
    local d1, d2, d3, d4 = dashes[1], dashes[2], dashes[3], dashes[4]
    local bounds = { { 1, d1 - 1, 8 }, { d1 + 1, d2 - 1, 4 }, { d2 + 1, d3 - 1, 4 }, { d3 + 1, d4 - 1, 4 }, { d4 + 1, #s, 12 } }
    local parts = {}
    for k, b in ipairs(bounds) do
      local negative, mag = parseHexLong(s, b[1], b[2])
      parts[k] = lowDigits(negative, mag, b[3])
    end
    return table.concat(parts, "-")
  end

  local function fixtureUuid(s, what)
    if s == nil then return nil end
    local ok, out = pcall(uuidOf, tostring(s))
    if not ok then error("ccsim: " .. what .. " is not a UUID: " .. tostring(out), 0) end
    return out
  end

  -- ===== items =====

  local gameData
  local function data()
    if not gameData then
      gameData = core.gameData or dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)
    end
    return gameData
  end
  local extraItems = {}
  for _, id in ipairs(cfg.items or {}) do extraItems[tostring(id)] = true end

  --- BuiltInRegistries.ITEM.get: an id nothing registered reads as air
  local function isItem(id)
    if id == "minecraft:air" or OWN_ITEMS[id] or extraItems[id] then return true end
    return data().isItem(id) == true
  end

  --- An ItemStack as the sim keeps it: nil is empty (count 0 or air)
  local function stack(def)
    if type(def) ~= "table" or def.name == nil then return nil end
    local name = tostring(def.name)
    if not name:find(":", 1, true) then name = "minecraft:" .. name end
    local count = tonumber(def.count) or 1
    if count <= 0 or name == "minecraft:air" then return nil end
    return { name = name, count = d2i(count), nbt = def.nbt }
  end

  local function copy(s, count)
    if not s then return nil end
    local c = {}
    for k, v in pairs(s) do c[k] = v end
    if count then c.count = count end
    if c.count <= 0 then return nil end
    return c
  end

  --- ItemData.fillBasic / ItemDetails.fillBasic: name, count and the NBT hash
  local function basic(s)
    if not s then return { name = "minecraft:air", count = 0 } end
    return { name = s.name, count = s.count, nbt = s.nbt }
  end

  --- 1.18.2 ItemStack.sameItem(other): false when other is empty; 1.20.1 ItemStack.is(other.getItem()): air is air
  local function sameItem(a, b)
    if NEW then return (a and a.name or "minecraft:air") == (b and b.name or "minecraft:air") end
    return b ~= nil and a ~= nil and a.name == b.name
  end

  local function count(s) return s and s.count or 0 end

  -- ===== players =====

  local players, entities = {}, {}
  local function setPlayers(list, into)
    for k in pairs(into) do into[k] = nil end
    for i, p in ipairs(list or {}) do
      if type(p) == "table" and p.uuid then
        into[fixtureUuid(p.uuid, "ccShops players/entities[" .. i .. "].uuid")] = tostring(p.name or "")
      end
    end
  end
  setPlayers(cfg.players, players)
  setPlayers(cfg.entities, entities)

  -- ===== shops =====

  local byName = {} -- peripheral name -> shop, for world.peripherals entries
  local all = {}    -- every shop, in the order it was made

  local function newShop(def, creative, label)
    local s = {
      label = label,
      output = stack(def.stock),
      cost = stack(def.cost),
      bar = stack(def.bar),
      invNr = d2i(tonumber(def.stored) or 0),
      gainsNr = d2i(tonumber(def.gains) or 0),
      owner = fixtureUuid(def.owner, label .. ".owner") or NIL_UUID,
      creative = creative == true,
    }
    all[#all + 1] = s
    return s
  end

  --- SimpleShopTileEntity.getStockNr: whole sales left, 0 with nothing to sell
  local function stockNr(s)
    local per = count(s.output)
    if per == 0 then return 0 end
    local q = s.invNr / per
    return q >= 0 and floor(q) or -floor(-q)
  end

  -- Every peripheral attachment of a shop to this computer (SimpleShopPeripheral.attach): name -> resolve(). Each one
  -- that is the shop gets the event, as ccshops$fireEvent queues it once per IComputerAccess. Looked up when an event
  -- fires: a turtle's first side refresh runs before core.turtle exists.
  local attachments = {}
  local attachOrder = {}

  --- ccshops$fireEvent: every computer the shop is attached to
  local function fire(s, ...)
    for _, name in ipairs(attachOrder) do
      local resolve = attachments[name]
      if resolve then
        local ok, other = pcall(resolve)
        if ok and other == s then os.queueEvent(...) end
      end
    end
  end

  local function isShopBlock(b) return b ~= nil and (b.name == SHOP_BLOCK or b.name == CREATIVE_BLOCK) end

  local function key(x, y, z) return x .. "," .. y .. "," .. z end

  --- The shop of a block in the world (turtle and placed computers)
  local function blockShop(b, x, y, z)
    if not isShopBlock(b) then return nil end
    if not b.__ccshop then
      b.__ccshop = newShop(type(b.def) == "table" and type(b.def.shop) == "table" and b.def.shop or {},
        b.name == CREATIVE_BLOCK, "block " .. key(x, y, z))
      b.__ccshop.pos = { x = x, y = y, z = z }
    end
    return b.__ccshop
  end

  local function shopAt(x, y, z)
    local brain = core.turtle
    if not brain then return nil end
    return blockShop(brain.blockAt(x, y, z), x, y, z)
  end

  -- block worlds: a shop block next to the computer is a peripheral of its own (CCShopsForgePeripheralProvider)
  core.blockPeripherals = core.blockPeripherals or {}
  core.blockPeripherals[SHOP_BLOCK] = "shop"
  core.blockPeripherals[CREATIVE_BLOCK] = "shop"

  -- ===== the peripheral =====

  local BASE = { "getStockItem", "getStockAmount", "getCostItem", "getGainsAmount", "getBarItem", "getOwner" }
  local COMMAND = { "setStockItem", "setStockAmount", "setCostItem", "setGainsAmount", "setBarItem", "setOwner" }

  --- SimpleShopCommandPeripheral.getItemStackFromData
  local function itemFromData(t)
    local name = t.name
    if not convertible(name) then error("Invalid Item Data, needs name", 0) end
    name = cast(name, "java.lang.String")
    local id = C.resourceLocation(name)
    local known = isItem(id)
    if (not known or id == "minecraft:air") and name ~= "minecraft:air" then
      error("Invalid Item Name, use namespace:id format", 0)
    end
    local n = 1
    if convertible(t.count) then n = d2i(cast(t.count, "java.lang.Double")) end
    if not known then id = "minecraft:air" end
    return stack({ name = id, count = n })
  end

  local function ownerResult(s)
    local name = players[s.owner] or entities[s.owner]
    return name, s.owner
  end

  local function methodsFor(resolve, command)
    local m = {}
    function m.getStockItem() return basic(copy(resolve().output)) end
    function m.getStockAmount() return stockNr(resolve()) end
    function m.getCostItem() return basic(copy(resolve().cost)) end
    function m.getGainsAmount() return resolve().gainsNr end
    function m.getBarItem() return basic(copy(resolve().bar)) end
    function m.getOwner() return ownerResult(resolve()) end
    if command then
      function m.setStockItem(t) local item = itemFromData(getTable(1, t)) resolve().output = copy(item) end
      function m.setStockAmount(n) n = getInt(1, n) resolve().invNr = n end
      function m.setCostItem(t) local item = itemFromData(getTable(1, t)) resolve().cost = copy(item) end
      function m.setGainsAmount(n) n = getInt(1, n) resolve().gainsNr = n end
      function m.setBarItem(t)
        local item = itemFromData(getTable(1, t))
        -- sets the bar when the item is a stock viewer, then throws either way
        if item and STOCKBARS[item.name] then resolve().bar = copy(item) end
        error("Not a Bar", 0)
      end
      function m.setOwner(text)
        text = getString(1, text)
        local uuid = uuidOf(text)
        -- sets the owner when a player or entity with that UUID is loaded, then throws either way
        if players[uuid] or entities[uuid] then resolve().owner = uuid end
        error("Invalid UUID", 0)
      end
    end
    return m
  end

  local function shopState(s)
    local name = ownerResult(s)
    return {
      stock = basic(s.output), stored = s.invNr, stockAmount = stockNr(s), cost = basic(s.cost),
      gains = s.gainsNr, bar = basic(s.bar), owner = s.owner, ownerName = name, creative = s.creative,
      pos = s.pos and { x = s.pos.x, y = s.pos.y, z = s.pos.z } or nil,
    }
  end

  function M.peripheral(def)
    local resolve
    local command
    if type(def.blockPos) == "table" then
      local p = def.blockPos
      -- the block the turtle (or placed computer) sees on that side; a placed command computer gets the setters
      resolve = function()
        local s = shopAt(p.x, p.y, p.z)
        if not s then error("ccsim: the shop block at " .. key(p.x, p.y, p.z) .. " is gone", 0) end
        return s
      end
      local placed = core.world.placed
      command = type(placed) == "table" and placed.block == "computercraft:computer_command"
    else
      local s = byName[def.name] or newShop(def, def.creative, "peripheral " .. tostring(def.name))
      byName[def.name] = s
      resolve = function() return s end
      command = def.commandComputer
      if command == nil then command = cfg.commandComputer == true end
    end
    local token = {}
    attachments[token] = resolve
    attachOrder[#attachOrder + 1] = token
    local methods = methodsFor(resolve, command)
    local names = {}
    for _, n in ipairs(command and COMMAND or {}) do names[#names + 1] = n end
    for _, n in ipairs(BASE) do names[#names + 1] = n end
    local computerThread = {}
    for _, n in ipairs(names) do computerThread[n] = true end
    return {
      methods = methods,
      methodOrder = C.hashMapOrder(names),
      computerThread = computerThread, -- no method is mainThread
      exactReturns = true,
      state = function()
        local ok, s = pcall(resolve)
        return ok and shopState(s) or { gone = true }
      end,
      detach = function()
        attachments[token] = nil
        for i, t in ipairs(attachOrder) do
          if t == token then table.remove(attachOrder, i) break end
        end
      end,
    }
  end

  -- ===== buying: SimpleShopTileEntity.tryBuy (a player) and ccshops$tryBuyWithTurtle =====

  --- A player using the shop: tryBuy, with the mixin's buy_attempt at its end
  local function playerBuy(s, playerName, input)
    local success = false
    if not (stockNr(s) <= 0 and not s.creative) then
      local cost = copy(s.cost)
      if sameItem(input, cost) and count(input) >= count(cost) then
        success = true -- the mixin's flag, set where tryBuy reads the output stack
        local result = copy(s.output)
        if not s.creative then s.invNr = s.invNr - count(result) end
        s.gainsNr = s.gainsNr + count(cost)
        s.lastSale = { player = playerName, given = basic(result), change = basic(copy(input, count(input) - count(cost))) }
      end
    end
    fire(s, "buy_attempt", playerName, basic(input), s.creative, success)
  end

  -- ===== the turtle API (1.18.2 only) =====

  local ghosts = {} -- slot -> the item a count-0 stack still names (see below)
  local watched

  --- A turtle slot the mod set to a 0-count stack (paying with the whole stack) still holds that item: it reads as
  --- empty, but ItemStack.grow on it brings the old item back. The brain keeps empty slots as nil, so the sim keeps
  --- the item here until anything is put into the slot (any brain write to a nil slot replaces the stack in Java too).
  local function watchSlots(t)
    if watched == t.slots then return end
    watched = t.slots
    for k in pairs(ghosts) do ghosts[k] = nil end
    setmetatable(t.slots, { __newindex = function(tb, k, v)
      ghosts[k] = nil
      rawset(tb, k, v)
    end })
  end

  local function maxStack(item)
    local brain = core.turtle
    return min(item.maxCount or brain.items.maxCount(item.name), 64)
  end

  --- ccshops$hasOpenSpace: `isEmpty() || (is(item) && fits) && slot != selected`, so an empty selected slot counts
  local function openSlot(t, result)
    local want = result and result.name or "minecraft:air"
    for i = 1, 16 do
      local test = t.slots[i]
      if test == nil then return i end
      if test.name == want and test.count <= maxStack(test) - count(result) and t.selected ~= i then return i end
    end
    return -1
  end

  local function turtleBuy(s)
    local brain = core.turtle
    local t = brain.state
    watchSlots(t)
    local input = t.slots[t.selected]
    local item = basic(input)
    local label = os.getComputerLabel()
    if stockNr(s) <= 0 and not s.creative then
      fire(s, "buy_attempt", label, item, false, false)
      return { ok = false, msg = "Out of Stock" }
    end
    local result, cost = copy(s.output), copy(s.cost)
    local slot = openSlot(t, result)
    if not sameItem(input, cost) then
      fire(s, "buy_attempt", label, item, s.creative, false)
      return { ok = false, msg = "Incorrect Payment Item" }
    elseif count(input) < count(cost) then
      fire(s, "buy_attempt", label, item, s.creative, false)
      return { ok = false, msg = "Insufficient Funds" }
    elseif slot == -1 then
      fire(s, "buy_attempt", label, item, s.creative, false)
      return { ok = false, msg = "Not Enough Space" }
    end
    if not s.creative then s.invNr = s.invNr - count(result) end
    s.gainsNr = s.gainsNr + count(cost)
    local sel = t.selected
    local left = count(input) - count(cost)
    if left > 0 then
      t.slots[sel] = copy(input, left)
    else
      t.slots[sel] = nil
      ghosts[sel] = copy(input, 1)
    end
    local current = rawget(t.slots, slot)
    if current == nil then
      local ghost = ghosts[slot]
      if ghost then
        -- not ItemStack.EMPTY itself: grow() revives the item the slot last held
        if count(result) > 0 then t.slots[slot] = copy(ghost, count(result)) end
      elseif result then
        t.slots[slot] = copy(result)
      end
    else
      current.count = current.count + count(result)
    end
    fire(s, "buy_attempt", label, item, s.creative, true)
    return { ok = true, n = 0 }
  end

  if type(core.world.turtle) == "table" and not NEW then
    -- MixinTileTurtle adds the API to every turtle. On 1.20.1 its reflection (getDeclaredMethod("addApi") with no
    -- parameters) always fails and the exception is swallowed: no turtle there has the API.
    local function command(interact)
      return function()
        local brain = core.turtle
        return brain.execute(function()
          local t = brain.state
          local dir = (interact == "up" or interact == "down") and interact or t.facing
          local x, y, z = brain.world.offset(core.position.x, core.position.y, core.position.z, dir)
          local s = shopAt(x, y, z)
          if not s then return { ok = false, msg = "Not a Shop" } end
          return turtleBuy(s)
        end)
      end
    end
    _G.shop = { buy = command("forward"), buyUp = command("up"), buyDown = command("down") }
  end

  -- ===== sim commands =====

  local function findShop(cmd)
    local ref = cmd.shop
    if type(cmd.pos) == "table" then ref = key(cmd.pos[1] or cmd.pos.x, cmd.pos[2] or cmd.pos.y, cmd.pos[3] or cmd.pos.z) end
    if type(ref) ~= "string" then return nil, "shop: a peripheral name or \"x,y,z\" of a shop block" end
    if byName[ref] then return byName[ref] end
    local x, y, z = ref:match("^(%-?%d+),(%-?%d+),(%-?%d+)$")
    if x then
      local s = shopAt(tonumber(x), tonumber(y), tonumber(z))
      if s then return s end
      return nil, "no shop block at " .. ref
    end
    return nil, "no shop named " .. ref
  end

  local handlers = {}

  --- A player right-clicks the shop holding `item` (SimpleShopBlock.use, then tryBuy)
  function handlers.shopPlayerBuy(cmd)
    local s, err = findShop(cmd)
    if not s then return false, err end
    local name = tostring(cmd.player or "Player")
    local uuid = cmd.uuid and fixtureUuid(cmd.uuid, "uuid") or nil
    -- isOwner: a creative shop belongs to anyone in creative mode, a normal one to its owner's UUID
    if (s.creative and cmd.creativeMode == true) or (not s.creative and uuid ~= nil and uuid == s.owner) then
      return false, "that player owns this shop: using it sets the cost or stocks it, which the sim does not do"
    end
    if not s.output then return false, "the shop sells nothing: using it buys nothing and sends no event" end
    playerBuy(s, name, stack(cmd.item))
    return true
  end

  --- Change a shop as its owner or a server admin would (no events)
  function handlers.shopSet(cmd)
    local s, err = findShop(cmd)
    if not s then return false, err end
    if cmd.stock ~= nil then s.output = stack(cmd.stock) end
    if cmd.cost ~= nil then s.cost = stack(cmd.cost) end
    if cmd.bar ~= nil then s.bar = stack(cmd.bar) end
    if cmd.stored ~= nil then s.invNr = d2i(tonumber(cmd.stored) or 0) end
    if cmd.gains ~= nil then s.gainsNr = d2i(tonumber(cmd.gains) or 0) end
    if cmd.owner ~= nil then
      local ok, u = pcall(fixtureUuid, cmd.owner, "owner")
      if not ok then return false, u end
      s.owner = u
    end
    return true
  end

  --- Who is online (getOwner and setOwner look players and entities up by UUID)
  function handlers.shopSetPlayers(cmd)
    local ok, e = pcall(function()
      if cmd.players ~= nil then setPlayers(cmd.players, players) end
      if cmd.entities ~= nil then setPlayers(cmd.entities, entities) end
    end)
    if not ok then return false, e end
    return true
  end

  M.handlers = handlers

  function M.state()
    local out = { shops = {}, ghosts = {} }
    for _, s in ipairs(all) do
      local st = shopState(s)
      st.label = s.label
      st.lastSale = s.lastSale and C.deepCopy(s.lastSale) or nil
      out.shops[#out.shops + 1] = st
    end
    for slot, g in pairs(ghosts) do out.ghosts[tostring(slot)] = g.name end
    if next(out.ghosts) == nil then out.ghosts = nil end
    return out
  end

  return M
end
