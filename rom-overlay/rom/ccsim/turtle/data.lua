-- ccsim turtle data: what the game knows about blocks and items, read from the files tools/turtledata/extract.py
-- generates from the real game jars (vanilla 1.18.2, Forge and every mod in the pack). Each namespace is its own
-- file and is only loaded when something from it turns up.
--
-- Each Minecraft version has its own set: 1.18.2's in /rom/ccsim/turtle/data/, any other in its <mc>/ folder there
-- (core.version.blockData, from packages/runner/src/versions.ts). A version without a set of its own (1.21.1 so
-- far) falls back to 1.18.2's.
--
-- A world can add to or override any of it in world.gameData: { names, blocks, items, loot, blockTags, itemTags,
-- recipes, maxCount, fuel, hardness } (see docs/turtle.md).
return function(extra, dir)
  local M = {}
  local DIR = "/rom/ccsim/turtle/data/"
  if type(dir) == "string" and dir ~= DIR and fs.exists(dir .. "minecraft.lua") then DIR = dir end
  M.dir = DIR
  local loaded = {}
  extra = extra or {}

  local function load(ns)
    local d = loaded[ns]
    if d then return d end
    local path = DIR .. ns .. ".lua"
    d = false
    if fs.exists(path) then
      local fn = loadfile(path, "t", {})
      if fn then
        local ok, value = pcall(fn)
        if ok and type(value) == "table" then d = value end
      end
    end
    d = d or {}
    for _, s in ipairs({ "names", "blocks", "defaults", "items", "loot", "blockTags", "itemTags", "mapColours" }) do
      d[s] = d[s] or {}
    end
    loaded[ns] = d
    return d
  end

  local function nsOf(id) return (tostring(id):match("^([^:]+):")) or "minecraft" end

  local function section(name, id)
    local over = extra[name]
    if over and over[id] ~= nil then return over[id] end
    return load(nsOf(id))[name][id]
  end

  --- "minecraft:stone" for "stone"; ids are always namespaced in game data
  function M.id(id)
    id = tostring(id)
    if not id:find(":", 1, true) then return "minecraft:" .. id end
    return id
  end

  function M.displayName(id)
    local name = section("names", id)
    if name then return name end
    -- an unknown id reads the way an untranslated key does: its path, title-cased, is a fair stand-in
    local path = tostring(id):match(":(.+)$") or tostring(id)
    return (path:gsub("_", " "):gsub("(%a)([%w]*)", function(a, b) return a:upper() .. b end))
  end

  function M.isBlock(id) return section("blocks", id) ~= nil end
  function M.isItem(id) return section("items", id) ~= nil end
  --- The block's state properties and the values each can take, or nil for an unknown block.
  function M.blockProperties(id) return section("blocks", id) end
  --- The block's default state (vanilla: from the game's own block report), or nil when not known.
  function M.defaultState(id) return section("defaults", id) end

  function M.lootTable(id)
    id = tostring(id):gsub("^([^:]+):blocks/", "%1:")
    return section("loot", id)
  end

  -- Tags never change after load, and the living world asks for them on every fluid tick: work each list out once
  local tagCache, tagSets = { blockTags = {}, itemTags = {} }, { blockTags = {}, itemTags = {} }
  local function tagsOf(kind, id)
    local hit = tagCache[kind][id]
    if hit then return hit end
    local list = {}
    local seen = {}
    local over = extra[kind] and extra[kind][id]
    for _, t in ipairs(over or {}) do if not seen[t] then seen[t] = true list[#list + 1] = t end end
    if not over or extra[kind .. "Replace"] then
      for _, t in ipairs(load(nsOf(id))[kind][id] or {}) do if not seen[t] then seen[t] = true list[#list + 1] = t end end
    end
    table.sort(list)
    tagCache[kind][id] = list
    return list
  end
  local function hasTag(kind, id, tag)
    local set = tagSets[kind][id]
    if not set then
      set = {}
      for _, t in ipairs(tagsOf(kind, id)) do set[t] = true end
      tagSets[kind][id] = set
    end
    return set[tag] == true
  end

  function M.blockTags(id) return tagsOf("blockTags", id) end
  function M.itemTags(id) return tagsOf("itemTags", id) end

  function M.blockHasTag(id, tag)
    tag = M.id((tostring(tag):gsub("^#", "")))
    return hasTag("blockTags", id, tag)
  end

  function M.itemHasTag(id, tag)
    tag = M.id((tostring(tag):gsub("^#", "")))
    return hasTag("itemTags", id, tag)
  end

  --- The block's map colour (MapColor.col, RGB) in this state, as CC:Tweaked 1.121.0's details give it: nil when it
  --- has none (MapColor.NONE) or the data set does not know (only sets read from the server's code have them).
  --- world.gameData.mapColours can give or override one: id -> colour, or false for none.
  function M.mapColour(id, state)
    local entry = section("mapColours", id)
    if entry == nil or entry == false then return nil end
    if type(entry) == "table" then
      local defaults = M.defaultState(id) or {}
      local key = {}
      for i, prop in ipairs(entry.by or {}) do
        local v = state and state[prop]
        if v == nil then v = defaults[prop] end
        key[i] = tostring(v)
      end
      entry = (entry.values or {})[table.concat(key, ",")] or entry.default
    end
    if type(entry) ~= "number" or entry == 0 then return nil end
    return entry
  end

  local compostables
  --- ComposterBlock.COMPOSTABLES: the chance one item raises a composter's level, or nil when it cannot be composted.
  function M.compostChance(id)
    if not compostables then
      local fn = loadfile(DIR .. "_compostables.lua", "t", {})
      compostables = fn and fn().compostables or {}
      for k, v in pairs(extra.compostables or {}) do compostables[k] = v ~= false and v or nil end
    end
    return compostables[id]
  end

  local tagMembers, recipes
  function M.tagMembers(tag)
    tag = M.id((tostring(tag):gsub("^#", "")))
    if not tagMembers then
      local fn = loadfile(DIR .. "_tag_members.lua", "t", {})
      tagMembers = fn and fn().items or {}
      for id, tags in pairs(extra.itemTags or {}) do
        for _, t in ipairs(tags) do
          local list = tagMembers[t] or {}
          tagMembers[t] = list
          local has = false
          for _, m in ipairs(list) do if m == id then has = true end end
          if not has then list[#list + 1] = id end
        end
      end
    end
    return tagMembers[tag] or {}
  end

  --- Every crafting recipe, id -> { type = "shaped"|"shapeless", ... }. Loaded on the first craft.
  function M.recipes()
    if not recipes then
      local fn = loadfile(DIR .. "_recipes.lua", "t", {})
      recipes = fn and fn().recipes or {}
      for id, r in pairs(extra.recipes or {}) do recipes[id] = r ~= false and r or nil end
    end
    return recipes
  end

  return M
end
