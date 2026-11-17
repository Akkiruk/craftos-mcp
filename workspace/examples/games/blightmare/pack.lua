-- pack.lua
-- Part of the craftos-mcp examples (MIT).
-- Opens blightmare.pak, the installed game's modules packed small enough for a computer's disk (build.mjs makes it), and
-- lets require load them from it. The game is about 2 MB of Lua, most of it story; a computer holds 1 MB. Each module is
-- kept with its comments and indents taken out (every line stays where it was, so an error's line number is the
-- source's) and squeezed with DEFLATE (RFC 1951), which this file undoes: a plain decoder in Lua, nothing else needed.
--
-- The .pak file: a text index, one module a line as "name<TAB>packed bytes<TAB>source bytes", an empty line, then each
-- module's DEFLATE data one after another, in the index's order.

local M = {}

local byte, char, concat, floor, min = string.byte, string.char, table.concat, math.floor, math.min
local unpack = table.unpack or unpack

local P = {} -- powers of two
for i = 0, 48 do P[i] = 2 ^ i end

local LEN_BASE = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 }
local LEN_EXTRA = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 }
local DIST_BASE = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577 }
local DIST_EXTRA = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 }
local ORDER = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 }
local FAST = 10        -- codes this long or shorter decode with one look-up; longer ones (rare) a bit at a time
local FAST_SIZE = P[FAST]

--- A Huffman code from the code length of each symbol (lengths[0..n-1]): canonical, as DEFLATE builds them. sym and len
--- are the look-up table, indexed by the next FAST bits of the stream; count and symbols decode the long codes.
local function code(lengths, n)
  local count, offs, symbols, sym, len = {}, {}, {}, {}, {}
  for l = 0, 15 do count[l] = 0 end
  for s = 0, n - 1 do
    local l = lengths[s] or 0
    count[l] = count[l] + 1
  end
  count[0] = 0
  offs[1] = 0
  for l = 1, 14 do offs[l + 1] = offs[l] + count[l] end
  local first, c = {}, 0
  for l = 1, 15 do
    c = (c + count[l - 1]) * 2
    first[l] = c
  end
  -- each code of length l has its number, first[l], first[l] + 1, ... in symbol order
  local next = {}
  for l = 1, 15 do next[l] = first[l] end
  for s = 0, n - 1 do
    local l = lengths[s] or 0
    if l > 0 then
      symbols[offs[l]] = s
      offs[l] = offs[l] + 1
      local cd = next[l]
      next[l] = cd + 1
      if l <= FAST then
        -- the stream gives a code's bits first to last, low bit first: the table is indexed by the code reversed
        local rev = 0
        for _ = 1, l do
          rev = rev * 2 + cd % 2
          cd = floor(cd / 2)
        end
        local step = P[l]
        for i = rev, FAST_SIZE - 1, step do
          sym[i] = s
          len[i] = l
        end
      end
    end
  end
  return { count = count, symbols = symbols, sym = sym, len = len }
end

local FIXED_LIT, FIXED_DIST
do
  local lengths = {}
  for i = 0, 143 do lengths[i] = 8 end
  for i = 144, 255 do lengths[i] = 9 end
  for i = 256, 279 do lengths[i] = 7 end
  for i = 280, 287 do lengths[i] = 8 end
  FIXED_LIT = code(lengths, 288)
  local dist = {}
  for i = 0, 29 do dist[i] = 5 end
  FIXED_DIST = code(dist, 30)
end

--- A long code, a bit at a time (puff's way). buf holds at least 15 bits.
local function slow(h, buf, cnt)
  local count, cd, first, index = h.count, 0, 0, 0
  for l = 1, 15 do
    local bit = buf % 2
    buf = (buf - bit) / 2
    cnt = cnt - 1
    cd = cd + bit
    local c = count[l]
    if cd - c < first then return h.symbols[index + (cd - first)], buf, cnt end
    index = index + c
    first = (first + c) * 2
    cd = cd * 2
  end
  error("bad DEFLATE data", 0)
end

--- One block's codes, to its end. Everything the loop touches is a local: this is where the time goes.
local function codes(data, pos, buf, cnt, out, n, lit, dist)
  local lsym, llen, dsym, dlen = lit.sym, lit.len, dist.sym, dist.len
  while true do
    if cnt < 24 then
      local a, b, c = byte(data, pos, pos + 2)
      buf = buf + (a or 0) * P[cnt] + (b or 0) * P[cnt + 8] + (c or 0) * P[cnt + 16]
      pos, cnt = pos + 3, cnt + 24
    end
    local i = buf % FAST_SIZE
    local l, s = llen[i], nil
    if l then
      s = lsym[i]
      buf = (buf - buf % P[l]) / P[l]
      cnt = cnt - l
    else
      s, buf, cnt = slow(lit, buf, cnt)
    end
    if s < 256 then
      n = n + 1
      out[n] = s
    elseif s == 256 then
      return pos, buf, cnt, n
    else
      s = s - 256
      local extra = LEN_EXTRA[s]
      local length = LEN_BASE[s]
      if extra > 0 then
        local v = buf % P[extra]
        buf, cnt = (buf - v) / P[extra], cnt - extra
        length = length + v
      end
      if cnt < 24 then
        local a, b, c = byte(data, pos, pos + 2)
        buf = buf + (a or 0) * P[cnt] + (b or 0) * P[cnt + 8] + (c or 0) * P[cnt + 16]
        pos, cnt = pos + 3, cnt + 24
      end
      i = buf % FAST_SIZE
      l = dlen[i]
      if l then
        s = dsym[i]
        buf = (buf - buf % P[l]) / P[l]
        cnt = cnt - l
      else
        s, buf, cnt = slow(dist, buf, cnt)
      end
      s = s + 1
      extra = DIST_EXTRA[s]
      local back = DIST_BASE[s]
      if extra > 0 then
        if cnt < extra then
          local a, b = byte(data, pos, pos + 1)
          buf = buf + (a or 0) * P[cnt] + (b or 0) * P[cnt + 8]
          pos, cnt = pos + 2, cnt + 16
        end
        local v = buf % P[extra]
        buf, cnt = (buf - v) / P[extra], cnt - extra
        back = back + v
      end
      local from = n - back
      for k = 1, length do out[n + k] = out[from + k] end
      n = n + length
    end
  end
end

--- Undo DEFLATE: data from position pos (1-based) to the end of the stream. Returns the bytes as a string.
function M.inflate(data, pos)
  pos = pos or 1
  local buf, cnt = 0, 0 -- the bit buffer: cnt bits, the next one lowest
  local out, n = {}, 0

  local function bits(k)
    while cnt < k do
      buf = buf + (byte(data, pos) or 0) * P[cnt]
      pos, cnt = pos + 1, cnt + 8
    end
    local v = buf % P[k]
    buf, cnt = (buf - v) / P[k], cnt - k
    return v
  end

  local function decode(h)
    bits(0)
    while cnt < 15 do
      buf = buf + (byte(data, pos) or 0) * P[cnt]
      pos, cnt = pos + 1, cnt + 8
    end
    local i = buf % FAST_SIZE
    local l = h.len[i]
    if l then
      buf, cnt = (buf - buf % P[l]) / P[l], cnt - l
      return h.sym[i]
    end
    local s
    s, buf, cnt = slow(h, buf, cnt)
    return s
  end

  repeat
    local last = bits(1)
    local kind = bits(2)
    if kind == 0 then
      -- to the byte: the bits left in this one are padding, and whole bytes already in the buffer go back
      pos = pos - floor(cnt / 8)
      buf, cnt = 0, 0
      local lo, hi = byte(data, pos, pos + 1)
      local size = lo + hi * 256
      pos = pos + 4
      for i = 0, size - 1 do out[n + 1 + i] = byte(data, pos + i) end
      n, pos = n + size, pos + size
    elseif kind == 1 then
      pos, buf, cnt, n = codes(data, pos, buf, cnt, out, n, FIXED_LIT, FIXED_DIST)
    elseif kind == 2 then
      local nlen, ndist, ncode = bits(5) + 257, bits(5) + 1, bits(4) + 4
      local lengths = {}
      for i = 1, 19 do lengths[ORDER[i]] = 0 end
      for i = 1, ncode do lengths[ORDER[i]] = bits(3) end
      local lencode = code(lengths, 19)
      local all, i = {}, 0
      while i < nlen + ndist do
        local s = decode(lencode)
        if s < 16 then
          all[i] = s
          i = i + 1
        else
          local rep, value = 0, 0
          if s == 16 then
            value, rep = all[i - 1], 3 + bits(2)
          elseif s == 17 then
            rep = 3 + bits(3)
          else
            rep = 11 + bits(7)
          end
          for _ = 1, rep do
            all[i] = value
            i = i + 1
          end
        end
      end
      local lit, dist = {}, {}
      for k = 0, nlen - 1 do lit[k] = all[k] end
      for k = 0, ndist - 1 do dist[k] = all[nlen + k] end
      pos, buf, cnt, n = codes(data, pos, buf, cnt, out, n, code(lit, nlen), code(dist, ndist))
    else
      error("bad DEFLATE block", 0)
    end
  until last == 1

  local parts = {}
  for i = 1, n, 4096 do parts[#parts + 1] = char(unpack(out, i, min(n, i + 4095))) end
  return concat(parts)
end

--- Open a .pak and teach this program's require (pkg is its package table, env its environment) to load from it.
--- Returns the module names.
function M.open(path, pkg, env)
  local h = fs.open(path, "rb")
  if not h then error("can't open " .. path, 0) end
  local data = h.readAll()
  h.close()
  local index, names, at = {}, {}, 1
  while true do
    local eol = data:find("\n", at, true)
    local line = data:sub(at, eol - 1)
    at = eol + 1
    if line == "" then break end
    local name, packed = line:match("^([^\t]+)\t(%d+)")
    names[#names + 1] = name
    index[name] = { size = tonumber(packed) }
  end
  for _, name in ipairs(names) do
    index[name].at = at
    at = at + index[name].size
  end
  local loaders = pkg.loaders or pkg.searchers
  table.insert(loaders, 2, function(name)
    local entry = index[name]
    if not entry then return nil end
    local source = M.inflate(data:sub(entry.at, entry.at + entry.size - 1))
    local fn, err = load(source, "@" .. name:gsub("%.", "/") .. ".lua", "t", env or _ENV)
    if not fn then error(err, 0) end
    return fn, name
  end)
  return names
end

return M
