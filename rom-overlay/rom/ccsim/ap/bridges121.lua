-- ccsim ap/bridges121: the ME bridge and the RS bridge of Advanced Peripherals 1.21.1-0.7.62b (MEBridgePeripheral,
-- RSBridgePeripheral, AEApi, RSApi, AECraftJob, RSCraftJob, BasicCraftJob, ItemFilter, FluidFilter, GenericFilter,
-- LuaConverter, StatusConstants), cross-checked with the jar's @LuaFunction list. Loaded by ap/bridges.lua for a
-- world on Minecraft 1.21.1; the network fixture is the same (see the top of ap/bridges.lua).
--
-- What 0.7.62b changed from 0.7.48r, as followed here:
--   - one API for both bridges (IStorageSystemPeripheral): getItem/getFluid/getChemical, getItems/getFluids/
--     getChemicals(filter?), getCraftableItems/getCraftableFluids(filter?), getCells, getDrives, getPatterns(filter?),
--     importItem/exportItem/importFluid/exportFluid(filter, side or peripheral name), getStoredEnergy,
--     getEnergyCapacity, getEnergyUsage, getAverageEnergyInput, getTotal/Used/Available[External]Item/Fluid/
--     ChemicalStorage, craftItem/craftFluid returning a job object, getCraftingTasks, getCraftingTask(id),
--     cancelCraftingTasks(filter), isCraftable/isCrafting(generic filter), isOnline; the ME bridge also has
--     getCraftingCPUs, the RS bridge getCraftableChemicals and craftChemical
--   - stacks are LuaConverter.itemStackToObject: name, tags, count, displayName, maxStackSize, components,
--     fingerprint, plus isCraftable; fluids carry fluidType instead of maxStackSize
--   - filters read `components` (not `nbt`), and a field of the wrong type raises "bad field ..." instead of
--     returning a NO_VALID_* code; fluid filters take `amount` (or `count`), default 1000
--   - errors are StatusConstants names: NOT_CONNECTED, EMPTY_FILTER, NOT_FOUND, INVENTORY_NOT_FOUND, NOT_CRAFTABLE,
--     CPU_NOT_FOUND_<name>, ADDON_NOT_LOADED_<addon>, NO_FILTER, NO_VALID_FILTER_TYPE (RS: NO_PATTERN_FOUND)
--   - a crafting job fires `ae_crafting` / `rs_crafting` (error, jobId, status): CALCULATION_STARTED,
--     CRAFTING_STARTED, then JOB_DONE (the RS bridge flags JOB_DONE as an error, as its code does) or JOB_CANCELED;
--     NOT_CRAFTABLE, MISSING_ITEMS and AE2's submit error codes (NO_CPU_FOUND, CPU_BUSY, ...) on failure
--   - the RS bridge (Refined Storage 2) is always connected; ME craftItem/craftFluid run on the computer thread
-- Not followed (no fixture for it): storage buses / external storage (always 0), the real XXHash64 fingerprint (the
-- md5 one of ap/base.lua or the fixture's `fingerprint` is used), pattern ingredients for craftables without a
-- `patterns` entry, AE2's byte count of a plan (getUsedBytes is the job's amount).
return function(core, B, ctx)
  local self, def, net, isME = ctx.self, ctx.def, ctx.net, ctx.isME
  local m = self.methods
  local test, findIn, sameKey = ctx.test, ctx.findIn, ctx.sameKey
  local EVENT = isME and "ae_crafting" or "rs_crafting"
  local chemAddon = def.chemicals ~= nil
  local chemicals = {}
  for _, c in ipairs(def.chemicals or {}) do
    local e = B.copy(c)
    e.amount = e.amount or e.count or 0
    e.count = nil
    chemicals[#chemicals + 1] = e
  end
  local ADDON = isME and "APP_MEKANISTICS" or "refinedstorage_mekanism_integration"

  local function typeName(v)
    if v == nil then return "nil" end
    return type(v)
  end

  local function badField(key, expected, v)
    error(("bad field '%s' (%s expected, got %s)"):format(key, expected, typeName(v)), 0)
  end

  -- ----- filters -----

  --- ItemFilter.parse / FluidFilter.parse / ChemicalFilter.parse of 0.7.62b: filter or nil, code; a field of the
  --- wrong type raises (LuaTable.getString/getInt).
  local function parseFilter(tbl, kind)
    local copy = {}
    for k, v in pairs(tbl) do copy[k] = v end
    copy.nbt, copy.components, copy.type = nil, nil, nil
    for _, key in ipairs({ "name", "fingerprint" }) do
      if copy[key] ~= nil and type(copy[key]) ~= "string" then badField(key, "string", copy[key]) end
    end
    local numbers = kind == "item" and { "fromSlot", "toSlot", "count" } or { "amount", "count" }
    for _, key in ipairs(numbers) do
      if copy[key] ~= nil and type(copy[key]) ~= "number" then badField(key, "number", copy[key]) end
    end
    local components
    if tbl.components ~= nil and kind ~= "chemical" then
      if type(tbl.components) == "string" then
        components = B.snbt(tbl.components)
        if components == nil then error('bad field "components", expect NBT string or table', 0) end
      elseif type(tbl.components) == "table" then
        components = tbl.components
      else
        error('bad field "components", expect NBT string or table', 0)
      end
    end
    if kind ~= "item" then
      copy.count = tbl.amount or tbl.count
      copy.amount, copy.fromSlot, copy.toSlot = nil, nil, nil
    end
    local f, err = B.parseFilter(copy, kind == "item" and "item" or "fluid")
    if not f then
      if kind == "chemical" then err = err:gsub("^FLUID", "CHEMICAL") end
      return nil, err
    end
    f.kind = kind
    if kind == "chemical" and copy.count == nil then f.count = 1000 end
    f.nbt = components
    return f
  end

  local function isEmpty(f) return B.filterIsEmpty(f) end

  local function tableArg(v) return B.table(1, v) end

  local function optTableArg(v)
    if v == nil then return {} end
    return B.table(1, v)
  end

  local KNOWN_FLUIDS = {
    ["minecraft:water"] = true, ["minecraft:lava"] = true, ["minecraft:flowing_water"] = true,
    ["minecraft:flowing_lava"] = true, ["minecraft:empty"] = true,
  }

  local function isFluidName(name)
    local full = name:find(":", 1, true) and name or ("minecraft:" .. name)
    if KNOWN_FLUIDS[full] then return true end
    for _, list in ipairs({ net.fluids, net.craftableFluids }) do
      for _, e in ipairs(list) do if e.name == full then return true end end
    end
    return false
  end

  local EMPTY_GENERIC = { empty = true }

  --- GenericFilter.parseGeneric: a filter with its kind, or nil/EMPTY and a code; bad shapes raise.
  local function parseGeneric(tbl)
    if tbl.type ~= nil then
      if type(tbl.type) ~= "string" then badField("type", "string", tbl.type) end
      if tbl.type == "item" then return parseFilter(tbl, "item") end
      if tbl.type == "fluid" then return parseFilter(tbl, "fluid") end
      if tbl.type == "chemical" then
        if not chemAddon then error("cannot use chemical filter: Mekanism is required", 0) end
        return parseFilter(tbl, "chemical")
      end
      error("unexpected filter type " .. tbl.type, 0)
    end
    if tbl.name == nil then error('Generic filter requires either field "type" or "name"', 0) end
    if type(tbl.name) ~= "string" then badField("name", "string", tbl.name) end
    local name = tbl.name
    if name:sub(1, 1) ~= "#" and name:match("^[%l%d_.%-]*:?[%l%d_./%-]+$") then
      if isFluidName(name) then return parseFilter(tbl, "fluid") end
      return parseFilter(tbl, "item")
    end
    return EMPTY_GENERIC, "NO_VALID_FILTER_TYPE"
  end

  local function genericTest(g, stack, kind)
    if not g or g.empty then return false end
    return g.kind == kind and test(g, stack)
  end

  -- ----- patterns and craftables -----

  local function patternList()
    local out = {}
    for i, p in ipairs(def.patterns or {}) do
      local outputs, inputs = {}, {}
      for _, s in ipairs(p.outputs or {}) do
        local copy = B.copy(s)
        copy.amount = copy.amount or copy.count or 1
        copy.count = nil
        copy.kind = copy.kind or (isFluidName(copy.name) and "fluid" or "item")
        outputs[#outputs + 1] = copy
      end
      for _, group in ipairs(p.inputs or {}) do
        local options = {}
        for _, s in ipairs(group) do
          local copy = B.copy(s)
          copy.amount = copy.amount or copy.count or 1
          copy.count = nil
          copy.kind = copy.kind or (isFluidName(copy.name) and "fluid" or "item")
          options[#options + 1] = copy
        end
        if #options > 0 then inputs[#inputs + 1] = options end
      end
      out[#out + 1] = { index = i, outputs = outputs, inputs = inputs, def = p }
    end
    return out
  end

  --- Whether the network can craft this key: a craftable fixture entry (no pattern details) or a pattern output.
  local function craftable(entry, kind)
    if kind ~= "chemical" and ctx.isCraftableEntry(entry, kind) then return true end
    for _, e in ipairs(kind == "fluid" and net.fluids or kind == "item" and net.items or chemicals) do
      if sameKey(e, entry) and e.craftable then return true end
    end
    for _, p in ipairs(patternList()) do
      for _, o in ipairs(p.outputs) do
        if o.kind == kind and sameKey(o, entry) then return true end
      end
    end
    return false
  end

  --- Every craftable key of a kind (craftable entries, flagged stored entries, pattern outputs), once each.
  local function craftableKeys(kind)
    local out = {}
    local function add(e)
      for _, o in ipairs(out) do if sameKey(o, e) then return end end
      out[#out + 1] = e
    end
    for _, e in ipairs(kind == "fluid" and net.fluids or kind == "item" and net.items or chemicals) do
      if e.craftable then add(e) end
    end
    if kind ~= "chemical" then
      for _, c in ipairs(kind == "fluid" and net.craftableFluids or net.craftableItems) do add(c) end
    end
    for _, p in ipairs(patternList()) do
      for _, o in ipairs(p.outputs) do if o.kind == kind then add(o) end end
    end
    return out
  end

  local function storedAmount(entry, kind)
    for _, e in ipairs(kind == "fluid" and net.fluids or kind == "item" and net.items or chemicals) do
      if sameKey(e, entry) then return e.amount end
    end
    return 0
  end

  -- ----- stack objects (LuaConverter, AEApi.parse*Stack, RSApi.getObjectFrom*Resource) -----

  local FLUID_TYPES = {
    ["minecraft:water"] = {
      viscosity = 1000, density = 1000, temperature = 300, canHydrate = true, canExtinguish = true,
      canDrownIn = true, canSwim = true, canPushEntity = true, supportsBoating = true, canConvertToSource = true,
    },
    ["minecraft:lava"] = {
      viscosity = 6000, density = 3000, temperature = 1300, canHydrate = false, canExtinguish = false,
      canDrownIn = false, canSwim = false, canPushEntity = false, supportsBoating = false, canConvertToSource = false,
    },
  }
  local DEFAULT_FLUID_TYPE = {
    viscosity = 1000, density = 1000, temperature = 300, canHydrate = false, canExtinguish = false,
    canDrownIn = true, canSwim = true, canPushEntity = true, supportsBoating = false, canConvertToSource = false,
  }

  --- The stack's table; `isCraftable` is the network's answer, or false where AP passes no crafting service.
  local function stackObject(entry, kind, count, withCraftable)
    if not entry.name then return nil end -- an empty stack (an RS job for a tag-only filter)
    local o
    if kind == "chemical" then
      o = {
        name = entry.name, tags = entry.tags or {}, isGaseous = entry.isGaseous ~= false, count = count,
        displayName = B.displayName(entry), fingerprint = B.fingerprint(entry),
      }
    else
      o = {
        name = entry.name, tags = entry.tags or {}, count = count, displayName = B.displayName(entry),
        components = B.copy(entry.components or entry.nbt or {}), fingerprint = B.fingerprint(entry),
      }
      if kind == "fluid" then
        o.fluidType = B.copy(entry.fluidType or FLUID_TYPES[entry.name] or DEFAULT_FLUID_TYPE)
      else
        o.maxStackSize = entry.maxCount or 64
      end
    end
    o.isCraftable = withCraftable ~= false and craftable(entry, kind) or false
    return o
  end

  local function listOf(kind)
    if kind == "item" then return net.items end
    if kind == "fluid" then return net.fluids end
    return chemicals
  end

  local function notConnected(default) return default, "NOT_CONNECTED" end
  local function available() return not isME or net.connected end

  -- ----- reading the network -----

  m.isConnected = function() return available() end
  if isME then
    m.isOnline = function() return net.connected and def.online ~= false end
  else
    m.isOnline = function() return ((net.energy or {}).stored or 0) > 0 end
  end

  local function getOne(kind)
    return function(filterTable)
      if not available() then return notConnected(nil) end
      if kind == "chemical" and not chemAddon then
        if isME then return nil end -- no Applied Mekanistics key can be stored
        return nil, "ADDON_NOT_LOADED_" .. ADDON
      end
      local f, err = parseFilter(tableArg(filterTable), kind)
      if not f then return nil, err end
      if isEmpty(f) then return nil, "EMPTY_FILTER" end
      local entry = findIn(listOf(kind), f)
      if entry then return stackObject(entry, kind, entry.amount) end
      if isME then
        -- AEApi.find*FromFilter falls back to the craftables (amount 0); nothing at all is a plain nil
        for _, c in ipairs(craftableKeys(kind)) do
          if test(f, c) then return stackObject(c, kind, 0) end
        end
        return nil
      end
      return nil, "NOT_FOUND"
    end
  end
  m.getItem = getOne("item")
  m.getFluid = getOne("fluid")
  m.getChemical = getOne("chemical")

  local function getMany(kind, craftables)
    return function(filterTable)
      if not available() then return notConnected(nil) end
      if kind == "chemical" and not chemAddon then
        return nil, "ADDON_NOT_LOADED_" .. (isME and ADDON or "RS_MEKANISM")
      end
      local f, err = parseFilter(optTableArg(filterTable), kind)
      if not f then return nil, err end
      local out = {}
      if craftables then
        for _, c in ipairs(craftableKeys(kind)) do
          if test(f, c) then out[#out + 1] = stackObject(c, kind, storedAmount(c, kind)) end
        end
      else
        for _, e in ipairs(listOf(kind)) do
          if test(f, e) then out[#out + 1] = stackObject(e, kind, e.amount) end
        end
      end
      return out
    end
  end
  m.getItems = getMany("item")
  m.getFluids = getMany("fluid")
  m.getChemicals = getMany("chemical")
  m.getCraftableItems = getMany("item", true)
  m.getCraftableFluids = getMany("fluid", true)
  if not isME then
    -- the ME bridge has the method but without @LuaFunction, so Lua never sees it
    local inner = getMany("chemical", true)
    m.getCraftableChemicals = function(filterTable)
      if not chemAddon then return nil, "ADDON_NOT_LOADED_" .. ADDON end
      return inner(filterTable)
    end
  end

  -- ----- cells, drives and storage totals -----

  local pos = { x = math.floor(def.x or 0), y = math.floor(def.y or 64), z = math.floor(def.z or 0) }

  local function cellKind(c)
    local t = c.cellType or c.type or "item"
    if t == "ae2:i" then return "item" end
    if t == "ae2:f" then return "fluid" end
    return t
  end

  local function cellCapacity(c) return c.capacity or c.totalBytes or c.bytes or 0 end

  --- ME: a cell's used bytes (AE2's BasicCellInventory: ceil(count / 8) + bytesPerType per type, fluids by bucket).
  local function meUsed(c)
    if c.usedBytes then return c.usedBytes end
    local list = cellKind(c) == "fluid" and net.fluids or cellKind(c) == "item" and net.items or chemicals
    local count = 0
    for _, e in ipairs(list) do count = count + e.amount end
    if cellKind(c) ~= "item" then count = math.floor(count / 1000) end
    return math.ceil(count / 8) + (c.bytesPerType or 8) * #list
  end

  --- RS: the disks (fixture `cells`, else the old `storage` maxima as one item and one fluid disk), each with the
  --- amount stored on it, filled in order.
  local function rsDisks()
    local cells = def.cells
    if not cells then
      cells = {}
      local s = def.storage or {}
      if (s.maxItemDisk or 0) ~= 0 then cells[#cells + 1] = { type = "item", capacity = s.maxItemDisk } end
      if (s.maxFluidDisk or 0) ~= 0 then cells[#cells + 1] = { type = "fluid", capacity = s.maxFluidDisk } end
    end
    local left = {}
    for _, kind in ipairs({ "item", "fluid", "chemical" }) do
      local sum = 0
      for _, e in ipairs(listOf(kind)) do sum = sum + e.amount end
      left[kind] = sum
    end
    local out = {}
    for _, c in ipairs(cells) do
      local kind, capacity = cellKind(c), cellCapacity(c)
      local used = c.used
      if used == nil then
        used = capacity < 0 and left[kind] or math.min(capacity, left[kind] or 0)
        left[kind] = (left[kind] or 0) - used
      end
      out[#out + 1] = { kind = kind, capacity = capacity, used = used, def = c }
    end
    return out
  end

  local function rsDiskObject(d)
    local state = "NORMAL"
    if d.capacity > 0 and d.used >= d.capacity then state = "FULL"
    elseif d.capacity > 0 and d.used >= d.capacity * 0.75 then state = "NEAR_CAPACITY" end
    return { used = d.used, capacity = d.capacity, state = d.def.state or state, type = d.kind }
  end

  local function meCellObject(c)
    local kind = cellKind(c)
    return {
      item = { name = c.item or "ae2:item_storage_cell_1k", tags = c.itemTags or {} },
      type = kind == "fluid" and "ae2:f" or kind == "item" and "ae2:i" or "appmek:chemical",
      bytes = cellCapacity(c), bytesPerType = c.bytesPerType or 8, usedBytes = meUsed(c),
      totalTypes = c.totalTypes or 63, fuzzyMode = c.fuzzyMode or "IGNORE_ALL",
    }
  end

  m.getCells = function()
    if not available() then return notConnected(nil) end
    local out = {}
    if isME then
      for _, c in ipairs(def.cells or {}) do out[#out + 1] = meCellObject(c) end
    else
      for _, d in ipairs(rsDisks()) do out[#out + 1] = rsDiskObject(d) end
    end
    return out
  end

  m.getDrives = function()
    if not available() then return notConnected(nil) end
    if def.drives then return B.copy(def.drives) end
    if isME then
      if not def.cells or #def.cells == 0 then return {} end
      local cells, used, total = {}, 0, 0
      for _, c in ipairs(def.cells) do
        cells[#cells + 1] = meCellObject(c)
        used, total = used + meUsed(c), total + cellCapacity(c)
      end
      return { {
        usedBytes = used, totalBytes = total, cells = cells, priority = 0,
        menuIcon = { name = "ae2:drive", tags = {} }, position = B.copy(pos), name = "ME Drive",
      } }
    end
    local disks = rsDisks()
    if #disks == 0 then return {} end
    local objects, used, total = {}, 0, 0
    for _, d in ipairs(disks) do
      objects[#objects + 1] = rsDiskObject(d)
      used, total = used + d.used, total + d.capacity
    end
    return { {
      used = used, total = total, disks = objects, mode = "BLOCK", access_type = "INSERT_EXTRACT",
      position = B.copy(pos), priority = 0,
    } }
  end

  local function total(kind)
    local sum = 0
    if isME then
      for _, c in ipairs(def.cells or {}) do if cellKind(c) == kind then sum = sum + cellCapacity(c) end end
    else
      for _, d in ipairs(rsDisks()) do if d.kind == kind then sum = sum + d.capacity end end
    end
    return sum
  end

  local function used(kind)
    local sum = 0
    if isME then
      for _, c in ipairs(def.cells or {}) do if cellKind(c) == kind then sum = sum + meUsed(c) end end
    else
      for _, d in ipairs(rsDisks()) do if d.kind == kind then sum = sum + d.used end end
    end
    return sum
  end

  local function storageMethod(fn, chemical)
    return function()
      if not available() then return notConnected(0) end
      if chemical and not chemAddon then
        if isME then return 0 end -- AEApi answers 0 without Applied Mekanistics
        return 0, "ADDON_NOT_LOADED_RS_MEKANISM"
      end
      return fn()
    end
  end
  local KINDS = { Item = "item", Fluid = "fluid", Chemical = "chemical" }
  for label, kind in pairs(KINDS) do
    local chem = kind == "chemical"
    m["getTotal" .. label .. "Storage"] = storageMethod(function() return total(kind) end, chem)
    m["getUsed" .. label .. "Storage"] = storageMethod(function() return used(kind) end, chem)
    m["getAvailable" .. label .. "Storage"] = storageMethod(function() return total(kind) - used(kind) end, chem)
    -- storage buses / external storage: none in a fixture (RS 0.7.62b's total is a TODO that answers 0 anyway)
    m["getTotalExternal" .. label .. "Storage"] = storageMethod(function() return 0 end, chem)
    m["getUsedExternal" .. label .. "Storage"] = storageMethod(function() return 0 end, chem)
    m["getAvailableExternal" .. label .. "Storage"] = storageMethod(function() return 0 end, chem)
  end

  local energy = net.energy or {}
  m.getStoredEnergy = storageMethod(function() return energy.stored or 0 end)
  m.getEnergyCapacity = storageMethod(function() return energy.max or 0 end)
  m.getEnergyUsage = storageMethod(function() return energy.usage or 0 end)
  m.getAverageEnergyInput = storageMethod(function()
    if not isME then return 0 end -- "Not supported for Refined Storage"
    return energy.injection or 0
  end)

  -- ----- moving items and fluids -----

  --- InventoryUtil/FluidUtil.getHandlerFromDirection, then getHandlerFromName: a side that is no side is just no
  --- handler in 0.7.62b (CoordUtil.getDirection answers null).
  local function resolve(arg, kind)
    local lower = arg:lower()
    local ok, direction = pcall(B.direction, lower, def.orientation)
    local name
    if ok then name = (def.adjacent or {})[lower] or (def.adjacent or {})[direction] end
    local target = name and (kind == "fluid" and ctx.tankOf(name) or ctx.inventoryOf(name))
    if target then return target end
    return kind == "fluid" and ctx.tankOf(arg) or ctx.inventoryOf(arg)
  end

  local function transfer(kind, direction)
    return function(filterTable, side)
      if not available() then return notConnected(0) end
      side = B.string(2, side)
      local target = resolve(side, kind)
      if not target then return 0, "INVENTORY_NOT_FOUND" end
      local f, err = parseFilter(tableArg(filterTable), kind)
      if not f then return 0, err end
      if kind == "item" then
        return (direction == "export" and ctx.exportItems or ctx.importItems)(f, target)
      end
      return (direction == "export" and ctx.exportFluids or ctx.importFluids)(f, target)
    end
  end
  m.importItem = transfer("item", "import")
  m.exportItem = transfer("item", "export")
  m.importFluid = transfer("fluid", "import")
  m.exportFluid = transfer("fluid", "export")

  local function chemicalTransfer()
    return function(filterTable, side)
      if not available() then return notConnected(0) end
      if not chemAddon then
        if isME then return nil, "ADDON_NOT_LOADED_APP_MEKANISTICS" end
        return 0, "ADDON_NOT_LOADED_" .. ADDON
      end
      B.string(2, side)
      tableArg(filterTable)
      return 0, "INVENTORY_NOT_FOUND" -- no chemical tanks in a fixture
    end
  end
  m.importChemical = chemicalTransfer()
  m.exportChemical = chemicalTransfer()

  -- ----- patterns -----

  local function genericObject(stack, kind, count)
    return stackObject(stack, kind, count, false)
  end

  local function uuid(n, salt)
    return ("%08x-%04x-4%03x-8%03x-%012x"):format((n * 2654435761) % 4294967296, salt % 65536, n % 4096,
      (n * 7) % 4096, n)
  end

  local function parsePattern(p)
    if isME then
      local inputs = {}
      for _, options in ipairs(p.inputs) do
        local first = options[1]
        inputs[#inputs + 1] = {
          primaryInput = genericObject(first, first.kind, 1),
          -- AEApi puts a Java Stream here, which CC cannot convert: Lua sees nil
          possibleInputs = nil,
          multiplier = first.amount,
          remaining = nil,
        }
      end
      local outputs = {}
      for _, o in ipairs(p.outputs) do outputs[#outputs + 1] = genericObject(o, o.kind, o.amount) end
      return {
        inputs = inputs, outputs = outputs, primaryOutput = outputs[1],
        patternType = p.def.patternType or (p.def.processing and "processing" or "crafting"),
      }
    end
    local outputs = {}
    for _, o in ipairs(p.outputs) do outputs[#outputs + 1] = stackObject(o, o.kind, o.amount) end
    local inputs = {}
    for _, options in ipairs(p.inputs) do
      local group = {}
      for _, s in ipairs(options) do group[#group + 1] = stackObject(s, s.kind, s.amount) end
      inputs[#inputs + 1] = group
    end
    return {
      primaryOutput = outputs[1], outputs = outputs, inputs = inputs,
      patternType = p.def.patternType or (p.def.processing and "PROCESSING" or "CRAFTING"),
      id = p.def.id or uuid(p.index, 0x5a7),
    }
  end

  --- AEApi/RSApi.findPatternFromFilters: the first pattern with inputs and outputs matching both filters (nil = any).
  local function findPattern(inputFilter, outputFilter)
    for _, p in ipairs(patternList()) do
      if #p.inputs > 0 and #p.outputs > 0 then
        local inputMatch, outputMatch = inputFilter == nil, outputFilter == nil
        if inputFilter then
          for _, options in ipairs(p.inputs) do
            for _, s in ipairs(options) do if genericTest(inputFilter, s, s.kind) then inputMatch = true end end
          end
        end
        if outputFilter then
          for _, o in ipairs(p.outputs) do if genericTest(outputFilter, o, o.kind) then outputMatch = true end end
        end
        if inputMatch and outputMatch then return p end
      end
    end
  end

  --- Whether a generic filter names something craftable: a pattern output, or a craftable fixture entry (which
  --- stands for a pattern whose ingredients the fixture does not list).
  local function craftableByFilter(g)
    if findPattern(nil, g) then return true end
    for _, kind in ipairs({ "item", "fluid" }) do
      for _, c in ipairs(craftableKeys(kind)) do if genericTest(g, c, kind) then return true end end
    end
    return false
  end

  m.getPatterns = function(filterTable)
    if not available() then return notConnected(nil) end
    local tbl = optTableArg(filterTable)
    if next(tbl) == nil then
      local out = {}
      for _, p in ipairs(patternList()) do out[#out + 1] = parsePattern(p) end
      return out
    end
    if tbl.input == nil and tbl.output == nil then return nil, "NO_FILTER" end
    local filters = {}
    for _, key in ipairs({ "input", "output" }) do
      if tbl[key] ~= nil then
        if type(tbl[key]) ~= "table" then badField(key, "table", tbl[key]) end
        local g, err = parseGeneric(tbl[key])
        if err and not isME then return nil, err end
        -- the ME bridge keeps only the left side: a filter that failed to parse is no filter at all, an unknown
        -- type is the empty filter that never matches
        filters[key] = g or nil
        if g == nil then filters[key] = false end
      end
    end
    local p = findPattern(filters.input or nil, filters.output or nil)
    if not p then return nil, isME and "NOT_FOUND" or "NO_PATTERN_FOUND" end
    return parsePattern(p)
  end

  -- ----- crafting jobs (BasicCraftJob, AECraftJob, RSCraftJob) -----

  local jobs = {}
  local cpuJob = {} -- ME cpu name -> the job running on it

  local function cpus() return def.cpus or {} end

  local function cpuByName(name)
    if name == "" then return nil end
    for _, cpu in ipairs(cpus()) do if cpu.name == name then return cpu end end
  end

  local function cpuBusy(cpu) return cpu.isBusy == true or cpuJob[cpu.name or ""] ~= nil end

  local function fire(job, isError, message)
    os.queueEvent(EVENT, isError, job.id, message)
    job.debug = message
    job.errorOccurred = isError
  end

  local function requested(job)
    if isME then return genericObject(job.entry, job.kind, job.amount) end
    return stackObject(job.entry, job.kind, job.amount)
  end

  local function cpuObject(cpu, recursive)
    local o = {
      storage = cpu.storage or 0, coProcessors = cpu.coProcessors or 0, isBusy = cpuBusy(cpu),
      name = cpu.name or "Unnamed", selectionMode = cpu.selectionMode or "ANY",
    }
    if not recursive then
      local job = cpuJob[cpu.name or ""]
      if job then
        o.craftingJob = { bridge_id = -1, quantity = job.amount, resource = genericObject(job.entry, job.kind, job.amount) }
      else
        o.craftingJob = cpu.craftingJob
      end
    end
    return o
  end

  local function finish(job, how)
    if job.cpu then cpuJob[job.cpu.name or ""] = nil end
    if how == "done" then
      job.done = true
      job.progress = job.amount
      -- RSCraftJob.jobStateChanged fires JOB_DONE with error = true; both arrive on the bridge's next tick
      core.after(0.05, function() fire(job, not isME, "JOB_DONE") end)
    else
      -- the CPU cancels now; the bridge's job hears of it (jobStateChanged) on a later tick, after the call returned
      job.canceled = true
      core.after(0.05, function() fire(job, false, "JOB_CANCELED") end)
    end
    core.save()
  end

  --- startCalculation, then maybeCraft, then (RS) the task's status: one server tick each.
  local function run(job)
    core.after(0.05, function()
      job.calculationStarted = true
      local can = isME and craftable(job.entry, job.kind)
        or (not isME and job.entry.name and craftable(job.entry, job.kind))
      if not can then
        if isME then job.notSuccessful = true end
        fire(job, true, "NOT_CRAFTABLE")
        return
      end
      fire(job, false, "CALCULATION_STARTED")
      core.after(0.05, function()
        job.planned = true
        if def.craftResult == "MISSING_ITEMS" or def.craftResult == "MISSING_RESOURCES" then
          job.notSuccessful = true
          fire(job, true, "MISSING_ITEMS")
          return
        end
        if isME then
          local cpu = job.cpu
          if cpu and cpuBusy(cpu) then
            job.notSuccessful = true
            fire(job, true, "CPU_BUSY")
            return
          end
          if not cpu then
            if #cpus() == 0 then
              job.notSuccessful = true
              fire(job, true, "NO_CPU_FOUND")
              return
            end
            for _, c in ipairs(cpus()) do
              if not cpuBusy(c) then cpu = c break end
            end
            if not cpu then
              job.notSuccessful = true
              fire(job, true, "NO_SUITABLE_CPU_FOUND")
              return
            end
          end
          job.cpu = cpu
          cpuJob[cpu.name or ""] = job
          job.craftingStarted = true
          job.started = core.nowMs()
          fire(job, false, "CRAFTING_STARTED")
          return
        end
        core.after(0.05, function()
          if job.canceled then return end
          job.task = true
          job.craftingStarted = true
          job.started = core.nowMs()
          fire(job, false, "CRAFTING_STARTED")
        end)
      end)
    end)
  end

  local function jobObject(job)
    local o = {}
    function o.getId() return job.id end
    function o.isDone() return job.done == true end
    function o.isCanceled() return job.canceled == true end
    function o.isCraftingStarted() return job.craftingStarted == true end
    function o.isCalculationStarted() return job.calculationStarted == true end
    function o.isCalculationNotSuccessful() return job.notSuccessful == true end
    function o.hasErrorOccurred() return job.errorOccurred == true end
    function o.getDebugMessage() return job.debug end
    function o.getRequestedItem() return requested(job) end
    local function running() return job.craftingStarted end
    function o.getElapsedTime()
      if not running() then return -1 end
      local ms = core.nowMs() - job.started
      return isME and math.floor(ms * 1000000) or math.floor(ms)
    end
    function o.getTotalItems()
      if not running() then return -1 end
      return isME and job.amount or 1
    end
    function o.getItemProgress()
      if not running() then return isME and -1 or 0 end
      return job.progress or 0
    end
    function o.getEmittedItems()
      if not job.planned then
        if isME then return nil end
        return {}
      end
      if isME then return {} end
      return { requested(job) }
    end
    function o.getUsedItems()
      if isME and not job.planned then return nil end
      return {}
    end
    function o.getMissingItems()
      if isME and not job.planned then return nil end
      return {}
    end
    function o.hasMultiplePaths() return false end
    function o.getFinalOutput()
      if not job.planned then
        if isME then return nil end
        return {}
      end
      if isME then return genericObject(job.entry, job.kind, job.amount) end
      return { requested(job) }
    end
    function o.cancel()
      if isME then
        if not job.cpu then error("java.lang.NullPointerException", 0) end
        if cpuBusy(job.cpu) and cpuJob[job.cpu.name or ""] == job then
          finish(job, "canceled")
          return true
        end
        return false
      end
      if not job.task or job.done or job.canceled then return false end
      finish(job, "canceled")
      return true
    end
    if isME then
      function o.getCraftingCPU()
        if not job.cpu then return nil end
        return cpuObject(job.cpu, true)
      end
      function o.getUsedBytes()
        if not job.planned then return -1 end
        return job.amount
      end
    end
    return o
  end

  local function newJob(entry, kind, amount, cpu)
    core.apCraftJobSeq = (core.apCraftJobSeq or 0) + 1 -- BasicCraftJob.ID_SEQ is shared by every bridge
    local job = { id = core.apCraftJobSeq, entry = entry, kind = kind, amount = amount, cpu = cpu, name = entry.name }
    jobs[#jobs + 1] = job
    run(job)
    return job
  end

  local function craft(kind)
    return function(filterTable, cpuName)
      if not available() then return notConnected(nil) end
      if kind == "chemical" and not chemAddon then
        return nil, "ADDON_NOT_LOADED_" .. (isME and "APP_MEKANISTICS" or "REFINEDSTORAGE_MEKANISM")
      end
      local f, err = parseFilter(tableArg(filterTable), kind)
      if not f then return nil, err end
      if not isME then
        -- RSBridgePeripheral: no empty-filter or stock check; the job finds out on its first tick
        local entry = { name = f.name, nbt = f.nbt }
        return jobObject(newJob(entry, kind, f.count))
      end
      if isEmpty(f) then return nil, "EMPTY_FILTER" end
      cpuName = B.optString(2, cpuName, "")
      local cpu = cpuByName(cpuName)
      if cpuName ~= "" and not cpu then return nil, "CPU_NOT_FOUND_" .. cpuName end
      local entry = findIn(listOf(kind), f)
      if not entry then
        for _, c in ipairs(craftableKeys(kind)) do if test(f, c) then entry = c break end end
      end
      if not entry then
        if kind == "item" then return nil, "NOT_CRAFTABLE" end
        return false, "NOT_CRAFTABLE" -- craftFluid answers false here
      end
      return jobObject(newJob(entry, kind, f.count, cpu))
    end
  end
  m.craftItem = craft("item")
  m.craftFluid = craft("fluid")
  if not isME then m.craftChemical = craft("chemical") end

  local function activeJobs()
    local out = {}
    for _, job in ipairs(jobs) do
      if job.craftingStarted and not job.done and not job.canceled then out[#out + 1] = job end
    end
    return out
  end

  m.getCraftingTasks = function()
    if not available() then return notConnected(nil) end
    local out = {}
    for _, job in ipairs(activeJobs()) do
      local crafted = job.progress or 0
      if isME then
        out[#out + 1] = {
          bridge_id = job.id, quantity = job.amount, resource = genericObject(job.entry, job.kind, job.amount),
          completion = crafted / job.amount, crafted = crafted, id = uuid(job.id, 0xae2),
          cpu = cpuObject(job.cpu, true),
        }
      else
        out[#out + 1] = {
          bridge_id = job.id, id = uuid(job.id, 0x252), quantity = job.amount, crafted = crafted,
          resource = stackObject(job.entry, job.kind, job.amount), completion = 0,
        }
      end
    end
    return out
  end

  m.getCraftingTask = function(id)
    if not available() then return notConnected(nil) end
    id = B.int(1, id)
    for _, job in ipairs(jobs) do
      if job.id == id then return jobObject(job) end
    end
    return nil -- the RS bridge adds StatusConstants.NOT_FOUND itself, an enum CC turns into nil
  end

  m.cancelCraftingTasks = function(filterTable)
    if not available() then return notConnected(0) end
    local g, err = parseGeneric(tableArg(filterTable))
    if err then return 0, err end
    if not g then return 0 end
    local canceled = 0
    for _, job in ipairs(activeJobs()) do
      if genericTest(g, job.entry, job.kind) then
        finish(job, "canceled")
        canceled = canceled + 1
      end
    end
    return canceled
  end

  m.isCraftable = function(filterTable)
    if not available() then return notConnected(false) end
    local g, err = parseGeneric(tableArg(filterTable))
    if err then return false, err end
    if not g then return false end
    if isME and isEmpty(g) then return false, "EMPTY_FILTER" end
    return craftableByFilter(g)
  end

  m.isCrafting = function(filterTable, cpuName)
    if not available() then return notConnected(false) end
    local g, err = parseGeneric(tableArg(filterTable))
    if err then return false, err end
    if not g then return false end
    if isME and isEmpty(g) then return false, "EMPTY_FILTER" end
    local cpu
    if isME then cpu = cpuByName(B.optString(2, cpuName, "")) end
    for _, job in ipairs(activeJobs()) do
      if (not cpu or job.cpu == cpu) and genericTest(g, job.entry, job.kind) then return true end
    end
    return false
  end

  if isME then
    m.getCraftingCPUs = function()
      if not available() then return notConnected(nil) end
      local out = {}
      for _, cpu in ipairs(cpus()) do out[#out + 1] = cpuObject(cpu, false) end
      return out
    end
  end

  -- ----- sim commands and state -----

  self.setters = {
    --- A running job finishes: its output goes into the network and JOB_DONE fires.
    completeCraft = function(name)
      for _, job in ipairs(activeJobs()) do
        if name == nil or job.name == name then
          ctx.addTo(listOf(job.kind), { name = job.entry.name, nbt = job.entry.nbt }, job.amount)
          finish(job, "done")
          return true
        end
      end
      return false
    end,
    setConnected = function(value) net.connected = value end,
  }

  function self.state()
    local list = {}
    for _, job in ipairs(jobs) do
      list[#list + 1] = {
        id = job.id, name = job.name, kind = job.kind, count = job.amount, cpu = job.cpu and job.cpu.name,
        done = job.done == true, canceled = job.canceled == true, started = job.craftingStarted == true,
      }
    end
    return { connected = (not isME) or net.connected, items = net.items, fluids = net.fluids, jobs = list }
  end
end
