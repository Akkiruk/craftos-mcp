-- ccsim ap/simple: playerDetector, chatBox, energyDetector, redstoneIntegrator, nbtStorage.
-- Behaviour follows AdvancedPeripherals 0.7.30r source (see ap/base.lua).
return function(core, B)
  local F = {}

  local function pos(def)
    return { x = math.floor(def.x or 0), y = math.floor(def.y or 64), z = math.floor(def.z or 0) }
  end

  local function dimensionOf(def) return def.dimension or "minecraft:overworld" end

  -- ===== playerDetector =====

  --- CoordUtil: ranges are axis-aligned boxes around the block position, checked with
  --- AABB.contains (min inclusive, max exclusive) on the player's position.
  local function inBox(p, a, b)
    return p.x >= math.min(a.x, b.x) and p.x < math.max(a.x, b.x)
      and p.y >= math.min(a.y, b.y) and p.y < math.max(a.y, b.y)
      and p.z >= math.min(a.z, b.z) and p.z < math.max(a.z, b.z)
  end

  function F.playerDetector(def)
    local self = B.new(def)
    local m = self.methods
    local origin, dimension = pos(def), dimensionOf(def)
    local maxRange = B.config.playerDetMaxRange

    local function players() return core.players end

    local function rangeBox(range)
      range = math.min(range, maxRange)
      return { x = origin.x - range, y = origin.y - range, z = origin.z - range },
        { x = origin.x + range, y = origin.y + range, z = origin.z + range }
    end

    local function inRange(p, range)
      if not p.online or p.dimension ~= dimension then return false end
      local lo, hi = rangeBox(range)
      return inBox(p, lo, hi)
    end

    local function inCubic(p, x, y, z)
      if not p.online or p.dimension ~= dimension then return false end
      x, y, z = math.min(x * 2, maxRange), math.min(y * 2, maxRange), math.min(z * 2, maxRange)
      return inBox(p, { x = origin.x - x, y = origin.y - y, z = origin.z - z },
        { x = origin.x + x, y = origin.y + y, z = origin.z + z })
    end

    local function blockPos(index, tbl)
      tbl = B.table(index, tbl)
      if type(tbl.x) ~= "number" or type(tbl.y) ~= "number" or type(tbl.z) ~= "number" then
        error("Table should be block position table", 0)
      end
      return { x = math.floor(tbl.x), y = math.floor(tbl.y), z = math.floor(tbl.z) }
    end

    local function inCoords(p, first, second)
      if not p.online or p.dimension ~= dimension then return false end
      local dx, dz = p.x - origin.x, p.z - origin.z
      if math.sqrt(dx * dx + dz * dz) > maxRange then return false end
      return inBox(p, first, second)
    end

    local function names(filter)
      local out = {}
      for _, p in ipairs(players()) do
        if filter(p) then out[#out + 1] = p.name end
      end
      return out
    end

    local function any(filter)
      for _, p in ipairs(players()) do if filter(p) then return true end end
      return false
    end

    function m.getOnlinePlayers()
      return names(function(p) return p.online end)
    end

    function m.getPlayersInCoords(first, second)
      local a, b = blockPos(1, first), blockPos(2, second)
      return names(function(p) return inCoords(p, a, b) end)
    end

    function m.getPlayersInCubic(x, y, z)
      x, y, z = B.int(1, x), B.int(2, y), B.int(3, z)
      return names(function(p) return inCubic(p, x, y, z) end)
    end

    function m.getPlayersInRange(range)
      range = B.int(1, range)
      return names(function(p) return inRange(p, range) end)
    end

    function m.isPlayersInCoords(first, second)
      local a, b = blockPos(1, first), blockPos(2, second)
      return any(function(p) return inCoords(p, a, b) end)
    end

    function m.isPlayersInCubic(x, y, z)
      x, y, z = B.int(1, x), B.int(2, y), B.int(3, z)
      return any(function(p) return inCubic(p, x, y, z) end)
    end

    function m.isPlayersInRange(range)
      range = B.int(1, range)
      return any(function(p) return inRange(p, range) end)
    end

    function m.isPlayerInCoords(first, second, username)
      local a, b = blockPos(1, first), blockPos(2, second)
      username = B.string(3, username)
      return any(function(p) return inCoords(p, a, b) and p.name == username end)
    end

    function m.isPlayerInCubic(x, y, z, username)
      x, y, z = B.int(1, x), B.int(2, y), B.int(3, z)
      username = B.string(4, username)
      return any(function(p) return inCubic(p, x, y, z) and p.name == username end)
    end

    function m.isPlayerInRange(range, username)
      range = B.int(1, range)
      username = B.string(2, username)
      return any(function(p) return inRange(p, range) and p.name == username end)
    end

    function m.getPlayerPos(username)
      username = B.string(1, username)
      if not B.config.enablePlayerPosFunction then
        error("This function is disabled in the config. Activate it or ask an admin if he can activate it.", 0)
      end
      local found
      for _, p in ipairs(players()) do
        if p.name == username then
          if inRange(p, maxRange) then found = p end
          break
        end
      end
      if not found then return {} end
      local info = { x = math.floor(found.x), y = math.floor(found.y), z = math.floor(found.z) }
      if B.config.morePlayerInformation then
        info.yaw = found.yaw
        info.pitch = found.pitch
        info.dimension = found.dimension
        info.eyeHeight = 1.62
      end
      return info
    end

    return self
  end

  -- ===== chatBox =====

  function F.chatBox(def)
    local self = B.new(def)
    local m = self.methods
    local origin, dimension = pos(def), dimensionOf(def)
    local cooldown = B.config.chatMessageCooldown
    B.addOperation(self, "chatMessage", {
      name = "chatMessage", type = "SimpleFreeOperation", cooldown = cooldown,
    })

    local function checkBrackets(brackets)
      return brackets ~= nil and #brackets ~= 2
    end

    local function prefixText(prefix)
      local text = prefix
      if prefix ~= "" and (prefix:sub(1, 1) == "{" or prefix:sub(1, 1) == "[" or prefix:sub(1, 1) == '"') then
        local ok, parsed = pcall(textutils.unserializeJSON, prefix)
        if ok and type(parsed) == "table" and parsed.text then text = parsed.text
        elseif ok and type(parsed) == "string" then text = parsed end
      end
      return text
    end

    -- Real format, read back from the game's chat: <color><open>§r<prefix><color><close>§r <message>. A & code is
    -- passed through as text, and § is one byte here (0xA7), as in CC strings.
    local RESET = "\167r"
    local function compose(message, prefix, brackets, bracketColor)
      if prefix == nil then prefix = B.config.defaultChatBoxPrefix end
      if brackets == nil or brackets == "" then brackets = "[]" end
      bracketColor = bracketColor or ""
      return bracketColor .. brackets:sub(1, 1) .. RESET .. prefixText(prefix) .. bracketColor .. brackets:sub(2, 2) .. RESET .. " " .. message
    end

    local function lookup(nameOrUuid)
      if nameOrUuid:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then
        local p = core.byUuid[nameOrUuid:lower()]
        return p and p.online and p or nil
      end
      local p = core.byName[nameOrUuid:lower()]
      return p and p.online and p or nil
    end

    local function deliver(player, text)
      core.chat[#core.chat + 1] = {
        to = player.name, text = text, time = core.instant(), kind = "chatBox", from = def.name,
      }
    end

    function m.sendMessage(message, prefix, brackets, bracketColor, range)
      message = B.string(1, message)
      prefix = B.optString(2, prefix)
      brackets = B.optString(3, brackets)
      bracketColor = B.optString(4, bracketColor)
      range = B.optInt(5, range, -1)
      return B.perform(self, "chatMessage", cooldown, nil, function()
        if checkBrackets(brackets) then return nil, "incorrect bracket string (e.g. [], {}, <>, ...)" end
        local text = compose(message, prefix, brackets, bracketColor)
        for _, p in ipairs(core.players) do
          if p.online then
            local near = true
            if range ~= -1 then
              near = p.dimension == dimension
                and math.abs(p.x - origin.x) <= range and math.abs(p.y - origin.y) <= range
                and math.abs(p.z - origin.z) <= range
            end
            if near then deliver(p, text) end
          end
        end
        core.save()
        return true
      end)
    end

    function m.sendMessageToPlayer(message, username, prefix, brackets, bracketColor)
      message = B.string(1, message)
      username = B.string(2, username)
      prefix = B.optString(3, prefix)
      brackets = B.optString(4, brackets)
      bracketColor = B.optString(5, bracketColor)
      return B.perform(self, "chatMessage", cooldown, nil, function()
        local player = lookup(username)
        if not player then return nil, "incorrect player name/uuid" end
        if checkBrackets(brackets) then return nil, "incorrect bracket string (e.g. [], {}, <>, ...)" end
        deliver(player, compose(message, prefix, brackets, bracketColor))
        core.save()
        return true
      end)
    end


    -- Advanced Peripherals' own formatted messages: the message is a JSON text component (Component.Serializer). The
    -- chat log keeps its plain text (text, translate or keybind of each part, then its extras), after the prefix.
    local function componentText(c)
      local kind = type(c)
      if kind == "string" or kind == "number" or kind == "boolean" then return tostring(c) end
      if kind ~= "table" then return nil end
      if c[1] ~= nil then
        local parts = {}
        for i, part in ipairs(c) do
          parts[i] = componentText(part)
          if parts[i] == nil then return nil end
        end
        return table.concat(parts)
      end
      local text = c.text or c.translate or c.keybind
      if text == nil then return nil end
      local parts = { tostring(text) }
      if type(c.extra) == "table" then
        for _, part in ipairs(c.extra) do
          local t = componentText(part)
          if t == nil then return nil end
          parts[#parts + 1] = t
        end
      end
      return table.concat(parts)
    end

    --- The component's text, or nil, "incorrect json" when it parses to no component (as fromJson's null)
    local function parseComponent(json)
      local ok, value = pcall(textutils.unserializeJSON, json)
      if not ok or value == nil then return nil end
      return componentText(value)
    end

    function m.sendFormattedMessage(json, prefix, brackets, bracketColor, range)
      json = B.string(1, json)
      prefix = B.optString(2, prefix)
      brackets = B.optString(3, brackets)
      bracketColor = B.optString(4, bracketColor)
      range = B.optInt(5, range, -1)
      return B.perform(self, "chatMessage", cooldown, nil, function()
        local text = parseComponent(json)
        if text == nil then return nil, "incorrect json" end
        if checkBrackets(brackets) then return nil, "incorrect bracket string (e.g. [], {}, <>, ...)" end
        local line = compose(text, prefix, brackets, bracketColor) -- appendPrefix, then the component
        for _, p in ipairs(core.players) do
          if p.online then
            local near = true
            if range ~= -1 then
              near = p.dimension == dimension
                and math.abs(p.x - origin.x) <= range and math.abs(p.y - origin.y) <= range
                and math.abs(p.z - origin.z) <= range
            end
            if near then deliver(p, line) end
          end
        end
        core.save()
        return true
      end)
    end

    function m.sendFormattedMessageToPlayer(json, username, prefix, brackets, bracketColor)
      json = B.string(1, json)
      username = B.string(2, username)
      prefix = B.optString(3, prefix)
      brackets = B.optString(4, brackets)
      bracketColor = B.optString(5, bracketColor)
      return B.perform(self, "chatMessage", cooldown, nil, function()
        local player = lookup(username)
        if not player then return nil, "incorrect player name/uuid" end
        local text = parseComponent(json)
        if text == nil then return nil, "incorrect json" end
        if checkBrackets(brackets) then return nil, "incorrect bracket string (e.g. [], {}, <>, ...)" end
        deliver(player, compose(text, prefix, brackets, bracketColor))
        core.save()
        return true
      end)
    end

    return self
  end

  -- ===== energyDetector =====

  function F.energyDetector(def)
    local self = B.new(def)
    local m = self.methods
    local limit = def.transferRateLimit or B.config.energyDetectorMaxFlow
    function m.getTransferRateLimit() return limit end
    function m.setTransferRateLimit(rate)
      rate = B.number(1, rate)
      limit = math.floor(math.max(0, math.min(B.config.energyDetectorMaxFlow, rate)))
    end
    function m.getTransferRate() return def.transferRate or 0 end
    self.setters = {
      transferRate = function(value) def.transferRate = value end,
    }
    function self.state() return { transferRate = def.transferRate or 0, transferRateLimit = limit } end
    return self
  end

  -- ===== redstoneIntegrator =====

  function F.redstoneIntegrator(def)
    local self = B.new(def)
    local m = self.methods
    local output = {}
    local input = {}
    for side, level in pairs(def.inputs or {}) do input[B.direction(side, def.orientation)] = level end

    local function dir(side)
      return B.direction(B.string(1, side), def.orientation)
    end

    local function clamp(power)
      return math.max(0, math.min(15, math.floor(power)))
    end

    function m.getInput(side) return (input[dir(side)] or 0) > 0 end
    function m.getOutput(side) return (output[dir(side)] or 0) > 0 end
    function m.getAnalogInput(side) return input[dir(side)] or 0 end
    function m.getAnalogOutput(side) return output[dir(side)] or 0 end
    m.getAnalogueInput, m.getAnalogueOutput = m.getAnalogInput, m.getAnalogOutput

    function m.setOutput(side, power)
      local d = dir(side)
      power = B.boolean(2, power)
      output[d] = power and 15 or 0
    end

    function m.setAnalogOutput(side, power)
      local d = dir(side)
      output[d] = clamp(B.int(2, power))
    end
    m.setAnalogueOutput = m.setAnalogOutput

    self.setters = {
      input = function(side, level) input[B.direction(side, def.orientation)] = clamp(level) end,
    }
    self.outputs = output
    function self.state() return { outputs = output, inputs = input } end
    return self
  end

  -- ===== nbtStorage =====

  function F.nbtStorage(def)
    local self = B.new(def)
    local m = self.methods
    local stored = B.copy(def.stored or {})
    self.extraConfig.maxSize = B.config.nbtStorageMaxSize

    function m.read() return B.copy(stored) end

    function m.writeJson(jsonData)
      jsonData = B.string(1, jsonData)
      if #jsonData > B.config.nbtStorageMaxSize then return nil, "JSON size is bigger than allowed" end
      local parsed, err = B.snbt(jsonData)
      if type(parsed) ~= "table" then
        return nil, "Cannot parse json: " .. tostring(err or "Expected compound")
      end
      stored = parsed
      return true
    end

    function self.state() return stored end
    return self
  end

  -- ===== speaker =====
  -- The headless engine refuses CraftOS-PC's speaker (no audio device), so a speaker is a recording fake. Its rules
  -- were measured on a real speaker (tools/conformance/peripheral_probe.lua): sounds are never refused, even many in
  -- one tick; only notes are limited, to 8 per game tick; only a malformed name errors, an unknown sound returns true.
  -- The calls land in state.json under peripherals.<name>.sounds (the last 300) with a running count.
  local INSTRUMENTS = {
    harp = true, basedrum = true, snare = true, hat = true, bass = true, flute = true, bell = true, guitar = true,
    chime = true, xylophone = true, iron_xylophone = true, cow_bell = true, didgeridoo = true, bit = true, banjo = true,
    pling = true,
  }

  function F.speaker(def)
    local self = { methods = {} }
    local m = self.methods
    local NOTES_PER_TICK = 8
    local KEEP = 300
    local log, total, refused = {}, 0, 0
    local noteTick, notesThisTick = -1, 0

    local function number(index, v, default)
      if v == nil then return default end
      return B.number(index, v)
    end

    local function validLocation(name)
      local ns, path = name:match("^([^:]*):(.*)$")
      if not ns then ns, path = "minecraft", name end
      return ns:match("^[a-z0-9_.-]*$") ~= nil and path:match("^[a-z0-9/._-]*$") ~= nil
    end

    local function record(entry, ok)
      entry.ok = ok
      if not ok then refused = refused + 1 end
      total = total + 1
      entry.t = core.nowMs()
      log[#log + 1] = entry
      if #log > KEEP then table.remove(log, 1) end
      return ok
    end

    -- ----- DFPWM audio, after CC:Tweaked 1.101.3 SpeakerPeripheral and DfpwmState -----
    -- A speaker holds one pending buffer. playAudio returns false while it is full. Once per server tick, update()
    -- sends the pending buffer when the client is within 0.5 s of running out (always true at the start), then
    -- queues speaker_audio_empty for the attached computer. The first push is sent on the next tick, and each
    -- later push goes out 0.5 s before the previous one finishes playing.
    local SAMPLE_RATE = 48000
    local CLIENT_BUFFER_MS = 500
    local MAX_SAMPLES = 128 * 1024
    local TICK = 0.05
    local audio          -- nil or { pending = { bytes, volume } | nil, clientEnd = ms, unplayed = bool, volume }
    local stopRequested = false
    local updateTimer
    local audioStats = { pushed = 0, full = 0, sent = 0, events = 0, sentMs = 0 }

    local function isPlaying(a) return a.unplayed or a.clientEnd >= core.nowMs() end

    local update
    local function scheduleUpdate(delay)
      if updateTimer then
        os.cancelTimer(updateTimer)
        core.simTimers[updateTimer] = nil
      end
      updateTimer = core.after(delay, update)
    end

    -- The next tick update() has work on: a stop, or the pending buffer coming due
    local function wake()
      if stopRequested then return scheduleUpdate(TICK) end
      if not (audio and audio.pending) then return end
      local wait = (audio.clientEnd - CLIENT_BUFFER_MS - core.nowMs()) / 1000
      scheduleUpdate(math.max(1, math.ceil(wait / TICK - 1e-9)) * TICK)
    end

    update = function()
      updateTimer = nil
      if stopRequested then
        -- stop() takes effect here: audio pushed after it in the same tick is dropped with it
        stopRequested = false
        audio = nil
        log[#log + 1] = { kind = "stop", t = core.nowMs(), ok = true }
        if #log > KEEP then table.remove(log, 1) end
        return
      end
      local a = audio
      if not (a and a.pending) then return end
      local now = core.nowMs()
      if now < a.clientEnd - CLIENT_BUFFER_MS then return wake() end
      local chunk = a.pending
      a.pending = nil
      local ms = chunk.bytes * 8 * 1000 / SAMPLE_RATE
      a.clientEnd = math.max(now, a.clientEnd) + ms
      a.unplayed = false
      audioStats.sent = audioStats.sent + 1
      audioStats.sentMs = audioStats.sentMs + ms
      audioStats.events = audioStats.events + 1
      os.queueEvent("speaker_audio_empty", def.name)
    end

    local function checkFinite(index, v)
      if v ~= v then error(("bad argument #%d (number expected, got nan)"):format(index), 0) end
      if v == math.huge then error(("bad argument #%d (number expected, got inf)"):format(index), 0) end
      if v == -math.huge then error(("bad argument #%d (number expected, got -inf)"):format(index), 0) end
    end

    function m.playAudio(samples, volume)
      B.table(1, samples)
      if volume ~= nil then
        B.number(2, volume)
        checkFinite(2, volume)
      end
      local length = #samples
      if length <= 0 then error("Cannot play empty audio", 0) end
      if length > MAX_SAMPLES then error("Audio data is too large", 0) end

      if not audio or not isPlaying(audio) then
        audio = { clientEnd = core.nowMs(), unplayed = true, volume = 1 }
      end
      if audio.pending then
        audioStats.full = audioStats.full + 1
        return record({ kind = "audio", samples = length }, false)
      end

      -- 8 samples make one byte; a tail shorter than 8 is dropped unchecked
      local bytes = math.floor(length / 8)
      for i = 1, bytes * 8 do
        local level = samples[i]
        if type(level) ~= "number" then
          error(("table item #%d is not number (got %s)"):format(i, level == nil and "nil" or type(level)), 0)
        end
        if level ~= level or level == math.huge or level == -math.huge then
          error(("table item #%d is not number (got %s)"):format(i, level ~= level and "nan" or (level > 0 and "inf" or "-inf")), 0)
        end
        level = level >= 0 and math.floor(level) or math.ceil(level)
        if level < -128 or level > 127 then
          error(("table item #%d must be between -128 and 127"):format(i), 0)
        end
      end

      if volume ~= nil then audio.volume = math.max(0, math.min(3, volume)) end
      audio.pending = { bytes = bytes, volume = audio.volume }
      audioStats.pushed = audioStats.pushed + 1
      if not updateTimer then wake() end
      return record({ kind = "audio", samples = length, volume = audio.volume }, true)
    end

    function m.playSound(name, volume, pitch)
      name = B.string(1, name)
      volume = math.max(0, math.min(3, number(2, volume, 1)))
      pitch = math.max(0, math.min(2, number(3, pitch, 1)))
      if not validLocation(name) then error("Malformed sound name '" .. name .. "' ", 0) end
      -- refused while a DFPWM stream is playing; otherwise it ends the stream
      if audio and isPlaying(audio) then
        return record({ kind = "sound", name = name, volume = volume, pitch = pitch }, false)
      end
      audio = nil
      return record({ kind = "sound", name = name, volume = volume, pitch = pitch }, true)
    end

    function m.playNote(instrument, volume, pitch)
      instrument = B.string(1, instrument)
      volume = math.max(0, math.min(3, number(2, volume, 1)))
      pitch = math.max(0, math.min(24, number(3, pitch, 1)))
      -- the real message really does print null: CC formats the failed instrument lookup, not the name
      if not INSTRUMENTS[instrument] then error('Invalid instrument, "null"!', 0) end
      local tick = math.floor(core.nowMs() / 50)
      if tick ~= noteTick then noteTick, notesThisTick = tick, 0 end
      notesThisTick = notesThisTick + 1
      return record({ kind = "note", name = instrument, volume = volume, pitch = pitch }, notesThisTick <= NOTES_PER_TICK)
    end

    function m.stop()
      stopRequested = true
      scheduleUpdate(TICK)
    end

    function self.state()
      local copy = {}
      for i, e in ipairs(log) do copy[i] = e end
      local a = audio
      return {
        total = total, refused = refused, sounds = copy,
        audio = {
          pushed = audioStats.pushed, full = audioStats.full, sent = audioStats.sent, events = audioStats.events,
          sentMs = math.floor(audioStats.sentMs), playing = a ~= nil and isPlaying(a), pending = a ~= nil and a.pending ~= nil,
        },
      }
    end

    return self
  end

  return F
end
