-- ccsim ap/bridges: meBridge (Applied Energistics 2) and rsBridge (Refined Storage).
-- Behaviour follows AdvancedPeripherals 0.7.30r (MeBridgePeripheral, RsBridgePeripheral,
-- AppEngApi, RefinedStorage, InventoryUtil, ItemFilter, FluidFilter). The storage network
-- is a fixture on the peripheral definition; nothing is simulated beyond item/fluid moves.
--
-- Fixture fields (all optional):
--   connected      default true
--   items          { {name, amount, displayName?, nbt?, tags?, fingerprint?, craftable?} }
--   fluids         same shape for fluids
--   craftableItems / craftableFluids   { {name, ...} } things with patterns but maybe no stock
--   energy         { stored, max, usage, injection }
--   cells          ME: { {item, cellType = "item"|"fluid", bytesPerType, totalBytes, usedBytes?} }
--   cpus           ME: { {storage, coProcessors, isBusy, craftingJob?} }
--   patterns       RS: { {outputs = {stack}, inputs = {{stack}}, byproducts, processing} }
--   storage        RS: { maxItemDisk, maxFluidDisk, maxItemExternal, maxFluidExternal }
--   adjacent       side -> name of a virtual inventory / tank next to the bridge
return function(core, B)
  local F = {}

  local function newEntryFrom(src, amountKey)
    local e = B.copy(src)
    e.amount = e.amount or e[amountKey or "count"] or 0
    e.count = nil
    return e
  end

  local function load(list)
    local out = {}
    for _, e in ipairs(list or {}) do out[#out + 1] = newEntryFrom(e) end
    return out
  end

  local function sameKey(a, b)
    return a.name == b.name and B.deepEqual(a.nbt or {}, b.nbt or {})
  end

  local function inventoryOf(name)
    local entry = name and core.peripherals[name]
    return entry and entry.inventory or nil
  end

  local function tankOf(name)
    local entry = name and core.peripherals[name]
    return entry and entry.tank or nil
  end

  local function build(def, flavor)
    local self = B.new(def)
    local m = self.methods
    local net = {
      connected = def.connected ~= false,
      items = load(def.items),
      fluids = load(def.fluids),
      craftableItems = load(def.craftableItems),
      craftableFluids = load(def.craftableFluids),
      energy = def.energy or {},
      jobs = {},
    }
    self.network = net
    local isME = flavor == "me"

    local function connected() return net.connected end
    local function notConnected() return nil, "NOT_CONNECTED" end

    -- ----- crafting lookups -----

    local function isCraftableEntry(entry, kind)
      if entry.craftable then return true end
      local list = kind == "fluid" and net.craftableFluids or net.craftableItems
      for _, c in ipairs(list) do if sameKey(c, entry) then return true end end
      return false
    end

    local function itemObject(entry, kind)
      local object = {
        fingerprint = B.fingerprint(entry),
        name = entry.name,
        amount = entry.amount,
        displayName = B.displayName(entry),
        isCraftable = isCraftableEntry(entry, kind),
      }
      if isME then
        -- AEItemKey.toTag(): {id = <registry name>, tag = <nbt>}
        local tag = { id = entry.name }
        if entry.nbt then tag.tag = B.copy(entry.nbt) end
        object.nbt = tag
        object.tags = entry.tags or {}
      else
        object.nbt = entry.nbt and B.copy(entry.nbt) or nil
        object.tags = (entry.tags and #entry.tags > 0) and entry.tags or nil
      end
      return object
    end

    local function findIn(list, filter)
      for _, e in ipairs(list) do
        if B.filterTest(filter, e) then return e end
      end
    end

    --- ME: stored match first, then craftables (amount 0). Returns entry or nil.
    local function findStack(filter, includeCraftables, kind)
      local stored = findIn(kind == "fluid" and net.fluids or net.items, filter)
      if stored then return stored, true end
      if not includeCraftables then return nil end
      local pattern = findIn(kind == "fluid" and net.craftableFluids or net.craftableItems, filter)
      if pattern then
        local copy = B.copy(pattern)
        copy.amount = 0
        return copy, false
      end
    end

    local function parse(tbl, kind)
      tbl = B.table(1, tbl)
      return B.parseFilter(tbl, kind)
    end

    -- ----- storage mutation -----

    local function removeFrom(list, entry, count)
      entry.amount = entry.amount - count
      if entry.amount <= 0 then
        for i, e in ipairs(list) do if e == entry then table.remove(list, i) break end end
      end
    end

    local function addTo(list, stack, count)
      for _, e in ipairs(list) do
        if sameKey(e, stack) then e.amount = e.amount + count return end
      end
      local copy = B.copy(stack)
      copy.count = nil
      copy.amount = count
      list[#list + 1] = copy
    end

    local function resolveTarget(arg, byPeripheral, kind)
      local name
      if byPeripheral then name = arg else
        local ok, direction = pcall(B.direction, arg, def.orientation)
        if not ok then error(direction, 0) end
        name = (def.adjacent or {})[arg:lower()] or (def.adjacent or {})[direction]
      end
      if kind == "fluid" then return tankOf(name) end
      return inventoryOf(name)
    end

    --- Move items network -> inventory or inventory -> network (InventoryUtil.moveItem).
    local function exportItems(filter, inv)
      local moved = 0
      local entry = findIn(net.items, filter)
      if not entry then return 0 end
      local want = math.min(filter.count, entry.amount)
      local stack = { name = entry.name, nbt = entry.nbt, displayName = entry.displayName, tags = entry.tags,
        maxCount = entry.maxCount, count = want }
      moved = inv.__insert(stack, want, filter.toSlot ~= -1 and filter.toSlot + 1 or nil)
      if moved > 0 then removeFrom(net.items, entry, moved) end
      return moved
    end

    local function importItems(filter, inv)
      local moved, slots = 0, inv.__state()
      local first = filter.fromSlot ~= -1 and filter.fromSlot + 1 or 1
      local last = filter.fromSlot ~= -1 and filter.fromSlot + 1 or inv.size()
      for slot = first, last do
        local stack = slots[slot]
        if stack and B.filterTest(filter, stack) then
          local take = math.min(filter.count - moved, stack.count)
          if take > 0 then
            addTo(net.items, stack, take)
            stack.count = stack.count - take
            if stack.count <= 0 then slots[slot] = nil end
            moved = moved + take
          end
          if moved >= filter.count then break end
        end
      end
      return moved
    end

    local function exportFluids(filter, tank)
      local entry = findIn(net.fluids, filter)
      if not entry then return 0 end
      local moved = tank.__fill(entry, math.min(filter.count, entry.amount))
      if moved > 0 then removeFrom(net.fluids, entry, moved) end
      return moved
    end

    local function importFluids(filter, tank)
      local fluid = tank.__contents()
      if not fluid or not B.filterTest(filter, fluid) then return 0 end
      local moved = tank.__drain(math.min(filter.count, fluid.amount))
      if moved > 0 then addTo(net.fluids, fluid, moved) end
      return moved
    end

    local function transfer(kind, direction, arg, byPeripheral, filterTable)
      local filter, err = parse(filterTable, kind)
      if not filter then return 0, err end
      local target = resolveTarget(arg, byPeripheral, kind)
      if not target then
        if isME then error("java.lang.NullPointerException", 0) end
        return 0, "INVALID_TARGET"
      end
      if kind == "item" then
        return (direction == "export" and exportItems or importItems)(filter, target)
      end
      return (direction == "export" and exportFluids or importFluids)(filter, target)
    end

    local function guard(fn)
      return function(...)
        if not connected() then return notConnected() end
        return fn(...)
      end
    end

    -- ----- shared surface -----

    m.isConnected = function() return connected() end

    m.exportItem = guard(function(filter, side) return transfer("item", "export", B.string(2, side), false, filter) end)
    m.importItem = guard(function(filter, side) return transfer("item", "import", B.string(2, side), false, filter) end)
    m.exportItemToPeripheral = guard(function(filter, name) return transfer("item", "export", B.string(2, name), true, filter) end)
    m.importItemFromPeripheral = guard(function(filter, name) return transfer("item", "import", B.string(2, name), true, filter) end)

    local fluidGuard = isME and function(fn) return fn end or guard
    m.exportFluid = fluidGuard(function(filter, side) return transfer("fluid", "export", B.string(2, side), false, filter) end)
    m.importFluid = fluidGuard(function(filter, side) return transfer("fluid", "import", B.string(2, side), false, filter) end)
    m.exportFluidToPeripheral = fluidGuard(function(filter, name) return transfer("fluid", "export", B.string(2, name), true, filter) end)
    m.importFluidFromPeripheral = fluidGuard(function(filter, name) return transfer("fluid", "import", B.string(2, name), true, filter) end)

    local function jobFor(entry)
      for _, job in ipairs(net.jobs) do if job.name == entry.name then return job end end
    end

    m.getItem = guard(function(filterTable)
      local filter, err = parse(filterTable, "item")
      if not filter then return nil, err end
      if isME and B.filterIsEmpty(filter) then return nil, "EMPTY_FILTER" end
      local entry = findStack(filter, true, "item")
      if not entry then return {} end
      return itemObject(entry, "item")
    end)

    m.isItemCraftable = guard(function(filterTable)
      local filter, err = parse(filterTable, "item")
      if not filter then return false, err end
      if B.filterIsEmpty(filter) then return false, "EMPTY_FILTER" end
      local entry = findStack(filter, true, "item")
      return entry ~= nil and isCraftableEntry(entry, "item")
    end)

    m.getEnergyUsage = guard(function() return net.energy.usage or 0 end)
    m.getEnergyStorage = guard(function() return net.energy.stored or 0 end)
    m.getMaxEnergyStorage = guard(function() return net.energy.max or 0 end)

    -- ----- craft jobs -----

    local function startJob(entry, count, kind, cpuName)
      net.jobs[#net.jobs + 1] = { name = entry.name, count = count, kind = kind, cpu = cpuName, started = core.nowMs() }
      core.save()
    end

    if isME then
      m.listItems = guard(function()
        local out = {}
        for _, e in ipairs(net.items) do out[#out + 1] = itemObject(e, "item") end
        return out
      end)

      -- AppEngApi.listStacks(flag 2): for each stored key, craftable ones are listed with their
      -- stock; the first stored key that is not craftable adds every unstocked craftable instead.
      m.listCraftableItems = guard(function()
        local out = {}
        for _, e in ipairs(net.items) do
          if not isCraftableEntry(e, "item") then
            for _, c in ipairs(net.craftableItems) do
              local stocked = false
              for _, s in ipairs(net.items) do if sameKey(s, c) then stocked = true end end
              if not stocked then
                local copy = B.copy(c)
                copy.amount = 0
                local object = itemObject(copy, "item")
                local dupe = false
                for _, o in ipairs(out) do if B.deepEqual(o, object) then dupe = true end end
                if not dupe then out[#out + 1] = object end
              end
            end
          else
            out[#out + 1] = itemObject(e, "item")
          end
        end
        return out
      end)

      m.listFluid = guard(function()
        local out = {}
        for _, e in ipairs(net.fluids) do out[#out + 1] = itemObject(e, "fluid") end
        return out
      end)

      m.listCraftableFluid = guard(function()
        local out = {}
        for _, e in ipairs(net.fluids) do
          if isCraftableEntry(e, "fluid") then out[#out + 1] = itemObject(e, "fluid") end
        end
        return out
      end)

      m.getAvgPowerUsage = guard(function() return net.energy.usage or 0 end)
      m.getAvgPowerInjection = guard(function() return net.energy.injection or 0 end)

      local function cells(kind)
        local out = {}
        for _, c in ipairs(def.cells or {}) do if c.cellType == kind then out[#out + 1] = c end end
        return out
      end

      local function total(kind)
        local sum = 0
        for _, c in ipairs(cells(kind)) do sum = sum + (c.totalBytes or 0) end
        return sum
      end

      local function used(kind)
        local sum = 0
        for _, c in ipairs(cells(kind)) do
          if c.usedBytes then sum = sum + c.usedBytes else
            -- AppEngApi: ceil(items / 8) + bytesPerType * distinct types (fluids count buckets)
            local list = kind == "fluid" and net.fluids or net.items
            local count, types = 0, #list
            for _, e in ipairs(list) do count = count + e.amount end
            if kind == "fluid" then count = math.floor(count / 1000) end
            sum = sum + math.ceil(count / 8) + (c.bytesPerType or 8) * types
          end
        end
        return sum
      end

      m.getTotalItemStorage = guard(function() return total("item") end)
      m.getTotalFluidStorage = guard(function() return total("fluid") end)
      m.getUsedItemStorage = guard(function() return used("item") end)
      m.getUsedFluidStorage = guard(function() return used("fluid") end)
      m.getAvailableItemStorage = guard(function() return total("item") - used("item") end)
      m.getAvailableFluidStorage = guard(function() return total("fluid") - used("fluid") end)

      m.listCells = guard(function()
        local out = {}
        for _, c in ipairs(def.cells or {}) do
          out[#out + 1] = {
            item = c.item, cellType = c.cellType, bytesPerType = c.bytesPerType, totalBytes = c.totalBytes,
          }
        end
        return out
      end)

      m.getCraftingCPUs = guard(function()
        local out = {}
        for _, cpu in ipairs(def.cpus or {}) do
          out[#out + 1] = {
            storage = cpu.storage or 0, coProcessors = cpu.coProcessors or 0, isBusy = cpu.isBusy or false,
            craftingJob = cpu.craftingJob,
          }
        end
        return out
      end)

      local function cpuExists(name)
        for _, cpu in ipairs(def.cpus or {}) do if cpu.name == name then return true end end
        return false
      end

      local function craft(kind)
        return function(filterTable, cpuName)
          if not connected() then return notConnected() end
          local filter, err = parse(filterTable, kind)
          if not filter then return false, err end
          if B.filterIsEmpty(filter) then return false, "EMPTY_FILTER" end
          cpuName = B.optString(2, cpuName, "")
          if cpuName ~= "" and not cpuExists(cpuName) then
            return false, "CPU " .. cpuName .. " does not exists"
          end
          local entry = findStack(filter, true, kind)
          if not entry or not isCraftableEntry(entry, kind) then return nil, "NOT_CRAFTABLE" end
          startJob(entry, filter.count, kind, cpuName)
          -- CraftJob.startCrafting fires a `crafting` event once the calculation starts: on a later tick, after the
          -- call's own task_complete, so the caller (which drops everything but that while it waits) still gets it
          core.after(0.05, function()
            os.queueEvent("crafting", true,
              "Started calculation of the recipe. After it's finished, the system will start crafting the item.")
          end)
          return true
        end
      end
      m.craftItem = craft("item")
      m.craftFluid = craft("fluid")

      m.isItemCrafting = guard(function(filterTable, cpuName)
        local filter, err = parse(filterTable, "item")
        if not filter then return false, err end
        if B.filterIsEmpty(filter) then return false, "EMPTY_FILTER" end
        cpuName = B.optString(2, cpuName, "")
        local entry = findStack(filter, true, "item")
        if not entry then return false end
        for _, job in ipairs(net.jobs) do
          if job.name == entry.name and (cpuName == "" or job.cpu == cpuName) then return true end
        end
        return false
      end)
    else
      m.listItems = guard(function()
        local out = {}
        for _, e in ipairs(net.items) do out[#out + 1] = itemObject(e, "item") end
        return out
      end)

      m.listFluids = guard(function()
        local out = {}
        for _, e in ipairs(net.fluids) do out[#out + 1] = itemObject(e, "fluid") end
        return out
      end)

      m.listCraftableItems = guard(function()
        local out = {}
        for _, c in ipairs(net.craftableItems) do
          local copy = B.copy(c)
          copy.amount = copy.amount ~= 0 and copy.amount or 1
          out[#out + 1] = itemObject(copy, "item")
        end
        return out
      end)

      m.listCraftableFluids = guard(function()
        local out = {}
        for _, c in ipairs(net.craftableFluids) do
          local copy = B.copy(c)
          copy.amount = copy.amount ~= 0 and copy.amount or 1000
          out[#out + 1] = itemObject(copy, "fluid")
        end
        return out
      end)

      local function storage(key)
        return guard(function() return (def.storage or {})[key] or 0 end)
      end
      m.getMaxItemDiskStorage = storage("maxItemDisk")
      m.getMaxFluidDiskStorage = storage("maxFluidDisk")
      m.getMaxItemExternalStorage = storage("maxItemExternal")
      m.getMaxFluidExternalStorage = storage("maxFluidExternal")

      m.getPattern = guard(function(filterTable)
        local filter, err = parse(filterTable, "item")
        if not filter then return false, err end
        if B.filterIsEmpty(filter) then return false, "EMPTY_FILTER" end
        for _, pattern in ipairs(def.patterns or {}) do
          for _, output in ipairs(pattern.outputs or {}) do
            if B.filterTest(filter, output) then
              local function stacks(list)
                local out = {}
                for _, s in ipairs(list or {}) do
                  local copy = B.copy(s)
                  copy.amount = copy.amount or copy.count or 1
                  out[#out + 1] = itemObject(copy, "item")
                end
                return out
              end
              local inputs = {}
              for _, group in ipairs(pattern.inputs or {}) do inputs[#inputs + 1] = stacks(group) end
              return {
                outputs = stacks(pattern.outputs), inputs = inputs,
                byproducts = pattern.processing and {} or stacks(pattern.byproducts),
                processing = pattern.processing or false,
              }
            end
          end
        end
        return nil
      end)

      local function craft(kind)
        return guard(function(filterTable)
          local filter, err = parse(filterTable, kind)
          if not filter then return nil, err end
          local entry = findStack(filter, true, kind)
          if not entry or not isCraftableEntry(entry, kind) then return nil, "NOT_CRAFTABLE" end
          local result = def.craftResult or "OK"
          if result == "OK" then startJob(entry, filter.count, kind) end
          return result == "OK"
        end)
      end
      m.craftItem = craft("item")
      m.craftFluid = craft("fluid")

      m.isItemCrafting = guard(function(filterTable)
        local filter, err = parse(filterTable, "item")
        if not filter then return nil, err end
        local entry = findStack(filter, false, "item")
        if not entry then return nil, "NOT_CRAFTABLE" end
        return jobFor(entry) ~= nil
      end)
    end

    self.setters = {
      completeCraft = function(name)
        for i, job in ipairs(net.jobs) do
          if job.name == name or name == nil then
            table.remove(net.jobs, i)
            local list = job.kind == "fluid" and net.fluids or net.items
            addTo(list, { name = job.name }, job.count)
            return true
          end
        end
        return false
      end,
      setConnected = function(value) net.connected = value end,
    }
    function self.state() return { connected = net.connected, items = net.items, fluids = net.fluids, jobs = net.jobs } end
    return self
  end

  function F.meBridge(def) return build(def, "me") end
  function F.rsBridge(def) return build(def, "rs") end
  return F
end
