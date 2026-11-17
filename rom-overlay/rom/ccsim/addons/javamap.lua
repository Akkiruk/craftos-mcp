-- peripheral.getMethods order on CC:Tweaked 1.121.0 (Minecraft 1.20.1 and 1.21.1): MethodSupplier.getSelfMethods
-- fills a `new HashMap<>()` (16 buckets, doubled past 3/4 full) and getMethods lists its keySet. So the order is the
-- bucket of each name's String.hashCode (spread by h ^ h >>> 16), ties in the order the methods were found (taken
-- here as the order given). CC 1.101.3 sizes the map to the method count instead: see create/common.lua.
local band, bxor, rshift = bit32.band, bit32.bxor, bit32.rshift

local J = {}

function J.hashCode(s)
  local h = 0
  for i = 1, #s do h = (h * 31 + s:byte(i)) % 4294967296 end
  return h
end

function J.order(keys)
  local cap = 16
  while #keys > cap * 0.75 do cap = cap * 2 end
  local rows = {}
  for i, k in ipairs(keys) do
    local h = J.hashCode(k)
    rows[i] = { k = k, i = i, b = band(bxor(h, rshift(h, 16)), cap - 1) }
  end
  table.sort(rows, function(a, b)
    if a.b ~= b.b then return a.b < b.b end
    return a.i < b.i
  end)
  local out = {}
  for i, r in ipairs(rows) do out[i] = r.k end
  return out
end

return J
