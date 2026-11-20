-- ccsim mek/entangloporter: Mekanism's Quantum Entangloporter (peripheral type "quantumEntangloporter").
--
-- Written from Mekanism 10.2.5 source (branch 1.18.x) and checked against the 10.2.5.465 jar:
--   tile/TileEntityQuantumEntangloporter, content/entangloporter/InventoryFrequency,
--   tile/component/TileComponentConfig, TileComponentEjector, tile/component/config/ConfigInfo, DataType,
--   inventory/slot/EntangloporterInventorySlot (BasicInventorySlot, 64), lib/inventory/TransitRequest,
--   capabilities/holder/ConfigHolder, capabilities/proxy/ProxyHandler, ProxyItemHandler,
--   capabilities/resolver/BasicSidedCapabilityResolver; CC:Tweaked 1.101.3 InventoryMethods.
-- docs/mekanism-qio.md has the rules with their lines.
--
-- Every entangloporter on a frequency shares the frequency's buffers: one item slot, one fluid tank, four chemical
-- tanks, an energy buffer and a heat capacitor. Items keep their full NBT. Items leave through the output sides
-- of entangloporters that eject, every 11th tick per entangloporter. CC's own inventory methods cannot move
-- anything in or out: they ask for the item handler with no side, which Mekanism makes read-only.
return function(core, Q)
  local J = Q.J
  local VOID, ret, fmt = Q.VOID, Q.ret, Q.fmt
  local cfg = (core.world.mekanism or {}).entangloporter or {}

  local E = {}
  E.TYPE = "quantumEntangloporter"

  -- peripheral.getMethods order (CC's HashMap of Mekanism's methods: the tile's sorted by name, then the upgrade,
  -- security, config and ejector components'), worked out like the QIO ones
  E.METHOD_ORDER = { "getBufferInfuseType", "getBufferInfuseTypeFilledPercentage", "hasStrictInput", "getBufferPigment",
    "getOutputColor", "decrementMode", "setFrequency", "getTransferLoss", "getBufferPigmentNeeded", "getEnvironmentalLoss",
    "getFrequencies", "getMode", "incrementMode", "getBufferPigmentCapacity", "getMaxEnergy", "getInstalledUpgrades",
    "clearOutputColor", "getBufferFluidCapacity", "getBufferSlurryNeeded", "getConfigurableTypes", "setOutputColor",
    "getBufferItem", "decrementOutputColor", "setEjecting", "getTemperature", "getEnergyFilledPercentage",
    "getSupportedModes", "createFrequency", "getOwnerUUID", "incrementInputColor", "getDirection", "setInputColor",
    "getSupportedUpgrades", "getBufferInfuseTypeNeeded", "getEnergy", "getBufferGasCapacity", "getBufferGas",
    "clearInputColor", "getEnergyNeeded", "incrementOutputColor", "isEjecting", "getOwnerName", "canEject",
    "getBufferGasNeeded", "getBufferFluidNeeded", "getSecurityMode", "getFrequency", "getBufferPigmentFilledPercentage",
    "getBufferFluidFilledPercentage", "setMode", "getBufferFluid", "getBufferSlurryCapacity", "hasFrequency",
    "getBufferGasFilledPercentage", "getInputColor", "getBufferInfuseTypeCapacity", "setStrictInput",
    "decrementInputColor", "getBufferSlurry", "getBufferSlurryFilledPercentage" }

  -- the server's general.toml [general.quantum_entangloporter]
  local ENERGY_BUFFER = tonumber(cfg.energyBuffer) or 256000000
  local FLUID_BUFFER = tonumber(cfg.fluidBuffer) or 256000
  local CHEMICAL_BUFFER = tonumber(cfg.chemicalBuffer) or 8192000
  local SLOT_LIMIT = 64 -- BasicInventorySlot.DEFAULT_LIMIT
  local EJECT_DELAY = 10 -- TileComponentEjector.outputItems: tickDelay = 10

  -- 10.7 (1.21.1): one CHEMICAL type and one chemical buffer where 10.2 / 10.4 have gas, infusion, pigment, slurry
  local TRANSMISSIONS = J.V21 and { "ITEM", "FLUID", "CHEMICAL", "ENERGY", "HEAT" }
    or { "ITEM", "FLUID", "GAS", "INFUSION", "PIGMENT", "SLURRY", "ENERGY", "HEAT" }
  local SIDES = { "FRONT", "LEFT", "RIGHT", "BACK", "TOP", "BOTTOM" }
  local DIRECTIONS = { "DOWN", "UP", "NORTH", "SOUTH", "WEST", "EAST" } -- Direction ordinal order (EnumSet order)
  local DATA_ORDER = J.ENUMS.DataType
  -- TransporterUtils.colors
  local TRANSPORTER_COLORS = { "DARK_BLUE", "DARK_GREEN", "DARK_AQUA", "DARK_RED", "PURPLE", "INDIGO", "BRIGHT_GREEN",
    "AQUA", "RED", "PINK", "YELLOW", "BLACK" }

  local function indexOf(list, v)
    for i, x in ipairs(list) do if x == v then return i end end
    return nil
  end

  -- ===== RelativeSide <-> Direction (RelativeSide.getDirection) =====

  local CLOCKWISE = { NORTH = "EAST", EAST = "SOUTH", SOUTH = "WEST", WEST = "NORTH" }
  local COUNTER = { NORTH = "WEST", WEST = "SOUTH", SOUTH = "EAST", EAST = "NORTH" }
  local OPPOSITE = { NORTH = "SOUTH", SOUTH = "NORTH", EAST = "WEST", WEST = "EAST", UP = "DOWN", DOWN = "UP" }

  local function toDirection(side, facing)
    local vertical = facing == "UP" or facing == "DOWN"
    if side == "FRONT" then return facing end
    if side == "BACK" then return OPPOSITE[facing] end
    if side == "LEFT" then return vertical and "EAST" or CLOCKWISE[facing] end
    if side == "RIGHT" then return vertical and "WEST" or COUNTER[facing] end
    if side == "TOP" then
      if facing == "DOWN" then return "NORTH" elseif facing == "UP" then return "SOUTH" end
      return "UP"
    end
    if facing == "DOWN" then return "SOUTH" elseif facing == "UP" then return "NORTH" end
    return "DOWN"
  end

  -- ===== frequencies =====

  local frequencies = {} -- FrequencyManager order; public ones are global, private ones per owner

  local function stackSpec(spec, capacity)
    if not spec then return nil end
    return { name = spec.name, amount = math.min(tonumber(spec.amount) or 0, capacity), nbt = spec.nbt }
  end

  local function newFrequency(spec, ownerUuid)
    local f = {
      name = spec.name, public = spec.public ~= false, owner = ownerUuid, valid = true,
      item = nil, fluid = stackSpec(spec.fluid, FLUID_BUFFER), gas = stackSpec(spec.gas, CHEMICAL_BUFFER),
      infusion = stackSpec(spec.infuseType or spec.infusion, CHEMICAL_BUFFER),
      pigment = stackSpec(spec.pigment, CHEMICAL_BUFFER), slurry = stackSpec(spec.slurry, CHEMICAL_BUFFER),
      energy = math.min(tonumber(spec.energy) or 0, ENERGY_BUFFER), temperature = tonumber(spec.temperature) or 300,
    }
    if J.V21 then
      -- one chemical tank: `chemical`, else the first of the old four the fixture names
      f.chemical = stackSpec(spec.chemical or spec.gas or spec.infuseType or spec.infusion or spec.pigment or spec.slurry,
        CHEMICAL_BUFFER)
      f.gas, f.infusion, f.pigment, f.slurry = nil, nil, nil, nil
      f.energy = math.floor(f.energy) -- a long of joules
    end
    if spec.item and spec.item.name then
      local ty = Q.typeOf(spec.item)
      local count = math.min(spec.item.count or 1, math.min(SLOT_LIMIT, ty.maxCount))
      if count > 0 then f.item = { type = ty, count = count } end
    end
    frequencies[#frequencies + 1] = f
    return f
  end

  local function find(name, public, ownerUuid)
    for _, f in ipairs(frequencies) do
      if f.name == name and f.public == public and (public or f.owner == ownerUuid) then return f end
    end
    return nil
  end

  for _, spec in ipairs(cfg.frequencies or {}) do
    if not find(spec.name, spec.public ~= false, Q.playerUuid(spec.owner)) then
      newFrequency(spec, (Q.playerUuid(spec.owner)))
    end
  end

  local function validFrequency(b)
    local f = b.frequency
    if f and f.valid then return f end
    return nil
  end

  --- BasicInventorySlot.insertItem into the frequency's slot; returns how many were taken.
  local function slotInsert(f, ty, count)
    local limit = math.min(SLOT_LIMIT, ty.maxCount)
    if not f.item then
      local n = math.min(limit, count)
      if n > 0 then f.item = { type = ty, count = n } end
      return n
    end
    if f.item.type ~= ty then return 0 end
    local n = math.min(limit - f.item.count, count)
    if n <= 0 then return 0 end
    f.item.count = f.item.count + n
    return n
  end

  -- ===== blocks =====

  local function defaultConfig()
    local config = {}
    for _, t in ipairs(TRANSMISSIONS) do
      local sides = {}
      if t == "HEAT" then
        for _, s in ipairs(SIDES) do sides[s] = "INPUT_OUTPUT" end
      else
        for _, s in ipairs(SIDES) do sides[s] = "INPUT" end -- config.fill(INPUT)
        sides.FRONT = "OUTPUT"                                 -- setDataType(OUTPUT, FRONT)
      end
      config[t] = {
        sides = sides, ejecting = false, canEject = t ~= "HEAT",
        modes = t == "HEAT" and { "NONE", "INPUT_OUTPUT" } or { "NONE", "INPUT", "OUTPUT", "INPUT_OUTPUT" },
      }
    end
    return config
  end

  local blocks = {}

  local function newBlock(def)
    local ownerUuid, ownerName = Q.playerUuid(def.owner)
    local b = {
      name = def.name or def.id, kind = E.TYPE, def = def, owner = ownerUuid, ownerName = def.ownerName or ownerName,
      security = tostring(def.securityMode or "PUBLIC"):upper(), facing = tostring(def.facing or "NORTH"):upper(),
      loaded = def.loaded ~= false, tickDelay = tonumber(def.tickDelay) or 0, anchor = def.anchorUpgrade == true,
      transferLoss = tonumber(def.transferLoss) or 0, environmentalLoss = tonumber(def.environmentalLoss) or 0,
      config = defaultConfig(), adjacent = {},
      strictInput = false, outputColor = nil, inputColors = {},
    }
    for t, spec in pairs(def.config or {}) do
      local c = b.config[tostring(t):upper()]
      if c then
        if spec.ejecting ~= nil then c.ejecting = spec.ejecting == true and c.canEject end
        for side, mode in pairs(spec.sides or {}) do c.sides[tostring(side):upper()] = tostring(mode):upper() end
      end
    end
    if def.ejector then
      b.strictInput = def.ejector.strictInput == true
      b.outputColor = def.ejector.outputColor and tostring(def.ejector.outputColor):upper() or nil
      for side, color in pairs(def.ejector.inputColors or {}) do b.inputColors[tostring(side):upper()] = tostring(color):upper() end
    end
    for key, inventoryName in pairs(def.adjacent or {}) do
      local k = tostring(key):upper()
      if indexOf(SIDES, k) then k = toDirection(k, b.facing) end
      b.adjacent[k] = inventoryName
    end
    if def.frequency ~= nil then
      local name, public = def.frequency, true
      if type(def.frequency) == "table" then name, public = def.frequency.name, def.frequency.public ~= false end
      b.frequency = find(name, public, ownerUuid) or newFrequency({ name = name, public = public }, ownerUuid)
    end

    --- TileComponentEjector.outputItems: each output mode's sides in Direction order, the whole slot offered to each
    local function outputItems(f)
      for _, mode in ipairs({ "OUTPUT", "INPUT_OUTPUT" }) do
        local dirs = {}
        for _, dir in ipairs(DIRECTIONS) do
          for _, side in ipairs(SIDES) do
            if b.config.ITEM.sides[side] == mode and toDirection(side, b.facing) == dir then dirs[#dirs + 1] = dir break end
          end
        end
        if #dirs > 0 and f.item then
          local remaining = f.item.count
          for _, dir in ipairs(dirs) do
            local inv = b.adjacent[dir] and Q.targetInventory(b.adjacent[dir])
            if inv and f.item then
              local items, left = inv.__state(), remaining
              for slot = 1, inv.size() do
                left = left - Q.insertIntoSlot(items, slot, f.item.type, left)
                if left <= 0 then break end
              end
              local used = remaining - left
              if used > 0 then
                f.item.count = f.item.count - used
                remaining = remaining - used
                if f.item.count <= 0 then f.item = nil end
                if remaining <= 0 then break end
              end
            end
          end
        end
      end
    end

    -- TileEntityConfigurableMachine.onUpdateServer -> TileComponentEjector.tickServer (items only: the other
    -- buffers go to neighbouring tanks and cables, which the emulator does not have)
    function b.tick()
      if not b.loaded then return end
      local f = validFrequency(b)
      if f and b.config.ITEM.ejecting then
        if b.tickDelay == 0 then
          outputItems(f)
          b.tickDelay = EJECT_DELAY
        else
          b.tickDelay = b.tickDelay - 1
        end
      end
    end

    function b.moving() return b.loaded and validFrequency(b) ~= nil and b.config.ITEM.ejecting end

    function b.stateFn()
      local f = b.frequency
      local out = { type = E.TYPE, frequency = f and f.name or nil, public = f and f.public or nil, loaded = b.loaded,
        tickDelay = b.tickDelay, itemSides = {}, itemEjecting = b.config.ITEM.ejecting }
      for _, side in ipairs(SIDES) do out.itemSides[side] = b.config.ITEM.sides[side] end
      return out
    end

    blocks[#blocks + 1] = b
    Q.addBlock(b)
    return b
  end

  for _, def in ipairs(cfg.blocks or {}) do newBlock(def) end

  -- ===== computer methods =====

  local function frequencyOf(b)
    local f = validFrequency(b)
    if not f then J.computerError("No frequency is currently selected.") end
    return f
  end

  local function fluidToLua(s)
    if not s or s.amount <= 0 then return { name = "minecraft:empty", amount = 0 } end
    local out = { name = s.name, amount = s.amount }
    if type(s.nbt) == "table" and next(s.nbt) then out.nbt = s.nbt end
    return out
  end

  local function chemicalToLua(s)
    if not s or s.amount <= 0 then return { name = "mekanism:empty", amount = 0 } end
    return { name = s.name, amount = s.amount }
  end

  local function supported(b, t)
    -- every transmission type is configurable on an entangloporter, so validateSupportedTransmissionType never fails
    return b.config[t]
  end

  local METHODS = {
    hasFrequency = { {}, function(b) return ret(validFrequency(b) ~= nil) end },
    getFrequencies = { {}, function()
      local out = {}
      for _, f in ipairs(frequencies) do if f.public then out[#out + 1] = J.frequency(f.name, true, f.owner) end end
      return ret(out)
    end },
    getFrequency = { {}, function(b)
      local f = frequencyOf(b)
      return ret(J.frequency(f.name, f.public, f.owner))
    end },
    setFrequency = { { "String" }, function(b, name)
      Q.requirePublic(b)
      local f = find(name, true)
      if not f then J.computerError(("No public inventory frequency with name '%s' found."):format(fmt(name))) end
      if b.owner then b.frequency = f end
      return VOID
    end },
    createFrequency = { { "String" }, function(b, name)
      Q.requirePublic(b)
      if find(name, true) then
        J.computerError(("Unable to create public inventory frequency with name '%s' as one already exists."):format(fmt(name)))
      end
      if b.owner then b.frequency = newFrequency({ name = name, public = true }, b.owner) end
      return VOID
    end },
    getTransferLoss = { {}, function(b) return ret(validFrequency(b) and b.transferLoss or 0) end },
    getEnvironmentalLoss = { {}, function(b) return ret(validFrequency(b) and b.environmentalLoss or 0) end },
    getBufferItem = { {}, function(b)
      local f = frequencyOf(b)
      return ret(Q.stackToLua(f.item and f.item.type, f.item and f.item.count or 0))
    end },
    getTemperature = { {}, function(b) return ret(frequencyOf(b).temperature) end },
    -- TileEntityMekanism
    getDirection = { {}, function(b) return ret(b.facing) end },
    getEnergy = { {}, function(b) local f = validFrequency(b) return ret(f and f.energy or 0) end },
    getMaxEnergy = { {}, function(b) return ret(validFrequency(b) and ENERGY_BUFFER or 0) end },
    getEnergyNeeded = { {}, function(b) local f = validFrequency(b) return ret(f and ENERGY_BUFFER - f.energy or 0) end },
    getEnergyFilledPercentage = { {}, function(b)
      local f = validFrequency(b)
      -- FloatingLong.divideToLevel: 1 when the maximum is zero (no frequency: no containers)
      if not f then return ret(1) end
      if f.energy >= ENERGY_BUFFER then return ret(1) end
      return ret(f.energy / ENERGY_BUFFER)
    end },
    -- TileComponentUpgrade
    getInstalledUpgrades = { {}, function(b) return ret(b.anchor and { ANCHOR = 1 } or {}) end },
    getSupportedUpgrades = { {}, function() return ret({ "ANCHOR" }) end },
    -- TileComponentSecurity
    getOwnerUUID = { {}, function(b) return ret(b.owner) end },
    getOwnerName = { {}, function(b) return ret(b.ownerName) end },
    getSecurityMode = { {}, function(b) return ret(b.security) end },
    -- TileComponentConfig
    getConfigurableTypes = { {}, function()
      local out = {}
      for i, t in ipairs(TRANSMISSIONS) do out[i] = t end
      return ret(out)
    end },
    canEject = { { "TransmissionType" }, function(b, t) return ret(supported(b, t).canEject) end },
    isEjecting = { { "TransmissionType" }, function(b, t) return ret(supported(b, t).ejecting) end },
    setEjecting = { { "TransmissionType", "boolean" }, function(b, t, ejecting)
      Q.requirePublic(b)
      local c = supported(b, t)
      if not c.canEject then
        J.computerError(("This machine does not support auto-ejecting for transmission type '%s'."):format(t))
      end
      c.ejecting = ejecting
      return VOID
    end },
    getSupportedModes = { { "TransmissionType" }, function(b, t)
      local out = {}
      for i, m in ipairs(supported(b, t).modes) do out[i] = m end
      return ret(out)
    end },
    getMode = { { "TransmissionType", "RelativeSide" }, function(b, t, side) return ret(supported(b, t).sides[side]) end },
    setMode = { { "TransmissionType", "RelativeSide", "DataType" }, function(b, t, side, mode)
      Q.requirePublic(b)
      local c = supported(b, t)
      if not indexOf(c.modes, mode) then
        J.computerError(("This machine does not support mode '%s' for transmission type '%s'."):format(mode, t))
      end
      c.sides[side] = mode
      return VOID
    end },
    incrementMode = { { "TransmissionType", "RelativeSide" }, function(b, t, side)
      Q.requirePublic(b)
      local c = supported(b, t)
      local i = indexOf(DATA_ORDER, c.sides[side])
      repeat i = i % #DATA_ORDER + 1 until indexOf(c.modes, DATA_ORDER[i])
      c.sides[side] = DATA_ORDER[i]
      return VOID
    end },
    decrementMode = { { "TransmissionType", "RelativeSide" }, function(b, t, side)
      Q.requirePublic(b)
      local c = supported(b, t)
      local i = indexOf(DATA_ORDER, c.sides[side])
      repeat i = (i - 2) % #DATA_ORDER + 1 until indexOf(c.modes, DATA_ORDER[i])
      c.sides[side] = DATA_ORDER[i]
      return VOID
    end },
    -- TileComponentEjector
    hasStrictInput = { {}, function(b) return ret(b.strictInput) end },
    setStrictInput = { { "boolean" }, function(b, v)
      Q.requirePublic(b)
      b.strictInput = v
      return VOID
    end },
    getOutputColor = { {}, function(b) return ret(b.outputColor) end },
    setOutputColor = { { "EnumColor" }, function(b, color)
      Q.requirePublic(b)
      if not indexOf(TRANSPORTER_COLORS, color) then
        J.computerError(("Color '%s' is not a supported transporter color."):format(color))
      end
      b.outputColor = color
      return VOID
    end },
    clearOutputColor = { {}, function(b)
      Q.requirePublic(b)
      b.outputColor = nil
      return VOID
    end },
    incrementOutputColor = { {}, function(b)
      Q.requirePublic(b)
      local i = b.outputColor and indexOf(TRANSPORTER_COLORS, b.outputColor)
      b.outputColor = (not b.outputColor) and TRANSPORTER_COLORS[1] or TRANSPORTER_COLORS[i + 1]
      return VOID
    end },
    decrementOutputColor = { {}, function(b)
      Q.requirePublic(b)
      local i = b.outputColor and indexOf(TRANSPORTER_COLORS, b.outputColor)
      b.outputColor = (not b.outputColor) and TRANSPORTER_COLORS[#TRANSPORTER_COLORS] or TRANSPORTER_COLORS[i - 1]
      return VOID
    end },
    -- no entangloporter side is disabled, so validateInputSide never fails
    getInputColor = { { "RelativeSide" }, function(b, side) return ret(b.inputColors[side]) end },
    setInputColor = { { "RelativeSide", "EnumColor" }, function(b, side, color)
      Q.requirePublic(b)
      if not indexOf(TRANSPORTER_COLORS, color) then
        J.computerError(("Color '%s' is not a supported transporter color."):format(color))
      end
      b.inputColors[side] = color
      return VOID
    end },
    clearInputColor = { { "RelativeSide" }, function(b, side)
      Q.requirePublic(b)
      b.inputColors[side] = nil
      return VOID
    end },
    incrementInputColor = { { "RelativeSide" }, function(b, side)
      Q.requirePublic(b)
      local c = b.inputColors[side]
      local i = c and indexOf(TRANSPORTER_COLORS, c)
      b.inputColors[side] = (not c) and TRANSPORTER_COLORS[1] or TRANSPORTER_COLORS[i + 1]
      return VOID
    end },
    decrementInputColor = { { "RelativeSide" }, function(b, side)
      Q.requirePublic(b)
      local c = b.inputColors[side]
      local i = c and indexOf(TRANSPORTER_COLORS, c)
      b.inputColors[side] = (not c) and TRANSPORTER_COLORS[#TRANSPORTER_COLORS] or TRANSPORTER_COLORS[i - 1]
      return VOID
    end },
  }

  -- the ComputerFluidTankWrapper / ComputerChemicalTankWrapper methods over each buffer
  local function tankMethods(prefix, field, capacity, toLua)
    METHODS["getBuffer" .. prefix] = { {}, function(b) return ret(toLua(frequencyOf(b)[field])) end }
    METHODS["getBuffer" .. prefix .. "Capacity"] = { {}, function(b) frequencyOf(b) return ret(capacity) end }
    METHODS["getBuffer" .. prefix .. "Needed"] = { {}, function(b)
      local s = frequencyOf(b)[field]
      return ret(capacity - (s and s.amount or 0))
    end }
    METHODS["getBuffer" .. prefix .. "FilledPercentage"] = { {}, function(b)
      local s = frequencyOf(b)[field]
      return ret((s and s.amount or 0) / capacity)
    end }
  end
  tankMethods("Fluid", "fluid", FLUID_BUFFER, fluidToLua)
  if J.V21 then
    tankMethods("Chemical", "chemical", CHEMICAL_BUFFER, chemicalToLua) -- 10.7 getBufferChemical*
  else
    tankMethods("Gas", "gas", CHEMICAL_BUFFER, chemicalToLua)
    tankMethods("InfuseType", "infusion", CHEMICAL_BUFFER, chemicalToLua)
    tankMethods("Pigment", "pigment", CHEMICAL_BUFFER, chemicalToLua)
    tankMethods("Slurry", "slurry", CHEMICAL_BUFFER, chemicalToLua)
  end

  --- What CC's pushItems/pullItems reach through MekanismPeripheral.getTarget(): getCapability(ITEM_HANDLER) with no
  --- side. Without a frequency there are no slots, so no handler; with one, the read-only proxy (one slot that
  --- refuses every insert and extract).
  local function ccHandler(b)
    if not validFrequency(b) then return nil end
    local handler = {}
    function handler.size() return 1 end
    function handler.__state() return {} end
    function handler.__insert(_, _, toSlot)
      if toSlot ~= nil and toSlot ~= 1 then error("To slot out of range (between 1 and 1)", 0) end
      return 0
    end
    function handler.__pull(slot)
      if slot ~= 1 then error("From slot out of range (between 1 and 1)", 0) end
      return 0
    end
    return handler
  end

  function E.peripheral(def)
    local b = Q.findBlock(def.name)
    if not b or b.def ~= def then b = newBlock(def) end
    local p = Q.makePeripheral(b, METHODS, E.METHOD_ORDER)
    p.ccHandler = function() return ccHandler(b) end
    return p
  end

  -- ===== state and host commands =====

  function E.state()
    local out = { frequencies = {} }
    for _, f in ipairs(frequencies) do
      out.frequencies[#out.frequencies + 1] = {
        name = f.name, public = f.public,
        item = f.item and Q.stackToLua(f.item.type, f.item.count) or nil,
        fluid = f.fluid, gas = f.gas, infuseType = f.infusion, pigment = f.pigment, slurry = f.slurry, chemical = f.chemical,
        energy = f.energy, temperature = f.temperature,
      }
    end
    return out
  end

  local function frequencyFor(cmd)
    local public = cmd.public ~= false
    return find(cmd.frequency, public, (Q.playerUuid(cmd.owner)))
  end

  local handlers = {}
  E.handlers = handlers

  --- Something (a hopper, a pipe, a player) puts items into an entangloporter's input side.
  function handlers.qeInsert(cmd)
    Q.catchUp()
    local f = frequencyFor(cmd)
    if not f then return false, "no such inventory frequency" end
    if type(cmd.item) ~= "table" or type(cmd.item.name) ~= "string" then return false, "item needs a name" end
    local want = cmd.item.count or 1
    local taken = slotInsert(f, Q.typeOf(cmd.item), want)
    if taken < want then return false, (want - taken) .. " refused (the slot holds one stack of one item)" end
    return true
  end

  function handlers.qeExtract(cmd)
    Q.catchUp()
    local f = frequencyFor(cmd)
    if not f then return false, "no such inventory frequency" end
    if f.item then
      f.item.count = f.item.count - math.min(f.item.count, tonumber(cmd.count) or f.item.count)
      if f.item.count <= 0 then f.item = nil end
    end
    return true
  end

  --- Load or unload an entangloporter's chunk: an unloaded one does not tick, so it ejects nothing.
  function handlers.qeSetLoaded(cmd)
    Q.catchUp()
    local b = Q.findBlock(cmd.block or "")
    if not b or b.kind ~= E.TYPE then return false, "no such entangloporter" end
    b.loaded = cmd.loaded ~= false
    return true
  end

  return E
end
