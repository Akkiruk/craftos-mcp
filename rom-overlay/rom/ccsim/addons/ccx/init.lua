-- ccsim addon ccx: CCX 6.1.1 (Minecraft 1.20.1, Forge and Fabric), by minecraftbossdj.
--
-- Written from the mod's source, github.com/minecraftbossdj/CCX at commit 20f1e4e (branch multiloader, mod_version
-- 6.1.1), common/src/main/java/com/awesoft/ccx/:
--   block/pcie/PCIePeripheral (type "pcie", 4 card slots), luaFunctions/cards/InventoryCardFunctions,
--   PeripheralCardFunctions, CommandCardFunctions, block/usb/USBPeripheral (type "usb_port"),
--   luaFunctions/usb/WirelessUSBFunctions, misc/WiFiNetwork, lib/LuaConverter.
-- Both peripherals have one method, getMethods (mainThread), which hands back tables of functions (ILuaFunction)
-- for the cards in the block; those functions run where they are called, on the computer thread.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local order = dofile("/rom/ccsim/addons/javamap.lua").order
  local M = {}

  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end
  local function int(i, v) return C.int(i, v) end
  local function str(i, v)
    if type(v) ~= "string" then error(("bad argument #%d (string expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end

  -- LuaConverter.itemToLua: the item in a slot of another block's inventory, or nil
  local function itemToLua(item)
    if not item then return nil end
    -- ItemStack.getDisplayName(): the hover name in square brackets
    local plain = item.displayName or ((item.name:match(":(.*)$") or item.name):gsub("_", " "):gsub("(%a)(%w*)", function(a, b) return a:upper() .. b end))
    local out = { name = item.name, count = item.count, displayName = "[" .. plain .. "]",
      maxStackSize = item.maxCount or 64, nbt = type(item.nbtTable) == "table" and item.nbtTable or {} }
    if item.maxDamage then
      out.damage = item.damage or 0
      out.maxDamage = item.maxDamage
    end
    return out
  end

  -- ===== pcie =====

  local CARDS = { inventory = "ccx:inventory_card", peripheral = "ccx:peripheral_card", command = "ccx:command_card" }

  local function newPcie(def)
    local s = saved(def.name)
    local o = { name = def.name, cards = {} }
    local src = s and s.cards or def.cards or {}
    for i = 1, 4 do
      local c = src[i] or src[tostring(i)]
      if type(c) == "table" and CARDS[c.kind] then o.cards[i] = { kind = c.kind, target = c.target, bound = c.bound ~= false } end
    end
    local function inventoryOf(target)
      if type(target) ~= "string" then return nil end
      local inv = host.findInventory(target)
      return inv
    end
    local function inventoryFunctions(slot)
      local function check() local c = o.cards[slot] return c and c.kind == "inventory" end
      local function inv() return inventoryOf(o.cards[slot] and o.cards[slot].target) end
      local f = {}
      f.size = function()
        if not check() then return false, "Card not inserted!" end
        local i = inv()
        if not i then return false, "Block is NOT a inventory!" end
        return i.size()
      end
      f.list = function()
        if not check() then return false, "Card not inserted!" end
        local i = inv()
        if not i then return false, "Block is NOT a inventory!" end
        local out = {}
        local items = i.__state()
        for k = 1, i.size() do out[k] = itemToLua(items[k]) end
        return out
      end
      f.getItemDetail = function(...)
        if not check() then return false, "Card not inserted!" end
        local i = inv()
        if not i then return false, "Block is NOT a inventory!" end
        local n = int(1, (...))
        return itemToLua(i.__state()[n])
      end
      f.getItemLimit = function(...)
        if not check() then return false, "Card not inserted!" end
        local i = inv()
        if not i then return false, "Block is NOT a inventory!" end
        local n = int(1, (...))
        local item = i.__state()[n]
        return item and (item.maxCount or 64) or 64 -- an empty slot is ItemStack.EMPTY, whose max stack size is 64
      end
      return f
    end
    local function peripheralFunctions(slot)
      local f = {}
      local function call(done)
        local c = o.cards[slot]
        local target = c and c.target
        -- periphBlockEntity.getBlockPos() comes before the null check
        if type(target) ~= "string" or not host.find(target) and not peripheral.isPresent(target) then
          if type(target) ~= "string" then C.java("java.lang.NullPointerException") end
          return false, "Not a valid peripheral! (debug: actual peripheral)"
        end
        -- the mod only calls the peripheral's attach/detach hook; the computer does not get it as a peripheral
        return true, done
      end
      f.attachPeripheral = function() return call("Peripheral Attached!") end
      f.detachPeripheral = function() return call("Peripheral Detached!") end
      return f
    end
    local m = {}
    function m.getMethods()
      local functions = {}
      for i = 1, 4 do
        local c = o.cards[i]
        if c then
          -- a card with no NBT (never bound to a block): the whole answer is nil
          if not c.bound then return nil end
          if c.kind == "peripheral" then functions["card_" .. i] = peripheralFunctions(i)
          elseif c.kind == "inventory" then functions["card_" .. i] = inventoryFunctions(i) end
          -- the command card has no case here: CommandCardFunctions is never used
        end
      end
      return functions
    end
    o.methods = m
    return o
  end

  -- ===== usb_port =====

  local function newUsb(def)
    local s = saved(def.name)
    local o = { name = def.name }
    local u = s and s.usb or def.usb
    if type(u) == "table" or u == true then
      o.usb = { channel = type(u) == "table" and tonumber(u.channel) or nil }
    end
    -- attach(): a wireless USB in the port starts listening on its channel (1 when it has none), and only then
    if o.usb then
      if o.usb.channel == nil then o.usb.channel = 1 end
      o.listening = o.usb.channel
    end
    local function check() return o.usb ~= nil end
    local function usbFunctions()
      local f = {}
      f.setChannel = function(...)
        if not check() then return false, "USB not inserted!" end
        local ch = int(1, (...))
        if ch > 65535 then ch = 65535 end
        if ch <= 0 then ch = 1 end
        o.usb.channel = ch
        return true, ch
      end
      f.getChannel = function()
        if not check() then return false, "USB not inserted!" end
        if o.usb.channel == nil then o.usb.channel = 1 end
        return true, o.usb.channel
      end
      f.broadcast = function(...)
        if not check() then return false, "USB not inserted!" end
        local message, channel = str(1, (...)), int(2, select(2, ...))
        -- WiFiNetwork.broadcast: to every other computer listening on the channel; this computer is never one
        local _ = message and channel
        return true, "Message sent!"
      end
      return f
    end
    local m = {}
    function m.getMethods()
      local functions = {}
      if o.usb then functions.usb = usbFunctions() end
      return functions
    end
    o.methods = m
    return o
  end

  local blocks = {}
  function M.peripheral(def)
    local o = def.type == "pcie" and newPcie(def) or newUsb(def)
    blocks[def.name] = o
    return {
      methods = o.methods,
      methodOrder = order({ "getMethods" }),
      computerThread = {},
      exactReturns = true,
      state = function()
        if def.type == "pcie" then
          local cards = {}
          for i = 1, 4 do if o.cards[i] then cards[tostring(i)] = o.cards[i] end end
          return { cards = cards }
        end
        return { usb = o.usb, listening = o.listening }
      end,
      detach = function() blocks[def.name] = nil end,
    }
  end

  local handlers = {}
  --- ccxSetCard {peripheral, slot, card = { kind, target, bound? } | null}: a card goes into (or out of) a PCIe slot
  function handlers.ccxSetCard(cmd)
    local o = blocks[tostring(cmd.peripheral)]
    if not o or not o.cards then return false, "no pcie named " .. tostring(cmd.peripheral) end
    local slot = tonumber(cmd.slot)
    if not slot or slot < 1 or slot > 4 then return false, "slot must be 1 to 4" end
    local c = cmd.card
    if type(c) == "table" then
      if not CARDS[c.kind] then return false, "card kind must be inventory, peripheral or command" end
      o.cards[slot] = { kind = c.kind, target = c.target, bound = c.bound ~= false }
    else
      o.cards[slot] = nil
    end
    return true
  end
  --- ccxSetUsb {peripheral, usb = { channel? } | null}: the wireless USB goes into (or out of) the port
  function handlers.ccxSetUsb(cmd)
    local o = blocks[tostring(cmd.peripheral)]
    if not o or o.cards then return false, "no usb_port named " .. tostring(cmd.peripheral) end
    if type(cmd.usb) == "table" then o.usb = { channel = tonumber(cmd.usb.channel) } else o.usb = nil end
    return true
  end
  M.handlers = handlers
  return M
end
