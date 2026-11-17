-- A Mark II manipulator (level 2 scanner, sensor, introspection bound to Alex, laser), a Mark I with one slot, a
-- redstone integrator and a chest, all on one computer (manipulator.world.json). Every method of the manipulator
-- and the integrator, happy paths and argument errors (Plethora-Fabric 1.20.1-1.13.0, docs/plethora.md).

local m = peripheral.wrap("manipulator_0")
local rs = peripheral.wrap("redstone_integrator_0")
local ALEX = "12345678-aaaa-4bbb-8ccc-1234567890ab"
local COW = "0c0c0c0c-0000-4000-9000-000000000001"

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^[^:]*:%d+: ", ""))
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  os.queueEvent("sim_done")
  os.pullEvent("sim_done")
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.1) end
  return condition()
end

ccunit.test("manipulator methods and modules", function()
  ccunit.eq(peripheral.getType("manipulator_0"), "manipulator")
  -- a bound introspection module gives the player's methods; there are no glasses, so no canvas
  ccunit.eq(peripheral.getMethods("manipulator_0"), {
    "getInventory", "getEquipment", "getEnder", "listModules", "hasModule", "filterModules", "getID", "getName",
    "getMetaOwner", "fire", "sense", "getMetaByID", "getMetaByName", "scan", "getBlockMeta", "getDocs",
  })
  -- a LinkedHashSet: slot order
  ccunit.eq(m.listModules(), { "plethora:scanner", "plethora:sensor", "plethora:introspection", "plethora:laser" })
  -- a Mark I has one slot
  ccunit.eq(peripheral.call("manipulator_1", "listModules"), { "plethora:sensor" })
  ccunit.eq(m.getID(), ALEX)
  ccunit.eq(m.getName(), "Alex")
end)

ccunit.test("a level 2 scanner reaches 14 blocks and costs energy", function()
  ccunit.eq(err(m.getBlockMeta, 15, 0, 0), "X coordinate out of bounds (between -14 and 14)")
  ccunit.eq(m.getBlockMeta(0, 0, 0).name, "plethora:manipulator_mark_2")
  ccunit.eq(m.getBlockMeta(0, -1, 0).name, "minecraft:grass_block")
  ccunit.eq(m.getBlockMeta(0, -1, 0).hardness, 0.6000000238418579) -- a Java float
  ccunit.eq(#m.scan(), 29 * 29 * 29)
  -- a scan costs 100 (level 2 x 50) and 10 comes back a tick: with 50 left the next one waits five ticks
  sim({ cmd = "plethoraSetEnergy", peripheral = "manipulator_0", energy = 50 })
  local started = os.clock()
  m.scan()
  ccunit.truthy(os.clock() - started >= 0.25, "the scan did not wait: " .. (os.clock() - started))
end)

ccunit.test("sensor and introspection from a block", function()
  local seen = m.sense()
  local cow
  for _, e in ipairs(seen) do if e.id == COW then cow = e end end
  -- relative to the manipulator's centre (0.5, 64.5, 0.5)
  ccunit.eq({ cow.x, cow.z }, { 3, 0 })
  ccunit.eq(cow.key, "minecraft:cow")
  local alex = m.getMetaOwner()
  ccunit.eq(alex.x, 10)
  ccunit.truthy(math.abs(alex.y - (64 + 1.6200000047683716 - 64.5)) < 1e-9, "alex.y " .. alex.y)
  ccunit.eq(m.getMetaByName("Alex").id, ALEX)
  ccunit.eq(m.getMetaByName("Cow").health, 10)

  local inv = m.getInventory()
  ccunit.eq(inv.list()[1], { name = "minecraft:cobblestone", count = 20 })
  ccunit.eq(inv.pushItems("minecraft:chest_0", 1, 5), 5)
  ccunit.eq(peripheral.call("minecraft:chest_0", "list")[1], { name = "minecraft:cobblestone", count = 5 })
  ccunit.eq(inv.pullItems("minecraft:chest_0", 1, 2, 9), 2)
  ccunit.eq(inv.list()[9], { name = "minecraft:cobblestone", count = 2 })
  ccunit.eq(inv.consume(5), true)
  ccunit.eq(inv.list()[5].count, 2)
  ccunit.eq(m.getEquipment().size(), 6)
  ccunit.eq(m.getEnder().list(), {})
end)

ccunit.test("a laser from the manipulator", function()
  -- yaw -90 points east (+x): the laser starts 0.9 out from the centre, level with it, and hits the cow
  ccunit.eq(select("#", m.fire(-90, 0, 1)), 0)
  ccunit.truthy(waitFor(function() return m.getMetaByID(COW).health < 10 end, 3), "the cow was not hit")
  ccunit.eq(m.getMetaByID(COW).health, 6)
  ccunit.eq(err(m.fire, 0, 0, 0.1), "Potency out of range (between 0.5 and 5.0).")
end)

ccunit.test("redstone integrator", function()
  ccunit.eq(peripheral.getType("redstone_integrator_0"), "redstone_integrator")
  ccunit.eq(rs.getSides(), { "DOWN", "UP", "NORTH", "SOUTH", "WEST", "EAST" })
  ccunit.eq(rs.getOutput("north"), false)
  rs.setOutput("north", true)
  ccunit.eq(rs.getOutput("north"), true)
  ccunit.eq(rs.getAnalogOutput("north"), 15)
  rs.setAnalogOutput("top", 7)
  ccunit.eq(rs.getAnalogueOutput("up"), 7)
  rs.setAnalogueOutput("Bottom", 3)
  ccunit.eq(rs.getAnalogOutput("down"), 3)
  ccunit.eq(err(rs.setAnalogOutput, "up", 16), "Power out of range (between 0 and 15)")
  ccunit.eq(err(rs.getOutput, "left"), "Bad name 'left' for argument 1")
  ccunit.eq(err(rs.setOutput, "up"), "bad argument #2 (boolean expected, got nil)")
  ccunit.eq(err(rs.getInput), "bad argument #1 (string expected, got nil)")
  rs.setBundledOutput("east", 0x0F0F)
  ccunit.eq(rs.getBundledOutput("east"), 0x0F0F)
  ccunit.eq(rs.getInput("west"), false)
  ccunit.eq(rs.getAnalogInput("west"), 0)

  sim({ cmd = "plethoraSetRedstoneInput", peripheral = "redstone_integrator_0", side = "west", level = 9, bundled = 5 })
  local _, name = os.pullEvent("redstone")
  ccunit.eq(name, "redstone_integrator_0")
  ccunit.eq(rs.getInput("west"), true)
  ccunit.eq(rs.getAnalogueInput("west"), 9)
  ccunit.eq(rs.getBundledInput("west"), 5)
  ccunit.eq(rs.testBundledInput("west", 4), true)
  ccunit.eq(rs.testBundledInput("west", 2), false)
end)
