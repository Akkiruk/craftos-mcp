-- ccsim turtle nbt: the `nbt` hash of getItemDetail, as CC:Tweaked 1.101.3 computes it (NBTUtil.getNBTHash).
--
-- The tag is written big-endian, the way DataOutputStream does, with the root name "" and the keys of every compound
-- NBTUtil reaches sorted (Arrays.sort on the key strings). A compound inside a list is written by vanilla
-- (CompoundTag.write), so its keys come in HashMap order. The MD5 of those bytes, in lowercase hex, is the hash.
--
-- A tag can be given typed ({ t = "int", v = 3 }, as mek/java.lua builds them), as SNBT text ("{Damage:0}"), or as a
-- plain Lua table: whole numbers are then ints (longs when too big), other numbers doubles, booleans bytes, arrays
-- lists and other tables compounds.
return function()
  local M = {}
  local band, bor, bxor, bnot = bit32.band, bit32.bor, bit32.bxor, bit32.bnot
  local lrotate, rshift = bit32.lrotate, bit32.rshift
  local floor, char, byte = math.floor, string.char, string.byte

  local N = dofile("/rom/ccsim/mek/java.lua")().nbt
  M.N = N

  -- ===== MD5 (RFC 1321) =====

  local K, S = {}, {
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  }
  for i = 0, 63 do K[i + 1] = floor(math.abs(math.sin(i + 1)) * 4294967296) % 4294967296 end

  local function md5(msg)
    local len = #msg
    msg = msg .. "\128" .. ("\0"):rep((55 - len) % 64)
    local bits = len * 8
    for i = 0, 7 do
      msg = msg .. char(floor(bits / 2 ^ (8 * i)) % 256)
    end
    local a0, b0, c0, d0 = 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476
    local X = {}
    for chunk = 1, #msg, 64 do
      for i = 0, 15 do
        local p = chunk + i * 4
        local b1, b2, b3, b4 = byte(msg, p, p + 3)
        X[i] = b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
      end
      local a, b, c, d = a0, b0, c0, d0
      for i = 0, 63 do
        local f, g
        if i < 16 then
          f, g = bor(band(b, c), band(bnot(b), d)), i
        elseif i < 32 then
          f, g = bor(band(d, b), band(bnot(d), c)), (5 * i + 1) % 16
        elseif i < 48 then
          f, g = bxor(b, c, d), (3 * i + 5) % 16
        else
          f, g = bxor(c, bor(b, bnot(d))), (7 * i) % 16
        end
        local sum = (a + f + K[i + 1] + X[g]) % 4294967296
        a, d, c = d, c, b
        b = (b + lrotate(sum, S[i + 1])) % 4294967296
      end
      a0, b0 = (a0 + a) % 4294967296, (b0 + b) % 4294967296
      c0, d0 = (c0 + c) % 4294967296, (d0 + d) % 4294967296
    end
    local out = {}
    for _, word in ipairs({ a0, b0, c0, d0 }) do
      for i = 0, 3 do out[#out + 1] = ("%02x"):format(floor(word / 2 ^ (8 * i)) % 256) end
    end
    return table.concat(out)
  end
  M.md5 = md5

  -- ===== Java strings =====

  --- A Lua (UTF-8) string as Java's UTF-16 code units. Bytes that are not UTF-8 count as one unit each.
  local function utf16(s)
    local units, i, n = {}, 1, #s
    while i <= n do
      local c = byte(s, i)
      local cp, size = c, 1
      if c >= 0xF0 and i + 3 <= n then
        cp, size = (c % 8) * 262144 + (byte(s, i + 1) % 64) * 4096 + (byte(s, i + 2) % 64) * 64 + byte(s, i + 3) % 64, 4
      elseif c >= 0xE0 and i + 2 <= n then
        cp, size = (c % 16) * 4096 + (byte(s, i + 1) % 64) * 64 + byte(s, i + 2) % 64, 3
      elseif c >= 0xC0 and i + 1 <= n then
        cp, size = (c % 32) * 64 + byte(s, i + 1) % 64, 2
      end
      if cp >= 0x10000 then
        cp = cp - 0x10000
        units[#units + 1] = 0xD800 + floor(cp / 1024)
        units[#units + 1] = 0xDC00 + cp % 1024
      else
        units[#units + 1] = cp
      end
      i = i + size
    end
    return units
  end

  --- DataOutput.writeUTF: modified UTF-8 behind a two-byte length.
  local function writeUTF(out, s)
    local body = {}
    for _, u in ipairs(utf16(s)) do
      if u >= 1 and u <= 0x7F then
        body[#body + 1] = char(u)
      elseif u <= 0x7FF then
        body[#body + 1] = char(0xC0 + floor(u / 64), 0x80 + u % 64)
      else
        body[#body + 1] = char(0xE0 + floor(u / 4096), 0x80 + floor(u / 64) % 64, 0x80 + u % 64)
      end
    end
    local text = table.concat(body)
    out[#out + 1] = char(floor(#text / 256) % 256, #text % 256)
    out[#out + 1] = text
  end

  --- String.compareTo: UTF-16 code units, then length.
  local function javaLess(a, b)
    local ua, ub = utf16(a), utf16(b)
    for i = 1, math.min(#ua, #ub) do
      if ua[i] ~= ub[i] then return ua[i] < ub[i] end
    end
    return #ua < #ub
  end

  local function stringHash(s)
    local h = 0
    for _, u in ipairs(utf16(s)) do h = (h * 31 + u) % 4294967296 end
    return h
  end

  --- Keys in HashMap iteration order (Maps.newHashMap, filled as the tag was read): bucket, then insertion order,
  --- which a Lua table does not keep, so keys sharing a bucket go in sorted order.
  local function hashMapOrder(keys)
    local cap = 16
    while #keys > cap * 0.75 do cap = cap * 2 end
    local list = {}
    for _, k in ipairs(keys) do
      local h = stringHash(k)
      list[#list + 1] = { k = k, b = band(bxor(h, rshift(h, 16)), cap - 1) }
    end
    table.sort(list, function(x, y)
      if x.b ~= y.b then return x.b < y.b end
      return javaLess(x.k, y.k)
    end)
    local out = {}
    for i, e in ipairs(list) do out[i] = e.k end
    return out
  end

  -- ===== numbers, big-endian =====

  local frexp = math.frexp or function(v)
    local exp = floor(math.log(v) / math.log(2)) + 1
    local frac = v / 2 ^ exp
    if frac >= 1 then frac, exp = frac / 2, exp + 1 elseif frac < 0.5 then frac, exp = frac * 2, exp - 1 end
    return frac, exp
  end

  local function int(out, v, bytes)
    v = v >= 0 and floor(v) or -floor(-v)
    if bytes == 8 then
      -- two words, so a negative long keeps its low bits in a double
      local hi = floor(v / 4294967296)
      int(out, hi, 4)
      int(out, v - hi * 4294967296, 4)
      return
    end
    local range = 2 ^ (8 * bytes)
    v = v % range
    local parts = {}
    for i = bytes, 1, -1 do
      parts[i] = floor(v % 256)
      v = floor(v / 256)
    end
    out[#out + 1] = char(table.unpack(parts))
  end

  --- IEEE 754 bits of `v` with `ebits` exponent bits and `mbits` mantissa bits, as big-endian bytes.
  local function ieee(out, v, ebits, mbits)
    local bias = 2 ^ (ebits - 1) - 1
    local sign, e, m = 0, 0, 0
    if v ~= v then
      e, m = 2 ^ ebits - 1, 2 ^ (mbits - 1)
    else
      if v < 0 or (v == 0 and 1 / v < 0) then sign, v = 1, -v end
      if v == math.huge then
        e = 2 ^ ebits - 1
      elseif v ~= 0 then
        local frac, exp = frexp(v) -- v = frac * 2^exp, 0.5 <= frac < 1
        e = exp + bias - 1
        if e <= 0 then
          m = floor(v / 2 ^ (1 - bias - mbits) + 0.5)
          e = 0
        else
          m = floor((frac * 2 - 1) * 2 ^ mbits + 0.5)
          if m >= 2 ^ mbits then m, e = 0, e + 1 end
          if e >= 2 ^ ebits - 1 then e, m = 2 ^ ebits - 1, 0 end
        end
      end
    end
    local bits = (sign * 2 ^ ebits + e) * 2 ^ mbits + m
    local bytes = (1 + ebits + mbits) / 8
    local parts = {}
    for i = bytes, 1, -1 do
      parts[i] = floor(bits % 256)
      bits = floor(bits / 256)
    end
    out[#out + 1] = char(table.unpack(parts))
  end

  -- ===== tags =====

  local IDS = {
    byte = 1, short = 2, int = 3, long = 4, float = 5, double = 6, byte_array = 7, string = 8, list = 9,
    compound = 10, int_array = 11, long_array = 12,
  }

  local payload

  --- Tag.write for every kind; `sorted` is NBTUtil's own compound writer, false for vanilla's.
  local function namedTag(out, name, tag, sorted)
    out[#out + 1] = char(IDS[tag.t])
    writeUTF(out, name)
    payload(out, tag, sorted)
  end

  function payload(out, tag, sorted)
    local t, v = tag.t, tag.v
    if t == "byte" then int(out, v, 1)
    elseif t == "short" then int(out, v, 2)
    elseif t == "int" then int(out, v, 4)
    elseif t == "long" then int(out, v, 8)
    elseif t == "float" then ieee(out, v, 8, 23)
    elseif t == "double" then ieee(out, v, 11, 52)
    elseif t == "string" then writeUTF(out, v)
    elseif t == "byte_array" or t == "int_array" or t == "long_array" then
      int(out, #v, 4)
      local size = t == "byte_array" and 1 or t == "int_array" and 4 or 8
      for _, x in ipairs(v) do int(out, x, size) end
    elseif t == "list" then
      local first = v[1]
      out[#out + 1] = char(first and IDS[first.t] or 0)
      int(out, #v, 4)
      -- ListTag.write: vanilla from here down
      for _, element in ipairs(v) do payload(out, element, false) end
    elseif t == "compound" then
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = k end
      if sorted then table.sort(keys, javaLess) else keys = hashMapOrder(keys) end
      for _, k in ipairs(keys) do namedTag(out, k, v[k], sorted) end
      out[#out + 1] = "\0"
    else
      error("ccsim: unknown NBT kind " .. tostring(t), 0)
    end
  end

  --- A tag from any of the forms above, or nil.
  function M.tag(value)
    if type(value) == "string" then
      local tag, err = N.parseSnbt(value)
      if not tag then error("ccsim: bad SNBT '" .. value .. "': " .. tostring(err), 0) end
      return tag
    end
    if type(value) ~= "table" then return nil end
    return N.fromJson(value)
  end

  --- The bytes NBTUtil feeds to MD5.
  function M.encode(value)
    local tag = M.tag(value)
    local out = {}
    namedTag(out, "", tag, true)
    return table.concat(out)
  end

  --- NBTUtil.getNBTHash.
  function M.hash(value)
    return md5(M.encode(value))
  end

  --- Does this string look like a hash already (and not SNBT)?
  function M.isHash(s) return type(s) == "string" and s:match("^%x+$") ~= nil end

  return M
end
