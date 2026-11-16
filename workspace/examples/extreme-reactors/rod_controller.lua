-- Extreme Reactors control rod controller for a passively cooled reactor.
--
-- Keeps the reactor's energy buffer around the middle: when the buffer fills up the control rods
-- go in (less power), when it runs low they come out (more power). A monitor shows the buffer, the
-- rod insertion, the output and the fuel temperature.
--
-- Needs a Reactor Computer Port next to (or wired to) the computer, and a monitor.
-- Usage: rod_controller [monitor_name]

local args = { ... }
local LOW, HIGH = 0.20, 0.80 -- rods fully out below LOW of the buffer, fully in above HIGH
local REFRESH = 1            -- seconds between adjustments

local reactor = peripheral.find("BigReactors-Reactor")
if not reactor then error("no Extreme Reactors reactor computer port found", 0) end
local monitor = args[1] and peripheral.wrap(args[1]) or peripheral.find("monitor")
if not monitor then error("no monitor found", 0) end
monitor.setTextScale(1)

--- Rod insertion (0 = fully out, 100 = fully in) for a buffer that is `fill` full (0 to 1).
local function rodsFor(fill)
  local level = (fill - LOW) / (HIGH - LOW) * 100
  return math.floor(math.max(0, math.min(100, level)) + 0.5)
end

local function bar(y, label, fraction, text, colour)
  local width = monitor.getSize()
  local barWidth = width - 8 - 9
  local filled = math.floor(math.max(0, math.min(1, fraction)) * barWidth + 0.5)
  monitor.setBackgroundColor(colors.black)
  monitor.setTextColor(colors.lightGray)
  monitor.setCursorPos(1, y)
  monitor.write(label)
  monitor.setCursorPos(9, y)
  monitor.setBackgroundColor(colour)
  monitor.write((" "):rep(filled))
  monitor.setBackgroundColor(colors.gray)
  monitor.write((" "):rep(barWidth - filled))
  monitor.setBackgroundColor(colors.black)
  monitor.setTextColor(colors.white)
  monitor.setCursorPos(9 + barWidth + 1, y)
  monitor.write(text)
end

local function draw(r)
  local width = monitor.getSize()
  monitor.setBackgroundColor(colors.black)
  monitor.clear()
  monitor.setBackgroundColor(colors.blue)
  monitor.setTextColor(colors.white)
  monitor.setCursorPos(1, 1)
  monitor.write((" REACTOR CONTROL" .. (" "):rep(width)):sub(1, width))

  monitor.setBackgroundColor(colors.black)
  monitor.setCursorPos(1, 3)
  monitor.setTextColor(r.active and colors.lime or colors.red)
  monitor.write(r.active and "ONLINE" or "OFFLINE")

  bar(5, "BUFFER", r.fill, ("%d%%"):format(r.fill * 100), colors.lime)
  bar(6, "RODS", r.rods / 100, ("%d%%"):format(r.rods), colors.orange)
  bar(7, "FUEL", r.fuel, ("%d%%"):format(r.fuel * 100), colors.yellow)

  monitor.setBackgroundColor(colors.black)
  monitor.setTextColor(colors.lightGray)
  monitor.setCursorPos(1, 9)
  monitor.write(("Output %d FE/t"):format(r.output))
  monitor.setCursorPos(1, 10)
  monitor.write(("Fuel temp %d C"):format(r.temperature))
end

while true do
  local capacity = reactor.getEnergyCapacity()
  local reading = {
    active = reactor.getActive(),
    fill = capacity > 0 and reactor.getEnergyStored() / capacity or 0,
    output = reactor.getEnergyProducedLastTick(),
    temperature = reactor.getFuelTemperature(),
    fuel = reactor.getFuelAmount() / math.max(1, reactor.getFuelAmountMax()),
  }
  reading.rods = rodsFor(reading.fill)
  -- Setters are queued for the next server tick and return nothing
  reactor.setAllControlRodLevels(reading.rods)
  draw(reading)
  sleep(REFRESH)
end
