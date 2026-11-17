-- Every function of CC: Drones+ 0.2.0's `drone` API once (the fork's DroneAPI.java), in the world of
-- drone_plus_api.world.json: a hovering drone at 0,66,0 with no upgrades yet, a modem upgrade
-- lying on the ground, a pig under it and a wall of logs six blocks south.
--
-- The fork answers most calls with true or false and a message, and what a drone may do depends
-- on its upgrades (mine, carry, modem).

local PIG = "11111111-2222-3333-4444-555555555555"

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

ccunit.test("the drone computer", function()
  local have = {}
  for name in pairs(drone) do have[#have + 1] = name end
  table.sort(have)
  ccunit.eq(have, {
    "breakForward", "down", "dropBlock", "dropEntity", "engineOn", "findUpgrades", "getPos", "hoverOn",
    "isColliding", "left", "lookBack", "lookForward", "pickUpEntity", "pickupBlock", "right", "rotation", "up",
  })
  ccunit.eq({ term.getSize() }, { 51, 19 })
  ccunit.eq(term.isColour(), true)
  -- DroneAPI.initDrive: a new drone has this file
  local h = fs.open("/startup/go.lua", "r")
  ccunit.eq(h.readAll(), "--default startup program")
  h.close()
end)

ccunit.test("without upgrades", function()
  ccunit.eq({ drone.breakForward() }, { false, "Mining Upgrade Not Installed!" })
  ccunit.eq({ drone.pickupBlock() }, { false, "Carry Upgrade Not Installed!" })
  ccunit.eq({ drone.pickUpEntity() }, { false, "Carry Upgrade Not Installed!" })
  ccunit.eq({ drone.getPos() }, { false, "Modem Upgrade Not Installed!" })
  ccunit.eq({ drone.dropEntity() }, { false, "No Passengers!" })
  ccunit.eq(select("#", drone.dropBlock()), 0)
end)

ccunit.test("findUpgrades and getPos", function()
  -- the modem upgrade on the ground is within two blocks
  ccunit.eq(select("#", drone.findUpgrades()), 0)
  local ok, pos = drone.getPos()
  ccunit.eq({ ok, pos }, { true, { x = 0.5, y = 66, z = 0.5 } })
end)

ccunit.test("hoverOn, engineOn, up and down", function()
  ccunit.eq({ drone.hoverOn(true) }, { true, "Hover on!" })
  ccunit.eq({ drone.engineOn(true) }, { true, "Turned On Engine!" })
  sleep(1)
  ccunit.eq({ drone.engineOn(false) }, { true, "Turned Off Engine" })
  local _, pos = drone.getPos()
  -- about twenty ticks at a tenth of a block, straight south
  ccunit.truthy(pos.z > 2.2 and pos.z < 2.8, "z " .. pos.z)
  ccunit.eq({ pos.x, pos.y }, { 0.5, 66 })
  sleep(0.3)
  ccunit.eq(select(2, drone.getPos()).z, pos.z) -- engineOn(false) stops it dead

  ccunit.eq(select("#", drone.up(10)), 0) -- one block a tick, less 2% each tick
  sleep(0.2)
  drone.engineOn(false)
  local high = select(2, drone.getPos()).y
  ccunit.truthy(high > 68 and high < 72, "y " .. high)
  ccunit.eq(select("#", drone.down(10)), 0)
  sleep(0.2)
  drone.engineOn(false)
  local low = select(2, drone.getPos()).y
  ccunit.truthy(low < high - 2 and low > 64, "y " .. low)

  ccunit.eq({ drone.hoverOn(false) }, { true, "Hover Off!" })
  sleep(2)
  ccunit.eq(select(2, drone.getPos()).y, 64) -- it fell to the ground
  ccunit.eq({ drone.hoverOn(true) }, { true, "Hover on!" })
  ccunit.eq(err(drone.engineOn, 1), "bad argument #1 (boolean expected, got number)")
  ccunit.eq(err(drone.hoverOn), "bad argument #1 (boolean expected, got nil)")
  ccunit.eq(err(drone.up, "x"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(drone.down), "bad argument #1 (number expected, got nil)")
end)

ccunit.test("right, left, rotation and isColliding", function()
  ccunit.eq(select("#", drone.right(600)), 0)
  ccunit.eq(drone.rotation(), 90)
  ccunit.eq(select("#", drone.left(600)), 0)
  ccunit.eq(drone.rotation(), 0)
  ccunit.eq(err(drone.right), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(drone.left, {}), "bad argument #1 (number expected, got table)")
  ccunit.eq(drone.isColliding(), false)
  -- on to the wall at z = 6: it stops against it
  drone.up(2)
  sleep(0.5)
  drone.engineOn(true)
  sleep(2.5)
  ccunit.eq(drone.isColliding(), true)
  drone.engineOn(false)
  local _, pos = drone.getPos()
  ccunit.eq(pos.z, 5.75) -- half a block wide
end)

ccunit.test("lookForward, lookBack and breakForward with the mine upgrade", function()
  ccunit.eq(sim({ cmd = "droneAddUpgrade", upgrade = "mine" }), true)
  ccunit.eq({ sim({ cmd = "droneAddUpgrade", upgrade = "mine" }) }, { false, "Drone already has mine" })
  ccunit.eq(drone.lookForward().name, "minecraft:oak_log")
  ccunit.eq(drone.lookBack().name, "minecraft:air")
  ccunit.eq({ drone.breakForward() }, { true, "Broke Block!" })
  ccunit.eq(drone.lookForward().name, "minecraft:air")
  ccunit.eq({ drone.breakForward() }, { true, "Broke Block!" }) -- nothing there: it says so all the same
end)

ccunit.test("pickupBlock, dropBlock, pickUpEntity and dropEntity with the carry upgrade", function()
  ccunit.eq(sim({ cmd = "droneAddUpgrade", upgrade = "carry" }), true)
  ccunit.eq(sim({ cmd = "droneTeleport", x = 0, y = 66, z = 0 }), true)
  ccunit.eq({ drone.pickUpEntity() }, { true, "Picked up Entity!" })
  -- the pig hangs two blocks under the drone and goes where it goes
  drone.up(10)
  sleep(0.2)
  drone.engineOn(false)
  ccunit.eq({ drone.dropEntity() }, { true, "Ejected Passenger!" })
  ccunit.eq({ drone.dropEntity() }, { false, "No Passengers!" })
  ccunit.eq(sim({ cmd = "mobRemove", uuid = PIG }), true)
  ccunit.eq({ drone.pickUpEntity() }, { false, "No Entities Nearby!" })

  ccunit.eq(sim({ cmd = "droneTeleport", x = 3, y = 66, z = 0 }), true)
  ccunit.eq({ drone.pickupBlock() }, { true, "Picked Up Block!" })
  ccunit.eq(select("#", drone.dropBlock()), 0)
  -- the grass now stands a block higher, right under the drone: it lands on it at once
  drone.hoverOn(false)
  sleep(1)
  ccunit.eq(select(2, drone.getPos()).y, 65)
  ccunit.eq(drone.lookForward().name, "minecraft:grass_block")
end)
