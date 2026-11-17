-- Every function of AC-Drones' `drone` API and of its claw once, with the answers the mod's source
-- gives (DroneAPI.java, DroneBrain.java, the commands, DroneClawAccessory.java), in the world of
-- drone_api.world.json: a drone resting on flat ground at 0,64,0 with a claw, a modem and a
-- chunkloader, a chest set into the ground three blocks east, a stone block three blocks west,
-- obsidian in the ground at 2,63,2 and three cobblestone lying at 0,64,2.
--
-- The drone has no way to say where it is, so every part starts by putting it where it should be
-- with the acDroneTeleport sim command.

local CRASH = "crashes a real server"

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return e
end

local simCount = 0
--- A sim command, as `craftos_sim_command` sends it (the world has simProgram on).
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

ccunit.test("the drone computer", function()
  local have = {}
  for name in pairs(drone) do have[#have + 1] = name end
  table.sort(have)
  ccunit.eq(have, {
    "compare", "getItemDetail", "getRotation", "getSelectedSlot", "move", "place", "select", "suck",
  })
  -- ComputerFamily.ADVANCED at the turtle's terminal size
  ccunit.eq({ term.getSize() }, { 39, 13 })
  ccunit.eq(term.isColour(), true)
  ccunit.eq(turtle, nil)
  -- the first attachment is on top, the second on the back, the claw below
  local names = peripheral.getNames()
  table.sort(names)
  ccunit.eq(names, { "back", "bottom", "top" })
  ccunit.eq(peripheral.getType("top"), "modem")
  ccunit.eq(peripheral.call("top", "isWireless"), true)
  ccunit.eq(peripheral.getType("back"), "chunkloader")
  ccunit.eq(peripheral.getMethods("back"), {})
  ccunit.eq(peripheral.getType("bottom"), "claw")
  ccunit.eq(peripheral.getMethods("bottom"), { "drop", "grab" })
end)

ccunit.test("select and getSelectedSlot", function()
  ccunit.eq(drone.getSelectedSlot(), 1)
  ccunit.eq({ drone.select(2) }, { true })
  ccunit.eq(drone.getSelectedSlot(), 2)
  ccunit.eq({ drone.select(0) }, { false, "Slot out of range" })
  ccunit.eq({ drone.select(5) }, { false, "Slot out of range" })
  ccunit.eq(drone.getSelectedSlot(), 2)
  ccunit.eq({ drone.select(1.9) }, { true }) -- cut to 1
  ccunit.eq(drone.getSelectedSlot(), 1)
  ccunit.eq(err(drone.select), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(drone.select, "1"), "bad argument #1 (number expected, got string)")
  -- the command waits for the drone's next tick, not for many: two ticks on an idle host, but each tick waited for
  -- can come late on a busy one, so the bound only has to catch a wait that is far too long
  local started = os.clock()
  drone.select(1)
  local took = os.clock() - started
  ccunit.truthy(took <= 0.5, "select took " .. took .. " s")
end)

ccunit.test("getItemDetail", function()
  local item = drone.getItemDetail()
  ccunit.eq({ item.name, item.count, item.displayName, item.maxCount }, { "minecraft:cobblestone", 8, "Cobblestone", 64 })
  ccunit.eq(drone.getItemDetail(3).count, 3)
  local empty = table.pack(drone.getItemDetail(4))
  ccunit.eq({ empty.n, empty[1] }, { 1, nil })
  ccunit.eq(err(drone.getItemDetail, 5), "Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index 4 out of bounds for length 4")
  ccunit.eq(err(drone.getItemDetail, 0), "Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index -1 out of bounds for length 4")
  ccunit.eq(err(drone.getItemDetail, "a"), "bad argument #1 (number expected, got string)")
end)

ccunit.test("compare", function()
  -- 1.20.1: the stacks must be equal, their counts too
  ccunit.eq({ drone.compare(1) }, { true })
  ccunit.eq({ drone.compare(2) }, { true })
  local different = table.pack(drone.compare(3))
  ccunit.eq({ different.n, different[1], different[2] }, { 2, false, nil })
  ccunit.eq(drone.compare(4), false)
  drone.select(4)
  ccunit.eq({ drone.compare(4) }, { true }) -- nothing is equal to nothing
  drone.select(1)
  ccunit.eq(err(drone.compare), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(drone.compare, {}), "bad argument #1 (number expected, got table)")
  ccunit.truthy(err(drone.compare, 5):find(CRASH, 1, true))
end)

ccunit.test("getRotation", function()
  local rotation = table.pack(drone.getRotation())
  ccunit.eq({ rotation.n, rotation[1], rotation[2] }, { 2, 0, 0 })
end)

ccunit.test("place", function()
  drone.select(4)
  ccunit.eq({ drone.place() }, { false, "No items to place or use" })
  drone.select(1)
  -- alpha 7 turns the protection check round: with nothing protecting the block, nothing can be placed
  ccunit.eq({ drone.place() }, { false, "Cannot place block here" })
  ccunit.eq(count(1), 8)
end)

ccunit.test("move", function()
  ccunit.eq(err(drone.move), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(drone.move, 1, 2), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(drone.move, 1, "2", 3), "bad argument #2 (number expected, got string)")
  ccunit.eq(err(drone.move, 0 / 0, 0, 0), "bad argument #1 (number expected, got nan)")
  ccunit.eq(err(drone.move, 0, math.huge, 0), "bad argument #2 (number expected, got inf)")
  -- nowhere to go: done on the tick after the one that started it (a few ticks at most, as late ticks on a busy host
  -- stretch it; this only catches a move that runs on)
  local started = os.clock()
  ccunit.eq({ drone.move(0, 0, 0) }, { true })
  local took = os.clock() - started
  ccunit.truthy(took <= 0.5, "an empty move took " .. took .. " s")
  -- three blocks east, to above the chest
  started = os.clock()
  ccunit.eq({ drone.move(3, 0, 0) }, { true })
  local took = os.clock() - started
  ccunit.truthy(took > 1 and took < 3)
  -- the nose swings toward where it flies (east is -90) and dips with the speed
  local yaw, pitch = drone.getRotation()
  ccunit.truthy(yaw < -80 and yaw > -90.001)
  ccunit.truthy(pitch < 0 and pitch > -30)
  ccunit.eq({ peripheral.call("bottom", "grab") }, { true }) -- the chest is below
  ccunit.eq({ drone.move(0, 1.5, 0) }, { true })
  ccunit.eq({ peripheral.call("bottom", "drop") }, { true })
  sleep(1)
  at(3, 64, 0) -- back down on top of the chest, which is where it was
end)

ccunit.test("move into a wall", function()
  at(0, 64, 0)
  -- the stone at -3 stops it: it pushes on for 100 ticks and gives up
  local started = os.clock()
  ccunit.eq({ drone.move(-5, 0, 0) }, { false, "Movement took too long" })
  local took = os.clock() - started
  ccunit.truthy(took > 4.9 and took < 5.5)
  -- it got as far as the wall: the block below it is the grass at -2
  ccunit.eq({ peripheral.call("bottom", "grab") }, { true })
  ccunit.eq({ drone.move(0, 2, 0) }, { true })
  ccunit.eq({ peripheral.call("bottom", "drop") }, { true })
  sleep(1)
end)

ccunit.test("suck: loose items", function()
  at(0, 65, 2) -- one block above the cobblestone on the ground
  drone.select(1)
  ccunit.eq({ drone.suck(0) }, { true })
  ccunit.eq(count(1), 8)
  ccunit.eq({ drone.suck(2) }, { true })
  ccunit.eq(count(1), 10)
  ccunit.eq({ drone.suck(64) }, { true }) -- the one that is left
  ccunit.eq(count(1), 11)
  ccunit.eq({ drone.suck(1) }, { false, "No items to take" })
  ccunit.eq(err(drone.suck), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(drone.suck, "all"), "bad argument #1 (number expected, got string)")
  ccunit.truthy(err(drone.suck, -1):find(CRASH, 1, true))
end)

ccunit.test("suck: the chest below", function()
  at(3, 64, 0)
  -- three slots of cobblestone and one coal: the only room is for coal
  ccunit.eq({ sim({ cmd = "acDroneSetSlot", slot = 4, item = "minecraft:coal" }) }, { true })
  drone.select(4)
  -- the chest's first slot is redstone, which fits nowhere: it is passed over. The next one has 16 coal, and one
  -- call takes from one slot
  ccunit.eq({ drone.suck(20) }, { true })
  local coal = drone.getItemDetail(4)
  ccunit.eq({ coal.name, coal.count }, { "minecraft:coal", 17 })
  ccunit.eq({ drone.suck(64) }, { true }) -- the 30 in the third slot
  ccunit.eq(count(4), 47)
  -- only the redstone is left
  ccunit.eq({ drone.suck(1) }, { false, "No space for items" })
  -- nothing below but grass
  at(5, 64, 0)
  ccunit.eq({ drone.suck(1) }, { false, "No items to take" })
end)

ccunit.test("the claw: grab and drop", function()
  local claw = peripheral.wrap("bottom")
  at(3, 64, 0)
  ccunit.eq({ claw.grab() }, { true }) -- the chest, with the redstone in it
  ccunit.eq({ claw.grab() }, { nil, "no block to grab" }) -- the hole it left
  at(4, 64, 0)
  ccunit.eq({ claw.grab() }, { nil, "claw is full" })
  ccunit.eq({ claw.drop() }, { nil, "block below drone is not air" })
  ccunit.eq({ drone.move(0, 3, 0) }, { true })
  ccunit.eq({ claw.drop() }, { true })
  ccunit.eq({ claw.drop() }, { nil, "claw is empty" })
  sleep(1) -- it falls two blocks
  at(4, 65, 0)
  ccunit.eq({ drone.suck(1) }, { false, "No space for items" }) -- the chest landed with its redstone
  -- obsidian is in #minecraft:dragon_immune, which the claw's blacklist names
  at(2, 64, 2)
  ccunit.eq({ claw.grab() }, { nil, "cannot grab block" })
end)

ccunit.test("drone_command_result", function()
  -- every command answers with an event the whole computer sees
  local seen
  parallel.waitForAll(
    function() drone.select(2) end,
    function() seen = table.pack(os.pullEvent("drone_command_result")) end
  )
  ccunit.eq({ seen.n, type(seen[2]), seen[3] }, { 3, "number", true })
  -- and takes any event with its number for its answer
  os.queueEvent("drone_command_result", seen[2] + 1, true, "from the program")
  ccunit.eq({ drone.select(1) }, { true, "from the program" })
  os.pullEvent("drone_command_result") -- the real answer
  ccunit.eq(drone.getSelectedSlot(), 1)
end)

ccunit.test("the command queue holds 17", function()
  local results, calls = {}, {}
  for i = 1, 19 do
    calls[i] = function() results[i] = table.pack(drone.select(1)) end
  end
  parallel.waitForAll(table.unpack(calls))
  for i = 1, 17 do ccunit.eq({ results[i].n, results[i][1] }, { 1, true }) end
  ccunit.eq({ results[18][1], results[18][2] }, { false, "The command queue is too fat" })
  ccunit.eq({ results[19][1], results[19][2] }, { false, "The command queue is too fat" })
end)

ccunit.test("sim commands", function()
  ccunit.eq({ sim({ cmd = "acDroneSetSlot", slot = 2, item = { name = "minecraft:stick", count = 5 } }) }, { true })
  ccunit.eq(drone.getItemDetail(2).name, "minecraft:stick")
  ccunit.eq({ sim({ cmd = "acDroneSetSlot", slot = 2 }) }, { true })
  ccunit.eq(drone.getItemDetail(2), nil)
  ccunit.eq({ sim({ cmd = "acDroneSetSlot", slot = 5 }) }, { false, "slot must be 1 to 4" })

  -- an attachment that goes into a slot rebuilds the sides, and that takes the claw off the bottom
  ccunit.eq({ sim({ cmd = "acDroneSetAttachment", slot = 2, attachment = "advanced_modem" }) }, { true })
  ccunit.eq(peripheral.getType("back"), "modem")
  ccunit.eq(peripheral.call("back", "isWireless"), true)
  ccunit.eq(peripheral.getType("bottom"), nil)
  -- one taken out stays on its side
  ccunit.eq({ sim({ cmd = "acDroneSetAttachment", slot = 1 }) }, { true })
  ccunit.eq(peripheral.getType("top"), "modem")
  ccunit.eq({ sim({ cmd = "acDroneSetAttachment", slot = 3, attachment = "modem" }) }, { false, "slot must be 1 or 2" })
  ccunit.eq({ sim({ cmd = "acDroneSetAttachment", slot = 1, attachment = "speaker" }) }, { false, "attachment must be modem, advanced_modem, chunkloader or null" })

  -- a claw put in (again) is back on the bottom on the next tick
  os.queueEvent("flush")
  os.pullEvent("flush")
  ccunit.eq({ sim({ cmd = "acDroneSetAccessory", accessory = "claw" }) }, { true })
  local _, side = os.pullEvent("peripheral")
  ccunit.eq(side, "bottom")
  ccunit.eq(peripheral.getType("bottom"), "claw")
  ccunit.eq({ sim({ cmd = "acDroneSetAccessory" }) }, { true })
  _, side = os.pullEvent("peripheral_detach")
  ccunit.eq(side, "bottom")
  ccunit.eq({ sim({ cmd = "acDroneSetAccessory", accessory = "modem" }) }, { false, "accessory must be claw or null" })

  ccunit.eq({ sim({ cmd = "acDroneTeleport", x = 1 }) }, { false, "x, y and z are needed" })
  -- the world around it (ccsim/mob.lua)
  at(8, 65, 8)
  ccunit.eq({ sim({ cmd = "mobDropItem", x = 8, y = 64, z = 8, name = "minecraft:stick", count = 2 }) }, { true })
  drone.select(2)
  ccunit.eq({ drone.suck(5) }, { true })
  ccunit.eq(drone.getItemDetail(2).count, 2)
end)
