-- Power monitor for any blocks that store energy (Forge Energy), from any mod.
--
-- Every block CC:Tweaked can read energy from has the generic "energy_storage" peripheral type, so
-- this works with batteries, energy cells, matrices and machines from any mod without extra code.
-- It lists them on a monitor with a fill bar and the charge or discharge rate, shows the total with
-- an estimate of when it runs empty or full, and raises a redstone signal when the total is low.
--
-- Usage: power_monitor [monitor_name] [alarm_side]

local args = { ... }
local ALARM_BELOW = 0.25 -- fraction of the total capacity
local ALARM_SIDE = args[2] or "top"
local REFRESH = 1        -- seconds between readings

local monitor = args[1] and peripheral.wrap(args[1]) or peripheral.find("monitor")
if not monitor then error("no monitor found", 0) end
monitor.setTextScale(1)

local previous = {} -- name -> { energy, time } from the last reading

--- Read every energy block once. Returns a list sorted by name and the clock it was read at.
local function readAll()
  local list = {}
  for _, name in ipairs(peripheral.getNames()) do
    if peripheral.hasType(name, "energy_storage") then
      local capacity = peripheral.call(name, "getEnergyCapacity")
      -- Each call waits for a server tick, so take the time right after the reading it belongs to
      local energy = peripheral.call(name, "getEnergy")
      local now = os.epoch("ingame") / 3600 -- game time in server ticks (3600 in-game ms each)
      local entry = { name = name, energy = energy, capacity = capacity }
      -- The rate is the change since the last reading, per tick
      local before = previous[name]
      if before and now > before.time then
        entry.rate = (energy - before.energy) / (now - before.time)
      end
      previous[name] = { energy = energy, time = now }
      list[#list + 1] = entry
    end
  end
  table.sort(list, function(a, b) return a.name < b.name end)
  return list
end

--- 12345 -> "12.3k", 2500000 -> "2.50M".
local function short(n)
  local sign = n < 0 and "-" or ""
  n = math.abs(n)
  if n >= 1e6 then return ("%s%.2fM"):format(sign, n / 1e6) end
  if n >= 1e3 then return ("%s%.1fk"):format(sign, n / 1e3) end
  return ("%s%d"):format(sign, n)
end

local function rateText(rate)
  if not rate then return "..." end
  if math.abs(rate) < 0.5 then return "idle" end
  return ("%s%s FE/t"):format(rate > 0 and "+" or "", short(rate))
end

--- Green when full enough, then yellow, then red.
local function fillColour(fraction)
  if fraction < ALARM_BELOW then return colors.red end
  if fraction < 0.5 then return colors.yellow end
  return colors.lime
end

local function bar(y, width, fraction, colour)
  local filled = math.floor(math.max(0, math.min(1, fraction)) * width + 0.5)
  monitor.setCursorPos(1, y)
  monitor.setBackgroundColor(colour)
  monitor.write((" "):rep(filled))
  monitor.setBackgroundColor(colors.gray)
  monitor.write((" "):rep(width - filled))
  monitor.setBackgroundColor(colors.black)
end

--- "empty in 2m 05s" or "full in 40s" from the net rate, or nil when nothing is changing.
local function eta(energy, capacity, rate)
  if not rate or math.abs(rate) < 0.5 then return nil end
  local ticks = rate > 0 and (capacity - energy) / rate or energy / -rate
  local seconds = math.floor(ticks / 20)
  local text = seconds >= 60 and ("%dm %02ds"):format(seconds / 60, seconds % 60) or seconds .. "s"
  return (rate > 0 and "full in " or "empty in ") .. text
end

local function draw(list)
  local width, height = monitor.getSize()
  monitor.setBackgroundColor(colors.black)
  monitor.clear()
  monitor.setBackgroundColor(colors.blue)
  monitor.setTextColor(colors.white)
  monitor.setCursorPos(1, 1)
  monitor.write((" POWER" .. (" "):rep(width)):sub(1, width))
  monitor.setBackgroundColor(colors.black)

  local total, totalCapacity, totalRate = 0, 0, nil
  local y = 3
  for _, entry in ipairs(list) do
    total = total + entry.energy
    totalCapacity = totalCapacity + entry.capacity
    if entry.rate then totalRate = (totalRate or 0) + entry.rate end

    local fraction = entry.capacity > 0 and entry.energy / entry.capacity or 0
    if y + 1 <= height - 3 then
      monitor.setTextColor(colors.white)
      monitor.setCursorPos(1, y)
      monitor.write(entry.name:sub(1, width - 17))
      local right = ("%3d%% %s"):format(fraction * 100, rateText(entry.rate))
      monitor.setTextColor(colors.lightGray)
      monitor.setCursorPos(width - #right + 1, y)
      monitor.write(right)
      bar(y + 1, width, fraction, fillColour(fraction))
    end
    y = y + 3
  end

  -- Totals along the bottom
  local fraction = totalCapacity > 0 and total / totalCapacity or 0
  monitor.setTextColor(colors.white)
  monitor.setCursorPos(1, height - 2)
  monitor.write(("TOTAL %s / %s FE"):format(short(total), short(totalCapacity)))
  monitor.setTextColor(colors.lightGray)
  monitor.setCursorPos(1, height - 1)
  monitor.write(rateText(totalRate) .. "  " .. (eta(total, totalCapacity, totalRate) or ""))
  bar(height, width, fraction, fillColour(fraction))
  return fraction
end

while true do
  local list = readAll()
  local fraction = draw(list)
  redstone.setOutput(ALARM_SIDE, fraction < ALARM_BELOW)
  sleep(REFRESH)
end
