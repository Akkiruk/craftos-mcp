-- ccsim create: Create 0.5.1.i and its six ComputerCraft peripherals.
--
-- Written from Create's source on the mc1.18/dev branch at 2828c88 (8 Oct 2024, the build the pack's
-- create-1.18.2-0.5.1.i.jar was made from; the repository has no 0.5.1.i tag) and checked against that jar with javap
-- (method names, signatures, every error string). Source files, relative to src/main/java/com/simibubi/create/:
--   compat/computercraft/implementation/peripherals/{DisplayLink,SequencedGearshift,SpeedController,SpeedGauge,
--   StressGauge,Station,Synced}Peripheral, .../implementation/{ComputerBehaviour,CreateLuaTable};
--   content/redstone/displayLink/{DisplayLinkBlockEntity, source/DisplaySource, source/ComputerDisplaySource,
--   target/{DisplayBoardTarget,SignDisplayTarget,LecternDisplayTarget,NixieTubeDisplayTarget,SingleLineDisplayTarget}};
--   content/kinetics/transmission/sequencer/{SequencedGearshiftBlockEntity,Instruction,SequencerInstructions,
--   InstructionSpeedModifiers}; content/kinetics/speedController/SpeedControllerBlockEntity;
--   content/kinetics/gauge/{SpeedGauge,StressGauge}BlockEntity; content/kinetics/base/KineticBlockEntity;
--   foundation/blockEntity/behaviour/scrollValue/ScrollValueBehaviour; foundation/utility/StringHelper;
--   content/trains/station/{StationBlockEntity,GlobalStation}; content/trains/entity/Train;
--   content/trains/schedule/{Schedule,ScheduleEntry,ScheduleRuntime,destination/*,condition/*} (see trains.lua);
--   content/trains/display/FlapDisplayBlockEntity; infrastructure/config/{CKinetics,CTrains}.
-- docs/create.md lists every behaviour with its source, and what is not simulated.
--
-- The world is a fixture (`world.create` and the peripherals' own fields). The clock is the virtual clock: every
-- 50 ms is a server tick, and everything is caught up tick by tick before anything looks.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local floor, abs, ceil = math.floor, math.abs, math.ceil
  local cfg = core.world.create or {}
  local conf = cfg.config or {}
  local MAX_RPM = tonumber(conf.maxRotationSpeed) or 256 -- CKinetics.maxRotationSpeed

  local M = { C = C }
  local byName = {} -- peripheral (or fixture object) name -> sim object
  local tickers = {} -- objects with tick(t) -> changed, busy() and skip(from, to)

  -- ===== the clock =====

  local bootMs = core.nowMs()
  local startTick = tonumber(cfg.gameTime) or 0
  local lastTick = startTick - 1
  local env = core.world.environment or {}
  local dayStart = tonumber(cfg.dayTime) or tonumber(env.time) or 0
  local function currentTick() return startTick + floor((core.nowMs() - bootMs) / 50) end
  local clock = {
    currentTick = currentTick,
    dayTime = function(t) return dayStart + (t - startTick) end,
  }
  M.clock = clock

  local T = dofile("/rom/ccsim/addons/create/trains.lua")(core, host, C, clock)
  M.trains = T

  function M.register(name, obj) byName[name] = obj end
  function M.find(name) return byName[name] end
  function M.addTicker(obj) tickers[#tickers + 1] = obj end

  -- ===== kinetics =====
  -- A network is a fixture: `world.create.networks[id] = { speed, capacity, stress, impact, source }`. `source` names
  -- the block that drives it (a speed controller, a sequenced gearshift, an electric motor); without one the network
  -- turns at `speed`. Stress is `stress` + `impact` (SU per RPM) x |speed|; capacity is `capacity` plus what a
  -- driving motor adds per RPM. Over capacity, the network is overstressed and every block on it reads speed 0.

  local networks = {}
  for id, n in pairs(cfg.networks or {}) do
    networks[tostring(id)] = {
      speed = tonumber(n.speed) or 0, capacity = tonumber(n.capacity) or 0, stress = tonumber(n.stress) or 0,
      impact = tonumber(n.impact) or 0, source = n.source,
    }
  end
  M.networks = networks

  local K = {}
  M.kinetics = K

  local function driver(net)
    return net.source and byName[net.source] or nil
  end

  function K.theoretical(id, depth)
    depth = depth or 0
    local net = id and networks[id]
    if not net or depth > 16 then return 0 end
    if net.source then
      local d = driver(net)
      return d and d.outputSpeed and d.outputSpeed(depth + 1) or 0
    end
    return net.speed
  end

  function K.stats(id, depth)
    local net = id and networks[id]
    if not net then return { speed = 0, stress = 0, capacity = 0, overstressed = false, effective = 0 } end
    local s = K.theoretical(id, depth)
    local d = driver(net)
    local capacity = net.capacity + ((d and d.capacityPerRpm) and d.capacityPerRpm() * abs(s) or 0)
    local stress = net.stress + net.impact * abs(s)
    local over = stress > capacity
    return { speed = s, stress = stress, capacity = capacity, overstressed = over, effective = over and 0 or s }
  end

  function K.effective(id, depth) return K.stats(id, depth).effective end

  -- ===== small blocks =====

  local function order(list) return C.hashMapOrder(list) end

  local function newSpeedController(def)
    local o = { kind = "Create_RotationSpeedController", def = def, network = def.network }
    local initial = tonumber(def.targetSpeed) or 16 -- SpeedControllerBlockEntity.DEFAULT_SPEED
    o.target = math.max(-MAX_RPM, math.min(MAX_RPM, C.toInt(initial)))
    function o.setTarget(v) -- ScrollValueBehaviour.setValue clamps to the configured range
      o.target = math.max(-MAX_RPM, math.min(MAX_RPM, v))
    end
    function o.outputSpeed(depth)
      if o.target == 0 then return 0 end
      if K.effective(o.network, depth) == 0 then return 0 end
      return o.target
    end
    return o
  end
  M.newSpeedController = newSpeedController

  local function newSpeedometer(def)
    local o = { kind = "Create_Speedometer", def = def, network = def.network, speed = tonumber(def.speed) or 0 }
    function o.getSpeed()
      if o.network then return K.effective(o.network) end
      return o.speed
    end
    return o
  end
  M.newSpeedometer = newSpeedometer

  local function newStressometer(def)
    local o = {
      kind = "Create_Stressometer", def = def, network = def.network,
      stress = tonumber(def.stress) or 0, capacity = tonumber(def.capacity) or 0,
    }
    function o.get()
      if o.network then
        local s = K.stats(o.network)
        return s.stress, s.capacity
      end
      return o.stress, o.capacity
    end
    return o
  end
  M.newStressometer = newStressometer

  -- ===== sequenced gearshift (SequencedGearshiftBlockEntity, Instruction) =====

  local MODIFIERS = { [2] = 2, [1] = 1, [-1] = -1, [-2] = -2 } -- InstructionSpeedModifiers: FORWARD_FAST .. BACK_FAST

  local function overflowAdd(a, b)
    local r = a + b
    if r > 2147483647 then r = r - 4294967296 end
    return r
  end

  local function duration(instr, progress, speed)
    speed = abs(speed * instr.mod)
    local target = instr.value - progress
    local per = instr.kind == "angle" and C.float(speed * 3 / 10) or C.float(speed / 512)
    return overflowAdd(C.toInt(ceil(target / per)), 2)
  end

  local function tickProgress(instr, speed)
    if instr.kind == "angle" then return C.float(speed * 3 / 10) end
    return C.float(speed / 512)
  end

  local function newGearshift(def)
    local o = { kind = "Create_SequencedGearshift", def = def, network = def.network }
    o.instructions = nil
    o.current, o.duration, o.progress, o.timer = -1, -1, 0, 0
    o.lastSpeed = nil
    local function input() return K.stats(o.network) end
    local function instr(i) return o.instructions and o.instructions[i + 1] or nil end
    function o.run(index)
      local ins = instr(index)
      if not ins or ins.kind == "end" then
        o.current, o.duration, o.progress, o.timer = -1, -1, 0, 0
        return
      end
      o.duration = duration(ins, 0, input().speed)
      o.current, o.progress, o.timer = index, 0, 0
    end
    function o.start(kind, value, modifier)
      o.instructions = { { kind = kind, mod = MODIFIERS[modifier] or 1, value = value }, { kind = "end" } }
      o.run(0)
    end
    function o.idle() return o.current == -1 end
    function o.outputSpeed(depth)
      if o.current == -1 then return 0 end
      local ins = instr(o.current)
      return K.effective(o.network, depth) * (ins and ins.mod or 0)
    end
    function o.tick()
      local s = input()
      local speed = s.speed
      if o.lastSpeed == nil then o.lastSpeed = speed end
      if speed ~= o.lastSpeed then -- onSpeedChanged
        local prev = o.lastSpeed
        o.lastSpeed = speed
        if o.current ~= -1 and abs(prev) ~= abs(speed) then
          local ins = instr(o.current)
          if ins then
            if s.effective == 0 then o.run(-1) end
            o.duration = duration(ins, o.progress, speed)
            o.timer = 0
          end
        end
      end
      if o.current == -1 or o.duration < 0 then return false end
      if o.timer < o.duration then
        o.timer = o.timer + 1
        local ins = instr(o.current)
        if ins then o.progress = o.progress + tickProgress(ins, s.effective) end
        return true
      end
      o.run(o.current + 1)
      return true
    end
    function o.busy() return o.current ~= -1 and o.duration >= 0 end
    return o
  end

  -- ===== display link (DisplayLinkBlockEntity, DisplaySource, the targets) =====

  local function newTarget(spec)
    if spec == nil or spec == "none" then return nil end
    if type(spec) == "string" then spec = { type = spec } end
    local t = { type = spec.type or "display_board" }
    if t.type == "display_board" then
      t.width = tonumber(spec.width) or 1
      t.height = tonumber(spec.height) or 1
      t.network = spec.network
      t.speed = tonumber(spec.speed) or 16
      t.lines = {}
      for i = 1, t.height * 2 do t.lines[i] = "" end
      for i, l in ipairs(spec.lines or {}) do t.lines[i] = l end
    elseif t.type == "sign" then
      t.lines = { "", "", "", "" }
      for i, l in ipairs(spec.lines or {}) do t.lines[i] = l end
    elseif t.type == "lectern" then
      t.book = spec.book or "written" -- "written", "writable" or "none"
      t.pages = C.deepCopy(spec.pages or {})
    elseif t.type == "nixie_tube" then
      t.tubes = tonumber(spec.tubes) or 1
      t.text = spec.text or ""
    else
      error("ccsim: unknown display link target '" .. tostring(t.type) .. "'", 0)
    end
    return t
  end

  local function targetStats(t)
    if t.type == "display_board" then return t.height * 2, C.toInt((t.width * 16 - 2) / 3.5) end
    if t.type == "sign" then return 4, 15 end
    if t.type == "lectern" then return 50, 256 end
    return 1, t.tubes * 2
  end

  local function boardRunning(t)
    if t.network then return K.effective(t.network) ~= 0 end
    return t.speed ~= 0
  end

  local function newDisplayLink(def)
    local o = { kind = "Create_DisplayLink", def = def }
    o.list = C.deepCopy(def.lines or {}) -- sourceConfig "ComputerSourceList"
    o.stored = def.lines ~= nil
    o.cursorX, o.cursorY = 0, 0
    o.source = def.source or "computer" -- "computer", "none", or the name of a digital adapter
    o.target = newTarget(def.target)
    o.activeTarget = (not def.restarted) and o.target or nil -- not saved: unknown after a restart until an update
    o.powered = def.powered == true
    o.targetLine = math.max(0, (tonumber(def.line) or 1) - 1)
    o.refreshTicks = 0
    o.updates = 0

    local function provideText()
      if o.source == "computer" then
        local out = {}
        for i, l in ipairs(o.list) do out[i] = l end
        return out
      end
      local adapter = byName[o.source]
      if adapter and adapter.textLines then
        local out = {}
        for i = 1, 16 do out[i] = adapter.textLines[i] or "" end
        return out
      end
      return {}
    end

    function o.updateGatheredData()
      o.activeTarget = o.target
      if o.source == "none" or not o.target then return end
      local t = o.target
      local text = provideText()
      local line = o.targetLine
      if t.type == "display_board" then -- DisplayBoardTarget.acceptFlapText
        if not boardRunning(t) then return end
        local rows = #t.lines
        local i = 0
        while i + line < rows do
          t.lines[i + line + 1] = text[i + 1] or ""
          i = i + 1
        end
      else
        if #text == 0 then text = { "" } end -- DisplaySource.EMPTY
        if t.type == "sign" then
          for i = 0, #text - 1 do
            if i + line >= 4 then break end
            t.lines[i + line + 1] = text[i + 1]
          end
        elseif t.type == "lectern" then
          if t.book == "none" then return end
          if t.book == "writable" then t.book = "written" end -- signed "Printed Book" by "Data Gatherer"
          local i = 0
          while i - line < #text and i < 50 do
            if #t.pages <= i then
              t.pages[#t.pages + 1] = i < line and "" or text[i - line + 1]
            elseif i >= line then
              t.pages[i + 1] = text[i - line + 1]
            end
            i = i + 1
          end
        else
          t.text = text[1]
        end
      end
      o.updates = o.updates + 1
    end

    function o.tickSource()
      o.refreshTicks = 0
      if o.powered then return end
      o.updateGatheredData()
    end

    -- the computer source never refreshes by itself; a digital adapter refreshes every 100 ticks
    function o.tick()
      if o.source == "computer" or o.source == "none" or not byName[o.source] then return false end
      o.refreshTicks = o.refreshTicks + 1
      if o.refreshTicks < 100 then return true end
      o.tickSource()
      return true
    end
    function o.busy() return false end
    function o.skip(n)
      if o.source == "computer" or o.source == "none" or not byName[o.source] then return end
      local total = o.refreshTicks + n
      if total >= 100 and not o.powered then o.updateGatheredData() end
      o.refreshTicks = total % 100
    end
    return o
  end

  -- ===== peripherals =====

  local TYPES = {}

  TYPES.Create_Speedometer = function(def, o)
    return { getSpeed = function() return C.float(o.getSpeed()) end }, { "getSpeed" }, {}
  end

  TYPES.Create_Stressometer = function(def, o)
    return {
      getStress = function() local s = o.get() return C.float(s) end,
      getStressCapacity = function() local _, c = o.get() return C.float(c) end,
    }, { "getStress", "getStressCapacity" }, {}
  end

  TYPES.Create_RotationSpeedController = function(def, o)
    return {
      setTargetSpeed = function(speed) o.setTarget(C.int(1, speed)) end,
      getTargetSpeed = function() return o.target end,
    }, { "setTargetSpeed", "getTargetSpeed" }, { setTargetSpeed = true }
  end

  TYPES.Create_SequencedGearshift = function(def, o)
    local function runInstruction(kind, ...)
      local n = select("#", ...)
      local args = { ... }
      local modifier = n > 1 and C.int(2, args[2]) or 1
      o.instructions = {}
      o.start(kind, abs(C.int(1, args[1])), modifier)
    end
    return {
      rotate = function(...) runInstruction("angle", ...) end,
      move = function(...) runInstruction("distance", ...) end,
      isRunning = function() return not o.idle() end,
    }, { "rotate", "move", "isRunning" }, { rotate = true, move = true }
  end

  TYPES.Create_DisplayLink = function(def, o)
    local m = {}
    function m.setCursorPos(x, y)
      x, y = C.int(1, x), C.int(2, y)
      o.cursorX, o.cursorY = x - 1, y - 1
    end
    function m.getCursorPos() return o.cursorX + 1, o.cursorY + 1 end
    function m.getSize()
      if not o.activeTarget then
        C.java("java.lang.NullPointerException", 'Cannot invoke "com.simibubi.create.content.redstone.displayLink.target.DisplayTarget.provideStats(com.simibubi.create.content.redstone.displayLink.DisplayLinkContext)" because "this.blockEntity.activeTarget" is null')
      end
      return targetStats(o.activeTarget)
    end
    function m.isColor() return false end
    function m.isColour() return false end
    -- sourceConfig.getList hands back the stored list (changed in place) or, before the first put, a new one
    local function sourceList()
      if o.stored then return o.list end
      return {}
    end
    local function put(list)
      o.list = list
      o.stored = true
    end
    function m.write(text)
      text = C.str(1, text)
      local list = sourceList()
      local x, y = o.cursorX, o.cursorY
      for _ = #list, y do list[#list + 1] = "" end
      local line = (y >= 0 and list[y + 1]) or ""
      if x > #line then line = line .. string.rep(" ", x - #line) end
      -- StringBuilder.replace(x, x + len, text): end is clamped to the length, start must be in range
      local stop = math.min(x + #text, #line)
      if x < 0 or x > stop then
        C.java("java.lang.StringIndexOutOfBoundsException", ("start %d, end %d, length %d"):format(x, stop, #line))
      end
      line = line:sub(1, x) .. text .. line:sub(stop + 1)
      if y < 0 then
        C.java("java.lang.IndexOutOfBoundsException", ("Index %d out of bounds for length %d"):format(y, #list))
      end
      list[y + 1] = line
      put(list)
      o.cursorX = x + #text
    end
    function m.clearLine()
      local list = sourceList()
      if #list > o.cursorY then
        if o.cursorY < 0 then
          C.java("java.lang.IndexOutOfBoundsException", ("Index %d out of bounds for length %d"):format(o.cursorY, #list))
        end
        list[o.cursorY + 1] = ""
      end
      put(list)
    end
    function m.clear() put({}) end
    function m.update() o.tickSource() end
    return m, { "setCursorPos", "getCursorPos", "getSize", "isColor", "isColour", "write", "clearLine", "clear", "update" },
      { getSize = true, update = true }
  end

  local function stationOf(o)
    local st = o.st
    if not st.track then error("station is not connected to a track", 0) end
    return st
  end

  local function trainOrThrow(o)
    local st = stationOf(o)
    local tr = T.presentTrain(st)
    if not tr then error("there is no train present", 0) end
    return tr
  end

  TYPES.Create_Station = function(def, o)
    local m = {}
    function m.assemble()
      local st = o.st
      if not st.assembling then error("station must be in assembly mode", 0) end
      T.assemble(st)
      if not st.track or not T.presentTrain(st) then error("failed to assemble train", 0) end
      if not T.exitAssemblyMode(st) then error("failed to exit assembly mode", 0) end
    end
    function m.disassemble()
      if o.st.assembling then error("station must not be in assembly mode", 0) end
      trainOrThrow(o)
      if not T.enterAssemblyMode(o.st) then error("could not disassemble train", 0) end
    end
    function m.setAssemblyMode(mode)
      mode = C.bool(1, mode)
      if mode then
        if not T.enterAssemblyMode(o.st) then error("failed to enter assembly mode", 0) end
      else
        if not T.exitAssemblyMode(o.st) then error("failed to exit assembly mode", 0) end
      end
    end
    function m.isInAssemblyMode() return o.st.assembling end
    function m.getStationName() return stationOf(o).name end
    function m.setStationName(name)
      name = C.str(1, name)
      if not o.st.track then error("could not set station name", 0) end
      o.st.name = name
    end
    function m.isTrainPresent() return T.presentTrain(stationOf(o)) ~= nil end
    function m.isTrainImminent() return T.imminentTrain(stationOf(o)) ~= nil end
    function m.isTrainEnroute() return stationOf(o).nearest ~= nil end
    function m.getTrainName() return trainOrThrow(o).name end
    function m.setTrainName(name)
      local tr = trainOrThrow(o)
      tr.name = C.str(1, name)
    end
    function m.hasSchedule() return trainOrThrow(o).schedule ~= nil end
    function m.getSchedule()
      local tr = trainOrThrow(o)
      if not tr.schedule then error("train doesn't have a schedule", 0) end
      return T.fromNBT(nil, T.scheduleWrite(tr.schedule))
    end
    function m.setSchedule(...)
      local tbl = C.table(1, (...))
      if C.count(tbl) ~= 2 then error("Not a valid schedule", 0) end
      local entries = tbl.entries
      if type(entries) == "table" and next(entries) == nil then error("Schedule must have at least one entry", 0) end
      local tr = trainOrThrow(o)
      local tag = T.toNBT(nil, tbl)
      if tag.t ~= C.COMPOUND then
        C.java("java.lang.ClassCastException", "class net.minecraft.nbt.ListTag cannot be cast to class net.minecraft.nbt.CompoundTag")
      end
      local schedule = T.scheduleFromTag(tag)
      T.setSchedule(tr, schedule, tr.schedule == nil or tr.auto)
    end
    return m, { "assemble", "disassemble", "setAssemblyMode", "isInAssemblyMode", "getStationName", "setStationName",
      "isTrainPresent", "isTrainImminent", "isTrainEnroute", "getTrainName", "setTrainName", "hasSchedule",
      "getSchedule", "setSchedule" },
      { assemble = true, disassemble = true, setAssemblyMode = true, setStationName = true, setTrainName = true,
        setSchedule = true }
  end

  local CONSTRUCT = {
    Create_Speedometer = newSpeedometer,
    Create_Stressometer = newStressometer,
    Create_RotationSpeedController = newSpeedController,
    Create_SequencedGearshift = newGearshift,
    Create_DisplayLink = newDisplayLink,
    Create_Station = function(def)
      return { kind = "Create_Station", def = def, st = T.newStation({
        station = def.station, track = def.track, assembling = def.assembling, powered = def.powered,
        pending = def.pending, peripheral = def.name,
      }) }
    end,
  }

  -- ===== the clock: catch every block up to now =====

  local function tickAll(t)
    T.tick(t)
    local changed = false
    for _, o in ipairs(tickers) do
      if o.tick(t) then changed = true end
    end
    return changed
  end

  local function anyBusy()
    if T.busy() then return true end
    for _, o in ipairs(tickers) do
      if o.busy and o.busy() then return true end
    end
    return false
  end

  function M.catchUp()
    T.init()
    local target = currentTick() - 1
    while lastTick < target do
      local t = lastTick + 1
      local changed = tickAll(t)
      lastTick = t
      if t % 512 == 0 and core.serverWork then core.serverWork() end -- the server's work (mekanism-machines/engine.lua)
      if not changed and not anyBusy() and lastTick < target then
        -- nothing moves: jump, letting the blocks that count ticks catch up at once
        for _, o in ipairs(tickers) do
          if o.skip then o.skip(target - lastTick, lastTick, target) end
        end
        lastTick = target
      end
    end
  end

  function M.peripheral(def)
    local make = CONSTRUCT[def.type]
    local o = make(def)
    byName[def.name] = o
    if o.tick then tickers[#tickers + 1] = o end
    local methods, decl, mainThread = TYPES[def.type](def, o)
    local computerThread = {}
    for _, name in ipairs(decl) do
      if not mainThread[name] then computerThread[name] = true end
    end
    local p = { methods = methods, methodOrder = order(decl), computerThread = computerThread, sim = o,
      exactReturns = true } -- every method returns exactly what its Java does (all are void or a non-null value)
    function p.state()
      if o.kind == "Create_Speedometer" then return { speed = o.getSpeed(), network = o.network } end
      if o.kind == "Create_Stressometer" then
        local s, c = o.get()
        return { stress = s, capacity = c, network = o.network }
      end
      if o.kind == "Create_RotationSpeedController" then
        return { targetSpeed = o.target, outputSpeed = o.outputSpeed(0), network = o.network }
      end
      if o.kind == "Create_SequencedGearshift" then
        return { running = not o.idle(), instruction = o.current, timer = o.timer, duration = o.duration,
          progress = o.progress, outputSpeed = o.outputSpeed(0) }
      end
      if o.kind == "Create_DisplayLink" then
        local s = { lines = C.deepCopy(o.list), cursor = { o.cursorX + 1, o.cursorY + 1 }, powered = o.powered,
          source = o.source, updates = o.updates }
        if o.target then
          local t = o.target
          s.target = { type = t.type, lines = C.deepCopy(t.lines), pages = C.deepCopy(t.pages), book = t.book,
            text = t.text }
          s.target.rows, s.target.columns = targetStats(t)
        end
        return s
      end
      return T.stationState(o.st)
    end
    return p
  end

  -- ===== sim commands =====

  local function stationFor(name)
    local o = byName[name]
    if o and o.st then return o.st end
    return T.stationByName(name)
  end

  local function trainFor(cmd)
    local tr = T.trainByName(cmd.train)
    if not tr then return nil, "no train named " .. tostring(cmd.train) end
    return tr
  end

  local handlers = {}

  function handlers.createTrainArrive(cmd)
    M.catchUp()
    local st = stationFor(cmd.station)
    if not st then return false, "no station " .. tostring(cmd.station) end
    local tr = T.trainByName(cmd.train) or T.addTrain({ name = cmd.train })
    T.arriveAt(tr, st)
    return true
  end

  function handlers.createTrainLeave(cmd)
    M.catchUp()
    local tr, err = trainFor(cmd)
    if not tr then return false, err end
    T.depart(tr)
    return true
  end

  function handlers.createTrainApproach(cmd)
    M.catchUp()
    local st = stationFor(cmd.station)
    if not st then return false, "no station " .. tostring(cmd.station) end
    local tr = T.trainByName(cmd.train) or T.addTrain({ name = cmd.train })
    T.approach(tr, st, tonumber(cmd.distance))
    return true
  end

  function handlers.createAddTrain(cmd)
    M.catchUp()
    local ok, err = pcall(T.addTrain, cmd.train or cmd)
    if not ok then return false, tostring(err) end
    return true
  end

  function handlers.createRemoveTrain(cmd)
    M.catchUp()
    local tr, err = trainFor(cmd)
    if not tr then return false, err end
    T.removeTrain(tr)
    return true
  end

  function handlers.createSetCargo(cmd)
    M.catchUp()
    local tr, err = trainFor(cmd)
    if not tr then return false, err end
    T.setCargo(tr, cmd)
    return true
  end

  function handlers.createSetStationPowered(cmd)
    M.catchUp()
    local st = stationFor(cmd.station)
    if not st then return false, "no station " .. tostring(cmd.station) end
    st.powered = cmd.powered == true
    return true
  end

  function handlers.createSetAssemblyReady(cmd)
    M.catchUp()
    local st = stationFor(cmd.station)
    if not st then return false, "no station " .. tostring(cmd.station) end
    if cmd.ready == false then st.pending = nil else st.pending = { name = cmd.name } end
    return true
  end

  function handlers.createSetRedstoneLink(cmd)
    M.catchUp()
    T.setLink(cmd.first, cmd.second, cmd.powered ~= false)
    return true
  end

  function handlers.createSetSpeed(cmd)
    M.catchUp()
    local speed = tonumber(cmd.speed)
    if not speed then return false, "speed must be a number" end
    if cmd.network then
      local net = networks[tostring(cmd.network)]
      if not net then
        net = { speed = 0, capacity = 0, stress = 0, impact = 0 }
        networks[tostring(cmd.network)] = net
      end
      net.speed = speed
      return true
    end
    local o = byName[cmd.peripheral]
    if not o or o.kind ~= "Create_Speedometer" then return false, "not a speedometer: " .. tostring(cmd.peripheral) end
    o.speed = speed
    return true
  end

  function handlers.createSetStress(cmd)
    M.catchUp()
    if cmd.network then
      local net = networks[tostring(cmd.network)]
      if not net then return false, "no network " .. tostring(cmd.network) end
      for _, k in ipairs({ "stress", "capacity", "impact" }) do
        if cmd[k] ~= nil then net[k] = tonumber(cmd[k]) or 0 end
      end
      return true
    end
    local o = byName[cmd.peripheral]
    if not o or o.kind ~= "Create_Stressometer" then return false, "not a stressometer: " .. tostring(cmd.peripheral) end
    if cmd.stress ~= nil then o.stress = tonumber(cmd.stress) or 0 end
    if cmd.capacity ~= nil then o.capacity = tonumber(cmd.capacity) or 0 end
    return true
  end

  function handlers.createSetLinkPowered(cmd)
    M.catchUp()
    local o = byName[cmd.peripheral]
    if not o or o.kind ~= "Create_DisplayLink" then return false, "not a display link: " .. tostring(cmd.peripheral) end
    local was = o.powered
    o.powered = cmd.powered == true
    if was and not o.powered and o.source ~= "none" then -- onNoLongerPowered
      o.refreshTicks = 0
      o.updateGatheredData()
    end
    return true
  end

  function handlers.createSetLinkTarget(cmd)
    M.catchUp()
    local o = byName[cmd.peripheral]
    if not o or o.kind ~= "Create_DisplayLink" then return false, "not a display link: " .. tostring(cmd.peripheral) end
    local ok, t = pcall(newTarget, cmd.target)
    if not ok then return false, tostring(t) end
    o.target = t
    return true
  end

  M.handlers = handlers

  function M.state()
    M.catchUp()
    local trains, stations, nets = {}, {}, {}
    for _, tr in ipairs(T.trains) do trains[#trains + 1] = T.trainState(tr) end
    for _, st in ipairs(T.stations) do stations[#stations + 1] = T.stationState(st) end
    for id in pairs(networks) do
      local s = K.stats(id)
      nets[id] = { speed = s.effective, stress = s.stress, capacity = s.capacity, overstressed = s.overstressed }
    end
    return { gameTime = lastTick, dayTime = clock.dayTime(lastTick), trains = trains, stations = stations, networks = nets }
  end

  return M
end
