-- ccsim addons/mekanism-machines/dynamic: the Dynamic Tank, read through its valves (see engine.lua).
--
-- Mekanism 10.2.5 source, src/main/java/mekanism/common/:
--   content/tank/TankMultiblockData (one merged tank: a fluid or one chemical at a time; capacities volume ×
--   dynamicTankFluidPerTank / dynamicTankChemicalPerTank; getStored, getFilledPercentage, the edit mode, the redstone
--   level), lib/multiblock/MultiblockData.setShape (volume = length × width × height),
--   tile/multiblock/TileEntityDynamicValve (a TileEntityDynamicTank: isFormed, and getComparatorLevel from the
--   Comparator attribute; no facing, no security), capabilities/merged/MergedTank, config/GeneralConfig (the pack's
--   general.toml: 350000 mB fluid and 16000000 mB chemical per block).
return function(E)
  local J = E.J
  local floor, min = math.floor, math.min

  J.ENUMS.ContainerEditMode = J.ENUMS.ContainerEditMode or { "BOTH", "FILL", "EMPTY" }

  local FLUID_PER_TANK, CHEMICAL_PER_TANK = 350000, 16000000
  local KINDS = { FLUID = true, GAS = true, INFUSION = true, PIGMENT = true, SLURRY = true }

  local K = { kind = "dynamicTank", defaults = { length = 3, width = 3, height = 3 } }
  K.rates = { fluidInput = true, fluidOutput = true, chemicalInput = true, chemicalOutput = true }
  K.defaultFluid = { fluid = "minecraft:water", chemical = "mekanism:hydrogen" }

  local function fluidCap(mb) return mb.volume * FLUID_PER_TANK end
  local function chemCap(mb) return mb.volume * CHEMICAL_PER_TANK end

  --- The merged tank: { kind = "FLUID" | "GAS" | ..., name, amount } or empty (kind nil).
  local function fill(mb, spec, kind)
    mb.store = { amount = 0 }
    if spec == nil then return end
    local name, amount
    if type(spec) == "number" then name, amount = K.defaultFluid[kind == "FLUID" and "fluid" or "chemical"], spec
    elseif type(spec) == "table" then
      name, amount = spec.name, tonumber(spec.amount) or 0
      if spec.type then kind = tostring(spec.type):upper() end
    else error("ccsim: a dynamic tank's contents are a number or { name, amount }", 0) end
    if not KINDS[kind] then error("ccsim: dynamic tank contents type '" .. tostring(kind) .. "' is not one of FLUID, GAS, INFUSION, PIGMENT, SLURRY", 0) end
    name = J.resourceLocation(name or K.defaultFluid[kind == "FLUID" and "fluid" or "chemical"]) or name
    if amount > 0 then
      mb.store = { kind = kind, name = name, amount = min(amount, kind == "FLUID" and fluidCap(mb) or chemCap(mb)) }
    end
  end

  local function capOf(mb) return mb.store.kind == "FLUID" and fluidCap(mb) or chemCap(mb) end

  function K.init(mb, spec)
    mb.editMode = "BOTH"
    if spec.editMode then
      local m = tostring(spec.editMode):upper()
      for _, x in ipairs(J.ENUMS.ContainerEditMode) do if x == m then mb.editMode = m end end
    end
    if spec.chemical ~= nil then fill(mb, spec.chemical, "GAS") else fill(mb, spec.fluid, "FLUID") end
    mb.inputItem, mb.outputItem = spec.inputItem, spec.outputItem
    -- mekAddTank: "fluid" or "chemical" goes into the merged tank when it is empty or holds the same
    local function view(kind)
      local t = { gas = kind ~= "FLUID" }
      t.cap = function() return kind == "FLUID" and fluidCap(mb) or chemCap(mb) end
      t.accepts = function() return mb.store.amount <= 0 or (mb.store.kind == "FLUID") == (kind == "FLUID") end
      return setmetatable(t, {
        __index = function(_, k)
          if k == "amount" then return ((mb.store.kind == "FLUID") == (kind == "FLUID")) and mb.store.amount or 0 end
          if k == "name" then return mb.store.amount > 0 and mb.store.name or nil end
        end,
        __newindex = function(_, k, v)
          if k == "amount" then
            mb.store.amount = v
            if v <= 0 then mb.store = { amount = 0 } elseif not mb.store.kind then mb.store.kind = kind end
          elseif k == "name" then
            if v == nil then mb.store = { amount = 0 } else mb.store.name = v; mb.store.kind = mb.store.kind or kind end
          end
        end,
      })
    end
    mb.tanks = { fluid = view("FLUID"), chemical = view("GAS") }
  end

  function K.tick() end

  --- Pipes on the valves: `fluidInput` / `chemicalInput` mB/t in, `fluidOutput` / `chemicalOutput` mB/t out.
  function K.transfer(mb)
    local s = mb.spec
    for _, side in ipairs({ { "fluid", "FLUID" }, { "chemical", "GAS" } }) do
      local t = mb.tanks[side[1]]
      local r = E.rate(s[side[1] .. "Input"])
      if r and r > 0 then E.insert(t, t.name or K.defaultFluid[side[1]], r) end
      r = E.rate(s[side[1] .. "Output"])
      if r and r > 0 and t.amount > 0 then E.shrink(t, r) end
    end
  end

  function K.redstoneLevel(mb) return E.redstoneLevel(mb.store.amount, capOf(mb)) end

  function K.set(mb, fields)
    E.applySet(mb, fields, {
      editMode = function(v) mb.editMode = tostring(v):upper() end,
      fluid = function(v) fill(mb, v, "FLUID") end,
      chemical = function(v) fill(mb, v, "GAS") end,
    })
  end

  function K.state(mb)
    local s = { editMode = mb.editMode, volume = mb.volume, tankCapacity = fluidCap(mb), chemicalTankCapacity = chemCap(mb) }
    if mb.store.amount > 0 then s.stored = { type = mb.store.kind, name = mb.store.name, amount = mb.store.amount } end
    return s
  end

  -- ===== computer methods =====

  local MODES = J.ENUMS.ContainerEditMode
  local function slot(field)
    return { {}, function(c) return E.B.item(c.mb[field]) end }
  end
  local MB = {
    getContainerEditMode = { {}, function(c) return c.mb.editMode end },
    getInputItem = slot("inputItem"),
    getOutputItem = slot("outputItem"),
    getTankCapacity = { {}, function(c) return fluidCap(c.mb) end },
    getChemicalTankCapacity = { {}, function(c) return chemCap(c.mb) end },
    setContainerEditMode = E.void({ "ContainerEditMode" }, function(c, m) c.mb.editMode = m end),
    incrementContainerEditMode = E.void({}, function(c) c.mb.editMode = E.cycle(MODES, c.mb.editMode, 1) end),
    decrementContainerEditMode = E.void({}, function(c) c.mb.editMode = E.cycle(MODES, c.mb.editMode, -1) end),
    getStored = { {}, function(c)
      local st = c.mb.store
      if st.amount <= 0 then return { name = E.EMPTY_FLUID, amount = 0 } end -- FluidStack.EMPTY
      return { name = st.name, amount = st.amount }
    end },
    getFilledPercentage = { {}, function(c) return c.mb.store.amount / capOf(c.mb) end },
  }
  E.shapeMethods(MB)

  K.types = {
    dynamicValve = {
      tile = { isFormed = E.T.isFormed, getComparatorLevel = E.T.getComparatorLevel },
      multiblock = MB,
    },
  }
  return K
end
