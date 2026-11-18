-- hut.lua builds its hut in hut.world.json's world: the test runs it, then walks the turtle round to look.
local T, eq, ok = ccunit.test, ccunit.eq, ccunit.truthy

T("it says what it needs and builds nothing with `dry`", function()
  eq(shell.run("examples/turtle/hut", "dry"), true)
  eq(turtle.detectDown(), true, "still on the ground")
  eq(turtle.getItemCount(1), 64)
end)

T("it builds the hut and turns its computer on", function()
  eq(shell.run("examples/turtle/hut"), true)
  -- it stands behind the hut, looking at the computer it placed
  local there, block = turtle.inspect()
  eq(there, true)
  eq(block.name, "computercraft:computer_advanced")
  eq(peripheral.getType("front"), "computer")
  -- turning on takes the computer a moment
  for _ = 1, 50 do
    if peripheral.call("front", "isOn") then break end
    sleep(0.2)
  end
  eq(peripheral.call("front", "isOn"), true)
  -- 46 cobblestone and 25 planks went into it
  eq(turtle.getItemCount(1), 64 - 46)
  eq(turtle.getItemCount(2), 32 - 25)
  -- the wall behind it is cobblestone, three high, with the roof on top
  turtle.turnLeft()
  turtle.turnLeft()
  for height = 1, 3 do
    local found, wall = turtle.inspect()
    ok(found, "wall at height " .. height)
    eq(wall.name, "minecraft:cobblestone")
    turtle.up()
  end
  local found, roof = turtle.inspect()
  ok(found, "roof")
  eq(roof.name, "minecraft:oak_planks")
end)
