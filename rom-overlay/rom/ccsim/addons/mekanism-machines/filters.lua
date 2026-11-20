-- ccsim addons/mekanism-machines/filters: the filter tables of the digital miner, logistical sorter and
-- oredictionificator, and the FloatingLong / Item arguments (see engine.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/integration/computer/computercraft/CCArgumentWrapper
-- (sanitizeArgument: FloatingLong from a non-negative number or a string, Item from a resource location, filters
-- through convertMapToFilter; wrapReturnType of an IFilter), content/filter/FilterType, BaseFilter (equals: the
-- same type and fields), tile/machine/TileEntityOredictionificator.isValidTarget (config validItemFilters).
-- Items are not checked against a registry: any valid resource location is an item (tryCreateItem gives air for an
-- unknown one in game).
return function(E)
  local J = E.J
  local floor = math.floor

  local F = {}
  local KINDS = {
    MINER_ITEMSTACK_FILTER = "item", MINER_MATERIAL_FILTER = "material", MINER_MODID_FILTER = "modid", MINER_TAG_FILTER = "tag",
    SORTER_ITEMSTACK_FILTER = "item", SORTER_MATERIAL_FILTER = "material", SORTER_MODID_FILTER = "modid", SORTER_TAG_FILTER = "tag",
    OREDICTIONIFICATOR_ITEM_FILTER = "ore",
  }
  local ORE_PREFIXES = { "dusts/", "ingots/", "nuggets/", "ores/", "storage_blocks/" } -- validItemFilters, forge namespace

  local function item(raw)
    if type(raw) ~= "string" then return "minecraft:air" end
    return J.resourceLocation(raw) or "minecraft:air"
  end
  local function bool(raw) return raw == true end
  local function int(raw)
    if type(raw) ~= "number" or raw ~= raw then return 0 end
    return raw >= 0 and floor(raw) or -floor(-raw)
  end
  local function validated(raw, pattern)
    if type(raw) ~= "string" or raw == "" then return nil end
    raw = raw:lower()
    if not raw:match(pattern) then return nil end
    return raw
  end

  --- convertMapToFilter: a filter for `family` ("MINER", "SORTER", "OREDICTIONIFICATOR"), or nil.
  function F.fromMap(family, map)
    local ty = J.get(map, "type")
    if type(ty) ~= "string" then return nil end
    ty = ty:upper()
    local kind = KINDS[ty]
    if not kind or ty:sub(1, #family + 1) ~= family .. "_" then return nil end
    local f = { type = ty, kind = kind }
    if kind == "item" then
      f.item = item(J.get(map, "item"))
      if f.item == "minecraft:air" then return nil end -- itemNBT is not kept
    elseif kind == "material" then
      f.materialItem = item(J.get(map, "materialItem"))
      if f.materialItem == "minecraft:air" then return nil end
    elseif kind == "modid" then
      f.modId = validated(J.get(map, "modId"), "^[a-z0-9_.%-*?]+$")
      if not f.modId then return nil end
    elseif kind == "tag" then
      f.tag = validated(J.get(map, "tag"), "^[a-z0-9_.%-/:*?]+$")
      if not f.tag then return nil end
    end
    if family == "MINER" then
      f.requiresReplacement = bool(J.get(map, "requiresReplacement"))
      f.replaceTarget = item(J.get(map, "replaceTarget"))
    elseif family == "SORTER" then
      f.allowDefault = bool(J.get(map, "allowDefault"))
      local c = J.get(map, "color")
      if type(c) == "string" then
        local u = c:upper()
        for _, x in ipairs(J.ENUMS.EnumColor) do if x == u then f.color = u end end
      end
      f.size = bool(J.get(map, "size"))
      f.min, f.max = int(J.get(map, "min")), int(J.get(map, "max"))
      if f.min < 0 or f.max < 0 or f.min > f.max or f.max > 64 then return nil end
      if kind == "item" then f.fuzzy = bool(J.get(map, "fuzzy")) end
    elseif family == "OREDICTIONIFICATOR" then
      local target = J.get(map, "target")
      if type(target) ~= "string" or target == "" then return nil end
      local rl = J.resourceLocation(target)
      if not rl then return nil end
      local ns, path = rl:match("^([^:]+):(.*)$")
      local ok = false
      if ns == "forge" then for _, p in ipairs(ORE_PREFIXES) do if path:sub(1, #p) == p then ok = true end end end
      if not ok then return nil end
      f.target = rl
      local sel = item(J.get(map, "selected"))
      f.selected = sel ~= "minecraft:air" and sel or nil
    end
    return f
  end

  -- ===== 10.4 / 10.7 (1.20.1, 1.21.1): SpecialConverters.convertMapToFilter =====
  -- No MATERIAL filters; `enabled`; each refusal is a ComputerException. 10.7 names the keys in snake_case
  -- (SerializationConstants: allow_default, requires_replacement, replace_target, modid), allows stacks up to 99
  -- (Item.ABSOLUTE_MAX_STACK_SIZE) and reads `components` where 10.4 reads `itemNBT` (SNBT).
  local V21 = J.V21
  local KEY = {
    allowDefault = V21 and "allow_default" or "allowDefault",
    requiresReplacement = V21 and "requires_replacement" or "requiresReplacement",
    replaceTarget = V21 and "replace_target" or "replaceTarget",
    modId = V21 and "modid" or "modId",
    itemData = V21 and "components" or "itemNBT",
  }
  F.KEY = KEY
  local NEW_KINDS = {
    MINER_ITEMSTACK_FILTER = "item", MINER_MODID_FILTER = "modid", MINER_TAG_FILTER = "tag",
    SORTER_ITEMSTACK_FILTER = "item", SORTER_MODID_FILTER = "modid", SORTER_TAG_FILTER = "tag",
    OREDICTIONIFICATOR_ITEM_FILTER = "ore", QIO_ITEMSTACK_FILTER = false, QIO_MODID_FILTER = false, QIO_TAG_FILTER = false,
  }
  -- validItemFilters: 10.4 "forge", 10.7 "c"; both add raw_materials/
  local NEW_ORE = { ns = V21 and "c" or "forge", "ingots/", "ores/", "dusts/", "nuggets/", "storage_blocks/", "raw_materials/" }
  local MAX_STACK = V21 and 99 or 64
  local function fail(msg) J.computerError(msg) end

  function F.fromMapNew(family, map)
    local ty = J.get(map, "type")
    if type(ty) ~= "string" then fail("Missing 'type' element") end
    local kind = ty ~= "" and NEW_KINDS[ty:upper()]
    if kind == nil then fail("Unknown 'type' value") end
    ty = ty:upper()
    if not kind or ty:sub(1, #family + 1) ~= family .. "_" then
      fail(V21 and "Unexpected format for: type" or "Type is not of an expected format")
    end
    local f = { type = ty, kind = kind, enabled = true }
    local en = J.get(map, "enabled")
    if type(en) == "boolean" then f.enabled = en end
    if kind == "item" then
      f.item = item(J.get(map, "item"))
      if f.item == "minecraft:air" then fail("Invalid or missing item specified for ItemStack filter") end
      local raw = J.get(map, KEY.itemData)
      if type(raw) == "string" then
        if V21 then
          f.itemData = raw
        else
          local tag, msg = J.nbt.parseSnbt(raw)
          if not tag then fail("Invalid SNBT: " .. tostring(msg)) end
          f.itemData = J.nbt.toSnbt(tag)
        end
      end
    elseif kind == "modid" then
      f.modId = validated(J.get(map, KEY.modId), "^[a-z0-9_.%-*?]+$")
      if not f.modId then fail("Invalid or missing modId specified for Mod Id filter") end
    elseif kind == "tag" then
      f.tag = validated(J.get(map, "tag"), "^[a-z0-9_.%-/:*?]+$")
      if not f.tag then fail("Invalid or missing tag specified for Tag filter") end
    end
    if family == "MINER" then
      f.requiresReplacement = bool(J.get(map, KEY.requiresReplacement))
      f.replaceTarget = item(J.get(map, KEY.replaceTarget))
    elseif family == "SORTER" then
      f.allowDefault = bool(J.get(map, KEY.allowDefault))
      local c = J.get(map, "color")
      if type(c) == "string" then
        local u = c:upper()
        for _, x in ipairs(J.ENUMS.EnumColor) do if x == u then f.color = u end end
      end
      f.size = bool(J.get(map, "size"))
      f.min, f.max = int(J.get(map, "min")), int(J.get(map, "max"))
      if f.min < 0 or f.max < 0 or f.min > f.max or f.max > MAX_STACK then
        fail(V21 and "Invalid min/max: 0 <= min <= max <= 99" or "Invalid or min/max: 0 <= min <= max <= 64")
      end
      if kind == "item" then f.fuzzy = bool(J.get(map, "fuzzy")) end
    elseif family == "OREDICTIONIFICATOR" then
      local target = J.get(map, "target")
      if type(target) ~= "string" or target == "" then fail("Missing 'target'") end
      local rl = J.resourceLocation(target)
      local ok = false
      if rl then
        local ns, path = rl:match("^([^:]+):(.*)$")
        if ns == NEW_ORE.ns then for _, p in ipairs(NEW_ORE) do if path:sub(1, #p) == p then ok = true end end end
      end
      if not ok then fail("Invalid 'target'") end
      f.target = rl
      local sel = item(J.get(map, "selected"))
      f.selected = sel ~= "minecraft:air" and sel or nil
    end
    return f
  end

  --- A fixture filter: the same fields as the Lua table, `type` required (10.4+: the version's keys; `enabled`).
  function F.fromFixture(family, t)
    local map = J.toJava(t)
    if J.NEW then
      local ok, f = pcall(F.fromMapNew, family, map)
      if not ok then error("ccsim: invalid " .. family:lower() .. " filter: " .. tostring(f), 0) end
      return f
    end
    local f = F.fromMap(family, map)
    if not f then error("ccsim: invalid " .. family:lower() .. " filter of type " .. tostring(t.type), 0) end
    return f
  end

  --- wrapReturnType of an IFilter.
  function F.toLua(f)
    if J.NEW then
      -- BaseComputerHelper.convertFilterCommon and the per-device convert
      local out = { type = f.type, enabled = f.enabled ~= false }
      if f.kind == "item" then
        out.item = f.item
        if f.itemData then out[KEY.itemData] = f.itemData end
      elseif f.kind == "modid" then out[KEY.modId] = f.modId
      elseif f.kind == "tag" then out.tag = f.tag end
      if f.type:sub(1, 6) == "MINER_" then
        out[KEY.requiresReplacement], out[KEY.replaceTarget] = f.requiresReplacement, f.replaceTarget
      elseif f.type:sub(1, 7) == "SORTER_" then
        out[KEY.allowDefault], out.color, out.size, out.min, out.max, out.fuzzy = f.allowDefault, f.color, f.size, f.min, f.max, f.fuzzy
      elseif f.kind == "ore" then
        out.target, out.selected = f.target, f.selected or "minecraft:air"
      end
      return out
    end
    local out = { type = f.type }
    if f.kind == "item" then out.item = f.item
    elseif f.kind == "material" then out.materialItem = f.materialItem
    elseif f.kind == "modid" then out.modId = f.modId
    elseif f.kind == "tag" then out.tag = f.tag end
    if f.type:sub(1, 6) == "MINER_" then
      out.requiresReplacement, out.replaceTarget = f.requiresReplacement, f.replaceTarget
    elseif f.type:sub(1, 7) == "SORTER_" then
      out.allowDefault, out.color, out.size, out.min, out.max, out.fuzzy = f.allowDefault, f.color, f.size, f.min, f.max, f.fuzzy
    elseif f.kind == "ore" then
      out.target, out.selected = f.target, f.selected or "minecraft:air"
    end
    return out
  end

  function F.equals(a, b)
    for _, k in ipairs({ "type", "item", "materialItem", "modId", "tag", "requiresReplacement", "replaceTarget", "allowDefault",
      "color", "size", "min", "max", "fuzzy", "target", "selected" }) do
      if a[k] ~= b[k] then return false end
    end
    if J.NEW and (a.enabled ~= false) ~= (b.enabled ~= false) then return false end -- 10.4+ BaseFilter.equals
    return true
  end

  --- HashList.add / remove: no duplicates.
  function F.add(list, f)
    for _, x in ipairs(list) do if F.equals(x, f) then return false end end
    list[#list + 1] = f
    return true
  end
  function F.remove(list, f)
    for i, x in ipairs(list) do if F.equals(x, f) then table.remove(list, i) return true end end
    return false
  end
  function F.list(list)
    local out = {}
    for i, f in ipairs(list) do out[i] = F.toLua(f) end
    return out
  end

  -- argument converters (engine.lua's argContext.convert)
  E.convert = E.convert or {}
  E.convert.MinerFilter = function(v) return J.isMap(v) and F.fromMap("MINER", v) or nil end
  E.convert.SorterFilter = function(v) return J.isMap(v) and F.fromMap("SORTER", v) or nil end
  E.convert.OredictionificatorItemFilter = function(v) return J.isMap(v) and F.fromMap("OREDICTIONIFICATOR", v) or nil end
  if J.NEW then
    E.convert.MinerFilter = function(v) return F.fromMapNew("MINER", v) end
    E.convert.SorterFilter = function(v) return F.fromMapNew("SORTER", v) end
    E.convert.OredictionificatorItemFilter = function(v) return F.fromMapNew("OREDICTIONIFICATOR", v) end
  end
  E.convert.Item = function(v)
    if type(v) ~= "string" then return nil end
    return J.resourceLocation(v) and item(v) or nil
  end
  E.convert.FloatingLong = function(v)
    if type(v) == "number" then
      if v == v and v >= 0 and v <= 1.8446744073709552e19 and v ~= math.huge then return E.FL.create(v) end
      return nil
    end
    if type(v) == "string" then
      local n = tonumber(v)
      if n and n >= 0 and v:match("^%s*[%d.]+%s*$") then return E.FL.create(n) end
    end
    return nil
  end

  E.filters = F
  return F
end
