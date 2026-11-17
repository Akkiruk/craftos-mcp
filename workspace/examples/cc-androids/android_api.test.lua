-- Every function of CC: Androids' `android` API once, with the answers the mod's source gives
-- (AndroidAPI.java), in the world of android_api.world.json: a normal android at 0,64,0 on flat
-- ground, a chest three blocks east, a dirt block four blocks south, diamonds on the ground, a
-- zombie, a cow and Steve.

local ZOMBIE = "11111111-2222-3333-4444-555555555555"
local COW = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
local AIR = "translation{key='block.minecraft.air', args=[]}"

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return e
end

--- Wait until the android has nothing left to do.
local function waitIdle(limit)
  local started = os.clock()
  while android.currentTask() ~= "idle" and os.clock() - started < (limit or 30) do sleep(0.1) end
  return android.currentTask()
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

local function names(list)
  local out = {}
  for i, e in ipairs(list) do out[i] = e.name end
  table.sort(out)
  return out
end

ccunit.test("the android computer", function()
  local have = {}
  for name in pairs(android) do have[#have + 1] = name end
  table.sort(have)
  ccunit.eq(have, {
    "attack", "breakBlock", "cancelTask", "changeFace", "currentTask", "dropItem", "equipSlot", "fuelLevel",
    "getBlocksOfType", "getClosestMob", "getClosestPlayer", "getContainerInfo", "getHandInfo", "getNearbyMobs",
    "getSelf", "getSlotInfo", "goTo", "grabItemFromContainer", "moveTo", "pickup", "refuel", "sendChatMessage",
    "storeHeldItemInContainer", "storeItem", "swapHands", "useBlock", "useEntity",
  })
  ccunit.eq({ term.getSize() }, { 39, 13 })
  ccunit.eq(term.isColour(), false)
  ccunit.eq(require("android"), android)
  ccunit.eq(turtle, nil)
end)

ccunit.test("getSelf and currentTask", function()
  local me = android.getSelf()
  ccunit.eq({ me.name, me.posX, me.posY, me.posZ, me.health }, { "Android", 0.5, 64, 0.5, 20 })
  ccunit.eq(type(me.uuid), "string")
  os.setComputerLabel("Robo")
  ccunit.eq(android.getSelf().name, "Robo")
  os.setComputerLabel(nil)
  ccunit.eq(android.currentTask(), "idle")
end)

ccunit.test("getHandInfo", function()
  ccunit.eq({ android.getHandInfo("main") }, { "Redstone Dust", 5 })
  ccunit.eq({ android.getHandInfo("right") }, { "Redstone Dust", 5 })
  ccunit.eq({ android.getHandInfo("off") }, { "Air", 0 })
  ccunit.eq({ android.getHandInfo("left") }, { "Air", 0 })
  ccunit.eq({ android.getHandInfo("nose") }, { true, "Invalid hand name" })
  ccunit.eq(err(android.getHandInfo), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(android.getHandInfo, 1), "bad argument #1 (string expected, got number)")
end)

ccunit.test("fuelLevel and refuel", function()
  ccunit.eq(android.fuelLevel(), 50)
  ccunit.eq({ android.refuel(2) }, { false, "Fuel level increased to 70" })
  ccunit.eq({ android.getHandInfo("main") }, { "Redstone Dust", 3 })
  ccunit.eq({ android.refuel() }, { false, "Fuel level increased to 100" })
  ccunit.eq({ android.refuel() }, { true, "Hand is empty" })
  ccunit.eq(err(android.refuel, "x"), "bad argument #1 (number expected, got string)")
  ccunit.eq({ android.equipSlot(0) }, { false, "Equipped stack from index 0" })
  ccunit.eq({ android.refuel() }, { true, "Held item stack cannot be used for fuel" })
  ccunit.eq(android.fuelLevel(), 100)
end)

ccunit.test("the stash: storeItem, equipSlot, getSlotInfo, swapHands", function()
  -- holding 3 cobblestone from slot 0
  ccunit.eq({ android.getSlotInfo(0) }, { "empty" })
  ccunit.eq({ android.getSlotInfo(3) }, { false, "Iron Pickaxe" })
  ccunit.eq({ android.getSlotInfo(9) }, { true, "Index must be between 0 and 8" })
  ccunit.eq({ android.getSlotInfo(-1) }, { true, "Index must be between 0 and 8" })
  ccunit.eq({ android.storeItem(9) }, { "Index must be between 0 and 9" })
  ccunit.eq({ android.storeItem(3) }, { "Index is occupied by another item stack!" })
  ccunit.eq({ android.storeItem(1) }, { false, "Stashed held item at index 1" })
  ccunit.eq({ android.storeItem(1) }, { true, "No item in hand to stash" })
  ccunit.eq({ android.equipSlot(9) }, { true, "Index must be between 0 and 8" })
  ccunit.eq({ android.equipSlot(0) }, { "Index of stash is empty" })
  ccunit.eq({ android.equipSlot(3) }, { false, "Equipped stack from index 3" })
  ccunit.eq({ android.equipSlot(1) }, { "Cannot equip item while holding an item" })
  ccunit.eq(select("#", android.swapHands()), 0)
  ccunit.eq({ android.getHandInfo("off") }, { "Iron Pickaxe", 1 })
  ccunit.eq({ android.getHandInfo("main") }, { "Air", 0 })
  android.swapHands()
  ccunit.eq({ android.getHandInfo("main") }, { "Iron Pickaxe", 1 })
  ccunit.eq(err(android.storeItem), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(android.equipSlot, {}), "bad argument #1 (number expected, got table)")
  ccunit.eq(err(android.getSlotInfo, "a"), "bad argument #1 (number expected, got string)")
end)

ccunit.test("pickup and dropItem", function()
  ccunit.eq({ android.pickup("diamond") }, { true, "Cannot pickup item without an empty hand" })
  ccunit.eq({ android.storeItem(3) }, { false, "Stashed held item at index 3" })
  ccunit.eq({ android.pickup("emerald") }, { true, "Could not find item" })
  ccunit.eq(select("#", android.pickup("diamond")), 0)
  ccunit.eq({ android.getHandInfo("main") }, { "Diamond", 3 })
  ccunit.eq(select("#", android.dropItem()), 0)
  ccunit.eq({ android.dropItem() }, { "Hand is empty" })
  ccunit.eq(select("#", android.pickup()), 0) -- any item: the diamonds again
  ccunit.eq({ android.getHandInfo("main") }, { "Diamond", 3 })
  ccunit.eq(err(android.pickup, 5), "bad argument #1 (string expected, got number)")
  ccunit.eq({ android.storeItem(5) }, { false, "Stashed held item at index 5" })
end)

ccunit.test("getClosestPlayer, getNearbyMobs, getClosestMob", function()
  local steve = android.getClosestPlayer()
  ccunit.eq({ steve.name, steve.posX, steve.posY, steve.posZ, steve.health }, { "Steve", 6.5, 64, 0.5, 20 })
  ccunit.eq(names(android.getNearbyMobs()), { "Cow", "Steve", "Zombie" })
  local zombies = android.getNearbyMobs("zombie")
  ccunit.eq(#zombies, 1)
  ccunit.eq(zombies[1], { uuid = ZOMBIE, name = "Zombie", posX = -4.5, posY = 64, posZ = -4.5, health = 6 })
  ccunit.eq(android.getNearbyMobs("creeper"), {})
  -- measured from (x, y, x) of the android's block, as the mod does
  ccunit.eq(android.getClosestMob().name, "Cow")
  ccunit.eq(android.getClosestMob("zombie").uuid, ZOMBIE)
  ccunit.eq(android.getClosestMob("ghast"), {})
  ccunit.eq(err(android.getNearbyMobs, 1), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(android.getClosestMob, true), "bad argument #1 (string expected, got boolean)")
end)

ccunit.test("getBlocksOfType", function()
  ccunit.eq(android.getBlocksOfType("chest"), { { x = 3, y = 64, z = 0 } })
  ccunit.eq(android.getBlocksOfType("minecraft:dirt"), { { x = 0, y = 64, z = 4 } })
  ccunit.eq(android.getBlocksOfType("bedrock"), {})
  -- the ground it can see: the nearest block first
  ccunit.eq(android.getBlocksOfType("grass_block")[1], { x = 0, y = 63, z = 0 })
  ccunit.eq(err(android.getBlocksOfType), "bad argument #1 (string expected, got nil)")
end)

ccunit.test("containers: getContainerInfo, grabItemFromContainer, storeHeldItemInContainer", function()
  local info = android.getContainerInfo(3, 64, 0)
  ccunit.eq({ info.slotCount, info.locked, #info.slots }, { 27, false, 27 })
  ccunit.eq(info.slots[1], { "translation{key='item.minecraft.coal', args=[]}", 16 })
  ccunit.eq(info.slots[2], { "translation{key='item.minecraft.redstone', args=[]}", 10 })
  ccunit.eq(info.slots[3], { AIR, 0 })
  ccunit.eq(android.getContainerInfo({ x = 3, y = 64, z = 0 }).slotCount, 27)
  ccunit.eq(android.getContainerInfo(0, 64, 4), {}) -- dirt
  ccunit.eq(err(android.getContainerInfo, 50, 64, 0), "Position out of range")
  ccunit.eq(err(android.getContainerInfo, { x = 1 }), "x,y,z keys expected")
  ccunit.eq(err(android.getContainerInfo), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(android.getContainerInfo, 1, 2), "bad argument #3 (number expected, got nil)")

  -- slots count from 0 here
  ccunit.eq(select("#", android.grabItemFromContainer(3, 64, 0, 0)), 0)
  ccunit.eq({ android.getHandInfo("main") }, { "Coal", 16 })
  ccunit.eq(err(android.grabItemFromContainer, 3, 64, 0, 0), "Slot is empty")
  ccunit.eq(err(android.grabItemFromContainer, { x = 3, y = 64, z = 0 }, 1), "Slot is blocked by item")
  ccunit.eq(err(android.grabItemFromContainer, 0, 64, 4, 0), "Targeted block does not have an inventory")
  ccunit.eq(err(android.grabItemFromContainer, 50, 64, 0, 0), "Position out of range")
  ccunit.eq(err(android.grabItemFromContainer, 3, 64, 0), "bad argument #4 (number expected, got nil)")

  ccunit.eq(err(android.storeHeldItemInContainer, 3, 64, 0, 1), "There is already a item in that slot")
  ccunit.eq(err(android.storeHeldItemInContainer, 0, 64, 4, 0), "Targeted block does not have an inventory")
  ccunit.eq(err(android.storeHeldItemInContainer, 50, 64, 0, 0), "Position out of range")
  ccunit.eq(err(android.storeHeldItemInContainer, 3, 64, 0, 99),
    "Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index 99 out of bounds for length 27")
  ccunit.eq(err(android.storeHeldItemInContainer, { x = 3, y = 64, z = 0 }), "bad argument #4 (number expected, got nil)")
  ccunit.eq(select("#", android.storeHeldItemInContainer({ x = 3, y = 64, z = 0 }, 5)), 0)
  ccunit.eq({ android.getHandInfo("main") }, { "Air", 0 })
  ccunit.eq(android.getContainerInfo(3, 64, 0).slots[6], { "translation{key='item.minecraft.coal', args=[]}", 16 })
end)

ccunit.test("moveTo and cancelTask", function()
  ccunit.eq(select("#", android.moveTo(0, 64, 4)), 0)
  ccunit.eq(android.currentTask(), "movingToBlock")
  ccunit.eq(waitIdle(), "idle")
  -- it stops as soon as its block is less than two blocks from the target: on stepping into z = 3
  local me = android.getSelf()
  ccunit.eq({ me.posX, me.posY, math.floor(me.posZ) }, { 0.5, 64, 3 })

  ccunit.eq({ android.moveTo(0, 500, 0) }, { true, "Block pos must be within build limit" })
  android.moveTo({ x = 0, y = 64, z = -20 })
  sleep(0.5)
  android.cancelTask()
  ccunit.eq(android.currentTask(), "idle")
  local stopped = android.getSelf()
  ccunit.truthy(stopped.posZ < 3.5 and stopped.posZ > -10, "part of the way: " .. stopped.posZ)
  sleep(0.5)
  ccunit.eq(android.getSelf().posZ, stopped.posZ)
  ccunit.eq(err(android.moveTo), "bad argument #1 (number expected, got nil)")
  ccunit.truthy(err(android.moveTo, { x = "a", y = 1, z = 1 }):find("java.lang.ClassCastException", 1, true))

  android.moveTo(0, 64, 4)
  ccunit.eq(waitIdle(), "idle")
end)

ccunit.test("breakBlock", function()
  ccunit.eq({ android.breakBlock(0, 64, 300) }, { true, "Block position must be within a 100 block radius" })
  ccunit.eq(select("#", android.breakBlock(0, 64, 4)), 0)
  ccunit.eq(android.currentTask(), "breakingBlock")
  ccunit.eq(waitIdle(), "idle")
  ccunit.eq(android.getBlocksOfType("minecraft:dirt"), {})
  -- what it drops lies where the block was
  ccunit.eq(select("#", android.pickup("dirt")), 0)
  ccunit.eq({ android.getHandInfo("main") }, { "Dirt", 1 })
  ccunit.eq(err(android.breakBlock, "a", 1, 1), "bad argument #1 (number expected, got string)")
end)

ccunit.test("useBlock", function()
  -- a block in the hand goes on top of the block it clicks
  ccunit.eq({ android.useBlock(0, 999, 0) }, { true, "Block position must be in world build limit" })
  ccunit.eq(select("#", android.useBlock(1, 63, 5)), 0)
  ccunit.eq(android.currentTask(), "usingBlock")
  ccunit.eq(waitIdle(), "idle")
  ccunit.eq(android.getBlocksOfType("minecraft:dirt"), { { x = 1, y = 64, z = 5 } })
  ccunit.eq({ android.getHandInfo("main") }, { "Air", 0 })
  ccunit.eq(err(android.useBlock, {}), "x,y,z keys expected")
end)

ccunit.test("goTo, useEntity and attack", function()
  ccunit.eq({ android.goTo("00000000-0000-0000-0000-000000000000") }, { true, "Unknown entity or invalid UUID" })
  ccunit.eq(err(android.goTo, "nope"),
    "Java Exception Thrown: java.lang.IllegalArgumentException: Invalid UUID string: nope")
  ccunit.eq(err(android.goTo), "bad argument #1 (string expected, got nil)")
  ccunit.eq(select("#", android.goTo(COW)), 0)
  ccunit.eq(android.currentTask(), "movingToEntity")
  ccunit.eq(waitIdle(), "idle")
  local me = android.getSelf()
  ccunit.eq({ math.floor(me.posX), math.floor(me.posZ) }, { 2, -6 }) -- in the cow's block

  ccunit.eq({ android.useEntity("00000000-0000-0000-0000-000000000000") }, { true, "Unknown entity or invalid UUID" })
  ccunit.eq(err(android.useEntity, 7), "bad argument #1 (string expected, got number)")
  ccunit.eq(select("#", android.useEntity(COW)), 0)
  ccunit.eq(android.currentTask(), "usingEntity")
  ccunit.eq(waitIdle(), "idle")

  ccunit.eq({ android.attack("00000000-0000-0000-0000-000000000000") }, { true, "Unknown entity or invalid UUID" })
  ccunit.eq(err(android.attack, {}), "bad argument #1 (string expected, got table)")
  ccunit.eq(select("#", android.attack(ZOMBIE)), 0)
  ccunit.eq(android.currentTask(), "attacking")
  -- six hits of 1 on its 6 health, one every 11 ticks, after the walk over
  ccunit.eq(waitIdle(), "idle")
  ccunit.eq(android.getNearbyMobs("zombie"), {})
  ccunit.eq(select("#", android.pickup("rotten_flesh")), 0)
  ccunit.eq({ android.getHandInfo("main") }, { "Rotten Flesh", 1 })
  -- a task burns one fuel a second
  local fuel = android.fuelLevel()
  ccunit.truthy(fuel < 100 and fuel > 80, "fuel left: " .. fuel)
end)

ccunit.test("sendChatMessage and the onChatMessage event", function()
  ccunit.eq(select("#", android.sendChatMessage("hello")), 0)
  -- the android hears itself: its fake player stands where it does
  local timer = os.startTimer(2)
  local ev = { os.pullEvent() }
  while ev[1] ~= "onChatMessage" and not (ev[1] == "timer" and ev[2] == timer) do ev = { os.pullEvent() } end
  ccunit.eq(ev, { "onChatMessage", "hello", "Android", "0d0c4ca0-4ff1-11e4-916c-0800200c9a66" })

  -- what a player says within 50 blocks (not through sim(): its wait for the reply would drop the event)
  os.queueEvent("ccsim_cmd", "sim:chat:1", textutils.serializeJSON({ cmd = "chat", player = "Steve", message = "come here" }))
  timer = os.startTimer(2)
  ev = { os.pullEvent() }
  while ev[1] ~= "onChatMessage" and not (ev[1] == "timer" and ev[2] == timer) do ev = { os.pullEvent() } end
  ccunit.eq({ ev[1], ev[2], ev[3] }, { "onChatMessage", "come here", "Steve" })
  ccunit.eq(err(android.sendChatMessage), "bad argument #1 (string expected, got nil)")
end)

ccunit.test("changeFace", function()
  ccunit.eq(select("#", android.changeFace("happy")), 0)
  ccunit.eq(select("#", android.changeFace("no such face")), 0)
  ccunit.eq(err(android.changeFace, 1), "bad argument #1 (string expected, got number)")
end)

ccunit.test("without fuel nothing that moves it works", function()
  ccunit.eq(sim({ cmd = "androidSetFuel", fuel = 0 }), true)
  ccunit.eq(android.fuelLevel(), 0)
  ccunit.eq(err(android.moveTo, 1, 64, 1), "Android requires fuel.")
  ccunit.eq(err(android.goTo, COW), "Android requires fuel.")
  ccunit.eq(err(android.attack, COW), "Android requires fuel.")
  ccunit.eq(err(android.breakBlock, 1, 63, 1), "Android requires fuel.")
  ccunit.eq(err(android.useBlock, 1, 63, 1), "Android requires fuel.")
  ccunit.eq(err(android.useEntity, COW), "Android requires fuel.")
  -- the hands still work
  ccunit.eq({ android.storeItem(8) }, { false, "Stashed held item at index 8" })
end)
