-- ccsim core: the simulated world around a computer (players, chat, inventories, other mods' blocks).
--
-- The host (the MCP runner) describes the world in /results/world.json before the
-- computer boots and can change it later by sending `ccsim_cmd` events. The sim
-- writes its observable state (balances, ledger, chat log) to /results/state.json.
local M = {}

local WORLD_PATH = "/results/world.json"
local STATE_PATH = "/results/state.json"
local BEACON_PATH = "/results/waiting.json"
local TRACE_PATH = "/results/trace.log"
local TRACE_MAX_LINES = 5000

M.config = {
  nonceExpirySeconds = 60,
  authIdleTimeoutMinutes = 10,
  maxTransferAmount = 1000000,
  interactionStaleSeconds = 30,
  maxHistoryResults = 50,
  maxBytesPerComputer = 16777216,
  -- computercraft-server.toml on the server
  modemRange = 64,
  modemHighAltitudeRange = 384,
  modemRangeDuringStorm = 64,
  modemHighAltitudeRangeDuringStorm = 384,
}

-- Server-mod behaviour this build does not simulate: always off.
M.vhcc, M.v36 = false, false
--- Whether a mod (an addon id such as "create") is part of this world.
M.addons, M.addonsAll = {}, true
function M.addonOn(id) return M.addonsAll or M.addons[id] == true end
M.simTimers = {}    -- timer id -> function: the sim's own timers, never handed to the program
M.unloaded = false  -- the computer's chunk is unloaded: it runs nothing until it loads again

M.world = {}
M.players = {}      -- ordered list
M.byName = {}       -- lower-case name -> player
M.byUuid = {}
M.chat = {}         -- messages the server sent to players
M.ledger = {}       -- completed transfers (oldest first)
M.rejections = {}
M.interaction = nil -- { uuid, at }
M.ownerUuid = nil
M.sessions = {}     -- uuid -> { uuid, last }: sessions are per player per computer since 2.2.34
M.playerTouched = {} -- uuid -> that player's own last interaction, for several players at one table
M.terminalLocked = false
M.pending = {}      -- nonce -> { uuid, expiresAt }
M.economyAvailable = true
M.computerId = os.getComputerID()
M.kind = "block"    -- "block" computers claim ownership on first interaction
M.peripherals = {}  -- virtual peripherals, filled by ccsim.peripherals
M.position = { x = 0, y = 64, z = 0, dimension = "minecraft:overworld" } -- where the computer stands

local function readFile(path)
  if not fs.exists(path) then return nil end
  local h = fs.open(path, "r")
  if not h then return nil end
  local text = h.readAll()
  h.close()
  return text
end

function M.nowMs()
  return M.frozenMs or os.epoch("utc")
end

--- ISO-8601 instant like java.time.Instant.toString().
function M.instant(ms)
  ms = ms or M.nowMs()
  local seconds = math.floor(ms / 1000)
  return os.date("!%Y-%m-%dT%H:%M:%S", seconds) .. string.format(".%03dZ", ms % 1000)
end

local function uuidFor(index)
  return string.format("00000000-0000-4000-8000-%012x", index)
end

local function addPlayer(def)
  local index = #M.players + 1
  local player = {
    name = def.name,
    uuid = def.uuid or uuidFor(index),
    balance = def.balance or 0,
    online = def.online ~= false and not (M.v36 and def.onOtherServer == true),
    -- 2.2.36: online on another server of the network. The economy knows them; this server counts them as offline.
    onOtherServer = M.v36 and def.onOtherServer == true or nil,
    x = def.x or 0, y = def.y or 64, z = def.z or 0,
    yaw = def.yaw or 0, pitch = def.pitch or 0,
    dimension = def.dimension or "minecraft:overworld",
    health = def.health or 20, maxHealth = def.maxHealth or 20,
  }
  M.players[#M.players + 1] = player
  M.byName[player.name:lower()] = player
  M.byUuid[player.uuid] = player
  return player
end
M.addPlayer = addPlayer

function M.findPlayer(nameOrUuid)
  if not nameOrUuid then return nil end
  return M.byUuid[nameOrUuid] or M.byName[tostring(nameOrUuid):lower()]
end

function M.onlinePlayer(uuid)
  local p = uuid and M.byUuid[uuid]
  if p and p.online then return p end
  return nil
end

--- Append a message the server shows to a player (kept for tests to inspect).
function M.say(player, text, extra)
  local entry = { to = player and player.name or "*", text = text, time = M.instant() }
  if extra then for k, v in pairs(extra) do entry[k] = v end end
  M.chat[#M.chat + 1] = entry
end

local function normalizeItems(items)
  local result = {}
  for key, item in pairs(items or {}) do
    local slot = tonumber(key)
    if slot then result[slot] = item end
  end
  return result
end
M.normalizeItems = normalizeItems

function M.load()
  local text = readFile(WORLD_PATH)
  local world = text and textutils.unserializeJSON(text) or {}
  M.world = world
  -- 2.2.36 is the target and the default; "2.2.35" is kept only as an explicit opt-out for old measurements
  -- Mods the world runs with (packages/runner/src/addons.ts). The runner always sends the list; without one, all.
  M.addons = {}
  if type(world.addons) == "table" then
    for _, id in ipairs(world.addons) do M.addons[id] = true end
  end
  M.addonsAll = type(world.addons) ~= "table"
  for key, value in pairs(world.config or {}) do M.config[key] = value end
  if M.v36 then
    -- 2.2.36 accepts 5-3600; Forge puts a value out of range back to the default
    local stale = tonumber(M.config.interactionStaleSeconds)
    if not stale or stale < 5 or stale > 3600 then M.config.interactionStaleSeconds = 30 end
  end
  if world.economyAvailable == false then M.economyAvailable = false end
  if world.computerId then M.computerId = world.computerId end
  if world.kind then M.kind = world.kind end
  for key, value in pairs(world.position or {}) do M.position[key] = value end

  local players = world.players
  if not players or #players == 0 then
    players = { { name = "Player", balance = 0 } }
  end
  for _, def in ipairs(players) do addPlayer(def) end

  if world.host then
    local host = M.findPlayer(world.host)
    if not host then host = addPlayer({ name = world.host, online = false }) end
    M.ownerUuid = host.uuid
  end
  if world.interacting then
    local p = M.findPlayer(world.interacting)
    if p then
      M.interaction = { uuid = p.uuid, at = M.nowMs() }
      M.playerTouched[p.uuid] = M.interaction.at
    end
  end
end

--- A reboot restarts the computer, not the server: balances, the ledger, sessions and ownership carry on.
function M.restore()
  local text = readFile(STATE_PATH)
  local saved = text and textutils.unserializeJSON(text)
  if type(saved) ~= "table" then
    M.joinEconomy()
    return
  end
  for name, balance in pairs(saved.balances or {}) do
    local p = M.findPlayer(name)
    if p then p.balance = balance end
  end
  if M.v36 then
    for name, level in pairs(saved.vaultLevels or {}) do
      local p = M.findPlayer(name)
      if p then p.vaultLevel = level end
    end
    for name, equipment in pairs(saved.equipment or {}) do
      local p = M.findPlayer(name)
      if p then p.equipment = equipment end
    end
  end
  M.ledger = saved.ledger or M.ledger
  M.rejections = saved.rejections or M.rejections
  M.chat = saved.chat or M.chat
  M.terminalLocked = saved.terminalLocked == true
  M.savedState = saved -- a turtle picks up where it was (ccsim/turtle)
  local survives = saved.survives
  if type(survives) == "table" then
    M.sessions = survives.sessions or {}
    M.playerTouched = survives.playerTouched or {}
    M.interaction = survives.interaction or M.interaction
    M.ownerUuid = survives.ownerUuid or M.ownerUuid
    M.position = survives.position or M.position
    if M.v36 then M.allowances = survives.allowances end
    M.rcPending = survives.rcPending
  end
  -- A server crash (crashServer): the server held sessions, touches, approvals and allowances only in memory
  -- (SessionAuthManager, ComputerInteractionTracker, AllowanceManager), so they went with it. Ownership is saved.
  if saved.serverCrash then
    M.sessions, M.playerTouched, M.interaction, M.pending = {}, {}, nil, {}
    if M.v36 then M.allowances = nil end
  end
  -- On 2.2.36 a reboot or a chunk reload keeps what is in the chests, as the world does
  if (M.v36 or not M.vhcc) and type(saved.inventories) == "table" then M.savedInventories = saved.inventories end
  M.joinEconomy()
end

-- ===== one economy for a linked network =====
-- A server has one economy behind every computer. A linked network's computers share it in /results/economy, which
-- the runner seeds (network.ts, seedEconomy): balances by uuid, the ledger and refused transfers, and a version. A
-- computer holds the economy while it reads or changes it by moving the one `free` token to its own name, which only
-- one computer can do at a time. Balances stay on the player records and M.ledger as before; they are brought up to
-- date from the shared copy whenever the version moved. Sessions, touches and approvals stay with each computer.
local ECONOMY_DIR = "/results/economy"
local rawFs = {
  open = fs.open, exists = fs.exists, move = fs.move, delete = fs.delete, list = fs.list, tryLock = fs.__ccsimTryLock,
}
fs.__ccsimTryLock = nil -- emulator-only: no program sees it
local economyVersion, economyBalances
local holding = 0

local function readAll(path)
  local h = rawFs.open(path, "r")
  if not h then return nil end
  local text = h.readAll()
  h.close()
  return text
end

local function writeAll(path, text)
  local h = rawFs.open(path, "w")
  if not h then error("ccsim: cannot write " .. path, 0) end
  h.write(text)
  h.close()
end

local function economyShared()
  return M.sharedEconomy == true
end

local function holdEconomy()
  local lock = ECONOMY_DIR .. "/lock"
  -- Nothing yields while holding it, so a holder lets go within a moment. An engine killed mid-hold leaves the lock,
  -- and the host (network.ts, returnEconomyToken) removes it. Never take it back here: a holder that is only slow (a
  -- busy machine) would still be changing the economy, and both computers would move the same tokens.
  while not rawFs.tryLock(lock) do end
  writeAll(lock, tostring(M.computerId)) -- whose it is, for the host
  return lock
end

--- Bring balances, the ledger and refusals up to date with the shared economy, if another computer changed it.
--- False when it changed but could not be read whole (caught mid-write, outside the hold).
local function pullEconomy(force)
  local version = readAll(ECONOMY_DIR .. "/version")
  -- Holding it, read it whole every time: a version can be seen out of step with the file under a busy machine, and a
  -- balance read stale there lets two computers spend the same tokens
  if version == economyVersion and not force then return true end
  local ok, data = pcall(textutils.unserializeJSON, readAll(ECONOMY_DIR .. "/economy.json") or "")
  if not ok or type(data) ~= "table" then return false end
  economyVersion = version
  economyBalances = data.balances or {}
  for uuid, balance in pairs(economyBalances) do
    local p = M.byUuid[uuid]
    if p then p.balance = balance end
  end
  -- fresh tables: a JSON [] reads back as textutils.empty_json_array, which cannot be added to
  local function list(value)
    local out = {}
    for i, v in ipairs(type(value) == "table" and value or {}) do out[i] = v end
    return out
  end
  M.ledger = list(data.ledger)
  M.rejections = list(data.rejections)
  return true
end

--- What another computer changed, without holding the economy: for state.json, which only shows it.
function M.peekEconomy()
  if economyShared() and holding == 0 then pcall(pullEconomy) end
end

local function pushEconomy()
  economyBalances = economyBalances or {}
  for _, p in ipairs(M.players) do economyBalances[p.uuid] = p.balance end
  local version = tostring((tonumber(economyVersion) or 0) + 1)
  writeAll(ECONOMY_DIR .. "/economy.json", textutils.serializeJSON({
    balances = economyBalances, ledger = M.ledger, rejections = M.rejections,
  }))
  writeAll(ECONOMY_DIR .. "/version", version)
  economyVersion = version
end

--- Run fn(...) with the economy held and current. A change it makes (M.economyChanged()) is what every computer
--- sees next. On a computer on its own this is just fn(...). fn must not yield.
function M.withEconomy(fn, ...)
  if not economyShared() or holding > 0 then return fn(...) end
  local token = holdEconomy()
  holding = 1
  M.economyDirty = false
  local results = table.pack(pcall(function(...)
    -- held, nobody writes it, so it reads whole; if not, changing it would write over what another computer did
    if not pullEconomy(true) then error("ccsim: the shared economy could not be read", 0) end
    return fn(...)
  end, ...))
  local ok, err = true, nil
  if M.economyDirty and results[1] then ok, err = pcall(pushEconomy) end
  if not (results[1] and ok) then economyVersion = nil end -- what this computer half-changed is read afresh next time
  M.economyDirty = false
  holding = 0
  pcall(rawFs.delete, token)
  if not results[1] then error(results[2], 0) end
  if not ok then error(err, 0) end
  return table.unpack(results, 2, results.n)
end

--- Something in the economy changed (a balance, the ledger, a refusal).
function M.economyChanged()
  M.economyDirty = true
end

--- Load the shared economy at boot: it is the server's, so it wins over what this computer saved.
function M.joinEconomy()
  M.sharedEconomy = rawFs.exists(ECONOMY_DIR .. "/economy.json")
  if M.sharedEconomy then M.withEconomy(function() end) end
end

--- Run fn after `seconds` of virtual time. The timer event is the sim's: no program ever sees it.
function M.after(seconds, fn)
  local id = os.startTimer(seconds)
  M.simTimers[id] = fn
  return id
end

--- A player's right-click: they become the interacting player and their own freshness and session are renewed.
function M.recordInteraction(uuid, at)
  M.interaction = { uuid = uuid, at = at }
  M.playerTouched[uuid] = at
  if M.sessions[uuid] then M.sessions[uuid].last = at end
end

--- Write state now if it has been quiet for 200 ms, otherwise flush at the next event or shutdown.
function M.touch()
  if M.nowMs() - (M.lastSave or 0) > 200 then M.save() else M.dirty = true end
end

--- Persist everything a test might want to assert on.
function M.save()
  M.lastSave, M.dirty = M.nowMs(), false
  -- One instant for the whole snapshot: every machine and the tick count it reports come from the same moment, even
  -- when the host is slow enough for a tick to pass while the state is gathered.
  local outer = M.frozenMs ~= nil
  M.frozenMs = M.frozenMs or os.epoch("utc")
  local ok, err = pcall(M.saveNow)
  if not outer then M.frozenMs = nil end
  if not ok then error(err, 0) end
end

function M.saveNow()
  if M.beforeObserve then M.beforeObserve() end -- machines on the virtual clock (Mekanism QIO) catch up first
  M.peekEconomy() -- what other computers moved shows here too
  local balances = {}
  for _, p in ipairs(M.players) do balances[p.name] = p.balance end
  local owner = M.ownerUuid and M.byUuid[M.ownerUuid]
  local state = {
    balances = balances,
    vaultLevels = M.v36 and (function()
      local levels = {}
      for _, p in ipairs(M.players) do levels[p.name] = p.vaultLevel end
      return next(levels) and levels or nil
    end)() or nil,
    equipment = M.v36 and (function()
      local worn = {}
      for _, p in ipairs(M.players) do worn[p.name] = p.equipment end
      return next(worn) and worn or nil
    end)() or nil,
    ledger = M.ledger,
    rejections = M.rejections,
    chat = M.chat,
    host = owner and owner.name or nil,
    interacting = M.interaction and M.byUuid[M.interaction.uuid] and M.byUuid[M.interaction.uuid].name or nil,
    authenticated = (function()
      -- the interacting player when approved, otherwise any approved player
      local uuid = M.interaction and M.sessions[M.interaction.uuid] and M.interaction.uuid or next(M.sessions)
      return uuid and M.byUuid[uuid] and M.byUuid[uuid].name or nil
    end)(),
    terminalLocked = M.terminalLocked,
    -- crashServer: the reboot to come is the whole server's
    serverCrash = M.serverCrash or nil,
    -- What the server would still know after this computer reboots
    survives = {
      sessions = M.sessions,
      playerTouched = M.playerTouched,
      interaction = M.interaction,
      ownerUuid = M.ownerUuid,
      position = M.position,
      allowances = M.allowances,
      rcPending = M.rcPending,
    },
    pendingApprovals = (function()
      local n = 0
      for _ in pairs(M.pending) do n = n + 1 end
      return n
    end)(),
    inventories = M.inventoryState and M.inventoryState() or nil,
    peripherals = M.peripheralState and M.peripheralState() or nil,
    qio = M.qioState and M.qioState() or nil,
    addons = M.addonState and M.addonState() or nil, -- addon-wide state (ccsim/addons), by module
    -- turtles (ccsim/turtle): the turtle itself, and every block, dropped item and mob the sim changed
    turtle = M.turtleState and M.turtleState() or nil,
    blocks = M.blockState and M.blockState() or nil,
    droppedItems = M.droppedItemState and M.droppedItemState() or nil,
  }
  local h = fs.open(STATE_PATH, "w")
  if h then
    h.write(textutils.serializeJSON(state))
    h.close()
  end
  if M.afterSave then M.afterSave() end
end

-- ===== host commands (delivered as `ccsim_cmd` events) =====

local handlers = {}
M.handlers = handlers

function handlers.interact(cmd)
  local p = M.findPlayer(cmd.player)
  if not p then return false, "unknown player" end
  M.recordInteraction(p.uuid, M.nowMs())
  return true
end

function handlers.approve(cmd)
  local p = M.findPlayer(cmd.player) or (M.interaction and M.byUuid[M.interaction.uuid])
  if not p then return false, "unknown player" end
  return M.approve(p.uuid, cmd.nonce)
end

function handlers.revoke(cmd)
  local p = M.findPlayer(cmd.player)
  if p then M.sessions[p.uuid] = nil else M.sessions = {} end
  if M.onRevoke then M.onRevoke(p) end
  return true
end

function handlers.setBalance(cmd)
  local p = M.findPlayer(cmd.player)
  if not p then return false, "unknown player" end
  return M.withEconomy(function()
    p.balance = cmd.balance
    M.economyChanged()
    return true
  end)
end

function handlers.addPlayer(cmd)
  if M.findPlayer(cmd.name) then return false, "player exists" end
  return M.withEconomy(function()
    local p = addPlayer(cmd)
    -- someone the economy already knows (another computer added them) keeps what they have
    if M.sharedEconomy and economyBalances and economyBalances[p.uuid] ~= nil and cmd.balance == nil then
      p.balance = economyBalances[p.uuid]
    else
      M.economyChanged()
    end
    return true
  end)
end

--- The server crashes and starts again: this computer restarts, and what the server kept only in memory is gone
--- (see restore). `onReboot`: not now, but the next time this computer reboots, whatever reboots it.
function handlers.crashServer(cmd)
  M.serverCrash = true
  if cmd.onReboot then return true end
  M.save()
  os.reboot()
  return true
end

function handlers.join(cmd)
  local p = M.findPlayer(cmd.player)
  if not p then return false, "unknown player" end
  p.online = true
  p.onOtherServer = nil -- joining here takes them off any other server of the network
  return true
end

function handlers.leave(cmd)
  local p = M.findPlayer(cmd.player)
  if not p then return false, "unknown player" end
  p.online = false
  -- logging out clears that player's auth state and pending nonces
  M.sessions[p.uuid] = nil
  for nonce, pending in pairs(M.pending) do
    if pending.uuid == p.uuid then M.pending[nonce] = nil end
  end
  if M.onLeave then M.onLeave(p) end
  return true
end

--- The computer's chunk unloads: it stops, and linked computers lose its peripherals. Nothing loads it but `load`.
function handlers.unload()
  if M.unloaded then return false, "already unloaded" end
  M.unloaded = true
  if M.onUnload then M.onUnload() end
  return true
end

--- The chunk loads again: the computer starts afresh, as a computer in a reloaded chunk does.
function handlers.load()
  if not M.unloaded then return false, "not unloaded" end
  -- `unloaded` stays set until the reboot (it is not saved, so the next boot starts loaded): anything this boot still
  -- publishes before it goes must not say it is loaded again, or a linked computer attaches its peripherals, calls
  -- one (watch) into a reboot that kills the call, and then hears no new attach from the boot that follows.
  M.save()
  os.reboot()
  return true
end

function handlers.setPlayerPos(cmd)
  local p = M.findPlayer(cmd.player)
  if not p then return false, "unknown player" end
  for _, key in ipairs({ "x", "y", "z", "yaw", "pitch", "dimension" }) do
    if cmd[key] ~= nil then p[key] = cmd[key] end
  end
  return true
end

function handlers.setHost(cmd)
  if cmd.player == nil then M.ownerUuid = nil return true end
  local p = M.findPlayer(cmd.player)
  if not p then return false, "unknown player" end
  M.ownerUuid = p.uuid
  return true
end

function handlers.reboot()
  if M.dirty then M.save() end
  os.reboot()
  return true
end

function handlers.shutdown()
  if M.dirty then M.save() end
  os.shutdown()
  return true
end

function handlers.setEconomy(cmd)
  M.economyAvailable = cmd.available ~= false
  return true
end

function handlers.chat(cmd)
  local p = M.findPlayer(cmd.player)
  if not p then return false, "unknown player" end
  local message, hidden = cmd.message, false
  if type(message) == "string" and message:sub(1, 1) == "$" then
    -- Advanced Peripherals' own (Events.onChatBox): the message is kept out of chat and reaches chat boxes with every
    -- "$" taken out (String.replace), and isHidden true
    message, hidden = (message:gsub("%$", "")), true
  end
  if M.hasPeripheralType and not M.hasPeripheralType("chatBox") then return true end
  os.queueEvent("chat", p.name, message, p.uuid, hidden)
  return true
end

function handlers.playerClick(cmd)
  local p = M.findPlayer(cmd.player)
  if not p then return false, "unknown player" end
  -- PlayerDetectorBlock fires playerClick with just the player name, to detectors only
  if not M.hasPeripheralType or M.hasPeripheralType("playerDetector") then os.queueEvent("playerClick", p.name) end
  return true
end

local lastSeq = 0

--- Apply one command event; returns true when state changed.
function M.applyCommand(seq, json)
  if type(seq) == "number" then
    if seq <= lastSeq then return end
    lastSeq = seq
  end
  local cmd = textutils.unserializeJSON(json)
  local ok, err = false, "bad command"
  if type(cmd) == "table" and handlers[cmd.cmd] then
    ok, err = handlers[cmd.cmd](cmd)
  elseif type(cmd) == "table" and M.extraHandlers and M.extraHandlers[cmd.cmd] then
    ok, err = M.extraHandlers[cmd.cmd](cmd)
  else
    err = "unknown command"
  end
  M.save()
  -- no acknowledgement event: programs must not see simulator traffic a real server never sends
  M.lastCommandResult = { seq = seq, ok = ok and true or false, error = err }
end

--- The in-computer `sim` program (rom/ccsim/sim.lua, emulator only): a `ccsim_cmd` event whose seq is a "sim:..."
--- token. It runs the same handlers as a host command and answers with a `ccsim_reply` event (token, ok, error, data),
--- which only that program waits for. "list" answers with every command name, "state" with the players.
--- Only a computer a person drives has it (world.simProgram, set by `craftos-mcp window` and `app`): anywhere else such
--- an event is an ordinary event the program queued, as on a real server.
local localSeen = {}
function M.localCommand(token, json)
  if not (M.world and M.world.simProgram == true) then return false end
  if type(token) ~= "string" or token:sub(1, 4) ~= "sim:" or localSeen[token] then return end
  localSeen[token] = true
  if json == "list" then
    local names = {}
    for name in pairs(handlers) do names[#names + 1] = name end
    for name in pairs(M.extraHandlers or {}) do if not handlers[name] then names[#names + 1] = name end end
    table.sort(names)
    os.queueEvent("ccsim_reply", token, true, nil, table.concat(names, " "))
    return
  elseif json == "state" then
    M.save()
    local players = {}
    for i, p in ipairs(M.players) do players[i] = { name = p.name, online = p.online, balance = p.balance } end
    os.queueEvent("ccsim_reply", token, true, nil, textutils.serialize(players))
    return
  end
  local ran, err = pcall(M.applyCommand, nil, json)
  local result = ran and M.lastCommandResult or { ok = false, error = tostring(err) }
  os.queueEvent("ccsim_reply", token, result.ok, result.error)
end

--- Wrap os.pullEventRaw so commands are applied wherever the program is waiting.
function M.installEventHook()
  local rawPull = os.pullEventRaw
  local rawShutdown, rawReboot = os.shutdown, os.reboot
  function os.shutdown(...)
    if M.dirty then M.save() end
    if M.flushBeacon then M.flushBeacon() end
    return rawShutdown(...)
  end
  function os.reboot(...)
    if M.dirty then M.save() end
    if M.flushBeacon then M.flushBeacon() end
    return rawReboot(...)
  end
  -- Input-wait beacon for the test harness (any program, no cooperation needed): which event the
  -- program is blocked on, and how many events of each kind it has actually been handed. A harness
  -- sends input, waits for the matching `delivered` counter to move, then waits for `blocked` again.
  -- cmdSeq: the newest host command applied, so the harness knows a command has taken effect.
  local beacon = { seq = 0, blocked = false, filter = "*", delivered = {}, last = {}, cmdSeq = 0 }
  local lastBlockedPublish = 0
  -- Trace log: events handed to the program and everything it prints (errors included), one line each
  -- ("<ms> E|O|X text"), read by the harness from a byte offset. Capped so a chatty loop cannot fill the disk.
  -- Lines wait in memory and go out with the beacon. The file is opened per write, not kept open: an open handle
  -- would count against the program's file limit.
  do local f = fs.open(TRACE_PATH, "w") if f then f.close() end end
  local traceLines, tracePending = 0, {}
  local function flushTrace()
    if #tracePending == 0 then return end
    local f = fs.open(TRACE_PATH, "a")
    if f then
      f.write(table.concat(tracePending, "\n") .. "\n")
      f.close()
    end
    tracePending = {}
  end
  -- The beacon is written at most every BEACON_MS (virtual) ms. A change inside that waits for a sim timer that
  -- writes it, so a burst of events costs a few writes instead of one per event, and the last state always lands.
  local BEACON_MS = 50
  local lastBeaconWrite, beaconPending, beaconTimer = -math.huge, false, nil
  local function writeBeacon()
    beacon.seq = beacon.seq + 1
    beaconPending = false
    lastBeaconWrite = os.epoch("utc")
    local h = fs.open(BEACON_PATH, "w")
    if h then
      h.write(textutils.serializeJSON(beacon))
      h.close()
    end
    flushTrace()
  end
  local function publishBeacon(now)
    beaconPending = true
    local since = os.epoch("utc") - lastBeaconWrite
    if now or since >= BEACON_MS then
      writeBeacon()
    elseif not beaconTimer then
      -- a sim timer, so a main-thread wait (ccsim/peripherals.lua) that swallows it still writes the beacon
      beaconTimer = M.after((BEACON_MS - since) / 1000, function()
        beaconTimer = nil
        if beaconPending then writeBeacon() end
      end)
    end
  end
  M.flushBeacon = function() if beaconPending then writeBeacon() else flushTrace() end end
  local function trace(kind, text)
    if traceLines >= TRACE_MAX_LINES then return end
    traceLines = traceLines + 1
    if traceLines == TRACE_MAX_LINES then text = "(trace full, later lines dropped)" end
    text = tostring(text):gsub("[\r\n]+", " ")
    tracePending[#tracePending + 1] = string.format("%d %s %s", math.floor(os.clock() * 1000), kind, text:sub(1, 300))
    -- an error goes out at once, in case nothing runs after it
    if kind == "X" or #tracePending >= 200 then flushTrace() end
  end
  local function joinArgs(...)
    local t = table.pack(...)
    for i = 1, t.n do t[i] = tostring(t[i]) end
    return table.concat(t, "\t")
  end
  local rawPrint, rawPrintError = print, printError
  function print(...)
    trace("O", joinArgs(...))
    return rawPrint(...)
  end
  function printError(...)
    trace("X", joinArgs(...))
    return rawPrintError(...)
  end

  -- Reproducible randomness: once pinned, math.randomseed(x) from the program is ignored so the
  -- sequence stays the one the harness chose, even if the program seeds itself from the clock.
  -- Cobalt works the bound out as a Java int, so a range that does not fit one fails
  local rawRandom = math.random
  function math.random(m, n)
    if n ~= nil and n - m + 1 > 2147483647 then
      error("vm error: java.lang.IllegalArgumentException: bound must be positive", 2)
    end
    if n ~= nil then return rawRandom(m, n) end
    if m ~= nil then return rawRandom(m) end
    return rawRandom()
  end

  local rawRandomseed = math.randomseed
  local function pinSeed(value)
    rawRandomseed(value)
    math.randomseed = function() end
  end
  if tonumber(M.world.seed) then pinSeed(tonumber(M.world.seed)) end
  function handlers.seed(cmd)
    if not tonumber(cmd.value) then return false, "seed needs a number" end
    pinSeed(tonumber(cmd.value))
    return true
  end

  -- Virtual time jump (engine hook, removed from os so programs never see it): moves os.clock/os.epoch
  -- forward and fires the timers that fall due, so sleeps and timeouts pass without waiting.
  local rawAdvance = os.__ccsimAdvance
  os.__ccsimAdvance = nil
  M.native = os.__ccsimNative
  os.__ccsimNative = nil
  function handlers.advance(cmd)
    local seconds = tonumber(cmd.seconds)
    if not rawAdvance or not seconds or seconds <= 0 then return false, "advance needs seconds > 0" end
    rawAdvance(seconds)
    return true
  end

  local function noteDelivered(event)
    local name = event[1]
    beacon.delivered[name] = (beacon.delivered[name] or 0) + 1
    if name ~= "timer" then
      local entry = { name }
      for i = 2, math.min(event.n, 4) do
        local v = event[i]
        entry[#entry + 1] = (type(v) == "number" or type(v) == "string" or type(v) == "boolean") and v or tostring(type(v))
      end
      beacon.last[#beacon.last + 1] = entry
      if #beacon.last > 8 then table.remove(beacon.last, 1) end
      local parts = {}
      for i, v in ipairs(entry) do parts[i] = tostring(v) end
      trace("E", table.concat(parts, " "))
    end
  end
  -- Under multishell (and parallel, rednet) several coroutines wait in this hook at once: the outer event
  -- loop gets every event first and passes it down. Only the innermost waiting coroutine is the program,
  -- so remember how deeply each coroutine is nested and count an event as delivered, and report what
  -- is being waited for, only for the deepest one.
  --- The player the harness says made a touch: the engine's touch then carries "ccsim_player:<name>" as a fifth value.
  local function touchedBy(tag)
    if type(tag) == "string" and tag:sub(1, 13) == "ccsim_player:" then return tag:sub(14) end
    return nil
  end
  local depthOf = setmetatable({}, { __mode = "k" })
  local rawCreate, rawRunning, rawStatus = coroutine.create, coroutine.running, coroutine.status
  function coroutine.create(fn)
    local co = rawCreate(fn)
    local parent = rawRunning()
    depthOf[co] = (parent and depthOf[parent] or 0) + 1
    return co
  end
  local waiting = setmetatable({}, { __mode = "k" }) -- coroutine -> { depth, filter, order }
  local MAIN, order = {}, 0
  local function deepest()
    local best
    for co, rec in pairs(waiting) do
      if type(co) == "thread" and rawStatus(co) == "dead" then
        waiting[co] = nil
      elseif not best or rec.depth > best.depth or (rec.depth == best.depth and rec.order > best.order) then
        best = rec
      end
    end
    return best
  end
  function os.pullEventRaw(filter)
    local co = rawRunning() or MAIN
    local rec = { depth = depthOf[co] or 0, filter = filter or "*", order = 0 }
    while true do
      order = order + 1
      rec.order = order
      waiting[co] = rec
      local leaf = deepest()
      local now = os.epoch("utc")
      if not beacon.blocked or beacon.filter ~= leaf.filter or now - lastBlockedPublish > 100 then
        beacon.blocked, beacon.filter = true, leaf.filter
        lastBlockedPublish = now
        publishBeacon()
      end
      local event = table.pack(rawPull())
      if M.dirty then M.save() end
      local inner = deepest()
      local isProgram = inner == nil or rec.depth >= inner.depth
      waiting[co] = nil
      -- Until an event is handed on, the program is still waiting: what the sim swallows leaves the beacon as it was
      if event[1] == "timer" and event[2] == beaconTimer then
        local fn = M.simTimers[event[2]]
        M.simTimers[event[2]] = nil
        fn()
      elseif event[1] == "ccsim_cmd" and type(event[2]) == "string" and M.world and M.world.simProgram == true then
        M.localCommand(event[2], event[3]) -- the sim program typed into the computer
      elseif event[1] == "ccsim_cmd" and type(event[2]) ~= "string" then -- the host's (numbered) and tests' (nil)
        beacon.blocked = false
        M.applyCommand(event[2], event[3])
        beacon.cmdSeq = lastSeq
        -- a command that failed with a reason (no such peripheral, ...) tells the harness why
        local result = M.lastCommandResult
        if result and result.seq == lastSeq and not result.ok and type(result.error) == "string" then
          beacon.cmdError = { seq = lastSeq, error = result.error }
        end
        lastBlockedPublish = 0
        publishBeacon(true)
      elseif M.unloaded then
        -- an unloaded computer runs nothing: every event is lost until it loads again
      elseif event[1] == "timer" and M.simTimers[event[2]] then
        local fn = M.simTimers[event[2]]
        M.simTimers[event[2]] = nil
        fn()
      elseif event[1] == "ccsim_net" then
        if M.onNet then M.onNet(event[2], event[3]) end -- comes back as modem_message events
      elseif event[1] == "ccsim_link" then
        if M.onLink then M.onLink(event[2], event[3]) end -- linked computers (2.2.36)
      elseif event[1] == "ccsim_world" then
        if M.onWorld then M.onWorld(event[2], event[3]) end -- blocks another computer changed (ccsim/turtle)
      elseif event[1] == "monitor_touch" and touchedBy(event[5]) and not M.findPlayer(touchedBy(event[5])) then
        -- the harness named a player the world does not hold: the touch is refused, not given to someone else
        trace("X", "ccsim: monitor_touch by unknown player " .. touchedBy(event[5]) .. " dropped")
      elseif M.onTouch and event[1] == "monitor_touch" and event[5] == nil then
        -- 2.2.36 with nobody interacting: linked computers still hear the touch, with no player
        os.queueEvent("monitor_touch", event[2], event[3], event[4], "ccsim")
        M.onTouch(event[2], event[3], event[4], nil)
      elseif event[1] == "monitor_touch" then
        if filter == nil or filter == "monitor_touch" then
          beacon.blocked = false
          if isProgram then
            event[5], event.n = nil, math.min(event.n, 4)
            noteDelivered(event)
            publishBeacon()
          end
          return table.unpack(event, 1, event.n)
        end
      elseif filter == nil or event[1] == filter or event[1] == "terminate" then
        beacon.blocked = false
        if isProgram then noteDelivered(event) publishBeacon() end
        return table.unpack(event, 1, event.n)
      end
    end
  end
end

--- Send a player a clickable chat prompt. request is session, claim, offer or allowance: what the click grants.
--- `extra` fields travel with the pending approval.
function M.prompt(player, request, text, extra)
  local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  local parts = {}
  for i = 1, 12 do
    local k = math.random(1, #chars)
    parts[i] = chars:sub(k, k)
  end
  local nonce = table.concat(parts)
  M.pending[nonce] = {
    uuid = player.uuid,
    request = request,
    expiresAt = M.nowMs() + M.config.nonceExpirySeconds * 1000,
  }
  for k, v in pairs(extra or {}) do M.pending[nonce][k] = v end
  M.say(player, text, { kind = request, nonce = nonce })
  if M.world.autoApprove then M.approve(player.uuid, nonce) end
  M.save()
  return nonce
end

--- Mark a pending approval as clicked. Used by the host command and autoApprove.
function M.approve(uuid, nonce)
  local now = M.nowMs()
  for key, pending in pairs(M.pending) do
    if pending.uuid == uuid and (nonce == nil or nonce == key) then
      M.pending[key] = nil
      if pending.expiresAt < now then return false, "nonce expired" end
      if pending.request == "offer" then
        if M.ownerUuid then return false, "already taken" end
        M.ownerUuid = uuid
      elseif pending.request == "claim" then
        M.ownerUuid = uuid
      elseif M.onApprove and M.onApprove[pending.request] then
        M.onApprove[pending.request](pending, now)
      else
        M.sessions[uuid] = { uuid = uuid, last = now }
      end
      return true
    end
  end
  return false, "no pending approval"
end

return M
