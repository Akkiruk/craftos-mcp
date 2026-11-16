-- ccsim addons/mekanism-machines/matrix: the Induction Matrix (see engine.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   content/matrix/MatrixMultiblockData (tick, computer methods, redstone level), content/matrix/MatrixEnergyContainer
--   (queued input and output, the transfer cap shared per tick, getEnergy = stored + queued in - queued out),
--   tile/multiblock/TileEntityInductionPort (mode: output when active; inserts only in input mode, emits only in
--   output mode), tile/multiblock/TileEntityInductionCasing, tier/InductionCellTier, tier/InductionProviderTier.
return function(E)
  local FL = E.FL
  local floor, min, max = math.floor, math.min, math.max

  local CELL = { basic = 8000000000, advanced = 64000000000, elite = 512000000000, ultimate = 4000000000000 }
  local PROVIDER = { basic = 256000, advanced = 2048000, elite = 16384000, ultimate = 131072000 }

  local K = { kind = "matrix", defaults = { length = 5, width = 5, height = 5 } }
  K.defaultFluid = {}
  K.rates = { input = true, output = true, inputPorts = true, outputPorts = true }

  --- `cells` / `providers`: a count of basic ones, or { basic = n, advanced = n, elite = n, ultimate = n }.
  local function tiers(spec, table_, default)
    local count, total = 0, 0
    if spec == nil then spec = default end
    if type(spec) == "number" then spec = { basic = spec } end
    for tier, n in pairs(spec) do
      local each = table_[tier]
      if not each then error("ccsim: unknown induction tier '" .. tostring(tier) .. "'", 0) end
      count = count + n
      total = total + each * n
    end
    return count, total
  end

  local function item(spec)
    if type(spec) == "table" and spec.name then return { name = spec.name, count = tonumber(spec.count) or 1 } end
    return { name = "minecraft:air", count = 0 }
  end

  function K.init(mb, spec)
    mb.cells, mb.storageCap = tiers(spec.cells, CELL, { basic = 1 })
    mb.providers, mb.transferCap = tiers(spec.providers, PROVIDER, { basic = 1 })
    local c = { cached = FL.create(min(tonumber(spec.energy) or 0, mb.storageCap)), queuedIn = 0, queuedOut = 0, lastIn = 0, lastOut = 0 }
    mb.container = c
    mb.tanks = {}
    mb.inputItem, mb.outputItem = item(spec.inputItem), item(spec.outputItem)
    -- the IEnergyContainer view the ports hand out
    mb.energyView = {
      get = function() return c.cached + c.queuedIn - c.queuedOut end,
      max = function() return mb.storageCap end,
      needed = function(self) return max(0, mb.storageCap - self.get()) end,
    }
  end

  local function energy(mb) return mb.energyView.get() end

  --- MatrixEnergyContainer.insert: up to the transfer cap left this tick and the room left.
  local function insert(mb, amount)
    if amount <= 0 or not mb.formed or mb.destroyed then return 0 end
    local c = mb.container
    local n = min(FL.create(amount), mb.transferCap - c.queuedIn, max(0, mb.storageCap - energy(mb)))
    if n <= 0 then return 0 end
    c.queuedIn = c.queuedIn + n
    return n
  end
  local function extract(mb, amount)
    if energy(mb) <= 0 or amount <= 0 or not mb.formed or mb.destroyed then return 0 end
    local c = mb.container
    local n = min(amount, mb.transferCap - c.queuedOut, energy(mb))
    if n <= 0 then return 0 end
    c.queuedOut = c.queuedOut + n
    return n
  end

  --- A linked turbine or fusion reactor charges the matrix through an input-mode port.
  function K.acceptEnergy(mb, amount)
    if not E.portAllows(mb, "input", "inputPorts") then return 0 end
    return insert(mb, amount)
  end

  function K.tick(mb)
    local c = mb.container
    if c.queuedIn < c.queuedOut then c.cached = FL.create(c.cached - (c.queuedOut - c.queuedIn))
    elseif c.queuedIn > c.queuedOut then c.cached = FL.create(c.cached + (c.queuedIn - c.queuedOut)) end
    c.lastIn, c.lastOut = c.queuedIn, c.queuedOut
    c.queuedIn, c.queuedOut = 0, 0
  end

  --- Cables on the ports: `input` J/t from generators through input-mode ports, `output` J/t to machines through
  --- output-mode ports (TileEntityInductionPort emits only while active).
  function K.transfer(mb)
    local s = mb.spec
    local r = E.rate(s.input)
    if r and r > 0 and E.portAllows(mb, "input", "inputPorts") then insert(mb, r) end
    r = E.rate(s.output)
    if r and r > 0 and E.portAllows(mb, "output", "outputPorts") then extract(mb, r) end
  end

  --- MekanismUtils.redstoneLevelFromContents(FloatingLong, FloatingLong)
  function K.redstoneLevel(mb)
    local e = energy(mb)
    if mb.storageCap == 0 or e == 0 then return 0 end
    return 1 + floor(FL.multiply(FL.divide(e, mb.storageCap), 14))
  end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      energy = function(v)
        local c = mb.container
        c.cached, c.queuedIn, c.queuedOut = FL.create(min(tonumber(v), mb.storageCap)), 0, 0
      end,
      cells = function(v) mb.cells, mb.storageCap = tiers(v, CELL); mb.container.cached = min(mb.container.cached, mb.storageCap) end,
      providers = function(v) mb.providers, mb.transferCap = tiers(v, PROVIDER) end,
      inputItem = function(v) mb.inputItem = item(v) end,
      outputItem = function(v) mb.outputItem = item(v) end,
    })
  end

  function K.state(mb)
    local c = mb.container
    return {
      energy = energy(mb), maxEnergy = mb.storageCap, transferCap = mb.transferCap, lastInput = c.lastIn,
      lastOutput = c.lastOut, cells = mb.cells, providers = mb.providers,
    }
  end

  -- ===== computer methods =====

  local function copy(t) return { name = t.name, count = t.count } end
  local MB = {
    getInputItem = { {}, function(c) return copy(c.mb.inputItem) end },
    getOutputItem = { {}, function(c) return copy(c.mb.outputItem) end },
    getTransferCap = { {}, function(c) return c.mb.transferCap end },
    getLastInput = { {}, function(c) return c.mb.container.lastIn end },
    getLastOutput = { {}, function(c) return c.mb.container.lastOut end },
    getInstalledCells = { {}, function(c) return c.mb.cells end },
    getInstalledProviders = { {}, function(c) return c.mb.providers end },
  }
  E.shapeMethods(MB)

  local PORT = {
    getMode = { {}, function(c) return c.block.portMode == "output" end },
    setMode = E.void({ "boolean" }, function(c, output) c.block.portMode = output and "output" or "input" end),
    isFormed = E.T.isFormed,
    getComparatorLevel = E.T.getComparatorLevel,
  }
  E.energyMethods(PORT, function(mb) return { mb.energyView } end)

  K.types = {
    inductionPort = {
      tile = PORT, multiblock = MB,
      newBlock = function(def) return { portMode = (def.mode == true or def.mode == "output") and "output" or "input" } end,
      blockState = function(c, s) s.mode = c.block.portMode == "output" end,
    },
  }
  return K
end
