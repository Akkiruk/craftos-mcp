-- ccsim vhcc: emulation of the vhcctweaks `vhcc` sandboxed file API (VHCCTweaksAPI.java).
-- Storage is a host directory mounted at core.vhccDir; paths are validated exactly
-- like the mod does before touching it.
return function(core)
  local vhcc = {}

  local MAX_WRITE_SIZE = 1024 * 1024
  local MAX_PATH_DEPTH = 16

  local function fail(message) error(message, 0) end

  -- VHCCTweaksAPI takes String parameters: CC:Tweaked's getString refuses a number (it arrives as a Double)
  local function checkString(index, v)
    if type(v) == "string" then return v end
    error(("bad argument #%d (string expected, got %s)"):format(index, v == nil and "nil" or type(v)), 0)
  end

  local function available()
    return fs.exists(core.vhccDir) and fs.isDir(core.vhccDir)
  end

  --- Each computer has a private folder under the shared store.
  local function computerRoot()
    return fs.combine(core.vhccDir, "computers/" .. core.computerId)
  end

  local function cost(bytes) return math.max(bytes, 4096) end

  local function usage(dir)
    if not fs.exists(dir) then return 0 end
    local total = 0
    for _, name in ipairs(fs.list(dir)) do
      local entry = fs.combine(dir, name)
      if fs.isDir(entry) then
        total = total + cost(0) + usage(entry)
      else
        total = total + cost(fs.getSize(entry))
      end
    end
    return total
  end

  --- Refuses a change that would leave the computer's folder over its allowance.
  local function requireSpace(target, newBytes)
    local limit = core.config.maxBytesPerComputer
    local oldCost = (fs.exists(target) and not fs.isDir(target)) and cost(fs.getSize(target)) or 0
    if usage(computerRoot()) + cost(0) - oldCost + cost(newBytes) > limit then
      fail("vhcc: out of space (limit " .. math.floor(limit / 1024) .. " KB per computer)")
    end
  end

  local function validatePath(path)
    if path == nil or path == "" then fail("vhcc: path cannot be empty") end
    local normalized = path:gsub("\\", "/")
    if normalized:sub(1, 1) == "/" then fail("vhcc: absolute paths not allowed") end
    -- String.split drops trailing empty segments
    local segments = {}
    for segment in (normalized .. "/"):gmatch("(.-)/") do segments[#segments + 1] = segment end
    while #segments > 0 and segments[#segments] == "" do segments[#segments] = nil end
    if #segments > MAX_PATH_DEPTH then
      fail("vhcc: path too deep (max " .. MAX_PATH_DEPTH .. " levels)")
    end
    for _, segment in ipairs(segments) do
      if segment ~= "" then
        if segment == ".." or segment == "." then fail("vhcc: '..' and '.' not allowed in paths") end
        if #segment > 128 or not segment:match("^[%w_%-][%w_%-%.]*$") then
          fail("vhcc: invalid path segment '" .. segment ..
            "' - use letters, numbers, dashes, underscores, dots")
        end
      end
    end
    return normalized
  end

  local function resolve(path)
    if not available() then fail("vhcc: root directory not configured") end
    local normalized = validatePath(path)
    local root = computerRoot()
    if not fs.exists(root) then fs.makeDir(root) end
    return fs.combine(root, normalized)
  end

  local function parentOf(target)
    return fs.getDir(target)
  end

  -- ===== remote code requests (vhcctweaks RemoteControl: /vhcc pc exec) =====
  -- The host command `rcExec {player, code, request?}` stands for a player running code on this computer through the
  -- mod: it queues `vhcc_rc_exec(request, code)` (what a supervisor program listens for), and the program answers with
  -- vhcc.rcReply(request, result), which sends the player `[vhcc-rc] {"exec":..,"result":..,"truncated":..}` in chat.
  local REPLY_PREFIX = "[vhcc-rc] "
  local MAX_REPLY_CHARS = 64 * 1024
  local MAX_PENDING = 32
  local EXEC_TIMEOUT_MS = 60000
  -- The client disconnects on chat JSON over 262,144 characters; the mod keeps lines under this
  local MAX_CHAT_JSON_CHARS = 260000

  -- Requests waiting for an answer: id -> { uuid, startedAt }. They belong to the server, so a reboot of the computer
  -- keeps them; a request is only dropped by an answer, or by the next request after its 60 seconds.
  core.rcPending = core.rcPending or {}

  local function randomHex()
    local out = {}
    for i = 1, 32 do out[i] = ("%x"):format(math.random(0, 15)) end
    return table.concat(out)
  end

  local function jsonString(s)
    -- The length of a string once JSON-escaped: quotes, backslashes and control characters
    local n = 2
    for i = 1, #s do
      local b = s:byte(i)
      if b == 34 or b == 92 or b == 10 or b == 13 or b == 9 or b == 8 or b == 12 then n = n + 2
      elseif b < 32 then n = n + 6
      else n = n + 1 end
    end
    return n
  end

  local function toJson(reply)
    local function str(s) return textutils.serialiseJSON(s) end
    local parts = {}
    if reply.exec then parts[#parts + 1] = '"exec":' .. str(reply.exec) end
    if reply.result ~= nil then parts[#parts + 1] = '"result":' .. str(reply.result) end
    if reply.truncated ~= nil then parts[#parts + 1] = '"truncated":' .. tostring(reply.truncated) end
    if reply.ok ~= nil then parts[#parts + 1] = '"ok":' .. tostring(reply.ok) end
    if reply.error then parts[#parts + 1] = '"error":' .. str(reply.error) end
    return "{" .. table.concat(parts, ",") .. "}"
  end

  --- Answer a remote code request; true only for a request this computer was actually sent.
  function vhcc.rcReply(request, result)
    request = checkString(1, request)
    result = checkString(2, result)
    local pending = core.rcPending[request]
    if not pending or pending.computerId ~= core.computerId then return false end
    core.rcPending[request] = nil
    local text = #result > MAX_REPLY_CHARS and result:sub(1, MAX_REPLY_CHARS) or result
    local player = core.byUuid[pending.uuid]
    -- a player who has left is simply not told
    if player and player.online and not player.onOtherServer then
      local reply = { exec = request, result = text, truncated = #text < #result }
      local line = REPLY_PREFIX .. toJson(reply)
      if jsonString(line) + 11 > MAX_CHAT_JSON_CHARS then
        line = REPLY_PREFIX .. toJson({ exec = request, ok = false, error = "reply too large for one chat line" })
      end
      core.say(player, line, { kind = "rc", exec = request })
      core.save()
    end
    return true
  end

  --- Host command: a player runs code on this computer. `request` picks the id (default: random hex, as the mod's).
  core.handlers.rcExec = function(cmd)
    local player = core.findPlayer(cmd.player)
    if not player or not player.online then return false, "unknown player" end
    if type(cmd.code) ~= "string" or cmd.code == "" then return false, "nothing uploaded to run" end
    local now = core.nowMs()
    for id, pending in pairs(core.rcPending) do
      if now - pending.startedAt > EXEC_TIMEOUT_MS then core.rcPending[id] = nil end
    end
    local count = 0
    for _ in pairs(core.rcPending) do count = count + 1 end
    if count >= MAX_PENDING then return false, "too many requests waiting for an answer" end
    local request = cmd.request or randomHex()
    core.rcPending[request] = { uuid = player.uuid, computerId = core.computerId, startedAt = now }
    os.queueEvent("vhcc_rc_exec", request, cmd.code)
    core.save()
    return true
  end

  function vhcc.isAvailable()
    return available()
  end

  function vhcc.getBasePath()
    if not available() then fail("vhcc: root directory not configured") end
    return core.world.vhccBaseName or "vhcc_data"
  end

  function vhcc.write(path, content)
    path = checkString(1, path)
    content = checkString(2, content)
    if #content > MAX_WRITE_SIZE then
      fail("vhcc: content too large (max " .. (MAX_WRITE_SIZE / 1024) .. " KB)")
    end
    local target = resolve(path)
    requireSpace(target, #content)
    fs.makeDir(parentOf(target))
    local h, err = fs.open(target, "wb")
    if not h then fail("vhcc: write failed - " .. tostring(err)) end
    h.write(content)
    h.close()
    return true
  end

  function vhcc.append(path, content)
    path = checkString(1, path)
    content = checkString(2, content)
    if #content > MAX_WRITE_SIZE then
      fail("vhcc: content too large (max " .. (MAX_WRITE_SIZE / 1024) .. " KB)")
    end
    local target = resolve(path)
    requireSpace(target, (fs.exists(target) and fs.getSize(target) or 0) + #content)
    fs.makeDir(parentOf(target))
    local h, err = fs.open(target, "ab")
    if not h then fail("vhcc: append failed - " .. tostring(err)) end
    h.write(content)
    h.close()
    return true
  end

  function vhcc.read(path)
    path = checkString(1, path)
    local target = resolve(path)
    if not fs.exists(target) then return nil end
    if fs.isDir(target) then fail("vhcc: cannot read a directory") end
    local h, err = fs.open(target, "rb")
    if not h then fail("vhcc: read failed - " .. tostring(err)) end
    local content = h.readAll() or ""
    h.close()
    return content
  end

  function vhcc.exists(path)
    return fs.exists(resolve(checkString(1, path)))
  end

  function vhcc.isDir(path)
    return fs.isDir(resolve(checkString(1, path)))
  end

  function vhcc.getSize(path)
    path = checkString(1, path)
    local target = resolve(path)
    if not fs.exists(target) then fail("vhcc: file not found - " .. path) end
    if fs.isDir(target) then fail("vhcc: cannot get size of a directory") end
    return fs.getSize(target)
  end

  -- 2.2.37: the bytes this computer's folder uses and its allowance. Every file and folder, the computer's own
  -- included, counts as at least 4096 bytes; a computer that has written nothing uses 0.
  if core.v37 then
    function vhcc.getUsage()
      if not available() then fail("vhcc: root directory not configured") end
      local root = computerRoot()
      local used = fs.exists(root) and usage(root) + cost(0) or 0
      return used, core.config.maxBytesPerComputer
    end
  end

  function vhcc.list(path)
    local target
    if path == nil or path == "" or path == "/" then
      if not available() then fail("vhcc: root directory not configured") end
      target = computerRoot()
      if not fs.exists(target) then fs.makeDir(target) end
    else
      path = checkString(1, path)
      target = resolve(path)
    end
    if not fs.exists(target) then fail("vhcc: directory not found - " .. tostring(path)) end
    if not fs.isDir(target) then fail("vhcc: not a directory - " .. tostring(path)) end
    local names = fs.list(target)
    table.sort(names)
    local result = {}
    for i, name in ipairs(names) do
      if fs.isDir(fs.combine(target, name)) then name = name .. "/" end
      result[i] = name
    end
    return result
  end

  function vhcc.makeDir(path)
    local target = resolve(checkString(1, path))
    fs.makeDir(target)
    return true
  end

  function vhcc.delete(path)
    path = checkString(1, path)
    local target = resolve(path)
    if not fs.exists(target) then return false end
    if fs.isDir(target) and #fs.list(target) > 0 then
      fail("vhcc: directory not empty - " .. path)
    end
    fs.delete(target)
    return true
  end

  function vhcc.move(from, to)
    from = checkString(1, from)
    to = checkString(2, to)
    local source = resolve(from)
    local dest = resolve(to)
    if not fs.exists(source) then fail("vhcc: source not found - " .. from) end
    if fs.exists(dest) then fail("vhcc: destination already exists - " .. to) end
    fs.makeDir(parentOf(dest))
    fs.move(source, dest)
    return true
  end

  function vhcc.copy(from, to)
    from = checkString(1, from)
    to = checkString(2, to)
    local source = resolve(from)
    local dest = resolve(to)
    if not fs.exists(source) then fail("vhcc: source not found - " .. from) end
    if fs.isDir(source) then fail("vhcc: cannot copy directories") end
    if fs.exists(dest) then fail("vhcc: destination already exists - " .. to) end
    requireSpace(dest, fs.getSize(source))
    fs.makeDir(parentOf(dest))
    fs.copy(source, dest)
    return true
  end

  -- Java exceptions are reported at the caller, as in ccvault.lua
  for name, fn in pairs(vhcc) do
    if type(fn) == "function" then vhcc[name] = core.native(fn) end
  end

  return vhcc
end
