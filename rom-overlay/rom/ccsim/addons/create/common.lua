-- Helpers shared by the Create and Create Crafts & Additions modules: CC:Tweaked's argument checks and method
-- order, Java's number casts and exception text, and a small NBT model (Create's schedules travel as NBT).
local C = {}

local floor = math.floor

-- ===== CC:Tweaked =====

local function typeName(v) return v == nil and "nil" or type(v) end
C.typeName = typeName

--- IArguments.getInt / an `int` parameter
function C.int(i, v)
  if type(v) ~= "number" then
    error(("bad argument #%d (number expected, got %s)"):format(i, typeName(v)), 0)
  end
  if v ~= v or v == math.huge or v == -math.huge then
    error(("bad argument #%d (number expected, got %s)"):format(i, tostring(v)), 0)
  end
  if v ~= floor(v) then error(("bad argument #%d (number has no integer representation)"):format(i), 0) end
  return C.toInt(v)
end

--- Optional<Integer>: nil is empty
function C.optInt(i, v)
  if v == nil then return nil end
  return C.int(i, v)
end

--- a `String` parameter (CC coerces numbers, like the shared checkString)
function C.str(i, v)
  if type(v) == "string" then return v end
  if type(v) == "number" then return tostring(v) end
  error(("bad argument #%d (string expected, got %s)"):format(i, typeName(v)), 0)
end

function C.bool(i, v)
  if type(v) ~= "boolean" then error(("bad argument #%d (boolean expected, got %s)"):format(i, typeName(v)), 0) end
  return v
end

function C.table(i, v)
  if type(v) ~= "table" then error(("bad argument #%d (table expected, got %s)"):format(i, typeName(v)), 0) end
  return v
end

--- What CC reports for an unchecked Java exception thrown by a method (LuaContext / the method wrapper).
function C.java(class, message)
  error("Java Exception Thrown: " .. class .. (message and (": " .. message) or ""), 0)
end

--- peripheral.getMethods order: CC:Tweaked puts the methods into `new HashMap<>(count)` (PeripheralAPI.getMethods)
--- in Class.getMethods order (taken here as declaration order; it only matters inside one bucket).
function C.hashMapOrder(keys)
  local n = #keys
  local cap = 1
  while cap < n do cap = cap * 2 end
  local threshold = floor(cap * 0.75)
  for size = 1, n do
    if size > threshold then
      cap = cap * 2
      threshold = floor(cap * 0.75)
    end
  end
  local rows = {}
  for i, k in ipairs(keys) do
    local h = 0
    for j = 1, #k do h = (h * 31 + k:byte(j)) % 4294967296 end
    h = bit32.bxor(h, bit32.rshift(h, 16))
    rows[i] = { k = k, i = i, b = bit32.band(h, cap - 1) }
  end
  table.sort(rows, function(a, b)
    if a.b ~= b.b then return a.b < b.b end
    return a.i < b.i
  end)
  local out = {}
  for i, r in ipairs(rows) do out[i] = r.k end
  return out
end

-- ===== Java numbers =====

--- (int) of a double: toward zero, saturating, NaN is 0
function C.toInt(d)
  if d ~= d then return 0 end
  if d >= 2147483647 then return 2147483647 end
  if d <= -2147483648 then return -2147483648 end
  if d >= 0 then return floor(d) end
  return -floor(-d)
end

--- (byte) of a double
function C.toByte(d)
  local i = C.toInt(d)
  return ((i + 128) % 256) - 128
end

--- a Java float as Lua sees it (CC hands floats to Lua as doubles)
function C.float(d)
  if d == 0 or d ~= d or d == math.huge or d == -math.huge then return d end
  local m, e = math.frexp(d)
  m = floor(m * 16777216 + 0.5) / 16777216
  return math.ldexp(m, e)
end

-- ===== NBT =====
-- A tag is { t = id, v = value }; lists also carry `et`, their element type. Ids as Tag.getId().

local BYTE, INT, DOUBLE, STRING, LIST, COMPOUND = 1, 3, 6, 8, 9, 10
C.BYTE, C.INT, C.DOUBLE, C.STRING, C.LIST, C.COMPOUND = BYTE, INT, DOUBLE, STRING, LIST, COMPOUND
local NUMERIC = { [1] = true, [2] = true, [3] = true, [4] = true, [5] = true, [6] = true }

function C.compound() return { t = COMPOUND, v = {} } end
function C.list() return { t = LIST, v = {}, et = 0 } end
function C.string(s) return { t = STRING, v = s } end
function C.intTag(i) return { t = INT, v = i } end
function C.byteTag(b) return { t = BYTE, v = b } end

--- ListTag.add: every element has the list's type
function C.listAdd(list, tag)
  if list.et == 0 then
    list.et = tag.t
  elseif list.et ~= tag.t then
    C.java("java.lang.UnsupportedOperationException",
      ("Trying to add tag of type %d to list of %d"):format(tag.t, list.et))
  end
  list.v[#list.v + 1] = tag
end

function C.copyTag(tag)
  if tag.t == COMPOUND then
    local out = C.compound()
    for k, v in pairs(tag.v) do out.v[k] = C.copyTag(v) end
    return out
  elseif tag.t == LIST then
    local out = { t = LIST, v = {}, et = tag.et }
    for i, v in ipairs(tag.v) do out.v[i] = C.copyTag(v) end
    return out
  end
  return { t = tag.t, v = tag.v }
end

-- CompoundTag getters: the wrong type reads as the default, like Minecraft's
function C.contains(c, key) return c.v[key] ~= nil end
function C.getString(c, key)
  local t = c.v[key]
  return (t and t.t == STRING) and t.v or ""
end
function C.getInt(c, key)
  local t = c.v[key]
  if t and NUMERIC[t.t] then return C.toInt(t.v) end
  return 0
end
function C.getByte(c, key)
  local t = c.v[key]
  if t and NUMERIC[t.t] then return C.toByte(t.v) end
  return 0
end
function C.getBoolean(c, key) return C.getByte(c, key) ~= 0 end
function C.getCompound(c, key)
  local t = c.v[key]
  return (t and t.t == COMPOUND) and t or C.compound()
end
function C.getList(c, key, elementType)
  local t = c.v[key]
  if t and t.t == LIST and (#t.v == 0 or t.et == elementType) then return t end
  return C.list()
end

-- ===== resource locations =====

--- new ResourceLocation(s): "minecraft" when there is no namespace, ResourceLocationException when a character is bad
function C.resourceLocation(s)
  local ns, path = "minecraft", s
  local i = s:find(":", 1, true)
  if i then
    path = s:sub(i + 1)
    if i > 1 then ns = s:sub(1, i - 1) end
  end
  if ns:find("[^a-z0-9_.%-]") then
    C.java("net.minecraft.ResourceLocationException", "Non [a-z0-9_.-] character in namespace of location: " .. ns .. ":" .. path)
  end
  if path:find("[^a-z0-9/._%-]") then
    C.java("net.minecraft.ResourceLocationException", "Non [a-z0-9/._-] character in path of location: " .. ns .. ":" .. path)
  end
  return ns .. ":" .. path
end

-- ===== the Lua <-> Java table conversion =====

function C.count(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  return n
end

function C.deepCopy(v)
  if type(v) ~= "table" then return v end
  local out = {}
  for k, x in pairs(v) do out[k] = C.deepCopy(x) end
  return out
end

return C
