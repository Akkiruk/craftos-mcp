-- ccsim addon: CC: Androids 1.3.0 for Minecraft 1.20.1 (ThunderBear2006/CC-Androids, commit a804326; the API is the
-- same at dc51f8e, 1.3.1). Written from its source: computer/api/AndroidAPI.java for every function, ai/task/ for
-- what a task does each tick, ai/modules/ for sensing, mining and containers, entity/android/ for fuel, hands and the
-- stash. docs/cc-androids.md says what each rule comes from and what is simplified.
--
-- A world with an `android` entry makes the computer an android: a mob that walks the block world of
-- ccsim/turtle/world.lua (ccsim/mob.lua has what it shares with the drones).
return function(core, host)
  local M = {}
  local spec = core.world.android
  if type(spec) ~= "table" then return M end
  local floor, min, max, abs, sqrt = math.floor, math.min, math.max, math.abs, math.sqrt

  local mob = dofile("/rom/ccsim/mob.lua")(core, {
    x = spec.x, y = spec.y, z = spec.z, dimension = spec.dimension,
  })
  local A = mob.args
  local brain, world, rules, data, items

  -- ===== the three androids (EntityRegistry, CCAndroidsConfig defaults) =====

  local KINDS = {
    normal = { prefix = "Android", health = 20, damage = 1, speed = 0.6, radius = 10 },
    advanced = { prefix = "AdvAndroid", health = 25, damage = 3, speed = 0.9, radius = 30 },
    command = { prefix = "ComAndroid", health = 25, damage = 3, speed = 0.9, radius = 30 },
  }
  local kindName = spec.type or (spec.advanced and "advanced") or "normal"
  local kind = KINDS[kindName]
  if not kind then error("world.android.type must be normal, advanced or command, not " .. tostring(kindName), 0) end
  local cfg = core.world.androidConfig or {}
  local maxHealth = cfg[kind.prefix .. "MaxHealth"] or kind.health
  local baseDamage = cfg[kind.prefix .. "Damage"] or kind.damage
  local moveSpeed = cfg[kind.prefix .. "Speed"] or kind.speed
  local MAX_FUEL = 10000 -- BaseAndroidEntity.maxFuel
  local STASH = 9        -- new AndroidInventory(9)
  local WIDTH, HEIGHT, EYE = 0.6, 1.8, 1.8 * 0.85 -- EntityType.Builder defaults; LivingEntity eye height
  -- The fake player an android acts through when nobody owns it (AndroidPlayer.DEFAULT_PROFILE)
  local DEFAULT_PROFILE = "0d0c4ca0-4ff1-11e4-916c-0800200c9a66"

  local a = {
    kind = kindName,
    fuel = spec.fuel or 0,
    health = spec.health or maxHealth,
    slots = {}, -- 0..8, as the API counts them
    face = "normal",
    owner = type(spec.owner) == "table" and spec.owner or nil,
    uuid = spec.uuid or "00000000-0000-4000-a000-000000000001",
    interactions = {},
    chat = {},
  }
  local task -- the current task, or nil when idle
  local nav  -- { path, index }: where it is walking

  -- ===== fuel (BaseAndroidEntity) =====

  local function hasFuel() return kindName == "command" or a.fuel > 0 end
  local function needFuel()
    if not hasFuel() then error("Android requires fuel.", 0) end
  end

  --- TagRegistry: redstone is minor (10 a piece), a redstone block medium (80); nothing is major (800) by default
  local FUEL_TAGS = {
    { tag = "cc_androids:minor_android_fuel", mult = 10, default = { ["minecraft:redstone"] = true } },
    { tag = "cc_androids:medium_android_fuel", mult = 80, default = { ["minecraft:redstone_block"] = true } },
    { tag = "cc_androids:major_android_fuel", mult = 800, default = {} },
  }
  local function fuelMultiplier(item)
    for _, f in ipairs(FUEL_TAGS) do
      if f.default[item.name] or data.itemHasTag(item.name, f.tag) then return f.mult end
    end
    return 0
  end

  -- ===== hands and the stash =====

  local POCKET_UPGRADES = {
    ["computercraft:wireless_modem_normal"] = true,
    ["computercraft:wireless_modem_advanced"] = true,
    ["computercraft:speaker"] = true,
  }

  local function setHand(hand, item)
    if item and item.count <= 0 then item = nil end
    local before = a[hand] and a[hand].name
    a[hand] = item
    core.dirty = true
    -- AndroidComputerContainer.onHandItemChanged: the main hand is the right upgrade, the off hand the left one
    if brain and before ~= (item and item.name) and (POCKET_UPGRADES[before or ""] or POCKET_UPGRADES[item and item.name or ""]) then
      brain.refreshPeripherals(false)
    end
  end

  local function displayName(item)
    if not item then return "Air" end
    return item.displayName or data.displayName(item.name)
  end

  --- Text.toString() of ItemStack.getName(), which is what getContainerInfo puts in its list
  local function nameText(item)
    if not item then return "translation{key='block.minecraft.air', args=[]}" end
    if item.displayName then return "literal{" .. item.displayName .. "}" end
    local ns, path = item.name:match("^([^:]+):(.+)$")
    return ("translation{key='%s.%s.%s', args=[]}"):format(data.isBlock(item.name) and "block" or "item", ns, path)
  end

  local function copyItem(item, count)
    local c = {}
    for k, v in pairs(item) do c[k] = v end
    c.count = count or item.count
    return c
  end

  -- ===== tools (what the fake player holds decides how fast a block breaks and what it drops) =====

  local TIERS = {
    wooden = { level = 0, speed = 2 }, golden = { level = 0, speed = 12 }, stone = { level = 1, speed = 4 },
    iron = { level = 2, speed = 6 }, diamond = { level = 3, speed = 8 }, netherite = { level = 4, speed = 9 },
  }
  -- attack damage modifiers of the vanilla tools (SwordItem 3, AxeItem 6/7/6/5/5, PickaxeItem 1, ShovelItem 1.5, plus
  -- the tier's own bonus)
  local TIER_BONUS = { wooden = 0, golden = 0, stone = 1, iron = 2, diamond = 3, netherite = 4 }
  local AXE_BASE = { wooden = 6, golden = 6, stone = 7, iron = 6, diamond = 5, netherite = 5 }

  local function toolOf(item)
    if not item then return nil end
    local tier, tool = item.name:match("^minecraft:(%a+)_(%a+)$")
    if tier and TIERS[tier] and (tool == "pickaxe" or tool == "axe" or tool == "shovel" or tool == "hoe" or tool == "sword") then
      return { tier = tier, tool = tool, level = TIERS[tier].level, speed = TIERS[tier].speed }
    end
    return nil
  end

  local function attackDamage()
    local item = a.main
    local bonus = 0
    if item then
      local t = toolOf(item)
      if item.attackDamage then bonus = item.attackDamage
      elseif item.name == "minecraft:trident" then bonus = 8
      elseif t and t.tool == "sword" then bonus = 3 + TIER_BONUS[t.tier]
      elseif t and t.tool == "axe" then bonus = AXE_BASE[t.tier] + TIER_BONUS[t.tier]
      elseif t and t.tool == "pickaxe" then bonus = 1 + TIER_BONUS[t.tier]
      elseif t and t.tool == "shovel" then bonus = 1.5 + TIER_BONUS[t.tier]
      end
    end
    return baseDamage + bonus
  end

  local function needsLevel(block)
    if data.blockHasTag(block.name, "minecraft:needs_diamond_tool") then return 3 end
    if data.blockHasTag(block.name, "minecraft:needs_iron_tool") then return 2 end
    if data.blockHasTag(block.name, "minecraft:needs_stone_tool") then return 1 end
    return 0
  end

  --- MiningToolItem: the tool is the right one for the block (its mineable tag) and its tier is high enough
  local function suitable(t, block)
    if not t or t.tool == "sword" then return false end
    return data.blockHasTag(block.name, "minecraft:mineable/" .. t.tool) and t.level >= needsLevel(block)
  end

  -- Block hardness is in the game's code, not in its data files: these are the common vanilla ones, a world adds
  -- more in gameData.hardness, and anything else counts as stone (1.5).
  local HARDNESS = {
    stone = 1.5, cobblestone = 2, mossy_cobblestone = 2, smooth_stone = 2, granite = 1.5, diorite = 1.5, andesite = 1.5,
    deepslate = 3, cobbled_deepslate = 3.5, tuff = 1.5, calcite = 0.75, dirt = 0.5, coarse_dirt = 0.5, grass_block = 0.6,
    podzol = 0.5, mycelium = 0.6, farmland = 0.6, dirt_path = 0.65, sand = 0.5, red_sand = 0.5, gravel = 0.6, clay = 0.6,
    sandstone = 0.8, red_sandstone = 0.8, netherrack = 0.4, end_stone = 3, obsidian = 50, crying_obsidian = 50,
    glass = 0.3, glowstone = 0.3, ice = 0.5, packed_ice = 0.5, snow_block = 0.2, snow = 0.1, bricks = 2,
    stone_bricks = 1.5, bookshelf = 1.5, chest = 2.5, trapped_chest = 2.5, barrel = 2.5, crafting_table = 2.5,
    furnace = 3.5, blast_furnace = 3.5, smoker = 3.5, hopper = 3, dispenser = 3.5, dropper = 3.5, ladder = 0.4,
    iron_block = 5, gold_block = 3, diamond_block = 5, emerald_block = 5, lapis_block = 3, coal_block = 5,
    redstone_block = 5, iron_door = 5, hay_block = 0.5, melon = 1, pumpkin = 1, cobweb = 4, sponge = 0.6,
    coal_ore = 3, iron_ore = 3, copper_ore = 3, gold_ore = 3, redstone_ore = 3, lapis_ore = 3, diamond_ore = 3,
    emerald_ore = 3, nether_quartz_ore = 3, nether_gold_ore = 3, ancient_debris = 30,
  }
  local function hardness(block)
    local over = core.world.gameData and core.world.gameData.hardness
    if over and over[block.name] ~= nil then return over[block.name] end
    if rules.isUnbreakable(block) then return -1 end
    if rules.isInstabreak(block) then return 0 end
    local ns, path = block.name:match("^([^:]+):(.+)$")
    if ns == "computercraft" then return 2 end
    if ns == "minecraft" then
      if HARDNESS[path] then return HARDNESS[path] end
      if path:find("^deepslate_.+_ore$") then return 4.5 end
      if data.blockHasTag(block.name, "minecraft:leaves") then return 0.2 end
      if data.blockHasTag(block.name, "minecraft:logs") or data.blockHasTag(block.name, "minecraft:planks") then return 2 end
      if data.blockHasTag(block.name, "minecraft:wool") then return 0.8 end
      if data.blockHasTag(block.name, "minecraft:wooden_doors") or data.blockHasTag(block.name, "minecraft:wooden_trapdoors") then return 3 end
    end
    return 1.5
  end

  --- MiningModule.canMineBlock
  local function canMine(x, y, z)
    local b = brain.blockAt(x, y, z)
    return b ~= nil and not rules.isAir(b) and hardness(b) > -1
  end

  --- MiningModule.getBreakSpeed: a player's breaking speed, a hundred times over. The fake player never stands on
  --- the ground, so its speed is a fifth (PlayerEntity.getBlockBreakingSpeed).
  local function breakSpeed(block)
    local t = toolOf(a.main)
    local speed = 1
    if t and t.tool ~= "sword" and data.blockHasTag(block.name, "minecraft:mineable/" .. t.tool) then speed = t.speed end
    if t and t.tool == "sword" and block.name == "minecraft:cobweb" then speed = 15 end
    speed = speed / 5
    local canHarvest = not rules.requiresCorrectTool(block) or suitable(t, block)
    return (speed / hardness(block) / (canHarvest and 30 or 100)) * 100, canHarvest
  end

  --- ServerPlayerInteractionManager.tryBreakBlock by the fake player: the block goes, what it drops lies there, and
  --- a tool takes a point of damage.
  local function breakBlock(x, y, z)
    local block = brain.blockAt(x, y, z)
    if not block or rules.isAir(block) then return end
    local t = toolOf(a.main)
    local _, canHarvest = breakSpeed(block)
    local hard = hardness(block)
    -- the turtle rules know the diamond tools: a tool that can harvest the block stands in as the diamond one
    local tool = canHarvest and t and t.tool ~= "sword" and ("minecraft:diamond_" .. t.tool) or nil
    if canHarvest and not tool and rules.requiresCorrectTool(block) then canHarvest = false end
    local drops
    if canHarvest or not rules.requiresCorrectTool(block) then
      drops = brain.breakBlock(x, y, z, block, tool)
    else
      drops = brain.breakBlock(x, y, z, block, nil)
    end
    for _, stack in ipairs(drops or {}) do world.dropItem(x, y, z, stack) end
    if t and hard ~= 0 and a.main then
      local limit = a.main.maxDamage or items.maxDamage(a.main.name)
      if limit and limit > 0 and not a.main.unbreakable then
        a.main.damage = (a.main.damage or 0) + (t.tool == "sword" and 2 or 1)
        if a.main.damage >= limit then setHand("main", nil) end
      end
    end
    core.dirty = true
  end

  -- ===== sensing (SensorModule) =====

  local function boxOf(e)
    local w, h = (e.width or 0.6) / 2, e.height or 1.8
    return e.x - w, e.y, e.z - w, e.x + w, e.y + h, e.z + w
  end

  --- Entities whose box touches the android's box grown by `r` on every side
  local function inRange(e, r)
    local x1, y1, z1, x2, y2, z2 = boxOf(e)
    return x2 > mob.x - WIDTH / 2 - r and x1 < mob.x + WIDTH / 2 + r
      and y2 > mob.y - r and y1 < mob.y + HEIGHT + r
      and z2 > mob.z - WIDTH / 2 - r and z1 < mob.z + WIDTH / 2 + r
  end

  --- LivingEntity.canSee: nothing with a collision shape between the two pairs of eyes, within 128 blocks
  local function canSee(e)
    local ey = e.y + (e.eyeHeight or (e.height or 1.8) * 0.85)
    local dx, dy, dz = e.x - mob.x, ey - (mob.y + EYE), e.z - mob.z
    if dx * dx + dy * dy + dz * dz > 128 * 128 then return false end
    return mob.raycast(mob.x, mob.y + EYE, mob.z, e.x, ey, e.z, false) == nil
  end

  --- SensorModule.collectEntityInfo
  local function entityInfo(e)
    local info = { uuid = e.uuid, name = mob.entityName(e), posX = e.x, posY = e.y, posZ = e.z }
    if e.living then info.health = e.health end
    return info
  end

  local function selfInfo()
    return {
      uuid = a.uuid,
      -- AndroidComputerContainer.updateOwnerLabel: the computer's label, or "Android" for all three kinds
      name = os.getComputerLabel() or "Android",
      posX = mob.x, posY = mob.y, posZ = mob.z,
      health = a.health,
    }
  end

  --- SensorModule.getTypePredicate
  local function matches(e, kindOf)
    if not e.living then return false end
    if kindOf == nil then return canSee(e) end
    return (e.type or ""):find(kindOf, 1, true) ~= nil and not e.spectator and mob.isAlive(e) and canSee(e)
  end

  local function livingEntity(uuid)
    local e = mob.findEntity(uuid)
    if e and not e.living then
      -- (LivingEntity) world.getEntity(uuid)
      mob.javaError("java.lang.ClassCastException", "class net.minecraft.entity.ItemEntity cannot be cast to class net.minecraft.entity.LivingEntity")
    end
    return e
  end

  -- ===== walking (MobNavigation at the task's speed of 0.5) =====

  -- LivingEntity.travel on the ground: the push is speed x input x 0.98 a tick and friction keeps 0.546 of it, so a
  -- mob settles at speed^2 x 0.98 / 0.454 blocks a tick (speed = 0.5 x its movement speed attribute).
  local function stride()
    local speed = 0.5 * moveSpeed
    return speed * speed * 0.98 / (1 - 0.6 * 0.91)
  end

  local function navIdle() return nav == nil or nav.index > #nav.path end

  local lastFailed -- { tick, key }: a target no path got closer to, so the search is not run again every tick
  local function startMovingTo(tx, ty, tz)
    local bx, by, bz = mob.blockPos()
    local key = bx .. "," .. by .. "," .. bz .. ">" .. tx .. "," .. ty .. "," .. tz
    if lastFailed and lastFailed.key == key and mob.age - lastFailed.tick < 20 then return end
    local sy = mob.standable(bx, by, bz, true) and by or mob.groundBelow(bx, by, bz) or by
    local path = mob.findPath(bx, sy, bz, tx, ty, tz, { doors = true })
    if #path == 0 then
      lastFailed = { tick = mob.age, key = key }
      nav = nil
      return
    end
    lastFailed = nil
    nav = { path = path, index = 1 }
  end

  local function setDoor(x, y, z, open)
    local b = brain.blockAt(x, y, z)
    if not mob.isDoor(b) then return end
    local value = open and "true" or "false"
    for _, yy in ipairs({ y, b.state.half == "upper" and y - 1 or y + 1 }) do
      local part = brain.blockAt(x, yy, z)
      if mob.isDoor(part) and part.state.open ~= value then
        part.state.open = value
        world.set(x, yy, z, part)
      end
    end
  end

  --- One tick of walking along the path, then InteractionModule.tickDoorInteraction: the door ahead opens, and the
  --- one before the end of the path shuts.
  local function walk()
    if navIdle() then return end
    local budget = stride()
    while budget > 0 and nav.index <= #nav.path do
      local node = nav.path[nav.index]
      if not mob.standable(node.x, node.y, node.z, true) then nav = nil return end -- the way changed
      local cx, cz = node.x + 0.5, node.z + 0.5
      local dx, dz = cx - mob.x, cz - mob.z
      local dist = sqrt(dx * dx + dz * dz)
      local y = max(mob.y, node.y) -- up a step at once, down one on arrival
      if dist <= budget then
        mob.setPos(cx, node.y, cz)
        budget = budget - dist
        nav.index = nav.index + 1
      else
        mob.setPos(mob.x + dx / dist * budget, y, mob.z + dz / dist * budget)
        budget = 0
      end
      if dist > 0 then a.yaw = math.deg((math.atan2 or math.atan)(-dx, dz)) end
    end
    if nav and nav.index <= #nav.path then
      local node = nav.path[nav.index]
      setDoor(node.x, node.y, node.z, true)
      local before = nav.path[#nav.path - 1]
      if before then setDoor(before.x, before.y, before.z, false) end
    end
  end

  -- ===== tasks (ai/task) =====

  --- Vec3i.isWithinDistance between the android's block and another: closer than `d`, measured block to block
  local function near(x, y, z, d)
    local bx, by, bz = mob.blockPos()
    return (bx - x) ^ 2 + (by - y) ^ 2 + (bz - z) ^ 2 < d * d
  end
  local function nearEntity(e, d) return near(floor(e.x), floor(e.y), floor(e.z), d) end

  local function remember(what)
    a.interactions[#a.interactions + 1] = what
    while #a.interactions > 32 do table.remove(a.interactions, 1) end
    core.dirty = true
  end

  --- InteractionModule.interactWithBlock: the fake player right-clicks the top of the block with the main hand.
  local function useBlock(x, y, z)
    local b = brain.blockAt(x, y, z)
    local held = a.main
    remember({ block = { x = x, y = y, z = z }, name = b and b.name or "minecraft:air", item = held and held.name or nil })
    if b and b.state.open ~= nil and not b.name:find("iron") then
      if mob.isDoor(b) then setDoor(x, y, z, b.state.open ~= "true")
      else b.state.open = b.state.open == "true" and "false" or "true" world.set(x, y, z, b) end
      return
    end
    if b and b.name == "minecraft:lever" then
      b.state.powered = b.state.powered == "true" and "false" or "true"
      world.set(x, y, z, b)
      return
    end
    if b and b.name:find("_button$") and b.state.powered ~= nil then
      b.state.powered = "true"
      world.set(x, y, z, b)
      -- ButtonBlock: a stone button springs back after 20 ticks, a wooden one after 30
      a.releases = a.releases or {}
      a.releases[#a.releases + 1] = { x = x, y = y, z = z, at = mob.age + ((b.name:find("stone") and 20) or 30) }
      return
    end
    if b and brain.inventoryOf(b) then return end -- a container opens its screen, which the android shuts again
    if b and not rules.isAir(b) and held then
      -- a block item goes on top of the block that was clicked (the hit is on its upper face)
      local place = rules.blockFor(held.name, "up")
      if place and data.isBlock(place) and rules.isReplaceable(brain.blockAt(x, y + 1, z)) then
        local bx, by, bz = mob.blockPos()
        if not (bx == x and bz == z and (by == y + 1 or by + 1 == y + 1)) then
          world.set(x, y + 1, z, world.newBlock({ name = place }))
          setHand("main", held.count > 1 and copyItem(held, held.count - 1) or nil)
        end
      end
    end
  end

  --- InteractionModule.interactWithEntity
  local function useEntity(e)
    local held = a.main
    remember({ entity = e.uuid, type = e.type, item = held and held.name or nil })
    if (e.type or ""):find("^cc_androids:.*android") and held and held.name == "cc_androids:components" then
      -- AndroidEntity.repair
      if (e.health or 0) < (e.maxHealth or 20) then
        e.health = min((e.health or 0) + 5, e.maxHealth or 20)
        setHand("main", held.count > 1 and copyItem(held, held.count - 1) or nil)
        return
      end
    end
    if not e.player then
      if held and held.name == "minecraft:lead" and e.leashedTo == nil then
        e.leashedTo = a.uuid
        setHand("main", held.count > 1 and copyItem(held, held.count - 1) or nil)
        return
      elseif not held and e.leashedTo == a.uuid then
        e.leashedTo = nil
        world.dropItem(floor(e.x), floor(e.y), floor(e.z), { name = "minecraft:lead", count = 1 })
        return
      end
    end
    e.interactions = (e.interactions or 0) + 1
  end

  local function moveToBlock(t)
    if navIdle() then startMovingTo(t.x, t.y, t.z) end
  end
  local function moveToEntity(t)
    if navIdle() then startMovingTo(floor(t.entity.x), floor(t.entity.y), floor(t.entity.z)) end
  end
  local function stopNav() nav = nil end

  local TASKS = {
    movingToBlock = {
      shouldTick = function(t) return not near(t.x, t.y, t.z, 2) end,
      tick = moveToBlock,
      lastTick = stopNav,
    },
    movingToEntity = {
      shouldTick = function(t) return mob.isAlive(t.entity) and not nearEntity(t.entity, 1) end,
      tick = moveToEntity,
      lastTick = stopNav,
    },
    attacking = {
      shouldTick = function(t) return mob.isAlive(t.entity) end,
      tick = function(t)
        local cooldown = t.cooldown or 0
        t.cooldown = cooldown - 1
        if cooldown > 0 then return end
        if nearEntity(t.entity, 2) then
          t.cooldown = 10
          mob.hurt(t.entity, attackDamage())
        else
          moveToEntity(t)
        end
      end,
      lastTick = stopNav,
    },
    breakingBlock = {
      shouldTick = function(t) return canMine(t.x, t.y, t.z) end,
      tick = function(t)
        if near(t.x, t.y, t.z, 3) then
          t.progress = (t.progress or 0) + breakSpeed(brain.blockAt(t.x, t.y, t.z))
          if t.progress >= 10 then breakBlock(t.x, t.y, t.z) end
        else
          moveToBlock(t)
        end
      end,
      lastTick = function(t) t.progress = 0 end, -- resetBreakProgress; the walk is not stopped
    },
    usingBlock = {
      shouldTick = function(t) return not t.complete end,
      tick = function(t)
        if near(t.x, t.y, t.z, 2) then
          useBlock(t.x, t.y, t.z)
          t.complete = true
        else
          moveToBlock(t)
        end
      end,
      lastTick = stopNav,
    },
    usingEntity = {
      shouldTick = function(t) return mob.isAlive(t.entity) and not t.complete end,
      tick = function(t)
        if nearEntity(t.entity, 2) then
          useEntity(t.entity)
          t.complete = true
        else
          moveToEntity(t)
        end
      end,
      lastTick = stopNav,
    },
  }

  local function clearTask()
    if not task then return end
    TASKS[task.name].lastTick(task)
    task = nil
    core.dirty = true
  end

  local function setTask(t)
    clearTask()
    task = t
    core.dirty = true
    mob.schedule()
  end

  mob.busy = function() return task ~= nil or not navIdle() or a.releases ~= nil end

  --- One game tick: AndroidEntity.tickMovement (walk, doors, then the task while there is fuel), then
  --- BaseAndroidEntity.tick's once-a-second part (idle: look at the blocks around; busy: burn one fuel).
  mob.onTick = function(age)
    walk()
    if hasFuel() then
      if task then
        local def = TASKS[task.name]
        if def.shouldTick(task) then def.tick(task) else clearTask() end
      end
    elseif not navIdle() then
      nav = nil
    end
    if age % 20 == 0 then
      if task == nil then
        brain.refreshPeripherals(false)
      elseif a.fuel > 0 then
        a.fuel = a.fuel - 1
        core.dirty = true
      end
    end
    if a.releases then
      for i = #a.releases, 1, -1 do
        local r = a.releases[i]
        if age >= r.at then
          local b = brain.blockAt(r.x, r.y, r.z)
          if b and b.state.powered == "true" then b.state.powered = "false" world.set(r.x, r.y, r.z, b) end
          table.remove(a.releases, i)
        end
      end
      if #a.releases == 0 then a.releases = nil end
    end
  end

  -- ===== the sides (BaseAndroidEntity.updatePeripherals) =====

  -- ComputerSide.valueOf(direction.ordinal()): the sides are fixed to the compass, whichever way the android looks,
  -- and nothing is ever wrapped above it
  local SIDE_DIR = { bottom = "down", back = "north", front = "south", right = "west", left = "east" }
  mob.sideDir = function(side) return SIDE_DIR[side] end
  mob.sideUpgrade = function(side)
    local item = (side == "right" and a.main) or (side == "left" and a.off) or nil
    return item and POCKET_UPGRADES[item.name] and item.name or nil
  end

  -- ===== positions (AndroidAPI.getPosFromArgs) =====

  local JAVA_CLASS = { string = "java.lang.String", boolean = "java.lang.Boolean", table = "java.util.HashMap" }
  local function intValue(v)
    if type(v) ~= "number" then
      local class = JAVA_CLASS[type(v)] or "java.lang.Object"
      mob.javaError("java.lang.ClassCastException", ("class %s cannot be cast to class java.lang.Double (%s and java.lang.Double are in module java.base of loader 'bootstrap')"):format(class, class))
    end
    if v ~= v then return 0 end
    return v >= 0 and floor(v) or -floor(-v)
  end

  --- Returns x, y, z and how many arguments the position took.
  local function posFromArgs(args)
    local first = args[1]
    if type(first) == "table" then
      if first.x == nil or first.y == nil or first.z == nil then error("x,y,z keys expected", 0) end
      return intValue(first.x), intValue(first.y), intValue(first.z)
    end
    return A.int(1, args[1]), A.int(2, args[2]), A.int(3, args[3])
  end

  local function inBuildLimit(y)
    local lo, hi = world.limits(core.position.dimension)
    return y >= lo and y <= hi
  end

  --- BlockPos.isWithinDistance(android.getPos(), radius): from the middle of the block to the android's feet
  local function withinReach(x, y, z)
    return (x + 0.5 - mob.x) ^ 2 + (y + 0.5 - mob.y) ^ 2 + (z + 0.5 - mob.z) ^ 2 < kind.radius * kind.radius
  end

  local function containerAt(x, y, z)
    local block = brain.blockAt(x, y, z)
    local inv = brain.inventoryOf(block)
    if not inv then return nil end
    return inv, inv.__state()
  end

  local function slotArg(args)
    -- args.count() == 2 ? args.getInt(1) : args.getInt(3)
    if args.n == 2 then return A.int(2, args[2]) end
    return A.int(4, args[4])
  end

  local function checkSlot(inv, slot)
    local size = inv.size()
    if slot < 0 or slot >= size then
      mob.javaError("java.lang.ArrayIndexOutOfBoundsException", ("Index %d out of bounds for length %d"):format(slot, size))
    end
  end

  -- ===== android (AndroidAPI.java) =====

  local api = {}
  local function main(fn)
    return function(...)
      local args = table.pack(...)
      return mob.onMainThread(function() return fn(args) end)
    end
  end

  -- information
  function api.currentTask() return task and task.name or "idle" end
  function api.getSelf() return selfInfo() end

  -- actions
  function api.attack(...)
    local uuid = A.string(1, (...))
    needFuel()
    local target = livingEntity(mob.parseUuid(uuid))
    if not target then return true, "Unknown entity or invalid UUID" end
    setTask({ name = "attacking", entity = target })
  end

  function api.goTo(...)
    local uuid = A.string(1, (...))
    needFuel()
    local target = livingEntity(mob.parseUuid(uuid))
    if not target or not mob.isAlive(target) then return true, "Unknown entity or invalid UUID" end
    setTask({ name = "movingToEntity", entity = target })
  end

  function api.moveTo(...)
    needFuel()
    local x, y, z = posFromArgs(table.pack(...))
    if not inBuildLimit(y) then return true, "Block pos must be within build limit" end
    setTask({ name = "movingToBlock", x = x, y = y, z = z })
  end

  function api.breakBlock(...)
    needFuel()
    local x, y, z = posFromArgs(table.pack(...))
    if not near(x, y, z, 100) then return true, "Block position must be within a 100 block radius" end
    if not inBuildLimit(y) then return true, "Block position must be in world build limit" end
    setTask({ name = "breakingBlock", x = x, y = y, z = z })
  end

  function api.useBlock(...)
    needFuel()
    local x, y, z = posFromArgs(table.pack(...))
    if not inBuildLimit(y) then return true, "Block position must be in world build limit" end
    setTask({ name = "usingBlock", x = x, y = y, z = z })
  end

  function api.useEntity(...)
    local uuid = A.string(1, (...))
    needFuel()
    local target = livingEntity(mob.parseUuid(uuid))
    if not target or not mob.isAlive(target) then return true, "Unknown entity or invalid UUID" end
    setTask({ name = "usingEntity", entity = target })
  end

  api.pickup = main(function(args)
    local kindOf = A.optString(1, args[1])
    -- SensorModule.getGroundItem: the first dropped item within 5 blocks whose id has the text in it
    local found
    for i, e in ipairs(world.itemEntities) do
      local ix, iy, iz = e.x + 0.5, e.y, e.z + 0.5
      if abs(ix - mob.x) <= 5 + WIDTH / 2 + 0.125 and abs(iz - mob.z) <= 5 + WIDTH / 2 + 0.125
        and iy + 0.25 >= mob.y - 5 and iy <= mob.y + HEIGHT + 5
        and (kindOf == nil or e.item.name:find(kindOf, 1, true)) then
        found = i
        break
      end
    end
    if not found then return true, "Could not find item" end
    if a.main then return true, "Cannot pickup item without an empty hand" end
    local e = table.remove(world.itemEntities, found)
    setHand("main", e.item)
  end)

  api.dropItem = main(function()
    if not a.main then return "Hand is empty" end
    local bx, by, bz = mob.blockPos()
    world.dropItem(bx, by, bz, a.main)
    setHand("main", nil)
  end)

  api.storeItem = main(function(args)
    local index = A.int(1, args[1])
    local held = a.main
    if not held then return true, "No item in hand to stash" end
    -- BaseAndroidEntity.canStash (its message counts one slot too many)
    if index < 0 or index > STASH - 1 then return ("Index must be between 0 and %d"):format(STASH) end
    local stored = a.slots[index]
    if stored and not brain.same(stored, held) then return "Index is occupied by another item stack!" end
    if not stored then
      a.slots[index] = held
      setHand("main", nil)
    else
      local transfer = min(held.count, brain.maxOf(stored) - stored.count)
      stored.count = stored.count + transfer
      setHand("main", held.count > transfer and copyItem(held, held.count - transfer) or nil)
    end
    core.dirty = true
    return false, "Stashed held item at index " .. index
  end)

  api.equipSlot = main(function(args)
    local index = A.int(1, args[1])
    if index < 0 or index > STASH - 1 then return true, ("Index must be between 0 and %d"):format(STASH - 1) end
    if a.main then return "Cannot equip item while holding an item" end
    local stored = a.slots[index]
    a.slots[index] = nil
    if not stored then return "Index of stash is empty" end
    setHand("main", stored)
    return false, "Equipped stack from index " .. index
  end)

  api.swapHands = main(function()
    local m, o = a.main, a.off
    setHand("main", o)
    setHand("off", m)
  end)

  api.getHandInfo = main(function(args)
    local hand = A.string(1, args[1])
    local item
    if hand == "right" or hand == "main" then item = a.main
    elseif hand == "left" or hand == "off" then item = a.off
    else return true, "Invalid hand name" end
    return displayName(item), item and item.count or 0
  end)

  api.getSlotInfo = main(function(args)
    local index = A.int(1, args[1])
    if index < 0 or index > STASH - 1 then return true, ("Index must be between 0 and %d"):format(STASH - 1) end
    local stored = a.slots[index]
    if not stored then return "empty" end
    return false, data.displayName(stored.name)
  end)

  api.refuel = main(function(args)
    local amount = A.optInt(1, args[1])
    local held = a.main
    if not held then return true, "Hand is empty" end
    -- BaseAndroidEntity.addFuel, as written: the room left is counted in items, not in fuel
    local mult = fuelMultiplier(held)
    if mult <= 0 then return true, "Held item stack cannot be used for fuel" end
    local used = min(min(amount or held.count, held.count), MAX_FUEL - a.fuel)
    a.fuel = min(a.fuel + used * mult, MAX_FUEL)
    setHand("main", held.count - used > 0 and copyItem(held, held.count - used) or nil)
    return false, "Fuel level increased to " .. a.fuel
  end)

  api.fuelLevel = main(function() return a.fuel end)

  -- senses
  api.getClosestPlayer = main(function()
    -- World.getClosestPlayer(android, 100): spectators do not count
    local best, bestD
    for _, e in ipairs(mob.entities()) do
      if e.player and not e.spectator and e.gamemode ~= "spectator" then
        local d = (e.x - mob.x) ^ 2 + (e.y - mob.y) ^ 2 + (e.z - mob.z) ^ 2
        if d < 100 * 100 and (not bestD or d < bestD) then best, bestD = e, d end
      end
    end
    return best and entityInfo(best) or {}
  end)

  api.getNearbyMobs = main(function(args)
    local kindOf = A.optString(1, args[1])
    local out = {}
    for _, e in ipairs(mob.entities()) do
      if inRange(e, kind.radius) and matches(e, kindOf) then out[#out + 1] = entityInfo(e) end
    end
    return out
  end)

  api.getClosestMob = main(function(args)
    local kindOf = A.optString(1, args[1])
    -- SensorModule.getClosestMobOfType measures from (x, y, x): the block's x stands in for its z
    local bx, by = mob.blockPos()
    local best, bestD
    for _, e in ipairs(mob.entities()) do
      -- TargetPredicate.DEFAULT: alive, not a spectator, and something that can take damage
      local attackable = mob.isAlive(e) and not e.spectator and e.gamemode ~= "spectator" and e.gamemode ~= "creative"
        and not e.creative and not e.invulnerable
      if attackable and inRange(e, kind.radius) and matches(e, kindOf) then
        local d = (e.x - bx) ^ 2 + (e.y - by) ^ 2 + (e.z - bx) ^ 2
        if not bestD or d < bestD then best, bestD = e, d end
      end
    end
    return best and entityInfo(best) or {}
  end)

  local solidNames = {}
  local function solidName(name)
    if name == nil then return false end
    local v = solidNames[name]
    if v == nil then
      local b = { name = name, state = {} }
      v = rules.hasCollision(b) and not rules.isLiquid(b)
      solidNames[name] = v
    end
    return v
  end

  -- Direction.stream(): down, up, north, south, west, east
  local SIX = { { 0, -1, 0 }, { 0, 1, 0 }, { 0, 0, -1 }, { 0, 0, 1 }, { -1, 0, 0 }, { 1, 0, 0 } }

  api.getBlocksOfType = main(function(args)
    local kindOf = A.string(1, args[1])
    local bx, by, bz = mob.blockPos()
    local r = kind.radius
    local ex, ey, ez = mob.x, mob.y + EYE, mob.z
    local found = {}
    local lowest = world.lowest and world.lowest() or nil
    for dy = -r, r do
      local y = by + dy
      for dx = -r, r do
        for dz = -r, r do
          local x, z = bx + dx, bz + dz
          local name = world.nameAt(x, y, z)
          if name and name:find(kindOf, 1, true) and not (lowest and y + 1 < lowest) then
            -- seen when a ray from the eyes reaches the middle of one of the open blocks around it
            for _, d in ipairs(SIX) do
              local nx, ny, nz = x + d[1], y + d[2], z + d[3]
              if not solidName(world.nameAt(nx, ny, nz)) then
                local hx, hy, hz = mob.raycast(ex, ey, ez, nx + 0.5, ny + 0.5, nz + 0.5, true)
                if hx == nil or (hx == nx and hy == ny and hz == nz) then
                  found[#found + 1] = { x = x, y = y, z = z, dx = dx, dy = dy, dz = dz }
                  break
                end
              end
            end
          end
        end
      end
    end
    -- BlockPos.iterateOutwards: nearest first by steps, then west to east, low to high, south before north
    table.sort(found, function(p, q)
      local dp, dq = abs(p.dx) + abs(p.dy) + abs(p.dz), abs(q.dx) + abs(q.dy) + abs(q.dz)
      if dp ~= dq then return dp < dq end
      if p.dx ~= q.dx then return p.dx < q.dx end
      if p.dy ~= q.dy then return p.dy < q.dy end
      return p.dz > q.dz
    end)
    local out = {}
    for i, p in ipairs(found) do out[i] = { x = p.x, y = p.y, z = p.z } end
    return out
  end)

  api.getContainerInfo = main(function(args)
    local x, y, z = posFromArgs(args)
    if not withinReach(x, y, z) then error("Position out of range", 0) end
    local inv, held = containerAt(x, y, z)
    if not inv then return {} end
    local slots = {}
    for i = 1, inv.size() do
      local item = held[i]
      slots[i] = { nameText(item), item and item.count or 0 }
    end
    return { slotCount = inv.size(), locked = false, slots = slots }
  end)

  api.storeHeldItemInContainer = main(function(args)
    local x, y, z = posFromArgs(args)
    local slot = slotArg(args)
    if not withinReach(x, y, z) then error("Position out of range", 0) end
    local inv, held = containerAt(x, y, z)
    if not inv then error("Targeted block does not have an inventory", 0) end
    checkSlot(inv, slot)
    local stack, there = a.main, held[slot + 1]
    if not there then
      held[slot + 1] = stack and copyItem(stack) or nil
      setHand("main", nil)
    elseif stack and brain.same(there, stack) then
      local transfer = min(stack.count, brain.maxOf(there) - there.count)
      there.count = there.count + transfer
      setHand("main", stack.count > transfer and copyItem(stack, stack.count - transfer) or nil)
    else
      error("There is already a item in that slot", 0)
    end
    core.dirty = true
  end)

  api.grabItemFromContainer = main(function(args)
    local x, y, z = posFromArgs(args)
    local slot = slotArg(args)
    if not withinReach(x, y, z) then error("Position out of range", 0) end
    local inv, held = containerAt(x, y, z)
    if not inv then error("Targeted block does not have an inventory", 0) end
    checkSlot(inv, slot)
    local stack, there = a.main, held[slot + 1]
    if not there then error("Slot is empty", 0) end
    if not stack then
      setHand("main", copyItem(there))
      held[slot + 1] = nil
    elseif brain.same(there, stack) then
      local transfer = min(there.count, brain.maxOf(stack) - stack.count)
      setHand("main", copyItem(stack, stack.count + transfer))
      there.count = there.count - transfer
      if there.count <= 0 then held[slot + 1] = nil end
    else
      error("Slot is blocked by item", 0)
    end
    core.dirty = true
  end)

  -- the rest
  local function hears(x, y, z)
    -- PlayerManagerMixin: androids whose box touches the speaker's box grown by 50
    return abs(x - mob.x) < 50 + 0.6 and abs(z - mob.z) < 50 + 0.6 and mob.y + HEIGHT > y - 50 and mob.y < y + 1.8 + 50
  end

  function api.sendChatMessage(...)
    local what = A.string(1, (...))
    local name = os.getComputerLabel() or "Android"
    a.chat[#a.chat + 1] = { name = name, message = what }
    while #a.chat > 32 do table.remove(a.chat, 1) end
    core.dirty = true
    -- the fake player stands where the android does, so the android hears itself
    os.queueEvent("onChatMessage", what, name, a.owner and a.owner.uuid or DEFAULT_PROFILE)
  end

  local FACES = { angry = true, annoyed = true, happy = true, sad = true, woozy = true }
  function api.changeFace(...)
    local face = A.string(1, (...))
    a.face = FACES[face] and face or "normal"
    core.dirty = true
  end

  function api.cancelTask() clearTask() end

  -- ===== the world's side =====

  mob.onInstall = function(b)
    brain, world, rules, data, items = b, b.world, b.rules, b.data, b.items
    a.main = spec.hands and brain.normItem(spec.hands.main) or nil
    a.off = spec.hands and brain.normItem(spec.hands.off) or nil
    for key, def in pairs(spec.inventory or {}) do
      local slot = tonumber(key)
      if slot and slot >= 0 and slot < STASH then a.slots[slot] = brain.normItem(def) end
    end
    local saved = core.savedState and core.savedState.addons and core.savedState.addons["cc-androids"]
    saved = saved and saved.android
    if type(saved) == "table" then
      a.fuel, a.health, a.face = saved.fuel or a.fuel, saved.health or a.health, saved.face or a.face
      a.main, a.off = brain.normItem(saved.main), brain.normItem(saved.off)
      a.slots = {}
      for key, def in pairs(saved.slots or {}) do a.slots[tonumber(key)] = brain.normItem(def) end
      if saved.x then mob.setPos(saved.x, saved.y, saved.z) end
    else
      -- a mob stands on the ground: one put in the air comes down
      local bx, by, bz = mob.blockPos()
      local ground = mob.groundBelow(bx, by, bz)
      if ground and ground ~= by then mob.setPos(mob.x, ground, mob.z) end
    end
    _G.android = api
    -- ILuaAPI.getModuleName: require("android") gives the same table
    local registry = debug and debug.getregistry and debug.getregistry()
    if type(registry) == "table" and type(registry._LOADED) == "table" then registry._LOADED.android = api end
    brain.refreshPeripherals(true)

    -- chat a player types within 50 blocks reaches the android (PlayerManagerMixin)
    local chat = core.handlers.chat
    core.handlers.chat = function(cmd)
      local p = core.findPlayer(cmd.player)
      if p and p.online and type(cmd.message) == "string" and hears(p.x, p.y, p.z) then
        os.queueEvent("onChatMessage", cmd.message, p.name, p.uuid)
      end
      return chat(cmd)
    end
  end

  M.state = function()
    local slots = {}
    for i = 0, STASH - 1 do if a.slots[i] then slots[tostring(i)] = a.slots[i] end end
    local entities = {}
    for i, e in ipairs(world and world.entities or {}) do
      entities[i] = {
        uuid = e.uuid, type = e.type, x = e.x, y = e.y, z = e.z, health = e.health, leashedTo = e.leashedTo,
        interactions = e.interactions,
      }
    end
    return {
      android = {
        type = a.kind, x = mob.x, y = mob.y, z = mob.z, fuel = a.fuel, health = a.health, face = a.face,
        main = a.main, off = a.off, slots = slots, task = task and task.name or "idle",
        target = task and (task.entity and task.entity.uuid or { x = task.x, y = task.y, z = task.z }) or nil,
        interactions = a.interactions, chat = a.chat,
      },
      entities = entities,
    }
  end

  -- ===== sim commands =====

  local function itemArg(cmd)
    if cmd.item == nil or cmd.item == false then return nil end
    if type(cmd.item) == "string" then return brain.normItem({ name = cmd.item, count = cmd.count or 1 }) end
    return brain.normItem(cmd.item)
  end

  M.handlers = {
    --- { hand = "main" | "off", item = <item> | null }: what a sneaking player's click swaps into the hand
    androidSetHand = function(cmd)
      local hand = cmd.hand or "main"
      if hand ~= "main" and hand ~= "off" then return false, "hand must be main or off" end
      setHand(hand, itemArg(cmd))
      return true
    end,
    --- { slot = 0..8, item = <item> | null }
    androidSetSlot = function(cmd)
      if type(cmd.slot) ~= "number" or cmd.slot < 0 or cmd.slot >= STASH then return false, "slot must be 0 to 8" end
      a.slots[floor(cmd.slot)] = itemArg(cmd)
      core.dirty = true
      return true
    end,
    --- { fuel = n }
    androidSetFuel = function(cmd)
      if type(cmd.fuel) ~= "number" then return false, "fuel must be a number" end
      a.fuel = max(0, min(MAX_FUEL, floor(cmd.fuel)))
      core.dirty = true
      return true
    end,
    --- { health = n }
    androidSetHealth = function(cmd)
      if type(cmd.health) ~= "number" then return false, "health must be a number" end
      a.health = max(0, min(maxHealth, cmd.health))
      core.dirty = true
      return true
    end,
    --- { x, y, z }: pick the android up and put it down somewhere else
    androidTeleport = function(cmd)
      if type(cmd.x) ~= "number" or type(cmd.y) ~= "number" or type(cmd.z) ~= "number" then return false, "x, y and z are needed" end
      local whole = cmd.x == floor(cmd.x) and cmd.z == floor(cmd.z)
      nav = nil
      mob.setPos(cmd.x + (whole and 0.5 or 0), cmd.y, cmd.z + (whole and 0.5 or 0))
      return true
    end,
  }
  for name, handler in pairs(mob.handlers) do M.handlers[name] = handler end
  mob.synced(api)
  mob.synced(M.handlers)

  return M
end
