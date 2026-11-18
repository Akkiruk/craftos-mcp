-- The emulator's `sim` program (rom/ccsim/sim.lua) in the shell: the `sim` alias and its tab completion. Not part of
-- CC:Tweaked, so only for a computer a person drives (`craftos-mcp window` / `app` set world.simProgram); every other
-- computer has no `sim`, as on a real server. Run from the ROM's startup.lua (scripts/rom-patches/startup-emulator.lua).
local show = ... -- programs do not see rom/ccsim; this keeps the one program the shell runs from it
if not shell or not fs.exists("/results/world.json") then return end
do
  local h = fs.open("/results/world.json", "r")
  local world = h and textutils.unserializeJSON(h.readAll())
  if h then h.close() end
  if type(world) ~= "table" or world.simProgram ~= true then return end
end
if show then show("rom/ccsim/sim.lua") end
shell.setAlias("sim", "/rom/ccsim/sim.lua")
-- `help sim`: a help topic, only here, so a computer with no `sim` has no help for it either
if help and help.setPath then
  if show then
    show("rom/ccsim/help")
    show("rom/ccsim/help/sim.txt")
  end
  help.setPath(help.path() .. ":/rom/ccsim/help")
end

-- CraftOS-PC's commands (attach, detach, config, mount, unmount), for people used to them: each does the real game's
-- way (rom/ccsim/craftospc_common.lua). Last on the path, not aliases, so a program of the same name in the
-- computer's files still wins.
local CRAFTOS_PC = { "attach", "detach", "config", "mount", "unmount" }
if show then
  show("rom/ccsim/craftospc")
  show("rom/ccsim/craftospc_common.lua")
  for _, name in ipairs(CRAFTOS_PC) do show("rom/ccsim/craftospc/" .. name .. ".lua") end
end
shell.setPath(shell.path() .. ":/rom/ccsim/craftospc")

local verbs = { "join ", "leave ", "chat ", "advance ", "item ", "state", "help" }

local function players()
  local names = {}
  local h = fs.open("/results/state.json", "r")
  local saved = h and textutils.unserializeJSON(h.readAll())
  if h then h.close() end
  -- the world's players as they stand now (state.json's live world)
  local live = type(saved) == "table" and type(saved.live) == "table" and saved.live or {}
  for _, p in ipairs(type(live.players) == "table" and live.players or {}) do
    if type(p) == "table" and type(p.name) == "string" then names[#names + 1] = p.name .. " " end
  end
  table.sort(names)
  return names
end

local function peripherals()
  local names = {}
  for i, name in ipairs(peripheral.getNames()) do names[i] = name .. " " end
  return names
end

shell.setCompletionFunction("rom/ccsim/sim.lua", function(_, index, text, previous)
  local choices
  if index == 1 then
    choices = verbs
  elseif index == 2 and (previous[2] == "join" or previous[2] == "leave" or previous[2] == "chat") then
    choices = players()
  elseif index == 2 and previous[2] == "item" then
    choices = peripherals()
  else
    return {}
  end
  local out = {}
  for _, choice in ipairs(choices) do
    if choice:sub(1, #text) == text then out[#out + 1] = choice:sub(#text + 1) end
  end
  return out
end)
