-- ccsim addons/mekanism-machines/sps: the Supercritical Phase Shifter, read through its ports (see engine.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   content/sps/SPSMultiblockData (tick: with polonium in and room for antimatter, the energy the coils received
--   last tick processes energy / energyPerInput mB of polonium, progress kept between ticks; every inputPerAntimatter
--   mB processed is 1 mB of antimatter; input 2 × inputPerAntimatter mB, output 1000 mB; getProcessRate, getCoils;
--   canSupplyCoilEnergy), tile/multiblock/TileEntitySPSPort (its own energy container, 1 GJ, handed to the coil in
--   front of it every tick while the SPS can work; output mode = active: emits antimatter; getMode / setMode),
--   config/GeneralConfig (the pack's general.toml: inputPerAntimatter 1000, energyPerInput 1000000 J),
--   config/StorageConfig (spsPort 1000000000).
return function(E)
  local FL = E.FL
  local floor, min, max = math.floor, math.min, math.max

  local INPUT_PER_ANTIMATTER, ENERGY_PER_INPUT = 1000, 1000000
  local MAX_OUTPUT, PORT_STORAGE = 1000, 1000000000
  local POLONIUM, ANTIMATTER = "mekanism:polonium", "mekanism:antimatter"

  local K = { kind = "sps", defaults = { length = 7, width = 7, height = 7 } }
  K.rates = { poloniumInput = true, antimatterOutput = true, energyInput = true }
  K.defaultFluid = { input = POLONIUM, output = ANTIMATTER }

  function K.init(mb, spec)
    mb.input = E.tank(true, function() return INPUT_PER_ANTIMATTER * 2 end, function(n) return n == POLONIUM end)
    mb.output = E.tank(true, function() return MAX_OUTPUT end, function(n) return n == ANTIMATTER end)
    E.fill(mb.input, spec.input, POLONIUM)
    E.fill(mb.output, spec.output, ANTIMATTER)
    mb.tanks = { input = mb.input, output = mb.output }
    mb.progress, mb.inputProcessed = 0, floor(tonumber(spec.inputProcessed) or 0)
    mb.receivedEnergy, mb.lastReceivedEnergy, mb.lastProcessed, mb.couldOperate = 0, 0, 0, false
    mb.ports = {}
    mb.antimatterMade = 0
  end

  local function canOperate(mb) return mb.input.amount > 0 and E.needed(mb.output) > 0 end

  local function process(mb, operations)
    if operations == 0 then return 0 end
    local processed = E.shrink(mb.input, operations)
    mb.inputProcessed = mb.inputProcessed + processed
    if mb.inputProcessed >= INPUT_PER_ANTIMATTER then
      local n = floor(mb.inputProcessed / INPUT_PER_ANTIMATTER)
      mb.antimatterMade = mb.antimatterMade + E.insert(mb.output, ANTIMATTER, n)
      mb.inputProcessed = mb.inputProcessed % INPUT_PER_ANTIMATTER
    end
    return processed
  end

  function K.tick(mb)
    local processed = 0
    mb.couldOperate = canOperate(mb)
    if mb.couldOperate and mb.receivedEnergy > 0 then
      local inputNeeded = (INPUT_PER_ANTIMATTER - mb.inputProcessed) + INPUT_PER_ANTIMATTER * (E.needed(mb.output) - 1)
      local processable = mb.receivedEnergy / ENERGY_PER_INPUT
      if processable + mb.progress >= inputNeeded then
        processed = process(mb, inputNeeded)
        mb.progress = 0
      else
        processed = processable
        mb.progress = mb.progress + processable
        local toProcess = E.toLong(mb.progress)
        local actual = process(mb, toProcess)
        if actual < toProcess then
          local dif = toProcess - actual
          mb.progress = mb.progress - dif
          processed = processed - dif
        end
        mb.progress = math.fmod(mb.progress, 1)
      end
    end
    mb.lastReceivedEnergy = mb.receivedEnergy
    mb.receivedEnergy = 0
    mb.lastProcessed = processed
  end

  local function canSupply(mb, coil) return (mb.couldOperate or canOperate(mb)) and coil end

  --- Cables into the ports (each port's `energyInput`, or the fixture's `energyInput` for ports no computer sees),
  --- the ports hand it to their coils; pipes: `poloniumInput` in, `antimatterOutput` out of a port in output mode.
  function K.transfer(mb)
    local s = mb.spec
    for _, b in ipairs(mb.ports) do
      local r = E.rate(b.energyInput)
      if r and r > 0 then b.energy:insert(min(r, PORT_STORAGE)) end
      if b.energy.stored > 0 and canSupply(mb, b.coil) then
        mb.receivedEnergy = FL.create(mb.receivedEnergy + b.energy:extract(b.energy.stored))
      end
    end
    local r = E.rate(s.energyInput)
    if r and r > 0 and canSupply(mb, true) then mb.receivedEnergy = FL.create(mb.receivedEnergy + min(r, PORT_STORAGE)) end
    r = E.rate(s.poloniumInput)
    if r and r > 0 then E.insert(mb.input, POLONIUM, r) end
    r = E.rate(s.antimatterOutput)
    if r and r > 0 and mb.output.amount > 0 and E.portAllows(mb, true) then E.shrink(mb.output, r) end
  end

  function K.redstoneLevel() return 0 end

  local function coils(mb)
    local n = 0
    for _, b in ipairs(mb.ports) do if b.coil then n = n + 1 end end
    return max(n, floor(tonumber(mb.spec.coils) or 0))
  end

  local function processRate(mb)
    return floor(mb.lastProcessed / INPUT_PER_ANTIMATTER * 1000 + 0.5) / 1000 -- Math.round
  end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      inputProcessed = function(v) mb.inputProcessed = floor(tonumber(v)) end,
      coils = function(v) mb.spec.coils = v end,
    })
  end

  function K.state(mb)
    return {
      input = E.tankState(mb.input), output = E.tankState(mb.output), processRate = processRate(mb),
      lastReceivedEnergy = mb.lastReceivedEnergy, inputProcessed = mb.inputProcessed, progress = mb.progress,
      coils = coils(mb), antimatterMade = mb.antimatterMade,
    }
  end

  -- ===== computer methods =====

  local MB = {
    getProcessRate = { {}, function(c) return processRate(c.mb) end },
    getCoils = { {}, function(c) return coils(c.mb) end },
  }
  E.tankMethods(MB, "Input", function(mb) return mb.input end)
  E.tankMethods(MB, "Output", function(mb) return mb.output end)
  E.shapeMethods(MB)

  local function portEnergy(field)
    return { {}, function(c) return c.block.energy[field](c.block.energy) end }
  end
  local PORT = {
    getMode = { {}, function(c) return c.block.portMode end },
    setMode = E.void({ "boolean" }, function(c, v) c.block.portMode = v end),
    isFormed = E.T.isFormed,
    getEnergy = portEnergy("get"),
    getMaxEnergy = portEnergy("max"),
    getEnergyNeeded = portEnergy("needed"),
    getEnergyFilledPercentage = { {}, function(c)
      local e = c.block.energy
      return FL.toLevel(e:get(), e:max())
    end },
  }

  K.types = {
    spsPort = {
      tile = PORT, multiblock = MB,
      newBlock = function(def, mb)
        local b = { portMode = def.mode == "output" or def.output == true, coil = def.coil ~= false, energyInput = def.energyInput }
        b.energy = E.energyContainer(function() return PORT_STORAGE end)
        b.energy.stored = FL.create(min(tonumber(def.energy) or 0, PORT_STORAGE))
        for i = #mb.ports, 1, -1 do if mb.ports[i].name == def.name then table.remove(mb.ports, i) end end
        b.name = def.name
        mb.ports[#mb.ports + 1] = b
        return b
      end,
      blockState = function(c, s)
        s.mode = c.block.portMode and "output" or "input"
        s.energy = c.block.energy.stored
      end,
    },
  }
  return K
end
