-- UnlimitedPeripheralWorks' item and block queries (Tweakium 1.4.10, PeripheralPluginUtils.itemQueryToPredicate and
-- blockQueryToPredicate), as predicates over the sim's items ({ name, count, nbt?, displayName?, tags? }) and blocks
-- ({ name, state }). A query is a name, or a table whose keys combine with AND:
--   or/or_/owo/any, and/and_/uwu/all, none/nuwu, not/no/not_/negate/nawu: sub-queries
--   name/namae, tag/taguru: a string, or { in = {...} } / { not_in = {...} }; displayName/tekisuto; nbt/nebeturu (items)
-- Keys the query does not know are ignored. Lua tables reach Java as maps, so the order the keys are walked in only
-- decides which error a query with two bad parts raises.
return function(core, C, gameData)
  local Q = {}

  local OR = { ["or"] = true, or_ = true, owo = true, any = true }
  local AND = { ["and"] = true, and_ = true, uwu = true, all = true }
  local NOT = { ["not"] = true, no = true, not_ = true, negate = true, nawu = true }
  local NONE = { none = true, nuwu = true }
  local NAME = { name = true, namae = true }
  local DISPLAY = { displayName = true, tekisuto = true }
  local TAG = { tag = true, taguru = true }
  local IN = { ["in"] = true, in_ = true, naibu = true }
  local NOT_IN = { not_in = true, wanai = true }
  local NBT = { nbt = true, nebeturu = true }

  local function always() return true end
  local function both(a, b) return function(x) return a(x) and b(x) end end
  local function either(a, b) return function(x) return a(x) or b(x) end end
  local function negate(a) return function(x) return not a(x) end end

  --- Map.values of a Lua table, as Java sees it: every value, any key
  local function values(t)
    local out = {}
    for _, v in pairs(t) do out[#out + 1] = v end
    return out
  end

  --- the Kotlin `reduce`: an empty list throws
  local function reduce(list, op)
    if #list == 0 then C.java("java.lang.UnsupportedOperationException", "Empty collection can't be reduced.") end
    local acc = list[1]
    for i = 2, #list do acc = op(acc, list[i]) end
    return acc
  end

  --- what `toString()` gives a Lua value that reached Java (numbers are Doubles)
  local function javaString(v)
    if type(v) == "number" then
      if v == math.floor(v) and math.abs(v) < 1e7 then return ("%d.0"):format(v) end
      return tostring(v)
    end
    if type(v) == "boolean" then return tostring(v) end
    if type(v) == "table" then return "{...}" end
    return tostring(v)
  end
  Q.javaString = javaString

  -- ===== registries =====

  --- PlatformRegistries.ITEMS.get(ResourceLocation(name)) is not air. Vanilla ids are checked against the version's
  --- item list; another mod's ids cannot be, so they count as real.
  local function itemExists(name)
    local id = C.resourceLocation(name)
    if id == "minecraft:air" then return false end
    if id:sub(1, 10) == "minecraft:" then return gameData.isItem(id) end
    return true
  end
  Q.itemExists = itemExists

  local function blockExists(name)
    local id = C.resourceLocation(name)
    if id == "minecraft:air" then return false end
    if id:sub(1, 10) == "minecraft:" then return gameData.isBlock(id) end
    return true
  end
  Q.blockExists = blockExists

  -- ===== what a predicate looks at =====

  function Q.itemTags(item)
    if type(item.tags) == "table" then
      local out = {}
      for k, v in pairs(item.tags) do
        if type(k) == "string" and v then out[#out + 1] = k elseif type(v) == "string" then out[#out + 1] = v end
      end
      return out
    end
    return gameData.itemTags(item.name)
  end

  function Q.itemDisplayName(item)
    return item.displayName or gameData.displayName(item.name)
  end

  function Q.itemHasTag(item, tag)
    for _, t in ipairs(Q.itemTags(item)) do if t == tag then return true end end
    return false
  end

  -- ===== the query builders =====

  --- `(value as Map<*, *>)` on a value that is not a table (JDK 17's message)
  local function notAMap(x)
    local class = type(x) == "number" and "java.lang.Double" or type(x) == "boolean" and "java.lang.Boolean" or "java.lang.String"
    C.java("java.lang.ClassCastException", ("class %s cannot be cast to class java.util.Map (%s and java.util.Map are in module java.base of loader 'bootstrap')"):format(class, class))
  end

  local function buildAll(query, kind)
    local build
    local function orP(v)
      if type(v) ~= "table" then error("Or predicate should contain table with another predicate maps", 0) end
      local ps = {}
      for _, x in ipairs(values(v)) do if type(x) == "table" then ps[#ps + 1] = build(x) end end
      return reduce(ps, either)
    end
    local function andP(v)
      if type(v) ~= "table" then error("And predicate should contain table with another predicate maps", 0) end
      local ps = {}
      for _, x in ipairs(values(v)) do if type(x) == "table" then ps[#ps + 1] = build(x) end end
      return reduce(ps, both)
    end
    local function noneP(v)
      if type(v) ~= "table" then error("And predicate should contain table with another predicate maps", 0) end
      local ps = {}
      for _, x in ipairs(values(v)) do if type(x) == "table" then ps[#ps + 1] = negate(build(x)) end end
      return reduce(ps, both)
    end
    local function notP(v)
      if type(v) ~= "table" then error("And predicate should contain table with another predicate maps", 0) end
      return negate(build(v))
    end
    local function valueP(v, simple, list)
      if type(v) == "string" then return simple(v) end
      if type(v) == "table" then
        for k, x in pairs(v) do
          if IN[k] then
            if type(x) ~= "table" then notAMap(x) end
            local set = {}
            for _, s in ipairs(values(x)) do set[#set + 1] = javaString(s) end
            return list(set)
          elseif NOT_IN[k] then
            if type(x) ~= "table" then notAMap(x) end
            local set = {}
            for _, s in ipairs(values(x)) do set[#set + 1] = javaString(s) end
            return negate(list(set))
          end
        end
        error("in or not_in instructions should be in the table", 0)
      end
      error("Unsupported argument for filter", 0)
    end

    local name, nameIn, tagP, tagIn, displayP
    if kind == "item" then
      name = function(n)
        if not itemExists(n) then error("There is no item " .. n, 0) end
        local id = C.resourceLocation(n)
        return function(it) return it.name == id end
      end
      nameIn = function(names)
        local set, any = {}, false
        for _, n in ipairs(names) do
          if itemExists(n) then set[C.resourceLocation(n)] = true any = true end
        end
        if not any then error("Zero valid items for filtering by name", 0) end
        return function(it) return set[it.name] == true end
      end
      tagP = function(t) return function(it) return Q.itemHasTag(it, t) end end
      tagIn = function(ts)
        return function(it)
          for _, t in ipairs(ts) do if Q.itemHasTag(it, t) then return true end end
          return false
        end
      end
      displayP = function(d) return function(it) return Q.itemDisplayName(it) == d end end
    else
      name = function(n)
        if not blockExists(n) then error("There is no item " .. n, 0) end
        local id = C.resourceLocation(n)
        return function(b) return b.name == id end
      end
      nameIn = function(names)
        local set, any = {}, false
        for _, n in ipairs(names) do
          if blockExists(n) then set[C.resourceLocation(n)] = true any = true end
        end
        if not any then error("Zero valid items for filtering by name", 0) end
        return function(b) return set[b.name] == true end
      end
      local function hasTag(b, t)
        if b.name == "minecraft:air" then return false end
        return gameData.blockHasTag(b.name, t)
      end
      tagP = function(t) return function(b) return hasTag(b, t) end end
      tagIn = function(ts)
        return function(b)
          for _, t in ipairs(ts) do if hasTag(b, t) then return true end end
          return false
        end
      end
      -- the block's descriptionId ("block.minecraft.stone"), not its display name
      displayP = function(d)
        return function(b)
          local ns, path = b.name:match("^([^:]+):(.+)$")
          return ("block." .. ns .. "." .. path:gsub("/", ".")) == d
        end
      end
    end

    -- ITEM_OPERATION_CONFIGURATION / BLOCK_OPERATION_CONFIGURATION, in their order for each key
    local steps = {
      { OR, orP }, { AND, andP }, { NONE, noneP }, { NOT, notP },
      { NAME, function(v) return valueP(v, name, nameIn) end },
      { TAG, function(v) return valueP(v, tagP, tagIn) end },
      { DISPLAY, function(v) return displayP(javaString(v)) end },
    }
    if kind == "item" then
      steps[#steps + 1] = { NBT, function(v)
        local want = javaString(v)
        return function(it) return it.nbt == want end
      end }
    end

    build = function(q)
      if q == nil then return always end
      if type(q) == "string" then return name(q) end
      if type(q) == "table" then
        local acc = always
        for k, v in pairs(q) do
          for _, step in ipairs(steps) do
            if step[1][k] and v ~= nil then acc = both(acc, step[2](v)) end
          end
        end
        return acc
      end
      error(kind == "item" and "Item query should be string or table" or "Block query should be string or table", 0)
    end
    return build(query)
  end

  function Q.item(query) return buildAll(query, "item") end
  function Q.block(query) return buildAll(query, "block") end

  return Q
end
