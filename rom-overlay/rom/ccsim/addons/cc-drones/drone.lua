-- ccsim addon: CC: Drones and its fork CC: Drones+, for Minecraft 1.20.1.
--
--   "original": CC: Drones 0.0.1 (JSJBDEV/CCDrones, commit 5c8f4ed, the Modrinth release of 2024-05-13)
--   "plus":     CC: Drones+ 0.2.0 (minecraftbossdj/CCDrones, commit c85ef36, the Modrinth release of 2025-09-04)
--
-- Written from entities/DroneAPI.java, entities/DroneEntity.java and blocks/DroneWorkbenchPeripheral.java of each.
-- The fork is the original with upgrades, answers on most calls, getPos and findUpgrades, an advanced computer and a
-- startup file; every difference below sits behind `plus`. docs/cc-drones.md has the rules and what is simplified.
--
-- A world with a `drone` (or `dronePlus`) entry makes the computer a drone: a half-block mob that flies through the
-- block world of ccsim/turtle/world.lua on the game's own entity physics (ccsim/mob.lua has what it shares with the
-- androids). The drone workbench is an ordinary peripheral.
return function(core, host, variant)
  local M = {}
  local plus = variant == "plus"
  local module = plus and "cc-drones-plus" or "cc-drones"
  local worldKey = plus and "dronePlus" or "drone"
  local floor, abs, min, max = math.floor, math.abs, math.min, math.max

  -- ===== block details, with or without a block world =====

  local gameData
  local function blockData()
    if core.turtle then return core.turtle.data end
    gameData = gameData or core.gameData or dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)
    return gameData
  end

  local function stateValue(v)
    if v == "true" then return true elseif v == "false" then return false end
    local n = tonumber(v)
    if n and tostring(n) == v then return n end
    return v
  end

  --- VanillaDetailRegistries.BLOCK_IN_WORLD.getDetails: name, state and tags (air has all three too)
  local function blockDetail(block)
    block = block or { name = "minecraft:air", state = {} }
    if core.turtle then return core.turtle.blockDetail(block) end
    local data = blockData()
    local state, tags = {}, {}
    for k, v in pairs(block.state or {}) do state[k] = stateValue(tostring(v)) end
    for _, tag in ipairs(data.blockTags(data.id(block.name))) do tags[tag] = true end
    local d = { name = data.id(block.name), state = state, tags = tags }
    if core.cc121 then
      local colour = data.mapColour(d.name, block.state or {})
      if colour then d.mapColor, d.mapColour = colour, colour end
    end
    return d
  end

  -- ===== the drone workbench (DroneWorkbenchPeripheral) =====

  -- data/ccdrones/tags/blocks/surveyable.json
  local SURVEY_TAGS = { "minecraft:leaves", "minecraft:logs", "minecraft:planks", "minecraft:stone_bricks",
    "minecraft:stairs", "minecraft:slabs", "minecraft:fences", "minecraft:walls", "ccdrones:surveyable" }
  local function surveyable(name)
    local data = blockData()
    name = data.id(name)
    if name == "minecraft:grass_block" then return true end
    for _, tag in ipairs(SURVEY_TAGS) do
      if data.blockHasTag(name, tag) then return true end
    end
    return false
  end

  local exports = {} -- what export() sent to drones, for the sim state
  local savedModule = core.savedState and core.savedState.addons and core.savedState.addons[module]
  local apiGiven = type(savedModule) == "table" and savedModule.apiGiven == true -- 0.0.1's api() was called here

  function M.peripheral(def)
    -- with both mods' addons on the workbench is the original's, unless the world says otherwise
    local forked = plus
    if def.mod == "cc-drones-plus" then forked = true elseif def.mod == "cc-drones" then forked = false end
    local pos = def.blockPos or (type(def.x) == "number" and def) or nil

    --- The block at an offset from the workbench: the block world's when the workbench stands in one, else the
    --- fixture's (`below`, `around`).
    local function blockAtOffset(dx, dy, dz)
      -- (the block world is only there once the computer has booted)
      if pos and core.turtle then return core.turtle.blockAt(pos.x + dx, pos.y + dy, pos.z + dz) end
      if dx == 0 and dy == -1 and dz == 0 and type(def.below) == "table" then return def.below end
      for _, b in ipairs(def.around or {}) do
        if (b.dx or b[1]) == dx and (b.dy or b[2]) == dy and (b.dz or b[3]) == dz then return b end
      end
      return nil
    end

    local p = { exactReturns = true, methods = {}, computerThread = { api = true, export = true, debug = true, survey = true } }

    function p.methods.api()
      if forked then return end -- 0.2.0 builds a properties object and throws it away; the reboot is commented out
      -- 0.0.1: the computer gets a drone API with no drone behind it, and reboots
      apiGiven = true
      core.save()
      os.reboot()
    end

    function p.methods.export(...)
      local path = (...)
      if type(path) ~= "string" then
        error(("bad argument #1 (string expected, got %s)"):format(path == nil and "nil" or type(path)), 0)
      end
      -- the first drone within two blocks; without one, List.get(0) throws
      local drones = def.drones or {}
      if #drones == 0 then
        error("Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index 0 out of bounds for length 0", 0)
      end
      local drone = drones[1]
      if not fs.exists(path) or fs.isDir(path) then
        if forked then return "File does not exist!" end
        return
      end
      local h = fs.open(path, "r")
      local text = h.readAll() or ""
      h.close()
      exports[#exports + 1] = { drone = type(drone) == "table" and (drone.id or drone.computerId) or drone, path = path, program = text }
      core.dirty = true
      return "Successfully copied data to drone, booting it up!"
    end

    function p.methods.debug() return blockDetail(blockAtOffset(0, -1, 0)) end

    function p.methods.survey()
      local found = {}
      for i = -5, 4 do
        for j = -5, 4 do
          for k = -5, 4 do
            local b = blockAtOffset(i, j, k)
            if b and surveyable(b.name) then
              found[i .. "," .. j .. "," .. k] = { name = blockData().id(b.name) } -- getBasicDetails
            end
          end
        end
      end
      return found
    end

    return p
  end

  -- A computer the 0.0.1 workbench's api() gave the drone API to: every function is there and throws, because there
  -- is no drone behind it (new DroneAPI(null)).
  local function nullApi(names)
    local api = {}
    for _, name in ipairs(names) do
      api[name] = function()
        error('Java Exception Thrown: java.lang.NullPointerException: Cannot invoke a method of DroneEntity because "this.drone" is null', 0)
      end
    end
    return api
  end
  local ORIGINAL_NAMES = { "debug", "engineOn", "hoverOn", "right", "left", "isColliding", "up", "down", "lookForward",
    "rotation", "lookBack", "breakForward", "pickupBlock", "dropBlock", "pickUpEntity", "dropEntity" }

  local spec = core.world[worldKey]
  if type(spec) ~= "table" or core.mob then
    if apiGiven and not core.mob then _G.drone = nullApi(ORIGINAL_NAMES) end
    M.state = function()
      if #exports == 0 and not apiGiven then return nil end
      return { exports = #exports > 0 and exports or nil, apiGiven = apiGiven or nil }
    end
    return M
  end

  -- ===== the drone =====

  local mob = dofile("/rom/ccsim/mob.lua")(core, { x = spec.x, y = spec.y, z = spec.z, dimension = spec.dimension })
  local A = mob.args
  local brain, world, rules

  -- Java float arithmetic: the nearest 24-bit value (ties to even)
  local function f32(v)
    if v == 0 or v ~= v or v == math.huge or v == -math.huge then return v end
    local m, e = math.frexp(v)
    local scaled = m * 16777216
    local whole = floor(scaled)
    local rest = scaled - whole
    if rest > 0.5 or (rest == 0.5 and whole % 2 == 1) then whole = whole + 1 end
    return math.ldexp(whole / 16777216, e)
  end

  -- Mth.sin and Mth.cos: a table of 65536 sines
  local SIN = setmetatable({}, { __index = function(t, i)
    local v = f32(math.sin(i * math.pi * 2 / 65536))
    t[i] = v
    return v
  end })
  local function trunc(v) return v >= 0 and floor(v) or -floor(-v) end
  local K = f32(10430.378)
  local function msin(f) return SIN[trunc(f32(f * K)) % 65536] end
  local function mcos(f) return SIN[trunc(f32(f32(f * K) + 16384)) % 65536] end
  local RAD, PI = f32(0.017453292), f32(3.1415927)

  local WIDTH, HEIGHT = 0.5, 0.5 -- EntityDimensions.fixed(0.5f, 0.5f)
  local d = {
    yaw = f32(spec.yaw or 0), pitch = f32(spec.pitch or 0),
    vx = 0, vy = 0, vz = 0,
    engineOn = spec.engineOn == true,
    hover = spec.hover == true, -- Entity.setNoGravity
    onGround = false, colliding = false,
    upgrades = {},
    carrying = nil, -- the block it carries: { name, state, items, blockEntity }
    passenger = nil, -- the entity riding below it
  }
  for _, u in ipairs(spec.upgrades or {}) do d.upgrades[#d.upgrades + 1] = tostring(u) end

  --- Entity.getForward(): calculateViewVector(xRot, yRot)
  local function forward()
    local a = f32(f32(-d.yaw * RAD) - PI)
    local f, g = mcos(a), msin(a)
    local b = f32(-d.pitch * RAD)
    local h, i = -mcos(b), msin(b)
    return f32(g * h), i, f32(f * h)
  end

  local function hasUpgrade(name)
    for _, u in ipairs(d.upgrades) do if u == name then return true end end
    return false
  end

  -- ===== Entity.move against whole blocks =====

  local EPS = 1e-7

  --- How far the box can go along one axis (1 x, 2 y, 3 z) before a block stops it.
  local function sweep(box, axis, dist)
    if dist == 0 then return 0 end
    local a, b = axis % 3 + 1, (axis + 1) % 3 + 1 -- the two other axes
    local a1, a2 = floor(box[a] + EPS), floor(box[a + 3] - EPS)
    local b1, b2 = floor(box[b] + EPS), floor(box[b + 3] - EPS)
    local function blocked(i)
      for ia = a1, a2 do
        for ib = b1, b2 do
          local p = { 0, 0, 0 }
          p[axis], p[a], p[b] = i, ia, ib
          if mob.solid(p[1], p[2], p[3]) then return true end
        end
      end
      return false
    end
    if dist > 0 then
      local face = box[axis + 3]
      for i = math.ceil(face - EPS), floor(face + dist - EPS) do
        if blocked(i) then return max(0, i - face) end
      end
    else
      local face = box[axis]
      for i = floor(face + EPS) - 1, floor(face + dist + EPS), -1 do
        if blocked(i) then return min(0, i + 1 - face) end
      end
    end
    return dist
  end

  --- Entity.move(MoverType.SELF, velocity): y first, then the longer of x and z. Sets the collision flags and stops
  --- the velocity on every axis that hit something.
  local function move()
    local hw = WIDTH / 2
    local box = { mob.x - hw, mob.y, mob.z - hw, mob.x + hw, mob.y + HEIGHT, mob.z + hw }
    local function shift(axis, dist) box[axis], box[axis + 3] = box[axis] + dist, box[axis + 3] + dist end
    local my = sweep(box, 2, d.vy)
    shift(2, my)
    local mx, mz
    if abs(d.vx) < abs(d.vz) then
      mz = sweep(box, 3, d.vz) shift(3, mz)
      mx = sweep(box, 1, d.vx) shift(1, mx)
    else
      mx = sweep(box, 1, d.vx) shift(1, mx)
      mz = sweep(box, 3, d.vz) shift(3, mz)
    end
    local hitX, hitZ, hitY = abs(mx - d.vx) > 1e-5, abs(mz - d.vz) > 1e-5, my ~= d.vy
    d.colliding = hitX or hitZ -- Entity.horizontalCollision
    d.onGround = hitY and d.vy < 0
    if mx ~= 0 or my ~= 0 or mz ~= 0 then mob.setPos(mob.x + mx, mob.y + my, mob.z + mz) end
    if hitX then d.vx = 0 end
    if hitZ then d.vz = 0 end
    if hitY then d.vy = 0 end
  end

  local FRICTION_AIR = f32(0.91)
  local FRICTION_GROUND = f32(f32(0.6) * FRICTION_AIR) -- every block counts as one of the usual slipperiness
  local DRAG = f32(0.98)

  local function carry()
    local e = d.passenger
    if not e then return end
    if not mob.isAlive(e) then d.passenger = nil return end
    -- DroneEntity.getPassengersRidingOffset: two blocks under the drone
    e.x, e.y, e.z = mob.x, mob.y - 2, mob.z
  end

  --- One game tick: LivingEntity.aiStep and travel with no input, then DroneEntity.tick's engine.
  mob.onTick = function()
    if abs(d.vx) < 0.003 then d.vx = 0 end
    if abs(d.vy) < 0.003 then d.vy = 0 end
    if abs(d.vz) < 0.003 then d.vz = 0 end
    local friction = d.onGround and FRICTION_GROUND or FRICTION_AIR
    move()
    local vy = d.vy
    if not d.hover then vy = vy - 0.08 end
    d.vx, d.vy, d.vz = d.vx * friction, vy * DRAG, d.vz * friction
    if d.engineOn then
      local fx, fy, fz = forward()
      d.vx, d.vy, d.vz = fx * 0.1, fy * 0.1, fz * 0.1
    end
    carry()
  end

  -- at rest on the ground, or hovering still: nothing happens until something sets it moving
  mob.busy = function()
    if d.engineOn or d.passenger or d.colliding then return true end
    if d.hover then return d.vx ~= 0 or d.vy ~= 0 or d.vz ~= 0 end
    return not (d.onGround and d.vx == 0 and d.vz == 0)
  end

  -- a drone has no sides: nothing beside it is a peripheral
  mob.sideDir = function() return nil end

  -- ===== what it looks at =====

  --- Entity.getOnPos(): the block it rests on, or the block its feet are in (the one below when it floats at a
  --- whole height)
  local function onPos()
    local x, y, z = floor(mob.x), floor(mob.y - 1e-5), floor(mob.z)
    if d.onGround and not mob.solid(x, y, z) then
      -- on an edge: the block under its box that is nearest its middle
      local best, bestD
      for bx = floor(mob.x - WIDTH / 2 + EPS), floor(mob.x + WIDTH / 2 - EPS) do
        for bz = floor(mob.z - WIDTH / 2 + EPS), floor(mob.z + WIDTH / 2 - EPS) do
          if mob.solid(bx, y, bz) then
            local dist = (bx + 0.5 - mob.x) ^ 2 + (bz + 0.5 - mob.z) ^ 2
            if not bestD or dist < bestD then best, bestD = { bx, bz }, dist end
          end
        end
      end
      if best then x, z = best[1], best[2] end
    end
    return x, y, z
  end

  --- level.clip(COLLIDER, Fluid.ANY) from the middle of getOnPos() along a vector: the block hit, or the block the
  --- ray ends in.
  local function clip(dx, dy, dz)
    local x, y, z = onPos()
    local sx, sy, sz = x + 0.5, y + 0.5, z + 0.5
    local hx, hy, hz, block = mob.raycast(sx, sy, sz, sx + dx, sy + dy, sz + dz, true)
    if hx == nil then
      hx, hy, hz = floor(sx + dx), floor(sy + dy), floor(sz + dz)
      block = brain.blockAt(hx, hy, hz)
    end
    return hx, hy, hz, block
  end

  local function look(sign)
    local fx, fy, fz = forward()
    local _, _, _, block = clip(fx * 3 * sign, fy * 3 * sign, fz * 3 * sign)
    return blockDetail(block)
  end

  --- Level.destroyBlock(pos, true, drone): any block goes, bedrock too, and drops what its loot table gives
  local function destroy(x, y, z, block)
    if block == nil or rules.isAir(block) or rules.isLiquid(block) then return end
    if rules.isUnbreakable(block) then
      world.set(x, y, z, nil) -- bedrock and its like have no loot table
    else
      local drops = brain.breakBlock(x, y, z, block, nil, true)
      for _, stack in ipairs(drops or {}) do world.dropItem(x, y, z, stack) end
    end
    core.dirty = true
  end

  local function deepCopy(v)
    if type(v) ~= "table" then return v end
    local out = {}
    for k, x in pairs(v) do out[k] = deepCopy(x) end
    return out
  end

  --- DroneEntity.setCarrying: the block and what is in it go into the drone, and air is left behind. It does not look
  --- at what it picks up: air and bedrock are carried like anything else, and a block already carried is forgotten.
  local function setCarrying(x, y, z)
    local block = brain.blockAt(x, y, z)
    if block == nil then
      d.carrying = { name = "minecraft:air" }
    else
      local items
      if block.inventory then
        items = {}
        for slot, item in pairs(block.inventory.__state()) do items[tostring(slot)] = deepCopy(item) end
      elseif block.def and block.def.items then
        items = deepCopy(block.def.items)
      end
      d.carrying = {
        name = block.name, state = deepCopy(block.state), items = items, size = block.def and block.def.size,
        blockEntity = deepCopy(block.blockEntity),
      }
      -- Clearable.tryClear: nothing spills
      if block.inventory then
        local held = block.inventory.__state()
        for slot in pairs(held) do held[slot] = nil end
      end
      world.set(x, y, z, nil)
    end
    core.dirty = true
  end

  --- DroneEntity.dropCarrying: the block is set there, over whatever was there
  local function dropCarrying(x, y, z)
    local c = d.carrying
    if not c then return end
    if c.name == "minecraft:air" then
      world.set(x, y, z, nil)
    else
      local block = world.newBlock({ name = c.name, state = c.state, items = c.items, size = c.size, blockEntity = c.blockEntity })
      world.set(x, y, z, block)
      brain.inventoryOf(block) -- its contents are in the world again
    end
    d.carrying = nil
    core.dirty = true
  end

  --- Entities whose box touches the box between two block corners (new AABB(BlockPos, BlockPos)). The drone itself
  --- is left out.
  local function entitiesIn(x1, y1, z1, x2, y2, z2)
    local out = {}
    for _, e in ipairs(mob.entities()) do
      local w, h = (e.width or 0.6) / 2, e.height or 1.8
      if mob.isAlive(e) and e.x + w > x1 and e.x - w < x2 and e.y + h > y1 and e.y < y2
        and e.z + w > z1 and e.z - w < z2 then
        out[#out + 1] = e
      end
    end
    return out
  end

  local function ride(e)
    d.passenger = e
    carry()
    core.dirty = true
    mob.schedule()
  end

  --- Entity.ejectPassengers: the passenger gets off on top of the drone and falls to the ground under it
  local function eject()
    local e = d.passenger
    d.passenger = nil
    if e then
      local bx, by, bz = floor(mob.x), floor(mob.y + HEIGHT), floor(mob.z)
      local ground = mob.groundBelow(bx, by, bz)
      e.x, e.y, e.z = mob.x, ground or (mob.y + HEIGHT), mob.z
    end
    core.dirty = true
  end

  -- ===== drone (DroneAPI.java) =====

  local api = {}
  local function main(fn)
    return function(...)
      local args = table.pack(...)
      return mob.onMainThread(function() return fn(args) end)
    end
  end

  if not plus then
    function api.debug() end -- prints the block position on the server's console
  end

  function api.engineOn(...)
    local on = A.boolean(1, (...))
    d.engineOn = on
    if not on then d.vx, d.vy, d.vz = 0, 0, 0 end
    core.dirty = true
    mob.schedule()
    if plus then return true, on and "Turned On Engine!" or "Turned Off Engine" end
  end

  function api.hoverOn(...)
    local on = A.boolean(1, (...))
    d.hover = on
    core.dirty = true
    mob.schedule()
    if plus then return true, on and "Hover on!" or "Hover Off!" end
  end

  --- Entity.turn(deg, 0): the yaw moves by 0.15 of the number given
  local function turn(deg)
    d.yaw = f32(d.yaw + f32(deg * f32(0.15)))
    core.dirty = true
  end
  function api.right(...) turn(A.int(1, (...))) end
  function api.left(...) turn(-A.int(1, (...))) end

  function api.isColliding() return d.colliding end

  local function lift(amount)
    d.vy = d.vy + amount / 10
    core.dirty = true
    mob.schedule()
  end
  function api.up(...) lift(A.int(1, (...))) end
  function api.down(...) lift(-A.int(1, (...))) end

  function api.lookForward() return look(1) end
  function api.lookBack() return look(-1) end
  function api.rotation() return d.yaw end -- Entity.yRotO, which a turn moves along with the yaw

  function api.breakForward()
    if plus and not hasUpgrade("mine") then return false, "Mining Upgrade Not Installed!" end
    local fx, fy, fz = forward()
    local x, y, z, block = clip(fx * 3, fy * 3, fz * 3)
    destroy(x, y, z, block)
    if plus then return true, "Broke Block!" end
  end

  api.pickupBlock = main(function()
    if plus and not hasUpgrade("carry") then return false, "Carry Upgrade Not Installed!" end
    local x, y, z = clip(0, -2, 0)
    setCarrying(x, y, z)
    if plus then return true, "Picked Up Block!" end
  end)

  api.dropBlock = main(function()
    local x, y, z = clip(0, -2, 0)
    dropCarrying(x, y + 1, z)
  end)

  api.pickUpEntity = main(function()
    local targets
    if plus then
      if not hasUpgrade("carry") then return false, "Carry Upgrade Not Installed!" end
      local x, y, z = onPos()
      targets = entitiesIn(x - 2, y - 2, z - 2, x + 2, y, z + 2)
    else
      local x, y, z = clip(0, -3, 0)
      targets = entitiesIn(x - 2, y - 2, z - 2, x + 2, y + 2, z + 2)
    end
    if #targets == 0 then
      if plus then return false, "No Entities Nearby!" end
      return
    end
    -- one of them at random; a drone that already carries something takes no second passenger
    local e = targets[math.random(#targets)]
    if not d.passenger then ride(e) end
    if plus then return true, "Picked up Entity!" end
  end)

  api.dropEntity = main(function()
    if not d.passenger then
      if plus then return false, "No Passengers!" end
      return
    end
    eject()
    if plus then return true, "Ejected Passenger!" end
  end)

  if plus then
    api.findUpgrades = main(function()
      -- every upgrade item lying within two blocks is added; the item stays where it is
      local x, y, z = onPos()
      for _, e in ipairs(world.itemEntities) do
        local upgrade = e.item.name:match("^ccdrones:(%a+)_upgrade$")
        if upgrade and e.x + 0.625 > x - 2 and e.x + 0.375 < x + 2 and e.y + 0.25 > y - 2 and e.y < y + 2
          and e.z + 0.625 > z - 2 and e.z + 0.375 < z + 2 then
          d.upgrades[#d.upgrades + 1] = upgrade
          core.dirty = true
        end
      end
    end)

    api.getPos = main(function()
      if not hasUpgrade("modem") then return false, "Modem Upgrade Not Installed!" end
      return true, { x = mob.x, y = mob.y, z = mob.z }
    end)
  end

  -- ===== the world's side =====

  mob.onInstall = function(b)
    brain, world, rules = b, b.world, b.rules
    local saved = core.savedState and core.savedState.addons and core.savedState.addons[module]
    saved = saved and saved.drone
    if type(saved) == "table" then
      mob.setPos(saved.x or mob.x, saved.y or mob.y, saved.z or mob.z)
      d.yaw, d.pitch = saved.yaw or d.yaw, saved.pitch or d.pitch
      d.vx, d.vy, d.vz = saved.vx or 0, saved.vy or 0, saved.vz or 0
      d.engineOn, d.hover = saved.engineOn == true, saved.hover == true
      d.onGround = saved.onGround == true
      d.upgrades = saved.upgrades or d.upgrades
      d.carrying = saved.carrying
      if saved.passenger then d.passenger = mob.findEntity(saved.passenger) end
    end
    _G.drone = api
    if plus and not fs.exists("/startup/go.lua") and not fs.isReadOnly("/") then
      -- DroneAPI.initDrive: a new drone writes this file five ticks after its first boot
      fs.makeDir("/startup")
      local h = fs.open("/startup/go.lua", "w")
      if h then h.write("--default startup program") h.close() end
    end
  end

  M.state = function()
    local entities = {}
    for i, e in ipairs(world and world.entities or {}) do
      entities[i] = { uuid = e.uuid, type = e.type, x = e.x, y = e.y, z = e.z }
    end
    return {
      entities = entities,
      drone = {
        x = mob.x, y = mob.y, z = mob.z, yaw = d.yaw, pitch = d.pitch, vx = d.vx, vy = d.vy, vz = d.vz,
        engineOn = d.engineOn, hover = d.hover, onGround = d.onGround, colliding = d.colliding,
        upgrades = plus and d.upgrades or nil, carrying = d.carrying,
        passenger = d.passenger and d.passenger.uuid or nil,
      },
      exports = #exports > 0 and exports or nil,
    }
  end

  -- ===== sim commands =====

  M.handlers = {
    --- { x, y, z, yaw?, pitch? }: put the drone somewhere else, at rest
    droneTeleport = function(cmd)
      if type(cmd.x) ~= "number" or type(cmd.y) ~= "number" or type(cmd.z) ~= "number" then return false, "x, y and z are needed" end
      local whole = cmd.x == floor(cmd.x) and cmd.z == floor(cmd.z)
      mob.setPos(cmd.x + (whole and 0.5 or 0), cmd.y, cmd.z + (whole and 0.5 or 0))
      if type(cmd.yaw) == "number" then d.yaw = f32(cmd.yaw) end
      if type(cmd.pitch) == "number" then d.pitch = f32(max(-90, min(90, cmd.pitch))) end
      d.vx, d.vy, d.vz, d.onGround = 0, 0, 0, false
      mob.schedule()
      return true
    end,
    --- { x?, y?, z? }: a shove, added to its velocity (blocks a tick)
    dronePush = function(cmd)
      d.vx, d.vy, d.vz = d.vx + (cmd.x or 0), d.vy + (cmd.y or 0), d.vz + (cmd.z or 0)
      core.dirty = true
      mob.schedule()
      return true
    end,
  }
  if plus then
    --- { upgrade = "mine" | "carry" | "survey" | "modem" }: a sneaking player's click with the upgrade item
    M.handlers.droneAddUpgrade = function(cmd)
      local u = cmd.upgrade
      if u ~= "mine" and u ~= "carry" and u ~= "survey" and u ~= "modem" then return false, "upgrade must be mine, carry, survey or modem" end
      if hasUpgrade(u) then return false, "Drone already has " .. u end
      d.upgrades[#d.upgrades + 1] = u
      core.dirty = true
      return true
    end
    --- a sneaking player's click with the crowbar: every upgrade drops at the drone
    M.handlers.droneRemoveUpgrades = function()
      for _, u in ipairs(d.upgrades) do
        world.dropItem(floor(mob.x), floor(mob.y), floor(mob.z), { name = "ccdrones:" .. u .. "_upgrade", count = 1 })
      end
      d.upgrades = {}
      core.dirty = true
      return true
    end
  end
  for name, handler in pairs(mob.handlers) do M.handlers[name] = handler end
  mob.synced(api)
  mob.synced(M.handlers)

  return M
end
