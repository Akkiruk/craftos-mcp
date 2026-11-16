-- ccsim mek/java: the Java side of a Mekanism computer call, for the Mekanism emulation.
--
-- Written from Mekanism 10.2.5 (1.18.x branch) source and checked against the 10.2.5.465 jar:
--   BoundComputerMethod.validateArguments / run      argument count, null, type checks and their messages
--   CCArgumentWrapper.sanitizeArgument / wrapReturnType / sanitizeNBT / convertMapToFilter
--   CobaltLuaMachine.toObject (CC:Tweaked 1.101.3)    how a Lua value reaches Java: numbers are Double, tables HashMap
-- Messages that quote a Java value (`with value %s`) print it the way Java does: Double.toString, HashMap.toString.
return function()
  local J = {}

  local floor, huge = math.floor, math.huge
  local band, bxor, rshift = bit32.band, bit32.bxor, bit32.rshift

  -- ===== Java values =====

  --- Double.toString (shortest digits that read back, Java's plain/scientific switch at 1e-3 and 1e7).
  function J.double(d)
    if d ~= d then return "NaN" end
    if d == huge then return "Infinity" end
    if d == -huge then return "-Infinity" end
    if d == 0 then return (1 / d < 0) and "-0.0" or "0.0" end
    local s
    for p = 1, 17 do
      s = string.format("%." .. (p - 1) .. "e", d)
      if tonumber(s) == d then break end
    end
    local sign, int, frac, exp = s:match("^(-?)(%d)%.?(%d*)e([-+]%d+)$")
    local digits = (int .. frac):gsub("0+$", "")
    if digits == "" then digits = "0" end
    exp = tonumber(exp)
    local a = math.abs(d)
    if a >= 1e-3 and a < 1e7 then
      if exp >= 0 then
        local ip = digits:sub(1, exp + 1)
        if #ip < exp + 1 then ip = ip .. string.rep("0", exp + 1 - #ip) end
        local fp = digits:sub(exp + 2)
        if fp == "" then fp = "0" end
        return sign .. ip .. "." .. fp
      end
      return sign .. "0." .. string.rep("0", -exp - 1) .. digits
    end
    local fp = digits:sub(2)
    if fp == "" then fp = "0" end
    return sign .. digits:sub(1, 1) .. "." .. fp .. "E" .. exp
  end

  --- A Lua table as CobaltLuaMachine.toObject hands it to Java: a HashMap whose keys and values are converted the
  --- same way. nil and function values (and keys) are dropped. The same table twice is the same map.
  local JMAP = {}
  function J.toJava(value, seen)
    local t = type(value)
    if t == "number" or t == "string" or t == "boolean" then return value end
    if t ~= "table" then return nil end
    seen = seen or {}
    if seen[value] then return seen[value] end
    local map = setmetatable({ entries = {} }, JMAP)
    seen[value] = map
    local done = {}
    local function add(k, v)
      local jk, jv = J.toJava(k, seen), J.toJava(v, seen)
      if jk ~= nil and jv ~= nil then map.entries[#map.entries + 1] = { k = jk, v = jv } end
    end
    -- Cobalt's next() walks the array part first, then the hash part
    for i = 1, #value do
      if value[i] ~= nil then add(i, value[i]) done[i] = true end
    end
    for k, v in pairs(value) do
      if not done[k] then add(k, v) end
    end
    return map
  end

  function J.isMap(v) return getmetatable(v) == JMAP end

  function J.get(map, key)
    for _, e in ipairs(map.entries) do
      if e.k == key then return e.v end
    end
    return nil
  end

  function J.size(map) return #map.entries end

  local function u32(n) return n % 4294967296 end

  local function stringHash(s)
    local h = 0
    for i = 1, #s do h = (h * 31 + s:byte(i)) % 4294967296 end
    return h
  end

  local function doubleBits(d)
    if d ~= d then return 0x7ff80000, 0 end
    if string.pack then
      local hi, lo = string.unpack(">I4I4", string.pack(">d", d))
      return hi, lo
    end
    -- frexp fallback
    local sign = (d < 0 or (d == 0 and 1 / d < 0)) and 0x80000000 or 0
    d = math.abs(d)
    if d == huge then return sign + 0x7ff00000, 0 end
    if d == 0 then return sign, 0 end
    local m, e = math.frexp(d)
    local exponent = e + 1022
    local mantissa
    if exponent <= 0 then
      mantissa = d / 2 ^ -1074
      exponent = 0
    else
      mantissa = (m * 2 - 1) * 2 ^ 52
    end
    local hiM = floor(mantissa / 4294967296)
    local lo = mantissa - hiM * 4294967296
    return sign + exponent * 1048576 + hiM, lo
  end

  local hashOf
  function hashOf(v, depth)
    local t = type(v)
    if t == "string" then return stringHash(v) end
    if t == "boolean" then return v and 1231 or 1237 end
    if t == "number" then
      local hi, lo = doubleBits(v)
      return bxor(hi, lo)
    end
    if J.isMap(v) then
      if (depth or 0) > 8 then return 0 end
      local h = 0
      for _, e in ipairs(v.entries) do
        h = u32(h + bxor(hashOf(e.k, (depth or 0) + 1), hashOf(e.v, (depth or 0) + 1)))
      end
      return h
    end
    return 0
  end

  --- Entries in HashMap iteration order: bucket (spread hash & (capacity - 1)), then insertion order.
  local function iterationOrder(map)
    local n = #map.entries
    local cap = 16
    while n > cap * 0.75 do cap = cap * 2 end
    local list = {}
    for i, e in ipairs(map.entries) do
      local h = hashOf(e.k)
      list[i] = { e = e, i = i, b = band(bxor(h, rshift(h, 16)), cap - 1) }
    end
    table.sort(list, function(a, b) if a.b ~= b.b then return a.b < b.b end return a.i < b.i end)
    local out = {}
    for i, x in ipairs(list) do out[i] = x.e end
    return out
  end

  --- String.valueOf for a converted value (HashMap.toString for tables).
  function J.str(v, inside)
    local t = type(v)
    if t == "number" then return J.double(v) end
    if t == "string" then return v end
    if t == "boolean" then return tostring(v) end
    if J.isMap(v) then
      local parts = {}
      for i, e in ipairs(iterationOrder(v)) do
        local k = e.k == v and "(this Map)" or J.str(e.k, true)
        local val = e.v == v and "(this Map)" or J.str(e.v, true)
        parts[i] = k .. "=" .. val
      end
      return "{" .. table.concat(parts, ", ") .. "}"
    end
    return "null"
  end

  --- getClass().getSimpleName() of a converted value.
  function J.className(v)
    local t = type(v)
    if t == "number" then return "Double" end
    if t == "string" then return "String" end
    if t == "boolean" then return "Boolean" end
    return "HashMap"
  end

  -- ===== String.format with no arguments (BoundComputerMethod.run formats a ComputerException message again) =====

  local VALID_CONVERSIONS = "bBhHsScCdoxXeEfgGaA"

  --- Returns the formatted text, or nil and the Java exception's toString.
  function J.reformat(msg)
    local out, i, n = {}, 1, #msg
    while i <= n do
      local p = msg:find("%", i, true)
      if not p then
        out[#out + 1] = msg:sub(i)
        break
      end
      out[#out + 1] = msg:sub(i, p - 1)
      local j = p + 1
      local s = j
      local argIndex = msg:match("^%d+%$", j)
      if argIndex then j = j + #argIndex end
      local flags = msg:match("^[%-#+ 0,(<]*", j)
      j = j + #flags
      local width = msg:match("^%d+", j)
      if width then j = j + #width end
      local precision = msg:match("^%.%d+", j)
      if precision then j = j + #precision end
      local c = msg:sub(j, j)
      local spec
      if c == "t" or c == "T" then
        local c2 = msg:sub(j + 1, j + 1)
        if c2:match("^[a-zA-Z%%]$") then spec = msg:sub(p, j + 1) end
      elseif c:match("^[a-zA-Z%%]$") then
        spec = msg:sub(p, j)
      end
      if not spec then
        local bad = msg:sub(s, s)
        if bad == "" then bad = "%" end
        return nil, "java.util.UnknownFormatConversionException: Conversion = '" .. bad .. "'"
      end
      local conv = spec:sub(-1)
      if c == "t" or c == "T" or VALID_CONVERSIONS:find(conv, 1, true) then
        return nil, "java.util.MissingFormatArgumentException: Format specifier '" .. spec .. "'"
      elseif conv == "%" then
        out[#out + 1] = "%"
      elseif conv == "n" then
        out[#out + 1] = "\n"
      else
        return nil, "java.util.UnknownFormatConversionException: Conversion = '" .. conv .. "'"
      end
      i = p + #spec
    end
    return table.concat(out)
  end

  --- The error a main-thread method raises: ComputerException message, formatted a second time, or the
  --- "Java Exception Thrown" text LuaContext.issueMainThreadTask produces when that formatting throws.
  function J.computerError(msg)
    local text, exception = J.reformat(msg)
    if text then error(text, 0) end
    error("Java Exception Thrown: " .. exception, 0)
  end

  -- ===== ResourceLocation =====

  --- ResourceLocation.tryParse: "minecraft" when there is no namespace; nil when a character is not allowed.
  function J.resourceLocation(s)
    local namespace, path = "minecraft", s
    local colon = s:find(":", 1, true)
    if colon then
      path = s:sub(colon + 1)
      if colon > 1 then namespace = s:sub(1, colon - 1) end
    end
    if not namespace:match("^[a-z0-9_.%-]*$") then return nil end
    if not path:match("^[a-z0-9/._%-]*$") then return nil end
    return namespace .. ":" .. path
  end

  -- ===== typed NBT =====
  -- A tag is { t = kind, v = value }: kinds byte, short, int, long, float, double, string, list, compound,
  -- byte_array, int_array, long_array. Compounds hold { key = tag }, lists and arrays hold 1-based Lua arrays.

  local N = {}
  J.nbt = N

  local NUMERIC = { byte = 1, short = 2, int = 3, long = 4, float = 5, double = 6 }
  N.NUMERIC = NUMERIC

  local function fround(d)
    if string.pack then return (string.unpack("<f", string.pack("<f", d))) end
    return d
  end

  function N.number(kind, v)
    if kind == "float" then v = fround(v) end
    if kind ~= "float" and kind ~= "double" then v = v >= 0 and floor(v) or -floor(-v) end
    return { t = kind, v = v }
  end

  --- A fixture value (decoded JSON) as NBT: whole numbers are ints (longs when too big), others doubles,
  --- booleans bytes, arrays lists, objects compounds.
  function N.fromJson(value)
    local t = type(value)
    if t == "string" then return { t = "string", v = value } end
    if t == "boolean" then return { t = "byte", v = value and 1 or 0 } end
    if t == "number" then
      if value == floor(value) and value >= -2147483648 and value <= 2147483647 then return { t = "int", v = value } end
      if value == floor(value) and math.abs(value) < 9.2e18 then return { t = "long", v = value } end
      return { t = "double", v = value }
    end
    if t ~= "table" then return nil end
    if value.t and value.v ~= nil and (NUMERIC[value.t] or value.t == "string" or value.t == "list" or value.t == "compound"
        or value.t == "byte_array" or value.t == "int_array" or value.t == "long_array") then
      return value -- already a tag (a type travelling with an item through a chest)
    end
    local n = #value
    local count = 0
    for _ in pairs(value) do count = count + 1 end
    if n > 0 and count == n then
      local list = {}
      for i = 1, n do list[i] = N.fromJson(value[i]) end
      return { t = "list", v = list }
    end
    local out = {}
    for k, v in pairs(value) do
      local tag = N.fromJson(v)
      if tag then out[tostring(k)] = tag end
    end
    return { t = "compound", v = out }
  end

  --- Stringified NBT with types (1b, 2s, 3, 4L, 5.0f, 6.0, "x", [I; 1, 2], {...}). Returns tag or nil, message.
  function N.parseSnbt(text)
    local pos = 1
    local function skip() pos = text:find("%S", pos) or #text + 1 end
    local function fail(m) error({ snbt = m .. " at position " .. pos }, 0) end
    local value

    local function quoted()
      local q = text:sub(pos, pos)
      pos = pos + 1
      local out = {}
      while pos <= #text do
        local c = text:sub(pos, pos)
        if c == "\\" then out[#out + 1] = text:sub(pos + 1, pos + 1) pos = pos + 2
        elseif c == q then pos = pos + 1 return table.concat(out)
        else out[#out + 1] = c pos = pos + 1 end
      end
      fail("Unclosed quoted string")
    end

    local function word()
      local w = text:match("^[%w_%.%+%-]+", pos)
      if not w then fail("Expected value") end
      pos = pos + #w
      return w
    end

    local function scalar(w)
      if w == "true" then return { t = "byte", v = 1 } end
      if w == "false" then return { t = "byte", v = 0 } end
      local num, suffix = w:match("^([%+%-]?%d*%.?%d+[eE]?[%+%-]?%d*)([bBsSlLfFdD]?)$")
      if num and tonumber(num) then
        local d = tonumber(num)
        local s = suffix:lower()
        if s == "b" then return N.number("byte", d) end
        if s == "s" then return N.number("short", d) end
        if s == "l" then return N.number("long", d) end
        if s == "f" then return N.number("float", d) end
        if s == "d" then return N.number("double", d) end
        if num:find("[%.eE]") then return N.number("double", d) end
        if d >= -2147483648 and d <= 2147483647 then return N.number("int", d) end
        return { t = "string", v = w }
      end
      return { t = "string", v = w }
    end

    function value()
      skip()
      local c = text:sub(pos, pos)
      if c == "{" then
        pos = pos + 1
        local out = {}
        skip()
        if text:sub(pos, pos) == "}" then pos = pos + 1 return { t = "compound", v = out } end
        while true do
          skip()
          local k = text:sub(pos, pos)
          local key = (k == '"' or k == "'") and quoted() or word()
          skip()
          if text:sub(pos, pos) ~= ":" then fail("Expected ':'") end
          pos = pos + 1
          out[key] = value()
          skip()
          local nc = text:sub(pos, pos)
          pos = pos + 1
          if nc == "}" then return { t = "compound", v = out } end
          if nc ~= "," then fail("Expected ',' or '}'") end
        end
      elseif c == "[" then
        pos = pos + 1
        skip()
        local arrayKind
        local prefix = text:match("^([BIL]);", pos)
        if prefix then
          arrayKind = ({ B = "byte_array", I = "int_array", L = "long_array" })[prefix]
          pos = pos + 2
        end
        local out = {}
        skip()
        if text:sub(pos, pos) == "]" then
          pos = pos + 1
          return { t = arrayKind or "list", v = out }
        end
        while true do
          local tag = value()
          if arrayKind then out[#out + 1] = tag.v else out[#out + 1] = tag end
          skip()
          local nc = text:sub(pos, pos)
          pos = pos + 1
          if nc == "]" then return { t = arrayKind or "list", v = out } end
          if nc ~= "," then fail("Expected ',' or ']'") end
        end
      elseif c == '"' or c == "'" then
        return { t = "string", v = quoted() }
      elseif c == "" then
        fail("Expected value")
      end
      return scalar(word())
    end

    local ok, result = pcall(function()
      local v = value()
      skip()
      if pos <= #text then fail("Trailing data") end
      return v
    end)
    if ok then return result end
    if type(result) == "table" and result.snbt then return nil, result.snbt end
    error(result, 0)
  end

  --- A fixture's NBT: an SNBT string or a JSON value.
  function N.fromFixture(value)
    if type(value) == "string" then
      local tag, err = N.parseSnbt(value)
      if not tag then error("ccsim: bad SNBT in a Mekanism fixture: " .. err, 0) end
      return tag
    end
    return N.fromJson(value)
  end

  --- Tag.equals: same kind and value; compounds and lists element by element (lists ignore their element type).
  function N.equals(a, b)
    if a == b then return true end
    if a == nil or b == nil then return false end
    if a.t ~= b.t then return false end
    if a.t == "compound" then
      for k, v in pairs(a.v) do if not N.equals(v, b.v[k]) then return false end end
      for k in pairs(b.v) do if a.v[k] == nil then return false end end
      return true
    end
    if a.t == "list" then
      if #a.v ~= #b.v then return false end
      for i = 1, #a.v do if not N.equals(a.v[i], b.v[i]) then return false end end
      return true
    end
    if a.t == "byte_array" or a.t == "int_array" or a.t == "long_array" then
      if #a.v ~= #b.v then return false end
      for i = 1, #a.v do if a.v[i] ~= b.v[i] then return false end end
      return true
    end
    return a.v == b.v
  end

  local SUFFIX = { byte = "b", short = "s", int = "", long = "L", float = "f", double = "d" }

  --- A canonical text for a tag: equal tags give equal text (keys sorted, types kept).
  function N.canon(tag)
    local t = tag.t
    if t == "compound" then
      local keys = {}
      for k in pairs(tag.v) do keys[#keys + 1] = k end
      table.sort(keys)
      local parts = {}
      for i, k in ipairs(keys) do parts[i] = string.format("%q", k) .. ":" .. N.canon(tag.v[k]) end
      return "{" .. table.concat(parts, ",") .. "}"
    end
    if t == "list" then
      local parts = {}
      for i, v in ipairs(tag.v) do parts[i] = N.canon(v) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    if t == "byte_array" or t == "int_array" or t == "long_array" then
      local parts = {}
      for i, v in ipairs(tag.v) do parts[i] = string.format("%.17g", v) end
      return "[" .. t:sub(1, 1):upper() .. ";" .. table.concat(parts, ",") .. "]"
    end
    if t == "string" then return string.format("%q", tag.v) end
    return string.format("%.17g", tag.v) .. SUFFIX[t]
  end

  --- CCArgumentWrapper.wrapNBT: numbers and strings as they are, lists and arrays as tables keyed from 0, compounds as tables.
  function N.toLua(tag)
    if tag == nil then return nil end
    local t = tag.t
    if t == "compound" then
      local out = {}
      for k, v in pairs(tag.v) do out[k] = N.toLua(v) end
      return out
    end
    if t == "list" then
      local out = {}
      for i, v in ipairs(tag.v) do out[i - 1] = N.toLua(v) end
      return out
    end
    if t == "byte_array" or t == "int_array" or t == "long_array" then
      local out = {}
      for i, v in ipairs(tag.v) do out[i - 1] = v end
      return out
    end
    return tag.v
  end

  function N.isEmptyCompound(tag) return tag ~= nil and tag.t == "compound" and next(tag.v) == nil end

  -- ----- CCArgumentWrapper.sanitizeNBT: a Java value (from J.toJava) to a tag of the expected class -----

  local INT_RANGE = { byte = { -128, 127 }, short = { -32768, 32767 }, int = { -2147483648, 2147483647 },
    long = { -9223372036854775808, 9223372036854775807 } }
  local FLOAT_MAX = 3.4028234663852886e38
  local HINTS = { [1] = "byte", [2] = "short", [3] = "int", [4] = "long", [5] = "float", [6] = "double",
    [7] = "byte_array", [8] = "string", [9] = "list", [10] = "compound", [11] = "int_array", [12] = "long_array",
    [99] = "Numeric", [0] = "end" }
  local ORDER = { "byte", "short", "int", "long", "float", "double" }
  local RANK = {}
  for i, k in ipairs(ORDER) do RANK[k] = i end

  local function finite(d) return d == d and d ~= huge and d ~= -huge end

  local sanitize

  local function genericNumber(d)
    if d == floor(d) and d >= INT_RANGE.long[1] and d <= INT_RANGE.long[2] then
      for _, k in ipairs({ "byte", "short", "int" }) do
        if d >= INT_RANGE[k][1] and d <= INT_RANGE[k][2] then return N.number(k, d) end
      end
      return N.number("long", d)
    end
    if d >= -FLOAT_MAX and d <= FLOAT_MAX then return N.number("float", d) end
    return N.number("double", d)
  end

  local function listOf(entries, validate)
    -- keys must be numbers 0..size-1, each once
    local n = #entries
    local set = {}
    for _, e in ipairs(entries) do
      local k = e.k
      if type(k) ~= "number" or not finite(k) or k < 0 or k >= n then return false end
      local ik = floor(k)
      if set[ik] or not validate(ik, e.v) then return false end
      set[ik] = true
    end
    return true
  end

  local function sanitizeList(entries)
    local elements = {}
    local desired, search = "Tag", "Tag"
    local ok = listOf(entries, function(index, value)
      local el = sanitize(search, value)
      if not el or el.t == "end" then return false end
      if desired == "Tag" then
        desired = el.t
        if NUMERIC[el.t] then search = "Numeric"
        elseif el.t == "list" or el.t == "byte_array" or el.t == "int_array" or el.t == "long_array" then search = "Collection"
        elseif not N.isEmptyCompound(el) then search = el.t end
      elseif desired ~= el.t then
        if NUMERIC[el.t] and NUMERIC[desired] then
          if RANK[el.t] > RANK[desired] then desired = el.t end
        elseif desired == "compound" and search == "Tag" and (el.t == "byte_array" or el.t == "int_array" or el.t == "long_array") then
          desired, search = el.t, "Collection"
        elseif (desired == "byte_array" and (el.t == "int_array" or el.t == "long_array"))
            or (desired == "int_array" and el.t == "long_array") then
          desired = el.t
        elseif (desired == "int_array" or desired == "long_array") and (el.t == "byte_array" or el.t == "int_array") then
          -- kept as the wider array
        else
          return false
        end
      end
      elements[index + 1] = el
      return true
    end)
    if not ok then return nil end
    local list = {}
    for i = 1, #entries do
      local el = elements[i]
      if NUMERIC[desired] and el.t ~= desired then el = N.number(desired, el.v) end
      if (desired == "int_array" or desired == "long_array") and el.t ~= desired then el = { t = desired, v = el.v } end
      list[i] = el
    end
    return { t = "list", v = list, elem = desired }
  end

  local function sanitizeCollection(entries)
    local list = sanitizeList(entries)
    if not list then return nil end
    local kind = list.elem
    if kind == "byte" or kind == "int" or kind == "long" then
      local values = {}
      for i, el in ipairs(list.v) do values[i] = el.v end
      return { t = kind .. "_array", v = values }
    end
    list.elem = nil
    return list
  end

  local function sanitizeCompound(entries)
    local out = {}
    for _, e in ipairs(entries) do
      if type(e.k) ~= "string" then return nil end
      local tag = sanitize("Tag", e.v)
      if not tag or out[e.k] ~= nil then return nil end
      out[e.k] = tag
    end
    return { t = "compound", v = out }
  end

  local function arrayOf(entries, kind)
    local lo, hi = INT_RANGE[kind][1], INT_RANGE[kind][2]
    local hint = ({ byte = 1, int = 3, long = 4 })[kind]
    local values = {}
    local function accept(index, value)
      if type(value) == "number" then
        if finite(value) and value >= lo and value <= hi then
          values[index + 1] = value >= 0 and floor(value) or -floor(-value)
          return true
        end
      elseif J.isMap(value) and J.size(value) == 2 then
        local v, h = J.get(value, 0), J.get(value, "typeHint")
        if v ~= nil and h == hint then return accept(index, v) end
      end
      return false
    end
    if listOf(entries, accept) then return { t = kind .. "_array", v = values } end
    return nil
  end

  function sanitize(expected, value)
    local t = type(value)
    if t == "boolean" then
      if expected == "byte" or expected == "Numeric" or expected == "Tag" then return { t = "byte", v = value and 1 or 0 } end
      return nil
    end
    if t == "number" then
      if not finite(value) then return nil end
      if INT_RANGE[expected] then
        if value >= INT_RANGE[expected][1] and value <= INT_RANGE[expected][2] then return N.number(expected, value) end
        return nil
      end
      if expected == "float" then
        if value >= -FLOAT_MAX and value <= FLOAT_MAX then return N.number("float", value) end
        return nil
      end
      if expected == "double" then return N.number("double", value) end
      if expected == "Numeric" or expected == "Tag" then return genericNumber(value) end
      return nil
    end
    if t == "string" then
      if expected == "string" or expected == "Tag" then return { t = "string", v = value } end
      if expected == "end" and value == "END" then return { t = "end" } end
      return nil
    end
    if not J.isMap(value) then return nil end
    if J.size(value) == 2 then
      local v, h = J.get(value, 0), J.get(value, "typeHint")
      if v ~= nil and type(h) == "number" and finite(h) and (h == 99 or (h >= 0 and h <= 12)) then
        local hinted = HINTS[floor(h)] or "Tag"
        if expected == hinted or expected == "Tag" then return sanitize(hinted, v) end
        if expected == "Numeric" and NUMERIC[hinted] then return sanitize(hinted, v) end
        if expected == "Collection" and (hinted == "byte_array" or hinted == "int_array" or hinted == "long_array" or hinted == "list") then
          return sanitize(hinted, v)
        end
        return nil
      end
    end
    local entries = value.entries
    if expected == "byte_array" then return arrayOf(entries, "byte") end
    if expected == "int_array" then return arrayOf(entries, "int") end
    if expected == "long_array" then return arrayOf(entries, "long") end
    if expected == "list" then
      local list = sanitizeList(entries)
      if list then list.elem = nil end
      return list
    end
    if expected == "Collection" then return sanitizeCollection(entries) end
    if expected == "compound" then return sanitizeCompound(entries) end
    if expected == "Tag" then
      -- HashMap.entrySet().stream().findAny(): the first entry in iteration order decides
      local first = iterationOrder(value)[1]
      if first and type(first.k) == "number" then return sanitizeCollection(entries) end
      return sanitizeCompound(entries)
    end
    return nil
  end

  --- Lua table to a CompoundTag the way an item filter's itemNBT is read; nil when Mekanism would refuse it.
  function N.fromLuaCompound(javaValue)
    return sanitize("compound", javaValue)
  end

  -- ===== method signatures (BoundComputerMethod.validateArguments) =====

  local ENUMS = {
    EnumColor = { "BLACK", "DARK_BLUE", "DARK_GREEN", "DARK_AQUA", "DARK_RED", "PURPLE", "ORANGE", "GRAY", "DARK_GRAY",
      "INDIGO", "BRIGHT_GREEN", "AQUA", "RED", "PINK", "YELLOW", "WHITE", "BROWN", "BRIGHT_PINK" },
    RedstoneControl = { "DISABLED", "HIGH", "LOW", "PULSE" },
    TransmissionType = { "ENERGY", "FLUID", "GAS", "INFUSION", "PIGMENT", "SLURRY", "ITEM", "HEAT" },
    RelativeSide = { "FRONT", "LEFT", "RIGHT", "BACK", "TOP", "BOTTOM" },
    DataType = { "NONE", "INPUT", "INPUT_1", "INPUT_2", "OUTPUT", "OUTPUT_1", "OUTPUT_2", "INPUT_OUTPUT", "ENERGY", "EXTRA" },
  }
  J.ENUMS = ENUMS

  local function enumFromString(list, s)
    if s == "" then return nil end
    local upper = s:upper()
    for _, name in ipairs(list) do if name == upper then return name end end
    return nil
  end

  --- Try to turn a converted argument into the Java parameter type; nil when sanitizeArgument would give up.
  --- `ctx.filter(map)` builds a QIOFilter, `ctx.knownItem(rl)` says whether an item exists.
  local function convert(expected, value, ctx)
    local t = type(value)
    if expected == "boolean" then
      if t == "boolean" then return value end
      return nil
    end
    if expected == "String" then
      if t == "string" then return value end
      return nil
    end
    if expected == "double" then
      -- a Double is a double already: no finite check (validateArguments only sanitizes when the types differ)
      if t == "number" then return value end
      return nil
    end
    if expected == "int" or expected == "long" then
      if t ~= "number" or not finite(value) then return nil end
      local range = INT_RANGE[expected]
      if value < range[1] or value > range[2] then return nil end
      return value >= 0 and floor(value) or -floor(-value)
    end
    if ENUMS[expected] then
      local list = ENUMS[expected]
      if t == "number" then
        if finite(value) and value >= 0 and value < #list then return list[floor(value) + 1] end
        return nil
      end
      if t == "string" then return enumFromString(list, value) end
      return nil
    end
    if expected == "ResourceLocation" then
      if t == "string" then return J.resourceLocation(value) end
      return nil
    end
    if expected == "QIOFilter" then
      if J.isMap(value) then return ctx.filter(value) end
      return nil
    end
    -- other parameter types a module knows (FloatingLong, Item, its filters): ctx.convert(expected, value)
    if ctx and ctx.convert then return ctx.convert(expected, value) end
    return nil
  end

  --- Check a call's arguments against one signature; returns the converted arguments or raises Mekanism's error.
  function J.checkArguments(methodName, params, args, ctx)
    local count = args.n
    if count ~= #params then
      error(("Mismatched parameter count. %s expected: '%d' arguments, but received: '%d' arguments."):format(
        methodName, #params, count), 0)
    end
    local out = { n = count }
    for index = 1, #params do
      local expected = params[index]
      local raw = args[index]
      local value = J.toJava(raw)
      if value == nil then
        error(("Invalid argument %d, %s expected %s but received null."):format(index - 1, methodName, expected), 0)
      end
      local converted = convert(expected, value, ctx)
      if converted == nil then
        error(("Invalid argument %d, %s expected %s but received type %s with value %s."):format(
          index - 1, methodName, expected, J.className(value), J.str(value)), 0)
      end
      out[index] = converted
    end
    return out
  end

  return J
end
