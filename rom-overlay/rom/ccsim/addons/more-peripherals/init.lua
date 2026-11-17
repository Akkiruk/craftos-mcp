-- ccsim more-peripherals: More Peripherals 1.20.1-1.13.0 (Forge), mod id "peripherals".
--
-- Written from github.com/JheffersonMarques/MorePeripherals, branch 1.20 at 48518f7 (16 Apr 2024, "Added the scanner",
-- the commit the 1.20.1-1.13.0 jar on Modrinth was built from) and checked against that jar with javap (method names,
-- signatures, local variable names in NullPointerException messages). Source files, relative to
-- src/main/java/com/hakimen/peripherals/:
--   peripherals/{XPCollector,XPBottler,Crafter,LoomInterface,MagneticCardManiputalor,BeehiveInterface,
--   TradingInterface,Spawner,PlayerInterface,EnderChestInterface,Scanner,Grinder}Peripheral.java,
--   blocks/tile_entities/{XPCollector,MagneticCardManiputalor,BeehiveInterface,TradingInterface,SpawnerInterface}Entity,
--   items/{MagneticCard,PlayerCard}Item, client/containers/CrafterContainer, assets/peripherals/lang/en_us.json.
-- Vanilla 1.20.1 facts (banner pattern order, Mth.atan2, Entity.lookAt) were read from the 1.20.1 server jar with javap.
-- docs/more-peripherals.md lists every behaviour with its source, and what is not emulated.
return function(core, host)
  local floor = math.floor
  local data = dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)
  local itemInfo = dofile("/rom/ccsim/turtle/items.lua")(data, core.world.gameData)
  local cfg = core.world.morePeripherals or {}
  local M = {}
  local objects = {}

  -- ===== CC's argument checks and Java's exceptions =====

  local function typeName(v) return v == nil and "nil" or type(v) end
  local checkString, checkInt = host.checkString, host.checkInt
  local function checkBool(i, v)
    if type(v) ~= "boolean" then error(("bad argument #%d (boolean expected, got %s)"):format(i, typeName(v)), 0) end
    return v
  end
  local function checkNumber(i, v)
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, typeName(v)), 0) end
    return v
  end
  local function checkTable(i, v)
    if type(v) ~= "table" then error(("bad argument #%d (table expected, got %s)"):format(i, typeName(v)), 0) end
    return v
  end
  local function optInt(i, v) if v == nil then return nil end return checkInt(i, v) end
  local function optBool(i, v) if v == nil then return nil end return checkBool(i, v) end
  local function optString(i, v) if v == nil then return nil end return checkString(i, v) end

  --- LuaContext: "Java Exception Thrown: " .. Throwable.toString()
  local function java(class, message)
    error("Java Exception Thrown: " .. class .. (message and (": " .. message) or ""), 0)
  end
  --- Java 17's helpful NullPointerException message (the jar keeps its local variable names)
  local function npe(call, var)
    java("java.lang.NullPointerException", ('Cannot invoke "%s" because "%s" is null'):format(call, var))
  end
  local function aioobe(index, length)
    java("java.lang.ArrayIndexOutOfBoundsException", ("Index %d out of bounds for length %d"):format(index, length))
  end
  --- ArgumentHelpers.assertBetween(int, int, int, String)
  local function assertBetween(v, lo, hi, fmt)
    if v < lo or v > hi then error((fmt:gsub("%%s", "between " .. lo .. " and " .. hi)), 0) end
  end

  -- ===== items: NBT as a Lua table under __tag, the nbt hash a stand-in made from it =====

  local function serialize(v)
    if type(v) ~= "table" then return type(v) == "string" and ("%q"):format(v) or tostring(v) end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local out = {}
    for _, k in ipairs(keys) do out[#out + 1] = tostring(k) .. "=" .. serialize(v[k]) end
    return "{" .. table.concat(out, ",") .. "}"
  end
  local function retag(item)
    item.nbt = item.__tag and host.md5(serialize(item.__tag)) or item.__origNbt
  end
  --- ItemStack.removeTagKey: an emptied tag goes away (CompoundTag.remove on getTag() keeps it)
  local function removeTagKey(item, key)
    local tag = item.__tag
    if tag and tag[key] ~= nil then
      tag[key] = nil
      if next(tag) == nil then item.__tag = nil end
    end
    retag(item)
  end
  --- ItemStack.resetHoverName: the custom name goes, and so does a tag left empty (1.20.1 jar)
  local function resetHoverName(item)
    item.displayName = nil
    if item.__tag and next(item.__tag) == nil then item.__tag = nil end
    retag(item)
  end
  --- A fixture item's `tag` (the NBT keys this mod reads) moves to __tag, out of getItemDetail's way.
  local function normalize(item)
    if type(item) ~= "table" then return item end
    if item.tag ~= nil and item.__tag == nil then
      item.__origNbt = item.nbt
      item.__tag = item.tag
      item.tag = nil
      retag(item)
    end
    return item
  end
  local function tagOf(item, create)
    if not item.__tag and create then item.__tag = {} end
    return item.__tag
  end
  for _, def in ipairs(core.world.peripherals or {}) do
    for _, item in pairs(def.items or {}) do normalize(item) end
  end

  local function copyItem(item)
    if not item then return nil end
    local c = host.copy(item)
    return c
  end
  local function maxStack(item) return math.min(item.maxCount or itemInfo.maxCount(data.id(item.name)), 64) end
  local function sameItem(a, b) return a ~= nil and b ~= nil and a.name == b.name end
  local function sameItemSameTags(a, b) return sameItem(a, b) and a.nbt == b.nbt end
  local function hoverName(item) return item.displayName or data.displayName(data.id(item.name)) end

  local REMAINDER = {
    ["minecraft:water_bucket"] = "minecraft:bucket", ["minecraft:lava_bucket"] = "minecraft:bucket",
    ["minecraft:milk_bucket"] = "minecraft:bucket", ["minecraft:powder_snow_bucket"] = "minecraft:bucket",
    ["minecraft:honey_bottle"] = "minecraft:glass_bottle", ["minecraft:dragon_breath"] = "minecraft:glass_bottle",
  }

  -- ===== IComputerAccess.getAvailablePeripheral + extractHandler: a block's IItemHandler (InvWrapper) =====

  local function lookup(name) return host.find(name) end

  --- The handler behind a peripheral, or nil when it is not an inventory (extractHandler returns null).
  local function handlerOf(entry)
    local inv = entry and entry.inventory
    if not inv or not inv.__state or not inv.size then return nil end
    local H = { inv = inv }
    local items = inv.__state()
    for _, item in pairs(items) do normalize(item) end
    function H.slots() return inv.size() end
    --- getStackInSlot(slot), 0-based; a vanilla container's NonNullList past its end throws
    function H.get(i)
      local size = inv.size()
      if i < 0 or i >= size then aioobe(i, size) end
      return items[i + 1]
    end
    function H.set(i, item) items[i + 1] = item end
    --- InvWrapper.insertItem: what is left of `stack` (nil for nothing)
    function H.insert(i, stack, simulate)
      if not stack or stack.count <= 0 then return nil end
      local here = H.get(i)
      if here then
        if here.count >= math.min(maxStack(here), 64) then return stack end
        if not sameItemSameTags(here, stack) then return stack end
        local m = math.min(maxStack(stack), 64) - here.count
        if stack.count <= m then
          if not simulate then here.count = here.count + stack.count end
          return nil
        end
        if not simulate then here.count = here.count + m end
        local rest = copyItem(stack)
        rest.count = stack.count - m
        return rest
      end
      local m = math.min(maxStack(stack), 64)
      if m < stack.count then
        if not simulate then
          local put = copyItem(stack)
          put.count = m
          items[i + 1] = put
        end
        local rest = copyItem(stack)
        rest.count = stack.count - m
        return rest
      end
      if not simulate then items[i + 1] = copyItem(stack) end
      return nil
    end
    --- InvWrapper.extractItem: the stack taken (nil for none)
    function H.extract(i, amount, simulate)
      if amount == 0 then return nil end
      local here = H.get(i)
      if not here then return nil end
      local m = math.min(here.count, amount)
      local out = copyItem(here)
      out.count = m
      if not simulate then
        here.count = here.count - m
        if here.count <= 0 then items[i + 1] = nil end
      end
      return out
    end
    --- ItemStack.shrink on the stack in a slot (no setChanged)
    function H.shrink(i, n)
      local here = items[i + 1]
      if not here then return end
      here.count = here.count - n
      if here.count <= 0 then items[i + 1] = nil end
    end
    return H
  end

  --- `slot < 0 || slot > handler.getSlots()`: a negative slot answers before the handler is touched
  local function outOfRange(slot, handler, var)
    if slot < 0 then return true end
    if not handler then npe("net.minecraftforge.items.IItemHandler.getSlots()", var) end
    return slot > handler.slots()
  end

  --- A player's own container (Inventory or PlayerEnderChestContainer) over a slot -> item table, 0-based.
  local function container(list, size)
    local C = { size = size }
    function C.get(i) return list[i + 1] end
    function C.set(i, item) list[i + 1] = item end
    --- ContainerHelper.removeItem / Inventory.removeItem: split up to `count` off the stack
    function C.removeItem(i, count)
      local here = list[i + 1]
      if i < 0 or i >= size or not here or count <= 0 then return nil end
      local n = math.min(count, here.count)
      local out = copyItem(here)
      out.count = n
      here.count = here.count - n
      if here.count <= 0 then list[i + 1] = nil end
      return out
    end
    --- SimpleContainer.canAddItem (also More Peripherals' own copy for the player's 36 main slots)
    function C.canAddItem(stack, slots)
      for i = 0, (slots or size) - 1 do
        local here = list[i + 1]
        if not here or (sameItemSameTags(here, stack) and here.count < maxStack(here)) then return true end
      end
      return false
    end
    --- SimpleContainer.addItem: same-type slots first, then empty ones; what does not fit is returned (and dropped by
    --- every caller here, so lost)
    function C.addItem(stack)
      if not stack then return nil end
      stack = copyItem(stack)
      for i = 0, size - 1 do
        local here = list[i + 1]
        if here and sameItemSameTags(here, stack) then
          local n = math.min(stack.count, maxStack(here) - here.count)
          if n > 0 then here.count = here.count + n stack.count = stack.count - n end
          if stack.count <= 0 then return nil end
        end
      end
      for i = 0, size - 1 do
        if not list[i + 1] then
          list[i + 1] = stack
          return nil
        end
      end
      return stack
    end
    return C
  end

  --- Inventory.add(stack) for a player: the selected hotbar slot, the off hand, then the main slots with room, then the
  --- first empty main slot, a slot at a time (Inventory.addResource). What does not fit is lost.
  local function playerAdd(p, stack)
    if not stack then return end
    stack = copyItem(stack)
    local inv = p.inventory
    local function hasRoom(here) return here and sameItemSameTags(here, stack) and here.count < maxStack(here) and maxStack(here) > 1 end
    while stack.count > 0 do
      local slot
      if hasRoom(inv[p.selected + 1]) then slot = p.selected
      elseif hasRoom(inv[41]) then slot = 40
      else
        for i = 0, 35 do if hasRoom(inv[i + 1]) then slot = i break end end
      end
      if not slot then
        for i = 0, 35 do if not inv[i + 1] then slot = i break end end
      end
      if not slot then return end
      local here = inv[slot + 1]
      if not here then
        here = copyItem(stack)
        here.count = 0
        inv[slot + 1] = here
      end
      local n = math.min(stack.count, maxStack(here) - here.count)
      if n <= 0 then return end
      here.count = here.count + n
      stack.count = stack.count - n
    end
  end

  -- ===== players (core.players for who is online and where, morePeripherals.players for what they carry) =====

  local playerData = {}
  local function slots(list)
    local out = {}
    for k, item in pairs(list or {}) do
      local n = tonumber(k)
      if n then out[n] = normalize(host.copy(item)) end
    end
    return out
  end
  local function pdata(p)
    local d = playerData[p.uuid]
    if d then return d end
    local spec = (cfg.players or {})[p.name] or {}
    d = {
      inventory = slots(spec.inventory), -- 1-36 main (1-9 the hotbar), 37-40 feet, legs, chest, head, 41 the off hand
      enderChest = slots(spec.enderChest),
      selected = tonumber(spec.selected) or 0,
      food = tonumber(spec.food) or 20,
      saturation = tonumber(spec.saturation) or 5,
      effects = host.copy(spec.effects or {}),
      messages = {},
    }
    playerData[p.uuid] = d
    return d
  end

  local function dimensionOf(def) return def.dimension or core.position.dimension or "minecraft:overworld" end

  -- ===== small float maths for Entity.lookAt =====

  local function fround(x)
    if x == 0 or x ~= x or x == math.huge or x == -math.huge then return x end
    local m, e = math.frexp(x)
    local s = m * 2 ^ 24
    local r = floor(s + 0.5)
    if r - s == 0.5 and r % 2 == 1 then r = r - 1 end
    return r * 2 ^ (e - 24)
  end
  local function toBits(x)
    if x == 0 then return 0, 0 end
    local m, e = math.frexp(x)
    local f = (m * 2 - 1) * 2 ^ 52
    return (e - 1 + 1023) * 2 ^ 20 + floor(f / 2 ^ 32), f % 2 ^ 32
  end
  local function fromBits(hi, lo)
    local E = floor(hi / 2 ^ 20)
    return (1 + ((hi % 2 ^ 20) * 2 ^ 32 + lo) / 2 ^ 52) * 2 ^ (E - 1023)
  end
  --- Mth.fastInvSqrt(double), its 64-bit integer step done on two 32-bit halves
  local function fastInvSqrt(x)
    local half = 0.5 * x
    local hi, lo = toBits(x)
    lo = floor(lo / 2) + (hi % 2) * 2 ^ 31
    hi = floor(hi / 2)
    local nlo, nhi = 0xC7B537AA - lo, 0x5FE6EB50 - hi
    if nlo < 0 then nlo, nhi = nlo + 2 ^ 32, nhi - 1 end
    x = fromBits(nhi, nlo)
    return x * (1.5 - half * x * x)
  end
  local FRAC_BIAS = 2 ^ 44
  local ASIN_TAB, COS_TAB = {}, {}
  for i = 0, 256 do
    local d1 = math.asin(i / 256.0)
    COS_TAB[i], ASIN_TAB[i] = math.cos(d1), d1
  end
  --- Mth.atan2: Minecraft's table approximation, not Math.atan2
  local function mthAtan2(y, x)
    local d0 = x * x + y * y
    if d0 ~= d0 then return 0 / 0 end
    local neg = y < 0
    if neg then y = -y end
    local flip = x < 0
    if flip then x = -x end
    local swap = y > x
    if swap then x, y = y, x end
    local d9 = fastInvSqrt(d0)
    x, y = x * d9, y * d9
    local d2 = FRAC_BIAS + y
    local d5 = d2 - FRAC_BIAS
    local i = floor(d5 * 256 + 0.5)
    local d6 = y * COS_TAB[i] - x * d5
    local d8 = ASIN_TAB[i] + (6.0 + d6 * d6) * d6 * 0.16666666666666666
    if swap then d8 = 1.5707963267948966 - d8 end
    if flip then d8 = math.pi - d8 end
    if neg then d8 = -d8 end
    return d8
  end
  local function wrapDegrees(f)
    f = fround(math.fmod(f, 360))
    if f >= 180 then f = fround(f - 360) end
    if f < -180 then f = fround(f + 360) end
    return f
  end
  local EYE = fround(1.62) -- Player standing eye height

  -- ===== the peripherals =====

  local TYPES = {}
  local function noCard(o) return not o.card end

  -- XPCollectorPeripheral / XPCollectorEntity: orbs within a block are added to xpPoints every tick (mpAddXP)
  TYPES.xp_collector = function(o, def)
    o.xp = floor(tonumber(def.xp) or 0)
    return {
      getCurrentXP = function() return o.xp end,
      dumpXP = function() o.xp = 0 end,
    }
  end

  local function collectorClass(entry)
    if entry.inventory then return "dan200.computercraft.shared.peripheral.generic.GenericPeripheral" end
    return tostring(entry.def and entry.def.type or "?")
  end

  -- XPBottlerPeripheral.bottleXP
  TYPES.xp_bottler = function(o)
    return {
      bottleXP = function(from, to, collectorName)
        from = checkString(1, from)
        to = checkString(2, to)
        collectorName = checkString(3, collectorName)
        local inputEntry = lookup(from)
        if not inputEntry then return false, "the input " .. from .. " was not found" end
        local input = handlerOf(inputEntry)
        local collectorEntry = lookup(collectorName)
        if not collectorEntry then return false, "the xp collector " .. collectorName .. " was not found" end
        local outEntry = lookup(to)
        if not outEntry then return false, "the output null was not found" end -- the mod prints the null peripheral
        local output = handlerOf(outEntry)
        local collector = collectorEntry.addon and collectorEntry.addon.__mp
        if not collector or collector.kind ~= "xp_collector" then
          java("java.lang.ClassCastException", "class " .. collectorClass(collectorEntry) ..
            " cannot be cast to class com.hakimen.peripherals.peripherals.XPCollectorPeripheral")
        end
        local bottles = floor(collector.xp / 8)
        if bottles == 0 then return false, "not enough experience in collector" end
        if not output then npe("net.minecraftforge.items.IItemHandler.getSlots()", "output") end
        local function roomFor(i)
          local here = output.get(i)
          return not here or (here.count < 64 and here.name == "minecraft:experience_bottle")
        end
        local hasSpace = false
        for i = 0, output.slots() - 1 do
          if roomFor(i) then hasSpace = true break end
        end
        if not hasSpace then return false, "target inventory doesn't have enough space" end
        if not input then npe("net.minecraftforge.items.IItemHandler.getSlots()", "input") end
        for _ = 1, bottles do
          local hasBottle = false
          for i = 0, input.slots() - 1 do
            local here = input.get(i)
            if here and here.name == "minecraft:glass_bottle" then
              input.extract(i, 1, false)
              hasBottle = true
              break
            end
          end
          if not hasBottle then
            core.save()
            return false, "no bottles found in input"
          end
          for i = 0, output.slots() - 1 do
            if roomFor(i) then
              output.insert(i, { name = "minecraft:experience_bottle", count = 1 }, false)
              collector.xp = collector.xp - 8
              break
            end
          end
        end
        core.save()
        return true
      end,
    }
  end

  -- ===== crafter (a vanilla crafting table): CrafterPeripheral.craft =====

  local function ingredientMatches(alts, item)
    if #alts == 0 then return item == nil end
    if item == nil then return false end
    for _, alt in ipairs(alts) do
      if alt.item and data.id(alt.item) == item.name then return true end
      if alt.tag and data.itemHasTag(item.name, alt.tag) then return true end
    end
    return false
  end
  local function matchShaped(recipe, grid)
    local pattern = recipe.pattern
    local h, w = #pattern, 0
    for _, row in ipairs(pattern) do w = math.max(w, #row) end
    for oy = 0, 3 - h do
      for ox = 0, 3 - w do
        for mirror = 0, 1 do
          local ok = true
          for y = 1, 3 do
            for x = 1, 3 do
              local px, py = x - ox, y - oy
              local alts = {}
              if px >= 1 and px <= w and py >= 1 and py <= h then
                local cx = mirror == 1 and (w - px + 1) or px
                local ch = pattern[py]:sub(cx, cx)
                if ch ~= " " and ch ~= "" then alts = recipe.key[ch] or { { item = "?" } } end
              end
              if not ingredientMatches(alts, grid[(y - 1) * 3 + x]) then ok = false break end
            end
            if not ok then break end
          end
          if ok then return true end
        end
      end
    end
    return false
  end
  local function matchShapeless(recipe, grid)
    local stacks = {}
    for i = 1, 9 do if grid[i] then stacks[#stacks + 1] = grid[i] end end
    local ings = recipe.ingredients
    if #stacks ~= #ings then return false end
    local used = {}
    local function assign(i)
      if i > #ings then return true end
      for j, s in ipairs(stacks) do
        if not used[j] and ingredientMatches(ings[i], s) then
          used[j] = true
          if assign(i + 1) then return true end
          used[j] = false
        end
      end
      return false
    end
    return assign(1)
  end
  local recipeOrder
  -- RecipeManager hands back the first match in its own map order; vanilla first, then the rest by id (as the turtle)
  local function findRecipe(grid)
    if not recipeOrder then
      local all = data.recipes()
      local ids = {}
      for id in pairs(all) do ids[#ids + 1] = id end
      table.sort(ids, function(a, b)
        local va, vb = a:sub(1, 10) == "minecraft:", b:sub(1, 10) == "minecraft:"
        if va ~= vb then return va end
        return a < b
      end)
      recipeOrder = {}
      for i, id in ipairs(ids) do recipeOrder[i] = all[id] end
    end
    local any = false
    for i = 1, 9 do if grid[i] then any = true end end
    if not any then return nil end
    for _, r in ipairs(recipeOrder) do
      if (r.type == "shaped" and matchShaped(r, grid)) or (r.type == "shapeless" and matchShapeless(r, grid)) then return r end
    end
    return nil
  end

  --- Lua table -> the HashMap CC hands over: number keys (Doubles) in ascending order, the rest after
  local function mapEntries(t)
    local nums, others = {}, {}
    for k, v in pairs(t) do
      if type(k) == "number" then nums[#nums + 1] = k else others[#others + 1] = k end
    end
    table.sort(nums)
    local out = {}
    for _, k in ipairs(nums) do out[#out + 1] = { k, t[k] } end
    for _, k in ipairs(others) do out[#out + 1] = { k, t[k] } end
    return out
  end
  local function intValue(n) return n < 0 and math.ceil(n) or floor(n) end

  TYPES.crafter = function(o)
    return {
      craft = function(fromName, toName, params)
        fromName = checkString(1, fromName)
        toName = checkString(2, toName)
        params = checkTable(3, params)
        local fromEntry = lookup(fromName)
        if not fromEntry then return false, "the input " .. fromName .. " was not found" end
        local from = handlerOf(fromEntry)
        local toEntry = lookup(toName)
        if not toEntry then return false, "the output " .. toName .. " was not found" end
        local to = handlerOf(toEntry)
        local grid, remainders, counts, countOrder = {}, {}, {}, {}
        local entries = mapEntries(params)
        for _, kv in ipairs(entries) do
          local key, value = kv[1], kv[2]
          if type(key) == "number" and type(value) == "number" then
            local slot = intValue(value)
            if slot ~= 0 then
              if not from then npe("net.minecraftforge.items.IItemHandler.getStackInSlot(int)", "fromHandler") end
              local stack = from.get(slot - 1)
              if counts[slot] then counts[slot] = counts[slot] + 1
              else counts[slot] = 1 countOrder[#countOrder + 1] = slot end
              if stack and REMAINDER[stack.name] then remainders[#remainders + 1] = { name = REMAINDER[stack.name], count = 1 } end
              local g = intValue(key) - 1
              if g < 0 or g >= 9 then aioobe(g, 9) end -- SimpleContainer(9).setItem
              grid[g + 1] = stack
            end
          end
        end
        table.sort(countOrder) -- HashMap<Integer, Integer>: small ints come out in order
        for _, k in ipairs(countOrder) do
          local here = from.get(k - 1)
          if (here and here.count or 0) < counts[k] then
            return false, ("Not enough resources on slot %d to craft"):format(k)
          end
        end
        local placed, canPlaceAll = false, true
        local recipe = findRecipe(grid)
        if recipe then
          if not to then npe("net.minecraftforge.items.IItemHandler.getSlots()", "toHandler") end
          for i = 0, to.slots() - 1 do
            local r = recipe.result
            local assemble = { name = data.id(r.item), count = r.count or 1 }
            if not to.insert(i, assemble, true) then
              placed = true
              to.insert(i, assemble, false)
              -- the mod's remainder loop indexes the remainders by inventory slot (remainders.get(k))
              for _ = 1, #remainders do
                for k = 0, from.slots() - 1 do
                  if k >= #remainders then
                    java("java.lang.IndexOutOfBoundsException", ("Index %d out of bounds for length %d"):format(k, #remainders))
                  end
                  if from.insert(k, remainders[k + 1], true) then canPlaceAll = false break end
                end
                if canPlaceAll then
                  for k = 0, from.slots() - 1 do
                    if not from.insert(k, remainders[k + 1], false) then break end
                  end
                else
                  break
                end
              end
              for _, kv in ipairs(entries) do
                if type(kv[2]) == "number" then
                  local slot = intValue(kv[2])
                  if slot ~= 0 then from.extract(slot - 1, 1, false) end
                end
              end
              break
            end
          end
          if not placed and not canPlaceAll then return false, "failed to Craft" end
        end
        core.save()
        return true
      end,
    }
  end

  -- ===== loom_interface (a vanilla loom): LoomInterfacePeripheral =====

  -- BannerPatterns.bootstrap order in the 1.20.1 jar: BuiltInRegistries.BANNER_PATTERN's order, by hash name
  local PATTERNS = { "b", "bl", "br", "tl", "tr", "bs", "ts", "ls", "rs", "cs", "ms", "drs", "dls", "ss", "cr", "sc",
    "bt", "tt", "bts", "tts", "ld", "rd", "lud", "rud", "mc", "mr", "vh", "hh", "vhr", "hhb", "bo", "cbo", "gra", "gru",
    "bri", "glb", "cre", "sku", "flo", "moj", "pig" }
  local DYES = { "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan",
    "purple", "blue", "brown", "green", "red", "black" }
  local DYE_ID, BANNER = {}, {}
  for i, c in ipairs(DYES) do
    DYE_ID["minecraft:" .. c .. "_dye"] = i - 1
    BANNER["minecraft:" .. c .. "_banner"] = true
  end
  local function isBanner(item) return item ~= nil and (BANNER[item.name] or item.banner == true) end
  local function isDye(item) return item ~= nil and DYE_ID[item.name] ~= nil end

  TYPES.loom_interface = function(o)
    return {
      paintBanner = function(from, slotBanner, slotDye, pattern)
        from = checkString(1, from)
        slotBanner = checkInt(2, slotBanner)
        slotDye = checkInt(3, slotDye)
        pattern = checkInt(4, pattern)
        local entry = lookup(from)
        if not entry then return false, "the input " .. from .. " was not found" end
        local input = handlerOf(entry)
        slotBanner, slotDye = slotBanner - 1, slotDye - 1
        if outOfRange(slotBanner, input, "input") then return false, "banner slot out of range" end
        if outOfRange(slotDye, input, "input") then return false, "dye slot out of range" end
        local banner, dye = input.get(slotBanner), input.get(slotDye)
        if not isBanner(banner) then return false, "the item in " .. slotBanner .. " is not a banner" end
        if not isDye(dye) then return false, "the item in " .. slotDye .. " is not a dye" end
        if dye.count < banner.count then return false, "not enough dye" end
        pattern = pattern - 1
        if pattern > #PATTERNS or pattern < 0 then
          return false, "invalid pattern, value was " .. (pattern + 1) .. " expected a value between 1 and " .. #PATTERNS
        end
        if pattern == #PATTERNS then aioobe(pattern, #PATTERNS) end -- stream().toList().get(size)
        local color = DYE_ID[dye.name]
        input.extract(slotDye, banner.count, false)
        local tag = tagOf(banner, true)
        tag.BlockEntityTag = tag.BlockEntityTag or {}
        tag.BlockEntityTag.Patterns = tag.BlockEntityTag.Patterns or {}
        local list = tag.BlockEntityTag.Patterns
        list[#list + 1] = { Pattern = PATTERNS[pattern + 1], Color = color }
        retag(banner)
        core.save()
        return true
      end,
      clearBanner = function(from, slot)
        from = checkString(1, from)
        slot = checkInt(2, slot)
        local entry = lookup(from)
        if not entry then return false, "the input " .. from .. " was not found" end
        local input = handlerOf(entry)
        slot = slot - 1
        if outOfRange(slot, input, "input") then return false, "slot out of range" end
        local banner = input.get(slot)
        if not isBanner(banner) then return false, "not a banner" end
        removeTagKey(banner, "BlockEntityTag") -- BlockItem.setBlockEntityData with an empty tag
        core.save()
        return true
      end,
    }
  end

  -- ===== magnetic_card_manipulator: MagneticCardManiputalorPeripheral and its entity's one-slot handler =====

  local function newCard(spec)
    if spec == nil or spec == false then return nil end
    if type(spec) ~= "table" then spec = {} end
    local item = { name = "peripherals:magnetic_card", count = 1, displayName = spec.label }
    local tag = {}
    if spec.data ~= nil then tag.data = tostring(spec.data) end
    if spec.sensible ~= nil then tag.sensible = spec.sensible == true end
    if next(tag) then item.__tag = tag end
    retag(item)
    return item
  end

  TYPES.magnetic_card_manipulator = function(o, def)
    o.card = newCard(def.card)
    -- the handler's extractItem queues card_remove to every attached computer (here, this one)
    function o.removeCard()
      local card = o.card
      if card then
        o.card = nil
        os.queueEvent("card_remove")
      end
      return card
    end
    return {
      readCard = function()
        if noCard(o) then return false, "no card found" end
        local tag = tagOf(o.card, true) -- getOrCreateTag: even reading leaves the card with a tag
        retag(o.card)
        return tag.data ~= nil and tostring(tag.data) or ""
      end,
      writeCard = function(text)
        text = checkString(1, text)
        if noCard(o) then return false, "no card found" end
        local tag = tagOf(o.card, true)
        if text ~= "" then tag.data = text else tag.data = nil end
        retag(o.card)
        return true
      end,
      hasCard = function() return o.card ~= nil end,
      ejectCard = function()
        if noCard(o) then return false end
        o.dropped = (o.dropped or 0) + 1
        o.lastDropped = o.removeCard()
        os.queueEvent("card_remove") -- and the peripheral's own computer.queueEvent
        return true
      end,
      setLabel = function(label)
        label = checkString(1, label)
        if noCard(o) then return false end
        if label == "" then resetHoverName(o.card) else o.card.displayName = label end
        return true
      end,
      getLabel = function()
        if noCard(o) then return false, "no card found" end
        return hoverName(o.card)
      end,
      setSecure = function(sensible)
        sensible = checkBool(1, sensible)
        if noCard(o) then return false, "no card found" end
        tagOf(o.card, true).sensible = sensible
        retag(o.card)
        return true
      end,
    }
  end

  -- ===== beehive_interface: BeehiveInterfacePeripheral (the hive next to it, from BeehiveInterfaceEntity.tick) =====

  local function newHive(spec)
    if type(spec) ~= "table" then return nil end
    local hive = { honeyLevel = floor(tonumber(spec.honeyLevel) or 0), fireNearby = spec.fireNearby == true, bees = {} }
    for i, b in ipairs(spec.bees or {}) do
      hive.bees[i] = {
        ticksInHive = floor(tonumber(b.ticksInHive) or 0), minOccupationTicks = floor(tonumber(b.minOccupationTicks) or 600),
        hasStung = b.hasStung == true, health = fround(tonumber(b.health) or 10), hasNectar = b.hasNectar == true,
        age = floor(tonumber(b.age) or 0), angerTime = floor(tonumber(b.angerTime) or 0),
      }
    end
    return hive
  end

  TYPES.beehive_interface = function(o, def)
    o.hive = newHive(def.beehive)
    o.hives = tonumber(def.beehives) or (o.hive and 1 or 0)
    local function check()
      if o.hives > 1 then return false, "more than one beehive connected" end
      if not o.hive then return false, "no beehive present" end
      return true
    end
    local function guard(fn)
      return function(...)
        local ok, err = check()
        if not ok then return ok, err end
        return fn(...)
      end
    end
    return {
      hasBees = guard(function() return #o.hive.bees > 0 end),
      getBeeCount = guard(function() return true, #o.hive.bees end),
      gotFireNear = guard(function() return true, o.hive.fireNearby end),
      getBees = guard(function()
        if #o.hive.bees == 0 then return false, "there is no bees in the hive" end
        local out = {}
        for i, b in ipairs(o.hive.bees) do
          out[i] = {
            TicksInHive = b.ticksInHive, MinOccupationTicks = b.minOccupationTicks,
            EntityData = { HasStung = b.hasStung, Health = b.health, HasNectar = b.hasNectar, Age = b.age,
              AngerTime = b.angerTime },
          }
        end
        return true, out
      end),
      getHoneyLevel = guard(function() return true, o.hive.honeyLevel end),
      collectHoney = function(resources, to, bottled)
        resources = checkString(1, resources)
        to = checkString(2, to)
        bottled = checkBool(3, bottled)
        local ok, err = check()
        if not ok then return ok, err end
        if o.hive.honeyLevel < 5 then return false, "there is not enough honey in the hive" end
        local inEntry = lookup(resources)
        if not inEntry then error("the input " .. resources .. " was not found", 0) end
        local input = handlerOf(inEntry)
        local outEntry = lookup(to)
        if not outEntry then error("the output " .. to .. " was not found", 0) end
        local output = handlerOf(outEntry)
        if not input then npe("net.minecraftforge.items.IItemHandler.getSlots()", "inputHandler") end
        local want = bottled and "minecraft:glass_bottle" or "minecraft:shears"
        local slot
        for i = 0, input.slots() - 1 do
          local here = input.get(i)
          if here and here.name == want then slot = i break end
        end
        if not slot then return false, "not found the needed item" end
        local passed = false
        local function outputSlots(product, max)
          if not output then npe("net.minecraftforge.items.IItemHandler.getSlots()", "outputHandler") end
          for i = 0, output.slots() - 1 do
            local here = output.get(i)
            if not here or (here.name == product and here.count < max) then return i end
          end
        end
        if bottled then
          input.extract(slot, 1, false)
          local i = outputSlots("minecraft:honey_bottle", 16)
          if i then
            output.insert(i, { name = "minecraft:honey_bottle", count = 1 }, false)
            passed = true
          end
        else
          local shears = copyItem(input.get(slot))
          input.extract(slot, 1, false)
          shears.count = 1
          shears.damage = (shears.damage or 0) + 1
          if shears.damage < (shears.maxDamage or itemInfo.maxDamage("minecraft:shears") or 238) then
            input.insert(slot, shears, false)
          end
          local i = outputSlots("minecraft:honeycomb", 64)
          if i then
            output.insert(i, { name = "minecraft:honeycomb", count = math.random(1, 3) }, false)
            passed = true
          end
        end
        core.save()
        if not passed then return false, "the destination inventory is full" end
        o.hive.honeyLevel = 0
        return true
      end,
    }
  end

  -- ===== trading_interface: TradingInterfacePeripheral (the villager within a block, TradingInterfaceEntity.tick) =====

  local function newStack(spec)
    if type(spec) ~= "table" or not spec.name then return nil end
    return { name = data.id(spec.name), count = floor(tonumber(spec.count) or 1), enchantments = spec.enchantments }
  end
  local function newOffers(list)
    local out = {}
    for i, t in ipairs(list or {}) do
      out[i] = { costA = newStack(t.costA), costB = newStack(t.costB), result = newStack(t.result) }
    end
    return out
  end
  local function newVillager(spec)
    if type(spec) ~= "table" then return nil end
    return { profession = spec.profession or "none", level = floor(tonumber(spec.level) or 1), xp = floor(tonumber(spec.xp) or 0),
      offers = newOffers(spec.offers), rerolls = spec.rerolls or {}, reroll = 0 }
  end
  --- getItemInfo: { enchants = { id = level }, count }, keyed by the item's id; an empty stack is minecraft:air, 0
  local function itemInfoMap(stack)
    local enchants = {}
    for _, e in ipairs(stack and stack.enchantments or {}) do enchants[e.name] = e.level end
    return { [stack and stack.name or "minecraft:air"] = { enchants = enchants, count = stack and stack.count or 0 } }
  end

  TYPES.trading_interface = function(o, def)
    o.villager = newVillager(def.villager)
    o.lastCycle = -math.huge
    local function gone() return not o.villager end
    return {
      getProfession = function()
        if gone() then return false, "villager not in range" end
        return true, o.villager.profession
      end,
      getTrades = function()
        if gone() then return false, "villager not in range" end
        local list = {}
        for i, offer in ipairs(o.villager.offers) do
          list[i] = { costA = itemInfoMap(offer.costA), costB = itemInfoMap(offer.costB), result = itemInfoMap(offer.result) }
        end
        return true, list
      end,
      trade = function(from, to, index)
        from = checkString(1, from)
        to = checkString(2, to)
        index = checkInt(3, index)
        if gone() then return false, "villager not in range" end
        local offers = o.villager.offers
        if index - 1 < 0 or index - 1 > #offers - 1 then return false, "trade index out of range" end
        local offer = offers[index]
        local inEntry = lookup(from)
        if not inEntry then return false, "the input " .. from .. " was not found" end
        local input = handlerOf(inEntry)
        local outEntry = lookup(to)
        if not outEntry then return false, "the input " .. to .. " was not found" end
        local result = handlerOf(outEntry)
        if not input then npe("net.minecraftforge.items.IItemHandler.getSlots()", "input") end
        local validA, validB, slotA, slotB = false, false, -1, -1
        local a, b = offer.costA, offer.costB
        for slot = 0, input.slots() - 1 do
          local test = input.get(slot)
          local count = test and test.count or 0
          if not validA and a and count >= a.count and test and test.name == a.name then validA, slotA = true, slot end
          if not validB then
            local bCount = b and b.count or 0
            if count >= bCount and ((b == nil and test == nil) or (b ~= nil and test ~= nil and test.name == b.name)) then
              validB, slotB = true, slot
            end
          end
        end
        if not validA then return false end
        local out = copyItem(offer.result)
        local rest = out and copyItem(out)
        if rest then
          if not result then npe("net.minecraftforge.items.IItemHandler.getSlots()", "result") end
          for slot = 0, result.slots() - 1 do
            rest = result.insert(slot, out, false)
            if not rest then break end
            out = rest
          end
        end
        core.save()
        if rest then return false, "destination inventory full" end
        input.shrink(slotA, a.count)
        if validB then input.shrink(slotB, b and b.count or 0) end
        core.save()
        return true
      end,
      restock = function()
        if gone() then return false, "villager not in range" end
        return true -- Villager.restock resets the uses, which trade() never counts
      end,
      cycleTrades = function()
        local now = core.nowMs()
        if o.lastCycle + 50 >= now then return end -- MethodResult.of(): nothing
        if gone() then return false, "villager not in range" end
        local v = o.villager
        v.level, v.xp = 1, 0
        v.reroll = v.reroll + 1
        local nextOffers = v.rerolls[v.reroll]
        if nextOffers then v.offers = newOffers(nextOffers) end
        o.lastCycle = now
        return true
      end,
    }
  end

  -- ===== spawner_interface: SpawnerPeripheral (the spawner next to it, SpawnerInterfaceEntity.tick) =====

  local function knownEntity(id)
    if type(id) ~= "string" or id == "" then return nil end
    if not id:find(":", 1, true) then id = "minecraft:" .. id end
    local ns, path = id:match("^([a-z0-9_.-]+):([a-z0-9_./-]+)$")
    if not ns then return nil end
    for _, e in ipairs(cfg.entities or {}) do if data.id(e) == id then return id end end
    if ns ~= "minecraft" then return id end
    if data.isItem(id .. "_spawn_egg") then return id end
    return nil
  end

  TYPES.spawner_interface = function(o, def)
    o.spawner = def.spawner ~= nil and def.spawner ~= false and { mob = type(def.spawner) == "table" and def.spawner.mob or
      (type(def.spawner) == "string" and def.spawner) or "minecraft:pig" } or nil
    o.spawners = tonumber(def.spawners) or (o.spawner and 1 or 0)
    o.lastCapture = -math.huge
    local function check()
      if o.spawners > 1 then return false, "more than one spawner present" end
      if not o.spawner then return false, "no spawner present" end
      return true
    end
    local function destroy()
      o.spawner = nil
      o.spawners = math.max(0, o.spawners - 1)
      o.dropped = (o.dropped or 0) + 1
    end
    return {
      changeSpawner = function(inv, slot, force)
        inv = checkString(1, inv)
        slot = checkInt(2, slot)
        force = optBool(3, force)
        local ok, err = check()
        if not ok then return ok, err end
        slot = slot - 1
        local entry = lookup(inv)
        if not entry then npe("dan200.computercraft.api.peripheral.IPeripheral.getTarget()", "peripheral") end
        local handler = handlerOf(entry)
        if outOfRange(slot, handler, "handler") then return false, "slot out of range" end
        local stack = handler.get(slot)
        local tag = stack and tagOf(stack)
        if stack and tag and stack.name == "peripherals:spawner_card" then
          local previous = o.spawner.mob or ""
          local id = knownEntity(tag.mob or "")
          if not id then java("java.util.NoSuchElementException", "No value present") end
          o.spawner.mob = id
          if force then tag.mob = nil else tag.mob = previous end
          resetHoverName(stack) -- which drops the tag a forced swap emptied
          core.save()
          return true
        end
        return false
      end,
      getCurrentlySpawningMob = function()
        local ok, err = check()
        if not ok then return ok, err end
        return o.spawner.mob or ""
      end,
      captureSpawner = function(inv, slot)
        inv = optString(1, inv)
        slot = optInt(2, slot)
        local ok, err = check()
        if not ok then return ok, err end
        if o.lastCapture + 50 >= core.nowMs() then return false end
        if inv then
          local entry = lookup(inv)
          if not entry then npe("dan200.computercraft.api.peripheral.IPeripheral.getTarget()", "peripheral") end
          local handler = handlerOf(entry)
          if slot then
            slot = slot - 1
            if outOfRange(slot, handler, "handler") then return false, "slot out of range" end
            local stack = handler.get(slot)
            if stack and stack.name == "peripherals:spawner_card" then
              local mob = o.spawner.mob or ""
              tagOf(stack, true).mob = mob
              stack.displayName = "Spawner Card (" .. mob .. ")"
              retag(stack)
              destroy()
              o.lastCapture = core.nowMs()
              core.save()
              return true
            end
          end
        elseif o.spawner.mob == "minecraft:pig" then
          destroy()
          o.lastCapture = core.nowMs()
          return true
        end
        return false
      end,
    }
  end

  -- ===== player_interface and ender_chest_interface: a bound player card in the block =====

  local function newPlayerCard(spec)
    if spec == nil or spec == false then return nil end
    if type(spec) == "string" then spec = { owner = spec } end
    if type(spec) ~= "table" then spec = {} end
    local card = { owner = spec.owner, uuid = spec.uuid }
    if card.owner and not card.uuid then
      local p = core.findPlayer(card.owner)
      card.uuid = p and p.uuid or nil
    end
    return card
  end

  --- The checks every method starts with; returns the player, or nil and the failure
  local function cardPlayer(o, sameLevel)
    if not o.card then return nil, "No card present" end
    if not o.card.owner then return nil, "Card isn't bound" end
    local p = o.card.uuid and core.byUuid[o.card.uuid]
    if not p or not p.online then return nil, "Player isn't present" end
    if sameLevel and (p.dimension or "minecraft:overworld") ~= dimensionOf(o.def) then return nil, "Player isn't present" end
    return p
  end

  local function basic(item)
    local out = { name = item.name, count = item.count }
    if item.nbt then out.nbt = item.nbt end
    return out
  end

  local function listOf(c)
    local out = {}
    for i = 0, c.size - 1 do
      local item = c.get(i)
      if item then out[i + 1] = basic(item) end
    end
    return out
  end

  --- pushItems shared by both: removeItem(fromSlot - 1, limit or 1), then the mod's insert loop (which offers the whole
  --- stack to every slot until one takes all of it)
  local function pushFrom(c, putBack, toName, fromSlot, limit, toSlot, fromMax)
    local location = lookup(toName)
    if not location then error("Target '" .. toName .. "' does not exist", 0) end
    local to = handlerOf(location)
    if not to then error("Target '" .. toName .. "' is not an inventory", 0) end
    local actual = limit or 2147483647
    assertBetween(fromSlot, 1, fromMax, "From slot out of range (%s)")
    if toSlot then assertBetween(toSlot, 1, to.slots(), "To slot out of range (%s)") end
    if actual <= 0 then return 0 end
    local extracted = c.removeItem(fromSlot - 1, limit or 1)
    local count = extracted and extracted.count or 0
    if toSlot then
      local rest = extracted and to.insert(toSlot - 1, extracted, false) or nil
      if not rest then
        core.save()
        return count
      end
      putBack(rest)
      core.save()
      return false, "Couldn't move items to slot " .. (toSlot - 1)
    end
    for i = 0, to.slots() - 1 do
      local rest = extracted and to.insert(i, extracted, false) or nil
      if not rest then break end
      if i == to.slots() - 1 then
        putBack(rest)
        core.save()
        return false, "Couldn't move items"
      end
    end
    core.save()
    return count
  end

  --- pullItems shared by both
  local function pullInto(c, add, canAdd, fullMessage, fromName, fromSlot, limit, toSlot, toMax)
    local location = lookup(fromName)
    if not location then error("Source '" .. fromName .. "' does not exist", 0) end
    local from = handlerOf(location)
    if not from then error("Source '" .. fromName .. "' is not an inventory", 0) end
    local actual = limit or 2147483647
    assertBetween(fromSlot, 1, from.slots(), "From slot out of range (%s)")
    if toSlot then assertBetween(toSlot, 1, toMax, "To slot out of range (%s)") end
    if actual <= 0 then return 0 end
    local extracted = from.extract(fromSlot - 1, limit or 1, true)
    local count = extracted and extracted.count or 0
    if not canAdd(extracted) then return false, fullMessage end
    extracted = from.extract(fromSlot - 1, limit or 1, false)
    if toSlot then
      local here = c.get(toSlot - 1)
      if not here then
        c.set(toSlot - 1, extracted)
      elseif extracted and sameItem(here, extracted) and here.count + extracted.count <= maxStack(here) then
        here.count = here.count + extracted.count
      elseif not extracted and here then
        -- ItemStack.isSameItem(here, EMPTY) is false for a filled slot: nothing to place
        core.save()
        return false, "Couldn't move items to slot " .. toSlot
      else
        core.save()
        return false, "Couldn't move items to slot " .. toSlot
      end
    else
      add(extracted)
    end
    core.save()
    return count
  end

  local function inventoryMethods(o, getC, sameLevel, isPlayer)
    local function start()
      local p, err = cardPlayer(o, sameLevel)
      if not p then return nil, err end
      return p, getC(p)
    end
    local m = {}
    function m.list()
      local p, c = start()
      if not p then return false, c end
      return listOf(c)
    end
    function m.size()
      local p, c = start()
      if not p then return false, c end
      return c.size
    end
    function m.getItemDetail(slot)
      slot = checkInt(1, slot)
      local p, c = start()
      if not p then return false, c end
      assertBetween(slot, 1, c.size, "Slot out of range (%s)")
      local item = c.get(slot - 1)
      if not item then return false end
      return host.itemDetail(item)
    end
    function m.getItemLimit(slot)
      slot = checkInt(1, slot)
      local p, c = start()
      if not p then return false, c end
      assertBetween(slot, 1, c.size, "Slot out of range (%s)")
      local item = c.get(slot - 1)
      return item and maxStack(item) or 64
    end
    function m.pushItems(toName, fromSlot, limit, toSlot)
      toName = checkString(1, toName)
      fromSlot = checkInt(2, fromSlot)
      limit = optInt(3, limit)
      toSlot = optInt(4, toSlot)
      local p, c = start()
      if not p then return false, c end
      local putBack = isPlayer and function(rest) playerAdd(pdata(p), rest) end or function(rest) c.addItem(rest) end
      return pushFrom(c, putBack, toName, fromSlot, limit, toSlot, isPlayer and 36 or c.size)
    end
    function m.pullItems(fromName, fromSlot, limit, toSlot)
      fromName = checkString(1, fromName)
      fromSlot = checkInt(2, fromSlot)
      limit = optInt(3, limit)
      toSlot = optInt(4, toSlot)
      local p, c = start()
      if not p then return false, c end
      local add, canAdd, full
      if isPlayer then
        add = function(stack) playerAdd(pdata(p), stack) end
        canAdd = function(stack) return stack == nil and c.canAddItem({ name = "minecraft:air" }, 36) or c.canAddItem(stack, 36) end
        full = "Player inventory is full"
      else
        add = function(stack) c.addItem(stack) end
        canAdd = function(stack) return stack == nil and c.canAddItem({ name = "minecraft:air" }) or c.canAddItem(stack) end
        full = "Ender chest is full"
      end
      return pullInto(c, add, canAdd, full, fromName, fromSlot, limit, toSlot, isPlayer and 36 or c.size)
    end
    return m
  end

  local EQUIPMENT = { { "mainhand" }, { "offhand", 41 }, { "feet", 37 }, { "legs", 38 }, { "chest", 39 }, { "head", 40 } }

  TYPES.player_interface = function(o, def)
    o.card = newPlayerCard(def.card)
    local function inv(p) return container(pdata(p).inventory, 41) end
    local m = inventoryMethods(o, inv, false, true)
    function m.getPlayerInfo()
      local p, err = cardPlayer(o)
      if not p then return false, err end
      local d = pdata(p)
      local effects = {}
      for id, e in pairs(d.effects) do
        effects[id] = { duration = floor((tonumber(e.duration) or 0) / 20), amplifier = floor(tonumber(e.amplifier) or 0) }
      end
      return {
        name = p.name, uuid = p.uuid,
        pos = { x = p.x, y = p.y, z = p.z },
        hunger = { hunger = d.food, saturation = fround(d.saturation) },
        yaw = fround(p.yaw or 0), pitch = fround(p.pitch or 0),
        effects = effects,
        dimension = p.dimension or "minecraft:overworld",
      }
    end
    function m.getEquipment()
      local p, err = cardPlayer(o)
      if not p then return false, err end
      local d = pdata(p)
      local out = {}
      for _, e in ipairs(EQUIPMENT) do
        local item = d.inventory[e[2] or (d.selected + 1)]
        if item then out[e[1]] = host.itemDetail(item) end
      end
      return out
    end
    function m.consume(slot)
      slot = checkInt(1, slot)
      local p, err = cardPlayer(o)
      if not p then return false, err end
      local d = pdata(p)
      assertBetween(slot, 1, 41, "From slot out of range (%s)")
      local item = d.inventory[slot]
      local food = item and item.food
      if type(food) == "table" then
        -- FoodData.eat(nutrition, saturationModifier), then LivingEntity.eat shrinks the stack
        local nutrition = floor(tonumber(food.nutrition) or 0)
        local mod = fround(tonumber(food.saturation) or 0)
        d.food = math.min(nutrition + d.food, 20)
        d.saturation = math.min(fround(d.saturation + fround(fround(nutrition * mod) * 2)), d.food)
        item.count = item.count - 1
        if item.count <= 0 then d.inventory[slot] = nil end
        return true
      end
      return false, "Item isn't edible"
    end
    function m.lookAt(x, y, z)
      x = checkNumber(1, x)
      y = checkNumber(2, y)
      z = checkNumber(3, z)
      local p, err = cardPlayer(o)
      if not p then return false, err end
      -- Entity.lookAt(EYES, target), from the 1.20.1 jar
      local dx, dy, dz = x - p.x, y - (p.y + EYE), z - p.z
      local horizontal = math.sqrt(dx * dx + dz * dz)
      local pitch = fround(-(mthAtan2(dy, horizontal) * 57.2957763671875))
      if pitch == pitch and pitch ~= math.huge and pitch ~= -math.huge then p.pitch = wrapDegrees(pitch) end
      local yaw = fround(fround(mthAtan2(dz, dx) * 57.2957763671875) - 90)
      if yaw == yaw and yaw ~= math.huge and yaw ~= -math.huge then p.yaw = wrapDegrees(yaw) end
      return true
    end
    function m.displayMessage(text, actionBar)
      text = checkString(1, text)
      actionBar = optBool(2, actionBar)
      local p, err = cardPlayer(o)
      if not p then return false, err end
      local d = pdata(p)
      d.messages[#d.messages + 1] = { text = text, actionBar = actionBar == true }
      core.say(p, text, { actionBar = actionBar == true, from = o.def.name })
      return true
    end
    o.computerThread = { lookAt = true, displayMessage = true }
    return m
  end

  TYPES.ender_chest_interface = function(o, def)
    o.card = newPlayerCard(def.card)
    return inventoryMethods(o, function(p) return container(pdata(p).enderChest, 27) end, true, false)
  end

  -- ===== moreperipherals:scanner: ScannerPeripheral (a book or printout in its slot) =====

  local LINES_PER_PAGE = 21 -- PrintoutItem.LINES_PER_PAGE
  local PRINTOUTS = { ["computercraft:printed_page"] = true, ["computercraft:printed_pages"] = true, ["computercraft:printed_book"] = true }
  local function stackType(item)
    if not item then return "NONE" end
    if item.name == "minecraft:written_book" then return "WRITTEN_AND_SIGNED_BOOK" end
    if item.name == "minecraft:writable_book" then return "WRITTEN_BOOK" end
    if PRINTOUTS[item.name] then return "PRINTED" end
    return "NONE"
  end
  local function guava(index, size)
    java("java.lang.IndexOutOfBoundsException", ("index (%d) must be less than size (%d)"):format(index, size))
  end
  --- Component.Serializer.fromJson(page).getString(), or the page itself when it is not JSON
  local function flatten(c)
    if type(c) == "string" then return c end
    if type(c) == "number" or type(c) == "boolean" then return tostring(c) end
    if type(c) ~= "table" then return "" end
    if c[1] ~= nil then
      local out = {}
      for i, part in ipairs(c) do out[i] = flatten(part) end
      return table.concat(out)
    end
    local s = c.text or c.translate or ""
    for _, part in ipairs(c.extra or {}) do s = s .. flatten(part) end
    return s
  end
  local function pageText(raw)
    local ok, decoded = pcall(textutils.unserializeJSON, raw)
    if ok and decoded ~= nil and raw:match("^%s*[%[{\"%d%-tf]") then return flatten(decoded) end
    return raw
  end

  TYPES["moreperipherals:scanner"] = function(o, def)
    o.item = def.item and normalize(host.copy(def.item)) or nil
    o.types = { "scanner" }
    o.computerThread = { getPage = true, getAuthor = true, getTitle = true, getCopyStatus = true }
    local function book() return o.item and (o.item.book or {}) or {} end
    return {
      getPage = function(page)
        page = checkInt(1, page)
        page = page - 1
        local item = o.item
        if not item then return false, "No Book" end
        local kind, b = stackType(item), book()
        if kind == "PRINTED" then
          local pages = floor(tonumber(b.pages) or 1)
          assertBetween(page, 0, pages, "Expected page number to be %s")
          local n = pages * LINES_PER_PAGE
          if page >= n then aioobe(page, n) end
          return true, (b.lines or {})[page + 1] or ""
        elseif kind == "WRITTEN_AND_SIGNED_BOOK" then
          local list = b.pages or {}
          local valid = b.pages ~= nil and type(b.title) == "string" and #b.title <= 32 and type(b.author) == "string"
          local pages = #list
          assertBetween(page, 0, pages, "Expected page number to be %s")
          if not valid then
            if page >= 1 then guava(page, 1) end
            return true, "* Invalid book tag *"
          end
          if page >= pages then guava(page, pages) end
          return true, pageText(tostring(list[page + 1]))
        elseif kind == "WRITTEN_BOOK" then
          if b.pages == nil then
            assertBetween(page, 0, 1, "Expected page number to be %s")
            if page >= 1 then guava(page, 1) end
            -- the invalid-tag placeholder is JSON, read as plain text here: FormattedText.of(json)
            return true, '{"color":"dark_red","translate":"book.invalid.tag"}'
          end
          local list = b.pages
          assertBetween(page, 0, #list, "Expected page number to be %s")
          if page >= #list then guava(page, #list) end
          return true, tostring(list[page + 1])
        end
        return false, "No scannable on scanner"
      end,
      getAuthor = function()
        if not o.item then return false, "No Book" end
        if stackType(o.item) == "WRITTEN_AND_SIGNED_BOOK" then return true, tostring(book().author or "") end
        return false, "No author"
      end,
      getTitle = function()
        if not o.item then return false, "No Book" end
        local kind = stackType(o.item)
        if kind == "WRITTEN_AND_SIGNED_BOOK" or kind == "PRINTED" then return true, tostring(book().title or "") end
        return false, "No Title"
      end,
      getCopyStatus = function()
        if stackType(o.item) == "WRITTEN_AND_SIGNED_BOOK" then
          local g = floor(tonumber(book().generation) or 0)
          local names = { "ORIGINAL", "COPY", "COPY OF COPY" }
          if g < 0 or g >= 3 then aioobe(g, 3) end
          return true, names[g + 1]
        end
        return false, "Not a Written Book"
      end,
    }
  end

  -- ===== grinder: GrinderPeripheral (one sword slot) =====

  local function isSword(item)
    if not item then return false end
    if item.sword ~= nil then return item.sword == true end
    return data.itemHasTag(item.name, "minecraft:swords")
  end

  TYPES.grinder = function(o, def)
    o.sword = def.sword and normalize(host.copy(def.sword)) or nil
    return {
      attack = function()
        o.attacks = (o.attacks or 0) + 1 -- entities are not simulated: the swing reaches nothing
      end,
      hasSword = function() return isSword(o.sword) end,
      pullSword = function(from, slot)
        from = checkString(1, from)
        slot = checkInt(2, slot)
        local entry = lookup(from)
        if not entry then return false, "the input " .. from .. " was not found" end
        local input = handlerOf(entry)
        if outOfRange(slot, input, "inputHandler") then return false, "slot out of range" end
        local stack = input.get(slot) -- the mod does not take one off: slot is 0-based here
        if isSword(stack) then
          if not isSword(o.sword) then
            o.sword = copyItem(stack)
            input.extract(slot, 1, false)
            core.save()
            return true
          end
          return false, "there is a sword in the grinder already"
        end
        return false
      end,
      pushSword = function(to)
        to = checkString(1, to)
        local entry = lookup(to)
        if not entry then return false, "the output " .. to .. " was not found" end
        local target = handlerOf(entry)
        if not target then npe("net.minecraftforge.items.IItemHandler.getSlots()", "inputHandler") end
        local stack = copyItem(o.sword)
        for i = 0, target.slots() - 1 do
          if not target.get(i) then
            if stack then target.insert(i, stack, false) end
            o.sword = nil
            core.save()
            return true
          end
        end
        return false, "target inventory is full"
      end,
    }
  end

  -- ===== the module =====

  local function state(o)
    if o.kind == "xp_collector" then return { xp = o.xp } end
    if o.kind == "magnetic_card_manipulator" then
      local c = o.card
      return { card = c and { data = c.__tag and c.__tag.data, sensible = c.__tag and c.__tag.sensible, label = c.displayName } or nil,
        ejected = o.dropped }
    end
    if o.kind == "beehive_interface" then return { beehive = host.copy(o.hive), beehives = o.hives } end
    if o.kind == "trading_interface" then return { villager = o.villager and host.copy(o.villager) or nil } end
    if o.kind == "spawner_interface" then
      return { spawner = o.spawner and o.spawner.mob or nil, spawners = o.spawners, dropped = o.dropped }
    end
    if o.kind == "player_interface" or o.kind == "ender_chest_interface" then
      local p = o.card and o.card.uuid and core.byUuid[o.card.uuid]
      local out = { card = o.card and host.copy(o.card) or nil }
      if p then
        local d = pdata(p)
        out.player = { name = p.name, yaw = p.yaw, pitch = p.pitch, food = d.food, saturation = d.saturation,
          inventory = host.copy(d.inventory), enderChest = host.copy(d.enderChest), messages = host.copy(d.messages) }
      end
      return out
    end
    if o.kind == "moreperipherals:scanner" then return { item = o.item and host.copy(o.item) or nil } end
    if o.kind == "grinder" then return { sword = o.sword and host.copy(o.sword) or nil, attacks = o.attacks } end
    return {}
  end

  function M.peripheral(def)
    local o = { kind = def.type, def = def }
    objects[def.name] = o
    local methods = TYPES[def.type](o, def)
    return {
      methods = methods,
      types = o.types,
      -- every method is mainThread = true unless the mod says otherwise (the scanner's, lookAt, displayMessage)
      computerThread = o.computerThread or {},
      exactReturns = true,
      state = function() return state(o) end,
      __mp = o,
    }
  end

  -- ===== sim commands =====

  local function find(cmd, kind)
    local o = objects[cmd.peripheral]
    if not o then return nil, "no More Peripherals block named " .. tostring(cmd.peripheral) end
    if kind and o.kind ~= kind and not (type(kind) == "table" and kind[o.kind]) then
      return nil, tostring(cmd.peripheral) .. " is a " .. o.kind
    end
    return o
  end

  local handlers = {}

  --- experience orbs reach the collector
  function handlers.mpAddXP(cmd)
    local o, err = find(cmd, "xp_collector")
    if not o then return false, err end
    o.xp = o.xp + floor(tonumber(cmd.amount) or 0)
    return true
  end

  --- a player puts a magnetic card in through the GUI (card_insert) or takes it out (card: null, card_remove)
  function handlers.mpSetCard(cmd)
    local o, err = find(cmd, "magnetic_card_manipulator")
    if not o then return false, err end
    if cmd.card == nil or cmd.card == false then
      o.removeCard()
    else
      o.card = newCard(cmd.card)
      os.queueEvent("card_insert")
    end
    return true
  end

  --- a player uses a card on the manipulator: card_read with the card's data (nothing for a card with no data)
  function handlers.mpSwipeCard(cmd)
    local o, err = find(cmd, "magnetic_card_manipulator")
    if not o then return false, err end
    if cmd.data ~= nil then
      -- StringTag.toString(), then the mod cuts off the first and last character (the quotes)
      local s, quote = tostring(cmd.data), nil
      local out = {}
      for ch in s:gmatch(".") do
        if ch == "\\" then out[#out + 1] = "\\"
        elseif ch == '"' or ch == "'" then
          if not quote then quote = ch == '"' and "'" or '"' end
          if quote == ch then out[#out + 1] = "\\" end
        end
        out[#out + 1] = ch
      end
      os.queueEvent("card_read", table.concat(out))
    end
    return true
  end

  function handlers.mpSetBeehive(cmd)
    local o, err = find(cmd, "beehive_interface")
    if not o then return false, err end
    if cmd.beehive ~= nil then o.hive = newHive(cmd.beehive) end
    if cmd.beehives ~= nil then o.hives = tonumber(cmd.beehives) or 0
    elseif cmd.beehive ~= nil then o.hives = o.hive and 1 or 0 end
    return true
  end

  function handlers.mpSetVillager(cmd)
    local o, err = find(cmd, "trading_interface")
    if not o then return false, err end
    o.villager = newVillager(cmd.villager)
    return true
  end

  function handlers.mpSetSpawner(cmd)
    local o, err = find(cmd, "spawner_interface")
    if not o then return false, err end
    if cmd.mob ~= nil then o.spawner = cmd.mob ~= false and { mob = tostring(cmd.mob) } or nil end
    if cmd.spawners ~= nil then o.spawners = tonumber(cmd.spawners) or 0
    else o.spawners = o.spawner and 1 or 0 end
    return true
  end

  function handlers.mpSetPlayerCard(cmd)
    local o, err = find(cmd, { player_interface = true, ender_chest_interface = true })
    if not o then return false, err end
    o.card = newPlayerCard(cmd.card)
    return true
  end

  --- a player's carried things: inventory/enderChest slot -> item (or null), selected, food, saturation, effects
  function handlers.mpSetPlayer(cmd)
    local p = core.findPlayer(cmd.player)
    if not p then return false, "no player " .. tostring(cmd.player) end
    local d = pdata(p)
    for _, key in ipairs({ "inventory", "enderChest" }) do
      if type(cmd[key]) == "table" then
        for k, item in pairs(cmd[key]) do
          local n = tonumber(k)
          if n then d[key][n] = item ~= false and normalize(host.copy(item)) or nil end
        end
      end
    end
    if cmd.selected ~= nil then d.selected = tonumber(cmd.selected) or 0 end
    if cmd.food ~= nil then d.food = tonumber(cmd.food) or 0 end
    if cmd.saturation ~= nil then d.saturation = tonumber(cmd.saturation) or 0 end
    if cmd.effects ~= nil then d.effects = host.copy(cmd.effects) end
    if cmd.online ~= nil then p.online = cmd.online == true end
    if cmd.dimension ~= nil then p.dimension = tostring(cmd.dimension) end
    return true
  end

  function handlers.mpSetScannerItem(cmd)
    local o, err = find(cmd, "moreperipherals:scanner")
    if not o then return false, err end
    o.item = type(cmd.item) == "table" and normalize(host.copy(cmd.item)) or nil
    return true
  end

  M.handlers = handlers
  function M.state()
    local players = {}
    for uuid, d in pairs(playerData) do
      local p = core.byUuid[uuid]
      players[p and p.name or uuid] = { food = d.food, saturation = d.saturation, selected = d.selected,
        inventory = host.copy(d.inventory), enderChest = host.copy(d.enderChest), messages = host.copy(d.messages) }
    end
    return { players = players }
  end
  return M
end
