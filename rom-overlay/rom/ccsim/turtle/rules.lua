-- ccsim turtle rules: the parts of vanilla Minecraft 1.18.2 block behaviour a turtle runs into that are code, not
-- data (Material, Block properties, getStateForPlacement, canSurvive, FallingBlock). docs/turtle/cct-1.101.3-turtle-
-- rules.md has the CC side. A world can extend the lists in world.gameData (liquids, replaceable, unbreakable,
-- instabreak, gravity, requiresTool, placesBlock).
return function(data, extra)
  local M = {}
  extra = extra or {}

  local function set(list, prefix)
    local t = {}
    for _, id in ipairs(list) do t[(prefix or "minecraft:") .. id] = true end
    return t
  end
  local function merged(base, name)
    for _, id in ipairs(extra[name] or {}) do base[data.id(id)] = true end
    return base
  end

  local AIR = set({ "air", "cave_air", "void_air" })
  M.LIQUIDS = merged(set({ "water", "lava", "bubble_column" }), "liquids")
  -- Material.isReplaceable (spec 3.2): what a turtle can move into
  M.REPLACEABLE = merged(set({ "air", "cave_air", "void_air", "light", "structure_void", "water", "lava", "bubble_column",
    "grass", "tall_grass", "fern", "large_fern", "dead_bush", "vine", "glow_lichen", "hanging_roots", "sunflower", "lilac",
    "rose_bush", "peony", "nether_sprouts", "crimson_roots", "warped_roots", "seagrass", "tall_seagrass", "snow", "fire",
    "soul_fire" }), "replaceable")
  -- hardness below 0 (getDestroyProgress <= 0)
  M.UNBREAKABLE = merged(set({ "bedrock", "barrier", "end_portal_frame", "end_portal", "end_gateway", "nether_portal",
    "command_block", "chain_command_block", "repeating_command_block", "structure_block", "jigsaw", "moving_piston",
    "light" }), "unbreakable")
  -- getDestroySpeed == 0: broken by any tool, even one with a breakable tag
  M.INSTABREAK = merged(set({ "torch", "wall_torch", "soul_torch", "soul_wall_torch", "redstone_torch", "redstone_wall_torch",
    "redstone_wire", "repeater", "comparator", "tripwire", "tripwire_hook", "lily_pad", "flower_pot", "scaffolding", "tnt",
    "slime_block", "sugar_cane", "grass", "tall_grass", "fern", "large_fern", "dead_bush", "seagrass", "tall_seagrass",
    "kelp", "kelp_plant", "sea_pickle", "nether_sprouts", "crimson_roots", "warped_roots", "crimson_fungus", "warped_fungus",
    "brown_mushroom", "red_mushroom", "wheat", "carrots", "potatoes", "beetroots", "melon_stem", "pumpkin_stem",
    "attached_melon_stem", "attached_pumpkin_stem", "sweet_berry_bush", "cave_vines", "cave_vines_plant", "spore_blossom",
    "small_dripleaf", "fire", "soul_fire", "structure_void" }),
    "instabreak")
  M.GRAVITY = merged(set({ "sand", "red_sand", "gravel", "anvil", "chipped_anvil", "damaged_anvil", "dragon_egg",
    "white_concrete_powder", "orange_concrete_powder", "magenta_concrete_powder", "light_blue_concrete_powder",
    "yellow_concrete_powder", "lime_concrete_powder", "pink_concrete_powder", "gray_concrete_powder",
    "light_gray_concrete_powder", "cyan_concrete_powder", "purple_concrete_powder", "blue_concrete_powder",
    "brown_concrete_powder", "green_concrete_powder", "red_concrete_powder", "black_concrete_powder" }), "gravity")

  function M.isAir(block) return block == nil or AIR[block.name] == true end
  function M.isLiquid(block) return block ~= nil and M.LIQUIDS[block.name] == true end
  function M.isReplaceable(block) return block == nil or M.REPLACEABLE[block.name] == true end
  function M.isUnbreakable(block) return block ~= nil and M.UNBREAKABLE[block.name] == true end
  function M.isInstabreak(block)
    return block ~= nil and (M.INSTABREAK[block.name] == true or data.blockHasTag(block.name, "minecraft:flowers")
      or data.blockHasTag(block.name, "minecraft:saplings") or data.blockHasTag(block.name, "minecraft:crops"))
  end
  function M.hasGravity(block) return block ~= nil and M.GRAVITY[block.name] == true end

  -- Collision (spec 3.2: only snow with 2+ layers stops a mob from being pushed aside). Blocks with no collision
  -- shape can hold an item entity falling through them.
  function M.hasCollision(block)
    if block == nil or M.isAir(block) or M.isLiquid(block) then return false end
    if block.name == "minecraft:snow" then return tonumber(block.state.layers or 1) >= 2 end
    if M.REPLACEABLE[block.name] or M.isInstabreak(block) then return false end
    local n = block.name
    if n:find("_sign$") or n:find("_banner$") or n:find("_button$") or n:find("_pressure_plate$") or n:find("rail$")
      or n == "minecraft:lever" or n == "minecraft:cobweb" or n:find("torch") then
      return false
    end
    return true
  end

  -- ===== tools (spec 4) =====

  -- Blocks a pickaxe-only material needs the right tool for (requiresCorrectToolForDrops). Approximated as every
  -- block in mineable/pickaxe, less the ones vanilla lets anything harvest.
  local PICKAXE_FREE = merged(set({ "rail", "powered_rail", "detector_rail", "activator_rail", "piston", "sticky_piston",
    "piston_head", "stone_button", "polished_blackstone_button", "ice", "packed_ice", "blue_ice", "frosted_ice",
    "lever" }), "pickaxeFree")
  local ALWAYS_NEEDS = merged(set({ "cobweb", "snow", "snow_block", "powder_snow" }), "requiresTool")

  local TOOL_TAG = {
    ["minecraft:diamond_pickaxe"] = "minecraft:mineable/pickaxe",
    ["minecraft:diamond_axe"] = "minecraft:mineable/axe",
    ["minecraft:diamond_shovel"] = "minecraft:mineable/shovel",
    ["minecraft:diamond_hoe"] = "minecraft:mineable/hoe",
  }

  function M.requiresCorrectTool(block)
    if ALWAYS_NEEDS[block.name] then return true end
    return data.blockHasTag(block.name, "minecraft:mineable/pickaxe") and not PICKAXE_FREE[block.name]
  end

  --- Tier diamond is correct for every needs_*_tool tag, so only the mineable tag matters.
  function M.isCorrectTool(tool, block)
    local tag = TOOL_TAG[tool]
    if tag and data.blockHasTag(block.name, tag) then return true end
    if tool == "minecraft:diamond_sword" and block.name == "minecraft:cobweb" then return true end
    if tool == "minecraft:shears" and (block.name == "minecraft:cobweb" or data.blockHasTag(block.name, "minecraft:leaves")) then return true end
    if tool == "minecraft:diamond_shovel" and (block.name == "minecraft:snow" or block.name == "minecraft:snow_block") then return true end
    return false
  end

  -- The default CC tool upgrades (spec 4.1): breakable tag (nil: anything) and attack multiplier
  M.TOOLS = {
    ["minecraft:diamond_pickaxe"] = { multiplier = 3 },
    ["minecraft:diamond_axe"] = { multiplier = 6 },
    ["minecraft:diamond_shovel"] = { multiplier = 3, breakable = function(b)
      return data.blockHasTag(b.name, "minecraft:mineable/shovel") or b.name == "minecraft:melon" or b.name == "minecraft:pumpkin"
        or b.name == "minecraft:carved_pumpkin" or b.name == "minecraft:jack_o_lantern"
    end, flattens = true },
    ["minecraft:diamond_hoe"] = { multiplier = 3, breakable = function(b)
      return data.blockHasTag(b.name, "minecraft:crops") or data.blockHasTag(b.name, "minecraft:mineable/hoe")
        or b.name == "minecraft:cactus" or b.name == "minecraft:melon" or b.name == "minecraft:pumpkin"
        or b.name == "minecraft:carved_pumpkin" or b.name == "minecraft:jack_o_lantern"
    end, tills = true },
    ["minecraft:diamond_sword"] = { multiplier = 9, breakable = function(b)
      return data.blockHasTag(b.name, "minecraft:wool") or b.name == "minecraft:cobweb"
    end },
  }
  function M.alwaysBreakable(block)
    return data.blockHasTag(block.name, "minecraft:leaves") or block.name == "minecraft:bamboo" or block.name == "minecraft:bamboo_sapling"
  end

  -- ===== items that place blocks (BlockItem, Item.BY_BLOCK) =====

  -- An item whose block has another id. Wall variants are picked from the clicked face.
  local PLACES = {
    redstone = "redstone_wire", string = "tripwire", wheat_seeds = "wheat", beetroot_seeds = "beetroots",
    carrot = "carrots", potato = "potatoes", melon_seeds = "melon_stem", pumpkin_seeds = "pumpkin_stem",
    sweet_berries = "sweet_berry_bush", glow_berries = "cave_vines", cocoa_beans = "cocoa", powder_snow_bucket = "powder_snow",
  }
  local WALL = {
    torch = "wall_torch", soul_torch = "soul_wall_torch", redstone_torch = "redstone_wall_torch",
  }

  --- The block an item places, and whether it is a BlockItem at all.
  function M.blockFor(itemId, face)
    local over = extra.placesBlock and extra.placesBlock[itemId]
    if over then return data.id(over) end
    if itemId == "computercraft:wired_modem" then return "computercraft:cable" end -- ItemBlockCable.WiredModem
    local path = itemId:match("^minecraft:(.+)$")
    if path then
      if PLACES[path] then return "minecraft:" .. PLACES[path] end
      local horizontal = face ~= "up" and face ~= "down"
      if WALL[path] then return "minecraft:" .. (horizontal and WALL[path] or path) end
      if path:find("_sign$") then return "minecraft:" .. (horizontal and path:gsub("_sign$", "_wall_sign") or path) end
      if path:find("_banner$") then return "minecraft:" .. (horizontal and path:gsub("_banner$", "_wall_banner") or path) end
      if path:find("_head$") or path:find("_skull$") then
        return "minecraft:" .. (horizontal and path:gsub("_head$", "_wall_head"):gsub("_skull$", "_wall_skull") or path)
      end
      if path:find("_bucket$") or path == "bucket" then return nil end
    end
    if itemId:match("^computercraft:pocket_computer") or itemId == "computercraft:disk" or itemId == "computercraft:treasure_disk"
      or itemId:match("^computercraft:printed") then
      return nil
    end
    if data.isBlock(itemId) then return itemId end
    return nil
  end

  -- ===== placement (getStateForPlacement) =====

  local HORIZONTAL = { north = true, south = true, east = true, west = true }
  local OPP = { north = "south", south = "north", east = "west", west = "east", up = "down", down = "up" }
  local AXIS = { north = "z", south = "z", east = "x", west = "x", up = "y", down = "y" }

  -- Any other 6-way block (piston, dispenser, dropper, barrel, command block) faces back at the player
  -- (nearestLookingDirection().getOpposite()). 6-way blocks set by the clicked face:
  local FACE_CLICKED_6 = set({ "end_rod", "lightning_rod", "amethyst_cluster", "large_amethyst_bud", "medium_amethyst_bud",
    "small_amethyst_bud", "shulker_box" })
  -- horizontal blocks that face where the player looks (not back at them)
  local LOOK_SAME = set({ "anvil", "chipped_anvil", "damaged_anvil" })
  -- wall blocks: facing is the clicked face
  local function wallMounted(name)
    return name:find("wall_torch$") or name:find("_wall_sign$") or name:find("_wall_banner$") or name:find("_wall_head$")
      or name:find("_wall_skull$") or name == "minecraft:ladder" or name == "minecraft:tripwire_hook"
      or name == "minecraft:cocoa"
  end

  --- `ctx` = { face = clicked face, look = direction the fake player looks (6-way), yaw = its horizontal facing,
  --- pitch = degrees (90 looking down) }. Returns the state for the block, or nil and why it cannot go there.
  function M.placementState(name, ctx)
    local props = data.blockProperties(name) or {}
    local state = {}
    local function has(p) return props[p] ~= nil end
    local function allows(p, v)
      for _, x in ipairs(props[p] or {}) do if x == v then return true end end
      return false
    end
    if has("axis") then state.axis = AXIS[ctx.face] end
    if has("facing") then
      local six = allows("facing", "up")
      local nearest = ctx.look
      if FACE_CLICKED_6[name] or (six and name:find("shulker_box$")) then
        state.facing = ctx.face
      elseif name == "minecraft:hopper" then
        local f = OPP[ctx.face]
        state.facing = f == "up" and "down" or f
      elseif name == "minecraft:observer" then
        state.facing = nearest
      elseif six then
        state.facing = OPP[nearest]
      elseif wallMounted(name) then
        if not HORIZONTAL[ctx.face] then return nil, "wall" end
        state.facing = ctx.face
      elseif name:find("_trapdoor$") then
        -- TrapDoorBlock: a side click hangs it on that side; a top or bottom click faces it back at the player
        state.facing = HORIZONTAL[ctx.face] and ctx.face or OPP[ctx.yaw]
        state.half = ctx.face == "down" and "top" or "bottom"
      elseif name:find("_stairs$") or name:find("_fence_gate$") or name:find("_door$") or name:find("_bed$") or LOOK_SAME[name] then
        state.facing = ctx.yaw
      else
        state.facing = OPP[ctx.yaw]
      end
    end
    if has("half") and not state.half then
      if allows("half", "lower") then state.half = "lower"
      else state.half = ctx.face == "down" and "top" or "bottom" end
    end
    if has("type") and allows("type", "double") then
      state.type = ctx.face == "down" and "top" or "bottom"
    end
    if has("rotation") then
      -- floor signs, banners and heads: RotationSegment from the player's yaw, 16 steps
      local yawDeg = ({ south = 0, west = 90, north = 180, east = 270 })[ctx.yaw] or 0
      state.rotation = tostring(math.floor((yawDeg + 180) * 16 / 360 + 0.5) % 16)
    end
    if name:match("^computercraft:turtle_") then
      state.facing = ctx.yaw -- BlockTurtle.getStateForPlacement: the way the placer looks
    end
    if name:match("^computercraft:monitor_") then
      -- BlockMonitor: looking steeply down puts the screen face up, steeply up face down
      state.orientation = ctx.pitch > 66.5 and "up" or ctx.pitch < -66.5 and "down" or "north"
      state.facing = OPP[ctx.yaw]
    end
    if has("face") then
      state.face = ctx.face == "up" and "floor" or ctx.face == "down" and "ceiling" or "wall"
      state.facing = HORIZONTAL[ctx.face] and ctx.face or ctx.yaw
    end
    if has("waterlogged") then state.waterlogged = ctx.inWater and "true" or "false" end
    return state
  end

  --- Can the block stand at `below`/`behind` (canSurvive)? Only the cases a turtle meets often.
  function M.canSurvive(name, state, support)
    -- support(dir) -> the block on that side of the new block
    local below = support("down")
    local function solid(b) return b ~= nil and M.hasCollision(b) and not M.isLiquid(b) end
    local path = name:match("^minecraft:(.+)$") or ""
    if path == "torch" or path == "soul_torch" or path == "redstone_torch" or path == "redstone_wire" or path:find("_carpet$")
      or path:find("_pressure_plate$") or path == "repeater" or path == "comparator" or path:find("rail$")
      or path:find("_sign$") and not path:find("_wall_sign$") or path:find("_banner$") and not path:find("_wall_banner$") then
      return solid(below)
    end
    if path:find("wall_torch$") or path:find("_wall_sign$") or path:find("_wall_banner$") or path == "ladder" then
      local f = state.facing
      return f ~= nil and solid(support(OPP[f]))
    end
    if data.blockHasTag(name, "minecraft:saplings") or data.blockHasTag(name, "minecraft:small_flowers") or path == "grass"
      or path == "fern" or path == "tall_grass" then
      return below ~= nil and (data.blockHasTag(below.name, "minecraft:dirt") or below.name == "minecraft:farmland")
    end
    if data.blockHasTag(name, "minecraft:crops") then return below ~= nil and below.name == "minecraft:farmland" end
    if path == "cactus" then return below ~= nil and (below.name == "minecraft:cactus" or data.blockHasTag(below.name, "minecraft:sand")) end
    if path == "sugar_cane" then
      return below ~= nil and (below.name == "minecraft:sugar_cane" or data.blockHasTag(below.name, "minecraft:dirt")
        or data.blockHasTag(below.name, "minecraft:sand"))
    end
    return true
  end

  --- What a dug block leaves behind: a waterlogged block keeps its water.
  function M.leftBehind(block)
    if block and block.state and (block.state.waterlogged == "true" or block.state.waterlogged == true) then
      return { name = "minecraft:water", state = { level = "0" } }
    end
    return nil
  end

  --- The item a block is (Block.asItem), for compare. Blocks with no item are minecraft:air.
  function M.asItem(block)
    if block == nil then return "minecraft:air" end
    local n = block.name
    local path = n:match("^minecraft:(.+)$")
    if path then
      local reverse = { redstone_wire = "redstone", tripwire = "string", wheat = "wheat_seeds", beetroots = "beetroot_seeds",
        carrots = "carrot", potatoes = "potato", melon_stem = "melon_seeds", pumpkin_stem = "pumpkin_seeds",
        sweet_berry_bush = "sweet_berries", cave_vines = "glow_berries", cave_vines_plant = "glow_berries", cocoa = "cocoa_beans",
        wall_torch = "torch", soul_wall_torch = "soul_torch", redstone_wall_torch = "redstone_torch", kelp_plant = "kelp",
        powder_snow = "powder_snow_bucket", attached_melon_stem = "melon_seeds", attached_pumpkin_stem = "pumpkin_seeds" }
      if reverse[path] then return "minecraft:" .. reverse[path] end
      local wall = path:match("^(.+)_wall_sign$") or path:match("^(.+)_wall_banner$")
      if wall then return "minecraft:" .. wall .. (path:find("sign$") and "_sign" or "_banner") end
      local head = path:match("^(.+)_wall_head$") or path:match("^(.+)_wall_skull$")
      if head then return "minecraft:" .. head .. (path:find("head$") and "_head" or "_skull") end
    end
    if data.isItem(n) then return n end
    return "minecraft:air"
  end

  M.OPP = OPP
  M.HORIZONTAL = HORIZONTAL
  return M
end
