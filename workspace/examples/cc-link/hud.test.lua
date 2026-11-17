-- Runs hud.lua against hud.world.json (Alex wears a Link core with seven upgrades and a set of modular Link armor,
-- with the link_armor pocket upgrade on "back"), then calls every function of the link API, of each upgrade table
-- and of the link_armor peripheral, happy path and argument errors.

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
-- the HUD, on a window so its screen can be read back
local width, height = term.getSize()
local screen = window.create(term.current(), 1, 1, width, height)
local seen = {}
parallel.waitForAny(function()
  local old = term.redirect(screen)
  local ok, e = pcall(shell.run, "examples/cc-link/hud.lua")
  term.redirect(old)
  if not ok then seen.error = e end
end, function()
  sleep(1.5)
  local lines = {}
  for y = 1, height do lines[y] = screen.getLine(y) end
  seen.screen = table.concat(lines, "\n")
end)

ccunit.test("the HUD shows health, food and the mobs within 8 blocks", function()
  ccunit.eq(seen.error, nil)
  ccunit.truthy(seen.screen:find("LINK HUD - Alex", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("HP 14  Food 20", 1, true), seen.screen) -- it ate a bread: 15 + 5
  ccunit.truthy(seen.screen:find("baby Daisy", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("Zombie", 1, true), seen.screen)
  ccunit.truthy(not seen.screen:find("Creeper", 1, true), seen.screen)
end)

ccunit.test("link: upgrades", function()
  local ok, list = link.listUpgrades()
  ccunit.eq(ok, true)
  ccunit.eq(#list, 7)
  ccunit.eq(list[1], "cclink:scanner_upgrade")
  ccunit.eq(link.hasUpgrade("cclink:chatty_upgrade"), true)
  ccunit.eq(link.hasUpgrade("chatty_upgrade"), false) -- minecraft:chatty_upgrade
  ccunit.eq(err(link.hasUpgrade, 5), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(link.hasUpgrade, "Bad:thing"),
    "Java Exception Thrown: net.minecraft.ResourceLocationException: Non [a-z0-9_.-] character in namespace of location: Bad:thing")
  local up = link.getUpgradeFunctions()
  local names = {}
  for k in pairs(up) do names[#names + 1] = k end
  table.sort(names)
  ccunit.eq(names, { "chatty", "introspection", "kinetic", "overlay", "scanner", "sensor", "world" })
end)

ccunit.test("link: getInfo, swingMainHand, lookAt, lookAtBlock", function()
  local info = link.getInfo()
  ccunit.eq(info.name, "Alex")
  ccunit.eq(info.x, nil) -- only the Integrated Link core reports a position
  ccunit.eq(info.dimension, "minecraft:overworld")
  ccunit.eq(info.health, 14)
  ccunit.eq(info.hunger, 20)
  ccunit.eq(info.saturation, 6)
  ccunit.eq(info.air, 300)
  ccunit.eq(info.armor, 0)
  ccunit.truthy(math.abs(info.speed - 0.1) < 1e-6)
  ccunit.eq(info.isHungry, false)
  ccunit.eq(info.isInWater, false)
  ccunit.eq(link.swingMainHand(), true)
  ccunit.eq(link.lookAt(10, 45), true)
  info = link.getInfo()
  ccunit.eq(info.pitch, 10)
  ccunit.eq(info.yaw, 0) -- lookAt only turns the head; getInfo reads the body's yaw
  ccunit.eq(err(link.lookAt, 1), "bad argument #2 (number expected, got nil)")
  ccunit.eq(link.lookAtBlock(0.5, 64.5, 3.5), true)
  info = link.getInfo()
  -- straight south, but Minecraft's 57.2957763671875 (just under 180/pi) leaves the float a step short of 90 - 90
  ccunit.eq(info.yaw, -7.62939453125e-06)
  ccunit.truthy(info.pitch > 20 and info.pitch < 21, tostring(info.pitch))
  ccunit.eq(err(link.lookAtBlock, 1, 2), "bad argument #3 (number expected, got nil)")
end)

ccunit.test("link: raycastBlock and raycastEntity", function()
  link.lookAtBlock(0.5, 64.5, 3.5)
  local hit = link.raycastBlock(3, false)
  ccunit.eq(hit, { id = "minecraft:oak_log", name = "[Oak Log]", x = 0, y = 64, z = 3 })
  ccunit.eq(err(link.raycastBlock, 3), "bad argument #2 (boolean expected, got nil)")
  link.lookAtBlock(1.5, 64.7, 2.5)
  local e = link.raycastEntity(5)
  ccunit.eq(e.id, "minecraft:cow")
  ccunit.eq(e.name, "Daisy")
  ccunit.eq({ e.x, e.y, e.z }, { 1, 64, 2 }) -- floored on a Link core
  ccunit.eq(e.health, 20)
  ccunit.eq(e.maxAir, 300)
  ccunit.eq(e.hunger, nil)
  link.lookAt(-90, 0) -- straight up: nothing there
  ccunit.eq(link.raycastEntity(5), {})
  ccunit.eq(link.raycastBlock(5, true), {})
  ccunit.eq(err(link.raycastEntity, "far"), "bad argument #1 (number expected, got string)")
end)

ccunit.test("link: consume", function()
  ccunit.eq({ link.consume(3) }, { false, "Item isnt edible!" })
  ccunit.eq({ link.consume(1) }, { false, "Player isnt hungry!" })
  ccunit.eq(err(link.consume, 0), "Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index -1 out of bounds for length 36")
  ccunit.eq(err(link.consume), "bad argument #1 (number expected, got nil)")
end)

ccunit.test("link: list, getSlot, moveItem", function()
  local list = link.list()
  ccunit.eq(#list, 41)
  ccunit.eq(list[1].name, "minecraft:bread")
  ccunit.eq(list[1].count, 2) -- one was eaten
  ccunit.eq(list[1].slot, 1)
  ccunit.eq(list[1].displayName, "[Bread]")
  ccunit.eq(list[4], {})
  ccunit.eq(list[38].name, "cclink:link_leggings")
  local pick = link.getSlot(2)
  ccunit.eq(pick.maxStackSize, 1)
  ccunit.eq(pick.nbt, { Damage = 0 })
  ccunit.eq(pick.slot, nil)
  ccunit.eq(link.getSlot(50), {})
  ccunit.eq(link.moveItem(3, 10, 5), true)
  ccunit.eq(link.getSlot(3).count, 30)
  ccunit.eq(link.getSlot(5).count, 10)
  ccunit.eq(link.moveItem(5, 60, 3), false) -- too few
  ccunit.eq(link.moveItem(1, 1, 2), false)  -- not the same item
  ccunit.eq(link.moveItem(3, 30, 5), true)
  ccunit.eq(link.getSlot(3), {})
  ccunit.eq(err(link.moveItem, 1, 0, 2), "Count cant be below zero!")
  sim({ cmd = "ccLinkSetItem", slot = 5, item = { name = "minecraft:torch", count = 60 } })
  ccunit.eq(err(link.moveItem, 6, 30, 5), "Cannot be above max stack size!")
end)

ccunit.test("scanner", function()
  local scanner = link.getUpgradeFunctions().scanner
  local blocks = scanner.scan(3)
  ccunit.eq(#blocks, 198) -- 7 x 7 x 4 of ground under the feet, the furnace and the log
  local byPos = {}
  for _, b in ipairs(blocks) do byPos[b.x .. "," .. b.y .. "," .. b.z] = b end
  ccunit.eq(byPos["2,1,0"].name, "minecraft:furnace")
  ccunit.eq(byPos["2,1,0"].direction, "east")
  ccunit.eq(byPos["0,1,3"].axis, "x")
  ccunit.eq(byPos["0,0,0"].name, "minecraft:grass_block")
  local tagged = false
  for _, t in ipairs(byPos["0,1,3"].tags) do if t:find("^minecraft:block/minecraft:") then tagged = true end end
  ccunit.truthy(tagged)
  ccunit.truthy(scanner.getOperationCooldown() > 1000)
  ccunit.eq({ scanner.scan(3) }, { nil, "On cooldown!" })
  sleep(2.1)
  ccunit.eq({ scanner.scan(9) }, { false, "Cannot be bigger than 8 block radius!" })
  sleep(2.1)
  ccunit.eq(err(scanner.scan), "bad argument #1 (number expected, got nil)")
end)

ccunit.test("sensor", function()
  sleep(2.1)
  local sensor = link.getUpgradeFunctions().sensor
  local seen = sensor.sense(8)
  ccunit.eq(#seen, 3)
  ccunit.eq(seen[1].name, "Steve")
  ccunit.eq(seen[1].id, "minecraft:player")
  ccunit.eq({ seen[2].name, seen[2].baby, seen[2].inLove, seen[2].aggressive }, { "Daisy", true, false, false })
  ccunit.eq(seen[3].name, "Zombie")
  ccunit.eq(seen[3].baby, nil) -- not an animal
  ccunit.truthy(sensor.getOperationCooldown() > 0)
  sleep(2.1)
  ccunit.eq({ sensor.sense(17) }, { false, "Cannot be bigger than 16 block radius!" })
end)

ccunit.test("introspection", function()
  local intro = link.getUpgradeFunctions().introspection
  local inv = intro.list("inv")
  ccunit.eq(inv[1], { name = "minecraft:bread", count = 2 })
  ccunit.eq(type(inv[2].nbt), "string") -- a damageable item carries a Damage tag
  ccunit.eq(inv[3], nil)
  ccunit.eq(intro.list("ENDER"), { { name = "minecraft:diamond", count = 5 } })
  ccunit.eq({ intro.list("bag") }, { false, 'Invalid Inventory type! Please use "inv" or "ender"!' })
  ccunit.eq(intro.size("inv"), 41)
  ccunit.eq(intro.size("ender"), 27)
  ccunit.eq({ intro.size("curios") }, { false, "Invalid Inventory type! Please use 'inv', 'ender' or 'curios'!" })
  ccunit.eq(intro.getItemDetail(1, "ender"), { name = "minecraft:diamond", count = 5 })
  ccunit.eq(intro.getItemDetail(9, "inv"), { name = "minecraft:air", count = 0 })
  ccunit.eq(intro.getItemLimit(2, "inv"), 1)
  ccunit.eq(intro.getItemLimit(9, "inv"), 64)
  -- moveItems moves, then answers nil: its MethodResult is wrapped in another one, which CC turns into nil
  ccunit.eq(select("#", intro.moveItems("ender", "inv", 1, 2, 10)), 1)
  ccunit.eq(intro.getItemDetail(10, "inv"), { name = "minecraft:diamond", count = 2 })
  ccunit.eq(intro.getItemDetail(1, "ender").count, 3)
  ccunit.eq({ intro.moveItems("x", "inv", 1, 1, 1) }, { false, 'Invalid Inventories! Please use "inv" or "ender"!' })
  ccunit.eq(err(intro.getItemDetail, "a", "inv"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(intro.getItemDetail, 1, 2), "bad argument #2 (string expected, got number)")
  ccunit.eq(err(intro.moveItems, "inv", "inv", 1), "bad argument #4 (number expected, got nil)")
end)

ccunit.test("world", function()
  local w = link.getUpgradeFunctions().world
  ccunit.eq(w.getWeather(), "raining")
  ccunit.eq(w.getDimension(), "minecraft:overworld")
  ccunit.eq(w.getBiome(), { name = "minecraft:plains", canSnow = false, canRain = true, fogColor = 12638463, foliageColor = 0 })
  ccunit.eq(w.canSeeSky(), true)
  ccunit.eq(w.isDay(), true)
  sim({ cmd = "ccLinkSetWorld", canSeeSky = false })
  ccunit.eq(w.getWeather(), "clear")
end)

ccunit.test("overlay", function()
  local o = link.getUpgradeFunctions().overlay
  ccunit.eq(o.addOrUpdateTextElement("t", "hello", 1, 2, 0xFF0000, 1.5), true)
  ccunit.eq(o.removeTextElement("t"), true)
  ccunit.eq(o.clearText(), true)
  ccunit.eq(o.addOrUpdateRightboundTextElement("r", "right", 1, 2, 0xFFFFFF, 1), true)
  ccunit.eq(o.removeRightboundTextElement("r"), true)
  ccunit.eq(o.clearRightboundText(), true)
  ccunit.eq(o.addOrUpdateRectElement("b", 0, 0, 10, 10, 0, 255), true)
  ccunit.eq(o.removeRectElement("b"), true)
  ccunit.eq(o.clearRect(), true)
  ccunit.eq(o.addOrUpdateItemElement("i", "minecraft:apple", 5, 5), true)
  ccunit.eq(o.removeItemElement("i"), true)
  ccunit.eq(o.clearItem(), true)
  ccunit.eq(o.clearAll(), true)
  sleep(0.1)
  ccunit.eq(o.send(), true)
  ccunit.eq({ o.send() }, { false, "On cooldown!" }) -- one packet per tick and player
  ccunit.eq(err(o.addOrUpdateTextElement, "a", "b", 1, 2, 3), "bad argument #6 (number expected, got nil)")
  ccunit.eq(err(o.addOrUpdateItemElement, "a", 1), "bad argument #2 (string expected, got number)")
end)

ccunit.test("kinetic", function()
  local k = link.getUpgradeFunctions().kinetic
  ccunit.eq(k.launch(0, -90, 2), true) -- a Link core needs no energy
  ccunit.eq({ k.launch(0, 0, 5) }, { false, "Power cannot be above 4!" })
  ccunit.eq(err(k.launch, nil, 0, 1), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(k.launch, 0, 0), "bad argument #3 (number expected, got nil)")
end)

ccunit.test("chatty and chat_message", function()
  local c = link.getUpgradeFunctions().chatty
  ccunit.eq(c.sendMessage("hi all", "Bot", "[]"), true)
  ccunit.eq(c.sendMessageToPlayer("psst", "steve", "Bot", "<>"), true) -- names match ignoring case
  ccunit.eq({ c.sendMessageToPlayer("x", "Nobody", "Bot", "[]") }, { false, "Player not online!" })
  ccunit.eq(err(c.sendMessage, "hi", "Bot", "["), "Java Exception Thrown: java.lang.StringIndexOutOfBoundsException: String index out of range: 1")
  ccunit.eq(err(c.sendMessage, "hi"), "bad argument #2 (string expected, got nil)")
  parallel.waitForAll(function()
    local _, who, message = os.pullEvent("chat_message")
    ccunit.eq({ who, message }, { "Alex", "hello link" })
  end, function() sim({ cmd = "ccLinkChat", message = "hello link" }) end)
end)

ccunit.test("upgrades come and go", function()
  local w = link.getUpgradeFunctions().world
  sim({ cmd = "ccLinkSetUpgrades", upgrades = { "cclink:scanner_upgrade" } })
  ccunit.eq({ w.isDay() }, { false, "Upgrade not equipped!" })
  local names = {}
  for k in pairs(link.getUpgradeFunctions()) do names[#names + 1] = k end
  ccunit.eq(names, { "scanner" })
  sim({ cmd = "ccLinkSetUpgrades", upgrades = { "cclink:scanner_upgrade", "cclink:sensor_upgrade", "cclink:kinetic_upgrade",
    "cclink:overlay_upgrade" } })
end)

ccunit.test("link_armor", function()
  local armor = peripheral.wrap("back")
  ccunit.eq(peripheral.getType("back"), "link_armor")
  local ok, list = armor.listUpgrades()
  ccunit.eq(ok, true)
  ccunit.eq(list, { "cclink:battery_upgrade_tier1", "cclink:kinetic_upgrade", "cclink:sensor_upgrade", "cclink:overlay_upgrade" })
  ccunit.eq(armor.hasUpgrade("cclink:sensor_upgrade"), true)
  ccunit.eq(armor.hasUpgrade("cclink:scanner_upgrade"), false)
  ccunit.eq(err(armor.hasUpgrade, nil), "bad argument #1 (string expected, got nil)")
  local f = armor.getArmorFunctions()
  local names = {}
  for k in pairs(f) do names[#names + 1] = k end
  table.sort(names)
  ccunit.eq(names, { "kinetic", "overlay", "sensor" })
  ccunit.eq(armor.getEnergy("boots"), 6000)
  ccunit.eq(armor.getMaxEnergy("BOOTS"), 10100) -- 100 and a tier 1 battery
  ccunit.eq(armor.getEnergy("helmet"), 0)
  ccunit.eq(armor.getMaxEnergy("helmet"), 100)
  ccunit.eq(armor.getEnergy("hat"), 0)
  ccunit.eq(err(armor.getEnergy, 1), "bad argument #1 (string expected, got number)")
  -- the armor's kinetic launch is paid from the leggings, 5000 FE per unit of power
  ccunit.eq(f.kinetic.launch(0, -90, 1), true)
  ccunit.eq(armor.getEnergy("leggings"), 4000)
  ccunit.eq({ f.kinetic.launch(0, -90, 1) }, { false, "Not Enough Energy!" })
  ccunit.eq({ f.kinetic.launch(0, 0, 5) }, { false, "Power cannot be above 4!" })
end)
