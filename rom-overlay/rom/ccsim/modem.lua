-- ccsim modem: wireless, ender and wired modems, written from CC:Tweaked 1.101.3 (ModemPeripheral, WirelessNetwork,
-- WirelessModemPeripheral, WiredModemPeripheral, WiredNode) and pinned by tools/conformance/modem-compare.mjs against
-- docs/conformance/modems-real.json.
--
-- Every rule lives here, on the receiving side. A sender checks its arguments, freezes the message and hands the packet
-- to its own other modems and to the outbox; the runner's relay (packages/runner/src/network.ts) only passes packets
-- between linked computers. Whoever receives a packet decides from it whether this modem hears it, so one computer's two
-- modems behave the same as two computers, and a lone computer needs no relay at all.
return function(core, host)
  local M = {}

  local OUTBOX = "/results/modem.out"
  local WORLD_LIMIT = 2147483647 -- an ender modem's range; it reaches further than any distance anyway
  local WIRED_RANGE = 256
  local MAX_OPEN = 128
  local DEFAULT_TOP = 320
  local TOPS = { ["minecraft:the_nether"] = 256, ["minecraft:the_end"] = 256 }

  -- The order the real peripheral lists them in
  local WIRELESS_METHODS = { "transmit", "isOpen", "closeAll", "isWireless", "close", "open" }
  local WIRED_METHODS = { "callRemote", "getNameLocal", "transmit", "closeAll", "isOpen", "isWireless", "getMethodsRemote",
    "hasTypeRemote", "getNamesRemote", "close", "isPresentRemote", "open", "getTypeRemote" }
  -- 2.2.36's ender modem: the wireless methods, then the links, then the hub (the real order is not known yet)
  local ENDER_METHODS = { "transmit", "isOpen", "closeAll", "isWireless", "close", "open", "link", "unlink", "getLinks",
    "callRemote", "getMethodsRemote", "hasTypeRemote", "getNamesRemote", "isPresentRemote", "getTypeRemote" }

  -- Taken now: a program may replace these, and the modems keep working underneath it
  local fsOpen, queueEvent = fs.open, os.queueEvent
  local nextPair, format, floor, ceil, sqrt, max = next, string.format, math.floor, math.ceil, math.sqrt, math.max
  local huge = math.huge

  local modems = {}  -- in world order
  local byName = {}

  -- ===== argument checks (VarargArguments, an int argument is a Java cast of a long) =====

  local function badType(index, expected, v)
    error(("bad argument #%d (%s expected, got %s)"):format(index, expected, v == nil and "nil" or type(v)), 0)
  end

  local function javaInt(index, v)
    if type(v) ~= "number" then badType(index, "number", v) end
    if v ~= v then error(("bad argument #%d (number expected, got nan)"):format(index), 0) end
    if v == huge or v == -huge then error(("bad argument #%d (number expected, got %s)"):format(index, v > 0 and "inf" or "-inf"), 0) end
    local n = v < 0 and ceil(v) or floor(v)
    if n >= 9223372036854775807 then return -1 end
    if n <= -9223372036854775808 then return 0 end
    n = n % 4294967296
    if n >= 2147483648 then n = n - 4294967296 end
    return n
  end

  local function channelOf(index, v)
    local channel = javaInt(index, v)
    if channel < 0 or channel > 65535 then error("Expected number in range 0-65535", 0) end
    return channel
  end

  local function stringOf(index, v)
    if type(v) ~= "string" then badType(index, "string", v) end
    return v
  end

  -- ===== messages =====
  -- CC turns a message into Java objects at transmit and back into a fresh Lua value for each receiver, so a message is
  -- frozen when it is sent and every receiver gets its own copy. Shared references and cycles survive, metatables do
  -- not, and a key or value with no Java form (function, coroutine) drops that pair. The text form is one line of
  -- ASCII: a value, then each table in order of first use as "count;key value key value ...".

  local function escapeByte(c) return ("%%%02X"):format(c:byte()) end
  local function unescapeByte(hex) return string.char(tonumber(hex, 16)) end

  local function numberText(v)
    if v ~= v then return "nan" end
    if v == huge then return "inf" end
    if v == -huge then return "-inf" end
    return format("%.17g", v)
  end

  local SURVIVES = { ["nil"] = false, ["boolean"] = true, ["number"] = true, ["string"] = true, ["table"] = true }

  local function encode(root)
    local out, ids, tables = {}, {}, {}
    local function value(v)
      local kind = type(v)
      if kind == "string" then
        local text = v:gsub("[%%%c\127-\255]", escapeByte)
        out[#out + 1] = "s" .. #text .. ":" .. text
      elseif kind == "number" then
        out[#out + 1] = "d" .. numberText(v) .. ";"
      elseif kind == "boolean" then
        out[#out + 1] = v and "T" or "F"
      elseif kind == "table" then
        local id = ids[v]
        if not id then
          id = #tables + 1
          ids[v], tables[id] = id, v
        end
        out[#out + 1] = "r" .. id .. ";"
      else
        out[#out + 1] = "N"
      end
    end
    value(root)
    local i = 1
    while i <= #tables do
      local mark, count = #out + 1, 0
      out[mark] = ""
      for k, v in nextPair, tables[i] do
        if SURVIVES[type(k)] and SURVIVES[type(v)] and k == k then
          value(k)
          value(v)
          count = count + 1
        end
      end
      out[mark] = count .. ";"
      i = i + 1
    end
    return table.concat(out)
  end

  local function decode(text)
    local pos, tables = 1, {}
    local function tableOf(id)
      local t = tables[id]
      if not t then
        t = {}
        tables[id] = t
      end
      return t
    end
    local function value()
      local c = text:sub(pos, pos)
      if c == "s" then
        local colon = text:find(":", pos, true)
        local length = tonumber(text:sub(pos + 1, colon - 1))
        pos = colon + length + 1
        return (text:sub(colon + 1, colon + length):gsub("%%(%x%x)", unescapeByte))
      elseif c == "d" then
        local stop = text:find(";", pos, true)
        local digits = text:sub(pos + 1, stop - 1)
        pos = stop + 1
        if digits == "nan" then return 0 / 0 end
        if digits == "inf" then return huge end
        if digits == "-inf" then return -huge end
        return tonumber(digits)
      elseif c == "r" then
        local stop = text:find(";", pos, true)
        local id = tonumber(text:sub(pos + 1, stop - 1))
        pos = stop + 1
        return tableOf(id)
      end
      pos = pos + 1
      if c == "T" then return true end
      if c == "F" then return false end
      return nil
    end
    local root = value()
    local id = 1
    while pos <= #text do
      local stop = text:find(";", pos, true)
      local count = tonumber(text:sub(pos, stop - 1))
      pos = stop + 1
      local t = tableOf(id)
      for _ = 1, count do
        local k = value()
        t[k] = value()
      end
      id = id + 1
    end
    return root
  end

  M.encode, M.decode = encode, decode

  -- ===== the rules =====

  local function positionOf(modem)
    local p, d = core.position, modem.def
    return { x = d.x or p.x, y = d.y or p.y, z = d.z or p.z, dimension = d.dimension or p.dimension }
  end

  --- WirelessModemPeripheral.getRange and the wired constant. Height is the block the modem sits on.
  local function rangeOf(modem)
    if modem.kind == "ender" then return WORLD_LIMIT end
    if modem.kind == "wired" then return WIRED_RANGE end
    local config, environment = core.config, core.world.environment or {}
    local low, high = config.modemRange, config.modemHighAltitudeRange
    if environment.raining and environment.thunder then
      low, high = config.modemRangeDuringStorm, config.modemHighAltitudeRangeDuringStorm
    end
    local at = positionOf(modem)
    if at.y > 96 and high > low then
      local top = TOPS[at.dimension] or core.config.modemWorldTop or DEFAULT_TOP
      return low + (at.y - 96) * ((high - low) / ((top - 1) - 96))
    end
    return low
  end

  local function deliver(modem, packet, distance, sameDimension)
    if sameDimension then
      queueEvent("modem_message", modem.name, packet.channel, packet.reply, decode(packet.payload), distance)
    else
      queueEvent("modem_message", modem.name, packet.channel, packet.reply, decode(packet.payload))
    end
  end

  --- WirelessNetwork.tryTransmit. A packet that reaches its range limit exactly is still heard.
  local function receiveWireless(modem, packet)
    local at = positionOf(modem)
    if at.dimension ~= packet.dimension then
      if packet.ender or modem.kind == "ender" then deliver(modem, packet, nil, false) end
      return
    end
    local dx, dy, dz = at.x - packet.x, at.y - packet.y, at.z - packet.z
    local square = dx * dx + dy * dy + dz * dz
    local reach = max(packet.range, rangeOf(modem))
    if packet.ender or modem.kind == "ender" or square <= reach * reach then
      deliver(modem, packet, sqrt(square), true)
    end
  end

  --- WiredNode.tryTransmit. Cables that lay the route give its length: `along` reaches the last modem block, `last` is
  --- the step from there to this computer. A network named by id alone has no route, so it is the straight line.
  local function receiveWired(modem, packet)
    if not modem.net or modem.net ~= packet.net then return end
    local at = positionOf(modem)
    if at.dimension ~= packet.dimension then return end
    local route = modem.peers[packet.sender]
    local along, last
    if route then
      along, last = route[1], route[2]
    else
      local dx, dy, dz = at.x - packet.x, at.y - packet.y, at.z - packet.z
      along, last = sqrt(dx * dx + dy * dy + dz * dz), 0
    end
    if along < max(packet.range, WIRED_RANGE) then deliver(modem, packet, along + last, true) end
  end

  local function receive(modem, packet)
    if packet.sender == modem.key or not modem.channels[packet.channel] then return end
    if (packet.kind == "wired") ~= (modem.kind == "wired") then return end
    if modem.kind == "wired" then receiveWired(modem, packet) else receiveWireless(modem, packet) end
  end

  -- Block changes come in bursts (a flow sets a few dozen blocks a tick), and opening the outbox for each one cost
  -- milliseconds of file work, on the computer's own time: they are held here and written together when the
  -- computer next waits for an event, or before anything else this computer sends, so the outbox keeps its order.
  local heldLines = {}
  local function flush()
    if #heldLines == 0 then return end
    local text = table.concat(heldLines, "\n") .. "\n"
    heldLines = {}
    local h = fsOpen(OUTBOX, "a")
    if h then
      h.write(text)
      h.close()
    end
  end

  local function send(line)
    if not core.world.modemLink then return end
    if #heldLines > 0 then
      heldLines[#heldLines + 1] = line
      return flush()
    end
    local h = fsOpen(OUTBOX, "a")
    if h then
      h.write(line .. "\n")
      h.close()
    end
  end

  -- Block worlds (ccsim/turtle) share their changes and ask the runner to start computers through the same outbox
  core.sendHost = send
  --- A block change for the outbox: written at the next flushHost (the event hook calls it before every wait)
  function core.sendHostLater(line)
    if not core.world.modemLink then return end
    heldLines[#heldLines + 1] = line
  end
  core.flushHost = flush

  local function transmit(modem, channel, reply, message)
    local at = positionOf(modem)
    local packet = {
      sender = modem.key, kind = modem.kind, net = modem.net, channel = channel, reply = reply,
      x = at.x, y = at.y, z = at.z, dimension = at.dimension,
      ender = modem.kind == "ender", range = modem.kind == "ender" and 0 or rangeOf(modem),
      payload = encode(message),
    }
    for _, other in ipairs(modems) do receive(other, packet) end
    send("P" .. encode(packet))
  end

  -- ===== packets from linked computers =====

  local lastSeq = 0

  --- A `ccsim_net` event: several coroutines see each one, so its number says whether it has been dealt with.
  function core.onNet(seq, text)
    if type(seq) ~= "number" or seq <= lastSeq or type(text) ~= "string" then return end
    lastSeq = seq
    for line in text:gmatch("[^\n]+") do
      local packet = decode(line)
      if type(packet) == "table" then
        for _, modem in ipairs(modems) do receive(modem, packet) end
      end
    end
  end

  -- ===== remote peripherals on a wired network =====

  local remoteUsers = {} -- peripheral name -> how many of this computer's modems reach it

  --- A peripheral on the cable is one block. The runner names the computer that holds it (`owner`); the others call
  --- it through the relay (ccsim/wiredrelay.lua), so what one computer puts in a chest every computer finds there.
  local placed = {} -- peripheral name -> "here", or the id of the computer that holds it

  local function holderOf(remote)
    local owner = remote.owner
    if type(owner) ~= "number" or owner == core.computerId or not core.wired then return "here" end
    return owner
  end

  local function place(remote)
    local owner = remote.owner
    local held = holderOf(remote) == "here"
    if held and remote.items ~= nil then
      -- this computer holds it now, from what the one that held it before last saved
      core.savedInventories = core.savedInventories or {}
      core.savedInventories[remote.name] = remote.items
    end
    host.attach(remote)
    placed[remote.name] = held and "here" or owner
    if not held then core.wired.attachWired(remote.name, owner) end
  end

  local function unplace(name)
    if placed[name] ~= "here" and core.wired then core.wired.detachWired(name) end
    placed[name] = nil
    host.detach(name)
  end

  --- The computer that held it went away and another holds it now. The program sees the same block throughout.
  local function reown(remote)
    if placed[remote.name] == nil or placed[remote.name] == holderOf(remote) then return end
    unplace(remote.name)
    place(remote)
  end

  local function attachRemote(remote)
    remoteUsers[remote.name] = (remoteUsers[remote.name] or 0) + 1
    if remoteUsers[remote.name] == 1 then place(remote) else reown(remote) end
  end

  local function detachRemote(name)
    remoteUsers[name] = remoteUsers[name] - 1
    if remoteUsers[name] == 0 then
      remoteUsers[name] = nil
      unplace(name)
    end
  end

  local computers = {} -- computer_N name -> its current entry, read by that peripheral's methods

  local function setRemotes(modem, remotes, announce)
    local old, new = {}, {}
    for _, remote in ipairs(modem.remotes) do old[remote.name] = true end
    for _, remote in ipairs(remotes) do
      new[remote.name] = true
      if remote.type == "computer" then computers[remote.name] = remote end
    end
    for _, remote in ipairs(modem.remotes) do
      if not new[remote.name] then
        detachRemote(remote.name)
        if announce then queueEvent("peripheral_detach", remote.name) end
      end
    end
    for _, remote in ipairs(remotes) do
      if not old[remote.name] then
        attachRemote(remote)
        if announce then queueEvent("peripheral", remote.name) end
      elseif remote.type ~= "computer" then
        reown(remote)
      end
    end
    modem.remotes = remotes
  end

  local function reaches(modem, name)
    for _, remote in ipairs(modem.remotes) do
      if remote.name == name then return remote end
    end
    return nil
  end

  --- What a computer on the network is as a peripheral. Only the runner can act on the other computer.
  function M.computerPeripheral(def)
    local methods = {}
    local function control(op) send("C" .. textutils.serializeJSON({ op = op, target = def.id })) end
    function methods.turnOn() control("turnOn") end
    function methods.shutdown() control("shutdown") end
    function methods.reboot() control("reboot") end
    function methods.getID() return def.id end
    function methods.isOn() return computers[def.name].running ~= false end
    function methods.getLabel() return computers[def.name].label end
    return methods
  end

  -- ===== the peripheral =====

  --- Build a modem from its world entry; the runner resolved its network into the entry's extra fields.
  function M.add(def)
    local kind = def.kind or "wireless"
    if kind ~= "wireless" and kind ~= "ender" and kind ~= "wired" then
      error("ccsim: unknown modem kind '" .. tostring(kind) .. "'", 0)
    end
    local modem = {
      name = def.name, def = def, kind = kind, key = def.key or (core.computerId .. "/" .. def.name),
      net = def.net, on = def.on ~= false, localName = def.localName, peers = def.peers or {},
      remotes = {}, channels = {}, open = 0,
    }
    local methods = {}
    modem.methods = methods
    modem.types = kind == "wired" and { "modem", "peripheral_hub" } or { "modem" }
    modem.methodOrder = kind == "wired" and WIRED_METHODS or WIRELESS_METHODS

    function methods.open(channel)
      channel = channelOf(1, channel)
      if modem.channels[channel] then return end
      if modem.open >= MAX_OPEN then error("Too many open channels", 0) end
      modem.channels[channel] = true
      modem.open = modem.open + 1
      core.dirty = true -- state.json lists the open channels: whoever watches the network reads who listens there
    end

    function methods.isOpen(channel)
      return modem.channels[channelOf(1, channel)] == true
    end

    function methods.close(channel)
      channel = channelOf(1, channel)
      if modem.channels[channel] then
        modem.channels[channel] = nil
        modem.open = modem.open - 1
        core.dirty = true
      end
    end

    function methods.closeAll()
      modem.channels, modem.open = {}, 0
      core.dirty = true
    end

    function methods.transmit(channel, reply, message)
      channel, reply = javaInt(1, channel), javaInt(2, reply)
      channelOf(1, channel)
      channelOf(2, reply)
      transmit(modem, channel, reply, message)
    end

    function methods.isWireless()
      return kind ~= "wired"
    end

    if kind == "wired" then
      function methods.getNamesRemote()
        local names = {}
        for i, remote in ipairs(modem.remotes) do names[i] = remote.name end
        return names
      end

      function methods.isPresentRemote(name)
        return reaches(modem, stringOf(1, name)) ~= nil
      end

      function methods.getTypeRemote(name)
        if not reaches(modem, stringOf(1, name)) then return nil end
        return host.getType(name)
      end

      function methods.hasTypeRemote(name, ty)
        name, ty = stringOf(1, name), stringOf(2, ty)
        if not reaches(modem, name) then return nil end
        return host.hasType(name, ty)
      end

      function methods.getMethodsRemote(name)
        if not reaches(modem, stringOf(1, name)) then return nil end
        return host.getMethods(name)
      end

      function methods.callRemote(name, method, ...)
        name, method = stringOf(1, name), stringOf(2, method)
        if not reaches(modem, name) then error("No peripheral: " .. name, 0) end
        local results = table.pack(host.invoke(name, method, ...))
        if not results[1] then error(results[2], 0) end
        return table.unpack(results, 2, results.n)
      end

      function methods.getNameLocal()
        return modem.on and modem.localName or nil
      end
    end

    if kind == "ender" and core.link then
      modem.types = { "modem", "peripheral_hub" }
      modem.methodOrder = ENDER_METHODS
      core.link.extendEnder(methods)
    end

    modems[#modems + 1] = modem
    byName[def.name] = modem
    return modem
  end

  --- A modem taken away (a turtle unequipping it): it hears nothing more, and what it reached goes with it.
  function M.remove(name)
    local modem = byName[name]
    if not modem then return end
    if modem.kind == "wired" then setRemotes(modem, {}, true) end
    byName[name] = nil
    for i, m in ipairs(modems) do
      if m == modem then table.remove(modems, i) break end
    end
  end

  --- Attach what a modem reaches at boot. A computer that starts with them gets no events for them.
  function M.start()
    for _, modem in ipairs(modems) do setRemotes(modem, modem.def.remotes or {}, false) end
  end

  --- Names this modem adds to peripheral.getNames, straight after its own.
  function M.remoteNames(name)
    local out, modem = {}, byName[name]
    if modem and modem.kind == "wired" then
      for i, remote in ipairs(modem.remotes) do out[i] = remote.name end
    elseif modem and modem.kind == "ender" and core.link then
      return core.link.remoteNames()
    end
    return out
  end

  function M.state(name)
    local modem, channels = byName[name], {}
    for channel in pairs(modem.channels) do channels[#channels + 1] = channel end
    table.sort(channels)
    return { kind = modem.kind, channels = channels, net = modem.net, on = modem.on, localName = modem.localName }
  end

  -- ===== host commands =====

  core.extraHandlers = core.extraHandlers or {}

  --- Pick the computer up and put it down somewhere else. Open channels stay, the way a teleported pocket computer's do.
  function core.extraHandlers.setComputerPos(cmd)
    for _, key in ipairs({ "x", "y", "z", "dimension" }) do
      if cmd[key] ~= nil then core.position[key] = cmd[key] end
    end
    return true
  end

  --- The runner reworked the wired network: a modem was switched, or a computer moved or stopped.
  function core.extraHandlers.modemTopology(cmd)
    for name, update in pairs(cmd.modems or {}) do
      local modem = byName[name]
      if modem and modem.kind == "wired" then
        modem.net, modem.on, modem.peers = update.net, update.on ~= false, update.peers or {}
        modem.localName = update.localName or modem.localName
        setRemotes(modem, update.remotes or {}, true)
      end
    end
    return true
  end

  return M
end
