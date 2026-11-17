-- ccsim cc-liftlink: CC: LiftLink, the `create_elevator` peripheral on Create's elevator contact.
--
-- Written from tiktop101/CC-LiftLink at 18ab47b (2 Oct 2026): src/main/java/com/tom/createelevatorcc/
-- {ElevatorMethods,ElevatorHelpers}.java, and checked against both released jars with javap (every method, signature,
-- string and the `mainThread = true` on each): ccliftlink-1.0.3.jar (Forge 1.20.1, a generic peripheral) and
-- ccliftlink-1.0.4-neoforge.jar (NeoForge 1.21.1, the same methods behind its own IPeripheral,
-- ElevatorContactPeripheral, registered as the contact's peripheral capability). Their method bodies are the same.
--
-- Create's side is read from Creators-of-Create/Create, tags mc1.20.1-6.0.8 and mc1.21.1-6.0.10 (the elevator code is
-- the same in both), src/main/java/com/simibubi/create/content/contraptions/: elevator/{ElevatorColumn,
-- ElevatorContactBlock,ElevatorContactBlockEntity,ElevatorContraption,ElevatorPulleyBlockEntity},
-- piston/LinearActuatorBlockEntity, pulley/PulleyBlockEntity, ../redstone/contact/ContactMovementBehaviour;
-- kinetics/base/KineticBlockEntity.convertToLinear; infrastructure/config/CKinetics (maxRopeLength 384).
-- The clock, kinetic networks and the Java helpers come from ../create/init.lua. docs/cc-liftlink.md lists every rule.
return function(core, host)
  local create = core.loadAddon("create")
  local C = create.C
  local K = create.kinetics
  local floor, abs, sqrt = math.floor, math.abs, math.sqrt
  local f = C.float
  local cfg = core.world.liftlink or {}
  local createConf = ((core.world.create or {}).config or {})
  local MAX_ROPE = tonumber(createConf.maxRopeLength) or 384 -- CKinetics.maxRopeLength
  local MIN_BUILD = tonumber(cfg.minBuildHeight) or -64
  local mc = (core.version or {}).mc or "1.20.1"

  local F_1_99, F_ACC_LO, F_ACC_HI, F_EPS = f(1.99), f(0.0075), f(0.0175), f(1.0E-4)

  local M = {}
  local columns, columnOrder = {}, {}
  local contactOf = {} -- peripheral name -> { column, contact }

  -- ===== Java helpers =====

  local function isBlank(s) return s == nil or s:match("^%s*$") ~= nil end -- String.isBlank
  local function nonBlank(s) if isBlank(s) then return nil end return s end -- ElevatorHelpers.nonBlank
  local function trim(s) return (s:gsub("^[%z\1- ]+", ""):gsub("[%z\1- ]+$", "")) end -- String.trim
  local function eqIgnoreCase(a, b) return a ~= nil and b ~= nil and a:lower() == b:lower() end

  --- Integer.valueOf(s, 10), or nil for a NumberFormatException
  local function tryValueOf(s)
    if not s:match("^[+-]?%d+$") then return nil end
    local v = tonumber(s)
    if not v or v > 2147483647 or v < -2147483648 then return nil end
    return v
  end

  --- ElevatorHelpers.bestFloorName: Objects.requireNonNullElse(nonBlank(short), nonBlank(long))
  local function bestFloorName(c)
    local n = nonBlank(c.shortName) or nonBlank(c.longName)
    if n == nil then C.java("java.lang.NullPointerException", "defaultObj") end
    return n
  end

  --- (int) of a long: CC 1.121's getInt is (int) getLong, and getLong is Number.longValue (toward zero)
  local function wrapInt(d)
    if d >= 9.2233720368547758e18 then d = 9.2233720368547758e18 - 1024 elseif d <= -9.2233720368547758e18 then d = -9.2233720368547758e18 end
    d = d >= 0 and floor(d) or -floor(-d)
    local r = math.fmod(d, 4294967296)
    if r < 0 then r = r + 4294967296 end
    if r >= 2147483648 then r = r - 4294967296 end
    return r
  end

  local function luaType(v)
    return v == nil and "nil" or type(v)
  end

  -- IArguments.getInt (1.121: no integer check, NaN and infinities refused)
  local function argInt(i, v)
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, luaType(v)), 0) end
    if v ~= v then error(("bad argument #%d (number expected, got nan)"):format(i), 0) end
    if v == math.huge then error(("bad argument #%d (number expected, got inf)"):format(i), 0) end
    if v == -math.huge then error(("bad argument #%d (number expected, got -inf)"):format(i), 0) end
    return wrapInt(v)
  end

  -- IArguments.getString: a Lua string only, numbers are not coerced
  local function argString(i, v)
    if type(v) ~= "string" then error(("bad argument #%d (string expected, got %s)"):format(i, luaType(v)), 0) end
    return v
  end

  local function fclamp(v, lo, hi) -- Mth.clamp(float)
    if v < lo then return lo end
    return math.min(v, hi)
  end

  -- ===== columns =====

  local FACINGS = { north = true, south = true, east = true, west = true, up = true, down = true }

  local function newContact(spec, y)
    return {
      y = y,
      shortName = type(spec.shortName) == "string" and spec.shortName or "",
      longName = type(spec.longName) == "string" and spec.longName or "",
      lastReported = type(spec.currentFloor) == "string" and spec.currentFloor or "", -- lastReportedCurrentFloor
      calling = spec.calling == true,
      powered = spec.powered == true,
      peripheral = spec.peripheral,
    }
  end

  local function getColumn(id)
    local col = columns[id]
    if col then return col end
    local spec = (cfg.columns or {})[id] or {}
    col = {
      id = id,
      x = C.toInt(tonumber(spec.x) or 0),
      z = C.toInt(tonumber(spec.z) or 0),
      facing = FACINGS[spec.facing] and spec.facing or "south",
      contacts = {}, -- sorted by y, as ElevatorColumn.contacts
      targetAvailable = false,
      targetY = 0,
      active = false,
      spec = spec,
    }
    columns[id] = col
    columnOrder[#columnOrder + 1] = id
    return col
  end

  local function findContact(col, y)
    for _, c in ipairs(col.contacts) do if c.y == y then return c end end
    return nil
  end

  -- ElevatorColumn.add: sorted by y, a second contact at the same height is ignored
  local function addContact(col, c)
    if findContact(col, c.y) then return false end
    local index = 1
    while index <= #col.contacts and col.contacts[index].y <= c.y do index = index + 1 end
    table.insert(col.contacts, index, c)
    return true
  end

  -- ElevatorColumn.initNames: blank (and clashing) short names become floor numbers
  local function initNames(col)
    local list = col.contacts
    local prevLevel = nil
    for i = 1, #list do
      local ecbe = list[i]
      local currentLevel = nil
      local skip = false
      if not isBlank(ecbe.shortName) then
        local v = tryValueOf(ecbe.shortName)
        if v ~= nil then currentLevel = v end
        if currentLevel == nil then skip = true end
      end
      if not skip then
        if prevLevel ~= nil then currentLevel = prevLevel + 1 end
        local nextLevel = nil
        for peek = i + 1, #list do
          local peekEcbe = list[peek]
          local v = tryValueOf(peekEcbe.shortName)
          if v ~= nil then
            if currentLevel ~= nil and currentLevel >= v then
              peekEcbe.shortName = ""
              break
            end
            nextLevel = v
            break
          end
        end
        if currentLevel == nil then currentLevel = nextLevel ~= nil and nextLevel - 1 or 0 end
        ecbe.shortName = tostring(currentLevel)
        prevLevel = currentLevel
      end
    end
  end

  local function floorReached(col, name) -- ElevatorColumn.floorReached -> updateDisplayedFloor
    for _, c in ipairs(col.contacts) do c.lastReported = name end
  end

  -- ElevatorContactBlock.callToContactAndUpdate
  local function callToContact(col, target, powered)
    for _, c in ipairs(col.contacts) do
      if c ~= target then c.calling = false end
    end
    if powered then target.powered = true end
    target.calling = true
    col.targetY = target.y -- ElevatorColumn.target
    col.targetAvailable = true
  end

  -- ===== the elevator pulley and its cab =====

  local function newPulley(col, spec)
    local p = { col = col }
    local top = col.contacts[#col.contacts] and col.contacts[#col.contacts].y or 64
    p.y = C.toInt(tonumber(spec.y) or (top + 3)) -- the pulley block's height
    p.contactYOffset = C.toInt(tonumber(spec.contactYOffset) or 0) -- the cab's contact, relative to the cab's top block
    p.distance = C.toInt(tonumber(spec.distance) or 1) -- horizontal blocks between the pulley and the contact column
    p.network = spec.network
    p.rpm = tonumber(spec.rpm) or (spec.network == nil and 32 or 0)
    p.assembled = spec.assembled ~= false
    p.prevSpeed = 0
    p.arrived = true
    p.maxContactY = p.y + p.contactYOffset - 1 -- ElevatorPulleyBlockEntity.assemble
    p.minContactY = p.maxContactY - MAX_ROPE
    p.range = math.max(0, math.min(MAX_ROPE, (p.y - 1) - MIN_BUILD)) -- PulleyBlockEntity.getExtensionRange
    local restY = tonumber(spec.cabY)
    if restY == nil then
      restY = (col.spec.target ~= nil and tonumber(col.spec.target)) or (col.contacts[1] and col.contacts[1].y) or p.maxContactY
    end
    p.restY = C.toInt(restY) -- where the cab's contact stands while it is disassembled
    if p.assembled then
      p.offset = f(p.y + p.contactYOffset - 1 - p.restY)
    else
      p.offset = f(tonumber(spec.offset) or -1) -- LinearActuatorBlockEntity.disassemble leaves -1
    end
    if spec.offset ~= nil and p.assembled then p.offset = f(tonumber(spec.offset)) end
    function p.kineticSpeed() -- KineticBlockEntity.getSpeed (0 when overstressed)
      if p.network then return f(K.effective(p.network)) end
      return f(p.rpm)
    end
    function p.cabY() -- ElevatorHelpers.getCurrentCabY
      if not p.assembled then return nil end
      return p.y + p.contactYOffset - 1.0 - p.offset
    end
    function p.unreachable(y) return y < p.minContactY or y > p.maxContactY end -- ElevatorContraption
    function p.currentTargetY() -- ElevatorContraption.getCurrentTargetY
      if not p.assembled then return nil end
      if not col.targetAvailable then return nil end
      if p.unreachable(col.targetY) then return nil end
      return col.targetY
    end
    local function targetOffset() -- ElevatorPulleyBlockEntity.getTargetOffset
      local target = p.currentTargetY()
      if target == nil then return C.toInt(p.offset) end
      return p.y - target + p.contactYOffset - 1
    end
    -- ElevatorPulleyBlockEntity.getMovementSpeed: it also keeps prevSpeed and `arrived`, so every call counts,
    -- the ones LiftLink makes (getSpeed, isMoving, getState) as well as the pulley's own tick
    function p.movementSpeed()
      local currentTarget = targetOffset()
      local diff = f(currentTarget - p.offset)
      local movementSpeed = fclamp(f(f(p.kineticSpeed() * 2) / 512), -F_1_99, F_1_99)
      local rpmLimit = abs(movementSpeed)
      local configacc = f(F_ACC_LO + f(rpmLimit * f(F_ACC_HI - F_ACC_LO))) -- Mth.lerp
      local decel = f(sqrt(f(f(2 * abs(diff)) * configacc)))
      local speed = diff
      speed = fclamp(speed, -rpmLimit, rpmLimit)
      speed = fclamp(speed, f(p.prevSpeed - configacc), f(p.prevSpeed + configacc))
      speed = fclamp(speed, -decel, decel)
      p.arrived = abs(diff) < 0.5
      p.prevSpeed = speed
      return speed
    end
    local function contactBlockY() -- the column block in front of the cab's contact (ContactMovementBehaviour)
      local y = p.cabY()
      return y and floor(y + 0.5) or nil
    end
    p.lastVisited = contactBlockY()
    -- one server tick: LinearActuatorBlockEntity.tick, then ElevatorPulleyBlockEntity.tick
    function p.tick()
      if not p.assembled then return false end
      local before, prev = p.offset, p.prevSpeed
      local movementSpeed = p.movementSpeed()
      p.offset = f(p.offset + movementSpeed)
      if p.offset <= 0 or p.offset >= p.range then p.offset = f(p.offset <= 0 and 0 or p.range) end
      local visited = contactBlockY()
      if visited ~= p.lastVisited then
        p.lastVisited = visited
        local c = findContact(col, visited)
        if c then floorReached(col, c.shortName) end -- ElevatorContraption.broadcastFloorData
      end
      return p.offset ~= before or p.prevSpeed ~= prev
    end
    function p.busy() return p.assembled and not p.arrived end
    return p
  end

  -- LinearActuatorBlockEntity: assembleNextTick, then ElevatorPulleyBlockEntity.assemble
  local function assemble(col)
    local p = col.pulley
    if p.assembled then return false, "the cab is already assembled" end
    if p.kineticSpeed() == 0 then return false, "the pulley is not turning (Create assembles only while it turns)" end
    if col.active then return false, "the column already has an elevator (column_conflict)" end
    p.offset = f(p.y + p.contactYOffset - 1 - p.restY)
    p.assembled = true
    p.arrived = true
    col.targetY = p.restY
    col.targetAvailable = true
    col.active = true
    p.lastVisited = p.restY
    local c = findContact(col, p.restY)
    if c then floorReached(col, c.shortName) end
    return true
  end

  local function disassemble(col)
    local p = col.pulley
    if not p.assembled then return false, "the cab is not assembled" end
    p.restY = floor(p.cabY() + 0.5)
    col.active = false
    p.assembled = false
    p.offset = f(-1)
    p.lastVisited = nil
    return true
  end

  -- ===== building the world =====

  local function contactSpec(def)
    return {
      shortName = def.shortName, longName = def.longName, currentFloor = def.currentFloor,
      calling = def.calling, powered = def.powered, peripheral = def.name,
    }
  end

  local function columnIdOf(def) return def.column ~= nil and tostring(def.column) or ("contact:" .. tostring(def.name)) end

  -- every contact first (blocks with and without a computer), then the pulleys, then the names Create would generate
  for id, spec in pairs(cfg.columns or {}) do
    local col = getColumn(tostring(id))
    for _, cs in ipairs(spec.contacts or {}) do addContact(col, newContact(cs, C.toInt(tonumber(cs.y) or 0))) end
  end
  for _, def in ipairs(core.world.peripherals or {}) do
    if def.type == "create_elevator" then
      local col = getColumn(columnIdOf(def))
      local c = newContact(contactSpec(def), C.toInt(tonumber(def.y) or 0))
      if not addContact(col, c) then c = findContact(col, c.y); c.peripheral = def.name end
      contactOf[def.name] = { col = col, contact = c }
    end
  end

  local function finish(col)
    local spec = col.spec
    if spec.target ~= nil then
      col.targetY = C.toInt(tonumber(spec.target) or 0)
      col.targetAvailable = true
    end
    if spec.pulley then
      col.pulley = newPulley(col, spec.pulley)
      create.addTicker(col.pulley)
      if col.pulley.assembled then
        col.active = true
        if spec.target == nil then
          col.targetY = col.pulley.restY
          col.targetAvailable = true
        end
      end
    end
    for _, c in ipairs(col.contacts) do
      if isBlank(c.shortName) then
        initNames(col) -- ElevatorContactBlockEntity.tick: deferNameGenerator, on the first tick
        break
      end
    end
    -- the cab was assembled at (or last passed) its floor: every contact shows that floor (broadcastFloorData)
    if col.pulley and col.pulley.assembled then
      local here = findContact(col, col.pulley.restY)
      if here then
        for _, c in ipairs(col.contacts) do
          if c.lastReported == "" then c.lastReported = here.shortName end
        end
      end
    end
  end
  for _, id in ipairs(columnOrder) do finish(columns[id]) end

  -- ===== what LiftLink reads (ElevatorHelpers) =====

  local function requireColumn(col)
    -- the contact itself is always on its column, so ElevatorHelpers.resolveColumn finds one
    if #col.contacts == 0 then error("No elevator column found for this contact", 0) end
    return col
  end

  -- ElevatorHelpers.resolvePulley: the contraption entity within the search box (assembled cabs), else a pulley
  -- block within 3 blocks of the column
  local function resolvePulley(col)
    local p = col.pulley
    if not p then return nil end
    if p.assembled and p.distance <= 4 then return p end
    if p.distance <= 3 then return p end
    return nil
  end

  local function findCurrentFloorContact(col)
    for _, c in ipairs(col.contacts) do
      local current = nonBlank(c.lastReported)
      if current ~= nil then
        if eqIgnoreCase(current, nonBlank(c.shortName)) or eqIgnoreCase(current, nonBlank(c.longName)) then return c end
      end
    end
    return nil
  end

  local function findBestContactForCabY(col, cabY)
    if cabY == nil then return nil end
    local best, bestDistance = nil, math.huge
    for _, c in ipairs(col.contacts) do
      local d = abs(c.y - cabY)
      if d < bestDistance then best, bestDistance = c, d end
    end
    return best
  end

  local function columnTarget(col) if col.targetAvailable then return col.targetY end return nil end

  -- ===== the peripheral =====

  -- Class.getMethods order of the class CC reads (HotSpot, measured with the jars' classes): ElevatorMethods for the
  -- Forge generic source, ElevatorContactPeripheral for NeoForge. CC 1.121 puts them into a HashMap.
  local DECL = mc == "1.21.1"
      and { "getState", "getOffset", "callToFloor", "getNearestFloor", "getSpeed", "getTargetY", "callToY", "listFloors",
        "getCabY", "isMoving", "getRole" }
      or { "getNearestFloor", "callToFloor", "getTargetY", "isMoving", "getCabY", "callToY", "getRole", "listFloors",
        "getSpeed", "getState", "getOffset" }

  local function newPeripheral(def)
    local at = contactOf[def.name]
    if not at then
      local col = getColumn(columnIdOf(def))
      local c = newContact(contactSpec(def), C.toInt(tonumber(def.y) or 0))
      if not addContact(col, c) then c = findContact(col, c.y); c.peripheral = def.name end
      if isBlank(c.shortName) then initNames(col) end
      at = { col = col, contact = c }
      contactOf[def.name] = at
    end
    local col, me = at.col, at.contact
    local m = {}

    function m.getRole() return "contact" end

    function m.listFloors()
      requireColumn(col)
      local out = {}
      local targetY = columnTarget(col)
      local current = findCurrentFloorContact(col)
      for i, c in ipairs(col.contacts) do
        local row = {}
        row.y = c.y
        row.shortName = c.shortName
        row.longName = c.longName
        row.name = bestFloorName(c)
        row.currentFloorName = nonBlank(c.lastReported)
        row.isTarget = targetY ~= nil and targetY == c.y
        row.isCurrent = current ~= nil and current == c
        out[i] = row
      end
      return out
    end

    function m.getState()
      requireColumn(col)
      local pulley = resolvePulley(col)
      local currentFloor = findCurrentFloorContact(col)
      local speed = pulley and pulley.movementSpeed() or 0.0
      local offset = pulley and pulley.offset or nil
      local cabY = pulley and pulley.cabY() or nil
      local currentTargetY = pulley and pulley.currentTargetY() or nil
      local columnTargetY = columnTarget(col)
      local targetY = currentTargetY ~= nil and currentTargetY or columnTargetY
      if cabY == nil and currentFloor ~= nil then cabY = currentFloor.y end
      local moving
      if pulley then
        moving = abs(speed) > 1.0E-4
      else
        moving = targetY ~= nil and currentFloor ~= nil and targetY ~= currentFloor.y
      end
      return {
        modName = "CC:LiftLink",
        role = "contact",
        active = col.active,
        targetAvailable = col.targetAvailable,
        targetY = targetY,
        currentTargetY = currentTargetY,
        speed = speed,
        offset = offset,
        cabY = cabY,
        moving = moving,
        floorCount = #col.contacts,
        blockX = col.x,
        blockY = me.y,
        blockZ = col.z,
        hasPulley = pulley ~= nil,
        trackingMode = pulley ~= nil and "live_pulley" or "single_contact",
        currentFloorName = currentFloor and bestFloorName(currentFloor) or nil,
        currentFloorY = currentFloor and currentFloor.y or nil,
      }
    end

    function m.getCabY()
      requireColumn(col)
      local pulley = resolvePulley(col)
      local live = pulley and pulley.cabY() or nil
      if live ~= nil then return live end
      local current = findCurrentFloorContact(col)
      if current ~= nil then return current.y end
      return nil
    end

    function m.getSpeed()
      local pulley = resolvePulley(col)
      if pulley == nil then return 0.0 end
      return pulley.movementSpeed()
    end

    function m.getOffset()
      local pulley = resolvePulley(col)
      if pulley == nil then return nil end
      return pulley.offset
    end

    function m.getTargetY()
      requireColumn(col)
      local pulley = resolvePulley(col)
      local live = pulley and pulley.currentTargetY() or nil
      if live ~= nil then return live end
      return columnTarget(col)
    end

    function m.isMoving()
      local pulley = resolvePulley(col)
      if pulley ~= nil then return abs(pulley.movementSpeed()) > F_EPS end
      requireColumn(col)
      local targetY = columnTarget(col)
      local current = findCurrentFloorContact(col)
      return targetY ~= nil and current ~= nil and targetY ~= current.y
    end

    function m.callToY(y)
      y = argInt(1, y)
      requireColumn(col)
      local target = findContact(col, y)
      if target ~= nil then
        callToContact(col, target, false)
        return true
      end
      local pulley = resolvePulley(col)
      if pulley ~= nil and pulley.assembled and not pulley.unreachable(y) then
        col.targetY = y
        col.targetAvailable = true
        return true
      end
      error(("Y=%d is not a real floor and is outside the elevator travel range"):format(y), 0)
    end

    function m.callToFloor(floorName)
      floorName = argString(1, floorName)
      requireColumn(col)
      local wanted = trim(floorName)
      local target = nil
      for _, c in ipairs(col.contacts) do
        if eqIgnoreCase(wanted, c.shortName) or eqIgnoreCase(wanted, c.longName) then
          target = c
          break
        end
      end
      if target == nil then error("No floor named '" .. floorName .. "'", 0) end
      callToContact(col, target, false)
      return true
    end

    function m.getNearestFloor()
      requireColumn(col)
      local pulley = resolvePulley(col)
      local cabY = pulley and pulley.cabY() or nil
      local best = findBestContactForCabY(col, cabY)
      if best == nil then best = findCurrentFloorContact(col) end
      if best == nil then return nil end
      return {
        y = best.y,
        shortName = best.shortName,
        longName = best.longName,
        name = bestFloorName(best),
        distance = cabY == nil and 0.0 or abs(best.y - cabY),
      }
    end

    local state = function()
      create.catchUp()
      return {
        column = col.id, y = me.y, shortName = me.shortName, longName = me.longName,
        currentFloor = me.lastReported, calling = me.calling,
      }
    end
    return {
      methods = m,
      methodOrder = C.hashMapOrder(DECL),
      computerThread = {}, -- every method is @LuaFunction(mainThread = true)
      exactReturns = true,
      state = state,
    }
  end

  function M.peripheral(def) return newPeripheral(def) end
  function M.catchUp() create.catchUp() end

  function M.state()
    create.catchUp()
    local out = {}
    for _, id in ipairs(columnOrder) do
      local col = columns[id]
      local contacts = {}
      for i, c in ipairs(col.contacts) do
        contacts[i] = { y = c.y, shortName = c.shortName, longName = c.longName, currentFloor = c.lastReported,
          calling = c.calling, powered = c.powered, peripheral = c.peripheral }
      end
      local p = col.pulley
      out[id] = {
        x = col.x, z = col.z, facing = col.facing, active = col.active,
        targetAvailable = col.targetAvailable, targetY = col.targetY, contacts = contacts,
        pulley = p and {
          y = p.y, assembled = p.assembled, offset = p.offset, cabY = p.cabY(), speed = p.prevSpeed,
          arrived = p.arrived, rpm = p.kineticSpeed(), restY = p.restY, minContactY = p.minContactY,
          maxContactY = p.maxContactY,
        } or nil,
      }
    end
    return { columns = out }
  end

  -- ===== sim commands =====

  local function findColumn(cmd)
    local col = columns[tostring(cmd.column)]
    if not col then return nil, "no elevator column named " .. tostring(cmd.column) end
    return col
  end
  local function needPulley(cmd)
    local col, err = findColumn(cmd)
    if not col then return nil, err end
    if not col.pulley then return nil, "column " .. col.id .. " has no elevator pulley" end
    return col
  end

  local handlers = {}

  function handlers.liftlinkAssemble(cmd)
    create.catchUp()
    local col, err = needPulley(cmd)
    if not col then return false, err end
    return assemble(col)
  end

  function handlers.liftlinkDisassemble(cmd)
    create.catchUp()
    local col, err = needPulley(cmd)
    if not col then return false, err end
    return disassemble(col)
  end

  function handlers.liftlinkSetSpeed(cmd)
    create.catchUp()
    local col, err = needPulley(cmd)
    if not col then return false, err end
    local rpm = tonumber(cmd.rpm)
    if not rpm then return false, "rpm must be a number" end
    col.pulley.network = nil
    col.pulley.rpm = rpm
    return true
  end

  -- redstone into a contact: ElevatorContactBlock.neighborChanged
  function handlers.liftlinkPower(cmd)
    create.catchUp()
    local col, err = findColumn(cmd)
    if not col then return false, err end
    local c = findContact(col, C.toInt(tonumber(cmd.y) or 0))
    if not c then return false, "no contact at y=" .. tostring(cmd.y) .. " in column " .. col.id end
    local signal = cmd.powered ~= false
    if c.powered == signal then return true end
    local was = c.powered
    c.powered = signal
    if was then return true end
    if c.calling then return true end
    callToContact(col, c, true)
    return true
  end

  -- a player edits a contact's names (ElevatorContactEditPacket -> updateName)
  function handlers.liftlinkRename(cmd)
    create.catchUp()
    local col, err = findColumn(cmd)
    if not col then return false, err end
    local c = findContact(col, C.toInt(tonumber(cmd.y) or 0))
    if not c then return false, "no contact at y=" .. tostring(cmd.y) .. " in column " .. col.id end
    if cmd.shortName ~= nil then c.shortName = tostring(cmd.shortName) end
    if cmd.longName ~= nil then c.longName = tostring(cmd.longName) end
    return true
  end

  -- a contact placed (ElevatorContactBlockEntity.initialize: added, names generated on its first tick when blank)
  function handlers.liftlinkAddContact(cmd)
    create.catchUp()
    local col, err = findColumn(cmd)
    if not col then return false, err end
    local c = newContact(cmd, C.toInt(tonumber(cmd.y) or 0))
    if not addContact(col, c) then return false, "column " .. col.id .. " already has a contact at y=" .. c.y end
    if isBlank(c.shortName) then initNames(col) end
    return true
  end

  -- a contact broken (ElevatorContactBlockEntity.invalidate -> ElevatorColumn.remove)
  function handlers.liftlinkRemoveContact(cmd)
    create.catchUp()
    local col, err = findColumn(cmd)
    if not col then return false, err end
    local y = C.toInt(tonumber(cmd.y) or 0)
    for i, c in ipairs(col.contacts) do
      if c.y == y then
        if c.peripheral then return false, "the contact at y=" .. y .. " is peripheral " .. c.peripheral end
        table.remove(col.contacts, i)
        return true
      end
    end
    return false, "no contact at y=" .. y .. " in column " .. col.id
  end

  M.handlers = handlers
  return M
end
