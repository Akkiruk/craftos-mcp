-- Runs turret.lua against turret.world.json (Minecraft 1.18.2), then calls every method of the radar, the world
-- scanner, the ballistic accelerator and the digitizer: the happy path and the argument errors. The ballistic numbers
-- come from a line-for-line Java port of the mod's BallisticFunctions.kt (docs/some-peripherals.md).

local printed = {}
local realPrint = print
_G.print = function(...)
  local parts = table.pack(...)
  for i = 1, parts.n do parts[i] = tostring(parts[i]) end
  printed[#printed + 1] = table.concat(parts, "\t")
end
shell.run("examples/some-peripherals/turret.lua")
_G.print = realPrint
local output = table.concat(printed, "\n")

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  -- CC 1.101.3 puts a peripheral's error at its caller, here pcall
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local function near(a, b, what) ccunit.truthy(math.abs(a - b) <= 1e-9 * math.max(1, math.abs(b)), ("%s: %.17g vs %.17g"):format(what, a, b)) end

local radar = peripheral.wrap("sp_radar_0")
local scanner = peripheral.wrap("world_scanner_0")
local ballistics = peripheral.wrap("ballistic_accelerator_0")
local digitizer = peripheral.wrap("digitizer_0")

ccunit.test("the turret finds the near zombie and a firing solution", function()
  ccunit.truthy(output:find("Target at 120.5 70.0 40.5", 1, true), output)
  ccunit.truthy(output:find("High arc: pitch 16.68, 39 ticks", 1, true), output)
  ccunit.truthy(not output:find("Low arc", 1, true), output)
  ccunit.truthy(output:find("Lands on block.minecraft.oak_planks", 1, true), output)
end)

ccunit.test("radar", function()
  ccunit.eq(radar.getConfigInfo(), { max_entity_search_radius = -1, max_ship_search_radius = -1 })
  local near8 = radar.scanForEntities(8)
  local kinds = {}
  for _, e in ipairs(near8) do kinds[#kinds + 1] = e.entity_type end
  table.sort(kinds)
  ccunit.eq(kinds, { "entity.minecraft.cow", "entity.minecraft.item", "entity.minecraft.player" })
  local cow
  for _, e in ipairs(near8) do if e.entity_type == "entity.minecraft.cow" then cow = e end end
  ccunit.eq({ cow.is_entity, cow.health, cow.max_health, cow.is_baby, cow.air_supply }, { true, 10, 10, true, 300 })
  ccunit.eq(cow.dimension, "ResourceKey[minecraft:dimension / minecraft:overworld]")
  ccunit.eq(cow.pos, { -5.5, 64, 7.5 })
  local players = radar.scanForPlayers(8)
  ccunit.eq(#players, 1)
  local steve = players[1]
  ccunit.eq({ steve.is_player, steve.nickname, steve.experience_level, steve.xp_needed_for_next_level }, { true, "Steve", 16, 42 })
  ccunit.eq({ steve.eye_height, steve.speed > 0.099 and steve.speed < 0.101 }, { 1.6200000047683716, true })
  ccunit.truthy(math.abs(steve.look_angle[1] + 1) < 1e-6, "Steve looks west")
  ccunit.eq(#radar.scan(8), 3) -- no Valkyrien Skies: entities only
  ccunit.eq(#radar.scan(0), 0) -- the radius is at least 1
  ccunit.eq(#radar.scanForEntities(400), 5) -- three mobs, the diamond, Steve
  ccunit.eq(radar.scanForShips(8), { error = "No Valkyrien Skies installed." })
  ccunit.eq(err(radar.scan), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(radar.scanForEntities, "far"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(radar.scanForPlayers), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(radar.scanForShips), "bad argument #1 (number expected, got nil)")
end)

ccunit.test("world scanner", function()
  ccunit.eq(scanner.getBlockAt(0, -1, 0), { block_type = "block.minecraft.grass_block" })
  ccunit.eq(scanner.getBlockAt(0, -2, 0), { block_type = "block.minecraft.stone" })
  ccunit.eq(scanner.getBlockAt(0, 10, 0), { block_type = "block.minecraft.air" })
  -- the offsets are added to the scanner's block and floored
  ccunit.eq(scanner.getBlockAt(120.9, 5.2, 40.1), { block_type = "block.minecraft.oak_planks" })
  ccunit.eq(err(scanner.getBlockAt, 0, 0), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(scanner.getBlockAt, "x", 0, 0), "bad argument #1 (number expected, got string)")
end)

ccunit.test("ballistic accelerator, against the Java port", function()
  ccunit.eq(ballistics.timeInAir(64, 70, 2), { 3, 69 })
  ccunit.eq(ballistics.timeInAir(64, 90, 0.1), { -1, -1 })
  local t = ballistics.tryPitch(30, 4, 3, 80, { 0, 64, 0 }, { 80, 64, 0 })
  near(t[1], 48.83850172553676, "delta")
  ccunit.eq({ t[2], t[3] }, { 30, 74 })
  ccunit.eq(ballistics.tryPitch(0, 0, 3, 80, { 0, 64, 0 }, { 80, 64, 0 }), { -1, -1, -1 })
  local r = ballistics.calculatePitch({ 0, 64, 0 }, { 120, 70, 40 }, 4, 3)
  ccunit.eq(r[1], { -1, -1, -1 })
  near(r[2][1], 0.15344248826439610, "dT2")
  near(r[2][2], 17.029047368421054, "pitch2")
  near(r[2][3], 39.0, "time2")
  local free = ballistics.calculatePitch({ 0, 64, 0 }, { 60, 64, 10 }, 4, 3, -30, 60, 0.05, 0.99, 1.0, 1000000, 5, 20, false)
  near(free[1][1], 83.231823486206850, "dT1")
  near(free[1][2], 59.810942105263160, "p1")
  near(free[2][2], 5.2662578947368420, "p2")
  near(free[2][3], 16.0, "t2")
  local batch = ballistics.batchCalculatePitches({ 0, 64, 0 }, { { 120, 70, 40 }, { 60, 64, 10 } }, 4, 3)
  ccunit.eq(#batch, 2)
  near(batch[1][2][2], 17.029047368421054, "batch pitch")
  near(ballistics.getDrag(0.98, 0.5), 0.99, "drag below 1")
  near(ballistics.getDrag(0.98, 3), 0.94, "drag above 1")
  ccunit.eq(err(ballistics.timeInAir, 1, 2), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(ballistics.timeInAir, 1, 2, 3, 0.05, 0.99, 0 / 0), "bad argument #6 (number expected, got nan)") -- 1.5 would be 1: CC truncates
  ccunit.eq(err(ballistics.tryPitch, 30, 4, 3, 80, { 0, 64, 0 }), "bad argument #6 (table expected, got nil)")
  ccunit.eq(err(ballistics.calculatePitch, { x = 0, y = 64, z = 0 }, { 1, 2, 3 }, 4, 3), "Can't convert cannon item at  1.0")
  ccunit.eq(err(ballistics.calculatePitch, { 0, 64 }, { 1, 2, "z" }, 4, 3), "Can't convert target item at  3.0")
  ccunit.eq(err(ballistics.batchCalculatePitches, { 0, 64, 0 }, { 5 }, 4, 3), "Can't convert targets at  1.0")
  ccunit.eq(err(ballistics.getDrag, 0.98), "bad argument #2 (number expected, got nil)")
end)

ccunit.test("digitizer", function()
  ccunit.eq(digitizer.getItemLimitInSlot(), 64)
  ccunit.eq(digitizer.getItemInSlot().name, "minecraft:iron_ingot")
  local id = digitizer.digitizeAmount(15)
  ccunit.truthy(id:match("^%x+%-%x+%-4%x+%-[89ab]%x+%-%x+$"), id)
  ccunit.eq(digitizer.getItemInSlot().count, 5)
  ccunit.eq(digitizer.checkID(id).item.count, 15)
  ccunit.eq(digitizer.checkID(id:upper()).item.name, "minecraft:iron_ingot")
  local part = digitizer.separateDigitalItem(id, 4)
  ccunit.eq({ digitizer.checkID(id).item.count, digitizer.checkID(part).item.count }, { 11, 4 })
  ccunit.eq(digitizer.mergeDigitalItems(id, part, 1), true)
  ccunit.eq({ digitizer.checkID(id).item.count, digitizer.checkID(part).item.count }, { 12, 3 })
  ccunit.eq(digitizer.mergeDigitalItems(id, part), true)
  ccunit.eq(digitizer.checkID(part), { error = "UUID doesn't exist" })
  ccunit.eq(digitizer.rematerializeAmount(id, 7), true)
  ccunit.eq(digitizer.getItemInSlot().count, 12)
  local rest = digitizer.digitizeAmount()
  ccunit.eq(digitizer.getItemInSlot(), {})
  ccunit.eq(digitizer.digitizeAmount(), { error = "Empty slot" })
  ccunit.eq(digitizer.digitizeAmount(0), { error = "Invalid amount" })
  ccunit.eq(digitizer.rematerializeAmount("nope"), { error = "First argument is not a UUID" })
  ccunit.eq(digitizer.rematerializeAmount(), { error = "First argument is not a UUID" })
  ccunit.eq(digitizer.rematerializeAmount("00000000-0000-0000-0000-000000000000"), { error = "UUID doesn't exist" })
  ccunit.eq(digitizer.mergeDigitalItems(id, id), { error = "Items have same id" })
  ccunit.eq(digitizer.mergeDigitalItems(id, "x"), { error = "Second argument is not a UUID" })
  ccunit.eq(digitizer.separateDigitalItem(id, 8), { error = "Cannot separate stack" }) -- 8 left: all of it
  ccunit.eq(digitizer.separateDigitalItem("bad", 1), { error = "First argument is not a UUID" })
  ccunit.eq(digitizer.checkID("bad"), { error = "First argument is not a UUID" })
  ccunit.eq(digitizer.rematerializeAmount(rest), true)
  ccunit.eq(digitizer.rematerializeAmount(id), true)
  ccunit.eq(digitizer.getItemInSlot().count, 20)
  -- another block can fill the digitizer's slot
  ccunit.eq(peripheral.call("chest_0", "pushItems", "digitizer_0", 1), 0)
  ccunit.eq(err(digitizer.separateDigitalItem, id), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(digitizer.checkID), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(digitizer.digitizeAmount, "all"), "bad argument #1 (number expected, got string)")
end)
