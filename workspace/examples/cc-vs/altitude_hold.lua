-- Altitude hold for a Valkyrien Skies airship (CC: VS 0.6.6, Minecraft 1.20.1).
-- Runs on a command computer on the ship (CC: VS's force methods need one by default). It shows the ship's state
-- and pushes it up or down towards a target height with a world-space force: a plain P controller with damping.
--
--   altitude_hold [targetY]

local target = tonumber(... or "") or 120
local GAIN, DAMPING = 2.0, 4.0 -- newtons per kg per block, per block/s

local function heading(q)
  -- yaw of the ship's forward axis (+Z in the shipyard), in degrees
  local fx = 2 * (q.v.x * q.v.z + q.a * q.v.y)
  local fz = 1 - 2 * (q.v.x * q.v.x + q.v.y * q.v.y)
  return math.deg(math.atan2(fx, fz)) % 360
end

local function draw(pos, vel, push)
  term.clear()
  term.setCursorPos(1, 1)
  print(("SHIP %s (#%d)"):format(ship.getSlug(), ship.getId()))
  print(("Altitude %6.1f  target %d"):format(pos.y, target))
  print(("Climb    %6.2f b/s"):format(vel.y))
  print(("Heading  %5.1f deg"):format(heading(ship.getQuaternion())))
  print(("Mass     %.0f kg"):format(ship.getMass()))
  print(ship.isStatic() and "STATIC: frozen in place" or ("Push     %8.1f N"):format(push))
end

while true do
  local pos, vel = ship.getWorldspacePosition(), ship.getVelocity()
  local push = 0
  if not ship.isStatic() then
    push = ship.getMass() * (GAIN * (target - pos.y) - DAMPING * vel.y)
    ship.applyWorldForce(vector.new(0, push, 0))
  end
  draw(pos, vel, push)
  sleep(0.5)
end
