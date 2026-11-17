-- Runs inside the emulator (scripts/probe-emulator.mjs): lists every global, every cc.* module and every method of
-- every attached peripheral, calls each method to learn its arguments and what it returns, and prints one JSON line
-- per finding into /probe-out.jsonl.
local out = fs.open("/probe-out.jsonl", "w")
local function emit(t)
  out.write(textutils.serialiseJSON(t) .. "\n")
  out.flush()
end

local function shape(v, depth)
  local t = type(v)
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "number" end
    return v % 1 == 0 and "integer" or "number"
  end
  if t ~= "table" then return t end
  if depth <= 0 then return "table" end
  local count, strings, ints = 0, 0, 0
  for k in pairs(v) do
    count = count + 1
    if type(k) == "string" then strings = strings + 1 elseif type(k) == "number" then ints = ints + 1 end
  end
  if count == 0 then return { empty = true } end
  if ints == count then
    local items, n = {}, 0
    for _, item in pairs(v) do
      n = n + 1
      if n > 6 then break end
      items[n] = shape(item, depth - 1)
    end
    return { array = items, sparse = #v ~= count or nil }
  end
  if strings == count then
    local fields = {}
    for k, item in pairs(v) do fields[k] = shape(item, depth - 1) end
    return { fields = fields }
  end
  return "table"
end

-- ===== globals =====
local function listTable(t, depth)
  local fields = {}
  for k, v in pairs(t) do
    if type(k) == "string" then
      if type(v) == "table" and depth > 0 and v ~= t and v ~= _G then
        fields[k] = listTable(v, depth - 1)
      else
        fields[k] = type(v)
      end
    end
  end
  return fields
end

local globals = {}
for k, v in pairs(_G) do
  if type(k) == "string" and k ~= "_G" and k ~= "_ENV" then
    globals[k] = type(v) == "table" and listTable(v, 1) or type(v)
  end
end
-- what a program's own environment adds
for _, k in ipairs({ "shell", "multishell", "require", "package" }) do
  local v = _ENV[k]
  if v ~= nil then globals[k] = type(v) == "table" and listTable(v, k == "package" and 0 or 1) or type(v) end
end
emit({ kind = "globals", host = _HOST, version = _VERSION, globals = globals })

for _, name in ipairs({ "cc.expect", "cc.completion", "cc.pretty", "cc.strings", "cc.audio.dfpwm", "cc.image.nft",
  "cc.shell.completion", "cc.require", "cc.base64" }) do
  local ok, mod = pcall(require, name)
  if ok and type(mod) == "table" then emit({ kind = "module", name = name, fields = listTable(mod, 0) }) end
end

-- ===== peripherals =====
local DUMMY = {
  number = 1, integer = 1, int = 1, long = 1, double = 1, string = "x", boolean = true, table = {},
  ["function"] = function() end,
}
-- what to try for a Mekanism parameter type: enums take their ordinal, the rest say so when the guess is wrong
local MEK_DUMMY = { int = { 0 }, long = { 0 }, double = { 0 }, String = { "x" }, boolean = { true } }
local MEK_GUESSES = { 0, "minecraft:stone", true, {} }
-- what a string or table argument is tried with after the plain dummy
local STRINGS = { "top", "north", "up", "minecraft:stone" }
local TABLES = { { x = 0, y = 0, z = 0 }, { name = "minecraft:stone", count = 1 } }
-- calls that would stop the probe itself
local SKIP = { tm_wdt = { setEnabled = true }, computer = { shutdown = true, reboot = true } }

local function call(name, method, args, n)
  local res
  parallel.waitForAny(function()
    res = table.pack(pcall(peripheral.call, name, method, table.unpack(args, 1, n)))
  end, function()
    sleep(30)
  end)
  return res
end

local function wanted(err)
  -- CC and most mods: "bad argument #2 (number expected, got nil)"; some: "Bad argument #1: (expected Number)"
  local index, ty = err:match("[Bb]ad argument #(%d+):? %(([%a|]+) expected")
  if not index then index, ty = err:match("[Bb]ad argument #(%d+):? %(expected ([%a|]+)") end
  if not index then return nil end
  return tonumber(index), ty:lower()
end

--- "Too few arguments (expected x,y,[color])", "..., excepted (number x, String text, [number size])": the names.
local function hinted(err)
  local inside = err:match("excepted %((.*)%)%s*$") or err:match("%(expected (.*)%)%s*$")
  if not inside or inside:find("^%a+$") and DUMMY[inside:lower()] ~= nil then return nil end
  local list = {}
  for part in (inside .. ","):gmatch("%s*(.-)%s*,") do
    if part ~= "" then
      local opt = part:find("^%[") ~= nil
      part = part:gsub("[%[%]]", "")
      local vararg = part:find("%.%.%.") ~= nil
      part = part:gsub("%.%.%.", "")
      local words = {}
      for w in part:gmatch("[%w_]+") do words[#words + 1] = w end
      if #words == 0 then return nil end
      local p = { name = words[#words], type = #words > 1 and words[1]:lower() or "any", opt = opt or nil, vararg = vararg or nil }
      list[#list + 1] = p
    end
  end
  return #list > 0 and list or nil
end

local function guess(p)
  if DUMMY[p.type] ~= nil then return DUMMY[p.type] end
  local n = p.name:lower()
  if n:find("text") or n:find("name") or n:find("font") then return "x" end
  if n:find("enable") then return true end
  return 1
end

local function probeMethod(name, ty, method)
  local args, n, params, tries = {}, 0, {}, {}
  local res
  if SKIP[ty] and SKIP[ty][method] then return { params = params, skipped = true } end
  for _ = 1, 24 do
    res = call(name, method, args, n)
    if not res then return { timeout = true, params = params } end
    if res[1] then break end
    local err = tostring(res[2])
    local progressed = false

    local count = tonumber(err:match("Mismatched parameter count%. .- expected: '(%d+)' arguments"))
    if count and count ~= n then
      n = count
      for i = 1, n do params[i] = params[i] or { type = "any" } end
      progressed = true
    end
    local index, javaType = err:match("Invalid argument (%d+), .- expected (%S+) but received")
    if index then
      index = tonumber(index) + 1
      params[index] = { type = javaType, java = true }
      tries[index] = (tries[index] or 0) + 1
      local candidates = MEK_DUMMY[javaType] or MEK_GUESSES
      local candidate = candidates[tries[index]]
      if candidate ~= nil then
        args[index] = candidate
        progressed = true
      end
    end
    local need = tonumber(err:match("Insufficient number of arguments, expected (%d+)"))
    if need and n < need then
      for i = n + 1, need do
        params[i] = { type = "any" }
        args[i] = 0
      end
      n = need
      progressed = true
    end
    local at, expected = wanted(err)
    if at and (at > n or params[at].type == "any") and at <= 12 then
      for i = n + 1, at - 1 do
        params[i] = { type = "any" }
        args[i] = {}
      end
      params[at] = { type = expected }
      local dummy = DUMMY[expected:match("^[^|]+")]
      if dummy ~= nil then
        args[at] = dummy
        n = math.max(n, at)
        progressed = true
      end
    end
    if not progressed and n == 0 then
      local list = hinted(err)
      if list then
        params = list
        for i, p in ipairs(list) do
          if not p.opt and not p.vararg then
            args[i] = guess(p)
            n = i
          end
        end
        progressed = n > 0
      end
    end
    if not progressed then break end
  end
  local result = { params = params, calls = {} }
  local function keep(r)
    local returns = {}
    for i = 2, r.n do returns[i - 1] = shape(r[i], 3) end
    result.calls[#result.calls + 1] = { returns = returns, count = r.n - 1 }
  end
  if res[1] then keep(res) else result.error = tostring(res[2]) end

  -- "x" and {} got past the type check, but a method says more when the string is a side, a player or an item
  -- and the table a position or an item filter: try those too and keep every answer
  local strings, tables, java = {}, {}, false
  for i = 1, n do
    if params[i] and params[i].java then java = true end
    if type(args[i]) == "string" then strings[#strings + 1] = i end
    if type(args[i]) == "table" then tables[#tables + 1] = i end
  end
  if not java and (#strings > 0 or #tables > 0) then
    local stringChoices = #strings > 0 and STRINGS or { false }
    local tableChoices = #tables > 0 and TABLES or { false }
    for _, s in ipairs(stringChoices) do
      for _, t in ipairs(tableChoices) do
        local try = {}
        for i = 1, n do try[i] = args[i] end
        for _, i in ipairs(strings) do try[i] = s end
        for _, i in ipairs(tables) do try[i] = t end
        local r = call(name, method, try, n)
        if r and r[1] then keep(r) end
      end
    end
  end
  return result
end

-- a player who is online, when the world has a player detector to ask
do
  local detector = peripheral.find("playerDetector")
  local ok, players = pcall(function() return detector.getOnlinePlayers() end)
  if ok and type(players) == "table" and type(players[1]) == "string" then table.insert(STRINGS, 1, players[1]) end
  -- and another block on the network, for the methods that move things to one
  for _, other in ipairs(peripheral.getNames()) do
    if peripheral.hasType(other, "inventory") then
      STRINGS[#STRINGS + 1] = other
      break
    end
  end
end

local function isGetter(m)
  return m:find("^get") or m:find("^is") or m:find("^has") or m:find("^can") or m:find("^list") or m == "size" or m == "tanks"
end

for _, name in ipairs(peripheral.getNames()) do
  local types = { peripheral.getType(name) }
  local methods = peripheral.getMethods(name) or {}
  local found = {}
  for pass = 1, 2 do
    for _, method in ipairs(methods) do
      if (pass == 1) == (isGetter(method) and true or false) then
        found[method] = probeMethod(name, types[1], method)
      end
    end
  end
  emit({ kind = "peripheral", name = name, types = types, order = methods, methods = found })
end
out.close()
print("probe done")
