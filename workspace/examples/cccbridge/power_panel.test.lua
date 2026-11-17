-- Runs power_panel.lua against power_panel.world.json (CC:C Bridge 1.5.1 on 1.18.2), plays a player turning the
-- scroller, a display link reading the source and another writing the target, then calls every method of the five
-- blocks, with their argument errors.

local scroller = peripheral.wrap("scroller_0")
local router = peripheral.wrap("redrouter_0")
local source = peripheral.wrap("create_source_0")
local target = peripheral.wrap("create_target_0")
local puppet = peripheral.wrap("animatronic_0")

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

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end

local seen = {}

local function scenario()
  -- the source's display link reads it within 20 ticks and gives it the display's 16x4: monitor_resize, a redraw
  seen.resized = waitFor(function() return source.getLine(1):find("Power  0/15", 1, true) ~= nil end, 10)
  seen.size = { source.getSize() }
  seen.startFace = puppet.getAppliedHeadRot()
  seen.startOutput = router.getAnalogOutput("front")

  sim({ cmd = "cccbScroll", peripheral = "scroller_0", value = 9 })
  seen.turned = waitFor(function() return router.getAnalogOutput("front") == 9 end, 5)
  seen.line1, seen.line2 = source.getLine(1), source.getLine(2)
  seen.arm = { puppet.getAppliedRightArmRot() }

  -- a stress gauge's display link writes into the target; the panel copies its first line on its next redraw
  sim({ cmd = "cccbLinkTarget", peripheral = "create_target_0", lines = { "Stress 42%" } })
  seen.copied = waitFor(function() return source.getLine(4):find("Stress 42%", 1, true) ~= nil end, 5)

  -- the key switch: redstone into the back locks the scroller; a player can no longer turn it
  sim({ cmd = "cccbSetInput", peripheral = "redrouter_0", side = "back", level = 15 })
  seen.locked = waitFor(function() return scroller.isLocked() end, 5)
  waitFor(function() return source.getLine(3):find("LOCKED", 1, true) ~= nil end, 5) -- the next redraw
  seen.lockedLine = source.getLine(3)

  sim({ cmd = "cccbSetInput", peripheral = "redrouter_0", side = "back", level = 0 })
  seen.unlocked = waitFor(function() return not scroller.isLocked() end, 5)
  sim({ cmd = "cccbScroll", peripheral = "scroller_0", value = 0 })
  seen.off = waitFor(function() return router.getAnalogOutput("front") == 0 end, 5)
  seen.face = puppet.getAppliedHeadRot()

  -- a bigger display on the link: the source grows and the panel redraws its bar to the new width
  sim({ cmd = "cccbLinkSource", peripheral = "create_source_0", rows = 5, columns = 24 })
  seen.regrown = waitFor(function() local w = source.getSize() return w == 24 end, 5)
  -- the size changes first; the panel redraws once its monitor_resize comes in
  waitFor(function() return #source.getLine(2):gsub(" +$", "") == 24 end, 5)
  seen.bar = source.getLine(2)
end

parallel.waitForAny(function() shell.run("examples/cccbridge/power_panel.lua") end, scenario)

ccunit.test("the panel draws on the size the display link gives the source", function()
  ccunit.truthy(seen.resized, source.getLine(1))
  ccunit.eq(seen.size, { 16, 4 })
  ccunit.eq(seen.startOutput, 0)
  ccunit.eq(seen.startFace, 20) -- sulking: head down, power off
end)

ccunit.test("turning the scroller sets the redrouter, the display and the puppet", function()
  ccunit.truthy(seen.turned, "the output never reached 9")
  ccunit.eq(seen.line1, "Power  9/15     ")
  ccunit.eq(seen.line2, "##########......")
  ccunit.eq(seen.arm, { -108, 0, 0 })
end)

ccunit.test("the target's text reaches the display", function()
  ccunit.truthy(seen.copied, source.getLine(4))
end)

ccunit.test("the key switch locks the scroller on the next tick", function()
  ccunit.truthy(seen.locked)
  ccunit.eq(seen.lockedLine, "LOCKED          ")
  ccunit.truthy(seen.unlocked)
  ccunit.truthy(seen.off)
  ccunit.eq(seen.face, 20)
end)

ccunit.test("a bigger display grows the source", function()
  ccunit.truthy(seen.regrown)
  ccunit.eq(seen.bar, ("."):rep(24))
end)

-- ===== every method =====

ccunit.test("types", function()
  ccunit.eq(peripheral.getType("scroller_0"), "scroller")
  ccunit.eq(peripheral.getType("redrouter_0"), "redrouter")
  ccunit.eq(peripheral.getType("create_source_0"), "create_source")
  ccunit.eq(peripheral.getType("create_target_0"), "create_target")
  ccunit.eq(peripheral.getType("animatronic_0"), "animatronic")
end)

ccunit.test("animatronic", function()
  puppet.setFace("question")
  ccunit.eq(err(puppet.setFace, "angry"), "Given string must be either 'normal', 'happy', 'question' or 'sad'")
  ccunit.eq(err(puppet.setFace, "Happy"), "Given string must be either 'normal', 'happy', 'question' or 'sad'")
  ccunit.eq(err(puppet.setFace), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(puppet.setFace, 1), "bad argument #1 (string expected, got number)")
  puppet.setHeadRot(10, 500, -500)
  ccunit.eq({ puppet.getStoredHeadRot() }, { 10, 180, -180 })
  puppet.setBodyRot(400, 0.1, 0)
  local x, y = puppet.getStoredBodyRot()
  ccunit.eq(x, 360)
  ccunit.truthy(math.abs(y - 0.1) < 1e-6 and y ~= 0.1, "a float, not the double: " .. y)
  puppet.setLeftArmRot(-30, 0, 0)
  puppet.setRightArmRot(45, 0, 5)
  ccunit.eq({ puppet.getStoredLeftArmRot() }, { -30, 0, 0 })
  ccunit.eq({ puppet.getStoredRightArmRot() }, { 45, 0, 5 })
  ccunit.eq(err(puppet.setHeadRot, 1, 2), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(puppet.setBodyRot, "x", 2, 3), "bad argument #1 (number expected, got string)")
  puppet.push()
  ccunit.eq({ puppet.getStoredHeadRot() }, { 0, 0, 0 }) -- pushing clears what was stored
  ccunit.eq({ puppet.getAppliedHeadRot() }, { 10, 180, -180 })
  local bx = puppet.getAppliedBodyRot()
  ccunit.eq(bx, 0) -- Rotations takes 360 modulo 360
  ccunit.eq({ puppet.getAppliedLeftArmRot() }, { -30, 0, 0 })
  ccunit.eq({ puppet.getAppliedRightArmRot() }, { 45, 0, 5 })
  ccunit.eq(puppet.setTransition, nil) -- 1.7.x only
end)

ccunit.test("redrouter", function()
  router.setOutput("left", true)
  ccunit.eq(router.getOutput("left"), true)
  ccunit.eq(router.getAnalogOutput("LEFT"), 15) -- sides ignore case
  router.setAnalogueOutput("top", 7)
  ccunit.eq(router.getAnalogueOutput("top"), 7)
  ccunit.eq(router.getOutput("bottom"), false)
  ccunit.eq(err(router.setAnalogOutput, "top", 16), "Expected number in range 0-15")
  ccunit.eq(err(router.setAnalogOutput, "top", -1), "Expected number in range 0-15")
  router.setAnalogOutput("top", 3.9) -- getInt truncates
  ccunit.eq(router.getAnalogOutput("top"), 3)
  ccunit.eq(err(router.setOutput, "up", true), "bad argument #1 (unknown option up)")
  ccunit.eq(err(router.setOutput, "top"), "bad argument #2 (boolean expected, got nil)")
  ccunit.eq(err(router.getInput), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(router.setAnalogOutput, "top", 0 / 0), "bad argument #2 (number expected, got nan)")
  sim({ cmd = "cccbSetInput", peripheral = "redrouter_0", side = "north", level = 6 }) -- facing east: north is left
  ccunit.eq(router.getAnalogInput("left"), 6)
  ccunit.eq(router.getAnalogueInput("left"), 6)
  ccunit.eq(router.getInput("left"), true)
  ccunit.eq(router.getInput("right"), false)
end)

ccunit.test("scroller", function()
  ccunit.eq(scroller.getLimit(), 15)
  scroller.setLimit(-300)
  ccunit.eq(scroller.getLimit(), 200)
  scroller.setLimit(0)
  ccunit.eq(scroller.getLimit(), 1)
  scroller.setLimit(20)
  -- 1.5.1's setValue fires scroller_changed at the computer too: the value in a table after the name
  scroller.setValue(-25) -- clamped to -limit even without the minus spectrum
  ccunit.eq(scroller.getValue(), -20)
  local ev, name, args = os.pullEvent("scroller_changed")
  ccunit.eq({ ev, name, args }, { "scroller_changed", "scroller_0", { -20 } })
  ccunit.eq(scroller.hasMinusSpectrum(), false)
  scroller.toggleMinusSpectrum(true)
  ccunit.eq(scroller.hasMinusSpectrum(), true)
  scroller.setValue(4)
  ev, name, args = os.pullEvent("scroller_changed")
  ccunit.eq(args, { 4 })
  scroller.setLock(true) -- the block state follows on the next server tick
  sleep(0.1)
  ccunit.eq(scroller.isLocked(), true)
  scroller.setLock(false)
  ccunit.eq(err(scroller.setLock), "bad argument #1 (boolean expected, got nil)")
  ccunit.eq(err(scroller.setValue, "x"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(scroller.setLimit), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(scroller.toggleMinusSpectrum, 1), "bad argument #1 (boolean expected, got number)")
end)

ccunit.test("create_source", function()
  sim({ cmd = "cccbLinkSource", peripheral = "create_source_0", linked = false })
  source.clear()
  source.setCursorPos(3, 2)
  source.write("hi")
  ccunit.eq({ source.getCursorPos() }, { 5, 2 })
  ccunit.eq(source.getLine(2), "  hi" .. (" "):rep(20))
  source.scroll(1)
  ccunit.eq(source.getLine(1), "  hi" .. (" "):rep(20))
  source.setCursorPos(1, 1)
  source.clearLine()
  ccunit.eq(source.getLine(1), (" "):rep(24))
  ccunit.eq({ source.getSize() }, { 24, 5 })
  ccunit.eq(err(source.getLine, 0), "Expected number in range 1-5")
  ccunit.eq(err(source.getLine, 6), "Expected number in range 1-5")
  ccunit.eq(err(source.write, 5), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(source.setCursorPos, 1), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(source.scroll), "bad argument #1 (number expected, got nil)")
  source.setCursorPos(-2, 1)
  source.write("abcdef") -- what falls left of the screen is cut
  ccunit.eq(source.getLine(1):sub(1, 4), "def ")
end)

ccunit.test("create_target", function()
  ccunit.eq({ target.getSize() }, { 32, 24 })
  ccunit.eq(target.getLine(1), "Stress 42% " .. (" "):rep(21)) -- each piece gets a space after it
  target.setWidth(40)
  ccunit.eq({ target.getSize() }, { 40, 16 }) -- setWidth always makes it 16 high
  ccunit.eq(err(target.setWidth, 0), "Expected number in range 1-164")
  ccunit.eq(err(target.setWidth, 165), "Expected number in range 1-164")
  sim({ cmd = "cccbLinkTarget", peripheral = "create_target_0", line = 2, lines = { "a", "b" } })
  ccunit.eq(target.getLine(2):sub(1, 3), "a  ")
  ccunit.eq(target.getLine(3):sub(1, 2), "b ")
  target.clearLine(2)
  ccunit.eq(target.getLine(2), (" "):rep(40))
  target.clearLine(99) -- out of range: nothing
  target.clear()
  ccunit.eq(target.getLine(3), (" "):rep(40))
  ccunit.eq(err(target.getLine, 17), "Expected number in range 1-16")
  ccunit.eq(err(target.clearLine), "bad argument #1 (number expected, got nil)")
end)
