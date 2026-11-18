-- ccsim link: vhcctweaks 2.2.36 linked ender modems and inventory watches (docs/vhcctweaks.md, "2.2.36").
-- Loaded on every computer unless its world opts out with `vhcctweaks: "2.2.35"` or turns the mod off.
--
-- Built on ccsim/wiredrelay.lua: the relay's directory entry also carries owner, dimension, ender modem and links,
-- and linking is decided from that directory. Calls on a linked computer's peripherals travel as relay requests and
-- run there, between its own events; the caller waits for the answer the way CC waits for a main-thread task.
return function(core, host, modems, relay)
  local L = {}

  local queueEvent = os.queueEvent
  local myId = core.computerId
  local request, tell, entryFor, notLoaded = relay.request, relay.tell, relay.entryFor, relay.notLoaded

  local links, linkSet = {}, {}
  local attached = {}   -- linked id -> { rname -> true } of what this computer has attached from it
  local attachedOrder = {} -- linked id -> list of rnames in that computer's order
  local myWatches = {}  -- name as this computer sees it -> { id?, rname }
  local watchCount = 0
  local registry = {}   -- local inventory name -> { sig, watchers = { [key] = { id?, boot? } } }
  local checking = false

  local function sameName(a, b) return a and b and a:lower() == b:lower() end

  --- Who owns this computer: whoever placed it, or for a pocket computer the player holding it.
  local function ownerName()
    if core.kind == "pocket" then
      local i = core.interaction
      local p = i and core.onlinePlayer(i.uuid)
      return p and p.name or nil
    end
    local owner = core.ownerUuid and core.byUuid[core.ownerUuid]
    return owner and owner.name or nil
  end

  function relay.entryFields(entry)
    entry.owner = ownerName()
    entry.dimension = core.position.dimension
    entry.ender = host.hasEnder()
    entry.links = links
  end

  -- what the rest of the sim reaches through core.link
  L.entryFor = entryFor
  L.request = request
  L.publish = relay.publish
  L.attachWired = relay.attachWired
  L.detachWired = relay.detachWired

  -- ===== remote peripherals =====

  local function displayName(id, rname) return id .. ":" .. rname end

  local function dropWatchesOf(id, rname)
    for name, watch in pairs(myWatches) do
      if watch.id == id and (rname == nil or watch.rname == rname) then
        myWatches[name] = nil
        watchCount = watchCount - 1
      end
    end
  end

  --- Make what this computer has attached from `id` match that computer's peripherals now.
  local function reconcile(id, announce)
    local entry = entryFor(id)
    local want, wantOrder = {}, {}
    if linkSet[id] and entry and entry.loaded then
      for _, p in ipairs(entry.peripherals or {}) do
        want[p.name] = p
        wantOrder[#wantOrder + 1] = p.name
      end
    end
    local have = attached[id] or {}
    for _, rname in ipairs(attachedOrder[id] or {}) do
      if not want[rname] then
        host.detachRemote(displayName(id, rname))
        dropWatchesOf(id, rname)
        if announce then queueEvent("peripheral_detach", displayName(id, rname)) end
      end
    end
    local now = {}
    for _, rname in ipairs(wantOrder) do
      now[rname] = true
      if not have[rname] then
        host.attachRemote(displayName(id, rname), want[rname], id, rname)
        if announce then queueEvent("peripheral", displayName(id, rname)) end
      end
    end
    attached[id], attachedOrder[id] = now, wantOrder
  end

  function relay.afterPublish()
    if linkSet[myId] then reconcile(myId, true) end
  end

  --- Names the ender modem adds to peripheral.getNames. A computer serving another one passes on none of them.
  function L.remoteNames()
    local out = {}
    if relay.serving() then return out end
    for _, id in ipairs(links) do
      for _, rname in ipairs(attachedOrder[id] or {}) do out[#out + 1] = displayName(id, rname) end
    end
    return out
  end

  function L.isRemote(name)
    if relay.serving() then return false end
    local id, rname = name:match("^(%d+):(.+)$")
    id = tonumber(id)
    return id ~= nil and attached[id] ~= nil and attached[id][rname] == true
  end

  --- The error for a peripheral of a linked computer that is not loaded, or nil.
  function L.ghost(name)
    if type(name) ~= "string" then return nil end
    local id = tonumber(name:match("^(%d+):"))
    if not id or not linkSet[id] then return nil end
    local entry = entryFor(id)
    if not entry or not entry.loaded then return notLoaded(id) end
    return nil
  end

  -- ===== the ender modem's methods =====

  local function javaInt(index, v)
    if type(v) ~= "number" then
      error(("bad argument #%d (number expected, got %s)"):format(index, v == nil and "nil" or type(v)), 0)
    end
    if v ~= v or v == math.huge or v == -math.huge then
      error(("bad argument #%d (number expected, got %s)"):format(index, tostring(v)), 0)
    end
    return v < 0 and math.ceil(v) or math.floor(v)
  end

  local function stringArg(index, v)
    if type(v) ~= "string" then
      error(("bad argument #%d (string expected, got %s)"):format(index, v == nil and "nil" or type(v)), 0)
    end
    return v
  end

  function L.link(id)
    id = javaInt(1, id)
    -- A link that exists is always fine; the rules are checked for a new one only
    if linkSet[id] then return true end
    local entry = entryFor(id)
    if not entry or not entry.loaded then return false, "not loaded" end
    local mine = ownerName()
    if not mine or not entry.owner or not sameName(mine, entry.owner) then return false, "not your computer" end
    if not entry.ender then return false, "no ender modem" end
    if entry.dimension ~= core.position.dimension then return false, "other dimension" end
    if #links >= core.config.maxLinksPerComputer then return false, "too many links" end
    links[#links + 1] = id
    linkSet[id] = true
    relay.publish()
    reconcile(id, true)
    return true
  end

  function L.unlink(id)
    id = javaInt(1, id)
    if not linkSet[id] then return false end
    linkSet[id] = nil
    for i, other in ipairs(links) do
      if other == id then table.remove(links, i) break end
    end
    reconcile(id, true)
    attached[id], attachedOrder[id] = nil, nil
    dropWatchesOf(id)
    relay.publish()
    return true
  end

  function L.getLinks()
    local out = {}
    for i, id in ipairs(links) do out[i] = id end
    return out
  end

  --- Methods an ender modem gains on 2.2.36: link, unlink, getLinks and the peripheral hub methods.
  function L.extendEnder(methods)
    methods.link = L.link
    methods.unlink = L.unlink
    methods.getLinks = L.getLinks

    function methods.getNamesRemote() return L.remoteNames() end

    function methods.isPresentRemote(name)
      return L.isRemote(stringArg(1, name))
    end

    function methods.getTypeRemote(name)
      name = stringArg(1, name)
      if not L.isRemote(name) then return nil end
      return host.getType(name)
    end

    function methods.hasTypeRemote(name, ty)
      name, ty = stringArg(1, name), stringArg(2, ty)
      if not L.isRemote(name) then return nil end
      return host.hasType(name, ty)
    end

    function methods.getMethodsRemote(name)
      name = stringArg(1, name)
      if not L.isRemote(name) then return nil end
      return host.getMethods(name)
    end

    function methods.callRemote(name, method, ...)
      name, method = stringArg(1, name), stringArg(2, method)
      if not L.isRemote(name) then error(L.ghost(name) or ("No peripheral: " .. name), 0) end
      local results = table.pack(host.invoke(name, method, ...))
      if not results[1] then error(results[2], 0) end
      return table.unpack(results, 2, results.n)
    end
  end

  -- ===== inventory watches =====

  local function signature(items)
    local parts = {}
    for slot, item in pairs(items) do
      -- __rev: a 2.2.37 backpack whose contents changed is set back in its slot, which the block reports as a change
      parts[#parts + 1] = tostring(slot) .. "=" .. tostring(item.name) .. "#" .. tostring(item.count) .. "#" .. tostring(item.nbt)
        .. "#" .. tostring(item.__rev)
    end
    table.sort(parts)
    return table.concat(parts, ";")
  end

  local function anyWatched() return next(registry) ~= nil end

  local check
  local function arm()
    if checking or not anyWatched() then return end
    checking = true
    -- The end of this server tick: changes within one tick make one event
    local now = os.clock()
    local rest = 0.05 - (now % 0.05)
    if rest < 0.001 then rest = 0.05 end
    core.after(rest, check)
  end

  check = function()
    checking = false
    if core.unloaded then return end
    if core.beforeObserve then core.beforeObserve() end
    for name, rec in pairs(registry) do
      local inv = host.localInventory(name)
      if not inv then
        -- the peripheral went away: its watches end
        for key in pairs(rec.watchers) do
          if key == "local" and myWatches[name] then
            myWatches[name] = nil
            watchCount = watchCount - 1
          end
        end
        registry[name] = nil
      else
        local sig = signature(inv.__state())
        if sig ~= rec.sig then
          rec.sig = sig
          for key, watcher in pairs(rec.watchers) do
            if key == "local" then
              queueEvent("inventory_changed", name)
            else
              tell(watcher.id, { kind = "evt", ev = "inv", name = name })
            end
          end
        end
      end
    end
    arm()
  end

  local function register(name, key, watcher)
    local inv = host.localInventory(name)
    if not inv then error("No peripheral: " .. name, 0) end
    local rec = registry[name]
    if not rec then
      rec = { sig = signature(inv.__state()), watchers = {} }
      registry[name] = rec
    end
    rec.watchers[key] = watcher
    arm()
  end

  local function unregister(name, key)
    local rec = registry[name]
    if not rec then return end
    rec.watchers[key] = nil
    if next(rec.watchers) == nil then registry[name] = nil end
  end

  --- inventory.watch() as this computer calls it; `id`/`rname` for a linked computer's inventory.
  function L.watch(name, id, rname)
    if myWatches[name] then return end
    if watchCount >= core.config.maxWatchesPerComputer then error("too many watches (max " .. core.config.maxWatchesPerComputer .. ")", 0) end
    if id then
      request(id, { kind = "req", op = "watch", name = rname, wired = relay.holderOf(name) == id or nil }, false)
    else
      register(name, "local", {})
    end
    myWatches[name] = { id = id, rname = rname }
    watchCount = watchCount + 1
  end

  function L.unwatch(name, id, rname)
    if not myWatches[name] then return end
    myWatches[name] = nil
    watchCount = watchCount - 1
    if id then
      tell(id, { kind = "req", op = "unwatch", name = rname })
    else
      unregister(name, "local")
    end
  end

  --- Drop the watches computers placed here once they reboot, unload or unlink.
  local function pruneWatchers()
    for name, rec in pairs(registry) do
      for key, watcher in pairs(rec.watchers) do
        if key ~= "local" then
          local entry = entryFor(watcher.id)
          local gone = not entry or not entry.loaded or entry.boot ~= watcher.boot
          if not gone and watcher.id ~= myId and not watcher.wired then
            gone = true
            for _, linked in ipairs(entry.links or {}) do
              if linked == myId then gone = false break end
            end
          end
          if gone then rec.watchers[key] = nil end
        end
      end
      if next(rec.watchers) == nil then registry[name] = nil end
    end
  end

  -- ===== requests from other computers =====

  function relay.ops.watch(msg)
    if not relay.exported(msg.name) or not host.localInventory(msg.name) then error("No peripheral: " .. tostring(msg.name), 0) end
    register(msg.name, msg.from, { id = msg.from, boot = msg.boot, wired = msg.wired })
  end

  function relay.ops.unwatch(msg) unregister(msg.name, msg.from) end

  function relay.onEvent(msg)
    local name = displayName(msg.from, msg.name)
    if msg.ev == "inv" then
      if myWatches[name] then queueEvent("inventory_changed", name)
      elseif relay.holderOf(msg.name) == msg.from and myWatches[msg.name] then queueEvent("inventory_changed", msg.name) end
    elseif msg.ev == "touch" then
      if linkSet[msg.from] and attached[msg.from] and attached[msg.from][msg.name] then
        -- a fresh interaction here as well, then who before where, as for a local touch
        local p = msg.player and core.findPlayer(msg.player)
        if p then
          core.recordInteraction(p.uuid, core.nowMs())
          core.dirty = true
        end
        if msg.player then queueEvent("vhcc_touch", msg.player) end
        queueEvent("monitor_touch", name, msg.x, msg.y, "ccsim")
      end
    end
  end

  --- What changed in the directory: attach, detach, drop stale watches, place watches again on rebooted computers.
  function relay.onDirectory(old, directory)
    for _, id in ipairs(links) do
      local before, now = old[id], directory[id]
      reconcile(id, true)
      -- a computer that rebooted lost the watches placed on it; place them again
      if before and now and now.loaded and before.boot ~= now.boot then
        for _, watch in pairs(myWatches) do
          if watch.id == id then tell(id, { kind = "req", op = "watch", name = watch.rname }) end
        end
      end
    end
    -- the same for the computers holding peripherals on this computer's cable
    for id in pairs(relay.holders()) do
      local before, now = old[id], directory[id]
      if not linkSet[id] and before and now and now.loaded and before.boot ~= now.boot then
        for _, watch in pairs(myWatches) do
          if watch.id == id then tell(id, { kind = "req", op = "watch", name = watch.rname, wired = true }) end
        end
      end
    end
    pruneWatchers()
  end

  --- A player touched one of this computer's monitors: every computer linked here hears it too.
  function L.onTouch(side, x, y, player)
    if not relay.exported(side) then return end
    local msg = { kind = "evt", ev = "touch", name = side, x = x, y = y, player = player }
    for id, entry in pairs(relay.directory()) do
      if entry.loaded then
        for _, linked in ipairs(entry.links or {}) do
          if linked == myId then
            tell(id, { kind = msg.kind, ev = msg.ev, name = side, x = x, y = y, player = player })
            break
          end
        end
      end
    end
    if linkSet[myId] then tell(myId, msg) end
  end

  return L
end
