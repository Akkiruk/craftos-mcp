-- ccsim mob: what the mobs with a computer in them share (CC: Androids, CC: Drones, CC: Drones+, AC-Drones).
--
-- Such a mob is an entity, not a block: it stands in the block world a turtle would (ccsim/turtle/world.lua, loaded
-- through ccsim/turtle/brain.lua) at a position with fractions, ticks 20 times a second on the computer's own clock,
-- and reaches blocks, dropped items and other entities from there. An addon makes one with
--
--   local mob = dofile("/rom/ccsim/mob.lua")(core, { x =, y =, z =, dimension = })
--
-- at boot (its init.lua, loaded because the world has its key), sets mob.sideDir / mob.sideUpgrade / mob.onInstall,
-- and gets the world in mob.onInstall(brain) once ccsim/init.lua has built it.
return function(core, spec)
  local mob = { spec = spec, age = 0 }
  core.mob = mob
  local floor, abs, sqrt, max = math.floor, math.abs, math.sqrt, math.max
  local brain, world, rules, data

  -- Feet position, as Entity.getX/Y/Z. A world gives a block (x, y, z whole: the mob stands in the middle of it) or
  -- an exact spot (any of them with a fraction).
  local function whole(v) return type(v) == "number" and v == floor(v) end
  local sx, sy, sz = spec.x or 0, spec.y or 64, spec.z or 0
  if whole(sx) and whole(sz) then sx, sz = sx + 0.5, sz + 0.5 end
  mob.x, mob.y, mob.z = sx, sy, sz
  spec.x, spec.y, spec.z = floor(sx), floor(sy), floor(sz)

  --- Entity.blockPosition()
  function mob.blockPos() return floor(mob.x), floor(mob.y), floor(mob.z) end

  --- Move the mob; the computer's own position (gps, modem range, the blocks on its sides) follows its block.
  function mob.setPos(x, y, z)
    mob.x, mob.y, mob.z = x, y, z
    local p = core.position
    local bx, by, bz = floor(x), floor(y), floor(z)
    if p.x ~= bx or p.y ~= by or p.z ~= bz then
      p.x, p.y, p.z = bx, by, bz
      if mob.onBlockChange then mob.onBlockChange() end
    end
    core.dirty = true
  end

  function mob.install(b)
    brain, world, rules, data = b, b.world, b.rules, b.data
    mob.brain, mob.world, mob.rules, mob.data = brain, world, rules, data
    -- entities the world file lists get the uuid the game would have given them, written as the game writes it
    for i, e in ipairs(world.entities) do
      if e.uuid == nil then e.uuid = ("00000000-0000-4000-9000-%012x"):format(i) else e.uuid = mob.uuid(e.uuid) end
    end
    if mob.onInstall then mob.onInstall(b) end
    mob.schedule()
  end

  -- ===== arguments, as CC:Tweaked's IArguments reads them for a @LuaFunction =====

  local A = {}
  mob.args = A
  local function typeName(v)
    if v == nil then return "nil" end
    if type(v) == "number" then
      if v ~= v then return "nan" elseif v == math.huge then return "inf" elseif v == -math.huge then return "-inf" end
    end
    return type(v)
  end
  local function bad(index, expected, v)
    error(("bad argument #%d (%s expected, got %s)"):format(index, expected, typeName(v)), 0)
  end
  A.bad = bad
  --- getFiniteDouble
  function A.double(index, v)
    if type(v) ~= "number" or v ~= v or v == math.huge or v == -math.huge then bad(index, "number", v) end
    return v
  end
  --- getInt: a finite number, cut toward zero ((int) (long) double)
  function A.int(index, v)
    A.double(index, v)
    return v >= 0 and floor(v) or -floor(-v)
  end
  function A.optInt(index, v)
    if v == nil then return nil end
    return A.int(index, v)
  end
  function A.string(index, v)
    if type(v) ~= "string" then bad(index, "string", v) end
    return v
  end
  function A.optString(index, v)
    if v == nil then return nil end
    return A.string(index, v)
  end
  function A.boolean(index, v)
    if type(v) ~= "boolean" then bad(index, "boolean", v) end
    return v
  end

  --- What a Java exception that is not a LuaException reaches Lua as (CobaltLuaMachine)
  function mob.javaError(class, message)
    error("Java Exception Thrown: " .. class .. (message and (": " .. message) or ""), 0)
  end

  --- java.util.UUID.fromString, which takes any five hex groups ("1-2-3-4-5"). Returns the uuid as
  --- UUID.toString writes it, or throws what Java throws.
  function mob.parseUuid(text)
    if #text > 36 then mob.javaError("java.lang.IllegalArgumentException", "UUID string too large") end
    local parts = {}
    for part in (text .. "-"):gmatch("([^-]*)-") do parts[#parts + 1] = part end
    if #parts ~= 5 then mob.javaError("java.lang.IllegalArgumentException", "Invalid UUID string: " .. text) end
    local widths = { 8, 4, 4, 4, 12 }
    for i, part in ipairs(parts) do
      local at = part:find("[^0-9a-fA-F]")
      if part == "" or at then
        -- Long.parseLong(CharSequence, begin, end, 16)
        if part == "" then mob.javaError("java.lang.NumberFormatException", "") end
        mob.javaError("java.lang.NumberFormatException", ('Error at index %d in: "%s"'):format(at - 1, part))
      end
      part = part:lower()
      if #part > widths[i] then part = part:sub(-widths[i]) end
      parts[i] = ("0"):rep(widths[i] - #part) .. part
    end
    return table.concat(parts, "-")
  end

  --- A uuid a world or a sim command gives, as UUID.toString writes it ("0-0-0-0-1" is a short way to write one);
  --- anything that is no uuid stays as it is.
  function mob.uuid(text)
    local ok, canonical = pcall(mob.parseUuid, tostring(text))
    return ok and canonical or text
  end

  --- A mainThread = true method: the call waits for the next server tick, and every other event that arrives
  --- meanwhile is lost. Returns what `task` returns.
  function mob.onMainThread(task)
    local results = core.waitForServerTick(task)
    if not results[1] then error(results[2], 0) end
    core.touch()
    return table.unpack(results, 2, results.n)
  end

  -- ===== the tick: 20 a second on the computer's clock =====

  local tickZero = os.clock()
  local ran = 0 -- ticks run so far
  local timer
  local resting = false -- the next tick was put off to the next whole second
  local function nowTick() return floor((os.clock() - tickZero) * 20 + 1e-6) end
  mob.nowTick = nowTick

  --- Run every tick that is due by now. An API function calls this before it changes anything, so the ticks a
  --- resting mob slept through are run as the rest they were, not with what the call is about to start.
  function mob.sync()
    local target = nowTick()
    if target <= ran then return end
    if target - ran > 1200 then ran = target - 1200 end -- a computer that slept a long time: the last minute
    while ran < target do
      ran = ran + 1
      mob.age = mob.age + 1
      if mob.onTick then mob.onTick(mob.age) end
    end
    if brain and brain.living then brain.living.catchUp() end
  end

  local function runTicks()
    timer = nil
    mob.sync()
    mob.schedule()
  end

  --- Wrap every function of an API (or sim command table) so the mob is up to date when it runs.
  function mob.synced(functions)
    for name, fn in pairs(functions) do
      functions[name] = function(...)
        mob.sync()
        return fn(...)
      end
    end
    return functions
  end

  --- Arrange the next tick: the very next one while something is going on (mob.busy()), otherwise the next whole
  --- second, where the ticks slept through are run at once.
  function mob.schedule()
    if timer then
      os.cancelTimer(timer)
      core.simTimers[timer] = nil
      timer = nil
    end
    if resting then
      -- woken from rest by something that did not call mob.sync() first: the ticks slept through were rest, and
      -- must not run now with what was just started
      local now = nowTick()
      if now > ran then mob.age, ran = mob.age + (now - ran), now end
    end
    local nextTick = ran + 1
    resting = not (mob.busy and mob.busy())
    if resting then nextTick = (floor(ran / 20) + 1) * 20 end
    local delay = tickZero + nextTick * 0.05 - os.clock()
    timer = core.after(max(delay, 0), runTicks)
  end

  -- ===== entities =====

  local function title(id)
    local path = id:match(":(.+)$") or id
    return (path:gsub("_", " "):gsub("(%a)([%w]*)", function(a, b) return a:upper() .. b end))
  end
  mob.title = title

  --- Every entity around: the world's mobs (world.entities) and the players who are online in this dimension.
  --- Each has uuid, type, name, x, y, z, health and `living`.
  function mob.entities()
    local out = {}
    for _, e in ipairs(world.entities) do
      e.type = e.type or e.name
      if e.living == nil then e.living = e.type ~= "minecraft:item" end
      if e.health == nil and e.living then e.health = e.maxHealth or 20 end
      out[#out + 1] = e
    end
    for _, p in ipairs(core.players) do
      if p.online and (p.dimension or "minecraft:overworld") == (core.position.dimension or "minecraft:overworld") then
        p.type, p.living, p.player = "minecraft:player", true, true
        out[#out + 1] = p
      end
    end
    return out
  end

  --- ServerLevel.getEntity(uuid)
  function mob.findEntity(uuid)
    for _, e in ipairs(mob.entities()) do
      if e.uuid == uuid then return e end
    end
    return nil
  end

  --- Entity.getName().getString(): its custom name, a player's name, or the entity type's own name
  function mob.entityName(e)
    if e.player then return e.name end
    return e.customName or e.displayName or (e.name ~= e.type and e.name) or title(e.type or "minecraft:pig")
  end

  function mob.isAlive(e)
    if e.removed then return false end
    return not e.living or (e.health or 1) > 0
  end

  --- Take an entity out of the world (it died or was picked up).
  function mob.removeEntity(e)
    e.removed = true
    for i, other in ipairs(world.entities) do
      if other == e then table.remove(world.entities, i) break end
    end
    core.dirty = true
  end

  --- LivingEntity.hurt: within 10 ticks of the last hit only a harder one lands. A mob that dies leaves its `drops`
  --- where it stood. Returns whether the hit landed.
  function mob.hurt(e, damage)
    local tick = nowTick()
    if e.__lastHurt and tick - e.__lastHurt < 10 and damage <= (e.__lastDamage or 0) then return false end
    e.__lastHurt, e.__lastDamage = tick, damage
    e.health = (e.health or e.maxHealth or 20) - damage
    if e.health <= 0 then
      e.health = 0
      if not e.player then
        mob.removeEntity(e)
        for _, d in ipairs(e.drops or {}) do
          local item = brain.normItem(d)
          if item then world.dropItem(floor(e.x), floor(e.y), floor(e.z), item) end
        end
      end
    end
    core.dirty = true
    return true
  end

  -- ===== sim commands every mob addon has: the world around the mob, changed while it runs =====

  local function number3(cmd)
    return type(cmd.x) == "number" and type(cmd.y) == "number" and type(cmd.z) == "number"
  end
  local function entityOf(cmd)
    local uuid = mob.uuid(cmd.uuid)
    for _, e in ipairs(world.entities) do
      if e.uuid == uuid then return e end
    end
    return nil
  end

  mob.handlers = {
    --- { type, x, y, z, uuid?, name?, health?, drops? ... }: a mob appears
    mobSpawn = function(cmd)
      if type(cmd.type) ~= "string" or not number3(cmd) then return false, "type, x, y and z are needed" end
      local e = {}
      for k, v in pairs(cmd) do if k ~= "cmd" then e[k] = v end end
      if e.uuid == nil then
        mob.spawned = (mob.spawned or 0) + 1
        e.uuid = ("00000000-0000-4000-9001-%012x"):format(mob.spawned)
      else
        e.uuid = mob.uuid(e.uuid)
        if entityOf(e) then return false, "an entity with that uuid is already there" end
      end
      world.entities[#world.entities + 1] = e
      core.dirty = true
      return true
    end,
    --- { uuid, x, y, z }: a mob walks or is carried somewhere else
    mobMove = function(cmd)
      local e = entityOf(cmd)
      if not e then return false, "unknown entity" end
      if not number3(cmd) then return false, "x, y and z are needed" end
      e.x, e.y, e.z = cmd.x, cmd.y, cmd.z
      core.dirty = true
      return true
    end,
    --- { uuid }: a mob is gone (no drops)
    mobRemove = function(cmd)
      local e = entityOf(cmd)
      if not e then return false, "unknown entity" end
      mob.removeEntity(e)
      return true
    end,
    --- { x, y, z, name, count?, nbt? }: an item lands on the ground
    mobDropItem = function(cmd)
      if type(cmd.name) ~= "string" or not number3(cmd) then return false, "name, x, y and z are needed" end
      local item = brain.normItem({ name = cmd.name, count = cmd.count or 1, nbt = cmd.nbt, displayName = cmd.displayName })
      if not item then return false, "count must be above 0" end
      world.dropItem(floor(cmd.x), floor(cmd.y), floor(cmd.z), item)
      return true
    end,
    --- { x, y, z, name?, state?, items? }: a block is placed (or, with no name or air, taken away)
    mobSetBlock = function(cmd)
      if not number3(cmd) then return false, "x, y and z are needed" end
      local x, y, z = floor(cmd.x), floor(cmd.y), floor(cmd.z)
      if cmd.name == nil or data.id(cmd.name) == "minecraft:air" then
        world.set(x, y, z, nil)
      else
        world.set(x, y, z, world.newBlock({ name = cmd.name, state = cmd.state, items = cmd.items, size = cmd.size, blockEntity = cmd.blockEntity }))
      end
      return true
    end,
  }

  -- ===== blocks =====

  function mob.blockAt(x, y, z) return brain.blockAt(x, y, z) end

  --- Whether a block stops movement. Shapes are whole blocks: a slab or a fence counts as a full cube.
  function mob.solid(x, y, z)
    local b = brain.blockAt(x, y, z)
    return b ~= nil and rules.hasCollision(b) and not rules.isLiquid(b)
  end

  --- Level.clip from one point to another: the first block on the way with a collision shape (or a liquid, with
  --- `fluids`). Returns its position and the block, or nil when the way is clear.
  function mob.raycast(x1, y1, z1, x2, y2, z2, fluids)
    local function hit(x, y, z)
      local b = brain.blockAt(x, y, z)
      if b == nil then return nil end
      if rules.isLiquid(b) then return fluids and b or nil end
      return rules.hasCollision(b) and b or nil
    end
    local x, y, z = floor(x1), floor(y1), floor(z1)
    local ex, ey, ez = floor(x2), floor(y2), floor(z2)
    local dx, dy, dz = x2 - x1, y2 - y1, z2 - z1
    local stepX, stepY, stepZ = dx > 0 and 1 or -1, dy > 0 and 1 or -1, dz > 0 and 1 or -1
    local function first(p, d, cell, step)
      if d == 0 then return math.huge, math.huge end
      local edge = step > 0 and (cell + 1 - p) or (p - cell)
      return edge / abs(d), 1 / abs(d)
    end
    local tx, ddx = first(x1, dx, x, stepX)
    local ty, ddy = first(y1, dy, y, stepY)
    local tz, ddz = first(z1, dz, z, stepZ)
    for _ = 1, 4096 do
      local b = hit(x, y, z)
      if b then return x, y, z, b end
      if x == ex and y == ey and z == ez then return nil end
      if tx <= ty and tx <= tz then
        if tx > 1 then return nil end
        x, tx = x + stepX, tx + ddx
      elseif ty <= tz then
        if ty > 1 then return nil end
        y, ty = y + stepY, ty + ddy
      else
        if tz > 1 then return nil end
        z, tz = z + stepZ, tz + ddz
      end
    end
    return nil
  end

  -- ===== walking (PathNavigation over a WalkNodeEvaluator, simplified to whole blocks) =====

  local function isDoor(b) return b ~= nil and data.blockHasTag(b.name, "minecraft:wooden_doors") end
  mob.isDoor = isDoor

  local function passable(x, y, z, doors)
    local b = brain.blockAt(x, y, z)
    if b == nil then return true end
    if doors and isDoor(b) then return true end
    if rules.isLiquid(b) then return true end
    return not rules.hasCollision(b)
  end

  --- Whether a mob two blocks tall can stand with its feet in this block.
  local function standable(x, y, z, doors)
    return passable(x, y, z, doors) and passable(x, y + 1, z, doors) and mob.solid(x, y - 1, z)
  end
  mob.standable = standable

  --- The block the mob would stand in from here: this one, or the first one below with ground under it.
  function mob.groundBelow(x, y, z)
    local lo = world.limits(core.position.dimension)
    for yy = y, max(lo, y - 64), -1 do
      if mob.solid(x, yy - 1, z) then return yy end
    end
    return nil
  end

  local MOVES = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { 1, -1 }, { -1, 1 }, { -1, -1 } }

  --- A path of blocks to stand in, from the block after `from` to the one closest to the target that can be reached:
  --- A* over at most `limit` blocks (Mob follow range 16 x 16 = 256). Steps one block up, drops up to three.
  function mob.findPath(fx, fy, fz, tx, ty, tz, opts)
    opts = opts or {}
    local doors, limit = opts.doors, opts.limit or 256
    local function key(x, y, z) return x .. "," .. y .. "," .. z end
    local function h(x, y, z) return sqrt((x - tx) ^ 2 + (y - ty) ^ 2 + (z - tz) ^ 2) end
    local start = { x = fx, y = fy, z = fz, g = 0 }
    start.f = h(fx, fy, fz)
    local open, seen = { start }, { [key(fx, fy, fz)] = start }
    local best, bestH = start, start.f
    local visited = 0
    while #open > 0 and visited < limit do
      local bi = 1
      for i = 2, #open do if open[i].f < open[bi].f then bi = i end end
      local node = table.remove(open, bi)
      node.closed = true
      visited = visited + 1
      local nh = h(node.x, node.y, node.z)
      if nh < bestH then best, bestH = node, nh end
      if nh == 0 then break end
      for _, m in ipairs(MOVES) do
        local nx, nz = node.x + m[1], node.z + m[2]
        local ny
        local diagonal = m[1] ~= 0 and m[2] ~= 0
        local clear = not diagonal or (standable(node.x + m[1], node.y, node.z, doors) and standable(node.x, node.y, node.z + m[2], doors))
        if clear then
          if standable(nx, node.y, nz, doors) then
            ny = node.y
          elseif not diagonal and passable(node.x, node.y + 2, node.z, doors) and standable(nx, node.y + 1, nz, doors) then
            ny = node.y + 1
          elseif not diagonal and passable(nx, node.y, nz, doors) and passable(nx, node.y + 1, nz, doors) then
            for drop = 1, 3 do
              if standable(nx, node.y - drop, nz, doors) then ny = node.y - drop break end
              if not passable(nx, node.y - drop, nz, doors) then break end
            end
          end
        end
        if ny and abs(nx - fx) <= 24 and abs(nz - fz) <= 24 and abs(ny - fy) <= 24 then
          local k = key(nx, ny, nz)
          local g = node.g + (diagonal and 1.41421356 or 1) + abs(ny - node.y) * 0.5
          local other = seen[k]
          if not other then
            other = { x = nx, y = ny, z = nz }
            seen[k] = other
            open[#open + 1] = other
          end
          if not other.closed and (other.g == nil or g < other.g) then
            other.g, other.f, other.from = g, g + h(nx, ny, nz), node
          end
        end
      end
    end
    local path = {}
    local node = best
    while node and node ~= start do
      table.insert(path, 1, { x = node.x, y = node.y, z = node.z })
      node = node.from
    end
    return path
  end

  return mob
end
