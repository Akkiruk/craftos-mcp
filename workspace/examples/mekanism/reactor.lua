-- Mekanism fission reactor controller with an automatic scram.
--
-- Needs a Fission Reactor Logic Adapter (Mekanism Generators) and an advanced or normal monitor.
-- The reactor is scrammed the moment it runs too hot, takes damage or fills with waste, and stays
-- off until someone presses RESET on the monitor (and the reactor is safe). Low coolant only turns
-- the status line into a warning: it is the temperature that does the harm.
--
-- Usage: reactor [monitor_name]

local args = { ... }

-- Safety limits. Mekanism starts damaging the casing at 1200 K; scram well before that.
local LIMITS = {
  temperature = 1000, -- kelvin
  damage = 5,         -- percent
  coolant = 10,       -- warn when the coolant tank drops below this percent
  waste = 90,         -- scram if the waste tank rises above this percent
}
local REFRESH = 0.2     -- seconds between readings
local SAFE_RESET = 600  -- kelvin: RESET only works below this

local reactor = peripheral.find("fissionReactorLogicAdapter")
if not reactor then error("no fission reactor logic adapter found", 0) end
local monitor = args[1] and peripheral.wrap(args[1]) or peripheral.find("monitor")
if not monitor then error("no monitor found", 0) end

local state = {
  data = nil,        -- the latest readings
  scrammed = false,  -- true once the controller has shut the reactor down
  reason = nil,      -- why
  message = nil,     -- last feedback for the operator
}

--- Read everything the dashboard shows. Each call waits a server tick, so this runs in its own
--- coroutine (see parallel below) and never blocks the touch handling.
local function readReactor()
  return {
    status = reactor.getStatus(),
    temperature = reactor.getTemperature(),
    damage = reactor.getDamagePercent(),
    coolant = reactor.getCoolantFilledPercentage(),
    fuel = reactor.getFuelFilledPercentage(),
    waste = reactor.getWasteFilledPercentage(),
    burn = reactor.getActualBurnRate(),
  }
end

--- Returns the reason to scram, or nil when everything is within limits.
local function dangerOf(d)
  if d.temperature >= LIMITS.temperature then
    return ("temperature %d K"):format(d.temperature)
  elseif d.damage >= LIMITS.damage then
    return ("damage %d%%"):format(d.damage)
  elseif d.waste * 100 > LIMITS.waste then
    return "waste tank full"
  end
end

local function scram(reason)
  state.scrammed, state.reason = true, reason
  pcall(reactor.scram) -- fails if it was already off; that is fine
end

local function poll()
  while true do
    local d = readReactor()
    state.data = d
    local reason = dangerOf(d)
    if reason and not state.scrammed then scram(reason) end
    os.queueEvent("reactor_update")
    sleep(REFRESH)
  end
end

-- Drawing ------------------------------------------------------------------------------------

--- A horizontal bar `width` cells wide filled to `fraction`, coloured by `colour`.
local function bar(y, x, width, fraction, colour)
  local filled = math.floor(math.max(0, math.min(1, fraction)) * width + 0.5)
  monitor.setCursorPos(x, y)
  monitor.setBackgroundColor(colour)
  monitor.write((" "):rep(filled))
  monitor.setBackgroundColor(colors.gray)
  monitor.write((" "):rep(width - filled))
end

local function gauge(y, label, fraction, text, colour)
  local w = monitor.getSize()
  local barWidth = w - 9 - 8
  monitor.setBackgroundColor(colors.black)
  monitor.setTextColor(colors.lightGray)
  monitor.setCursorPos(1, y)
  monitor.write(label)
  bar(y, 9, barWidth, fraction, colour)
  monitor.setBackgroundColor(colors.black)
  monitor.setTextColor(colors.white)
  monitor.setCursorPos(9 + barWidth + 1, y)
  monitor.write(text)
end

local resetButton = { x1 = 0, x2 = 0, y = 0 }

local function draw()
  local d = state.data
  local w, h = monitor.getSize()
  monitor.setBackgroundColor(colors.black)
  monitor.clear()

  monitor.setBackgroundColor(colors.blue)
  monitor.setTextColor(colors.white)
  monitor.setCursorPos(1, 1)
  monitor.write((" FISSION REACTOR" .. (" "):rep(w)):sub(1, w))
  if not d then return end

  -- Status line
  local text, colour
  if state.scrammed then
    text, colour = "SCRAMMED: " .. state.reason, colors.red
  elseif d.status and d.coolant * 100 < LIMITS.coolant then
    text, colour = "RUNNING - LOW COOLANT", colors.orange
  elseif d.status then
    text, colour = "RUNNING", colors.lime
  else
    text, colour = "OFF", colors.yellow
  end
  monitor.setBackgroundColor(colors.black)
  monitor.setTextColor(colour)
  monitor.setCursorPos(1, 3)
  monitor.write(text:sub(1, w))

  -- Gauges; the temperature bar is green, yellow, then red as it nears the limit
  local hot = d.temperature / LIMITS.temperature
  local heat = hot > 0.9 and colors.red or hot > 0.7 and colors.orange or colors.lime
  local gap = h >= 18 and 2 or 1 -- a tall monitor gets a blank row between the gauges
  gauge(5, "TEMP", hot, ("%d K"):format(d.temperature), heat)
  gauge(5 + gap, "DAMAGE", d.damage / 100, ("%d%%"):format(d.damage), colors.red)
  gauge(5 + 2 * gap, "COOLANT", d.coolant, ("%d%%"):format(d.coolant * 100), colors.lightBlue)
  gauge(5 + 3 * gap, "FUEL", d.fuel, ("%d%%"):format(d.fuel * 100), colors.yellow)
  gauge(5 + 4 * gap, "WASTE", d.waste, ("%d%%"):format(d.waste * 100), colors.brown)

  monitor.setBackgroundColor(colors.black)
  monitor.setTextColor(colors.lightGray)
  monitor.setCursorPos(1, 6 + 5 * gap)
  monitor.write(("Burn %.1f mB/t"):format(d.burn))

  -- Reset button, along the bottom
  resetButton = { x1 = 1, x2 = 9, y = h }
  monitor.setCursorPos(1, h)
  monitor.setBackgroundColor(state.scrammed and colors.orange or colors.gray)
  monitor.setTextColor(colors.black)
  monitor.write(" RESET   ")
  if state.message then
    monitor.setBackgroundColor(colors.black)
    monitor.setTextColor(colors.lightGray)
    monitor.setCursorPos(11, h)
    monitor.write(state.message:sub(1, w - 10))
  end
end

--- RESET: switch the reactor back on, but only once it is cool and undamaged.
local function reset()
  local d = state.data
  if not state.scrammed then
    state.message = "already running"
  elseif d.temperature > SAFE_RESET then
    state.message = "still too hot"
  elseif d.damage > 0 then
    state.message = "damaged"
  else
    local ok, err = pcall(reactor.activate)
    if ok then
      state.scrammed, state.reason, state.message = false, nil, "restarted"
    else
      state.message = tostring(err):sub(1, 20)
    end
  end
end

local function ui()
  while true do
    local event, a, x, y = os.pullEvent()
    if event == "monitor_touch" and y == resetButton.y and x >= resetButton.x1 and x <= resetButton.x2 then
      reset()
      draw()
    elseif event == "reactor_update" then
      draw()
    end
  end
end

monitor.setTextScale(1)
parallel.waitForAny(poll, ui)
