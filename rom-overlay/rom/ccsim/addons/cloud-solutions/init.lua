-- ccsim cloud-solutions: SirEdvin's Cloud Solutions 0.3.4 (Minecraft 1.20.1 and 1.21.1).
--
-- Written from SirEdvin/CloudSolutions at the tags v1.20.1-0.3.4 and v1.21.1-0.3.4 (the same Lua behaviour), and
-- Tweakium 1.4.10 for OwnedPeripheral (getConfiguration). Source files, relative to
-- projects/core/src/main/kotlin/site/siredvin/cloudsolutions/:
--   computercraft/peripheral/{KVStorage,CrafkaBroker,StatsDBridge,TSDBStorage}Peripheral.kt;
--   subsystems/Management.kt (SubscriptionManager, SubsystemManager); subsystems/kv/sqlite/KVSQLiteManager.kt;
--   subsystems/crafka/{CrafkaSQLiteManager,CrafkaTopic,CrafkaMessage,CrafkaSubscription}.kt;
--   subsystems/statsq/StatsDClient.kt; common/configuration/ModConfig.kt (defaults).
-- The mod keeps its data in SQLite files in the world folder; the sim keeps the same tables in memory (saved in
-- state.json) and answers the same queries. docs/cloud-solutions.md has the rest.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local R = dofile("/rom/ccsim/addons/cloud-solutions/regex.lua")
  local floor = math.floor
  local cfg = core.world.cloudSolutions or {}
  local conf = cfg.config or {}
  local function num(key, default) return tonumber(conf[key]) or default end
  local function bool(key, default) if conf[key] == nil then return default end return conf[key] == true end

  local KEY_LIMIT = num("kvStorageKeyLimit", 10240)
  local VALUE_LIMIT = num("kvStorageValueLimit", 500000)
  local KV_ON = (conf.kvStorageMode or "SQLITE"):upper() ~= "DISABLED"
  local TOPIC_LIMIT = num("crafkaTopicLimit", 512)
  local TOPIC_SIZE_LIMIT = num("crafkaTopicSizeLimit", 512)
  local MESSAGE_SIZE_LIMIT = num("crafkaMessageSizeLimit", 500000)
  local MAX_RESEND = num("crafkaMaxResendSteps", 21)
  local RESEND_DELAY = num("crafkaCursorRevalidationDelay", 100)
  local CRAFKA_ON = (conf.crafkaStorageMode or "SQLITE"):upper() ~= "DISABLED"
  local STATSD_ON = bool("enableStatsDConnection", false)
  local STATSD_PREFIX = type(conf.statsdPrefix) == "string" and conf.statsdPrefix or ""
  local PLAYER_RATE = num("statsdPlayerRateLimit", 1000)
  local GLOBAL_RATE = num("statsdGlobalRateLimit", 21000)
  local INT_MAX = 2147483647
  local DEFAULT_OWNER = "8667ba71-b85a-4004-af54-457a9734eed7"

  local computerId = core.computerId or os.getComputerID()
  local function now() return os.epoch("utc") end
  local function epochSecond() return floor(now() / 1000) end

  -- ===== Java and SQLite number text =====

  local function shortest(d)
    for p = 1, 17 do
      local s = ("%." .. p .. "g"):format(d)
      if tonumber(s) == d then return s end
    end
    return ("%.17g"):format(d)
  end

  --- Double.toString
  local function javaDouble(d)
    if d ~= d then return "NaN" end
    if d == math.huge then return "Infinity" end
    if d == -math.huge then return "-Infinity" end
    if d == 0 then return (1 / d < 0) and "-0.0" or "0.0" end
    local a = math.abs(d)
    local s = shortest(d)
    local mant, exp = s:match("^(-?[%d%.]+)e([-+]%d+)$")
    local digits, e10
    if mant then
      digits = mant:gsub("[-.]", "")
      local intPart = mant:gsub("^-", ""):match("^(%d+)")
      e10 = tonumber(exp) + #intPart - 1
    else
      local bare = s:gsub("^-", "")
      local ip, fp = bare:match("^(%d*)%.?(%d*)$")
      if ip ~= "" and tonumber(ip) ~= 0 then
        digits = (ip .. fp)
        e10 = #ip - 1
      else
        local lead = fp:match("^(0*)")
        digits = fp:sub(#lead + 1)
        e10 = -(#lead + 1)
      end
    end
    digits = digits:gsub("^0+", ""):gsub("0+$", "")
    if digits == "" then digits = "0" end
    local sign = d < 0 and "-" or ""
    if a >= 1e-3 and a < 1e7 then
      if e10 >= 0 then
        local ip = digits:sub(1, e10 + 1)
        ip = ip .. ("0"):rep(e10 + 1 - #ip)
        local fp = digits:sub(e10 + 2)
        if fp == "" then fp = "0" end
        return sign .. ip .. "." .. fp
      end
      return sign .. "0." .. ("0"):rep(-e10 - 1) .. digits
    end
    local fp = digits:sub(2)
    if fp == "" then fp = "0" end
    return sign .. digits:sub(1, 1) .. "." .. fp .. "E" .. e10
  end

  --- what a Lua value is as Java's toString() (CC hands numbers over as Double, tables as maps)
  local function javaString(v)
    if type(v) == "number" then return javaDouble(v) end
    if type(v) == "boolean" then return tostring(v) end
    if type(v) == "table" then return "{}" end
    return tostring(v)
  end

  --- SQLite's REAL to TEXT ("%!.15g": always a decimal point)
  local function sqliteReal(d)
    local s = ("%.15g"):format(d)
    if s:find("[%.ni]") then
      return s
    end
    local m, e = s:match("^(-?%d+)(e.+)$")
    if m then return m .. ".0" .. e end
    return s .. ".0"
  end

  --- CAST(text AS REAL): the longest numeric prefix, 0 when there is none
  local function sqliteToReal(text)
    local prefix = tostring(text):match("^%s*([+-]?%d*%.?%d*[eE][+-]?%d+)") or tostring(text):match("^%s*([+-]?%d*%.?%d*)")
    return tonumber(prefix or "") or 0.0
  end

  --- SQL LIKE: % any run, _ one character, ASCII letters in any case
  local function like(pattern, s)
    local p = { "^" }
    for i = 1, #pattern do
      local c = pattern:sub(i, i)
      if c == "%" then p[#p + 1] = ".-"
      elseif c == "_" then p[#p + 1] = "."
      elseif c:match("%a") then p[#p + 1] = "[" .. c:lower() .. c:upper() .. "]"
      else p[#p + 1] = "%" .. c end
    end
    p[#p + 1] = "$"
    return s:find(table.concat(p)) ~= nil
  end

  -- ===== CC's argument checks =====

  local long = C.long -- IArguments.getLong: 1.5 is 1
  local function optLong(i, v) if v == nil then return nil end return long(i, v) end
  local function double(i, v)
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end

  local function peripheral(def, methods, computerThread, extra)
    local names = {}
    for name in pairs(methods) do names[#names + 1] = name end
    table.sort(names)
    local p = { methods = methods, methodOrder = C.hashMapOrder(names), computerThread = computerThread, exactReturns = true }
    for k, v in pairs(extra or {}) do p[k] = v end
    return p
  end

  local function ownerOf(def)
    if def.owner == false then return nil end
    return def.owner or cfg.owner or DEFAULT_OWNER
  end

  -- ===== saved data =====

  local saved = core.savedState and core.savedState.addons and core.savedState.addons["cloud-solutions"] or {}
  local function savedBlock(name)
    local s = core.savedState
    local p = s and s.peripherals and s.peripherals[name]
    return p and type(p.restore) == "table" and p.restore or nil
  end

  -- ===== KV storage (KVSQLiteManager): kv_records_1 (ownerUUID, key, value, expire), unique (ownerUUID, key) =====

  local kv = {} -- owner -> key -> { value, expire }
  for owner, rows in pairs(type(saved.kv) == "table" and saved.kv or type(cfg.kv) == "table" and cfg.kv or {}) do
    kv[owner] = {}
    for k, row in pairs(rows) do
      if type(row) == "table" then kv[owner][k] = { value = tostring(row.value), expire = row.expire }
      else kv[owner][k] = { value = tostring(row) } end
    end
  end
  local function rowsOf(owner)
    kv[owner] = kv[owner] or {}
    return kv[owner]
  end
  local function live(row) return row.expire == nil or row.expire > epochSecond() end
  local function sortedKeys(rows)
    local keys = {}
    for k, row in pairs(rows) do if live(row) then keys[#keys + 1] = k end end
    table.sort(keys) -- the unique index on (ownerUUID, key) is how SQLite walks them
    return keys
  end

  local kvBlocks = {} -- every kv_storage block: SubscriptionManager

  local function hookChanged(owner, key, value)
    for _, b in ipairs(kvBlocks) do if b.owner == owner then b.onKeyChanged(key, value) end end
  end
  local function hookDeleted(owner, key)
    for _, b in ipairs(kvBlocks) do if b.owner == owner then b.onKeyDeleted(key) end end
  end

  local function tooManyKeys(owner, adding)
    local count = 0
    for _ in pairs(rowsOf(owner)) do count = count + 1 end
    return count + adding >= KEY_LIMIT
  end

  -- the cleanup the mod runs every minute: expired keys go, and their subscribers hear it
  local function cleanup()
    local t = epochSecond()
    for owner, rows in pairs(kv) do
      local gone = {}
      for k, row in pairs(rows) do if row.expire ~= nil and row.expire < t then gone[#gone + 1] = k end end
      table.sort(gone)
      for _, k in ipairs(gone) do
        rows[k] = nil
        hookDeleted(owner, k)
      end
    end
    core.save()
    core.after(60, cleanup)
  end
  if KV_ON then core.after(0.05, cleanup) end

  local regexCache = {}
  local function regex(pattern)
    local hit = regexCache[pattern]
    if hit == nil then
      local fn, why = R.compile(pattern)
      hit = fn or { error = why }
      regexCache[pattern] = hit
    end
    if type(hit) == "table" then
      C.java("com.google.common.util.concurrent.UncheckedExecutionException", "java.util.regex.PatternSyntaxException: " .. hit.error)
    end
    return hit
  end

  local function buildKV(def)
    local owner = ownerOf(def)
    local function player()
      if not owner then error("Cannot find attached player to this peripheral", 0) end
      return owner
    end
    local restore = savedBlock(def.name) or {}
    -- KV_STORAGE_CHANGED_SUBS and KV_STORAGE_DELETED_SUBS are the same tag name in the mod: whatever was saved last
    -- under it comes back as both kinds
    local changed, deleted = {}, {}
    local function load(tag)
      for pattern, ids in pairs(tag or {}) do
        local set = {}
        for _, id in ipairs(ids) do set[id] = true end
        changed[pattern] = set
        local copy = {}
        for id in pairs(set) do copy[id] = true end
        deleted[pattern] = copy
      end
    end
    load(restore.subs or def.subscriptions)
    local tag = restore.subs
    local function saveSettings()
      local function asTag(map)
        local out = {}
        for pattern, set in pairs(map) do
          local ids = {}
          for id in pairs(set) do ids[#ids + 1] = id end
          table.sort(ids)
          out[pattern] = ids
        end
        return out
      end
      if next(changed) then tag = asTag(changed) end
      if next(deleted) then tag = asTag(deleted) end
      core.save()
    end

    local b = { owner = owner }
    function b.onKeyChanged(key, value)
      for pattern, set in pairs(changed) do
        if regex(pattern)(key) and set[computerId] then os.queueEvent("kv_storage_key_changed", key, value) end
      end
    end
    function b.onKeyDeleted(key)
      for pattern, set in pairs(deleted) do
        if regex(pattern)(key) and set[computerId] then os.queueEvent("kv_storage_key_deleted", key) end
      end
    end
    if owner then kvBlocks[#kvBlocks + 1] = b end

    --- DisabledKVManager: every call throws
    local function manager()
      if not KV_ON then error("KV storage is disabled in server configuration", 0) end
      return true
    end

    local methods = {}
    function methods.put(key, value, expire)
      key, value = C.str(1, key), C.str(2, value)
      expire = optLong(3, expire)
      if #value > VALUE_LIMIT then error("Value is too long", 0) end
      local o = player()
      manager()
      if tooManyKeys(o, 1) then return false, "Too many keys in KV storage" end
      rowsOf(o)[key] = { value = value, expire = expire and C.toInt(expire) or nil }
      hookChanged(o, key, value)
      core.save()
      return true
    end
    function methods.delete(key)
      key = C.str(1, key)
      local o = player()
      manager()
      rowsOf(o)[key] = nil
      hookDeleted(o, key)
      core.save()
      return true
    end
    function methods.get(key)
      key = C.str(1, key)
      local o = player()
      manager()
      local row = rowsOf(o)[key]
      if row and live(row) then return row.value end
      return nil
    end
    function methods.mget(keys)
      keys = C.table(1, keys)
      local o = player()
      local out = {}
      manager()
      for _, k in pairs(keys) do
        local name = javaString(k)
        local row = rowsOf(o)[name]
        if row and live(row) then out[name] = row.value end
      end
      return out
    end
    function methods.mput(values)
      values = C.table(1, values)
      local o = player()
      manager()
      local entries, count = {}, 0
      for k, v in pairs(values) do
        local key = javaString(k)
        if entries[key] == nil then count = count + 1 end
        entries[key] = javaString(v)
      end
      if count == 0 then return false, "Where is values?" end
      if tooManyKeys(o, count) then return false, "Too many keys already exists" end
      local keys = {}
      for k in pairs(entries) do keys[#keys + 1] = k end
      for _, k in ipairs(keys) do rowsOf(o)[k] = { value = entries[k] } end
      for _, k in ipairs(keys) do hookChanged(o, k, entries[k]) end
      core.save()
      return count
    end
    methods.get_ex = function(key)
      key = C.str(1, key)
      local o = player()
      manager()
      local row = rowsOf(o)[key]
      if row and live(row) and row.expire ~= nil then return row.expire end
      return nil
    end
    methods.put_ex = function(key, expire)
      key = C.str(1, key)
      expire = optLong(2, expire)
      local o = player()
      manager()
      local row = rowsOf(o)[key]
      if row then row.expire = expire and C.toInt(expire) or nil end
      core.save()
      return true
    end
    function methods.list(glob)
      if glob ~= nil then glob = C.str(1, glob) end
      local o = player()
      manager()
      local out = {}
      for _, k in ipairs(sortedKeys(rowsOf(o))) do
        if glob == nil or like(glob, k) then out[#out + 1] = k end
      end
      return out
    end
    local function incr(key, by)
      local o = player()
      manager()
      local rows = rowsOf(o)
      local row = rows[key]
      if row then
        -- ON CONFLICT: value = CAST(CAST(value AS DOUBLE) + by AS VARCHAR)
        row.value = sqliteReal(sqliteToReal(row.value) + by)
      else
        rows[key] = { value = javaDouble(by) }
        row = rows[key]
      end
      core.save()
      return tonumber(row.value) or 0.0
    end
    function methods.incr(key, value)
      key = C.str(1, key)
      if value ~= nil then value = double(2, value) end
      return incr(key, value or 1.0)
    end
    function methods.decr(key, value)
      key = C.str(1, key)
      if value ~= nil then value = double(2, value) end
      return incr(key, -(value or 1.0))
    end
    local KINDS = { changed = changed, deleted = deleted }
    function methods.getSubscriptions(kind)
      kind = C.str(1, kind)
      local map = KINDS[kind]
      if not map then error("You can only list subscriptions to changed or deleted events", 0) end
      local out = {}
      for pattern, set in pairs(map) do if set[computerId] then out[#out + 1] = pattern end end
      table.sort(out)
      return out
    end
    function methods.subscribe(kind, pattern)
      kind, pattern = C.str(1, kind), C.str(2, pattern)
      local map = KINDS[kind]
      if not map then error("You can subscribe only to changed or deleted events", 0) end
      map[pattern] = map[pattern] or {}
      if not map[pattern][computerId] then
        map[pattern][computerId] = true
        saveSettings()
      end
    end
    function methods.unsubscribe(kind, pattern)
      kind, pattern = C.str(1, kind), C.str(2, pattern)
      local map = KINDS[kind]
      if not map then error("You can unsubscribe only from changed or deleted events", 0) end
      if map[pattern] and map[pattern][computerId] then
        map[pattern][computerId] = nil
        saveSettings()
      end
    end
    function methods.getConfiguration() return { keyLimit = KEY_LIMIT, valueLimit = VALUE_LIMIT } end

    local computer = {}
    for name in pairs(methods) do computer[name] = true end
    computer.getSubscriptions, computer.subscribe, computer.unsubscribe = nil, nil, nil -- mainThread = true
    return peripheral(def, methods, computer, {
      state = function() return { restore = { subs = tag and C.deepCopy(tag) or nil } } end,
    })
  end

  -- ===== Crafka broker (CrafkaSQLiteManager) =====

  local crafka = type(saved.crafka) == "table" and C.deepCopy(saved.crafka) or { topics = {}, subs = {}, nextTopic = 1, nextSub = 1 }
  crafka.topics = crafka.topics or {}
  crafka.subs = crafka.subs or {}
  -- topics: list of { id, name, owner, limit, messages = { { id, value } ... } }; subs: list of { id, topic, computer, cursor, fragile, autoCursor }

  local function topicOf(owner, name)
    for _, t in ipairs(crafka.topics) do if t.owner == owner and t.name == name then return t end end
    return nil
  end
  local function topicById(id)
    for _, t in ipairs(crafka.topics) do if t.id == id then return t end end
    return nil
  end
  local function subById(id)
    for i, s in ipairs(crafka.subs) do if s.id == id then return s, i end end
    return nil
  end
  local function removeSub(id)
    local _, i = subById(id)
    if i then table.remove(crafka.subs, i) end
  end

  --- publishMessageToSubscription: true when the cursor must be moved by hand (and the message sent again later)
  local function deliver(topic, messageId, value, sub)
    if sub.computer ~= computerId then
      -- no such computer running: a fragile subscription goes
      if sub.fragile then removeSub(sub.id) end
      return false
    end
    os.queueEvent("crafka_broker_message", topic.name, messageId, value)
    if sub.autoCursor then
      if sub.cursor < messageId then sub.cursor = messageId end
      return false
    end
    return true
  end

  local revalidate
  revalidate = function(subId, previousCursor, attempt)
    if attempt >= MAX_RESEND then
      removeSub(subId)
      core.save()
      return
    end
    local sub = subById(subId)
    if not sub then return end
    local topic = topicById(sub.topic)
    if not topic then return end
    local current = sub.cursor
    local message
    for _, m in ipairs(topic.messages) do
      if m.id > current and (message == nil or m.id < message.id) then message = m end
    end
    if not message then return end
    local manual = deliver(topic, message.id, message.value, sub)
    local again = manual
    if not manual then
      for _, m in ipairs(topic.messages) do if m.id > message.id then again = true break end end
    end
    if again then
      local prev = manual and current or message.id
      local nextAttempt = (not manual or current ~= previousCursor) and 1 or attempt + 1
      core.after(RESEND_DELAY * nextAttempt / 1000, function() revalidate(subId, prev, nextAttempt) end)
    end
    core.save()
  end

  local function trimTopics()
    for _, t in ipairs(crafka.topics) do
      local extra = #t.messages - t.limit
      if extra > 0 then
        table.sort(t.messages, function(a, b) return a.id < b.id end)
        for _ = 1, extra do table.remove(t.messages, 1) end
      end
    end
    core.save()
    core.after(60, trimTopics)
  end
  if CRAFKA_ON then core.after(0.05, trimTopics) end

  local attachedCrafka = {}

  local function buildCrafka(def)
    local owner = ownerOf(def)
    local function player()
      if not owner then error("Cannot find attached player to this peripheral", 0) end
      return owner
    end
    local function manager()
      if not CRAFKA_ON then C.java("java.lang.NullPointerException") end
    end
    -- attach: subscriptions of this computer behind the newest message catch up a little later
    if owner and CRAFKA_ON and not attachedCrafka[owner] then
      attachedCrafka[owner] = true
      for _, s in ipairs(crafka.subs) do
        local t = topicById(s.topic)
        if t and t.owner == owner and s.computer == computerId then
          local max = 0
          for _, m in ipairs(t.messages) do if m.id > max then max = m.id end end
          if #t.messages > 0 and s.cursor < max then
            local id, cursor = s.id, s.cursor
            core.after(RESEND_DELAY / 1000, function() revalidate(id, cursor, 1) end)
          end
        end
      end
    end

    local methods = {}
    function methods.createTopic(...)
      local a = table.pack(...)
      local o = player()
      local name = C.str(1, a[1])
      local limit = a[2] == nil and TOPIC_SIZE_LIMIT or C.int(2, a[2])
      manager()
      local count = 0
      for _, t in ipairs(crafka.topics) do if t.owner == o then count = count + 1 end end
      if count >= TOPIC_LIMIT then return false, "Too many topics" end
      if topicOf(o, name) then return nil, "Such topic already exists" end
      crafka.topics[#crafka.topics + 1] = {
        id = crafka.nextTopic, name = name, owner = o, limit = math.min(limit, TOPIC_SIZE_LIMIT), messages = {},
      }
      crafka.nextTopic = crafka.nextTopic + 1
      core.save()
      return true
    end
    function methods.listTopics()
      local o = player()
      manager()
      local out = {}
      for _, t in ipairs(crafka.topics) do if t.owner == o then out[#out + 1] = t.name end end
      table.sort(out) -- the unique index on (ownerUUID, name)
      return out
    end
    function methods.deleteTopic(name)
      name = C.str(1, name)
      local o = player()
      manager()
      for i, t in ipairs(crafka.topics) do
        if t.owner == o and t.name == name then
          table.remove(crafka.topics, i)
          -- ON DELETE CASCADE: its messages and subscriptions go with it
          for j = #crafka.subs, 1, -1 do if crafka.subs[j].topic == t.id then table.remove(crafka.subs, j) end end
          break
        end
      end
      core.save()
      return true
    end
    function methods.publish(name, message)
      name, message = C.str(1, name), C.str(2, message)
      local o = player()
      if #message > MESSAGE_SIZE_LIMIT then return false, "Message is too big" end
      manager()
      local t = topicOf(o, name)
      if not t then return false, "There is no such topic" end
      local max = 0
      for _, m in ipairs(t.messages) do if m.id > max then max = m.id end end
      local id = max + 1
      t.messages[#t.messages + 1] = { id = id, value = message }
      -- redistributeMessage: every subscription behind it
      local subs = {}
      for _, s in ipairs(crafka.subs) do if s.topic == t.id and s.cursor < id then subs[#subs + 1] = s end end
      for _, s in ipairs(subs) do
        local cursor = s.cursor
        if deliver(t, id, message, s) then
          local sid = s.id
          core.after(RESEND_DELAY / 1000, function() revalidate(sid, cursor, 1) end)
        end
      end
      core.save()
      return true
    end
    function methods.fetchMessages(name, index)
      name, index = C.str(1, name), C.int(2, index)
      local o = player()
      manager()
      local t = topicOf(o, name)
      local out = {}
      if not t then return out end
      for _, m in ipairs(t.messages) do if m.id >= index then out[m.id] = m.value end end
      return out
    end
    function methods.describeTopic(name)
      name = C.str(1, name)
      local o = player()
      manager()
      local t = topicOf(o, name)
      if not t then return {} end
      local lo, hi
      for _, m in ipairs(t.messages) do
        if lo == nil or m.id < lo then lo = m.id end
        if hi == nil or m.id > hi then hi = m.id end
      end
      return { messageLimit = t.limit, firstMessage = lo or 0, lastMessage = hi or 0 }
    end
    function methods.subscribe(name, options)
      name = C.str(1, name)
      if options ~= nil then options = C.table(2, options) end
      local o = player()
      options = options or {}
      local fragile = type(options.fragile) == "boolean" and options.fragile or false
      local autoCursor = true
      if type(options.autoCursor) == "boolean" then autoCursor = options.autoCursor end
      local cursor = type(options.cursor) == "number" and C.toInt(options.cursor) or 0
      manager()
      local t = topicOf(o, name)
      if not t then return false, "There is no such topic" end
      for _, s in ipairs(crafka.subs) do
        if s.topic == t.id and s.computer == computerId then
          C.java("org.jetbrains.exposed.exceptions.ExposedSQLException",
            "org.sqlite.SQLiteException: [SQLITE_CONSTRAINT_UNIQUE] A UNIQUE constraint failed (UNIQUE constraint failed: crafka_subscription.topic_id, crafka_subscription.computer_id)")
        end
      end
      local id = crafka.nextSub
      crafka.nextSub = id + 1
      crafka.subs[#crafka.subs + 1] = { id = id, topic = t.id, computer = computerId, cursor = cursor, fragile = fragile, autoCursor = autoCursor }
      -- submitted to the mod's idle executor thread, which runs it straight away: anything already published after
      -- the cursor comes before the call's own answer
      revalidate(id, cursor, 1)
      core.save()
      return true, id
    end
    function methods.unsubscribe(name)
      name = C.str(1, name)
      local o = player()
      manager()
      local t = topicOf(o, name)
      if not t then return false, "There is no such topic" end
      for j = #crafka.subs, 1, -1 do
        local s = crafka.subs[j]
        if s.topic == t.id and s.computer == computerId then table.remove(crafka.subs, j) end
      end
      core.save()
      return true
    end
    function methods.getSubscription(name)
      name = C.str(1, name)
      local o = player()
      manager()
      local t = topicOf(o, name)
      if not t then return nil, "There is no such topic" end
      for _, s in ipairs(crafka.subs) do
        if s.topic == t.id and s.computer == computerId then
          return { cursor = s.cursor, autoCursor = s.autoCursor, fragile = s.fragile }
        end
      end
      return nil, "There is no such subscription"
    end
    function methods.setCursor(name, value)
      name, value = C.str(1, name), C.int(2, value)
      local o = player()
      manager()
      local t = topicOf(o, name)
      if not t then return false, "There is no such topic" end
      for _, s in ipairs(crafka.subs) do
        if s.topic == t.id and s.computer == computerId and s.cursor < value then s.cursor = value end
      end
      core.save()
      return true
    end
    function methods.getConfiguration()
      return {
        topicLimit = TOPIC_LIMIT, maxMessageLimit = MESSAGE_SIZE_LIMIT, maxMessageSize = MESSAGE_SIZE_LIMIT,
        maxResendSteps = MAX_RESEND, resendDelay = RESEND_DELAY,
      }
    end
    local computer = {}
    for name in pairs(methods) do computer[name] = true end -- no Crafka method is mainThread
    return peripheral(def, methods, computer, {
      detach = function()
        -- onComputerDetach: this computer's fragile subscriptions on the owner's topics go
        if not owner then return end
        for j = #crafka.subs, 1, -1 do
          local s = crafka.subs[j]
          local t = topicById(s.topic)
          if s.computer == computerId and s.fragile and t and t.owner == owner then table.remove(crafka.subs, j) end
        end
      end,
    })
  end

  -- ===== StatsD bridge (StatsDClient, Guava's RateLimiter) =====

  --- RateLimiter.create(permitsPerSecond): SmoothBursty, at most one second of permits stored, none at the start
  local function rateLimiter(perSecond)
    local interval = 1e6 / perSecond -- microseconds
    local maxPermits = perSecond
    local stored, nextFree = 0, now() * 1000
    local r = {}
    function r.tryAcquire()
      local t = now() * 1000
      if nextFree > t then return false end
      -- resync, then reserve one permit
      if t > nextFree then
        stored = math.min(maxPermits, stored + (t - nextFree) / interval)
        nextFree = t
      end
      local spend = math.min(1, stored)
      local fresh = 1 - spend
      nextFree = nextFree + fresh * interval
      stored = stored - spend
      return true
    end
    return r
  end
  local globalLimiter
  local playerLimiters = {}
  local sent = type(saved.statsd) == "table" and saved.statsd or {}

  local function statsdPrefixed(aspect)
    local p = STATSD_PREFIX:match("^%s*(.-)%s*$")
    if p == "" then return aspect end
    return p .. "." .. aspect
  end

  local function buildStatsD(def)
    local ownerName = def.ownerName or cfg.ownerName or "Steve"
    local owner = ownerOf(def)
    --- peripheralOwner.owner: the owner as an online player
    local function online()
      local o = def.ownerOnline
      if o == nil then o = cfg.ownerOnline end
      return o ~= false
    end
    local function validate()
      if not owner or not online() then error("Cannot find owner", 0) end
      globalLimiter = globalLimiter or rateLimiter(GLOBAL_RATE / 60)
      if not globalLimiter.tryAcquire() then error("Too many requests to server, please wait a little", 0) end
      playerLimiters[owner] = playerLimiters[owner] or rateLimiter(PLAYER_RATE / 60)
      if not playerLimiters[owner].tryAcquire() then error("Too many request from you, please wait a little", 0) end
      if not STATSD_ON then error("Statsd Bridge is disabled in server configuration", 0) end
    end
    local function send(line)
      -- a UDP packet: nothing waits for it (the call's own touch saves the state soon enough)
      sent[#sent + 1] = line
      while #sent > 200 do table.remove(sent, 1) end
    end
    local function aspectOf(aspect) return statsdPrefixed(ownerName .. "." .. aspect) end

    local methods = {}
    function methods.count(aspect, delta)
      aspect, delta = C.str(1, aspect), long(2, delta)
      validate()
      send(("%s:%d|c"):format(aspectOf(aspect), delta))
    end
    function methods.delta(aspect, value)
      aspect, value = C.str(1, aspect), long(2, value)
      validate()
      send(("%s:%s%d|g"):format(aspectOf(aspect), value >= 0 and "+" or "", value))
    end
    function methods.gauge(aspect, value)
      aspect, value = C.str(1, aspect), long(2, value)
      validate()
      -- a negative gauge is sent as a reset to 0 and then the value (java-statsd-client)
      if value < 0 then send(("%s:0|g"):format(aspectOf(aspect))) end
      send(("%s:%d|g"):format(aspectOf(aspect), value))
    end
    function methods.set(aspect, eventName)
      aspect, eventName = C.str(1, aspect), C.str(2, eventName)
      validate()
      send(("%s:%s|s"):format(aspectOf(aspect), eventName))
    end
    function methods.time(aspect, ms)
      aspect, ms = C.str(1, aspect), long(2, ms)
      validate()
      send(("%s:%d|ms"):format(aspectOf(aspect), ms))
    end
    function methods.getConfiguration()
      return { playerRateLimit = PLAYER_RATE, globalRateLimit = GLOBAL_RATE }
    end
    local computer = {}
    for name in pairs(methods) do computer[name] = true end
    return peripheral(def, methods, computer)
  end

  local M = { handlers = {} }

  local BUILDERS = { kv_storage = buildKV, crafka_broker = buildCrafka, statsd_bridge = buildStatsD }
  function M.peripheral(def) return BUILDERS[def.type](def) end

  function M.state()
    local kvOut = {}
    for owner, rows in pairs(kv) do
      kvOut[owner] = {}
      for k, row in pairs(rows) do kvOut[owner][k] = { value = row.value, expire = row.expire } end
    end
    return { kv = kvOut, crafka = C.deepCopy(crafka), statsd = C.deepCopy(sent) }
  end

  -- ===== sim commands: another computer (or the server) writes =====

  function M.handlers.csPut(cmd)
    local owner = cmd.owner or cfg.owner or DEFAULT_OWNER
    if type(cmd.key) ~= "string" then return false, "key is needed" end
    if cmd.value == nil then
      rowsOf(owner)[cmd.key] = nil
      hookDeleted(owner, cmd.key)
    else
      local value = tostring(cmd.value)
      rowsOf(owner)[cmd.key] = { value = value, expire = cmd.expire }
      hookChanged(owner, cmd.key, value)
    end
    return true
  end

  function M.handlers.csPublish(cmd)
    local owner = cmd.owner or cfg.owner or DEFAULT_OWNER
    local t = topicOf(owner, cmd.topic)
    if not t then return false, "there is no such topic" end
    local max = 0
    for _, m in ipairs(t.messages) do if m.id > max then max = m.id end end
    local id = max + 1
    local message = tostring(cmd.message)
    t.messages[#t.messages + 1] = { id = id, value = message }
    for _, s in ipairs(crafka.subs) do
      if s.topic == t.id and s.cursor < id then
        local cursor = s.cursor
        if deliver(t, id, message, s) then
          local sid = s.id
          core.after(RESEND_DELAY / 1000, function() revalidate(sid, cursor, 1) end)
        end
      end
    end
    return true
  end

  function M.handlers.csSetOwnerOnline(cmd)
    cfg.ownerOnline = cmd.online == true
    return true
  end

  return M
end
