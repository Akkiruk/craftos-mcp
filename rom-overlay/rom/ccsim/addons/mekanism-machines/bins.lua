-- ccsim addons/mekanism-machines/bins: the Bins, every tier (see engine.lua, blocks.lua).
--
-- A bin is a Mekanism peripheral of its own ("basicBin" ... "creativeBin"), not CC's generic inventory: CC uses a
-- block's peripheral capability before its generic ones, so pushItems/pullItems do not reach it.
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/TileEntityBin (getStored wraps the bin slot, getCapacity = the slot's limit, onUpdateServer: while active
--   it pushes the bottom stack down when delayTicks reaches 0, then waits 10 ticks counted down twice a tick),
--   inventory/slot/BinInventorySlot (one item type, the tier's count; a creative bin never empties), tier/BinTier
--   (4096, 8192, 32768, 262144, Integer.MAX_VALUE), registries/MekanismBlockTypes.createBin (a Machine without
--   security, upgrades or redstone: facing and comparator only).
return function(E)
  local B, J = E.B, E.J
  local floor, min = math.floor, math.min

  local TIERS = { basic = 4096, advanced = 8192, elite = 32768, ultimate = 262144, creative = 2147483647 }

  local K = { kind = "bin" }
  K.rates = {}
  B.kindDefaults(K)

  local O = {
    directional = true, noSecurity = true,
    comparator = function(mb) return E.redstoneLevel(mb.item and mb.item.count or 0, mb.cap) end,
  }

  function K.init(mb, spec)
    local tier = K.types[spec.type] and K.types[spec.type].tier
    if not tier then error("ccsim: unknown bin '" .. tostring(spec.type) .. "'", 0) end
    mb.tier, mb.cap, mb.creative = tier, TIERS[tier], tier == "creative"
    B.newBlock(spec, mb, O)
    mb.item = B.stack(spec.item)
    if mb.item then mb.item.count = min(mb.item.count, mb.cap) end
    -- 10.4+: `locked = true` locks it to its item (or `locked = "<item>"`)
    if E.J.NEW and spec.locked and not mb.creative then
      local name = type(spec.locked) == "string" and spec.locked or (mb.item and mb.item.name)
      if name then mb.lock = { name = E.J.resourceLocation(name) or name, count = 1 } end
    end
    mb.block.active = spec.active == true
    mb.delayTicks, mb.pushed = 0, 0
    mb.tanks = {}
    mb.after = B.after
  end

  --- What a push hands to the block below: the bottom stack (a full stack at most), all of it taken when `below`.
  function K.tick(mb)
    mb.delayTicks = math.max(0, mb.delayTicks - 1)
    if mb.delayTicks == 0 then
      if mb.block.active then
        if mb.item and mb.spec.below then
          local n = min(mb.item.count, 64)
          mb.pushed = mb.pushed + n
          if not mb.creative then
            mb.item.count = mb.item.count - n
            if mb.item.count <= 0 then mb.item = nil end
          end
        end
        mb.delayTicks = 10
      end
    else
      mb.delayTicks = mb.delayTicks - 1
    end
  end

  function K.redstoneLevel(mb) return O.comparator(mb) end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      item = function(v)
        mb.item = B.stack(v)
        if mb.item then mb.item.count = min(mb.item.count, mb.cap) end
      end,
      active = function(v) mb.block.active = v == true end,
      below = function(v) mb.spec.below = v end,
    })
  end

  function K.state(mb)
    return B.state(mb, { item = mb.item and { name = mb.item.name, count = mb.item.count }, capacity = mb.cap,
      pushed = mb.pushed, locked = mb.lock and mb.lock.name or nil })
  end

  local OWN = {
    getStored = { {}, function(c) return B.item(c.mb.item) end },
    getCapacity = { {}, function(c) return c.mb.cap end },
  }
  if E.J.NEW then
    -- 10.4+ TileEntityBin: the lock (BinInventorySlot.setLocked: not creative, not the same state, not empty to lock).
    -- unlock() calls setLocked(true) in both 10.4.16 and 10.7.19, so a locked bin answers "This bin is not locked!"
    -- and an unlocked one with items gets locked: kept as the jar does it.
    local function setLocked(mb, lock)
      if mb.creative or (mb.lock ~= nil) == lock or (lock and not mb.item) then return false end
      mb.lock = lock and { name = mb.item.name, count = 1 } or nil
      return true
    end
    OWN.isLocked = { {}, function(c) return c.mb.lock ~= nil end }
    OWN.getLock = { {}, function(c) return B.item(c.mb.lock) end }
    OWN.lock = E.void({}, function(c)
      if c.mb.creative then E.J.computerError("Creative bins cannot be locked!") end
      if not c.mb.item then E.J.computerError("Empty bins cannot be locked!") end
      if not setLocked(c.mb, true) then E.J.computerError("This bin is already locked!") end
    end)
    OWN.unlock = E.void({}, function(c)
      if c.mb.creative then E.J.computerError("Creative bins cannot be unlocked!") end
      if not setLocked(c.mb, true) then E.J.computerError("This bin is not locked!") end
    end)
  end

  K.types = {}
  for tier in pairs(TIERS) do
    K.types[tier .. "Bin"] = {
      tier = tier,
      groups = B.groups(B.tileMethods(OWN, O), O),
      newBlock = function(_, mb) return mb.block end,
      blockState = function(c, s) B.state(c.mb, s) end,
    }
  end
  return K
end
