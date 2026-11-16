-- ccsim turtle living world: the parts of a block world that move on their own (vanilla 1.18.2).
--
--   water and lava    FlowingFluid: sources and flowing levels, water every 5 ticks, lava every 30 (10 in the nether),
--                     and the lava and water reactions (obsidian, cobblestone, stone)
--   random ticks      crops, nether wart, stems (and their fruit), sugar cane, saplings, farmland; randomTickSpeed 3
--   bone meal         crops grow, a sapling becomes a basic tree
--   furnaces          furnace, blast furnace and smoker: burn times and the recipes of the jars (data/_cooking.lua)
--   hoppers           one item every 8 ticks, between containers and from dropped items above
--   dropped items     merge when they share a block, despawn after 6000 ticks
--
-- Nothing here runs on a timer of its own. The world is caught up to the server tick (the 50 ms grid the turtle's
-- command queue runs on) whenever something looks at it or changes it: before each turtle command, before every
-- peripheral call, and before a block is set. The catch-up walks the ticks in order and jumps over the quiet ones, so
-- a day passes in a moment. All randomness comes from one generator seeded by world.seed, so a run repeats.
-- Moving mobs are not simulated (docs/conformance/emulator-vs-real-deviations.md, row 66).
return function(core, ctx)
  local M = {}
  local world, rules, data, items = ctx.world, ctx.rules, ctx.data, ctx.items
  local blockAt, inventoryOf, nowTick = ctx.blockAt, ctx.inventoryOf, ctx.nowTick
  local floor, min, max = math.floor, math.min, math.max

  -- Only the main computer of a world runs it: a computer block started by the host gets the blocks as they are
  -- and the changes the main computer relays
  local enabled = core.world.placed == nil
  M.enabled = enabled

  local rules0 = core.world.gameRules or {}
  local randomTickSpeed = tonumber(rules0.randomTickSpeed) or 3
  local DESPAWN = 6000
  local MERGE_EVERY = 40
  local HOPPER_COOLDOWN = 8
  local MAX_STEPS = 4000000

  -- ===== random numbers (one stream, seeded by the world) =====

  local rngState = ((floor(tonumber(core.world.seed) or 0) * 7919 + 12345) % 2147483646) + 1
  local function rnd()
    rngState = rngState * 48271 % 2147483647
    return rngState
  end
  local function nextInt(n) return rnd() % n end
  local function nextFloat() return rnd() / 2147483647 end
  M.nextInt, M.nextFloat = nextInt, nextFloat

  local function dim() return core.position.dimension or "minecraft:overworld" end
  local function key(x, y, z) return x .. "," .. y .. "," .. z end

  -- ===== the event queue: a binary heap of { tick, seq, kind, ... } =====

  local heap, heapN, seq = {}, 0, 0
  local function before(a, b) return a[1] < b[1] or (a[1] == b[1] and a[2] < b[2]) end
  local function push(tick, kind, a, b, c)
    seq = seq + 1
    heapN = heapN + 1
    local e = { tick, seq, kind, a, b, c }
    local i = heapN
    heap[i] = e
    while i > 1 do
      local p = floor(i / 2)
      if before(heap[i], heap[p]) then heap[i], heap[p] = heap[p], heap[i] i = p else break end
    end
  end
  local function pop()
    local top = heap[1]
    heap[1] = heap[heapN]
    heap[heapN] = nil
    heapN = heapN - 1
    local i = 1
    while true do
      local l, r, s = i * 2, i * 2 + 1, i
      if l <= heapN and before(heap[l], heap[s]) then s = l end
      if r <= heapN and before(heap[r], heap[s]) then s = r end
      if s == i then break end
      heap[i], heap[s] = heap[s], heap[i]
      i = s
    end
    return top
  end

  local last = 0   -- the last tick the world has been run to
  local cur = 0    -- the tick being run (last, outside a catch-up)
  local busy = false

  -- ===== helpers =====

  local function copyItem(item, count)
    local c = {}
    for k, v in pairs(item) do c[k] = v end
    c.count = count or item.count
    return c
  end
  local function sameItem(a, b)
    return a.name == b.name and a.nbt == b.nbt and a.displayName == b.displayName and a.damage == b.damage
  end
  local function limitOf(item) return min(item.maxCount or items.maxCount(item.name), 64) end

  local function isAir(b) return b == nil or rules.isAir(b) end
  local function set(x, y, z, b) world.set(x, y, z, b) end
  local function mk(name, state) return world.newBlock({ name = name, state = state }) end

  local HORIZ = { { 0, -1, "north" }, { 1, 0, "east" }, { 0, 1, "south" }, { -1, 0, "west" } }
  local SIX = { { 0, -1, 0 }, { 0, 1, 0 }, { 0, 0, -1 }, { 0, 0, 1 }, { -1, 0, 0 }, { 1, 0, 0 } }

  -- ===== water and lava (FlowingFluid, LiquidBlock, WaterFluid, LavaFluid) =====

  local WATER, LAVA = "minecraft:water", "minecraft:lava"

  --- The fluid in a block: kind, source?, amount (8 for a source or a falling column), falling?
  local function fluidOf(b)
    if not b then return nil end
    local n = b.name
    if n ~= WATER and n ~= LAVA then return nil end
    local level = tonumber(b.state.level) or 0
    if level == 0 then return n, true, 8, false end
    return n, false, 8 - (level % 8), level >= 8
  end

  local function fluidBlock(kind, f)
    local level = 0
    if not f.source then level = 8 - min(f.amount, 8) + (f.falling and 8 or 0) end
    return mk(kind, { level = tostring(level) })
  end

  local function tickDelay(kind)
    if kind == WATER then return 5 end
    return dim() == "minecraft:the_nether" and 10 or 30
  end
  local function dropOff(kind)
    if kind == WATER then return 1 end
    return dim() == "minecraft:the_nether" and 1 or 2
  end
  local function slopeFind(kind)
    if kind == WATER then return 4 end
    return dim() == "minecraft:the_nether" and 4 or 2
  end

  -- Blocks a fluid cannot flow into even though they have no collision (doors, signs, ladders, reeds, kelp ...)
  local function blocksFluid(b)
    local n = b.name
    return n:find("_door$") ~= nil or n:find("_sign$") ~= nil or n == "minecraft:ladder" or n == "minecraft:sugar_cane"
      or n == "minecraft:kelp" or n == "minecraft:kelp_plant" or n == "minecraft:seagrass" or n == "minecraft:tall_seagrass"
      or n == "minecraft:bubble_column" or n:find("_portal$") ~= nil
  end

  --- canHoldFluid: air, another fluid, or a block without a collision shape that is not one of the exceptions
  local function canHold(b)
    if isAir(b) then return true end
    if rules.isLiquid(b) then return true end
    return not rules.hasCollision(b) and not blocksFluid(b)
  end

  local pendingFluid = {} -- "x,y,z" -> tick of its scheduled fluid tick
  local function scheduleFluid(x, y, z, kind)
    local k = key(x, y, z)
    if pendingFluid[k] then return end
    local at = cur + tickDelay(kind)
    pendingFluid[k] = at
    push(at, "f", x, y, z)
  end

  local function sourcesAround(kind, x, y, z)
    local n = 0
    for _, d in ipairs(HORIZ) do
      local k2, src = fluidOf(blockAt(x + d[1], y, z + d[2]))
      if k2 == kind and src then n = n + 1 end
    end
    return n
  end

  --- getNewLiquid: what the fluid at x,y,z becomes: { source }, { amount, falling } or nil for empty
  local function newLiquid(kind, x, y, z)
    local highest, sources = 0, 0
    for _, d in ipairs(HORIZ) do
      local k2, src, amount = fluidOf(blockAt(x + d[1], y, z + d[2]))
      if k2 == kind then
        if src then sources = sources + 1 end
        highest = max(highest, amount)
      end
    end
    if kind == WATER and sources >= 2 then
      local below = blockAt(x, y - 1, z)
      local bk, bsrc = fluidOf(below)
      if (below and not bk and rules.hasCollision(below)) or (bk == kind and bsrc) then
        return { source = true, amount = 8, falling = false }
      end
    end
    local ak = fluidOf(blockAt(x, y + 1, z))
    if ak == kind then return { source = false, amount = 8, falling = true } end
    local amount = highest - dropOff(kind)
    if amount <= 0 then return nil end
    return { source = false, amount = amount, falling = false }
  end

  --- A neighbour a fluid of `kind` could pass through (not a source of its own kind, and able to hold it)
  local function passable(kind, x, y, z)
    local b = blockAt(x, y, z)
    local k2, src = fluidOf(b)
    if k2 == kind and src then return false end
    return canHold(b)
  end

  local function isHole(kind, x, y, z) -- isWaterHole: the block at x,y,z lets the fluid fall further
    local b = blockAt(x, y, z)
    if fluidOf(b) == kind then return true end
    return canHold(b)
  end

  local function slopeDistance(kind, x, y, z, depth, fromIdx)
    local best = 1000
    for i, d in ipairs(HORIZ) do
      if i ~= fromIdx then
        local nx, nz = x + d[1], z + d[2]
        if passable(kind, nx, y, nz) then
          if isHole(kind, nx, y - 1, nz) then return depth end
          if depth < slopeFind(kind) then
            local j = slopeDistance(kind, nx, y, nz, depth + 1, (i + 1) % 4 + 1)
            if j < best then best = j end
          end
        end
      end
    end
    return best
  end

  --- canSpreadTo: only into a block that holds no fluid, or lava falling onto water (which becomes stone)
  local function canSpread(kind, x, y, z, down)
    local b = blockAt(x, y, z)
    local k2 = fluidOf(b)
    if k2 then return down and kind == LAVA and k2 == WATER end
    return canHold(b)
  end

  local function spreadTo(kind, x, y, z, f, down)
    local b = blockAt(x, y, z)
    local k2 = fluidOf(b)
    if k2 == WATER and kind == LAVA and down then
      set(x, y, z, mk("minecraft:stone")) -- LavaFluid.spreadTo: lava meets water below it
      return
    end
    set(x, y, z, fluidBlock(kind, f))
  end

  local function spreadSides(kind, x, y, z, amount, falling)
    local i = falling and 7 or (amount - dropOff(kind))
    if i <= 0 then return end
    local best, chosen = 1000, {}
    for idx, d in ipairs(HORIZ) do
      local nx, nz = x + d[1], z + d[2]
      if passable(kind, nx, y, nz) then
        local f = newLiquid(kind, nx, y, nz)
        if f then
          local j
          if isHole(kind, nx, y - 1, nz) then j = 0 else j = slopeDistance(kind, nx, y, nz, 1, (idx + 1) % 4 + 1) end
          if j < best then best = j chosen = {} end
          if j <= best then chosen[#chosen + 1] = { nx, nz, f } end
        end
      end
    end
    for _, c in ipairs(chosen) do
      if canSpread(kind, c[1], y, c[2], false) then spreadTo(kind, c[1], y, c[2], c[3], false) end
    end
  end

  local function spread(kind, x, y, z, source, amount, falling)
    local below = newLiquid(kind, x, y - 1, z)
    if below and canSpread(kind, x, y - 1, z, true) then
      spreadTo(kind, x, y - 1, z, below, true)
      if sourcesAround(kind, x, y, z) >= 3 then spreadSides(kind, x, y, z, amount, falling) end
    elseif source or not isHole(kind, x, y - 1, z) then
      spreadSides(kind, x, y, z, amount, falling)
    end
  end

  local function fluidTick(x, y, z)
    local b = blockAt(x, y, z)
    local kind, source, amount, falling = fluidOf(b)
    if not kind then return end
    if not source then
      local nb = newLiquid(kind, x, y, z)
      if not nb then
        set(x, y, z, nil)
        return
      end
      if nb.source ~= source or nb.amount ~= amount or nb.falling ~= falling then
        source, amount, falling = nb.source, nb.amount, nb.falling
        set(x, y, z, fluidBlock(kind, nb))
      end
    end
    spread(kind, x, y, z, source, amount, falling)
  end

  --- LiquidBlock.shouldSpreadLiquid: lava next to or under water turns to obsidian (a source) or cobblestone
  local function lavaReacts(x, y, z)
    local b = blockAt(x, y, z)
    local kind, source = fluidOf(b)
    if kind ~= LAVA then return false end
    for _, d in ipairs(SIX) do
      if d[2] >= 0 then -- not the block below
        local k2 = fluidOf(blockAt(x + d[1], y + d[2], z + d[3]))
        if k2 == WATER then
          set(x, y, z, mk(source and "minecraft:obsidian" or "minecraft:cobblestone"))
          return true
        end
      end
    end
    return false
  end

  -- ===== crops and other random ticks =====

  local randReg = {}   -- "x,y,z" -> { x, y, z, kind, nextAt }

  local tagCache = {} -- block name -> "crop" | "sapling" | false (the tag lookups are slow)
  local function randomKind(b)
    if not b then return nil end
    local n = b.name
    if n == "minecraft:farmland" then return "farmland" end
    if n == "minecraft:nether_wart" then return "wart" end
    if n == "minecraft:sugar_cane" then return "cane" end
    if n == "minecraft:melon_stem" or n == "minecraft:pumpkin_stem" then return "stem" end
    local tagged = tagCache[n]
    if tagged == nil then
      tagged = data.blockHasTag(n, "minecraft:crops") and "crop" or (data.blockHasTag(n, "minecraft:saplings") and "sapling" or false)
      tagCache[n] = tagged
    end
    if tagged == "crop" and b.state.age then return "crop" end
    if tagged == "sapling" and b.state.stage then return "sapling" end
    return nil
  end

  local function geometric()
    local p = min(1, randomTickSpeed / 4096)
    if p >= 1 then return 1 end
    local u = (rnd() + 1) / 2147483648
    return floor(math.log(u) / math.log(1 - p)) + 1
  end

  local function registerRandom(x, y, z, b)
    local k = key(x, y, z)
    local kind = randomKind(b)
    if not kind or randomTickSpeed <= 0 then
      randReg[k] = nil
      return
    end
    local reg = randReg[k]
    if reg and reg.kind == kind then return end
    reg = { x = x, y = y, z = z, kind = kind, nextAt = cur + geometric() }
    randReg[k] = reg
    push(reg.nextAt, "r", k)
  end

  local LIGHT = {
    torch = 14, wall_torch = 14, lantern = 15, glowstone = 15, sea_lantern = 15, shroomlight = 15, jack_o_lantern = 15,
    lava = 15, campfire = 15, redstone_lamp = 15, end_rod = 14, beacon = 15, ochre_froglight = 15, verdant_froglight = 15,
    pearlescent_froglight = 15, soul_torch = 10, soul_wall_torch = 10, soul_lantern = 10, soul_campfire = 10,
    fire = 15, magma_block = 3, glow_lichen = 7, sea_pickle = 6, redstone_torch = 7,
  }
  local function lightOf(b)
    if not b then return 0 end
    local plain = b.name:match("^minecraft:(.+)$")
    local l = plain and LIGHT[plain] or 0
    if (plain == "campfire" or plain == "soul_campfire" or plain == "redstone_lamp") and b.state.lit == "false" then return 0 end
    return l
  end

  --- Light of 9 or more at a block: open sky overhead (every tick is daytime here) or a light source near enough
  local function brightEnough(x, y, z)
    local _, hi = world.limits(dim())
    local open = true
    for yy = y + 1, min(hi, y + 32) do
      local b = blockAt(x, yy, z)
      if b and rules.hasCollision(b) then open = false break end
    end
    if open then return true end
    for dx = -6, 6 do
      for dy = -6, 6 do
        for dz = -6, 6 do
          local dist = math.abs(dx) + math.abs(dy) + math.abs(dz)
          if dist <= 6 then
            local l = lightOf(blockAt(x + dx, y + dy, z + dz))
            if l - dist >= 9 then return true end
          end
        end
      end
    end
    return false
  end

  local function maxAge(b)
    local values = (data.blockProperties(b.name) or {}).age or { "7" }
    local top = 0
    for _, v in ipairs(values) do top = max(top, tonumber(v) or 0) end
    return top
  end

  --- CropBlock.getGrowthSpeed
  local function growthSpeed(b, x, y, z)
    local f = 1.0
    for i = -1, 1 do
      for j = -1, 1 do
        local f1 = 0.0
        local s = blockAt(x + i, y - 1, z + j)
        if s and s.name == "minecraft:farmland" then
          f1 = 1.0
          if (tonumber(s.state.moisture) or 0) > 0 then f1 = 3.0 end
        end
        if i ~= 0 or j ~= 0 then f1 = f1 / 4 end
        f = f + f1
      end
    end
    local function is(dx, dz)
      local o = blockAt(x + dx, y, z + dz)
      return o ~= nil and o.name == b.name
    end
    local flag = is(-1, 0) or is(1, 0)
    local flag1 = is(0, -1) or is(0, 1)
    if flag and flag1 then
      f = f / 2
    elseif is(-1, -1) or is(1, -1) or is(1, 1) or is(-1, 1) then
      f = f / 2
    end
    return f
  end

  local function growsThisTick(b, x, y, z)
    local f = growthSpeed(b, x, y, z)
    return nextInt(floor(25.0 / f) + 1) == 0
  end

  local SOIL = {
    ["minecraft:farmland"] = true, ["minecraft:dirt"] = true, ["minecraft:grass_block"] = true,
    ["minecraft:coarse_dirt"] = true, ["minecraft:podzol"] = true, ["minecraft:rooted_dirt"] = true,
    ["minecraft:mycelium"] = true, ["minecraft:moss_block"] = true,
  }

  local function waterNear(x, y, z)
    for dx = -4, 4 do
      for dz = -4, 4 do
        for dy = 0, 1 do
          local b = blockAt(x + dx, y + dy, z + dz)
          if b and b.name == WATER then return true end
        end
      end
    end
    return false
  end

  -- advanceTree and the tree itself (TreeFeature, StraightTrunkPlacer, BlobFoliagePlacer), written below
  local growTree

  local function randomTick(reg, b)
    local x, y, z, kind = reg.x, reg.y, reg.z, reg.kind
    if kind == "crop" then
      if not brightEnough(x, y, z) then return end
      local age = tonumber(b.state.age) or 0
      if age >= maxAge(b) then return end
      if b.name == "minecraft:beetroots" and nextInt(3) ~= 0 then return end
      if growsThisTick(b, x, y, z) then
        b.state.age = tostring(age + 1)
        set(x, y, z, b)
      end
    elseif kind == "wart" then
      local age = tonumber(b.state.age) or 0
      if age < 3 and nextInt(10) == 0 then
        b.state.age = tostring(age + 1)
        set(x, y, z, b)
      end
    elseif kind == "stem" then
      if not brightEnough(x, y, z) then return end
      if not growsThisTick(b, x, y, z) then return end
      local age = tonumber(b.state.age) or 0
      if age < 7 then
        b.state.age = tostring(age + 1)
        set(x, y, z, b)
      else
        local d = HORIZ[nextInt(4) + 1]
        local fx, fz = x + d[1], z + d[2]
        local fruit = b.name == "minecraft:melon_stem" and "minecraft:melon" or "minecraft:pumpkin"
        local soil = blockAt(fx, y - 1, fz)
        if isAir(blockAt(fx, y, fz)) and soil and SOIL[soil.name] then
          set(fx, y, fz, mk(fruit))
          local attached = b.name == "minecraft:melon_stem" and "minecraft:attached_melon_stem" or "minecraft:attached_pumpkin_stem"
          set(x, y, z, mk(attached, { facing = d[3] }))
        end
      end
    elseif kind == "cane" then
      if isAir(blockAt(x, y + 1, z)) then
        local h = 1
        while h < 3 do
          local below = blockAt(x, y - h, z)
          if below and below.name == b.name then h = h + 1 else break end
        end
        if h < 3 then
          local age = tonumber(b.state.age) or 0
          if age == 15 then
            set(x, y + 1, z, mk(b.name))
            b.state.age = "0"
            set(x, y, z, b)
          else
            b.state.age = tostring(age + 1)
            set(x, y, z, b)
          end
        end
      end
    elseif kind == "sapling" then
      if brightEnough(x, y + 1, z) and nextInt(7) == 0 then
        if (tonumber(b.state.stage) or 0) == 0 then
          b.state.stage = "1"
          set(x, y, z, b)
        else
          growTree(b, x, y, z)
        end
      end
    elseif kind == "farmland" then
      local moisture = tonumber(b.state.moisture) or 0
      if waterNear(x, y, z) then
        if moisture < 7 then
          b.state.moisture = "7"
          set(x, y, z, b)
        end
      elseif moisture > 0 then
        b.state.moisture = tostring(moisture - 1)
        set(x, y, z, b)
      else
        local above = blockAt(x, y + 1, z)
        local keeps = above and (data.blockHasTag(above.name, "minecraft:crops") or above.name:find("_stem$") ~= nil)
        if not keeps then set(x, y, z, mk("minecraft:dirt")) end
      end
    end
  end

  -- ===== trees =====

  local TREES = {
    oak = { log = "minecraft:oak_log", leaves = "minecraft:oak_leaves", base = 4, rand = 2 },
    birch = { log = "minecraft:birch_log", leaves = "minecraft:birch_leaves", base = 5, rand = 2 },
    jungle = { log = "minecraft:jungle_log", leaves = "minecraft:jungle_leaves", base = 4, rand = 8 },
    -- spruce and acacia are drawn as the same round tree with their own wood
    spruce = { log = "minecraft:spruce_log", leaves = "minecraft:spruce_leaves", base = 5, rand = 2 },
    acacia = { log = "minecraft:acacia_log", leaves = "minecraft:acacia_leaves", base = 5, rand = 2 },
  }

  local function treeFree(b)
    if isAir(b) then return true end
    if rules.isLiquid(b) then return false end
    if b.name:find("_leaves$") then return true end
    return rules.isReplaceable(b)
  end

  growTree = function(b, x, y, z)
    local species = b.name:match("^minecraft:(%a+)_sapling$")
    local tree = species and TREES[species]
    if not tree then return false end -- dark oak needs a 2 x 2 patch, the rest are not basic trees
    local height = tree.base + nextInt(tree.rand + 1)
    -- the sapling goes first; the tree must find its column (and a ring of one around it) free
    set(x, y, z, nil)
    local fits = true
    for yy = 0, height + 1 do
      local r = yy < 1 and 0 or 1
      for dx = -r, r do
        for dz = -r, r do
          if not treeFree(blockAt(x + dx, y + yy, z + dz)) then fits = false end
        end
      end
    end
    if not fits then
      set(x, y, z, b)
      return false
    end
    local ground = blockAt(x, y - 1, z)
    if ground and (ground.name == "minecraft:grass_block" or ground.name == "minecraft:podzol" or ground.name == "minecraft:mycelium") then
      set(x, y - 1, z, mk("minecraft:dirt"))
    end
    local placed = {} -- key -> { x, y, z, log? }
    local function put(px, py, pz, block, isLog)
      set(px, py, pz, block)
      placed[key(px, py, pz)] = { px, py, pz, isLog }
    end
    for i = 0, height - 1 do put(x, y + i, z, mk(tree.log, { axis = "y" }), true) end
    local top = y + height
    for i = 0, -3, -1 do
      local j = max(2 - 1 - (i >= 0 and floor(i / 2) or -floor(-i / 2)), 0)
      for dx = -j, j do
        for dz = -j, j do
          local skip = math.abs(dx) == j and math.abs(dz) == j and (nextInt(2) == 0 or i == 0)
          if not skip then
            local px, py, pz = x + dx, top + i, z + dz
            local here = blockAt(px, py, pz)
            if treeFree(here) and not (here and here.name:find("_leaves$")) and not placed[key(px, py, pz)] then
              put(px, py, pz, mk(tree.leaves, { persistent = "false", distance = "7" }), false)
            end
          end
        end
      end
    end
    -- LeavesBlock distance: steps to the nearest log through leaves, at most 7
    local dist, queue = {}, {}
    for k, p in pairs(placed) do
      if p[4] then dist[k] = 0 queue[#queue + 1] = p end
    end
    local qi = 1
    while queue[qi] do
      local p = queue[qi]
      qi = qi + 1
      local d = dist[key(p[1], p[2], p[3])]
      for _, s in ipairs(SIX) do
        local nk = key(p[1] + s[1], p[2] + s[2], p[3] + s[3])
        local q = placed[nk]
        if q and not q[4] and dist[nk] == nil and d + 1 <= 7 then
          dist[nk] = d + 1
          queue[#queue + 1] = q
        end
      end
    end
    for k, p in pairs(placed) do
      if not p[4] then
        local leaf = blockAt(p[1], p[2], p[3])
        if leaf then
          leaf.state.distance = tostring(dist[k] or 7)
          set(p[1], p[2], p[3], leaf)
        end
      end
    end
    return true
  end

  --- Bone meal on the block at x,y,z. Returns true when it was a valid target (the meal is used up).
  function M.boneMeal(b, x, y, z)
    if not enabled then return false end
    M.catchUp()
    local kind = randomKind(b)
    if kind == "crop" or kind == "stem" then
      local top = maxAge(b)
      local age = tonumber(b.state.age) or 0
      if age >= top then return false end
      local inc = b.name == "minecraft:beetroots" and 1 or (2 + nextInt(4))
      b.state.age = tostring(min(top, age + inc))
      set(x, y, z, b)
      return true
    elseif kind == "sapling" then
      if nextFloat() < 0.45 then
        if (tonumber(b.state.stage) or 0) == 0 then
          b.state.stage = "1"
          set(x, y, z, b)
        else
          growTree(b, x, y, z)
        end
      end
      return true
    end
    return false
  end

  -- ===== furnaces (AbstractFurnaceBlockEntity.serverTick) =====

  local FURNACE_TYPE = {
    ["minecraft:furnace"] = "smelting", ["minecraft:blast_furnace"] = "blasting", ["minecraft:smoker"] = "smoking",
  }

  local cooking -- type -> { byItem = { id -> recipe }, byTag = { { tag, recipe } } }
  local function loadCooking()
    cooking = { smelting = { byItem = {}, byTag = {} }, blasting = { byItem = {}, byTag = {} },
      smoking = { byItem = {}, byTag = {} }, campfire_cooking = { byItem = {}, byTag = {} } }
    local fn = loadfile("/rom/ccsim/turtle/data/_cooking.lua", "t", {})
    local all = fn and fn().cooking or {}
    for id, r in pairs(((core.world.gameData or {}).cooking) or {}) do all[id] = r ~= false and r or nil end
    local ids = {}
    for id in pairs(all) do ids[#ids + 1] = id end
    -- the vanilla recipe wins when a mod cooks the same thing, then by id
    table.sort(ids, function(a, b)
      local am, bm = a:find("^minecraft:") ~= nil, b:find("^minecraft:") ~= nil
      if am ~= bm then return am end
      return a < b
    end)
    for _, id in ipairs(ids) do
      local r = all[id]
      local t = cooking[r.type]
      if t then
        for _, alt in ipairs(r.ingredient or {}) do
          if alt.item then
            if not t.byItem[alt.item] then t.byItem[alt.item] = r end
          elseif alt.tag then
            t.byTag[#t.byTag + 1] = { alt.tag, r }
          end
        end
      end
    end
  end

  --- The recipe a furnace of this kind has for an item: { result, time } or nil
  local function recipeFor(furnaceName, item)
    if not cooking then loadCooking() end
    local t = cooking[FURNACE_TYPE[furnaceName]]
    if not t then return nil end
    local r = t.byItem[item.name]
    if r then return r end
    for _, entry in ipairs(t.byTag) do
      if data.itemHasTag(item.name, entry[1]) then return entry[2] end
    end
    return nil
  end
  M.recipeFor = recipeFor

  local function canBurn(recipe, st)
    if not st[1] or not recipe then return false end
    local out = st[3]
    if not out then return true end
    if out.name ~= recipe.result or out.nbt ~= nil then return false end
    return out.count + 1 <= limitOf(out)
  end

  local owned = setmetatable({}, { __mode = "k" }) -- blocks whose blockEntity table is this module's own copy
  local function entityOf(b)
    local be = {}
    for k, v in pairs(b.blockEntity or {}) do be[k] = v end
    b.blockEntity = be
    return be
  end

  local function furnaceTick(x, y, z, b)
    local inv = inventoryOf(b)
    if not inv then return false end
    local st = inv.__state()
    local be = b.blockEntity
    if not be or not owned[b] then
      be = entityOf(b)
      owned[b] = true
    end
    local burn = be.BurnTime or 0
    local wasLit = burn > 0
    local touched = false
    if wasLit then burn = burn - 1 end
    local lit = burn > 0
    local input, fuel = st[1], st[2]
    local active = wasLit
    if lit or (fuel and input) then
      local recipe = input and recipeFor(b.name, input)
      if not lit and canBurn(recipe, st) then
        local bt = fuel and items.burnTime(fuel.name) or 0
        burn = bt
        if burn > 0 then
          fuel.count = fuel.count - 1
          if fuel.count <= 0 then
            local rem = items.burnRemainder(fuel.name)
            st[2] = rem and { name = rem, count = 1 } or nil
          end
          touched = true
        end
      end
      if burn > 0 and canBurn(recipe, st) then
        active = true
        local progress = (be.CookTime or 0) + 1
        be.CookTimeTotal = recipe.time
        if progress >= recipe.time then
          progress = 0
          input.count = input.count - 1
          if input.count <= 0 then st[1] = nil end
          if st[3] then st[3].count = st[3].count + 1 else st[3] = { name = recipe.result, count = 1 } end
          touched = true
        end
        be.CookTime = progress
      else
        be.CookTime = 0
      end
    elseif (be.CookTime or 0) > 0 then
      be.CookTime = max(0, min(be.CookTime - 2, be.CookTimeTotal or 0))
      active = true
    end
    be.BurnTime = burn
    local isLit = burn > 0
    if isLit ~= wasLit then
      b.state.lit = isLit and "true" or "false"
      touched = true
    end
    if touched then set(x, y, z, b) end
    return active or isLit
  end

  -- ===== hoppers (HopperBlockEntity) =====

  local function furnaceSlots(b, face)
    if FURNACE_TYPE[b.name] then
      if face == "up" then return { 1 } elseif face == "down" then return { 3, 2 } else return { 2 } end
    end
    return nil
  end

  local function mayPlace(b, slot, item)
    if FURNACE_TYPE[b.name] then
      if slot == 3 then return false end
      if slot == 2 then return items.burnTime(item.name) > 0 or item.name == "minecraft:bucket" end
    end
    return true
  end

  local function mayTake(b, slot, item)
    if FURNACE_TYPE[b.name] and slot == 2 then return item.name == "minecraft:bucket" end
    return true
  end

  local hopperRec = {} -- "x,y,z" -> { cd, lastTick }

  --- Put as much of `stack` as fits into a container through `face`; returns what is left (count)
  local function insertInto(b, inv, face, stack)
    local st = inv.__state()
    local slots = furnaceSlots(b, face)
    if not slots then
      slots = {}
      for i = 1, inv.size() do slots[i] = i end
    end
    local left = stack.count
    for _, s in ipairs(slots) do
      if left <= 0 then break end
      if mayPlace(b, s, stack) then
        local here = st[s]
        local limit = limitOf(stack)
        if not here then
          local n = min(left, limit)
          st[s] = copyItem(stack, n)
          left = left - n
        elseif sameItem(here, stack) and here.count < limit then
          local n = min(left, limit - here.count)
          here.count = here.count + n
          left = left - n
        end
      end
    end
    return left
  end

  local function hopperEmpty(inv)
    local st = inv.__state()
    for i = 1, inv.size() do if st[i] then return false end end
    return true
  end

  local function hopperFull(inv)
    local st = inv.__state()
    for i = 1, inv.size() do
      local it = st[i]
      if not it or it.count < limitOf(it) then return false end
    end
    return true
  end

  local OPPOSITE = { north = "south", south = "north", east = "west", west = "east", up = "down", down = "up" }
  local STEP = { north = { 0, 0, -1 }, south = { 0, 0, 1 }, east = { 1, 0, 0 }, west = { -1, 0, 0 }, up = { 0, 1, 0 }, down = { 0, -1, 0 } }

  local function touch(x, y, z, b) set(x, y, z, b) end

  local function hopperTick(x, y, z, b, rec)
    rec.cd = (rec.cd or 0) - 1
    rec.lastTick = cur
    if rec.cd > 0 then return true end
    rec.cd = 0
    if b.state.enabled == "false" then return false end
    local inv = inventoryOf(b)
    if not inv then return false end
    local st = inv.__state()
    local moved = false
    -- ejectItems: the first item that fits in the container the hopper faces
    if not hopperEmpty(inv) then
      local facing = b.state.facing or "down"
      local d = STEP[facing] or STEP.down
      local tx, ty, tz = x + d[1], y + d[2], z + d[3]
      local tb = blockAt(tx, ty, tz)
      local tinv = tb and inventoryOf(tb)
      if tinv and not (tb.name == "minecraft:hopper" and hopperFull(tinv)) then
        for slot = 1, inv.size() do
          local it = st[slot]
          if it then
            local wasEmpty = hopperEmpty(tinv)
            local one = copyItem(it, 1)
            local left = insertInto(tb, tinv, OPPOSITE[facing], one)
            if left <= 0 then
              it.count = it.count - 1
              if it.count <= 0 then st[slot] = nil end
              moved = true
              if tb.name == "minecraft:hopper" and wasEmpty then
                local r = hopperRec[key(tx, ty, tz)]
                if r and (r.cd or 0) <= 0 then r.cd = (r.lastTick == cur) and (HOPPER_COOLDOWN - 1) or HOPPER_COOLDOWN end
              end
              touch(tx, ty, tz, tb)
              break
            end
          end
        end
      end
    end
    -- suckInItems: one item from the container above, or the dropped items in the block above
    if not hopperFull(inv) then
      local ab = blockAt(x, y + 1, z)
      local ainv = ab and inventoryOf(ab)
      if ainv then
        local ast = ainv.__state()
        local slots = furnaceSlots(ab, "down")
        if not slots then
          slots = {}
          for i = 1, ainv.size() do slots[i] = i end
        end
        for _, s in ipairs(slots) do
          local it = ast[s]
          if it and mayTake(ab, s, it) then
            local left = insertInto(b, inv, "up", copyItem(it, 1))
            if left <= 0 then
              it.count = it.count - 1
              if it.count <= 0 then ast[s] = nil end
              touch(x, y + 1, z, ab)
              moved = true
              break
            end
          end
        end
      elseif not (ab and rules.hasCollision(ab)) then
        local list = world.itemEntities
        for i = 1, #list do
          local e = list[i]
          if e and floor(e.x) == x and floor(e.y) == y + 1 and floor(e.z) == z then
            local left = insertInto(b, inv, "up", copyItem(e.item))
            if left <= 0 then
              table.remove(list, i)
              moved = true
              core.dirty = true
              break
            elseif left < e.item.count then
              e.item.count = left
              core.dirty = true
            end
          end
        end
      end
    end
    if moved then
      rec.cd = HOPPER_COOLDOWN
      touch(x, y, z, b)
    end
    return moved or rec.cd > 0
  end

  -- ===== block entities in key order =====

  local actors = {}     -- "x,y,z" -> "furnace" | "hopper"
  local actorPos = {}   -- "x,y,z" -> { x, y, z }
  local actorList = {}
  local actorsDirty = false

  local function registerActor(x, y, z, b)
    local k = key(x, y, z)
    local kind = b and (FURNACE_TYPE[b.name] and "furnace" or (b.name == "minecraft:hopper" and "hopper")) or nil
    if actors[k] ~= (kind or nil) then
      actors[k] = kind or nil
      actorPos[k] = kind and { x, y, z } or nil
      actorsDirty = true
    end
    if kind == "hopper" and not hopperRec[k] then hopperRec[k] = { cd = 0 } end
    if kind ~= "hopper" then hopperRec[k] = nil end
  end

  local function runActors(t)
    if actorsDirty then
      actorList = {}
      for k in pairs(actors) do actorList[#actorList + 1] = k end
      table.sort(actorList)
      actorsDirty = false
    end
    local active = false
    for _, k in ipairs(actorList) do
      local kind = actors[k]
      if kind then
        local pos = actorPos[k]
        local x, y, z = pos[1], pos[2], pos[3]
        local b = blockAt(x, y, z)
        if kind == "furnace" and b and FURNACE_TYPE[b.name] then
          if furnaceTick(x, y, z, b) then active = true end
        elseif kind == "hopper" and b and b.name == "minecraft:hopper" then
          if hopperTick(x, y, z, b, hopperRec[k]) then active = true end
        else
          registerActor(x, y, z, b)
        end
      end
    end
    return active
  end

  -- ===== dropped items (ItemEntity) =====

  local function cellKey(e) return floor(e.x) .. "," .. floor(e.y) .. "," .. floor(e.z) end

  local function runItems(t)
    local list = world.itemEntities
    local changedAny = false
    for _, e in ipairs(list) do if e.born == nil then e.born = t end end
    local order, dead = {}, {}
    for i, e in ipairs(list) do order[i] = e end
    -- despawn at 6000 ticks of age
    for _, e in ipairs(order) do
      if t - e.born >= DESPAWN then dead[e] = true end
    end
    -- merging, on the entity's own 40-tick beat; the bigger stack takes the smaller, and keeps the younger age
    for _, e in ipairs(order) do
      if not dead[e] and (t - e.born) % MERGE_EVERY == 0 then
        for _, o in ipairs(order) do
          if o ~= e and not dead[o] and not dead[e] and cellKey(o) == cellKey(e) and sameItem(o.item, e.item)
            and o.item.count + e.item.count <= limitOf(e.item) then
            local target, src = e, o
            if o.item.count >= e.item.count then target, src = o, e end
            target.item.count = target.item.count + src.item.count
            target.born = max(target.born, src.born)
            dead[src] = true
            if src == e then break end
          end
        end
      end
    end
    for i = #list, 1, -1 do
      if dead[list[i]] then
        table.remove(list, i)
        changedAny = true
      end
    end
    if changedAny then core.dirty = true end
  end

  --- The next tick after `t` at which a dropped item despawns or gets to merge
  local function nextItemTick(t)
    local list = world.itemEntities
    if #list == 0 then return nil end
    local best
    local cells = {}
    for _, e in ipairs(list) do
      if e.born == nil then e.born = t end
      local k = cellKey(e) .. "|" .. e.item.name
      cells[k] = (cells[k] or 0) + 1
    end
    for _, e in ipairs(list) do
      local at = e.born + DESPAWN
      if cells[cellKey(e) .. "|" .. e.item.name] > 1 then
        local beat = e.born + MERGE_EVERY * math.ceil((t + 1 - e.born) / MERGE_EVERY)
        if beat < at then at = beat end
      end
      if not best or at < best then best = at end
    end
    return best
  end

  -- ===== the clock =====

  local function dispatch(e)
    local kind = e[3]
    if kind == "f" then
      local x, y, z = e[4], e[5], e[6]
      pendingFluid[key(x, y, z)] = nil
      fluidTick(x, y, z)
    elseif kind == "r" then
      local reg = randReg[e[4]]
      if reg and reg.nextAt == e[1] then
        local b = blockAt(reg.x, reg.y, reg.z)
        if randomKind(b) == reg.kind then
          randomTick(reg, b)
          local again = randReg[e[4]]
          if again == reg then
            reg.nextAt = e[1] + geometric()
            push(reg.nextAt, "r", e[4])
          end
        else
          randReg[e[4]] = nil
        end
      end
    end
  end

  local function runTick(t)
    cur = t
    while heapN > 0 and heap[1][1] <= t do dispatch(pop()) end
    local active = runActors(t)
    if #world.itemEntities > 0 then runItems(t) end
    return active
  end

  local keepAlive
  local function arm()
    if keepAlive or not core.after then return end
    keepAlive = core.after(0.5, function()
      keepAlive = nil
      M.catchUp()
    end)
  end

  --- Run the world up to the server tick it is now
  function M.catchUp()
    if busy or not enabled then return end
    local now = nowTick()
    if now <= last then return end
    busy = true
    local steps = 0
    local ok, err = pcall(function()
      local activeNext = true
      while last < now do
        local nxt = heapN > 0 and heap[1][1] or nil
        local itemAt = nextItemTick(last)
        if itemAt and (not nxt or itemAt < nxt) then nxt = itemAt end
        if activeNext then nxt = nxt and min(nxt, last + 1) or last + 1 end
        if not nxt or nxt > now then break end
        if nxt <= last then nxt = last + 1 end
        last = nxt
        activeNext = runTick(nxt)
        steps = steps + 1
        if steps > MAX_STEPS then break end
      end
      last = now
    end)
    busy = false
    cur = last
    if not ok then error(err, 0) end
    -- something still in motion that nobody may look at: keep it moving so other computers see it
    if next(pendingFluid) ~= nil then arm() end
  end

  --- The hook world.set calls after a block changed
  function M.changed(x, y, z, b)
    if not enabled then return end
    registerRandom(x, y, z, b)
    registerActor(x, y, z, b)
    local kind = fluidOf(b)
    if kind then scheduleFluid(x, y, z, kind) end
    lavaReacts(x, y, z)
    for _, d in ipairs(SIX) do
      local nx, ny, nz = x + d[1], y + d[2], z + d[3]
      local nk = fluidOf(blockAt(nx, ny, nz))
      if nk then
        if nk == LAVA then lavaReacts(nx, ny, nz) end
        scheduleFluid(nx, ny, nz, nk)
      end
    end
    if next(pendingFluid) ~= nil then arm() end
  end

  --- world.dropItem hook: the stack starts ageing now
  function M.itemDropped(e)
    if not enabled then return end
    e.born = nowTick()
  end

  --- Find everything alive in a world that was just loaded
  function M.scan()
    if not enabled then return end
    last = nowTick()
    cur = last
    local function wants(name)
      return name == WATER or name == LAVA or FURNACE_TYPE[name] ~= nil or name == "minecraft:hopper"
        or name == "minecraft:farmland" or name == "minecraft:nether_wart" or name == "minecraft:sugar_cane"
        or name == "minecraft:melon_stem" or name == "minecraft:pumpkin_stem"
        or data.blockHasTag(name, "minecraft:crops") or data.blockHasTag(name, "minecraft:saplings")
    end
    world.eachBlock(function(x, y, z, b)
      registerRandom(x, y, z, b)
      registerActor(x, y, z, b)
    end, wants)
    for _, e in ipairs(world.itemEntities) do e.born = e.born or last end
  end

  -- world.set and world.dropItem first bring the world up to date, then tell it what changed
  if enabled then
    local rawSet = world.set
    function world.set(x, y, z, b)
      M.catchUp()
      rawSet(x, y, z, b)
      M.changed(x, y, z, b)
    end
    local rawDrop = world.dropItem
    function world.dropItem(x, y, z, item)
      M.catchUp()
      rawDrop(x, y, z, item)
      local list = world.itemEntities
      if list[#list] then M.itemDropped(list[#list]) end
    end
    local previous = core.beforeObserve
    core.beforeObserve = function()
      if previous then previous() end
      M.catchUp()
    end
  end

  return M
end
