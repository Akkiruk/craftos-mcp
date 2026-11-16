-- Java semantics Tom's Peripherals relies on: int casts and overflow, float rounding, Double.toString, exceptions,
-- and com.tom.peripherals.util.ParamCheck / math.MathHelper (api branch, commit 5dbf6fc, the jar's API).
-- Arguments arrive as CC hands them to Java: numbers are Doubles, strings Strings, tables Maps, nil null.
return function()
  local J = {}
  local floor = math.floor
  local huge = math.huge
  local TWO32, TWO31 = 4294967296, 2147483648

  --- Wrap a whole number to a Java int (two's complement, 32 bits).
  function J.i32(n)
    n = n % TWO32
    if n >= TWO31 then n = n - TWO32 end
    return n
  end
  local i32 = J.i32

  --- (int) d: toward zero, NaN is 0, saturates at the int range.
  function J.d2i(d)
    if d ~= d then return 0 end
    if d >= 2147483647 then return 2147483647 end
    if d <= -2147483648 then return -2147483648 end
    if d >= 0 then return floor(d) end
    return -floor(-d)
  end
  local d2i = J.d2i

  --- (long) d, then (int): the low 32 bits of the truncated long (Double.longValue saturates at the long range).
  function J.d2l2i(d)
    if d ~= d then return 0 end
    if d >= 9223372036854775807 then return -1 end      -- Long.MAX_VALUE: low 32 bits are all ones
    if d <= -9223372036854775808 then return 0 end      -- Long.MIN_VALUE: low 32 bits are zero
    local t = d >= 0 and floor(d) or -floor(-d)
    return i32(t)
  end

  --- MathHelper.floor: (int) val, minus one when val is below it (wrapping at Integer.MIN_VALUE like Java).
  function J.floor(d)
    local i = d2i(d)
    if d < i then return i32(i - 1) end
    return i
  end

  --- Round to a Java float (IEEE single, nearest-even) and back to double.
  local pack, unpack = string.pack, string.unpack
  if pack then
    function J.f(x) return (unpack("<f", pack("<f", x))) end
  else
    function J.f(x)
      if x ~= x or x == huge or x == -huge or x == 0 then return x end
      local m, e = math.frexp(x)              -- x = m * 2^e, 0.5 <= |m| < 1
      local bits = 24
      if e < -125 then bits = 24 - (-125 - e) end -- subnormal floats keep fewer bits
      if bits < 1 then return 0 * x end
      local s = m * 2 ^ bits
      local r = floor(s + 0.5)
      if r - s == 0.5 and r % 2 == 1 then r = r - 1 end
      local out = r * 2 ^ (e - bits)
      if out >= 3.4028235677973366e38 or out <= -3.4028235677973366e38 then
        if math.abs(out) > 3.4028234663852886e38 then return out > 0 and huge or -huge end
      end
      return out
    end
  end

  --- Java's Double.toString, for a number a method reads with toString().
  function J.doubleToString(d)
    if d ~= d then return "NaN" end
    if d == huge then return "Infinity" end
    if d == -huge then return "-Infinity" end
    if d == 0 then return (1 / d < 0) and "-0.0" or "0.0" end
    local digits, exp
    for p = 1, 17 do
      local s = string.format("%." .. p .. "e", d)
      if tonumber(s) == d then
        local mant, e = s:match("^-?(%d[%.%d]*)e([-+]%d+)$")
        digits, exp = mant:gsub("%.", ""), tonumber(e)
        break
      end
    end
    digits = digits:gsub("0+$", "")
    if digits == "" then digits = "0" end
    local sign = d < 0 and "-" or ""
    local a = math.abs(d)
    if a >= 1e-3 and a < 1e7 then
      local intLen = exp + 1
      if intLen <= 0 then
        return sign .. "0." .. string.rep("0", -intLen) .. digits
      elseif intLen >= #digits then
        return sign .. digits .. string.rep("0", intLen - #digits) .. ".0"
      else
        return sign .. digits:sub(1, intLen) .. "." .. digits:sub(intLen + 1)
      end
    end
    local frac = digits:sub(2)
    if frac == "" then frac = "0" end
    return sign .. digits:sub(1, 1) .. "." .. frac .. "E" .. exp
  end

  --- String.valueOf / Object.toString of an argument.
  function J.toString(v)
    if v == nil then return "null" end
    if type(v) == "number" then return J.doubleToString(v) end
    if type(v) == "boolean" then return tostring(v) end
    if type(v) == "string" then return v end
    return "{}" -- a Map: HashMap.toString, not worth reproducing
  end

  -- ===== exceptions =====
  -- A LuaException is a plain string. Any other Java exception is a table, so the method boundary can tell them
  -- apart: CC words an unexpected exception "Java Exception Thrown: ...", TMLuaObject.call "Java Exception: ...".
  local Exc = {}
  Exc.__index = Exc
  Exc.__tostring = function(e) return e.class .. (e.msg and (": " .. e.msg) or "") end
  function J.throw(class, msg) error(setmetatable({ class = class, msg = msg }, Exc), 0) end
  function J.isJava(e) return getmetatable(e) == Exc end
  function J.indexOutOfBounds(e)
    return getmetatable(e) == Exc and (e.class == "java.lang.ArrayIndexOutOfBoundsException"
      or e.class == "java.lang.IndexOutOfBoundsException" or e.class == "java.lang.StringIndexOutOfBoundsException")
  end
  function J.aioobe(index, length)
    J.throw("java.lang.ArrayIndexOutOfBoundsException",
      string.format("Index %d out of bounds for length %d", index, length))
  end
  function J.npe(msg) J.throw("java.lang.NullPointerException", msg) end
  function J.divZero() J.throw("java.lang.ArithmeticException", "/ by zero") end
  --- Java int division (truncates toward zero); x / 0 throws.
  function J.idiv(a, b)
    if b == 0 then J.divZero() end
    local q = a / b
    return q >= 0 and floor(q) or -floor(-q)
  end
  --- Java int remainder (sign of the dividend).
  function J.irem(a, b)
    if b == 0 then J.divZero() end
    return a - J.idiv(a, b) * b
  end
  function J.lua(msg) error(msg, 0) end

  -- ===== ParamCheck =====
  local P = {}
  J.P = P
  local function lerr(msg) error(msg, 0) end

  function P.isNumber(a, arg)
    if not (arg < a.n and type(a[arg + 1]) == "number") then
      lerr("Bad argument #" .. (arg + 1) .. ": (expected Number)")
    end
  end
  function P.getInt(a, arg)
    P.isNumber(a, arg)
    return J.floor(a[arg + 1])
  end
  function P.optionalInt(a, arg, def)
    if arg < a.n then return P.getInt(a, arg) end
    return def
  end
  function P.getDouble(a, arg)
    P.isNumber(a, arg)
    return a[arg + 1]
  end
  function P.getString(a, arg)
    if not (arg < a.n and a[arg + 1] ~= nil) then lerr("Bad argument #" .. (arg + 1) .. ": (expected Number)") end
    return J.toString(a[arg + 1])
  end
  function P.getBoolean(a, arg)
    if not (arg < a.n and type(a[arg + 1]) == "boolean") then
      lerr("Bad argument #" .. (arg + 1) .. ": (expected Boolean)")
    end
    return a[arg + 1]
  end
  --- ints/uints: every argument from `arg` on; the message names the range, not the bad one.
  local function stream(a, arg, conv)
    local out = {}
    for i = arg + 1, a.n do
      local v = a[i]
      if type(v) ~= "number" then lerr("Bad argument #" .. (arg + 1) .. "-" .. a.n .. ": (expected Number)") end
      out[#out + 1] = conv(v)
    end
    return out
  end
  function P.ints(a, arg) return stream(a, arg, J.floor) end
  function P.uints(a, arg) return stream(a, arg, J.d2l2i) end

  local band, bor, lshift = bit32.band, bit32.bor, bit32.lshift
  function P.toColor(args, start)
    local n = args.n
    if n == start then
      lerr("Too few arguments expected number argb or [number r/a], [number g/r], [number b/g], [number b]")
    elseif n == start + 3 then
      local r, g, b = args[start + 1], args[start + 2], args[start + 3]
      if type(r) == "number" and type(g) == "number" and type(b) == "number" then
        return i32(0xFF000000 + band(J.floor(r), 0xFF) * 65536 + band(J.floor(g), 0xFF) * 256 + band(J.floor(b), 0xFF))
      end
      lerr("bad arguments: numbers expected")
    elseif n == start + 4 then
      local r, g, b, al = args[start + 1], args[start + 2], args[start + 3], args[start + 4]
      if type(r) == "number" and type(g) == "number" and type(b) == "number" and type(al) == "number" then
        return i32(band(J.floor(al), 0xFF) * 16777216 + band(J.floor(r), 0xFF) * 65536
          + band(J.floor(g), 0xFF) * 256 + band(J.floor(b), 0xFF))
      end
      lerr("bad arguments: numbers expected")
    end
    P.isNumber(args, start)
    return J.d2l2i(args[start + 1])
  end

  --- Unsigned view of a Java int, for bit32.
  function J.u32(n) return n % TWO32 end
  --- 1 << k for a Java int (the shift count is masked to 5 bits).
  function J.bit(k) return lshift(1, k % 32) end
  J.band, J.bor = band, bor

  return J
end
