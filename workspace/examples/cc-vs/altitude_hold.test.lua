-- Runs altitude_hold.lua on a command computer aboard a ship (altitude_hold.world.json, CC: VS 0.6.6 on 1.20.1),
-- moves the ship with sim commands and checks what the program shows and the forces it applies. Then every function
-- of the ship, aerodynamics and drag APIs once, with its argument errors.

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local function near(a, b, what) ccunit.truthy(math.abs(a - b) < 1e-9, ("%s: %s is not %s"):format(what, a, b)) end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end
local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.25) end
  return condition()
end
local window = window.create(term.current(), 1, 1, term.getSize())
local function screen()
  local _, h = window.getSize()
  local lines = {}
  for y = 1, h do lines[y] = (window.getLine(y)) end
  return table.concat(lines, "\n")
end

-- the program pushes through ship.applyWorldForce: watch what it asks for
local pushes = {}
local realApply = ship.applyWorldForce
ship.applyWorldForce = function(force, pos)
  pushes[#pushes + 1] = force.y
  return realApply(force, pos)
end

local seen = {}
local function scenario()
  waitFor(function() return #pushes > 0 end, 10)
  seen.firstPush = pushes[#pushes]
  seen.screen = screen()
  -- the ship rises above the target and stops
  sim({ cmd = "ccvsSet", position = { x = 100.5, y = 130, z = -40.5 }, velocity = { 0, 0, 0 } })
  local n = #pushes
  waitFor(function() return #pushes > n + 1 end, 10)
  seen.highPush = pushes[#pushes]
  -- frozen: no more pushes
  ship.setStatic(true)
  seen.staticAtOnce = ship.isStatic()
  waitFor(function() return ship.isStatic() end, 5)
  sleep(1)
  seen.staticScreen = screen()
  local before = #pushes
  sleep(1.2)
  seen.pushesWhileStatic = #pushes - before
  ship.setStatic(false)
  sleep(0.2)
end

local old = term.redirect(window)
parallel.waitForAny(function() shell.run("examples/cc-vs/altitude_hold.lua", "120") end, scenario)
term.redirect(old)
ship.applyWorldForce = realApply

ccunit.test("the program shows the ship", function()
  ccunit.truthy(seen.screen:find("SHIP skylark (#42)", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("Altitude  100.0  target 120", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("Heading   45.0 deg", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("Mass     2500 kg", 1, true), seen.screen)
end)

ccunit.test("it pushes up when low and down when high", function()
  -- 2500 * (2 * (120 - 100) - 4 * -1.5)
  near(seen.firstPush, 2500 * (2 * 20 + 6), "first push")
  near(seen.highPush, 2500 * (2 * -10), "push from above")
end)

ccunit.test("setStatic shows at the next tick and stops the pushes", function()
  ccunit.eq(seen.staticAtOnce, false)
  ccunit.truthy(seen.staticScreen:find("STATIC", 1, true), seen.staticScreen)
  ccunit.eq(seen.pushesWhileStatic, 0)
end)

-- ===== every function =====

ccunit.test("ship getters", function()
  ccunit.eq(ship.getId(), 42)
  ccunit.eq(ship.getMass(), 2500)
  ccunit.eq(ship.getMomentOfInertiaTensor(), { { 900, 0, 0 }, { 0, 1200, 0 }, { 0, 0, 700 } })
  ccunit.eq(ship.getSlug(), "skylark")
  ccunit.eq(tostring(ship.getAngularVelocity()), "0,0,0")
  local q = ship.getQuaternion()
  near(q.v.y, 0.3826834323650898, "q.y")
  near(q.a, 0.9238795325112867, "q.w")
  ccunit.eq(tostring(ship.getScale()), "1,1,1")
  ccunit.eq(tostring(ship.getShipyardPosition()), "2,1,3")
  ccunit.eq(ship.getSize(), { x = 5, y = 4, z = 11 })
  ccunit.eq(tostring(ship.getVelocity()), "0,0,0")
  ccunit.eq(tostring(ship.getWorldspacePosition()), "100.5,130,-40.5")
  ccunit.eq(ship.isStatic(), false)
end)

ccunit.test("transformPositionToWorld and the matrix", function()
  -- the shipyard position is the ship's centre: it lands on the world position
  local p = ship.transformPositionToWorld(2, 1, 3)
  near(p.x, 100.5, "x") near(p.y, 130, "y") near(p.z, -40.5, "z")
  -- one block along shipyard +Z, turned 45 degrees about Y
  p = ship.transformPositionToWorld({ x = 2, y = 1, z = 4 })
  near(p.x, 100.5 + math.sqrt(0.5), "x") near(p.z, -40.5 + math.sqrt(0.5), "z")
  local m = ship.getTransformationMatrix()
  ccunit.eq(m.rows, 4)
  ccunit.eq(m.columns, 4)
  ccunit.eq(err(ship.transformPositionToWorld, 1, 2), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(ship.transformPositionToWorld, "a"), "bad argument #1 (table expected, got string)")
  ccunit.truthy(err(ship.transformPositionToWorld, { y = "up" }):find("ClassCastException: class java.lang.String cannot be cast to class java.lang.Double", 1, true))
end)

ccunit.test("setSlug, setScale, teleport", function()
  ship.setSlug("heron")
  ccunit.eq(ship.getSlug(), "heron")
  ccunit.eq(err(ship.setSlug, nil), "bad argument #1 (string expected, got nil)")
  ship.setScale(2)
  sleep(0.1)
  ccunit.eq(tostring(ship.getScale()), "2,2,2")
  ccunit.eq(err(ship.setScale, "big"), "bad argument #1 (number expected, got string)")
  ship.teleport({ pos = { x = 0, y = 200, z = 0 }, rot = { x = 0, y = 0, z = 0, w = 2 }, scale = 1 })
  sleep(0.1)
  ccunit.eq(tostring(ship.getWorldspacePosition()), "0,200,0")
  ccunit.eq(tostring(ship.getQuaternion()), tostring(quaternion.identity()))
  ship.teleport({}) -- nothing given: everything stays
  ccunit.eq(err(ship.teleport, 5), "bad argument #1 (table expected, got number)")
  ccunit.eq(err(ship.teleport, { pos = { x = 1, y = 2 } }), "Malformed z key of pos")
  ccunit.eq(err(ship.teleport, { rot = { x = 0, y = 0, z = 0 } }), "Malformed w key of rot")
  ccunit.truthy(err(ship.teleport, { vel = 3 }):find("class java.lang.Double cannot be cast to class java.util.Map", 1, true))
  ccunit.truthy(err(ship.teleport, { dimension = 1 }):find("class java.lang.Double cannot be cast to class java.lang.String", 1, true))
  ccunit.eq(err(ship.setStatic, 1), "bad argument #1 (boolean expected, got number)")
end)

ccunit.test("forces and torques", function()
  local v = vector.new(1, 2, 3)
  ship.applyWorldForce(v)
  ship.applyWorldForce(v, vector.new(0, 1, 0))
  ship.applyModelForce(v)
  ship.applyBodyForce(v, v)
  ship.applyWorldTorque(v)
  ship.applyModelTorque(v)
  ship.applyBodyTorque(v)
  ship.applyWorldForceToModelPos(v, v)
  ship.applyWorldForceToBodyPos(v, v)
  -- the mod's wrappers want vectors
  ccunit.eq(err(ship.applyWorldForce, { x = 1, y = 2, z = 3 }), "bad argument #1 (vector expected, got table)")
  ccunit.eq(err(ship.applyWorldTorque, 1, 2, 3), "bad argument #1 (table expected, got number)")
  ccunit.eq(err(ship.applyWorldForceToModelPos, v), "bad argument #2 (table expected, got nil)")
  -- the native methods behind them check their numbers
  ccunit.eq(err(ship.applyBodyForce, vector.new(1, 2, 3), setmetatable({ x = "a", y = 0, z = 0 }, getmetatable(v))),
    "bad argument #4 (number expected, got string)")
  -- the old 0.5 names
  ccunit.eq(err(ship.applyInvariantForce, v), "This method no longer exists! Use applyWorldForceToBodyPos instead!")
  ccunit.eq(err(ship.getOmega), "This method no longer exists! Use getAngularVelocity instead!")
  ccunit.eq(err(ship.getYaw), "This method no longer exists! Please utilize the new quaternion API!")
  ccunit.eq(err(ship.getRotationMatrix), "This method no longer exists! Use getTransformationMatrix instead!")
end)

ccunit.test("joints and physics ticks", function()
  local joints = ship.getJoints()
  ccunit.eq(#joints, 1)
  ccunit.eq(joints[1].type, "DISTANCE")
  ccunit.eq(tostring(joints[1].pose1.pos), "0,2,0")
  ccunit.eq(err(ship.pullPhysicsTicks), "Physics Tick is not exposed! This is a configuration option!")
end)

ccunit.test("aerodynamics", function()
  ccunit.eq(aero.getDefaultMax(), 962)
  ccunit.eq(aero.getDefaultSeaLevel(), 62)
  ccunit.eq(aero.getDragCoefficient(), 2.18)
  ccunit.eq(aero.getGravitationalAcceleration(), 10)
  ccunit.eq(aero.getUniversalGasConstant(), 8.314)
  ccunit.eq(aero.getAirMolarMass(), 0.0289644)
  ccunit.eq(aerodynamics.getAtmosphericParameters(), { maxY = 962, seaLevel = 62, gravity = 10 })
  ccunit.eq(aero.getAirDensity(), 1.1)
  ccunit.eq(aero.getAirPressure(80), 95000)
  ccunit.eq(aero.getAirTemperature(), 285)
  ccunit.eq(err(aero.getAirDensity, "high"), "bad argument #1 (number expected, got string)")
end)

ccunit.test("drag", function()
  ccunit.eq(tostring(drag.getDragForce()), "0,120,0")
  ccunit.eq(tostring(drag.getLiftForce()), "0,15,0")
  drag.disableDrag() drag.enableDrag()
  drag.disableLift() drag.enableLift()
  drag.disableRotDrag() drag.enableRotDrag()
  drag.setWindDirection(vector.new(1, 0, 0))
  drag.setWindSpeed(4)
  ccunit.eq(err(drag.setWindSpeed, "fast"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(drag.setWindDirection, 1), "bad argument #1 (table expected, got number)")
  -- the wrapper passes four numbers; the Java reads the fifth
  ccunit.eq(err(drag.applyWindImpulse, vector.new(1, 0, 0), 3), "bad argument #5 (number expected, got nil)")
  ccunit.eq(err(drag.applyWindImpulse, vector.new(2, 0, 0), 3), "bad argument #1 (normalized vector expected, got vector)")
end)
