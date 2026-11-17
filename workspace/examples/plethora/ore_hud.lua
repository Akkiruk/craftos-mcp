-- ore_hud.lua: a neural interface heads-up display (Plethora Peripherals).
--
-- Needs the block scanner, entity sensor, introspection and overlay glasses modules; a laser is optional.
-- Every second it scans the blocks around you for ores and the mobs around you, and draws both on the
-- glasses with your health. With a laser it shoots any hostile mob that comes within GUARD blocks.
-- Run "ore_hud once" for a single refresh.

local ni = peripheral.wrap("back")
if not ni or not ni.hasModule then error("ore_hud needs a neural interface on its back", 0) end
for _, m in ipairs({ "plethora:scanner", "plethora:sensor", "plethora:introspection", "plethora:glasses" }) do
  if not ni.hasModule(m) then error("ore_hud needs the " .. m .. " module", 0) end
end
local hasLaser = ni.hasModule("plethora:laser")

local GUARD = 6
local HOSTILE = { ["minecraft:zombie"] = true, ["minecraft:skeleton"] = true, ["minecraft:creeper"] = true, ["minecraft:spider"] = true }

local function isOre(name) return name:find("_ore$") ~= nil end

local canvas = ni.canvas()
canvas.clear()
local panel = canvas.addGroup({ 4, 4 })
panel.addRectangle(0, 0, 150, 70, 0x00000080)
local title = panel.addText({ 3, 3 }, "", 0xFFFFFFFF)
local oreLine = panel.addText({ 3, 15 }, "", 0x55FFFFFF)
local mobLines = {}
for i = 1, 4 do mobLines[i] = panel.addText({ 3, 15 + i * 10 }, "", 0xFF5555FF) end

local function refresh()
  local me = ni.getMetaOwner()
  title.setText(("%s  %d/%d hp"):format(ni.getName(), me.health, me.maxHealth))

  local ores, nearest = 0, nil
  for _, b in ipairs(ni.scan()) do
    if isOre(b.name) then
      ores = ores + 1
      local d = math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z)
      if not nearest or d < nearest.d then nearest = { d = d, name = b.name } end
    end
  end
  oreLine.setText(nearest and ("%d ores, nearest %s %.1fm"):format(ores, (nearest.name:gsub("^minecraft:", "")), nearest.d) or "no ores")

  local mobs = {}
  for _, e in ipairs(ni.sense()) do
    if e.key ~= "minecraft:player" then
      e.d = math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z)
      mobs[#mobs + 1] = e
    end
  end
  table.sort(mobs, function(a, b) return a.d < b.d end)
  for i = 1, #mobLines do
    local e = mobs[i]
    mobLines[i].setText(e and ("%s %.1fm"):format(e.displayName, e.d) or "")
  end

  local shots = 0
  if hasLaser then
    for _, e in ipairs(mobs) do
      if HOSTILE[e.key] and e.d <= GUARD then
        -- aim at the mob's eyes: Minecraft's yaw is measured from south, turning west
        local yaw = math.deg(math.atan2(-e.x, e.z))
        local pitch = -math.deg(math.atan2(e.y, math.sqrt(e.x * e.x + e.z * e.z)))
        ni.fire(yaw, pitch, 2)
        shots = shots + 1
      end
    end
  end

  term.clear()
  term.setCursorPos(1, 1)
  print(("ores: %d  mobs: %d  shots: %d"):format(ores, #mobs, shots))
  if nearest then print("nearest ore: " .. nearest.name) end
end

local once = ... == "once"
repeat
  refresh()
  if not once then sleep(1) end
until once
