-- Runs order_desk.lua against order_desk.world.json (Minecraft 1.20.1, CC Total Logistics 0.3.7), then calls every
-- method of the four peripherals, good arguments and bad.

local ticker = peripheral.wrap("stockticker_0")
local requester = peripheral.wrap("redstonerequester_0")
local port = peripheral.wrap("frogport_0")
local clipboard = peripheral.wrap("clipboard_0")
local chest = peripheral.wrap("minecraft:chest_0")

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.25) end
  return condition()
end

local function count(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  return n
end

-- ----- the program -----

local printed = {}
local realPrint = _G.print
_G.print = function(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring(select(i, ...)) end
  printed[#printed + 1] = table.concat(parts, " ")
end
local ran, runError = pcall(shell.run, "examples/create-cc-logistics/order_desk.lua")
_G.print = realPrint
local out = table.concat(printed, "\n")

ccunit.test("the order desk reads the clipboard, orders and sees the delivery", function()
  ccunit.truthy(ran, runError)
  ccunit.truthy(out:find("Stock links: 2", 1, true), out)
  ccunit.truthy(out:find("minecraft.chest: 3/27 slots", 1, true), out)
  ccunit.truthy(out:find("minecraft.barrel: 3/27 slots", 1, true), out)
  ccunit.truthy(out:find("Ordering 12 x Iron Ingot (40 in stock)", 1, true), out)
  ccunit.truthy(out:find("Ordering 84 x Wheat (84 in stock)", 1, true), out)
  ccunit.truthy(out:find("Not in stock: diamond", 1, true), out)
  ccunit.truthy(not out:find("carrot", 1, true), "a ticked line is not ordered")
  ccunit.truthy(out:find("Order delivered.", 1, true), out)
end)

ccunit.test("the items left the inventories and arrived packed", function()
  ccunit.eq(chest.getItemDetail(1).count, 28)
  local packages = port.listPackages()
  ccunit.eq(count(packages), 2)
  ccunit.eq(packages[1], { address = "Workshop", orderIsComplete = false }) -- 0.3.7 reads IsFinal at the wrong level
  local iron = port.getPackageContentDetails(1)
  ccunit.eq(#iron, 1)
  ccunit.eq(iron[1].id, "minecraft:iron_ingot")
  ccunit.eq(iron[1].count, 12)
  ccunit.eq(iron[1].item, '{"id":"minecraft:iron_ingot","Count":12}')
  local wheat = port.getPackageContentDetails(2)
  ccunit.eq(#wheat, 2)
  ccunit.eq({ wheat[1].count, wheat[2].count }, { 64, 20 })
end)

-- ----- stock ticker -----

ccunit.test("stockcheckingblock: getMethods and types", function()
  ccunit.eq(peripheral.getType("stockticker_0"), "stockcheckingblock")
  local m = peripheral.getMethods("stockticker_0")
  table.sort(m)
  ccunit.eq(m, { "countConnectedStockLinks", "getCountOf", "inventorySize", "itemBasicDetails", "itemDetails",
    "stockLinkDetails" })
end)

ccunit.test("stockcheckingblock: the summary", function()
  ccunit.eq(ticker.inventorySize(), 4) -- iron, cobblestone, andesite alloy, carrot
  ccunit.eq(ticker.itemBasicDetails(1), { count = 28, id = "iron_ingot", displayName = "Iron Ingot" })
  local d = ticker.itemDetails(3)
  ccunit.eq(d.id, "andesite_alloy") -- Item.toString on 1.20.1: the path only
  ccunit.eq(d.displayName, "Andesite Alloy")
  ccunit.eq(d.item, '{"id":"create:andesite_alloy","Count":16}')
  ccunit.eq(ticker.getCountOf(d.item), 16)
  ccunit.eq(ticker.getCountOf('{"id":"minecraft:carrot","Count":1}'), 33)
  ccunit.eq(ticker.getCountOf('{"id":"minecraft:diamond","Count":1}'), 0)
end)

ccunit.test("stockcheckingblock: argument errors", function()
  ccunit.eq(err(ticker.itemBasicDetails, 0), "Index out of range (between 1 and 4)")
  ccunit.eq(err(ticker.itemDetails, 5), "Index out of range (between 1 and 4)")
  ccunit.eq(err(ticker.itemDetails), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(ticker.itemBasicDetails, 0 / 0), "bad argument #1 (number expected, got nan)") -- 1.5 would be 1: CC truncates
  -- getCountOf takes an item's JSON, not its id: Gson stops at the colon and throws
  ccunit.truthy(err(ticker.getCountOf, "minecraft:iron_ingot"):find("JsonSyntaxException", 1, true))
  ccunit.eq(err(ticker.getCountOf, "iron_ingot"), 'Item not parseable from "iron_ingot" or non-existent')
  ccunit.eq(err(ticker.getCountOf, '{"id":"minecraft:iron_ingot"}'),
    'Item not parseable from "{"id":"minecraft:iron_ingot"}" or non-existent') -- Count is required on 1.20.1
  ccunit.eq(err(ticker.getCountOf, '{"id":"minecraft:not_an_item","Count":1}'),
    'Item not parseable from "{"id":"minecraft:not_an_item","Count":1}" or non-existent')
  ccunit.eq(err(ticker.getCountOf, {}), "bad argument #1 (string expected, got table)")
  ccunit.truthy(err(ticker.getCountOf, "{"):find("JsonSyntaxException", 1, true))
end)

ccunit.test("stockcheckingblock: stock links", function()
  ccunit.eq(ticker.countConnectedStockLinks(), 2)
  ccunit.eq(ticker.stockLinkDetails(1), { capacity = 27, occupiedSlots = 3, type = "minecraft.chest" })
  ccunit.eq(ticker.stockLinkDetails(2), { capacity = 27, occupiedSlots = 1, type = "minecraft.barrel",
    frogportAddress = "Farm" })
  ccunit.eq(err(ticker.stockLinkDetails, 3), "Index out of range (between 1 and 2)")
  -- a link powered at 15 leaves the network
  sim({ cmd = "cclSetLinkPower", network = "main", link = "farm", power = 15 })
  ccunit.eq(ticker.countConnectedStockLinks(), 1)
  ccunit.eq(ticker.inventorySize(), 3)
  sim({ cmd = "cclSetLinkPower", network = "main", link = "farm", power = 0 })
  ccunit.eq(ticker.countConnectedStockLinks(), 2)
end)

-- ----- redstone requester -----

ccunit.test("redstonerequester: getMethods", function()
  local m = peripheral.getMethods("redstonerequester_0")
  table.sort(m)
  ccunit.eq(m, { "request", "requestCraft" })
end)

ccunit.test("redstonerequester: request by id, item and index; partial and refused orders", function()
  local before = count(port.listPackages())
  ccunit.eq(requester.request({ { id = "minecraft:cobblestone", count = 10 } }, "Workshop"), true)
  ccunit.eq(requester.request({ { item = '{"id":"minecraft:carrot","Count":1}', count = 3 } }, "Workshop", false, false), true)
  -- more than there is: refused unless partial
  ccunit.eq(requester.request({ { index = 1, count = 1000 } }, "Workshop"), false)
  ccunit.eq(requester.request({ { index = 1, count = 1000 } }, "Elsewhere", true), true)
  ccunit.truthy(waitFor(function() return count(port.listPackages()) >= before + 2 end, 15), "packages arrive")
  ccunit.eq(chest.getItemDetail(1), nil) -- every iron ingot went to "Elsewhere"
  ccunit.eq(ticker.getCountOf('{"id":"minecraft:iron_ingot","Count":1}'), 0)
end)

ccunit.test("redstonerequester: argument errors", function()
  ccunit.eq(err(requester.request), "bad argument #1 (table expected, got nil)")
  ccunit.eq(err(requester.request, {}), "Contents list argument is empty")
  ccunit.eq(err(requester.request, { {} }), "Expected table format: {count = [int], item = [string]} or {count = [int], id = [string]} or {count = [int], index = [int]}")
  ccunit.eq(err(requester.request, { { count = 1 } }), "Expected table format: {count = [int], item = [string]} or {count = [int], id = [string]} or {count = [int], index = [int]}")
  ccunit.eq(err(requester.request, { { id = 5, count = 1 } }), "Expected table format: {count = [int], item = [string]} or {count = [int], id = [string]} or {count = [int], index = [int]}")
  ccunit.eq(err(requester.request, { { index = 99, count = 1 } }), "Index out of range (between 1 and 3)")
  ccunit.eq(err(requester.request, { { id = "minecraft:nope", count = 1 } }), 'Item not parseable from "minecraft:nope" or non-existent')
  ccunit.eq(err(requester.request, { "x", "y" }), "class java.lang.String cannot be cast to class java.util.Map (java.lang.String and java.util.Map are in module java.base of loader 'bootstrap')")
  ccunit.eq(err(requester.request, { a = {}, b = {} }), "class java.lang.String cannot be cast to class java.lang.Double (java.lang.String and java.lang.Double are in module java.base of loader 'bootstrap')")
  ccunit.eq(err(requester.request, { { id = "minecraft:carrot", count = 1 } }, "5", "x"), "bad argument #3 (boolean expected, got string)")
  ccunit.eq(err(requester.request, { { id = "minecraft:carrot", count = 1 } }, 5), "bad argument #2 (string expected, got number)") -- getString takes no number
  ccunit.eq(err(requester.request, { { id = "minecraft:carrot", count = 1 } }, {}), "bad argument #2 (string expected, got table)")
  ccunit.eq(err(requester.request, { { id = "minecraft:carrot", count = 1 } }, "a", true, 1), "bad argument #4 (boolean expected, got number)")
end)

ccunit.test("redstonerequester: requestCraft", function()
  sim({ cmd = "cclAddItems", network = "main", link = "vault", items = { { name = "minecraft:oak_planks", count = 8 } } })
  local before = count(port.listPackages())
  ccunit.eq(requester.requestCraft({ { id = "minecraft:oak_planks" }, { id = "minecraft:oak_planks" }, "empty" }, "Workshop"), true)
  -- wait for it here, or it lands in the port halfway through the package port tests
  ccunit.truthy(waitFor(function() return count(port.listPackages()) > before end, 15), "the craft package arrives")
  ccunit.eq(requester.requestCraft({ { id = "minecraft:diamond" } }), false)
  ccunit.eq(err(requester.requestCraft, {}), "Contents list argument is empty")
  ccunit.eq(err(requester.requestCraft, { "empty", "empty" }), "Contents list argument is empty")
  ccunit.eq(err(requester.requestCraft, { 5 }), 'Expected crafting format: {item = [string]} or {id = [string]} or {index = [int]} or "empty", got 5.0')
  ccunit.eq(err(requester.requestCraft, { { item = 5 } }), 'Expected crafting format: {item = [string]} or {id = [string]} or {index = [int]} or "empty"')
  ccunit.eq(err(requester.requestCraft, { {} }), "Expected table format: {count = [int], item = [string]} or {count = [int], id = [string]} or {count = [int], index = [int]}")
  local ten = {}
  for i = 1, 10 do ten[i] = { id = "minecraft:oak_planks" } end
  ccunit.eq(err(requester.requestCraft, ten), "Cowardly refusing to package >9 items in a single crafting request")
  ccunit.eq(err(requester.requestCraft, nil), "bad argument #1 (table expected, got nil)")
  ccunit.eq(err(requester.requestCraft, { "empty", { id = "minecraft:oak_planks" } }, "a", "b"), "bad argument #3 (boolean expected, got string)")
end)

-- ----- package port -----

ccunit.test("packageport: getMethods and types", function()
  local types = { peripheral.getType("frogport_0") }
  ccunit.eq(types, { "packageport", "inventory" })
  local m = peripheral.getMethods("frogport_0")
  table.sort(m)
  ccunit.eq(m, { "capacity", "getAcceptsPackages", "getAddressFilter", "getPackageContentDetails", "listPackages",
    "renamePackageAddress", "setAcceptsPackages", "setAddressFilter" })
end)

ccunit.test("packageport: filter, accepting, renaming", function()
  ccunit.eq(port.capacity(), 18)
  ccunit.eq(port.getAddressFilter(), "Workshop")
  ccunit.eq(port.getAcceptsPackages(), true)
  port.setAcceptsPackages(false)
  ccunit.eq(port.getAcceptsPackages(), false)
  port.setAcceptsPackages(true)
  port.setAddressFilter("Work*")
  ccunit.eq(port.getAddressFilter(), "Work*")
  port.setAddressFilter("Workshop")
  ccunit.eq(select("#", port.renamePackageAddress(1, "Basement")), 0)
  ccunit.eq(port.listPackages()[1].address, "Basement")
end)

ccunit.test("packageport: other inventories move packages through it", function()
  -- a package addressed elsewhere goes in; one addressed here comes out
  local barrel = peripheral.wrap("minecraft:barrel_0")
  ccunit.eq(chest.pullItems("frogport_0", 1), 0) -- slot 1 is for "Basement", not this port: it stays
  ccunit.eq(barrel.pullItems("frogport_0", 2), 1)
  ccunit.eq(barrel.list()[1].name:match("^create:cardboard_package"), "create:cardboard_package")
  ccunit.eq(barrel.pushItems("frogport_0", 1), 0) -- addressed to this port: the automation side refuses it
  ccunit.eq(barrel.pushItems("frogport_0", 1, nil, 2), 0)
  ccunit.eq(port.listPackages()[2], nil)
end)

ccunit.test("packageport: argument errors", function()
  ccunit.eq(err(port.getPackageContentDetails, 0), "Index out of range (between 1 and 18)")
  ccunit.eq(err(port.getPackageContentDetails, 18), "Targeted index is empty")
  ccunit.eq(err(port.renamePackageAddress, 19, "x"), "Index out of range (between 1 and 18)")
  ccunit.eq(err(port.renamePackageAddress, 18, "x"), "Targeted index is empty")
  ccunit.eq(err(port.renamePackageAddress, 1), "bad argument #2 (string expected, got nil)")
  ccunit.eq(err(port.setAcceptsPackages, "yes"), "bad argument #1 (boolean expected, got string)")
  ccunit.eq(err(port.setAddressFilter), "bad argument #1 (string expected, got nil)")
end)

ccunit.test("packageport: a delivered package by sim command", function()
  sim({ cmd = "cclDeliverPackage", port = "frogport_0", slot = 10, address = "Workshop",
    items = { { name = "minecraft:apple", count = 5 } } })
  ccunit.eq(port.listPackages()[10], { address = "Workshop", orderIsComplete = false })
  local apple = port.getPackageContentDetails(10)[1]
  ccunit.eq({ apple.count, apple.id, apple.displayName, apple.item },
    { 5, "minecraft:apple", "Apple", '{"id":"minecraft:apple","Count":5}' })
  sim({ cmd = "cclTakePackage", port = "frogport_0", slot = 10 })
  ccunit.eq(port.listPackages()[10], nil)
end)

-- ----- clipboard -----

ccunit.test("clipboard", function()
  ccunit.eq(peripheral.getType("clipboard_0"), "clipboard")
  ccunit.eq(clipboard.isClipboardAttached(), true)
  ccunit.eq(clipboard.getNumPages(), 1)
  local page = clipboard.readPage(1)
  ccunit.eq(#page, 5)
  ccunit.eq(page[2], { checked = false, text = "12 iron ingot" })
  ccunit.eq(page[5].checked, true)
  ccunit.eq(err(clipboard.readPage, 2), "Index out of range (between 1 and 1)")
  ccunit.eq(err(clipboard.readPage, "x"), "bad argument #1 (number expected, got string)")
  sim({ cmd = "cclSetClipboard", peripheral = "clipboard_0", pages = { {
    { text = "Iron", icon = { name = "minecraft:iron_ingot", count = 1 }, amount = 32 } } } })
  local icon = clipboard.readPage(1)[1].icon
  ccunit.eq(icon, { count = 32, id = "minecraft:iron_ingot", displayName = "Iron Ingot",
    item = '{"id":"minecraft:iron_ingot","Count":1}' })
end)
