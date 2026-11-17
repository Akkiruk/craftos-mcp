-- ccsim addon ducky-peripherals: Ducky Peripherals by SamsTheNerd, its four plain ComputerCraft peripherals.
--
-- Written from github.com/SamsTheNerd/ducky-periphs (the repository has no tags):
--   1.20.1-1.3.1: commit f4fc865 ("version bump", 17 Aug 2023, gradle.properties mod_version = 1.20.1-1.3.1),
--     common/src/main/java/com/samsthenerd/duckyperiphs/peripherals/:
--     EntityDetector/{EntityDetectorPeripheral,EntityDetectorTile}, WeatherMachine/WeatherMachinePeripheral,
--     keyboards/{KeyboardPeripheral,KeyboardTile,KeyboardUtils}, sculkophone/{SculkophonePeripheral,
--     SculkophoneBlockEntity,SculkophoneBlock}
--   1.18.2: 1.0.2 (Fabric, CC: Restitched 1.100.5), commit 1699d8c ("pushing v1.0.2.jar", 20 Jan 2023),
--     src/main/java/net/fabricmc/duckyperiphs/peripherals/: the same files, without the sculkophone.
-- docs/ducky-peripherals.md lists every behaviour with its source, and what is not emulated (the Hex Casting blocks).
--
-- None of the four has an argument: entity_detector and weather_machine have plain @LuaFunction methods (computer
-- thread, no mainThread), keyboard and sculkophone have none at all and only queue events.
return function(core, host)
  local floor = math.floor
  local queue = os.queueEvent
  local band, bxor, rshift = bit32.band, bit32.bxor, bit32.rshift
  local OLD = core.version.mc == "1.18.2" -- 1.0.2: events carry no peripheral name, key up is a "key" event
  local MOD = OLD and "Ducky Peripherals 1.0.2 (Minecraft 1.18.2)" or "Ducky Peripherals 1.20.1-1.3.1"

  local cfg = core.world.duckyPeripherals or {}
  local savedAll = core.savedState and type(core.savedState.addons) == "table"
    and core.savedState.addons["ducky-peripherals"] or nil
  local weather = {
    raining = cfg.raining == true,
    thundering = cfg.thundering == true,
  }
  if type(savedAll) == "table" and type(savedAll.weather) == "table" then
    weather.raining = savedAll.weather.raining == true
    weather.thundering = savedAll.weather.thundering == true
  end

  local function now() return os.epoch("utc") end
  local function nextTick(t) return (floor(t / 50) + 1) * 50 end
  local function after(ms, fn) core.after(math.max(0, ms) / 1000, fn) end

  --- a Java float widened to double (Biome.getTemperature, the vibration distance)
  local function float(d)
    if d == 0 or d ~= d or d == math.huge or d == -math.huge then return d end
    local m, e = math.frexp(d)
    m = floor(m * 16777216 + 0.5) / 16777216
    return math.ldexp(m, e)
  end

  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end

  local blocks = {} -- name -> block, every peripheral of this addon
  local M = { handlers = {} }

  -- ===== entity_detector =====

  local RANGE, Y_RANGE = 8, 16 -- EntityDetectorPeripheral.DEFAULT_RANGE / DEFAULT_Y_RANGE

  -- UUID.hashCode then HashMap.hash: the order HashMap<UUID, Entity>.keySet() walks in
  local function uuidHash(uuid)
    local hex = uuid:gsub("-", "")
    if #hex ~= 32 or hex:find("[^%x]") then return 0 end
    local h = 0
    for i = 0, 3 do h = bxor(h, tonumber(hex:sub(i * 8 + 1, i * 8 + 8), 16)) end
    return bxor(h, rshift(h, 16))
  end
  --- the keys of a HashMap built by put()s in this order, in its iteration order: by bucket, then insertion
  local function hashOrder(list)
    local cap = 16
    while #list > cap * 0.75 do cap = cap * 2 end
    local buckets = {}
    for i, e in ipairs(list) do
      local b = band(uuidHash(e.uuid), cap - 1)
      buckets[b] = buckets[b] or {}
      table.insert(buckets[b], e)
      e.__i = i
    end
    local out = {}
    for b = 0, cap - 1 do
      for _, e in ipairs(buckets[b] or {}) do out[#out + 1] = e end
    end
    return out
  end

  local uuidCounter = 0
  local function newUuid(seed)
    uuidCounter = uuidCounter + 1
    local h = host.md5(tostring(seed) .. "#" .. uuidCounter)
    -- shaped like a version 3 UUID, the kind UUID.nameUUIDFromBytes makes (offline players have one)
    local vi = tonumber(h:sub(17, 17), 16) % 4 + 1
    local variant = ("89ab"):sub(vi, vi)
    return ("%s-%s-3%s-%s%s-%s"):format(h:sub(1, 8), h:sub(9, 12), h:sub(14, 16), variant, h:sub(18, 20), h:sub(21, 32))
  end

  local function checkNumber(v, what)
    if type(v) ~= "number" or v ~= v then return nil, what .. " must be a number" end
    return v
  end

  --- an entity from the fixture or a command
  local function newEntity(e, owner)
    if type(e) ~= "table" then return nil, "entity must be an object" end
    local x, err = checkNumber(e.x, "x")
    if not x then return nil, err end
    local y, err2 = checkNumber(e.y, "y")
    if not y then return nil, err2 end
    local z, err3 = checkNumber(e.z, "z")
    if not z then return nil, err3 end
    local player = e.player == true or e.isPlayer == true
    local typeName = type(e.type) == "string" and e.type or (player and "Player" or "Pig")
    local name = type(e.name) == "string" and e.name or typeName
    return {
      uuid = type(e.uuid) == "string" and e.uuid:lower() or newUuid(owner .. ":" .. name),
      name = name,
      type = typeName,
      player = player,
      living = e.living ~= false,
      x = x, y = y, z = z,
      width = tonumber(e.width) or 0.6,
      height = tonumber(e.height) or 1.8,
    }
  end

  --- EntityDetectorTile.makeBox: new Box(pos).expand(8, 16, 8), here relative to the block; getOtherEntities keeps
  --- an entity whose bounding box intersects it (strictly), and nearbyEntities only the living ones
  local function inRange(e)
    if not e.living then return false end
    local hw = e.width / 2
    return e.x - hw < 1 + RANGE and e.x + hw > -RANGE
      and e.y < 1 + Y_RANGE and e.y + e.height > -Y_RANGE
      and e.z - hw < 1 + RANGE and e.z + hw > -RANGE
  end

  --- the map nearbyEntities and the events give for one entity (positions relative to the block)
  local function entityMap(e)
    return { uuid = e.uuid, name = e.name, isPlayer = e.player, type = e.type, x = e.x, y = e.y, z = e.z }
  end

  local function newDetector(def)
    local d = { kind = "entity_detector", name = def.name, entities = {} }
    local old = saved(def.name)
    local source = (old and type(old.entities) == "table") and old.entities or def.entities or {}
    for _, e in ipairs(source) do
      local ent, err = newEntity(e, def.name)
      if not ent then error("ccsim: " .. def.name .. ".entities: " .. err, 0) end
      d.entities[#d.entities + 1] = ent
    end

    local function seen()
      local list = {}
      for _, e in ipairs(d.entities) do if inRange(e) then list[#list + 1] = e end end
      return list
    end
    -- the first tick fills cachedEntities without an event
    d.cached = seen()
    local pending = false

    --- EntityDetectorTile.checkEntityChange, on the tick after a change: new ones, then the ones that left
    local function check()
      pending = false
      local fresh = seen()
      local freshSet, cachedSet = {}, {}
      for _, e in ipairs(fresh) do freshSet[e.uuid] = e end
      for _, e in ipairs(d.cached) do cachedSet[e.uuid] = e end
      for _, e in ipairs(hashOrder(fresh)) do
        if not cachedSet[e.uuid] then
          if OLD then queue("new_entity", entityMap(e)) else queue("new_entity", d.name, entityMap(e)) end
        end
      end
      for _, e in ipairs(hashOrder(d.cached)) do
        if not freshSet[e.uuid] then
          -- the cached Entity object: where it is now (or was last, when it is gone)
          if OLD then queue("removed_entity", entityMap(e)) else queue("removed_entity", d.name, entityMap(e)) end
        end
      end
      d.cached = fresh
    end
    function d.changed()
      core.touch()
      if pending then return end
      pending = true
      after(nextTick(now()) - now(), check)
    end

    function d.find(key)
      for i, e in ipairs(d.entities) do
        if e.uuid == key or e.name == key then return e, i end
      end
    end

    local p = {
      exactReturns = true,
      computerThread = { nearbyEntities = true },
      methods = {
        nearbyEntities = function()
          local out = {}
          for i, e in ipairs(seen()) do out[i] = entityMap(e) end
          return out
        end,
      },
    }
    function p.state()
      local list = {}
      for i, e in ipairs(d.entities) do
        list[i] = { uuid = e.uuid, name = e.name, type = e.type, player = e.player, living = e.living,
          x = e.x, y = e.y, z = e.z, width = e.width, height = e.height }
      end
      return { entities = list }
    end
    function p.detach() blocks[def.name] = nil end
    blocks[def.name] = d
    return p
  end

  -- ===== weather_machine =====

  local PRECIPITATION = { rain = true, snow = true, none = true }

  local function newWeatherMachine(def)
    local w = { kind = "weather_machine", name = def.name }
    local old = saved(def.name) or {}
    w.biome = old.biome or (type(def.biome) == "string" and def.biome) or "minecraft:plains"
    w.temperature = tonumber(old.temperature) or tonumber(def.temperature) or 0.8
    -- Biome.getPrecipitation: none without precipitation, else snow when cold enough (below 0.15) or rain
    w.precipitation = old.precipitation or def.precipitation
    if w.precipitation ~= nil and not PRECIPITATION[w.precipitation] then
      error("ccsim: " .. def.name .. ".precipitation must be rain, snow or none", 0)
    end
    local function precipitation()
      if w.precipitation then return w.precipitation end
      return w.temperature < 0.15 and "snow" or "rain"
    end
    -- World.isRaining / isThundering: thunder is scaled by the rain, so there is none without it
    local function raining() return weather.raining end
    local function thundering() return weather.raining and weather.thundering end

    local p = {
      exactReturns = true,
      computerThread = {
        isRaining = true, isThundering = true, getBiome = true, canSnow = true, isSnowing = true,
        getTemperature = true, isPrecipitating = true,
      },
      methods = {
        isRaining = function() return raining() and precipitation() == "rain" end,
        isThundering = function() return thundering() end,
        -- the biome key's toString cut after the last "/": "minecraft:plains"
        getBiome = function()
          local s = tostring(w.biome)
          local last = s:match("([^/]*)$") or s
          return (last:gsub("%]%]", ""):gsub(" ", ""))
        end,
        canSnow = function() return precipitation() == "snow" end,
        isSnowing = function() return raining() and precipitation() == "snow" end,
        getTemperature = function() return float(w.temperature) end,
        isPrecipitating = function() return raining() and precipitation() ~= "none" end,
      },
    }
    function p.state()
      return { biome = w.biome, temperature = w.temperature, precipitation = w.precipitation }
    end
    function p.detach() blocks[def.name] = nil end
    blocks[def.name] = w
    return p
  end

  -- ===== keyboard =====

  local function newKeyboard(def)
    local k = { kind = "keyboard", name = def.name }
    -- KeyboardPeripheral: every event goes to each attached computer; 1.20.1 adds the attachment name last
    function k.queue(event, ...)
      if OLD then return queue(event, ...) end
      local args = table.pack(...)
      args[args.n + 1] = k.name
      queue(event, table.unpack(args, 1, args.n + 1))
    end
    local p = { exactReturns = true, computerThread = {}, methods = {} }
    function p.detach() blocks[def.name] = nil end
    blocks[def.name] = k
    return p
  end

  -- ===== sculkophone (1.20.1 only) =====

  local SCULK_RANGE = 8 -- SPVibrationCallback.getRange
  local function newSculkophone(def)
    if OLD then
      error("ccsim: the sculkophone is not in " .. MOD .. ": it came in 1.1.0 (Minecraft 1.19.2)", 0)
    end
    local s = { kind = "sculkophone", name = def.name, phase = "inactive", until_ = 0 }
    local function phase()
      local t = now()
      if s.phase ~= "inactive" and t >= s.until_ then
        -- active for 20 ticks (setActive), then cooldown for 1 (setCooldown), then inactive
        if s.phase == "active" and t < s.until_ + 50 then return "cooldown" end
        s.phase = "inactive"
      end
      return s.phase
    end
    s.getPhase = phase
    function s.vibrate(event, distance, at)
      if phase() ~= "inactive" then return false end
      queue("vibration", s.name, event, float(distance))
      s.phase = "active"
      s.until_ = at + 20 * 50
      return true
    end
    function s.stepOn(at)
      if phase() ~= "inactive" then return end
      s.phase = "active"
      s.until_ = at + 20 * 50
    end
    local p = { exactReturns = true, computerThread = {}, methods = {} }
    function p.state() return { phase = phase() } end
    function p.detach() blocks[def.name] = nil end
    blocks[def.name] = s
    return p
  end

  local BUILD = {
    entity_detector = newDetector,
    weather_machine = newWeatherMachine,
    keyboard = newKeyboard,
    sculkophone = newSculkophone,
  }
  function M.peripheral(def) return BUILD[def.type](def) end

  -- ===== sim commands =====

  local function blockFor(cmd, kind)
    local name = cmd.peripheral
    if name == nil then
      local found
      for _, b in pairs(blocks) do
        if b.kind == kind then
          if found then return nil, "more than one " .. kind .. ": give peripheral" end
          found = b
        end
      end
      if not found then return nil, "no " .. kind .. " in this world" end
      return found
    end
    local b = blocks[name]
    if not b or b.kind ~= kind then return nil, tostring(name) .. " is not a " .. kind end
    return b
  end

  local H = M.handlers

  --- duckyAddEntity {peripheral?, entity}: an entity appears (x, y, z relative to the detector block)
  function H.duckyAddEntity(cmd)
    local d, err = blockFor(cmd, "entity_detector")
    if not d then return false, err end
    local e, err2 = newEntity(cmd.entity, d.name)
    if not e then return false, err2 end
    if d.find(e.uuid) then return false, "an entity with uuid " .. e.uuid .. " is already there" end
    d.entities[#d.entities + 1] = e
    d.changed()
    return true
  end

  --- duckyMoveEntity {peripheral?, entity (uuid or name), x, y, z}: it is somewhere else from the next tick
  function H.duckyMoveEntity(cmd)
    local d, err = blockFor(cmd, "entity_detector")
    if not d then return false, err end
    local e = d.find(cmd.entity)
    if not e then return false, "no entity " .. tostring(cmd.entity) end
    for _, axis in ipairs({ "x", "y", "z" }) do
      if cmd[axis] ~= nil then
        local v, err2 = checkNumber(cmd[axis], axis)
        if not v then return false, err2 end
        e[axis] = v
      end
    end
    d.changed()
    return true
  end

  --- duckyRemoveEntity {peripheral?, entity (uuid or name)}: it dies or despawns
  function H.duckyRemoveEntity(cmd)
    local d, err = blockFor(cmd, "entity_detector")
    if not d then return false, err end
    local _, i = d.find(cmd.entity)
    if not i then return false, "no entity " .. tostring(cmd.entity) end
    table.remove(d.entities, i)
    d.changed()
    return true
  end

  --- duckySetWeather {raining?, thundering?}: the world's weather, every weather machine sees it
  function H.duckySetWeather(cmd)
    if cmd.raining ~= nil then weather.raining = cmd.raining == true end
    if cmd.thundering ~= nil then weather.thundering = cmd.thundering == true end
    core.touch()
    return true
  end

  --- duckySetBiome {peripheral?, biome?, temperature?, precipitation?}: what the biome at the block is like
  function H.duckySetBiome(cmd)
    local w, err = blockFor(cmd, "weather_machine")
    if not w then return false, err end
    if cmd.precipitation ~= nil and cmd.precipitation ~= false and not PRECIPITATION[cmd.precipitation] then
      return false, "precipitation must be rain, snow or none"
    end
    if cmd.biome ~= nil then w.biome = tostring(cmd.biome) end
    if cmd.temperature ~= nil then w.temperature = tonumber(cmd.temperature) or w.temperature end
    if cmd.precipitation == false then w.precipitation = nil
    elseif cmd.precipitation ~= nil then w.precipitation = cmd.precipitation end
    core.touch()
    return true
  end

  local function keyCode(v)
    if type(v) == "number" then return floor(v) end
    if type(v) == "string" and type(keys) == "table" and type(keys[v]) == "number" then return keys[v] end
    return nil
  end
  local function withKeyboard(cmd, fn)
    local k, err = blockFor(cmd, "keyboard")
    if not k then return false, err end
    return fn(k)
  end

  --- duckyKey {peripheral?, key, repeat?}: a key goes down in the keyboard screen (a GLFW code or a keys name)
  function H.duckyKey(cmd)
    return withKeyboard(cmd, function(k)
      local code = keyCode(cmd.key)
      if not code then return false, "key must be a key code or a name from keys" end
      k.queue("key", code, cmd["repeat"] == true)
      return true
    end)
  end
  --- duckyKeyUp {peripheral?, key}: 1.0.2's keyUp sends ("key", key, false), 1.20.1 a key_up
  function H.duckyKeyUp(cmd)
    return withKeyboard(cmd, function(k)
      local code = keyCode(cmd.key)
      if not code then return false, "key must be a key code or a name from keys" end
      if OLD then k.queue("key", code, false) else k.queue("key_up", code) end
      return true
    end)
  end
  --- duckyChar {peripheral?, char}: one typed character
  function H.duckyChar(cmd)
    return withKeyboard(cmd, function(k)
      if type(cmd.char) ~= "string" or #cmd.char ~= 1 then return false, "char must be one character" end
      k.queue("char", cmd.char)
      return true
    end)
  end
  --- duckyType {peripheral?, text}: one char event per character (no key events: the screen sends those apart)
  function H.duckyType(cmd)
    return withKeyboard(cmd, function(k)
      if type(cmd.text) ~= "string" then return false, "text must be a string" end
      for i = 1, #cmd.text do k.queue("char", cmd.text:sub(i, i)) end
      return true
    end)
  end
  --- duckyKeyboardEvent {peripheral?, event}: holding Ctrl+T, Ctrl+S or Ctrl+R in the keyboard screen
  function H.duckyKeyboardEvent(cmd)
    return withKeyboard(cmd, function(k)
      if cmd.event == "terminate" then
        k.queue("terminate")
      elseif cmd.event == "shutdown" then
        -- ServerComputer.shutdown(), then a "shutdown" event the stopped computer never sees
        os.shutdown()
      elseif cmd.event == "reboot" then
        os.reboot()
      else
        return false, "event must be terminate, shutdown or reboot"
      end
      return true
    end)
  end

  --- duckyVibration {peripheral?, event, distance}: a vanilla game event within 8 blocks reaches the sculkophone
  function H.duckyVibration(cmd)
    local s, err = blockFor(cmd, "sculkophone")
    if not s then return false, err end
    if type(cmd.event) ~= "string" or cmd.event == "" then return false, "event must be a game event id (step)" end
    local distance = tonumber(cmd.distance) or 0
    if distance < 0 then return false, "distance must be 0 or more" end
    if distance > SCULK_RANGE then return true end -- out of its range: nothing hears it
    local event = cmd.event:gsub("^minecraft:", "")
    local at = nextTick(now())
    after(at - now(), function() s.vibrate(event, distance, at) end)
    return true
  end
  --- duckyStepOn {peripheral?}: something walks on it: active for 20 ticks, no event
  function H.duckyStepOn(cmd)
    local s, err = blockFor(cmd, "sculkophone")
    if not s then return false, err end
    s.stepOn(now())
    return true
  end

  function M.state() return { weather = { raining = weather.raining, thundering = weather.thundering } } end

  return M
end
