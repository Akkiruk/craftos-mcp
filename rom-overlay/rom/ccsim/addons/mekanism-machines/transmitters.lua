-- ccsim addons/mekanism-machines/transmitters: Universal Cables, Mechanical Pipes and Pressurized Tubes of every tier,
-- and the Diversion Transporter (see engine.lua). They are peripherals of their own (a computer next to a cable).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/transmitter/TileEntityUniversalCable, TileEntityMechanicalPipe, TileEntityPressurizedTube (getBuffer: the
--   network's buffer, getCapacity: the network's capacity, the sum of its transmitters', getNeeded,
--   getFilledPercentage), TileEntityDiversionTransporter (getMode / setMode / incrementMode / decrementMode per
--   Direction; content/network/transmitter/DiversionTransporter.DiversionControl), tier/CableTier, PipeTier, TubeTier
--   (the pack's tiers.toml). No TileEntityMekanism methods: a transmitter is not one.
-- The network is a fixture: `network` transmitters (1) holding `buffer`.
return function(E)
  local B, J, FL = E.B, E.J, E.FL
  local floor, min, max = math.floor, math.min, math.max

  J.ENUMS.Direction = { "DOWN", "UP", "NORTH", "SOUTH", "WEST", "EAST" }
  J.ENUMS.DiversionControl = { "DISABLED", "HIGH", "LOW" }

  local TIERS = {
    UniversalCable = { basic = 8000, advanced = 128000, elite = 1024000, ultimate = 8192000 },
    MechanicalPipe = { basic = 2000, advanced = 8000, elite = 32000, ultimate = 128000 },
    PressurizedTube = { basic = 4000, advanced = 16000, elite = 256000, ultimate = 1024000 },
  }

  local K = { kind = "transmitter" }
  K.rates = {}
  B.kindDefaults(K)
  local O = { noSecurity = true }

  function K.init(mb, spec)
    local t = K.types[spec.type]
    if not t then error("ccsim: unknown transmitter '" .. tostring(spec.type) .. "'", 0) end
    mb.t = t
    mb.block = { o = O }
    mb.tanks = {}
    mb.network = max(1, floor(tonumber(spec.network) or 1))
    if t.family == "UniversalCable" then
      mb.buffer = FL.create(min(tonumber(spec.buffer) or 0, t.cap * mb.network))
    elseif t.family then
      mb.buffer = E.tank(t.family == "PressurizedTube", function() return t.cap * mb.network end)
      E.fill(mb.buffer, spec.buffer, t.family == "MechanicalPipe" and "minecraft:water" or "mekanism:hydrogen")
      mb.tanks.buffer = mb.buffer
    else
      mb.modes = {}
      for i, d in ipairs(J.ENUMS.Direction) do
        local m = type(spec.modes) == "table" and spec.modes[d:lower()] or nil
        mb.modes[i] = B.enumOf(J.ENUMS.DiversionControl, m, "DISABLED", "diversion mode")
      end
    end
  end

  function K.tick() end
  function K.redstoneLevel() return 0 end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      buffer = function(v)
        if mb.t.family == "UniversalCable" then mb.buffer = FL.create(min(tonumber(v), mb.t.cap * mb.network))
        else E.fill(mb.buffer, v, mb.buffer.name) end
      end,
      network = function(v) mb.network = max(1, floor(tonumber(v))) end,
    })
  end

  function K.state(mb)
    local s = { network = mb.network }
    if mb.t.family == "UniversalCable" then s.buffer = mb.buffer
    elseif mb.t.family then s.buffer = E.tankState(mb.buffer)
    else
      s.modes = {}
      for i, d in ipairs(J.ENUMS.Direction) do s.modes[d:lower()] = mb.modes[i] end
    end
    return s
  end

  local function cap(c) return c.mb.t.cap * c.mb.network end
  local CABLE = {
    getBuffer = { {}, function(c) return c.mb.buffer end },
    getCapacity = { {}, cap },
    getNeeded = { {}, function(c) return max(0, cap(c) - c.mb.buffer) end },
    getFilledPercentage = { {}, function(c) return FL.toLevel(c.mb.buffer, cap(c)) end },
  }
  local function stackMethods(empty)
    return {
      getBuffer = { {}, function(c)
        local t = c.mb.buffer
        if t.amount <= 0 then return { name = empty, amount = 0 } end
        return { name = t.name, amount = t.amount }
      end },
      getCapacity = { {}, cap },
      getNeeded = { {}, function(c) return cap(c) - c.mb.buffer.amount end },
      getFilledPercentage = { {}, function(c) return c.mb.buffer.amount / cap(c) end },
    }
  end
  local PIPE, TUBE = stackMethods(E.EMPTY_FLUID), stackMethods(E.EMPTY_GAS)
  local function side(d) for i, x in ipairs(J.ENUMS.Direction) do if x == d then return i end end end
  local DIVERSION = {
    getMode = { { "Direction" }, function(c, d) return c.mb.modes[side(d)] end },
    setMode = E.void({ "Direction", "DiversionControl" }, function(c, d, m) c.mb.modes[side(d)] = m end),
    incrementMode = E.void({ "Direction" }, function(c, d)
      local i = side(d)
      c.mb.modes[i] = E.cycle(J.ENUMS.DiversionControl, c.mb.modes[i], 1)
    end),
    decrementMode = E.void({ "Direction" }, function(c, d)
      local i = side(d)
      c.mb.modes[i] = E.cycle(J.ENUMS.DiversionControl, c.mb.modes[i], -1)
    end),
  }

  K.types = {}
  local OWN = { UniversalCable = CABLE, MechanicalPipe = PIPE, PressurizedTube = TUBE }
  for family, tiers in pairs(TIERS) do
    for tier, capacity in pairs(tiers) do
      K.types[tier .. family] = { family = family, cap = capacity, groups = { OWN[family] },
        newBlock = function() return {} end }
    end
  end
  K.types.diversionTransporter = { groups = { DIVERSION }, newBlock = function() return {} end,
    blockState = function(c, s) s.modes = K.state(c.mb).modes end }
  return K
end
