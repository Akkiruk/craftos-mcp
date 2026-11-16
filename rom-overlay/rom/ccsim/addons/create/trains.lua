-- ccsim create/trains: Create 0.5.1.i train stations, trains and schedules (see init.lua for the sources).
--
-- Schedules are kept as Create keeps them: entries of an instruction and columns of wait conditions, each with its
-- Id and its Data compound. setSchedule/getSchedule convert to and from Lua tables exactly as StationPeripheral does
-- (toNBTTag / fromNBTTag with StringHelper's snake_case <-> CamelCase), and ScheduleRuntime runs them on the
-- virtual clock: navigate to the nearest station matching the filter, arrive, tick the conditions, move on.
return function(core, host, C, clock)
  local floor, abs, min, max, sqrt = math.floor, math.abs, math.min, math.max, math.sqrt
  local cfg = core.world.create or {}
  local conf = cfg.config or {}

  -- CTrains defaults (blocks per second, blocks per second squared)
  local TOP = tonumber(conf.trainTopSpeed) or 28
  local POWERED_TOP = tonumber(conf.poweredTrainTopSpeed) or 40
  local ACCEL = tonumber(conf.trainAcceleration) or 3
  local POWERED_ACCEL = tonumber(conf.poweredTrainAcceleration) or 3
  local DEFAULT_DISTANCE = tonumber(cfg.distance) or 300
  local INTERVAL = 40 -- ScheduleRuntime.INTERVAL: retry after a failed navigation
  local IMMINENT = 30 -- GlobalStation.getImminentTrain: within 30 blocks
  local UNNAMED = "Unnamed Train" -- create.train.unnamed

  local T = { stations = {}, trains = {} }
  local linkVersion = 0
  local linkPowered = {}

  -- ===== schedule <-> Lua (StationPeripheral.toNBTTag / fromNBTTag, StringHelper) =====

  local function snakeToCamel(text)
    if #text == 0 then C.java("java.lang.StringIndexOutOfBoundsException", "begin 0, end 1, length 0") end
    local out = { text:sub(1, 1):upper() }
    local i = 2
    while i <= #text do
      local j = text:find("_", i, true)
      if not j then
        out[#out + 1] = text:sub(i) -- the tail after the last "_" keeps its case
        break
      end
      out[#out + 1] = text:sub(i, j - 1):lower()
      if j + 1 > #text then
        C.java("java.lang.StringIndexOutOfBoundsException", ("begin %d, end %d, length %d"):format(j, j + 1, #text))
      end
      out[#out + 1] = text:sub(j + 1, j + 1):upper()
      i = j + 2
    end
    return table.concat(out)
  end
  T.snakeToCamel = snakeToCamel

  local function camelToSnake(text)
    local s = text:gsub("%u", function(c) return "_" .. c:lower() end)
    if s:sub(1, 1) == "_" then s = s:sub(2) end
    return s
  end
  T.camelToSnake = camelToSnake

  local function javaClassOf(v)
    if type(v) == "string" then return "java.lang.String" end
    if type(v) == "boolean" then return "java.lang.Boolean" end
    if type(v) == "table" then return "java.util.HashMap" end
    return "java.lang.Object"
  end

  local function toNBT(key, value)
    local ty = type(value)
    if ty == "boolean" then return C.byteTag(value and 1 or 0) end
    if key == "count" then
      if ty ~= "number" then
        C.java("java.lang.ClassCastException", "class " .. javaClassOf(value) .. " cannot be cast to class java.lang.Number")
      end
      return C.byteTag(C.toByte(value))
    end
    if ty == "number" then
      local i = C.toInt(value)
      if i == value then return C.intTag(i) end
      return { t = C.DOUBLE, v = value }
    end
    if ty == "string" then return C.string(value) end
    if ty == "table" then
      if value[1] ~= nil then -- a list: keys 1..size, holes skipped
        local list = C.list()
        for i = 1, C.count(value) do
          if value[i] ~= nil then C.listAdd(list, toNBT(nil, value[i])) end
        end
        return list
      end
      local compound = C.compound()
      for k, v in pairs(value) do
        if type(k) ~= "string" then error("table key is not of type string", 0) end
        -- items keep their lower-case "id" when they have a "count" beside it
        local name = (k == "id" and value.count ~= nil) and "id" or snakeToCamel(k)
        compound.v[name] = toNBT(k, v)
      end
      return compound
    end
    C.java("java.lang.NullPointerException")
  end
  T.toNBT = toNBT

  local function fromNBT(key, tag)
    local t = tag.t
    if t == C.BYTE and key == "Count" then return tag.v end
    if t == C.BYTE then return tag.v ~= 0 end
    if t == C.INT or t == C.DOUBLE or t == 2 or t == 4 or t == 5 then return tag.v end
    if t == C.STRING then return tag.v end
    if t == C.LIST then
      local out = {}
      for i, v in ipairs(tag.v) do out[i] = fromNBT(nil, v) end
      return out
    end
    local out = {}
    for k, v in pairs(tag.v) do out[camelToSnake(k)] = fromNBT(k, v) end
    return out
  end
  T.fromNBT = fromNBT

  -- ===== items (ItemStack.of / save, FilterItemStack) =====

  local function itemOf(tag)
    local ok, id = pcall(C.resourceLocation, C.getString(tag, "id"))
    if not ok or id == "minecraft:air" then return nil end
    local count = C.getByte(tag, "Count")
    if count <= 0 then return nil end
    local stackTag = tag.v.tag and tag.v.tag.t == C.COMPOUND and C.copyTag(tag.v.tag) or nil
    return { id = id, count = count, tag = stackTag }
  end

  local function itemSave(stack)
    local c = C.compound()
    -- ItemStack.EMPTY is air with a count of 1
    c.v.id = C.string(stack and stack.id or "minecraft:air")
    c.v.Count = C.byteTag(stack and stack.count or 1)
    if stack and stack.tag then c.v.tag = C.copyTag(stack.tag) end
    return c
  end

  local function bucketFluid(stack)
    if not stack then return nil end
    if stack.id == "minecraft:water_bucket" then return "minecraft:water" end
    if stack.id == "minecraft:lava_bucket" then return "minecraft:lava" end
    local ns, base = stack.id:match("^([^:]+):(.+)_bucket$")
    return ns and (ns .. ":" .. base) or false
  end

  -- ===== schedule objects (Schedule, ScheduleEntry, ScheduleInstruction, ScheduleWaitCondition) =====

  local INSTRUCTIONS = { ["create:destination"] = "destination", ["create:rename"] = "rename", ["create:throttle"] = "throttle" }
  local CONDITIONS = {
    ["create:delay"] = "delay", ["create:time_of_day"] = "time_of_day", ["create:fluid_threshold"] = "fluid_threshold",
    ["create:item_threshold"] = "item_threshold", ["create:redstone_link"] = "redstone_link",
    ["create:player_count"] = "player_count", ["create:idle"] = "idle", ["create:unloaded"] = "unloaded",
    ["create:powered"] = "powered",
  }

  local function readFrequency(tag)
    local list = C.getList(tag, "Frequency", C.COMPOUND)
    local stacks = {}
    for i, c in ipairs(list.v) do
      local s = itemOf(c)
      if s then s.count = 1 end
      stacks[i] = s or false
    end
    if #list.v < 2 then
      C.java("java.lang.IndexOutOfBoundsException", ("Index %d out of bounds for length %d"):format(#list.v, #list.v))
    end
    return { stacks[1] or nil, stacks[2] or nil }
  end

  local function instructionFromTag(tag)
    local id = C.resourceLocation(C.getString(tag, "Id"))
    local kind = INSTRUCTIONS[id]
    if not kind then id, kind = "create:destination", "destination" end -- "Could not parse schedule instruction type"
    return { id = id, kind = kind, data = C.getCompound(tag, "Data") }
  end

  local function conditionFromTag(tag)
    local id = C.resourceLocation(C.getString(tag, "Id"))
    local kind = CONDITIONS[id]
    if not kind then return false end -- "Could not parse waiting condition type": a null in the list
    local data = C.getCompound(tag, "Data")
    local cond = { id = id, kind = kind, data = data }
    -- readAdditional runs on the outer tag (migration) and then on Data
    for _, from in ipairs({ tag, data }) do
      if kind == "item_threshold" and C.contains(from, "Item") then cond.item = itemOf(C.getCompound(from, "Item")) end
      if kind == "fluid_threshold" and C.contains(from, "Bucket") then cond.bucket = itemOf(C.getCompound(from, "Bucket")) end
      if kind == "redstone_link" and C.contains(from, "Frequency") then cond.freq = readFrequency(from) end
    end
    if kind == "redstone_link" then cond.freq = cond.freq or {} end
    return cond
  end

  local function scheduleFromTag(tag)
    local s = { entries = {}, cyclic = C.getBoolean(tag, "Cyclic"), savedProgress = 0 }
    for _, e in ipairs(C.getList(tag, "Entries", C.COMPOUND).v) do
      local entry = { instruction = instructionFromTag(C.getCompound(e, "Instruction")), conditions = {} }
      if entry.instruction.kind == "destination" then
        for _, column in ipairs(C.getList(e, "Conditions", C.LIST).v) do
          if column.t == C.LIST then
            local list = {}
            for _, c in ipairs(column.v) do
              if c.t ~= C.COMPOUND then
                C.java("java.lang.ClassCastException", "class net.minecraft.nbt." .. (({ [1] = "ByteTag", [3] = "IntTag",
                  [6] = "DoubleTag", [8] = "StringTag", [9] = "ListTag" })[c.t] or "Tag") ..
                  " cannot be cast to class net.minecraft.nbt.CompoundTag")
              end
              list[#list + 1] = conditionFromTag(c)
            end
            entry.conditions[#entry.conditions + 1] = list
          end
        end
      end
      s.entries[#s.entries + 1] = entry
    end
    if C.contains(tag, "Progress") then s.savedProgress = C.getInt(tag, "Progress") end
    return s
  end
  T.scheduleFromTag = scheduleFromTag

  local function conditionWrite(cond)
    if not cond then C.java("java.lang.NullPointerException") end
    local tag = C.compound()
    local data = C.copyTag(cond.data)
    if cond.kind == "item_threshold" then data.v.Item = itemSave(cond.item) end
    if cond.kind == "fluid_threshold" then data.v.Bucket = itemSave(cond.bucket) end
    if cond.kind == "redstone_link" then
      local list = C.list()
      C.listAdd(list, itemSave(cond.freq[1]))
      C.listAdd(list, itemSave(cond.freq[2]))
      data.v.Frequency = list
    end
    tag.v.Id = C.string(cond.id)
    tag.v.Data = data
    return tag
  end

  local function scheduleWrite(s)
    local tag = C.compound()
    local entries = C.list()
    for _, e in ipairs(s.entries) do
      local et = C.compound()
      local it = C.compound()
      it.v.Id = C.string(e.instruction.id)
      it.v.Data = C.copyTag(e.instruction.data)
      et.v.Instruction = it
      if e.instruction.kind == "destination" then
        local outer = C.list()
        for _, column in ipairs(e.conditions) do
          local list = C.list()
          for _, cond in ipairs(column) do C.listAdd(list, conditionWrite(cond)) end
          C.listAdd(outer, list)
        end
        et.v.Conditions = outer
      end
      C.listAdd(entries, et)
    end
    tag.v.Entries = entries
    tag.v.Cyclic = C.byteTag(s.cyclic and 1 or 0)
    if s.savedProgress > 0 then tag.v.Progress = C.intTag(s.savedProgress) end
    return tag
  end
  T.scheduleWrite = scheduleWrite

  --- A fixture route { {station = "A", wait = 10}, ... } as Create would store it: go there, wait `wait` seconds.
  local function routeSchedule(route, cyclic)
    local entries = {}
    for _, stop in ipairs(route) do
      local wait = tonumber(stop.wait) or 5
      entries[#entries + 1] = {
        instruction = { id = "create:destination", data = { text = stop.station } },
        conditions = { { { id = "create:delay", data = { value = floor(wait), time_unit = 1 } } } },
      }
    end
    return { entries = entries, cyclic = cyclic ~= false }
  end

  -- ===== stations =====

  local function stationByName(name)
    for _, st in ipairs(T.stations) do
      if st.track and st.name == name then return st end
    end
    return nil
  end
  T.stationByName = stationByName

  local function newStation(spec)
    if spec.peripheral then
      -- a station block with a computer may also be listed by name in world.create.stations: one station
      local name = spec.station or "Track Station"
      for _, st in ipairs(T.stations) do
        if not st.peripheral and st.key == name then
          st.peripheral = spec.peripheral
          st.track = spec.track ~= false
          st.assembling = spec.assembling == true or st.assembling
          st.powered = spec.powered == true or st.powered
          st.pending = spec.pending == true and {} or spec.pending or st.pending
          return st
        end
      end
    end
    local st = {
      key = spec.station or spec.name or "Track Station",
      name = spec.station or spec.name or "Track Station",
      track = spec.track ~= false,
      assembling = spec.assembling == true,
      powered = spec.powered == true,
      pending = spec.pending,
      lastDisassembled = nil,
      nearest = nil,
      peripheral = spec.peripheral,
    }
    if st.pending == true then st.pending = {} end
    T.stations[#T.stations + 1] = st
    return st
  end
  T.newStation = newStation

  for _, s in ipairs(cfg.stations or {}) do
    newStation(type(s) == "table" and s or { name = tostring(s) })
  end

  local distances = {}
  for k, d in pairs(cfg.distances or {}) do
    local a, b = tostring(k):match("^(.-)|(.+)$")
    if a then
      distances[a .. "|" .. b] = tonumber(d)
      distances[b .. "|" .. a] = tonumber(d)
    end
  end
  local function distance(from, to)
    if from == to then return 0 end
    if not from then return DEFAULT_DISTANCE end
    return distances[from.key .. "|" .. to.key] or DEFAULT_DISTANCE
  end

  -- ===== trains =====

  local function rtReset(tr)
    tr.paused = true
    tr.completed = false
    tr.auto = false
    tr.currentEntry = 0
    tr.title = ""
    tr.schedule = nil
    tr.state = "PRE_TRANSIT"
    tr.progress = {}
    tr.context = {}
    tr.cooldown = 0
  end

  local function setSchedule(tr, schedule, auto)
    rtReset(tr)
    tr.schedule = schedule
    local n = #schedule.entries
    local p = schedule.savedProgress
    tr.currentEntry = p < 0 and 0 or (p > n - 1 and n - 1 or p) -- Mth.clamp(progress, 0, size - 1)
    tr.paused = false
    tr.auto = auto
    tr.status = "new_schedule"
    tr.crashed = nil
  end
  T.setSchedule = setSchedule

  local function newTrain(spec)
    local tr = {
      name = spec.name or UNNAMED,
      conductor = spec.conductor ~= false,
      powered = spec.powered == true or spec.fuel == true,
      maxSpeed = tonumber(spec.maxSpeed),
      throttle = 1,
      players = tonumber(spec.players) or 0,
      cargo = { items = C.deepCopy(spec.items or {}), fluids = C.deepCopy(spec.fluids or {}) },
      cargoVersion = 0,
      idleTicks = 0,
      canDisassemble = spec.canDisassemble ~= false,
      ticksInTransit = 0,
      status = nil,
    }
    rtReset(tr)
    T.trains[#T.trains + 1] = tr
    return tr
  end

  local function trainByName(name)
    for _, tr in ipairs(T.trains) do
      if tr.name == name then return tr end
    end
    return nil
  end
  T.trainByName = trainByName

  local function cancelReservation(st, tr)
    if st and st.nearest == tr then st.nearest = nil end
  end

  local function reserveFor(st, tr)
    local n = st.nearest
    local function dist(x) return x.nav and x.nav.remaining or 0 end
    if n == nil or dist(n) > dist(tr) then st.nearest = tr end
  end

  local function leaveStation(tr)
    if tr.station then cancelReservation(tr.station, tr) end
    tr.station = nil
  end

  local function removeTrain(tr)
    leaveStation(tr)
    if tr.nav then cancelReservation(tr.nav.dest, tr) end
    for _, st in ipairs(T.stations) do cancelReservation(st, tr) end
    for i, x in ipairs(T.trains) do
      if x == tr then table.remove(T.trains, i) break end
    end
  end
  T.removeTrain = removeTrain

  local function placeAt(tr, st)
    tr.station = st
    tr.lastStation = st
    st.nearest = tr
  end

  -- ScheduleRuntime.destinationReached
  local function destinationReached(tr)
    if tr.state ~= "IN_TRANSIT" then return end
    tr.state = "POST_TRANSIT"
    tr.progress = {}
    tr.idleTicks = 0 -- resetIdleCargoTracker
    if tr.currentEntry >= #tr.schedule.entries then return end
    local columns = tr.schedule.entries[tr.currentEntry + 1].conditions
    tr.context = {}
    for i = 1, #columns do
      tr.progress[i] = 0
      tr.context[i] = {}
    end
  end

  local function arrive(tr, st)
    tr.nav = nil
    placeAt(tr, st)
    if tr.schedule then destinationReached(tr) end
  end

  local function startNavigation(tr, dest)
    leaveStation(tr)
    tr.nav = { dest = dest, remaining = distance(tr.lastStation, dest), speed = 0 }
    reserveFor(dest, tr)
  end

  -- ===== wait conditions (schedule/condition/*) =====

  local TICKS_PER = { [0] = 1, [1] = 20, [2] = 1200 } -- TimedWaitCondition.TimeUnit
  local ROTATION = { [9] = 250, [8] = 500, [7] = 750, [6] = 1000, [5] = 2000, [4] = 3000, [3] = 4000, [2] = 6000, [1] = 12000 }

  local function enumIndex(data, key, length)
    local v = C.getInt(data, key)
    local i = math.fmod(v, length)
    if i < 0 then
      C.java("java.lang.ArrayIndexOutOfBoundsException", ("Index %d out of bounds for length %d"):format(i, length))
    end
    return i
  end

  local function totalWaitTicks(cond)
    return C.getInt(cond.data, "Value") * TICKS_PER[enumIndex(cond.data, "TimeUnit", 3)]
  end

  local function getThreshold(cond)
    local text = C.getString(cond.data, "Threshold")
    local n = text:match("^[+-]?%d+$") and tonumber(text)
    if n and n >= -2147483648 and n <= 2147483647 then return n end
    cond.data.v.Threshold = C.string("0") -- CargoThresholdCondition.getThreshold resets a bad number
    return 0
  end

  local function opTest(op, current, target)
    if op == 0 then return current > target end
    if op == 1 then return current < target end
    return current == target
  end

  local function cargoTest(tr, cond)
    local op = enumIndex(cond.data, "Operator", 3)
    local target = getThreshold(cond)
    if cond.kind == "item_threshold" then
      local stacks = C.getInt(cond.data, "Measure") == 1
      local found = 0
      for _, it in ipairs(tr.cargo.items) do
        local name = it.name
        if name and not name:find(":", 1, true) then name = "minecraft:" .. name end
        if not cond.item or cond.item.id == name then
          local count = tonumber(it.count) or 1
          if stacks then
            found = found + (count == (tonumber(it.maxCount) or 64) and 1 or 0)
          else
            found = found + count
          end
        end
      end
      return opTest(op, found, target)
    end
    local fluid = bucketFluid(cond.bucket)
    local found = 0
    for _, f in ipairs(tr.cargo.fluids) do
      local name = f.name
      if name and not name:find(":", 1, true) then name = "minecraft:" .. name end
      local amount = tonumber(f.amount) or 0
      if fluid == nil or (fluid and fluid == name and amount > 0) then found = found + amount end
    end
    return opTest(op, found, target * 1000)
  end

  local function linkKey(a, b) return (a or "minecraft:air") .. "|" .. (b or "minecraft:air") end

  local function conditionTick(tr, cond, ctx, t)
    if not cond then
      tr.crashed = "java.lang.NullPointerException (unknown wait condition)"
      return false
    end
    local kind = cond.kind
    if kind == "delay" then
      local time = ctx.Time or 0
      if time >= totalWaitTicks(cond) then return true end
      ctx.Time = time + 1
      return false
    elseif kind == "idle" then
      return tr.idleTicks > totalWaitTicks(cond)
    elseif kind == "time_of_day" then
      local index = C.getInt(cond.data, "Rotation")
      local rotation = ROTATION[index] or 24000
      local dayTime = math.fmod(clock.dayTime(t), rotation)
      local hour, minute = C.getInt(cond.data, "Hour"), C.getInt(cond.data, "Minute")
      local target = math.fmod(math.fmod(hour + 18, 24) * 1000 + math.ceil(minute / 60 * 1000), rotation)
      local diff = dayTime - target
      return diff >= 0 and 40 >= diff
    elseif kind == "powered" then
      return tr.station ~= nil and tr.station.powered
    elseif kind == "unloaded" then
      return false
    elseif kind == "player_count" then
      local target = C.getInt(cond.data, "Count")
      if C.getInt(cond.data, "Exact") ~= 0 then return tr.players >= target end
      return tr.players == target
    elseif kind == "redstone_link" then
      local last = ctx.LastChecked or -1
      if linkVersion == last then return false end
      ctx.LastChecked = linkVersion
      local f = cond.freq
      local on = linkPowered[linkKey(f[1] and f[1].id, f[2] and f[2].id)] == true
      local low = C.getInt(cond.data, "Inverted") == 1
      return on ~= low
    elseif kind == "item_threshold" or kind == "fluid_threshold" then
      local time = ctx.Time or 0
      if time % 20 == 0 then -- LazyTickedScheduleCondition(20)
        local last = ctx.LastChecked or -1
        if tr.cargoVersion ~= last then
          ctx.LastChecked = tr.cargoVersion
          if cargoTest(tr, cond) then return true end
        end
        time = 0
      end
      ctx.Time = time + 1
      return false
    end
    return false
  end

  -- ===== ScheduleRuntime =====

  local function globPattern(filter)
    local parts = {}
    for piece in (filter .. "*"):gmatch("([^*]*)%*") do
      parts[#parts + 1] = piece:gsub("[%^%$%(%)%%%.%[%]%+%-%?]", "%%%0")
    end
    return "^" .. table.concat(parts, ".*") .. "$"
  end
  T.globPattern = globPattern

  local function startCurrentInstruction(tr)
    local entry = tr.schedule.entries[tr.currentEntry + 1]
    local inst = entry.instruction
    if inst.kind == "destination" then
      local filter = C.getString(inst.data, "Text")
      if not tr.conductor then
        tr.status = "missing_conductor"
        tr.cooldown = INTERVAL
        return nil
      end
      local pattern = globPattern(filter)
      local anyMatch, best, bestDistance = false, nil, nil
      for _, st in ipairs(T.stations) do
        if st.track and st.name:match(pattern) then
          anyMatch = true
          if not st.assembling then
            local d = (tr.station == st) and 0 or distance(tr.lastStation, st)
            if not best or d < bestDistance then best, bestDistance = st, d end
          end
        end
      end
      if not best then
        tr.status = anyMatch and "navigation_failed" or ("no_target: " .. filter)
        tr.cooldown = INTERVAL
        return nil
      end
      return best
    end
    if inst.kind == "rename" then
      tr.title = C.getString(inst.data, "Text")
    else
      tr.throttle = C.getInt(inst.data, "Value") / 100
    end
    tr.state = "PRE_TRANSIT"
    tr.currentEntry = tr.currentEntry + 1
    return nil
  end

  local function tickConditions(tr, t)
    local columns = tr.schedule.entries[tr.currentEntry + 1].conditions
    for i = 1, #columns do
      local list = columns[i]
      local p = tr.progress[i] or 0
      if p >= #list then
        tr.state = "PRE_TRANSIT"
        tr.currentEntry = tr.currentEntry + 1
        return
      end
      if conditionTick(tr, list[p + 1], tr.context[i], t) then
        tr.context[i] = {}
        tr.progress[i] = p + 1
      end
      if tr.crashed then return end
    end
    tr.idleTicks = tr.idleTicks + 1 -- tickIdleCargoTracker
  end

  local function runtimeTick(tr, t)
    if not tr.schedule or tr.paused or tr.crashed then return end
    if tr.nav then
      tr.ticksInTransit = tr.ticksInTransit + 1
      return
    end
    local n = #tr.schedule.entries
    if tr.currentEntry >= n then
      tr.currentEntry = 0
      if not tr.schedule.cyclic then
        tr.paused = true
        tr.completed = true
      end
      return
    end
    local cd = tr.cooldown
    tr.cooldown = cd - 1
    if cd > 0 then return end
    if tr.state == "IN_TRANSIT" then return end
    if tr.currentEntry < 0 then
      tr.crashed = ("java.lang.IndexOutOfBoundsException: Index %d out of bounds for length %d"):format(tr.currentEntry, n)
      return
    end
    if tr.state == "POST_TRANSIT" then
      tickConditions(tr, t)
      return
    end
    local dest = startCurrentInstruction(tr)
    if not dest then return end
    tr.status = nil -- successfulNavigation
    if dest == tr.station then
      tr.state = "IN_TRANSIT"
      destinationReached(tr)
      return
    end
    startNavigation(tr, dest)
    tr.state = "IN_TRANSIT"
    tr.ticksInTransit = 0
  end

  local function move(tr)
    local nav = tr.nav
    if not nav then return end
    reserveFor(nav.dest, tr)
    local a = (tr.powered and POWERED_ACCEL or ACCEL) / 400
    local top = (tr.maxSpeed or (tr.powered and POWERED_TOP or TOP)) / 20 * tr.throttle
    if top <= 0 then return end
    local v = min(nav.speed + a, top, sqrt(2 * a * nav.remaining))
    if v < a then v = min(a, nav.remaining) end
    nav.speed = v
    nav.remaining = nav.remaining - v
    if nav.remaining <= 1e-9 then arrive(tr, nav.dest) end
  end

  --- One server tick for every train.
  function T.tick(t)
    for _, tr in ipairs(T.trains) do
      runtimeTick(tr, t)
      move(tr)
    end
  end

  --- Anything that changes from tick to tick: a moving train or a running schedule.
  function T.busy()
    for _, tr in ipairs(T.trains) do
      if tr.nav and tr.throttle > 0 then return true end
      if tr.schedule and not tr.paused and not tr.crashed then return true end
    end
    return false
  end

  -- ===== fixture trains =====

  local pendingSpecs = cfg.trains or {}
  local placed = false

  --- Stations from peripherals register as the world is built; trains find their stations the first time anything looks.
  function T.init()
    if placed then return end
    placed = true
    for _, spec in ipairs(pendingSpecs) do T.addTrain(spec) end
  end

  function T.addTrain(spec)
    local tr = newTrain(spec)
    if spec.at then
      local st = stationByName(spec.at)
      if not st then error("ccsim: train '" .. tr.name .. "' is at unknown station '" .. tostring(spec.at) .. "'", 0) end
      placeAt(tr, st)
    end
    local sched
    if spec.schedule then
      sched = scheduleFromTag(toNBT(nil, spec.schedule))
    elseif spec.route then
      sched = scheduleFromTag(toNBT(nil, routeSchedule(spec.route, spec.cyclic)))
    end
    if sched then setSchedule(tr, sched, spec.autoSchedule == true) end
    if spec.heading then
      local st = stationByName(spec.heading)
      if st then
        tr.nav = { dest = st, remaining = tonumber(spec.distance) or DEFAULT_DISTANCE, speed = 0 }
        reserveFor(st, tr)
        if tr.schedule then tr.state = "IN_TRANSIT" end
      end
    end
    return tr
  end

  -- ===== the station block (StationBlockEntity) =====

  --- enterAssemblyMode: disassembles a present train first, then needs a valid track
  function T.enterAssemblyMode(st)
    if st.assembling then return false end
    local tr = st.track and st.nearest and st.nearest.station == st and st.nearest or nil
    if tr and tr.canDisassemble then
      st.lastDisassembled = tr.name
      st.pending = { name = tr.name, conductor = tr.conductor, powered = tr.powered, maxSpeed = tr.maxSpeed }
      removeTrain(tr) -- dropSchedule: the schedule item drops into the world
    end
    if not st.track then return false end
    st.assembling = true
    for _, x in ipairs(T.trains) do
      if x.nav and x.nav.dest == st then -- re-route: the station can no longer be approached
        cancelReservation(st, x)
        x.nav = nil
        if x.schedule and x.state == "IN_TRANSIT" then
          x.state = "PRE_TRANSIT"
          x.cooldown = 0
        end
      end
    end
    return true
  end

  function T.exitAssemblyMode(st)
    if not st.assembling then return false end
    st.assembling = false
    return st.track
  end

  --- StationBlockEntity.assemble: needs carriages on the track (the fixture's `pending`)
  function T.assemble(st)
    if not st.track or not st.pending then return end
    local p = st.pending
    st.pending = nil
    local tr = newTrain({ conductor = p.conductor, powered = p.powered, maxSpeed = p.maxSpeed })
    if st.lastDisassembled then
      tr.name = st.lastDisassembled
      st.lastDisassembled = nil
    elseif p.name then
      tr.name = p.name
    end
    placeAt(tr, st)
  end

  function T.presentTrain(st)
    local n = st.nearest
    if n and n.station == st then return n end
    return nil
  end

  function T.imminentTrain(st)
    local n = st.nearest
    if not n then return nil end
    if n.station == st then return n end
    if not n.nav then return nil end
    if n.nav.remaining > IMMINENT then return nil end
    return n
  end

  -- ===== sim commands =====

  function T.arriveAt(tr, st)
    if tr.nav and tr.nav.dest ~= st then cancelReservation(tr.nav.dest, tr) end
    if tr.station ~= st then leaveStation(tr) end
    arrive(tr, st)
  end

  function T.depart(tr)
    if tr.nav then cancelReservation(tr.nav.dest, tr) end
    tr.nav = nil
    leaveStation(tr)
  end

  function T.approach(tr, st, dist)
    if tr.nav then cancelReservation(tr.nav.dest, tr) end
    leaveStation(tr)
    tr.nav = { dest = st, remaining = dist or distance(tr.lastStation, st), speed = 0 }
    reserveFor(st, tr)
  end

  function T.setLink(first, second, powered)
    linkPowered[linkKey(first, second)] = powered and true or nil
    linkVersion = linkVersion + 1
  end

  function T.setCargo(tr, cmd)
    if cmd.items then tr.cargo.items = C.deepCopy(cmd.items) end
    if cmd.fluids then tr.cargo.fluids = C.deepCopy(cmd.fluids) end
    if cmd.items or cmd.fluids then
      tr.cargoVersion = tr.cargoVersion + 1
      tr.idleTicks = 0 -- an exchange resets the idle tracker
    end
    if cmd.players then tr.players = tonumber(cmd.players) or 0 end
  end

  -- ===== state =====

  function T.trainState(tr)
    local s = {
      name = tr.name,
      station = tr.station and tr.station.name or nil,
      destination = tr.nav and tr.nav.dest.name or nil,
      distance = tr.nav and floor(tr.nav.remaining * 100 + 0.5) / 100 or nil,
      speed = tr.nav and floor(tr.nav.speed * 20 * 100 + 0.5) / 100 or 0, -- blocks per second
      throttle = tr.throttle,
      hasSchedule = tr.schedule ~= nil,
      players = tr.players,
      status = tr.status,
      crashed = tr.crashed,
    }
    if tr.schedule then
      s.schedule = {
        currentEntry = tr.currentEntry + 1, entries = #tr.schedule.entries, state = tr.state, paused = tr.paused,
        completed = tr.completed, cyclic = tr.schedule.cyclic, title = tr.title, auto = tr.auto,
      }
    end
    return s
  end

  function T.stationState(st)
    local present = T.presentTrain(st)
    return {
      name = st.name,
      connected = st.track,
      assembling = st.assembling,
      powered = st.powered,
      trainPresent = present ~= nil,
      trainImminent = T.imminentTrain(st) ~= nil,
      trainEnroute = st.nearest ~= nil,
      train = present and present.name or (st.nearest and st.nearest.name) or nil,
      readyToAssemble = st.pending ~= nil,
    }
  end

  return T
end
