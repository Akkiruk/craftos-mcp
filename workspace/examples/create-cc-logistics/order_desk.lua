-- Order desk for a Create logistics network (Create: CC Total Logistics).
--
-- Reads the shopping list off a clipboard ("12 iron ingot" per line), checks the stock ticker for each item,
-- orders what the network has through a redstone requester, and waits for the packages to land in the frogport.
--
-- Usage: order_desk [address]   (default: the frogport's own address filter)

local ticker = peripheral.find("stockcheckingblock") or error("no stock ticker attached", 0)
local requester = peripheral.find("redstonerequester") or error("no redstone requester attached", 0)
local port = peripheral.find("packageport") or error("no frogport or postbox attached", 0)
local clipboard = peripheral.find("clipboard")

local address = ... or port.getAddressFilter()

--- The network's stock as id -> { count, name, index }
local function stock()
  local out = {}
  for i = 1, ticker.inventorySize() do
    local d = ticker.itemBasicDetails(i)
    out[d.id] = { count = d.count, name = d.displayName, index = i }
  end
  return out
end

--- Lines like "12 iron ingot" or "3 Andesite Alloy"
local function shoppingList()
  local list = {}
  if not clipboard then return list end
  for page = 1, clipboard.getNumPages() do
    for _, entry in ipairs(clipboard.readPage(page)) do
      local count, what = entry.text:match("^%s*(%d+)%s+(.-)%s*$")
      if count and not entry.checked then
        list[#list + 1] = { count = tonumber(count), what = what:lower():gsub(" ", "_") }
      end
    end
  end
  return list
end

local function packagesHere()
  local n = 0
  for _ in pairs(port.listPackages()) do n = n + 1 end
  return n
end

print(("Stock links: %d"):format(ticker.countConnectedStockLinks()))
for i = 1, ticker.countConnectedStockLinks() do
  local link = ticker.stockLinkDetails(i)
  print(("  %s: %s/%s slots"):format(link.type, tostring(link.occupiedSlots), tostring(link.capacity)))
end

local have = stock()
local order = {}
for _, want in ipairs(shoppingList()) do
  local s = have[want.what]
  if not s then
    print(("Not in stock: %s"):format(want.what))
  else
    local n = math.min(want.count, s.count)
    print(("Ordering %d x %s (%d in stock)"):format(n, s.name, s.count))
    order[#order + 1] = { index = s.index, count = n }
  end
end

if #order == 0 then
  print("Nothing to order.")
  return
end

local before = packagesHere()
if not requester.request(order, address, true) then
  print("The network turned the order down.")
  return
end
print(("Sent to %s, waiting for packages..."):format(address))

local deadline = os.clock() + 30
while packagesHere() == before and os.clock() < deadline do sleep(0.5) end

for slot, pkg in pairs(port.listPackages()) do
  print(("Package in slot %d for %s:"):format(slot, pkg.address))
  for _, item in ipairs(port.getPackageContentDetails(slot)) do
    print(("  %d x %s"):format(item.count, item.displayName))
  end
end
print(packagesHere() > before and "Order delivered." or "Still waiting on the delivery.")
