-- Holds a simulated furnace at a target temperature with Advanced Math's PID controller, then reports the run with
-- its stats module. Run it as a program: furnace_pid [target] [steps]
local pid = require("advanced_math.pid")
local stats = require("advanced_math.stats")

local target = tonumber(... or nil) or 800
local steps = tonumber(select(2, ...) or nil) or 60

local controller = pid.new(target, 0.6, 0.05, 0.1)
controller:clampOutput(0, 100) -- the burner runs from 0 to 100 %

local temperature, history = 20, {}
for _ = 1, steps do
  local burner = controller:step(temperature, 1)
  -- the furnace: heats with the burner, loses heat to the room
  temperature = temperature + burner * 0.9 - (temperature - 20) * 0.08
  history[#history + 1] = temperature
end

local tail = { table.unpack(history, math.max(1, #history - 9)) }
print(("target %d, final %.1f"):format(target, history[#history]))
print(("last 10 steps: mean %.1f, stdev %.2f"):format(stats.mean(tail), stats.stdev(tail)))
return history
