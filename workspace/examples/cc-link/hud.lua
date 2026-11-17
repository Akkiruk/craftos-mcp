-- hud.lua: a HUD for a CC: Link core. Shows your health and food and the mobs near you on the overlay, eats when
-- you are hungry, and mirrors it all on the computer's own screen.
--
-- Needs the overlay, sensor and introspection upgrades in the Link core. Each pass asks for a fresh set of upgrade
-- functions: an overlay table remembers every element it was ever given and sends them all again on each send().

local function pad(s, n) return (s .. (" "):rep(n)):sub(1, n) end

local function pass()
  local up = link.getUpgradeFunctions()
  if not (up.overlay and up.sensor and up.introspection) then
    error("this HUD needs the overlay, sensor and introspection upgrades", 0)
  end
  local info = link.getInfo()

  -- eat something when hungry: the first food in the hotbar
  if info.isHungry then
    for slot = 1, 9 do
      local ok = link.consume(slot)
      if ok then break end
    end
    info = link.getInfo()
  end

  local mobs = up.sensor.sense(8)
  local lines = {
    ("HP %d  Food %d"):format(info.health, info.hunger),
  }
  if type(mobs) == "table" then
    for _, m in ipairs(mobs) do
      if m.id ~= "minecraft:player" then lines[#lines + 1] = (m.baby and "baby " or "") .. m.name end
    end
  end

  local o = up.overlay
  o.clearAll()
  for i, line in ipairs(lines) do
    o.addOrUpdateTextElement("line" .. i, line, 4, 4 + (i - 1) * 10, 0xFFFFFF, 1)
  end
  o.addOrUpdateRectElement("bar", 2, 2, 120, 2 + #lines * 10, 0x000000, 128)
  o.send()

  term.clear()
  term.setCursorPos(1, 1)
  print("LINK HUD - " .. info.name)
  for _, line in ipairs(lines) do print(pad(line, 30)) end
end

while true do
  pass()
  sleep(2.5) -- the sensor has a 2 s cooldown
end
