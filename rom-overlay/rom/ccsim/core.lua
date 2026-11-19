-- ccsim core: simulated server world for the vhcctweaks / Advanced Peripherals APIs.
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

-- The engine's channel to the host (os.__ccsimHost, engine/src/apis/os.cpp, on when the runner starts the engine with
-- --host-channel): what the sim tells the host (packets for other computers, the input-wait beacon, the trace) goes
-- over the engine's own stdout, as it happens, instead of into files the host reads over and over. Taken out of os
-- here, so no program sees it. Without it (another host, the browser build) everything goes to the files as before.
do
  local rawHost = os.__ccsimHost
  os.__ccsimHost = nil
  if rawHost and rawHost("?", "") then M.host = rawHost end
end

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
  -- vhcctweaks 2.2.36 (only read when the world turns 2.2.36 on)
  maxLinksPerComputer = 64,
  maxBatchMoves = 256,
  batchTimeBudgetMicros = 2000,
  maxWatchesPerComputer = 64,
  maxAllowanceMinutes = 240,
  -- Emulator only: what one moveMany move costs against batchTimeBudgetMicros, so a test can force an early stop
  batchMoveCostMicros = 10,
  -- vhcctweaks 2.2.37 (only read when the world says 2.2.37): vaultDetails.gearScore and gearScoreLines
  gearScore = true,
  gearScoreLines = true,
  -- Emulator only: Vault Hunters' own gear_power.json minLevel, the level Gear Power starts at
  gearPowerMinLevel = 100,
}

-- The vhcctweaks mod (ccvault, vhcc, lockdown, and its changes to CC and Advanced Peripherals). On by default; off when
-- the world says `vhcctweaks: false` or the ROM has no /rom/ccsim/vhcc.lua (a build without the mod). Off, the server
-- is plain CC:Tweaked 1.101.3, Advanced Peripherals 0.7.31r and Mekanism with their own default behaviour.
M.vhcc = false
-- vhcctweaks 2.2.36 behaviour (the default with the mod; a world with vhcctweaks "2.2.35" opts out)
M.v36 = false
-- vhcctweaks 2.2.37 on top of 2.2.36: only for a world that says `vhcctweaks: "2.2.37"` (ccsim/vhcc237.lua)
M.v37 = false
--- The Minecraft / CC:Tweaked version the world is on (packages/runner/src/versions.ts; world.json `version`).
--- Modules read it to follow a version: what CC:Tweaked 1.121.0 does differently from 1.101.3 is behind M.cc121
--- (docs/turtle.md, "Minecraft versions").
M.version = { mc = "1.18.2", cc = "1.101.3", loader = "forge", blockData = "/rom/ccsim/turtle/data/" }
--- The world runs CC:Tweaked 1.121.0 (Minecraft 1.20.1 and 1.21.1); set by M.load from the version.
M.cc121 = false
--- Whether the world's CC:Tweaked is at least this version ("1.109.0").
function M.ccAtLeast(want)
  local function parts(v)
    local a, b, c = tostring(v):match("^(%d+)%.(%d+)%.(%d+)$")
    return tonumber(a) or 0, tonumber(b) or 0, tonumber(c) or 0
  end
  local a1, b1, c1 = parts(M.version.cc)
  local a2, b2, c2 = parts(want)
  if a1 ~= a2 then return a1 > a2 end
  if b1 ~= b2 then return b1 > b2 end
  return c1 >= c2
end
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
M.vhccDir = "/.vhcc_data"
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
    vaultLevel = def.vaultLevel, -- Vault Hunters level (2.2.36 getPlayerVaultLevel); nil: no vault data
    equipment = def.equipment,   -- worn and held items (2.2.36 getPlayerEquipment)
    -- 2.2.37: what Vault Hunters knows about the player (ccsim/vhcc237.lua)
    gearPower = M.v37 and def.gearPower or nil,
    temper = M.v37 and def.temper or nil,
    reputation = M.v37 and def.reputation or nil,
    greedTier = M.v37 and def.greedTier or nil,
    skills = (M.v37 or nil) and def.skills, -- false: Vault Hunters cannot read them
    stats = (M.v37 or nil) and def.stats,
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
  if type(world.version) == "table" then
    for key, value in pairs(world.version) do M.version[key] = value end
  end
  M.cc121 = M.ccAtLeast("1.121.0")
  -- 2.2.36 is the target and the default; "2.2.35" is kept only as an explicit opt-out for old measurements
  M.vhcc = world.vhcctweaks ~= false and fs.exists("/rom/ccsim/vhcc.lua")
  M.v36 = M.vhcc and world.vhcctweaks ~= "2.2.35"
  M.v37 = M.vhcc and world.vhcctweaks == "2.2.37"
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
  -- What a call to a peripheral of a vhcctweaks-linked computer costs, in ms (the runner resolves world.linkLatency
  -- and CRAFTOS_LINK_LATENCY; 0 is "fast"). Inventory methods wait for the server tick instead (deviation 164).
  M.linkLatency = tonumber(world.linkLatency) or 0
  -- 2.2.36 tests: ccvault function name -> how many calls answer nil, "internal error" (-1: every call)
  if M.v36 and type(world.internalErrors) == "table" then
    M.internalErrors = {}
    for name, times in pairs(world.internalErrors) do M.internalErrors[name] = times end
  end
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
  if M.v37 then
    for name, stats in pairs(saved.vaultStats or {}) do
      local p = M.findPlayer(name)
      if p then
        p.gearPower, p.temper, p.reputation, p.greedTier = stats.gearPower, stats.temper, stats.reputation, stats.greedTier
        p.skills, p.stats = stats.skills, stats.stats
      end
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

-- A state that takes long to write (a node holding thousands of pieces: seconds) is written at most once in twice the
-- time its last write took, and at least 200 ms apart, by a timer rather than at every call and every wait: a linked
-- call to such a computer cost a whole-state write each time, a second or more where the game spends one tick
-- (deviation 167). A cheap state is written as it always was. Commands, shutdown and reboot always write it at once.
local SLOW_SAVE_MS = 50
local flushTimer
local function slowState() return (M.saveCost or 0) >= SLOW_SAVE_MS end
local function saveWait()
  return math.max(200, 2 * (M.saveCost or 0)) - (M.nowMs() - (M.lastSaveEnd or 0))
end
local function deferSave()
  M.dirty = true
  if flushTimer then return end
  flushTimer = M.after(math.max(0.05, saveWait() / 1000), function()
    flushTimer = nil
    if M.dirty then M.save() end
  end)
end
--- The state changed and should be written when it can: now, or (for a slow state) once its wait is over.
function M.flush()
  if not M.dirty then return end
  if not slowState() or saveWait() <= 0 then M.save() else deferSave() end
end

--- Write state now if it has been quiet for 200 ms, otherwise flush at the next event or shutdown.
function M.touch()
  if slowState() then
    M.dirty = true
    M.flush()
    return
  end
  if M.nowMs() - (M.lastSave or 0) > 200 then M.save() else M.dirty = true end
end

local RS_SIDES = { "top", "bottom", "left", "right", "front", "back" }

--- What the computer puts out on its redstone sides, and what comes in: the analog level per side, and the
--- bundled colour mask where one is set.
function M.redstoneState()
  local rs = M.rawRedstone
  if not rs then return nil end
  local outputs, inputs, bundledOut, bundledIn = {}, {}, {}, {}
  for _, side in ipairs(RS_SIDES) do
    local function get(fn) local ok, v = pcall(rs[fn], side) return ok and tonumber(v) or 0 end
    outputs[side], inputs[side] = get("getAnalogOutput"), get("getAnalogInput")
    local bo, bi = get("getBundledOutput"), get("getBundledInput")
    if bo ~= 0 then bundledOut[side] = bo end
    if bi ~= 0 then bundledIn[side] = bi end
  end
  return { outputs = outputs, inputs = inputs, bundledOutputs = bundledOut, bundledInputs = bundledIn }
end

--- Wrap the redstone API (and its rs alias) so a changed output is saved like a peripheral call is. touch() batches
--- writes (one per 200 ms at most), and a write that changes nothing does not save at all.
function M.installRedstone()
  local orig = _G.redstone
  if type(orig) ~= "table" or M.rawRedstone then return end
  M.rawRedstone = orig
  local wrapped = {}
  for k, v in pairs(orig) do wrapped[k] = v end
  -- A wrapper in Lua adds a stack frame: the engine's argument errors then named this file's line
  -- ("/rom/ccsim/core.lua:446: bad argument #1 (string expected, got number)") where a Java function's name its
  -- caller, or nothing under a bare pcall (CC's redstone_spec checks the bare text). So the wrapper is made a native
  -- function, which positions a plain message at its caller, and the engine's own position is taken off first: the
  -- same pair scripts/rom-patches/startup-emulator.lua uses for fs.
  local toNative = M.native or os.__ccsimNative
  local getinfo = debug.getinfo
  local function plain(fn, ...)
    local r, here = table.pack(pcall(fn, ...)) if not r[1] then here = getinfo(1, "Sl") end -- one line: the pcall's
    if r[1] then return r end
    local err = r[2]
    if type(err) == "string" and here then
      local at = here.short_src .. ":" .. here.currentline .. ": "
      if err:sub(1, 7) == "pcall: " then err = err:sub(8)
      elseif err:sub(1, #at) == at then err = err:sub(#at + 1) end
    end
    error(err, 0)
  end
  local function watch(name, reader)
    local fn = orig[name]
    if type(fn) ~= "function" then return end
    local function inner(side, ...)
      local before = type(side) == "string" and select(2, pcall(orig[reader], side)) or nil
      local r = plain(fn, side, ...)
      if select(2, pcall(orig[reader], side)) ~= before then M.touch() end
      return table.unpack(r, 2, r.n)
    end
    wrapped[name] = toNative and toNative(inner) or inner
  end
  watch("setOutput", "getAnalogOutput")
  watch("setAnalogOutput", "getAnalogOutput")
  watch("setAnalogueOutput", "getAnalogOutput")
  watch("setBundledOutput", "getBundledOutput")
  _G.redstone = wrapped
  if type(_G.rs) == "table" then _G.rs = wrapped end
end

--- Persist everything a test might want to assert on.
function M.save()
  M.lastSave, M.dirty = M.nowMs(), false
  -- One instant for the whole snapshot: every machine and the tick count it reports come from the same moment, even
  -- when the host is slow enough for a tick to pass while the state is gathered.
  local outer = M.frozenMs ~= nil
  local started = os.epoch("utc")
  M.frozenMs = M.frozenMs or started
  local ok, err = pcall(M.saveNow)
  if not outer then M.frozenMs = nil end
  -- what a write costs here, for how often a slow one may be repeated (M.flush)
  M.lastSaveEnd = os.epoch("utc")
  M.saveCost = M.lastSaveEnd - started
  if not ok then error(err, 0) end
end

--- What the world file says now, after the host's commands: the players (who is online, where they stand, what
--- they have), the weather and time of day, entities, where this computer is, and the virtual peripherals put down
--- or taken away. A reboot starts from the world file again; a snapshot (the app's) starts from this, with the rest
--- of state.json for everything a reboot keeps.
local PLAYER_FIELDS = {
  "name", "uuid", "balance", "online", "onOtherServer", "x", "y", "z", "yaw", "pitch", "dimension", "health",
  "maxHealth",
}
PLAYER_FIELDS[#PLAYER_FIELDS + 1] = "vaultLevel"
PLAYER_FIELDS[#PLAYER_FIELDS + 1] = "equipment"
-- a copy of plain data: state.json may hold a table once only (textutils.serializeJSON refuses repeats)
local function copyData(v)
  if type(v) ~= "table" then return v end
  local out = {}
  for k, x in pairs(v) do
    if type(x) ~= "function" and type(x) ~= "thread" and type(x) ~= "userdata" then out[k] = copyData(x) end
  end
  return out
end
function M.liveWorld()
  local players = {}
  for i, p in ipairs(M.players) do
    local def = {}
    for _, key in ipairs(PLAYER_FIELDS) do def[key] = copyData(p[key]) end
    players[i] = def
  end
  local owner = M.ownerUuid and M.byUuid[M.ownerUuid]
  return {
    players = players,
    host = owner and owner.name or nil,
    environment = copyData(M.world.environment),
    entities = copyData(M.world.entities),
    position = copyData(M.position),
    peripherals = copyData(M.worldPeripherals or M.world.peripherals),
    -- the engine's monitors and drives next to it now (peripherals.lua), for the browser app's world panel
    engine = M.engineBlocks and M.engineBlocks() or nil,
  }
end

--- state.json as textutils.serializeJSON writes it (the same escapes, the same rule for a list or an object, the same refusal
--- of a table met twice), but built in one pass with table.concat. CC's own builds each object by joining strings onto it,
--- so its time grows with the square of the size: a vault node holding 15,000 pieces took longer than the computer's 7 s
--- without yielding to write, failing its boot and the shop's listDetailed calls (deviation 197). Writing the state is the
--- emulator's work, not the program's, so every few thousand values it starts the computer's 7 s again (serverWork).
do
  local empty, null = textutils.empty_json_array, textutils.json_null
  local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
  for i = 0, 0x1f do
    local c = string.char(i)
    if escapes[c] == nil then escapes[c] = ("\\u00%02X"):format(i) end
  end
  local function hexify(c) return ("\\u00%02X"):format(c:byte()) end
  local function str(s) return '"' .. s:gsub('[\0-\31"\\]', escapes):gsub("[\127-\255]", hexify) .. '"' end
  function M.encodeJSON(value)
    local out, n, seen, count = {}, 0, {}, 0
    local function put(s)
      n = n + 1
      out[n] = s
    end
    local function encode(v)
      count = count + 1
      if count % 4000 == 0 and M.serverWork then M.serverWork() end
      local kind = type(v)
      if v == empty then put("[]")
      elseif v == null then put("null")
      elseif kind == "table" then
        if seen[v] ~= nil then error("Cannot serialize table with recursive entries", 0) end
        seen[v] = true
        if next(v) == nil then
          put("{}")
          return
        end
        local keys, largest = {}, 0
        for k in pairs(v) do
          if type(k) == "string" then keys[#keys + 1] = k
          elseif type(k) == "number" and k > largest then largest = k end
        end
        if #keys > 0 or largest == 0 then
          -- an object: its string keys, in pairs order as CC's are, and no numbered entries
          put("{")
          local first = true
          for k, x in pairs(v) do
            if type(k) == "string" then
              if not first then put(",") end
              first = false
              put(str(k))
              put(":")
              encode(x)
            end
          end
          put("}")
        else
          put("[")
          for k = 1, largest do
            if k > 1 then put(",") end
            if v[k] == nil then put("null") else encode(v[k]) end
          end
          put("]")
        end
      elseif kind == "string" then put(str(v))
      elseif kind == "number" or kind == "boolean" then put(tostring(v))
      else error("Cannot serialize type " .. kind, 0) end
    end
    encode(value)
    return table.concat(out)
  end
end

function M.saveNow()
  if M.beforeObserve then M.beforeObserve() end -- machines on the virtual clock (Mekanism QIO) catch up first
  M.peekEconomy() -- what other computers moved shows here too
  local balances = {}
  for _, p in ipairs(M.players) do balances[p.name] = p.balance end
  local owner = M.ownerUuid and M.byUuid[M.ownerUuid]
  -- the server mod's economy and approvals: only a world with it on has them, so a plain world's state has none
  local econ = M.vhcc
  local state = {
    balances = econ and balances or nil,
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
    vaultStats = M.v37 and (function()
      local stats = {}
      for _, p in ipairs(M.players) do
        if p.gearPower or p.temper or p.reputation or p.greedTier or p.skills ~= nil or p.stats ~= nil then
          stats[p.name] = { gearPower = p.gearPower, temper = p.temper, reputation = p.reputation, greedTier = p.greedTier,
            skills = p.skills, stats = p.stats }
        end
      end
      return next(stats) and stats or nil
    end)() or nil,
    ledger = econ and M.ledger or nil,
    rejections = econ and M.rejections or nil,
    chat = M.chat,
    host = owner and owner.name or nil,
    interacting = M.interaction and M.byUuid[M.interaction.uuid] and M.byUuid[M.interaction.uuid].name or nil,
    authenticated = econ and (function()
      -- the interacting player when approved, otherwise any approved player
      local uuid = M.interaction and M.sessions[M.interaction.uuid] and M.interaction.uuid or next(M.sessions)
      return uuid and M.byUuid[uuid] and M.byUuid[uuid].name or nil
    end)() or nil,
    terminalLocked = nil, -- set below: false is a value too
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
    pendingApprovals = econ and (function()
      local n = 0
      for _ in pairs(M.pending) do n = n + 1 end
      return n
    end)() or nil,
    inventories = M.inventoryState and M.inventoryState() or nil,
    redstone = M.redstoneState(), -- the computer's own sides: outputs, inputs, bundled
    peripherals = M.peripheralState and M.peripheralState() or nil,
    qio = M.qioState and M.qioState() or nil,
    addons = M.addonState and M.addonState() or nil, -- addon-wide state (ccsim/addons), by module
    -- turtles (ccsim/turtle): the turtle itself, and every block, dropped item and mob the sim changed
    turtle = M.turtleState and M.turtleState() or nil,
    blocks = M.blockState and M.blockState() or nil,
    droppedItems = M.droppedItemState and M.droppedItemState() or nil,
    -- the world file as it stands now (liveWorld): a snapshot starts the computer from it
    live = (function()
      local ok, live = pcall(M.liveWorld)
      return ok and live or nil
    end)(),
  }
  if econ then state.terminalLocked = M.terminalLocked end
  -- written only when it says something new: an idle computer's saves were the same text again and again, each one
  -- a file write (and, on Windows, a scan of it)
  local text = M.encodeJSON(state)
  if text ~= M.lastStateText then
    local h = fs.open(STATE_PATH, "w")
    if h then
      h.write(text)
      h.close()
      M.lastStateText = text
    end
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
  -- Computers belong to whoever placed them; one with no host offers itself on every right-click (vhcctweaks)
  if M.vhcc and M.kind == "block" and not M.ownerUuid then
    for nonce, pending in pairs(M.pending) do
      if pending.request == "offer" and pending.uuid == p.uuid then M.pending[nonce] = nil end
    end
    M.prompt(p, "offer", "[CCVault] Computer #" .. M.computerId .. " has no host. Claim it? Scripts on it can spend from your wallet. [CLAIM]")
  end
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
    -- the hidden "$" channel is removed by vhcctweaks
    if M.vhcc then return true end
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
  local handler = type(cmd) == "table" and (handlers[cmd.cmd] or (M.extraHandlers and M.extraHandlers[cmd.cmd]))
  if handler then
    -- a handler that raises (a field of the wrong type) fails the command, not the program waiting for an event
    local ran, a, b = pcall(handler, cmd)
    if ran then ok, err = a, b else ok, err = false, tostring(a) end
    -- a refusal without a reason still reaches the harness as a failure
    if not ok and type(err) ~= "string" then err = cmd.cmd .. " was refused" end
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
    -- the server mod's economy and approval commands are only listed where the world has the mod on
    local SERVER_MOD = { approve = true, revoke = true, setBalance = true, setEconomy = true, setHost = true, interact = true }
    local function listed(name) return M.vhcc or not SERVER_MOD[name] end
    local names = {}
    for name in pairs(handlers) do if listed(name) then names[#names + 1] = name end end
    for name in pairs(M.extraHandlers or {}) do
      if not handlers[name] and listed(name) then names[#names + 1] = name end
    end
    table.sort(names)
    os.queueEvent("ccsim_reply", token, true, nil, table.concat(names, " "))
    return
  elseif json == "state" then
    M.save()
    local players = {}
    for i, p in ipairs(M.players) do
      players[i] = { name = p.name, online = p.online, balance = M.vhcc and p.balance or nil }
    end
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
    if M.flushHost then M.flushHost() end -- block changes held back (ccsim/modem.lua)
    return rawShutdown(...)
  end
  function os.reboot(...)
    if M.dirty then M.save() end
    if M.flushBeacon then M.flushBeacon() end
    if M.flushHost then M.flushHost() end
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
  -- with the host channel (M.host) the beacon and the trace go over it, not into these files
  if not M.host then local f = fs.open(TRACE_PATH, "w") if f then f.close() end end
  local traceLines, tracePending = 0, {}
  local function flushTrace()
    if #tracePending == 0 then return end
    if M.host then
      M.host("T", table.concat(tracePending, "\n") .. "\n")
      tracePending = {}
      return
    end
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
    if M.host then
      -- the trace first, so a host that sees the beacon move has the lines that led to it
      flushTrace()
      M.host("B", textutils.serializeJSON(beacon))
      return
    end
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
  -- math.random itself is the engine's: Cobalt 0.6's java.util.Random on 1.101.3, with its Java int bounds
  -- (craftos2-lua lmathlib.c), and Lua 5.4's on 1.121.0, whose Cobalt 0.9.9 takes any range.
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
  -- A person's jump (`sim advance`, stepped = true): one timer at a time, the programs running between them, as the
  -- time bar's jump; it goes on after the answer, while the computer waits. An engine without it: the plain jump.
  local rawJump = os.__ccsimJump
  os.__ccsimJump = nil
  -- The server's own work done here (machines catching up after a jump) does not count towards the computer's
  -- 7 s limit without yielding: call it now and then in a long catch-up (an engine without it: nothing)
  M.serverWork = os.__ccsimServerWork or function() end
  os.__ccsimServerWork = nil
  M.native = os.__ccsimNative -- emulator.hide() removes it (scripts/rom-patches/startup-emulator.lua wraps fs with it)
  function handlers.advance(cmd)
    local seconds = tonumber(cmd.seconds)
    if not rawAdvance or not seconds or seconds <= 0 then return false, "advance needs seconds > 0" end
    if cmd.stepped == true and rawJump then rawJump(seconds) else rawAdvance(seconds) end
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
  --- A touch the engine made (a player's) carries a tag as its fifth value: "ccsim_engine" (no player named),
  --- "ccsim_player:<name>", or "ccsim" on the copy the sim queues again. One a program queued itself has none,
  --- and CC hands it on as an ordinary event, as it was queued and in the order it was queued.
  local function engineTouch(tag) return tag == "ccsim_engine" or touchedBy(tag) ~= nil end
  local function simTouch(tag) return tag == "ccsim" or engineTouch(tag) end
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
  -- A call on the computer thread to a linked computer's peripheral (a monitor's, ccsim/wiredrelay.lua) returns before
  -- the computer takes its next event in CC, so the coroutine that made it still gets every event that arrived
  -- meanwhile, in order. Here the call has to yield to hear its answer: what that coroutine is handed while it waits is
  -- kept for it alone (M.keepFor), and its next waits here take those first, as if they had only just arrived. The rest
  -- of the program gets each event once, as it comes. (Queued again instead, every other coroutine got each event a
  -- second time, and two such calls at once multiplied them until CC's 256-event queue dropped a call's task_complete
  -- and the call never returned.)
  local keptFor = setmetatable({}, { __mode = "k" }) -- coroutine -> events kept for its next waits
  function M.keepFor(event)
    local co = rawRunning() or MAIN
    local list = keptFor[co]
    if not list then
      list = {}
      keptFor[co] = list
    end
    list[#list + 1] = event
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
      if M.flushHost then M.flushHost() end -- the block changes held back go out before the wait (ccsim/modem.lua)
      M.flush() -- a change inside the 200 ms window (a redstone output) is written when the program waits (a slow state: soon after)
      local kept = keptFor[co]
      local event
      if kept and kept[1] then
        event = table.remove(kept, 1)
      else
        event = table.pack(rawPull())
      end
      M.flush()
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
      elseif event[1] == "monitor_touch" and M.normalMonitors and M.normalMonitors[event[2]] then
        -- a normal monitor: right-clicking it does nothing in game, only advanced monitors send monitor_touch
      elseif event[1] == "monitor_touch" and touchedBy(event[5]) and not M.findPlayer(touchedBy(event[5])) then
        -- the harness named a player the world does not hold: the touch is refused, not given to someone else
        trace("X", "ccsim: monitor_touch by unknown player " .. touchedBy(event[5]) .. " dropped")
      elseif M.vhcc and event[1] == "monitor_touch" and (event[5] == "ccsim_engine" and M.interaction or touchedBy(event[5])) then
        -- The touch as the engine sends it, with the player who made it when the harness names one: each touch
        -- carries its own player, so two players' touches close together keep their own names. Like
        -- ComputerInteractionTracker, renew the interaction, then send vhcc_touch and the touch in that order, so a
        -- script always sees who before where. The tag marks the second copy, which every coroutine then treats as
        -- a plain touch; only the program's copy drops it.
        local by = touchedBy(event[5])
        local uuid = by and M.findPlayer(by).uuid or M.interaction.uuid
        M.recordInteraction(uuid, M.nowMs())
        local who = M.byUuid[uuid]
        if who then os.queueEvent("vhcc_touch", who.name) end
        os.queueEvent("monitor_touch", event[2], event[3], event[4], "ccsim")
        if M.onTouch then M.onTouch(event[2], event[3], event[4], who and who.name or nil) end
      elseif M.onTouch and event[1] == "monitor_touch" and event[5] == "ccsim_engine" then
        -- 2.2.36 with nobody interacting: linked computers still hear the touch, with no player
        os.queueEvent("monitor_touch", event[2], event[3], event[4], "ccsim")
        M.onTouch(event[2], event[3], event[4], nil)
      elseif event[1] == "monitor_touch" and simTouch(event[5]) then
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
  M.say(player, text, { kind = request == "session" and "auth" or request, nonce = nonce, command = "/ccvault approve " .. nonce })
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
