-- Porch watch: who is near the front door, what the weather is doing, and what the sculkophone heard.
-- Needs an entity detector, a weather machine, a keyboard and a sculkophone (Ducky Peripherals).
-- Press q on the keyboard to stop.

local detector = peripheral.find("entity_detector")
local weather = peripheral.find("weather_machine")
local keyboard = peripheral.find("keyboard")
local keyboardName = keyboard and peripheral.getName(keyboard)

local log = {}
local function note(line)
  table.insert(log, 1, line)
  while #log > 5 do table.remove(log) end
end

local function sky()
  if weather.isThundering() then return "thunderstorm" end
  if weather.isSnowing() then return "snowing" end
  if weather.isRaining() then return "raining" end
  return "clear"
end

local function draw()
  term.clear()
  term.setCursorPos(1, 1)
  print(("Porch  %s, %s (%.2f)"):format(weather.getBiome(), sky(), weather.getTemperature()))
  local players, others = {}, 0
  for _, e in ipairs(detector.nearbyEntities()) do
    if e.isPlayer then
      players[#players + 1] = ("%s %.0fm"):format(e.name, math.sqrt(e.x * e.x + e.z * e.z))
    else
      others = others + 1
    end
  end
  print("Players: " .. (#players > 0 and table.concat(players, ", ") or "none"))
  print("Mobs: " .. others)
  print()
  for _, line in ipairs(log) do print(line) end
end

draw()
while true do
  local event, a, b, c = os.pullEvent()
  if event == "new_entity" then
    note(b.name .. " arrived")
  elseif event == "removed_entity" then
    note(b.name .. " left")
  elseif event == "vibration" then
    note(("heard %s %.1fm away"):format(b, c))
  elseif event == "char" and b == keyboardName and a == "q" then
    term.clear()
    term.setCursorPos(1, 1)
    print("Porch watch stopped")
    return
  end
  draw()
end
