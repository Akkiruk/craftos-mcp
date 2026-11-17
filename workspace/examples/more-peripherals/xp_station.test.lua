-- Runs xp_station.lua against xp_station.world.json (More Peripherals 1.20.1-1.13.0), then calls every method of
-- every emulated block once or more: the happy path and the argument errors, with the messages from the mod's source.

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end

local function pack(...) return { n = select("#", ...), ... } end

local C0, C1, C2, C3 = "minecraft:chest_0", "minecraft:chest_1", "minecraft:chest_2", "minecraft:chest_3"
local function slot(chest, n) return peripheral.call(chest, "getItemDetail", n) end
local function count(chest, name)
  local n = 0
  for _, item in pairs(peripheral.call(chest, "list")) do if item.name == name then n = n + item.count end end
  return n
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.25) end
  return condition()
end

-- ===== the station program itself =====

local lines = {}
local realPrint = print
local seen = {}
local function scenario()
  _G.print = function(text) lines[#lines + 1] = text end
  seen.bottledTwo = waitFor(function() return count(C1, "minecraft:experience_bottle") == 2 end, 20)
  sim({ cmd = "mpAddXP", peripheral = "xp_collector_0", amount = 8 })
  seen.bottledThree = waitFor(function() return count(C1, "minecraft:experience_bottle") == 3 end, 20)
  -- A card event that comes while the station is in a main-thread call (each waits a server tick and drops the events
  -- meanwhile, as in the game) is lost, and a busy machine makes that likelier: like a person at the door, swipe again
  -- until the station answers.
  local function said(text)
    for _, line in ipairs(lines) do
      if line:find(text, 1, true) then return true end
    end
    return false
  end
  local function retry(command, text)
    for _ = 1, 5 do
      sim(command)
      if waitFor(function() return said(text) end, 3) then return true end
    end
    return false
  end
  retry({ cmd = "mpSwipeCard", peripheral = "magnetic_card_manipulator_0", data = "staff" }, "door open for staff")
  retry({ cmd = "mpSwipeCard", peripheral = "magnetic_card_manipulator_0", data = "stranger" }, "card refused")
  retry({ cmd = "mpSetCard", peripheral = "magnetic_card_manipulator_0", card = { data = "guest" } }, "card in:")
  _G.print = realPrint
end
parallel.waitForAny(function() shell.run("examples/more-peripherals/xp_station.lua") end, scenario)
_G.print = realPrint
local log = table.concat(lines, "\n")

ccunit.test("the station bottles the collector's experience", function()
  ccunit.truthy(seen.bottledTwo, log)
  ccunit.truthy(seen.bottledThree, log)
  ccunit.eq(count(C0, "minecraft:glass_bottle"), 13)
  ccunit.truthy(log:find("door open for staff", 1, true), log)
  ccunit.truthy(log:find("card refused", 1, true), log)
  ccunit.truthy(log:find("card in: Magnetic Card (guest)", 1, true), log)
end)

-- ===== xp_collector and xp_bottler =====

local collector = peripheral.wrap("xp_collector_0")
local bottler = peripheral.wrap("xp_bottler_0")

ccunit.test("xp_collector", function()
  ccunit.eq(collector.getCurrentXP(), 4)
  ccunit.eq(pack(collector.dumpXP()).n, 0)
  ccunit.eq(collector.getCurrentXP(), 0)
end)

ccunit.test("xp_bottler", function()
  ccunit.eq(pack(bottler.bottleXP("nope", C1, "xp_collector_0")), { n = 2, false, "the input nope was not found" })
  ccunit.eq(pack(bottler.bottleXP(C0, C1, "nope")), { n = 2, false, "the xp collector nope was not found" })
  ccunit.eq(pack(bottler.bottleXP(C0, "nope", "xp_collector_0")), { n = 2, false, "the output null was not found" })
  ccunit.eq(pack(bottler.bottleXP(C0, C1, "xp_collector_0")), { n = 2, false, "not enough experience in collector" })
  ccunit.eq(err(bottler.bottleXP, C0, C1, C2), "Java Exception Thrown: java.lang.ClassCastException: class " ..
    "dan200.computercraft.shared.peripheral.generic.GenericPeripheral cannot be cast to class " ..
    "com.hakimen.peripherals.peripherals.XPCollectorPeripheral")
  ccunit.eq(err(bottler.bottleXP), "bad argument #1 (string expected, got nil)")
  sim({ cmd = "mpAddXP", peripheral = "xp_collector_0", amount = 17 })
  ccunit.eq(err(bottler.bottleXP, "crafter_0", C1, "xp_collector_0"),
    'Java Exception Thrown: java.lang.NullPointerException: Cannot invoke "net.minecraftforge.items.IItemHandler.getSlots()" because "input" is null')
  ccunit.eq(pack(bottler.bottleXP(C3, C1, "xp_collector_0")), { n = 2, false, "no bottles found in input" })
  ccunit.eq(pack(bottler.bottleXP(C0, C1, "xp_collector_0")), { n = 1, true })
  ccunit.eq(collector.getCurrentXP(), 1)
  ccunit.eq(count(C1, "minecraft:experience_bottle"), 5)
end)

-- ===== crafter (a crafting table) =====

local crafter = peripheral.wrap("crafter_0")
ccunit.test("crafter", function()
  ccunit.eq(pack(crafter.craft("nope", C1, {})), { n = 2, false, "the input nope was not found" })
  ccunit.eq(pack(crafter.craft(C2, "nope", {})), { n = 2, false, "the output nope was not found" })
  ccunit.eq(err(crafter.craft, C2, C3), "bad argument #3 (table expected, got nil)")
  ccunit.eq(pack(crafter.craft(C2, C3, { [1] = 1, [2] = 1, [4] = 1, [5] = 1 })), { n = 1, true })
  ccunit.eq(slot(C3, 1).name, "minecraft:crafting_table")
  ccunit.eq(slot(C2, 1), nil)
  ccunit.eq(pack(crafter.craft(C2, C3, { [1] = 1 })), { n = 2, false, "Not enough resources on slot 1 to craft" })
  ccunit.eq(err(crafter.craft, C2, C3, { [10] = 9 }),
    "Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index 9 out of bounds for length 9")
  -- no recipe takes one dirt: the mod still answers true and nothing moves
  ccunit.eq(pack(crafter.craft(C2, C3, { [1] = 9 })), { n = 1, true })
  ccunit.eq(slot(C2, 9).count, 10)
  peripheral.call(C3, "pushItems", C1, 1)
end)

-- ===== loom_interface =====

local loom = peripheral.wrap("loom_interface_0")
ccunit.test("loom_interface", function()
  ccunit.eq(err(loom.paintBanner, C2), "bad argument #2 (number expected, got nil)")
  ccunit.eq(pack(loom.paintBanner("nope", 2, 3, 1)), { n = 2, false, "the input nope was not found" })
  ccunit.eq(pack(loom.paintBanner(C2, 0, 3, 1)), { n = 2, false, "banner slot out of range" })
  ccunit.eq(pack(loom.paintBanner(C2, 2, 99, 1)), { n = 2, false, "dye slot out of range" })
  ccunit.eq(pack(loom.paintBanner(C2, 3, 3, 1)), { n = 2, false, "the item in 2 is not a banner" })
  ccunit.eq(pack(loom.paintBanner(C2, 2, 4, 1)), { n = 2, false, "the item in 3 is not a dye" })
  ccunit.eq(pack(loom.paintBanner(C2, 2, 3, 0)), { n = 2, false, "invalid pattern, value was 0 expected a value between 1 and 41" })
  ccunit.eq(err(loom.paintBanner, C2, 2, 3, 42),
    "Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index 41 out of bounds for length 41")
  ccunit.eq(err(loom.paintBanner, "crafter_0", 1, 1, 1),
    'Java Exception Thrown: java.lang.NullPointerException: Cannot invoke "net.minecraftforge.items.IItemHandler.getSlots()" because "input" is null')
  local before = slot(C2, 2).nbt
  ccunit.eq(before, nil)
  ccunit.eq(pack(loom.paintBanner(C2, 2, 3, 15)), { n = 1, true })
  ccunit.eq(slot(C2, 3).count, 1)
  ccunit.truthy(slot(C2, 2).nbt)
  ccunit.eq(pack(loom.clearBanner(C2, 2)), { n = 1, true })
  ccunit.eq(slot(C2, 2).nbt, nil)
  ccunit.eq(pack(loom.clearBanner(C2, 1)), { n = 2, false, "not a banner" })
  ccunit.eq(pack(loom.clearBanner(C2, -4)), { n = 2, false, "slot out of range" })
end)

-- ===== magnetic_card_manipulator =====

local reader = peripheral.wrap("magnetic_card_manipulator_0")
ccunit.test("magnetic_card_manipulator", function()
  ccunit.eq(reader.hasCard(), true)
  ccunit.eq(reader.readCard(), "guest")
  ccunit.eq(reader.getLabel(), "Magnetic Card")
  ccunit.eq(pack(reader.writeCard("vip")), { n = 1, true })
  ccunit.eq(reader.readCard(), "vip")
  ccunit.eq(pack(reader.writeCard("")), { n = 1, true })
  ccunit.eq(reader.readCard(), "")
  ccunit.eq(pack(reader.setLabel("Staff Card")), { n = 1, true })
  ccunit.eq(reader.getLabel(), "Staff Card")
  ccunit.eq(pack(reader.setSecure(true)), { n = 1, true })
  ccunit.eq(err(reader.setSecure), "bad argument #1 (boolean expected, got nil)")
  ccunit.eq(err(reader.writeCard), "bad argument #1 (string expected, got nil)")
  ccunit.eq(pack(reader.ejectCard()), { n = 1, true })
  local removes = 0
  local timer = os.startTimer(0.5)
  while true do
    local e, id = os.pullEvent()
    if e == "card_remove" then removes = removes + 1 end
    if e == "timer" and id == timer then break end
  end
  -- both card_remove events are queued during the main-thread call, while the computer waits for task_complete:
  -- the calling computer never sees them
  ccunit.eq(removes, 0)
  ccunit.eq(reader.hasCard(), false)
  ccunit.eq(pack(reader.readCard()), { n = 2, false, "no card found" })
  ccunit.eq(pack(reader.getLabel()), { n = 2, false, "no card found" })
  ccunit.eq(pack(reader.writeCard("x")), { n = 2, false, "no card found" })
  ccunit.eq(pack(reader.setSecure(false)), { n = 2, false, "no card found" })
  ccunit.eq(pack(reader.setLabel("x")), { n = 1, false })
  ccunit.eq(pack(reader.ejectCard()), { n = 1, false })
end)

-- ===== beehive_interface =====

local hive = peripheral.wrap("beehive_interface_0")
ccunit.test("beehive_interface", function()
  ccunit.eq(pack(hive.hasBees()), { n = 1, true })
  ccunit.eq(pack(hive.getBeeCount()), { n = 2, true, 1 })
  ccunit.eq(pack(hive.gotFireNear()), { n = 2, true, false })
  ccunit.eq(pack(hive.getHoneyLevel()), { n = 2, true, 5 })
  ccunit.eq(pack(hive.getBees()), { n = 2, true, { {
    TicksInHive = 40, MinOccupationTicks = 2400,
    EntityData = { HasStung = false, Health = 10, HasNectar = true, Age = 0, AngerTime = 0 },
  } } })
  ccunit.eq(err(hive.collectHoney, C2, C3), "bad argument #3 (boolean expected, got nil)")
  ccunit.eq(err(hive.collectHoney, "nope", C3, true), "the input nope was not found")
  ccunit.eq(err(hive.collectHoney, C2, "nope", true), "the output nope was not found")
  ccunit.eq(pack(hive.collectHoney(C3, C3, true)), { n = 2, false, "not found the needed item" })
  ccunit.eq(pack(hive.collectHoney(C2, C3, true)), { n = 1, true })
  ccunit.eq(count(C3, "minecraft:honey_bottle"), 1)
  ccunit.eq(slot(C2, 7).count, 1)
  ccunit.eq(pack(hive.getHoneyLevel()), { n = 2, true, 0 })
  ccunit.eq(pack(hive.collectHoney(C2, C3, true)), { n = 2, false, "there is not enough honey in the hive" })
  sim({ cmd = "mpSetBeehive", peripheral = "beehive_interface_0", beehive = { honeyLevel = 5, fireNearby = true } })
  ccunit.eq(pack(hive.gotFireNear()), { n = 2, true, true })
  ccunit.eq(pack(hive.getBees()), { n = 2, false, "there is no bees in the hive" })
  ccunit.eq(pack(hive.hasBees()), { n = 1, false })
  ccunit.eq(pack(hive.collectHoney(C2, C3, false)), { n = 1, true })
  ccunit.eq(slot(C2, 8).damage, 1)
  local combs = count(C3, "minecraft:honeycomb")
  ccunit.truthy(combs >= 1 and combs <= 3, combs)
  sim({ cmd = "mpSetBeehive", peripheral = "beehive_interface_0", beehives = 2 })
  ccunit.eq(pack(hive.hasBees()), { n = 2, false, "more than one beehive connected" })
  sim({ cmd = "mpSetBeehive", peripheral = "beehive_interface_0", beehive = false })
  ccunit.eq(pack(hive.getBeeCount()), { n = 2, false, "no beehive present" })
  peripheral.call(C3, "pushItems", C1, 1)
  peripheral.call(C3, "pushItems", C1, 2)
end)

-- ===== trading_interface =====

local trader = peripheral.wrap("trading_interface_0")
ccunit.test("trading_interface", function()
  ccunit.eq(pack(trader.getProfession()), { n = 2, true, "librarian" })
  ccunit.eq(pack(trader.getTrades()), { n = 2, true, {
    { costA = { ["minecraft:emerald"] = { enchants = {}, count = 5 } }, costB = { ["minecraft:book"] = { enchants = {}, count = 1 } },
      result = { ["minecraft:enchanted_book"] = { enchants = { ["minecraft:mending"] = 1 }, count = 1 } } },
    { costA = { ["minecraft:emerald"] = { enchants = {}, count = 1 } }, costB = { ["minecraft:air"] = { enchants = {}, count = 0 } },
      result = { ["minecraft:bookshelf"] = { enchants = {}, count = 1 } } },
  } })
  ccunit.eq(err(trader.trade, C2, C3), "bad argument #3 (number expected, got nil)")
  ccunit.eq(pack(trader.trade(C2, C3, 3)), { n = 2, false, "trade index out of range" })
  ccunit.eq(pack(trader.trade("nope", C3, 1)), { n = 2, false, "the input nope was not found" })
  ccunit.eq(pack(trader.trade(C2, "nope", 1)), { n = 2, false, "the input nope was not found" })
  -- the book is never looked for when it is missing: the trade goes through on the emeralds alone
  ccunit.eq(pack(trader.trade(C2, C3, 1)), { n = 1, true })
  ccunit.eq(slot(C3, 1).name, "minecraft:enchanted_book")
  ccunit.eq(slot(C2, 4).count, 5)
  ccunit.eq(pack(trader.trade(C3, C3, 2)), { n = 1, false })
  ccunit.eq(pack(trader.restock()), { n = 1, true })
  ccunit.eq(pack(trader.cycleTrades()), { n = 1, true })
  local _, trades = trader.getTrades()
  ccunit.eq(next(trades[1].costA), "minecraft:paper")
  sim({ cmd = "mpSetVillager", peripheral = "trading_interface_0", villager = false })
  ccunit.eq(pack(trader.getProfession()), { n = 2, false, "villager not in range" })
  ccunit.eq(pack(trader.getTrades()), { n = 2, false, "villager not in range" })
  ccunit.eq(pack(trader.restock()), { n = 2, false, "villager not in range" })
  peripheral.call(C3, "pushItems", C1, 1)
end)

-- ===== spawner_interface =====

local spawner = peripheral.wrap("spawner_interface_0")
ccunit.test("spawner_interface", function()
  ccunit.eq(spawner.getCurrentlySpawningMob(), "minecraft:pig")
  ccunit.eq(err(spawner.changeSpawner, C2), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(spawner.changeSpawner, "nope", 1),
    'Java Exception Thrown: java.lang.NullPointerException: Cannot invoke "dan200.computercraft.api.peripheral.IPeripheral.getTarget()" because "peripheral" is null')
  ccunit.eq(pack(spawner.changeSpawner(C2, 0)), { n = 2, false, "slot out of range" })
  ccunit.eq(pack(spawner.changeSpawner(C2, 4)), { n = 1, false })
  ccunit.eq(pack(spawner.changeSpawner(C2, 5)), { n = 1, true })
  ccunit.eq(spawner.getCurrentlySpawningMob(), "minecraft:zombie")
  ccunit.eq(pack(spawner.changeSpawner(C2, 5, true)), { n = 1, true })
  ccunit.eq(spawner.getCurrentlySpawningMob(), "minecraft:pig")
  -- the forced swap emptied the card's tag and resetHoverName dropped it: no longer a filled card
  ccunit.eq(pack(spawner.changeSpawner(C2, 5)), { n = 1, false })
  -- a card with a tag but no mob: EntityType.byString("").get()
  ccunit.eq(err(spawner.changeSpawner, C2, 10), "Java Exception Thrown: java.util.NoSuchElementException: No value present")
  ccunit.eq(pack(spawner.captureSpawner()), { n = 1, true })
  ccunit.eq(pack(spawner.getCurrentlySpawningMob()), { n = 2, false, "no spawner present" })
  sim({ cmd = "mpSetSpawner", peripheral = "spawner_interface_0", mob = "minecraft:skeleton" })
  ccunit.eq(pack(spawner.captureSpawner()), { n = 1, false })
  ccunit.eq(pack(spawner.captureSpawner(C2, 5)), { n = 1, true })
  ccunit.eq(slot(C2, 5).displayName, "Spawner Card (minecraft:skeleton)")
  sim({ cmd = "mpSetSpawner", peripheral = "spawner_interface_0", mob = "minecraft:zombie", spawners = 2 })
  ccunit.eq(pack(spawner.getCurrentlySpawningMob()), { n = 2, false, "more than one spawner present" })
end)

-- ===== player_interface =====

local player = peripheral.wrap("player_interface_0")
ccunit.test("player_interface", function()
  ccunit.eq(player.getPlayerInfo(), {
    name = "Steve", uuid = "00000000-0000-4000-8000-000000000001", pos = { x = 2.5, y = 64, z = 0.5 },
    hunger = { hunger = 14, saturation = 0 }, yaw = 0, pitch = 0,
    effects = { ["minecraft:speed"] = { duration = 30, amplifier = 1 } }, dimension = "minecraft:overworld",
  })
  local eq = player.getEquipment()
  ccunit.eq(eq.mainhand.name, "minecraft:diamond_sword")
  ccunit.eq(eq.chest.name, "minecraft:iron_chestplate")
  ccunit.eq(eq.head, nil)
  ccunit.eq(player.list(), { [1] = { name = "minecraft:diamond_sword", count = 1 }, [2] = { name = "minecraft:bread", count = 3 },
    [39] = { name = "minecraft:iron_chestplate", count = 1 } })
  ccunit.eq(player.size(), 41)
  ccunit.eq(player.getItemDetail(2).displayName, "Bread")
  ccunit.eq(pack(player.getItemDetail(3)), { n = 1, false })
  ccunit.eq(err(player.getItemDetail, 0), "Slot out of range (between 1 and 41)")
  ccunit.eq(player.getItemLimit(2), 64)
  ccunit.eq(pack(player.consume(2)), { n = 1, true })
  ccunit.eq(player.getPlayerInfo().hunger, { hunger = 19, saturation = 6 })
  ccunit.eq(player.list()[2].count, 2)
  ccunit.eq(pack(player.consume(1)), { n = 2, false, "Item isn't edible" })
  ccunit.eq(err(player.consume, 42), "From slot out of range (between 1 and 41)")
  ccunit.eq(pack(player.lookAt(12.5, 65.62, 10.5)), { n = 1, true })
  local info = player.getPlayerInfo()
  ccunit.truthy(math.abs(info.yaw + 45) < 0.05, info.yaw)
  ccunit.truthy(math.abs(info.pitch) < 0.05, info.pitch)
  ccunit.eq(err(player.lookAt, 1, 2), "bad argument #3 (number expected, got nil)")
  ccunit.eq(pack(player.displayMessage("hello")), { n = 1, true })
  ccunit.eq(err(player.displayMessage), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(player.pushItems, "nope", 1), "Target 'nope' does not exist")
  ccunit.eq(err(player.pushItems, "crafter_0", 1), "Target 'crafter_0' is not an inventory")
  ccunit.eq(err(player.pushItems, C3, 37), "From slot out of range (between 1 and 36)")
  ccunit.eq(player.pushItems(C3, 2), 1) -- one at a time unless a limit is given
  ccunit.eq(slot(C3, 1).count, 1)
  ccunit.eq(err(player.pullItems, "nope", 1), "Source 'nope' does not exist")
  ccunit.eq(err(player.pullItems, C3, 1, 1, 37), "To slot out of range (between 1 and 36)")
  ccunit.eq(player.pullItems(C3, 1, 5), 1)
  ccunit.eq(player.list()[2].count, 2)
  sim({ cmd = "mpSetPlayerCard", peripheral = "player_interface_0", card = { uuid = "x" } })
  ccunit.eq(pack(player.list()), { n = 2, false, "Card isn't bound" })
  sim({ cmd = "mpSetPlayerCard", peripheral = "player_interface_0", card = false })
  ccunit.eq(pack(player.getPlayerInfo()), { n = 2, false, "No card present" })
  sim({ cmd = "mpSetPlayerCard", peripheral = "player_interface_0", card = "Alex" })
  ccunit.eq(player.getPlayerInfo().dimension, "minecraft:the_nether")
  sim({ cmd = "mpSetPlayer", player = "Alex", online = false })
  ccunit.eq(pack(player.size()), { n = 2, false, "Player isn't present" })
end)

-- ===== ender_chest_interface =====

local ender = peripheral.wrap("ender_chest_interface_0")
ccunit.test("ender_chest_interface", function()
  ccunit.eq(ender.list(), { [1] = { name = "minecraft:diamond", count = 5 } })
  ccunit.eq(ender.size(), 27)
  ccunit.eq(ender.getItemDetail(1).name, "minecraft:diamond")
  ccunit.eq(ender.getItemLimit(1), 64)
  ccunit.eq(err(ender.getItemLimit, 28), "Slot out of range (between 1 and 27)")
  ccunit.eq(ender.pushItems(C3, 1, 2), 2)
  ccunit.eq(ender.list()[1].count, 3)
  ccunit.eq(ender.pullItems(C3, 1, 2, 1), 2)
  ccunit.eq(ender.list()[1].count, 5)
  ccunit.eq(err(ender.pushItems, C3), "bad argument #2 (number expected, got nil)")
  -- the interface reaches the player only in its own dimension
  sim({ cmd = "mpSetPlayerCard", peripheral = "ender_chest_interface_0", card = "Alex" })
  sim({ cmd = "mpSetPlayer", player = "Alex", online = true })
  ccunit.eq(pack(ender.list()), { n = 2, false, "Player isn't present" })
end)

-- ===== scanner =====

local scanner = peripheral.wrap("scanner_0")
ccunit.test("scanner", function()
  ccunit.eq(peripheral.getType("scanner_0"), "scanner")
  ccunit.eq(pack(scanner.getPage(1)), { n = 2, true, "No griefing" })
  ccunit.eq(pack(scanner.getPage(2)), { n = 2, true, "Be nice" })
  ccunit.eq(err(scanner.getPage, 3), "Java Exception Thrown: java.lang.IndexOutOfBoundsException: index (2) must be less than size (2)")
  ccunit.eq(err(scanner.getPage, 4), "Expected page number to be between 0 and 2")
  ccunit.eq(err(scanner.getPage), "bad argument #1 (number expected, got nil)")
  ccunit.eq(pack(scanner.getAuthor()), { n = 2, true, "Steve" })
  ccunit.eq(pack(scanner.getTitle()), { n = 2, true, "Rules" })
  ccunit.eq(pack(scanner.getCopyStatus()), { n = 2, true, "COPY" })
  sim({ cmd = "mpSetScannerItem", peripheral = "scanner_0", item = { name = "computercraft:printed_page", count = 1,
    book = { title = "Note", pages = 1, lines = { "line one", "line two" } } } })
  ccunit.eq(pack(scanner.getPage(1)), { n = 2, true, "line one" })
  ccunit.eq(pack(scanner.getPage(2)), { n = 2, true, "line two" })
  ccunit.eq(pack(scanner.getTitle()), { n = 2, true, "Note" })
  ccunit.eq(pack(scanner.getAuthor()), { n = 2, false, "No author" })
  ccunit.eq(pack(scanner.getCopyStatus()), { n = 2, false, "Not a Written Book" })
  sim({ cmd = "mpSetScannerItem", peripheral = "scanner_0", item = { name = "minecraft:writable_book", count = 1, book = { pages = { "draft" } } } })
  ccunit.eq(pack(scanner.getPage(1)), { n = 2, true, "draft" })
  ccunit.eq(pack(scanner.getTitle()), { n = 2, false, "No Title" })
  sim({ cmd = "mpSetScannerItem", peripheral = "scanner_0", item = false })
  ccunit.eq(pack(scanner.getPage(1)), { n = 2, false, "No Book" })
  ccunit.eq(pack(scanner.getAuthor()), { n = 2, false, "No Book" })
end)

-- ===== grinder =====

local grinder = peripheral.wrap("grinder_0")
ccunit.test("grinder", function()
  ccunit.eq(grinder.hasSword(), false)
  ccunit.eq(pack(grinder.attack()).n, 0)
  ccunit.eq(err(grinder.pullSword, C2), "bad argument #2 (number expected, got nil)")
  ccunit.eq(pack(grinder.pullSword("nope", 1)), { n = 2, false, "the input nope was not found" })
  ccunit.eq(pack(grinder.pullSword(C2, -1)), { n = 2, false, "slot out of range" })
  ccunit.eq(err(grinder.pullSword, "crafter_0", 1),
    'Java Exception Thrown: java.lang.NullPointerException: Cannot invoke "net.minecraftforge.items.IItemHandler.getSlots()" because "inputHandler" is null')
  -- the slot is not shifted to 0-based: 5 is the chest's sixth slot
  ccunit.eq(pack(grinder.pullSword(C2, 5)), { n = 1, true })
  ccunit.eq(grinder.hasSword(), true)
  ccunit.eq(slot(C2, 6), nil)
  ccunit.eq(pack(grinder.pullSword(C2, 0)), { n = 1, false })
  ccunit.eq(pack(grinder.pushSword("nope")), { n = 2, false, "the output nope was not found" })
  ccunit.eq(pack(grinder.pushSword(C3)), { n = 1, true })
  ccunit.eq(count(C3, "minecraft:iron_sword"), 1)
  ccunit.eq(grinder.hasSword(), false)
end)
