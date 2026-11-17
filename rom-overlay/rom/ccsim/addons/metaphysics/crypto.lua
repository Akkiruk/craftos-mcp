-- The primitives Metaphysics' CryptographyAPI gets from the JDK, written out so the results are the JDK's own:
-- SHA3-256 / SHA3-512 (FIPS 202), SHA-1, the "SHA1PRNG" generator of the SUN provider
-- (sun.security.provider.SecureRandom: setSeed then nextBytes), AES-256 and GCM with a 128-bit tag (NIST SP 800-38D).
-- Byte strings are Lua strings. Checked against vectors from the JDK 21 the mod runs on (docs/metaphysics.md).
return function()
  local band, bor, bxor, bnot = bit32.band, bit32.bor, bit32.bxor, bit32.bnot
  local lshift, rshift, lrotate = bit32.lshift, bit32.rshift, bit32.lrotate
  local char, byte, floor = string.char, string.byte, math.floor
  local X = {}

  -- ===== Keccak-f[1600], lanes as (hi, lo) 32-bit halves =====

  local RC_HI = { 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000,
    0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
    0x80000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000 }
  local RC_LO = { 0x00000001, 0x00008082, 0x0000808A, 0x80008000, 0x0000808B, 0x80000001, 0x80008081, 0x00008009,
    0x0000008A, 0x00000088, 0x80008009, 0x8000000A, 0x8000808B, 0x0000008B, 0x00008089, 0x00008003, 0x00008002,
    0x00000080, 0x0000800A, 0x8000000A, 0x80008081, 0x00008080, 0x80000001, 0x80008008 }
  -- rotation offsets r[x][y], index x + 5y (0-based)
  local ROT = { [0] = 0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14 }

  local function rot64(hi, lo, n)
    if n == 0 then return hi, lo end
    if n >= 32 then hi, lo = lo, hi n = n - 32 end
    if n == 0 then return hi, lo end
    return bor(lshift(hi, n), rshift(lo, 32 - n)), bor(lshift(lo, n), rshift(hi, 32 - n))
  end

  local function keccakF(H, L)
    local CH, CL, DH, DL, BH, BL = {}, {}, {}, {}, {}, {}
    for round = 1, 24 do
      for x = 0, 4 do
        CH[x] = bxor(H[x], H[x + 5], H[x + 10], H[x + 15], H[x + 20])
        CL[x] = bxor(L[x], L[x + 5], L[x + 10], L[x + 15], L[x + 20])
      end
      for x = 0, 4 do
        local rh, rl = rot64(CH[(x + 1) % 5], CL[(x + 1) % 5], 1)
        DH[x] = bxor(CH[(x + 4) % 5], rh)
        DL[x] = bxor(CL[(x + 4) % 5], rl)
      end
      for i = 0, 24 do
        local x = i % 5
        H[i] = bxor(H[i], DH[x])
        L[i] = bxor(L[i], DL[x])
      end
      -- rho and pi: B[y, 2x + 3y] = rot(A[x, y], r[x, y])
      for x = 0, 4 do
        for y = 0, 4 do
          local i = x + 5 * y
          local j = y + 5 * ((2 * x + 3 * y) % 5)
          BH[j], BL[j] = rot64(H[i], L[i], ROT[i])
        end
      end
      -- chi
      for y = 0, 4 do
        for x = 0, 4 do
          local i = x + 5 * y
          local i1 = (x + 1) % 5 + 5 * y
          local i2 = (x + 2) % 5 + 5 * y
          H[i] = bxor(BH[i], band(bnot(BH[i1]), BH[i2]))
          L[i] = bxor(BL[i], band(bnot(BL[i1]), BL[i2]))
        end
      end
      -- iota
      H[0] = bxor(H[0], RC_HI[round])
      L[0] = bxor(L[0], RC_LO[round])
    end
  end

  local function sha3(msg, outBytes)
    local rate = 200 - 2 * outBytes
    local H, L = {}, {}
    for i = 0, 24 do H[i], L[i] = 0, 0 end
    -- pad10*1 with the SHA-3 domain bits 01
    local padLen = rate - (#msg % rate)
    if padLen == 1 then
      msg = msg .. char(0x86)
    else
      msg = msg .. char(0x06) .. ("\0"):rep(padLen - 2) .. char(0x80)
    end
    for off = 1, #msg, rate do
      for lane = 0, rate / 8 - 1 do
        local p = off + lane * 8
        local b1, b2, b3, b4, b5, b6, b7, b8 = byte(msg, p, p + 7)
        L[lane] = bxor(L[lane], b1 + b2 * 256 + b3 * 65536 + b4 * 16777216)
        H[lane] = bxor(H[lane], b5 + b6 * 256 + b7 * 65536 + b8 * 16777216)
      end
      keccakF(H, L)
    end
    local out = {}
    for lane = 0, outBytes / 8 - 1 do
      local l, h = L[lane], H[lane]
      out[#out + 1] = char(l % 256, floor(l / 256) % 256, floor(l / 65536) % 256, floor(l / 16777216) % 256,
        h % 256, floor(h / 256) % 256, floor(h / 65536) % 256, floor(h / 16777216) % 256)
    end
    return table.concat(out)
  end
  function X.sha3_256(msg) return sha3(msg, 32) end
  function X.sha3_512(msg) return sha3(msg, 64) end

  -- ===== SHA-1 =====

  local function be32(n) return char(floor(n / 16777216) % 256, floor(n / 65536) % 256, floor(n / 256) % 256, n % 256) end

  function X.sha1(msg)
    local h0, h1, h2, h3, h4 = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0
    local len = #msg
    msg = msg .. "\128" .. ("\0"):rep((55 - len) % 64)
    local bits = len * 8
    msg = msg .. be32(floor(bits / 4294967296)) .. be32(bits % 4294967296)
    local w = {}
    for chunk = 1, #msg, 64 do
      for i = 0, 15 do
        local a, b, c, d = byte(msg, chunk + i * 4, chunk + i * 4 + 3)
        w[i] = ((a * 256 + b) * 256 + c) * 256 + d
      end
      for i = 16, 79 do w[i] = lrotate(bxor(w[i - 3], w[i - 8], w[i - 14], w[i - 16]), 1) end
      local a, b, c, d, e = h0, h1, h2, h3, h4
      for i = 0, 79 do
        local f, k
        if i < 20 then f, k = bor(band(b, c), band(bnot(b), d)), 0x5A827999
        elseif i < 40 then f, k = bxor(b, c, d), 0x6ED9EBA1
        elseif i < 60 then f, k = bor(band(b, c), band(b, d), band(c, d)), 0x8F1BBCDC
        else f, k = bxor(b, c, d), 0xCA62C1D6 end
        local t = (lrotate(a, 5) + f + e + k + w[i]) % 4294967296
        e, d, c, b, a = d, c, lrotate(b, 30), a, t
      end
      h0, h1, h2 = (h0 + a) % 4294967296, (h1 + b) % 4294967296, (h2 + c) % 4294967296
      h3, h4 = (h3 + d) % 4294967296, (h4 + e) % 4294967296
    end
    return be32(h0) .. be32(h1) .. be32(h2) .. be32(h3) .. be32(h4)
  end

  -- ===== SHA1PRNG (sun.security.provider.SecureRandom) =====

  --- A generator seeded once with setSeed(seed) before any output, as CryptographyAPI.generateKey does it.
  function X.sha1prng(seed)
    local state = { byte(X.sha1(seed), 1, 20) }
    local remainder, remCount = nil, 0
    local g = {}
    local function signed(b) return b >= 128 and b - 256 or b end
    -- state(n + 1) = (state(n) + output(n) + 1) % 2^160, on signed bytes with an arithmetic carry
    local function updateState(output)
      local last, zf = 1, false
      for i = 1, 20 do
        local v = signed(state[i]) + signed(output[i]) + last
        local t = v % 256
        if state[i] ~= t then zf = true end
        state[i] = t
        last = floor(v / 256)
      end
      if not zf then state[1] = (state[1] + 1) % 256 end
    end
    function g.nextBytes(n)
      local result = {}
      local index = 0
      if remCount > 0 then
        local todo = math.min(n, 20 - remCount)
        for i = 1, todo do result[i] = remainder[remCount + i] end
        remCount = remCount + todo
        index = todo
      end
      local output = remainder
      while index < n do
        output = { byte(X.sha1(char(table.unpack(state))), 1, 20) }
        updateState(output)
        local todo = math.min(20, n - index)
        for i = 1, todo do result[index + i] = output[i] end
        index = index + todo
        remCount = remCount + todo
      end
      remainder = output
      remCount = remCount % 20
      return char(table.unpack(result))
    end
    return g
  end

  -- ===== AES =====

  local SBOX, MUL2, MUL3 = {}, {}, {}
  do
    local function xtime(a)
      a = a * 2
      if a >= 256 then a = bxor(a, 0x11B) end
      return a
    end
    local function mul(a, b)
      local r = 0
      while b > 0 do
        if b % 2 == 1 then r = bxor(r, a) end
        a = xtime(a)
        b = floor(b / 2)
      end
      return r
    end
    -- the inverse in GF(2^8) then the affine map
    for x = 0, 255 do
      local inv = 0
      if x ~= 0 then
        for y = 1, 255 do if mul(x, y) == 1 then inv = y break end end
      end
      local s = inv
      for i = 1, 4 do s = bxor(s, band(bor(lshift(inv, i), rshift(inv, 8 - i)), 0xFF)) end
      SBOX[x] = bxor(s, 0x63)
      MUL2[x] = xtime(x)
      MUL3[x] = bxor(xtime(x), x)
    end
  end

  --- AES-256 key schedule: 15 round keys of 16 bytes (0-based tables)
  local function expandKey(key)
    local w = {}
    for i = 0, 31 do w[i] = byte(key, i + 1) end
    local rcon = 1
    for i = 8, 59 do
      local t0, t1, t2, t3 = w[(i - 1) * 4], w[(i - 1) * 4 + 1], w[(i - 1) * 4 + 2], w[(i - 1) * 4 + 3]
      if i % 8 == 0 then
        t0, t1, t2, t3 = bxor(SBOX[t1], rcon), SBOX[t2], SBOX[t3], SBOX[t0]
        rcon = rcon * 2
        if rcon >= 256 then rcon = bxor(rcon, 0x11B) end
      elseif i % 8 == 4 then
        t0, t1, t2, t3 = SBOX[t0], SBOX[t1], SBOX[t2], SBOX[t3]
      end
      w[i * 4] = bxor(w[(i - 8) * 4], t0)
      w[i * 4 + 1] = bxor(w[(i - 8) * 4 + 1], t1)
      w[i * 4 + 2] = bxor(w[(i - 8) * 4 + 2], t2)
      w[i * 4 + 3] = bxor(w[(i - 8) * 4 + 3], t3)
    end
    return w
  end

  --- one block (a 0-based table of 16 bytes) through AES-256
  local function encryptBlock(w, input)
    local s = {}
    for i = 0, 15 do s[i] = bxor(input[i], w[i]) end
    for round = 1, 14 do
      local t = {}
      -- SubBytes and ShiftRows (column-major state: byte r + 4c)
      for c = 0, 3 do
        for r = 0, 3 do t[r + 4 * c] = SBOX[s[r + 4 * ((c + r) % 4)]] end
      end
      if round < 14 then
        for c = 0, 3 do
          local a0, a1, a2, a3 = t[4 * c], t[4 * c + 1], t[4 * c + 2], t[4 * c + 3]
          t[4 * c] = bxor(MUL2[a0], MUL3[a1], a2, a3)
          t[4 * c + 1] = bxor(a0, MUL2[a1], MUL3[a2], a3)
          t[4 * c + 2] = bxor(a0, a1, MUL2[a2], MUL3[a3])
          t[4 * c + 3] = bxor(MUL3[a0], a1, a2, MUL2[a3])
        end
      end
      for i = 0, 15 do s[i] = bxor(t[i], w[round * 16 + i]) end
    end
    return s
  end

  -- ===== GCM (128-bit tag, no additional data) =====

  local function toWords(b) -- 16 bytes (0-based) -> 4 big-endian words
    local out = {}
    for i = 0, 3 do out[i + 1] = ((b[4 * i] * 256 + b[4 * i + 1]) * 256 + b[4 * i + 2]) * 256 + b[4 * i + 3] end
    return out
  end

  --- X * Y in GF(2^128), GCM's bit order
  local function gmul(x, y)
    local z1, z2, z3, z4 = 0, 0, 0, 0
    local v1, v2, v3, v4 = y[1], y[2], y[3], y[4]
    for i = 0, 127 do
      local word = x[floor(i / 32) + 1]
      if band(word, lshift(1, 31 - i % 32)) ~= 0 then
        z1, z2, z3, z4 = bxor(z1, v1), bxor(z2, v2), bxor(z3, v3), bxor(z4, v4)
      end
      local lsb = band(v4, 1)
      v4 = bor(rshift(v4, 1), lshift(band(v3, 1), 31))
      v3 = bor(rshift(v3, 1), lshift(band(v2, 1), 31))
      v2 = bor(rshift(v2, 1), lshift(band(v1, 1), 31))
      v1 = rshift(v1, 1)
      if lsb == 1 then v1 = bxor(v1, 0xE1000000) end
    end
    return { z1, z2, z3, z4 }
  end

  local function ghash(h, data)
    local y = { 0, 0, 0, 0 }
    for off = 1, #data, 16 do
      local b = {}
      for i = 0, 15 do b[i] = byte(data, off + i) or 0 end
      local wds = toWords(b)
      y = gmul({ bxor(y[1], wds[1]), bxor(y[2], wds[2]), bxor(y[3], wds[3]), bxor(y[4], wds[4]) }, h)
    end
    return y
  end

  local function ctr(w, j0, data)
    local out = {}
    local counter = {}
    for i = 0, 15 do counter[i] = j0[i] end
    for off = 1, #data, 16 do
      -- inc32: the last four bytes count up
      local n = ((counter[12] * 256 + counter[13]) * 256 + counter[14]) * 256 + counter[15]
      n = (n + 1) % 4294967296
      counter[12], counter[13], counter[14], counter[15] = floor(n / 16777216) % 256, floor(n / 65536) % 256, floor(n / 256) % 256, n % 256
      local ks = encryptBlock(w, counter)
      for i = 0, 15 do
        local c = byte(data, off + i)
        if not c then break end
        out[#out + 1] = char(bxor(c, ks[i]))
      end
    end
    return table.concat(out)
  end

  local function tagOf(w, h, j0, ciphertext)
    local padded = ciphertext .. ("\0"):rep((16 - #ciphertext % 16) % 16)
    local bits = #ciphertext * 8
    local lens = ("\0"):rep(8) .. be32(floor(bits / 4294967296)) .. be32(bits % 4294967296)
    local s = ghash(h, padded .. lens)
    local ek = encryptBlock(w, j0)
    local out = {}
    for i = 1, 4 do
      local e = ((ek[4 * (i - 1)] * 256 + ek[4 * (i - 1) + 1]) * 256 + ek[4 * (i - 1) + 2]) * 256 + ek[4 * (i - 1) + 3]
      out[i] = be32(bxor(s[i], e))
    end
    return table.concat(out)
  end

  local function setup(key, iv)
    local w = expandKey(key)
    local zero = {}
    for i = 0, 15 do zero[i] = 0 end
    local hb = encryptBlock(w, zero)
    local h = toWords(hb)
    local j0 = {}
    for i = 0, 11 do j0[i] = byte(iv, i + 1) end
    j0[12], j0[13], j0[14], j0[15] = 0, 0, 0, 1
    return w, h, j0
  end

  --- ciphertext .. tag
  function X.gcmEncrypt(key, iv, plaintext)
    local w, h, j0 = setup(key, iv)
    local c = ctr(w, j0, plaintext)
    return c .. tagOf(w, h, j0, c)
  end

  --- the plaintext, or nil when the tag does not match (AEADBadTagException)
  function X.gcmDecrypt(key, iv, data)
    if #data < 16 then return nil end
    local w, h, j0 = setup(key, iv)
    local c, tag = data:sub(1, -17), data:sub(-16)
    if tagOf(w, h, j0, c) ~= tag then return nil end
    return ctr(w, j0, c)
  end

  return X
end
