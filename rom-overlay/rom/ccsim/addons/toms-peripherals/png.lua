-- PNG for the GPU's decodeImage and saveImage. On Forge the mod reads and writes images through Minecraft's
-- NativeImage (util/NativeImageIO), which is LWJGL 3.2.2's stb: stb_image to read (always as RGBA), and
-- stb_image_write's PNG writer (its own filter choice and fixed-Huffman deflate, compression level 8) to write.
-- Both are followed here: decode gives what stbi_load gives with 4 channels, encode gives stb's bytes.
-- Only PNG is read; stb's other formats (JPEG, BMP, GIF, TGA, ...) are not simulated (docs/toms-peripherals.md).
return function()
  local M = {}
  local band, bor, bxor, lshift, rshift = bit32.band, bit32.bor, bit32.bxor, bit32.lshift, bit32.rshift
  local char, floor = string.char, math.floor

  -- ===== inflate (zlib) =====

  -- LWJGL builds stb with STBI_FAILURE_USERMSG: stbi_failure_reason gives the long message of stbi__err(x, y)
  local LONG = {
    ["unknown image type"] = "Image not of any known type, or corrupt",
    ["too large"] = "Very large image (corrupt?)",
    ["1/2/4/8/16-bit only"] = "PNG not supported: 1/2/4/8/16-bit only",
    ["unknown chunk"] = "PNG not supported: unknown PNG chunk type",
  }
  local function fail(msg) error({ png = LONG[msg] or "Corrupt PNG", short = msg }, 0) end

  local LBASE = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 }
  local LEXT = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 }
  local DBASE = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 }
  local DEXT = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 }
  local CLORDER = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 }

  --- Canonical Huffman decoding table: counts per length, symbols by code.
  local function huffman(lengths, n)
    local count, offs, symbols = {}, {}, {}
    for i = 0, 15 do count[i] = 0 end
    for i = 0, n - 1 do count[lengths[i] or 0] = count[lengths[i] or 0] + 1 end
    count[0] = 0
    offs[1] = 0
    for i = 1, 14 do offs[i + 1] = offs[i] + count[i] end
    for i = 0, n - 1 do
      local l = lengths[i] or 0
      if l ~= 0 then symbols[offs[l]] = i; offs[l] = offs[l] + 1 end
    end
    return { count = count, symbols = symbols }
  end

  local fixedLit, fixedDist
  do
    local l = {}
    for i = 0, 143 do l[i] = 8 end
    for i = 144, 255 do l[i] = 9 end
    for i = 256, 279 do l[i] = 7 end
    for i = 280, 287 do l[i] = 8 end
    fixedLit = huffman(l, 288)
    local d = {}
    for i = 0, 29 do d[i] = 5 end
    fixedDist = huffman(d, 30)
  end

  --- zlib stream (a list of bytes, 1-based) -> list of bytes
  function M.inflate(src)
    local pos, bitbuf, bitcnt = 1, 0, 0
    local n = #src
    local function bits(need)
      while bitcnt < need do
        if pos > n then fail("outofdata") end
        bitbuf = bitbuf + lshift(src[pos], bitcnt)
        pos = pos + 1
        bitcnt = bitcnt + 8
      end
      local v = band(bitbuf, lshift(1, need) - 1)
      bitbuf = rshift(bitbuf, need)
      bitcnt = bitcnt - need
      return v
    end
    local function decode(h)
      local code, first, index = 0, 0, 0
      for len = 1, 15 do
        code = bor(code, bits(1))
        local c = h.count[len]
        if code - c < first then return h.symbols[index + (code - first)] end
        index = index + c
        first = (first + c) * 2
        code = code * 2
      end
      fail("bad huffman code")
    end
    if n < 2 then fail("outofdata") end
    local cmf, flg = src[1], src[2]
    if (cmf * 256 + flg) % 31 ~= 0 then fail("bad zlib header") end
    if band(flg, 32) ~= 0 then fail("no preset dict") end
    if band(cmf, 15) ~= 8 then fail("bad compression") end
    pos = 3
    local out, o = {}, 0
    repeat
      local final = bits(1)
      local typ = bits(2)
      if typ == 0 then
        bitbuf, bitcnt = 0, 0
        if pos + 3 > n then fail("outofdata") end
        local len = src[pos] + src[pos + 1] * 256
        local nlen = src[pos + 2] + src[pos + 3] * 256
        if len ~= bxor(nlen, 0xFFFF) then fail("zlib corrupt") end
        pos = pos + 4
        if pos + len - 1 > n then fail("read past buffer") end
        for i = 0, len - 1 do o = o + 1; out[o] = src[pos + i] end
        pos = pos + len
      elseif typ == 3 then
        fail("bad zlib header")
      else
        local lit, dist
        if typ == 1 then
          lit, dist = fixedLit, fixedDist
        else
          local hlit = bits(5) + 257
          local hdist = bits(5) + 1
          local hclen = bits(4) + 4
          local cl = {}
          for i = 1, hclen do cl[CLORDER[i]] = bits(3) end
          local clh = huffman(cl, 19)
          local lengths, i = {}, 0
          while i < hlit + hdist do
            local sym = decode(clh)
            if sym < 16 then
              lengths[i] = sym; i = i + 1
            else
              local rep, val = 0, 0
              if sym == 16 then
                if i == 0 then fail("bad codelengths") end
                val = lengths[i - 1]; rep = 3 + bits(2)
              elseif sym == 17 then rep = 3 + bits(3)
              else rep = 11 + bits(7) end
              if i + rep > hlit + hdist then fail("bad codelengths") end
              for _ = 1, rep do lengths[i] = val; i = i + 1 end
            end
          end
          local ll, dl = {}, {}
          for k = 0, hlit - 1 do ll[k] = lengths[k] end
          for k = 0, hdist - 1 do dl[k] = lengths[hlit + k] end
          lit, dist = huffman(ll, hlit), huffman(dl, hdist)
        end
        while true do
          local sym = decode(lit)
          if sym < 256 then
            o = o + 1; out[o] = sym
          elseif sym == 256 then
            break
          else
            sym = sym - 257
            if sym >= 29 then fail("bad huffman code") end
            local len = LBASE[sym + 1] + bits(LEXT[sym + 1])
            local ds = decode(dist)
            if ds >= 30 then fail("bad huffman code") end
            local d = DBASE[ds + 1] + bits(DEXT[ds + 1])
            if d > o then fail("bad dist") end
            for _ = 1, len do o = o + 1; out[o] = out[o - d] end
          end
        end
      end
    until final == 1
    return out
  end

  -- ===== stb_image PNG reader =====

  local SIG = { 137, 80, 78, 71, 13, 10, 26, 10 }
  local function u32(b, p) return (((b[p] or 0) * 256 + (b[p + 1] or 0)) * 256 + (b[p + 2] or 0)) * 256 + (b[p + 3] or 0) end

  --- stb's reader hands back zeros past the end of the data, so a cut file reads as chunks of type 0
  local function chunks(b)
    for i = 1, 8 do if b[i] ~= SIG[i] then return nil end end
    local p = 9
    return function()
      local len = u32(b, p)
      local typ = char(b[p + 4] or 0, b[p + 5] or 0, b[p + 6] or 0, b[p + 7] or 0)
      local start = p + 8
      p = start + len + 4
      return typ, start, len
    end
  end

  --- Walk the chunks as stbi__parse_png_file does; header = stop where stbi_info stops (first IDAT or tRNS).
  local function parse(b, header)
    local next = chunks(b)
    if not next then fail("unknown image type") end
    local first, hdr, pal, palLen, tc, hasTrans, idat = true, nil, nil, 0, nil, false, {}
    local palImgN = 0
    while true do
      local typ, s, len = next()
      if typ == "IHDR" then
        if not first then fail("multiple IHDR") end
        if len ~= 13 then fail("bad IHDR len") end
        local w, h = u32(b, s), u32(b, s + 4)
        if w > 16777216 or h > 16777216 then fail("too large") end
        local depth, color, comp, filter, interlace =
          b[s + 8] or 0, b[s + 9] or 0, b[s + 10] or 0, b[s + 11] or 0, b[s + 12] or 0
        if depth ~= 1 and depth ~= 2 and depth ~= 4 and depth ~= 8 and depth ~= 16 then fail("1/2/4/8/16-bit only") end
        if color > 6 then fail("bad ctype") end
        if color == 3 and depth == 16 then fail("bad ctype") end
        if color == 3 then palImgN = 3 elseif band(color, 1) ~= 0 then fail("bad ctype") end
        if comp ~= 0 then fail("bad comp method") end
        if filter ~= 0 then fail("bad filter method") end
        if interlace > 1 then fail("bad interlace method") end
        if w == 0 or h == 0 then fail("0-pixel image") end
        local n = palImgN == 0 and ((band(color, 2) ~= 0 and 3 or 1) + (band(color, 4) ~= 0 and 1 or 0)) or 1
        hdr = { w = w, h = h, depth = depth, color = color, interlace = interlace, n = n }
        first = false
      elseif typ == "CgBI" and first then
        first = false -- iPhone PNG: stb un-premultiplies, not simulated
      elseif typ == "PLTE" then
        if first then fail("first not IHDR") end
        if len > 256 * 3 then fail("invalid PLTE") end
        palLen = floor(len / 3)
        if palLen * 3 ~= len then fail("invalid PLTE") end
        pal = {}
        for i = 0, palLen - 1 do
          pal[i] = { b[s + i * 3], b[s + i * 3 + 1], b[s + i * 3 + 2], 255 }
        end
      elseif typ == "tRNS" then
        if first then fail("first not IHDR") end
        if #idat > 0 then fail("tRNS after IDAT") end
        if palImgN ~= 0 then
          if header then return hdr end
          if palLen == 0 then fail("tRNS before PLTE") end
          if len > palLen then fail("bad tRNS len") end
          palImgN = 4
          for i = 0, len - 1 do pal[i][4] = b[s + i] end
        else
          if band(hdr.n, 1) == 0 then fail("tRNS with alpha") end
          if len ~= hdr.n * 2 then fail("bad tRNS len") end
          hasTrans = true
          if header then return hdr end
          tc = {}
          local scale = ({ [1] = 0xff, [2] = 0x55, [4] = 0x11, [8] = 1, [16] = 1 })[hdr.depth]
          for k = 0, hdr.n - 1 do
            local v = b[s + k * 2] * 256 + b[s + k * 2 + 1]
            if hdr.depth == 16 then tc[k] = v else tc[k] = band(v, 255) * scale end
          end
        end
      elseif typ == "IDAT" then
        if first then fail("first not IHDR") end
        if palImgN ~= 0 and palLen == 0 then fail("no PLTE") end
        if header then return hdr end
        if s + len - 1 > #b then fail("outofdata") end
        for i = s, s + len - 1 do idat[#idat + 1] = b[i] end
      elseif typ == "IEND" then
        if first then fail("first not IHDR") end
        if header then return hdr end
        if #idat == 0 then fail("no IDAT") end
        return hdr, idat, pal, palImgN, tc, hasTrans
      else
        if first then fail("first not IHDR") end
        if band(b[s - 4] or 0, 32) == 0 then fail("unknown chunk") end -- a critical chunk stb does not know
      end
    end
  end

  local function paeth(a, b, c)
    local p = a + b - c
    local pa, pb, pc = math.abs(p - a), math.abs(p - b), math.abs(p - c)
    if pa <= pb and pa <= pc then return a end
    if pb <= pc then return b end
    return c
  end

  --- Unfilter one (sub)image: returns rows of samples (each sample a 0-255 or 0-65535 value per channel).
  local function unfilter(raw, rp, w, h, n, depth, out, place)
    local bpp = math.max(1, floor(n * depth / 8)) -- bytes per complete pixel, for the filters
    local stride = floor((w * n * depth + 7) / 8)
    local prev = {}
    for i = 1, stride do prev[i] = 0 end
    for y = 0, h - 1 do
      local ft = raw[rp]
      if ft == nil then fail("not enough pixels") end
      if ft > 4 then fail("invalid filter") end
      rp = rp + 1
      local cur = {}
      for i = 1, stride do
        local x = raw[rp + i - 1]
        if x == nil then fail("not enough pixels") end
        local a = i > bpp and cur[i - bpp] or 0
        local bb = prev[i]
        local c = i > bpp and prev[i - bpp] or 0
        if ft == 1 then x = x + a
        elseif ft == 2 then x = x + bb
        elseif ft == 3 then x = x + floor((a + bb) / 2)
        elseif ft == 4 then x = x + paeth(a, bb, c) end
        cur[i] = x % 256
      end
      rp = rp + stride
      -- samples
      local samples = {}
      if depth == 8 then
        for i = 1, w * n do samples[i] = cur[i] end
      elseif depth == 16 then
        for i = 1, w * n do samples[i] = cur[i * 2 - 1] * 256 + cur[i * 2] end
      else
        local per = 8 / depth
        local mask = lshift(1, depth) - 1
        for i = 0, w * n - 1 do
          local byte = cur[floor(i / per) + 1]
          local shift = 8 - depth * (i % per + 1)
          samples[i + 1] = band(rshift(byte, shift), mask)
        end
      end
      place(y, samples)
      prev = cur
    end
    return rp
  end

  local DEPTH_SCALE = { [1] = 0xff, [2] = 0x55, [4] = 0x11 }

  --- Full decode: { w, h, data = ARGB Java ints, 1-based }, or nil and stb's failure reason.
  function M.decode(bytes)
    local ok, a, b = pcall(function()
      local hdr, idat, pal, palImgN, tc, hasTrans = parse(bytes, false)
      local raw = M.inflate(idat)
      local w, h, n, depth = hdr.w, hdr.h, hdr.n, hdr.depth
      local data = {}
      local function put(x, y, samples, i)
        local r, g, bl, al
        if palImgN ~= 0 then
          local e = pal[samples[i]]
          if e == nil then e = { 0, 0, 0, 255 } end -- stb reads the zeroed palette past its end
          r, g, bl, al = e[1], e[2], e[3], palImgN == 4 and e[4] or 255
        else
          local s = {}
          for k = 0, n - 1 do s[k] = samples[i + k] end
          local full = depth == 16 and 65535 or 255
          if depth < 8 then for k = 0, n - 1 do s[k] = s[k] * DEPTH_SCALE[depth] end end
          local alpha
          if n == 1 or n == 3 then
            alpha = full
            if hasTrans then
              local same = true
              for k = 0, n - 1 do if s[k] ~= tc[k] then same = false end end
              if same then alpha = 0 end
            end
          end
          if n == 1 then r, g, bl, al = s[0], s[0], s[0], alpha
          elseif n == 2 then r, g, bl, al = s[0], s[0], s[0], s[1]
          elseif n == 3 then r, g, bl, al = s[0], s[1], s[2], alpha
          else r, g, bl, al = s[0], s[1], s[2], s[3] end
          if depth == 16 then
            r, g, bl, al = rshift(r, 8), rshift(g, 8), rshift(bl, 8), rshift(al, 8)
          end
        end
        local v = ((al * 256 + r) * 256 + g) * 256 + bl
        if v >= 2147483648 then v = v - 4294967296 end
        data[y * w + x + 1] = v
      end
      if hdr.interlace == 0 then
        local used = unfilter(raw, 1, w, h, n, depth, nil, function(y, samples)
          for x = 0, w - 1 do put(x, y, samples, x * n + 1) end
        end)
        if used - 1 > #raw then fail("not enough pixels") end -- stb allows extra data after the rows
      else
        local XO, YO = { 0, 4, 0, 2, 0, 1, 0 }, { 0, 0, 4, 0, 2, 0, 1 }
        local XS, YS = { 8, 8, 4, 4, 2, 2, 1 }, { 8, 8, 8, 4, 4, 2, 2 }
        local rp = 1
        for p = 1, 7 do
          local pw = floor((w - XO[p] + XS[p] - 1) / XS[p])
          local ph = floor((h - YO[p] + YS[p] - 1) / YS[p])
          if pw > 0 and ph > 0 then
            rp = unfilter(raw, rp, pw, ph, n, depth, nil, function(y, samples)
              for x = 0, pw - 1 do put(x * XS[p] + XO[p], y * YS[p] + YO[p], samples, x * n + 1) end
            end)
          end
        end
      end
      return { w = w, h = h, data = data }
    end)
    if ok then return a end
    return nil, type(a) == "table" and a.png or tostring(a)
  end

  --- stbi_info: width and height, or nil, nil and the failure reason.
  function M.info(bytes)
    local ok, hdr = pcall(parse, bytes, true)
    if not ok then return nil, nil, type(hdr) == "table" and hdr.png or tostring(hdr) end
    return hdr.w, hdr.h
  end

  -- ===== stb_image_write PNG writer =====

  local CRC = {}
  for i = 0, 255 do
    local c = i
    for _ = 1, 8 do
      if band(c, 1) ~= 0 then c = bxor(0xEDB88320, rshift(c, 1)) else c = rshift(c, 1) end
    end
    CRC[i] = c
  end
  local function crc32(t, from, to)
    local c = 0xFFFFFFFF
    for i = from, to do c = bxor(CRC[band(bxor(c, t[i]), 0xFF)], rshift(c, 8)) end
    return bxor(c, 0xFFFFFFFF)
  end

  local function bitrev(code, codebits)
    local res = 0
    for _ = 1, codebits do
      res = bor(lshift(res, 1), band(code, 1))
      code = rshift(code, 1)
    end
    return res
  end

  local function zhash(d, i)
    local hash = d[i] + d[i + 1] * 256 + d[i + 2] * 65536
    hash = bxor(hash, lshift(hash, 3))
    hash = (hash + rshift(hash, 5)) % 4294967296
    hash = bxor(hash, lshift(hash, 4))
    hash = (hash + rshift(hash, 17)) % 4294967296
    hash = bxor(hash, lshift(hash, 25))
    hash = (hash + rshift(hash, 6)) % 4294967296
    return hash
  end

  local LENGTHC = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 259 }
  local LENGTHEB = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 }
  local DISTC = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 32768 }
  local DISTEB = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 }

  --- stbi_zlib_compress (stb_image_write 1.13, as in LWJGL 3.2.2): fixed Huffman, hash chains, lazy matching.
  --- data is 0-based.
  local function zlibCompress(data, len, quality)
    local out, on = { 0x78, 0x5e }, 2
    local bitbuf, bitcount = 0, 0
    local function add(code, codebits)
      bitbuf = bor(bitbuf, lshift(code, bitcount))
      bitcount = bitcount + codebits
      while bitcount >= 8 do
        on = on + 1; out[on] = band(bitbuf, 0xFF)
        bitbuf = rshift(bitbuf, 8)
        bitcount = bitcount - 8
      end
    end
    local function huff(n)
      if n <= 143 then add(bitrev(0x30 + n, 8), 8)
      elseif n <= 255 then add(bitrev(0x190 + n - 144, 9), 9)
      elseif n <= 279 then add(bitrev(n - 256, 7), 7)
      else add(bitrev(0xc0 + n - 280, 8), 8) end
    end
    if quality < 5 then quality = 5 end
    add(1, 1)
    add(1, 2)
    local hash = {}
    local function countm(a, b, limit)
      local i = 0
      while i < limit and i < 258 do
        if data[a + i] ~= data[b + i] then break end
        i = i + 1
      end
      return i
    end
    local i = 0
    while i < len - 3 do
      local h = band(zhash(data, i), 16383)
      local best, bestloc = 3, nil
      local hlist = hash[h]
      if hlist then
        for j = 1, #hlist do
          if hlist[j] > i - 32768 then
            local d = countm(hlist[j], i, len - i)
            if d >= best then best = d; bestloc = hlist[j] end
          end
        end
      end
      if hlist and #hlist == 2 * quality then
        local kept = {}
        for j = quality + 1, 2 * quality do kept[#kept + 1] = hlist[j] end
        hash[h] = kept
        hlist = kept
      end
      if not hlist then hlist = {}; hash[h] = hlist end
      hlist[#hlist + 1] = i
      if bestloc then
        local h2 = band(zhash(data, i + 1), 16383)
        local hl2 = hash[h2]
        if hl2 then
          for j = 1, #hl2 do
            if hl2[j] > i - 32767 then
              local e = countm(hl2[j], i + 1, len - i - 1)
              if e > best then bestloc = nil; break end
            end
          end
        end
      end
      if bestloc then
        local d = i - bestloc
        local j = 1
        while best > LENGTHC[j + 1] - 1 do j = j + 1 end
        huff(j - 1 + 257)
        if LENGTHEB[j] ~= 0 then add(best - LENGTHC[j], LENGTHEB[j]) end
        j = 1
        while d > DISTC[j + 1] - 1 do j = j + 1 end
        add(bitrev(j - 1, 5), 5)
        if DISTEB[j] ~= 0 then add(d - DISTC[j], DISTEB[j]) end
        i = i + best
      else
        huff(data[i])
        i = i + 1
      end
    end
    while i < len do huff(data[i]); i = i + 1 end
    huff(256)
    while bitcount ~= 0 do add(0, 1) end
    -- adler32
    local s1, s2 = 1, 0
    local blocklen = len % 5552
    local j = 0
    while j < len do
      for k = 0, blocklen - 1 do s1 = s1 + data[j + k]; s2 = s2 + s1 end
      s1, s2 = s1 % 65521, s2 % 65521
      j = j + blocklen
      blocklen = 5552
    end
    out[on + 1] = rshift(s2, 8); out[on + 2] = band(s2, 0xFF)
    out[on + 3] = rshift(s1, 8); out[on + 4] = band(s1, 0xFF)
    return out
  end

  local function spaeth(a, b, c)
    local p = a + b - c
    local pa, pb, pc = math.abs(p - a), math.abs(p - b), math.abs(p - c)
    if pa <= pb and pa <= pc then return a end
    if pb <= pc then return b end
    return c
  end

  --- stbi_write_png_to_mem for an RGBA image (NativeImage.asByteArray). img: { w, h, get(x, y) -> ARGB int }.
  function M.encode(img)
    local x, y, n = img.w, img.h, 4
    local stride = x * n
    local px = {} -- 0-based RGBA bytes
    for yy = 0, y - 1 do
      for xx = 0, x - 1 do
        local c = img.get(xx, yy) % 4294967296
        local o = (yy * x + xx) * 4
        px[o] = band(rshift(c, 16), 255)
        px[o + 1] = band(rshift(c, 8), 255)
        px[o + 2] = band(c, 255)
        px[o + 3] = rshift(c, 24)
      end
    end
    local MAP, FIRST = { [0] = 0, 1, 2, 3, 4 }, { [0] = 0, 1, 0, 5, 6 }
    local line = {}
    local function encodeLine(j, filterType)
      local typ = (j ~= 0 and MAP or FIRST)[filterType]
      local z = stride * j
      if typ == 0 then
        for i = 0, stride - 1 do line[i] = px[z + i] end
        return
      end
      for i = 0, n - 1 do
        local v = px[z + i]
        if typ == 2 then v = v - px[z + i - stride]
        elseif typ == 3 then v = v - rshift(px[z + i - stride], 1)
        elseif typ == 4 then v = v - spaeth(0, px[z + i - stride], 0) end
        line[i] = v % 256
      end
      for i = n, stride - 1 do
        local v = px[z + i]
        if typ == 1 then v = v - px[z + i - n]
        elseif typ == 2 then v = v - px[z + i - stride]
        elseif typ == 3 then v = v - rshift(px[z + i - n] + px[z + i - stride], 1)
        elseif typ == 4 then v = v - spaeth(px[z + i - n], px[z + i - stride], px[z + i - stride - n])
        elseif typ == 5 then v = v - rshift(px[z + i - n], 1)
        elseif typ == 6 then v = v - spaeth(px[z + i - n], 0, 0) end
        line[i] = v % 256
      end
    end
    local filt, fl = {}, 0
    for j = 0, y - 1 do
      local best, bestVal = 0, 0x7fffffff
      for ft = 0, 4 do
        encodeLine(j, ft)
        local est = 0
        for i = 0, stride - 1 do
          local v = line[i]
          est = est + (v >= 128 and 256 - v or v)
        end
        if est < bestVal then bestVal = est; best = ft end
      end
      encodeLine(j, best)
      filt[fl] = best; fl = fl + 1
      for i = 0, stride - 1 do filt[fl] = line[i]; fl = fl + 1 end
    end
    local z = zlibCompress(filt, fl, 8)
    local o = { 137, 80, 78, 71, 13, 10, 26, 10 }
    local function p32(v) o[#o + 1] = band(rshift(v, 24), 255); o[#o + 1] = band(rshift(v, 16), 255); o[#o + 1] = band(rshift(v, 8), 255); o[#o + 1] = band(v, 255) end
    local function chunk(tag, body)
      p32(#body)
      local start = #o + 1
      for i = 1, 4 do o[#o + 1] = tag:byte(i) end
      for i = 1, #body do o[#o + 1] = body[i] end
      p32(crc32(o, start, #o))
    end
    local ihdr = {}
    local function b32(t, v) t[#t + 1] = band(rshift(v, 24), 255); t[#t + 1] = band(rshift(v, 16), 255); t[#t + 1] = band(rshift(v, 8), 255); t[#t + 1] = band(v, 255) end
    b32(ihdr, x); b32(ihdr, y)
    ihdr[9], ihdr[10], ihdr[11], ihdr[12], ihdr[13] = 8, 6, 0, 0, 0
    chunk("IHDR", ihdr)
    chunk("IDAT", z)
    chunk("IEND", {})
    local parts = {}
    for i = 1, #o, 4096 do parts[#parts + 1] = char(table.unpack(o, i, math.min(i + 4095, #o))) end
    return table.concat(parts)
  end

  return M
end
