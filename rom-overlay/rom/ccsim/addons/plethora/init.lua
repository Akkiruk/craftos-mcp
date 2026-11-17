-- ccsim plethora: Plethora Peripherals (Lemmmy / SwitchCraft's Fabric port of SquidDev's Plethora), 1.20.1-1.13.0.
--
-- Written from github.com/SwitchCraftCC/Plethora-Fabric at 30c2b5d ("feat: v1.13.0"). Source files, relative to
-- src/main/java/io/sc3/plethora/:
--   core/{MethodRegistry,MethodWrapperPeripheral,MethodWrapperLuaObject,Context,DefaultCostHandler,RegisteredMethod,
--     TurtleUpgradeModule}, core/executor/{Task,TaskRunner,ComputerAccessExecutor,BasicExecutor};
--   api/method/{BasicMethod,FutureMethodResult,ArgumentExt,ContextHelpers}, api/module/*, api/{WorldLocation,
--     EntityWorldLocation};
--   gameplay/neural/{NeuralHelpers,NeuralComputer}, gameplay/manipulator/{ManipulatorPeripheral,ManipulatorType},
--   gameplay/modules/{LevelableModuleItem,ModuleItem,RangeInfo}, gameplay/modules/{scanner,sensor,introspection,
--     laser,kinetic,glasses}/*, gameplay/redstone/*, gameplay/registry/PlethoraMethodRegistration;
--   integration/{CoreMethods,GetMetadataMethod,EntityIdentifier}, integration/vanilla/meta/*,
--   integration/vanilla/method/*, integration/computercraft/InventoryMethodsWrapper;
--   util/config/PlethoraConfig (every default).
-- The glasses canvas is in canvas.lua; vanilla block hardness, collision and entity sizes in vanilla.lua.
-- docs/plethora.md lists every behaviour, the fixture fields, the sim commands and what is not emulated.
return function(core, host)
  local DIR = "/rom/ccsim/addons/plethora/"
  local V = dofile(DIR .. "vanilla.lua")
  local floor, abs, sqrt, sin, cos, huge = math.floor, math.abs, math.sqrt, math.sin, math.cos, math.huge
  local fmod = math.fmod
  local band, bxor, rshift, lshift = bit32.band, bit32.bxor, bit32.rshift, bit32.lshift
  local W = core.world.plethora or {}

  -- ===== config (PlethoraConfig defaults; world.plethora.config overrides any of them) =====

  local CFG = {
    laser = { minimumPotency = 0.5, maximumPotency = 5.0, damage = 4.0, cost = 10.0, lifetime = 5 * 20 },
    kinetic = { launchMax = 4.0, launchCost = 10.0, launchYScale = 0.5, launchFallReset = true,
      launchFloatReset = true, launchElytraScale = 0.4 },
    scanner = { radius = 8, maxRadius = 16, scanLevelCost = 50 },
    sensor = { radius = 16, maxRadius = 32, senseLevelCost = 40 },
    costSystem = { initial = 250.0, regen = 10.0, limit = 250.0, allowNegative = false, awaitRegen = true },
  }
  for section, values in pairs(type(W.config) == "table" and W.config or {}) do
    if CFG[section] and type(values) == "table" then
      for k, v in pairs(values) do CFG[section][k] = v end
    end
  end

  -- ===== Java =====

  local J = {}
  local TWO32, TWO31 = 4294967296, 2147483648
  function J.i32(n)
    n = n % TWO32
    if n >= TWO31 then n = n - TWO32 end
    return n
  end
  local i32 = J.i32
  local function trunc(d) if d >= 0 then return floor(d) end return -floor(-d) end
  --- Double.longValue() then (int): truncate, saturate at the long range, keep the low 32 bits
  function J.l2i(d)
    if d ~= d then return 0 end
    if d >= 9223372036854775807 then return -1 end
    if d <= -9223372036854775808 then return 0 end
    return i32(trunc(d))
  end
  --- Round to a Java float and back.
  local pack, unpack = string.pack, string.unpack
  if pack then
    function J.f32(x) return (unpack("<f", pack("<f", x))) end
  else
    function J.f32(x)
      if x ~= x or x == huge or x == -huge or x == 0 then return x end
      local m, e = math.frexp(x)
      local bits = 24
      if e < -125 then bits = 24 - (-125 - e) end
      if bits < 1 then return 0 * x end
      local s = m * 2 ^ bits
      local r = floor(s + 0.5)
      if r - s == 0.5 and r % 2 == 1 then r = r - 1 end
      local out = r * 2 ^ (e - bits)
      if abs(out) > 3.4028234663852886e38 then return out > 0 and huge or -huge end
      return out
    end
  end
  local f32 = J.f32

  --- Double.toString, for messages built with string templates.
  function J.dstr(d)
    if d ~= d then return "NaN" end
    if d == huge then return "Infinity" end
    if d == -huge then return "-Infinity" end
    if d == 0 then return (1 / d < 0) and "-0.0" or "0.0" end
    local digits, exp
    for p = 1, 17 do
      local s = string.format("%." .. p .. "e", d)
      if tonumber(s) == d then
        local mant, e = s:match("^-?(%d[%.%d]*)e([-+]%d+)$")
        digits, exp = mant:gsub("%.", ""), tonumber(e)
        break
      end
    end
    digits = digits:gsub("0+$", "")
    if digits == "" then digits = "0" end
    local sign = d < 0 and "-" or ""
    local a = abs(d)
    if a >= 1e-3 and a < 1e7 then
      local intLen = exp + 1
      if intLen <= 0 then return sign .. "0." .. string.rep("0", -intLen) .. digits end
      if intLen >= #digits then return sign .. digits .. string.rep("0", intLen - #digits) .. ".0" end
      return sign .. digits:sub(1, intLen) .. "." .. digits:sub(intLen + 1)
    end
    local frac = digits:sub(2)
    if frac == "" then frac = "0" end
    return sign .. digits:sub(1, 1) .. "." .. frac .. "E" .. exp
  end

  --- A Java exception other than a LuaException: shown as "Java Exception Thrown: <class>: <message>".
  local JAVA = {}
  JAVA.__tostring = function(e) return e.class .. (e.msg and (": " .. e.msg) or "") end
  function J.java(class, msg) error(setmetatable({ class = class, msg = msg }, JAVA), 0) end
  function J.isJava(e) return getmetatable(e) == JAVA end
  function J.lua(msg) error(msg, 0) end
  --- What a Plethora task makes of any error (Task.update, RegisteredMethod.call)
  local function luaError(e)
    if J.isJava(e) then return "Java Exception Thrown: " .. tostring(e) end
    return e
  end

  --- String.hashCode
  local function strHash(s)
    local h = 0
    for i = 1, #s do h = (h * 31 + s:byte(i)) % TWO32 end
    return h
  end

  -- Helpers.normaliseAngle: Helpers.mod(angle, 360), then above 180 take 360 off
  local function normaliseAngle(a)
    local m = fmod(a, 360)
    if m * 360 < 0 then m = m + 360 end
    if m > 180 then m = m - 360 end
    return m
  end

  -- MathHelper.sin / cos: the 65536-entry float table
  local function msinIndex(i) return f32(sin(i * math.pi * 2 / 65536)) end
  local function msin(x) return msinIndex(i32(trunc(f32(f32(x) * f32(10430.378)))) % 65536) end
  local function mcos(x) return msinIndex(i32(trunc(f32(f32(f32(x) * f32(10430.378)) + 16384))) % 65536) end

  -- ===== IArguments (CC:Tweaked 1.117 / 1.121) =====
  -- `a` is table.pack of the Lua arguments; indices here are 0-based like Java's.

  local A = {}
  function A.luaType(v)
    local t = type(v)
    if t == "nil" or t == "string" or t == "boolean" or t == "number" or t == "table" then return t end
    return "userdata" -- LuaValues.getType for anything else CC hands over
  end
  function A.argType(a, i) return type(a[i + 1]) end -- VarargArguments.getType: the Lua type
  function A.bad(i, expected, v) J.lua(("bad argument #%d (%s expected, got %s)"):format(i + 1, expected, type(v))) end
  local function numType(v)
    if v ~= v then return "nan" elseif v == huge then return "inf" elseif v == -huge then return "-inf" end
    return "number"
  end
  local function finite(i, v)
    if v ~= v or v == huge or v == -huge then J.lua(("bad argument #%d (number expected, got %s)"):format(i + 1, numType(v))) end
    return v
  end
  function A.double(a, i)
    local v = a[i + 1]
    if type(v) ~= "number" then A.bad(i, "number", v) end
    return v
  end
  function A.finite(a, i) return finite(i, A.double(a, i)) end
  function A.int(a, i)
    local v = a[i + 1]
    if type(v) ~= "number" then A.bad(i, "number", v) end
    return J.l2i(finite(i, v))
  end
  function A.optInt(a, i, def)
    local v = a[i + 1]
    if v == nil then return def end
    if type(v) ~= "number" then A.bad(i, "number", v) end
    return J.l2i(finite(i, v))
  end
  function A.optDouble(a, i, def)
    local v = a[i + 1]
    if v == nil then return def end
    if type(v) ~= "number" then A.bad(i, "number", v) end
    return v
  end
  function A.string(a, i)
    local v = a[i + 1]
    if type(v) ~= "string" then A.bad(i, "string", v) end
    return v
  end
  function A.optString(a, i, def)
    local v = a[i + 1]
    if v == nil then return def end
    if type(v) ~= "string" then A.bad(i, "string", v) end
    return v
  end
  function A.bool(a, i)
    local v = a[i + 1]
    if type(v) ~= "boolean" then A.bad(i, "boolean", v) end
    return v
  end
  function A.table(a, i)
    local v = a[i + 1]
    if type(v) ~= "table" then A.bad(i, "table", v) end
    return v
  end
  --- ArgumentExt.assertIntBetween / assertDoubleBetween
  local function intBetween(a, i, lo, hi, message)
    local v = A.int(a, i)
    if v < lo or v > hi then J.lua(message:format("between " .. lo .. " and " .. hi)) end
    return v
  end
  local function doubleBetween(a, i, lo, hi, message)
    local v = A.finite(a, i)
    if v < lo or v > hi or v ~= v then J.lua(message:format("between " .. J.dstr(lo) .. " and " .. J.dstr(hi))) end
    return v
  end

  -- ===== Identifier (net.minecraft.util.Identifier, 1.20.1) =====

  local function validChars(s, slash)
    for i = 1, #s do
      local c = s:sub(i, i)
      if not (c == "_" or c == "-" or c == "." or c:match("[a-z0-9]") or (slash and c == "/")) then return false end
    end
    return true
  end
  --- new Identifier(string): split at the first ':', "minecraft" when there is no namespace, then validate.
  --- An invalid one throws InvalidIdentifierException (net.minecraft.class_151 on a Fabric server).
  local function identifier(s)
    local ns, path = "minecraft", s
    local i = s:find(":", 1, true)
    if i then
      path = s:sub(i + 1)
      if i > 1 then ns = s:sub(1, i - 1) end
    end
    if not validChars(ns, false) then
      J.java("net.minecraft.class_151", "Non [a-z0-9_.-] character in namespace of location: " .. ns .. ":" .. path)
    end
    if not validChars(path, true) then
      J.java("net.minecraft.class_151", "Non [a-z0-9/._-] character in path of location: " .. ns .. ":" .. path)
    end
    return ns .. ":" .. path
  end

  --- Identifier.hashCode: 31 * namespace.hashCode() + path.hashCode()
  local function idHash(id)
    local ns, path = id:match("^([^:]*):(.*)$")
    return (31 * strHash(ns) + strHash(path)) % TWO32
  end

  --- A java.util.HashSet<Identifier> of these ids, in its iteration order (16 buckets: at most 12 entries fit).
  local function hashSetOrder(ids)
    local seen, unique = {}, {}
    for _, id in ipairs(ids) do
      if not seen[id] then seen[id] = true unique[#unique + 1] = id end
    end
    local buckets = {}
    for _, id in ipairs(unique) do
      local h = idHash(id)
      local spread = bxor(h, rshift(h, 16))
      local b = band(spread, 15)
      buckets[b] = buckets[b] or {}
      table.insert(buckets[b], id)
    end
    local out = {}
    for b = 0, 15 do
      for _, id in ipairs(buckets[b] or {}) do out[#out + 1] = id end
    end
    return out
  end

  -- ===== the clock =====

  local bootMs = core.nowMs()
  local startTick = tonumber(W.gameTime) or 0
  local function currentTick() return startTick + floor((core.nowMs() - bootMs) / 50) end

  -- ===== game data and the block world (the turtle block world, like Advanced Peripherals' geo scanner) =====

  local gameData, lootLib, rulesLib
  local function data()
    if core.gameData then return core.gameData end
    gameData = gameData or dofile("/rom/ccsim/turtle/data.lua")(core.world.gameData, core.version.blockData)
    return gameData
  end
  local function loot()
    lootLib = lootLib or dofile("/rom/ccsim/turtle/loot.lua")(data())
    return lootLib
  end
  local function hasWorld(w) return type(w) == "table" and (w.blocks ~= nil or w.fills ~= nil or w.ground ~= nil) end
  local sharedWorld
  local function blockWorld(def)
    if core.turtle then return core.turtle.world end
    if hasWorld(core.world) then
      if not sharedWorld then
        sharedWorld = dofile("/rom/ccsim/turtle/world.lua")(core, data())
        sharedWorld.load(core.world)
      end
      return sharedWorld
    end
    if def and hasWorld(def) then
      if not def.__world then
        local w = dofile("/rom/ccsim/turtle/world.lua")(core, data())
        w.load({ blocks = def.blocks, fills = def.fills, ground = def.ground })
        def.__world = w
      end
      return def.__world
    end
    return nil
  end
  local function blockAt(def, x, y, z)
    if core.turtle and core.turtle.blockAt then
      local b = core.turtle.blockAt(x, y, z)
      local p = core.position
      if b == nil and p and p.x == x and p.y == y and p.z == z then
        -- the turtle itself stands there
        local advanced = type(core.world.turtle) == "table" and core.world.turtle.advanced == true
        return { name = advanced and "computercraft:turtle_advanced" or "computercraft:turtle_normal", state = {} }
      end
      return b
    end
    local w = blockWorld(def)
    return w and w.get(x, y, z) or nil
  end
  local function setBlock(def, x, y, z, block)
    local w = blockWorld(def)
    if w then w.set(x, y, z, block) end
  end

  local AIR = { ["minecraft:air"] = true, ["minecraft:cave_air"] = true, ["minecraft:void_air"] = true }

  --- BlockStateMeta.fillBasicMeta: each property, as a boolean, number or string like its Java value.
  local function stateTable(block)
    local out = {}
    for k, v in pairs(block and block.state or {}) do
      local s = tostring(v)
      if s == "true" then out[k] = true
      elseif s == "false" then out[k] = false
      elseif s:match("^%-?%d+$") then out[k] = tonumber(s)
      else out[k] = s end
    end
    return out
  end

  local function hardnessOf(block)
    if block.def and type(block.def.hardness) == "number" then return f32(block.def.hardness) end
    local gd = core.world.gameData
    if gd and type(gd.hardness) == "table" and type(gd.hardness[block.name]) == "number" then return f32(gd.hardness[block.name]) end
    local h = V.hardness[block.name]
    if h then return f32(h) end
    return nil
  end

  -- ===== players and entities =====

  local LOOKUP = {} -- uuid -> extra state of a player (inventories and the like)
  local function playerDef(p)
    for _, def in ipairs(core.world.players or {}) do
      if def.name == p.name then return def end
    end
    return {}
  end
  local function playerExtra(p)
    local x = LOOKUP[p.uuid]
    if x then return x end
    local def = playerDef(p)
    x = { def = def }
    x.main = host.newInventory({ size = 36, items = def.inventory })
    x.ender = host.newInventory({ size = 27, items = def.ender })
    x.armor = {}
    for _, slot in ipairs({ "feet", "legs", "chest", "head" }) do x.armor[slot] = def.armor and def.armor[slot] or nil end
    x.offhand = def.offhand
    x.food = def.food or 20
    x.saturation = def.saturation or 5
    x.heldItemSlot = def.heldItemSlot or 0
    LOOKUP[p.uuid] = x
    return x
  end

  local entities = {}
  local mobCount = 0
  local function addEntity(def)
    mobCount = mobCount + 1
    local e = { def = def, uuid = def.uuid or string.format("00000000-0000-4000-9000-%012x", mobCount) }
    e.type = data().id(def.type or "minecraft:pig")
    e.x, e.y, e.z = def.x or 0, def.y or 64, def.z or 0
    e.yaw, e.pitch = f32(def.yaw or 0), f32(def.pitch or 0)
    local vt = V.entities[e.type]
    e.living = def.living
    if e.living == nil then e.living = vt == nil or vt[4] end
    e.maxHealth = def.maxHealth or 20
    e.health = def.health or e.maxHealth
    e.alive = def.alive ~= false
    e.dimension = def.dimension or "minecraft:overworld"
    entities[#entities + 1] = e
    return e
  end
  for _, def in ipairs(W.entities or {}) do addEntity(def) end

  --- An entity view: a player (from world.players) or a fixture entity. Same fields either way.
  local function playerEntity(p)
    local x = playerExtra(p)
    local def = x.def
    return {
      isPlayer = true, player = p, extra = x, def = def, uuid = p.uuid, type = "minecraft:player",
      x = p.x, y = p.y, z = p.z, yaw = f32(p.yaw or 0), pitch = f32(p.pitch or 0), dimension = p.dimension,
      health = p.health, maxHealth = p.maxHealth, living = true, alive = p.health == nil or p.health > 0,
    }
  end

  local function eyeHeight(e)
    if e.def.eyeHeight then return f32(e.def.eyeHeight) end
    if e.isPlayer then return e.def.sneaking and f32(1.27) or f32(1.62) end -- PlayerEntity.getActiveEyeHeight
    local vt = V.entities[e.type]
    local h = f32(e.def.height or (vt and vt[3]) or 1)
    return f32(h * f32(0.85)) -- Entity.getEyeHeight: 85% of the height, unless the entity says otherwise
  end
  local function sizeOf(e)
    if e.isPlayer then return f32(0.6), e.def.sneaking and f32(1.5) or f32(1.8) end
    local vt = V.entities[e.type]
    return f32(e.def.width or (vt and vt[2]) or 0.6), f32(e.def.height or (vt and vt[3]) or 1)
  end
  local function eyePos(e) return e.x, e.y + eyeHeight(e), e.z end
  local function bbox(e)
    local w, h = sizeOf(e)
    local hw = w / 2
    return { e.x - hw, e.y, e.z - hw, e.x + hw, e.y + h, e.z + hw }
  end

  --- Every entity in the world: online players, then the fixture's entities, then items dropped in the block world.
  local function allEntities()
    local out = {}
    for _, p in ipairs(core.players or {}) do
      if p.online then out[#out + 1] = playerEntity(p) end
    end
    for _, e in ipairs(entities) do out[#out + 1] = e end
    return out
  end
  local function findPlayer(nameOrUuid)
    local p = core.findPlayer(nameOrUuid)
    return p
  end
  local function entityByUuid(uuid)
    for _, e in ipairs(allEntities()) do if e.uuid == uuid then return e end end
    return nil
  end

  local function entityTypeName(e)
    local vt = V.entities[e.type]
    if vt then return vt[1] end
    return data().displayName(e.type)
  end
  --- EntityHelpers.getName: a player's name, else the entity type's name
  local function entityName(e)
    if e.isPlayer then return e.player.name end
    return entityTypeName(e)
  end
  --- Entity.getName().getString(): a custom name, a dropped item's name, else the type's
  local function displayName(e)
    if e.isPlayer then return e.player.name end
    if e.def.customName then return e.def.customName end
    if e.type == "minecraft:item" and e.def.item then
      return e.def.item.displayName or data().displayName(e.def.item.name)
    end
    return entityTypeName(e)
  end

  local function predicate(e)
    if not e.alive then return false end
    if e.isPlayer and e.def.gameMode == "spectator" then return false end
    return true
  end

  -- ===== cost handlers (DefaultCostHandler: one per owner, regenerated every tick) =====

  local costs = {}
  local function costHandler(key)
    local h = costs[key]
    if not h then
      h = { value = CFG.costSystem.initial, tick = currentTick() }
      costs[key] = h
    end
    return h
  end
  local function regen(h)
    local t = currentTick()
    local cs = CFG.costSystem
    while h.tick < t do
      h.tick = h.tick + 1
      if h.value < cs.limit then h.value = math.min(cs.limit, h.value + cs.regen) else
        h.tick = t -- full: nothing changes until something is spent
      end
    end
  end
  local function consume(h, amount)
    regen(h)
    local cs = CFG.costSystem
    if cs.allowNegative then
      if h.value <= 0 then return false end
    elseif amount > h.value then
      return false
    end
    h.value = h.value - amount
    return true
  end

  -- ===== futures (FutureMethodResult) and tasks =====

  local FINAL = {}
  local function R(...) return { [FINAL] = true, n = select("#", ...), ... } end
  local function isFinal(f) return f[FINAL] == true end
  local function nextTick(fn) return { call = fn } end
  local function awaiting(ready, fn) return { ready = ready, call = fn } end

  --- ICostHandler.await, both overloads. `closeParen`: the Callable overload's message ends in ")." and the
  --- FutureMethodResult one in "." alone.
  local function costAwait(h, amount, nextFn, isCallable)
    if consume(h, amount) then
      if isCallable then return nextFn() end
      return nextFn
    end
    local cs = CFG.costSystem
    if (not cs.allowNegative and amount > cs.limit) or not cs.awaitRegen then
      J.lua("Insufficient energy (requires " .. J.dstr(amount) .. ", has " .. J.dstr(h.value) .. (isCallable and ")." or "."))
    end
    if isCallable then return awaiting(function() return consume(h, amount) end, nextFn) end
    return awaiting(function() return consume(h, amount) end, function() return nextFn end)
  end

  --- One TaskRunner.update of a task: run as much of the chain as is ready. true when done.
  local function stepTask(task)
    while not task.done do
      local fut = task.fut
      if not task.resolved then
        if fut.ready and not fut.ready() then return false end
        task.resolved = true
      end
      local ok, res = pcall(fut.call)
      if not ok then
        task.done, task.err = true, luaError(res)
      elseif isFinal(res) then
        task.done, task.result = true, res
      else
        task.fut, task.resolved = res, false
      end
    end
    return true
  end

  local AGAIN = {}
  --- IResultExecutor.execute. `ex`: { attached() -> message|nil, nextId() } for a ComputerAccessExecutor (the
  --- plethora_task event), or nil for the BasicExecutor (one main-thread task, task_complete).
  local function execute(fut, ex)
    if ex then
      local msg = ex.attached()
      if msg then J.lua(msg) end
    end
    if isFinal(fut) then return fut end
    local task = { fut = fut }
    local opts
    if ex then opts = { event = "plethora_task", id = ex.nextId(), again = AGAIN } end
    local r = core.waitForServerTick(function()
      if core.beforeObserve then core.beforeObserve() end
      if ex then
        -- ComputerTask.update: a detached peripheral cancels the task
        local msg = ex.attached()
        if msg then task.done, task.err = true, msg end
      end
      if ex then
        if not stepTask(task) then return AGAIN end
      else
        -- BlockingTask: one pass; a chain still waiting gives nothing
        if not stepTask(task) then return end
      end
      if task.err then error(task.err, 0) end
      if task.result then return table.unpack(task.result, 1, task.result.n) end
    end, false, opts)
    if not r[1] then J.lua(luaError(r[2])) end
    core.touch()
    return R(table.unpack(r, 2, r.n))
  end

  -- ===== Lua objects (TypedLuaObject: a table of functions) =====

  local GET_DOCS_DOC = "function([name: string]):string|table -- Get the documentation for all functions or the " ..
    "function specified. Errors if the function cannot be found."
  local GET_METADATA_DOC = "function():table -- Get metadata about this object"

  --- A method of a Lua object: errors are positioned at the caller (LuaException, level 1).
  local function objectFunction(apply, ex)
    return function(...)
      local args = table.pack(...)
      local ok, res = pcall(function()
        local fut = apply(args)
        return execute(fut, ex)
      end)
      if not ok then error(luaError(res), 2) end
      return table.unpack(res, 1, res.n)
    end
  end

  -- ===== the glasses canvas =====

  local P = { J = J, A = A, data = data, identifier = identifier, GET_DOCS_DOC = GET_DOCS_DOC }
  --- A canvas method: worldThread = false, so it runs at once (the executor only checks it is still attached).
  --- The method runs first (its safeBake can fail), then the executor checks it is still attached.
  function P.immediate(fn, ex)
    return function(...)
      local args = table.pack(...)
      local ok, res = pcall(function()
        local out = table.pack(fn(args))
        local msg = ex.attached()
        if msg then J.lua(msg) end
        return out
      end)
      if not ok then error(luaError(res), 2) end
      core.touch()
      return table.unpack(res, 1, res.n)
    end
  end
  function P.docsMethod(docs, ex)
    return objectFunction(function(args)
      return nextTick(function()
        local name = A.optString(args, 0, nil)
        if name == nil then
          local out = {}
          for k, v in pairs(docs) do out[k] = v end
          return R(out)
        end
        local d = docs[name]
        if d == nil then J.lua("No such method") end
        return R(d)
      end)
    end, ex)
  end
  local Canvas = dofile(DIR .. "canvas.lua")(P)

  -- ===== metadata =====

  local itemDetail = host.itemDetail

  --- ContextHelpers.wrapStack: an object whose getMetadata gives the stack's details; nil for no stack.
  local function wrapStack(item, ex)
    if item == nil or (item.count or 1) <= 0 then return nil end
    local copy = host.copy(item)
    copy.count = copy.count or 1
    local docs = { getMetadata = GET_METADATA_DOC, getDocs = GET_DOCS_DOC }
    return {
      getMetadata = objectFunction(function()
        return nextTick(function() return R(itemDetail(copy)) end)
      end, ex),
      getDocs = objectFunction(function(args)
        return nextTick(function()
          local name = A.optString(args, 0, nil)
          if name == nil then return R(host.copy(docs)) end
          if docs[name] == nil then J.lua("No such method") end
          return R(docs[name])
        end)
      end, ex),
    }
  end

  --- EntityMeta.getBasicProperties. `loc`: { x, y, z, dimension } of the origin, or nil.
  local function basicProperties(e, loc)
    local m = e.def.motion or {}
    local d = e.def.deltaPos or {}
    local out = {
      id = e.uuid,
      key = e.type,
      name = entityName(e),
      displayName = displayName(e),
      motionX = m.x or m[1] or 0, motionY = m.y or m[2] or 0, motionZ = m.z or m[3] or 0,
      deltaPosX = d.x or d[1] or 0, deltaPosY = d.y or d[2] or 0, deltaPosZ = d.z or d[3] or 0,
      pitch = normaliseAngle(e.pitch),
      yaw = normaliseAngle(e.yaw),
    }
    if loc and loc.dimension == (e.dimension or "minecraft:overworld") then
      local x, y, z = eyePos(e)
      out.x, out.y, out.z = x - loc.x, y - loc.y, z - loc.z
    end
    return out
  end

  local function heldItem(e)
    if e.isPlayer then return e.extra.main.__state()[e.extra.heldItemSlot + 1] end
    return e.def.heldItem
  end
  local function armorItem(e, slot)
    if e.isPlayer then return e.extra.armor[slot] end
    return e.def.armor and e.def.armor[slot] or nil
  end
  local function offhandItem(e)
    if e.isPlayer then return e.extra.offhand end
    return e.def.offhand
  end

  local neuralWorn = {} -- player uuid -> true while a neural interface peripheral is worn (for trinkets)

  --- The whole meta of an entity: every provider that applies (EntityMeta, LivingEntityMeta, PlayerEntityMeta,
  --- ItemEntityMeta, SheepEntityMeta).
  local function entityMeta(e, loc, ex)
    local out = basicProperties(e, loc)
    local x, y, z = eyePos(e)
    out.withinBlock = { x = x - floor(x), y = y - floor(y), z = z - floor(z) }
    local def = e.def
    if e.living then
      out.armor = {
        boots = wrapStack(armorItem(e, "feet"), ex),
        leggings = wrapStack(armorItem(e, "legs"), ex),
        chestplate = wrapStack(armorItem(e, "chest"), ex),
        helmet = wrapStack(armorItem(e, "head"), ex),
      }
      if e.isPlayer then
        -- TrinketsApi: the player's trinket groups and slots; Plethora's neural interface sits in head/face
        if def.trinkets then
          local t = {}
          for group, slots in pairs(def.trinkets) do
            t[group] = {}
            for slot, items in pairs(slots) do
              t[group][slot] = {}
              for k, it in pairs(items) do t[group][slot][tonumber(k) or k] = wrapStack(it, ex) end
            end
          end
          out.trinkets = t
        else
          out.trinkets = { head = { face = neuralWorn[e.uuid] and { wrapStack({ name = "plethora:neural_interface", count = 1 }, ex) } or {} } }
        end
      end
      out.heldItem = wrapStack(heldItem(e), ex)
      out.offhandItem = wrapStack(offhandItem(e), ex)
      local effects = {}
      for i, name in ipairs(def.potionEffects or {}) do effects[i] = name end
      out.potionEffects = effects
      out.absorption = f32(def.absorption or 0)
      out.health = f32(e.health or 20)
      out.maxHealth = f32(e.maxHealth or 20)
      out.isAirborne = def.onGround == false
      out.isBurning = def.burning == true
      out.isAlive = e.alive
      out.isInWater = def.inWater == true
      out.isOnLadder = def.climbing == true
      out.isSleeping = def.sleeping == true
      out.isRiding = def.riding == true
      out.isSneaking = def.sneaking == true
      out.isSprinting = def.sprinting == true
      out.isWet = def.inWater == true or def.wet == true
      out.isChild = def.baby == true
      out.isDead = (e.health or 20) <= 0
      out.isElytraFlying = def.elytraFlying == true
    end
    if e.isPlayer then
      local food = e.extra.food
      out.food = { hunger = food, saturation = f32(e.extra.saturation), hungry = food < 20 }
      out.heldItemSlot = e.extra.heldItemSlot
    end
    if e.type == "minecraft:item" and def.item then out.item = itemDetail(def.item) end
    if e.type == "minecraft:sheep" then
      local c = def.color or def.colour or "white"
      out.woolColour, out.woolColor = c, c
    end
    return out
  end

  --- BlockMeta + BlockReferenceMeta + BlockStateMeta (+ SignBlockEntityMeta) for a block in the world.
  local function blockMeta(block)
    local name = block and block.name or "minecraft:air"
    local b = block or { name = name, state = {} }
    local out = {
      name = name,
      displayName = data().displayName(name),
      translationKey = "block." .. name:gsub(":", "."),
      state = stateTable(b),
    }
    local h = hardnessOf(b)
    if h then out.hardness = h end
    local col = data().mapColour(name, b.state)
    if col == nil and (V.hardness[name] ~= nil) then col = 0 end -- a vanilla block with MapColor.CLEAR
    if col ~= nil then out.color, out.colour = col, col end
    local lines = b.blockEntity and b.blockEntity.lines
    if type(lines) == "table" and name:match("_sign$") then
      local l = {}
      for i = 1, 8 do l[i] = lines[i] or lines[tostring(i)] or "" end
      out.lines = l
    end
    return out
  end

  -- ===== the modules =====
  -- spec: { name, doc, modules = { ids }, sub = what the context must hold, world = worldThread, fn(ctx, args) }
  -- sub: "location", "entity" (EntityIdentifier), "player" (EntityIdentifier.Player), "living" (LivingEntity),
  -- "canvas" (CanvasServer). The list is in MethodRegistry order: Vanilla's registrations, Plethora's, then CC's.

  local SCANNER, SENSOR, INTRO = "plethora:scanner", "plethora:sensor", "plethora:introspection"
  local LASER, KINETIC, GLASSES, KEYBOARD = "plethora:laser", "plethora:kinetic", "plethora:glasses", "plethora:keyboard"

  local SPECS = {}
  local function spec(s) SPECS[#SPECS + 1] = s return s end

  -- lasers in flight (ticked by catchUp) and kinetic launches
  local lasers, laserTick = {}, currentTick()
  local launches = {}
  local laserCount = 0

  --- The entity an introspection method talks about (IntrospectionContextHelpers.getContext).
  local function subEntity(ctx, module)
    return ctx.identifier(module)
  end

  -- player inventories as Plethora wraps them (RangedInventoryWrapper / EquipmentInventoryWrapper)
  local INV_DOCS = {
    size = "function():number -- Get the size of this inventory.",
    list = "function():table -- List all items in this inventory. This returns a table, with an entry for each slot.",
    getItemDetail = "function(slot:number):table -- Get detailed information about an item.",
    getItemLimit = "function(slot:number):number -- Get the maximum number of items which can be stored in this slot.",
    pushItems = "function(toName:string, fromSlot:number, [limit:number], [toSlot:number]):number -- Push items from one inventory to another connected one.",
    pullItems = "function(fromName:string, fromSlot:number, [limit:number], [toSlot:number]):number -- Pull items from a connected inventory into this one.",
    consume = "function(slot:number):boolean -- Consume an item from the given slot in the inventory",
    drop = "function(slot:number, [limit:number, [direction:string]]):number -- Drop an item on the ground",
  }

  local EQUIP_SLOTS = { "mainhand", "offhand", "feet", "legs", "chest", "head" } -- EquipmentSlot.entries

  --- An inventory object. `get()`: { inv = a host inventory, after = function() end }, fresh each call.
  local function inventoryObject(ctx, get, ranged, player)
    local ex = ctx.ex
    local obj, docs = {}, {}
    local function m(name, fn)
      docs[name] = INV_DOCS[name]
      obj[name] = objectFunction(function(args)
        return nextTick(function()
          ctx.check()
          local h = get()
          local res = table.pack(fn(h.inv, args))
          if h.after then h.after() end
          return R(table.unpack(res, 1, res.n))
        end)
      end, ex)
    end
    m("size", function(inv) return inv.size() end)
    m("list", function(inv) return inv.list() end)
    m("getItemDetail", function(inv, a) return inv.getItemDetail(A.int(a, 0)) end)
    m("getItemLimit", function(inv, a) return inv.getItemLimit(A.int(a, 0)) end)
    m("pushItems", function(inv, a)
      local to, from = A.string(a, 0), A.int(a, 1)
      return inv.pushItems(to, from, A.optInt(a, 2, nil), A.optInt(a, 3, nil))
    end)
    m("pullItems", function(inv, a)
      local from, slot = A.string(a, 0), A.int(a, 1)
      return inv.pullItems(from, slot, A.optInt(a, 2, nil), A.optInt(a, 3, nil))
    end)
    if ranged then
      m("consume", function(inv, a)
        local slot = intBetween(a, 0, 1, 36, "Slot out of range (%s)")
        if not ctx.modules.set[INTRO] then J.lua("No Introspection module installed") end
        local items = inv.__state()
        local it = items[slot]
        if not it then return false end
        -- food: an item with `hunger` and `saturation` (FoodItemMeta's keys); a drink says useAction = "drink"
        local action = it.useAction or (it.hunger ~= nil and "eat") or nil
        if action ~= "eat" and action ~= "drink" then return false end
        -- Item.finishUsing: one of the stack is used; food fills the player (HungerManager.eat, in floats)
        if it.hunger ~= nil and player then
          local x = playerExtra(player)
          local n, s = it.hunger, f32(it.saturation or 0)
          x.food = math.min(n + x.food, 20)
          x.saturation = math.min(f32(x.saturation + f32(f32(n * s) * 2)), x.food)
        end
        it.count = (it.count or 1) - 1
        if it.count <= 0 then items[slot] = it.remainder and host.copy(it.remainder) or nil end
        return true
      end)
      m("drop", function(inv, a)
        local slot = intBetween(a, 0, 1, 36, "Slot out of range (%s)")
        local limit = intBetween(a, 1, 1, 2147483647, "Limit out of range (%s)")
        local direction = A.optString(a, 2, nil)
        if not ctx.modules.set[INTRO] then J.lua("No Introspection module installed") end
        local items = inv.__state()
        local it = items[slot]
        if not it then return 0 end
        local loc = ctx.location()
        local dir
        if direction == "forward" or direction == "backward" then
          local e = player and playerEntity(player)
          local yaw = e and e.yaw or 0
          -- Entity.getHorizontalFacing: Direction.fromRotation(yaw)
          local idx = floor(yaw / 90 + 0.5) % 4
          dir = ({ [0] = "south", [1] = "west", [2] = "north", [3] = "east" })[idx]
          if direction == "backward" then
            dir = ({ south = "north", north = "south", west = "east", east = "west" })[dir]
          end
        elseif direction ~= nil then
          local ok = ({ down = true, up = true, north = true, south = true, west = true, east = true })[direction]
          if not ok then J.lua("Invalid direction: " .. direction) end
          dir = direction
        end
        local n = math.min(limit, it.count or 1)
        local dropped = host.copy(it)
        dropped.count = n
        it.count = (it.count or 1) - n
        if it.count <= 0 then items[slot] = nil end
        local x, y, z = loc.x, loc.y, loc.z
        if dir then
          local v = ({ down = { 0, -1, 0 }, up = { 0, 1, 0 }, north = { 0, 0, -1 }, south = { 0, 0, 1 },
            west = { -1, 0, 0 }, east = { 1, 0, 0 } })[dir]
          x, y, z = x + v[1] * 0.75, y + v[2] * 0.75, z + v[3] * 0.75
        end
        addEntity({ type = "minecraft:item", item = dropped, x = x, y = y, z = z, dimension = loc.dimension, living = false })
        return n
      end)
    end
    docs.getDocs = GET_DOCS_DOC
    obj.getDocs = objectFunction(function(args)
      return nextTick(function()
        local name = A.optString(args, 0, nil)
        if name == nil then return R(host.copy(docs)) end
        if docs[name] == nil then J.lua("No such method") end
        return R(docs[name])
      end)
    end, ex)
    return obj
  end

  local function playerFor(ctx, module)
    local id = ctx.identifier(module)
    if not id or not id.player then J.lua("Must be run on a player") end
    local p = findPlayer(id.uuid)
    if not p or not p.online then J.lua("Player is not online") end
    return p
  end

  spec({ name = "getInventory", doc = "function():table -- Get this player's inventory", modules = { INTRO }, sub = "player", world = true,
    fn = function(ctx)
      ctx.check()
      local p = playerFor(ctx, INTRO)
      return R(inventoryObject(ctx, function() return { inv = playerExtra(p).main } end, true, p))
    end })
  spec({ name = "getEquipment", doc = "function():table -- Get this player's held item and armor", modules = { INTRO }, sub = "player", world = true,
    fn = function(ctx)
      ctx.check()
      local p = playerFor(ctx, INTRO)
      return R(inventoryObject(ctx, function()
        local x = playerExtra(p)
        local main = x.main.__state()
        local items = { main[x.heldItemSlot + 1], x.offhand, x.armor.feet, x.armor.legs, x.armor.chest, x.armor.head }
        local view = host.newInventory({ size = 6, items = items })
        return { inv = view, after = function()
          local s = view.__state()
          main[x.heldItemSlot + 1] = s[1]
          x.offhand, x.armor.feet, x.armor.legs, x.armor.chest, x.armor.head = s[2], s[3], s[4], s[5], s[6]
        end }
      end, false, p))
    end })
  spec({ name = "getEnder", doc = "function():table -- Get this player's ender chest", modules = { INTRO }, sub = "player", world = true,
    fn = function(ctx)
      ctx.check()
      local p = playerFor(ctx, INTRO)
      return R(inventoryObject(ctx, function() return { inv = playerExtra(p).ender } end, true, p))
    end })

  local function livingFor(ctx)
    -- KineticMethods.getContext: the LivingEntity from the origin or the module
    return ctx.living(KINETIC)
  end
  spec({ name = "look", doc = "function(yaw:number, pitch:number) -- Look in a set direction", modules = { KINETIC }, sub = "living", world = true,
    fn = function(ctx, a)
      ctx.check()
      local e = livingFor(ctx)
      local yaw = f32(normaliseAngle(A.finite(a, 0)))
      local pitch = f32(math.max(-90, math.min(90, normaliseAngle(A.finite(a, 1)))))
      if e.isPlayer then
        e.player.yaw, e.player.pitch = yaw, pitch
      else
        e.yaw, e.pitch = yaw, pitch
      end
      core.dirty = true
      return R()
    end })
  local function notEmulated(what)
    return function() J.lua("ccsim: " .. what .. " is not emulated (docs/plethora.md)") end
  end
  spec({ name = "use", doc = "function([duration:integer], [hand:string]):boolean, string|nil -- Right click with this item using a particular hand (\"main\" or \"off\"). The duration is in ticks, or 1/20th of a second.",
    modules = { KINETIC }, sub = "living", world = true, fn = notEmulated("kinetic use") })
  spec({ name = "swing", doc = "function():boolean, string|nil -- Left click with the item in the main hand. Returns the action taken.",
    modules = { KINETIC }, sub = "living", world = true, fn = notEmulated("kinetic swing") })

  spec({ name = "listModules", doc = "function():table -- Lists all modules available", world = true,
    fn = function(ctx)
      ctx.check()
      local out = {}
      for i, id in ipairs(ctx.modules.list) do out[i] = id end
      return R(out)
    end })
  spec({ name = "hasModule", doc = "function(module:string):boolean -- Checks whether a module is available", world = true,
    fn = function(ctx, a)
      ctx.check()
      local id = identifier(A.string(a, 0))
      return R(ctx.modules.set[id] == true)
    end })
  spec({ name = "filterModules", doc = "function(names:string...):table|nil -- Gets the methods which require these modules", world = true,
    fn = function(ctx, a)
      ctx.check()
      local list, seen = {}, {}
      for i = 0, a.n - 1 do
        local id = identifier(A.string(a, i))
        if ctx.modules.set[id] and not seen[id] then seen[id] = true list[#list + 1] = id end -- a LinkedHashSet
      end
      if #list == 0 then
        -- the Kotlin delegate returns null, which Task.update then calls isFinal() on
        J.java("java.lang.NullPointerException",
          'Cannot invoke "io.sc3.plethora.api.method.FutureMethodResult.isFinal()" because "next" is null')
      end
      return R(ctx.childObject(list))
    end })

  spec({ name = "getID", doc = "function():string -- Get this entity's UUID.", modules = { INTRO }, sub = "entity", world = true,
    fn = function(ctx)
      ctx.check()
      return R(subEntity(ctx, INTRO).uuid)
    end })
  spec({ name = "getName", doc = "function():string -- Get this entity's name.", modules = { INTRO }, sub = "entity", world = true,
    fn = function(ctx)
      ctx.check()
      return R(subEntity(ctx, INTRO).name) -- EntityIdentifier.name: null unless it is a player
    end })
  spec({ name = "getMetaOwner", doc = "function():table -- Get this entity's metadata.", modules = { INTRO, SENSOR }, sub = "entity", world = true,
    fn = function(ctx)
      ctx.check()
      local id = ctx.identifier(INTRO) or ctx.identifier(SENSOR)
      local e = entityByUuid(id.uuid)
      if not e or not e.living then J.lua("Cannot find entity") end
      -- makePartialChild: a partial context, so its item objects use the BasicExecutor
      return R(entityMeta(e, ctx.location(), nil))
    end })

  spec({ name = "launch", doc = "function(yaw:number, pitch:number, power:number) -- Launch the entity in a set direction", modules = { KINETIC }, sub = "living", world = true,
    fn = function(ctx, a)
      ctx.check()
      local yaw = f32(normaliseAngle(A.finite(a, 0)))
      local pitch = f32(normaliseAngle(A.finite(a, 1)))
      local power = f32(doubleBetween(a, 2, 0, CFG.kinetic.launchMax, "Power out of range (%s)."))
      return costAwait(ctx.cost, power * CFG.kinetic.launchCost, nextTick(function()
        local e = ctx.originLiving()
        if not e then J.java("java.lang.NullPointerException") end
        -- KineticMethods.launch
        local mx = f32(-msin(f32(f32(yaw / f32(180)) * f32(math.pi))) * mcos(f32(f32(pitch / f32(180)) * f32(math.pi))))
        local mz = f32(mcos(f32(f32(yaw / f32(180)) * f32(math.pi))) * mcos(f32(f32(pitch / f32(180)) * f32(math.pi))))
        local my = f32(-msin(f32(f32(pitch / f32(180)) * f32(math.pi))))
        local len = f32(sqrt(f32(f32(f32(mx * mx) + f32(my * my)) + f32(mz * mz))))
        local pw = f32(power / len)
        if e.def.elytraFlying then pw = f32(pw * CFG.kinetic.launchElytraScale) end
        -- Entity.addVelocity: recorded, not applied (no movement is emulated)
        launches[#launches + 1] = {
          entity = e.uuid, tick = currentTick(),
          x = f32(mx * pw), y = f32(my * pw) * CFG.kinetic.launchYScale, z = f32(mz * pw),
        }
        core.dirty = true
        return R()
      end))
    end })

  spec({ name = "fire", doc = "function(yaw:number, pitch:number, potency:number) -- Fire a laser in a set direction", modules = { LASER }, sub = "location", world = true,
    fn = function(ctx, a)
      ctx.check()
      local yaw = normaliseAngle(A.finite(a, 0))
      local pitch = normaliseAngle(A.finite(a, 1))
      local potency = f32(doubleBetween(a, 2, CFG.laser.minimumPotency, CFG.laser.maximumPotency, "Potency out of range (%s)."))
      local PIF = f32(math.pi)
      local motionX = -sin(yaw / 180 * PIF) * cos(pitch / 180 * PIF)
      local motionZ = cos(yaw / 180 * PIF) * cos(pitch / 180 * PIF)
      local motionY = -sin(pitch / 180 * PIF)
      return costAwait(ctx.cost, potency * CFG.laser.cost, nextTick(function()
        local loc = ctx.location()
        local px, py, pz
        if ctx.host.kind == "manipulator" or ctx.host.kind == "turtle" then
          local vOff = 0.3
          local ox, oy, oz
          if pitch < -60 then ox, oy, oz = 0, 0.5 + vOff, 0
          elseif pitch > 60 then ox, oy, oz = 0, -0.5 - vOff, 0
          else
            local hOff = 0.9
            local length = sqrt(motionX * motionX + motionZ * motionZ)
            ox, oy, oz = motionX / length * hOff, 0, motionZ / length * hOff
          end
          px, py, pz = loc.x + ox, loc.y + oy, loc.z + oz
        else
          local e = ctx.originEntity()
          local w = sizeOf(e)
          local offset = w + 0.2
          local length = sqrt(motionX * motionX + motionY * motionY + motionZ * motionZ)
          px = e.x + motionX / length * offset
          py = e.y + (eyeHeight(e) + motionY / length * offset)
          pz = e.z + motionZ / length * offset
        end
        -- LaserEntity.shoot(motion, 1.5f, 0f): normalised, times 1.5 (no spread at 0 inaccuracy)
        local d = sqrt(motionX * motionX + motionY * motionY + motionZ * motionZ)
        local vx, vy, vz = 0, 0, 0
        if d >= 1.0E-4 then vx, vy, vz = motionX / d * 1.5, motionY / d * 1.5, motionZ / d * 1.5 end
        laserCount = laserCount + 1
        local shooter = ctx.originEntity and ctx.originEntity() or nil
        lasers[#lasers + 1] = {
          id = laserCount, x = px, y = py, z = pz, vx = vx, vy = vy, vz = vz, potency = potency, age = 0,
          shooter = shooter and shooter.uuid or nil, def = ctx.def, dimension = loc.dimension,
          creative = shooter and shooter.isPlayer and shooter.def.gameMode == "creative",
        }
        core.dirty = true
        return R()
      end))
    end })

  local function rangeOf(ctx, module, cfg, baseKey, maxKey, costKey)
    local level = ctx.level(module)
    local base, max = cfg[baseKey], cfg[maxKey]
    local range
    if max <= base or level <= 0 then range = base
    else range = base + math.ceil((1 - 0.5 ^ level) * (max - base)) end
    return range, level * cfg[costKey]
  end

  spec({ name = "sense", doc = "function():table -- Scan for entities in the vicinity", modules = { SENSOR }, sub = "location", world = true,
    fn = function(ctx)
      ctx.check()
      local loc = ctx.location()
      local range, cost = rangeOf(ctx, SENSOR, CFG.sensor, "radius", "maxRadius", "senseLevelCost")
      return costAwait(ctx.cost, cost, function()
        local box = { loc.bx - range, loc.by - range, loc.bz - range, loc.bx + range, loc.by + range, loc.bz + range }
        local out = {}
        for _, e in ipairs(allEntities()) do
          if (e.dimension or "minecraft:overworld") == loc.dimension and predicate(e) then
            local b = bbox(e)
            if box[1] < b[4] and box[4] > b[1] and box[2] < b[5] and box[5] > b[2] and box[3] < b[6] and box[6] > b[3] then
              out[#out + 1] = basicProperties(e, loc)
            end
          end
        end
        return R(out)
      end, true)
    end })

  local function inRange(ctx, e, range)
    local loc = ctx.location()
    if (e.dimension or "minecraft:overworld") ~= loc.dimension or not predicate(e) then return false end
    local box = { loc.bx - range, loc.by - range, loc.bz - range, loc.bx + range, loc.by + range, loc.bz + range }
    local b = bbox(e)
    return box[1] < b[4] and box[4] > b[1] and box[2] < b[5] and box[5] > b[2] and box[3] < b[6] and box[6] > b[3]
  end

  --- UUID.fromString, then its canonical form (or nil when Java would throw IllegalArgumentException)
  local function parseUuid(s)
    if #s > 36 then return nil end
    local parts = {}
    for part in (s .. "-"):gmatch("([^-]*)-") do parts[#parts + 1] = part end
    if #parts ~= 5 then return nil end
    local widths = { 8, 4, 4, 4, 12 }
    local out = {}
    for i, part in ipairs(parts) do
      if part == "" or not part:match("^[0-9a-fA-F]+$") or #part > 16 then return nil end
      local p = part:lower():gsub("^0+", "")
      if #p > widths[i] then p = p:sub(#p - widths[i] + 1) end -- the long is masked to its width
      out[i] = string.rep("0", widths[i] - #p) .. p
    end
    return table.concat(out, "-")
  end

  spec({ name = "getMetaByID", doc = "function(id:string):table|nil -- Find a nearby entity by UUID", modules = { SENSOR }, sub = "location", world = true,
    fn = function(ctx, a)
      ctx.check()
      local range = rangeOf(ctx, SENSOR, CFG.sensor, "radius", "maxRadius", "senseLevelCost")
      local uuid = parseUuid(A.string(a, 0))
      if not uuid then J.lua("Invalid UUID") end
      for _, e in ipairs(allEntities()) do
        if e.uuid:lower() == uuid and inRange(ctx, e, range) then return R(entityMeta(e, ctx.location(), ctx.ex)) end
      end
      return R()
    end })
  spec({ name = "getMetaByName", doc = "function(name:string):table|nil -- Find a nearby entity by name", modules = { SENSOR }, sub = "location", world = true,
    fn = function(ctx, a)
      local ok, res = pcall(function()
        ctx.check()
        local range = rangeOf(ctx, SENSOR, CFG.sensor, "radius", "maxRadius", "senseLevelCost")
        local name = A.string(a, 0)
        for _, e in ipairs(allEntities()) do
          if inRange(ctx, e, range) and (entityName(e) == name or e.type == name) then
            return R(entityMeta(e, ctx.location(), ctx.ex))
          end
        end
        return R()
      end)
      -- every exception, LuaExceptions too, becomes this one (the catch (e: Exception) in getMetaByName)
      if not ok then J.lua("Unknown error in getMetaByName") end
      return res
    end })

  spec({ name = "scan", doc = "function():table -- Scan all blocks in the vicinity", modules = { SCANNER }, sub = "location", world = true,
    fn = function(ctx)
      ctx.check()
      local loc = ctx.location()
      local range, cost = rangeOf(ctx, SCANNER, CFG.scanner, "radius", "maxRadius", "scanLevelCost")
      local x, y, z = loc.bx, loc.by, loc.bz
      return costAwait(ctx.cost, cost, function()
        local out = {}
        for ox = x - range, x + range do
          for oy = y - range, y + range do
            for oz = z - range, z + range do
              local b = blockAt(ctx.def, ox, oy, oz)
              out[#out + 1] = { x = ox - x, y = oy - y, z = oz - z, name = b and b.name or "minecraft:air", state = stateTable(b) }
            end
          end
        end
        return R(out)
      end, true)
    end })
  spec({ name = "getBlockMeta", doc = "function(x:integer, y:integer, z:integer):table|nil -- -- Get metadata about a nearby block", modules = { SCANNER }, sub = "location", world = true,
    fn = function(ctx, a)
      ctx.check()
      local range = rangeOf(ctx, SCANNER, CFG.scanner, "radius", "maxRadius", "scanLevelCost")
      local x = intBetween(a, 0, -range, range, "X coordinate out of bounds (%s)")
      local y = intBetween(a, 1, -range, range, "Y coordinate out of bounds (%s)")
      local z = intBetween(a, 2, -range, range, "Z coordinate out of bounds (%s)")
      local loc = ctx.location()
      return R(blockMeta(blockAt(ctx.def, loc.bx + x, loc.by + y, loc.bz + z)))
    end })

  spec({ name = "canvas", doc = "function():table -- Get the 2D canvas for these glasses.", modules = { GLASSES }, sub = "canvas", world = false,
    fn = function(ctx)
      local msg = ctx.check(true)
      return R(ctx.canvas.canvas2d())
    end })
  spec({ name = "canvas3d", doc = "function():table -- Get the 3D canvas for these glasses.", modules = { GLASSES }, sub = "canvas", world = false,
    fn = function(ctx)
      ctx.check(true)
      return R(ctx.canvas.canvas3d())
    end })

  -- ===== hosts: the neural interface, the manipulator and the turtle upgrades =====

  local instances = {} -- peripheral name -> live instance

  --- The modules of a fixture: "plethora:scanner" or { id, level, bound }.
  local function readModules(list)
    local out = {}
    for _, m in ipairs(list or {}) do
      if type(m) == "string" then m = { id = m } end
      local id = m.id or m.name
      if type(id) == "string" then
        if not id:find(":", 1, true) then id = "plethora:" .. id end
        out[#out + 1] = { id = id, level = tonumber(m.level) or 0, bound = m.bound }
      end
    end
    return out
  end

  --- Build one peripheral. kind: "neural" (worn by a player), "manipulator" (a block), "turtle" (one upgrade).
  local function build(def, kind)
    local name = def.name
    local mods = readModules(def.modules)
    if kind == "turtle" then mods = { { id = def.type, level = tonumber(def.level) or 0 } } end
    -- NeuralHelpers.MODULE_SIZE is 5; a Mark I manipulator has one slot, a Mark II five (ManipulatorType)
    local slots = kind == "neural" and 5 or (kind == "manipulator" and (tonumber(def.mark) == 2 and 5 or 1)) or 1
    while #mods > slots do table.remove(mods) end
    if #mods == 0 then
      error("ccsim: a " .. def.type .. " with no modules is not a peripheral at all (" .. tostring(name) .. "): leave it out", 0)
    end
    local ids = {}
    for _, m in ipairs(mods) do ids[#ids + 1] = m.id end
    local list
    if kind == "neural" then list = hashSetOrder(ids) -- a HashSet
    else
      list = {}
      local seen = {}
      for _, id in ipairs(ids) do if not seen[id] then seen[id] = true list[#list + 1] = id end end -- LinkedHashSet
    end
    local set = {}
    for _, id in ipairs(list) do set[id] = true end

    local inst = { name = name, def = def, kind = kind, modules = { list = list, set = set }, attached = true }
    instances[name] = inst

    local ownerPlayer
    if kind == "neural" then
      ownerPlayer = def.owner and findPlayer(def.owner) or (core.players or {})[1]
      if not ownerPlayer then error("ccsim: a neuralInterface needs a player in world.players to wear it", 0) end
      inst.owner = ownerPlayer.uuid
      neuralWorn[ownerPlayer.uuid] = true
    end

    -- the context every method of this peripheral bakes
    local ctx = { host = inst, modules = inst.modules, def = def }
    local taskIds = 0
    ctx.ex = {
      attached = function()
        if not inst.attached then return "Peripheral '" .. name .. "' is no longer attached" end
        return nil
      end,
      nextId = function() taskIds = taskIds + 1 return taskIds end,
    }
    inst.ex = ctx.ex

    local function owner()
      if kind ~= "neural" then return nil end
      local p = core.findPlayer(inst.owner)
      return p and playerEntity(p) or nil
    end
    --- IReference.get / safeGet of the module container. `safe`: safeGet ("A module has changed").
    function ctx.check(safe)
      if inst.replacedBy then
        if safe or not inst.removed then J.lua("A module has changed") end
        J.lua("The " .. inst.removed .. " module has been removed")
      end
      if kind == "manipulator" and inst.gone then J.lua("Manipulator is no longer there") end
    end

    function ctx.location()
      if kind == "neural" then
        local e = owner()
        local x, y, z = eyePos(e)
        return { x = x, y = y, z = z, bx = floor(x), by = floor(y), bz = floor(z), dimension = e.dimension or "minecraft:overworld" }
      end
      local bx, by, bz
      if kind == "turtle" and core.position then
        bx, by, bz = core.position.x, core.position.y, core.position.z
      else
        bx, by, bz = floor(def.x or 0), floor(def.y or 64), floor(def.z or 0)
      end
      local dim = (core.position and core.position.dimension) or def.dimension or "minecraft:overworld"
      return { x = bx + 0.5, y = by + 0.5, z = bz + 0.5, bx = bx, by = by, bz = bz, dimension = dim }
    end
    function ctx.originEntity() return owner() end
    function ctx.originLiving() return owner() end

    --- The module's stack: its level and binding
    local byId = {}
    for _, m in ipairs(mods) do byId[m.id] = m end -- with two of one module the later slot counts
    function ctx.level(module) return byId[module] and byId[module].level or 0 end

    --- EntityIdentifier from the origin (the wearer) or a bound module: { uuid, name, player = true|nil }
    function ctx.identifier(module)
      local e = owner()
      if e then return { uuid = e.uuid, name = e.player.name, player = true } end
      local m = byId[module]
      if m and m.bound then
        local p = findPlayer(m.bound)
        if p then return { uuid = p.uuid, name = p.name, player = true } end
        local b = type(m.bound) == "table" and m.bound or { name = tostring(m.bound) }
        return { uuid = b.uuid or "00000000-0000-0000-0000-000000000000", name = b.name, player = true }
      end
      return nil
    end
    function ctx.living(module)
      local e = owner()
      if e then return e end
      local m = byId[module]
      if m and m.bound then
        local p = findPlayer(m.bound)
        if p and p.online then return playerEntity(p) end
      end
      return nil
    end

    if set[GLASSES] and kind == "neural" then
      -- GlassesModuleItem: a canvas only for a real player
      ctx.canvas = Canvas.server({
        ex = ctx.ex,
        stale = function()
          if inst.replacedBy then return "A module has changed" end
          return nil
        end,
        origin = function()
          local loc = ctx.location()
          return loc.x, loc.y, loc.z
        end,
        dimension = function() return ctx.location().dimension end,
      })
      inst.canvas = ctx.canvas
    end

    local costKey = kind == "neural" and ("player:" .. inst.owner) or (kind == "turtle" and "turtle" or ("block:" .. name))
    ctx.cost = costHandler(costKey)

    --- Can this method be had here (SubtargetedModuleMethod.canApply)?
    local function canApply(s, modules)
      for _, m in ipairs(s.modules or {}) do if not modules[m] then return false end end
      if not s.sub then return true end
      if s.sub == "location" then return true end
      if s.sub == "canvas" then return ctx.canvas ~= nil end
      for _, m in ipairs(s.modules) do
        if s.sub == "living" then
          if ctx.living(m) then return true end
        elseif ctx.identifier(m) then
          return true
        end
      end
      return false
    end

    --- The methods for these modules, in MethodRegistry.getMethodsPaired order, getDocs last.
    local function methodsFor(modules)
      local out, seen = {}, {}
      for _, s in ipairs(SPECS) do
        if not seen[s.name] and canApply(s, modules) then
          seen[s.name] = true
          out[#out + 1] = s
        end
      end
      return out
    end

    local function apply(s, args)
      if s.world then return nextTick(function() return s.fn(ctx, args) end) end
      return s.fn(ctx, args)
    end

    local function docsOf(list)
      local docs = {}
      for _, s in ipairs(list) do docs[s.name] = s.doc end
      docs.getDocs = GET_DOCS_DOC
      return docs
    end
    local function getDocsApply(docs)
      return function(args)
        return nextTick(function()
          ctx.check()
          local n = A.optString(args, 0, nil)
          if n == nil then return R(host.copy(docs)) end
          if docs[n] == nil then J.lua("No such method") end
          return R(docs[n])
        end)
      end
    end

    --- filterModules' object: the methods of these modules only
    function ctx.childObject(ids)
      local sub = {}
      for _, id in ipairs(ids) do sub[id] = true end
      local list = methodsFor(sub)
      local obj = {}
      for _, s in ipairs(list) do
        local childCtx = setmetatable({ modules = { list = ids, set = sub } }, { __index = ctx })
        obj[s.name] = objectFunction(function(args)
          if s.world then return nextTick(function() return s.fn(childCtx, args) end) end
          return s.fn(childCtx, args)
        end, ctx.ex)
      end
      obj.getDocs = objectFunction(getDocsApply(docsOf(list)), ctx.ex)
      return obj
    end

    local list2 = methodsFor(set)
    local methods, order = {}, {}
    for _, s in ipairs(list2) do
      order[#order + 1] = s.name
      methods[s.name] = function(...)
        local args = table.pack(...)
        local ok, res = pcall(function() return execute(apply(s, args), ctx.ex) end)
        if not ok then error(luaError(res), 0) end
        return table.unpack(res, 1, res.n)
      end
    end
    order[#order + 1] = "getDocs"
    local getDocs = getDocsApply(docsOf(list2))
    methods.getDocs = function(...)
      local args = table.pack(...)
      local ok, res = pcall(function() return execute(getDocs(args), ctx.ex) end)
      if not ok then error(luaError(res), 0) end
      return table.unpack(res, 1, res.n)
    end
    local computerThread = {}
    for n in pairs(methods) do computerThread[n] = true end -- each method does its own waiting (plethora_task)

    local peripheralType = ({ neural = "neuralInterface", manipulator = "manipulator" })[kind] or def.type
    local p = {
      methods = methods, methodOrder = order, computerThread = computerThread, exactReturns = true,
      types = { peripheralType },
    }
    function p.detach()
      inst.attached = false
      if kind == "neural" and inst.owner then neuralWorn[inst.owner] = nil end
    end
    function p.state()
      local s = { modules = host.copy(list), energy = (function() regen(ctx.cost) return ctx.cost.value end)() }
      if inst.canvas then s.canvas = inst.canvas.state() end
      return s
    end
    inst.peripheral = p
    return p
  end

  -- ===== the redstone integrator (RedstoneIntegratorPeripheral) =====

  local DIRS = { "down", "up", "north", "south", "west", "east" } -- Direction.entries
  local DIR_INDEX = { down = 1, up = 2, north = 3, south = 4, west = 5, east = 6 }
  local integrators = {}

  local function newIntegrator(def)
    local name = def.name
    local io = { inputs = {}, outputs = {}, bundledInputs = {}, bundledOutputs = {} }
    for i = 1, 6 do io.inputs[i], io.outputs[i], io.bundledInputs[i], io.bundledOutputs[i] = 0, 0, 0, 0 end
    for side, v in pairs(def.inputs or {}) do local i = DIR_INDEX[side] if i then io.inputs[i] = v end end
    for side, v in pairs(def.bundledInputs or {}) do local i = DIR_INDEX[side] if i then io.bundledInputs[i] = v end end
    integrators[name] = io
    local function side(a, i)
      local value = A.string(a, i):lower()
      if value == "bottom" then return 1 end
      if value == "top" then return 2 end
      local idx = DIR_INDEX[value]
      if not idx then J.lua("Bad name '" .. value .. "' for argument " .. (i + 1)) end
      return idx
    end
    local function luaFn(fn)
      return function(...)
        local a = table.pack(...)
        local res = table.pack(pcall(fn, a))
        if not res[1] then error(luaError(res[2]), 0) end
        core.touch()
        return table.unpack(res, 2, res.n)
      end
    end
    local m = {}
    m.getSides = luaFn(function()
      return { "DOWN", "UP", "NORTH", "SOUTH", "WEST", "EAST" }
    end)
    m.setOutput = luaFn(function(a)
      local s = side(a, 0)
      io.outputs[s] = A.bool(a, 1) and 15 or 0
      core.dirty = true
    end)
    m.getOutput = luaFn(function(a) return io.outputs[side(a, 0)] > 0 end)
    m.getInput = luaFn(function(a) return io.inputs[side(a, 0)] > 0 end)
    m.setBundledOutput = luaFn(function(a)
      local s = side(a, 0)
      io.bundledOutputs[s] = A.int(a, 1)
      core.dirty = true
    end)
    m.getBundledOutput = luaFn(function(a) return io.bundledOutputs[side(a, 0)] end)
    m.getBundledInput = luaFn(function(a) return io.bundledInputs[side(a, 0)] end)
    m.testBundledInput = luaFn(function(a)
      local s = side(a, 0)
      local power = A.int(a, 1)
      return i32(band(io.bundledInputs[s] % TWO32, power % TWO32)) == power
    end)
    local function setAnalog(a)
      local s = side(a, 0)
      io.outputs[s] = intBetween(a, 1, 0, 15, "Power out of range (%s)")
      core.dirty = true
    end
    m.setAnalogOutput, m.setAnalogueOutput = luaFn(setAnalog), luaFn(setAnalog)
    local function getAnalogOut(a) return io.outputs[side(a, 0)] end
    m.getAnalogOutput, m.getAnalogueOutput = luaFn(getAnalogOut), luaFn(getAnalogOut)
    local function getAnalogIn(a) return io.inputs[side(a, 0)] end
    m.getAnalogInput, m.getAnalogueInput = luaFn(getAnalogIn), luaFn(getAnalogIn)
    local ct = {}
    for k in pairs(m) do ct[k] = true end
    local p = { methods = m, computerThread = ct, exactReturns = true, types = { "redstone_integrator" } }
    function p.state()
      local out = { outputs = {}, bundledOutputs = {}, inputs = {}, bundledInputs = {} }
      for i, d in ipairs(DIRS) do
        out.outputs[d], out.bundledOutputs[d] = io.outputs[i], io.bundledOutputs[i]
        out.inputs[d], out.bundledInputs[d] = io.inputs[i], io.bundledInputs[i]
      end
      return out
    end
    function p.detach() integrators[name] = nil end
    return p
  end

  -- ===== lasers in flight (LaserEntity.tick) =====

  local function solid(def, x, y, z)
    local b = blockAt(def, x, y, z)
    if not b or AIR[b.name] then return nil end
    if V.noCollision[b.name] then return nil end
    return b
  end

  --- AABB.getDirection / clipPoint: the nearest face of `box` the segment enters, as the game works it out.
  local function clipPoint(minD, prev, dS, dA, dB, minSide, minA, maxA, minB, maxB, side, sS, sA, sB)
    local d0 = (minSide - sS) / dS
    local d1 = sA + d0 * dA
    local d2 = sB + d0 * dB
    if 0 < d0 and d0 < minD[1] and minA - 1.0E-7 < d1 and d1 < maxA + 1.0E-7 and minB - 1.0E-7 < d2 and d2 < maxB + 1.0E-7 then
      minD[1] = d0
      return side
    end
    return prev
  end
  local function boxDirection(b, sx, sy, sz, minD, facing, dx, dy, dz)
    if dx > 1.0E-7 then facing = clipPoint(minD, facing, dx, dy, dz, b[1], b[2], b[5], b[3], b[6], "west", sx, sy, sz)
    elseif dx < -1.0E-7 then facing = clipPoint(minD, facing, dx, dy, dz, b[4], b[2], b[5], b[3], b[6], "east", sx, sy, sz) end
    if dy > 1.0E-7 then facing = clipPoint(minD, facing, dy, dz, dx, b[2], b[3], b[6], b[1], b[4], "down", sy, sz, sx)
    elseif dy < -1.0E-7 then facing = clipPoint(minD, facing, dy, dz, dx, b[5], b[3], b[6], b[1], b[4], "up", sy, sz, sx) end
    if dz > 1.0E-7 then facing = clipPoint(minD, facing, dz, dx, dy, b[3], b[1], b[4], b[2], b[5], "north", sz, sx, sy)
    elseif dz < -1.0E-7 then facing = clipPoint(minD, facing, dz, dx, dy, b[6], b[1], b[4], b[2], b[5], "south", sz, sx, sy) end
    return facing
  end
  --- Direction.getFacing(x, y, z): the axis the vector points along most
  local function nearestDir(x, y, z)
    local best, dir = -huge, "north"
    local cands = { { "down", 0, -1, 0 }, { "up", 0, 1, 0 }, { "north", 0, 0, -1 }, { "south", 0, 0, 1 }, { "west", -1, 0, 0 }, { "east", 1, 0, 0 } }
    for _, c in ipairs(cands) do
      local d = x * c[2] + y * c[3] + z * c[4]
      if d > best then best, dir = d, c[1] end
    end
    return dir
  end
  local OPPOSITE = { down = "up", up = "down", north = "south", south = "north", west = "east", east = "west" }

  --- VoxelShape.raycast of a full cube at a block: nil, or the hit point and the side.
  local function clipCube(fx, fy, fz, tx, ty, tz, bx, by, bz)
    local dx, dy, dz = tx - fx, ty - fy, tz - fz
    if dx * dx + dy * dy + dz * dz < 1.0E-7 then return nil end
    local ix, iy, iz = fx + dx * 0.001, fy + dy * 0.001, fz + dz * 0.001
    local lx, ly, lz = ix - bx, iy - by, iz - bz
    if lx >= 0 and lx < 1 and ly >= 0 and ly < 1 and lz >= 0 and lz < 1 then
      return ix, iy, iz, OPPOSITE[nearestDir(dx, dy, dz)]
    end
    local minD = { 1.0 }
    local dir = boxDirection({ bx, by, bz, bx + 1, by + 1, bz + 1 }, fx, fy, fz, minD, nil, dx, dy, dz)
    if not dir then return nil end
    local t = minD[1]
    return fx + t * dx, fy + t * dy, fz + t * dz, dir
  end

  --- BlockView.raycast (COLLIDER, no fluids): the first block a segment hits, the way BlockGetter.traverseBlocks walks.
  local function raycast(def, fx, fy, fz, tx, ty, tz)
    if fx == tx and fy == ty and fz == tz then return nil end
    local function lerp(t, a, b) return a + t * (b - a) end
    local function frac(v) return v - floor(v) end
    local function sign(v) if v == 0 then return 0 elseif v > 0 then return 1 end return -1 end
    local d0, d1, d2 = lerp(-1.0E-7, tx, fx), lerp(-1.0E-7, ty, fy), lerp(-1.0E-7, tz, fz)
    local d3, d4, d5 = lerp(-1.0E-7, fx, tx), lerp(-1.0E-7, fy, ty), lerp(-1.0E-7, fz, tz)
    local i, j, k = floor(d3), floor(d4), floor(d5)
    local function test(x, y, z)
      if not solid(def, x, y, z) then return nil end
      local hx, hy, hz, side = clipCube(fx, fy, fz, tx, ty, tz, x, y, z)
      if hx then return { x = hx, y = hy, z = hz, side = side, bx = x, by = y, bz = z } end
      return nil
    end
    local hit = test(i, j, k)
    if hit then return hit end
    local d6, d7, d8 = d0 - d3, d1 - d4, d2 - d5
    local l, i1, j1 = sign(d6), sign(d7), sign(d8)
    local MAX = 1.7976931348623157e308
    local d9 = l == 0 and MAX or l / d6
    local d10 = i1 == 0 and MAX or i1 / d7
    local d11 = j1 == 0 and MAX or j1 / d8
    local d12 = d9 * (l > 0 and 1.0 - frac(d3) or frac(d3))
    local d13 = d10 * (i1 > 0 and 1.0 - frac(d4) or frac(d4))
    local d14 = d11 * (j1 > 0 and 1.0 - frac(d5) or frac(d5))
    while d12 <= 1.0 or d13 <= 1.0 or d14 <= 1.0 do
      if d12 < d13 then
        if d12 < d14 then i = i + l d12 = d12 + d9 else k = k + j1 d14 = d14 + d11 end
      elseif d13 < d14 then j = j + i1 d13 = d13 + d10
      else k = k + j1 d14 = d14 + d11 end
      hit = test(i, j, k)
      if hit then return hit end
    end
    return nil
  end

  --- Box.raycast(from, to): where the segment enters the box, or nil (also when it starts inside).
  local function boxRaycast(b, fx, fy, fz, tx, ty, tz)
    local minD = { 1.0 }
    local dx, dy, dz = tx - fx, ty - fy, tz - fz
    local dir = boxDirection(b, fx, fy, fz, minD, nil, dx, dy, dz)
    if not dir then return nil end
    local t = minD[1]
    return fx + t * dx, fy + t * dy, fz + t * dz
  end

  local function breakBlock(L, x, y, z, b)
    setBlock(L.def, x, y, z, nil)
    if L.creative then return end
    if data().blockHasTag(b.name, "minecraft:tall_flowers") then return end -- plethora:laser_dont_drop
    local drops = loot().drops(b, nil, function(ax, ay, az) return blockAt(L.def, ax, ay, az) end) or {}
    for _, stack in ipairs(drops) do
      -- Block.dropStack: a dropped item near the block's centre
      addEntity({ type = "minecraft:item", item = stack, x = x + 0.5, y = y + 0.25, z = z + 0.5, dimension = L.dimension, living = false })
    end
  end

  local function onImpact(L, hit)
    if hit.entity then
      local e = hit.entity
      if not e.living then return end
      local tagged = ({ ["minecraft:blaze"] = true, ["minecraft:magma_cube"] = true, ["minecraft:zombified_piglin"] = true })[e.type]
      local amount = f32(L.potency * CFG.laser.damage)
      local target = e.isPlayer and e.player or e
      if tagged then
        -- plethora:lasers_provide_energy: heal and strengthen instead
        target.health = math.min(e.maxHealth or 20, (e.health or 20) + amount)
      elseif not (e.isPlayer and (e.def.gameMode == "creative" or e.def.gameMode == "spectator")) then
        target.health = (e.health or 20) - amount
        if target.health <= 0 then
          target.health = 0
          if not e.isPlayer then e.alive = false end
        end
      end
      L.potency = -1
      return
    end
    local bx, by, bz = floor(hit.x), floor(hit.y), floor(hit.z) -- BlockPos.ofFloored(collision.pos)
    local b = blockAt(L.def, bx, by, bz)
    if not b or AIR[b.name] then return end
    if b.name == "minecraft:water" or b.name == "minecraft:lava" then return end
    local hardness = hardnessOf(b)
    if hardness == nil then
      -- a modded block with no `hardness` in the fixture: the emulator cannot know, so the laser stops here
      L.potency = -1
      return
    end
    if b.name == "minecraft:tnt" then
      L.potency = f32(L.potency - hardness)
      setBlock(L.def, bx, by, bz, nil) -- primed: the TNT entity itself is not emulated
    elseif b.name == "minecraft:obsidian" then
      L.potency = f32(L.potency - hardness)
      local step = ({ down = { 0, -1, 0 }, up = { 0, 1, 0 }, north = { 0, 0, -1 }, south = { 0, 0, 1 }, west = { -1, 0, 0 }, east = { 1, 0, 0 } })[hit.side]
      local ox, oy, oz = bx + step[1], by + step[2], bz + step[3]
      local there = blockAt(L.def, ox, oy, oz)
      if not there or AIR[there.name] then
        local w = blockWorld(L.def)
        if w then w.set(ox, oy, oz, w.newBlock({ name = "minecraft:fire" })) end
      end
    elseif hardness > -1 and hardness <= L.potency then
      L.potency = f32(L.potency - hardness)
      if hardness >= 0 then breakBlock(L, bx, by, bz, b) end
    else
      L.potency = -1
    end
  end

  local function laserStep(L)
    L.age = L.age + 1
    local remaining, ticks = 1.0, 5
    while remaining >= 0.01 and L.potency > 0 do
      ticks = ticks - 1
      if ticks < 0 then break end
      local px, py, pz = L.x, L.y, L.z
      local vx, vy, vz = L.vx, L.vy, L.vz
      local nx, ny, nz = px + vx * remaining, py + vy * remaining, pz + vz * remaining
      local collision = raycast(L.def, px, py, pz, nx, ny, nz)
      if collision then nx, ny, nz = collision.x, collision.y, collision.z end
      -- entities near where the laser ends up this step
      local lb = { px - 0.125 + vx * remaining - 1, py + vy * remaining - 1, pz - 0.125 + vz * remaining - 1,
        px + 0.125 + vx * remaining + 1, py + 0.25 + vy * remaining + 1, pz + 0.125 + vz * remaining + 1 }
      local closestD = (nx - px) ^ 2 + (ny - py) ^ 2 + (nz - pz) ^ 2
      local closest
      for _, e in ipairs(allEntities()) do
        if e.alive and e.living and (e.dimension or "minecraft:overworld") == L.dimension and (e.uuid ~= L.shooter or L.age >= 5) then
          local b = bbox(e)
          if lb[1] < b[4] and lb[4] > b[1] and lb[2] < b[5] and lb[5] > b[2] and lb[3] < b[6] and lb[6] > b[3] then
            local eb = { b[1] - 0.3, b[2] - 0.3, b[3] - 0.3, b[4] + 0.3, b[5] + 0.3, b[6] + 0.3 }
            local hx, hy, hz = boxRaycast(eb, px, py, pz, nx, ny, nz)
            if hx then
              local d = (hx - px) ^ 2 + (hy - py) ^ 2 + (hz - pz) ^ 2
              if d < closestD then closest, closestD, nx, ny, nz = e, d, hx, hy, hz end
            end
          end
        end
      end
      if closest then collision = { entity = closest } end
      local dist = sqrt((nx - px) ^ 2 + (ny - py) ^ 2 + (nz - pz) ^ 2)
      remaining = remaining - dist / sqrt(vx * vx + vy * vy + vz * vz)
      L.x, L.y, L.z = nx, ny, nz
      if collision then onImpact(L, collision) end
    end
    return L.potency <= 0 or L.age > CFG.laser.lifetime
  end

  local function catchUp()
    local now = currentTick()
    while laserTick < now do
      laserTick = laserTick + 1
      if #lasers == 0 then laserTick = now break end
      local keep = {}
      for _, L in ipairs(lasers) do
        if not laserStep(L) then keep[#keep + 1] = L end
      end
      lasers = keep
      core.dirty = true
    end
  end

  -- ===== turtle upgrades (TurtleUpgradeProvider: laser, scanner, sensor, introspection) =====

  core.turtleUpgrades = core.turtleUpgrades or {}
  for _, m in ipairs({ "laser", "scanner", "sensor", "introspection" }) do
    core.turtleUpgrades["plethora:module_" .. m] = { peripheral = "plethora:" .. m }
  end

  -- ===== sim commands =====

  local handlers = {}
  local function findDef(name)
    local inst = instances[name]
    return inst
  end

  --- Swap a neural interface's or manipulator's modules: the peripheral is rebuilt, like the real one when a slot
  --- changes (detached, then attached again; objects from the old one fail).
  function handlers.plethoraSetModules(cmd)
    local inst = findDef(cmd.peripheral)
    if not inst then return false, "no such Plethora peripheral" end
    local def = inst.def
    local old = readModules(def.modules)
    local new = readModules(cmd.modules)
    -- the first slot whose module is gone or changed (the container reference's get())
    for i, m in ipairs(old) do
      local n = new[i]
      if not n or n.id ~= m.id then inst.removed = m.id break end
    end
    local copy = {}
    for k, v in pairs(def) do copy[k] = v end
    copy.modules = cmd.modules
    inst.replacedBy = true
    core.detachSide(def.name)
    -- no modules left: no peripheral (buildModules returns null)
    if #new > 0 then core.attachSide(copy) end
    return true
  end

  local function entityFor(cmd)
    for _, e in ipairs(entities) do
      if e.uuid == cmd.uuid or (cmd.entity and (e.uuid == cmd.entity or e.def.id == cmd.entity)) then return e end
    end
    return nil
  end

  function handlers.plethoraAddEntity(cmd)
    local def = cmd.entity or cmd
    local copy = {}
    for k, v in pairs(def) do if k ~= "cmd" then copy[k] = v end end
    local e = addEntity(copy)
    core.dirty = true
    return true, e.uuid
  end
  function handlers.plethoraMoveEntity(cmd)
    local e = entityFor(cmd)
    if not e then return false, "no such entity" end
    for _, k in ipairs({ "x", "y", "z" }) do if cmd[k] ~= nil then e[k] = cmd[k] end end
    if cmd.yaw ~= nil then e.yaw = f32(cmd.yaw) end
    if cmd.pitch ~= nil then e.pitch = f32(cmd.pitch) end
    if cmd.health ~= nil then e.health = cmd.health end
    core.dirty = true
    return true
  end
  function handlers.plethoraRemoveEntity(cmd)
    for i, e in ipairs(entities) do
      if e.uuid == cmd.uuid or e.uuid == cmd.entity then table.remove(entities, i) core.dirty = true return true end
    end
    return false, "no such entity"
  end
  function handlers.plethoraSetPlayer(cmd)
    local p = findPlayer(cmd.player)
    if not p then return false, "unknown player" end
    local x = playerExtra(p)
    if cmd.food ~= nil then x.food = cmd.food end
    if cmd.saturation ~= nil then x.saturation = cmd.saturation end
    if cmd.heldItemSlot ~= nil then x.heldItemSlot = cmd.heldItemSlot end
    if cmd.health ~= nil then p.health = cmd.health end
    if cmd.slot ~= nil then
      local items = (cmd.ender and x.ender or x.main).__state()
      items[tonumber(cmd.slot)] = cmd.item ~= nil and cmd.item or nil
      if cmd.item == false then items[tonumber(cmd.slot)] = nil end
    end
    for _, slot in ipairs({ "feet", "legs", "chest", "head" }) do
      if cmd[slot] ~= nil then x.armor[slot] = cmd[slot] ~= false and cmd[slot] or nil end
    end
    if cmd.offhand ~= nil then x.offhand = cmd.offhand ~= false and cmd.offhand or nil end
    for _, k in ipairs({ "sneaking", "sprinting", "gameMode", "potionEffects", "motion", "onGround" }) do
      if cmd[k] ~= nil then x.def[k] = cmd[k] end
    end
    core.dirty = true
    return true
  end
  function handlers.plethoraSetRedstoneInput(cmd)
    local io = integrators[cmd.peripheral]
    if not io then return false, "no such redstone_integrator" end
    local i = DIR_INDEX[tostring(cmd.side):lower()]
    if not i then return false, "bad side" end
    local changed = false
    if cmd.level ~= nil and io.inputs[i] ~= cmd.level then io.inputs[i] = cmd.level changed = true end
    if cmd.bundled ~= nil and io.bundledInputs[i] ~= cmd.bundled then io.bundledInputs[i] = cmd.bundled changed = true end
    -- RedstoneIntegratorBlockEntity: an input change queues "redstone" (with this peripheral's name) on the next tick
    if changed then os.queueEvent("redstone", cmd.peripheral) end
    core.dirty = true
    return true
  end
  function handlers.plethoraSetEnergy(cmd)
    local inst = instances[cmd.peripheral]
    if not inst then return false, "no such Plethora peripheral" end
    local key = inst.kind == "neural" and ("player:" .. inst.owner) or (inst.kind == "turtle" and "turtle" or ("block:" .. inst.name))
    local h = costHandler(key)
    regen(h)
    h.value = cmd.energy
    return true
  end

  -- ===== the module =====

  local M = {}
  M.handlers = handlers
  M.catchUp = catchUp
  function M.peripheral(def)
    local ty = def.type
    if ty == "neuralInterface" then return build(def, "neural") end
    if ty == "manipulator" then return build(def, "manipulator") end
    if ty == "redstone_integrator" then return newIntegrator(def) end
    return build(def, "turtle")
  end
  function M.state()
    local out = { gameTime = currentTick() }
    local ls = {}
    for _, L in ipairs(lasers) do
      ls[#ls + 1] = { x = L.x, y = L.y, z = L.z, potency = L.potency, age = L.age }
    end
    out.lasers = ls
    out.launches = launches
    local es = {}
    for _, e in ipairs(entities) do
      es[#es + 1] = { uuid = e.uuid, type = e.type, x = e.x, y = e.y, z = e.z, yaw = e.yaw, pitch = e.pitch,
        health = e.health, alive = e.alive, item = e.def.item }
    end
    out.entities = es
    local ps = {}
    for uuid, x in pairs(LOOKUP) do
      ps[uuid] = { inventory = x.main.__state(), ender = x.ender.__state(), armor = x.armor, offhand = x.offhand,
        food = x.food, saturation = x.saturation, heldItemSlot = x.heldItemSlot }
    end
    out.players = ps
    return out
  end
  return M
end
