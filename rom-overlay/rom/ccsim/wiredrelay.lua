-- ccsim wiredrelay: one block on a wired network, shared by every computer on that cable, as in plain CC:Tweaked.
-- Loaded on every computer unless its world says `vhcctweaks: "2.2.35"`, with or without the vhcctweaks mod.
--
-- Every computer publishes a directory entry (id, boot, loaded, peripherals) to the runner's relay, which hands the
-- full directory to every computer that uses it. The runner names the computer that holds each peripheral on a
-- cable (packages/runner/src/wired.ts); the others call it as requests through the relay, which run on the holder
-- between its own events, the caller waiting for the answer the way CC waits for a main-thread task
-- (`task_complete`). ccsim/link.lua (vhcctweaks 2.2.36 linked ender modems and watches) builds on this.
return function(core, host, modems)
  local R = {}

  local OUTBOX = "/results/modem.out"
  local fsOpen, queueEvent = fs.open, os.queueEvent
  local encode, decode = modems.encode, modems.decode
  local myId = core.computerId
  local boot = tostring(os.epoch("utc")) .. "-" .. tostring(os.clock())
  R.myId, R.boot = myId, boot

  local directory = {}  -- id -> entry of every other computer on the relay, as the relay last sent it
  local pending = {}    -- rid -> request waiting for its answer
  local nextRid, nextTask = 0, 0
  local serving = 0     -- > 0 while running a request from another computer

  -- What link.lua adds: more directory fields, ops, events, and what to do after a publish or a directory change
  R.ops = {}
  R.entryFields = nil   -- function(entry) adds fields to this computer's entry
  R.afterPublish = nil  -- function()
  R.onEvent = nil       -- function(msg) for a message of kind "evt"
  R.onDirectory = nil   -- function(old, directory) after the directory changed and lost calls failed

  local function send(line)
    if not core.world.modemLink then return end
    if core.flushHost then core.flushHost() end -- block changes held back go first (ccsim/modem.lua)
    -- the host channel (ccsim/core.lua M.host): straight to the runner, no file
    if core.host then return core.host("M", line .. "\n") end
    local h = fsOpen(OUTBOX, "a")
    if h then
      h.write(line .. "\n")
      h.close()
    end
  end
  R.send = send

  local function selfEntry()
    local entry = { id = myId, boot = boot, loaded = not core.unloaded, peripherals = host.exports() }
    if R.entryFields then R.entryFields(entry) end
    return entry
  end

  local function entryFor(id)
    if id == myId then return selfEntry() end
    return directory[id]
  end
  R.entryFor = entryFor

  function R.directory() return directory end
  function R.serving() return serving > 0 end

  local lastPublished
  --- Tell the relay what this computer is now, if anything changed.
  function R.publish()
    local text = encode(selfEntry())
    if text == lastPublished then return end
    lastPublished = text
    send("D" .. myId .. ";" .. text)
    if R.afterPublish then R.afterPublish() end
  end

  local function notLoaded(id) return "computer " .. tostring(id) .. " is not loaded" end
  R.notLoaded = notLoaded

  local handleRequest -- defined below

  -- ===== peripherals on a cable that another computer holds (ccsim/modem.lua) =====

  local wiredHolder = {} -- peripheral name -> the computer that holds it
  local holderCount = {} -- computer id -> how many peripherals here it holds
  local ownerWaits = {}  -- task -> true: calls waiting to hear of the holder

  --- `name` is on this computer's cable but `owner` holds it: calls on it go there. It keeps its types and methods.
  function R.attachWired(name, owner)
    local types = table.pack(host.getType(name))
    local info = { types = {}, methods = host.getMethods(name) or {} }
    for i = 1, types.n do info.types[i] = types[i] end
    host.attachRemote(name, info, owner, name)
    wiredHolder[name] = owner
    holderCount[owner] = (holderCount[owner] or 0) + 1
  end

  function R.detachWired(name)
    local owner = wiredHolder[name]
    if owner == nil then return end
    wiredHolder[name] = nil
    holderCount[owner] = holderCount[owner] - 1
    if holderCount[owner] == 0 then holderCount[owner] = nil end
  end

  --- The computer holding `name` on this computer's cable, or nil when this computer holds it or it is not wired.
  function R.holderOf(name) return wiredHolder[name] end
  --- Every computer holding a peripheral on this computer's cable: id -> how many.
  function R.holders() return holderCount end

  --- A computer that has just booted has not heard the directory yet. A call to a peripheral on its cable waits for
  --- the computer holding it to be heard of, as long as a server tick or two, instead of failing.
  local function awaitHolder(id)
    nextTask = nextTask + 1
    local task = -nextTask
    ownerWaits[task] = true
    local gaveUp = false
    core.after(0.5, function()
      if ownerWaits[task] then
        gaveUp = true
        queueEvent("task_complete", task, false)
      end
    end)
    local kept = {}
    while true do
      local entry = entryFor(id)
      if entry and entry.loaded then break end
      local ev = table.pack(coroutine.yield())
      if ev[1] == "task_complete" and ev[2] == task then
        if gaveUp then break end
      elseif ev[1] == "terminate" then
        ownerWaits[task] = nil
        error("Terminated", 0)
      elseif not (ev[1] == "task_complete" and type(ev[2]) == "number" and ev[2] < 0) then
        kept[#kept + 1] = ev
      end
    end
    ownerWaits[task] = nil
    for _, ev in ipairs(kept) do core.keepFor(ev) end
  end

  -- ===== requests to other computers =====

  --- Run a request on computer `id` and return its results. `keep`: events that arrive meanwhile are kept for this
  --- coroutine's next waits (a call that runs on the computer thread, core.keepFor); otherwise they are lost to it, as in
  --- a main-thread call. The program's other coroutines get them as usual either way.
  function R.request(id, msg, keep)
    local entry = entryFor(id)
    if (not entry or not entry.loaded) and holderCount[id] then
      awaitHolder(id)
      entry = entryFor(id)
    end
    if not entry or not entry.loaded then error(notLoaded(id), 0) end
    msg.from, msg.boot = myId, boot
    if id == myId then
      local values = handleRequest(msg)
      if not values.ok then error(values.err, 0) end
      return table.unpack(values.values, 1, values.values.n)
    end
    nextRid, nextTask = nextRid + 1, nextTask + 1
    msg.rid = nextRid
    -- Task ids of the sim are negative so they never match a program's own
    local waiting = { to = id, boot = entry.boot, task = -nextTask }
    pending[nextRid] = waiting
    send("M" .. id .. ";" .. encode(msg))
    local kept = {}
    while not waiting.done do
      local ev = table.pack(coroutine.yield())
      if ev[1] == "task_complete" and ev[2] == waiting.task then
        break
      elseif ev[1] == "terminate" and not keep then
        pending[msg.rid] = nil
        error("Terminated", 0)
      elseif keep and not (ev[1] == "task_complete" and type(ev[2]) == "number" and ev[2] < 0) then
        kept[#kept + 1] = ev
      end
    end
    pending[msg.rid] = nil
    for _, ev in ipairs(kept) do core.keepFor(ev) end
    if not waiting.ok then error(waiting.err, 0) end
    return table.unpack(waiting.values, 1, waiting.values.n)
  end

  --- A message that needs no answer.
  function R.tell(id, msg)
    msg.from, msg.boot = myId, boot
    if id == myId then
      handleRequest(msg)
      return
    end
    send("M" .. id .. ";" .. encode(msg))
  end

  local function finish(waiting, ok, values, err)
    if waiting.done then return end
    waiting.done, waiting.ok, waiting.values, waiting.err = true, ok, values or { n = 0 }, err
    queueEvent("task_complete", waiting.task, ok)
  end

  -- ===== requests from other computers =====

  function R.exported(name)
    for _, p in ipairs(host.exports()) do
      if p.name == name then return true end
    end
    return false
  end
  local exported = R.exported

  local function inventoryOf(name)
    if not exported(name) then error("No peripheral: " .. tostring(name), 0) end
    local inv = host.localTarget(name)
    if not inv then error("Target '" .. tostring(name) .. "' is not an inventory", 0) end
    return inv
  end

  local ops = R.ops

  function ops.call(msg)
    if not exported(msg.name) then error("No peripheral: " .. tostring(msg.name), 0) end
    local args = msg.args or { n = 0 }
    local results = table.pack(host.invokeNow(msg.name, msg.method, table.unpack(args, 1, args.n or #args)))
    if not results[1] then error(results[2], 0) end
    return table.unpack(results, 2, results.n)
  end

  function ops.peek(msg) return inventoryOf(msg.name).__peek(msg.slot) end
  function ops.room(msg) return inventoryOf(msg.name).__room(msg.item, msg.count, msg.toSlot) end
  function ops.take(msg)
    local moved = inventoryOf(msg.name).__take(msg.slot, msg.count, msg.item)
    core.touch()
    return moved
  end
  function ops.insert(msg)
    local moved = inventoryOf(msg.name).__insert(msg.item, msg.count, msg.toSlot)
    core.touch()
    return moved
  end
  function ops.size(msg) return inventoryOf(msg.name).size() end
  -- 2.2.37: a container item in one of this computer's inventories (vhcc237.lua inv.__inner)
  function ops.inner(msg)
    local inner = inventoryOf(msg.name).__inner
    local fn = inner and inner[msg.fn]
    if not fn then error("Target '" .. tostring(msg.name) .. "' is not an inventory", 0) end
    local args = msg.args or { n = 0 }
    local results = table.pack(fn(msg.slot, msg.inner, table.unpack(args, 1, args.n or #args)))
    if msg.fn ~= "blocked" and msg.fn ~= "peek" then core.touch() end
    return table.unpack(results, 1, results.n)
  end

  handleRequest = function(msg)
    if msg.kind == "evt" then
      if R.onEvent then R.onEvent(msg) end
      return { ok = true, values = { n = 0 } }
    end
    local op = ops[msg.op]
    if not op then return { ok = false, err = "bad request" } end
    serving = serving + 1
    local results = table.pack(pcall(op, msg))
    serving = serving - 1
    if not results[1] then return { ok = false, err = tostring(results[2]) } end
    local values = { n = results.n - 1 }
    for i = 2, results.n do values[i - 1] = results[i] end
    return { ok = true, values = values }
  end

  local function onMessage(msg)
    if type(msg) ~= "table" then return end
    if msg.kind == "res" then
      local waiting = pending[msg.rid]
      if waiting then finish(waiting, msg.ok, msg.values, msg.err) end
      return
    end
    if core.unloaded then return end
    local result = handleRequest(msg)
    if msg.rid then
      send("M" .. msg.from .. ";" .. encode({ kind = "res", rid = msg.rid, ok = result.ok, values = result.values, err = result.err }))
    end
  end

  --- What changed in the directory: fail calls to computers that went away, then let link.lua catch up.
  local function onDirectory(entries)
    local old = directory
    directory = {}
    for _, e in ipairs(entries) do
      if e.entry.id ~= myId then
        e.entry.loaded = e.entry.loaded and e.up
        directory[e.entry.id] = e.entry
      end
    end
    for _, waiting in pairs(pending) do
      local entry = directory[waiting.to]
      if not entry or not entry.loaded or entry.boot ~= waiting.boot then
        finish(waiting, false, nil, notLoaded(waiting.to))
      end
    end
    if R.onDirectory then R.onDirectory(old, directory) end
    -- calls waiting to hear of a holder look again
    for task in pairs(ownerWaits) do queueEvent("task_complete", task, true) end
  end

  local lastSeq = 0
  --- A `ccsim_link` event from the relay: directory lines first, then messages, in order.
  function core.onLink(seq, text)
    if type(seq) ~= "number" or seq <= lastSeq or type(text) ~= "string" then return end
    lastSeq = seq
    local entries
    for line in text:gmatch("[^\n]+") do
      local kind = line:sub(1, 1)
      if kind == "D" then
        local up, id, payload = line:match("^D(%d);(%d+);(.*)$")
        if payload then
          entries = entries or {}
          local entry = decode(payload)
          if type(entry) == "table" then entries[#entries + 1] = { up = up == "1", entry = entry } end
        end
      elseif kind == "M" then
        if entries then
          onDirectory(entries)
          entries = nil
        end
        local payload = line:match("^M%d+;(.*)$")
        if payload then onMessage(decode(payload)) end
      end
    end
    if entries then onDirectory(entries) end
    -- what other computers did here shows in state.json at once, not at this computer's next event
    if core.dirty then core.save() end
  end

  return R
end
