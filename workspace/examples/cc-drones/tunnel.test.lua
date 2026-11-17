-- Runs tunnel.lua in tunnel.world.json: a plank wall, a cobblestone wall two blocks thick and a
-- glass wall, 3, 7 and 12 blocks south of the drone. Three blocks take it through the first two
-- walls; it stops short of the third.

ccunit.test("the drone breaks three blocks and stops before the glass", function()
  local ok = shell.run("examples/cc-drones/tunnel.lua", "3")
  ccunit.eq(ok, true)
  -- behind it the hole it made
  ccunit.eq(drone.lookBack().name, "minecraft:air")
  ccunit.eq(drone.isColliding(), false)
  -- and the glass still stands: fly on until it stops against it
  drone.engineOn(true)
  local started = os.clock()
  while not drone.isColliding() and os.clock() - started < 10 do sleep(0.1) end
  drone.engineOn(false)
  ccunit.eq(drone.lookForward().name, "minecraft:glass")
end)
