-- CraftOS-PC's `mount`: lists what is mounted (the ROM, disks); mounting a folder of the PC explains what to do
-- instead. Only on a computer a person drives (rom/ccsim/sim_shell.lua).
local cpc = dofile("/rom/ccsim/craftospc_common.lua")
local args = { ... }

if #args == 0 then
  for _, m in ipairs(cpc.mounts()) do
    print(("%s on %s%s"):format(m.drive, m.path, m.readOnly and " (read only)" or ""))
  end
  return
end
cpc.say(cpc.MOUNT)
