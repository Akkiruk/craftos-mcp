-- storage_card.lua, then every CCX function: the PCIe hub's cards and the USB port's wireless USB.
local T, eq, ok = ccunit.test, ccunit.eq, ccunit.truthy
local lines = {}
local function run()
  local env = setmetatable({ print = function(t) lines[#lines + 1] = t end }, { __index = _ENV })
  return assert(loadfile("examples/ccx/storage_card.lua", nil, env))()
end
local function err(fn, ...)
  local okc, e = pcall(fn, ...)
  if okc then error("expected an error", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end

T("the program lists the far chest", function()
  run()
  eq(lines, { " 1 [Diamond] x12", " 4 [Iron Pickaxe] x1", "13 items in 2 of 27 slots" })
end)

T("pcie: one method; the inventory card's four functions", function()
  eq(peripheral.getMethods("pcie_0"), { "getMethods" })
  local cards = peripheral.call("pcie_0", "getMethods")
  local inv = cards.card_1
  eq(inv.size(), 27)
  eq(inv.getItemDetail(1), { name = "minecraft:diamond", count = 12, displayName = "[Diamond]", maxStackSize = 64, nbt = {} })
  eq(inv.getItemDetail(2), nil)
  eq(inv.getItemLimit(4), 1)
  eq(inv.getItemLimit(2), 64)
  eq(err(inv.getItemDetail), "bad argument #1 (number expected, got nil)")
end)

T("pcie: the peripheral card only says so", function()
  local cards = peripheral.call("pcie_0", "getMethods")
  eq({ cards.card_2.attachPeripheral() }, { true, "Peripheral Attached!" })
  eq({ cards.card_2.detachPeripheral() }, { true, "Peripheral Detached!" })
  eq(cards.card_3, nil)
end)

T("usb_port: the wireless USB", function()
  local usb = peripheral.call("usb_port_0", "getMethods").usb
  eq({ usb.getChannel() }, { true, 5 })
  eq({ usb.setChannel(70000) }, { true, 65535 })
  eq({ usb.setChannel(-3) }, { true, 1 })
  eq({ usb.broadcast("hi", 1) }, { true, "Message sent!" })
  eq(err(usb.broadcast, "hi"), "bad argument #2 (number expected, got nil)")
  eq(err(usb.setChannel), "bad argument #1 (number expected, got nil)")
end)
