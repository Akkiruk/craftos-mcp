-- ccsim addon: AC-Drones alpha 7 for Minecraft 1.20.1 (ApioCraft/ac-drones, commit a73fcdd, and the release jar
-- 1.20.1-alpha-7, whose bytecode was compared with that source). Written from its source: apis/DroneAPI.java for
-- every function, core/DroneBrain.java for the command queue, commands/ for what each command does,
-- entities/ComputerDroneEntity.java for the tick (movement, drag, yaw and pitch), accessories/ for the claw, the
-- modems and the chunkloader. docs/ac-drones.md says what each rule comes from and what is simplified.
--
-- A world with an `acDrone` entry makes the computer a drone: an entity that flies through the block world of
-- ccsim/turtle/world.lua (ccsim/mob.lua has what it shares with the other mobs).
return function(core, host)
  local M = {}
  local spec = core.world.acDrone
  if type(spec) ~= "table" then return M end
  local floor, min, max, abs, sqrt = math.floor, math.min, math.max, math.abs, math.sqrt
  local atan2 = math.atan2 or math.atan

  local mob = dofile("/rom/ccsim/mob.lua")(core, {
    x = spec.x, y = spec.y, z = spec.z, dimension = spec.dimension,
  })
  local A = mob.args
  local brain, world, rules, data

  -- Which build: the released alpha 7 (commit a73fcdd), or the repository's later fix of place() (fa57149)
  local BUILDS = { ["alpha-7"] = "alpha-7", a73fcdd = "alpha-7", fa57149 = "fa57149", master = "fa57149" }
  local build = BUILDS[spec.build or "alpha-7"]
  if not build then error("world.acDrone.build must be alpha-7 or fa57149, not " .. tostring(spec.build), 0) end
  -- DroneAPI has two @LuaFunction methods called suck, suck(int) and suck(): CC:Tweaked keeps one per name, the one
  -- Class.getMethods() lists last, and Java does not say which that is. "quantity" is suck(int), "none" is suck().
  local suckOverload = spec.suckOverload or "quantity"
  if suckOverload ~= "quantity" and suckOverload ~= "none" then
    error("world.acDrone.suckOverload must be quantity or none, not " .. tostring(suckOverload), 0)
  end

  local SLOTS = 4                     -- ComputerDroneEntity.INVENTORY_SIZE
  local HALF, HEIGHT = 0.375, 0.25    -- EntityDimensions.fixed(0.75f, 0.25f)
  local EPS = 1e-7

  -- Java floats: yaw, pitch and the move command's speed are floats, and the rounding shows in what Lua reads
  local fround = function(v) return v end
  if string.pack and string.unpack then
    local ok, r = pcall(function() return (string.unpack("<f", string.pack("<f", 0.1))) end)
    if ok and type(r) == "number" and r ~= 0.1 then
      fround = function(v)
        if v ~= v or v == math.huge or v == -math.huge then return v end
        return (string.unpack("<f", string.pack("<f", v)))
      end
    end
  end

  -- ===== accessories (DroneAccessoryRegistry) =====

  -- The bottom slot takes the claw (DroneAccessoryAttachment.BOTTOM), the two attachment slots the others (INTERNAL)
  local ACCESSORY = { claw = "claw", ["acdrones:drone_claw"] = "claw" }
  local ATTACHMENT = {
    modem = "modem", ["computercraft:wireless_modem_normal"] = "modem",
    advanced_modem = "advanced_modem", ["computercraft:wireless_modem_advanced"] = "advanced_modem",
    chunkloader = "chunkloader", ["acdrones:drone_chunkloader"] = "chunkloader",
  }
  local function isModem(kind) return kind == "modem" or kind == "advanced_modem" end
  local function nothing(v) return v == nil or v == false or v == "" or v == "none" or v == textutils.json_null end

  local d = {
    selected = 1,       -- as the API counts it (the entity keeps it from 0)
    slots = {},         -- 1..4
    yaw = fround(tonumber(spec.yaw) or 0),
    pitch = fround(tonumber(spec.pitch) or 0),
    vx = 0, vy = 0, vz = 0,
    lvx = 0, lvy = 0, lvz = 0, -- lastVelocity
    accessory = nil,    -- { kind = "claw", carrying = <block> } or nil: the object in the bottom slot
    attachments = {},   -- [1], [2]: "modem" | "advanced_modem" | "chunkloader" | nil
    sides = {},         -- what the computer has on top, back and bottom (it can differ from the slots, see below)
    falling = {},       -- blocks the claw let go of, on their way down
  }
  local cachedAccessory -- DroneBrain._cachedAccessory

  -- ===== items =====

  local function copy(item, count)
    local c = {}
    for k, v in pairs(item) do c[k] = v end
    c.count = count or item.count
    return c
  end

  --- InventoryUtil.storeItemsFromOffset over the four slots, from `begin` round. Returns how many did not fit.
  --- The fabric transfer API fills the slots the same way (CombinedStorage over the slots, rotated).
  local function store(stack, begin)
    local left = stack.count
    for i = 0, SLOTS - 1 do
      local slot = (begin - 1 + i) % SLOTS + 1
      local here = d.slots[slot]
      if not here then
        local n = min(left, brain.maxOf(stack))
        d.slots[slot] = copy(stack, n)
        left = left - n
      elseif brain.same(here, stack) and here.count < brain.maxOf(here) then
        local n = min(left, brain.maxOf(here) - here.count)
        here.count = here.count + n
        left = left - n
      end
      if left <= 0 then break end
    end
    if left ~= stack.count then core.dirty = true end
    return left
  end

  -- ===== results (DroneCommandResult) =====

  local function ok(...) return table.pack(true, ...) end
  -- failure(null) reaches Lua as false and a nil: the event carries the message even when there is none
  local function fail(message) return { n = 2, false, message } end

  -- ===== the entity's tick (ComputerDroneEntity.tick) =====

  local OTHER = { { 2, 3 }, { 1, 3 }, { 1, 2 } }

  --- VoxelShapes.calculateMaxOffset against whole blocks: how far the box can go along an axis. A block the box is
  --- already in does not stop it (a drone that placed a block into itself flies out again).
  local function clip(box, axis, dist)
    if abs(dist) < EPS then return 0 end
    local u, w = OTHER[axis][1], OTHER[axis][2]
    local u1, u2 = floor(box[u] + EPS), floor(box[u + 3] - EPS)
    local w1, w2 = floor(box[w] + EPS), floor(box[w + 3] - EPS)
    local cell = {}
    local function hit(b)
      cell[axis] = b
      for i = u1, u2 do
        for j = w1, w2 do
          cell[u], cell[w] = i, j
          if mob.solid(cell[1], cell[2], cell[3]) then return true end
        end
      end
      return false
    end
    if dist > 0 then
      local face = box[axis + 3]
      for b = floor(face - EPS) + 1, floor(face + dist - EPS) do
        if hit(b) then dist = min(dist, b - face) break end
      end
    else
      local face = box[axis]
      for b = floor(face + EPS) - 1, floor(face + dist + EPS), -1 do
        if hit(b) then dist = max(dist, b + 1 - face) break end
      end
    end
    if abs(dist) < EPS then return 0 end
    return dist
  end

  local function shift(box, axis, dist)
    box[axis], box[axis + 3] = box[axis] + dist, box[axis + 3] + dist
  end

  --- Entity.move(MovementType.SELF, velocity): y first, then the larger of x and z, stopped by blocks; the velocity
  --- loses the axes that hit something.
  local function moveSelf()
    local mx, my, mz = d.vx, d.vy, d.vz
    if mx == 0 and my == 0 and mz == 0 then return end
    local box = { mob.x - HALF, mob.y, mob.z - HALF, mob.x + HALF, mob.y + HEIGHT, mob.z + HALF }
    local ax, ay, az = mx, my, mz
    if ay ~= 0 then
      ay = clip(box, 2, ay)
      if ay ~= 0 then shift(box, 2, ay) end
    end
    local zFirst = abs(ax) < abs(az)
    if zFirst and az ~= 0 then
      az = clip(box, 3, az)
      if az ~= 0 then shift(box, 3, az) end
    end
    if ax ~= 0 then
      ax = clip(box, 1, ax)
      if not zFirst and ax ~= 0 then shift(box, 1, ax) end
    end
    if not zFirst and az ~= 0 then az = clip(box, 3, az) end
    if ax * ax + ay * ay + az * az > 1e-7 then mob.setPos(mob.x + ax, mob.y + ay, mob.z + az) end
    if abs(mx - ax) >= 1e-5 then d.vx = 0 end
    if abs(mz - az) >= 1e-5 then d.vz = 0 end
    if my ~= ay then d.vy = 0 end -- Block.onEntityLand
  end

  --- ComputerDroneEntity.lerpDegrees, in floats as written
  local function lerpDegrees(from, to, amount)
    local difference = abs(fround(to - from))
    if difference > 180 then
      if to > from then from = fround(from + 360) else to = fround(to + 360) end
    end
    local value = fround(from + fround(fround(to - from) * amount))
    if value >= 0 and value <= 360 then return value end
    return fround(math.fmod(value, 360))
  end

  --- ComputerDroneEntity.updateDirection: the nose follows the velocity, a quarter of the way each tick
  local function updateDirection()
    local targetYaw = fround(math.deg(atan2(-d.vx, d.vz)))
    local horizontal = sqrt(d.vx * d.vx + d.vz * d.vz)
    local targetPitch = -math.deg(math.atan(horizontal)) * 1.5
    if horizontal > 0.01 then d.yaw = lerpDegrees(d.yaw, targetYaw, 0.25) end
    d.pitch = lerpDegrees(d.pitch, fround(targetPitch), 0.25)
    d.lvx, d.lvy, d.lvz = d.vx, d.vy, d.vz
  end

  -- ===== blocks the claw dropped (FallingBlockEntity) =====

  local function land(f, y)
    local x, z = f.x, f.z
    local block = f.block
    local here = brain.blockAt(x, y, z)
    local support = function(dir)
      local sx, sy, sz = world.offset(x, y, z, dir)
      return brain.blockAt(sx, sy, sz)
    end
    if rules.isReplaceable(here) and rules.canSurvive(block.name, block.state, support) then
      world.set(x, y, z, block)
    else
      -- it breaks and lies there as its item; what was in it is gone with it
      local item = rules.asItem(block)
      if item ~= "minecraft:air" then world.dropItem(x, y, z, { name = item, count = 1 }) end
    end
    core.dirty = true
  end

  local function tickFalling()
    if #d.falling == 0 then return end
    local lo, hi = world.limits(core.position.dimension)
    for i = #d.falling, 1, -1 do
      local f = d.falling[i]
      f.time = f.time + 1
      f.vy = f.vy - 0.04
      local ny = f.y + f.vy
      local landed
      for cy = floor(f.y + EPS) - 1, floor(ny + EPS), -1 do
        if mob.solid(f.x, cy, f.z) then ny, landed = cy + 1, true break end
      end
      f.y = ny
      if landed then
        table.remove(d.falling, i)
        land(f, floor(ny + EPS))
      elseif (f.time > 100 and (ny <= lo or ny > hi)) or f.time > 600 then
        table.remove(d.falling, i) -- fell out of the world
        core.dirty = true
      end
      f.vy = f.vy * 0.98
    end
  end

  -- ===== the sides of the computer =====

  local function clawPeripheral(side) -- set below
  end

  local function sideDef(side, kind)
    if kind == "claw" then return clawPeripheral(side) end
    -- DroneChunkloaderAccessory: a peripheral of type "chunkloader" with no methods
    return { name = side, type = "chunkloader", __methods = {} }
  end

  --- ServerComputer.setPeripheral: nothing happens when the new peripheral equals the old one (a modem equals any
  --- other drone modem).
  local function setSide(side, kind, quiet)
    local before = d.sides[side]
    if before == kind then return end
    if isModem(before) and isModem(kind) then d.sides[side] = kind return end
    if before and not isModem(before) then core.detachSide(side, quiet) end
    d.sides[side] = isModem(kind) and kind or nil
    brain.refreshPeripherals(quiet) -- the modem comes or goes (mob.sideUpgrade)
    d.sides[side] = kind
    if kind and not isModem(kind) then core.attachSide(sideDef(side, kind), nil, quiet) end
    core.dirty = true
  end

  -- A drone is not a block: nothing next to it is wrapped
  mob.sideDir = function() return nil end
  -- DroneModemAccessory calls super(new ModemState(), false) for both modems: an advanced modem in a drone is a
  -- plain wireless one, with the range of one
  mob.sideUpgrade = function(side)
    return isModem(d.sides[side]) and "computercraft:wireless_modem_normal" or nil
  end

  --- ComputerDroneEntity.updateInputsImmediately: the first attachment is on top, the second on the back, and every
  --- other side is emptied, the bottom with the claw on it too.
  local function updateInputs(quiet)
    setSide("top", d.attachments[1], quiet)
    setSide("back", d.attachments[2], quiet)
    setSide("bottom", nil, quiet)
  end

  -- ===== commands (DroneBrain) =====

  local queue = {}   -- commands waiting: { id, at, execute, update }
  local current      -- the one that is running (only a move takes more than its own tick)
  local issued = 0   -- DroneBrain.didCommands
  local posted = {}  -- id -> the exact result of a command whose event is on its way

  local function post(cmd)
    local r = cmd.result
    posted[cmd.id] = r
    os.queueEvent("drone_command_result", cmd.id, table.unpack(r, 1, r.n))
  end

  --- DroneBrain.checkWorkCommand: true while the current command still needs ticks
  local function checkWork()
    if not current then return false end
    if current.result then
      post(current)
      current = nil
      return false
    end
    current.update()
    return true
  end

  --- DroneBrain.update, once a tick
  local function brainUpdate()
    if cachedAccessory ~= d.accessory then
      cachedAccessory = d.accessory
      setSide("bottom", d.accessory and d.accessory.kind or nil, false)
    end
    if checkWork() then return end
    local cmd = queue[1]
    -- a command is taken by the first tick after the call that queued it
    if not cmd or cmd.at >= mob.nowTick() then return end
    table.remove(queue, 1)
    cmd.result = cmd.execute()
    current = cmd
    checkWork()
  end

  mob.busy = function()
    return current ~= nil or #queue > 0 or #d.falling > 0 or cachedAccessory ~= d.accessory
      or d.vx * d.vx + d.vy * d.vy + d.vz * d.vz > 1e-7 or abs(d.pitch) > 1e-3
  end

  mob.onTick = function()
    moveSelf()
    updateDirection()
    -- the computer is on, so there is no gravity; drag
    d.vx, d.vy, d.vz = d.vx * 0.9, d.vy * 0.9, d.vz * 0.9
    brainUpdate()
    tickFalling()
  end

  local pullEventRaw = os.pullEventRaw -- the sim's hooked version, taken before any program can replace it

  --- DroneBrain.executeCommand: queue it and wait for its drone_command_result (DroneCommandCallback)
  local function run(cmd)
    if #queue > 16 then return false, "The command queue is too fat" end
    issued = issued + 1
    cmd.id, cmd.at = issued, mob.nowTick()
    queue[#queue + 1] = cmd
    mob.schedule()
    while true do
      local ev = table.pack(pullEventRaw("drone_command_result"))
      if ev[1] == "terminate" then error("Terminated", 0) end
      if ev[1] == "drone_command_result" and ev.n >= 3 and type(ev[2]) == "number" and type(ev[3]) == "boolean" then
        local id = ev[2] >= 0 and floor(ev[2]) or -floor(-ev[2])
        if id == cmd.id then
          local r = posted[id]
          if r then
            posted[id] = nil
            return table.unpack(r, 1, r.n)
          end
          return table.unpack(ev, 3, ev.n) -- an event the program queued itself
        end
      end
    end
  end

  local function instant(fn) return { execute = fn, update = function() end } end

  --- DroneMoveCommand: fly by (x, y, z) from where the drone is when the command starts. Each tick sets the
  --- velocity toward what is left, faster up to a quarter block a tick over the first half and slower over the
  --- last two blocks; done within a tenth of a block, given up after 100 ticks.
  local function moveCommand(x, y, z)
    local wx, wy, wz = x, y, z
    local initial = sqrt(x * x + y * y + z * z)
    local lx, ly, lz
    local iterations = 0
    local speed = fround(0.01)
    local cmd = {}
    function cmd.execute()
      lx, ly, lz = mob.x, mob.y, mob.z
      return nil
    end
    function cmd.update()
      iterations = iterations + 1
      local cx, cy, cz = mob.x, mob.y, mob.z
      local tx, ty, tz = cx + wx, cy + wy, cz + wz
      local dx, dy, dz = tx - cx, ty - cy, tz - cz
      local distance = sqrt(dx * dx + dy * dy + dz * dz)
      local progress = 1 - distance / initial
      if progress < 0.5 then
        if speed < 0.25 then speed = fround(speed + 0.01) end
      elseif speed > 0.05 and distance <= 2 then
        speed = fround(speed - 0.01 * (2 - distance))
      end
      if distance < 1e-4 then -- Vec3d.normalize
        d.vx, d.vy, d.vz = 0, 0, 0
      else
        d.vx, d.vy, d.vz = dx / distance * speed, dy / distance * speed, dz / distance * speed
      end
      wx, wy, wz = wx - (cx - lx), wy - (cy - ly), wz - (cz - lz)
      if sqrt(wx * wx + wy * wy + wz * wz) < 0.1 then
        d.vx, d.vy, d.vz = 0, 0, 0
        cmd.result = ok()
      end
      -- the velocity stays as it is: a drone that gives up drifts on until the drag stops it
      if iterations > 100 and not cmd.result then cmd.result = fail("Movement took too long") end
      lx, ly, lz = cx, cy, cz
    end
    return cmd
  end

  --- Every entity whose box reaches into a block (World.getEntitiesByClass(Entity.class, new Box(pos)))
  local function entitiesIn(x, y, z, livingOnly)
    if not livingOnly and #world.itemsIn(x, y, z, x + 1, y + 1, z + 1) > 0 then return true end
    for _, e in ipairs(mob.entities()) do
      if not livingOnly or e.living then
        local w, h = (e.width or 0.6) / 2, e.height or 1.8
        if e.x + w > x and e.x - w < x + 1 and e.y + h > y and e.y < y + 1 and e.z + w > z and e.z - w < z + 1 then
          return true
        end
      end
    end
    return false
  end

  local function inBuildLimit(y)
    local lo, hi = world.limits(core.position.dimension)
    return y >= lo and y <= hi
  end

  --- DroneUseCommand.letMePlace on the block below the drone
  local function letMePlace(item, x, y, z)
    if not inBuildLimit(y) then return false end
    local below = brain.blockAt(x, y, z)
    if rules.isAir(below) then return false end
    if rules.blockFor(item.name, "up") and rules.isLiquid(below) then return false end
    if entitiesIn(x, y, z, false) then return false end
    -- Alpha 7 ends with `return !CommonProtection.canPlaceBlock(...)`: with nothing protecting the block that is
    -- always false. Commit fa57149 ("Whoops! The check was inverted!") returns it as it is.
    return build == "fa57149"
  end

  -- Direction.fromRotation
  local FACINGS = { [0] = "south", "west", "north", "east" }
  local function yawFacing() return FACINGS[floor(d.yaw / 90 + 0.5) % 4] end

  --- ItemStack.useOnBlock on the drone's own block, clicked from above, by a fake player who looks the way the drone
  --- does. Only an item that is a block does anything.
  local function useOnBlock(item, x, y, z)
    local name = rules.blockFor(item.name, "up")
    if not name then return false end
    -- ItemPlacementContext: into the clicked block when it can be replaced, else onto it
    if not rules.isReplaceable(brain.blockAt(x, y, z)) then y = y + 1 end
    local target = brain.blockAt(x, y, z)
    if not rules.isReplaceable(target) or not inBuildLimit(y) then return false end
    local facing = yawFacing()
    local look = (d.pitch > 45 and "down") or (d.pitch < -45 and "up") or facing
    local inWater = target ~= nil and target.name == "minecraft:water" and tostring(target.state.level or "0") == "0"
    local state = rules.placementState(name, { face = "up", look = look, pitch = d.pitch, yaw = facing, inWater = inWater })
    if not state then return false end
    local block = world.newBlock({ name = name, state = state })
    -- World.canPlace: a mob standing there is in the way (the drone itself is not: it does not block building)
    if rules.hasCollision(block) and entitiesIn(x, y, z, true) then return false end
    local support = function(dir)
      local sx, sy, sz = world.offset(x, y, z, dir)
      return brain.blockAt(sx, sy, sz)
    end
    if not rules.canSurvive(name, block.state, support) then return false end
    local other -- the second block of a door, a tall plant or a bed
    if block.state.half == "lower" then
      other = { x, y + 1, z, "half", "upper" }
    elseif name:find("_bed$") then
      local hx, hy, hz = world.offset(x, y, z, block.state.facing or facing)
      block.state.part = "foot"
      other = { hx, hy, hz, "part", "head" }
    end
    if other then
      if not rules.isReplaceable(brain.blockAt(other[1], other[2], other[3])) then return false end
      local second = world.newBlock({ name = name, state = block.state })
      second.state[other[4]] = other[5]
      world.set(other[1], other[2], other[3], second)
    end
    world.set(x, y, z, block)
    return true
  end

  --- DroneUseCommand
  local function placeCommand()
    local slot = d.selected
    local item = d.slots[slot]
    if not item then return fail("No items to place or use") end
    local bx, by, bz = mob.blockPos()
    if not letMePlace(item, bx, by - 1, bz) then return fail("Cannot place block here") end
    if not useOnBlock(item, bx, by, bz) then return fail("Cannot place block here") end
    item.count = item.count - 1
    if item.count <= 0 then d.slots[slot] = nil end
    core.dirty = true
    return ok()
  end

  --- DroneSuckCommand
  local function suckCommand(quantity)
    if quantity == 0 then return ok() end
    local bx, by, bz = mob.blockPos()
    local x, y, z = bx, by - 1, bz
    local inv = brain.worldInventory(x, y, z, "up")
    if inv then
      -- CC:Tweaked's FabricContainerTransfer.moveTo (1.112.0 and later): slot by slot, the first slot whose items
      -- fit moves, from that slot only and as many as fit; a slot whose items do not fit is passed over
      local hasItem = false
      for _, s in ipairs(inv.slots) do
        local here = inv.get(s)
        if here then
          hasItem = true
          local want = min(quantity, here.count)
          local n = want - store(copy(here, want), d.selected)
          if n > 0 then
            here.count = here.count - n
            if here.count <= 0 then inv.set(s, nil) end
            core.dirty = true
            return ok()
          end
        end
      end
      return fail(hasItem and "No space for items" or "No items to take")
    end
    -- loose items in the block below the drone
    local found = world.itemsIn(x, y, z, x + 1, y + 1, z + 1)
    if #found == 0 then return fail("No items to take") end
    for _, index in ipairs(found) do
      local e = world.itemEntities[index]
      local n = min(quantity, e.item.count)
      local stored = n - store(copy(e.item, n), d.selected)
      if stored > 0 then
        e.item.count = e.item.count - stored
        if e.item.count <= 0 then table.remove(world.itemEntities, index) end
        core.dirty = true
        return ok()
      end
    end
    return fail("No space for items")
  end

  --- What happens on the server thread inside the entity's tick: an exception there takes the server down
  local function crash(what)
    error("ccsim ac-drones: " .. what .. " throws inside the drone's tick, which crashes a real server (not emulated)", 0)
  end

  -- ===== drone (DroneAPI.java) =====

  local api = {}

  function api.move(...)
    local x, y, z = ...
    x, y, z = A.double(1, x), A.double(2, y), A.double(3, z)
    return run(moveCommand(x, y, z))
  end

  function api.select(...)
    local slot = A.int(1, (...))
    return run(instant(function()
      if slot < 1 or slot > SLOTS then return fail("Slot out of range") end
      d.selected = slot
      core.dirty = true
      return ok()
    end))
  end

  function api.getSelectedSlot() return d.selected end

  if suckOverload == "quantity" then
    function api.suck(...)
      local quantity = A.int(1, (...))
      if quantity < 0 then crash("suck with a quantity below 0") end
      return run(instant(function() return suckCommand(quantity) end))
    end
  else
    function api.suck()
      return run(instant(function() return suckCommand(1) end))
    end
  end

  function api.place()
    return run(instant(placeCommand))
  end

  function api.compare(...)
    local slot = A.int(1, (...))
    -- DefaultedList.get(slot - 1)
    if slot < 1 or slot > SLOTS then crash("compare with a slot outside 1 to 4") end
    return run(instant(function()
      local a, b = d.slots[d.selected], d.slots[slot]
      -- 1.20.1: ItemStack.areEqual, which counts the items too (the 1.21 build has areItemsAndComponentsEqual)
      local equal
      if not a and not b then equal = true
      elseif not a or not b then equal = false
      else equal = a.count == b.count and brain.same(a, b) end
      if equal then return ok() end
      return fail(nil)
    end))
  end

  function api.getRotation()
    return mob.onMainThread(function() return d.yaw, d.pitch end)
  end

  function api.getItemDetail(...)
    local args = table.pack(...)
    return mob.onMainThread(function()
      local slot = A.optInt(1, args[1]) or d.selected
      if slot < 1 or slot > SLOTS then
        mob.javaError("java.lang.ArrayIndexOutOfBoundsException", ("Index %d out of bounds for length %d"):format(slot - 1, SLOTS))
      end
      local item = d.slots[slot]
      if not item then return nil end
      return brain.itemDetail(item, true)
    end)
  end

  -- ===== the claw (DroneClawAccessory) =====

  -- #acdrones:claw_blacklist is #computercraft:turtle, #minecraft:dragon_immune and #minecraft:wither_immune. The
  -- vanilla 1.20.1 members are listed for worlds whose game data does not have the tags.
  local IMMUNE = {}
  for name in ("barrier bedrock end_portal end_portal_frame end_gateway command_block repeating_command_block "
    .. "chain_command_block structure_block jigsaw moving_piston obsidian crying_obsidian end_stone iron_bars "
    .. "respawn_anchor reinforced_deepslate light"):gmatch("%S+") do
    IMMUNE["minecraft:" .. name] = true
  end
  IMMUNE["computercraft:turtle_normal"], IMMUNE["computercraft:turtle_advanced"] = true, true

  local function blacklisted(block)
    local name = block.name
    return IMMUNE[name] or data.blockHasTag(name, "acdrones:claw_blacklist") or data.blockHasTag(name, "computercraft:turtle")
      or data.blockHasTag(name, "minecraft:dragon_immune") or data.blockHasTag(name, "minecraft:wither_immune")
  end

  local function clawGrab()
    local claw = d.accessory
    local x, y, z = mob.blockPos()
    -- the block the drone is in, or the one below it
    if rules.isAir(brain.blockAt(x, y, z)) then y = y - 1 end
    local block = brain.blockAt(x, y, z)
    if rules.isAir(block) then return nil, "no block to grab" end
    if claw.carrying then return nil, "claw is full" end
    if blacklisted(block) then return nil, "cannot grab block" end
    -- the block and what is in it (its block entity) go into the claw; nothing drops
    claw.carrying = block
    world.set(x, y, z, nil)
    core.dirty = true
    return true
  end

  local function clawDrop()
    local claw = d.accessory
    local x, y, z = mob.blockPos()
    y = y - 1
    if not rules.isAir(brain.blockAt(x, y, z)) then return nil, "block below drone is not air" end
    if not claw.carrying then return nil, "claw is empty" end
    -- FallingBlockEntity.spawnFromBlock in the block below the drone
    d.falling[#d.falling + 1] = { block = claw.carrying, x = x, y = y, z = z, vy = 0, time = 0 }
    claw.carrying = nil
    core.dirty = true
    mob.schedule()
    return true
  end

  clawPeripheral = function(side)
    return {
      name = side, type = "claw",
      __methods = {
        -- the claw answers for whichever claw is in the slot when the call runs
        grab = function() return clawGrab() end,
        drop = function() return clawDrop() end,
      },
    }
  end

  -- ===== the world's side =====

  local function setAccessory(kind, carrying)
    d.accessory = kind and { kind = kind, carrying = carrying } or nil
    core.dirty = true
  end

  local function blockDef(block)
    if not block then return nil end
    local def = { name = block.name }
    if next(block.state) then def.state = block.state end
    if block.inventory then
      local items = {}
      for slot, item in pairs(block.inventory.__state()) do items[tostring(slot)] = copy(item) end
      if next(items) then def.items = items end
    elseif block.def and block.def.items then
      def.items = block.def.items
    end
    if block.def and block.def.size then def.size = block.def.size end
    if block.blockEntity then def.blockEntity = block.blockEntity end
    return def
  end

  local function readAttachments(list)
    local out = {}
    if type(list) ~= "table" then return out end
    for i = 1, 2 do
      local v = list[i]
      if v == nil then v = list[tostring(i)] end
      if not nothing(v) then
        local kind = ATTACHMENT[v]
        if not kind then error("world.acDrone.attachments: " .. tostring(v) .. " is not modem, advanced_modem or chunkloader", 0) end
        out[i] = kind
      end
    end
    return out
  end

  mob.onInstall = function(b)
    brain, world, rules, data = b, b.world, b.rules, b.data
    for key, def in pairs(spec.inventory or {}) do
      local slot = tonumber(key)
      if slot and slot >= 1 and slot <= SLOTS then d.slots[slot] = brain.normItem(def) end
    end
    local selected = tonumber(spec.selectedSlot)
    if selected and selected >= 1 and selected <= SLOTS then d.selected = floor(selected) end
    d.attachments = readAttachments(spec.attachments)
    if not nothing(spec.accessory) then
      local kind = ACCESSORY[spec.accessory]
      if not kind then error("world.acDrone.accessory: " .. tostring(spec.accessory) .. " is not claw", 0) end
      setAccessory(kind, type(spec.carrying) == "table" and world.newBlock(spec.carrying) or nil)
    end

    local saved = core.savedState and core.savedState.addons and core.savedState.addons["ac-drones"]
    saved = saved and saved.drone
    if type(saved) == "table" then
      if saved.x then mob.setPos(saved.x, saved.y, saved.z) end
      d.yaw, d.pitch = saved.yaw or d.yaw, saved.pitch or d.pitch
      d.selected = saved.selected or d.selected
      d.slots = {}
      for key, def in pairs(saved.slots or {}) do d.slots[tonumber(key)] = brain.normItem(def) end
      d.attachments = readAttachments(saved.attachments)
      setAccessory(saved.accessory, type(saved.carrying) == "table" and world.newBlock(saved.carrying) or nil)
    end

    -- the computer as it is made: updateInputsImmediately, then DroneBrain.update puts the claw on the bottom
    updateInputs(true)
    cachedAccessory = d.accessory
    setSide("bottom", d.accessory and d.accessory.kind or nil, true)

    _G.drone = api
  end

  M.state = function()
    local slots = {}
    for i = 1, SLOTS do if d.slots[i] then slots[tostring(i)] = d.slots[i] end end
    local falling = {}
    for i, f in ipairs(d.falling) do falling[i] = { name = f.block.name, x = f.x, y = f.y, z = f.z } end
    return {
      drone = {
        x = mob.x, y = mob.y, z = mob.z, yaw = d.yaw, pitch = d.pitch,
        velocity = { x = d.vx, y = d.vy, z = d.vz },
        selected = d.selected, slots = slots,
        accessory = d.accessory and d.accessory.kind or nil,
        carrying = d.accessory and blockDef(d.accessory.carrying) or nil,
        attachments = { ["1"] = d.attachments[1], ["2"] = d.attachments[2] },
        sides = { top = d.sides.top, back = d.sides.back, bottom = d.sides.bottom },
        queued = #queue, moving = current ~= nil,
        falling = #falling > 0 and falling or nil,
      },
    }
  end

  -- ===== sim commands =====

  local function itemArg(cmd)
    if nothing(cmd.item) then return nil end
    if type(cmd.item) == "string" then return brain.normItem({ name = cmd.item, count = cmd.count or 1 }) end
    return brain.normItem(cmd.item)
  end

  M.handlers = {
    --- { slot = 1..4, item = <item> | null }: what a player puts into or takes out of the drone's inventory
    acDroneSetSlot = function(cmd)
      if type(cmd.slot) ~= "number" or cmd.slot < 1 or cmd.slot > SLOTS then return false, "slot must be 1 to 4" end
      d.slots[floor(cmd.slot)] = itemArg(cmd)
      core.dirty = true
      return true
    end,
    --- { accessory = "claw" | null, carrying? = <block> }: the bottom slot. A claw that is taken out loses the block
    --- it carries, and the computer sees the change on its next tick.
    acDroneSetAccessory = function(cmd)
      if nothing(cmd.accessory) then
        setAccessory(nil)
      else
        local kind = ACCESSORY[cmd.accessory]
        if not kind then return false, "accessory must be claw or null" end
        setAccessory(kind, type(cmd.carrying) == "table" and world.newBlock(cmd.carrying) or nil)
      end
      mob.schedule()
      return true
    end,
    --- { slot = 1 | 2, attachment = "modem" | "advanced_modem" | "chunkloader" | null }: an attachment slot
    acDroneSetAttachment = function(cmd)
      if cmd.slot ~= 1 and cmd.slot ~= 2 then return false, "slot must be 1 or 2" end
      if nothing(cmd.attachment) then
        -- setAccessoryAttachment(slot, null) empties the slot and leaves the computer's side as it was
        d.attachments[cmd.slot] = nil
      else
        local kind = ATTACHMENT[cmd.attachment]
        if not kind then return false, "attachment must be modem, advanced_modem, chunkloader or null" end
        d.attachments[cmd.slot] = kind
        updateInputs(false)
      end
      core.dirty = true
      return true
    end,
    --- { x, y, z, yaw?, pitch? }: pick the drone up and put it somewhere else
    acDroneTeleport = function(cmd)
      if type(cmd.x) ~= "number" or type(cmd.y) ~= "number" or type(cmd.z) ~= "number" then return false, "x, y and z are needed" end
      local whole = cmd.x == floor(cmd.x) and cmd.z == floor(cmd.z)
      mob.setPos(cmd.x + (whole and 0.5 or 0), cmd.y, cmd.z + (whole and 0.5 or 0))
      if type(cmd.yaw) == "number" then d.yaw = fround(cmd.yaw) end
      if type(cmd.pitch) == "number" then d.pitch = fround(cmd.pitch) end
      mob.schedule()
      return true
    end,
  }
  for name, handler in pairs(mob.handlers) do M.handlers[name] = handler end

  return M
end
