-- ccsim ap/simple: playerDetector, chatBox, energyDetector, redstoneIntegrator, nbtStorage.
-- Behaviour follows AdvancedPeripherals 0.7.30r source on 1.18.2, and the 0.7.48r (1.20.1) and 0.7.62b (1.21.1) tags
-- for the detector and chat box there (newPlayerDetector, newChatBox; see ap/base.lua). The energy detector, redstone
-- integrator and NBT storage did not change; 1.21.1 has no redstone integrator (ap/types.lua refuses it).
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

  --- The player detector of 0.7.48r (1.20.1) and 0.7.62b (1.21.1): CoordUtil's block-centre ranges, every dimension
  --- seen while the range is unlimited (the default), getPlayerPos with decimals and more fields.
  local function newPlayerDetector(def)
    local self = B.new(def)
    local m = self.methods
    local origin, dimension = pos(def), dimensionOf(def)
    local maxRange = B.config.playerDetMaxRange

    local function multiDimensional()
      if not B.config.playerDetMultiDimensional then return false end
      -- 0.7.48r also takes the old default (100000000) as unlimited; 0.7.62b only -1
      if B.V20 then return maxRange == -1 or maxRange >= 100000000 end
      return maxRange == -1
    end

    local function visible(p)
      if not p.online then return false end
      if B.V21 and not B.config.showSpectators and p.gamemode == "spectator" then return false end
      return true
    end

    --- 0.7.48r: every player on the server, skipping other dimensions unless multi-dimensional.
    --- 0.7.62b: the server's players when multi-dimensional, else the detector's level's.
    local function players()
      local out = {}
      local multi = multiDimensional()
      for _, p in ipairs(core.players) do
        if visible(p) and (multi or p.dimension == dimension) then out[#out + 1] = p end
      end
      return out
    end

    --- PlayerList.getPlayerByName (any case), then 0.7.62b's own checks
    local function byName(username)
      local found
      for _, p in ipairs(core.players) do
        if p.online and p.name:lower() == username:lower() then found = p break end
      end
      if found == nil then
        if not multiDimensional() then
          -- the source reads player.level() of the null it got
          error("Java Exception Thrown: java.lang.NullPointerException", 0)
        end
        return nil
      end
      if not multiDimensional() and found.dimension ~= dimension then return nil end
      if B.V21 and not B.config.showSpectators and found.gamemode == "spectator" then return nil end
      return found
    end

    local function blockPos(index, tbl)
      tbl = B.table(index, tbl)
      if type(tbl.x) ~= "number" or type(tbl.y) ~= "number" or type(tbl.z) ~= "number" then
        error("Table should be block position table", 0)
      end
      local function int(v) return v < 0 and math.ceil(v) or math.floor(v) end -- Number.intValue
      return { x = int(tbl.x), y = int(tbl.y), z = int(tbl.z) }
    end

    local function inRange(p, range) return B.inRange(origin, dimension, p, range, maxRange) end
    local function inCubic(p, x, y, z) return B.inCubic(origin, dimension, p, x, y, z, maxRange) end
    --- the box is the world's getNearbyPlayers (the detector's own level), after a Manhattan distance check
    local function inCoords(p, a, b)
      local d = math.abs(p.x - origin.x) + math.abs(p.z - origin.z)
      if d > (maxRange ~= -1 and maxRange or 2147483647) then return false end
      return p.dimension == dimension and inBox(p, a, b)
    end

    local function names(filter)
      local out = {}
      for _, p in ipairs(players()) do if filter(p) then out[#out + 1] = p.name end end
      return out
    end
    local function any(filter)
      for _, p in ipairs(players()) do if filter(p) then return true end end
      return false
    end

    function m.getOnlinePlayers()
      if B.V20 then -- the server's player names, whatever the dimension
        local out = {}
        for _, p in ipairs(core.players) do if p.online then out[#out + 1] = p.name end end
        return out
      end
      return names(function() return true end)
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

    -- 0.7.48r walks its list for an exact name; 0.7.62b asks the server by name, in any case
    local function one(username, test)
      if B.V21 then
        local p = byName(username)
        return p ~= nil and test(p)
      end
      return any(function(p) return test(p) and p.name == username end)
    end
    function m.isPlayerInCoords(first, second, username)
      local a, b = blockPos(1, first), blockPos(2, second)
      username = B.string(3, username)
      return one(username, function(p) return inCoords(p, a, b) end)
    end
    function m.isPlayerInCubic(x, y, z, username)
      x, y, z = B.int(1, x), B.int(2, y), B.int(3, z)
      username = B.string(4, username)
      return one(username, function(p) return inCubic(p, x, y, z) end)
    end
    function m.isPlayerInRange(range, username)
      range = B.int(1, range)
      username = B.string(2, username)
      return one(username, function(p) return inRange(p, range) end)
    end

    function m.getPlayerPos(username, decimals)
      if not B.config.enablePlayerPosFunction then
        error("This function is disabled in the config. Activate it or ask an admin if he can activate it.", 0)
      end
      local found
      if B.V21 then
        found = byName(B.string(1, username))
        if found == nil then return nil end
        if maxRange ~= -1 and not inRange(found, maxRange) then return nil end
      else
        for _, p in ipairs(players()) do
          if p.name == B.string(1, username) then -- read for each player, as the source does
            if maxRange == -1 or inRange(p, maxRange) then found = p end
            break
          end
        end
        if not found then return {}, "PLAYER_NOT_FOUND" end
      end
      decimals = math.min(B.optInt(2, decimals, 0), 4)
      local unit = 10 ^ decimals
      local info = {
        x = math.floor(found.x * unit) / unit,
        y = math.floor(found.y * unit) / unit,
        z = math.floor(found.z * unit) / unit,
      }
      if B.config.morePlayerInformation then
        if B.V21 then info.uuid, info.name = found.uuid, found.name end
        info.yaw, info.pitch = found.yaw, found.pitch
        info.dimension = found.dimension
        info.eyeHeight = 1.62
        info.health, info.maxHealth = found.health or 20, found.maxHealth or 20
        if B.V20 then info.maxHeatlh = info.maxHealth end -- 0.7.48r keeps the misspelt key too
        info.airSupply = found.airSupply or 300
        if type(found.respawnPosition) == "table" then
          local r = found.respawnPosition
          info.respawnPosition = { x = math.floor(r.x or 0), y = math.floor(r.y or 0), z = math.floor(r.z or 0) }
        end
        info.respawnDimension = found.respawnDimension or "minecraft:overworld"
        info.respawnAngle = found.respawnAngle or 0
      end
      return info
    end
    m.getPlayer = m.getPlayerPos

    return self
  end

  function F.playerDetector(def)
    if B.NEW then return newPlayerDetector(def) end
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

  -- ===== chatBox =====

  --- The chat box of 0.7.48r (1.20.1) and 0.7.62b (1.21.1): every method takes a range (CoordUtil's block-centre
  --- range, -1 everyone), "&" codes in the prefix and bracket colour, a UTF-8 flag, toasts; 0.7.62b limits the length.
  local function newChatBox(def)
    local self = B.new(def)
    local m = self.methods
    local origin, dimension = pos(def), dimensionOf(def)
    local cooldown = B.config.chatMessageCooldown
    B.addOperation(self, "chatMessage", {
      name = "chatMessage", type = "SimpleFreeOperation", cooldown = cooldown,
    })
    local BRACKET_ERROR = "incorrect bracket string (e.g. [], {}, <>, ...)"

    local function lookup(nameOrUuid)
      local p
      if nameOrUuid:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then
        p = core.byUuid[nameOrUuid:lower()]
      else
        p = core.byName[nameOrUuid:lower()]
      end
      return p and p.online and p or nil
    end

    --- appendPrefix: <colour><open>§r<prefix><colour><close>§r <message>; an empty prefix is the default one
    local function compose(text, prefix, brackets, color)
      prefix = B.andToSection(prefix or B.config.defaultChatBoxPrefix)
      if prefix == "" then prefix = B.config.defaultChatBoxPrefix end
      local first = prefix:sub(1, 1)
      if first == "{" or first == "[" or first == '"' then
        local parsed = parseComponent(prefix)
        if parsed ~= nil then prefix = parsed end
      end
      if brackets == nil or brackets == "" then brackets = "[]" end
      color = B.andToSection(color or "")
      return color .. brackets:sub(1, 1) .. "\167r" .. prefix .. color .. brackets:sub(2, 2) .. "\167r " .. text
    end

    local function tooLong(message) return B.V21 and #message > B.config.chatBoxMessageSize end

    local function reaches(p, range)
      if not B.config.chatBoxMultiDimensional and p.dimension ~= dimension then return false end
      return B.inRange(origin, dimension, p, range, B.config.chatBoxMaxRange)
    end

    local function deliver(player, text, extra)
      local entry = { to = player.name, text = text, time = core.instant(), kind = "chatBox", from = def.name }
      for k, v in pairs(extra or {}) do entry[k] = v end
      core.chat[#core.chat + 1] = entry
    end

    local function broadcast(text, range)
      for _, p in ipairs(core.players) do
        if p.online and reaches(p, range) then deliver(p, text) end
      end
      core.save()
      return true
    end

    -- 0 message, 1 prefix, 2 brackets, 3 color, 4 range, 5 utf8
    local function toAll(formatted)
      return function(message, prefix, brackets, color, range, utf8)
        return B.perform(self, "chatMessage", cooldown, nil, function()
          B.optBoolean(6, utf8, false)
          message = B.string(1, message)
          if tooLong(message) then return nil, "Message is too long" end
          range = B.optInt(5, range, -1)
          local text = message
          if formatted then
            text = parseComponent(message)
            if text == nil then return nil, "incorrect json" end
          end
          brackets = B.optString(3, brackets)
          if brackets ~= nil and #brackets ~= 2 then return nil, BRACKET_ERROR end
          prefix = B.optString(2, prefix)
          color = B.optString(4, color, "")
          return broadcast(compose(text, prefix, brackets, color), range)
        end)
      end
    end
    m.sendMessage = toAll(false)
    m.sendFormattedMessage = toAll(true)

    -- 0 message, 1 player, 2 prefix, 3 brackets, 4 color, 5 range, 6 utf8 (0.7.62b reads its formatted form's flag
    -- from 5, the range's place)
    local function toPlayer(formatted)
      return function(message, username, prefix, brackets, color, range, utf8)
        return B.perform(self, "chatMessage", cooldown, nil, function()
          if formatted and B.V21 then B.optBoolean(6, range, false) else B.optBoolean(7, utf8, false) end
          message = B.string(1, message)
          if tooLong(message) then return nil, "Message is too long" end
          username = B.string(2, username)
          range = B.optInt(6, range, -1)
          local player = lookup(username)
          if not player then return nil, "incorrect player name/uuid" end
          local text = message
          if formatted then
            text = parseComponent(message)
            if text == nil then return nil, "incorrect json" end
          end
          brackets = B.optString(4, brackets)
          if brackets ~= nil and #brackets ~= 2 then return nil, BRACKET_ERROR end
          prefix = B.optString(3, prefix)
          color = B.optString(5, color, "")
          local line = compose(text, prefix, brackets, color)
          if not B.config.chatBoxMultiDimensional and player.dimension ~= dimension then
            return false, "NOT_SAME_DIMENSION"
          end
          if B.inRange(origin, dimension, player, range, B.config.chatBoxMaxRange) then
            deliver(player, line)
            core.save()
          end
          return true
        end)
      end
    end
    m.sendMessageToPlayer = toPlayer(false)
    m.sendFormattedMessageToPlayer = toPlayer(true)

    -- 0 message, 1 title, 2 player, 3 prefix, 4 brackets, 5 color, 6 range, 7 utf8. The toast is kept in the chat
    -- log with kind "toast" and its title.
    local function toast(formatted)
      return function(message, title, username, prefix, brackets, color, range, utf8)
        return B.perform(self, "chatMessage", cooldown, nil, function()
          B.optBoolean(8, utf8, false)
          message = B.string(1, message)
          if tooLong(message) then return nil, "Message is too long" end
          title = B.string(2, title)
          username = B.string(3, username)
          range = B.optInt(7, range, -1)
          local player = lookup(username)
          if not player then return nil, "incorrect player name/uuid" end
          local text, heading = message, title
          if formatted then
            text = parseComponent(message)
            if text == nil then return nil, "incorrect json for message" end
            heading = parseComponent(title)
            if heading == nil then return nil, "incorrect json for title" end
          end
          brackets = B.optString(5, brackets)
          if brackets ~= nil and #brackets ~= 2 then
            -- the formatted toast's message has its own typo
            return nil, formatted and "incorrect bracket string (e.g. [], {}, <>, ,,,)" or BRACKET_ERROR
          end
          prefix = B.optString(4, prefix)
          color = B.optString(6, color, "")
          local line = compose(text, prefix, brackets, color)
          if not B.config.chatBoxMultiDimensional and player.dimension ~= dimension then
            return false, "NOT_SAME_DIMENSION"
          end
          if B.inRange(origin, dimension, player, range, B.config.chatBoxMaxRange) then
            deliver(player, line, { kind = "toast", title = heading })
            core.save()
          end
          return true
        end)
      end
    end
    m.sendToastToPlayer = toast(false)
    m.sendFormattedToastToPlayer = toast(true)

    return self
  end

  function F.chatBox(def)
    if B.NEW then return newChatBox(def) end
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

    if core.vhcc then
      -- vhcctweaks cancels both formatted-message methods before AP runs them (no cooldown used)
      function m.sendFormattedMessage()
        return nil, "sendFormattedMessage is disabled on this server for security"
      end

      function m.sendFormattedMessageToPlayer()
        return nil, "sendFormattedMessageToPlayer is disabled on this server for security"
      end
      return self
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

  -- ===== redstone_relay (CC:Tweaked 1.114.0+, so only on 1.121.0 worlds) =====
  -- RedstoneRelayPeripheral: CC's RedstoneMethods on its own six sides. What reaches it from the world is not
  -- simulated: the inputs come from the world file (`inputs`, side -> level, `bundledInputs`, side -> mask) and the
  -- outputs land in state.json.

  local RELAY_SIDES = { top = true, bottom = true, left = true, right = true, front = true, back = true }

  function F.redstone_relay(def)
    local self = B.new(def)
    local m = self.methods
    local output, bundledOut, input, bundledIn = {}, {}, {}, {}
    for side, level in pairs(def.inputs or {}) do input[side] = level end
    for side, mask in pairs(def.bundledInputs or {}) do bundledIn[side] = mask end

    -- IArguments.getEnum(ComputerSide): any case, else "unknown option"
    local function side(v)
      v = B.string(1, v)
      local s = v:lower()
      if not RELAY_SIDES[s] then error(("bad argument #1 (unknown option %s)"):format(v), 0) end
      return s
    end

    function m.setOutput(s, on)
      s = side(s)
      output[s] = B.boolean(2, on) and 15 or 0
    end
    function m.getOutput(s) return (output[side(s)] or 0) > 0 end
    function m.getInput(s) return (input[side(s)] or 0) > 0 end
    function m.setAnalogOutput(s, value)
      s = side(s)
      value = B.int(2, value)
      if value < 0 or value > 15 then error("Expected number in range 0-15", 0) end
      output[s] = value
    end
    function m.getAnalogOutput(s) return output[side(s)] or 0 end
    function m.getAnalogInput(s) return input[side(s)] or 0 end
    m.setAnalogueOutput, m.getAnalogueOutput, m.getAnalogueInput = m.setAnalogOutput, m.getAnalogOutput, m.getAnalogInput
    function m.setBundledOutput(s, mask)
      s = side(s)
      bundledOut[s] = B.int(2, mask)
    end
    function m.getBundledOutput(s) return bundledOut[side(s)] or 0 end
    function m.getBundledInput(s) return bundledIn[side(s)] or 0 end
    function m.testBundledInput(s, mask)
      s = side(s)
      mask = B.int(2, mask)
      local have = bundledIn[s] or 0
      return bit32.band(have, mask) == bit32.band(mask, 0xFFFFFFFF)
    end

    self.setters = {
      input = function(s, level) input[s] = level end,
    }
    function self.state() return { outputs = output, bundledOutputs = bundledOut, inputs = input } end
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

    if B.NEW then
      -- 0.7.30r's writeTable throws IOException, so CC:Tweaked never offers it; from 0.7.48r it exists. The table is
      -- stored as NBTUtil.toDirectNBT makes it: booleans become 1/0, keys strings, anything else dropped. The size
      -- check is Java serialization's byte count, estimated here from the serialised table.
      local function direct(v)
        local t = type(v)
        if t == "boolean" then return v and 1 or 0 end
        if t == "number" or t == "string" then return v end
        if t == "table" then
          local out = {}
          for k, x in pairs(v) do
            local d = direct(x)
            if d ~= nil then out[tostring(k)] = d end
          end
          return out
        end
        return nil
      end
      function m.writeTable(data)
        data = B.table(1, data)
        local ok, text = pcall(textutils.serialize, data, { compact = true })
        if ok and #text > B.config.nbtStorageMaxSize then return nil, "JSON size is bigger than allowed" end
        stored = direct(data)
        return true
      end
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

  -- The sound events of the music discs (RecordItem.getBySound), which a 1.121.0 speaker refuses: Minecraft 1.20.1
  local MUSIC_DISCS = {}
  for _, disc in ipairs({ "13", "cat", "blocks", "chirp", "far", "mall", "mellohi", "stal", "strad", "ward", "11", "wait",
    "otherside", "5", "pigstep", "relic" }) do
    MUSIC_DISCS["minecraft:music_disc." .. disc] = true
  end

  function F.speaker(def)
    local self = { methods = {} }
    local m = self.methods
    local NOTES_PER_TICK = 8
    local KEEP = 300
    local log, total, refused = {}, 0, 0
    local noteTick, notesThisTick = -1, 0
    local soundTick = -1 -- 1.121.0: the server tick the pending sound was played in

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
      if core.cc121 then
        -- CC:Tweaked 1.121.0 SpeakerPeripheral.playSound: a length limit, its own messages, no music discs, and
        -- one sound per server tick (pendingSound is only sent, and cleared, on the next tick)
        if #name > 512 then error("bad argument #1 (sound name is too long)", 0) end
        if not validLocation(name) then error("bad argument #1 (malformed sound name)", 0) end
        local id = name:find(":", 1, true) and name or ("minecraft:" .. name)
        if MUSIC_DISCS[id] then return record({ kind = "sound", name = name, volume = volume, pitch = pitch }, false) end
        local tick = math.floor(core.nowMs() / 50)
        if soundTick == tick or (audio and isPlaying(audio)) then
          return record({ kind = "sound", name = name, volume = volume, pitch = pitch }, false)
        end
        soundTick = tick
        audio = nil
        return record({ kind = "sound", name = name, volume = volume, pitch = pitch }, true)
      end
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
