-- ccsim addon cctech: CCTech 0.1.6 (Forge, Minecraft 1.18.2), by ShreksHellraiser.
--
-- Written from the mod's source, github.com/ShreksHellraiser/cctech branch 1.18.2 at commit ab949e6 (9 May 2023, the
-- day 0.1.6 was published), checked against cctech-1.18.2-0.1.6.jar (javap: the peripheral types). Paths are under
-- src/main/java/github/shrekshellraiser/cctech/:
--   common/peripheral/tape/TapePeripheral, TapeBlockEntity (the event queue), cassette/*, reel/*
--   common/peripheral/StorageBlockEntity, server/FileManager (tape data: a file per tape, a 4-byte pointer first)
--   common/peripheral/cards/CardWriterPeripheral, CardWriterBlockEntity, MagCardPeripheral, MagCardBlock
--   common/item/StorageItem, tape/TapeItem, cards/MagCardItem, config/CCTechCommonConfigs
-- The jar's ROM files (rom/programs/tape.lua, rom/autorun/cctech_completion.lua) are in rom/, unchanged.
--
-- Every method is a plain @LuaFunction (computer thread). read, write, seek and seekAbs move the tape at once and then
-- wait for their event (MethodResult.pullEvent), which the block sends from its tick: one queued operation at a time,
-- each taking (int)(bytes * ticksPerByte) ticks after the tick that takes it off the queue.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua") -- CC's argument checks, HashMap order, Java exceptions
  local band, rshift = bit32.band, bit32.rshift
  local M = {}
  local cfg = core.world.cctech or {}
  local POINTER_SIZE = 4
  local CASSETTE_BPS = tonumber(cfg.cassetteBytesPerSecond) or 10000 -- "Cassette Operation Time (Bps): "
  local REEL_BPS = tonumber(cfg.reelBytesPerSecond) or 20000 -- "Reel Operation Time (Bps): "
  local DEFAULT_LENGTH = tonumber(cfg.defaultLength) or 360000 -- "Cassette Default Size"
  local rawFs = fs -- the simulation's own fs
  local DATA_DIR = "results/addons/cctech"

  local function now() return os.epoch("utc") end
  local function tickOf(t) return math.floor(t / 50) end

  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end

  local function randomUUID()
    local b = {}
    for i = 1, 16 do b[i] = math.random(0, 255) end
    b[7] = bit32.bor(band(b[7], 0x0f), 0x40)
    b[9] = bit32.bor(band(b[9], 0x3f), 0x80)
    local hex = ("%02x"):rep(16):format(table.unpack(b))
    return hex:sub(1, 8) .. "-" .. hex:sub(9, 12) .. "-" .. hex:sub(13, 16) .. "-" .. hex:sub(17, 20) .. "-" .. hex:sub(21)
  end

  -- ===== tape data (FileManager): <dir>/<uuid>, the pointer in its first four bytes =====

  local function dataPath(dir, uuid) return DATA_DIR .. "/" .. dir .. "/" .. uuid end

  --- FileManager.getData(folder, uuid, targetLength): the file, padded with zeros to targetLength; a missing file is
  --- four zero bytes (and is written so)
  local function loadBytes(dir, uuid, targetLength, initial)
    local path = dataPath(dir, uuid)
    local s
    if rawFs.exists(path) then
      local h = rawFs.open(path, "rb")
      s = h.readAll()
      h.close()
    else
      s = initial or string.rep("\0", POINTER_SIZE)
      if not rawFs.exists(DATA_DIR .. "/" .. dir) then rawFs.makeDir(DATA_DIR .. "/" .. dir) end
      local h = rawFs.open(path, "wb")
      h.write(s)
      h.close()
    end
    local bytes = {} -- sparse: index 0-based, nil is 0
    for i = 1, #s do
      local b = s:byte(i)
      if b ~= 0 then bytes[i - 1] = b end
    end
    return { bytes = bytes, length = math.max(#s, targetLength) }
  end

  local function saveBytes(dir, uuid, data)
    if not rawFs.exists(DATA_DIR .. "/" .. dir) then rawFs.makeDir(DATA_DIR .. "/" .. dir) end
    local parts, chunk = {}, {}
    local bytes = data.bytes
    for i = 0, data.length - 1 do
      chunk[#chunk + 1] = bytes[i] or 0
      if #chunk == 4096 then
        parts[#parts + 1] = string.char(table.unpack(chunk))
        chunk = {}
      end
    end
    if #chunk > 0 then parts[#parts + 1] = string.char(table.unpack(chunk)) end
    local h = rawFs.open(dataPath(dir, uuid), "wb")
    h.write(table.concat(parts))
    h.close()
  end

  --- FileManager.getPointer: four signed Java bytes added, so a byte of 128 or more counts negative
  local function getPointer(data)
    local function sb(i)
      local b = data.bytes[i] or 0
      return b >= 128 and b - 256 or b
    end
    return C.toInt(sb(0) + sb(1) * 256 + sb(2) * 65536 + sb(3) * 16777216)
  end
  local function setPointer(data, pointer)
    local p = pointer % 4294967296
    for i = 0, 3 do
      local b = band(rshift(p, 8 * i), 0xff)
      data.bytes[i] = b ~= 0 and b or nil
    end
  end

  -- ===== tape drives =====

  local tapes = {}
  local anyBusy -- schedules the next tick that has work

  local function newTape(def)
    local reel = def.type == "reel_to_reel"
    local o = { name = def.name, reel = reel, dir = reel and "reel" or "cassette" }
    o.ticksPerByte = 1.0 / ((reel and REEL_BPS or CASSETTE_BPS) / 20.0)
    local s = saved(def.name)
    o.open = def.open == true
    o.isLocked = reel and def.locked == true or false
    o.blockLocked = o.isLocked -- the block's LOCKED property, set from isLocked on the block's tick
    o.lockSetTick = nil
    o.item = nil -- { uuid, length, label } while a tape is in the slot
    o.pointer = 0
    o.queue, o.qstate, o.current, o.timer = {}, "FREE", nil, 0
    o.lastTick = tickOf(now())
    if s then
      o.open, o.isLocked, o.blockLocked = s.open == true, s.locked == true, s.locked == true
      if type(s.tape) == "table" then o.item = { uuid = s.tape.uuid, length = s.tape.length, label = s.tape.label } end
    elseif type(def.tape) == "table" then
      local t = def.tape
      o.item = { uuid = type(t.uuid) == "string" and t.uuid or randomUUID(), length = math.floor(tonumber(t.length) or DEFAULT_LENGTH),
        label = type(t.label) == "string" and t.label or nil, data = t.data, pointer = t.pointer }
    end
    return o
  end

  --- StorageBlockEntity.itemInserted -> TapeBlockEntity.loadData; the reel starts at 0 again
  local function insert(o)
    local it = o.item
    local initial
    if type(it.data) == "string" then
      -- a fixture tape: its contents (after the pointer) as the file the mod would have
      local p = math.floor(tonumber(it.pointer) or 0) % 4294967296
      initial = string.char(band(p, 255), band(rshift(p, 8), 255), band(rshift(p, 16), 255), band(rshift(p, 24), 255)) .. it.data
      it.data, it.pointer = nil, nil
    end
    o.data = loadBytes(o.dir, it.uuid, it.length + POINTER_SIZE, initial)
    o.pointer = getPointer(o.data)
    if o.reel then o.pointer = 0 end
    o.deviceInserted = true
  end
  --- itemRemoved -> saveData (with the pointer); the reel resets its pointer first
  local function remove(o)
    if o.reel then o.pointer = 0 end
    setPointer(o.data, o.pointer)
    saveBytes(o.dir, o.item.uuid, o.data)
    o.deviceInserted = false
    o.data = nil
  end

  local function currentTick() return tickOf(now()) end

  local function syncLock(o)
    if o.lockSetTick and currentTick() > o.lockSetTick then
      o.blockLocked = o.isLocked
      o.lockSetTick = nil
    end
  end

  local function assertReady(o)
    syncLock(o)
    if o.open then error("Door open", 0) end
    if o.reel and not o.blockLocked then error("Door unlocked", 0) end
    if not o.deviceInserted then error("No device inserted.", 0) end
  end

  -- TapeBlockEntity.tick, one server tick
  local function tickOnce(o)
    if o.qstate == "FREE" then
      while #o.queue > 0 and o.qstate == "FREE" do
        o.current = table.remove(o.queue, 1)
        o.qstate = "WAITING"
        o.timer = o.current.ticks
        if o.timer == 0 then
          os.queueEvent(o.current.event, o.name, true, o.current.value)
          o.qstate = "FREE"
        end
      end
    elseif o.qstate == "WAITING" then
      local t = o.timer
      o.timer = t - 1
      if t <= 0 then
        o.qstate = "FREE"
        os.queueEvent(o.current.event, o.name, true, o.current.value)
      end
    end
    if o.reel then o.blockLocked = o.isLocked; o.lockSetTick = nil end
  end

  --- Bring the block up to the current tick
  local function catchUp(o)
    local target = currentTick()
    while o.lastTick < target do
      o.lastTick = o.lastTick + 1
      tickOnce(o)
      -- an idle queue: nothing more happens until the next call
      if o.qstate == "FREE" and #o.queue == 0 then
        o.lastTick = target
        if o.reel then o.blockLocked = o.isLocked; o.lockSetTick = nil end
      end
    end
  end

  local timerAt
  function anyBusy()
    -- the earliest tick at which some drive has something to do
    local soonest
    for _, o in pairs(tapes) do
      catchUp(o)
      local at
      if o.qstate == "WAITING" then
        at = o.lastTick + math.max(o.timer, 0) + 1
      elseif #o.queue > 0 then
        at = o.lastTick + 1
      end
      if at and (not soonest or at < soonest) then soonest = at end
    end
    if not soonest or (timerAt and timerAt <= soonest) then return end
    timerAt = soonest
    core.after(math.max(0, soonest * 50 - now()) / 1000, function()
      timerAt = nil
      anyBusy()
      core.touch() -- the sim state shows what the ticks did
    end)
  end

  local function enqueue(o, value, event, ticks)
    catchUp(o)
    o.queue[#o.queue + 1] = { value = value, event = event, ticks = ticks }
    anyBusy()
  end

  --- EventFinished: pullEvent(filter), then resume checks the drive again and returns the event's value
  local function waitFor(o, event)
    local ev = table.pack(os.pullEvent(event))
    catchUp(o)
    assertReady(o)
    if ev.n < 4 then error("Invalid amount of arguments for event", 0) end
    if ev[3] == false then error(tostring(ev[4]), 0) end
    return ev[4]
  end

  local function optBool(i, v)
    if v == nil then return nil end
    return C.bool(i, v)
  end

  local function tapeMethods(o)
    local m = {}
    function m.isReady()
      catchUp(o)
      local has = o.item ~= nil
      if o.reel then return o.isLocked and has end
      return has
    end
    function m.read(count, async)
      count = C.optInt(1, count)
      async = optBool(2, async)
      catchUp(o)
      local characters = count or 1
      if characters < 1 then error("Cannot read <1 bytes.", 0) end
      assertReady(o)
      local from = o.pointer + POINTER_SIZE
      if from < 0 or from + characters > o.data.length then
        o.pointer = math.min(math.max(o.pointer, 0), o.data.length - POINTER_SIZE)
        error("Attempt to read past tape end.", 0)
      end
      local parts, chunk = {}, {}
      for i = from, from + characters - 1 do
        chunk[#chunk + 1] = o.data.bytes[i] or 0
        if #chunk == 4096 then
          parts[#parts + 1] = string.char(table.unpack(chunk))
          chunk = {}
        end
      end
      if #chunk > 0 then parts[#parts + 1] = string.char(table.unpack(chunk)) end
      o.pointer = o.pointer + characters
      enqueue(o, table.concat(parts), "tape_read", C.toInt(o.ticksPerByte * characters))
      if async then return true end
      return waitFor(o, "tape_read")
    end
    function m.write(str, async)
      str = C.str(1, str)
      async = optBool(2, async)
      catchUp(o)
      assertReady(o)
      local maxPointer = o.data.length - POINTER_SIZE
      local endPointer = o.pointer + #str
      if endPointer > maxPointer then
        -- the mod's own arithmetic: pointer - maxPointer is never positive here
        local writeAmount = o.pointer - maxPointer
        if writeAmount < 0 then
          C.java("java.lang.ArrayIndexOutOfBoundsException", ("arraycopy: length %d is negative"):format(writeAmount))
        end
        enqueue(o, false, "tape_write", C.toInt(o.ticksPerByte * writeAmount))
        if async then return false end
        return waitFor(o, "tape_write")
      end
      local at = o.pointer + POINTER_SIZE
      for i = 1, #str do
        local b = str:byte(i)
        o.data.bytes[at + i - 1] = b ~= 0 and b or nil
      end
      o.pointer = o.pointer + #str
      o.dirty = true
      enqueue(o, true, "tape_write", C.toInt(o.ticksPerByte * #str))
      if async then return true end
      return waitFor(o, "tape_write")
    end
    local function seekTo(newPointer, async)
      local start = o.pointer
      o.pointer = math.min(math.max(newPointer, 0), o.data.length - POINTER_SIZE)
      local moved = o.pointer - start
      enqueue(o, moved, "tape_seek", C.toInt(moved * o.ticksPerByte))
      if async then return true end
      return waitFor(o, "tape_seek")
    end
    function m.seek(offset, async)
      offset = C.int(1, offset)
      async = optBool(2, async)
      catchUp(o)
      assertReady(o)
      return seekTo(C.toInt(o.pointer + offset), async)
    end
    function m.setLabel(label)
      label = C.str(1, label)
      catchUp(o)
      assertReady(o)
      o.item.label = label
    end
    function m.clearLabel()
      catchUp(o)
      assertReady(o)
      o.item.label = nil
    end
    function m.getSize()
      catchUp(o)
      assertReady(o)
      return o.data.length - POINTER_SIZE
    end
    local decl = { "isReady", "read", "write", "seek", "setLabel", "clearLabel", "getSize" }
    if o.reel then
      function m.seekAbs(loc, async)
        loc = C.int(1, loc)
        async = optBool(2, async)
        catchUp(o)
        assertReady(o)
        return seekTo(loc, async)
      end
      function m.getPos()
        catchUp(o)
        return o.pointer
      end
      function m.lock(lock)
        lock = optBool(1, lock)
        catchUp(o)
        local newState
        if lock == nil then newState = not o.isLocked else newState = lock end
        if o.open then error("Door open", 0) end
        o.isLocked = newState
        o.lockSetTick = currentTick() -- the block's LOCKED follows on its next tick
        return o.isLocked
      end
      -- ReelToReelPeripheral's own methods come first in Class.getMethods, then TapePeripheral's
      decl = { "seekAbs", "isReady", "getPos", "lock", "read", "write", "seek", "setLabel", "clearLabel", "getSize" }
    end
    return m, decl
  end

  local function tapeState(o)
    catchUp(o)
    local st = { open = o.open, queue = #o.queue, busy = o.qstate == "WAITING" }
    if o.reel then st.locked = o.isLocked end
    if o.item then
      st.tape = { uuid = o.item.uuid, length = o.item.length, label = o.item.label }
      st.pointer = o.pointer
      if o.dirty then
        -- the world saves: StorageBlockEntity.saveAdditional writes the tape's file (with the pointer)
        setPointer(o.data, o.pointer)
        saveBytes(o.dir, o.item.uuid, o.data)
        o.dirty = false
      end
    end
    return st
  end

  -- ===== magnetic cards =====

  local writers, readers = {}, {}

  local function newWriter(def)
    local s = saved(def.name)
    local o = { name = def.name, open = def.open == true, writerUUID = type(def.writerUUID) == "string" and def.writerUUID or randomUUID() }
    if s then
      o.open, o.writerUUID = s.open == true, s.writerUUID or o.writerUUID
      if type(s.card) == "table" then o.card = { uuid = s.card.uuid, contents = s.card.contents, label = s.card.label } end
    elseif type(def.card) == "table" then
      o.card = { uuid = def.card.uuid, contents = def.card.contents, label = def.card.label }
    end
    local function assertReadyW()
      if o.open then error("Door open", 0) end
      if not o.card then error("No card inserted", 0) end
    end
    local m = {}
    function m.writeCard(data)
      data = C.str(1, data)
      assertReadyW()
      o.card.contents = data
      o.card.uuid = o.writerUUID
    end
    function m.setLabel(label)
      label = C.str(1, label)
      assertReadyW()
      o.card.label = label
    end
    function m.getLabel()
      assertReadyW()
      return o.card.label
    end
    function m.clearLabel()
      assertReadyW()
      o.card.label = nil
      return true
    end
    function m.readCard()
      assertReadyW()
      if o.card.uuid ~= nil and o.card.contents ~= nil then
        return { uuid = o.card.uuid, contents = o.card.contents }
      end
      return nil
    end
    function m.getUUID() return o.writerUUID end
    return o, m, { "writeCard", "setLabel", "getLabel", "clearLabel", "readCard", "getUUID" }
  end

  -- ===== the module =====

  function M.peripheral(def)
    local methods, decl, state
    if def.type == "cassette_deck" or def.type == "reel_to_reel" then
      local o = newTape(def)
      tapes[def.name] = o
      if o.item then insert(o) end
      methods, decl = tapeMethods(o)
      state = function() return tapeState(o) end
    elseif def.type == "card_writer" then
      local o
      o, methods, decl = newWriter(def)
      writers[def.name] = o
      state = function()
        return { open = o.open, writerUUID = o.writerUUID, card = o.card and { uuid = o.card.uuid, contents = o.card.contents, label = o.card.label } or nil }
      end
    else
      readers[def.name] = true
      methods, decl = {}, {}
    end
    local computer = {}
    for _, name in ipairs(decl) do computer[name] = true end
    return {
      methods = methods,
      methodOrder = C.hashMapOrder(decl),
      computerThread = computer,
      exactReturns = true,
      -- the card writer is a "magnetic_card_reader" too (CardWriterPeripheral.getType)
      types = { def.type == "card_writer" and "magnetic_card_reader" or def.type },
      state = state,
      detach = function()
        local o = tapes[def.name]
        if o and o.item and o.deviceInserted then remove(o) end
        tapes[def.name], writers[def.name], readers[def.name] = nil, nil, nil
      end,
    }
  end

  function M.catchUp()
    for _, o in pairs(tapes) do catchUp(o) end
  end

  -- ===== sim commands =====

  local handlers = {}
  local function find(set, name, what)
    local o = set[tostring(name)]
    if not o then return nil, "no " .. what .. " named " .. tostring(name) end
    return o
  end

  --- ctSetDoor {peripheral, open}: a player opens or closes the drive's (or writer's) door
  function handlers.ctSetDoor(cmd)
    local o = tapes[tostring(cmd.peripheral)] or writers[tostring(cmd.peripheral)]
    if not o then return false, "no cassette deck, reel to reel or card writer named " .. tostring(cmd.peripheral) end
    if o.reel then
      catchUp(o)
      syncLock(o)
      if o.blockLocked then return false, "the reel to reel is locked: its door stays shut" end
    end
    o.open = cmd.open == true
    return true
  end

  --- ctInsert {peripheral, tape = { uuid?, length?, label?, data?, pointer? }}: a player puts a tape in (door open)
  function handlers.ctInsert(cmd)
    local o, err = find(tapes, cmd.peripheral, "cassette deck or reel to reel")
    if not o then return false, err end
    if not o.open then return false, "open the door first (ctSetDoor)" end
    if o.item then return false, tostring(cmd.peripheral) .. " already holds a tape" end
    local t = type(cmd.tape) == "table" and cmd.tape or {}
    catchUp(o)
    o.item = { uuid = type(t.uuid) == "string" and t.uuid or randomUUID(), length = math.floor(tonumber(t.length) or DEFAULT_LENGTH),
      label = type(t.label) == "string" and t.label or nil, data = t.data, pointer = t.pointer }
    insert(o)
    return true
  end

  --- ctEject {peripheral}: a player takes the tape out (door open); its data is saved to its file
  function handlers.ctEject(cmd)
    local o, err = find(tapes, cmd.peripheral, "cassette deck or reel to reel")
    if not o then return false, err end
    if not o.open then return false, "open the door first (ctSetDoor)" end
    if not o.item then return false, tostring(cmd.peripheral) .. " holds no tape" end
    catchUp(o)
    remove(o)
    o.item = nil
    return true
  end

  --- ctInsertCard {peripheral, card = { uuid?, contents?, label? }} / ctEjectCard {peripheral}: the card writer's slot
  function handlers.ctInsertCard(cmd)
    local o, err = find(writers, cmd.peripheral, "card writer")
    if not o then return false, err end
    if not o.open then return false, "open the door first (ctSetDoor)" end
    if o.card then return false, tostring(cmd.peripheral) .. " already holds a card" end
    local c = type(cmd.card) == "table" and cmd.card or {}
    o.card = { uuid = c.uuid, contents = c.contents, label = c.label }
    return true
  end
  function handlers.ctEjectCard(cmd)
    local o, err = find(writers, cmd.peripheral, "card writer")
    if not o then return false, err end
    if not o.open then return false, "open the door first (ctSetDoor)" end
    if not o.card then return false, tostring(cmd.peripheral) .. " holds no card" end
    o.card = nil
    return true
  end

  --- ctSwipe {peripheral, uuid?, contents?}: a player uses a card on the reader (MagCardBlock.use)
  function handlers.ctSwipe(cmd)
    if not readers[tostring(cmd.peripheral)] then return false, "no magnetic card reader named " .. tostring(cmd.peripheral) end
    os.queueEvent("magnetic_card_scanned", cmd.uuid, cmd.contents)
    return true
  end

  M.handlers = handlers
  return M
end
