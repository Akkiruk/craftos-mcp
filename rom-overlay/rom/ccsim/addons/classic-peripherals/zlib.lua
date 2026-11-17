-- ccsim classic-peripherals: java.util.zip.Deflater / Inflater as the cryptographic accelerator's deflate and inflate
-- use them (core/Compression.java in 0.6.6): a zlib stream (RFC 1950) around raw deflate (RFC 1951).
--
-- deflate is a port of zlib's deflate at the Deflater defaults (level 6: deflate_slow with good 8, lazy 16, nice 128,
-- chain 128; 15 window bits, memLevel 8, the default strategy), trees.c included, so the bytes are the ones a JVM
-- writes. Java calls it with Z_FINISH from the first call, and zlib's output does not depend on how the output buffer
-- is cut. inflate follows zlib's inflate checks (incomplete and over-subscribed codes, distances too far back, the
-- Adler-32 trailer); every failure is one message in the mod, so it only has to say yes or no.
local band, bor, bxor, lshift, rshift = bit32.band, bit32.bor, bit32.bxor, bit32.lshift, bit32.rshift
local floor, byte, char, concat = math.floor, string.byte, string.char, table.concat

local Z = {}

-- Java's zlib is native code; this port is not. Z.work is core.serverWork (see crypto.lua's C.work).
Z.work = function() end
local workCount = 0
local function work()
  workCount = workCount + 1
  if workCount >= 4096 then
    workCount = 0
    Z.work()
  end
end

local function adler32(s)
  local a, b = 1, 0
  local n = #s
  local i = 1
  while i <= n do
    local stop = math.min(n, i + 3799)
    for j = i, stop do
      a = a + byte(s, j)
      b = b + a
    end
    a, b = a % 65521, b % 65521
    i = stop + 1
  end
  return b * 65536 + a
end

-- ===== shared tables (trees.c, tr_static_init) =====

local LENGTH_CODES, LITERALS, L_CODES, D_CODES, BL_CODES = 29, 256, 286, 30, 19
local MAX_BITS, MAX_BL_BITS, END_BLOCK = 15, 7, 256
local REP_3_6, REPZ_3_10, REPZ_11_138 = 16, 17, 18
local EXTRA_LBITS = { [0] = 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 }
local EXTRA_DBITS = { [0] = 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 }
local EXTRA_BLBITS = { [0] = 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7 }
local BL_ORDER = { [0] = 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 }

local BASE_LENGTH, LENGTH_CODE, BASE_DIST, DIST_CODE = {}, {}, {}, {}
do
  local length = 0
  for code = 0, LENGTH_CODES - 2 do
    BASE_LENGTH[code] = length
    for _ = 1, 2 ^ EXTRA_LBITS[code] do
      LENGTH_CODE[length] = code
      length = length + 1
    end
  end
  LENGTH_CODE[length - 1] = LENGTH_CODES - 1
  BASE_LENGTH[LENGTH_CODES - 1] = 0
  local dist = 0
  for code = 0, 15 do
    BASE_DIST[code] = dist
    for _ = 1, 2 ^ EXTRA_DBITS[code] do
      DIST_CODE[dist] = code
      dist = dist + 1
    end
  end
  dist = floor(dist / 128)
  for code = 16, D_CODES - 1 do
    BASE_DIST[code] = dist * 128
    for _ = 1, 2 ^ (EXTRA_DBITS[code] - 7) do
      DIST_CODE[256 + dist] = code
      dist = dist + 1
    end
  end
end

local function dCode(dist)
  if dist < 256 then return DIST_CODE[dist] end
  return DIST_CODE[256 + floor(dist / 128)]
end

local function reverseBits(code, len)
  local res = 0
  for _ = 1, len do
    res = res * 2 + code % 2
    code = floor(code / 2)
  end
  return res
end

--- gen_codes: Len -> Code for codes 0..maxCode
local function genCodes(len, code, maxCode, blCount)
  local nextCode = {}
  local c = 0
  for bits = 1, MAX_BITS do
    c = (c + (blCount[bits - 1] or 0)) * 2
    nextCode[bits] = c
  end
  for n = 0, maxCode do
    local l = len[n]
    if l ~= 0 then
      code[n] = reverseBits(nextCode[l], l)
      nextCode[l] = nextCode[l] + 1
    end
  end
end

local STATIC_LLEN, STATIC_LCODE, STATIC_DLEN, STATIC_DCODE = {}, {}, {}, {}
do
  local blCount = {}
  for b = 0, MAX_BITS do blCount[b] = 0 end
  for n = 0, 287 do
    local l = n <= 143 and 8 or n <= 255 and 9 or n <= 279 and 7 or 8
    STATIC_LLEN[n] = l
    blCount[l] = blCount[l] + 1
  end
  genCodes(STATIC_LLEN, STATIC_LCODE, L_CODES + 1, blCount)
  for n = 0, D_CODES - 1 do
    STATIC_DLEN[n] = 5
    STATIC_DCODE[n] = reverseBits(n, 5)
  end
end

-- ===== deflate =====

function Z.deflate(input)
  local WSIZE, WMASK = 32768, 32767
  local HASH_BITS = 15
  local HASH_SIZE, HASH_MASK, HASH_SHIFT = 2 ^ HASH_BITS, 2 ^ HASH_BITS - 1, floor((HASH_BITS + 3 - 1) / 3)
  local MIN_MATCH, MAX_MATCH = 3, 258
  local MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1
  local MAX_DIST = WSIZE - MIN_LOOKAHEAD
  local WINDOW_SIZE = 2 * WSIZE
  local TOO_FAR = 4096
  local GOOD, LAZY, NICE, CHAIN = 8, 16, 128, 128
  local LIT_BUFSIZE = 16384
  local SYM_END = LIT_BUFSIZE - 1

  -- output bits, least significant first (send_bits)
  local out = {}
  local bitBuf, bitCount = 0, 0
  local function sendBits(value, length)
    bitBuf = bitBuf + value * 2 ^ bitCount
    bitCount = bitCount + length
    while bitCount >= 8 do
      out[#out + 1] = bitBuf % 256
      bitBuf = floor(bitBuf / 256)
      bitCount = bitCount - 8
    end
  end
  local function windup()
    if bitCount > 0 then out[#out + 1] = bitBuf % 256 end
    bitBuf, bitCount = 0, 0
  end

  local window, head, prev = {}, {}, {}
  for i = 0, WINDOW_SIZE - 1 do window[i] = 0 end
  for i = 0, HASH_SIZE - 1 do head[i] = 0 end
  for i = 0, WSIZE - 1 do prev[i] = 0 end

  local inPos, inLen = 1, #input
  local strstart, blockStart, lookahead, insert = 0, 0, 0, 0
  local matchLength, prevLength, prevMatch, matchStart, matchAvailable = MIN_MATCH - 1, MIN_MATCH - 1, 0, 0, false
  local insH = 0

  local function updateHash(h, c) return band(bxor(lshift(h, HASH_SHIFT), c), HASH_MASK) end
  local function insertString(str)
    insH = updateHash(insH, window[str + MIN_MATCH - 1])
    local matchHead = head[insH]
    prev[band(str, WMASK)] = matchHead
    head[insH] = str
    return matchHead
  end

  local function slideHash()
    for n = 0, HASH_SIZE - 1 do
      local m = head[n]
      head[n] = m >= WSIZE and m - WSIZE or 0
    end
    for n = 0, WSIZE - 1 do
      local m = prev[n]
      prev[n] = m >= WSIZE and m - WSIZE or 0
    end
  end

  local function fillWindow()
    repeat
      local more = WINDOW_SIZE - lookahead - strstart
      if strstart >= WSIZE + MAX_DIST then
        for i = 0, WSIZE - more - 1 do window[i] = window[i + WSIZE] end
        matchStart = matchStart - WSIZE
        strstart = strstart - WSIZE
        blockStart = blockStart - WSIZE
        if insert > strstart then insert = strstart end
        slideHash()
        more = more + WSIZE
      end
      if inPos > inLen then break end
      local n = math.min(more, inLen - inPos + 1)
      local base = strstart + lookahead
      for i = 0, n - 1 do window[base + i] = byte(input, inPos + i) end
      inPos = inPos + n
      lookahead = lookahead + n
      if lookahead + insert >= MIN_MATCH then
        local str = strstart - insert
        insH = window[str]
        insH = updateHash(insH, window[str + 1])
        while insert > 0 do
          insH = updateHash(insH, window[str + MIN_MATCH - 1])
          prev[band(str, WMASK)] = head[insH]
          head[insH] = str
          str = str + 1
          insert = insert - 1
          if lookahead + insert < MIN_MATCH then break end
        end
      end
    until not (lookahead < MIN_LOOKAHEAD and inPos <= inLen)
  end

  local function longestMatch(curMatch)
    local chainLength = CHAIN
    local scan = strstart
    local bestLen = prevLength
    local niceMatch = NICE
    local limit = strstart > MAX_DIST and strstart - MAX_DIST or 0
    local strend = strstart + MAX_MATCH
    local scanEnd1, scanEnd = window[scan + bestLen - 1], window[scan + bestLen]
    if prevLength >= GOOD then chainLength = floor(chainLength / 4) end
    if niceMatch > lookahead then niceMatch = lookahead end
    repeat
      local match = curMatch
      if window[match + bestLen] == scanEnd and window[match + bestLen - 1] == scanEnd1
          and window[match] == window[scan] and window[match + 1] == window[scan + 1] then
        local s, m = scan + 2, match + 2
        while s < strend and window[s] == window[m] do
          s, m = s + 1, m + 1
        end
        local len = s - scan
        if len > MAX_MATCH then len = MAX_MATCH end
        if len > bestLen then
          matchStart = curMatch
          bestLen = len
          if len >= niceMatch then break end
          scanEnd1, scanEnd = window[scan + bestLen - 1], window[scan + bestLen]
        end
      end
      curMatch = prev[band(curMatch, WMASK)]
      chainLength = chainLength - 1
    until not (curMatch > limit and chainLength ~= 0)
    if bestLen <= lookahead then return bestLen end
    return lookahead
  end

  -- the block being built (sym_buf and the frequencies)
  local syms = {} -- dist, lc pairs
  local symCount = 0
  local lFreq, dFreq, blFreq = {}, {}, {}
  local lLen, dLen, blLen = {}, {}, {}
  local lCode, dCode_, blCode = {}, {}, {}
  local optLen, staticLen = 0, 0

  local function initBlock()
    for n = 0, L_CODES - 1 do lFreq[n] = 0 end
    for n = 0, D_CODES - 1 do dFreq[n] = 0 end
    for n = 0, BL_CODES - 1 do blFreq[n] = 0 end
    lFreq[END_BLOCK] = 1
    optLen, staticLen = 0, 0
    symCount = 0
  end
  for n = 0, 2 * L_CODES do lLen[n] = 0 end
  for n = 0, 2 * D_CODES do dLen[n] = 0 end
  for n = 0, 2 * BL_CODES do blLen[n] = 0 end
  initBlock()

  local function tallyLit(c)
    syms[symCount * 2 + 1], syms[symCount * 2 + 2] = 0, c
    symCount = symCount + 1
    lFreq[c] = lFreq[c] + 1
    return symCount == SYM_END
  end
  local function tallyDist(dist, lc)
    syms[symCount * 2 + 1], syms[symCount * 2 + 2] = dist, lc
    symCount = symCount + 1
    dist = dist - 1
    local l = LENGTH_CODE[lc] + LITERALS + 1
    lFreq[l] = lFreq[l] + 1
    local d = dCode(dist)
    dFreq[d] = dFreq[d] + 1
    return symCount == SYM_END
  end

  local HEAP_SIZE = 2 * L_CODES + 1
  local heap, depth = {}, {}
  local heapLen, heapMax

  local function smaller(freq, n, m)
    return freq[n] < freq[m] or (freq[n] == freq[m] and depth[n] <= depth[m])
  end
  local function pqdownheap(freq, k)
    local v = heap[k]
    local j = k * 2
    while j <= heapLen do
      if j < heapLen and smaller(freq, heap[j + 1], heap[j]) then j = j + 1 end
      if smaller(freq, v, heap[j]) then break end
      heap[k] = heap[j]
      k = j
      j = j * 2
    end
    heap[k] = v
  end

  --- build_tree for one tree: freq, len, code, static lengths (or nil), extra bits, extra base, elems, max_length
  local function buildTree(freq, len, code, stree, extra, base, elems, maxLength)
    local dad = {}
    heapLen, heapMax = 0, HEAP_SIZE
    local maxCode = -1
    for n = 0, elems - 1 do
      if freq[n] ~= 0 then
        heapLen = heapLen + 1
        heap[heapLen] = n
        maxCode = n
        depth[n] = 0
      else
        len[n] = 0
      end
    end
    while heapLen < 2 do
      local node
      if maxCode < 2 then
        maxCode = maxCode + 1
        node = maxCode
      else
        node = 0
      end
      heapLen = heapLen + 1
      heap[heapLen] = node
      freq[node] = 1
      depth[node] = 0
      optLen = optLen - 1
      if stree then staticLen = staticLen - stree[node] end
    end
    for n = floor(heapLen / 2), 1, -1 do pqdownheap(freq, n) end
    local node = elems
    repeat
      local n = heap[1]
      heap[1] = heap[heapLen]
      heapLen = heapLen - 1
      pqdownheap(freq, 1)
      local m = heap[1]
      heapMax = heapMax - 1
      heap[heapMax] = n
      heapMax = heapMax - 1
      heap[heapMax] = m
      freq[node] = freq[n] + freq[m]
      depth[node] = (depth[n] >= depth[m] and depth[n] or depth[m]) + 1
      dad[n], dad[m] = node, node
      heap[1] = node
      node = node + 1
      pqdownheap(freq, 1)
    until heapLen < 2
    heapMax = heapMax - 1
    heap[heapMax] = heap[1]

    -- gen_bitlen
    local blCount = {}
    for b = 0, MAX_BITS do blCount[b] = 0 end
    len[heap[heapMax]] = 0
    local overflow = 0
    local h = heapMax + 1
    while h < HEAP_SIZE do
      local n = heap[h]
      local bits = len[dad[n]] + 1
      if bits > maxLength then
        bits = maxLength
        overflow = overflow + 1
      end
      len[n] = bits
      if n <= maxCode then
        blCount[bits] = blCount[bits] + 1
        local xbits = n >= base and extra[n - base] or 0
        local f = freq[n]
        optLen = optLen + f * (bits + xbits)
        if stree then staticLen = staticLen + f * (stree[n] + xbits) end
      end
      h = h + 1
    end
    if overflow > 0 then
      repeat
        local bits = maxLength - 1
        while blCount[bits] == 0 do bits = bits - 1 end
        blCount[bits] = blCount[bits] - 1
        blCount[bits + 1] = blCount[bits + 1] + 2
        blCount[maxLength] = blCount[maxLength] - 1
        overflow = overflow - 2
      until overflow <= 0
      h = HEAP_SIZE
      for bits = maxLength, 1, -1 do
        local n = blCount[bits]
        while n ~= 0 do
          h = h - 1
          local m = heap[h]
          if m <= maxCode then
            if len[m] ~= bits then
              optLen = optLen + (bits - len[m]) * freq[m]
              len[m] = bits
            end
            n = n - 1
          end
        end
      end
    end
    genCodes(len, code, maxCode, blCount)
    return maxCode
  end

  local function scanTree(len, maxCode)
    local prevlen, nextlen, count = -1, len[0], 0
    local maxCount, minCount = 7, 4
    if nextlen == 0 then maxCount, minCount = 138, 3 end
    len[maxCode + 1] = 0xffff
    for n = 0, maxCode do
      local curlen = nextlen
      nextlen = len[n + 1]
      count = count + 1
      if not (count < maxCount and curlen == nextlen) then
        if count < minCount then
          blFreq[curlen] = blFreq[curlen] + count
        elseif curlen ~= 0 then
          if curlen ~= prevlen then blFreq[curlen] = blFreq[curlen] + 1 end
          blFreq[REP_3_6] = blFreq[REP_3_6] + 1
        elseif count <= 10 then
          blFreq[REPZ_3_10] = blFreq[REPZ_3_10] + 1
        else
          blFreq[REPZ_11_138] = blFreq[REPZ_11_138] + 1
        end
        count, prevlen = 0, curlen
        if nextlen == 0 then
          maxCount, minCount = 138, 3
        elseif curlen == nextlen then
          maxCount, minCount = 6, 3
        else
          maxCount, minCount = 7, 4
        end
      end
    end
  end

  local function sendCode(c, code, len) sendBits(code[c], len[c]) end

  local function sendTree(len, maxCode)
    local prevlen, nextlen, count = -1, len[0], 0
    local maxCount, minCount = 7, 4
    if nextlen == 0 then maxCount, minCount = 138, 3 end
    for n = 0, maxCode do
      local curlen = nextlen
      nextlen = len[n + 1]
      count = count + 1
      if not (count < maxCount and curlen == nextlen) then
        if count < minCount then
          repeat
            sendCode(curlen, blCode, blLen)
            count = count - 1
          until count == 0
        elseif curlen ~= 0 then
          if curlen ~= prevlen then
            sendCode(curlen, blCode, blLen)
            count = count - 1
          end
          sendCode(REP_3_6, blCode, blLen)
          sendBits(count - 3, 2)
        elseif count <= 10 then
          sendCode(REPZ_3_10, blCode, blLen)
          sendBits(count - 3, 3)
        else
          sendCode(REPZ_11_138, blCode, blLen)
          sendBits(count - 11, 7)
        end
        count, prevlen = 0, curlen
        if nextlen == 0 then
          maxCount, minCount = 138, 3
        elseif curlen == nextlen then
          maxCount, minCount = 6, 3
        else
          maxCount, minCount = 7, 4
        end
      end
    end
  end

  local function compressBlock(ltreeCode, ltreeLen, dtreeCode, dtreeLen)
    for i = 0, symCount - 1 do
      local dist, lc = syms[i * 2 + 1], syms[i * 2 + 2]
      if dist == 0 then
        sendBits(ltreeCode[lc], ltreeLen[lc])
      else
        local code = LENGTH_CODE[lc]
        sendBits(ltreeCode[code + LITERALS + 1], ltreeLen[code + LITERALS + 1])
        local extra = EXTRA_LBITS[code]
        if extra ~= 0 then sendBits(lc - BASE_LENGTH[code], extra) end
        dist = dist - 1
        code = dCode(dist)
        sendBits(dtreeCode[code], dtreeLen[code])
        extra = EXTRA_DBITS[code]
        if extra ~= 0 then sendBits(dist - BASE_DIST[code], extra) end
      end
    end
    sendBits(ltreeCode[END_BLOCK], ltreeLen[END_BLOCK])
  end

  local function flushBlock(last)
    local storedLen = strstart - blockStart
    local lMax = buildTree(lFreq, lLen, lCode, STATIC_LLEN, EXTRA_LBITS, LITERALS + 1, L_CODES, MAX_BITS)
    local dMax = buildTree(dFreq, dLen, dCode_, STATIC_DLEN, EXTRA_DBITS, 0, D_CODES, MAX_BITS)
    -- build_bl_tree
    scanTree(lLen, lMax)
    scanTree(dLen, dMax)
    buildTree(blFreq, blLen, blCode, nil, EXTRA_BLBITS, 0, BL_CODES, MAX_BL_BITS)
    local maxBlindex = BL_CODES - 1
    while maxBlindex >= 3 do
      if blLen[BL_ORDER[maxBlindex]] ~= 0 then break end
      maxBlindex = maxBlindex - 1
    end
    optLen = optLen + 3 * (maxBlindex + 1) + 5 + 5 + 4
    local optLenb = floor((optLen + 3 + 7) / 8)
    local staticLenb = floor((staticLen + 3 + 7) / 8)
    if staticLenb <= optLenb then optLenb = staticLenb end
    local lastBit = last and 1 or 0
    if storedLen + 4 <= optLenb and blockStart >= 0 then
      sendBits(lastBit, 3) -- STORED_BLOCK << 1
      windup()
      out[#out + 1] = storedLen % 256
      out[#out + 1] = floor(storedLen / 256)
      out[#out + 1] = 255 - storedLen % 256
      out[#out + 1] = 255 - floor(storedLen / 256)
      for i = blockStart, blockStart + storedLen - 1 do out[#out + 1] = window[i] end
    elseif staticLenb == optLenb then
      sendBits(2 + lastBit, 3)
      compressBlock(STATIC_LCODE, STATIC_LLEN, STATIC_DCODE, STATIC_DLEN)
    else
      sendBits(4 + lastBit, 3)
      sendBits(lMax + 1 - 257, 5)
      sendBits(dMax + 1 - 1, 5)
      sendBits(maxBlindex + 1 - 4, 4)
      for rank = 0, maxBlindex do sendBits(blLen[BL_ORDER[rank]], 3) end
      sendTree(lLen, lMax)
      sendTree(dLen, dMax)
      compressBlock(lCode, lLen, dCode_, dLen)
    end
    initBlock()
    if last then windup() end
    blockStart = strstart
  end

  -- deflate_slow, every call with Z_FINISH
  while true do
    work()
    if lookahead < MIN_LOOKAHEAD then
      fillWindow()
      if lookahead == 0 then break end
    end
    local hashHead = 0
    if lookahead >= MIN_MATCH then hashHead = insertString(strstart) end
    prevLength, prevMatch = matchLength, matchStart
    matchLength = MIN_MATCH - 1
    if hashHead ~= 0 and prevLength < LAZY and strstart - hashHead <= MAX_DIST then
      matchLength = longestMatch(hashHead)
      if matchLength <= 5 and matchLength == MIN_MATCH and strstart - matchStart > TOO_FAR then
        matchLength = MIN_MATCH - 1
      end
    end
    if prevLength >= MIN_MATCH and matchLength <= prevLength then
      local maxInsert = strstart + lookahead - MIN_MATCH
      local bflush = tallyDist(strstart - 1 - prevMatch, prevLength - MIN_MATCH)
      lookahead = lookahead - (prevLength - 1)
      prevLength = prevLength - 2
      repeat
        strstart = strstart + 1
        if strstart <= maxInsert then insertString(strstart) end
        prevLength = prevLength - 1
      until prevLength == 0
      matchAvailable = false
      matchLength = MIN_MATCH - 1
      strstart = strstart + 1
      if bflush then flushBlock(false) end
    elseif matchAvailable then
      if tallyLit(window[strstart - 1]) then flushBlock(false) end
      strstart = strstart + 1
      lookahead = lookahead - 1
    else
      matchAvailable = true
      strstart = strstart + 1
      lookahead = lookahead - 1
    end
  end
  if matchAvailable then
    tallyLit(window[strstart - 1])
    matchAvailable = false
  end
  flushBlock(true)

  local adler = adler32(input)
  local trailer = char(floor(adler / 16777216) % 256, floor(adler / 65536) % 256, floor(adler / 256) % 256, adler % 256)
  local parts = { "\120\156" }
  for i = 1, #out, 4096 do parts[#parts + 1] = char(table.unpack(out, i, math.min(#out, i + 4095))) end
  parts[#parts + 1] = trailer
  return concat(parts)
end

-- ===== inflate =====

--- Build a decoding table from code lengths, zlib's inflate_table rules: nil when over-subscribed, or incomplete
--- unless `incompleteOk` and the only code has length 1.
local function buildDecoder(lengths, n, isCodes)
  local count = {}
  for b = 0, MAX_BITS do count[b] = 0 end
  for i = 0, n - 1 do count[lengths[i]] = count[lengths[i]] + 1 end
  local max = MAX_BITS
  while max >= 1 and count[max] == 0 do max = max - 1 end
  if max == 0 then
    -- no codes: zlib makes a table that errors when used (allowed for distances only)
    return { empty = true }
  end
  local left = 1
  for len = 1, MAX_BITS do
    left = left * 2 - count[len]
    if left < 0 then return nil end
  end
  if left > 0 and (isCodes or max ~= 1) then return nil end
  -- canonical codes: map (len, code) -> symbol
  local offs, nextCode = {}, {}
  local code = 0
  count[0] = 0
  for len = 1, MAX_BITS do
    code = (code + count[len - 1]) * 2
    nextCode[len] = code
  end
  local map = {}
  for i = 0, n - 1 do
    local l = lengths[i]
    if l ~= 0 then
      map[l * 65536 + nextCode[l]] = i
      nextCode[l] = nextCode[l] + 1
    end
  end
  return { map = map, max = max }
end

--- Inflater.inflate until finished: the bytes, or nil when Java would throw (any DataFormatException, or input that
--- ends first, or a preset dictionary).
function Z.inflate(data)
  local pos, n = 1, #data
  local bitBuf, bitCount = 0, 0
  local function need(k)
    while bitCount < k do
      if pos > n then error("eof", 0) end
      bitBuf = bitBuf + byte(data, pos) * 2 ^ bitCount
      pos = pos + 1
      bitCount = bitCount + 8
    end
  end
  local function bits(k)
    need(k)
    local v = bitBuf % 2 ^ k
    bitBuf = floor(bitBuf / 2 ^ k)
    bitCount = bitCount - k
    return v
  end
  local function decode(t)
    if t.empty then error("bad", 0) end
    local code, len = 0, 0
    while true do
      len = len + 1
      code = code * 2 + bits(1)
      local sym = t.map[len * 65536 + code]
      if sym then return sym end
      if len >= t.max then error("bad", 0) end
    end
  end

  local out = {}
  local ok, err = pcall(function()
    local cmf, flg = bits(8), bits(8)
    if (cmf * 256 + flg) % 31 ~= 0 then error("bad", 0) end
    if cmf % 16 ~= 8 then error("bad", 0) end
    if floor(cmf / 16) + 8 > 15 then error("bad", 0) end
    if floor(flg / 32) % 2 == 1 then error("dict", 0) end
    local last
    repeat
      last = bits(1) == 1
      local btype = bits(2)
      if btype == 0 then
        bitBuf, bitCount = floor(bitBuf / 2 ^ (bitCount % 8)), bitCount - bitCount % 8
        local len, nlen = bits(16), bits(16)
        if len ~= 65535 - nlen then error("bad", 0) end
        for _ = 1, len do out[#out + 1] = bits(8) end
      elseif btype == 1 or btype == 2 then
        local lit, dist
        if btype == 1 then
          local l, d = {}, {}
          for i = 0, 287 do l[i] = STATIC_LLEN[i] end
          for i = 0, 29 do d[i] = 5 end
          d[30], d[31] = 5, 5
          lit, dist = buildDecoder(l, 288, false), buildDecoder(d, 32, false)
        else
          local nlen, ndist, ncode = bits(5) + 257, bits(5) + 1, bits(4) + 4
          if nlen > 286 or ndist > 30 then error("bad", 0) end
          local cl = {}
          for i = 0, 18 do cl[i] = 0 end
          for i = 0, ncode - 1 do cl[BL_ORDER[i]] = bits(3) end
          local clTable = buildDecoder(cl, 19, true)
          if not clTable or clTable.empty then error("bad", 0) end
          local lens = {}
          local i = 0
          while i < nlen + ndist do
            local sym = decode(clTable)
            if sym < 16 then
              lens[i] = sym
              i = i + 1
            else
              local value, rep = 0, 0
              if sym == 16 then
                if i == 0 then error("bad", 0) end
                value, rep = lens[i - 1], 3 + bits(2)
              elseif sym == 17 then
                rep = 3 + bits(3)
              else
                rep = 11 + bits(7)
              end
              if i + rep > nlen + ndist then error("bad", 0) end
              for _ = 1, rep do
                lens[i] = value
                i = i + 1
              end
            end
          end
          if lens[256] == 0 then error("bad", 0) end
          local l, d = {}, {}
          for k = 0, nlen - 1 do l[k] = lens[k] end
          for k = 0, ndist - 1 do d[k] = lens[nlen + k] end
          lit, dist = buildDecoder(l, nlen, false), buildDecoder(d, ndist, false)
          if not lit or lit.empty or not dist then error("bad", 0) end
        end
        while true do
          work()
          local sym = decode(lit)
          if sym < 256 then
            out[#out + 1] = sym
          elseif sym == 256 then
            break
          else
            sym = sym - 257
            if sym >= 29 then error("bad", 0) end
            local len = (sym == 28 and 258) or (BASE_LENGTH[sym] + 3 + bits(EXTRA_LBITS[sym]))
            local dsym = decode(dist)
            if dsym >= 30 then error("bad", 0) end
            local d = BASE_DIST[dsym] + 1 + bits(EXTRA_DBITS[dsym])
            if d > #out then error("bad", 0) end
            local from = #out - d
            for k = 1, len do out[#out + 1] = out[from + k] end
          end
        end
      else
        error("bad", 0)
      end
    until last
    -- the Adler-32 trailer, from the next byte boundary
    bitBuf, bitCount = floor(bitBuf / 2 ^ (bitCount % 8)), bitCount - bitCount % 8
    local a = 0
    for _ = 1, 4 do a = a * 256 + bits(8) end
    local parts = {}
    for k = 1, #out, 4096 do parts[#parts + 1] = char(table.unpack(out, k, math.min(#out, k + 4095))) end
    local result = concat(parts)
    if a ~= adler32(result) then error("bad", 0) end
    out = result
  end)
  if not ok then return nil, err end
  return out
end

Z.adler32 = adler32
return Z
