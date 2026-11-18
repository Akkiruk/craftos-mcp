-- CraftOS-PC's `detach`: breaks the block next to the computer in the simulated world, live. Only on a computer a
-- person drives (rom/ccsim/sim_shell.lua).
local cpc = dofile("/rom/ccsim/craftospc_common.lua")
local side = ...

if not side then
  print("Usage: detach <side>")
  print("This is CraftOS-PC's command. In the game you break the block; here it leaves the world.")
  return
end
local ok, err = cpc.send({ cmd = "detachPeripheral", name = side })
if not ok then
  printError("detach: " .. tostring(err))
  return
end
print(("Took the peripheral off %s."):format(side))
print("Programs get a peripheral_detach event, as when the block breaks in the game.")
