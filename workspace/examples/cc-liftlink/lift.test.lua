-- Runs lift.lua against a three-floor Create elevator (lift.world.json: contacts at y 64, 70 and 76, an elevator
-- pulley at y 80 turning at 64 RPM, the cab at the lobby) and checks every create_elevator method on the way,
-- with the argument errors and the sim commands that assemble, stop and re-power the lift.

local lift = peripheral.find("create_elevator")

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.25) end
  return condition()
end

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^[^:]*:%d+: ", ""))
end

--- runs the program and gives what it printed
local function run(...)
  local w, h = term.getSize()
  local win = window.create(term.current(), 1, 1, w, h, false)
  local old = term.redirect(win)
  shell.run("examples/cc-liftlink/lift.lua", ...)
  term.redirect(old)
  local lines = {}
  for y = 1, h do
    local line = win.getLine(y):gsub("%s+$", "")
    if line ~= "" then lines[#lines + 1] = line end
  end
  return table.concat(lines, "\n")
end

ccunit.test("type and methods", function()
  ccunit.eq(peripheral.getType(lift), "create_elevator")
  local methods = peripheral.getMethods(peripheral.getName(lift))
  table.sort(methods)
  ccunit.eq(methods, { "callToFloor", "callToY", "getCabY", "getNearestFloor", "getOffset", "getRole", "getSpeed",
    "getState", "getTargetY", "isMoving", "listFloors" })
  ccunit.eq(lift.getRole(), "contact")
end)

ccunit.test("at rest in the lobby", function()
  local floors = lift.listFloors()
  ccunit.eq(#floors, 3)
  ccunit.eq(floors[1], { y = 64, shortName = "G", longName = "Lobby", name = "G", currentFloorName = "G",
    isTarget = true, isCurrent = true })
  ccunit.eq(floors[3].name, "2")
  ccunit.eq(floors[3].isCurrent, false)
  ccunit.eq(lift.getCabY(), 64)
  ccunit.eq(lift.getOffset(), 15) -- pulley at 80: 80 - 1 - 64
  ccunit.eq(lift.getTargetY(), 64)
  ccunit.eq(lift.isMoving(), false)
  ccunit.eq(lift.getSpeed(), 0)
  ccunit.eq(lift.getNearestFloor(), { y = 64, shortName = "G", longName = "Lobby", name = "G", distance = 0 })
  local s = lift.getState()
  ccunit.eq(s.modName, "CC:LiftLink")
  ccunit.eq(s.role, "contact")
  ccunit.eq(s.active, true)
  ccunit.eq(s.targetAvailable, true)
  ccunit.eq(s.hasPulley, true)
  ccunit.eq(s.trackingMode, "live_pulley")
  ccunit.eq(s.floorCount, 3)
  ccunit.eq({ s.blockX, s.blockY, s.blockZ }, { 120, 64, -40 })
  ccunit.eq(s.currentFloorName, "G")
  ccunit.eq(s.currentFloorY, 64)
  ccunit.eq(s.moving, false)
end)

ccunit.test("argument errors", function()
  ccunit.eq(err(lift.callToFloor), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(lift.callToFloor, 2), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(lift.callToFloor, "Basement"), "No floor named 'Basement'")
  ccunit.eq(err(lift.callToY), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(lift.callToY, "70"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(lift.callToY, 0 / 0), "bad argument #1 (number expected, got nan)")
  ccunit.eq(err(lift.callToY, math.huge), "bad argument #1 (number expected, got inf)")
  ccunit.eq(err(lift.callToY, 200), "Y=200 is not a real floor and is outside the elevator travel range")
end)

ccunit.test("the program rides to the roof and back by name", function()
  local out = run('"roof garden"', "nowhere", '" g "')
  ccunit.truthy(out:find("Arrived at 2 (Roof Garden, y=76)", 1, true), out)
  ccunit.truthy(out:find("Skipping nowhere: No floor named 'nowhere'", 1, true), out)
  ccunit.truthy(out:find("Arrived at G (Lobby, y=64)", 1, true), out)
  ccunit.eq(lift.getCabY(), 64)
  ccunit.eq(lift.listFloors()[1].isCurrent, true)
end)

ccunit.test("a ride: moving, speed, offset, current floor reports", function()
  ccunit.eq(lift.callToY(76), true)
  ccunit.eq(lift.getTargetY(), 76)
  -- look as soon as the cab is under way: the ride is a few seconds of a 5x clock, which a fixed sleep on a busy host
  -- could sleep right through
  local t0 = os.clock()
  while not (lift.isMoving() and lift.getOffset() < 15) and os.clock() - t0 < 5 do sleep(0.05) end
  ccunit.eq(lift.isMoving(), true)
  -- the pulley's offset shrinks as the cab rises, so the speed is negative going up
  local speed = lift.getSpeed()
  ccunit.truthy(speed < 0 and speed >= -0.25, speed)
  local offset = lift.getOffset()
  ccunit.truthy(offset < 15 and offset > 0, offset)
  local s = lift.getState()
  ccunit.eq(s.moving, true)
  ccunit.eq(s.targetY, 76)
  ccunit.eq(s.currentTargetY, 76)
  ccunit.truthy(waitFor(function() return not lift.isMoving() end, 20))
  ccunit.eq(lift.getCabY(), 76)
  ccunit.eq(lift.getNearestFloor().name, "2")
  ccunit.eq(lift.listFloors()[3].isCurrent, true)
  ccunit.eq(lift.listFloors()[2].currentFloorName, "2")
end)

ccunit.test("a secret floor between contacts", function()
  ccunit.eq(lift.callToY(73), true)
  ccunit.truthy(waitFor(function() return not lift.isMoving() and lift.getCabY() == 73 end, 20))
  local near = lift.getNearestFloor()
  ccunit.eq(near.distance, 3)
  ccunit.truthy(near.y == 70 or near.y == 76, near.y)
  ccunit.eq(near.y, 70) -- a tie goes to the lower contact, the first in height order
  ccunit.eq(lift.listFloors()[2].isTarget, false)
end)

ccunit.test("disassembled: the pulley still reads, the cab does not", function()
  sim({ cmd = "liftlinkDisassemble", column = "shaft" })
  ccunit.eq(lift.getState().active, false)
  ccunit.eq(lift.getOffset(), -1)
  ccunit.eq(lift.getSpeed(), 0)
  ccunit.eq(lift.isMoving(), false)
  -- the cab's last floor report was "2" (it passed y 76 on the way down to 73)
  ccunit.eq(lift.getCabY(), 76)
  ccunit.eq(lift.getTargetY(), 73)
  ccunit.eq(err(lift.callToY, 73), "Y=73 is not a real floor and is outside the elevator travel range")
  ccunit.eq(lift.callToY(64), true)
  ccunit.eq(lift.getTargetY(), 64)
  sim({ cmd = "liftlinkAssemble", column = "shaft" })
  ccunit.eq(lift.getState().active, true)
  ccunit.eq(lift.getCabY(), 73)
  ccunit.eq(lift.getTargetY(), 73)
end)

ccunit.test("redstone into a contact calls the cab; a stopped pulley holds it", function()
  sim({ cmd = "liftlinkSetSpeed", column = "shaft", rpm = 0 })
  -- the lobby contact is still "calling" from callToY(64): a signal there does nothing
  sim({ cmd = "liftlinkPower", column = "shaft", y = 64, powered = true })
  ccunit.eq(lift.getTargetY(), 73)
  sim({ cmd = "liftlinkPower", column = "shaft", y = 70, powered = true })
  ccunit.eq(lift.getTargetY(), 70)
  sleep(1)
  ccunit.eq(lift.getCabY(), 73)
  ccunit.eq(lift.isMoving(), false)
  sim({ cmd = "liftlinkSetSpeed", column = "shaft", rpm = 128 })
  ccunit.truthy(waitFor(function() return lift.getCabY() == 70 end, 20))
  ccunit.eq(lift.getNearestFloor().name, "1")
  ccunit.eq(lift.listFloors()[2].isCurrent, true)
end)

ccunit.test("names: a renamed floor and a new unnamed contact", function()
  sim({ cmd = "liftlinkRename", column = "shaft", y = 70, longName = "Market" })
  ccunit.eq(lift.listFloors()[2].longName, "Market")
  ccunit.eq(lift.callToFloor("MARKET"), true)
  sim({ cmd = "liftlinkAddContact", column = "shaft", y = 58 })
  local floors = lift.listFloors()
  ccunit.eq(#floors, 4)
  ccunit.eq(floors[1].y, 58)
  ccunit.eq(floors[1].shortName, "0") -- ElevatorColumn.initNames numbers it below the next numbered floor
  sim({ cmd = "liftlinkRemoveContact", column = "shaft", y = 58 })
  ccunit.eq(#lift.listFloors(), 3)
end)
