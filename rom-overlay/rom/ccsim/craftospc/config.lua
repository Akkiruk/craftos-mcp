-- CraftOS-PC's `config`: shows the settings that apply and says where each one is changed, since a real computer
-- cannot change them from inside. Only on a computer a person drives (rom/ccsim/sim_shell.lua).
local cpc = dofile("/rom/ccsim/craftospc_common.lua")
local args = { ... }
local verb, name = args[1], args[2]

local function show(n)
  local s = cpc.settings[n]
  print(("%s = %s"):format(n, tostring(s.get())))
end

if verb == "list" or verb == nil then
  if verb == nil then print("Usage: config get <name> | config set <name> <value> | config list") end
  print("Settings (as this computer has them):")
  for _, n in ipairs(cpc.settingNames()) do show(n) end
  print("A real computer cannot change these; `config set <name>` says where each one lives.")
elseif verb == "get" then
  if not name then return print("Usage: config get <name>") end
  if cpc.settings[name] then show(name) else print(cpc.noCounterpart(name)) end
elseif verb == "set" then
  if not name then return print("Usage: config set <name> <value>") end
  print(cpc.whereSet(name))
else
  print("Usage: config get <name> | config set <name> <value> | config list")
end
