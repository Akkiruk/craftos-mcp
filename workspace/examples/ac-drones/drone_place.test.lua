-- drone.place() as the AC-Drones repository has it after alpha 7 (commit fa57149, which turns the
-- protection check the right way round), and the other of the mod's two suck methods, suck() with no
-- quantity. drone_place.world.json asks for both: "build": "fa57149" and "suckOverload": "none".
--
-- The world: a drone with a claw resting on flat ground at 0,64,0, holding cobblestone, a stick and
-- torches; a torch on the ground at 2,64,0 with two feathers lying by it; water in the ground at
-- 7,63,0.

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  local token = ("sim:%d:%.0f"):format(simCount, os.epoch("utc"))
  os.queueEvent("ccsim_cmd", token, textutils.serializeJSON(command))
  while true do
    local _, got, ok, message = os.pullEvent("ccsim_reply")
    if got == token then return ok, message end
  end
end

local function at(x, y, z)
  ccunit.eq({ sim({ cmd = "acDroneTeleport", x = x, y = y, z = z }) }, { true })
end

local function count(slot)
  local item = drone.getItemDetail(slot)
  return item and item.count or 0
end

ccunit.test("place puts the block where the drone is", function()
  local claw = peripheral.wrap("bottom")
  ccunit.eq({ drone.place() }, { true })
  ccunit.eq(count(1), 3)
  -- the cobblestone is in the drone's own block: that is the one the claw takes first
  ccunit.eq({ claw.grab() }, { true })
  ccunit.eq({ claw.grab() }, { nil, "claw is full" })
  ccunit.eq({ drone.place() }, { true })
  -- a drone inside a block is not held by it (a move stops up to a tenth of a block short, so aim past 66)
  ccunit.eq({ drone.move(0, 2.5, 0) }, { true })
  -- nothing below to place against
  ccunit.eq({ drone.place() }, { false, "Cannot place block here" })
  ccunit.eq(count(1), 2)
end)

ccunit.test("place needs a block item and a free block below", function()
  at(5, 64, 0)
  drone.select(2)
  ccunit.eq({ drone.place() }, { false, "Cannot place block here" }) -- a stick
  ccunit.eq(count(2), 1)
  drone.select(4)
  ccunit.eq({ drone.place() }, { false, "No items to place or use" })
  drone.select(1)
  at(7, 64, 0)
  ccunit.eq({ drone.place() }, { false, "Cannot place block here" }) -- water below
  -- something lying in the block below is in the way
  at(2, 65, 0)
  ccunit.eq({ drone.place() }, { false, "Cannot place block here" })
  ccunit.eq({ drone.suck() }, { true })
  ccunit.eq(count(4), 1)
  ccunit.eq({ drone.suck(5) }, { true }) -- suck() takes no quantity: one feather again
  ccunit.eq(count(4), 2)
  ccunit.eq({ drone.suck() }, { false, "No items to take" })
  ccunit.eq({ drone.place() }, { true })
  ccunit.eq(count(1), 1)
end)

ccunit.test("place: a block that needs something to stand on", function()
  at(9, 64, 0)
  drone.select(3)
  ccunit.eq({ drone.place() }, { true }) -- a torch on the grass
  -- the next one would go on top of that torch
  ccunit.eq({ drone.place() }, { false, "Cannot place block here" })
  ccunit.eq(count(3), 1)
end)
