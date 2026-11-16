-- ccsim create-additions: Create Crafts & Additions 1.0.0 and its five ComputerCraft peripherals.
--
-- Written from mrh0/createaddition on the 1.18.2 branch at e1af3a8 (5 Aug 2023, the day the pack's
-- createaddition-1.18.2-1.0.0.jar was built; the repository has no 1.0.0 tag) and checked against that jar with javap
-- (method names, signatures, every error string). Source files, relative to src/main/java/com/mrh0/createaddition/:
--   compat/computercraft/{Peripherals,Helpers,ElectricMotorPeripheral,ModularAccumulatorPeripheral,
--   PortableEnergyInterfacePeripheral,RedstoneRelayPeripheral,DigitalAdapterPeripheral};
--   blocks/electric_motor/ElectricMotorBlockEntity; blocks/modular_accumulator/ModularAccumulatorBlockEntity;
--   blocks/portable_energy_interface/PortableEnergyInterfaceBlockEntity; blocks/redstone_relay/RedstoneRelayBlockEntity;
--   blocks/digital_adapter/{DigitalAdapterBlockEntity,DigitalAdapterDisplaySource}; mixin/SpeedControllerTileEntityMixin;
--   config/Config (defaults, the same as the pack's createaddition-common.toml).
-- Create's side (kinetic networks, gauges, speed controllers, the clock) comes from ../create/init.lua.
-- docs/create-additions.md lists every behaviour with its source, and what is not simulated.
return function(core, host)
  local create = core.loadAddon("create")
  local C = create.C
  local floor, abs = math.floor, math.abs
  local cfg = core.world.createAdditions or {}
  local conf = cfg.config or {}
  local function num(key, default) return tonumber(conf[key]) or default end

  local FE_RPM = num("fe_at_max_rpm", 480)
  local MAX_STRESS = num("max_stress", 16384)
  local RPM_RANGE = num("motor_rpm_range", 256)
  local MIN_CONSUMPTION = num("motor_min_consumption", 8)
  local MOTOR_MAX_INPUT = num("motor_max_input", 5000)
  local MOTOR_CAPACITY = num("motor_capacity", 5000)
  local CONNECTOR_IN = num("small_connector_max_input", 1024)
  local CONNECTOR_OUT = num("small_connector_max_output", 1024)
  local ACC_IN = num("accumulator_max_input", 5000)
  local ACC_OUT = num("accumulator_max_output", 5000)
  local ACC_CAPACITY = num("accumulator_capacity", 2000000)
  local PEI_IN = num("pei_max_input", 5000)
  local PEI_OUT = num("pei_max_output", 5000)
  local MAX_LINES = 16 -- DigitalAdapterBlockEntity.MAX_LINES
  local MAX_RPM = tonumber(((core.world.create or {}).config or {}).maxRotationSpeed) or 256

  local M = {}
  local objects = {}

  local function clampRpm(rpm) return math.max(-RPM_RANGE, math.min(RPM_RANGE, rpm)) end

  -- ElectricMotorBlockEntity.getEnergyConsumptionRate
  local function consumption(rpm)
    if abs(rpm) == 0 then return 0 end
    return C.toInt(math.max(FE_RPM * (abs(rpm) / 256), MIN_CONSUMPTION))
  end

  -- ElectricMotorBlockEntity.getDurationAngle / getDurationDistance, in ticks
  local function durationAngle(deg, speed)
    speed, deg = abs(speed), abs(deg)
    if speed < 0.1 then return 0 end
    return C.toInt(deg / ((speed * 360) / 60 / 20) + 1)
  end
  local function durationDistance(dis, speed)
    speed, dis = abs(speed), abs(dis)
    if speed < 0.1 then return 0 end
    return C.toInt(dis / (speed / 512))
  end

  -- ===== electric motor =====

  local function newMotor(def)
    local o = { kind = "electric_motor", def = def }
    o.value = clampRpm(C.toInt(tonumber(def.rpm) or 32)) -- generatedSpeed, 32 by default
    o.ccRpm = o.value -- cc_new_rpm: what getSpeed answers
    o.pending = false -- cc_update_rpm
    o.antiSpam = 5 -- set by every lazy tick (every 20 ticks, and the first)
    o.lazyCounter = 20
    o.energy = math.min(tonumber(def.energy) or 0, MOTOR_CAPACITY)
    o.input = tonumber(def.input) or 0 -- FE/t offered by whatever feeds it
    o.powered = def.powered == true -- redstone stops the motor
    o.active = def.active
    if o.active == nil then o.active = false end
    function o.setRPM(rpm)
      o.ccRpm = clampRpm(rpm)
      o.pending = true
      return o.antiSpam > 0
    end
    function o.outputSpeed() return o.active and o.value or 0 end
    function o.capacityPerRpm() return C.float(MAX_STRESS / 256) end
    function o.tick()
      local e, a, v = o.energy, o.active, o.value
      if o.input > 0 then o.energy = o.energy + math.max(0, math.min(o.input, MOTOR_MAX_INPUT, MOTOR_CAPACITY - o.energy)) end
      local old = o.lazyCounter -- SmartBlockEntity.tick: lazyTick when the counter runs out
      o.lazyCounter = old - 1
      if old <= 0 then
        o.lazyCounter = 20
        o.antiSpam = 5
      end
      if o.pending and o.antiSpam > 0 then
        o.value = o.ccRpm
        o.pending = false
        o.antiSpam = o.antiSpam - 1
      end
      local con = consumption(o.value)
      if not o.active then
        if o.energy > con * 2 and not o.powered then o.active = true end
      else
        local ext = math.min(con, o.energy)
        o.energy = o.energy - ext
        if ext < con or o.powered then o.active = false end
      end
      return o.energy ~= e or o.active ~= a or o.value ~= v
    end
    function o.busy() return o.pending end
    function o.skip(n)
      if n <= o.lazyCounter then
        o.lazyCounter = o.lazyCounter - n
      else
        local left = n - (o.lazyCounter + 1)
        o.antiSpam = 5
        o.lazyCounter = 20 - (left % 21)
      end
    end
    return o
  end

  -- ===== modular accumulator =====

  local function newAccumulator(def)
    local o = { kind = "modular_accumulator", def = def }
    o.width = math.max(1, math.min(num("accumulator_max_width", 3), tonumber(def.width) or 1))
    o.height = math.max(1, math.min(num("accumulator_max_height", 5), tonumber(def.height) or 1))
    o.capacity = o.width * o.width * o.height * ACC_CAPACITY
    o.energy = math.min(tonumber(def.energy) or 0, o.capacity)
    o.input = tonumber(def.input) or 0
    o.output = tonumber(def.output) or 0
    function o.tick()
      local e = o.energy
      o.energy = o.energy + math.max(0, math.min(o.input, ACC_IN, o.capacity - o.energy))
      o.energy = o.energy - math.max(0, math.min(o.output, ACC_OUT, o.energy))
      return o.energy ~= e
    end
    return o
  end

  -- ===== portable energy interface =====

  local function newPEI(def)
    local o = { kind = "portable_energy_interface", def = def }
    local c = def.contraption
    o.connected = def.connected == true or c ~= nil
    o.energy = tonumber(c and c.energy) or 0
    o.capacity = tonumber(c and c.capacity) or 0
    o.input = tonumber(def.input) or 0 -- FE/t pushed in, while connected
    o.output = tonumber(def.output) or 0 -- FE/t pulled out, while connected
    function o.tick()
      if not o.connected then return false end
      local e = o.energy
      o.energy = o.energy + math.max(0, math.min(o.input, PEI_IN, o.capacity - o.energy))
      o.energy = o.energy - math.max(0, math.min(o.output, PEI_OUT, o.energy))
      return o.energy ~= e
    end
    return o
  end

  -- ===== redstone relay =====

  local function newRelay(def)
    local o = { kind = "redstone_relay", def = def }
    o.powered = def.powered == true
    o.supply = tonumber(def.supply) or 0 -- FE/t the input network can give
    o.demand = tonumber(def.demand) or 0 -- FE/t the output network wants
    o.lastDemand = 0 -- what was asked last tick (RedstoneRelayBlockEntity.demand)
    o.throughput = 0
    function o.tick()
      local before, d = o.throughput, o.lastDemand
      o.throughput = 0
      if o.powered then
        o.throughput = math.min(o.supply, o.lastDemand)
        o.lastDemand = o.demand
      end
      return o.throughput ~= before or o.lastDemand ~= d
    end
    return o
  end

  -- ===== digital adapter =====

  local DIRS = { north = true, south = true, east = true, west = true, up = true, down = true }

  -- Helpers.nameToDir: exact names, anything else (north included) is NORTH
  local function nameToDir(name)
    if name == "down" or name == "bottom" then return "down" end
    if name == "up" or name == "top" then return "up" end
    if name == "south" or name == "east" or name == "west" then return name end
    return "north"
  end

  local function newSide(spec)
    if type(spec) == "string" then return { ref = spec } end
    local kind = spec.kind
    if kind == "speed_controller" then return { obj = create.newSpeedController(spec) } end
    if kind == "speedometer" then return { obj = create.newSpeedometer(spec) } end
    if kind == "stressometer" then return { obj = create.newStressometer(spec) } end
    if kind == "piston" or kind == "pulley" or kind == "hose_pulley" or kind == "elevator_pulley" or kind == "bearing" then
      local s = {
        kind = kind, offset = tonumber(spec.offset) or 0, angle = tonumber(spec.angle) or 0,
        rpm = tonumber(spec.rpm) or 0, running = spec.running, floors = C.deepCopy(spec.floors or {}),
        targetY = tonumber(spec.targetY), assembled = spec.assembled ~= false,
      }
      if s.running == nil then s.running = s.rpm ~= 0 end
      if kind == "elevator_pulley" and s.targetY == nil and s.floors[1] then s.targetY = s.floors[1].y end
      s.since = create.clock.currentTick()
      return { contraption = s }
    end
    error("ccsim: unknown digital adapter neighbour kind '" .. tostring(kind) .. "'", 0)
  end

  local function bearingAngle(s, partial)
    if not s.running then return s.angle end
    local w = C.float(s.rpm * 3 / 10) -- convertToAngular
    local t = create.clock.currentTick() - 1 - s.since
    local angle = math.fmod(s.angle + w * math.max(0, t), 360)
    return angle + partial * w
  end

  local function newAdapter(def)
    local o = { kind = "digital_adapter", def = def, textLines = {}, line = 1, sides = {} }
    for i = 1, MAX_LINES do o.textLines[i] = "" end
    for dir, spec in pairs(def.sides or {}) do
      if not DIRS[dir] then error("ccsim: digital adapter side '" .. tostring(dir) .. "' is not a direction", 0) end
      o.sides[dir] = newSide(spec)
    end
    function o.neighbour(dir)
      local s = o.sides[dir]
      if not s then return nil end
      if s.ref then return create.find(s.ref) end
      return s.obj or s.contraption
    end
    function o.setTextLine(ln, text)
      if ln < 1 or ln > MAX_LINES then return end
      o.textLines[ln] = text
    end
    return o
  end

  -- ===== peripherals =====

  local TYPES = {}

  TYPES.electric_motor = function(o)
    local m = {}
    function m.getType() return "electric_motor" end
    local function getSpeed() return o.ccRpm end
    local function setSpeed(rpm)
      if rpm == getSpeed() then return end
      if not o.setRPM(rpm) then error("Speed is set too many times per second (Anti Spam).", 0) end
    end
    function m.setSpeed(rpm) setSpeed(C.int(1, rpm)) end
    function m.stop() setSpeed(0) end
    function m.getSpeed() return getSpeed() end
    function m.getStressCapacity() return C.toInt(MAX_STRESS / 256) end
    function m.getEnergyConsumption() return consumption(o.value) end
    function m.rotate(deg, rpm)
      deg, rpm = C.int(1, deg), C.optInt(2, rpm)
      local r = rpm or getSpeed()
      if rpm then setSpeed(deg < 0 and -r or r) end
      return C.float(durationAngle(deg, r) / 20)
    end
    function m.translate(blocks, rpm)
      blocks, rpm = C.int(1, blocks), C.optInt(2, rpm)
      local r = rpm or getSpeed()
      if rpm then setSpeed(blocks < 0 and -r or r) end
      return C.float(durationDistance(blocks, r) / 20)
    end
    function m.getMaxInsert() return MOTOR_MAX_INPUT end
    function m.getMaxExtract() return 0 end
    return m, { "getType", "setSpeed", "stop", "getSpeed", "getStressCapacity", "getEnergyConsumption", "rotate",
      "translate", "getMaxInsert", "getMaxExtract" }, { getType = true }
  end

  TYPES.modular_accumulator = function(o)
    return {
      getEnergy = function() return o.energy end,
      getCapacity = function() return o.capacity end,
      getPercent = function() return C.float(C.float(o.energy / o.capacity) * 100) end,
      getMaxInsert = function() return ACC_IN end,
      getMaxExtract = function() return ACC_OUT end,
      getHeight = function() return o.height end,
      getWidth = function() return o.width end,
    }, { "getEnergy", "getCapacity", "getPercent", "getMaxInsert", "getMaxExtract", "getHeight", "getWidth" }, {}
  end

  TYPES.portable_energy_interface = function(o)
    return {
      getEnergy = function() return o.connected and o.energy or 0 end,
      getCapacity = function() return o.connected and o.capacity or 0 end,
      isConnected = function() return o.connected end,
      getMaxInsert = function() return PEI_IN end,
      getMaxExtract = function() return PEI_OUT end,
    }, { "getEnergy", "getCapacity", "isConnected", "getMaxInsert", "getMaxExtract" }, {}
  end

  TYPES.redstone_relay = function(o)
    return {
      getMaxInsert = function() return CONNECTOR_IN end,
      getMaxExtract = function() return CONNECTOR_OUT end,
      getThroughput = function() return o.throughput end,
      isPowered = function() return o.powered end,
    }, { "getMaxInsert", "getMaxExtract", "getThroughput", "isPowered" }, {}
  end

  TYPES.digital_adapter = function(o)
    local m = {}
    local function side(dir, kind)
      local n = o.neighbour(nameToDir(dir))
      if n and n.kind == kind then return n end
      return nil
    end
    local function contraption(dir, kind)
      local n = o.neighbour(nameToDir(dir))
      if n and n.kind == kind and n.assembled ~= false then return n end
      return nil
    end
    function m.clearLine() o.setTextLine(o.line, "") end
    function m.clear()
      for i = 1, MAX_LINES do o.setTextLine(i, "") end
    end
    function m.print(text)
      text = C.str(1, text)
      o.setTextLine(o.line, text:sub(1, 128))
      o.line = math.min(o.line + 1, MAX_LINES)
    end
    function m.getLine() return o.line end
    function m.setLine(ln)
      ln = C.int(1, ln)
      if not (ln < 1 or ln > MAX_LINES) then o.line = ln end
      return o.line
    end
    function m.getMaxLines() return MAX_LINES end
    function m.setTargetSpeed(dir, speed)
      dir, speed = C.str(1, dir), C.int(2, speed)
      local c = side(dir, "Create_RotationSpeedController")
      if c then c.setTarget(speed) end
    end
    function m.getTargetSpeed(dir)
      local c = side(C.str(1, dir), "Create_RotationSpeedController")
      return c and c.target or 0
    end
    function m.getKineticStress(dir)
      local g = side(C.str(1, dir), "Create_Stressometer")
      if not g then return 0 end
      local s = g.get()
      return C.toInt(C.float(s))
    end
    function m.getKineticCapacity(dir)
      local g = side(C.str(1, dir), "Create_Stressometer")
      if not g then return 0 end
      local _, c = g.get()
      return C.toInt(C.float(c))
    end
    function m.getKineticSpeed(dir)
      local g = side(C.str(1, dir), "Create_Speedometer")
      return g and C.toInt(C.float(g.getSpeed())) or 0
    end
    function m.getKineticTopSpeed() return MAX_RPM end
    function m.getPulleyDistance(dir)
      dir = C.str(1, dir)
      local n = o.neighbour(nameToDir(dir))
      if n and (n.kind == "pulley" or n.kind == "hose_pulley" or n.kind == "elevator_pulley") then
        return C.toInt(n.offset)
      end
      return 0
    end
    function m.getPistonDistance(dir)
      local n = side(C.str(1, dir), "piston")
      return n and C.toInt(n.offset) or 0
    end
    function m.getBearingAngle(dir)
      local n = side(C.str(1, dir), "bearing")
      return n and C.toInt(bearingAngle(n, 0.5)) or 0
    end
    function m.getElevatorFloor(dir)
      local e = contraption(C.str(1, dir), "elevator_pulley")
      if not e then return 0 end
      for i, f in ipairs(e.floors) do
        if f.y == e.targetY then return i - 1 end
      end
      return 0
    end
    function m.getElevatorFloors(dir)
      local e = contraption(C.str(1, dir), "elevator_pulley")
      return e and #e.floors or 0
    end
    function m.getElevatorFloorName(dir, index)
      dir, index = C.str(1, dir), C.int(2, index)
      local e = contraption(dir, "elevator_pulley")
      if not e or index >= #e.floors or index < 0 then return tostring(index) end
      return e.floors[index + 1].name or ""
    end
    function m.gotoElevatorFloor(dir, index)
      dir, index = C.str(1, dir), C.int(2, index)
      local e = contraption(dir, "elevator_pulley")
      if not e or index >= #e.floors or index < 0 then return 0 end
      local old = e.targetY or 0
      local y = e.floors[index + 1].y
      if e.floors[index + 1].reachable ~= false then e.targetY = y end
      return y - old
    end
    function m.getDurationAngle(deg, rpm)
      deg, rpm = C.int(1, deg), C.int(2, rpm)
      return C.float(durationAngle(deg, rpm) / 20)
    end
    function m.getDurationDistance(blocks, rpm)
      blocks, rpm = C.int(1, blocks), C.int(2, rpm)
      return C.float(durationDistance(blocks, rpm) / 20)
    end
    return m, { "clearLine", "clear", "print", "getLine", "setLine", "getMaxLines", "setTargetSpeed", "getTargetSpeed",
      "getKineticStress", "getKineticCapacity", "getKineticSpeed", "getKineticTopSpeed", "getPulleyDistance",
      "getPistonDistance", "getBearingAngle", "getElevatorFloor", "getElevatorFloors", "getElevatorFloorName",
      "gotoElevatorFloor", "getDurationAngle", "getDurationDistance" }, {}
  end

  local CONSTRUCT = {
    electric_motor = newMotor,
    modular_accumulator = newAccumulator,
    portable_energy_interface = newPEI,
    redstone_relay = newRelay,
    digital_adapter = newAdapter,
  }

  local function state(o)
    if o.kind == "electric_motor" then
      return { rpm = o.value, ccRpm = o.ccRpm, active = o.active, energy = o.energy, capacity = MOTOR_CAPACITY,
        consumption = consumption(o.value), input = o.input, powered = o.powered, pending = o.pending,
        antiSpam = o.antiSpam, outputSpeed = o.outputSpeed() }
    end
    if o.kind == "modular_accumulator" then
      return { energy = o.energy, capacity = o.capacity, width = o.width, height = o.height, input = o.input,
        output = o.output }
    end
    if o.kind == "portable_energy_interface" then
      return { connected = o.connected, energy = o.energy, capacity = o.capacity }
    end
    if o.kind == "redstone_relay" then
      return { powered = o.powered, throughput = o.throughput, supply = o.supply, demand = o.demand }
    end
    local sides = {}
    for dir, s in pairs(o.sides) do
      local c = s.contraption
      if c then
        sides[dir] = { kind = c.kind, offset = c.offset, angle = c.kind == "bearing" and bearingAngle(c, 0) or nil,
          targetY = c.targetY }
      else
        sides[dir] = { ref = s.ref, kind = s.obj and s.obj.kind or nil }
      end
    end
    return { lines = C.deepCopy(o.textLines), line = o.line, sides = sides }
  end

  function M.peripheral(def)
    local o = CONSTRUCT[def.type](def)
    objects[def.name] = o
    create.register(def.name, o)
    if o.tick then create.addTicker(o) end
    local methods, decl, computer = TYPES[def.type](o)
    return {
      methods = methods,
      methodOrder = C.hashMapOrder(decl),
      computerThread = computer,
      exactReturns = true, -- every method returns exactly what its Java does (all are void or a non-null value)
      state = function() create.catchUp() return state(o) end,
    }
  end

  function M.catchUp() create.catchUp() end

  -- ===== sim commands =====

  local function find(cmd, kinds)
    local o = objects[cmd.peripheral]
    if not o then return nil, "no Create Crafts & Additions block named " .. tostring(cmd.peripheral) end
    if kinds and not kinds[o.kind] then return nil, tostring(cmd.peripheral) .. " is a " .. o.kind end
    return o
  end

  local handlers = {}

  function handlers.caSetEnergy(cmd)
    create.catchUp()
    local o, err = find(cmd, { electric_motor = true, modular_accumulator = true, portable_energy_interface = true })
    if not o then return false, err end
    local cap = o.kind == "electric_motor" and MOTOR_CAPACITY or o.capacity
    o.energy = math.max(0, math.min(cap, tonumber(cmd.energy) or 0))
    return true
  end

  function handlers.caSetEnergyInput(cmd)
    create.catchUp()
    local o, err = find(cmd, { electric_motor = true, modular_accumulator = true, portable_energy_interface = true })
    if not o then return false, err end
    o.input = tonumber(cmd.rate) or 0
    return true
  end

  function handlers.caSetEnergyOutput(cmd)
    create.catchUp()
    local o, err = find(cmd, { modular_accumulator = true, portable_energy_interface = true })
    if not o then return false, err end
    o.output = tonumber(cmd.rate) or 0
    return true
  end

  function handlers.caSetRedstone(cmd)
    create.catchUp()
    local o, err = find(cmd, { electric_motor = true, redstone_relay = true })
    if not o then return false, err end
    o.powered = cmd.powered == true
    return true
  end

  function handlers.caSetRelayFlow(cmd)
    create.catchUp()
    local o, err = find(cmd, { redstone_relay = true })
    if not o then return false, err end
    if cmd.supply ~= nil then o.supply = tonumber(cmd.supply) or 0 end
    if cmd.demand ~= nil then o.demand = tonumber(cmd.demand) or 0 end
    return true
  end

  function handlers.caConnectContraption(cmd)
    create.catchUp()
    local o, err = find(cmd, { portable_energy_interface = true })
    if not o then return false, err end
    o.connected = true
    if cmd.energy ~= nil then o.energy = tonumber(cmd.energy) or 0 end
    if cmd.capacity ~= nil then o.capacity = tonumber(cmd.capacity) or 0 end
    return true
  end

  function handlers.caDisconnectContraption(cmd)
    create.catchUp()
    local o, err = find(cmd, { portable_energy_interface = true })
    if not o then return false, err end
    o.connected = false
    return true
  end

  function handlers.caSetContraption(cmd)
    create.catchUp()
    local o, err = find(cmd, { digital_adapter = true })
    if not o then return false, err end
    local s = o.sides[tostring(cmd.side)]
    local c = s and s.contraption
    if not c then return false, "no piston, bearing or pulley on side " .. tostring(cmd.side) end
    if c.kind == "bearing" then
      c.angle = bearingAngle(c, 0)
      c.since = create.clock.currentTick() - 1
    end
    if cmd.offset ~= nil then c.offset = tonumber(cmd.offset) or 0 end
    if cmd.angle ~= nil then c.angle = tonumber(cmd.angle) or 0 end
    if cmd.rpm ~= nil then c.rpm = tonumber(cmd.rpm) or 0 end
    if cmd.running ~= nil then c.running = cmd.running == true end
    if cmd.targetY ~= nil then c.targetY = tonumber(cmd.targetY) end
    if cmd.assembled ~= nil then c.assembled = cmd.assembled == true end
    return true
  end

  M.handlers = handlers
  return M
end
