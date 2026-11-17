-- Turret aim: the radar finds the nearest zombie, the ballistic accelerator works out the pitch that lands a shell
-- on it (a cannon with a 3-block barrel firing at 4 blocks a tick), and the world scanner checks what the shell would
-- hit at the target. Prints the firing solution.

local radar = peripheral.find("sp_radar")
local ballistics = peripheral.find("ballistic_accelerator")
local scanner = peripheral.find("world_scanner")
local CANNON = { 0, 64, 0 } -- where the barrel pivots
local SPEED, BARREL = 4, 3

local nearest, best
for _, thing in ipairs(radar.scanForEntities(128)) do
  if thing.entity_type == "entity.minecraft.zombie" then
    local p = thing.pos
    local d = math.sqrt((p[1] - CANNON[1]) ^ 2 + (p[3] - CANNON[3]) ^ 2)
    if not best or d < best then nearest, best = thing, d end
  end
end
if not nearest then
  print("No target")
  return
end

local target = nearest.pos
print(("Target at %.1f %.1f %.1f, %.1f blocks out"):format(target[1], target[2], target[3], best))
local solutions = ballistics.calculatePitch(CANNON, target, SPEED, BARREL)
local low, high = solutions[1], solutions[2]
if low[2] ~= -1 then print(("Low arc: pitch %.2f, %.0f ticks"):format(low[2], low[3])) end
if high[2] ~= -1 then print(("High arc: pitch %.2f, %.0f ticks"):format(high[2], high[3])) end
if low[2] == -1 and high[2] == -1 then print("Out of reach") end

local ground = scanner.getBlockAt(target[1], target[2] - 1 - 64, target[3])
print("Lands on " .. (ground.block_type or ground.error))
