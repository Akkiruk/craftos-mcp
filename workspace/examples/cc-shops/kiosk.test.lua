-- Runs kiosk.lua against a command-computer shop (kiosk.world.json: 2 diamonds for 3 emeralds, 3 sales stocked)
-- while players buy through sim commands, then checks every shop method, its errors and the setters' quirks.

local shop = peripheral.wrap("shop_0")
local ALEX = "4f3a2b1c-0000-4000-8000-00000000abcd"
local GOLEM = "11111111-2222-3333-4444-555555555555"

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

local function readLog()
  if not fs.exists("kiosk.log") then return "" end
  local f = fs.open("kiosk.log", "r")
  local text = f.readAll()
  f.close()
  return text
end

local seen = {}
if fs.exists("kiosk.log") then fs.delete("kiosk.log") end
local w, h = term.getSize()
local screen = window.create(term.current(), 1, 1, w, h, false)
local function scenario()
  sleep(0.3)
  local emeralds = { name = "minecraft:emerald", count = 5 }
  sim({ cmd = "shopPlayerBuy", shop = "shop_0", player = "Steve", item = emeralds })
  sim({ cmd = "shopPlayerBuy", shop = "shop_0", player = "Steve", item = emeralds }) -- 1 sale left: refill
  sim({ cmd = "shopPlayerBuy", shop = "shop_0", player = "Steve", item = { name = "minecraft:dirt", count = 64 } })
  sleep(0.3)
  seen.log = readLog()
  local lines = {}
  for y = 1, h do lines[y] = screen.getLine(y) end
  seen.screen = table.concat(lines, "\n")
end
local old = term.redirect(screen)
parallel.waitForAny(function() shell.run("examples/cc-shops/kiosk.lua") end, scenario)
term.redirect(old)

ccunit.test("the kiosk shows the shop", function()
  ccunit.truthy(seen.screen:find("Shop of Alex (" .. ALEX .. ")", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("Selling 2 x minecraft:diamond", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("Price 3 x minecraft:emerald, 3 left", 1, true), seen.screen)
end)

ccunit.test("the kiosk logs sales and refills", function()
  ccunit.eq(seen.log, table.concat({
    "SALE 1: Steve paid 5 x minecraft:emerald",
    "SALE 2: Steve paid 5 x minecraft:emerald",
    "REFILL: 10 sales in stock, 6 payments held",
    "NO SALE: Steve offered 64 x minecraft:dirt",
  }, "\n"))
  ccunit.eq(shop.getStockAmount(), 10)
  ccunit.eq(shop.getGainsAmount(), 6)
end)

ccunit.test("getters", function()
  ccunit.eq(peripheral.getType("shop_0"), "shop")
  ccunit.eq(shop.getStockItem(), { name = "minecraft:diamond", count = 2 })
  ccunit.eq(shop.getCostItem(), { name = "minecraft:emerald", count = 3 })
  ccunit.eq(shop.getBarItem(), { name = "minecraft:air", count = 0 })
  ccunit.eq(table.pack(shop.getOwner()), { n = 2, "Alex", ALEX })
end)

ccunit.test("setters", function()
  shop.setStockItem({ name = "minecraft:gold_ingot", count = 5 })
  ccunit.eq(shop.getStockItem(), { name = "minecraft:gold_ingot", count = 5 })
  shop.setStockAmount(17)
  ccunit.eq(shop.getStockAmount(), 3) -- 17 items, 5 a sale
  shop.setCostItem({ name = "minecraft:emerald" })
  ccunit.eq(shop.getCostItem(), { name = "minecraft:emerald", count = 1 })
  shop.setGainsAmount(0)
  ccunit.eq(shop.getGainsAmount(), 0)
  -- these two set what they can and then always throw
  ccunit.eq(err(shop.setBarItem, { name = "simpleshops:green_stockbar" }), "Not a Bar")
  ccunit.eq(shop.getBarItem(), { name = "simpleshops:green_stockbar", count = 1 })
  ccunit.eq(err(shop.setOwner, GOLEM), "Invalid UUID")
  ccunit.eq(table.pack(shop.getOwner()), { n = 2, "Shop Golem", GOLEM })
end)

ccunit.test("argument errors", function()
  ccunit.eq(err(shop.setStockItem, "diamond"), "bad argument #1 (table expected, got string)")
  ccunit.eq(err(shop.setStockItem, { count = 1 }), "Invalid Item Data, needs name")
  ccunit.eq(err(shop.setCostItem, { name = "minecraft:not_an_item" }), "Invalid Item Name, use namespace:id format")
  ccunit.eq(err(shop.setBarItem, { name = "minecraft:stick" }), "Not a Bar")
  ccunit.eq(err(shop.setStockAmount, "lots"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(shop.setGainsAmount), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(shop.setOwner, 42), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(shop.setOwner, "steve"), "Java Exception Thrown: java.lang.IllegalArgumentException: Invalid UUID string: steve")
end)
