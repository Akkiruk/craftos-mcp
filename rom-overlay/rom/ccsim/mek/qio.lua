-- ccsim mek/qio: Mekanism's QIO system and its five computer peripherals.
--
-- Written from Mekanism 10.2.5 source (branch 1.18.x, the code the pack's 10.2.5.465 jar was built from) and
-- checked against that jar. Source files, relative to src/main/java/mekanism/common/:
--   tile/qio/TileEntityQIOComponent, ...DriveArray, ...Dashboard, ...FilterHandler, ...Importer, ...Exporter,
--   ...RedstoneAdapter; content/qio/QIOFrequency, QIODriveData, IQIODriveItem; tier/QIODriveTier;
--   tile/base/TileEntityMekanism; tile/component/TileComponentSecurity, TileComponentUpgrade;
--   integration/computer/* (see mek/java.lua); lib/WildcardMatcher; lib/inventory/Finder, HashedItem.
-- docs/mekanism-qio.md lists every behaviour with its line, and what could not be confirmed.
--
-- The world is a fixture (`world.mekanism`), the clock is the virtual clock: every 50 ms is a server tick, and
-- the machines are caught up tick by tick whenever anything looks (a peripheral call, a state dump).
return function(core, host)
  local J = dofile("/rom/ccsim/mek/java.lua")()
  local N = J.nbt
  local floor = math.floor

  local cfg = core.world.mekanism or {}
  local qcfg = cfg.qio or {}

  local Q = {}
  Q.TYPES = { qioDriveArray = true, qioDashboard = true, qioImporter = true, qioExporter = true, qioRedstoneAdapter = true }

  -- peripheral.getMethods order: CC:Tweaked builds the method table as a java.util.HashMap sized to the method count,
  -- filled in Mekanism's order (the tile's methods sorted by name, then the upgrade and security components').
  -- Worked out from String.hashCode; the same calculation reproduces the measured modem orders.
  Q.METHOD_ORDER = {
    qioDriveArray = { "getDrive", "getDriveStatus", "getOwnerUUID", "getDirection", "getSecurityMode", "getFrequency",
      "getFrequencyItemPercentage", "getFrequencyColor", "incrementFrequencyColor", "setFrequency", "setFrequencyColor",
      "getFrequencyItemCount", "getSlotCount", "getFrequencyItemTypeCapacity", "getFrequencyItemTypePercentage",
      "hasFrequency", "decrementFrequencyColor", "getFrequencyItemCapacity", "getFrequencies", "getFrequencyItemTypeCount",
      "createFrequency", "getOwnerName" },
    qioDashboard = { "getOwnerUUID", "getDirection", "getSecurityMode", "getFrequency", "getCraftingInput",
      "getFrequencyColor", "incrementFrequencyColor", "setFrequency", "setFrequencyColor", "getCraftingOutput",
      "hasFrequency", "decrementFrequencyColor", "getFrequencies", "createFrequency", "getOwnerName" },
    qioImporter = { "getImportWithoutFilter", "getInstalledUpgrades", "getOwnerUUID", "getDirection",
      "getSupportedUpgrades", "getSecurityMode", "getFrequency", "removeFilter", "getFrequencyColor",
      "incrementFrequencyColor", "setImportsWithoutFilter", "setFrequency", "setFrequencyColor", "hasFrequency",
      "decrementFrequencyColor", "getRedstoneMode", "getFilters", "addFilter", "getFrequencies", "setRedstoneMode",
      "createFrequency", "getOwnerName" },
    qioExporter = { "getInstalledUpgrades", "getOwnerUUID", "getDirection", "getSupportedUpgrades", "getSecurityMode",
      "getFrequency", "setExportsWithoutFilter", "removeFilter", "getFrequencyColor", "incrementFrequencyColor",
      "setFrequency", "setFrequencyColor", "hasFrequency", "decrementFrequencyColor", "getExportWithoutFilter",
      "getRedstoneMode", "getFilters", "addFilter", "getFrequencies", "setRedstoneMode", "createFrequency",
      "getOwnerName" },
    qioRedstoneAdapter = { "setTriggerAmount", "getOwnerUUID", "clearTargetItem", "getTriggerAmount", "getDirection",
      "getSecurityMode", "getFrequency", "getTargetItem", "setTargetItem", "getFrequencyColor",
      "incrementFrequencyColor", "setFrequency", "setFrequencyColor", "hasFrequency", "decrementFrequencyColor",
      "getFrequencies", "createFrequency", "getOwnerName" },
  }

  -- QIODriveTier: item count and type limits per drive
  local TIERS = {
    base = { count = 16000, types = 128 },
    hyper_dense = { count = 128000, types = 256 },
    time_dilating = { count = 1048000, types = 1024 },
    supermassive = { count = 16000000000, types = 8192 },
  }
  local DRIVE_SLOTS = 12          -- TileEntityQIODriveArray.DRIVE_SLOTS
  local MAX_DELAY = 10            -- importer/exporter: acts, then waits 10 ticks, so every 11th tick
  local MAX_EJECT_ATTEMPTS = 100  -- TileEntityQIOExporter.EfficientEjector
  local CRAFTING_WINDOWS = 3      -- IQIOCraftingWindowHolder.MAX_CRAFTING_WINDOWS
  local AUTOSAVE_TICKS = 6000     -- MinecraftServer saves every 6000 ticks; drive arrays write their drives then

  -- ===== randomness (Level.random / QIOFrequency's Random), private so programs' math.random is untouched =====

  local seed = tonumber(cfg.seed) or 0
  local rngState = (seed * 69069 + 1) % 2147483648
  local function rand()
    rngState = (rngState * 1103515245 + 12345) % 2147483648
    return rngState / 2147483648
  end

  -- ===== items =====
  -- A type is what Mekanism's HashedItem keys on: item name plus NBT (exact, typed). Items in chests keep the type's
  -- tag in `__qioTag` so a stack that leaves the QIO comes back as the same type.

  local typesByKey = {}
  local knownItems
  if type(cfg.knownItems) == "table" then
    knownItems = {}
    for _, name in ipairs(cfg.knownItems) do knownItems[J.resourceLocation(name) or name] = true end
  end

  local function namespaceOf(name) return name:match("^([^:]+):") or "minecraft" end

  local INTERNAL = { count = true, nbt = true, nbtHash = true, __qioTag = true, slot = true }

  --- The type of a fixture item or chest stack.
  local function typeOf(spec)
    local tag, hash
    if spec.__qioTag then
      tag = spec.__qioTag
    elseif type(spec.nbt) == "table" then
      tag = N.fromFixture(spec.nbt)
    elseif type(spec.nbt) == "string" and spec.nbt:match("^%s*{") then
      tag = N.fromFixture(spec.nbt)
    elseif type(spec.nbt) == "string" then
      hash = spec.nbt -- a CC nbt hash on a chest stack: the full tag is unknown, the hash still tells types apart
    end
    local name = J.resourceLocation(spec.name) or spec.name
    local key = name .. "\1" .. (tag and N.canon(tag) or "-") .. "\1" .. (tag and "" or (hash or ""))
    local existing = typesByKey[key]
    if existing then return existing end
    local tags = {}
    for _, t in ipairs(spec.tags or {}) do tags[#tags + 1] = (tostring(t):gsub("^minecraft:item/", "")) end
    local extra = {}
    for k, v in pairs(spec) do
      if type(k) == "string" and not INTERNAL[k] and k:sub(1, 2) ~= "__" then extra[k] = v end
    end
    extra.name = name
    local ty = {
      key = key, name = name, tag = tag, hash = spec.nbtHash or hash, tags = tags,
      modId = spec.modId or namespaceOf(name), maxCount = spec.maxCount or 64, extra = extra,
    }
    typesByKey[key] = ty
    if knownItems then knownItems[name] = true end
    return ty
  end
  Q.typeOf = typeOf

  local function isKnownItem(rl)
    if rl == "minecraft:air" then return false end
    if knownItems then return knownItems[rl] == true end
    return true
  end

  --- A chest stack of `count` of a type (what the exporter's insertItem leaves in a slot).
  local function chestStack(ty, count)
    local item = {}
    for k, v in pairs(ty.extra) do item[k] = v end
    item.name = ty.name
    item.count = count
    if ty.hash then item.nbt = ty.hash
    elseif ty.tag then item.nbt = host.md5(N.canon(ty.tag)) end
    if ty.tag then item.__qioTag = ty.tag end
    if ty.maxCount ~= 64 then item.maxCount = ty.maxCount end
    return item
  end

  --- ItemStack as CCArgumentWrapper.wrapStack returns it: name, count, and nbt when the tag is not empty.
  local function stackToLua(ty, count)
    if not ty or count <= 0 then return { name = "minecraft:air", count = 0 } end
    local out = { name = ty.name, count = count }
    if ty.tag and not N.isEmptyCompound(ty.tag) then out.nbt = N.toLua(ty.tag) end
    return out
  end

  --- ItemStack.save: { id, Count, tag } (Count is the stack's size: 1 for a QIO type).
  local function savedStackTag(ty)
    local v = { id = { t = "string", v = ty.name }, Count = { t = "byte", v = 1 } }
    if ty.tag then v.tag = ty.tag end
    return { t = "compound", v = v }
  end

  -- ===== WildcardMatcher and Finder =====

  local function wildcard(wc, text)
    wc, text = wc:lower(), text:lower()
    local function match(wi0, ti, continueSearch)
      for wi = wi0, #wc do
        local c = wc:sub(wi, wi)
        local fail = false
        if c == "*" then
          return match(wi + 1, ti, true)
        elseif ti > #text then
          return false
        elseif c == "#" then
          if not text:sub(ti, ti):match("%d") then fail = true end
        elseif c ~= "?" then
          if c ~= text:sub(ti, ti) then fail = true end
        end
        if fail then
          return continueSearch and match(wi0, ti + 1, true)
        end
        ti = ti + 1
      end
      return ti > #text or (#wc > 0 and wc:sub(-1) == "*")
    end
    return match(1, 1, false)
  end
  Q.wildcard = wildcard

  --- ItemHandlerHelper.canItemStacksStack between a filter's stack and a type: same item, both tagged or not, equal tags.
  local function sameStack(name, tag, ty)
    if name ~= ty.name then return false end
    if (tag ~= nil) ~= (ty.tag ~= nil) then return false end
    if tag == nil then
      return ty.hash == nil
    end
    return N.equals(tag, ty.tag)
  end

  --- QIOFilter.getFinder().modifies(stack)
  local function filterMatches(f, ty)
    if f.kind == "item" then
      if f.fuzzy then return f.item == ty.name end -- Finder.item(ItemStack): ItemStack.isSame, NBT ignored
      return sameStack(f.item, f.tag, ty)          -- Finder.strict
    elseif f.kind == "tag" then
      for _, t in ipairs(ty.tags) do if wildcard(f.tagName, t) then return true end end
      return false
    else
      return wildcard(f.modId, ty.modId)
    end
  end

  --- equals(): item filters compare the item and fuzzy mode only (ItemStack.sameItem ignores NBT).
  local function filterEquals(a, b)
    if a.kind ~= b.kind then return false end
    if a.kind == "item" then return a.item == b.item and a.fuzzy == b.fuzzy end
    if a.kind == "tag" then return a.tagName == b.tagName end
    return a.modId == b.modId
  end

  local function filterToLua(f)
    if f.kind == "item" then
      local out = { type = "QIO_ITEMSTACK_FILTER", item = f.item, fuzzy = f.fuzzy }
      if f.tag and not N.isEmptyCompound(f.tag) then out.itemNBT = N.toLua(f.tag) end
      return out
    elseif f.kind == "tag" then
      return { type = "QIO_TAG_FILTER", tag = f.tagName }
    end
    return { type = "QIO_MODID_FILTER", modId = f.modId }
  end

  local FILTER_TYPES = {
    QIO_ITEMSTACK_FILTER = "item", QIO_TAG_FILTER = "tag", QIO_MODID_FILTER = "modid",
    MINER_ITEMSTACK_FILTER = false, MINER_MATERIAL_FILTER = false, MINER_MODID_FILTER = false, MINER_TAG_FILTER = false,
    SORTER_ITEMSTACK_FILTER = false, SORTER_MATERIAL_FILTER = false, SORTER_MODID_FILTER = false,
    SORTER_TAG_FILTER = false, OREDICTIONIFICATOR_ITEM_FILTER = false,
  }

  local function validTag(s)
    if type(s) ~= "string" or s == "" then return nil end
    s = s:lower()
    if s:match("^[a-z0-9/._%-:*#?]+$") then return s end
    return nil
  end

  local function validModId(s)
    if type(s) ~= "string" or s == "" then return nil end
    s = s:lower()
    if s:match("^[a-z0-9_.%-*#?]+$") then return s end
    return nil
  end

  --- CCArgumentWrapper.convertMapToFilter for a QIOFilter parameter; nil when it would be refused.
  local function filterFromJava(map)
    local typeName = J.get(map, "type")
    if type(typeName) ~= "string" or typeName == "" then return nil end
    local kind = FILTER_TYPES[typeName:upper()]
    if not kind then return nil end
    if kind == "item" then
      local name = J.get(map, "item")
      local rl = type(name) == "string" and J.resourceLocation(name)
      if not rl or not isKnownItem(rl) then return nil end
      local tag
      local rawNbt = J.get(map, "itemNBT")
      if rawNbt ~= nil then
        tag = N.fromLuaCompound(rawNbt)
        if not tag then return nil end
      end
      return { kind = "item", item = rl, tag = tag, fuzzy = J.get(map, "fuzzy") == true }
    elseif kind == "tag" then
      local t = validTag(J.get(map, "tag"))
      if not t then return nil end
      return { kind = "tag", tagName = t }
    end
    local m = validModId(J.get(map, "modId"))
    if not m then return nil end
    return { kind = "modid", modId = m }
  end

  local function filterFromFixture(f)
    local kind = FILTER_TYPES[tostring(f.type or ""):upper()]
    if kind == "item" then
      return { kind = "item", item = J.resourceLocation(f.item) or f.item,
        tag = f.itemNBT ~= nil and N.fromFixture(f.itemNBT) or nil, fuzzy = f.fuzzy == true }
    elseif kind == "tag" then
      return { kind = "tag", tagName = tostring(f.tag):lower() }
    elseif kind == "modid" then
      return { kind = "modid", modId = tostring(f.modId):lower() }
    end
    error("ccsim: unknown QIO filter type '" .. tostring(f.type) .. "'", 0)
  end

  -- ===== frequencies =====

  local frequencies = {}  -- every frequency, creation order (FrequencyManager keeps a LinkedHashMap)
  local blocks = {}       -- every QIO block, in the order their block entities tick
  local blocksByName = {}

  local function playerUuid(nameOrUuid)
    if nameOrUuid == nil then return nil, nil end
    local p = core.findPlayer(nameOrUuid)
    if p then return p.uuid, p.name end
    return tostring(nameOrUuid), nil
  end

  local function newFrequency(name, public, ownerUuid)
    local f = {
      name = name, public = public ~= false, owner = ownerUuid, color = "INDIGO", valid = true,
      drives = {},                  -- drive references in driveMap order: { block, slot, drive }
      order = {}, data = {},        -- itemDataMap: keys in insertion order, key -> { type, count, drives }
      totalCount = 0, totalCap = 0, totalTypeCap = 0, typeCount = 0,
      dirty = false, version = 0,
    }
    frequencies[#frequencies + 1] = f
    return f
  end

  local function findFrequency(name, public)
    for _, f in ipairs(frequencies) do
      if f.name == name and (public == nil or f.public == public) then return f end
    end
    return nil
  end

  local function publicFrequency(name) return findFrequency(name, true) end

  local function changed(f)
    f.dirty = true
    f.version = f.version + 1
  end

  local function createTypeData(f, ty)
    local d = { type = ty, count = 0, drives = {} }
    f.data[ty.key] = d
    f.order[#f.order + 1] = ty.key
    f.typeCount = f.typeCount + 1
    return d
  end

  local function removeTypeData(f, key)
    f.data[key] = nil
    for i, k in ipairs(f.order) do
      if k == key then table.remove(f.order, i) break end
    end
    f.typeCount = f.typeCount - 1
  end

  local function containsDrive(list, ref)
    for i, r in ipairs(list) do if r == ref then return i end end
    return nil
  end

  -- QIODriveData.add / remove on a drive's live map
  local function driveAdd(drive, ty, amount)
    local stored = drive.counts[ty.key] or 0
    if drive.itemCount == drive.cap or (stored == 0 and drive.typeCount == drive.typeCap) then return amount end
    local toAdd = math.min(amount, drive.cap - drive.itemCount)
    if stored == 0 then
      drive.order[#drive.order + 1] = ty.key
      drive.typeCount = drive.typeCount + 1
      drive.types[ty.key] = ty
    end
    drive.counts[ty.key] = stored + toAdd
    drive.itemCount = drive.itemCount + toAdd
    return amount - toAdd
  end

  local function driveRemove(drive, ty, amount)
    local stored = drive.counts[ty.key] or 0
    local removed = math.min(amount, stored)
    local remaining = stored - removed
    if remaining > 0 then
      drive.counts[ty.key] = remaining
    elseif stored > 0 then
      drive.counts[ty.key] = nil
      drive.types[ty.key] = nil
      drive.typeCount = drive.typeCount - 1
      for i, k in ipairs(drive.order) do
        if k == ty.key then table.remove(drive.order, i) break end
      end
    end
    drive.itemCount = drive.itemCount - removed
    return removed
  end

  --- QIOFrequency.addItem: returns how many were refused.
  local function frequencyAdd(f, ty, amount)
    if amount <= 0 then return 0 end
    if f.totalCount == f.totalCap or (not f.data[ty.key] and f.typeCount == f.totalTypeCap) then return amount end
    local d = f.data[ty.key] or createTypeData(f, ty)
    local toAdd = amount
    -- drives that already hold the type first, then any other drive (QIOItemTypeData.add)
    for _, ref in ipairs(d.drives) do
      toAdd = driveAdd(ref.drive, ty, toAdd)
      if toAdd == 0 then break end
    end
    if toAdd > 0 then
      for _, ref in ipairs(f.drives) do
        if not containsDrive(d.drives, ref) then
          local before = toAdd
          toAdd = driveAdd(ref.drive, ty, toAdd)
          if toAdd < before then d.drives[#d.drives + 1] = ref end
          if toAdd == 0 then break end
        end
      end
    end
    d.count = d.count + amount - toAdd
    f.totalCount = f.totalCount + amount - toAdd
    changed(f)
    return toAdd
  end

  --- QIOFrequency.removeByType: returns how many were removed.
  local function frequencyRemove(f, ty, amount)
    if f.typeCount == 0 or amount <= 0 then return 0 end
    local d = f.data[ty.key]
    if not d then return 0 end
    local removed = 0
    local i = 1
    while i <= #d.drives do
      local ref = d.drives[i]
      removed = removed + driveRemove(ref.drive, ty, amount - removed)
      if (ref.drive.counts[ty.key] or 0) == 0 then table.remove(d.drives, i) else i = i + 1 end
      if removed == amount then break end
    end
    d.count = d.count - removed
    f.totalCount = f.totalCount - removed
    changed(f)
    if d.count == 0 then removeTypeData(f, ty.key) end
    return removed
  end

  local function stored(f, ty)
    local d = f and f.data[ty.key]
    return d and d.count or 0
  end

  -- ===== drives =====

  local function newDrive(spec)
    local tierName = tostring(spec.tier or "base"):lower():gsub("^qio_drive_", ""):gsub("^mekanism:qio_drive_", "")
    local tier = TIERS[tierName]
    if not tier then error("ccsim: unknown QIO drive tier '" .. tostring(spec.tier) .. "'", 0) end
    local drive = { tier = tierName, cap = tier.count, typeCap = tier.types }
    -- what is written in the drive item's NBT (IQIODriveItem.writeItemMap); the live map is loaded from it
    drive.saved = {}
    for _, item in ipairs(spec.items or {}) do
      local ty = typeOf(item)
      drive.saved[#drive.saved + 1] = { type = ty, count = item.count or 1 }
    end
    local function loadLive()
      drive.order, drive.counts, drive.types, drive.itemCount, drive.typeCount = {}, {}, {}, 0, 0
      for _, e in ipairs(drive.saved) do
        if not drive.counts[e.type.key] then
          drive.order[#drive.order + 1] = e.type.key
          drive.typeCount = drive.typeCount + 1
          drive.types[e.type.key] = e.type
        end
        drive.counts[e.type.key] = e.count -- QIODriveData puts each entry; a repeated type keeps the last count
      end
      for _, k in ipairs(drive.order) do drive.itemCount = drive.itemCount + drive.counts[k] end
    end
    drive.loadLive = loadLive
    loadLive()
    drive.metaCount, drive.metaTypes = drive.itemCount, drive.typeCount
    return drive
  end

  local function saveDrive(drive)
    drive.saved = {}
    for _, k in ipairs(drive.order) do drive.saved[#drive.saved + 1] = { type = drive.types[k], count = drive.counts[k] } end
  end

  local function saveFrequency(f)
    for _, ref in ipairs(f.drives) do saveDrive(ref.drive) end
    f.dirty = false
  end

  --- QIOFrequency.addDrive
  local function addDrive(f, block, slot)
    local drive = block.slots[slot]
    if not drive then return end
    drive.loadLive()
    local ref = { block = block, slot = slot, drive = drive }
    f.totalCap = f.totalCap + drive.cap
    f.totalTypeCap = f.totalTypeCap + drive.typeCap
    f.drives[#f.drives + 1] = ref
    for _, k in ipairs(drive.order) do
      local ty = drive.types[k]
      local d = f.data[k] or createTypeData(f, ty)
      d.count = d.count + drive.counts[k]
      f.totalCount = f.totalCount + drive.counts[k]
      if not containsDrive(d.drives, ref) then d.drives[#d.drives + 1] = ref end
    end
    changed(f)
  end

  --- QIOFrequency.removeDrive(key, true): takes the drive's items out and writes them to the drive.
  local function removeDrive(f, block, slot)
    local index, ref
    for i, r in ipairs(f.drives) do
      if r.block == block and r.slot == slot then index, ref = i, r break end
    end
    if not ref then return end
    for _, k in ipairs(ref.drive.order) do
      local d = f.data[k]
      if d then
        local at = containsDrive(d.drives, ref)
        if at then table.remove(d.drives, at) end
        d.count = d.count - ref.drive.counts[k]
        f.totalCount = f.totalCount - ref.drive.counts[k]
        if #d.drives == 0 or d.count == 0 then removeTypeData(f, k) end
      end
    end
    f.totalCap = f.totalCap - ref.drive.cap
    f.totalTypeCap = f.totalTypeCap - ref.drive.typeCap
    table.remove(f.drives, index)
    saveDrive(ref.drive)
    changed(f)
  end

  --- DriveStatus for one slot (TileEntityQIODriveArray.onUpdateServer)
  local function driveStatus(block, slot)
    local drive = block.slots[slot]
    local f = block.frequency
    local loaded = false
    if f and drive then
      for _, ref in ipairs(f.drives) do if ref.block == block and ref.slot == slot then loaded = true break end end
    end
    if not f or not loaded then return drive and "OFFLINE" or "NONE" end
    if drive.itemCount == drive.cap then return "FULL" end
    if drive.typeCount == drive.typeCap or drive.itemCount >= drive.cap * 0.75 then return "NEAR_FULL" end
    return "READY"
  end

  local function updateStatuses(block)
    for slot = 0, DRIVE_SLOTS - 1 do block.status[slot] = driveStatus(block, slot) end
  end

  -- ===== blocks =====

  local function setBlockFrequency(block, f)
    local old = block.frequency
    if old == f then return end
    if old and block.kind == "qioDriveArray" then
      for slot = 0, DRIVE_SLOTS - 1 do removeDrive(old, block, slot) end
    end
    block.frequency = f
    if f and block.kind == "qioDriveArray" then
      for slot = 0, DRIVE_SLOTS - 1 do addDrive(f, block, slot) end
    end
  end

  local inventories = {} -- inventories that only QIO blocks touch (not attached to the computer)

  local function targetInventory(block)
    if not block.target then return nil end
    return inventories[block.target] or host.findInventory(block.target)
  end

  local function newBlock(def)
    local kind = def.type
    local ownerUuid, ownerName = playerUuid(def.owner)
    local block = {
      name = def.name or def.id, kind = kind, def = def,
      owner = ownerUuid, ownerName = def.ownerName or ownerName,
      security = tostring(def.securityMode or "PUBLIC"):upper(),
      facing = tostring(def.facing or "NORTH"):upper(),
    }
    if kind == "qioDriveArray" then
      block.slots, block.status = {}, {}
      local drives = def.drives or {}
      local list = {}
      if #drives > 0 then
        for i, spec in ipairs(drives) do list[#list + 1] = { slot = spec.slot or (i - 1), spec = spec } end
      else
        for k, spec in pairs(drives) do list[#list + 1] = { slot = tonumber(k), spec = spec } end
      end
      for _, e in ipairs(list) do
        if e.slot == nil or e.slot < 0 or e.slot >= DRIVE_SLOTS then error("ccsim: QIO drive slot out of range (0-11)", 0) end
        block.slots[e.slot] = newDrive(e.spec)
      end
    elseif kind == "qioDashboard" then
      block.windows = {}
      for w = 0, CRAFTING_WINDOWS - 1 do
        local spec = (def.crafting or {})[w + 1] or {}
        local window = { inputs = {}, output = nil }
        for k, item in pairs(spec.inputs or {}) do
          local slot = tonumber(k)
          if #(spec.inputs or {}) > 0 then slot = k - 1 end
          window.inputs[slot] = { type = typeOf(item), count = item.count or 1 }
        end
        if spec.output then window.output = { type = typeOf(spec.output), count = spec.output.count or 1 } end
        block.windows[w] = window
      end
    elseif kind == "qioImporter" or kind == "qioExporter" then
      block.filters = {}
      for _, f in ipairs(def.filters or {}) do
        local filter = filterFromFixture(f)
        local dup = false
        for _, g in ipairs(block.filters) do if filterEquals(g, filter) then dup = true end end
        if not dup then block.filters[#block.filters + 1] = filter end
      end
      if kind == "qioImporter" then
        block.withoutFilter = def.importWithoutFilter ~= false -- importers default to importing everything
      else
        block.withoutFilter = def.exportWithoutFilter == true  -- exporters default to needing a filter
      end
      block.redstone = tostring(def.redstoneMode or "DISABLED"):upper()
      block.powered = def.powered == true
      block.poweredLast = block.powered
      block.speed = math.max(0, math.min(8, tonumber(def.speedUpgrades) or 0))
      block.delay = tonumber(def.delay) or 0
      block.target = def.target
    elseif kind == "qioRedstoneAdapter" then
      if def.targetItem then block.targetType = typeOf(type(def.targetItem) == "string" and { name = def.targetItem } or def.targetItem) end
      block.trigger = tonumber(def.triggerAmount) or 0
    end
    if def.frequency ~= nil then
      local spec = def.frequency
      local name, public = spec, nil
      if type(spec) == "table" then name, public = spec.name, spec.public end
      local f = findFrequency(name, public)
      if not f then f = newFrequency(name, public ~= false, ownerUuid) end
      setBlockFrequency(block, f)
    end
    if kind == "qioDriveArray" then updateStatuses(block) end
    blocks[#blocks + 1] = block
    if block.name then blocksByName[block.name] = block end
    return block
  end

  -- ===== the tick =====

  local transitCount = function(b) return 64 + 32 * b.speed end                  -- 64 to 320 items
  local transitTypes = function(b) return floor(1 + b.speed / 2 + 0.5) end        -- Math.round(1F + speed / 2F): 1 to 5

  local function canFunction(b)
    local mode = b.redstone
    if mode == "DISABLED" then return true end
    if mode == "HIGH" then return b.powered end
    if mode == "LOW" then return not b.powered end
    return b.powered and not b.poweredLast -- PULSE
  end

  --- IItemHandler.insertItem into slot i of a chest-like inventory (InvWrapper); returns how many went in.
  local function insertIntoSlot(items, slot, ty, count)
    local existing = items[slot]
    local limit = math.min(ty.maxCount, 64)
    if existing then
      if typeOf(existing) ~= ty then return 0 end
      local room = math.min(ty.maxCount, 64) - existing.count
      if room <= 0 then return 0 end
      local n = math.min(room, count)
      existing.count = existing.count + n
      return n
    end
    local n = math.min(limit, count)
    if n > 0 then items[slot] = chestStack(ty, n) end
    return n
  end

  --- EfficientEjector.eject
  local function eject(b, f, inv, entries)
    if #entries == 0 then return end
    local chance = math.min(1, MAX_EJECT_ATTEMPTS / #entries)
    local maxTypes, maxCount = transitTypes(b), transitCount(b)
    local removed, removedOrder, amountRemoved = {}, {}, 0
    local items, size = inv.__state(), inv.size()
    for _, e in ipairs(entries) do
      if amountRemoved == maxCount or #removedOrder == maxTypes then break end
      if not (rand() > chance) then
        local want = math.min(maxCount - amountRemoved, math.min(e.count, 2147483647))
        local left = want
        if want > 0 then
          for slot = 1, size do
            left = left - insertIntoSlot(items, slot, e.type, left)
            if left <= 0 then break end
          end
        end
        local used = want - left
        if used > 0 then
          amountRemoved = amountRemoved + used
          if not removed[e.type.key] then removedOrder[#removedOrder + 1] = e.type end
          removed[e.type.key] = (removed[e.type.key] or 0) + used
        end
      end
    end
    for _, ty in ipairs(removedOrder) do frequencyRemove(f, ty, removed[ty.key]) end
  end

  --- TileEntityQIOExporter.getFilterEjectMap
  local function filterEjectMap(b, f)
    local seen, list = {}, {}
    local function put(ty)
      local entry = seen[ty.key]
      if entry then entry.count = stored(f, ty) return end
      entry = { type = ty, count = stored(f, ty) }
      seen[ty.key] = entry
      list[#list + 1] = entry
    end
    for _, filter in ipairs(b.filters) do
      if filter.kind == "item" and filter.fuzzy then
        for _, k in ipairs(f.order) do if f.data[k].type.name == filter.item then put(f.data[k].type) end end
      elseif filter.kind == "item" then
        put(typeOf({ name = filter.item, __qioTag = filter.tag }))
      else
        for _, k in ipairs(f.order) do if filterMatches(filter, f.data[k].type) then put(f.data[k].type) end end
      end
    end
    return list
  end

  local function exportTick(b)
    local f = b.frequency
    local inv = targetInventory(b)
    if not f or not inv then return end
    if not b.withoutFilter and #b.filters == 0 then return end
    local entries
    if #b.filters == 0 then
      entries = {}
      for _, k in ipairs(f.order) do entries[#entries + 1] = { type = f.data[k].type, count = f.data[k].count } end
    else
      entries = filterEjectMap(b, f)
    end
    eject(b, f, inv, entries)
  end

  local function importTick(b)
    local f = b.frequency
    local inv = targetInventory(b)
    if not f or not inv then return end
    if not b.withoutFilter and #b.filters == 0 then return end
    local items = inv.__state()
    local typesAdded, typeCount = {}, 0
    local maxTypes, maxCount, countAdded = transitTypes(b), transitCount(b), 0
    for slot = inv.size(), 1, -1 do
      local item = items[slot]
      local want = maxCount - countAdded
      if item and want > 0 then
        local n = math.min(want, item.count)
        local ty = typeOf(item)
        if typesAdded[ty.key] or typeCount < maxTypes then
          local accepted = b.withoutFilter and #b.filters == 0
          if not accepted then
            for _, filter in ipairs(b.filters) do
              if filterMatches(filter, ty) then accepted = true break end
            end
          end
          if accepted then
            local used = n - frequencyAdd(f, ty, n)
            if used > 0 then
              item.count = item.count - used
              if item.count <= 0 then items[slot] = nil end
            end
            if not typesAdded[ty.key] then typesAdded[ty.key] = true typeCount = typeCount + 1 end
            countAdded = countAdded + used
          end
        end
      end
    end
  end

  local function tickBlock(b, t)
    if b.tick then
      b.tick(t) -- another Mekanism machine (the entangloporter) on the same clock
    elseif b.kind == "qioDriveArray" then
      if t % 10 == 0 then updateStatuses(b) end
    elseif b.kind == "qioImporter" or b.kind == "qioExporter" then
      if canFunction(b) then
        if b.delay > 0 then
          b.delay = b.delay - 1
        else
          if b.kind == "qioExporter" then exportTick(b) else importTick(b) end
          b.delay = MAX_DELAY
        end
      end
      b.poweredLast = b.powered
    end
  end

  local bootMs = core.nowMs()
  local startTick = tonumber(cfg.gameTime) or 0
  local lastTick = startTick - 1 -- every tick up to here has been simulated

  local function currentTick() return startTick + floor((core.nowMs() - bootMs) / 50) end
  Q.currentTick = currentTick

  local function anyMachineMoving()
    for _, b in ipairs(blocks) do
      if b.moving and b.moving() then return true end
      if (b.kind == "qioImporter" or b.kind == "qioExporter") and b.frequency and b.target then
        if b.redstone == "DISABLED" or (b.redstone == "HIGH" and b.powered) or (b.redstone == "LOW" and not b.powered)
            or (b.redstone == "PULSE" and b.powered ~= b.poweredLast) then
          return true
        end
      end
    end
    return false
  end

  local function frequencyTick(t)
    for _, f in ipairs(frequencies) do
      -- QIOFrequency.tick: a changed frequency writes its drives on a random tick, 1 in 100
      if f.dirty and rand() < 0.01 then saveFrequency(f) end
      if t % AUTOSAVE_TICKS == 0 then saveFrequency(f) end
    end
  end

  --- Simulate every tick before `target` (a main-thread task runs at the start of a tick, before block entities).
  function Q.catchUp(target)
    target = target or currentTick()
    local last = target - 1
    if last <= lastTick then return end
    local t = lastTick + 1
    while t <= last do
      if not anyMachineMoving() then
        -- nothing moves items: jump, but keep the drive LEDs, saves and redstone history right
        local from = t
        for _, b in ipairs(blocks) do
          if b.kind == "qioDriveArray" and floor(last / 10) * 10 >= from then updateStatuses(b) end
          if b.poweredLast ~= nil then b.poweredLast = b.powered end
        end
        for _, f in ipairs(frequencies) do
          if f.dirty then
            local u = rand()
            local wait = math.ceil(math.log(1 - u) / math.log(0.99))
            if from + wait - 1 <= last then saveFrequency(f) end
          end
          if floor(last / AUTOSAVE_TICKS) * AUTOSAVE_TICKS >= from then saveFrequency(f) end
        end
        t = last + 1
      else
        for _, b in ipairs(blocks) do tickBlock(b, t) end
        frequencyTick(t)
        t = t + 1
      end
    end
    lastTick = last
  end

  -- ===== computer methods =====

  local VOID = { n = 0 }
  local function ret(v) return { n = 1, v } end

  local function frequencyOf(b)
    local f = b.frequency
    if not f or not f.valid then J.computerError("No frequency is currently selected.") end
    return f
  end

  local function requirePublic(b)
    if b.security ~= "PUBLIC" then
      J.computerError("Setter not available due to machine security not being public.")
    end
  end

  local function frequencyToLua(f) return { key = f.name, public = f.public } end

  local function colorStep(color, step)
    local list = J.ENUMS.EnumColor
    for i, c in ipairs(list) do
      if c == color then return list[(i - 1 + step) % #list + 1] end
    end
    return color
  end

  -- A name is put into the message as it is; a "%" in it then breaks Mekanism's second String.format (J.computerError)
  local function fmt(s) return tostring(s) end

  local COMMON = {
    getFrequencies = { {}, function()
      local out = {}
      for _, f in ipairs(frequencies) do if f.public then out[#out + 1] = frequencyToLua(f) end end
      return ret(out)
    end },
    hasFrequency = { {}, function(b) return ret(b.frequency ~= nil and b.frequency.valid) end },
    getFrequency = { {}, function(b) return ret(frequencyToLua(frequencyOf(b))) end },
    setFrequency = { { "String" }, function(b, name)
      requirePublic(b)
      local f = publicFrequency(name)
      if not f then J.computerError(("No public QIO frequency with name '%s' found."):format(fmt(name))) end
      if b.owner then setBlockFrequency(b, f) end -- setFrequencyFromData does nothing without an owner
      return VOID
    end },
    createFrequency = { { "String" }, function(b, name)
      requirePublic(b)
      if publicFrequency(name) then
        J.computerError(("Unable to create public QIO frequency with name '%s' as one already exists."):format(fmt(name)))
      end
      if b.owner then setBlockFrequency(b, newFrequency(name, true, b.owner)) end
      return VOID
    end },
    getFrequencyColor = { {}, function(b) return ret(frequencyOf(b).color) end },
    setFrequencyColor = { { "EnumColor" }, function(b, color)
      requirePublic(b)
      frequencyOf(b).color = color
      return VOID
    end },
    incrementFrequencyColor = { {}, function(b)
      requirePublic(b)
      local f = frequencyOf(b)
      f.color = colorStep(f.color, 1)
      return VOID
    end },
    decrementFrequencyColor = { {}, function(b)
      requirePublic(b)
      local f = frequencyOf(b)
      f.color = colorStep(f.color, -1)
      return VOID
    end },
    -- TileEntityMekanism
    getDirection = { {}, function(b) return ret(b.facing) end },
    -- TileComponentSecurity
    getOwnerUUID = { {}, function(b) return ret(b.owner) end },
    getOwnerName = { {}, function(b) return ret(b.ownerName) end },
    getSecurityMode = { {}, function(b) return ret(b.security) end },
  }

  local function validateSlot(slot)
    if slot < 0 or slot >= DRIVE_SLOTS then
      J.computerError(("Slot: '%d' is out of bounds, as this QIO drive array only has '%d' drive slots (zero indexed)."):format(slot, DRIVE_SLOTS))
    end
  end

  local function driveStackToLua(drive)
    if not drive then return { name = "minecraft:air", count = 0 } end
    local mek = {}
    if #drive.saved > 0 then
      local list = {}
      for i, e in ipairs(drive.saved) do
        list[i] = { t = "compound", v = { Item = savedStackTag(e.type), amount = { t = "long", v = e.count } } }
      end
      mek.qioItemMap = { t = "list", v = list }
    end
    if drive.itemCount ~= 0 then mek.qioMetaCount = { t = "long", v = drive.itemCount } end
    if drive.typeCount ~= 0 then mek.qioMetaTypes = { t = "int", v = drive.typeCount } end
    local out = { name = "mekanism:qio_drive_" .. drive.tier, count = 1 }
    if next(mek) then out.nbt = N.toLua({ t = "compound", v = { mekData = { t = "compound", v = mek } } }) end
    return out
  end

  local function percentage(a, b)
    if b == 0 then return a == 0 and -(0 / 0) or math.huge end
    return a / b
  end

  local BY_TYPE = {
    qioDriveArray = {
      getSlotCount = { {}, function() return ret(DRIVE_SLOTS) end },
      getDrive = { { "int" }, function(b, slot)
        validateSlot(slot)
        return ret(driveStackToLua(b.slots[slot]))
      end },
      getDriveStatus = { { "int" }, function(b, slot)
        validateSlot(slot)
        return ret(b.status[slot] or "NONE")
      end },
      getFrequencyItemCount = { {}, function(b) return ret(frequencyOf(b).totalCount) end },
      getFrequencyItemCapacity = { {}, function(b) return ret(frequencyOf(b).totalCap) end },
      getFrequencyItemPercentage = { {}, function(b)
        local f = frequencyOf(b)
        return ret(percentage(f.totalCount, f.totalCap))
      end },
      getFrequencyItemTypeCount = { {}, function(b) return ret(frequencyOf(b).typeCount) end },
      getFrequencyItemTypeCapacity = { {}, function(b) return ret(frequencyOf(b).totalTypeCap) end },
      getFrequencyItemTypePercentage = { {}, function(b)
        local f = frequencyOf(b)
        return ret(percentage(f.typeCount, f.totalTypeCap))
      end },
    },
    qioDashboard = {
      getCraftingInput = { { "int", "int" }, function(b, window, slot)
        if window < 0 or window >= CRAFTING_WINDOWS then
          J.computerError(("Window '%d' is out of bounds, must be between 0 and %d."):format(window, CRAFTING_WINDOWS))
        end
        if slot < 0 or slot >= 9 then
          J.computerError(("Slot '%d' is out of bounds, must be between 0 and 9."):format(slot))
        end
        local s = b.windows[window].inputs[slot]
        return ret(stackToLua(s and s.type, s and s.count or 0))
      end },
      getCraftingOutput = { { "int" }, function(b, window)
        if window < 0 or window >= CRAFTING_WINDOWS then
          J.computerError(("Window '%d' is out of bounds, must be between 0 and %d."):format(window, CRAFTING_WINDOWS))
        end
        local s = b.windows[window].output
        return ret(stackToLua(s and s.type, s and s.count or 0))
      end },
    },
    qioRedstoneAdapter = {
      getTargetItem = { {}, function(b) return ret(stackToLua(b.targetType, b.targetType and 1 or 0)) end },
      getTriggerAmount = { {}, function(b) return ret(b.trigger) end },
      clearTargetItem = { {}, function(b)
        requirePublic(b)
        b.targetType = nil
        return VOID
      end },
      setTargetItem = { { "ResourceLocation" }, function(b, rl)
        requirePublic(b)
        if not isKnownItem(rl) then
          J.computerError(("Target item '%s' could not be found. If you are trying to clear it consider using clearTargetItem instead."):format(fmt(rl)))
        end
        b.targetType = typeOf({ name = rl })
        return VOID
      end },
      setTriggerAmount = { { "long" }, function(b, amount)
        requirePublic(b)
        if amount < 0 then
          J.computerError(("Trigger amount cannot be negative. Received: %d"):format(amount))
        end
        b.trigger = amount
        return VOID
      end },
    },
  }

  local FILTER_METHODS = {
    getFilters = { {}, function(b)
      local out = {}
      for i, f in ipairs(b.filters) do out[i] = filterToLua(f) end
      return ret(out)
    end },
    addFilter = { { "QIOFilter" }, function(b, filter)
      requirePublic(b)
      for _, f in ipairs(b.filters) do if filterEquals(f, filter) then return ret(false) end end
      b.filters[#b.filters + 1] = filter
      return ret(true)
    end },
    removeFilter = { { "QIOFilter" }, function(b, filter)
      requirePublic(b)
      for i, f in ipairs(b.filters) do
        if filterEquals(f, filter) then
          table.remove(b.filters, i)
          return ret(true)
        end
      end
      return ret(false)
    end },
    getRedstoneMode = { {}, function(b) return ret(b.redstone) end },
    setRedstoneMode = { { "RedstoneControl" }, function(b, mode)
      requirePublic(b)
      if mode == "PULSE" then J.computerError("Unsupported redstone control mode: PULSE") end
      b.redstone = mode
      return VOID
    end },
    getInstalledUpgrades = { {}, function(b)
      if b.speed > 0 then return ret({ SPEED = b.speed }) end
      return ret({})
    end },
    getSupportedUpgrades = { {}, function() return ret({ "SPEED" }) end },
  }
  BY_TYPE.qioImporter = {
    getImportWithoutFilter = { {}, function(b) return ret(b.withoutFilter) end },
    setImportsWithoutFilter = { { "boolean" }, function(b, v)
      requirePublic(b)
      b.withoutFilter = v
      return VOID
    end },
  }
  BY_TYPE.qioExporter = {
    getExportWithoutFilter = { {}, function(b) return ret(b.withoutFilter) end },
    setExportsWithoutFilter = { { "boolean" }, function(b, v)
      requirePublic(b)
      b.withoutFilter = v
      return VOID
    end },
  }
  for _, kind in ipairs({ "qioImporter", "qioExporter" }) do
    for name, m in pairs(FILTER_METHODS) do BY_TYPE[kind][name] = m end
  end

  local argContext = { filter = filterFromJava, knownItem = isKnownItem }

  --- A Mekanism peripheral over `block` with `table_` (name -> { params, fn }): methods for wrap, plus validate
  --- (computer thread) and run (server thread) for the call path in peripherals.lua.
  function Q.makePeripheral(block, table_, order)
    local p = { block = block, methods = {}, methodOrder = order }
    for name, m in pairs(table_) do
      local params, fn = m[1], m[2]
      p.methods[name] = function(...)
        local args = J.checkArguments(name, params, table.pack(...), argContext)
        Q.catchUp()
        local r = fn(block, table.unpack(args, 1, args.n))
        return table.unpack(r, 1, r.n)
      end
    end
    function p.validate(name, args)
      return J.checkArguments(name, table_[name][1], args, argContext)
    end
    function p.run(name, args)
      Q.catchUp()
      return table_[name][2](block, table.unpack(args, 1, args.n))
    end
    function p.state() return Q.blockState(block) end
    return p
  end

  --- The peripheral for a QIO block in world.peripherals.
  function Q.peripheral(def)
    local block = blocksByName[def.name]
    if not block or block.def ~= def then block = newBlock(def) end
    local table_ = {}
    for name, m in pairs(COMMON) do table_[name] = m end
    for name, m in pairs(BY_TYPE[def.type]) do table_[name] = m end
    return Q.makePeripheral(block, table_, Q.METHOD_ORDER[def.type])
  end

  -- shared with mek/entangloporter.lua
  Q.J, Q.VOID, Q.ret, Q.fmt = J, VOID, ret, fmt
  Q.chestStack, Q.stackToLua, Q.insertIntoSlot, Q.playerUuid = chestStack, stackToLua, insertIntoSlot, playerUuid
  Q.requirePublic = requirePublic
  Q.inventories = inventories
  Q.targetInventory = function(name) return inventories[name] or host.findInventory(name) end
  function Q.addBlock(b)
    blocks[#blocks + 1] = b
    if b.name then blocksByName[b.name] = b end
  end
  function Q.findBlock(name) return blocksByName[name] end

  -- ===== world fixture =====

  for _, spec in ipairs(qcfg.frequencies or {}) do
    local ownerUuid = playerUuid(spec.owner)
    local f = findFrequency(spec.name, spec.public ~= false) or newFrequency(spec.name, spec.public ~= false, ownerUuid)
    if spec.color then f.color = tostring(spec.color):upper() end
  end
  for _, def in ipairs(qcfg.inventories or {}) do
    inventories[def.name] = host.newInventory(def)
  end
  -- QIO blocks the computer cannot see are built now; the computer's own when peripherals.lua registers them,
  -- in world order, so they tick in the order they are listed (blocks first, then peripherals).
  for _, def in ipairs(qcfg.blocks or {}) do
    if not Q.TYPES[def.type] then error("ccsim: unknown QIO block type '" .. tostring(def.type) .. "'", 0) end
    newBlock(def)
  end

  -- ===== state for tests =====

  local function typeToState(ty, count)
    local out = { name = ty.name, count = count }
    if ty.tag then out.nbt = N.toLua(ty.tag) end
    if ty.hash then out.nbtHash = ty.hash end
    return out
  end

  function Q.frequencyState(f)
    local items = {}
    for _, k in ipairs(f.order) do items[#items + 1] = typeToState(f.data[k].type, f.data[k].count) end
    return {
      name = f.name, public = f.public, color = f.color,
      itemCount = f.totalCount, itemCapacity = f.totalCap, typeCount = f.typeCount, typeCapacity = f.totalTypeCap,
      items = items,
    }
  end

  function Q.blockState(b)
    if b.stateFn then return b.stateFn() end
    local out = { type = b.kind, frequency = b.frequency and b.frequency.name or nil }
    if b.kind == "qioDriveArray" then
      out.drives = {}
      for slot = 0, DRIVE_SLOTS - 1 do
        local d = b.slots[slot]
        if d then
          out.drives[tostring(slot)] = { tier = d.tier, itemCount = d.itemCount, typeCount = d.typeCount, status = b.status[slot] }
        end
      end
    elseif b.kind == "qioImporter" or b.kind == "qioExporter" then
      out.redstoneMode, out.powered, out.delay = b.redstone, b.powered, b.delay
      out.withoutFilter = b.withoutFilter
      out.filters = {}
      for i, f in ipairs(b.filters) do out.filters[i] = filterToLua(f) end
    elseif b.kind == "qioRedstoneAdapter" then
      local count = b.targetType and stored(b.frequency, b.targetType) or 0
      out.powering = b.targetType ~= nil and b.frequency ~= nil and count > 0 and count >= b.trigger
      out.redstoneOutput = out.powering and 15 or 0
    end
    return out
  end

  --- For state.json: core.save has already caught the machines up, so this matches the inventories it writes.
  function Q.state()
    local out = { gameTime = lastTick, frequencies = {}, blocks = {}, inventories = {} }
    for _, f in ipairs(frequencies) do out.frequencies[#out.frequencies + 1] = Q.frequencyState(f) end
    for _, b in ipairs(blocks) do
      if b.name then out.blocks[b.name] = Q.blockState(b) end
    end
    for name, inv in pairs(inventories) do
      local slots = {}
      for slot, item in pairs(inv.__state()) do slots[tostring(slot)] = item end
      out.inventories[name] = slots
    end
    return out
  end

  -- ===== host commands =====

  local handlers = {}
  Q.handlers = handlers

  local function blockFor(cmd)
    local b = blocksByName[cmd.block or cmd.peripheral or ""]
    if not b then return nil, "no such QIO block" end
    Q.catchUp() -- what happened up to now happened with the old setting
    return b
  end

  --- Redstone signal into an importer or exporter.
  function handlers.qioSetPowered(cmd)
    local b, err = blockFor(cmd)
    if not b then return false, err end
    b.powered = cmd.powered == true
    return true
  end

  --- Insert (drive spec) or remove (null) a drive, as a player would in the drive array's GUI.
  function handlers.qioSetDrive(cmd)
    local b, err = blockFor(cmd)
    if not b or b.kind ~= "qioDriveArray" then return false, err or "not a drive array" end
    local slot = tonumber(cmd.slot)
    if not slot or slot < 0 or slot >= DRIVE_SLOTS then return false, "slot out of range" end
    if b.frequency then removeDrive(b.frequency, b, slot) end
    b.slots[slot] = cmd.drive and newDrive(cmd.drive) or nil
    if b.frequency and b.slots[slot] then addDrive(b.frequency, b, slot) end
    return true
  end

  function handlers.qioSetSecurity(cmd)
    local b, err = blockFor(cmd)
    if not b then return false, err end
    b.security = tostring(cmd.mode or "PUBLIC"):upper()
    return true
  end

  function handlers.qioSetUpgrades(cmd)
    local b, err = blockFor(cmd)
    if not b or b.speed == nil then return false, err or "no upgrade slot" end
    b.speed = math.max(0, math.min(8, tonumber(cmd.speed) or 0))
    return true
  end

  --- A player puts items in or takes them out through a dashboard or portable item viewer.
  function handlers.qioInsert(cmd)
    Q.catchUp()
    local f = findFrequency(cmd.frequency)
    if not f then return false, "no such frequency" end
    if type(cmd.item) ~= "table" or type(cmd.item.name) ~= "string" then return false, "item needs a name" end
    local refused = frequencyAdd(f, typeOf(cmd.item), cmd.item.count or 1)
    if refused > 0 then return false, refused .. " refused (frequency full)" end
    return true
  end

  function handlers.qioExtract(cmd)
    Q.catchUp()
    local f = findFrequency(cmd.frequency)
    if not f then return false, "no such frequency" end
    if type(cmd.item) ~= "table" or type(cmd.item.name) ~= "string" then return false, "item needs a name" end
    frequencyRemove(f, typeOf(cmd.item), cmd.item.count or 1)
    return true
  end

  return Q
end
