-- ccsim cc-vs: CC: VS, the ComputerCraft x Valkyrien Skies addon. It adds global APIs, not peripherals.
--
-- 1.18.2: CC: VS 0.5.1 (cc_vs-1.18.2-forge-0.5.1.jar), TechTastic/CC-VS branch 1.18.x/archived at 7a65541 (the
--   commits after it change only the changelog and version). `ship` only, added by a mixin on TileComputer /
--   TileTurtle.createComputer when the computer is on a ship (CCVSUtils.applyShipAPIsToComputer).
-- 1.20.1: CC: VS 0.6.6 (cc_vs-1.20.1-forge-0.6.6.jar), branch 1.20.x/main at e0fd0de. `ship`, `aerodynamics`/`aero`
--   and `drag`, registered with ComputerCraftAPI.registerAPIFactory, so every computer has them; off a ship the
--   ship-bound methods throw.
-- Kotlin, relative to common/src/main/kotlin/io/github/techtastic/cc_vs/: apis/{ShipAPI,AerodynamicsAPI,DragAPI,
-- LuaPhysShip}.kt, util/CCVSUtils.kt, ship/QueuedForcesApplier.kt (1.18.2), forge/config/CCVSConfig.kt. Every method
-- list was checked against the jars with javap. The mod's own Lua wrappers (rom/apis/ship.lua, aero.lua, drag.lua)
-- and CC: Advanced Math (matrix.lua, quaternion.lua), which the jars put in the ROM, are in rom-<version>/apis/,
-- unchanged, and are loaded here the way bios.lua's os.loadAPI loads them. docs/cc-vs.md has the rest.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local cfg = type(core.world.ccvs) == "table" and core.world.ccvs or {}
  local NEW = core.version.mc ~= "1.18.2" -- 0.6.6 on 1.20.1; 0.5.1 on 1.18.2
  local conf = type(cfg.config) == "table" and cfg.config or {}
  local function flag(key, default)
    if conf[key] == nil then return default end
    return conf[key] == true
  end
  -- CCVSConfig defaults: can_teleport false, command_only true, expose_phys_tick false
  local CAN_TELEPORT = flag("canTeleport", false)
  local COMMAND_ONLY = flag("commandOnly", true)
  local EXPOSE_PHYS = flag("exposePhysTick", false)
  -- VSCoreConfig.Server.PhysicsThreadSettings.physicsTicksPerGameTick (3 in Valkyrien Skies 2.4.9)
  local PHYS_PER_TICK = math.max(0, math.floor(tonumber(conf.physicsTicksPerGameTick) or 3))
  -- VSCoreConfig.Server.DragSettings.dragCoefficient (2.18 in 2.4.9)
  local DRAG_COEFFICIENT = tonumber(conf.dragCoefficient) or 2.18
  local family = type(core.world.turtle) == "table" and "turtle" or tostring(cfg.family or "normal")
  local native = core.native or function(fn) return fn end
  local queueEvent = os.queueEvent

  local M = {}
  local st = { ship = nil, forces = {}, windImpulses = {}, joints = {}, collisions = {}, physTicks = 0 }

  -- ===== values =====

  local function v3(t, default)
    default = default or 0
    if type(t) == "number" then return { x = t, y = t, z = t } end
    t = type(t) == "table" and t or {}
    return { x = tonumber(t.x or t[1]) or default, y = tonumber(t.y or t[2]) or default, z = tonumber(t.z or t[3]) or default }
  end
  local function quat(t)
    t = type(t) == "table" and t or {}
    return { x = tonumber(t.x or t[1]) or 0, y = tonumber(t.y or t[2]) or 0, z = tonumber(t.z or t[3]) or 0,
      w = tonumber(t.w or t[4]) or 1 }
  end
  local function m3(t)
    local out = {}
    for r = 1, 3 do
      local row = type(t) == "table" and type(t[r]) == "table" and t[r] or {}
      out[r] = { tonumber(row[1]) or 0, tonumber(row[2]) or 0, tonumber(row[3]) or 0 }
    end
    return out
  end
  local function luaV(v) return { x = v.x, y = v.y, z = v.z } end -- Vector3dc.toLua
  local function luaQ(q) return { x = q.x, y = q.y, z = q.z, w = q.w } end -- Quaterniondc.toLua
  local function luaM3(m) -- Matrix3dc.toLua: the rows
    return { { m[1][1], m[1][2], m[1][3] }, { m[2][1], m[2][2], m[2][3] }, { m[3][1], m[3][2], m[3][3] } }
  end

  local function newShip(def)
    local s = {
      id = tonumber(def.id) or 1,
      slug = type(def.slug) == "string" and def.slug or nil,
      mass = tonumber(def.mass) or 1000,
      inertia = m3(def.inertia),
      pos = v3(def.position),
      shipyard = v3(def.shipyardPosition),
      rot = quat(def.rotation),
      scale = v3(def.scale or 1, 1),
      vel = v3(def.velocity),
      omega = v3(def.omega),
      static = def.static == true,
      dimension = type(def.dimension) == "string" and def.dimension or (core.position.dimension or "minecraft:overworld"),
      constraints = C.deepCopy(type(def.constraints) == "table" and def.constraints or {}),
      joints = C.deepCopy(type(def.joints) == "table" and def.joints or {}),
      buoyantFactor = tonumber(def.buoyantFactor) or 1,
      doFluidDrag = def.doFluidDrag ~= false,
    }
    s.inertiaToSave = def.inertiaToSave ~= nil and m3(def.inertiaToSave) or C.deepCopy(s.inertia)
    if type(def.aabb) == "table" then
      local a = def.aabb
      s.aabb = { minX = tonumber(a.minX) or 0, minY = tonumber(a.minY) or 0, minZ = tonumber(a.minZ) or 0,
        maxX = tonumber(a.maxX) or 0, maxY = tonumber(a.maxY) or 0, maxZ = tonumber(a.maxZ) or 0 }
    end
    if def.drag ~= false then
      local d = type(def.drag) == "table" and def.drag or {}
      s.drag = { dragForce = v3(d.dragForce), liftForce = v3(d.liftForce), drag = d.drag ~= false,
        lift = d.lift ~= false, rotDrag = d.rotDrag ~= false, windDirection = v3(d.windDirection),
        windSpeed = tonumber(d.windSpeed) or 0 }
    end
    return s
  end
  if type(cfg.ship) == "table" then st.ship = newShip(cfg.ship) end

  -- ===== the ship's transform (BodyTransformImpl: translate(pos).rotate(rot).scale(scale).translate(-posInShip)) =====

  local function rotation(q) -- JOML Matrix4d.rotate(Quaterniondc), as rows
    local w2, x2, y2, z2 = q.w * q.w, q.x * q.x, q.y * q.y, q.z * q.z
    local zw, xy, xz, yw, yz, xw = q.z * q.w, q.x * q.y, q.x * q.z, q.y * q.w, q.y * q.z, q.x * q.w
    return {
      { w2 + x2 - z2 - y2, -zw + xy - zw + xy, yw + xz + xz + yw },
      { xy + zw + zw + xy, y2 - z2 + w2 - x2, yz + yz - xw - xw },
      { xz - yw + xz - yw, yz + yz + xw + xw, z2 - y2 - x2 + w2 },
    }
  end
  local function shipToWorld(s)
    local R = rotation(s.rot)
    local sc = { s.scale.x, s.scale.y, s.scale.z }
    local p = { s.shipyard.x, s.shipyard.y, s.shipyard.z }
    local w = { s.pos.x, s.pos.y, s.pos.z }
    local m = {}
    for r = 1, 3 do
      local row = {}
      for c = 1, 3 do row[c] = R[r][c] * sc[c] end
      row[4] = w[r] - (row[1] * p[1] + row[2] * p[2] + row[3] * p[3])
      m[r] = row
    end
    m[4] = { 0, 0, 0, 1 }
    return m
  end
  local function toWorld(s, x, y, z)
    local m = shipToWorld(s)
    return {
      x = m[1][1] * x + m[1][2] * y + m[1][3] * z + m[1][4],
      y = m[2][1] * x + m[2][2] * y + m[2][3] * z + m[2][4],
      z = m[3][1] * x + m[3][2] * y + m[3][3] * z + m[3][4],
    }
  end

  -- ===== CC's argument checks and Java's casts =====

  local typeName = C.typeName
  local function dbl(args, i) -- IArguments.getDouble(i - 1) / a `double` parameter
    local v = args[i]
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, typeName(v)), 0) end
    return v
  end
  local function optDbl(args, i) -- IArguments.optDouble(i - 1)
    if args[i] == nil then return nil end
    return dbl(args, i)
  end
  local JAVA = { string = "java.lang.String", number = "java.lang.Double", boolean = "java.lang.Boolean",
    table = "java.util.HashMap" }
  local function cast(v, to) -- Kotlin `as`: a ClassCastException for anything else
    local from = JAVA[type(v)]
    if not from then return nil end -- CC turns other values into null
    if (to == "java.util.Map" and from == "java.util.HashMap") or from == to then return v end
    C.java("java.lang.ClassCastException", ("class %s cannot be cast to class %s (%s and %s are in module java.base of loader 'bootstrap')")
      :format(from, to, from, to))
  end

  local function ship()
    if not st.ship then error("This computer is not on a Ship!", 0) end
    return st.ship
  end

  local function verifyAdmin()
    if NEW then
      -- CCVSUtils.verifyAdmin: needs ComputerComponents.ADMIN_COMPUTER, which only a command computer has
      if COMMAND_ONLY and family ~= "command" then error("This method requires a Command Computer!", 0) end
    else
      -- ShipAPI.verifyAdmin in 0.5.1 throws when the computer IS a command computer (a turtle is not a TileComputer)
      if COMMAND_ONLY and family == "command" then error("This method requires a Command Computer!", 0) end
    end
  end

  -- ===== the virtual clock: what Valkyrien Skies does at the next tick =====

  local pending = {}
  local ticking = false
  local tick
  local function schedule()
    if ticking then return end
    ticking = true
    core.after(0.05, tick)
  end
  local function later(fn)
    pending[#pending + 1] = fn
    schedule()
  end
  local function needsTicks() return EXPOSE_PHYS or #st.collisions > 0 or #pending > 0 end

  -- An event cannot carry functions through os.queueEvent, so a LuaPhysShip travels as a marker and becomes its
  -- table of methods again when a program pulls the event.
  local physObjects, physNext = {}, 0
  local function marker(obj)
    physNext = physNext + 1
    physObjects[physNext] = obj
    physObjects[physNext - 512] = nil
    return { __ccvsPhysShip = physNext }
  end
  local function unmark(v)
    if type(v) ~= "table" then return v end
    if v.__ccvsPhysShip then return physObjects[v.__ccvsPhysShip] or v end
    for i, x in ipairs(v) do
      if type(x) == "table" and x.__ccvsPhysShip then v[i] = physObjects[x.__ccvsPhysShip] or x end
    end
    return v
  end
  local rawPull = os.pullEventRaw
  os.pullEventRaw = function(filter)
    local ev = table.pack(rawPull(filter))
    if ev[1] == "physics_ticks" then
      for i = 2, ev.n do ev[i] = unmark(ev[i]) end
    end
    return table.unpack(ev, 1, ev.n)
  end

  local function physShip(s)
    -- LuaPhysShip: a Java object, which CC hands to Lua as a table of its @LuaFunction methods
    local inertia, poseVel
    if NEW then
      inertia = { momentOfInertia = luaM3(s.inertia), mass = s.mass }
      poseVel = { vel = luaV(s.vel), omega = luaV(s.omega), pos = luaV(s.shipyard), rot = luaQ(s.rot) }
    else
      inertia = { momentOfInertiaTensor = luaM3(s.inertia), mass = s.mass }
      poseVel = { vel = luaV(s.vel), omega = luaV(s.omega), pos = luaV(s.pos), rot = luaQ(s.rot) }
    end
    local buoyant, static, fluid = s.buoyantFactor, s.static, s.doFluidDrag
    return marker({
      getBuoyantFactor = native(function() return buoyant end),
      isStatic = native(function() return static end),
      doFluidDrag = native(function() return fluid end),
      getInertia = native(function() return C.deepCopy(inertia) end),
      getPoseVel = native(function() return C.deepCopy(poseVel) end),
      getForcesInducers = native(function() return {} end),
    })
  end

  function tick()
    ticking = false
    local due = pending
    pending = {}
    for _, fn in ipairs(due) do fn() end
    -- the API's update(), once per server tick
    if NEW then
      for _, phase in ipairs({ "started", "persisted", "ended" }) do
        local list = {}
        for i = #st.collisions, 1, -1 do
          local c = st.collisions[i]
          if c.phase == phase then
            table.insert(list, 1, c.event)
            table.remove(st.collisions, i)
          end
        end
        if #list > 0 then queueEvent("collisions_" .. phase, table.unpack(list)) end
      end
      if EXPOSE_PHYS then
        local data = {}
        if st.ship then for i = 1, PHYS_PER_TICK do data[i] = physShip(st.ship) end end
        st.physTicks = st.physTicks + #data
        queueEvent("physics_ticks", table.unpack(data))
      end
    elseif EXPOSE_PHYS and st.ship then
      -- 0.5.1 hands the whole array as one argument (no spread operator in update())
      local data = {}
      for i = 1, PHYS_PER_TICK do data[i] = physShip(st.ship) end
      st.physTicks = st.physTicks + #data
      queueEvent("physics_ticks", data)
    end
    for _, s in ipairs(st.forces) do s.applied = true end
    if needsTicks() then schedule() end
    core.touch()
  end

  local function record(list, entry)
    entry.at = core.nowMs()
    list[#list + 1] = entry
    if #list > 100 then table.remove(list, 1) end
    core.touch()
  end
  local function force(method, applied, s, fields)
    fields.method, fields.applied, fields.shipId, fields.call = method, false, s.id, applied
    record(st.forces, fields)
    schedule()
  end

  -- ===== the ship API =====

  local api = {}
  local function def(name, fn)
    api[name] = native(function(...) return fn(table.pack(...)) end)
  end

  def("getId", function() return ship().id end)
  def("getMass", function() return ship().mass end)
  def("getMomentOfInertiaTensor", function()
    local s = ship()
    return luaM3(s.inertia)
  end)
  def("getSlug", function() return ship().slug or "no-name" end)
  def("getQuaternion", function() return luaQ(ship().rot) end)
  def("getScale", function() return luaV(ship().scale) end)
  def("getShipyardPosition", function() return luaV(ship().shipyard) end)
  def("getSize", function()
    local a = ship().aabb or { minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0 }
    return { x = a.maxX - a.minX, y = a.maxY - a.minY, z = a.maxZ - a.minZ }
  end)
  def("getVelocity", function() return luaV(ship().vel) end)
  def("getWorldspacePosition", function() return luaV(ship().pos) end)
  def("transformPositionToWorld", function(args)
    local x, y, z
    if args.n == 1 then
      local t = C.table(1, args[1])
      -- CCVSUtils.toVector: the unchecked cast to Map<String, Double> never fails; each value is cast when used
      local function get(k)
        local v = cast(t[k], "java.lang.Double")
        if v == nil then return 0 end
        return v
      end
      x, y, z = get("x"), get("y"), get("z")
    else
      x, y, z = dbl(args, 1), dbl(args, 2), dbl(args, 3)
    end
    return toWorld(ship(), x, y, z)
  end)
  def("isStatic", function() return ship().static end)
  def("setSlug", function(args)
    local name = C.str(1, args[1])
    ship().slug = name
    core.touch()
  end)
  def("getTransformationMatrix", function()
    local m = shipToWorld(ship())
    return { { m[1][1], m[1][2], m[1][3], m[1][4] }, { m[2][1], m[2][2], m[2][3], m[2][4] },
      { m[3][1], m[3][2], m[3][3], m[3][4] }, { m[4][1], m[4][2], m[4][3], m[4][4] } }
  end)
  def("pullPhysicsTicks", function()
    if not EXPOSE_PHYS then error("Physics Tick is not exposed! This is a configuration option!", 0) end
    -- Array<Any>? null: no values
  end)

  local function readVector(input, section)
    local t = cast(input[section], "java.util.Map")
    local function field(k)
      local v = t[k]
      if v == nil then error("Malformed " .. k .. " key of " .. section, 0) end
      return cast(v, "java.lang.Double")
    end
    local x = field("x")
    local y = field("y")
    local z = field("z")
    return { x = x, y = y, z = z }
  end
  def("teleport", function(args)
    if NEW then verifyAdmin() end
    if not CAN_TELEPORT then error("Teleporting is Disabled via CC: VS Config!", 0) end
    local input = C.table(1, args[1])
    local s = ship()
    local pos = s.pos
    if input.pos ~= nil then pos = readVector(input, "pos") end
    local rot = s.rot
    if input.rot ~= nil then
      local t = cast(input.rot, "java.util.Map")
      local q = {}
      for _, k in ipairs({ "x", "y", "z", "w" }) do
        if t[k] == nil then error("Malformed " .. k .. " key of rot", 0) end
        q[k] = cast(t[k], "java.lang.Double")
      end
      local inv = 1 / math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) -- Quaterniond.normalize
      rot = { x = q.x * inv, y = q.y * inv, z = q.z * inv, w = q.w * inv }
    end
    local vel = s.vel
    if input.vel ~= nil then vel = readVector(input, "vel") end
    local omega = s.omega
    if input.omega ~= nil then omega = readVector(input, "omega") end
    local dimension
    if input.dimension ~= nil then dimension = cast(input.dimension, "java.lang.String") end
    local scale = s.scale.x
    if input.scale ~= nil then scale = cast(input.scale, "java.lang.Double") end
    record(st.forces, { method = "teleport", call = "teleportShip", shipId = s.id, applied = false,
      pos = luaV(pos), rot = luaQ(rot), vel = luaV(vel), omega = luaV(omega), dimension = dimension, scale = scale })
    later(function()
      s.pos, s.rot, s.vel, s.omega = luaV(pos), luaQ(rot), luaV(vel), luaV(omega)
      s.scale = { x = scale, y = scale, z = scale }
      if dimension then s.dimension = dimension end
    end)
  end)
  def("setScale", function(args)
    local scale = dbl(args, 1)
    if NEW then verifyAdmin() end
    local s = ship()
    record(st.forces, { method = "setScale", call = "scaleShip", shipId = s.id, applied = false, scale = scale })
    later(function() s.scale = { x = scale, y = scale, z = scale } end)
  end)
  def("setStatic", function(args)
    local b = C.bool(1, args[1])
    if NEW then verifyAdmin() end
    local s = ship()
    record(st.forces, { method = "setStatic", call = "setStatic", shipId = s.id, applied = false, static = b })
    later(function() s.static = b end)
  end)

  if NEW then
    -- 0.6.6
    def("getAngularVelocity", function() return luaV(ship().omega) end)
    def("getJoints", function()
      if st.ship then st.joints = C.deepCopy(st.ship.joints) end -- refreshed by every physics tick on a ship
      return C.deepCopy(st.joints)
    end)
    local function xyz(args) return { x = dbl(args, 1), y = dbl(args, 2), z = dbl(args, 3) } end
    local function optPos(args)
      local x = optDbl(args, 4)
      if x == nil then return nil end
      local y = optDbl(args, 5)
      if y == nil then return nil end
      local z = optDbl(args, 6)
      if z == nil then return nil end
      return { x = x, y = y, z = z }
    end
    local function withPos(name, call, zeroPos)
      def(name, function(args)
        local f = xyz(args)
        verifyAdmin()
        local p = optPos(args)
        if p == nil and zeroPos then p = { x = 0, y = 0, z = 0 } end
        force(name, call, ship(), { force = f, pos = p })
      end)
    end
    withPos("applyWorldForce", "applyWorldForce", false)
    withPos("applyModelForce", "applyModelForce", false)
    withPos("applyBodyForce", "applyBodyForce", true)
    local function torque(name, call)
      def(name, function(args)
        local t = xyz(args)
        verifyAdmin()
        force(name, call, ship(), { torque = t })
      end)
    end
    torque("applyWorldTorque", "applyWorldTorque")
    torque("applyModelTorque", "applyModelTorque")
    torque("applyBodyTorque", "applyBodyTorque")
    local function toPos(name, call)
      def(name, function(args)
        local f = xyz(args)
        local p = { x = dbl(args, 4), y = dbl(args, 5), z = dbl(args, 6) }
        verifyAdmin()
        force(name, call, ship(), { force = f, pos = p })
      end)
    end
    toPos("applyWorldForceToModelPos", "applyWorldForceToModelPos")
    -- applyWorldForceToBodyPos calls the GTPA's applyWorldForceToModelPos (ShipAPI.kt 294-297)
    toPos("applyWorldForceToBodyPos", "applyWorldForceToModelPos")
  else
    -- 0.5.1
    def("getMomentOfInertiaTensorToSave", function() return luaM3(ship().inertiaToSave) end)
    def("getOmega", function() return luaV(ship().omega) end)
    def("getConstraints", function() return C.deepCopy(ship().constraints) end)
    local function xyz(args) return { x = dbl(args, 1), y = dbl(args, 2), z = dbl(args, 3) } end
    for _, name in ipairs({ "applyInvariantForce", "applyRotDependentForce" }) do
      def(name, function(args)
        local f = xyz(args)
        verifyAdmin()
        force(name, name, ship(), { force = f })
      end)
    end
    for _, name in ipairs({ "applyInvariantTorque", "applyRotDependentTorque" }) do
      def(name, function(args)
        local t = xyz(args)
        verifyAdmin()
        force(name, name, ship(), { torque = t })
      end)
    end
    for _, name in ipairs({ "applyInvariantForceToPos", "applyRotDependentForceToPos" }) do
      def(name, function(args)
        local f = xyz(args)
        local p = { x = dbl(args, 4), y = dbl(args, 5), z = dbl(args, 6) }
        verifyAdmin()
        force(name, name, ship(), { force = f, pos = p })
      end)
    end
  end

  -- ===== aerodynamics and drag (0.6.6) =====

  local aero, drag
  if NEW then
    local a = type(cfg.aero) == "table" and cfg.aero or {}
    aero = {}
    local function adef(name, fn) aero[name] = native(function(...) return fn(table.pack(...)) end) end
    -- AerodynamicUtils' constants (valkyrienskies core api 1.1.0+f6a942e0e1)
    adef("getDefaultMax", function() return 962.0 end)
    adef("getDefaultSeaLevel", function() return 62.0 end)
    adef("getDragCoefficient", function() return DRAG_COEFFICIENT end)
    adef("getGravitationalAcceleration", function() return 10.0 end)
    adef("getUniversalGasConstant", function() return 8.314 end)
    adef("getAirMolarMass", function() return 0.0289644 end)
    local function dimension() return st.ship and st.ship.dimension or (core.position.dimension or "minecraft:overworld") end
    adef("getAtmosphericParameters", function()
      local all = type(a.atmospheres) == "table" and a.atmospheres or {}
      local at = type(all[dimension()]) == "table" and all[dimension()] or {}
      return { maxY = tonumber(at.maxY) or 962.0, seaLevel = tonumber(at.seaLevel) or 62.0,
        gravity = tonumber(at.gravity) or 10.0 }
    end)
    local function computerY()
      local p = core.position
      local x, y, z = (tonumber(p.x) or 0) + 0.5, (tonumber(p.y) or 0) + 0.5, (tonumber(p.z) or 0) + 0.5
      if st.ship then return toWorld(st.ship, x, y, z).y end -- Level.positionToWorld: shipyard to world
      return y
    end
    local function air(name, key)
      adef(name, function(args)
        local y = optDbl(args, 1)
        if y == nil then y = computerY() end
        local values = type(a.air) == "table" and a.air or {}
        local v = values[key]
        if type(v) == "table" then v = v[tostring(y)] or v[("%d"):format(math.floor(y))] end
        if type(v) ~= "number" then
          error(("ccsim: aerodynamics.%s needs world.ccvs.aero.air.%s (Valkyrien Skies' atmosphere model is not emulated)")
            :format(name, key), 0)
        end
        return v
      end)
    end
    air("getAirDensity", "density")
    air("getAirPressure", "pressure")
    air("getAirTemperature", "temperature")

    drag = {}
    local function ddef(name, fn) drag[name] = native(function(...) return fn(table.pack(...)) end) end
    ddef("getDragForce", function()
      local d = ship().drag
      if not d then return nil end
      return luaV(d.dragForce)
    end)
    ddef("getLiftForce", function()
      local d = ship().drag
      if not d then return nil end
      return luaV(d.liftForce)
    end)
    for _, t in ipairs({ { "Drag", "drag" }, { "Lift", "lift" }, { "RotDrag", "rotDrag" } }) do
      for _, on in ipairs({ true, false }) do
        ddef((on and "enable" or "disable") .. t[1], function()
          verifyAdmin()
          local d = ship().drag
          if d then
            d[t[2]] = on
            core.touch()
          end
        end)
      end
    end
    ddef("setWindDirection", function(args)
      local dir = { x = dbl(args, 1), y = dbl(args, 2), z = dbl(args, 3) }
      verifyAdmin()
      local d = ship().drag
      if d then d.windDirection = dir core.touch() end
    end)
    ddef("setWindSpeed", function(args)
      local speed = dbl(args, 1)
      verifyAdmin()
      local d = ship().drag
      if d then d.windSpeed = speed core.touch() end
    end)
    ddef("applyWindImpulse", function(args)
      verifyAdmin()
      -- DragAPI.applyWindImpulse reads arguments 0, 1, 2 and 4: the fifth, not the fourth
      local x, y, z = dbl(args, 1), dbl(args, 2), dbl(args, 3)
      local speed = math.min(dbl(args, 5), 0.0) -- coerceAtMost(0.0)
      local s = ship()
      if s.drag then
        record(st.windImpulses, { shipId = s.id, direction = { x = x, y = y, z = z }, speed = speed })
      end
    end)
  end

  -- ===== the globals, then the ROM's wrappers as bios.lua loads them =====

  local romDir = "/rom/ccsim/addons/cc-vs/rom-" .. (NEW and "1.20.1" or "1.18.2") .. "/apis/"
  local function loadAPI(name) -- bios.lua os.loadAPI, for /rom/apis/<name>.lua
    local h = fs.open(romDir .. name .. ".lua", "r")
    local text = h.readAll()
    h.close()
    local tEnv = setmetatable({}, { __index = _G })
    local fn, err = load(text, "@/rom/apis/" .. name .. ".lua", "t", tEnv)
    if not fn then error("Failed to load API " .. name .. " due to " .. tostring(err), 0) end
    local ok, e = pcall(fn)
    if not ok then error("Failed to load API " .. name .. " due to " .. tostring(e), 0) end
    local t = {}
    for k, v in pairs(tEnv) do
      if k ~= "_ENV" then t[k] = v end
    end
    _G[name] = t
  end

  local installed = NEW or st.ship ~= nil
  if NEW then
    _G.aerodynamics, _G.aero, _G.drag = aero, aero, drag
  end
  if installed then _G.ship = api end
  -- bios.lua loads rom/apis in fs.list order: aero, ..., drag, ..., matrix, ..., quaternion, ..., ship, ...
  if NEW then
    loadAPI("aero")
    loadAPI("drag")
  end
  loadAPI("matrix")
  loadAPI("quaternion")
  -- Off a ship on 1.18.2 the real bios stops here: ship.lua errors and os.loadAPI rethrows (docs/cc-vs.md)
  if installed then loadAPI("ship") end
  st.installed = installed

  if needsTicks() then schedule() end

  -- ===== sim commands =====

  local handlers = {}
  local function requireShip()
    if not st.ship then return nil, "this computer is not on a ship (ccvsSetShip first)" end
    return st.ship
  end

  function handlers.ccvsSetShip(cmd)
    if type(cmd.ship) == "table" then
      st.ship = newShip(cmd.ship)
    else
      st.ship = nil
    end
    core.touch()
    return true
  end

  function handlers.ccvsSet(cmd)
    local s, err = requireShip()
    if not s then return false, err end
    if cmd.position ~= nil then s.pos = v3(cmd.position) end
    if cmd.shipyardPosition ~= nil then s.shipyard = v3(cmd.shipyardPosition) end
    if cmd.rotation ~= nil then s.rot = quat(cmd.rotation) end
    if cmd.velocity ~= nil then s.vel = v3(cmd.velocity) end
    if cmd.omega ~= nil then s.omega = v3(cmd.omega) end
    if cmd.scale ~= nil then s.scale = v3(cmd.scale, 1) end
    if cmd.mass ~= nil then s.mass = tonumber(cmd.mass) or s.mass end
    if cmd.inertia ~= nil then s.inertia = m3(cmd.inertia) end
    if cmd.static ~= nil then s.static = cmd.static == true end
    if cmd.slug ~= nil then s.slug = type(cmd.slug) == "string" and cmd.slug or nil end
    if cmd.dimension ~= nil then s.dimension = tostring(cmd.dimension) end
    if type(cmd.joints) == "table" then s.joints = C.deepCopy(cmd.joints) end
    if type(cmd.constraints) == "table" then s.constraints = C.deepCopy(cmd.constraints) end
    if type(cmd.drag) == "table" and s.drag then
      local d = cmd.drag
      if d.dragForce ~= nil then s.drag.dragForce = v3(d.dragForce) end
      if d.liftForce ~= nil then s.drag.liftForce = v3(d.liftForce) end
    end
    core.touch()
    return true
  end

  function handlers.ccvsCollision(cmd)
    if not NEW then return false, "collision events are CC: VS 0.6.6 (Minecraft 1.20.1)" end
    local phase = ({ start = "started", started = "started", persist = "persisted", persisted = "persisted",
      ["end"] = "ended", ended = "ended" })[tostring(cmd.phase)]
    if not phase then return false, "phase must be start, persist or end" end
    local s = st.ship
    if not s then return true end -- the listener returns when the computer is on no ship
    local dim = cmd.dimensionId or s.dimension
    local a, b = tonumber(cmd.shipIdA) or s.id, tonumber(cmd.shipIdB) or -1
    if dim ~= s.dimension or (a ~= s.id and b ~= s.id) then return true end
    local points = {}
    for i, p in ipairs(type(cmd.contactPoints) == "table" and cmd.contactPoints or {}) do
      points[i] = { position = v3(p.position), normal = v3(p.normal), separation = tonumber(p.separation) or 0,
        velocity = v3(p.velocity) }
    end
    st.collisions[#st.collisions + 1] = { phase = phase,
      event = { dimensionId = dim, shipIdA = a, shipIdB = b, contactPoints = points } }
    schedule()
    return true
  end

  M.handlers = handlers

  function M.state()
    local s = st.ship
    local ship
    if s then
      ship = { id = s.id, slug = s.slug, mass = s.mass, position = luaV(s.pos), shipyardPosition = luaV(s.shipyard),
        rotation = luaQ(s.rot), scale = luaV(s.scale), velocity = luaV(s.vel), omega = luaV(s.omega), static = s.static,
        dimension = s.dimension, drag = s.drag and C.deepCopy(s.drag) or nil }
    end
    return { version = NEW and "0.6.6" or "0.5.1", installed = st.installed, family = family, ship = ship,
      forces = C.deepCopy(st.forces), windImpulses = C.deepCopy(st.windImpulses), physicsTicks = st.physTicks }
  end

  return M
end
