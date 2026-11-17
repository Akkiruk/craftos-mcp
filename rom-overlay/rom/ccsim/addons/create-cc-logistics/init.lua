-- ccsim create-cc-logistics: Create: CC Total Logistics and its four ComputerCraft peripherals.
--
-- Written from gitlab.com/xeli-cloud/create-cc-logistics: branch 1.20.1-forge at f40f558 (mod_version 0.3.7) and
-- master at 5f952d2 (only CI and README changes after 9efe133 "v 0.3.6"), and checked with javap against the released
-- jars createcclogistics-1.20.1-forge-0.3.7.jar and createcclogistics-1.21.1-0.3.6.jar (method names, signatures,
-- every error string). Source files, relative to src/main/kotlin/com/xeli/createcclogistics/:
--   LogisticsMod (which blocks get which peripheral); peripheral/{DigitalStockTickerPeripheral,PackagePortPeripheral,
--   RedstoneRequesterPeripheral,ClipboardPeripheral,AssertBetween}; peripheral/itemhandling/{ItemDetails,
--   ReinterpretItemTag}.
-- Create's side, from Creators-of-Create/Create at tag mc1.20.1-6.0.8, relative to
-- src/main/java/com/simibubi/create/content/:
--   logistics/packager/{InventorySummary,PackagerBlockEntity,PackagingRequest}; logistics/packagerLink/
--   {LogisticsManager,LogisticallyLinkedBehaviour,PackagerLinkBlockEntity}; logistics/stockTicker/
--   {StockCheckingBlockEntity,PackageOrder,PackageOrderWithCrafts}; logistics/box/{PackageItem,PackageStyles};
--   logistics/packagePort/{PackagePortBlockEntity,PackagePortAutomationInventoryWrapper}; logistics/BigItemStack;
--   equipment/clipboard/{ClipboardEntry,ClipboardBlockEntity}.
-- Minecraft's side (Item.toString, the ItemStack codec) was read in the official 1.20.1 and 1.21.1 server jars.
--
-- The worlds are 1.20.1 or 1.21.1 (the mod has no 1.18.2 release); the version picks the item formats.
-- docs/create-cc-logistics.md lists every behaviour with its source, and what is not simulated.
return function(core, host)
  local create = core.loadAddon("create")
  local C = create.C
  local floor = math.floor
  local cfg = core.world.createLogistics or {}
  local V21 = core.version.mc == "1.21.1"

  local M = {}
  local INF = 1000000000 -- BigItemStack.INF
  local PACKAGE_SLOTS = 9 -- PackageItem.SLOTS
  local PORT_SLOTS = 18 -- PackagePortBlockEntity: new SmartInventory(18, ...)
  local CYCLE = 20 -- PackagerBlockEntity.CYCLE
  local TRAVEL = tonumber(cfg.travelTicks) or 40
  local BOXES = { "create:cardboard_package_12x12", "create:cardboard_package_10x12",
    "create:cardboard_package_10x8", "create:cardboard_package_12x10" } -- PackageStyles.STYLES, the standard ones

  local function lua(message) error(message, 0) end

  -- AssertBetween.kt
  local function assertBetween(value, min, max, message)
    if value < min or value > max then lua((message:gsub("%%s", "between " .. min .. " and " .. max))) end
  end

  -- ===== items =====
  -- An item is the sim's usual { name, count, nbt?, displayName?, maxCount? } plus, for the item JSON the mod prints
  -- and reads, `tag` (1.20.1: the NBT as JSON) or `components` (1.21.1). Two stacks stack when name and tag match.

  local gameData
  local function data()
    if gameData == nil then
      local ok, d = pcall(function()
        return core.gameData or dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)
      end)
      gameData = ok and d or false
    end
    return gameData or nil
  end

  local mentioned = {} -- item ids the world names: they exist even when the game data does not know them
  local function mention(name) if type(name) == "string" then mentioned[name] = true end end
  for _, id in ipairs(cfg.items or {}) do mention(id) end

  local function canonical(v)
    if type(v) ~= "table" then return tostring(v) end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local out = {}
    for _, k in ipairs(keys) do
      local x = v[k]
      if x == nil then x = v[tonumber(k)] end
      out[#out + 1] = k .. "=" .. canonical(x)
    end
    return "{" .. table.concat(out, ",") .. "}"
  end

  local function extra(item)
    if V21 then return item.components end
    return item.tag
  end

  local function itemKey(item)
    local e = extra(item)
    if e ~= nil and next(e) ~= nil then return item.name .. "|" .. canonical(e) end
    if item.nbt then return item.name .. "|nbt:" .. item.nbt end
    return item.name
  end

  local function stackable(a, b) return itemKey(a) == itemKey(b) end -- ItemHandlerHelper.canItemStacksStack
  local function maxStack(item) return item.maxCount or 64 end

  local function copyItem(item, count)
    local out = {}
    for k, v in pairs(item) do out[k] = v end
    if count then out.count = count end
    return out
  end

  local function displayName(item) return host.itemDetail(item).displayName end

  --- Item.toString(): 1.20.1 gives the path ("iron_ingot"), 1.21.1 the registered name ("minecraft:iron_ingot")
  local function itemToString(name)
    if V21 then return name end
    return name:match(":(.+)$") or name
  end

  -- ----- the JSON the mod prints: Gson's toJson of ItemStack.CODEC -----

  local function javaStringHash(s)
    local h = 0
    for i = 1, #s do h = (h * 31 + s:byte(i)) % 4294967296 end
    return h
  end

  --- a CompoundTag's keys as its HashMap (default capacity 16) iterates them
  local function hashMapKeys(keys)
    local cap = 16
    while #keys > cap * 0.75 do cap = cap * 2 end
    local rows = {}
    for i, k in ipairs(keys) do
      local h = javaStringHash(k)
      h = bit32.bxor(h, bit32.rshift(h, 16))
      rows[i] = { k = k, b = bit32.band(h, cap - 1) }
    end
    table.sort(rows, function(a, b)
      if a.b ~= b.b then return a.b < b.b end
      return a.k < b.k
    end)
    local out = {}
    for i, r in ipairs(rows) do out[i] = r.k end
    return out
  end

  local function jsonString(s)
    -- Gson escapes HTML characters by default
    return '"' .. s:gsub('[%c"\\<>&=\']', function(c)
      if c == '"' then return '\\"' end
      if c == "\\" then return "\\\\" end
      if c == "\n" then return "\\n" end
      if c == "\t" then return "\\t" end
      if c == "\r" then return "\\r" end
      if c == "\b" then return "\\b" end
      if c == "\f" then return "\\f" end
      return ("\\u%04x"):format(c:byte())
    end) .. '"'
  end

  local function javaDouble(d)
    if d ~= d then return "NaN" end
    if d == math.huge then return "Infinity" end
    if d == -math.huge then return "-Infinity" end
    local a = math.abs(d)
    if a >= 1e-3 and a < 1e7 then
      for p = 1, 17 do
        local s = ("%." .. p .. "g"):format(d)
        if tonumber(s) == d then
          if not s:find("[.e]") then s = s .. ".0" end
          return s
        end
      end
    end
    for p = 1, 17 do
      local s = ("%." .. p .. "e"):format(d)
      if tonumber(s) == d then
        local m, e = s:match("^(.-)e(.*)$")
        m = m:gsub("0+$", ""):gsub("%.$", ".0")
        if not m:find("%.") then m = m .. ".0" end
        return m .. "E" .. tostring(tonumber(e))
      end
    end
    return tostring(d)
  end

  local function isArray(t)
    local n = 0
    for _ in pairs(t) do n = n + 1 end
    for i = 1, n do if t[i] == nil then return false end end
    return n > 0
  end

  local function json(v)
    local ty = type(v)
    if ty == "string" then return jsonString(v) end
    if ty == "boolean" then return v and "1" or "0" end -- NBT has no booleans: a byte
    if ty == "number" then
      if v == floor(v) and math.abs(v) < 2 ^ 53 then return ("%d"):format(v) end
      return javaDouble(v)
    end
    if ty == "table" then
      if isArray(v) then
        local out = {}
        for i, x in ipairs(v) do out[i] = json(x) end
        return "[" .. table.concat(out, ",") .. "]"
      end
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = tostring(k) end
      local out = {}
      for _, k in ipairs(hashMapKeys(keys)) do out[#out + 1] = jsonString(k) .. ":" .. json(v[k]) end
      return "{" .. table.concat(out, ",") .. "}"
    end
    return "null"
  end

  --- ItemDetails.encodeItemAsJson: the stack through ItemStack.CODEC, then Gson
  local function encodeItem(item, count)
    if V21 then
      if count < 1 or count > 99 then C.java("java.util.NoSuchElementException", "No value present") end
      local s = '{"id":' .. jsonString(item.name) .. ',"count":' .. count
      if item.components and next(item.components) then s = s .. ',"components":' .. json(item.components) end
      return s .. "}"
    end
    local s = '{"id":' .. jsonString(item.name) .. ',"Count":' .. count
    if item.tag and next(item.tag) then s = s .. ',"tag":' .. json(item.tag) end
    return s .. "}"
  end

  -- ----- the JSON the mod reads: JsonParser.parseString, then ItemStack.CODEC.decode -----

  local function validLocation(s)
    local ns, path = "minecraft", s
    local i = s:find(":", 1, true)
    if i then
      path = s:sub(i + 1)
      if i > 1 then ns = s:sub(1, i - 1) end
    end
    if ns:find("[^a-z0-9_.%-]") or path:find("[^a-z0-9/._%-]") then return nil end
    return ns .. ":" .. path
  end

  --- BuiltInRegistries.ITEM.byNameCodec(): the id must name a registered item
  local function knownItem(id)
    if mentioned[id] then return true end
    local d = data()
    if id:sub(1, 10) == "minecraft:" and d and d.isItem then return d.isItem(id) end
    return true -- other mods' items: the sim cannot tell, so any well-formed id exists
  end

  local function notParseable(s) lua('Item not parseable from "' .. s .. '" or non-existent') end

  --- a JSON number as Codec.INT reads it (LazilyParsedNumber.intValue), booleans as 1 and 0; nil when not a number
  local function codecInt(v)
    if type(v) == "number" then return C.toInt(v) end
    if type(v) == "boolean" then return v and 1 or 0 end
    return nil
  end

  --- String.reinterpret: returns an item copy with `count` the stack's own count, `empty` when it is ItemStack.EMPTY
  local function decodeItem(s, original)
    local ok, value = pcall(textutils.unserializeJSON, s)
    local trimmed = s:match("^%s*(.-)%s*$")
    if not ok or (value == nil and trimmed:find("[{}%[%]:,\"'%s;=#/\\]")) then
      -- Gson's lenient reader takes one bare word as a string, but anything else it cannot read throws, uncaught
      -- ("minecraft:iron_ingot" stops at the colon: "Did not consume the entire document" or a syntax error)
      C.java("com.google.gson.JsonSyntaxException")
    end
    if type(value) ~= "table" then notParseable(original or s) end
    local rawId = value.id
    if type(rawId) ~= "string" then notParseable(original or s) end
    local id = validLocation(rawId)
    if not id then notParseable(original or s) end
    local count
    if V21 then
      count = codecInt(value.count)
      if count == nil or count < 1 or count > 99 then count = 1 end -- intRange(1, 99).fieldOf("count").orElse(1)
      if id == "minecraft:air" then notParseable(original or s) end -- ITEM_NON_AIR_CODEC
    else
      count = codecInt(value.Count)
      if count == nil then notParseable(original or s) end
      -- CompoundTag.CODEC: "Not a compound tag" for anything but a JSON object
      if value.tag ~= nil and (type(value.tag) ~= "table" or isArray(value.tag)) then notParseable(original or s) end
    end
    if id ~= "minecraft:air" and not knownItem(id) then notParseable(original or s) end
    local item = { name = id, count = count }
    if V21 then
      if type(value.components) == "table" and next(value.components) then item.components = value.components end
    elseif type(value.tag) == "table" and next(value.tag) then
      item.tag = value.tag
    end
    item.empty = id == "minecraft:air" or count <= 0
    return item
  end

  --- String.reinterpretAsID: {"id": id, "Count": 1} (1.20.1) or {"id": id, "count": 1} (1.21.1)
  local function decodeId(id)
    local s = '{"id":' .. jsonString(id) .. (V21 and ',"count":1}' or ',"Count":1}')
    return decodeItem(s, id)
  end

  -- ===== InventorySummary =====
  -- Items keyed like Create's IdentityHashMap<Item, List<BigItemStack>>: entries of one item stay together, items in
  -- the order first seen (the real order is the Item objects' identity hashes).

  local function newSummary()
    local s = { byName = {}, names = {}, total = 0 }
    function s.add(item, count)
      if count == 0 or item.empty then return end
      if s.total < INF then s.total = s.total + count end
      local list = s.byName[item.name]
      if not list then
        list = {}
        s.byName[item.name] = list
        s.names[#s.names + 1] = item.name
      end
      for _, e in ipairs(list) do
        if stackable(e.stack, item) then
          if e.count < INF then e.count = e.count + count end
          return
        end
      end
      local stack = copyItem(item)
      if stack.count > maxStack(stack) then stack.count = 1 end
      list[#list + 1] = { stack = stack, count = count }
    end
    function s.addSummary(other)
      for _, name in ipairs(other.names) do
        for _, e in ipairs(other.byName[name]) do s.add(e.stack, e.count) end
      end
    end
    function s.stacks()
      local out = {}
      for _, name in ipairs(s.names) do
        for _, e in ipairs(s.byName[name]) do out[#out + 1] = e end
      end
      return out
    end
    function s.countOf(item)
      if item.empty then return 0 end
      for _, e in ipairs(s.byName[item.name] or {}) do
        if stackable(e.stack, item) then return e.count end
      end
      return 0
    end
    return s
  end

  -- ===== logistics networks: stock links on packagers, each facing an inventory =====

  local networks, netOrder = {}, {}
  local linkCount = 0

  local function newLink(net, spec, i)
    linkCount = linkCount + 1
    local l = {
      net = net, name = spec.name or ("link_" .. i), power = tonumber(spec.power) or 0,
      packager = spec.packager ~= false, block = spec.block, frogport = spec.frogport,
      frogportAddress = spec.frogportAddress, held = nil, anim = 0, queue = {}, travel = tonumber(spec.travelTicks),
      id = linkCount,
    }
    if type(spec.inventory) == "string" then
      l.invName = spec.inventory
    elseif spec.inventory ~= false and (spec.items or spec.size or spec.inventory == nil) then
      for _, item in pairs(spec.items or {}) do mention(item.name) end
      l.ownInv = host.newInventory({ size = spec.size or 27, items = spec.items or {} })
    end
    --- the block the packager faces: the fixture's `block`, else the inventory peripheral's type, else a chest
    function l.blockId()
      if l.block then return l.block end
      if l.invName then
        local entry = host.find(l.invName)
        local ty = entry and entry.def and entry.def.type
        if type(ty) == "string" and ty:find(":", 1, true) then return ty end
        return "minecraft:chest"
      end
      if l.ownInv then return "minecraft:chest" end
      return "minecraft:air"
    end
    function l.inventory()
      if l.ownInv then return l.ownInv end
      if l.invName then return host.findInventory(l.invName) end
      return nil
    end
    return l
  end

  for id, n in pairs(cfg.networks or {}) do
    local net = { id = tostring(id), links = {}, travel = tonumber(n.travelTicks) }
    for i, spec in ipairs(n.links or {}) do net.links[i] = newLink(net, spec, i) end
    networks[net.id] = net
    netOrder[#netOrder + 1] = net.id
  end
  table.sort(netOrder)
  for _, def in ipairs(core.world.peripherals or {}) do
    for _, item in pairs(def.items or {}) do if type(item) == "table" then mention(item.name) end end
  end

  local function network(id)
    id = tostring(id or "")
    local net = networks[id]
    if not net then
      net = { id = id, links = {} }
      networks[id] = net
      netOrder[#netOrder + 1] = id
    end
    return net
  end

  local function slotsOf(inv)
    if inv.size then return inv.size() end
    if inv.__size then return inv.__size() end
    return 0
  end

  --- LogisticallyLinkedBehaviour.getAllPresent: a link powered at 15 leaves the network
  local function present(net)
    local out = {}
    for _, l in ipairs(net.links) do if l.power ~= 15 then out[#out + 1] = l end end
    return out
  end

  --- PackagerLinkBlockEntity.getPackager
  local function hasPackager(l) return l.packager and l.power ~= 15 end

  --- PackagerBlockEntity.getAvailableItems: every slot as extractItem(slot, limit, simulate) sees it
  local function availableItems(l)
    local s = newSummary()
    local inv = l.inventory()
    if not inv then return s end
    for slot = 1, slotsOf(inv) do
      local item = inv.__peek and inv.__peek(slot)
      if item then s.add(item, math.min(item.count, maxStack(item))) end
    end
    return s
  end

  --- LogisticsManager.getInventoryIdentifierFromLink
  local function inventoryId(l)
    if not hasPackager(l) or not l.inventory() then return nil end
    return l.invName and ("inv:" .. l.invName) or ("own:" .. l.id)
  end

  --- LogisticsManager.createSummaryOfNetwork (the accurate summary: rebuilt every tick)
  local function summaryOf(netId)
    local net = networks[tostring(netId or "")]
    local out = newSummary()
    if not net then return out end
    local seen = {}
    for _, l in ipairs(present(net)) do
      local id = inventoryId(l)
      if not (id and seen[id]) then
        if id then seen[id] = true end
        if hasPackager(l) then out.addSummary(availableItems(l)) end
      end
    end
    return out
  end

  -- ===== packages =====

  local packageSerial = 0
  local function newPackage(contents, address, fragment)
    packageSerial = packageSerial + 1
    local item = {
      name = BOXES[(packageSerial - 1) % #BOXES + 1], count = 1, maxCount = 1,
      nbt = ("%032x"):format(packageSerial * 2654435761 % 4294967296),
      __pkg = { contents = contents, address = address, fragment = fragment, serial = packageSerial },
    }
    return item
  end

  local function pkgOf(item) return item and item.__pkg end

  -- Glob.toRegexPattern, as far as the sim knows it: * any run, ? one character, everything else literal
  local function globMatch(glob, s)
    local pat = "^" .. glob:gsub("[%^%$%(%)%%%.%[%]%+%-]", "%%%0"):gsub("%*", ".*"):gsub("%?", ".") .. "$"
    return s:match(pat) ~= nil
  end

  local function blank(s) return s:match("^%s*$") ~= nil end

  --- PackageItem.matchAddress(boxAddress, address)
  local function matchAddress(boxAddress, address)
    if blank(address) then return blank(boxAddress) end
    if address == "*" or boxAddress == "*" then return true end
    if address == boxAddress then return true end
    return globMatch(boxAddress, address) or globMatch(address, boxAddress)
  end

  -- ===== package ports (frogports, postboxes) =====

  local ports, portOrder = {}, {}

  local function newPort(def)
    local o = { kind = "packageport", def = def, slots = {}, filter = def.addressFilter or "",
      accepts = def.acceptsPackages ~= false }
    local function contents(items)
      local c = {}
      for i, item in ipairs(items or {}) do
        if i > PACKAGE_SLOTS then break end
        mention(item.name)
        c[i] = copyItem(item, item.count or 1)
      end
      return c
    end
    for i, p in ipairs(def.packages or {}) do
      local slot = tonumber(p.slot) or i
      local fragment = nil
      if p.final ~= nil then fragment = { orderId = 0, linkIndex = 0, isFinalLink = true, index = 0, isFinal = p.final == true } end
      o.slots[slot] = newPackage(contents(p.items), p.address or "", fragment)
    end
    o.newContents = contents
    function o.filterString() return o.accepts and o.filter or nil end
    local inv = {}
    function inv.__size() return PORT_SLOTS end
    function inv.__state()
      local out = {}
      for slot, item in pairs(o.slots) do
        out[slot] = { name = item.name, count = item.count, nbt = item.nbt, address = pkgOf(item) and pkgOf(item).address }
      end
      return out
    end
    -- PackagePortAutomationInventoryWrapper: only packages go in, and not ones addressed here; only packages addressed
    -- here come out
    local function mayInsert(item)
      local p = pkgOf(item)
      if not p then return false end
      local f = o.filterString()
      if f ~= nil and matchAddress(p.address, f) then return false end
      return true
    end
    local function mayExtract(item)
      local p = pkgOf(item)
      if not p then return false end
      local f = o.filterString()
      return f ~= nil and matchAddress(p.address, f)
    end
    function inv.__room(item, count, toSlot)
      if count <= 0 or not mayInsert(item) then return 0 end
      if toSlot then return o.slots[toSlot] == nil and 1 or 0 end
      for slot = 1, PORT_SLOTS do if not o.slots[slot] then return 1 end end
      return 0
    end
    function inv.__insert(item, count, toSlot)
      if inv.__room(item, count, toSlot) <= 0 then return 0 end
      local slot = toSlot
      if not slot then
        for s = 1, PORT_SLOTS do if not o.slots[s] then slot = s break end end
      end
      o.slots[slot] = copyItem(item, 1)
      return 1
    end
    function inv.__peek(slot)
      local item = o.slots[slot]
      if not item or not mayExtract(item) then return nil end
      return copyItem(item)
    end
    function inv.__take(slot, count, like)
      local item = o.slots[slot]
      if not item or count <= 0 or not mayExtract(item) or not stackable(item, like) then return 0 end
      o.slots[slot] = nil
      return 1
    end
    function inv.__pull(slot, limit, sink)
      local item = o.slots[slot]
      if not item or not mayExtract(item) then return 0 end
      if limit and limit <= 0 then return 0 end
      local moved = sink(item, 1)
      if moved > 0 then o.slots[slot] = nil end
      return moved
    end
    o.inv = inv
    return o
  end

  -- ===== packagers: the request queue, the box leaving, the trip to a port =====

  local transit = {} -- packages on their way: { item, due, from }
  local requestLog = {}

  --- ItemHandlerHelper.insertItemStacked into the package's ItemStackHandler(9); returns the leftover count
  local function insertStacked(box, item, count)
    local limit = math.min(64, maxStack(item))
    local left = count
    if maxStack(item) > 1 then
      for i = 1, PACKAGE_SLOTS do
        local e = box[i]
        if e and stackable(e, item) and e.count < limit then
          local n = math.min(limit - e.count, left)
          e.count = e.count + n
          left = left - n
          if left <= 0 then return 0 end
        end
      end
    end
    for i = 1, PACKAGE_SLOTS do
      if not box[i] then
        local n = math.min(limit, left)
        box[i] = copyItem(item, n)
        box[i].empty = nil
        left = left - n
        if left <= 0 then return 0 end
      end
    end
    return left
  end

  local function bulky(item)
    return pkgOf(item) ~= nil or item.name:find("shulker_box", 1, true) ~= nil -- canFitInsideContainerItems false
  end

  local function sendOut(l, box)
    if l.held or l.anim ~= 0 then
      l.queue[#l.queue + 1] = box
      return
    end
    l.held = box
    l.anim = CYCLE
  end

  --- PackagerBlockEntity.attemptToSend(queuedRequests): one package from the front of the queue
  local function attemptToSend(l, queued)
    local inv = l.inventory()
    if not inv then return end
    local any = false
    local box = {}
    local extractedPackage = nil
    local nextRequest = queued[1]
    local fixedAddress, fixedOrderId, linkIndex, finalLink, packageIndex, orderContext
    local finalPackage = false
    if nextRequest then
      fixedAddress = nextRequest.address
      fixedOrderId = nextRequest.orderId
      linkIndex = nextRequest.linkIndex
      finalLink = nextRequest.finalLink.v
      packageIndex = nextRequest.counter.v
      nextRequest.counter.v = nextRequest.counter.v + 1
      orderContext = nextRequest.context
    end
    local size = slotsOf(inv)
    local done = false
    for _ = 1, PACKAGE_SLOTS do
      if done then break end
      local continuePacking = true
      while continuePacking and not done do
        continuePacking = false
        for slot = 1, size do
          local initial = math.min(64, nextRequest.count)
          local peek = inv.__peek(slot)
          local extracted = peek and copyItem(peek, math.min(initial, peek.count, maxStack(peek)))
          if extracted and extracted.count > 0 and stackable(extracted, nextRequest.item) then
            local isBulky = bulky(extracted)
            if not (isBulky and any) then
              any = true
              local left = insertStacked(box, extracted, extracted.count)
              local transferred = extracted.count - left
              if transferred > 0 then inv.__take(slot, transferred, extracted) end
              if pkgOf(extracted) then extractedPackage = extracted end
              nextRequest.count = nextRequest.count - transferred
              if nextRequest.count > 0 then
                if isBulky then done = true break end
              else
                finalPackage = true
                table.remove(queued, 1)
                if #queued == 0 then done = true break end
                local previous = nextRequest.counter.v
                nextRequest = queued[1]
                if fixedAddress ~= nextRequest.address or fixedOrderId ~= nextRequest.orderId then done = true break end
                nextRequest.counter.v = previous
                finalPackage = false
                continuePacking = true
                if nextRequest.context then orderContext = nextRequest.context end
                if isBulky then done = true end
                break
              end
            end
          end
        end
      end
    end
    if not any then
      if nextRequest then table.remove(queued, 1) end
      return
    end
    local item
    if extractedPackage then
      item = copyItem(extractedPackage)
      item.__pkg = C.deepCopy(extractedPackage.__pkg)
    else
      item = newPackage(box, "", nil)
    end
    item.__pkg.address = fixedAddress or ""
    item.__pkg.fragment = { orderId = fixedOrderId, linkIndex = linkIndex, isFinalLink = finalLink,
      index = packageIndex, isFinal = finalPackage, hasContext = orderContext ~= nil }
    sendOut(l, item)
  end

  --- LogisticsManager.findPackagersForRequest
  local function findPackagers(net, order, address)
    local stacks = {}
    for _, e in ipairs(order) do
      if not e.item.empty and e.count > 0 then stacks[#stacks + 1] = e end
    end
    -- sorted by redstone power (LogisticallyLinkedBehaviour.getAllPresent(freq, true))
    local all = present(net)
    for i, l in ipairs(all) do l.sortIndex = i end
    table.sort(all, function(a, b)
      if a.power ~= b.power then return a.power < b.power end
      return a.sortIndex < b.sortIndex
    end)
    local groups, groupOrder, available = {}, {}, {}
    for _, l in ipairs(all) do
      local id = inventoryId(l)
      if id then
        if not groups[id] then groups[id] = {} groupOrder[#groupOrder + 1] = id end
        table.insert(groups[id], l)
      else
        available[#available + 1] = l
      end
    end
    for _, id in ipairs(groupOrder) do available[#available + 1] = groups[id][1] end

    local snapshots = {}
    local function summaryAt(l)
      if not snapshots[l] then snapshots[l] = availableItems(l) end
      return snapshots[l]
    end

    local requests, packagerOrder = {}, {}
    local used = {}
    local finalTracker = { v = false }
    local context = order
    local orderId = math.random(0, 2147483646) - 1073741823 -- r.nextInt() (Cobalt bounds the range)
    for i, entry in ipairs(stacks) do
      local remaining = entry.count
      local finalEntry = i == #stacks
      for _, l in ipairs(available) do
        local usedIndex = -1
        for j, u in ipairs(used) do if u == l then usedIndex = j - 1 break end end
        local linkIndex = usedIndex == -1 and #used or usedIndex
        local isFinalLink = { v = false }
        if linkIndex == #used - 1 then isFinalLink = finalTracker end
        -- PackagerLinkBlockEntity.processRequest
        local req
        if hasPackager(l) then
          local have = summaryAt(l).countOf(entry.item)
          if have > 0 then
            req = { item = entry.item, count = math.min(remaining, have), address = address,
              linkIndex = linkIndex, finalLink = isFinalLink, counter = { v = 0 }, orderId = orderId,
              context = context }
          end
        end
        if req then
          if not requests[l] then requests[l] = {} packagerOrder[#packagerOrder + 1] = l end
          table.insert(requests[l], req)
          local processed = req.count
          if processed > 0 and usedIndex == -1 then
            context = nil
            used[#used + 1] = l
            finalTracker = isFinalLink
          end
          remaining = remaining - processed
          if remaining <= 0 then
            if finalEntry then finalTracker.v = true end
            break
          end
        end
      end
    end
    return requests, packagerOrder
  end

  --- LogisticsManager.broadcastPackageRequest
  local function broadcast(netId, order, address)
    if #order == 0 then return false end
    local net = networks[tostring(netId or "")]
    if not net then return true end -- no links: nothing to ask, and nothing too busy
    local requests, packagerOrder = findPackagers(net, order, address)
    for _, l in ipairs(packagerOrder) do
      if #l.queue >= 20 then return false end -- isTooBusyFor(REDSTONE)
    end
    for _, l in ipairs(packagerOrder) do
      local queued = requests[l]
      for _ = 1, 100 do
        if #queued == 0 then break end
        attemptToSend(l, queued)
      end
    end
    core.save()
    return true
  end

  -- ===== the clock =====

  local function deliver(entry)
    local p = pkgOf(entry.item)
    for _, name in ipairs(portOrder) do
      local o = ports[name]
      if o.accepts and matchAddress(p.address, o.filter) then
        for slot = 1, PORT_SLOTS do
          if not o.slots[slot] then
            o.slots[slot] = entry.item
            return true
          end
        end
      end
    end
    return false
  end

  local ticker = {}
  function ticker.tick(t)
    local changed = false
    for _, id in ipairs(netOrder) do
      for _, l in ipairs(networks[id].links) do
        if l.anim == 0 then
          if #l.queue > 0 and l.held == nil then
            l.held = table.remove(l.queue, 1)
            l.anim = CYCLE
            changed = true
          end
        else
          l.anim = l.anim - 1
          changed = true
          if l.anim == 0 then
            transit[#transit + 1] = { item = l.held, due = t + (l.travel or networks[id].travel or TRAVEL),
              from = l.name }
            l.held = nil
          end
        end
      end
    end
    local i = 1
    while i <= #transit do
      local e = transit[i]
      if e.due <= t and deliver(e) then
        table.remove(transit, i)
        changed = true
      else
        i = i + 1
      end
    end
    return changed
  end
  function ticker.busy()
    for _, id in ipairs(netOrder) do
      for _, l in ipairs(networks[id].links) do
        if l.anim ~= 0 or #l.queue > 0 then return true end
      end
    end
    local now = create.clock.currentTick()
    for _, e in ipairs(transit) do if e.due >= now - 1 then return true end end
    return false
  end
  function ticker.skip() end
  create.addTicker(ticker)

  -- ===== reading a Lua table as the mod does =====

  local function javaClass(v)
    local ty = type(v)
    if ty == "number" then return "java.lang.Double" end
    if ty == "string" then return "java.lang.String" end
    if ty == "boolean" then return "java.lang.Boolean" end
    return "java.util.HashMap"
  end

  local function cce(from, to)
    lua(("class %s cannot be cast to class %s (%s and %s are in module java.base of loader 'bootstrap')")
      :format(from, to, from, to))
  end

  --- Map<*, *>.coerceList: values sorted by their keys as Doubles (a sort only compares with two or more entries)
  local function coerceList(t, castToMap)
    local keys = {}
    for k in pairs(t) do keys[#keys + 1] = k end
    if #keys >= 2 then
      for _, k in ipairs(keys) do
        if type(k) ~= "number" then cce(javaClass(k), "java.lang.Double") end
      end
      table.sort(keys)
    end
    local out = {}
    for i, k in ipairs(keys) do
      local v = t[k]
      if castToMap and type(v) ~= "table" then cce(javaClass(v), "java.util.Map") end
      out[i] = v
    end
    return out
  end

  local FORMAT = "Expected table format: {count = [int], item = [string]} or {count = [int], id = [string]} or {count = [int], index = [int]}"
  local CRAFT_FORMAT = 'Expected crafting format: {item = [string]} or {id = [string]} or {index = [int]} or "empty"'

  local function fromIndex(dict, summary, format)
    local index = dict.index
    if type(index) ~= "number" then lua(format) end
    index = C.toInt(index)
    local stacks = summary.stacks()
    assertBetween(index, 1, #stacks, "Index out of range (%s)")
    local stack = copyItem(stacks[index].stack)
    return stack, "index:" .. index
  end

  --- List<Map<*, *>>.reinterpret
  local function reinterpretList(list, summary)
    local out = {}
    for i, dict in ipairs(list) do
      local count = dict.count
      if type(count) ~= "number" then lua(FORMAT) end
      count = C.toInt(count)
      local item
      if dict.item ~= nil then
        if type(dict.item) ~= "string" then lua(FORMAT) end
        item = decodeItem(dict.item)
      elseif dict.id ~= nil then
        if type(dict.id) ~= "string" then lua(FORMAT) end
        item = decodeId(dict.id)
      elseif dict.index ~= nil then
        item = fromIndex(dict, summary, FORMAT)
      else
        lua(FORMAT)
      end
      out[i] = { item = item, count = count }
    end
    return out
  end

  --- Map<*, *>.reinterpretAsCraft; each entry also carries the identity BigItemStack.equals sees (a summary index's
  --- stack is one object, every parsed stack its own)
  local function reinterpretCraft(t, summary)
    local list = coerceList(t, false)
    local out = {}
    for i, v in ipairs(list) do
      if v == "empty" then
        out[i] = { item = { name = "minecraft:air", count = 0, empty = true }, count = 1, key = "new:" .. i }
      elseif type(v) == "table" then
        local item, key
        if v.item ~= nil then
          if type(v.item) ~= "string" then lua(CRAFT_FORMAT) end
          item = decodeItem(v.item)
        elseif v.id ~= nil then
          if type(v.id) ~= "string" then lua(CRAFT_FORMAT) end
          item = decodeId(v.id)
        elseif v.index ~= nil then
          item, key = fromIndex(v, summary, FORMAT)
        else
          lua(FORMAT)
        end
        out[i] = { item = item, count = 1, key = key or ("new:" .. i) }
      else
        local shown = type(v) == "number" and javaDouble(v) or tostring(v)
        lua(CRAFT_FORMAT .. ", got " .. shown)
      end
    end
    return out
  end

  -- ===== peripherals =====

  local function itemDetailsStack(item, count) -- ItemDetails.itemDetails(ItemStack): the stack's own count
    return { count = count, id = item.name, displayName = displayName(item), item = encodeItem(item, count) }
  end

  local TYPES = {}

  TYPES.stockcheckingblock = function(def)
    local function summary() return summaryOf(def.network) end
    local m = {}
    function m.inventorySize() return #summary().stacks() end
    function m.itemBasicDetails(index)
      index = C.int(1, index)
      local stacks = summary().stacks()
      assertBetween(index, 1, #stacks, "Index out of range (%s)")
      local e = stacks[index]
      return { count = e.count, id = itemToString(e.stack.name), displayName = displayName(e.stack) }
    end
    function m.itemDetails(index)
      index = C.int(1, index)
      local stacks = summary().stacks()
      assertBetween(index, 1, #stacks, "Index out of range (%s)")
      local e = stacks[index]
      return { count = e.count, id = itemToString(e.stack.name), displayName = displayName(e.stack),
        item = encodeItem(e.stack, e.stack.count) }
    end
    function m.getCountOf(item)
      item = C.str(1, item)
      return summary().countOf(decodeItem(item))
    end
    local function packagers()
      local net = networks[tostring(def.network or "")]
      local out = {}
      if not net then return out end
      for _, l in ipairs(present(net)) do if hasPackager(l) then out[#out + 1] = l end end
      return out
    end
    function m.countConnectedStockLinks() return #packagers() end
    function m.stockLinkDetails(index)
      index = C.int(1, index)
      local list = packagers()
      assertBetween(index, 1, #list, "Index out of range (%s)")
      local l = list[index]
      local out = {}
      local inv = l.inventory()
      if inv then
        local size, used = slotsOf(inv), 0
        for slot = 1, size do if inv.__peek(slot) then used = used + 1 end end
        out.capacity, out.occupiedSlots = size, used
      else
        out.capacity = "unknown"
      end
      -- Block.id: the block's key as a language key ("minecraft.chest"); air when the packager faces nothing
      local block = l.blockId()
      if not block:find(":", 1, true) then block = "minecraft:" .. block end
      out.type = (block:gsub(":", ".", 1))
      local port = l.frogport and ports[l.frogport]
      if port then out.frogportAddress = port.filter
      elseif l.frogportAddress ~= nil then out.frogportAddress = tostring(l.frogportAddress) end
      return out
    end
    return m, { "inventorySize", "itemBasicDetails", "itemDetails", "getCountOf", "countConnectedStockLinks",
      "stockLinkDetails" }, {}
  end

  TYPES.redstonerequester = function(def)
    local m = {}
    local function log(kind, ok, address)
      requestLog[#requestLog + 1] = { peripheral = def.name, kind = kind, ok = ok, address = address,
        tick = create.clock.currentTick() }
    end
    function m.request(contents, address, allowPartial, makeSound)
      contents = C.table(1, contents)
      if address ~= nil then address = C.str(2, address) end
      if allowPartial ~= nil then allowPartial = C.bool(3, allowPartial) end
      if makeSound ~= nil then makeSound = C.bool(4, makeSound) end
      address = address or ""
      allowPartial = allowPartial == true
      local summary = summaryOf(def.network)
      local order = reinterpretList(coerceList(contents, true), summary)
      local wanted = newSummary()
      for _, e in ipairs(order) do wanted.add(e.item, e.count) end
      if #order == 0 then lua("Contents list argument is empty") end
      local all = true
      for _, e in ipairs(wanted.stacks()) do
        if summary.countOf(e.stack) < e.count then all = false end
      end
      if not all and not allowPartial then
        log("request", false, address)
        return false
      end
      local ok = broadcast(def.network, order, address)
      log("request", ok, address)
      return ok
    end
    function m.requestCraft(crafts, address, makeSound)
      crafts = C.table(1, crafts)
      if address ~= nil then address = C.str(2, address) end
      if makeSound ~= nil then makeSound = C.bool(3, makeSound) end
      address = address or ""
      local summary = summaryOf(def.network)
      local pattern = reinterpretCraft(crafts, summary)
      local allEmpty = true
      for _, e in ipairs(pattern) do if not e.item.empty then allEmpty = false end end
      if allEmpty then lua("Contents list argument is empty") end
      if #pattern > 9 then lua("Cowardly refusing to package >9 items in a single crafting request") end
      -- enoughIngredientsForCrafting: grouped by BigItemStack.equals, which compares the ItemStack objects
      local groups, groupOrder = {}, {}
      for _, e in ipairs(pattern) do
        if not groups[e.key] then groups[e.key] = { item = e.item, amount = 0 } groupOrder[#groupOrder + 1] = e.key end
        groups[e.key].amount = groups[e.key].amount + e.count
      end
      for _, key in ipairs(groupOrder) do
        local g = groups[key]
        if g.amount ~= 0 and not g.item.empty and summary.countOf(g.item) < g.amount then
          log("requestCraft", false, address)
          return false
        end
      end
      local ok = broadcast(def.network, pattern, address)
      log("requestCraft", ok, address)
      return ok
    end
    return m, { "request", "requestCraft" }, {} -- makeRequest is public Kotlin but not a @LuaFunction
  end

  TYPES.packageport = function(def, o)
    local m = {}
    function m.listPackages()
      local out = {}
      for slot = 1, PORT_SLOTS do
        local item = o.slots[slot]
        local p = pkgOf(item)
        if p then
          local final
          if V21 then
            final = true
            if p.fragment then final = p.fragment.isFinal end
          else
            final = false -- box.tag.getBoolean("IsFinal"): the flag sits under "Fragment", never at the top
          end
          out[slot] = { address = p.address, orderIsComplete = final }
        end
      end
      return out
    end
    function m.capacity() return PORT_SLOTS end
    local function packageAt(index)
      local item = o.slots[index]
      if not item then lua("Targeted index is empty") end
      if not pkgOf(item) then lua("Targeted index does not contain a package") end
      return item
    end
    function m.getPackageContentDetails(index)
      index = C.int(1, index)
      assertBetween(index, 1, PORT_SLOTS, "Index out of range (%s)")
      local p = pkgOf(packageAt(index))
      local out = {}
      for slot = 1, PACKAGE_SLOTS do
        local item = p.contents[slot]
        if item and (item.count or 0) > 0 then
          -- getItemId (1.20.1) and Item.toString (1.21.1) both give namespace:path here
          out[#out + 1] = itemDetailsStack(item, item.count)
        end
      end
      return out
    end
    function m.renamePackageAddress(index, name)
      index, name = C.int(1, index), C.str(2, name)
      assertBetween(index, 1, PORT_SLOTS, "Index out of range (%s)")
      pkgOf(packageAt(index)).address = name
      core.save()
    end
    function m.getAcceptsPackages() return o.accepts end
    function m.setAcceptsPackages(accept)
      o.accepts = C.bool(1, accept)
      core.save()
    end
    function m.getAddressFilter() return o.filter end
    function m.setAddressFilter(filter)
      filter = C.str(1, filter)
      if filter == o.filter then return end
      o.filter = filter
      core.save()
    end
    return m, { "listPackages", "capacity", "getPackageContentDetails", "renamePackageAddress", "getAcceptsPackages",
      "setAcceptsPackages", "getAddressFilter", "setAddressFilter" }, {}
  end

  local function newClipboard(def)
    local o = { kind = "clipboard", def = def }
    function o.setPages(pages)
      o.pages = {}
      for i, page in ipairs(pages or {}) do
        o.pages[i] = {}
        for j, e in ipairs(page) do
          if e.icon then mention(e.icon.name) end
          o.pages[i][j] = { text = e.text or "", checked = e.checked == true, icon = e.icon and copyItem(e.icon),
            amount = tonumber(e.amount) or 0 }
        end
      end
    end
    o.setPages(def.pages)
    return o
  end

  TYPES.clipboard = function(def, o)
    local m = {}
    function m.isClipboardAttached() return true end -- the peripheral is the clipboard block itself
    function m.getNumPages() return #o.pages end
    function m.readPage(index)
      index = C.int(1, index)
      assertBetween(index, 1, #o.pages, "Index out of range (%s)")
      local out = {}
      for i, e in ipairs(o.pages[index]) do
        local row = { checked = e.checked, text = e.text }
        if e.icon and (e.icon.count or 1) > 0 and e.icon.name ~= "minecraft:air" then
          local count = e.icon.count or 1
          local d = itemDetailsStack(e.icon, count)
          d.count = e.amount -- the entry's ItemAmount replaces the stack's count
          row.icon = d
        end
        out[i] = row
      end
      return out
    end
    -- none of the clipboard's methods is mainThread
    return m, { "isClipboardAttached", "getNumPages", "readPage" },
      { isClipboardAttached = true, getNumPages = true, readPage = true }
  end

  local objects = {}

  local function portState(o)
    local slots = {}
    for slot = 1, PORT_SLOTS do
      local p = pkgOf(o.slots[slot])
      if p then
        local items = {}
        for s = 1, PACKAGE_SLOTS do
          local it = p.contents[s]
          if it then items[#items + 1] = { name = it.name, count = it.count } end
        end
        slots[tostring(slot)] = { address = p.address, items = items, final = p.fragment and p.fragment.isFinal or nil }
      end
    end
    return { addressFilter = o.filter, acceptsPackages = o.accepts, packages = slots }
  end

  function M.peripheral(def)
    local o
    if def.type == "packageport" then
      o = newPort(def)
      ports[def.name] = o
      portOrder[#portOrder + 1] = def.name
    elseif def.type == "clipboard" then
      o = newClipboard(def)
    else
      o = { kind = def.type, def = def }
    end
    objects[def.name] = o
    local methods, decl, computer = TYPES[def.type](def, o)
    local p = {
      methods = methods,
      methodOrder = C.hashMapOrder(decl),
      computerThread = computer,
      exactReturns = true, -- every method returns exactly what its Kotlin does (void, a value or a table)
    }
    if def.type == "packageport" then
      p.types = { "packageport", "inventory" } -- getAdditionalTypes() + "inventory"
      p.inventory = o.inv -- getTarget() is the block: other inventories push and pull through its item handler
    end
    function p.state()
      create.catchUp()
      if o.kind == "packageport" then return portState(o) end
      if o.kind == "clipboard" then return { pages = C.deepCopy(o.pages) } end
      local s = summaryOf(def.network)
      local stock = {}
      for _, e in ipairs(s.stacks()) do stock[#stock + 1] = { name = e.stack.name, count = e.count } end
      return { network = def.network, stock = stock }
    end
    return p
  end

  function M.catchUp() create.catchUp() end

  function M.state()
    create.catchUp()
    local nets = {}
    for _, id in ipairs(netOrder) do
      local links = {}
      for _, l in ipairs(networks[id].links) do
        local items = {}
        local inv = l.inventory()
        if inv then
          for slot = 1, slotsOf(inv) do
            local it = inv.__peek(slot)
            if it then items[#items + 1] = { slot = slot, name = it.name, count = it.count } end
          end
        end
        links[#links + 1] = { name = l.name, power = l.power, packager = l.packager, items = items,
          queued = #l.queue, sending = l.held ~= nil, animation = l.anim }
      end
      local stock = {}
      for _, e in ipairs(summaryOf(id).stacks()) do stock[#stock + 1] = { name = e.stack.name, count = e.count } end
      nets[id] = { links = links, stock = stock }
    end
    local moving = {}
    for _, e in ipairs(transit) do
      local p = pkgOf(e.item)
      moving[#moving + 1] = { address = p.address, from = e.from, due = e.due, items = #p.contents }
    end
    return { tick = create.clock.currentTick(), networks = nets, transit = moving, requests = C.deepCopy(requestLog) }
  end

  -- ===== sim commands =====

  local function findLink(cmd)
    local net = networks[tostring(cmd.network or "")]
    if not net then return nil, "no logistics network " .. tostring(cmd.network) end
    if cmd.link == nil then
      if net.links[1] then return net.links[1] end
      return nil, "network " .. net.id .. " has no stock links"
    end
    for _, l in ipairs(net.links) do if l.name == cmd.link then return l end end
    return nil, "no stock link " .. tostring(cmd.link) .. " on network " .. net.id
  end

  local handlers = {}

  function handlers.cclAddItems(cmd)
    create.catchUp()
    local l, err = findLink(cmd)
    if not l then return false, err end
    local inv = l.inventory()
    if not inv then return false, "stock link " .. l.name .. " faces no inventory" end
    for _, item in ipairs(cmd.items or { cmd.item }) do
      mention(item.name)
      local moved = inv.__insert(item, item.count or 1)
      if moved < (item.count or 1) then return false, "only " .. moved .. " of " .. item.name .. " fit" end
    end
    core.save()
    return true
  end

  function handlers.cclRemoveItems(cmd)
    create.catchUp()
    local l, err = findLink(cmd)
    if not l then return false, err end
    local inv = l.inventory()
    if not inv then return false, "stock link " .. l.name .. " faces no inventory" end
    local left = tonumber(cmd.count) or math.huge
    for slot = 1, slotsOf(inv) do
      local it = inv.__peek(slot)
      if it and it.name == cmd.name and left > 0 then left = left - inv.__take(slot, math.min(left, it.count), it) end
    end
    core.save()
    return true
  end

  function handlers.cclSetLinkPower(cmd)
    create.catchUp()
    local l, err = findLink(cmd)
    if not l then return false, err end
    l.power = math.max(0, math.min(15, tonumber(cmd.power) or 0))
    return true
  end

  function handlers.cclAddLink(cmd)
    create.catchUp()
    local net = network(cmd.network)
    local spec = cmd.link or {}
    net.links[#net.links + 1] = newLink(net, spec, #net.links + 1)
    return true
  end

  function handlers.cclDeliverPackage(cmd)
    create.catchUp()
    local o = ports[cmd.port or cmd.peripheral]
    if not o then return false, "no package port named " .. tostring(cmd.port or cmd.peripheral) end
    local slot = tonumber(cmd.slot)
    if not slot then
      for s = 1, PORT_SLOTS do if not o.slots[s] then slot = s break end end
    end
    if not slot or slot < 1 or slot > PORT_SLOTS then return false, "no free slot" end
    if o.slots[slot] then return false, "slot " .. slot .. " is taken" end
    local fragment = nil
    if cmd.final ~= nil then fragment = { orderId = 0, linkIndex = 0, isFinalLink = true, index = 0, isFinal = cmd.final == true } end
    o.slots[slot] = newPackage(o.newContents(cmd.items), cmd.address or "", fragment)
    core.save()
    return true
  end

  function handlers.cclTakePackage(cmd)
    create.catchUp()
    local o = ports[cmd.port or cmd.peripheral]
    if not o then return false, "no package port named " .. tostring(cmd.port or cmd.peripheral) end
    local slot = tonumber(cmd.slot)
    if not slot or not o.slots[slot] then return false, "no package in slot " .. tostring(cmd.slot) end
    o.slots[slot] = nil
    core.save()
    return true
  end

  function handlers.cclSetClipboard(cmd)
    local o = objects[cmd.peripheral]
    if not o or o.kind ~= "clipboard" then return false, "no clipboard named " .. tostring(cmd.peripheral) end
    o.setPages(cmd.pages)
    return true
  end

  M.handlers = handlers
  return M
end
