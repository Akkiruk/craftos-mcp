-- CraftOS-PC's `attach`, for people used to it: places the block in the simulated world, live. Not CC:Tweaked's: only
-- a computer a person drives has it (rom/ccsim/sim_shell.lua).
local cpc = dofile("/rom/ccsim/craftospc_common.lua")
local args = { ... }

if #args < 2 then
  print("Usage: attach <side> <type> [options]")
  print("Types: " .. table.concat(cpc.TYPES, ", ") .. ", or any the world knows (minecraft:barrel, ...)")
  print(" attach top monitor 3 2    a wall 3 blocks wide, 2 high")
  print(" attach left drive 1       a disk drive with disk 1 in it")
  print("This is CraftOS-PC's command. In the game you place the block next to the computer; here it goes into the world.")
  return
end

local def, why, disk = cpc.spec(args[1], args[2], { table.unpack(args, 3) })
if not def then
  printError(why)
  return
end
local ok, err = cpc.send({ cmd = "attachPeripheral", peripheral = def })
if not ok then
  printError("attach: " .. tostring(err))
  return
end
if disk then
  local put, perr = cpc.send({ cmd = "insertDisk", peripheral = def.name, disk = disk })
  if not put then printError("attach: the drive is there, but the disk did not go in: " .. tostring(perr)) end
end
cpc.say(cpc.attached(def))
