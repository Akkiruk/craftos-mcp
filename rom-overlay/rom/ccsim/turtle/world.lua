-- ccsim turtle world: the blocks, dropped items and mobs around a turtle.
--
-- The world file describes it (world.blocks, world.fills, world.ground, world.items, world.entities; see
-- docs/turtle.md); everything else is air. Every block the sim changes is kept, so state.json can say what the
-- turtle built or dug.
return function(core, data)
  local M = {}
  local floor = math.floor

  local blocks = {}     -- "x,y,z" -> block
  local changed = {}    -- "x,y,z" -> true: blocks the sim set or removed
  local fills = {}      -- { from = {x,y,z}, to = {x,y,z}, block }
  local ground = nil    -- { y = top of the ground, name = block }
  M.itemEntities = {}   -- { x, y, z, item, age } dropped stacks lying in the world
  M.entities = {}       -- { x, y, z, type, health, ... } mobs a turtle can hit

  -- Build limits (DimensionType): the overworld is -64..319 in 1.18, the nether and the end 0..255
  local LIMITS = {
    ["minecraft:overworld"] = { -64, 319 },
    ["minecraft:the_nether"] = { 0, 255 },
    ["minecraft:the_end"] = { 0, 255 },
  }
  function M.limits(dimension)
    local l = LIMITS[dimension or "minecraft:overworld"] or LIMITS["minecraft:overworld"]
    return l[1], l[2]
  end

  local function key(x, y, z) return x .. "," .. y .. "," .. z end
  M.key = key

  local function copyState(state)
    local out = {}
    for k, v in pairs(state or {}) do out[k] = v end
    return out
  end

  --- A block as the sim holds it. `def` is a world-file entry: { name, state?, items?, size?, blockEntity?, ... }
  function M.newBlock(def)
    local name = data.id(def.name)
    local block = { name = name, state = copyState(def.state), blockEntity = def.blockEntity, def = def }
    if name == "computercraft:cable" and block.state.modem == nil then
      -- the game data lists the modem values a cable can take but not "none", its default
      block.state.modem = "none"
      if block.state.cable == nil then block.state.cable = "true" end
    end
    -- fill in the state the block has by default for any property the world left out (the first value listed in
    -- its blockstate file is a guess the world can override; the properties themselves are real)
    local props = data.blockProperties(name)
    local known = data.defaultState(name)
    if known then
      for prop, v in pairs(known) do
        if block.state[prop] == nil then block.state[prop] = v end
      end
    elseif props then
      for prop, values in pairs(props) do
        if block.state[prop] == nil then
          local wants = M.defaultState[prop]
          if type(wants) ~= "table" then wants = { wants } end
          for _, want in ipairs(wants) do
            for _, v in ipairs(values) do
              if v == want and block.state[prop] == nil then block.state[prop] = v end
            end
          end
          if block.state[prop] == nil then block.state[prop] = values[1] end
        end
      end
    end
    return block
  end

  -- Default values for common properties (Block.defaultBlockState in vanilla)
  M.defaultState = {
    waterlogged = "false", powered = "false", lit = "false", open = "false", snowy = "false", persistent = "false",
    axis = "y", facing = "north", half = { "bottom", "lower" }, type = { "bottom", "single", "normal" },
    shape = { "straight", "north_south" }, level = "0", age = "0", layers = "1", hinge = "left", attached = "false",
    triggered = "false", enabled = "true", occupied = "false", part = "foot",
    north = { "false", "none" }, south = { "false", "none" }, east = { "false", "none" }, west = { "false", "none" },
    up = { "false", "true" }, down = "false", distance = "7", stage = "0", rotation = "0", face = "wall",
    mode = "save", state = { "off", "empty", "none" }, power = "0", note = "0", instrument = "harp", moisture = "0",
    bites = "0", charges = "0", delay = "1", eggs = "1", hatch = "0", pickles = "1", candles = "1", honey_level = "0",
    orientation = "north", attachment = "floor", tilt = "none", thickness = "tip", vertical_direction = "up",
    sculk_sensor_phase = "inactive", inverted = "false", extended = "false", short = "false", locked = "false",
    unstable = "false", conditional = "false", drag = "true", has_book = "false", has_record = "false", bottom = "false",
    in_wall = "false", disarmed = "false", signal_fire = "false", hanging = "false", berries = "false",
  }

  local function inFill(f, x, y, z)
    return x >= f.x1 and x <= f.x2 and y >= f.y1 and y <= f.y2 and z >= f.z1 and z <= f.z2
  end

  --- The block at a position, or nil for air.
  function M.get(x, y, z)
    local k = key(x, y, z)
    local b = blocks[k]
    if b ~= nil then return b or nil end
    -- later fills cover earlier ones
    for i = #fills, 1, -1 do
      local f = fills[i]
      if inFill(f, x, y, z) then
        if f.air then return nil end
        local block = M.newBlock(f.def)
        blocks[k] = block -- materialise it, so the block keeps its own state and inventory from now on
        return block
      end
    end
    if ground and y <= ground.y then
      local lo = M.limits(core.position.dimension)
      if y >= lo then
        local block = M.newBlock({ name = y == ground.y and ground.top or ground.name })
        blocks[k] = block
        return block
      end
    end
    return nil
  end

  --- The name of the block at a position, or nil for air, without making the block: for a scan over many blocks.
  function M.nameAt(x, y, z)
    local b = blocks[key(x, y, z)]
    if b ~= nil then return b and b.name or nil end
    for i = #fills, 1, -1 do
      local f = fills[i]
      if inFill(f, x, y, z) then
        if f.air then return nil end
        return data.id(f.def.name)
      end
    end
    if ground and y <= ground.y and y >= M.limits(core.position.dimension) then
      return y == ground.y and ground.top or ground.name
    end
    return nil
  end

  --- The lowest y at which anything but the plain ground can be: below it every block has ground on all six sides.
  --- nil when the world has no ground.
  function M.lowest()
    if not ground then return nil end
    local low = ground.y
    for _, f in ipairs(fills) do if f.y1 < low then low = f.y1 end end
    for k in pairs(changed) do
      local y = tonumber(k:match("^-?%d+,(-?%d+),"))
      if y and y < low then low = y end
    end
    for _, def in ipairs(core.world.blocks or {}) do
      local y = def.y or def[2]
      if y and y < low then low = y end
    end
    return low
  end

  --- Forget a block the world file put where this computer itself stands (a placed turtle's own block), unchanged.
  function M.forget(x, y, z) blocks[key(x, y, z)] = false end

  M.changedCount = 0 -- blocks in `changed`
  M.unsaved = 0      -- background changes since state.json was last gathered (M.state)

  --- Put a block (or air, for nil) at a position. `background`: a change the world made on its own (water flowing, a
  --- crop growing; living.lua decides when those are written), counted in M.unsaved instead of marking state dirty.
  function M.set(x, y, z, block, background)
    local k = key(x, y, z)
    blocks[k] = block or false
    if not changed[k] then
      changed[k] = true
      M.changedCount = M.changedCount + 1
    end
    if background then M.unsaved = M.unsaved + 1 else core.dirty = true end
    if M.onChange then M.onChange(x, y, z, block) end
  end

  function M.load(world)
    for _, f in ipairs(world.fills or {}) do
      local a, b = f.from or {}, f.to or {}
      fills[#fills + 1] = {
        x1 = math.min(a[1] or a.x, b[1] or b.x), x2 = math.max(a[1] or a.x, b[1] or b.x),
        y1 = math.min(a[2] or a.y, b[2] or b.y), y2 = math.max(a[2] or a.y, b[2] or b.y),
        z1 = math.min(a[3] or a.z, b[3] or b.z), z2 = math.max(a[3] or a.z, b[3] or b.z),
        air = f.name == nil or data.id(f.name) == "minecraft:air", def = f,
      }
    end
    if type(world.ground) == "table" then
      ground = { y = world.ground.y or 63, name = data.id(world.ground.name or "minecraft:stone") }
      ground.top = world.ground.top and data.id(world.ground.top) or ground.name
    end
    for _, def in ipairs(world.blocks or {}) do
      local x, y, z = def.x or def[1], def.y or def[2], def.z or def[3]
      if def.name == nil or data.id(def.name) == "minecraft:air" then
        blocks[key(x, y, z)] = false
      else
        blocks[key(x, y, z)] = M.newBlock(def)
      end
    end
    for _, it in ipairs(world.items or {}) do
      M.itemEntities[#M.itemEntities + 1] = { x = it.x, y = it.y, z = it.z, item = { name = data.id(it.name), count = it.count or 1, nbt = it.nbt } }
    end
    for _, e in ipairs(world.entities or {}) do
      if e.x and e.y and e.z and (e.type or e.name) then M.entities[#M.entities + 1] = e end
    end
  end

  --- Saved changes from an earlier boot of the same computer (state.json), applied over the world file.
  function M.restore(saved)
    for k, def in pairs(saved or {}) do
      local x, y, z = k:match("^(-?%d+),(-?%d+),(-?%d+)$")
      if x then
        x, y, z = tonumber(x), tonumber(y), tonumber(z)
        if def == false or (type(def) == "table" and def.name == nil) then blocks[key(x, y, z)] = false
        else blocks[key(x, y, z)] = M.newBlock(def) end
        if not changed[key(x, y, z)] then
          changed[key(x, y, z)] = true
          M.changedCount = M.changedCount + 1
        end
      end
    end
  end

  local function deepCopy(v)
    if type(v) ~= "table" then return v end
    local out = {}
    for k, x in pairs(v) do out[k] = deepCopy(x) end
    return out
  end

  --- Every block the sim changed, "x,y,z" -> { name, state, items } or { } for air.
  function M.state()
    M.unsaved = 0 -- this write takes every change with it
    local out = {}
    for k in pairs(changed) do
      local b = blocks[k]
      if b then
        local entry = { name = b.name }
        if next(b.state) then entry.state = b.state end
        if b.inventory then
          local items = {}
          -- copies: the same stacks are also saved under the peripheral's inventory, and a table may not be saved twice
          for slot, item in pairs(b.inventory.__state()) do items[tostring(slot)] = deepCopy(item) end
          if next(items) then entry.items = items end
        end
        if b.blockEntity then entry.blockEntity = b.blockEntity end
        out[k] = entry
      else
        out[k] = {}
      end
    end
    return next(out) and out or nil
  end

  -- ===== directions =====

  -- Direction indices as Minecraft's 2D data values: 0 south, 1 west, 2 north, 3 east
  M.FACINGS = { "south", "west", "north", "east" }
  local STEP = { south = { 0, 0, 1 }, west = { -1, 0, 0 }, north = { 0, 0, -1 }, east = { 1, 0, 0 }, up = { 0, 1, 0 }, down = { 0, -1, 0 } }
  M.STEP = STEP
  local OPPOSITE = { south = "north", north = "south", east = "west", west = "east", up = "down", down = "up" }
  M.OPPOSITE = OPPOSITE
  local LEFT = { north = "west", west = "south", south = "east", east = "north" }
  local RIGHT = { north = "east", east = "south", south = "west", west = "north" }
  M.LEFT, M.RIGHT = LEFT, RIGHT

  function M.offset(x, y, z, dir, n)
    local s = STEP[dir]
    n = n or 1
    return x + s[1] * n, y + s[2] * n, z + s[3] * n
  end

  --- Blocks within a box (inclusive), for picking up items and finding mobs.
  function M.itemsIn(x1, y1, z1, x2, y2, z2)
    local out = {}
    for i, e in ipairs(M.itemEntities) do
      if e.x >= x1 and e.x < x2 and e.y >= y1 and e.y < y2 and e.z >= z1 and e.z < z2 then out[#out + 1] = i end
    end
    return out
  end

  --- Calls fn(x, y, z, block) for every block the world holds. Fills are walked only for the blocks `wants(name)`
  --- says are of interest (and only up to 250000 blocks each), so a stone box costs nothing.
  function M.eachBlock(fn, wants)
    local keys = {}
    for k in pairs(blocks) do keys[#keys + 1] = k end
    for _, k in ipairs(keys) do
      local b = blocks[k]
      if b then
        local x, y, z = k:match("^(-?%d+),(-?%d+),(-?%d+)$")
        fn(tonumber(x), tonumber(y), tonumber(z), b)
      end
    end
    for _, f in ipairs(fills) do
      if not f.air and (not wants or wants(data.id(f.def.name))) then
        local volume = (f.x2 - f.x1 + 1) * (f.y2 - f.y1 + 1) * (f.z2 - f.z1 + 1)
        if volume <= 250000 then
          for x = f.x1, f.x2 do
            for y = f.y1, f.y2 do
              for z = f.z1, f.z2 do
                if blocks[key(x, y, z)] == nil then
                  local b = M.get(x, y, z)
                  if b then fn(x, y, z, b) end
                end
              end
            end
          end
        end
      end
    end
  end

  function M.dropItem(x, y, z, item)
    M.itemEntities[#M.itemEntities + 1] = { x = x, y = y, z = z, item = item }
    core.dirty = true
  end

  function M.itemEntityState()
    local out = {}
    for _, e in ipairs(M.itemEntities) do
      out[#out + 1] = { x = e.x, y = e.y, z = e.z, name = e.item.name, count = e.item.count, nbt = e.item.nbt }
    end
    return out
  end

  M.floor = floor
  return M
end
