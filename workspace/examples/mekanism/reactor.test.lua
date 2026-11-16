-- Runs reactor.lua against a reactor with an empty coolant tank (reactor.world.json, 3x2 monitor "top"),
-- lets it heat with the simulated clock, and checks the controller scrams it before it takes
-- damage, shows that on the monitor, refuses RESET while hot and restarts it once it has cooled.

local reactor = peripheral.find("fissionReactorLogicAdapter")
local realMonitor = peripheral.find("monitor")
local monitorName = peripheral.getName(realMonitor)

-- The program draws on a window over the monitor, so the test can read back what is on screen.
local width, height = realMonitor.getSize()
local screen = window.create(realMonitor, 1, 1, width, height)
screen.setTextScale = realMonitor.setTextScale
local find = peripheral.find
peripheral.find = function(kind, ...)
  if kind == "monitor" then return screen end
  return find(kind, ...)
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

--- Wait (up to `limit` seconds) until `condition()` is true.
local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.25) end
end

--- The temperature the dashboard shows, in kelvin.
local function shownTemperature()
  return tonumber(screenText():match("TEMP%s+(%d+) K")) or math.huge
end

local function pressReset()
  os.queueEvent("monitor_touch", monitorName, 3, height)
  sleep(0.5)
end

local seen = {}

local function scenario()
  waitFor(function() return screenText():find("RUNNING", 1, true) end, 60)
  seen.runningScreen = screenText()
  seen.runningStatus = reactor.getStatus()

  -- Let it heat until the controller shuts it down
  local started = os.clock()
  seen.peakTemperature, seen.peakDamage = 0, 0
  while reactor.getStatus() and os.clock() - started < 300 do
    sleep(0.5)
    seen.peakTemperature = math.max(seen.peakTemperature, reactor.getTemperature())
    seen.peakDamage = math.max(seen.peakDamage, reactor.getDamagePercent())
  end
  seen.scrammedAfter = os.clock() - started
  seen.scrammedStatus = reactor.getStatus()
  waitFor(function() return screenText():find("SCRAMMED", 1, true) end, 60)
  seen.scrammedScreen = screenText()

  -- RESET while hot does nothing
  waitFor(function() return shownTemperature() > 900 end, 60)
  pressReset()
  seen.hotResetStatus = reactor.getStatus()
  seen.hotResetScreen = screenText()

  -- Pipe in coolant; the reactor cools down and RESET works
  sim({ cmd = "mekAddTank", multiblock = "reactor", tank = "coolant", amount = 2000000 })
  local cooling = os.clock()
  while reactor.getTemperature() > 550 and os.clock() - cooling < 600 do sleep(1) end
  waitFor(function() return shownTemperature() <= 550 end, 120) -- the controller has read it too
  seen.cooledTemperature = reactor.getTemperature()
  pressReset()
  seen.resetStatus = reactor.getStatus()
end

parallel.waitForAny(function() shell.run("examples/mekanism/reactor.lua") end, scenario)

ccunit.test("it shows the reactor running", function()
  ccunit.truthy(seen.runningStatus, "reactor was not running")
  ccunit.truthy(seen.runningScreen:find("FISSION REACTOR", 1, true))
  ccunit.truthy(seen.runningScreen:find("RUNNING - LOW COOLANT", 1, true), seen.runningScreen)
end)

ccunit.test("it scrams the overheating reactor before any damage", function()
  ccunit.eq(seen.scrammedStatus, false)
  ccunit.truthy(seen.scrammedAfter < 300, "never scrammed")
  ccunit.truthy(seen.peakTemperature < 1200, "reached " .. seen.peakTemperature .. " K")
  ccunit.eq(seen.peakDamage, 0)
  ccunit.truthy(seen.scrammedScreen:find("SCRAMMED: temperature", 1, true))
end)

ccunit.test("RESET refuses while the reactor is hot", function()
  ccunit.eq(seen.hotResetStatus, false)
  ccunit.truthy(seen.hotResetScreen:find("still too hot", 1, true))
end)

ccunit.test("RESET restarts it after it has cooled", function()
  ccunit.truthy(seen.cooledTemperature <= 550, "still " .. seen.cooledTemperature .. " K")
  ccunit.eq(seen.resetStatus, true)
end)
