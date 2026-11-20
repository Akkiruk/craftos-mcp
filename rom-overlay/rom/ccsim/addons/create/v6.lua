-- ccsim create/v6: the peripherals Create 6.0 added (1.20.1: 6.0.8, 1.21.1: 6.0.10). The creative motor lives with
-- the other kinetic blocks in init.lua; everything else is here.
--
-- Written from Creators-of-Create/Create at tags mc1.20.1-6.0.8 and mc1.21.1-6.0.10 and checked with javap against
-- create-1.20.1-6.0.8.jar and create-1.21.1-6.0.10.jar (types, methods, mainThread flags, error strings). Paths
-- relative to src/main/java/com/simibubi/create/:
--   compat/computercraft/implementation/peripherals/{Sticker,Signal,TrackObserver,NixieTube,Frogport,Postbox,
--   Packager,Repackager,StockTicker,RedstoneRequester,TableClothShop}Peripheral, .../implementation/{ComputerUtil,
--   ComputerBehaviour}, .../implementation/luaObjects/{PackageLuaObject,PackageOrderLuaObject}, .../events/*;
--   content/contraptions/chassis/StickerBlockEntity; content/trains/signal/{SignalBlockEntity,SignalBoundary};
--   content/trains/observer/TrackObserverBlockEntity; content/redstone/nixieTube/NixieTubeBlockEntity;
--   content/logistics/packager/{PackagerBlockEntity,repackager/RepackagerBlockEntity};
--   content/logistics/packagePort/PackagePortBlockEntity; content/logistics/stockTicker/StockTickerBlockEntity;
--   content/logistics/redstoneRequester/RedstoneRequesterBlockEntity; content/logistics/tableCloth/*.
-- docs/create-versions.md lists the behaviour with its source, and what is not simulated.
return function(core, host, M)
  local C = M.C
  local T = M.trains
  local V21 = M.V21
  local floor = math.floor
  local cfg = core.world.create or {}

  local X = { handlers = {} }
  local blocks = {} -- name -> sim object of every 6.0 block, for the sim commands
  local requests = {} -- logistics requests the network was sent (StockTicker, RedstoneRequester)

  local function lua(message) error(message, 0) end
  local typeName = C.typeName

  -- ===== CC's argument checks that common.lua lacks =====

  local function optStr(i, v)
    if v == nil then return nil end
    return C.str(i, v)
  end

  -- LuaValues.checkEnum(index, ...): the index is the Java one, so the message says #index+1 whatever the argument
  local function checkEnum(index, names, value)
    local low = value:lower()
    for _, n in ipairs(names) do if n == low then return n end end
    lua(("bad argument #%d (unknown option %s)"):format(index + 1, value))
  end

  local function badField(name, expected, v)
    lua(("bad field '%s' (%s expected, got %s)"):format(name, expected, typeName(v)))
  end

  -- Number.intValue of a Lua number (a Double): toward zero, saturating, NaN is 0
  local intValue = C.toInt

  -- ===== a @LuaFunction(mainThread = true) on a returned object (PackageLuaObject): waits for the next tick =====

  local function mainThread(fn)
    return function(...)
      local args = table.pack(...)
      local r = core.waitForServerTick(function()
        M.catchUp()
        return fn(table.unpack(args, 1, args.n))
      end)
      if not r[1] then error(r[2], 0) end
      M.poke()
      return table.unpack(r, 2, r.n)
    end
  end

  -- ===== items =====
  -- An item is the sim's usual { name, count, nbt?, ... }. A package is an item with `__pkg`:
  -- { address, contents = { [slot] = item } (9 slots), order = { ... }? }. A fixture writes a package as
  -- { "name": "create:cardboard_package_12x12", "package": { "address": "Farm", "items": [...] } }.

  local PACKAGE_SLOTS = 9 -- PackageItem.SLOTS
  local BOX = "create:cardboard_package_12x12" -- PackageStyles: the real one picks a style at random

  local function isPackage(item) return item ~= nil and item.__pkg ~= nil end

  local function newPackage(contents, address)
    local box = { name = BOX, count = 1, __pkg = { address = address or "", contents = {} } }
    for slot, item in pairs(contents or {}) do
      local copy = {}
      for k, v in pairs(item) do copy[k] = v end
      box.__pkg.contents[slot] = copy
    end
    return box
  end

  --- a fixture item: `package` becomes the sim's own package fields
  local function fixtureItem(item)
    if type(item) ~= "table" then return item end
    local out = {}
    for k, v in pairs(item) do if k ~= "package" then out[k] = v end end
    out.count = tonumber(out.count) or 1
    if type(item.package) == "table" then
      local contents = {}
      for i, x in ipairs(item.package.items or {}) do contents[i] = fixtureItem(x) end
      local p = newPackage(contents, item.package.address)
      out.name = out.name or BOX
      out.count = 1
      out.__pkg = p.__pkg
      if type(item.package.order) == "table" then out.__pkg.order = item.package.order end
    end
    return out
  end

  local function fixtureItems(list)
    local out = {}
    for k, item in pairs(list or {}) do
      local slot = tonumber(k)
      if slot then out[slot] = fixtureItem(item) end
    end
    return out
  end

  local function stackable(a, b) return a.name == b.name and a.nbt == b.nbt and not a.__pkg and not b.__pkg end

  local comparables = setmetatable({}, { __mode = "k" }) -- package objects -> their table representation

  --- VanillaDetailRegistries.ITEM_STACK.getBasicDetails
  local function basic(item, count)
    local d = { name = item.name, count = count or item.count }
    if item.nbt then d.nbt = item.nbt end
    return d
  end

  local packageObject -- below
  --- VanillaDetailRegistries.ITEM_STACK.getDetails, with Create's provider: a package also has `package`
  local function details(item, count)
    local d = host.itemDetail(item)
    if count then d.count = count end
    if isPackage(item) then d.package = packageObject(nil, item) end
    return d
  end

  -- ===== ComputerUtil.list / getItemDetail over a slot list =====

  local function slotError(slot, size)
    -- 6.0.8 (1.20.1) misses the space after the comma; 6.0.10 has it
    lua(("Slot %d out of range,%savailable slots between 1 and %d"):format(slot, V21 and " " or "", size))
  end

  local function listOf(slots, size)
    local out = {}
    for i = 1, size do
      local item = slots(i)
      if item and item.count > 0 then out[i] = basic(item) end
    end
    return out
  end

  local function itemDetailOf(slots, size, slot)
    slot = C.int(1, slot)
    if slot < 1 or slot > size then slotError(slot, size) end
    local item = slots(slot)
    if not item or item.count <= 0 then return nil end
    return details(item)
  end

  --- an inventory (host.newInventory or a world inventory) as a slot reader
  local function invSlots(inv) return function(i) return inv.__peek(i) end end
  local function invSize(inv) return inv.size and inv.size() or (inv.__size and inv.__size()) or 0 end

  -- ===== package objects (PackageLuaObject, PackageOrderLuaObject) =====

  local function orderObject(pkg)
    local order = pkg.__pkg.order
    local ctx = order.stacks and order or nil -- PackageItem.getOrderContext: null without the order's stacks
    local o = {}
    o.getOrderID = mainThread(function() return intValue(tonumber(order.orderId) or 0) end)
    o.getIndex = mainThread(function() return intValue(tonumber(order.index) or 0) + 1 end)
    o.isFinal = mainThread(function() return order.isFinal == true end)
    o.getLinkIndex = mainThread(function() return intValue(tonumber(order.linkIndex) or 0) + 1 end)
    o.isFinalLink = mainThread(function() return order.isFinalLink == true end)
    o.list = mainThread(function()
      if not ctx then return nil end
      local out = {}
      for i, s in ipairs(ctx.stacks) do out[i] = basic(s, s.count) end
      return out
    end)
    o.getItemDetail = mainThread(function(slot)
      if not ctx then return nil end
      slot = C.int(1, slot)
      if slot < 1 then lua("Slot out of range (1 or greater)") end
      local s = ctx.stacks[slot]
      if not s then return nil end
      return details(s, s.count)
    end)
    o.getCrafts = mainThread(function()
      if not ctx then return nil end
      local out = {}
      for i, craft in ipairs(ctx.crafts or {}) do
        local recipe = {}
        for j, name in ipairs(craft.recipe or {}) do
          if name ~= "minecraft:air" then recipe[j] = name end
        end
        out[i] = { count = craft.count or 1, recipe = recipe }
      end
      return out
    end)
    return o
  end

  --- PackageLuaObject(blockEntity, box): `owner` is the packager holding it (editable while it holds this box)
  function packageObject(owner, box)
    local o = {}
    local address = box.__pkg.address -- the address when the object was made
    local function editable() return owner ~= nil and owner.heldBox ~= nil and owner.heldBox == box end
    o.isEditable = mainThread(function() return editable() end)
    o.getAddress = mainThread(function()
      if editable() then address = box.__pkg.address end
      return address
    end)
    o.setAddress = mainThread(function(a)
      a = C.str(1, a)
      if not editable() then lua("Package is not editable") end
      box.__pkg.address = a
      address = a
    end)
    local function slots(i) return box.__pkg.contents[i] end
    o.list = mainThread(function() return listOf(slots, PACKAGE_SLOTS) end)
    o.getItemDetail = mainThread(function(slot) return itemDetailOf(slots, PACKAGE_SLOTS, slot) end)
    o.getOrderData = mainThread(function()
      if not box.__pkg.order then return nil end
      return orderObject(box)
    end)
    -- LuaComparable.getTableRepresentation, for the Stock Ticker's filters
    comparables[o] = function()
      local contents = {}
      for i = 1, PACKAGE_SLOTS do
        local item = box.__pkg.contents[i]
        if item and item.count > 0 then contents[#contents + 1] = { __comparable = details(item) } end
      end
      local rep = { address = editable() and box.__pkg.address or address, contents = { __list = contents } }
      if box.__pkg.order then
        local ord = box.__pkg.order
        rep.orderData = { orderID = tonumber(ord.orderId) or 0, index = (tonumber(ord.index) or 0) + 1,
          isFinal = ord.isFinal == true, linkIndex = (tonumber(ord.linkIndex) or 0) + 1,
          isFinalLink = ord.isFinalLink == true }
      end
      return rep
    end
    return o
  end

  -- An event cannot carry functions through os.queueEvent: a package object travels as a marker and becomes its
  -- table of methods again when the program pulls the event (the cc-vs way).
  local marked, markNext = {}, 0
  local function mark(obj)
    markNext = markNext + 1
    marked[markNext] = obj
    marked[markNext - 256] = nil
    return { __createPackage = markNext }
  end
  local PACKAGE_EVENTS = { package_created = true, package_received = true, package_sent = true,
    package_repackaged = true }
  local rawPull = os.pullEventRaw
  os.pullEventRaw = function(filter)
    local ev = table.pack(rawPull(filter))
    if PACKAGE_EVENTS[ev[1]] then
      for i = 2, ev.n do
        local v = ev[i]
        if type(v) == "table" and v.__createPackage then ev[i] = marked[v.__createPackage] or v end
      end
    end
    return table.unpack(ev, 1, ev.n)
  end

  local function emitPackage(event, name, obj, ...) M.emit(event, name, mark(obj), ...) end

  -- ===== the Stock Ticker's filters (ComputerUtil.bigItemStackToLuaTableFilter, deepEquals) =====
  -- Lua tables from the program are Java Maps; an item's details hold Maps and Lists. A List on the item side is a
  -- table tagged { __list = {...} } or one of the known list fields; a LuaComparable is { __comparable = map }.

  local LIST_FIELDS = { itemGroups = true, lore = true, enchantments = true }

  local function itemSide(v, key)
    if type(v) ~= "table" then return v end
    if v.__list or v.__comparable then return v end
    if comparables[v] then return { __comparable = comparables[v]() } end
    local isList = LIST_FIELDS[key] or (#v > 0 and C.count(v) == #v)
    local out = {}
    for k, x in pairs(v) do out[k] = itemSide(x, k) end
    if isList then return { __list = out } end
    return out
  end

  local function deepCopy(v)
    if type(v) ~= "table" then return v end
    if comparables[v] then return v end
    local out = {}
    for k, x in pairs(v) do out[k] = deepCopy(x) end
    return out
  end

  -- isArrayLike: number keys only; key - 1 truncated (the whole-number check compares an int with itself)
  local function toOrderedList(m)
    local n = C.count(m)
    local seen, out = {}, {}
    for k, v in pairs(m) do
      if type(k) ~= "number" then return nil end
      local idx = intValue(k) - 1
      if idx < 0 or idx >= n or seen[idx] then return nil end
      seen[idx] = true
      out[idx + 1] = v
    end
    return out
  end

  local function javaSimpleName(v)
    if type(v) == "number" then return "Double" end
    if type(v) == "string" then return "String" end
    if type(v) == "boolean" then return "Boolean" end
    return "HashMap"
  end

  -- java.util.regex for the simple patterns: . * + ? [...] ^ $ \d \w \s and escapes; anything else is not simulated
  local function regexToPattern(re)
    if re:find("[|{}()]") then
      lua("ccsim: this regex is not simulated (groups, alternatives and counted repeats): " .. re)
    end
    local out, i = {}, 1
    while i <= #re do
      local c = re:sub(i, i)
      if c == "\\" then
        local n = re:sub(i + 1, i + 1)
        local map = { d = "%d", D = "%D", w = "[%w_]", W = "[^%w_]", s = "%s", S = "%S" }
        out[#out + 1] = map[n] or ("%" .. n)
        i = i + 2
      elseif c == "[" then
        local j = re:find("]", i + 2, true)
        if not j then lua("ccsim: bad regex: " .. re) end
        out[#out + 1] = re:sub(i, j):gsub("\\d", "%%d"):gsub("\\w", "%%w_"):gsub("\\s", "%%s")
        i = j + 1
      elseif c == "*" or c == "+" or c == "?" then
        out[#out + 1] = c == "*" and "*" or c
        i = i + 1
      elseif c == "." then
        out[#out + 1] = "."
        i = i + 1
      elseif c == "^" or c == "$" then
        i = i + 1 -- String.matches is anchored at both ends anyway
      else
        out[#out + 1] = c:gsub("[%%%-%(%)%[%]%^%$]", "%%%0")
        i = i + 1
      end
    end
    return "^" .. table.concat(out) .. "$"
  end

  local deepEquals

  local function collectionOf(v)
    if type(v) ~= "table" then return nil end
    if v.__comparable then return nil end
    if v.__list then return { mode = "contains", list = { table.unpack(v.__list) } } end
    local mode = "contains"
    local m = v._mode
    if type(m) == "string" then
      local low = m:lower()
      if low ~= "exact" and low ~= "contains" and low ~= "contained" then
        lua(("Invalid match mode: %s, expected 'exact', 'contained' or 'contains'"):format(m))
      end
      mode = low
    end
    v._mode = nil -- m.remove("_mode"): the filter's own map, so a nested one loses it after the first item
    return { mode = mode, list = toOrderedList(v), map = v }
  end

  local function matchList(f, i)
    if f.mode == "exact" then
      if #f.list ~= #i.list then return false end
      for k = 1, #f.list do
        if not deepEquals(f.list[k], i.list[k]) then return false end
      end
      return true
    end
    local a, b = f.list, i.list -- contains: every filter value finds an item value (each used once)
    if f.mode == "contained" then a, b = i.list, f.list end
    for _, x in ipairs(a) do
      local found = false
      for k, y in ipairs(b) do
        local hit
        if f.mode == "contained" then hit = deepEquals(y, x) else hit = deepEquals(x, y) end
        if hit then
          table.remove(b, k)
          found = true
          break
        end
      end
      if not found then return false end
    end
    return true
  end

  local function matchMap(f, i)
    if f.mode == "exact" then
      for k in pairs(f.map) do if i.map[k] == nil then return false end end
      for k in pairs(i.map) do if f.map[k] == nil then return false end end
      for k, v in pairs(f.map) do
        if not deepEquals(v, i.map[k]) then return false end
      end
      return true
    elseif f.mode == "contains" then
      for k, v in pairs(f.map) do
        if i.map[k] == nil or not deepEquals(v, i.map[k]) then return false end
      end
      return true
    end
    for k, v in pairs(i.map) do
      if f.map[k] == nil or not deepEquals(f.map[k], v) then return false end
    end
    return true
  end

  function deepEquals(fv, iv)
    if fv == iv and type(fv) ~= "table" then return true end -- Objects.equals; numbers compare as doubles
    if type(iv) == "table" and iv.__comparable then return deepEquals(fv, iv.__comparable) end
    if type(fv) == "table" and type(fv._op) == "string" and fv.value ~= nil then
      local op, value = fv._op, fv.value
      if op == "not" then return not deepEquals(value, iv) end
      if op == "any" or op == "all" then
        local values = type(value) == "table" and toOrderedList(value) or nil
        if not values then lua(op .. " operator requires a list of values") end
        local all = op == "all"
        for _, v in ipairs(values) do
          local hit = deepEquals(v, iv)
          if all and not hit then return false end
          if not all and hit then return true end
        end
        return all
      end
      if op == "type" then
        if type(value) ~= "string" then lua("Type operator requires a string value") end
        if iv == nil then return value == "nil" end
        local isTable = type(iv) == "table"
        local isList = isTable and iv.__list ~= nil
        local isObject = isTable and iv.__comparable ~= nil
        if value == "nil" then return false end
        if value == "number" then return type(iv) == "number" end
        if value == "string" then return type(iv) == "string" end
        if value == "boolean" then return type(iv) == "boolean" end
        if value == "table" then return isTable and not isObject end
        if value == "list" then return isList end
        if value == "map" then return isTable and not isList and not isObject end
        if value == "object" then return isObject end
        lua("Unknown type: " .. value)
      end
      if type(iv) == "number" and type(value) == "number" then
        if op == ">" then return iv > value end
        if op == ">=" then return iv >= value end
        if op == "<" then return iv < value end
        if op == "<=" then return iv <= value end
        if op == "==" then return iv == value end
        if op == "~=" then return iv ~= value end
        lua("Unknown operator: " .. op)
      end
      if type(iv) == "string" and type(value) == "string" then
        if op == "glob" then return iv:match(T.globPattern(value)) ~= nil end
        if op == "regex" then return iv:match(regexToPattern(value)) ~= nil end
        lua("Unknown operator: " .. op)
      end
      lua(("Operator %s not supported for type %s"):format(op, javaSimpleName(value)))
    end
    local fc, ic = collectionOf(fv), collectionOf(iv)
    if not fc or not ic then return false end
    if ic.list and fc.list then return matchList(fc, ic) end
    if ic.map and fc.map then return matchMap(fc, ic) end
    return false
  end

  --- bigItemStackToLuaTableFilter: the entry's count when it matches, else 0
  local function filterCount(entry, filter)
    local d = itemSide(details(entry.item, entry.count))
    if type(filter.name) == "string" and not filter.name:find(":", 1, true) then
      d.name = "minecraft:" .. filter.name -- (sic) the item's name becomes the filter's, so the filter never matches
    end
    local top = {}
    for k, v in pairs(filter) do top[k] = v end -- new HashMap<>(filter)
    if not deepEquals(top, d) then return 0 end
    return entry.count
  end

  -- ===== logistics networks: what a Stock Ticker or Redstone Requester sees (InventorySummary) =====
  -- world.create.stock = { "<network>": [items] }; a block names its network with `network`, or has its own `stock`.

  local nets = {}
  local function summaryAdd(net, item, count)
    for _, e in ipairs(net) do
      if e.item.name == item.name and e.item.nbt == item.nbt then
        e.count = e.count + count
        return
      end
    end
    local copy = {}
    for k, v in pairs(item) do if k ~= "count" then copy[k] = v end end
    copy.count = 1
    net[#net + 1] = { item = copy, count = count }
  end
  local function network(id)
    id = tostring(id or "main")
    if not nets[id] then
      local net = {}
      for _, item in ipairs((cfg.stock or {})[id] or {}) do
        local it = fixtureItem(item)
        summaryAdd(net, it, it.count)
      end
      nets[id] = net
    end
    return nets[id]
  end
  local function netFor(def)
    if def.stock then
      local id = "@" .. def.name
      if not nets[id] then
        local net = {}
        for _, item in ipairs(def.stock) do
          local it = fixtureItem(item)
          summaryAdd(net, it, it.count)
        end
        nets[id] = net
      end
      return id
    end
    return tostring(def.network or "main")
  end
  local function prune(net)
    for i = #net, 1, -1 do if net[i].count <= 0 then table.remove(net, i) end end
  end
  local function countOf(net, item)
    for _, e in ipairs(net) do
      if e.item.name == item.name and e.item.nbt == item.nbt then return e.count end
    end
    return 0
  end

  local function itemFor(name)
    -- BuiltInRegistries.ITEM.get(ResourceLocation.tryParse(name)): a bad id is air
    if type(name) ~= "string" then return nil end
    local ok, id = pcall(C.resourceLocation, name)
    if not ok or id == "minecraft:air" then return nil end
    return { name = id, count = 1 }
  end

  -- ===== simple blocks =====

  local function finish(def, o, methods, decl, main, extra)
    local computerThread = {}
    for _, n in ipairs(decl) do if not main[n] then computerThread[n] = true end end
    local p = { methods = methods, methodOrder = C.hashMapOrder(decl), computerThread = computerThread, sim = o,
      exactReturns = true }
    for k, v in pairs(extra or {}) do p[k] = v end
    blocks[def.name] = o
    M.register(def.name, o)
    if o.tick then M.addTicker(o) end
    return p
  end

  local ALL_MAIN = setmetatable({}, { __index = function() return true end })

  local B = {}

  -- StickerPeripheral: the EXTENDED block state; attached when the block in front can take glue
  function B.Create_Sticker(def)
    local o = { kind = "Create_Sticker", extended = def.extended == true, attached = def.attached ~= false }
    local m = {}
    function m.isExtended() return o.extended end
    function m.isAttachedToBlock() return o.extended and o.attached end
    function m.extend()
      if o.extended then return false end
      o.extended = true
      return true
    end
    function m.retract()
      if not o.extended then return false end
      o.extended = false
      return true
    end
    function m.toggle()
      o.extended = not o.extended
      return true
    end
    local p = finish(def, o, m, { "isExtended", "isAttachedToBlock", "extend", "retract", "toggle" },
      { extend = true, retract = true, toggle = true })
    function p.state() return { extended = o.extended, attached = o.attached } end
    return p
  end

  -- SignalPeripheral over SignalBlockEntity / SignalBoundary. Fixture: `signal: false` (no boundary: INVALID, "no
  -- signal"), `signalType` ("ENTRY_SIGNAL" / "CROSS_SIGNAL"), `clear` (the state with no train: "GREEN", or "YELLOW"),
  -- `trains` (names in the section behind it: RED), `powered` (redstone: forced red).
  function B.Create_Signal(def)
    local o = { kind = "Create_Signal", boundary = def.signal ~= false, type = def.signalType or "ENTRY_SIGNAL",
      clear = def.clear or "GREEN", trains = C.deepCopy(def.trains or {}), powered = def.powered == true }
    if o.type ~= "ENTRY_SIGNAL" and o.type ~= "CROSS_SIGNAL" then lua("ccsim: signal type must be ENTRY_SIGNAL or CROSS_SIGNAL") end
    local function target()
      if not o.boundary then return "INVALID" end
      if o.powered or #o.trains > 0 then return "RED" end -- isForcedRed / isOccupiedUnless
      return o.clear
    end
    o.state = target()
    o.redDelay = 0 -- switchToRedAfterTrainEntered
    function o.tick()
      -- SignalBlockEntity.tick -> enterState: RED waits 15 ticks after the signal turned green or yellow
      local s = target()
      if o.redDelay > 0 then o.redDelay = o.redDelay - 1 end
      if o.state == s then return false end
      if s == "RED" and o.redDelay > 0 then return true end
      o.state = s
      o.redDelay = (s == "GREEN" or s == "YELLOW") and 15 or 0
      M.emit("train_signal_state_change", def.name, s)
      return true
    end
    function o.busy() return o.state ~= target() or o.redDelay > 0 end
    local m = {}
    function m.getState() return o.state end
    function m.isForcedRed() return o.powered end
    function m.setForcedRed(powered)
      o.powered = C.bool(1, powered)
    end
    local function needSignal() if not o.boundary then lua("no signal") end end
    function m.listBlockingTrainNames()
      needSignal()
      local out = {}
      for i, n in ipairs(o.trains) do out[i] = n end
      return out
    end
    function m.getSignalType()
      needSignal()
      return o.type
    end
    function m.cycleSignalType()
      needSignal()
      o.type = o.type == "ENTRY_SIGNAL" and "CROSS_SIGNAL" or "ENTRY_SIGNAL"
    end
    local p = finish(def, o, m, { "getState", "isForcedRed", "setForcedRed", "listBlockingTrainNames",
      "getSignalType", "cycleSignalType" }, { setForcedRed = true, cycleSignalType = true })
    function p.state()
      return { state = o.state, type = o.type, powered = o.powered, trains = C.deepCopy(o.trains),
        connected = o.boundary }
    end
    return p
  end

  -- TrackObserverPeripheral: a train passing (sim command createTrainPass) sends train_passing, then train_passed
  function B.Create_TrainObserver(def)
    local o = { kind = "Create_TrainObserver", passing = nil, observer = def.observer ~= false }
    local m = {}
    function m.isTrainPassing() return o.passing ~= nil and T.trainByName(o.passing) ~= nil end
    function m.getPassingTrainName()
      if o.passing and T.trainByName(o.passing) then return o.passing end
      return nil
    end
    local p = finish(def, o, m, { "isTrainPassing", "getPassingTrainName" }, {})
    function p.state() return { passing = o.passing } end
    return p
  end

  -- NixieTubePeripheral. Fixture `tubes` (the row, default 1). Attaching clears the row's text.
  local DYES = { "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan",
    "purple", "blue", "brown", "green", "red", "black" }
  local function tubeDisplay() return { r = 63, g = 63, b = 63, blinkPeriod = 0, blinkOffTime = 0, glowWidth = 1,
      glowHeight = 1 } end
  function B.Create_NixieTube(def)
    local o = { kind = "Create_NixieTube", tubes = tonumber(def.tubes) or 1, text = "", colour = def.colour or "orange",
      signal = nil }
    local m = {}
    function m.setText(...)
      local args = table.pack(...)
      o.signal = nil -- blockEntity.computerSignal = null, before the arguments are read
      local text = C.str(1, args[1])
      local colour = optStr(2, args[2])
      local dye
      if colour ~= nil then dye = checkEnum(1, DYES, colour == "grey" and "gray" or colour) end
      o.text = text
      if dye then o.colour = dye end
    end
    function m.setTextColour(colour)
      colour = C.str(1, colour)
      o.colour = checkEnum(1, DYES, colour == "grey" and "gray" or colour)
    end
    m.setTextColor = m.setTextColour
    local function constrain(name, min, max, raw)
      if type(raw) ~= "number" then badField(name, "number", raw) end
      local v = intValue(raw)
      if v < min or v > max then lua(("field %s must be in range %d-%d"):format(name, min, max)) end
      return C.toByte(v)
    end
    local function setDisplay(d, attrs)
      if attrs.r ~= nil then d.r = constrain("r", 0, 255, attrs.r) end
      if attrs.g ~= nil then d.g = constrain("g", 0, 255, attrs.g) end
      if attrs.b ~= nil then d.b = constrain("r", 0, 255, attrs.b) end -- (sic) "r"
      if attrs.glowWidth ~= nil then d.glowWidth = constrain("glowWidth", 1, 4, attrs.glowWidth) end
      if attrs.glowHeight ~= nil then d.glowHeight = constrain("glowHeight", 1, 4, attrs.glowHeight) end
      if attrs.blinkPeriod ~= nil then d.blinkPeriod = constrain("blinkPeriod", 0, 255, attrs.blinkPeriod) end
      if attrs.blinkOffTime ~= nil then d.blinkOffTime = constrain("blinkOffTime", 0, 255, attrs.blinkOffTime) end
      if d.r == 0 and d.g == 0 and d.b == 0 then
        d.blinkPeriod, d.blinkOffTime = 0, 0
      elseif d.blinkPeriod == 0 then
        d.blinkPeriod, d.blinkOffTime = 1, 0
      end
    end
    function m.setSignal(...)
      local args = table.pack(...)
      for i = 1, 2 do
        local t = args[i]
        if t ~= nil then
          C.table(i, t)
          o.signal = o.signal or { first = tubeDisplay(), second = tubeDisplay() }
          setDisplay(i == 1 and o.signal.first or o.signal.second, t)
        end
      end
    end
    local p = finish(def, o, m, { "setText", "setTextColour", "setTextColor", "setSignal" }, ALL_MAIN)
    function p.state()
      return { text = o.text, colour = o.colour, tubes = o.tubes, signal = C.deepCopy(o.signal) }
    end
    return p
  end

  -- ===== package ports: Frogport, Postbox (PackagePortBlockEntity: 18 slots, packages only) =====
  -- Fixture: `address` (the filter), `target: false` (not connected to a chain / station), `accepts` (default
  -- true), `items` (packages in its inventory). Sim commands createDeliverPackage / createSendPackage move packages.

  local function newPort(def, kind)
    local o = { kind = kind, address = def.address or "", target = def.target ~= false, accepts = def.accepts ~= false }
    o.inv = host.newInventory({ size = 18, items = fixtureItems(def.items) })
    local m = {}
    function m.setAddress(a) o.address = C.str(1, a) end
    function m.getAddress() return o.address end
    function m.getConfiguration()
      if not o.target then return nil end
      return o.accepts and "send_recieve" or "send"
    end
    function m.setConfiguration(config)
      config = C.str(1, config)
      if not o.target then return false end
      if config == "send_recieve" then o.accepts = true return true end
      if config == "send" then o.accepts = false return true end
      lua(('Unknown configuration: "%s" Possible configurations are: "send_recieve" and "send".'):format(config))
    end
    function m.list() return listOf(invSlots(o.inv), 18) end
    function m.getItemDetail(slot) return itemDetailOf(invSlots(o.inv), 18, slot) end
    local decl = kind == "Create_Frogport"
      and { "setAddress", "getAddress", "getConfiguration", "setConfiguration", "list", "getItemDetail" }
      or { "setAddress", "getAddress", "list", "getItemDetail", "getConfiguration", "setConfiguration" }
    local p = finish(def, o, m, decl, ALL_MAIN)
    function p.state()
      return { address = o.address, configuration = o.target and (o.accepts and "send_recieve" or "send") or nil,
        items = o.inv.list() }
    end
    return p
  end
  B.Create_Frogport = function(def) return newPort(def, "Create_Frogport") end
  B.Create_Postbox = function(def) return newPort(def, "Create_Postbox") end

  -- ===== packagers (PackagerBlockEntity, RepackagerBlockEntity) =====
  -- Fixture: `inventory` (a world inventory's name) or `items`/`size` (its own), `address` (a sign on it), `linked`
  -- (on a stock link: redstone mode is off, makePackage does nothing), `output: "none"` (nothing takes the box: it
  -- stays held until createTakePackage; by default a belt or funnel takes it when the 20-tick animation ends).

  local CYCLE = 20 -- PackagerBlockEntity.CYCLE

  local function newPackager(def, kind)
    local repack = kind == "Create_Repackager"
    local o = { kind = kind, heldBox = nil, animation = 0, cooldown = 0, sign = def.address or "",
      custom = "", hasCustom = false, linked = (not repack) and def.linked == true, output = def.output or "belt",
      sent = {} }
    if def.inventory == false then
      o.ownInv = nil
    elseif def.inventory == nil then
      o.ownInv = host.newInventory({ size = def.size or 27, items = fixtureItems(def.items) })
    end
    local function inventory()
      if o.ownInv then return o.ownInv end
      if type(def.inventory) == "string" then return host.findInventory(def.inventory) end
      return nil
    end
    local function updateSignAddress() -- signBasedAddress: the sign, or the computer's address while it set one
      o.signBased = o.sign
      if o.hasCustom then o.signBased = o.custom end
    end
    updateSignAddress()

    local function pack(inv)
      local size = invSize(inv)
      local box = {}
      local any, packageItem = false, nil
      local function insertStacked(item, count) -- ItemHandlerHelper.insertItemStacked into the 9 slots
        local left = count
        local limit = item.maxCount or 64
        for s = 1, PACKAGE_SLOTS do
          local e = box[s]
          if e and stackable(e, item) and left > 0 then
            local n = math.min(limit - e.count, left)
            if n > 0 then e.count, left = e.count + n, left - n end
          end
        end
        for s = 1, PACKAGE_SLOTS do
          if not box[s] and left > 0 then
            local copy = {}
            for k, v in pairs(item) do copy[k] = v end
            local n = math.min(limit, left)
            copy.count = n
            box[s], left = copy, left - n
          end
        end
        return count - left
      end
      local done = false
      for _ = 1, PACKAGE_SLOTS do -- for (i < PackageItem.SLOTS): every pass looks at every slot again
        for slot = 1, size do
          local item = inv.__peek(slot)
          if item and item.count > 0 then
            local bulky = isPackage(item) or item.name:find("shulker_box$") ~= nil -- canFitInsideContainerItems
            if not (bulky and any) then
              any = true
              local moved = insertStacked(item, math.min(64, item.count))
              if moved > 0 then inv.__take(slot, moved, item) end
              if isPackage(item) then packageItem = item end
              if bulky then done = true break end -- break Outer
            end
          end
        end
        if done then break end
      end
      if not any then return nil end
      if packageItem then
        local copy = {}
        for k, v in pairs(packageItem) do copy[k] = v end
        copy.count = 1
        return copy
      end
      return newPackage(box, "")
    end

    local function attemptToSend()
      if o.heldBox or o.animation ~= 0 or o.cooldown > 0 then return end
      local inv = inventory()
      if not inv then return end
      if repack then
        -- attemptToRepackage: the first package that is not a fragment of an order leaves as it is
        for slot = 1, invSize(inv) do
          local item = inv.__peek(slot)
          if item and isPackage(item) and not item.__pkg.order then
            inv.__take(slot, 1, item)
            local box = {}
            for k, v in pairs(item) do box[k] = v end
            box.count = 1
            o.heldBox, o.animation = box, CYCLE
            updateSignAddress()
            if o.signBased:find("%S") then box.__pkg.address = o.signBased end
            return
          end
        end
        return
      end
      local box = pack(inv)
      if not box then return end
      emitPackage("package_created", def.name, packageObject(o, box))
      box.__pkg.address = "" -- PackageItem.clearAddress
      if o.signBased:find("%S") then box.__pkg.address = o.signBased end
      o.heldBox, o.animation = box, CYCLE
    end

    function o.tick()
      if o.cooldown > 0 then o.cooldown = o.cooldown - 1 end
      if o.animation == 0 then return o.cooldown > 0 end
      o.animation = o.animation - 1
      if o.animation == 0 and o.heldBox and o.output ~= "none" then -- wakeTheFrogs: the belt takes it
        local b = o.heldBox
        o.sent[#o.sent + 1] = { address = b.__pkg.address, items = listOf(function(i) return b.__pkg.contents[i] end, 9) }
        o.heldBox = nil
      end
      return true
    end
    function o.busy() return o.animation > 0 or o.cooldown > 0 end

    local m = {}
    function m.makePackage()
      if o.heldBox then return false end
      if not o.linked then -- activate(): redstone mode only
        updateSignAddress()
        attemptToSend()
        if o.cooldown <= 0 then o.cooldown = 40 end
      end
      return o.heldBox ~= nil
    end
    function m.list()
      local inv = inventory()
      if not inv then C.java("java.lang.NullPointerException") end
      return listOf(invSlots(inv), invSize(inv))
    end
    function m.getItemDetail(slot)
      local inv = inventory()
      if not inv then C.java("java.lang.NullPointerException") end
      return itemDetailOf(invSlots(inv), invSize(inv), slot)
    end
    function m.getAddress()
      updateSignAddress()
      return o.signBased
    end
    function m.setAddress(a)
      if a ~= nil then
        a = C.str(1, a)
        o.custom, o.signBased, o.hasCustom = a, a, true
      else
        o.custom, o.hasCustom = "", false
      end
    end
    function m.getPackage()
      if not o.heldBox then return nil end
      return packageObject(o, o.heldBox)
    end
    o.inventory = inventory
    local p = finish(def, o, m, { "makePackage", "list", "getItemDetail", "getAddress", "setAddress", "getPackage" },
      ALL_MAIN)
    function p.state()
      local held = o.heldBox
      return { held = held and { address = held.__pkg.address,
          items = listOf(function(i) return held.__pkg.contents[i] end, 9) } or nil,
        animation = o.animation, address = (o.hasCustom and o.custom) or o.sign, sent = C.deepCopy(o.sent) }
    end
    return p
  end
  B.Create_Packager = function(def) return newPackager(def, "Create_Packager") end
  B.Create_Repackager = function(def) return newPackager(def, "Create_Repackager") end

  -- ===== Stock Ticker (StockTickerPeripheral) =====
  -- Fixture: `network` (world.create.stock[network], default "main") or `stock` (its own), `payments` (items in its
  -- 27-slot payment inventory; other inventories reach it by name, its getTarget()).

  function B.Create_StockTicker(def)
    local o = { kind = "Create_StockTicker", net = netFor(def) }
    o.payments = host.newInventory({ size = 27, items = fixtureItems(def.payments) })
    local m = {}
    function m.stock(detailed)
      if detailed ~= nil then C.bool(1, detailed) end
      local out = {}
      for i, e in ipairs(network(o.net)) do
        out[i] = detailed and details(e.item, e.count) or basic(e.item, e.count)
      end
      return out
    end
    function m.getStockItemDetail(slot)
      slot = C.int(1, slot)
      local net = network(o.net)
      if slot < 1 or slot > #net then slotError(slot, #net) end
      return details(net[slot].item, net[slot].count)
    end
    function m.requestFiltered(...)
      local args = table.pack(...)
      local address = C.str(1, args[1])
      local net = network(o.net)
      local order, total = {}, 0
      for i = 2, args.n do
        local f = args[i]
        if type(f) ~= "table" then lua("Filter must be a table") end
        for k in pairs(f) do if type(k) ~= "string" then lua("Filter keys must be strings") end end
        local filter = deepCopy(f) -- the Java map the argument became
        local want = 2147483647
        if filter._requestCount ~= nil then
          local rc = filter._requestCount
          filter._requestCount = nil
          if type(rc) ~= "number" then lua("_requestCount must be a positive number or nil for no limit") end
          want = intValue(rc)
          if want < 1 then lua("_requestCount must be a positive number or nil for no limit") end
        end
        for _, e in ipairs(net) do
          local found = filterCount(e, filter)
          if found > 0 then
            local take = math.min(found, want)
            want, total = want - take, total + take
            e.count = e.count - take
            order[#order + 1] = basic(e.item, take)
          end
          if want <= 0 then break end
        end
      end
      prune(net)
      if #order > 0 then
        requests[#requests + 1] = { from = def.name, kind = "restock", network = o.net, address = address, items = order }
      end
      return total
    end
    function m.list() return listOf(invSlots(o.payments), 27) end
    function m.getItemDetail(slot) return itemDetailOf(invSlots(o.payments), 27, slot) end
    local p = finish(def, o, m, { "stock", "getStockItemDetail", "requestFiltered", "list", "getItemDetail" }, ALL_MAIN,
      { inventory = o.payments })
    function p.state()
      local stock = {}
      for i, e in ipairs(network(o.net)) do stock[i] = basic(e.item, e.count) end
      return { network = o.net, stock = stock, payments = o.payments.list() }
    end
    return p
  end

  -- ===== Redstone Requester (RedstoneRequesterPeripheral, RedstoneRequesterBlockEntity) =====
  -- Fixture: `network` / `stock` as the Stock Ticker, `address`, `allowPartial`, `request` (up to 9 items).

  local function generateOrder(args, from)
    local list = {}
    for i = from, from + 8 do
      local a = args[i]
      if a == nil then
        list[#list + 1] = { item = nil, count = 1 }
      elseif type(a) == "string" then
        list[#list + 1] = { item = itemFor(a), count = 1 }
      elseif type(a) == "table" then
        local name = type(a.name) == "string" and a.name or "minecraft:air"
        local count = 1
        if type(a.count) == "number" then
          count = intValue(a.count)
          if count > 256 then lua("Count for item " .. name .. " exceeds 256") end
        end
        list[#list + 1] = { item = itemFor(name), count = count }
      end
    end
    return list
  end

  function B.Create_RedstoneRequester(def)
    local o = { kind = "Create_RedstoneRequester", net = netFor(def), address = def.address or "",
      partial = def.allowPartial == true, request = {}, crafts = {} }
    for _, it in ipairs(def.request or {}) do
      o.request[#o.request + 1] = { item = itemFor(it.name), count = tonumber(it.count) or 1 }
    end
    local m = {}
    function m.request()
      if #o.request == 0 then return end -- encodedRequest.isEmpty(): no entries at all (air entries count)
      local net = network(o.net)
      local wanted = {} -- InventorySummary of the order: air is not counted
      for _, e in ipairs(o.request) do if e.item and e.count > 0 then summaryAdd(wanted, e.item, e.count) end end
      for _, e in ipairs(wanted) do
        if countOf(net, e.item) < e.count and not o.partial then return end
      end
      local sent = {}
      for _, e in ipairs(wanted) do
        for _, s in ipairs(net) do
          if s.item.name == e.item.name and s.item.nbt == e.item.nbt then
            local n = math.min(s.count, e.count)
            if n > 0 then
              s.count = s.count - n
              sent[#sent + 1] = basic(s.item, n)
            end
          end
        end
      end
      prune(net)
      requests[#requests + 1] = { from = def.name, kind = "redstone", network = o.net, address = o.address,
        items = sent, crafts = #o.crafts > 0 and C.deepCopy(o.crafts) or nil }
    end
    function m.setRequest(...)
      o.request = generateOrder(table.pack(...), 1)
      o.crafts = {}
    end
    function m.setCraftingRequest(...)
      local args = table.pack(...)
      local count = C.int(1, args[1])
      o.request = generateOrder(args, 2)
      local recipe = {}
      for i, e in ipairs(o.request) do recipe[i] = e.item and e.item.name or "minecraft:air" end
      o.crafts = { { count = count, recipe = recipe } }
    end
    function m.getRequest()
      local out = {}
      for i, e in ipairs(o.request) do
        if e.item then out[i] = details(e.item, e.count) end
      end
      return out
    end
    function m.getConfiguration() return o.partial and "allow_partial" or "strict" end
    function m.setConfiguration(config)
      config = C.str(1, config)
      if config == "allow_partial" then o.partial = true return end
      if config == "strict" then o.partial = false return end
      lua(('Unknown configuration: "%s" Possible configurations are: "allow_partial" and "strict".'):format(config))
    end
    function m.setAddress(a) o.address = C.str(1, a) end
    function m.getAddress() return o.address end
    local p = finish(def, o, m, { "request", "setRequest", "setCraftingRequest", "getRequest", "getConfiguration",
      "setConfiguration", "setAddress", "getAddress" }, ALL_MAIN)
    function p.state()
      local req = {}
      for i, e in ipairs(o.request) do req[i] = e.item and { name = e.item.name, count = e.count } or false end
      return { address = o.address, configuration = o.partial and "allow_partial" or "strict", request = req,
        crafts = C.deepCopy(o.crafts) }
    end
    return p
  end

  -- ===== Table Cloth shop (TableClothShopPeripheral) =====
  -- Fixture: `wares` (what it sells: a shop when there are any), `address`, `priceTag: { item, count }`, `items`
  -- (items placed on the cloth by hand: setWares refuses).

  function B.Create_TableClothShop(def)
    local o = { kind = "Create_TableClothShop", wares = {}, address = def.address or "",
      priceItem = def.priceTag and itemFor(def.priceTag.item) or nil,
      priceCount = def.priceTag and intValue(tonumber(def.priceTag.count) or 1) or 1,
      manual = def.items ~= nil and next(def.items) ~= nil }
    for _, w in ipairs(def.wares or {}) do
      local it = itemFor(w.name)
      if it then o.wares[#o.wares + 1] = { item = it, count = tonumber(w.count) or 1 } end
    end
    local function isShop() return #o.wares > 0 end
    local function assertShop() if not isShop() then lua("TableCloth is not a shop!") end end
    local m = {}
    function m.isShop() return isShop() end
    function m.getAddress()
      assertShop()
      return o.address
    end
    function m.setAddress(a)
      a = C.str(1, a)
      assertShop()
      o.address = a
    end
    function m.getPriceTagItem()
      assertShop()
      return details(o.priceItem or { name = "minecraft:air", count = 0 }, o.priceItem and 1 or 0)
    end
    function m.setPriceTagItem(name)
      if name ~= nil then name = C.str(1, name) end
      assertShop()
      o.priceItem = name and itemFor(name) or nil
    end
    function m.getPriceTagCount()
      assertShop()
      return o.priceCount
    end
    function m.setPriceTagCount(n)
      if n ~= nil then
        if type(n) ~= "number" then lua(("bad argument #1 (number expected, got %s)"):format(typeName(n))) end
      end
      assertShop()
      o.priceCount = n ~= nil and math.max(1, math.min(100, intValue(n))) or 1
    end
    function m.getWares()
      assertShop()
      local out = {}
      for i, w in ipairs(o.wares) do out[i] = details(w.item, w.count) end
      return out
    end
    function m.setWares(...)
      local args = table.pack(...)
      if o.manual then lua("Tablecloth isn't empty.") end
      local list = {}
      for i = 1, 9 do
        local a = args[i]
        if a ~= nil then
          C.table(i, a)
          local name = type(a.name) == "string" and a.name or "minecraft:air"
          local count = 1
          if type(a.count) == "number" then
            count = intValue(a.count)
            if count > 256 then lua("Count for item " .. name .. " exceeds 256") end
          end
          local it = itemFor(name)
          if not it then lua("Invalid item at index: " .. i) end
          list[#list + 1] = { item = it, count = count }
        end
      end
      o.wares = list
    end
    local p = finish(def, o, m, { "isShop", "getAddress", "setAddress", "getPriceTagItem", "setPriceTagItem",
      "getPriceTagCount", "setPriceTagCount", "getWares", "setWares" }, ALL_MAIN)
    function p.state()
      local wares = {}
      for i, w in ipairs(o.wares) do wares[i] = { name = w.item.name, count = w.count } end
      return { shop = isShop(), address = o.address, wares = wares,
        priceTag = { item = o.priceItem and o.priceItem.name or "minecraft:air", count = o.priceCount } }
    end
    return p
  end

  function X.peripheral(def)
    local make = B[def.type]
    return make(def)
  end

  -- ===== sim commands =====

  local function block(name, kinds)
    local o = blocks[name]
    if not o or not kinds[o.kind] then return nil, "not a " .. table.concat((function()
      local out = {}
      for k in pairs(kinds) do out[#out + 1] = k end
      table.sort(out)
      return out
    end)(), " or ") .. ": " .. tostring(name) end
    return o
  end

  --- a train passes a Train Observer: train_passing, and train_passed when `passing` is false
  function X.handlers.createTrainPass(cmd)
    M.catchUp()
    local o, err = block(cmd.peripheral, { Create_TrainObserver = true })
    if not o then return false, err end
    local name = cmd.train
    if not T.trainByName(name) then T.addTrain({ name = name }) end
    if cmd.passing == false then
      if o.passing then
        M.emit("train_passed", cmd.peripheral, o.passing)
        o.passing = nil
      end
    else
      o.passing = name
      M.emit("train_passing", cmd.peripheral, name)
    end
    return true
  end

  --- a signal's section: trains in it, redstone on it, its clear state
  function X.handlers.createSetSignal(cmd)
    M.catchUp()
    local o, err = block(cmd.peripheral, { Create_Signal = true })
    if not o then return false, err end
    if cmd.trains then o.trains = C.deepCopy(cmd.trains) end
    if cmd.powered ~= nil then o.powered = cmd.powered == true end
    if cmd.clear then o.clear = cmd.clear end
    if cmd.connected ~= nil then o.boundary = cmd.connected ~= false end
    return true
  end

  --- a package arrives: into a port's inventory (package_received), or into a packager, which unwraps it into its
  --- inventory (package_received)
  function X.handlers.createDeliverPackage(cmd)
    M.catchUp()
    local o, err = block(cmd.peripheral, { Create_Frogport = true, Create_Postbox = true, Create_Packager = true,
      Create_Repackager = true })
    if not o then return false, err end
    local contents = {}
    for i, it in ipairs(cmd.items or {}) do contents[i] = fixtureItem(it) end
    local box = newPackage(contents, cmd.address)
    if o.inv then
      if o.inv.__insert(box, 1) ~= 1 then return false, "the port is full" end
    else
      local inv = o.inventory()
      if not inv then return false, "the packager faces no inventory" end
      for i = 1, PACKAGE_SLOTS do
        local item = box.__pkg.contents[i]
        if item then inv.__insert(item, item.count) end
      end
    end
    emitPackage("package_received", cmd.peripheral, packageObject(nil, box))
    return true
  end

  --- a port sends a package on (the frog throws it onto the chain, the train takes it): package_sent
  function X.handlers.createSendPackage(cmd)
    M.catchUp()
    local o, err = block(cmd.peripheral, { Create_Frogport = true, Create_Postbox = true })
    if not o then return false, err end
    for slot = tonumber(cmd.slot) or 1, tonumber(cmd.slot) or 18 do
      local item = o.inv.__peek(slot)
      if item and isPackage(item) then
        o.inv.__take(slot, 1, item)
        emitPackage("package_sent", cmd.peripheral, packageObject(nil, item))
        return true
      end
    end
    return false, "no package in " .. tostring(cmd.peripheral)
  end

  --- something takes the box a packager holds (output "none")
  function X.handlers.createTakePackage(cmd)
    M.catchUp()
    local o, err = block(cmd.peripheral, { Create_Packager = true, Create_Repackager = true })
    if not o then return false, err end
    if not o.heldBox or o.animation > 0 then return false, "no package ready" end
    local b = o.heldBox
    o.sent[#o.sent + 1] = { address = b.__pkg.address, items = listOf(function(i) return b.__pkg.contents[i] end, 9) }
    o.heldBox = nil
    return true
  end

  --- a logistics network's stock changes
  function X.handlers.createSetStock(cmd)
    M.catchUp()
    local id = tostring(cmd.network or "main")
    local net = {}
    for _, item in ipairs(cmd.items or {}) do
      local it = fixtureItem(item)
      summaryAdd(net, it, it.count)
    end
    nets[id] = net
    return true
  end

  function X.state(s)
    s.requests = C.deepCopy(requests)
    local stock = {}
    for id, net in pairs(nets) do
      local list = {}
      for i, e in ipairs(net) do list[i] = basic(e.item, e.count) end
      stock[id] = list
    end
    s.stock = stock
  end

  return X
end
