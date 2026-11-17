-- Ore survey: scans the ground around a universal scanner for ores, prints where each one is, and puts the most
-- common ore on a display pedestal. The ultimate sensor says when the survey ran. Retries when the scanner is
-- cooling down.

local scanner = peripheral.find("universal_scanner")
local sensor = peripheral.find("ultimate_sensor")
local pedestal = peripheral.find("display_pedestal")
if not scanner then error("no universal scanner attached", 0) end

-- every scan starts the scanner's cooldown (half a second on a block); the next one waits it out
local function scan(mode, radius, filter)
  while true do
    local found, err = scanner.scan(mode, radius, filter)
    if found then return found end
    if not err:find("cooldown", 1, true) then error(err, 0) end
    sleep(scanner.getCooldown("stationaryUniversalScan") / 1000)
  end
end

local ores = scan("block", 8, { tag = "forge:ores" })
local counts, best = {}, nil
for _, block in ipairs(ores) do
  counts[block.name] = (counts[block.name] or 0) + 1
  print(("%-22s %3d %3d %3d"):format(block.displayName, block.x, block.y, block.z))
end
for name, n in pairs(counts) do
  if not best or n > counts[best] or (n == counts[best] and name < best) then best = name end
end

if sensor then
  local day = sensor.inspect("calendar").day
  print(("Survey done on day %d, weather %s"):format(day, sensor.inspect("weather")))
end

if best then
  print(("Most common: %s (%d)"):format(best, counts[best]))
  if pedestal then pedestal.setItem(best, "Most common ore") end
else
  print("No ores in range")
end

local mobs = scan("entity", 8)
if #mobs > 0 then print(("Watch out: %d mob(s) nearby"):format(#mobs)) end
