-- ccsim ccvault: behaviour-faithful emulation of the vhcctweaks `ccvault` Lua API
-- (CCVaultAPI.java, SessionAuthManager, TransferService, TransactionLedger).
--
-- Notes on fidelity:
--  * Java LuaException => error(msg, 0). Functions that return `Object[]{null, msg}`
--    return nil, msg.
--  * Messages that contain an em dash in the mod show a "?" on the server (characters above 255 become "?"), so " ? " is used here;
--    the "no registered owner" message uses a plain hyphen in the mod and keeps it.
--  * The mod README mentions rate limits and `transfersRemaining`; the source has neither,
--    so neither is emulated.
return function(core)
  local ccvault = {}

  local OWNER_REGISTRATION_MESSAGE =
    "computer has no registered owner - right-click it and claim it in chat, or call ccvault.claimHost()"
  local MAX_REASON_LENGTH = 64

  local function typeName(v)
    if v == nil then return "nil" end
    return type(v)
  end

  -- CCVaultAPI's parameters go through CC:Tweaked's IArguments (transfer(String, String, long, String) in the
  -- 2.2.36 jar): getString takes strings only, getLong truncates a finite number toward zero (1.5 is 1)
  local function checkString(index, v)
    if type(v) == "string" then return v end
    error(("bad argument #%d (string expected, got %s)"):format(index, typeName(v)), 0)
  end

  local function checkLong(index, v)
    if type(v) ~= "number" then
      error(("bad argument #%d (number expected, got %s)"):format(index, typeName(v)), 0)
    end
    if v ~= v then error(("bad argument #%d (number expected, got nan)"):format(index), 0) end
    if v == math.huge or v == -math.huge then
      error(("bad argument #%d (number expected, got %s)"):format(index, v > 0 and "inf" or "-inf"), 0)
    end
    return v < 0 and math.ceil(v) or math.floor(v)
  end

  local function fmt(n)
    local s = tostring(math.floor(n))
    local out = s:reverse():gsub("(%d%d%d)", "%1,"):reverse()
    return (out:gsub("^,", ""))
  end

  -- ===== session / interaction state =====

  local function sessionExpired(session, now)
    return now - session.last > core.config.authIdleTimeoutMinutes * 60000
  end

  local function activeSession(uuid)
    local session = core.sessions[uuid]
    if not session then return nil end
    if sessionExpired(session, core.nowMs()) then
      core.sessions[uuid] = nil
      return nil
    end
    return session
  end

  local function touchSession(uuid)
    local session = activeSession(uuid)
    if session then session.last = core.nowMs() end
  end

  --- ComputerInteractionTracker.getPlayer: last interactor if still online.
  local function currentPlayer()
    local i = core.interaction
    if not i then return nil end
    return core.onlinePlayer(i.uuid)
  end

  --- getFreshPlayer: interaction must be recent as well.
  --- While a player has the computer's GUI open the mod refreshes the interaction every
  --- tick (pocket computers are always used that way). Block computers are only refreshed
  --- by right-clicks, which the sim models as `interact` commands and monitor touches.
  local function holdsInteraction()
    local hold = core.world.holdInteraction
    if hold == nil then return core.kind == "pocket" end
    return hold
  end

  local function freshPlayer()
    local i = core.interaction
    if not i then return nil end
    if not holdsInteraction()
      and core.nowMs() - i.at > core.config.interactionStaleSeconds * 1000 then
      return nil
    end
    return currentPlayer()
  end

  local function interactingPlayerOrThrow()
    local p = freshPlayer()
    if not p then error("no player interacting with this computer (or interaction expired)", 0) end
    return p
  end

  local function isAuthenticated(uuid)
    return activeSession(uuid) ~= nil
  end

  local function requireAuth()
    local player = interactingPlayerOrThrow()
    if not activeSession(player.uuid) then error("not authenticated ? call ccvault.requestAuth() first", 0) end
    touchSession(player.uuid)
  end

  local NAMED_PREFIX = "player:"
  local activeAllowance -- 2.2.36, set below

  local function isNamed(target)
    return target:sub(1, #NAMED_PREFIX):lower() == NAMED_PREFIX
  end

  --- CCVaultAPI.authorize: a named player is checked when resolved, anything else needs the last interactor's session.
  local function authorize(...)
    local anyNamed, anyLast = false, false
    for _, target in ipairs({ ... }) do
      anyNamed = anyNamed or isNamed(target)
      anyLast = anyLast or target:lower() == "player"
    end
    if anyLast or not anyNamed then requireAuth() end
  end

  local function approvedPlayer(target)
    local name = target:sub(#NAMED_PREFIX + 1)
    local player = core.findPlayer(name)
    if not player or not player.online then error("player '" .. name .. "' is not online", 0) end
    if not isAuthenticated(player.uuid) then error("player '" .. name .. "' has not approved this computer", 0) end
    return player, name
  end

  --- A named player must be at this table: online, approved here, and (up to 2.2.36) touching it within the staleness
  --- window. 2.2.37 (vhcctweaks e7c880a) drops the touch: the approval session alone lets the computer charge them, until
  --- they disconnect or go idle here.
  local function resolveNamedPlayer(target)
    local player, name = approvedPlayer(target)
    local touched = core.playerTouched[player.uuid]
    if not core.v37 and not holdsInteraction()
      and (not touched or core.nowMs() - touched > core.config.interactionStaleSeconds * 1000) then
      error("player '" .. name .. "' has not touched this computer recently", 0)
    end
    touchSession(player.uuid)
    return player.uuid
  end

  --- `noTouch`: 2.2.36 lets the host pay a named player who is online and approved here but not touching it.
  local function resolveTarget(target, noTouch)
    if isNamed(target) and noTouch then
      local player = approvedPlayer(target)
      touchSession(player.uuid)
      return player.uuid
    end
    if isNamed(target) then return resolveNamedPlayer(target) end
    local t = target:lower()
    if t == "player" then return interactingPlayerOrThrow().uuid end
    if t == "host" then
      if not core.ownerUuid then error(OWNER_REGISTRATION_MESSAGE, 0) end
      return core.ownerUuid
    end
    error("invalid target '" .. target .. "' ? use 'player', 'player:Name' or 'host'", 0)
  end

  local function balanceOf(uuid)
    if not core.economyAvailable then return -1 end
    local p = core.byUuid[uuid]
    if not p then return -1 end
    return p.balance
  end

  local function randomHex(bytes)
    local out = {}
    for i = 1, bytes do out[i] = string.format("%02x", math.random(0, 255)) end
    return table.concat(out)
  end

  --- Hex without string.format("%x"), which rejects millisecond timestamps in this Lua.
  local function hex(n)
    n = math.floor(n)
    if n <= 0 then return "0" end
    local digits, out = "0123456789abcdef", ""
    while n > 0 do
      local d = n % 16
      out = digits:sub(d + 1, d + 1) .. out
      n = (n - d) / 16
    end
    return out
  end

  local function txId()
    return hex(core.nowMs()) .. "-" .. randomHex(6)
  end

  local function notify(uuid, sign, amount, reason)
    local p = core.onlinePlayer(uuid)
    if not p then return end
    local bal = balanceOf(uuid)
    local text = "[CCVault] " .. sign .. fmt(amount) .. " tokens | " .. reason
    if bal >= 0 then text = text .. " | Bal: " .. fmt(bal) end
    core.say(p, text, { kind = sign == "-" and "debit" or "credit" })
  end

  local function pushLedger(id, from, to, amount, reason, playerUuid, hostUuid)
    local entry = {
      txId = id,
      from = from,
      to = to,
      amount = amount,
      reason = reason,
      computerId = core.computerId,
      playerUuid = playerUuid,
      hostUuid = hostUuid,
      timestamp = core.instant(),
    }
    core.ledger[#core.ledger + 1] = entry
    core.economyChanged()
    return entry
  end

  --- TransactionLedger.logRejection: a transfer the economy refused, in the history of the player it was for. Its
  --- `type` is "REJECTED:" and the txId it would have had; it has no txId of its own, so verifyTransaction never finds it.
  local function pushRejection(id, from, to, amount, reason, playerUuid, rejectionReason)
    core.rejections[#core.rejections + 1] = {
      type = "REJECTED:" .. id,
      from = from,
      to = to,
      amount = amount,
      reason = reason,
      computerId = core.computerId,
      playerUuid = playerUuid,
      rejectionReason = rejectionReason,
      timestamp = core.instant(),
      afterLedger = #core.ledger, -- the sim's own: where it falls among the transfers. Never handed to a program
    }
    core.economyChanged()
  end

  --- Whose history an entry is in: a transfer is in everyone's it names, a refusal only in its player's.
  local function involves(entry, uuid)
    if entry.rejectionReason ~= nil then return entry.playerUuid == uuid end
    return entry.from == uuid or entry.to == uuid or entry.playerUuid == uuid or entry.hostUuid == uuid
  end

  --- Transfers and refusals in the order they were logged.
  local function historyOf(uuid)
    local out, r = {}, 1
    local rejections = core.rejections or {}
    for i = 0, #core.ledger do
      while rejections[r] and (rejections[r].afterLedger or 0) <= i do
        if involves(rejections[r], uuid) then out[#out + 1] = rejections[r] end
        r = r + 1
      end
      local entry = core.ledger[i + 1]
      if entry and involves(entry, uuid) then out[#out + 1] = entry end
    end
    while rejections[r] do
      if involves(rejections[r], uuid) then out[#out + 1] = rejections[r] end
      r = r + 1
    end
    return out
  end

  local function copyEntry(entry)
    local copy = {}
    for k, v in pairs(entry) do
      if k ~= "afterLedger" then copy[k] = v end
    end
    return copy
  end

  -- ===== API =====

  function ccvault.isAvailable()
    return core.economyAvailable
  end

  function ccvault.requestAuth()
    local player = interactingPlayerOrThrow()
    local now = core.nowMs()
    for nonce, pending in pairs(core.pending) do
      if pending.expiresAt < now then core.pending[nonce] = nil end
    end
    if isAuthenticated(player.uuid) then
      touchSession(player.uuid)
      return true, "already authenticated"
    end
    for _, pending in pairs(core.pending) do
      if pending.uuid == player.uuid and pending.expiresAt > now then
        return nil, "auth request already pending ? check your chat"
      end
    end

    core.prompt(player, "session",
      "[CCVault] Computer #" .. core.computerId .. " is requesting access to your wallet. [APPROVE]")
    return true
  end

  function ccvault.isAuthenticated()
    local player = currentPlayer()
    if not player then return false end
    return isAuthenticated(player.uuid)
  end

  function ccvault.getBalance(target)
    target = checkString(1, target)
    authorize(target)
    local uuid = resolveTarget(target)
    local balance = balanceOf(uuid)
    if balance < 0 then return nil, "could not read balance" end
    return balance
  end

  function ccvault.getPlayerBalance(playerName)
    playerName = checkString(1, playerName)
    if playerName:match("^%s*$") then return nil, "playerName is required" end
    local name = playerName:match("^%s*(.-)%s*$")
    local uuid
    if name:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then
      uuid = name:lower()
    else
      local p = core.findPlayer(name)
      uuid = p and p.uuid or nil
      -- The first call for an unseen offline name looks it up in the background
      -- (2.2.36: a player on another server of the network is known to the economy, so needs no lookup)
      if p and not p.online and not p.lookedUp and not p.onOtherServer then
        p.lookedUp = true
        return nil, "looking up player '" .. name .. "' - try again"
      end
    end
    if not uuid or not core.byUuid[uuid] then
      -- a syntactically valid UUID is accepted even when unknown, like UUID.fromString
      if uuid and not core.byUuid[uuid] then
        local balance = balanceOf(uuid)
        if balance < 0 then return nil, "could not read balance" end
        return balance
      end
      return nil, "unknown player or UUID '" .. name .. "'"
    end
    local balance = balanceOf(uuid)
    if balance < 0 then return nil, "could not read balance" end
    return balance
  end

  function ccvault.transfer(from, to, amount, reason)
    from = checkString(1, from)
    to = checkString(2, to)
    amount = checkLong(3, amount)
    reason = checkString(4, reason)
    authorize(from, to)

    if from == to then return nil, "cannot transfer to self" end
    if amount <= 0 then return nil, "amount must be positive" end
    if reason:match("^%s*$") then return nil, "reason is required" end
    if #reason > MAX_REASON_LENGTH then
      return nil, "reason too long (max " .. MAX_REASON_LENGTH .. " chars)"
    end

    -- 2.2.36: a player's allowance pays this computer's host with no session or touch, up to what is left of it
    local allowance
    if core.v36 and isNamed(from) and to:lower() == "host" then
      local p = core.findPlayer(from:sub(#NAMED_PREFIX + 1))
      local a = p and activeAllowance(p.uuid)
      if a and amount <= a.remaining then allowance = { player = p, record = a } end
    end

    local fromUuid
    if allowance then
      -- on another server of the network the allowance stays, but nothing can be charged until they are back here
      if allowance.player.onOtherServer then return nil, "player not on this server" end
      if not allowance.player.online then
        error("player '" .. from:sub(#NAMED_PREFIX + 1) .. "' is not online", 0)
      end
      fromUuid = allowance.player.uuid
    else
      fromUuid = resolveTarget(from)
    end
    local toUuid = resolveTarget(to, core.v36 and from:lower() == "host")
    if fromUuid == toUuid then
      return nil, "cannot transfer to yourself ? player and host are the same account"
    end

    local playerUuid = isNamed(from) and fromUuid or isNamed(to) and toUuid or interactingPlayerOrThrow().uuid
    local hostUuid = core.ownerUuid

    -- TransferService.execute
    if amount > core.config.maxTransferAmount then
      return nil, "amount exceeds maximum (" .. core.config.maxTransferAmount .. ")"
    end
    if not core.economyAvailable then return nil, "economy system not available" end
    local sourceBalance = balanceOf(fromUuid)
    if sourceBalance < 0 then return nil, "could not read source balance" end
    if sourceBalance < amount then return nil, "insufficient balance" end

    local id = txId()
    -- EconomyBridge.transfer moves both balances in one transaction or neither. It refuses an account it does not
    -- know, and a test can make it refuse (refuseTransfers); TransferService logs the refusal
    local dest = core.byUuid[toUuid]
    local refuse = core.refuseTransfers and core.refuseTransfers ~= 0
    if refuse and core.refuseTransfers > 0 then core.refuseTransfers = core.refuseTransfers - 1 end
    if refuse or not dest then
      pushRejection(id, fromUuid, toUuid, amount, reason, playerUuid, "economy refused the transfer")
      core.save()
      return nil, "transfer failed"
    end
    core.byUuid[fromUuid].balance = core.byUuid[fromUuid].balance - amount
    dest.balance = dest.balance + amount
    core.economyChanged()
    if allowance then
      allowance.record.remaining = allowance.record.remaining - amount
      if allowance.record.remaining <= 0 then core.allowances[fromUuid] = nil end
    end
    pushLedger(id, fromUuid, toUuid, amount, reason, playerUuid, hostUuid)
    notify(fromUuid, "-", amount, reason)
    notify(toUuid, "+", amount, reason)
    core.save()
    return { txId = id, success = true }
  end

  function ccvault.getPlayerName()
    local p = currentPlayer()
    if not p then return nil end
    return p.name
  end

  function ccvault.getHostName()
    local owner = core.ownerUuid
    if not owner then return nil, OWNER_REGISTRATION_MESSAGE end
    local p = core.onlinePlayer(owner)
    if p then return p.name end
    return owner
  end

  function ccvault.claimHost()
    local player = interactingPlayerOrThrow()
    if player.uuid == core.ownerUuid then
      return { success = true, hostName = player.name, computerId = core.computerId }
    end
    -- The claim lands when the player clicks, so this returns before it happens
    local now = core.nowMs()
    for _, pending in pairs(core.pending) do
      if pending.uuid == player.uuid and pending.request == "claim" and pending.expiresAt > now then
        return nil, "host claim already pending ? check your chat"
      end
    end
    core.prompt(player, "claim",
      "[CCVault] Computer #" .. core.computerId .. " wants to make you its host. Scripts on it can spend from your wallet. [CONFIRM]")
    return nil, "confirm the host claim in chat"
  end

  function ccvault.forgetHost()
    local hadHost = core.ownerUuid ~= nil
    core.ownerUuid = nil
    core.terminalLocked = false
    core.save()
    return hadHost
  end

  function ccvault.setTerminalLock(locked)
    local player = interactingPlayerOrThrow()
    if player.uuid ~= core.ownerUuid then return nil, "only this computer's owner can change its lock" end
    core.terminalLocked = locked == true
    core.save()
    return true
  end

  function ccvault.isTerminalLocked()
    return core.terminalLocked
  end

  function ccvault.getComputerId()
    return core.computerId
  end

  function ccvault.getSessionInfo()
    local player = currentPlayer()
    local hostName
    if core.ownerUuid then
      local host = core.onlinePlayer(core.ownerUuid)
      hostName = host and host.name or core.ownerUuid
    end
    return {
      computerId = core.computerId,
      playerName = player and player.name or nil,
      hostName = hostName,
      isSelfPlay = (player ~= nil and core.ownerUuid ~= nil and player.uuid == core.ownerUuid),
      authenticated = (player ~= nil and isAuthenticated(player.uuid)),
    }
  end

  function ccvault.transferSelf(amount, reason)
    amount = checkLong(1, amount)
    reason = checkString(2, reason)
    requireAuth()
    if amount <= 0 then return nil, "amount must be positive" end
    if reason:match("^%s*$") then return nil, "reason is required" end
    if #reason > MAX_REASON_LENGTH then
      return nil, "reason too long (max " .. MAX_REASON_LENGTH .. " chars)"
    end

    local player = interactingPlayerOrThrow()
    local hostUuid = core.ownerUuid
    if not hostUuid then return nil, OWNER_REGISTRATION_MESSAGE end
    if player.uuid ~= hostUuid then
      return nil, "transferSelf is only for same-person sessions (player must be host)"
    end

    local balance = balanceOf(player.uuid)
    if balance < 0 then return nil, "could not read balance" end
    if balance < amount then return nil, "insufficient balance" end

    local id = "sim-" .. hex(core.nowMs()) .. "-" .. randomHex(4)
    pushLedger(id, player.uuid, player.uuid, amount, "[self-play] " .. reason, player.uuid, hostUuid)
    core.say(player,
      "[CCVault] [Self-Play] Self-transfer: " .. amount .. " tokens | " .. reason ..
        " | Bal: " .. fmt(balance),
      { kind = "selfplay" })
    core.save()
    return { txId = id, success = true, testMode = true, selfPlay = true }
  end

  function ccvault.verifyTransaction(id)
    id = checkString(1, id)
    requireAuth()
    if id:match("^%s*$") then return nil, "txId is required" end
    local player = interactingPlayerOrThrow()
    for _, entry in ipairs(core.ledger) do
      if entry.txId == id and involves(entry, player.uuid) then return copyEntry(entry) end
    end
    return nil
  end

  function ccvault.getTransactionHistory(limit)
    limit = checkLong(1, limit)
    requireAuth()
    local maxResults = core.config.maxHistoryResults
    if limit <= 0 then limit = 10 end
    if limit > maxResults then limit = maxResults end
    local player = interactingPlayerOrThrow()
    local mine = historyOf(player.uuid)
    local result = {}
    local first = math.max(1, #mine - limit + 1)
    for i = first, #mine do result[#result + 1] = copyEntry(mine[i]) end
    return result
  end

  -- ===== 2.2.36: spending allowances =====

  if core.v36 then
    core.allowances = core.allowances or {} -- uuid -> { remaining, expiresAt, requestId }

    activeAllowance = function(uuid)
      local a = core.allowances[uuid]
      if not a then return nil end
      if a.remaining <= 0 or core.nowMs() >= a.expiresAt then
        core.allowances[uuid] = nil
        return nil
      end
      return a
    end

    local requests = {} -- request id -> { done }
    local nextRequest = 0

    core.onApprove = core.onApprove or {}
    function core.onApprove.allowance(pending, now)
      local p = core.byUuid[pending.uuid]
      core.allowances[pending.uuid] = {
        remaining = pending.maxTokens,
        expiresAt = now + pending.minutes * 60000,
        requestId = pending.requestId,
      }
      local request = requests[pending.requestId]
      if request then request.done = true end
      os.queueEvent("ccvault_allowance", pending.requestId, p and p.name or pending.uuid, true)
    end

    -- Disconnecting and /ccvault revoke end allowances
    function core.onLeave(p) core.allowances[p.uuid] = nil end
    function core.onRevoke(p)
      if p then core.allowances[p.uuid] = nil else core.allowances = {} end
    end

    function ccvault.requestAllowance(player, maxTokens, minutes)
      player = checkString(1, player)
      maxTokens = checkLong(2, maxTokens)
      minutes = checkLong(3, minutes)
      -- the mod's order: a name, the amount, the minutes, the player here, an owner, then a request already waiting
      player = player:match("^%s*(.-)%s*$")
      if player == "" then return nil, "player is required" end
      if maxTokens <= 0 then return nil, "maxTokens must be positive" end
      local most = core.config.maxAllowanceMinutes
      if minutes < 1 or minutes > most then return nil, "minutes must be between 1 and " .. most end
      local p = core.findPlayer(player)
      -- offline here and on another server of the network are one answer
      if not p or not p.online or p.onOtherServer then return nil, "player not on this server" end
      local owner = core.ownerUuid and core.byUuid[core.ownerUuid]
      if not owner then return nil, OWNER_REGISTRATION_MESSAGE end
      for _, waiting in pairs(core.pending) do
        if waiting.uuid == p.uuid and waiting.request == "allowance" and waiting.expiresAt > core.nowMs() then
          return nil, "an allowance request to '" .. p.name .. "' is already waiting"
        end
      end
      nextRequest = nextRequest + 1
      local id = nextRequest
      local request = { done = false, name = p.name }
      requests[id] = request
      local label = os.getComputerLabel() or ("Computer #" .. core.computerId)
      local nonce
      -- the answer comes later, as an event; so does running out of time to give one
      core.after(core.config.nonceExpirySeconds, function()
        if request.done then return end
        request.done = true
        if nonce then core.pending[nonce] = nil end
        os.queueEvent("ccvault_allowance", id, request.name, false)
      end)
      nonce = core.prompt(p, "allowance",
        label .. " (owner " .. owner.name .. ") asks to charge you up to " .. maxTokens .. " tokens over " ..
          minutes .. " minutes [APPROVE]",
        { requestId = id, maxTokens = maxTokens, minutes = minutes })
      return id
    end

    --- A player's Vault Hunters level: read-only, no auth or touch, offline players too. The name or UUID resolves as
    --- for getPlayerBalance, including its first lookup of an offline name.
    function ccvault.getPlayerVaultLevel(playerName)
      playerName = checkString(1, playerName)
      local name = playerName:match("^%s*(.-)%s*$")
      if name == "" then return nil, "unknown player" end
      local p
      if name:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then
        -- a well-formed UUID is accepted as given; with no saved stats there is nothing to read
        p = core.byUuid[name:lower()] or core.byUuid[name]
        if not p then return nil, "no vault data" end
      else
        p = core.findPlayer(name)
        if not p then return nil, "unknown player" end
        if not p.online and not p.lookedUp and not p.onOtherServer then
          p.lookedUp = true
          return nil, "looking up player '" .. name .. "' - try again"
        end
      end
      if type(p.vaultLevel) ~= "number" then return nil, "no vault data" end
      return p.vaultLevel
    end

    local EQUIPMENT_SLOTS = { "head", "chest", "legs", "feet", "mainhand", "offhand" }

    --- What an online player wears and holds: each piece as getItemDetail describes it, empty slots left out, curios
    --- by slot type and index from 1. No auth, touch or range; one main-thread call, so it waits for the server tick.
    function ccvault.getPlayerEquipment(playerName)
      -- a mainThread=true method gets its arguments checked in the task, after the wait
      core.waitForServerTick()
      playerName = checkString(1, playerName)
      local name = playerName:match("^%s*(.-)%s*$")
      if name == "" then return nil, "unknown player" end
      local p
      if name:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then
        -- a well-formed UUID is accepted as given, like getPlayerBalance; nobody with it is online
        p = core.byUuid[name:lower()] or core.byUuid[name]
        if not p then return nil, "player offline" end
      else
        p = core.findPlayer(name)
        if not p then return nil, "unknown player" end
      end
      if not p.online then return nil, "player offline" end
      local worn, out = p.equipment or {}, { curios = {} }
      for _, slot in ipairs(EQUIPMENT_SLOTS) do
        local item = worn[slot]
        if type(item) == "table" and item.name then out[slot] = core.itemDetail(item) end
      end
      for slotType, items in pairs(type(worn.curios) == "table" and worn.curios or {}) do
        local details = {}
        for index, item in pairs(items) do
          local i = tonumber(index)
          if i and type(item) == "table" and item.name then details[i] = core.itemDetail(item) end
        end
        if next(details) then out.curios[slotType] = details end
      end
      return out
    end

    core.extraHandlers = core.extraHandlers or {}

    --- Sim command: put on, take off or swap one piece. `slot` is head, chest, legs, feet, mainhand or offhand, or
    --- `curio` (slot type) with `index` (from 1); `item` null empties it. `equipment` replaces everything at once.
    function core.extraHandlers.setEquipment(cmd)
      local p = core.findPlayer(cmd.player)
      if not p then return false, "unknown player" end
      if cmd.equipment ~= nil then
        p.equipment = cmd.equipment
        return true
      end
      p.equipment = p.equipment or {}
      if cmd.curio ~= nil then
        local index = tonumber(cmd.index)
        if type(cmd.curio) ~= "string" or not index or index < 1 then return false, "curio needs a slot type and an index from 1" end
        p.equipment.curios = p.equipment.curios or {}
        local slots = p.equipment.curios[cmd.curio] or {}
        local normal = {}
        for k, v in pairs(slots) do if tonumber(k) then normal[tonumber(k)] = v end end
        normal[index] = cmd.item
        p.equipment.curios[cmd.curio] = normal
        return true
      end
      for _, slot in ipairs(EQUIPMENT_SLOTS) do
        if cmd.slot == slot then
          p.equipment[slot] = cmd.item
          return true
        end
      end
      return false, "slot must be head, chest, legs, feet, mainhand or offhand (or give curio and index)"
    end

    --- Sim command: a player moves to another server of the network (`onOtherServer` true) or back here (false). Away,
    --- this server treats them as offline: sessions and pending prompts here end, as on a logout. Allowances stay.
    function core.extraHandlers.setOnOtherServer(cmd)
      local p = core.findPlayer(cmd.player)
      if not p then return false, "unknown player" end
      if cmd.onOtherServer == false then
        p.onOtherServer, p.online = nil, true
        return true
      end
      p.onOtherServer, p.online = true, false
      core.sessions[p.uuid] = nil
      for nonce, pending in pairs(core.pending) do
        if pending.uuid == p.uuid then core.pending[nonce] = nil end
      end
      return true
    end

    --- Sim command: the next `times` calls of a ccvault function (-1: every call, 0: none again) answer
    --- nil, "internal error", so tests can see that callers cope.
    function core.extraHandlers.internalError(cmd)
      if type(cmd["function"]) ~= "string" or type(ccvault[cmd["function"]]) ~= "function" then
        return false, "no such ccvault function"
      end
      core.internalErrors = core.internalErrors or {}
      core.internalErrors[cmd["function"]] = tonumber(cmd.times) or 1
      return true
    end

    --- Sim command: a player's vault level changes (or `level` null: no vault data).
    function core.extraHandlers.setVaultLevel(cmd)
      local p = core.findPlayer(cmd.player)
      if not p then return false, "unknown player" end
      if cmd.level ~= nil and type(cmd.level) ~= "number" then return false, "level must be a number or null" end
      p.vaultLevel = cmd.level
      return true
    end

    function ccvault.getAllowance(player)
      player = checkString(1, player):match("^%s*(.-)%s*$")
      local p = core.findPlayer(player)
      local a = p and activeAllowance(p.uuid)
      if not a then return nil end
      return a.remaining, math.floor((a.expiresAt - core.nowMs()) / 1000)
    end

    function ccvault.endAllowance(player)
      player = checkString(1, player):match("^%s*(.-)%s*$")
      local p = core.findPlayer(player)
      if not p or not core.allowances[p.uuid] then return false end
      local had = activeAllowance(p.uuid) ~= nil
      core.allowances[p.uuid] = nil
      core.save()
      return had
    end
  end

  -- ===== 2.2.37: Gear Power, Temper, reputation, limits, Gear Score in item details =====
  if core.v37 then dofile("/rom/ccsim/vhcc237.lua")(core, ccvault) end

  -- Errors of the real mod are Java exceptions that CC reports at the caller: "script:12: msg", or "pcall: msg" when
  -- pcall calls the function directly. core.native gives the plain messages above that position.
  -- ===== 2.2.36: the economy thread =====
  -- Money calls that reach the database run on the mod's economy thread. The caller waits for vhcc_economy_done with
  -- its ticket and loses every other event meanwhile, as in a main-thread call. The work itself is done when the call
  -- is made, so a terminated wait still leaves the transfer done; tickets complete in the order they were issued.
  local economyCall -- name -> function(args) true when this call goes to the economy thread
  local awaitEconomy
  if core.v36 then
    local queueEvent, clock = os.queueEvent, os.clock
    core.economyDelayTicks = tonumber(core.world.economyDelayTicks) or 0
    local nextTicket, lastDue, armed = 0, 0, false
    local line = {} -- { ticket, due } in issue order

    local function presentHere(target)
      if type(target) ~= "string" then return false end
      local t = target:lower()
      if t == "player" then return true end
      if isNamed(target) then
        local p = core.findPlayer(target:sub(#NAMED_PREFIX + 1))
        return p ~= nil and p.online == true
      end
      if t == "host" then return core.ownerUuid ~= nil and core.onlinePlayer(core.ownerUuid) ~= nil end
      return false
    end

    economyCall = {
      transfer = function() return true end,
      getPlayerBalance = function() return true end,
      getBalance = function(args) return not presentHere(args[1]) end,
    }

    local function release()
      armed = false
      local now = clock()
      while line[1] and line[1].due <= now + 1e-9 do
        queueEvent("vhcc_economy_done", table.remove(line, 1).ticket)
      end
      if line[1] then
        armed = true
        core.after(math.max(0, line[1].due - now), release)
      end
    end

    awaitEconomy = function()
      nextTicket = nextTicket + 1
      local ticket = nextTicket
      local due = math.max(clock() + core.economyDelayTicks * 0.05, lastDue)
      lastDue = due
      line[#line + 1] = { ticket = ticket, due = due }
      if not armed then
        armed = true
        core.after(math.max(0, due - clock()), release)
      end
      local keep = {}
      while true do
        local ev = table.pack(coroutine.yield())
        if ev[1] == "vhcc_economy_done" and ev[2] == ticket then break end
        if ev[1] == "terminate" then
          for _, e in ipairs(keep) do queueEvent(table.unpack(e, 1, e.n)) end
          return false
        elseif ev[1] == "ccsim_cmd" then
          keep[#keep + 1] = ev -- the harness's own commands are not part of the simulated world
        end
      end
      for _, e in ipairs(keep) do queueEvent(table.unpack(e, 1, e.n)) end
      return true
    end

    core.extraHandlers = core.extraHandlers or {}
    --- Sim command: how many server ticks the economy thread takes per call from now on.
    function core.extraHandlers.setEconomyDelay(cmd)
      local ticks = tonumber(cmd.ticks)
      if not ticks or ticks < 0 then return false, "ticks must be a number >= 0" end
      core.economyDelayTicks = ticks
      return true
    end
  end

  --- Sim command: the economy refuses the next `times` transfers (-1: every one, 0: none again), as a database that
  --- will not commit does. Nothing moves; the refusal is in the player's history.
  core.extraHandlers = core.extraHandlers or {}
  function core.extraHandlers.refuseTransfers(cmd)
    local times = cmd.times == nil and 1 or tonumber(cmd.times)
    if not times then return false, "times must be a number" end
    core.refuseTransfers = times
    return true
  end

  -- What reads or moves money sees the one economy of a linked network as it is now (core.withEconomy)
  local MONEY = {
    transfer = true, transferSelf = true, getBalance = true, getPlayerBalance = true,
    getTransactionHistory = true, verifyTransaction = true,
  }
  for name, raw in pairs(ccvault) do
    if type(raw) == "function" then
      local fn = raw
      if MONEY[name] then fn = function(...) return core.withEconomy(raw, ...) end end
      local inner = fn
      if core.v36 then
        -- 2.2.36 test hook: a failure inside the mod, before anything happens
        local direct = function(...)
          local left = core.internalErrors and core.internalErrors[name]
          if left and left ~= 0 then
            if left > 0 then core.internalErrors[name] = left - 1 end
            return nil, "internal error"
          end
          return fn(...)
        end
        inner = direct
        if economyCall[name] then
          inner = function(...)
            local args = table.pack(...)
            if not economyCall[name](args) then return direct(...) end
            -- checks that fail raise at once, on the computer thread; what reaches the database waits for its ticket
            local results = table.pack(direct(...))
            -- terminate errors the call (positioned at the caller, like the main-thread wait); the work stays done
            if not awaitEconomy() then error("Terminated", 0) end
            return table.unpack(results, 1, results.n)
          end
        end
      end
      ccvault[name] = core.native(inner)
    end
  end

  return ccvault
end
