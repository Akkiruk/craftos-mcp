-- ccsim turtle loot: evaluates real Minecraft 1.18.2 block loot tables (LootTable, LootPool, the vanilla
-- LootItemCondition and LootItemFunction types), so a dug block drops what the game drops: stone gives cobblestone,
-- glass nothing, a double slab two slabs, an ore its raw item.
--
-- The context is what Block.getDrops builds for a block broken by a turtle: the block state, its block entity, the
-- tool the turtle swings, no explosion, and luck 0.
return function(data)
  local M = {}
  local floor, random = math.floor, math.random

  local function number(n, ctx)
    if type(n) == "number" then return n end
    if type(n) ~= "table" then return 0 end
    local kind = n.type or (n.min ~= nil and "minecraft:uniform") or (n.n ~= nil and "minecraft:binomial") or "minecraft:constant"
    if kind == "minecraft:constant" then return number(n.value, ctx)
    elseif kind == "minecraft:uniform" then
      local lo, hi = number(n.min, ctx), number(n.max, ctx)
      return lo + random() * (hi - lo)
    elseif kind == "minecraft:binomial" then
      local trials, p, hits = floor(number(n.n, ctx)), number(n.p, ctx), 0
      for _ = 1, trials do if random() < p then hits = hits + 1 end end
      return hits
    end
    return 0
  end
  -- IntRange / NumberProvider.getInt: uniform ints include both ends
  local function int(n, ctx)
    if type(n) == "table" and (n.type == "minecraft:uniform" or (n.type == nil and n.min ~= nil)) then
      local lo, hi = floor(number(n.min, ctx) + 0.5), floor(number(n.max, ctx) + 0.5)
      if hi < lo then return lo end
      return random(lo, hi)
    end
    return floor(number(n, ctx) + 0.5)
  end

  local function enchantLevel(ctx, id)
    local ench = ctx.tool and ctx.tool.enchantments
    if type(ench) ~= "table" then return 0 end
    for _, e in ipairs(ench) do
      if e.name == id or e.id == id then return tonumber(e.level) or 1 end
    end
    return 0
  end

  local function inRange(value, range)
    if range == nil then return true end
    if type(range) == "number" then return value == range end
    if range.min and value < range.min then return false end
    if range.max and value > range.max then return false end
    return true
  end

  local function itemMatches(item, predicate)
    if type(predicate) ~= "table" then return true end
    if not item then return false end
    if predicate.items then
      local found = false
      for _, id in ipairs(predicate.items) do if id == item.name then found = true end end
      if not found then return false end
    end
    if predicate.item and predicate.item ~= item.name then return false end
    if predicate.tag and not data.itemHasTag(item.name, predicate.tag) then return false end
    for _, want in ipairs(predicate.enchantments or {}) do
      local level = enchantLevel({ tool = item }, want.enchantment)
      if level <= 0 or not inRange(level, want.levels) then return false end
    end
    if predicate.count and not inRange(item.count or 1, predicate.count) then return false end
    return true
  end

  local function stateMatches(state, props)
    for k, want in pairs(props or {}) do
      local have = state and state[k]
      if type(want) == "table" then
        local n = tonumber(have)
        if n == nil then return false end
        if want.min and n < tonumber(want.min) then return false end
        if want.max and n > tonumber(want.max) then return false end
      elseif tostring(have) ~= tostring(want) then
        return false
      end
    end
    return true
  end

  local condition

  local function allConditions(list, ctx)
    for _, c in ipairs(list or {}) do
      if not condition(c, ctx) then return false end
    end
    return true
  end

  function condition(c, ctx)
    local kind = c.condition
    if kind == "minecraft:survives_explosion" then return true -- nothing exploded
    elseif kind == "minecraft:inverted" then return not condition(c.term, ctx)
    elseif kind == "minecraft:alternative" or kind == "minecraft:any_of" then
      for _, t in ipairs(c.terms or {}) do if condition(t, ctx) then return true end end
      return false
    elseif kind == "minecraft:all_of" then return allConditions(c.terms, ctx)
    elseif kind == "minecraft:match_tool" then return itemMatches(ctx.tool, c.predicate)
    elseif kind == "minecraft:block_state_property" then
      if c.block and c.block ~= ctx.block.name then return false end
      return stateMatches(ctx.block.state, c.properties)
    elseif kind == "minecraft:table_bonus" then
      local chances = c.chances or {}
      local level = enchantLevel(ctx, c.enchantment)
      local chance = chances[math.min(level + 1, #chances)] or 0
      return random() < chance
    elseif kind == "minecraft:random_chance" then return random() < (c.chance or 0)
    elseif kind == "minecraft:random_chance_with_looting" then return random() < (c.chance or 0) -- looting 0
    elseif kind == "minecraft:location_check" then
      local p = c.predicate or {}
      if not p.block then return true end
      local o = { x = c.offsetX or 0, y = c.offsetY or 0, z = c.offsetZ or 0 }
      local other = ctx.blockAt and ctx.blockAt(o.x, o.y, o.z)
      if not other then return false end
      if p.block.blocks then
        local found = false
        for _, id in ipairs(p.block.blocks) do if id == other.name then found = true end end
        if not found then return false end
      end
      if p.block.tag and not data.blockHasTag(other.name, p.block.tag) then return false end
      return stateMatches(other.state, p.block.state)
    elseif kind == "minecraft:entity_properties" then
      -- the breaker is the turtle's fake player: not sneaking, not on fire, no effects
      local p = c.predicate
      return type(p) ~= "table" or next(p) == nil
    elseif kind == "minecraft:killed_by_player" then return false
    elseif kind == "minecraft:reference" then return false
    elseif kind == "minecraft:weather_check" then
      if c.raining ~= nil and c.raining ~= false then return false end
      if c.thundering ~= nil and c.thundering ~= false then return false end
      return true
    elseif kind == "minecraft:value_check" then return inRange(int(c.value, ctx), c.range)
    elseif kind == "minecraft:time_check" then return true
    -- CC:Tweaked's computer and turtle drops (BlockNamedEntityLootCondition, HasComputerIdLootCondition,
    -- PlayerCreativeLootCondition): a turtle is never a creative player
    elseif kind == "computercraft:block_named" then
      local be = ctx.block.blockEntity
      return be ~= nil and be.CustomName ~= nil
    elseif kind == "computercraft:has_id" then
      local be = ctx.block.blockEntity
      return be ~= nil and be.ComputerId ~= nil
    elseif kind == "computercraft:player_creative" then return false
    elseif kind == "forge:can_tool_perform_action" then
      return ctx.toolActions and ctx.toolActions[c.action] == true or false
    end
    return false -- an unknown modded condition: the conservative answer is "does not apply"
  end

  local function setNbtFromTable(stack, key, value)
    stack.__nbt = stack.__nbt or {}
    -- an NBT path ("BlockEntityTag.Items") is nested compounds
    local at = stack.__nbt
    local parts = {}
    for part in tostring(key):gmatch("[^%.]+") do parts[#parts + 1] = part end
    for i = 1, #parts - 1 do
      if type(at[parts[i]]) ~= "table" then at[parts[i]] = {} end
      at = at[parts[i]]
    end
    at[parts[#parts]] = value
  end

  local function apply(fn, stack, ctx)
    if not allConditions(fn.conditions, ctx) then return stack end
    local kind = fn["function"]
    if kind == "minecraft:set_count" then
      local n = int(fn.count, ctx)
      stack.count = fn.add and stack.count + n or n
    elseif kind == "minecraft:limit_count" then
      local limit = fn.limit
      if type(limit) == "number" then stack.count = math.min(stack.count, limit)
      elseif type(limit) == "table" then
        if limit.min then stack.count = math.max(stack.count, int(limit.min, ctx)) end
        if limit.max then stack.count = math.min(stack.count, int(limit.max, ctx)) end
      end
    elseif kind == "minecraft:apply_bonus" then
      local level = enchantLevel(ctx, fn.enchantment)
      local formula = fn.formula
      local p = fn.parameters or {}
      if formula == "minecraft:ore_drops" then
        if level > 0 then
          local mult = random(0, level + 1) - 1
          if mult < 0 then mult = 0 end
          stack.count = stack.count * (mult + 1)
        end
      elseif formula == "minecraft:uniform_bonus_count" then
        if level > 0 then stack.count = stack.count + random(0, floor((p.bonusMultiplier or 1) * level)) end
      elseif formula == "minecraft:binomial_with_bonus_count" then
        for _ = 1, level + (p.extra or 0) do
          if random() < (p.probability or 0) then stack.count = stack.count + 1 end
        end
      end
    elseif kind == "minecraft:explosion_decay" then
      -- no explosion
    elseif kind == "minecraft:copy_name" then
      local be = ctx.block.blockEntity
      if be and be.CustomName then stack.displayName = be.CustomName end
    elseif kind == "minecraft:copy_nbt" then
      local be = ctx.block.blockEntity
      if be then
        for _, op in ipairs(fn.ops or {}) do
          local value = be[op.source]
          if value ~= nil then setNbtFromTable(stack, op.target, value) end
        end
      end
    elseif kind == "minecraft:set_contents" then
      local contents = ctx.block.contents
      if contents and next(contents) ~= nil then setNbtFromTable(stack, "BlockEntityTag.Items", contents) end
    elseif kind == "minecraft:copy_state" then
      local copied = {}
      for _, prop in ipairs(fn.properties or {}) do copied[prop] = ctx.block.state and ctx.block.state[prop] end
      setNbtFromTable(stack, "BlockStateTag", copied)
    elseif kind == "minecraft:set_nbt" then
      stack.nbtText = fn.tag
    end
    return stack
  end

  local function applyAll(list, stacks, ctx)
    if not list then return stacks end
    for i, s in ipairs(stacks) do
      for _, fn in ipairs(list) do s = apply(fn, s, ctx) end
      stacks[i] = s
    end
    return stacks
  end

  local evaluate -- forward

  -- Expand an entry into the leaf choices a pool picks from (LootPoolEntryContainer.expand)
  local function expand(entry, ctx, out)
    if not allConditions(entry.conditions, ctx) then return false end
    local kind = entry.type
    if kind == "minecraft:alternatives" then
      for _, child in ipairs(entry.children or {}) do
        if expand(child, ctx, out) then return true end
      end
      return false
    elseif kind == "minecraft:group" then
      for _, child in ipairs(entry.children or {}) do expand(child, ctx, out) end
      return true
    elseif kind == "minecraft:sequence" then
      for _, child in ipairs(entry.children or {}) do
        if not expand(child, ctx, out) then return false end
      end
      return true
    elseif kind == "minecraft:tag" and entry.expand then
      for _, id in ipairs(data.tagMembers(entry.name)) do
        out[#out + 1] = { weight = entry.weight or 1, make = function() return { { name = id, count = 1 } } end, functions = entry.functions }
      end
      return true
    end
    out[#out + 1] = {
      weight = entry.weight or 1,
      functions = entry.functions,
      make = function()
        if kind == "minecraft:item" then return { { name = entry.name, count = 1 } }
        elseif kind == "minecraft:tag" then
          local list = {}
          for _, id in ipairs(data.tagMembers(entry.name)) do list[#list + 1] = { name = id, count = 1 } end
          return list
        elseif kind == "minecraft:loot_table" then
          local tbl = data.lootTable(entry.name)
          return tbl and evaluate(tbl, ctx) or {}
        elseif kind == "minecraft:dynamic" then
          -- "minecraft:contents": a block entity's items (a shulker box breaking open)
          if entry.name == "minecraft:contents" then
            local list = {}
            for _, item in pairs(ctx.block.contents or {}) do list[#list + 1] = { name = item.name, count = item.count, nbt = item.nbt } end
            return list
          end
          -- any other dynamic drop (computercraft:computer) is the block's own item, carrying its block entity
          -- (a computer keeps its id and label, a turtle its fuel, upgrades and inventory)
          local stack = { name = ctx.block.name, count = 1 }
          local be = ctx.block.blockEntity
          if be then
            stack.__blockEntity = be
            if be.CustomName then stack.displayName = be.CustomName end
          end
          return { stack }
        end
        return {}
      end,
    }
    return true
  end

  local function rollPool(pool, ctx, out)
    if not allConditions(pool.conditions, ctx) then return end
    local rolls = int(pool.rolls or 1, ctx) -- bonus_rolls * luck: luck is 0
    for _ = 1, rolls do
      local choices = {}
      for _, entry in ipairs(pool.entries or {}) do expand(entry, ctx, choices) end
      local total = 0
      for _, c in ipairs(choices) do total = total + math.max(c.weight, 0) end
      if #choices > 0 and total > 0 then
        local pick
        if #choices == 1 then pick = choices[1]
        else
          local r = random(0, total - 1)
          for _, c in ipairs(choices) do
            r = r - math.max(c.weight, 0)
            if r < 0 then pick = c break end
          end
        end
        local stacks = applyAll(pick.functions, pick.make(), ctx)
        stacks = applyAll(pool.functions, stacks, ctx)
        for _, s in ipairs(stacks) do out[#out + 1] = s end
      end
    end
  end

  function evaluate(tbl, ctx)
    local out = {}
    for _, pool in ipairs(tbl.pools or {}) do rollPool(pool, ctx, out) end
    applyAll(tbl.functions, out, ctx)
    local kept = {}
    for _, s in ipairs(out) do
      if s.count and s.count > 0 then kept[#kept + 1] = s end
    end
    return kept
  end

  --- The stacks a broken block drops. `block` = { name, state, blockEntity, contents }, `tool` = the turtle's tool item.
  --- No loot table at all (bedrock, a code-defined modded drop): nil, so the caller can decide.
  function M.drops(block, tool, blockAt, toolActions)
    local tbl = data.lootTable(block.name)
    if not tbl then return nil end
    return evaluate(tbl, { block = block, tool = tool, blockAt = blockAt, toolActions = toolActions })
  end

  return M
end
