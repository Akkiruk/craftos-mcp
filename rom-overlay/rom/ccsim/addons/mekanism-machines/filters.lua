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

  --- A fixture filter: the same fields as the Lua table, `type` required.
  function F.fromFixture(family, t)
    local map = J.toJava(t)
    local f = F.fromMap(family, map)
    if not f then error("ccsim: invalid " .. family:lower() .. " filter of type " .. tostring(t.type), 0) end
    return f
  end

  --- wrapReturnType of an IFilter.
  function F.toLua(f)
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
