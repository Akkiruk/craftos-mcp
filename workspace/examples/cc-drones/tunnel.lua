-- CC: Drones: fly straight ahead and break whatever is in the way.
--
-- Usage: tunnel [blocks]   (how many blocks to break before stopping; default 3)
--
-- The drone starts in the air, hovering (left there by a player). Run it in the emulator with tunnel.world.json.
-- It works on CC: Drones 0.0.1 and on CC: Drones+ (which needs the mine upgrade to break).
--
-- Things worth knowing about the mod (docs/cc-drones.md):
--   * hoverOn(true) first, or the drone falls.
--   * engineOn(true) moves it a tenth of a block a tick the way it faces, until engineOn(false).
--   * 0.0.1 tells a program nothing about where it is: all it has is isColliding(), rotation()
--     and what lookForward() and lookBack() see within three blocks.
--   * right(n) and left(n) turn 0.15 degrees for each 1 of n: a quarter turn is 600.

local blocks = tonumber(({ ... })[1]) or 3

term.clear()
term.setCursorPos(1, 1)
print("Drone tunnel: " .. blocks .. " block(s)")

drone.hoverOn(true)
drone.engineOn(true)

local broken = 0
while broken < blocks do
  -- fly until something stops it
  while not drone.isColliding() do sleep(0.1) end
  local name = drone.lookForward().name
  if name == "minecraft:bedrock" then
    print("bedrock: stopping here")
    break
  end
  local ok, why = drone.breakForward()
  if ok == false then
    drone.engineOn(false)
    error(why, 0)
  end
  broken = broken + 1
  print(("%d: %s"):format(broken, name))
  sleep(0.2) -- a few ticks to get moving again
end

sleep(0.5) -- clear of the last block
drone.engineOn(false)
print("stopped; ahead: " .. drone.lookForward().name)
