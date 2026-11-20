-- ccsim addons/mekanism-machines/blocks: what every ordinary (single-block) Mekanism machine shares.
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   tile/base/TileEntityMekanism (getDirection, get/setRedstoneMode, getComparatorLevel, the energy methods,
--   validateSecurityIsPublic, the component order: upgrade, security, then the tile's own config and ejector),
--   tile/component/TileComponentUpgrade (getInstalledUpgrades, getSupportedUpgrades), TileComponentSecurity,
--   tile/component/TileComponentConfig and config/ConfigInfo (side config: modes per side, setDefaults, eject),
--   tile/component/TileComponentEjector (strict input, transporter colours; util/TransporterUtils.colors),
--   util/MekanismUtils (canFunction, getTicks, getEnergyPerTick, getMaxEnergy, redstoneLevelFromContents),
--   content/blocktype/Machine (SECURITY, REDSTONE, COMPARATOR, facing; SPEED, ENERGY, MUFFLING upgrades).
return function(E, core)
  local J, FL = E.J, E.FL
  local floor, min, max = math.floor, math.min, math.max
  local ENUMS = J.ENUMS

  local B = {}
  B.UPGRADES = { "SPEED", "ENERGY", "FILTER", "GAS", "MUFFLING", "ANCHOR", "STONE_GENERATOR" } -- Upgrade order
  B.UPGRADE_MAX = { SPEED = 8, ENERGY = 8, FILTER = 1, GAS = 8, MUFFLING = 4, ANCHOR = 1, STONE_GENERATOR = 1 }
  B.MAX_UPGRADE_MULTIPLIER = 10 -- general.maxUpgradeMultiplier
  local DATA_TYPES = ENUMS.DataType
  local SIDES = ENUMS.RelativeSide
  -- TransporterUtils.colors
  local COLORS = { "DARK_BLUE", "DARK_GREEN", "DARK_AQUA", "DARK_RED", "PURPLE", "INDIGO", "BRIGHT_GREEN", "AQUA", "RED",
    "PINK", "YELLOW", "BLACK" }
  local DIRECTIONS = { NORTH = true, SOUTH = true, EAST = true, WEST = true, UP = true, DOWN = true }

  local function err(msg) J.computerError(msg) end
  local function indexOf(list, v) for i, x in ipairs(list) do if x == v then return i end end end

  local function enumOf(list, v, default, what)
    if v == nil then return default end
    local u = tostring(v):upper()
    if indexOf(list, u) then return u end
    error("ccsim: " .. what .. " '" .. tostring(v) .. "' is not one of " .. table.concat(list, ", "), 0)
  end
  B.enumOf = enumOf

  --- 10.7 (1.21.1) has one CHEMICAL transmission type where 10.2/10.4 have GAS, INFUSION, PIGMENT and SLURRY.
  local CHEMICALS = { GAS = true, INFUSION = true, PIGMENT = true, SLURRY = true }
  function B.transmission(t)
    if J.V21 and CHEMICALS[t] then return "CHEMICAL" end
    return t
  end
  B.CHEMICALS = CHEMICALS
  --- A block's side config list for this version: on 1.21.1 its chemical configs become one CHEMICAL config with
  --- every mode of them, each side keeping the first set mode, ejecting when any of them could and did.
  function B.versionConfig(list)
    if not J.V21 then return list end
    local out, chem = {}, nil
    for _, c in ipairs(list) do
      if CHEMICALS[c.type] then
        if not chem then
          chem = { type = "CHEMICAL", modes = {}, sides = {}, canEject = false, ejecting = false }
          out[#out + 1] = chem
        end
        for _, m in ipairs(c.modes) do
          if not indexOf(chem.modes, m) then chem.modes[#chem.modes + 1] = m end
        end
        for _, side in ipairs(SIDES) do
          local m = (c.sides and c.sides[side]) or c.fill
          if m and m ~= "NONE" and not chem.sides[side] then chem.sides[side] = m end
        end
        chem.canEject = chem.canEject or c.canEject ~= false
        chem.ejecting = chem.ejecting or c.ejecting == true
      else
        out[#out + 1] = c
      end
    end
    return out
  end

  --- The block state of a machine: facing, redstone, security, upgrades, side config, ejector.
  --- `o`: { directional, redstone, upgrades = { supported... } | nil, config = { {type, modes, fill, sides, canEject,
  --- ejecting}... } | nil, ejector = bool }.
  function B.newBlock(def, mb, o)
    local b = { o = o }
    b.facing = def.facing and tostring(def.facing):upper() or "NORTH"
    if not DIRECTIONS[b.facing] then error("ccsim: facing '" .. b.facing .. "' is not a direction", 0) end
    b.redstoneControl = enumOf(ENUMS.RedstoneControl, def.redstoneMode, "DISABLED", "redstone mode")
    b.powered, b.wasPowered = def.powered == true, def.powered == true
    b.security = enumOf({ "PUBLIC", "PRIVATE", "TRUSTED" }, def.security, "PUBLIC", "security mode")
    if def.owner ~= nil then
      local p = core.findPlayer and core.findPlayer(def.owner)
      if p then b.ownerUUID, b.ownerName = p.uuid, p.name else b.ownerUUID = tostring(def.owner) end
    end
    if o.upgrades then
      b.upgrades = {}
      for k, n in pairs(type(def.upgrades) == "table" and def.upgrades or {}) do
        local u = tostring(k):upper()
        if not indexOf(o.upgrades, u) then error("ccsim: this block takes no " .. u .. " upgrade", 0) end
        n = min(floor(tonumber(n) or 0), B.UPGRADE_MAX[u])
        if n > 0 then b.upgrades[u] = n end
      end
    end
    if o.config then
      b.config, b.configOrder = {}, {}
      for _, c in ipairs(B.versionConfig(o.config)) do
        local info = { modes = {}, sides = {}, canEject = c.canEject ~= false, ejecting = c.ejecting == true }
        info.modes.NONE = true
        for _, m in ipairs(c.modes) do info.modes[m] = true end
        for _, side in ipairs(SIDES) do info.sides[side] = c.fill or "NONE" end
        for side, m in pairs(c.sides or {}) do info.sides[side] = m end
        -- ConfigInfo.addDisabledSides: the side reads NONE and setDataType leaves it alone
        if o.disabledSides then
          info.disabled = {}
          for _, side in ipairs(o.disabledSides) do info.disabled[side] = true; info.sides[side] = "NONE" end
        end
        b.config[c.type] = info
        b.configOrder[#b.configOrder + 1] = c.type
      end
      for t, sides in pairs(type(def.sideConfig) == "table" and def.sideConfig or {}) do
        local info = b.config[B.transmission(tostring(t):upper())]
        if not info then error("ccsim: no side config for " .. tostring(t), 0) end
        for side, m in pairs(sides) do info.sides[tostring(side):upper()] = tostring(m):upper() end
      end
    end
    if o.ejector then b.strictInput, b.inputColors, b.outputColor = false, {}, nil end
    mb.block = b
    return b
  end

  function B.upgrades(b, u) return b.upgrades and b.upgrades[u] or 0 end
  local function fraction(b, u) return B.upgrades(b, u) / B.UPGRADE_MAX[u] end
  --- MekanismUtils.getTicks / getEnergyPerTick / getMaxEnergy (kept per block until its upgrades change: every
  --- machine asks each tick)
  local function cache(b, key)
    local c = b.upgradeCache
    if not c then c = { t = {}, e = {}, m = {} }; b.upgradeCache = c end
    return c[key]
  end
  function B.ticks(b, def)
    if not b.upgrades then return def end
    local c = cache(b, "t")
    local v = c[def]
    if v == nil then v = E.toInt(def * B.MAX_UPGRADE_MULTIPLIER ^ (-fraction(b, "SPEED"))); c[def] = v end
    return v
  end
  function B.energyPerTick(b, def)
    if not b.upgrades then return def end
    local c = cache(b, "e")
    local v = c[def]
    if v == nil then
      local pow = B.MAX_UPGRADE_MULTIPLIER ^ (2 * fraction(b, "SPEED") - fraction(b, "ENERGY"))
      if J.V21 then
        v = min(math.ceil(def * pow), FL.MAX) -- 10.7 MekanismUtils.getEnergyPerTick: MathUtils.ceilToLong
      else
        v = FL.multiply(def, FL.create(pow))
      end
      c[def] = v
    end
    return v
  end
  function B.maxEnergy(b, def)
    if not b.upgrades then return def end
    local c = cache(b, "m")
    local v = c[def]
    if v == nil then
      local pow = B.MAX_UPGRADE_MULTIPLIER ^ fraction(b, "ENERGY")
      v = J.V21 and FL.create(def * pow) or FL.multiply(def, FL.create(pow)) -- 10.7: MathUtils.clampToLong
      c[def] = v
    end
    return v
  end

  --- MekanismUtils.canFunction
  function B.canFunction(b)
    if not b.o.redstone then return true end
    local m = b.redstoneControl
    if m == "HIGH" then return b.powered end
    if m == "LOW" then return not b.powered end
    if m == "PULSE" then return b.powered and not b.wasPowered end
    return true
  end

  function B.requirePublic(b)
    if b.security ~= "PUBLIC" then err("Setter not available due to machine security not being public.") end
  end

  --- redstoneLevelFromContents(FloatingLong, FloatingLong)
  function B.energyLevel(e, cap)
    if cap == 0 or e == 0 then return 0 end
    return 1 + floor(FL.multiply(FL.divide(e, cap), 14))
  end
  --- redstoneLevelFromContents(List<IInventorySlot>): item counts over slot limits (64 a slot)
  function B.slotsLevel(stacks)
    local count, limit = 0, 0
    for _, s in ipairs(stacks) do
      count = count + (s and s.count or 0)
      limit = limit + 64
    end
    return E.redstoneLevel(count, limit)
  end

  --- An ItemStack as CCArgumentWrapper returns it: { name, count }, air for an empty slot.
  function B.item(s)
    if type(s) == "table" and s.name and (tonumber(s.count) or 1) > 0 then
      return { name = J.resourceLocation(s.name) or s.name, count = floor(tonumber(s.count) or 1) }
    end
    return { name = "minecraft:air", count = 0 }
  end
  function B.slot(get) return { {}, function(c) return B.item(get(c.mb)) end } end

  -- ===== method groups =====

  --- The tile's own methods with the TileEntityMekanism ones its block attributes allow. `o.comparator(mb)`,
  --- `o.energy(mb)` (its containers) switch those on.
  function B.tileMethods(own, o)
    local t = {}
    for k, v in pairs(own) do t[k] = v end
    if o.directional then t.getDirection = { {}, function(c) return c.mb.block.facing end } end
    if o.redstone then
      t.getRedstoneMode = { {}, function(c) return c.mb.block.redstoneControl end }
      t.setRedstoneMode = E.void({ "RedstoneControl" }, function(c, mode)
        B.requirePublic(c.mb.block)
        if mode == "PULSE" then err("Unsupported redstone control mode: PULSE") end -- canPulse() is false
        c.mb.block.redstoneControl = mode
      end)
    end
    if o.comparator then t.getComparatorLevel = { {}, function(c) return o.comparator(c.mb) end } end
    if o.energy then
      local function sum(c, field)
        local total = 0
        for _, e in ipairs(o.energy(c.mb)) do total = total + e[field](e) end
        return total
      end
      t.getEnergy = { {}, function(c) return sum(c, "get") end }
      t.getMaxEnergy = { {}, function(c) return sum(c, "max") end }
      t.getEnergyNeeded = { {}, function(c) return sum(c, "needed") end }
      t.getEnergyFilledPercentage = { {}, function(c) return FL.toLevel(sum(c, "get"), sum(c, "max")) end }
    end
    return t
  end

  local UPGRADE = {
    getInstalledUpgrades = { {}, function(c)
      local out = {}
      for u, n in pairs(c.mb.block.upgrades) do out[u] = n end
      return out
    end },
    getSupportedUpgrades = { {}, function(c)
      local out = {}
      for _, u in ipairs(B.UPGRADES) do
        if indexOf(c.mb.block.o.upgrades, u) then out[#out + 1] = u end
      end
      return out
    end },
  }

  local SECURITY = {
    getOwnerUUID = { {}, function(c) return c.mb.block.ownerUUID end },
    getOwnerName = { {}, function(c) return c.mb.block.ownerName end },
    getSecurityMode = { {}, function(c) return c.mb.block.security end },
  }

  local function configOf(c, t)
    local info = c.mb.block.config[t]
    if not info then err(("This machine does not support configuring transmission type '%s'."):format(t)) end
    return info
  end
  local function nextMode(info, current, step)
    local i = indexOf(DATA_TYPES, current)
    for _ = 1, #DATA_TYPES do
      i = (i - 1 + step) % #DATA_TYPES + 1
      if info.modes[DATA_TYPES[i]] then return DATA_TYPES[i] end
    end
    return current
  end
  local CONFIG = {
    getConfigurableTypes = { {}, function(c)
      local out = {}
      for i, t in ipairs(c.mb.block.configOrder) do out[i] = t end
      return out
    end },
    canEject = { { "TransmissionType" }, function(c, t) return configOf(c, t).canEject end },
    isEjecting = { { "TransmissionType" }, function(c, t) return configOf(c, t).ejecting end },
    setEjecting = E.void({ "TransmissionType", "boolean" }, function(c, t, v)
      B.requirePublic(c.mb.block)
      local info = configOf(c, t)
      if not info.canEject then err(("This machine does not support auto-ejecting for transmission type '%s'."):format(t)) end
      info.ejecting = v
    end),
    getSupportedModes = { { "TransmissionType" }, function(c, t)
      local info, out = configOf(c, t), {}
      for _, m in ipairs(DATA_TYPES) do if info.modes[m] then out[#out + 1] = m end end -- an EnumSet
      return out
    end },
    getMode = { { "TransmissionType", "RelativeSide" }, function(c, t, side) return configOf(c, t).sides[side] end },
    setMode = E.void({ "TransmissionType", "RelativeSide", "DataType" }, function(c, t, side, mode)
      B.requirePublic(c.mb.block)
      local info = configOf(c, t)
      if not info.modes[mode] then
        err(("This machine does not support mode '%s' for transmission type '%s'."):format(mode, t))
      end
      if not (info.disabled and info.disabled[side]) then info.sides[side] = mode end
    end),
    incrementMode = E.void({ "TransmissionType", "RelativeSide" }, function(c, t, side)
      B.requirePublic(c.mb.block)
      local info = configOf(c, t)
      if not (info.disabled and info.disabled[side]) then info.sides[side] = nextMode(info, info.sides[side], 1) end
    end),
    decrementMode = E.void({ "TransmissionType", "RelativeSide" }, function(c, t, side)
      B.requirePublic(c.mb.block)
      local info = configOf(c, t)
      if not (info.disabled and info.disabled[side]) then info.sides[side] = nextMode(info, info.sides[side], -1) end
    end),
  }

  local function colorStep(color, step)
    if color == nil then return step > 0 and COLORS[1] or COLORS[#COLORS] end
    local i = indexOf(COLORS, color) + step
    return COLORS[i] -- nil past either end
  end
  local function checkColor(color)
    if not indexOf(COLORS, color) then err(("Color '%s' is not a supported transporter color."):format(color)) end
  end
  local EJECTOR = {
    hasStrictInput = { {}, function(c) return c.mb.block.strictInput end },
    getOutputColor = { {}, function(c) return c.mb.block.outputColor end },
    getInputColor = { { "RelativeSide" }, function(c, side) return c.mb.block.inputColors[side] end },
    setStrictInput = E.void({ "boolean" }, function(c, v) B.requirePublic(c.mb.block); c.mb.block.strictInput = v end),
    clearInputColor = E.void({ "RelativeSide" }, function(c, side) B.requirePublic(c.mb.block); c.mb.block.inputColors[side] = nil end),
    incrementInputColor = E.void({ "RelativeSide" }, function(c, side)
      B.requirePublic(c.mb.block)
      local cs = c.mb.block.inputColors
      cs[side] = colorStep(cs[side], 1)
    end),
    decrementInputColor = E.void({ "RelativeSide" }, function(c, side)
      B.requirePublic(c.mb.block)
      local cs = c.mb.block.inputColors
      cs[side] = colorStep(cs[side], -1)
    end),
    setInputColor = E.void({ "RelativeSide", "EnumColor" }, function(c, side, color)
      B.requirePublic(c.mb.block)
      checkColor(color)
      c.mb.block.inputColors[side] = color
    end),
    clearOutputColor = E.void({}, function(c) B.requirePublic(c.mb.block); c.mb.block.outputColor = nil end),
    incrementOutputColor = E.void({}, function(c) B.requirePublic(c.mb.block); c.mb.block.outputColor = colorStep(c.mb.block.outputColor, 1) end),
    decrementOutputColor = E.void({}, function(c) B.requirePublic(c.mb.block); c.mb.block.outputColor = colorStep(c.mb.block.outputColor, -1) end),
    setOutputColor = E.void({ "EnumColor" }, function(c, color)
      B.requirePublic(c.mb.block)
      checkColor(color)
      c.mb.block.outputColor = color
    end),
  }

  --- getComputerMethods: the tile, then the components in the order the constructors add them.
  function B.groups(tile, o)
    local g = { tile }
    if o.upgrades then g[#g + 1] = UPGRADE end
    if not o.noSecurity then g[#g + 1] = SECURITY end -- the Security attribute (bins, chargepads have none)
    if o.config then g[#g + 1] = CONFIG end
    if o.ejector then g[#g + 1] = EJECTOR end
    return g
  end

  --- State of the shared parts, for the sim state.
  function B.state(mb, s)
    local b = mb.block
    s.redstoneMode, s.powered, s.security, s.active = b.redstoneControl, b.powered, b.security, b.active == true
    -- copies: the same table twice in the sim state is refused by the JSON writer
    local function copy(t)
      local out = {}
      for k, v in pairs(t) do out[k] = type(v) == "table" and copy(v) or v end
      return out
    end
    if b.upgrades then s.upgrades = copy(b.upgrades) end
    if b.config then
      s.sideConfig = {}
      for t, info in pairs(b.config) do s.sideConfig[t] = { sides = copy(info.sides), ejecting = info.ejecting } end
    end
    for k, v in pairs(s) do if type(v) == "table" then s[k] = copy(v) end end
    return s
  end

  --- A per-tick end: remember the redstone for PULSE.
  function B.after(mb) mb.block.wasPowered = mb.block.powered end

  --- Whether this side config sends `t` out anywhere (OUTPUT-like mode on a side) and ejects it.
  function B.ejects(b, t)
    local info = b.config and b.config[B.transmission(t)]
    if not info or not info.ejecting then return false end
    for _, m in pairs(info.sides) do
      if m == "OUTPUT" or m == "OUTPUT_1" or m == "OUTPUT_2" or m == "INPUT_OUTPUT" then return true end
    end
    return false
  end

  --- mekSet fields every machine has.
  function B.setFields(mb)
    local b = mb.block
    return {
      redstoneMode = function(v) b.redstoneControl = enumOf(ENUMS.RedstoneControl, v, "DISABLED", "redstone mode") end,
      powered = function(v) b.powered = v == true end,
      security = function(v) b.security = enumOf({ "PUBLIC", "PRIVATE", "TRUSTED" }, v, "PUBLIC", "security mode") end,
      upgrades = function(v)
        if not b.upgrades then error("this block takes no upgrades", 0) end
        b.upgrades, b.upgradeCache = {}, nil
        for k, n in pairs(v) do
          local u = tostring(k):upper()
          if not indexOf(b.o.upgrades, u) then error("this block takes no " .. u .. " upgrade", 0) end
          n = min(floor(tonumber(n) or 0), B.UPGRADE_MAX[u])
          if n > 0 then b.upgrades[u] = n end
        end
      end,
    }
  end

  -- ===== side config builders (TileComponentConfig.setup*Config, ConfigInfo.setDefaults) =====

  B.cfg = {}
  --- setupItemIOConfig / setupItemIOExtraConfig: input everywhere, output right, extra bottom, energy back.
  function B.cfg.itemIO(extra)
    local c = { type = "ITEM", modes = { "INPUT", "OUTPUT", "INPUT_OUTPUT", "ENERGY" }, fill = "INPUT",
      sides = { RIGHT = "OUTPUT", BACK = "ENERGY" } }
    if extra then c.modes[#c.modes + 1] = "EXTRA"; c.sides.BOTTOM = "EXTRA" end
    return c
  end
  --- setupInputConfig: input everywhere, never ejects.
  function B.cfg.input(t) return { type = t, modes = { "INPUT" }, fill = "INPUT", canEject = false } end
  --- setupOutputConfig: output on the sides given (none: every side NONE).
  function B.cfg.output(t, ...)
    local c = { type = t, modes = { "OUTPUT" }, sides = {} }
    for _, side in ipairs({ ... }) do c.sides[side] = "OUTPUT" end
    return c
  end
  --- setupIOConfig: input everywhere, output on one side.
  function B.cfg.io(t, side, ejecting)
    return { type = t, modes = { "INPUT", "OUTPUT", "INPUT_OUTPUT" }, fill = "INPUT", sides = { [side] = "OUTPUT" },
      ejecting = ejecting == true }
  end
  --- The two-input layout of the chemical infuser and pigment mixer.
  function B.cfg.twoInputs(t, energy, ejecting)
    local c = { type = t, modes = { "INPUT_1", "INPUT_2", "OUTPUT", "INPUT_OUTPUT" },
      sides = { LEFT = "INPUT_1", RIGHT = "INPUT_2", FRONT = "OUTPUT" }, ejecting = ejecting == true }
    if energy then c.modes[#c.modes + 1] = "ENERGY"; c.sides.BACK = "ENERGY" end
    return c
  end

  --- A fixture slot: { name, count } or nil.
  function B.stack(spec)
    if type(spec) ~= "table" or not spec.name or (tonumber(spec.count) or 1) <= 0 then return nil end
    return { name = J.resourceLocation(spec.name) or spec.name, count = floor(tonumber(spec.count) or 1) }
  end

  --- The powered input is per block: mekSetRedstone reaches it through the peripheral's ctx.block.
  function B.kindDefaults(K)
    K.defaults = { length = 1, width = 1, height = 1 }
    K.single = true
    K.defaultFluid = K.defaultFluid or {}
    K.rates = K.rates or {}
  end

  return B
end
