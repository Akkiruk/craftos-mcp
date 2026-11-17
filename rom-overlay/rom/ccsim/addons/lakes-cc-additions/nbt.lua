-- Minecraft 1.20.1's NBT as the scanner sees it: SNBT read the way TagParser reads it (a fixture's item NBT is SNBT
-- text), and written the way Tag.toString / StringTagVisitor writes it (sorted keys, the b/s/L/f/d suffixes, quoting),
-- which the scanner hashes for fingerprint(). A tag is { t = "compound"|"list"|"string"|"byte"|"short"|"int"|"long"|
-- "float"|"double"|"byte_array"|"int_array"|"long_array", v = ... }.
local N = {}

-- ===== numbers as Java prints them =====

local function fround(x)
  if x == 0 or x ~= x or x == math.huge or x == -math.huge then return x end
  local m, e = math.frexp(x)
  if e < -125 then -- subnormal: a fixed step of 2^-149
    return math.floor(x / 2 ^ -149 + 0.5) * 2 ^ -149
  end
  local scaled = m * 2 ^ 24
  local r = math.floor(scaled + 0.5)
  if r - scaled == 0.5 and r % 2 == 1 then r = r - 1 end -- ties to even
  return r / 2 ^ 24 * 2 ^ e
end
N.fround = fround

--- Double.toString / Float.toString: the shortest digits that read back, "1.0", "1.0E10", "1.0E-5"
local function javaNumber(x, float)
  if x ~= x then return "NaN" end
  if x == math.huge then return "Infinity" end
  if x == -math.huge then return "-Infinity" end
  if x == 0 then return (1 / x < 0) and "-0.0" or "0.0" end
  local digits
  for p = 1, 17 do
    local s = ("%." .. p .. "e"):format(x)
    local back = tonumber(s)
    if (float and fround(back) == x) or (not float and back == x) then digits = s break end
  end
  local sign, mant, exp = digits:match("^(-?)(%d[%.%d]*)e([-+]%d+)$")
  exp = tonumber(exp)
  local d = mant:gsub("%.", "")
  d = d:gsub("0+$", "")
  if d == "" then d = "0" end
  local ax = math.abs(x)
  if ax >= 1e-3 and ax < 1e7 then
    local point = exp + 1
    local s
    if point <= 0 then
      s = "0." .. ("0"):rep(-point) .. d
    elseif point >= #d then
      s = d .. ("0"):rep(point - #d) .. ".0"
    else
      s = d:sub(1, point) .. "." .. d:sub(point + 1)
    end
    return sign .. s
  end
  local s = d:sub(1, 1) .. "." .. (#d > 1 and d:sub(2) or "0")
  return sign .. s .. "E" .. exp
end
N.javaNumber = javaNumber

-- ===== writing (StringTagVisitor) =====

local SIMPLE = "^[0-9A-Za-z_%-%.%+]+$"

function N.quote(s)
  local out, q = {}, nil
  for i = 1, #s do
    local c = s:sub(i, i)
    if c == "\\" then
      out[#out + 1] = "\\"
    elseif c == '"' or c == "'" then
      if not q then q = c == '"' and "'" or '"' end
      if q == c then out[#out + 1] = "\\" end
    end
    out[#out + 1] = c
  end
  q = q or '"'
  return q .. table.concat(out) .. q
end

local function intText(v) return ("%d"):format(v) end

function N.write(tag)
  local t, v = tag.t, tag.v
  if t == "compound" then
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys)
    local parts = {}
    for i, k in ipairs(keys) do
      parts[i] = (k:match(SIMPLE) and k or N.quote(k)) .. ":" .. N.write(v[k])
    end
    return "{" .. table.concat(parts, ",") .. "}"
  elseif t == "list" then
    local parts = {}
    for i, e in ipairs(v) do parts[i] = N.write(e) end
    return "[" .. table.concat(parts, ",") .. "]"
  elseif t == "string" then
    return N.quote(v)
  elseif t == "byte" then return intText(v) .. "b"
  elseif t == "short" then return intText(v) .. "s"
  elseif t == "int" then return intText(v)
  elseif t == "long" then return intText(v) .. "L"
  elseif t == "float" then return javaNumber(v, true) .. "f"
  elseif t == "double" then return javaNumber(v, false) .. "d"
  else
    local prefix, suffix = ({ byte_array = "B", int_array = "I", long_array = "L" })[t], ({ byte_array = "B", int_array = "", long_array = "L" })[t]
    local parts = {}
    for i, e in ipairs(v) do parts[i] = intText(e) .. suffix end
    return "[" .. prefix .. ";" .. table.concat(parts, ",") .. "]"
  end
end

-- ===== reading (TagParser) =====

local function err(msg) error("ccsim: bad SNBT in the fixture: " .. msg, 0) end

local function readNumberOrString(s)
  local lower = s:lower()
  local function int(str) return tonumber(str) end
  if lower:match("^[-+]?%d+b$") and (lower:match("^[-+]?0b$") or lower:match("^[-+]?[1-9]%d*b$")) then
    return { t = "byte", v = int(s:sub(1, -2)) }
  end
  if lower:match("^[-+]?0l$") or lower:match("^[-+]?[1-9]%d*l$") then return { t = "long", v = int(s:sub(1, -2)) } end
  if lower:match("^[-+]?0s$") or lower:match("^[-+]?[1-9]%d*s$") then return { t = "short", v = int(s:sub(1, -2)) } end
  if s:match("^[-+]?0$") or s:match("^[-+]?[1-9]%d*$") then return { t = "int", v = int(s) } end
  local function isFloatBody(b)
    return b:match("^[-+]?%d+%.$") or b:match("^[-+]?%d*%.%d+$") or b:match("^[-+]?%d+%.[eE][-+]?%d+$")
      or b:match("^[-+]?%d*%.%d+[eE][-+]?%d+$") or b:match("^[-+]?%d+[eE][-+]?%d+$")
  end
  if lower:sub(-1) == "f" and (isFloatBody(s:sub(1, -2)) or s:sub(1, -2):match("^[-+]?%d+$")) then
    return { t = "float", v = fround(tonumber(s:sub(1, -2))) }
  end
  if lower:sub(-1) == "d" and (isFloatBody(s:sub(1, -2)) or s:sub(1, -2):match("^[-+]?%d+$")) then
    return { t = "double", v = tonumber(s:sub(1, -2)) }
  end
  if isFloatBody(s) and s:find("%.") then return { t = "double", v = tonumber(s) } end
  if lower == "true" then return { t = "byte", v = 1 } end
  if lower == "false" then return { t = "byte", v = 0 } end
  return { t = "string", v = s }
end

function N.parse(text)
  local pos = 1
  local function ws() pos = text:find("[^%s]", pos) or #text + 1 end
  local function peek() ws() return text:sub(pos, pos) end
  local function expect(c)
    ws()
    if text:sub(pos, pos) ~= c then err(("expected '%s' at %d"):format(c, pos)) end
    pos = pos + 1
  end
  local function quoted()
    local q = text:sub(pos, pos)
    pos = pos + 1
    local out = {}
    while true do
      local c = text:sub(pos, pos)
      if c == "" then err("unterminated string") end
      if c == "\\" then
        out[#out + 1] = text:sub(pos + 1, pos + 1)
        pos = pos + 2
      elseif c == q then
        pos = pos + 1
        return table.concat(out)
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
  end
  local function unquoted()
    local s = text:match("^[0-9A-Za-z_%-%.%+]*", pos)
    pos = pos + #s
    return s
  end
  local value
  local function key()
    ws()
    local c = text:sub(pos, pos)
    if c == '"' or c == "'" then return quoted() end
    local k = unquoted()
    if k == "" then err("expected a key at " .. pos) end
    return k
  end
  function value()
    local c = peek()
    if c == "{" then
      pos = pos + 1
      local v = {}
      if peek() == "}" then pos = pos + 1 return { t = "compound", v = v } end
      while true do
        local k = key()
        expect(":")
        v[k] = value()
        local n = peek()
        pos = pos + 1
        if n == "}" then break end
        if n ~= "," then err("expected ',' or '}' at " .. (pos - 1)) end
      end
      return { t = "compound", v = v }
    elseif c == "[" then
      local arr = text:match("^%[([BIL]);", pos)
      if arr then
        pos = pos + 3
        local t = ({ B = "byte_array", I = "int_array", L = "long_array" })[arr]
        local v = {}
        if peek() == "]" then pos = pos + 1 return { t = t, v = v } end
        while true do
          ws()
          local s = unquoted()
          local n = tonumber((s:gsub("[bBlL]$", "")))
          if not n then err("bad array element " .. s) end
          v[#v + 1] = n
          local d = peek()
          pos = pos + 1
          if d == "]" then break end
          if d ~= "," then err("expected ',' or ']'") end
        end
        return { t = t, v = v }
      end
      pos = pos + 1
      local v = {}
      if peek() == "]" then pos = pos + 1 return { t = "list", v = v } end
      while true do
        v[#v + 1] = value()
        local d = peek()
        pos = pos + 1
        if d == "]" then break end
        if d ~= "," then err("expected ',' or ']'") end
      end
      return { t = "list", v = v }
    elseif c == '"' or c == "'" then
      return { t = "string", v = quoted() }
    else
      local s = unquoted()
      if s == "" then err("expected a value at " .. pos) end
      return readNumberOrString(s)
    end
  end
  local tag = value()
  return tag
end

-- ===== helpers =====

function N.compound(v) return { t = "compound", v = v or {} } end
function N.str(s) return { t = "string", v = s } end
function N.int(i) return { t = "int", v = i } end
function N.byte(b) return { t = "byte", v = b } end
function N.get(c, k) return c and c.t == "compound" and c.v[k] or nil end
function N.getString(c, k) local t = N.get(c, k) return t and t.t == "string" and t.v or "" end
local NUMERIC = { byte = true, short = true, int = true, long = true, float = true, double = true }
function N.getInt(c, k) local t = N.get(c, k) return t and NUMERIC[t.t] and math.floor(t.v) or 0 end
function N.getByte(c, k) local t = N.get(c, k) return t and NUMERIC[t.t] and math.floor(t.v) or 0 end
function N.isNumeric(t) return NUMERIC[t.t] == true end
function N.copy(tag)
  if type(tag) ~= "table" then return tag end
  local out = {}
  for k, v in pairs(tag) do out[k] = type(v) == "table" and N.copy(v) or v end
  return out
end

return N
