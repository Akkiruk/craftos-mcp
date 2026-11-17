-- CC: Androids: carry everything from one chest to another, a stack at a time.
--
-- The android starts between the two chests with redstone in its hand and no fuel. Run it in
-- the emulator with courier.world.json, or change FROM and TO for your own chests.
--
-- Things worth knowing about the mod (docs/cc-androids.md):
--   * walking needs fuel: redstone held in the main hand and android.refuel().
--   * moveTo and the other actions only start a task: wait for currentTask() to say "idle".
--     moveTo stops as soon as the android is within two blocks of where it was sent.
--   * most calls answer `true, message` when they could not do it and nothing when they could.
--   * container slots count from 0, and a chest must be within 10 blocks to be opened.

local FROM = { x = 4, y = 64, z = 0 }
local TO = { x = -4, y = 64, z = 0 }

local function say(text)
  print(("[%3d fuel] %s"):format(android.fuelLevel(), text))
end

local function waitIdle()
  while android.currentTask() ~= "idle" do sleep(0.2) end
end

local function walkTo(pos)
  local failed, why = android.moveTo(pos)
  if failed then error("moveTo: " .. tostring(why), 0) end
  waitIdle()
end

--- The first slot (counted from 0) of a chest that holds something, or that is empty.
local function findSlot(pos, wantEmpty)
  local info = android.getContainerInfo(pos)
  for i, slot in ipairs(info.slots or {}) do
    if (slot[2] == 0) == wantEmpty then return i - 1 end
  end
  return nil
end

term.clear()
term.setCursorPos(1, 1)
print("Android courier")

if android.fuelLevel() < 50 then
  local failed, message = android.refuel()
  if failed then error("no fuel: " .. tostring(message), 0) end
  say(message)
end

local carried = 0
while true do
  walkTo(FROM)
  local slot = findSlot(FROM, false)
  if not slot then break end
  android.grabItemFromContainer(FROM, slot)
  local name, count = android.getHandInfo("main")
  say(("took %d %s"):format(count, name))

  walkTo(TO)
  local free = findSlot(TO, true)
  if not free then
    say("the other chest is full")
    break
  end
  android.storeHeldItemInContainer(TO, free)
  carried = carried + count
end

android.changeFace("happy")
say(("done: %d items carried"):format(carried))
