-- Every function of CC: Drones 0.0.1's `drone` API once, with what the mod's source does
-- (DroneAPI.java), in the world of drone_api.world.json: a drone hovering two blocks above flat ground at
-- 0,66,0 looking south at a wall of logs three blocks away, a stone block to the west and a
-- chest to the east of where it ends up, and a pig below.
--
-- This version tells a program almost nothing: no call answers and there is no position. What a
-- program can see is what the drone looks at, its rotation and whether it is against a wall.

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return e
end

local function nothing(...) return select("#", ...) end

ccunit.test("the drone computer", function()
  drone.hoverOn(true) -- before the first tick, or it starts to fall
  local have = {}
  for name in pairs(drone) do have[#have + 1] = name end
  table.sort(have)
  ccunit.eq(have, {
    "breakForward", "debug", "down", "dropBlock", "dropEntity", "engineOn", "hoverOn", "isColliding", "left",
    "lookBack", "lookForward", "pickUpEntity", "pickupBlock", "right", "rotation", "up",
  })
  ccunit.eq({ term.getSize() }, { 51, 19 })
  ccunit.eq(term.isColour(), false)
  ccunit.eq(turtle, nil)
  ccunit.eq(nothing(drone.debug()), 0)
end)

ccunit.test("arguments", function()
  ccunit.eq(err(drone.engineOn), "bad argument #1 (boolean expected, got nil)")
  ccunit.eq(err(drone.hoverOn, "on"), "bad argument #1 (boolean expected, got string)")
  ccunit.eq(err(drone.right), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(drone.left, "a"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(drone.up), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(drone.down, {}), "bad argument #1 (number expected, got table)")
end)

ccunit.test("hoverOn, lookForward and lookBack", function()
  ccunit.eq(nothing(drone.hoverOn(true)), 0)
  local ahead = drone.lookForward()
  ccunit.eq({ ahead.name, ahead.state.axis, ahead.tags["minecraft:logs"] }, { "minecraft:oak_log", "y", true })
  local behind = drone.lookBack()
  ccunit.eq({ behind.name, behind.state }, { "minecraft:air", {} })
  ccunit.eq(drone.isColliding(), false)
end)

ccunit.test("engineOn flies it forward until it is against the wall", function()
  ccunit.eq(nothing(drone.engineOn(true)), 0)
  sleep(0.5)
  ccunit.eq(drone.isColliding(), false) -- a tenth of a block a tick: not there yet
  sleep(1.5)
  ccunit.eq(drone.isColliding(), true)
  ccunit.eq(nothing(drone.engineOn(false)), 0)
  sleep(0.2)
  ccunit.eq(drone.isColliding(), false) -- it no longer pushes
end)

ccunit.test("breakForward", function()
  ccunit.eq(nothing(drone.breakForward()), 0)
  -- the log at its height is gone; the wall is one block thick
  ccunit.eq(drone.lookForward().name, "minecraft:air")
end)

ccunit.test("right, left and rotation", function()
  ccunit.eq(drone.rotation(), 0)
  -- Entity.turn takes 0.15 of what it is given
  ccunit.eq(nothing(drone.right(20)), 0)
  ccunit.eq(drone.rotation(), 3)
  ccunit.eq(nothing(drone.left(20)), 0)
  ccunit.eq(drone.rotation(), 0)
  drone.right(600) -- a quarter turn: west
  ccunit.eq(drone.rotation(), 90)
  ccunit.eq(drone.lookForward().name, "minecraft:stone")
  ccunit.eq(drone.lookBack().name, "minecraft:chest")
  drone.left(600)
  -- float arithmetic, as in the game: 7 x 0.15 is not quite 1.05
  drone.right(7)
  ccunit.truthy(math.abs(drone.rotation() - 1.05) < 1e-6 and drone.rotation() ~= 1.05, tostring(drone.rotation()))
  drone.left(7)
  ccunit.eq(drone.rotation(), 0)
  -- nothing wraps it
  drone.right(2400)
  ccunit.eq(drone.rotation(), 360)
  drone.left(2400)
end)

ccunit.test("pickupBlock and dropBlock", function()
  -- two blocks down from the block it is in: the grass it floats over
  ccunit.eq(nothing(drone.pickupBlock()), 0)
  -- put down on top of whatever is two blocks down now (the stone under the hole)
  ccunit.eq(nothing(drone.dropBlock()), 0)
  ccunit.eq(nothing(drone.dropBlock()), 0) -- carrying nothing: nothing happens
end)

ccunit.test("down and up; a drone on the ground looks at the block under it", function()
  ccunit.eq(nothing(drone.down(10)), 0)
  sleep(1)
  -- landed on the grass block it put back, one block higher than the ground: Entity.getOnPos() is that block now,
  -- and the ray starts inside it
  ccunit.eq(drone.lookForward().name, "minecraft:grass_block")
  ccunit.eq(drone.lookBack().name, "minecraft:grass_block")
  ccunit.eq(nothing(drone.up(4)), 0)
  sleep(0.5)
  drone.engineOn(false) -- stops it dead
  ccunit.eq(drone.lookBack().name, "minecraft:air")
end)

ccunit.test("pickUpEntity and dropEntity", function()
  ccunit.eq(nothing(drone.pickUpEntity()), 0)
  ccunit.eq(nothing(drone.dropEntity()), 0)
  ccunit.eq(nothing(drone.dropEntity()), 0) -- no passenger: nothing happens
end)
