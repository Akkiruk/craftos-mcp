-- java.util.zip.Deflater / Inflater as Cricket's Peripherals uses them: zlib format, level 6 (Deflater's default),
-- windowBits 15, memLevel 8. Ported from zlib 1.2.13 (deflate.c, trees.c, inflate.c), the zlib Java 21 bundles, so
-- deflate gives the same bytes as the JDK: deflate_slow with its lazy matching, hash chains and window slide, and
-- trees.c's Huffman trees, including the union of Freq/Code and Dad/Len in ct_data that gen_bitlen relies on.
-- Inflate raises zlib's own messages (strm->msg), which Java passes on in a DataFormatException.
local band, bor, bxor, lshift, rshift = bit32.band, bit32.bor, bit32.bxor, bit32.lshift, bit32.rshift
local byte, char, concat = string.byte, string.char, table.concat

local Z = {}

-- ===== constants and the static tables (trees.c tr_static_init) =====

local MIN_MATCH, MAX_MATCH = 3, 258
local LENGTH_CODES, LITERALS = 29, 256
local L_CODES = LITERALS + 1 + LENGTH_CODES -- 286
local D_CODES, BL_CODES = 30, 19
local HEAP_SIZE = 2 * L_CODES + 1
local MAX_BITS, MAX_BL_BITS = 15, 7
local END_BLOCK, REP_3_6, REPZ_3_10, REPZ_11_138 = 256, 16, 17, 18
local W_BITS = 15
local W_SIZE = lshift(1, W_BITS)
local W_MASK = W_SIZE - 1
local HASH_BITS = 8 + 7 -- memLevel 8
local HASH_SIZE = lshift(1, HASH_BITS)
local HASH_MASK = HASH_SIZE - 1
local HASH_SHIFT = math.floor((HASH_BITS + MIN_MATCH - 1) / MIN_MATCH)
local LIT_BUFSIZE = lshift(1, 8 + 6)
local SYM_END = (LIT_BUFSIZE - 1) * 3
local WINDOW_SIZE = 2 * W_SIZE
local MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1
local MAX_DIST = W_SIZE - MIN_LOOKAHEAD
local TOO_FAR = 4096
local WIN_INIT = MAX_MATCH
-- level 6: good 8, lazy 16, nice 128, chain 128
local GOOD_MATCH, MAX_LAZY, NICE_MATCH, MAX_CHAIN = 8, 16, 128, 128

local extra_lbits = { [0] = 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 }
local extra_dbits = { [0] = 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 }
local extra_blbits = { [0] = 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7 }
local bl_order = { [0] = 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 }

local function bi_reverse(code, len)
  local res = 0
  repeat
    res = bor(res, band(code, 1))
    code = rshift(code, 1)
    res = lshift(res, 1)
    len = len - 1
  until len <= 0
  return rshift(res, 1)
end

local base_length, length_code, base_dist, dist_code = {}, {}, {}, {}
do
  local length = 0
  local code = 0
  while code < LENGTH_CODES - 1 do
    base_length[code] = length
    for _ = 1, lshift(1, extra_lbits[code]) do
      length_code[length] = code
      length = length + 1
    end
    code = code + 1
  end
  length_code[length - 1] = code
  local dist = 0
  code = 0
  while code < 16 do
    base_dist[code] = dist
    for _ = 1, lshift(1, extra_dbits[code]) do
      dist_code[dist] = code
      dist = dist + 1
    end
    code = code + 1
  end
  dist = rshift(dist, 7)
  while code < D_CODES do
    base_dist[code] = lshift(dist, 7)
    for _ = 1, lshift(1, extra_dbits[code] - 7) do
      dist_code[256 + dist] = code
      dist = dist + 1
    end
    code = code + 1
  end
end
local function d_code(dist)
  if dist < 256 then return dist_code[dist] end
  return dist_code[256 + rshift(dist, 7)]
end

-- a tree is two arrays: fc (Freq, or Code once gen_codes ran) and dl (Dad, or Len once gen_bitlen ran)
local function gen_codes(fc, dl, max_code, bl_count)
  local next_code = {}
  local code = 0
  for bits = 1, MAX_BITS do
    code = lshift(code + (bl_count[bits - 1] or 0), 1)
    next_code[bits] = code
  end
  for n = 0, max_code do
    local len = dl[n]
    if len ~= 0 then
      fc[n] = bi_reverse(next_code[len], len)
      next_code[len] = next_code[len] + 1
    end
  end
end

local static_lcode, static_llen, static_dcode, static_dlen = {}, {}, {}, {}
do
  local bl_count = {}
  for b = 0, MAX_BITS do bl_count[b] = 0 end
  for n = 0, 287 do
    local len = n <= 143 and 8 or n <= 255 and 9 or n <= 279 and 7 or 8
    static_llen[n] = len
    bl_count[len] = bl_count[len] + 1
  end
  gen_codes(static_lcode, static_llen, L_CODES + 1, bl_count)
  for n = 0, D_CODES - 1 do
    static_dlen[n] = 5
    static_dcode[n] = bi_reverse(n, 5)
  end
end

-- ===== deflate =====

function Z.deflate(input)
  local inLen, inPos = #input, 1
  local window = {}
  local head, prev = {}, {}
  for i = 0, HASH_SIZE - 1 do head[i] = 0 end
  for i = 0, W_SIZE - 1 do prev[i] = 0 end
  local s = {
    strstart = 0, block_start = 0, lookahead = 0, insert = 0, match_length = MIN_MATCH - 1,
    prev_length = MIN_MATCH - 1, match_available = false, match_start = 0, prev_match = 0, ins_h = 0, high_water = 0,
  }
  local out, outN = {}, 0
  local bi_buf, bi_valid = 0, 0
  local adler_a, adler_b = 1, 0

  local function put_byte(b)
    outN = outN + 1
    out[outN] = b
  end
  local function send_bits(value, length)
    bi_buf = bor(bi_buf, lshift(value, bi_valid))
    bi_valid = bi_valid + length
    while bi_valid >= 8 do
      put_byte(band(bi_buf, 0xff))
      bi_buf = rshift(bi_buf, 8)
      bi_valid = bi_valid - 8
    end
  end
  local function bi_windup()
    if bi_valid > 0 then put_byte(band(bi_buf, 0xff)) end
    bi_buf, bi_valid = 0, 0
  end

  -- trees: dyn_ltree, dyn_dtree, bl_tree
  local function newTree(size)
    local t = { fc = {}, dl = {} }
    for i = 0, size - 1 do t.fc[i], t.dl[i] = 0, 0 end
    return t
  end
  local ltree, dtree, bltree = newTree(HEAP_SIZE), newTree(2 * D_CODES + 1), newTree(2 * BL_CODES + 1)
  local l_desc = { tree = ltree, max_code = 0, stree_len = static_llen, extra = extra_lbits, base = LITERALS + 1,
    elems = L_CODES, max_length = MAX_BITS }
  local d_desc = { tree = dtree, max_code = 0, stree_len = static_dlen, extra = extra_dbits, base = 0, elems = D_CODES,
    max_length = MAX_BITS }
  local bl_desc = { tree = bltree, max_code = 0, extra = extra_blbits, base = 0, elems = BL_CODES,
    max_length = MAX_BL_BITS }
  local heap, depth, bl_count = {}, {}, {}
  local heap_len, heap_max = 0, 0
  local opt_len, static_len = 0, 0
  local sym_buf, sym_next = {}, 0

  local function init_block()
    for n = 0, L_CODES - 1 do ltree.fc[n] = 0 end
    for n = 0, D_CODES - 1 do dtree.fc[n] = 0 end
    for n = 0, BL_CODES - 1 do bltree.fc[n] = 0 end
    ltree.fc[END_BLOCK] = 1
    opt_len, static_len = 0, 0
    sym_next = 0
  end
  init_block()

  local function smaller(fc, n, m)
    return fc[n] < fc[m] or (fc[n] == fc[m] and depth[n] <= depth[m])
  end
  local function pqdownheap(fc, k)
    local v = heap[k]
    local j = lshift(k, 1)
    while j <= heap_len do
      if j < heap_len and smaller(fc, heap[j + 1], heap[j]) then j = j + 1 end
      if smaller(fc, v, heap[j]) then break end
      heap[k] = heap[j]
      k = j
      j = lshift(j, 1)
    end
    heap[k] = v
  end

  local function gen_bitlen(desc)
    local fc, dl = desc.tree.fc, desc.tree.dl
    local max_code, stree_len, extra, base, max_length = desc.max_code, desc.stree_len, desc.extra, desc.base,
      desc.max_length
    local overflow = 0
    for bits = 0, MAX_BITS do bl_count[bits] = 0 end
    dl[heap[heap_max]] = 0
    local h = heap_max + 1
    while h < HEAP_SIZE do
      local n = heap[h]
      local bits = dl[dl[n]] + 1
      if bits > max_length then bits, overflow = max_length, overflow + 1 end
      dl[n] = bits
      if n <= max_code then
        bl_count[bits] = bl_count[bits] + 1
        local xbits = 0
        if n >= base then xbits = extra[n - base] end
        local f = fc[n]
        opt_len = opt_len + f * (bits + xbits)
        if stree_len then static_len = static_len + f * (stree_len[n] + xbits) end
      end
      h = h + 1
    end
    if overflow == 0 then return end
    repeat
      local bits = max_length - 1
      while bl_count[bits] == 0 do bits = bits - 1 end
      bl_count[bits] = bl_count[bits] - 1
      bl_count[bits + 1] = bl_count[bits + 1] + 2
      bl_count[max_length] = bl_count[max_length] - 1
      overflow = overflow - 2
    until overflow <= 0
    for bits = max_length, 1, -1 do
      local n = bl_count[bits]
      while n ~= 0 do
        h = h - 1
        local m = heap[h]
        if m <= max_code then
          if dl[m] ~= bits then
            opt_len = opt_len + (bits - dl[m]) * fc[m]
            dl[m] = bits
          end
          n = n - 1
        end
      end
    end
  end

  local function build_tree(desc)
    local fc, dl = desc.tree.fc, desc.tree.dl
    local stree_len, elems = desc.stree_len, desc.elems
    local max_code = -1
    heap_len, heap_max = 0, HEAP_SIZE
    for n = 0, elems - 1 do
      if fc[n] ~= 0 then
        heap_len = heap_len + 1
        heap[heap_len] = n
        max_code = n
        depth[n] = 0
      else
        dl[n] = 0
      end
    end
    while heap_len < 2 do
      local node
      if max_code < 2 then
        max_code = max_code + 1
        node = max_code
      else
        node = 0
      end
      heap_len = heap_len + 1
      heap[heap_len] = node
      fc[node] = 1
      depth[node] = 0
      opt_len = opt_len - 1
      if stree_len then static_len = static_len - stree_len[node] end
    end
    desc.max_code = max_code
    for n = math.floor(heap_len / 2), 1, -1 do pqdownheap(fc, n) end
    local node = elems
    repeat
      local n = heap[1]
      heap[1] = heap[heap_len]
      heap_len = heap_len - 1
      pqdownheap(fc, 1)
      local m = heap[1]
      heap_max = heap_max - 1
      heap[heap_max] = n
      heap_max = heap_max - 1
      heap[heap_max] = m
      fc[node] = fc[n] + fc[m]
      depth[node] = (depth[n] >= depth[m] and depth[n] or depth[m]) + 1
      dl[n], dl[m] = node, node
      heap[1] = node
      node = node + 1
      pqdownheap(fc, 1)
    until heap_len < 2
    heap_max = heap_max - 1
    heap[heap_max] = heap[1]
    gen_bitlen(desc)
    gen_codes(fc, dl, max_code, bl_count)
  end

  local function scan_tree(tree, max_code)
    local dl, blfc = tree.dl, bltree.fc
    local prevlen, nextlen, count = -1, dl[0], 0
    local max_count, min_count = 7, 4
    if nextlen == 0 then max_count, min_count = 138, 3 end
    dl[max_code + 1] = 0xffff
    for n = 0, max_code do
      local curlen = nextlen
      nextlen = dl[n + 1]
      count = count + 1
      if count < max_count and curlen == nextlen then
        -- continue
      else
        if count < min_count then
          blfc[curlen] = blfc[curlen] + count
        elseif curlen ~= 0 then
          if curlen ~= prevlen then blfc[curlen] = blfc[curlen] + 1 end
          blfc[REP_3_6] = blfc[REP_3_6] + 1
        elseif count <= 10 then
          blfc[REPZ_3_10] = blfc[REPZ_3_10] + 1
        else
          blfc[REPZ_11_138] = blfc[REPZ_11_138] + 1
        end
        count, prevlen = 0, curlen
        if nextlen == 0 then max_count, min_count = 138, 3
        elseif curlen == nextlen then max_count, min_count = 6, 3
        else max_count, min_count = 7, 4 end
      end
    end
  end

  local function send_code(c, tree) send_bits(tree.fc[c], tree.dl[c]) end

  local function send_tree(tree, max_code)
    local dl = tree.dl
    local prevlen, nextlen, count = -1, dl[0], 0
    local max_count, min_count = 7, 4
    if nextlen == 0 then max_count, min_count = 138, 3 end
    for n = 0, max_code do
      local curlen = nextlen
      nextlen = dl[n + 1]
      count = count + 1
      if count < max_count and curlen == nextlen then
        -- continue
      else
        if count < min_count then
          repeat send_code(curlen, bltree); count = count - 1 until count == 0
        elseif curlen ~= 0 then
          if curlen ~= prevlen then
            send_code(curlen, bltree)
            count = count - 1
          end
          send_code(REP_3_6, bltree)
          send_bits(count - 3, 2)
        elseif count <= 10 then
          send_code(REPZ_3_10, bltree)
          send_bits(count - 3, 3)
        else
          send_code(REPZ_11_138, bltree)
          send_bits(count - 11, 7)
        end
        count, prevlen = 0, curlen
        if nextlen == 0 then max_count, min_count = 138, 3
        elseif curlen == nextlen then max_count, min_count = 6, 3
        else max_count, min_count = 7, 4 end
      end
    end
  end

  local function build_bl_tree()
    scan_tree(ltree, l_desc.max_code)
    scan_tree(dtree, d_desc.max_code)
    build_tree(bl_desc)
    local max_blindex = BL_CODES - 1
    while max_blindex >= 3 do
      if bltree.dl[bl_order[max_blindex]] ~= 0 then break end
      max_blindex = max_blindex - 1
    end
    opt_len = opt_len + 3 * (max_blindex + 1) + 5 + 5 + 4
    return max_blindex
  end

  local function compress_block(lfc, ldl, dfc, ddl)
    local sx = 0
    while sx < sym_next do
      local dist = sym_buf[sx] + sym_buf[sx + 1] * 256
      local lc = sym_buf[sx + 2]
      sx = sx + 3
      if dist == 0 then
        send_bits(lfc[lc], ldl[lc])
      else
        local code = length_code[lc]
        send_bits(lfc[code + LITERALS + 1], ldl[code + LITERALS + 1])
        local extra = extra_lbits[code]
        if extra ~= 0 then send_bits(lc - base_length[code], extra) end
        dist = dist - 1
        code = d_code(dist)
        send_bits(dfc[code], ddl[code])
        extra = extra_dbits[code]
        if extra ~= 0 then send_bits(dist - base_dist[code], extra) end
      end
    end
    send_bits(lfc[END_BLOCK], ldl[END_BLOCK])
  end

  local function flush_block(last)
    local stored_len = s.strstart - s.block_start
    local hasBuf = s.block_start >= 0
    build_tree(l_desc)
    build_tree(d_desc)
    local max_blindex = build_bl_tree()
    local opt_lenb = rshift(opt_len + 3 + 7, 3)
    local static_lenb = rshift(static_len + 3 + 7, 3)
    if static_lenb <= opt_lenb then opt_lenb = static_lenb end
    local lastBit = last and 1 or 0
    if stored_len + 4 <= opt_lenb and hasBuf then
      send_bits(0 + lastBit, 3) -- STORED_BLOCK << 1
      bi_windup()
      put_byte(band(stored_len, 0xff)); put_byte(band(rshift(stored_len, 8), 0xff))
      local nlen = band(bxor(stored_len, 0xffff), 0xffff)
      put_byte(band(nlen, 0xff)); put_byte(rshift(nlen, 8))
      for i = s.block_start, s.block_start + stored_len - 1 do put_byte(window[i]) end
    elseif static_lenb == opt_lenb then
      send_bits(2 + lastBit, 3) -- STATIC_TREES << 1
      compress_block(static_lcode, static_llen, static_dcode, static_dlen)
    else
      send_bits(4 + lastBit, 3) -- DYN_TREES << 1
      local lcodes, dcodes, blcodes = l_desc.max_code + 1, d_desc.max_code + 1, max_blindex + 1
      send_bits(lcodes - 257, 5)
      send_bits(dcodes - 1, 5)
      send_bits(blcodes - 4, 4)
      for rank = 0, blcodes - 1 do send_bits(bltree.dl[bl_order[rank]], 3) end
      send_tree(ltree, lcodes - 1)
      send_tree(dtree, dcodes - 1)
      compress_block(ltree.fc, ltree.dl, dtree.fc, dtree.dl)
    end
    init_block()
    if last then bi_windup() end
    s.block_start = s.strstart
  end

  local function tally_lit(c)
    sym_buf[sym_next], sym_buf[sym_next + 1], sym_buf[sym_next + 2] = 0, 0, c
    sym_next = sym_next + 3
    ltree.fc[c] = ltree.fc[c] + 1
    return sym_next == SYM_END
  end
  local function tally_dist(dist, len)
    sym_buf[sym_next], sym_buf[sym_next + 1], sym_buf[sym_next + 2] = band(dist, 0xff), rshift(dist, 8), len
    sym_next = sym_next + 3
    dist = dist - 1
    local lc = length_code[len] + LITERALS + 1
    ltree.fc[lc] = ltree.fc[lc] + 1
    local dc = d_code(dist)
    dtree.fc[dc] = dtree.fc[dc] + 1
    return sym_next == SYM_END
  end

  local function update_hash(h, c) return band(bxor(lshift(h, HASH_SHIFT), c), HASH_MASK) end
  local function insert_string(str)
    s.ins_h = update_hash(s.ins_h, window[str + MIN_MATCH - 1])
    local mh = head[s.ins_h]
    prev[band(str, W_MASK)] = mh
    head[s.ins_h] = str
    return mh
  end

  local function read_buf(at, size)
    local len = inLen - inPos + 1
    if len > size then len = size end
    if len == 0 then return 0 end
    local a, b = adler_a, adler_b
    for i = 0, len - 1 do
      local c = byte(input, inPos + i)
      window[at + i] = c
      a = (a + c) % 65521
      b = (b + a) % 65521
    end
    adler_a, adler_b = a, b
    inPos = inPos + len
    return len
  end

  local function fill_window()
    repeat
      local more = WINDOW_SIZE - s.lookahead - s.strstart
      if s.strstart >= W_SIZE + MAX_DIST then
        -- zmemcpy(window, window + wsize, wsize - more): the upper half keeps its bytes
        for i = 0, W_SIZE - more - 1 do window[i] = window[i + W_SIZE] end
        s.match_start = s.match_start - W_SIZE
        s.strstart = s.strstart - W_SIZE
        s.block_start = s.block_start - W_SIZE
        if s.insert > s.strstart then s.insert = s.strstart end
        for i = 0, HASH_SIZE - 1 do
          local m = head[i]
          head[i] = m >= W_SIZE and m - W_SIZE or 0
        end
        for i = 0, W_SIZE - 1 do
          local m = prev[i]
          prev[i] = m >= W_SIZE and m - W_SIZE or 0
        end
        more = more + W_SIZE
      end
      if inPos > inLen then break end
      local n = read_buf(s.strstart + s.lookahead, more)
      s.lookahead = s.lookahead + n
      if s.lookahead + s.insert >= MIN_MATCH then
        local str = s.strstart - s.insert
        s.ins_h = window[str]
        s.ins_h = update_hash(s.ins_h, window[str + 1])
        while s.insert > 0 do
          s.ins_h = update_hash(s.ins_h, window[str + MIN_MATCH - 1])
          prev[band(str, W_MASK)] = head[s.ins_h]
          head[s.ins_h] = str
          str = str + 1
          s.insert = s.insert - 1
          if s.lookahead + s.insert < MIN_MATCH then break end
        end
      end
    until not (s.lookahead < MIN_LOOKAHEAD and inPos <= inLen)
    if s.high_water < WINDOW_SIZE then
      local curr = s.strstart + s.lookahead
      if s.high_water < curr then
        local init = WINDOW_SIZE - curr
        if init > WIN_INIT then init = WIN_INIT end
        for i = curr, curr + init - 1 do window[i] = 0 end
        s.high_water = curr + init
      elseif s.high_water < curr + WIN_INIT then
        local init = curr + WIN_INIT - s.high_water
        if init > WINDOW_SIZE - s.high_water then init = WINDOW_SIZE - s.high_water end
        for i = s.high_water, s.high_water + init - 1 do window[i] = 0 end
        s.high_water = s.high_water + init
      end
    end
  end

  local function longest_match(cur_match)
    local chain_length = MAX_CHAIN
    local scan = s.strstart
    local best_len = s.prev_length
    local nice_match = NICE_MATCH
    local limit = s.strstart > MAX_DIST and s.strstart - MAX_DIST or 0
    local strend = s.strstart + MAX_MATCH
    local scan_end1 = window[scan + best_len - 1]
    local scan_end = window[scan + best_len]
    if s.prev_length >= GOOD_MATCH then chain_length = rshift(chain_length, 2) end
    if nice_match > s.lookahead then nice_match = s.lookahead end
    repeat
      local match = cur_match
      if window[match + best_len] == scan_end and window[match + best_len - 1] == scan_end1
          and window[match] == window[scan] and window[match + 1] == window[scan + 1] then
        local sp, mp = scan + 2, match + 2
        -- the C loop compares bytes 3..258 (sp from scan+3 to strend)
        repeat
          sp, mp = sp + 1, mp + 1
        until window[sp] ~= window[mp] or sp >= strend
        local len = MAX_MATCH - (strend - sp)
        if len > best_len then
          s.match_start = cur_match
          best_len = len
          if len >= nice_match then break end
          scan_end1 = window[scan + best_len - 1]
          scan_end = window[scan + best_len]
        end
      end
      cur_match = prev[band(cur_match, W_MASK)]
      chain_length = chain_length - 1
    until not (cur_match > limit and chain_length ~= 0)
    if best_len <= s.lookahead then return best_len end
    return s.lookahead
  end

  -- deflate(): the zlib header, deflate_slow(Z_FINISH), the Adler-32 trailer
  put_byte(0x78); put_byte(0x9C)
  while true do
    if s.lookahead < MIN_LOOKAHEAD then
      fill_window()
      if s.lookahead == 0 then break end
    end
    local hash_head = 0
    if s.lookahead >= MIN_MATCH then hash_head = insert_string(s.strstart) end
    s.prev_length, s.prev_match = s.match_length, s.match_start
    s.match_length = MIN_MATCH - 1
    if hash_head ~= 0 and s.prev_length < MAX_LAZY and s.strstart - hash_head <= MAX_DIST then
      s.match_length = longest_match(hash_head)
      if s.match_length <= 5 and s.match_length == MIN_MATCH and s.strstart - s.match_start > TOO_FAR then
        s.match_length = MIN_MATCH - 1
      end
    end
    if s.prev_length >= MIN_MATCH and s.match_length <= s.prev_length then
      local max_insert = s.strstart + s.lookahead - MIN_MATCH
      local bflush = tally_dist(s.strstart - 1 - s.prev_match, s.prev_length - MIN_MATCH)
      s.lookahead = s.lookahead - (s.prev_length - 1)
      s.prev_length = s.prev_length - 2
      repeat
        s.strstart = s.strstart + 1
        if s.strstart <= max_insert then insert_string(s.strstart) end
        s.prev_length = s.prev_length - 1
      until s.prev_length == 0
      s.match_available = false
      s.match_length = MIN_MATCH - 1
      s.strstart = s.strstart + 1
      if bflush then flush_block(false) end
    elseif s.match_available then
      if tally_lit(window[s.strstart - 1]) then flush_block(false) end
      s.strstart = s.strstart + 1
      s.lookahead = s.lookahead - 1
    else
      s.match_available = true
      s.strstart = s.strstart + 1
      s.lookahead = s.lookahead - 1
    end
  end
  if s.match_available then
    tally_lit(window[s.strstart - 1])
    s.match_available = false
  end
  flush_block(true)
  put_byte(rshift(adler_b, 8)); put_byte(band(adler_b, 0xff))
  put_byte(rshift(adler_a, 8)); put_byte(band(adler_a, 0xff))

  local parts = {}
  for i = 1, outN, 4096 do parts[#parts + 1] = char(table.unpack(out, i, math.min(i + 4095, outN))) end
  return concat(parts)
end

-- ===== inflate =====

local LBASE = { [0] = 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258 }
local LEXT = { [0] = 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 }
local DBASE = { [0] = 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577 }
local DEXT = { [0] = 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 }
local CLORDER = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 }

--- A canonical Huffman decoder from code lengths, as inflate_table checks them: over-subscribed is an error, and so
--- is an incomplete set unless it is a single code of length 1 in a literal/length or distance set.
local function huffman(lens, n, isCodes)
  local count = {}
  for i = 0, MAX_BITS do count[i] = 0 end
  for i = 0, n - 1 do count[lens[i]] = count[lens[i]] + 1 end
  local max = MAX_BITS
  while max >= 1 and count[max] == 0 do max = max - 1 end
  if max == 0 then return { empty = true } end -- no codes: every lookup fails (inflate_table makes invalid entries)
  local left = 1
  for len = 1, MAX_BITS do
    left = left * 2 - count[len]
    if left < 0 then return nil end
  end
  if left > 0 and (isCodes or max ~= 1) then return nil end
  local offs = { [1] = 0 }
  for len = 1, MAX_BITS - 1 do offs[len + 1] = offs[len] + count[len] end
  local symbol = {}
  for i = 0, n - 1 do
    if lens[i] ~= 0 then
      symbol[offs[lens[i]]] = i
      offs[lens[i]] = offs[lens[i]] + 1
    end
  end
  return { count = count, symbol = symbol, max = max }
end

function Z.inflate(data)
  local n = #data
  local pos, bitbuf, bitcnt = 1, 0, 0
  local out, outN = {}, 0
  local STOP = {}

  local function need(bits)
    while bitcnt < bits do
      if pos > n then error(STOP, 0) end -- needsInput(): Java's loop stops with what came out so far
      bitbuf = bor(bitbuf, lshift(byte(data, pos), bitcnt))
      pos = pos + 1
      bitcnt = bitcnt + 8
    end
  end
  local function bits(k)
    need(k)
    local v = band(bitbuf, lshift(1, k) - 1)
    bitbuf = rshift(bitbuf, k)
    bitcnt = bitcnt - k
    return v
  end
  local function fail(msg) error({ msg = msg }, 0) end
  local function decode(h, invalid)
    if h.empty then
      need(1)
      fail(invalid)
    end
    local code, first, index = 0, 0, 0
    for len = 1, MAX_BITS do
      code = bor(code, bits(1))
      local count = h.count[len]
      if code - count < first then return h.symbol[index + (code - first)] end
      index = index + count
      first = (first + count) * 2
      code = code * 2
    end
    fail(invalid)
  end
  local function emit(b)
    outN = outN + 1
    out[outN] = b
  end

  local fixedL, fixedD
  local function fixed()
    if not fixedL then
      local l = {}
      for i = 0, 287 do l[i] = i <= 143 and 8 or i <= 255 and 9 or i <= 279 and 7 or 8 end
      fixedL = huffman(l, 288, false)
      local d = {}
      for i = 0, 29 do d[i] = 5 end
      -- inflate's fixed distance table has 32 five-bit codes; 30 and 31 are invalid distance codes
      d[30], d[31] = 5, 5
      fixedD = huffman(d, 32, false)
    end
    return fixedL, fixedD
  end

  local function codes(lh, dh)
    while true do
      local sym = decode(lh, "invalid literal/length code")
      if sym < 256 then
        emit(sym)
      elseif sym == 256 then
        return
      else
        sym = sym - 257
        if sym >= 29 then fail("invalid literal/length code") end
        local len = LBASE[sym] + bits(LEXT[sym])
        local dsym = decode(dh, "invalid distance code")
        if dsym >= 30 then fail("invalid distance code") end
        local dist = DBASE[dsym] + bits(DEXT[dsym])
        if dist > outN then fail("invalid distance too far back") end
        for _ = 1, len do emit(out[outN - dist + 1]) end
      end
    end
  end

  local ok, e = pcall(function()
    local cmf = bits(8)
    local flg = bits(8)
    if (cmf * 256 + flg) % 31 ~= 0 then fail("incorrect header check") end
    if band(cmf, 15) ~= 8 then fail("unknown compression method") end
    if rshift(cmf, 4) + 8 > 15 then fail("invalid window size") end
    if band(flg, 0x20) ~= 0 then
      bits(16); bits(16) -- DICTID: then zlib asks for the dictionary (Z_NEED_DICT)
      if pos <= n then fail({ dictionary = true }) end
      error(STOP, 0) -- no input left: needsInput(), and Java's loop stops
    end
    repeat
      local last = bits(1)
      local btype = bits(2)
      if btype == 0 then
        bitbuf, bitcnt = 0, 0 -- to a byte boundary
        local len = bits(16)
        local nlen = bits(16)
        if len ~= band(bxor(nlen, 0xffff), 0xffff) then fail("invalid stored block lengths") end
        for _ = 1, len do
          if pos > n then error(STOP, 0) end
          emit(byte(data, pos))
          pos = pos + 1
        end
      elseif btype == 1 then
        codes(fixed())
      elseif btype == 2 then
        local nlen = bits(5) + 257
        local ndist = bits(5) + 1
        local ncode = bits(4) + 4
        if nlen > 286 or ndist > 30 then fail("too many length or distance symbols") end
        local cl = {}
        for i = 0, 18 do cl[i] = 0 end
        for i = 1, ncode do cl[CLORDER[i]] = bits(3) end
        local ch = huffman(cl, 19, true)
        if not ch or ch.empty then fail("invalid code lengths set") end
        local lens, i = {}, 0
        while i < nlen + ndist do
          local sym = decode(ch, "invalid code lengths set")
          if sym < 16 then
            lens[i] = sym
            i = i + 1
          else
            local len, rep = 0, 0
            if sym == 16 then
              if i == 0 then fail("invalid bit length repeat") end
              len = lens[i - 1]
              rep = 3 + bits(2)
            elseif sym == 17 then
              rep = 3 + bits(3)
            else
              rep = 11 + bits(7)
            end
            if i + rep > nlen + ndist then fail("invalid bit length repeat") end
            for _ = 1, rep do
              lens[i] = len
              i = i + 1
            end
          end
        end
        if lens[256] == 0 then fail("invalid code -- missing end-of-block") end
        local ll, dl = {}, {}
        for k = 0, nlen - 1 do ll[k] = lens[k] end
        for k = 0, ndist - 1 do dl[k] = lens[nlen + k] end
        local lh = huffman(ll, nlen, false)
        if not lh then fail("invalid literal/lengths set") end
        local dh = huffman(dl, ndist, false)
        if not dh then fail("invalid distances set") end
        codes(lh, dh)
      else
        fail("invalid block type")
      end
    until last == 1
    -- the Adler-32 trailer, from the next byte boundary
    bitbuf, bitcnt = 0, 0
    local want = 0
    for _ = 1, 4 do want = want * 256 + bits(8) end
    local a, b = 1, 0
    for k = 1, outN do
      a = (a + out[k]) % 65521
      b = (b + a) % 65521
    end
    if want ~= b * 65536 + a then fail("incorrect data check") end
  end)

  local parts = {}
  for i = 1, outN, 4096 do parts[#parts + 1] = char(table.unpack(out, i, math.min(i + 4095, outN))) end
  local result = concat(parts)
  if ok or e == STOP then return result end
  if type(e) == "table" and type(e.msg) == "table" and e.msg.dictionary then return nil, "dictionary" end
  if type(e) == "table" and e.msg then error(e.msg, 0) end
  error(e, 0)
end

return Z
