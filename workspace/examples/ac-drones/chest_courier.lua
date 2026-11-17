-- AC-Drones: carry a chest somewhere else with the claw, then take a few items out of it.
--
-- The drone starts on the ground. The chest stands three blocks east of it and has to go four
-- blocks further south. Run it in the emulator with chest_courier.world.json.
--
-- Things worth knowing about the mod (docs/ac-drones.md):
--   * drone.move is relative, stops within a tenth of a block of where it was sent, and gives up
--     after 100 ticks ("Movement took too long"), which is about 20 blocks.
--   * suck and the claw work on the block below the drone, so the drone lands on what it handles.
--   * the mod has two suck methods and a computer gets only one of them: suck(1) works with both.

local claw = peripheral.find("claw")
if not claw then error("this drone has no claw", 0) end

local function say(text)
  local _, y = term.getCursorPos()
  term.setCursorPos(1, y)
  term.clearLine()
  print(text)
end

local function fly(x, y, z)
  local ok, why = drone.move(x, y, z)
  if not ok then error(("move %d %d %d: %s"):format(x, y, z, tostring(why)), 0) end
end

local function try(what, ok, why)
  if not ok then error(what .. ": " .. tostring(why), 0) end
end

term.clear()
term.setCursorPos(1, 1)
term.setTextColour(colours.yellow)
print("Chest courier")
term.setTextColour(colours.white)

say("Flying to the chest")
fly(0, 2, 0)
fly(3, 0, 0)
fly(0, -1, 0) -- down onto its lid

say("Picking it up")
try("grab", claw.grab())

say("Carrying it south")
fly(0, 2, 0)
fly(0, 0, 4)
try("drop", claw.drop())
sleep(1.5) -- it falls to the ground as a falling block, with everything still in it

say("Landing on it")
fly(0, -2, 0)

say("Taking 8 items")
try("select", drone.select(1))
local taken = 0
while taken < 8 do
  local ok, why = drone.suck(1)
  if not ok then
    say("Stopped: " .. tostring(why))
    break
  end
  taken = taken + 1
end

local item = drone.getItemDetail(1)
term.setTextColour(colours.lime)
print(("Done: %d x %s"):format(item and item.count or 0, item and item.displayName or "nothing"))
term.setTextColour(colours.white)
