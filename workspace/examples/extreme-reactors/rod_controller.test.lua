-- Runs rod_controller.lua against a passively cooled reactor (rod_controller.world.json, 3x2
-- monitor "top") and changes the power demand with sim commands: the controller must pull the
-- rods out when the buffer drains and push them back in as it fills.

local reactor = peripheral.find("BigReactors-Reactor")
local realMonitor = peripheral.find("monitor")
local width, height = realMonitor.getSize()
local screen = window.create(realMonitor, 1, 1, width, height)
screen.setTextScale = realMonitor.setTextScale
-- What the controller decided, with the buffer reading it decided on: the test judges those, not a reading of its
-- own taken whenever a busy host next woke it (on a 20x clock the buffer moves a long way in that time).
local decisions = {}
local lastFill
local controlled = setmetatable({
  getEnergyStored = function()
    local stored = reactor.getEnergyStored()
    lastFill = stored / reactor.getEnergyCapacity()
    return stored
  end,
  setAllControlRodLevels = function(level)
    decisions[#decisions + 1] = { rods = level, fill = lastFill }
    return reactor.setAllControlRodLevels(level)
  end,
}, { __index = reactor })

local find = peripheral.find
peripheral.find = function(kind, ...)
  if kind == "monitor" then return screen end
  if kind == "BigReactors-Reactor" then return controlled end
  return find(kind, ...)
end

--- The first decision from index `from` on that passes `test`, and its index.
local function firstDecision(from, test)
  for i = from, #decisions do
    if test(decisions[i]) then return decisions[i], i end
  end
end

local function screenText()
  local lines = {}
  for y = 1, height do lines[y] = screen.getLine(y) end
  return table.concat(lines, "\n")
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.5) end
  return condition()
end

local function fill() return reactor.getEnergyStored() / reactor.getEnergyCapacity() end
local function rods() return reactor.getControlRodLevel(0) end

local seen = {}

local function scenario()
  waitFor(function() return screenText():find("ONLINE", 1, true) end, 20)
  seen.screen = screenText()
  -- the controller's first decision and the reading it made it on, as below: a busy host can wake this coroutine
  -- after the clock has moved on and the controller has already pulled the rods out
  local first = decisions[1]
  seen.startFill, seen.startRods = first and first.fill or fill(), first and first.rods or rods()

  -- A town switches on: demand far above what the reactor makes. The buffer empties.
  sim({ cmd = "erSetLoad", peripheral = "BigReactors-Reactor_0", rate = 3000 })
  seen.reachedZeroRods = waitFor(function() return rods() == 0 end, 300)
  local out, at = firstDecision(1, function(d) return d.rods == 0 end)
  seen.lowFill = out and out.fill or fill()

  -- Demand stops. The reactor, rods out, fills the buffer again and the rods go back in.
  sim({ cmd = "erSetLoad", peripheral = "BigReactors-Reactor_0", rate = 0 })
  seen.reachedHalfRods = waitFor(function() return rods() >= 50 end, 300)
  local back = firstDecision(at or 1, function(d) return d.rods >= 50 end)
  seen.fillAtHalfRods = back and back.fill or fill()
end

parallel.waitForAny(function() shell.run("examples/extreme-reactors/rod_controller.lua") end, scenario)

ccunit.test("the dashboard shows the reactor", function()
  ccunit.truthy(seen.screen:find("REACTOR CONTROL", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("BUFFER", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("RODS", 1, true), seen.screen)
end)

ccunit.test("a nearly full buffer starts with the rods well inserted", function()
  ccunit.truthy(seen.startFill > 0.6, "buffer " .. seen.startFill)
  ccunit.truthy(seen.startRods > 60, "rods " .. seen.startRods)
end)

ccunit.test("rods come fully out when the buffer drains", function()
  ccunit.truthy(seen.reachedZeroRods, "rods never came out")
  ccunit.truthy(seen.lowFill <= 0.21, "buffer " .. seen.lowFill)
end)

ccunit.test("rods go back in as the buffer refills", function()
  ccunit.truthy(seen.reachedHalfRods, "rods never went back in")
  ccunit.truthy(seen.fillAtHalfRods > 0.4 and seen.fillAtHalfRods < 0.6, "buffer " .. seen.fillAtHalfRods)
end)
