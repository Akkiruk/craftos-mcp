-- XP station: bottles the experience an XP collector gathers, and opens for staff cards.
-- Peripherals (More Peripherals 1.20.1-1.13.0): an xp_collector, an xp_bottler, a chest of glass bottles,
-- a chest for the bottles of experience and a magnetic_card_manipulator by the door.
local collector = peripheral.find("xp_collector")
local bottler = peripheral.find("xp_bottler")
local reader = peripheral.find("magnetic_card_manipulator")
local BOTTLES, OUTPUT = "minecraft:chest_0", "minecraft:chest_1"
local STAFF = "staff"

local function bottled()
  local n = 0
  for _, item in pairs(peripheral.call(OUTPUT, "list")) do
    if item.name == "minecraft:experience_bottle" then n = n + item.count end
  end
  return n
end

local function status(text)
  print(("[%s] xp %d, bottled %d: %s"):format(textutils.formatTime(os.time(), true), collector.getCurrentXP(), bottled(), text))
end

status("station up")
local timer = os.startTimer(1)
while true do
  local event, data = os.pullEvent()
  if event == "timer" and data == timer then
    if collector.getCurrentXP() >= 8 then
      local ok, err = bottler.bottleXP(BOTTLES, OUTPUT, peripheral.getName(collector))
      status(ok and "bottled" or ("cannot bottle: " .. tostring(err)))
    end
    timer = os.startTimer(1)
  elseif event == "card_read" then
    if data == STAFF then status("door open for staff") else status("card refused") end
  elseif event == "card_insert" then
    local text = reader.readCard()
    status("card in: " .. reader.getLabel() .. " (" .. text .. ")")
  end
end
