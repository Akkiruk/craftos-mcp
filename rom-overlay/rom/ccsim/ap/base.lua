-- ccsim ap/base: shared plumbing for the Advanced Peripherals emulation.
--
-- Written from AdvancedPeripherals 0.7.30r source (BasePeripheral, OperationAbility,
-- FuelAbility, LuaConverter) and checked against the 0.7.31r jar. Server config defaults are the ones
-- 0.7.31r ships (PeripheralsConfig, SimpleFreeOperation, SphereOperation); world.ap.config overrides them.
return function(core)
  local B = {}

  B.config = {
    playerDetMaxRange = 100000000,
    enablePlayerPosFunction = true,
    morePlayerInformation = true,
    defaultChatBoxPrefix = "AP",
    chatMessageCooldown = 100,
    energyDetectorMaxFlow = 2147483647,
    nbtStorageMaxSize = 1048576,
    energyToFuelRate = 575,
    poweredPeripheralMaxEnergyStored = 100000000,
    enablePoweredPeripherals = false,
    scanEntities = { cooldown = 2000, maxFreeRadius = 8, maxCostRadius = 16, extraBlockCost = 0.17 },
  }
  for key, value in pairs((core.world.ap or {}).config or {}) do B.config[key] = value end

  -- ===== argument helpers (CC's IArguments semantics) =====

  local function typeName(v)
    if v == nil then return "nil" end
    return type(v)
  end

  local function bad(index, expected, v)
    error(("bad argument #%d (%s expected, got %s)"):format(index, expected, typeName(v)), 0)
  end

  function B.string(index, v)
    if type(v) == "string" then return v end
    if type(v) == "number" then return tostring(v) end
    bad(index, "string", v)
  end

  function B.int(index, v)
    if type(v) ~= "number" then bad(index, "number", v) end
    if v ~= math.floor(v) then
      error(("bad argument #%d (number has no integer representation)"):format(index), 0)
    end
    return v
  end

  function B.number(index, v)
    if type(v) ~= "number" then bad(index, "number", v) end
    return v
  end

  function B.boolean(index, v)
    if type(v) ~= "boolean" then bad(index, "boolean", v) end
    return v
  end

  function B.table(index, v)
    if type(v) ~= "table" then bad(index, "table", v) end
    return v
  end

  function B.optString(index, v, default)
    if v == nil then return default end
    return B.string(index, v)
  end

  function B.optInt(index, v, default)
    if v == nil then return default end
    return B.int(index, v)
  end

  -- ===== small utilities =====

  function B.titleCase(name)
    local path = name:match(":(.+)$") or name
    return (path:gsub("_", " "):gsub("(%a)([%w]*)", function(a, b) return a:upper() .. b end))
  end

  function B.deepEqual(a, b)
    if a == b then return true end
    if type(a) ~= "table" or type(b) ~= "table" then return false end
    for k, v in pairs(a) do if not B.deepEqual(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
  end

  function B.copy(value)
    if type(value) ~= "table" then return value end
    local out = {}
    for k, v in pairs(value) do out[k] = B.copy(v) end
    return out
  end

  --- Minecraft's relative-side resolution for a block peripheral (default orientation:
  --- front = north, top = up).
  function B.direction(side, orientation)
    local s = tostring(side):lower()
    local absolute = { down = "down", up = "up", north = "north", south = "south", west = "west", east = "east" }
    if absolute[s] then return absolute[s] end
    local front = (orientation and orientation.front) or "north"
    local clockwise = { north = "east", east = "south", south = "west", west = "north" }
    local counter = { north = "west", west = "south", south = "east", east = "north" }
    local opposite = { north = "south", south = "north", east = "west", west = "east", up = "down", down = "up" }
    if s == "front" then return front end
    if s == "back" then return opposite[front] end
    if s == "top" then return "up" end
    if s == "bottom" then return "down" end
    if s == "right" then return counter[front] end
    if s == "left" then return clockwise[front] end
    error(s:upper() .. " is not a valid side", 0)
  end

  -- ===== peripheral objects =====

  --- Create the shared part of a peripheral: getName, getConfiguration and operations.
  function B.new(def)
    local self = {
      def = def,
      methods = {},
      operations = {},
      cooldownUntil = {},
      extraConfig = {},
    }
    local m = self.methods

    function m.getName() return def.customName or "" end

    function m.getConfiguration()
      local out = {}
      for name, op in pairs(self.operations) do out[name] = op.description end
      for k, v in pairs(self.extraConfig) do out[k] = v end
      return out
    end

    return self
  end

  --- Register an operation (cooldown-gated action) and the getOperationCooldown method.
  function B.addOperation(self, name, description)
    self.operations[name] = { description = description }
    if not self.methods.getOperationCooldown then
      function self.methods.getOperationCooldown(opName)
        opName = B.string(1, opName)
        if not self.operations[opName] then return nil, "Cannot find this operation" end
        return math.max(0, math.floor((self.cooldownUntil[opName] or 0) - core.nowMs()))
      end
    end
  end

  --- OperationAbility.performOperation. `check` returns nil,msg to refuse before running.
  function B.perform(self, name, cooldownMs, check, fn)
    local now = core.nowMs()
    if (self.cooldownUntil[name] or 0) > now then
      return nil, name .. " is on cooldown"
    end
    if check then
      local a, b = check()
      if a == nil and b ~= nil then return nil, b end
    end
    local r1, r2, r3 = fn()
    if cooldownMs > 0 then self.cooldownUntil[name] = core.nowMs() + cooldownMs end
    return r1, r2, r3
  end

  --- FuelAbility methods for block peripherals (powered peripherals are disabled in the
  --- pack's config, so consumption is off and the fuel level is the empty internal buffer).
  function B.addFuel(self)
    local rate = 1
    self.extraConfig.maxFuelConsumptionRate = 1
    function self.methods.getFuelLevel() return 0 end
    function self.methods.getMaxFuelLevel() return 0 end
    function self.methods.getFuelConsumptionRate() return rate end
    function self.methods.setFuelConsumptionRate(newRate)
      newRate = B.int(1, newRate)
      if newRate < 1 then return nil, "Too small fuel consumption rate" end
      if newRate > 1 then return nil, "Too big fuel consumption rate" end
      rate = newRate
      return true
    end
  end

  -- ===== item / fluid stacks and filters (ItemFilter, FluidFilter, LuaConverter) =====

  --- 32-bit MD5 (needs bit32), for ItemUtil.getFingerprint on stacks without NBT.
  local function md5(message)
    local band, bor, bxor, bnot = bit32.band, bit32.bor, bit32.bxor, bit32.bnot
    local lrot = bit32.lrotate
    local K, S = {}, {
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    }
    for i = 0, 63 do K[i] = math.floor(math.abs(math.sin(i + 1)) * 4294967296) % 4294967296 end
    local a0, b0, c0, d0 = 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476
    local length = #message
    message = message .. "\128" .. string.rep("\0", (55 - length) % 64)
    local bits = length * 8
    message = message .. string.char(bits % 256, math.floor(bits / 256) % 256, math.floor(bits / 65536) % 256,
      math.floor(bits / 16777216) % 256, 0, 0, 0, 0)
    for chunk = 1, #message, 64 do
      local M = {}
      for i = 0, 15 do
        local b1, b2, b3, b4 = message:byte(chunk + i * 4, chunk + i * 4 + 3)
        M[i] = b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
      end
      local A, Bv, C, D = a0, b0, c0, d0
      for i = 0, 63 do
        local F, g
        if i < 16 then F = bor(band(Bv, C), band(bnot(Bv), D)) g = i
        elseif i < 32 then F = bor(band(D, Bv), band(bnot(D), C)) g = (5 * i + 1) % 16
        elseif i < 48 then F = bxor(Bv, bxor(C, D)) g = (3 * i + 5) % 16
        else F = bxor(C, bor(Bv, bnot(D))) g = (7 * i) % 16 end
        F = (F + A + K[i] + M[g]) % 4294967296
        A, D, C = D, C, Bv
        Bv = (Bv + lrot(F, S[i + 1])) % 4294967296
      end
      a0, b0, c0, d0 = (a0 + A) % 4294967296, (b0 + Bv) % 4294967296, (c0 + C) % 4294967296, (d0 + D) % 4294967296
    end
    local function le(n) return ("%02x%02x%02x%02x"):format(n % 256, math.floor(n / 256) % 256, math.floor(n / 65536) % 256, math.floor(n / 16777216) % 256) end
    return le(a0) .. le(b0) .. le(c0) .. le(d0)
  end
  B.md5 = md5

  function B.displayName(entry)
    return entry.displayName or B.titleCase(entry.name)
  end

  --- ItemUtil.getFingerprint: md5(stack NBT string + registry name + display name). The
  --- NBT string of a tag-less stack is "{}". With NBT the exact Minecraft formatting is not
  --- reproduced; fixtures can set `fingerprint` explicitly.
  function B.fingerprint(entry)
    if entry.fingerprint then return entry.fingerprint end
    local nbt = entry.nbtString or (entry.nbt == nil and "{}" or textutils.serialize(entry.nbt, { compact = true }))
    return md5(nbt .. entry.name .. B.displayName(entry))
  end

  --- Result table of LuaConverter.stackToObject for inventory stacks.
  function B.stackObject(entry, tags)
    return {
      name = entry.name,
      count = entry.count,
      displayName = B.displayName(entry),
      maxStackSize = entry.maxCount or 64,
      nbt = entry.nbt or {},
      tags = entry.tags or tags or {},
    }
  end

  --- Parse an ItemFilter/FluidFilter table. Returns filter or nil, errorCode.
  function B.parseFilter(tbl, kind)
    local f = { count = kind == "fluid" and 1000 or 64, fromSlot = -1, toSlot = -1, kind = kind }
    local size = 0
    for _ in pairs(tbl) do size = size + 1 end
    if size == 0 then return f end
    local prefix = kind == "fluid" and "FLUID" or "ITEM"
    if tbl.name ~= nil then
      if type(tbl.name) ~= "string" then return nil, "NO_VALID_" .. prefix end
      if tbl.name:sub(1, 1) == "#" then f.tag = tbl.name:sub(2) else
        if not tbl.name:match("^[%l%d_.%-]*:?[%l%d_./%-]+$") then return nil, prefix .. "_NOT_FOUND" end
        f.name = tbl.name:find(":", 1, true) and tbl.name or ("minecraft:" .. tbl.name)
      end
    end
    if tbl.nbt ~= nil then
      if type(tbl.nbt) == "string" then
        local parsed = B.snbt(tbl.nbt)
        if parsed == nil then return nil, "NO_VALID_NBT" end
        f.nbt = parsed
      elseif type(tbl.nbt) == "table" and kind ~= "fluid" then
        f.nbt = tbl.nbt
      else
        return nil, "NO_VALID_NBT"
      end
    end
    if tbl.fingerprint ~= nil then
      if type(tbl.fingerprint) ~= "string" then return nil, "NO_VALID_FINGERPRINT" end
      f.fingerprint = tbl.fingerprint
    end
    if kind ~= "fluid" then
      if tbl.fromSlot ~= nil then
        if type(tbl.fromSlot) ~= "number" then return nil, "NO_VALID_FROMSLOT" end
        f.fromSlot = math.floor(tbl.fromSlot)
      end
      if tbl.toSlot ~= nil then
        if type(tbl.toSlot) ~= "number" then return nil, "NO_VALID_TOSLOT" end
        f.toSlot = math.floor(tbl.toSlot)
      end
    end
    if tbl.count ~= nil then
      if type(tbl.count) ~= "number" then return nil, "NO_VALID_COUNT" end
      f.count = math.floor(tbl.count)
    end
    return f
  end

  function B.filterIsEmpty(f)
    return (f.fingerprint == nil or f.fingerprint == "") and f.name == nil and f.tag == nil and f.nbt == nil
  end

  --- ItemFilter.test / FluidFilter.test against {name, nbt, tags, ...}.
  function B.filterTest(f, entry)
    if f.fingerprint and f.fingerprint ~= "" then return B.fingerprint(entry) == f.fingerprint end
    if f.name and f.tag == nil and f.nbt == nil then return entry.name == f.name end
    if f.tag then
      local wanted = (f.kind == "fluid" and "minecraft:fluid/" or "minecraft:item/") .. f.tag
      local found = false
      for _, t in ipairs(entry.tags or {}) do if t == wanted or t == f.tag then found = true end end
      if not found then return false end
      if f.name and entry.name ~= f.name then return false end
    end
    if f.nbt and not B.deepEqual(entry.nbt or {}, f.nbt) then return false end
    return f.name ~= nil or f.tag ~= nil or f.nbt ~= nil
  end

  -- ===== SNBT (stringified NBT) parsing for filters and nbtStorage =====

  function B.snbt(text)
    local pos = 1
    local function skip() pos = text:find("%S", pos) or #text + 1 end
    local parseValue
    local function fail(message) error({ snbt = message .. " at position " .. pos }, 0) end

    local function parseString()
      local quote = text:sub(pos, pos)
      pos = pos + 1
      local out = {}
      while pos <= #text do
        local c = text:sub(pos, pos)
        if c == "\\" then out[#out + 1] = text:sub(pos + 1, pos + 1) pos = pos + 2
        elseif c == quote then pos = pos + 1 return table.concat(out)
        else out[#out + 1] = c pos = pos + 1 end
      end
      fail("Unclosed quoted string")
    end

    local function parseWord()
      local word = text:match("^[%w_%.%+%-]+", pos)
      if not word then fail("Expected value") end
      pos = pos + #word
      return word
    end

    local function convertWord(word)
      if word == "true" then return 1 end
      if word == "false" then return 0 end
      local numeric = word:match("^([%+%-]?%d+%.?%d*[eE]?[%+%-]?%d*)[bBsSlLfFdD]?$")
      if numeric and tonumber(numeric) then return tonumber(numeric) end
      return word
    end

    function parseValue()
      skip()
      local c = text:sub(pos, pos)
      if c == "{" then
        pos = pos + 1
        local out = {}
        skip()
        if text:sub(pos, pos) == "}" then pos = pos + 1 return out end
        while true do
          skip()
          local key
          local k = text:sub(pos, pos)
          if k == '"' or k == "'" then key = parseString() else key = parseWord() end
          skip()
          if text:sub(pos, pos) ~= ":" then fail("Expected ':'") end
          pos = pos + 1
          out[key] = parseValue()
          skip()
          local nextChar = text:sub(pos, pos)
          pos = pos + 1
          if nextChar == "}" then return out end
          if nextChar ~= "," then fail("Expected ',' or '}'") end
        end
      elseif c == "[" then
        pos = pos + 1
        skip()
        if text:match("^[BIL];", pos) then pos = pos + 2 end
        local out = {}
        skip()
        if text:sub(pos, pos) == "]" then pos = pos + 1 return out end
        while true do
          out[#out + 1] = parseValue()
          skip()
          local nextChar = text:sub(pos, pos)
          pos = pos + 1
          if nextChar == "]" then return out end
          if nextChar ~= "," then fail("Expected ',' or ']'") end
        end
      elseif c == '"' or c == "'" then
        return parseString()
      elseif c == "" then
        fail("Expected value")
      end
      return convertWord(parseWord())
    end

    local ok, result = pcall(function()
      local value = parseValue()
      skip()
      if pos <= #text then fail("Trailing data") end
      return value
    end)
    if ok then return result end
    if type(result) == "table" and result.snbt then return nil, result.snbt end
    error(result, 0)
  end

  return B
end
