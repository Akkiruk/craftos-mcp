-- Shop kiosk: a command computer next to a Simple Shop (CC Shops). It prints what the shop sells, logs every
-- buy_attempt to kiosk.log, and refills the shop when it runs low.
--   kiosk [low] [refill]   refill to `refill` sales when fewer than `low` are left (default 2 and 10)

local shop = peripheral.find("shop") or error("no shop attached", 0)
local args = { ... }
local LOW, REFILL = tonumber(args[1]) or 2, tonumber(args[2]) or 10

local function describe(item)
  if item.count == 0 then return "nothing" end
  return item.count .. " x " .. item.name
end

local function log(line)
  print(line)
  local f = fs.open("kiosk.log", "a")
  f.writeLine(line)
  f.close()
end

local ownerName, ownerId = shop.getOwner()
print(("Shop of %s (%s)"):format(ownerName or "someone offline", ownerId))
print("Selling " .. describe(shop.getStockItem()))
print(("Price %s, %d left"):format(describe(shop.getCostItem()), shop.getStockAmount()))

local sales = 0
while true do
  local _, buyer, offered, creative, ok = os.pullEvent("buy_attempt")
  buyer = buyer or "a turtle"
  if ok then
    sales = sales + 1
    log(("SALE %d: %s paid %s"):format(sales, buyer, describe(offered)))
  else
    log(("NO SALE: %s offered %s%s"):format(buyer, describe(offered), creative and " (creative shop)" or ""))
  end
  -- setStockAmount takes the number of items, not of sales
  if shop.setStockAmount and shop.getStockAmount() < LOW then
    shop.setStockAmount(REFILL * shop.getStockItem().count)
    log(("REFILL: %d sales in stock, %d payments held"):format(shop.getStockAmount(), shop.getGainsAmount()))
  end
end
