-- Buyer bot: a turtle in front of (or under, or on top of) a Simple Shop buys a number of sales with the CC Shops
-- `shop` API, paying from whichever slot holds the price.
--   buyer_bot <sales> [front|up|down]

local args = { ... }
local wanted = tonumber(args[1]) or 1
local where = args[2] or "front"
local buy = ({ front = shop.buy, up = shop.buyUp, down = shop.buyDown })[where] or error("front, up or down", 0)
local side = ({ front = "front", up = "top", down = "bottom" })[where]

local counter = peripheral.wrap(side)
if not counter or peripheral.getType(side) ~= "shop" then
  print("No shop " .. where)
  return
end
local cost = counter.getCostItem()
print(("Buying %d x %s"):format(wanted, counter.getStockItem().name))
print(("Price: %d %s"):format(cost.count, cost.name))

--- the slot with enough of the price in it
local function paySlot()
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item and item.name == cost.name and item.count >= cost.count then return slot end
  end
end

local bought = 0
while bought < wanted do
  local slot = paySlot()
  if not slot then
    print("Out of money")
    break
  end
  turtle.select(slot)
  local ok, why = buy()
  if not ok then
    print("Stopped: " .. why)
    break
  end
  bought = bought + 1
end
print(("Bought %d of %d"):format(bought, wanted))
