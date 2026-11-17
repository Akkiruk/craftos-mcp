---@meta

-- Hand-written: where CC:Tweaked's Lua differs from the Lua 5.2 that lua-language-server is told to assume.
-- CC:Tweaked 1.101.3 runs Lua 5.1 with parts of 5.2 and 5.3; from 1.109.0 it runs Lua 5.2 with parts of 5.3. Both keep
-- the 5.1 functions below, and both have `utf8` and string.pack.

---The old ComputerCraft bit API. Use `bit32`.
---
---[tweaked.cc](https://tweaked.cc/module/bit.html)
---@class cc.bit
bit = {}

---@deprecated Use `bit32.lshift`.
---@param n integer
---@param bits integer
---@return integer
function bit.blshift(n, bits) end

---Arithmetic shift right: the sign bit is copied in.
---@deprecated Use `bit32.arshift`.
---@param n integer
---@param bits integer
---@return integer
function bit.brshift(n, bits) end

---Logical shift right: zeros come in.
---@deprecated Use `bit32.rshift`.
---@param n integer
---@param bits integer
---@return integer
function bit.blogic_rshift(n, bits) end

---@deprecated Use `bit32.bxor`.
---@param m integer
---@param n integer
---@return integer
function bit.bxor(m, n) end

---@deprecated Use `bit32.bor`.
---@param m integer
---@param n integer
---@return integer
function bit.bor(m, n) end

---@deprecated Use `bit32.band`.
---@param m integer
---@param n integer
---@return integer
function bit.band(m, n) end

---@deprecated Use `bit32.bnot`.
---@param n integer
---@return integer
function bit.bnot(n) end

---Lua 5.3's UTF-8 library. CC:Tweaked has had it since 1.87.0.
---@class cc.utf8
---@field charpattern string The pattern that matches one UTF-8 character.
utf8 = {}

---The characters with these code points, as one string.
---@param ... integer
---@return string
function utf8.char(...) end

---Iterate over the characters of a string: `for position, codepoint in utf8.codes(s) do`.
---@param s string
---@return fun(s: string, i: integer): integer, integer
---@return string
---@return integer
function utf8.codes(s) end

---The code points of the characters from byte `i` to byte `j`.
---@param s string
---@param i? integer Default 1.
---@param j? integer Default `i`.
---@return integer ...
function utf8.codepoint(s, i, j) end

---How many characters are between byte `i` and byte `j`. Nil and the position of the first bad byte when the string
---is not valid UTF-8.
---@param s string
---@param i? integer Default 1.
---@param j? integer Default -1.
---@return integer? length
---@return integer? badPosition
function utf8.len(s, i, j) end

---The byte position where character `n` starts, counted from byte `i`.
---@param s string
---@param n integer
---@param i? integer
---@return integer? position
function utf8.offset(s, n, i) end

---Lua 5.3's string.pack: values as a binary string (`">I2"`, `"<i4"`, `"z"` ...).
---@param fmt string
---@param ... string|number
---@return string
function string.pack(fmt, ...) end

---The size of what `string.pack` makes with a format that has no variable-length parts.
---@param fmt string
---@return integer
function string.packsize(fmt) end

---Lua 5.3's string.unpack: read values out of a binary string. Returns them, then the position after the last.
---@param fmt string
---@param s string
---@param pos? integer Default 1.
---@return any ...
function string.unpack(fmt, s, pos) end

---Lua 5.1's base-10 logarithm. `math.log(x, 10)` is the same and stays.
---@deprecated Lua 5.1 only; use `math.log(x, 10)`.
---@param x number
---@return number
function math.log10(x) end

---Lua 5.1's name for `#list`.
---@deprecated Use `#list`.
---@param list table
---@return integer
function table.getn(list) end

---Lua 5.1's largest positive number key of a table.
---@deprecated Lua 5.1 only.
---@param list table
---@return number
function table.maxn(list) end

---Lua 5.3's table.move: copy `a1[f..e]` to `a2[t..]`.
---
---**Not in CC:Tweaked 1.101.3** (Lua 5.1).
---@generic T
---@param a1 T[]
---@param f integer
---@param e integer
---@param t integer
---@param a2? T[] Default `a1`.
---@return T[] a2
function table.move(a1, f, e, t, a2) end

---Whether the running coroutine can yield.
---
---**Not in CC:Tweaked 1.101.3** (Lua 5.1).
---@return boolean
function coroutine.isyieldable() end
