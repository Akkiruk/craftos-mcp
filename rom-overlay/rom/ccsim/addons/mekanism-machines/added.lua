-- ccsim addons/mekanism-machines/added: the blocks Mekanism 10.4 gave computer support (1.20.1 and 1.21.1 only; see
-- engine.lua, blocks.lua): Radioactive Waste Barrel, Industrial Alarm, Personal Chest, Personal Barrel, Security Desk.
--
-- Read in the 10.4.16 / 10.7.19 tags, src/main/java/mekanism/common/:
--   registries/MekanismBlockTypes (their attributes: facing on all five; SECURITY on the chests and the desk;
--   REDSTONE on the alarm; COMPARATOR on the barrel), tile/TileEntityRadioactiveWasteBarrel (getStored / getCapacity /
--   getNeeded / getFilledPercentage over its tank; every 20 ticks 1 mB of a stored chemical decays, the config's
--   radioactiveWasteBarrelProcessTicks / DecayAmount; 512,000 mB, radioactiveWasteBarrelMaxGas), config/GeneralConfig.
-- None of the others has methods of its own: what a program sees is TileEntityMekanism's and the security
-- component's. The chests' inventories are not reachable from a computer (Mekanism's peripheral is the block's).
return function(E)
  local B, J = E.B, E.J

  local K = { kind = "added" }
  K.rates = {}
  B.kindDefaults(K)
  K.defaultFluid = { stored = "mekanism:spent_nuclear_waste" }

  local BARREL_CAP, PROCESS_TICKS, DECAY = 512000, 20, 1

  local D = {
    radioactiveWasteBarrel = { o = { directional = true, noSecurity = true }, barrel = true },
    industrialAlarm = { o = { directional = true, redstone = true, noSecurity = true } },
    personalChest = { o = { directional = true } },
    personalBarrel = { o = { directional = true } },
    securityDesk = { o = { directional = true } },
  }
  D.radioactiveWasteBarrel.o.comparator = function(mb) return E.redstoneLevel(mb.tank.amount, BARREL_CAP) end

  function K.init(mb, spec)
    local d = K.types[spec.type] and K.types[spec.type].d
    if not d then error("ccsim: unknown block '" .. tostring(spec.type) .. "'", 0) end
    mb.d = d
    B.newBlock(spec, mb, d.o)
    mb.tanks = {}
    if d.barrel then
      mb.tank = E.tank(true, function() return BARREL_CAP end)
      E.fill(mb.tank, spec.stored, "mekanism:spent_nuclear_waste")
      mb.tanks.stored = mb.tank
      mb.decays = spec.decays ~= false -- false: a chemical in mekanism:waste_barrel_decay_blacklist
      mb.processTicks = 0
    end
    mb.after = B.after
  end

  function K.tick(mb)
    if mb.d.barrel and mb.decays and mb.tank.amount > 0 then
      mb.processTicks = mb.processTicks + 1
      if mb.processTicks >= PROCESS_TICKS then
        mb.processTicks = 0
        E.shrink(mb.tank, DECAY)
      end
    end
  end

  function K.redstoneLevel(mb) return mb.block.o.comparator and mb.block.o.comparator(mb) or 0 end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    extra.decays = function(v) mb.decays = v ~= false end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    local s = {}
    if mb.d.barrel then s.stored = E.tankState(mb.tank) end
    return B.state(mb, s)
  end

  local OWN = {}
  OWN.radioactiveWasteBarrel = {
    getStored = { {}, function(c) return E.stack(c.mb.tank) end },
    getCapacity = { {}, function() return BARREL_CAP end },
    getNeeded = { {}, function(c) return E.needed(c.mb.tank) end },
    getFilledPercentage = { {}, function(c) return c.mb.tank.amount / BARREL_CAP end },
  }

  K.types = {}
  if J.NEW then
    for name, d in pairs(D) do
      K.types[name] = {
        d = d,
        groups = B.groups(B.tileMethods(OWN[name] or {}, d.o), d.o),
        newBlock = function(_, mb) return mb.block end,
        blockState = function(c, s) B.state(c.mb, s) end,
      }
    end
  end
  return K
end
