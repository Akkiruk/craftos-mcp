-- Runs train_board.lua against three stations (train_board.world.json, 6x2 monitor "top") and
-- brings a train in with sim commands, checking what the board shows at each step.

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

--- The board line of one platform ("" when it is not listed).
local function rowOf(platform)
  for line in screenText():gmatch("[^\n]+") do
    if line:sub(1, #platform) == platform then return line end
  end
  return ""
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(2) -- the board redraws every second
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.5) end
  return condition()
end

local seen = {}

local function scenario()
  sleep(2)
  seen.idle = rowOf("Central")
  seen.mine = rowOf("Mine")
  sim({ cmd = "createTrainApproach", train = "Harvest", station = "Central", distance = 300 })
  seen.expected = rowOf("Central")
  -- the train drives in
  waitFor(function() return rowOf("Central"):find("AT PLATFORM", 1, true) end, 200)
  seen.arrived = rowOf("Central")
  sim({ cmd = "createTrainLeave", train = "Harvest" })
  seen.left = rowOf("Central")
end

parallel.waitForAny(function() shell.run("examples/create/train_board.lua") end, scenario)

ccunit.test("the board lists every station", function()
  ccunit.truthy(seen.idle:find("NO TRAIN", 1, true), seen.idle)
  ccunit.truthy(seen.mine:find("Ore Express", 1, true), seen.mine)
  ccunit.truthy(seen.mine:find("AT PLATFORM", 1, true), seen.mine)
end)

ccunit.test("it follows a train as it approaches and arrives", function()
  ccunit.truthy(seen.expected:find("EXPECTED", 1, true) or seen.expected:find("ARRIVING", 1, true), seen.expected)
  ccunit.truthy(seen.arrived:find("Harvest", 1, true), seen.arrived)
  ccunit.truthy(seen.arrived:find("AT PLATFORM", 1, true), seen.arrived)
  ccunit.truthy(seen.arrived:find("Farm > Central > Mine", 1, true), seen.arrived)
end)

ccunit.test("the platform clears when the train leaves", function()
  ccunit.truthy(not seen.left:find("Harvest", 1, true), seen.left)
end)
