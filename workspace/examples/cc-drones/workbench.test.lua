-- The drone workbench of CC: Drones 0.0.1 (DroneWorkbenchPeripheral.java) on a computer's left
-- side, with a drone within two blocks; the one on the right has no drone near it
-- (workbench.world.json). api() reboots the computer, so it is left to the runner's own tests.

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return e
end

local bench = peripheral.wrap("left")

ccunit.test("the peripheral", function()
  ccunit.eq(peripheral.getType("left"), "droneworkbench")
  local methods = peripheral.getMethods("left")
  table.sort(methods)
  ccunit.eq(methods, { "api", "debug", "export", "survey" })
  ccunit.eq(drone, nil) -- only a drone has the API, until api() is called
end)

ccunit.test("debug: the block under the workbench", function()
  local below = bench.debug()
  ccunit.eq({ below.name, below.state, below.tags["minecraft:mineable/pickaxe"] }, { "minecraft:stone", {}, true })
  -- nothing under the other one
  ccunit.eq(peripheral.call("right", "debug").name, "minecraft:air")
end)

ccunit.test("survey: the surveyable blocks from -5 to 4 on each axis", function()
  ccunit.eq(bench.survey(), {
    ["1,0,0"] = { name = "minecraft:oak_log" },
    ["-5,-1,4"] = { name = "minecraft:grass_block" },
    ["2,1,-2"] = { name = "minecraft:oak_stairs" },
  })
  ccunit.eq(peripheral.call("right", "survey"), {})
end)

ccunit.test("export", function()
  local h = fs.open("/patrol.lua", "w")
  h.write("drone.engineOn(true)")
  h.close()
  ccunit.eq({ bench.export("/patrol.lua") }, { "Successfully copied data to drone, booting it up!" })
  ccunit.eq(select("#", bench.export("/nothing.lua")), 0) -- no such file: no answer at all
  ccunit.eq(err(bench.export), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(peripheral.call, "right", "export", "/patrol.lua"),
    "Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index 0 out of bounds for length 0")
end)
