-- startup.lua
-- Part of the craftos-mcp examples (MIT).
-- Starts BLIGHTMARE when the computer boots, and again a few seconds after a crash, with the crash noted in
-- blightmare.log. Hold Ctrl+T to leave for the shell. Leave this file out if the computer has other work to do.

local dir = fs.getDir(shell.getRunningProgram())
local game = fs.combine(dir, "blightmare.lua")
local log = fs.combine(dir, "blightmare.log")

local function note(text)
  local h = fs.open(log, "a")
  if h then
    h.writeLine(os.date("%Y-%m-%d %H:%M:%S") .. " [startup] " .. tostring(text))
    h.close()
  end
end

while true do
  local ok, err = pcall(shell.run, "/" .. game)
  if ok and err ~= false then return end -- a clean stop
  if not ok and tostring(err):find("Terminated", 1, true) then return end
  -- shell.run prints the error itself and returns false; a Ctrl+T that stopped the game reads the same
  note("the game stopped: " .. tostring(err))
  print("Starting again in 5 seconds. Hold Ctrl+T to stop.")
  if not pcall(sleep, 5) then return end
end
