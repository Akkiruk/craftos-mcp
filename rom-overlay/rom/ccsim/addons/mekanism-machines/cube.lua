-- ccsim addons/mekanism-machines/cube: the Energy Cubes, every tier (see engine.lua, blocks.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/TileEntityEnergyCube (config ENERGY then ITEM, both in on every side and out at the front, energy
--   ejecting at the tier's output rate while it can function, getChargeItem, getDischargeItem, comparator = energy),
--   capabilities/energy/EnergyCubeEnergyContainer (the creative cube never changes), tier/EnergyCubeTier,
--   registries/MekanismBlockTypes.createEnergyCube (no upgrades, facing, security, redstone, comparator).
return function(E)
  local B, FL = E.B, E.FL
  local min = math.min

  local TIERS = {
    basic = { 4000000, 4000 }, advanced = { 16000000, 16000 }, elite = { 64000000, 64000 },
    ultimate = { 256000000, 256000 }, creative = { FL.MAX, FL.MAX }, -- FloatingLong.MAX_VALUE; 10.7 Long.MAX_VALUE
  }

  local K = { kind = "energyCube" }
  K.rates = { energyInput = true, energyOutput = true }
  B.kindDefaults(K)

  local IO = { "INPUT", "OUTPUT", "INPUT_OUTPUT" }
  local O = {
    directional = true, redstone = true, ejector = true,
    config = {
      { type = "ENERGY", modes = IO, fill = "INPUT", sides = { FRONT = "OUTPUT" }, ejecting = true },
      { type = "ITEM", modes = IO, fill = "INPUT", sides = { FRONT = "OUTPUT" }, canEject = false },
    },
    comparator = function(mb) return B.energyLevel(mb.energy.stored, mb.energy:max()) end,
    energy = function(mb) return { mb.energy } end,
  }

  function K.init(mb, spec)
    local name = spec.type and K.types[spec.type] and K.types[spec.type].tierName or tostring(spec.tier or "basic"):lower()
    local tier = TIERS[name]
    if not tier then error("ccsim: unknown energy cube tier '" .. name .. "'", 0) end
    mb.tier, mb.creative = tier, name == "creative"
    B.newBlock(spec, mb, O)
    mb.energy = E.energyContainer(function() return tier[1] end)
    mb.energy.stored = FL.create(min(tonumber(spec.energy) or (mb.creative and tier[1] or 0), tier[1]))
    mb.chargeItem, mb.dischargeItem = spec.chargeItem, spec.dischargeItem
    mb.tanks = {}
    mb.after = B.after
  end

  function K.tick() end

  --- Cables: `energyInput` J/t comes in; the front ejects up to the tier's output to a load of `energyOutput` J/t.
  function K.transfer(mb)
    local s, e = mb.spec, mb.energy
    local r = E.rate(s.energyInput)
    if r and r > 0 and not mb.creative then e:insert(min(r, 1.8e19)) end
    r = E.rate(s.energyOutput)
    if r and r > 0 and B.canFunction(mb.block) and B.ejects(mb.block, "ENERGY") then
      local n = min(r, mb.tier[2], e.stored)
      mb.lastOutput = n
      if not mb.creative then e:extract(n) end
    else
      mb.lastOutput = 0
    end
  end

  function K.redstoneLevel(mb) return O.comparator(mb) end

  function K.set(mb, fields)
    local extra = B.setFields(mb)
    extra.energy = function(v) mb.energy.stored = FL.create(min(tonumber(v), mb.tier[1])) end
    E.applySet(mb, fields, extra)
  end

  function K.state(mb)
    return B.state(mb, { energy = mb.energy.stored, maxEnergy = mb.tier[1], lastOutput = mb.lastOutput or 0 })
  end

  local OWN = {
    getChargeItem = B.slot(function(mb) return mb.chargeItem end),
    getDischargeItem = B.slot(function(mb) return mb.dischargeItem end),
  }
  local groups = B.groups(B.tileMethods(OWN, O), O)

  K.types = {}
  for tier in pairs(TIERS) do
    K.types[tier .. "EnergyCube"] = {
      groups = groups, tierName = tier,
      newBlock = function(_, mb) return mb.block end,
      blockState = function(c, s) B.state(c.mb, s) end,
    }
  end
  return K
end
