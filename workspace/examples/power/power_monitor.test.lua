-- Runs power_monitor.lua against three energy blocks (power_monitor.world.json, 4x3 monitor "top")
-- where one battery drains faster than the others charge: the dashboard must show the rates and
-- raise the low-power redstone alarm once the total falls under a quarter.

local realMonitor = peripheral.find("monitor")
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

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.25) end
end

local seen = {}

local function scenario()
  waitFor(function() return screenText():find("FE/t", 1, true) end, 20)
  seen.early = screenText()
  seen.earlyAlarm = redstone.getOutput("top")
  -- 105k of 250k at -150 FE/t: under 25% after about 14 s
  waitFor(function() return redstone.getOutput("top") end, 120)
  seen.alarm = redstone.getOutput("top")
  seen.late = screenText()
end

parallel.waitForAny(function() shell.run("examples/power/power_monitor.lua") end, scenario)

ccunit.test("it lists every energy block with its rate", function()
  ccunit.truthy(seen.early:find("battery_0", 1, true), seen.early)
  ccunit.truthy(seen.early:find("energy_cell_0", 1, true), seen.early)
  ccunit.truthy(seen.early:find("machine_0", 1, true), seen.early)
  ccunit.truthy(seen.early:find("%-[12]%d%d FE/t"), seen.early)
  ccunit.truthy(seen.early:find("%+[3-7]%d FE/t"), seen.early)
  ccunit.truthy(seen.early:find("idle", 1, true), seen.early)
end)

ccunit.test("it adds up the total and predicts when it runs empty", function()
  ccunit.truthy(seen.early:find("TOTAL %d+%.%dk / 250.0k FE"), seen.early)
  ccunit.truthy(seen.early:find("empty in", 1, true), seen.early)
end)

ccunit.test("the low-power alarm stays off, then comes on", function()
  ccunit.eq(seen.earlyAlarm, false)
  ccunit.eq(seen.alarm, true)
  ccunit.truthy(seen.late:find("%f[%d]2%d%%") or seen.late:find("%f[%d]1%d%%"), seen.late)
end)
