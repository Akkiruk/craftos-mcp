-- ccsim turtle can_use: CC:Tweaked 1.121.0 lets turtle.place right-click the block straight in front with the
-- selected item when the block is in the computercraft:turtle_can_use tag (#minecraft:beehives, #minecraft:cauldrons,
-- minecraft:composter). TurtlePlaceCommand.doDeployOnBlock calls BlockState.use before the item's own useOn, so a
-- compostable block item goes into a composter instead of being placed against it. CC:Tweaked 1.101.3 never does this.
--
-- The block side is vanilla 1.20.1: ComposterBlock.use / addItem / extractProduce, CauldronInteraction (buckets of
-- water, lava and powder snow, water bottles, and the empty bucket and bottle taking them out again), and
-- BeehiveBlock.use (shears and a glass bottle on a full hive). Washing dyed leather, banners and shulker boxes in a
-- water cauldron is not simulated (docs/conformance/emulator-vs-real-deviations.md).
return function(ctx)
  local M = {}
  local world, data, t = ctx.world, ctx.data, ctx.t
  local storeItems, dropFromTurtle, nbtHash, items = ctx.storeItems, ctx.dropFromTurtle, ctx.nbtHash, ctx.items
  local random = math.random

  local WATER_POTION = nbtHash({ Potion = "minecraft:water" })

  local function level(b) return tonumber(b.state and b.state.level) or 0 end

  local function setBlock(x, y, z, name, state)
    world.set(x, y, z, world.newBlock({ name = name, state = state }))
  end

  --- ItemUtils.createFilledResult: the used item shrinks by one; the result takes its place when it was the last,
  --- else goes into the turtle (the fake player's inventory), and what does not fit is dropped behind it
  local function swapOne(stack, slot, result)
    stack.count = stack.count - 1
    if stack.count <= 0 then
      t.slots[slot] = result
    else
      local rest = storeItems(result, t.selected)
      if rest then dropFromTurtle(rest, ctx.behind()) end
    end
  end

  local function isWaterBottle(stack)
    return stack.name == "minecraft:potion" and (stack.potion == "minecraft:water" or stack.nbt == WATER_POTION)
  end

  --- Block.popResource: an item entity at the block, a little off its centre
  local function pop(x, y, z, item)
    world.dropItem(x + 0.5 + (random() - 0.5) * 0.5, y + 0.5 + (random() - 0.5) * 0.5,
      z + 0.5 + (random() - 0.5) * 0.5, item)
  end

  -- ===== ComposterBlock =====

  local function composter(stack, slot, x, y, z, b)
    local lv = level(b)
    local chance = data.compostChance(stack.name)
    if lv < 8 and chance then
      if lv < 7 then
        -- addItem: the first item always counts in an empty composter, any other only with its chance
        if (lv == 0 and chance > 0) or random() < chance then
          local up = lv + 1
          setBlock(x, y, z, b.name, { level = tostring(up) })
          if up == 7 and ctx.living then ctx.living.scheduleTick(x, y, z, 20) end
        end
        stack.count = stack.count - 1
        if stack.count <= 0 then t.slots[slot] = nil end
      end
      return true
    elseif lv == 8 then
      -- extractProduce: one bone meal pops out of the top, and the composter is empty again
      world.dropItem(x + random() * 0.7 + 0.15, y + random() * 0.7 + 0.06 + 0.6, z + random() * 0.7 + 0.15,
        { name = "minecraft:bone_meal", count = 1 })
      setBlock(x, y, z, b.name, { level = "0" })
      return true
    end
    return false
  end

  -- ===== cauldrons (CauldronInteraction) =====

  local FILL = {
    ["minecraft:water_bucket"] = { "minecraft:water_cauldron", "3" },
    ["minecraft:lava_bucket"] = { "minecraft:lava_cauldron" },
    ["minecraft:powder_snow_bucket"] = { "minecraft:powder_snow_cauldron", "3" },
  }
  -- what an empty bucket takes out of a full cauldron
  local TAKE = {
    ["minecraft:water_cauldron"] = "minecraft:water_bucket",
    ["minecraft:lava_cauldron"] = "minecraft:lava_bucket",
    ["minecraft:powder_snow_cauldron"] = "minecraft:powder_snow_bucket",
  }

  local function cauldron(stack, slot, x, y, z, b)
    local name = stack.name
    local fill = FILL[name]
    if fill then
      -- emptyBucket: any cauldron takes a full bucket, replacing what it held
      setBlock(x, y, z, fill[1], fill[2] and { level = fill[2] } or {})
      swapOne(stack, slot, { name = "minecraft:bucket", count = 1 })
      return true
    end
    if b.name == "minecraft:cauldron" then
      if isWaterBottle(stack) then
        setBlock(x, y, z, "minecraft:water_cauldron", { level = "1" })
        swapOne(stack, slot, { name = "minecraft:glass_bottle", count = 1 })
        return true
      end
      return false
    end
    if name == "minecraft:bucket" then
      -- fillBucket: lava is always full; water and powder snow only at level 3
      local full = TAKE[b.name]
      if not full or (b.name ~= "minecraft:lava_cauldron" and level(b) ~= 3) then return false end
      setBlock(x, y, z, "minecraft:cauldron", {})
      swapOne(stack, slot, { name = full, count = 1 })
      return true
    end
    if b.name == "minecraft:water_cauldron" then
      if name == "minecraft:glass_bottle" then
        local lv = level(b) - 1
        if lv <= 0 then setBlock(x, y, z, "minecraft:cauldron", {})
        else setBlock(x, y, z, b.name, { level = tostring(lv) }) end
        swapOne(stack, slot, { name = "minecraft:potion", count = 1, nbt = WATER_POTION })
        return true
      elseif isWaterBottle(stack) and level(b) < 3 then
        setBlock(x, y, z, b.name, { level = tostring(level(b) + 1) })
        swapOne(stack, slot, { name = "minecraft:glass_bottle", count = 1 })
        return true
      end
    end
    return false
  end

  -- ===== BeehiveBlock =====

  local function beehive(stack, slot, x, y, z, b)
    if (tonumber(b.state and b.state.honey_level) or 0) < 5 then return false end
    if stack.name == "minecraft:shears" then
      for _ = 1, 3 do pop(x, y, z, { name = "minecraft:honeycomb", count = 1 }) end
      stack.damage = (stack.damage or 0) + 1
      if stack.damage >= items.maxDamage(stack.name) then t.slots[slot] = nil end
    elseif stack.name == "minecraft:glass_bottle" then
      swapOne(stack, slot, { name = "minecraft:honey_bottle", count = 1 })
    else
      return false
    end
    -- resetHoneyLevel (the bees, if any, are not simulated)
    local state = {}
    for k, v in pairs(b.state or {}) do state[k] = v end
    state.honey_level = "0"
    setBlock(x, y, z, b.name, state)
    return true
  end

  --- Right-click the block at x,y,z with the selected stack, if it is one a turtle can use. True when it took the
  --- action (the turtle.place succeeds), false to go on with the item's own use.
  function M.use(stack, slot, x, y, z, b)
    if not b or not data.blockHasTag(b.name, "computercraft:turtle_can_use") then return false end
    if b.name == "minecraft:composter" then return composter(stack, slot, x, y, z, b) end
    if data.blockHasTag(b.name, "minecraft:cauldrons") then return cauldron(stack, slot, x, y, z, b) end
    if data.blockHasTag(b.name, "minecraft:beehives") then return beehive(stack, slot, x, y, z, b) end
    return false
  end

  M.WATER_POTION = WATER_POTION
  return M
end
