-- Reads a far-away chest through a CCX inventory card in a PCIe hub and prints what it holds.
local hub = peripheral.find("pcie")
if not hub then error("no PCIe hub attached", 0) end
local cards = hub.getMethods()
local card
for slot = 1, 4 do
  local c = cards["card_" .. slot]
  if c and c.list then card = c break end
end
if not card then error("no inventory card in the hub", 0) end

local total, kinds = 0, 0
for slot, item in pairs(card.list()) do
  total = total + item.count
  kinds = kinds + 1
  print(("%2d %s x%d"):format(slot, item.displayName, item.count))
end
print(("%d items in %d of %d slots"):format(total, kinds, card.size()))
