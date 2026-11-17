-- Runs buyer_bot.lua on a turtle (buyer_bot.world.json: a bread shop in front with 3 sales stocked, a creative torch
-- shop above, nothing below) and checks shop.buy, shop.buyUp and shop.buyDown with every failure they give.

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end

--- runs the program and gives what it printed
local function run(...)
  local w, h = term.getSize()
  local win = window.create(term.current(), 1, 1, w, h, false)
  local old = term.redirect(win)
  shell.run("examples/cc-shops/buyer_bot.lua", ...)
  term.redirect(old)
  local lines = {}
  for y = 1, h do
    local line = win.getLine(y):gsub("%s+$", "")
    if line ~= "" then lines[#lines + 1] = line end
  end
  return table.concat(lines, "\n")
end

local front = peripheral.wrap("front")

ccunit.test("the shop API is there on a 1.18.2 turtle", function()
  ccunit.eq(type(shop.buy), "function")
  ccunit.eq(type(shop.buyUp), "function")
  ccunit.eq(type(shop.buyDown), "function")
end)

ccunit.test("buying bread until the shop runs out", function()
  ccunit.eq(run(4), table.concat({
    "Buying 4 x minecraft:bread",
    "Price: 2 minecraft:emerald",
    "Stopped: Out of Stock",
    "Bought 3 of 4",
  }, "\n"))
  ccunit.eq(turtle.getItemDetail(3), { name = "minecraft:bread", count = 12 })
  ccunit.eq(turtle.getItemCount(1), 4)
  ccunit.eq(front.getStockAmount(), 0)
  ccunit.eq(front.getGainsAmount(), 6)
end)

ccunit.test("buying torches from the creative shop above", function()
  ccunit.eq(run(2, "up"), table.concat({
    "Buying 2 x minecraft:torch",
    "Price: 8 minecraft:cobblestone",
    "Bought 2 of 2",
  }, "\n"))
  ccunit.eq(turtle.getItemDetail(4), { name = "minecraft:torch", count = 32 })
  ccunit.eq(turtle.getItemCount(2), 16)
  ccunit.eq(run(1, "down"), "No shop down")
end)

ccunit.test("every failure", function()
  turtle.select(1) -- 4 emeralds
  ccunit.eq(table.pack(shop.buy()), { n = 2, false, "Out of Stock" })
  ccunit.eq(table.pack(shop.buyDown()), { n = 2, false, "Not a Shop" })
  ccunit.eq(table.pack(shop.buyUp()), { n = 2, false, "Incorrect Payment Item" })
  sim({ cmd = "shopSet", shop = "0,64,-1", stored = 8, cost = { name = "minecraft:emerald", count = 5 } })
  ccunit.eq(table.pack(shop.buy()), { n = 2, false, "Insufficient Funds" })
end)

ccunit.test("the turtle hears its own buy_attempt (the shop in front is its peripheral)", function()
  sim({ cmd = "shopSet", shop = "0,64,-1", cost = { name = "minecraft:emerald", count = 1 } })
  os.setComputerLabel("Baker")
  local ev
  parallel.waitForAll(function()
    ccunit.eq(table.pack(shop.buy()), { n = 1, true })
  end, function()
    ev = table.pack(os.pullEvent("buy_attempt"))
  end)
  ccunit.eq(ev, { n = 5, "buy_attempt", "Baker", { name = "minecraft:emerald", count = 4 }, false, true })
  ccunit.eq(turtle.getItemDetail(3), { name = "minecraft:bread", count = 16 })
end)
