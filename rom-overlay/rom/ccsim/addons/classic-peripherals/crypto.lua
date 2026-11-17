-- ccsim classic-peripherals: the cryptography behind the cryptographic accelerator and the NFC reader, in plain Lua.
--
-- The mod calls Bouncy Castle 1.78.1 (bundled in its jar) and, in 0.5.1, javax.crypto for AES. Every function here
-- works on Lua strings as byte strings, the way CC hands a Lua string to Java (one char per byte, ISO-8859-1), and
-- returns raw bytes. The integration test checks each one against vectors made by running the mod's own Crypto and
-- Compression classes on a JVM (packages/runner/src/classic-peripherals-vectors.json).
--
-- MD5 (RFC 1321), SHA-1 / SHA-256 / SHA-512 (FIPS 180-4), HMAC (RFC 2104), BLAKE3 (the reference implementation),
-- AES-CBC with PKCS#7 padding (FIPS 197), base64 (RFC 4648 as java.util.Base64 reads it), Ed25519 (RFC 8032, with
-- Bouncy Castle's extra checks on verify) and X25519 (RFC 7748). The curve arithmetic follows TweetNaCl: sixteen
-- 16-bit limbs, which keeps every product inside a double's 53 bits.
local band, bor, bxor, bnot = bit32.band, bit32.bor, bit32.bxor, bit32.bnot
local lrotate, rrotate, lshift, rshift = bit32.lrotate, bit32.rrotate, bit32.lshift, bit32.rshift
local floor = math.floor
local char, byte, concat = string.char, string.byte, table.concat

local C = {}

-- The Java does this work in microseconds; this port takes a while on big inputs, time the real computer never
-- spends. init.lua points C.work at core.serverWork, so long loops do not trip the 7 s "Too long without yielding".
C.work = function() end
local workCount = 0
local function work()
  workCount = workCount + 1
  if workCount >= 256 then
    workCount = 0
    C.work()
  end
end

local function bytesOf(s)
  local t = {}
  for i = 1, #s do t[i] = byte(s, i) end
  return t
end

local function stringOf(t, from, to)
  local parts = {}
  from, to = from or 1, to or #t
  for i = from, to, 4096 do
    parts[#parts + 1] = char(table.unpack(t, i, math.min(to, i + 4095)))
  end
  return concat(parts)
end

C.bytesOf, C.stringOf = bytesOf, stringOf

function C.hex(s)
  return (s:gsub(".", function(c) return ("%02x"):format(byte(c)) end))
end

-- ===== MD5 =====

local MD5_K, MD5_S = {}, {
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
}
for i = 0, 63 do MD5_K[i] = floor(math.abs(math.sin(i + 1)) * 4294967296) % 4294967296 end

local function lengthBytes(bits, bigEndian, width)
  local out = {}
  for i = 1, width do
    local b = floor(bits / 256 ^ (i - 1)) % 256
    if bigEndian then out[width - i + 1] = b else out[i] = b end
  end
  return char(table.unpack(out))
end

function C.md5(msg)
  local len = #msg
  msg = msg .. "\128" .. ("\0"):rep((55 - len) % 64) .. lengthBytes(len * 8, false, 8)
  local a0, b0, c0, d0 = 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476
  local M = {}
  for chunk = 1, #msg, 64 do
    work()
    for i = 0, 15 do
      local p = chunk + i * 4
      local b1, b2, b3, b4 = byte(msg, p, p + 3)
      M[i] = b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
    end
    local A, B, Cc, D = a0, b0, c0, d0
    for i = 0, 63 do
      local F, g
      if i < 16 then
        F, g = bor(band(B, Cc), band(bnot(B), D)), i
      elseif i < 32 then
        F, g = bor(band(D, B), band(bnot(D), Cc)), (5 * i + 1) % 16
      elseif i < 48 then
        F, g = bxor(B, Cc, D), (3 * i + 5) % 16
      else
        F, g = bxor(Cc, bor(B, bnot(D))), (7 * i) % 16
      end
      F = (F + A + MD5_K[i] + M[g]) % 4294967296
      A, D, Cc = D, Cc, B
      B = (B + lrotate(F, MD5_S[i + 1])) % 4294967296
    end
    a0, b0, c0, d0 = (a0 + A) % 4294967296, (b0 + B) % 4294967296, (c0 + Cc) % 4294967296, (d0 + D) % 4294967296
  end
  local out = {}
  for _, w in ipairs({ a0, b0, c0, d0 }) do
    for i = 0, 3 do out[#out + 1] = floor(w / 256 ^ i) % 256 end
  end
  return char(table.unpack(out))
end

-- ===== SHA-1 and SHA-256 =====

local function bigWords(msg, chunk, W, n)
  for i = 0, n - 1 do
    local p = chunk + i * 4
    local b1, b2, b3, b4 = byte(msg, p, p + 3)
    W[i] = ((b1 * 256 + b2) * 256 + b3) * 256 + b4
  end
end

local function wordsOut(words)
  local out = {}
  for _, w in ipairs(words) do
    out[#out + 1] = char(floor(w / 16777216) % 256, floor(w / 65536) % 256, floor(w / 256) % 256, w % 256)
  end
  return concat(out)
end

local function pad64(msg)
  local len = #msg
  return msg .. "\128" .. ("\0"):rep((55 - len) % 64) .. lengthBytes(len * 8, true, 8)
end

function C.sha1(msg)
  msg = pad64(msg)
  local h0, h1, h2, h3, h4 = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0
  local W = {}
  for chunk = 1, #msg, 64 do
    work()
    bigWords(msg, chunk, W, 16)
    for i = 16, 79 do W[i] = lrotate(bxor(W[i - 3], W[i - 8], W[i - 14], W[i - 16]), 1) end
    local a, b, c, d, e = h0, h1, h2, h3, h4
    for i = 0, 79 do
      local f, k
      if i < 20 then
        f, k = bor(band(b, c), band(bnot(b), d)), 0x5A827999
      elseif i < 40 then
        f, k = bxor(b, c, d), 0x6ED9EBA1
      elseif i < 60 then
        f, k = bor(band(b, c), band(b, d), band(c, d)), 0x8F1BBCDC
      else
        f, k = bxor(b, c, d), 0xCA62C1D6
      end
      local temp = (lrotate(a, 5) + f + e + k + W[i]) % 4294967296
      e, d, c, b, a = d, c, lrotate(b, 30), a, temp
    end
    h0, h1, h2 = (h0 + a) % 4294967296, (h1 + b) % 4294967296, (h2 + c) % 4294967296
    h3, h4 = (h3 + d) % 4294967296, (h4 + e) % 4294967296
  end
  return wordsOut({ h0, h1, h2, h3, h4 })
end

local SHA256_K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local IV32 = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 }

function C.sha256(msg)
  msg = pad64(msg)
  local H = { table.unpack(IV32) }
  local W = {}
  for chunk = 1, #msg, 64 do
    work()
    bigWords(msg, chunk, W, 16)
    for i = 16, 63 do
      local w15, w2 = W[i - 15], W[i - 2]
      local s0 = bxor(rrotate(w15, 7), rrotate(w15, 18), rshift(w15, 3))
      local s1 = bxor(rrotate(w2, 17), rrotate(w2, 19), rshift(w2, 10))
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) % 4294967296
    end
    local a, b, c, d, e, f, g, h = H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]
    for i = 0, 63 do
      local S1 = bxor(rrotate(e, 6), rrotate(e, 11), rrotate(e, 25))
      local ch = bxor(band(e, f), band(bnot(e), g))
      local t1 = (h + S1 + ch + SHA256_K[i + 1] + W[i]) % 4294967296
      local S0 = bxor(rrotate(a, 2), rrotate(a, 13), rrotate(a, 22))
      local maj = bxor(band(a, b), band(a, c), band(b, c))
      local t2 = (S0 + maj) % 4294967296
      h, g, f, e, d, c, b, a = g, f, e, (d + t1) % 4294967296, c, b, a, (t1 + t2) % 4294967296
    end
    H[1], H[2], H[3], H[4] = (H[1] + a) % 4294967296, (H[2] + b) % 4294967296, (H[3] + c) % 4294967296, (H[4] + d) % 4294967296
    H[5], H[6], H[7], H[8] = (H[5] + e) % 4294967296, (H[6] + f) % 4294967296, (H[7] + g) % 4294967296, (H[8] + h) % 4294967296
  end
  return wordsOut(H)
end

-- ===== SHA-512: each 64-bit word is a pair of 32-bit halves =====

local SHA512_K = {
  "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc", "3956c25bf348b538",
  "59f111f1b605d019", "923f82a4af194f9b", "ab1c5ed5da6d8118", "d807aa98a3030242", "12835b0145706fbe",
  "243185be4ee4b28c", "550c7dc3d5ffb4e2", "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235",
  "c19bf174cf692694", "e49b69c19ef14ad2", "efbe4786384f25e3", "0fc19dc68b8cd5b5", "240ca1cc77ac9c65",
  "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5", "983e5152ee66dfab",
  "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4", "c6e00bf33da88fc2", "d5a79147930aa725",
  "06ca6351e003826f", "142929670a0e6e70", "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed",
  "53380d139d95b3df", "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b",
  "a2bfe8a14cf10364", "a81a664bbc423001", "c24b8b70d0f89791", "c76c51a30654be30", "d192e819d6ef5218",
  "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8", "19a4c116b8d2d0c8", "1e376c085141ab53",
  "2748774cdf8eeb99", "34b0bcb5e19b48a8", "391c0cb3c5c95a63", "4ed8aa4ae3418acb", "5b9cca4f7763e373",
  "682e6ff3d6b2b8a3", "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec",
  "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b", "ca273eceea26619c",
  "d186b8c721c0c207", "eada7dd6cde0eb1e", "f57d4f7fee6ed178", "06f067aa72176fba", "0a637dc5a2c898a6",
  "113f9804bef90dae", "1b710b35131c471b", "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc",
  "431d67c49c100d4c", "4cc5d4becb3e42b6", "597f299cfc657e2a", "5fcb6fab3ad6faec", "6c44198c4a475817",
}
local KH, KL = {}, {}
for i, h in ipairs(SHA512_K) do KH[i - 1], KL[i - 1] = tonumber(h:sub(1, 8), 16), tonumber(h:sub(9), 16) end
local SHA512_IV = {
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
}

-- rotate a 64-bit (hi, lo) right by n (0 < n < 64)
local function rotr64(h, l, n)
  if n >= 32 then h, l, n = l, h, n - 32 end
  if n == 0 then return h, l end
  return bor(rshift(h, n), lshift(l, 32 - n)), bor(rshift(l, n), lshift(h, 32 - n))
end
local function shr64(h, l, n) -- n < 32
  return rshift(h, n), bor(rshift(l, n), lshift(h, 32 - n))
end

function C.sha512(msg)
  local len = #msg
  msg = msg .. "\128" .. ("\0"):rep((111 - len) % 128) .. ("\0"):rep(8) .. lengthBytes(len * 8, true, 8)
  local H = { table.unpack(SHA512_IV) }
  local WH, WL = {}, {}
  for chunk = 1, #msg, 128 do
    work()
    for i = 0, 15 do
      local p = chunk + i * 8
      local b1, b2, b3, b4, b5, b6, b7, b8 = byte(msg, p, p + 7)
      WH[i] = ((b1 * 256 + b2) * 256 + b3) * 256 + b4
      WL[i] = ((b5 * 256 + b6) * 256 + b7) * 256 + b8
    end
    for i = 16, 79 do
      local ah, al = rotr64(WH[i - 15], WL[i - 15], 1)
      local bh, bl = rotr64(WH[i - 15], WL[i - 15], 8)
      local ch, cl = shr64(WH[i - 15], WL[i - 15], 7)
      local s0h, s0l = bxor(ah, bh, ch), bxor(al, bl, cl)
      ah, al = rotr64(WH[i - 2], WL[i - 2], 19)
      bh, bl = rotr64(WH[i - 2], WL[i - 2], 61)
      ch, cl = shr64(WH[i - 2], WL[i - 2], 6)
      local s1h, s1l = bxor(ah, bh, ch), bxor(al, bl, cl)
      local lo = WL[i - 16] + s0l + WL[i - 7] + s1l
      WL[i] = lo % 4294967296
      WH[i] = (WH[i - 16] + s0h + WH[i - 7] + s1h + floor(lo / 4294967296)) % 4294967296
    end
    local ah, al, bh, bl, chh, chl, dh, dl = H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]
    local eh, el, fh, fl, gh, gl, hh, hl = H[9], H[10], H[11], H[12], H[13], H[14], H[15], H[16]
    for i = 0, 79 do
      local x1h, x1l = rotr64(eh, el, 14)
      local x2h, x2l = rotr64(eh, el, 18)
      local x3h, x3l = rotr64(eh, el, 41)
      local S1h, S1l = bxor(x1h, x2h, x3h), bxor(x1l, x2l, x3l)
      local chH = bxor(band(eh, fh), band(bnot(eh), gh))
      local chL = bxor(band(el, fl), band(bnot(el), gl))
      local t1l = hl + S1l + chL + KL[i] + WL[i]
      local t1h = hh + S1h + chH + KH[i] + WH[i] + floor(t1l / 4294967296)
      t1l, t1h = t1l % 4294967296, t1h % 4294967296
      x1h, x1l = rotr64(ah, al, 28)
      x2h, x2l = rotr64(ah, al, 34)
      x3h, x3l = rotr64(ah, al, 39)
      local S0h, S0l = bxor(x1h, x2h, x3h), bxor(x1l, x2l, x3l)
      local majH = bxor(band(ah, bh), band(ah, chh), band(bh, chh))
      local majL = bxor(band(al, bl), band(al, chl), band(bl, chl))
      local t2l = S0l + majL
      local t2h = (S0h + majH + floor(t2l / 4294967296)) % 4294967296
      t2l = t2l % 4294967296
      hh, hl, gh, gl, fh, fl = gh, gl, fh, fl, eh, el
      local nel = dl + t1l
      eh, el = (dh + t1h + floor(nel / 4294967296)) % 4294967296, nel % 4294967296
      dh, dl, chh, chl, bh, bl = chh, chl, bh, bl, ah, al
      local nal = t1l + t2l
      ah, al = (t1h + t2h + floor(nal / 4294967296)) % 4294967296, nal % 4294967296
    end
    local add = { ah, al, bh, bl, chh, chl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl }
    for i = 1, 16, 2 do
      local lo = H[i + 1] + add[i + 1]
      H[i + 1] = lo % 4294967296
      H[i] = (H[i] + add[i] + floor(lo / 4294967296)) % 4294967296
    end
  end
  return wordsOut(H)
end

-- ===== HMAC (Bouncy Castle's HMac: a key longer than the block is hashed first) =====

local BLOCK = { md5 = 64, sha1 = 64, sha256 = 64, sha512 = 128 }

function C.hmac(name, key, data)
  local hash, size = C[name], BLOCK[name]
  if #key > size then key = hash(key) end
  key = key .. ("\0"):rep(size - #key)
  local ipad, opad = {}, {}
  for i = 1, size do
    local k = byte(key, i)
    ipad[i], opad[i] = bxor(k, 0x36), bxor(k, 0x5c)
  end
  return hash(char(table.unpack(opad)) .. hash(char(table.unpack(ipad)) .. data))
end

-- ===== BLAKE3 =====

local B3_PERM = { 2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8 }
local CHUNK_START, CHUNK_END, PARENT, ROOT = 1, 2, 4, 8
local KEYED_HASH, DERIVE_KEY_CONTEXT, DERIVE_KEY_MATERIAL = 16, 32, 64

local function g(v, a, b, c, d, mx, my)
  v[a] = (v[a] + v[b] + mx) % 4294967296
  v[d] = rrotate(bxor(v[d], v[a]), 16)
  v[c] = (v[c] + v[d]) % 4294967296
  v[b] = rrotate(bxor(v[b], v[c]), 12)
  v[a] = (v[a] + v[b] + my) % 4294967296
  v[d] = rrotate(bxor(v[d], v[a]), 8)
  v[c] = (v[c] + v[d]) % 4294967296
  v[b] = rrotate(bxor(v[b], v[c]), 7)
end

--- The compression function: 16 output words (the first 8 are the chaining value).
local function compress(cv, m, counter, blockLen, flags)
  local v = {
    cv[1], cv[2], cv[3], cv[4], cv[5], cv[6], cv[7], cv[8],
    IV32[1], IV32[2], IV32[3], IV32[4],
    counter % 4294967296, floor(counter / 4294967296), blockLen, flags,
  }
  local w = {}
  for i = 1, 16 do w[i] = m[i] end
  for round = 1, 7 do
    g(v, 1, 5, 9, 13, w[1], w[2])
    g(v, 2, 6, 10, 14, w[3], w[4])
    g(v, 3, 7, 11, 15, w[5], w[6])
    g(v, 4, 8, 12, 16, w[7], w[8])
    g(v, 1, 6, 11, 16, w[9], w[10])
    g(v, 2, 7, 12, 13, w[11], w[12])
    g(v, 3, 8, 9, 14, w[13], w[14])
    g(v, 4, 5, 10, 15, w[15], w[16])
    if round < 7 then
      local p = {}
      for i = 1, 16 do p[i] = w[B3_PERM[i] + 1] end
      w = p
    end
  end
  for i = 1, 8 do
    v[i] = bxor(v[i], v[i + 8])
    v[i + 8] = bxor(v[i + 8], cv[i])
  end
  return v
end

local function blockWords(s, from, len)
  local m = {}
  for i = 0, 15 do
    local word = 0
    for j = 3, 0, -1 do
      local p = from + i * 4 + j
      local b = (i * 4 + j < len) and byte(s, p) or 0
      word = word * 256 + b
    end
    m[i + 1] = word
  end
  return m
end

local function keyWords(key)
  local k = {}
  for i = 0, 7 do
    local b1, b2, b3, b4 = byte(key, i * 4 + 1, i * 4 + 4)
    k[i + 1] = b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
  end
  return k
end

--- BLAKE3 of `input` with key words `key` and base flags, `outLen` bytes of extended output.
local function blake3(input, key, flags, outLen)
  local stack = {}
  local function addChunkCv(cv, totalChunks)
    while totalChunks % 2 == 0 do
      local left = table.remove(stack)
      local m = {}
      for i = 1, 8 do m[i], m[i + 8] = left[i], cv[i] end
      local out = compress(key, m, 0, 64, flags + PARENT)
      cv = { out[1], out[2], out[3], out[4], out[5], out[6], out[7], out[8] }
      totalChunks = totalChunks / 2
    end
    stack[#stack + 1] = cv
  end

  -- the last chunk's (or, for one chunk, the root's) output: the inputs of its final compression
  local len = #input
  local chunks = math.max(1, math.ceil(len / 1024))
  local outCv, outBlock, outCounter, outBlockLen, outFlags
  for chunk = 0, chunks - 1 do
    work()
    local start = chunk * 1024
    local chunkLen = math.min(1024, len - start)
    local cv = key
    local blocks = math.max(1, math.ceil(chunkLen / 64))
    for b = 0, blocks - 1 do
      local blockLen = math.min(64, chunkLen - b * 64)
      local f = flags
      if b == 0 then f = f + CHUNK_START end
      local m = blockWords(input, start + b * 64 + 1, blockLen)
      if b == blocks - 1 then
        f = f + CHUNK_END
        if chunk == chunks - 1 then
          outCv, outBlock, outCounter, outBlockLen, outFlags = cv, m, chunk, blockLen, f
        else
          local out = compress(cv, m, chunk, blockLen, f)
          addChunkCv({ out[1], out[2], out[3], out[4], out[5], out[6], out[7], out[8] }, chunk + 1)
        end
      else
        local out = compress(cv, m, chunk, blockLen, f)
        cv = { out[1], out[2], out[3], out[4], out[5], out[6], out[7], out[8] }
      end
    end
  end
  -- merge the last chunk up the stack: every parent but the root is compressed now
  while #stack > 0 do
    local out = compress(outCv, outBlock, outCounter, outBlockLen, outFlags)
    local right = { out[1], out[2], out[3], out[4], out[5], out[6], out[7], out[8] }
    local left = table.remove(stack)
    local m = {}
    for i = 1, 8 do m[i], m[i + 8] = left[i], right[i] end
    outCv, outBlock, outCounter, outBlockLen, outFlags = key, m, 0, 64, flags + PARENT
  end
  local bytes = {}
  local counter = 0
  while #bytes < outLen do
    local out = compress(outCv, outBlock, counter, outBlockLen, outFlags + ROOT)
    for i = 1, 16 do
      local w = out[i]
      for _ = 1, 4 do
        if #bytes < outLen then bytes[#bytes + 1] = w % 256 end
        w = floor(w / 256)
      end
    end
    counter = counter + 1
  end
  return stringOf(bytes)
end

function C.blake3Hash(data, outLen) return blake3(data, IV32, 0, outLen) end
function C.blake3Keyed(data, key, outLen) return blake3(data, keyWords(key), KEYED_HASH, outLen) end
function C.blake3Derive(data, context, outLen)
  local contextKey = blake3(context, IV32, DERIVE_KEY_CONTEXT, 32)
  return blake3(data, keyWords(contextKey), DERIVE_KEY_MATERIAL, outLen)
end

-- ===== AES-CBC with PKCS#7 padding =====

local SBOX, INV = {}, {}
do
  -- the S-box from the multiplicative inverse in GF(2^8) and the affine map
  local function rotl8(v, n) return band(bor(lshift(v, n), rshift(v, 8 - n)), 0xFF) end
  local p, q = 1, 1
  repeat
    p = band(bxor(p, lshift(p, 1), band(p, 0x80) ~= 0 and 0x1B or 0), 0xFF) -- p * 3
    q = bxor(q, lshift(q, 1)) -- q / 3
    q = bxor(q, lshift(q, 2))
    q = bxor(q, lshift(q, 4))
    q = band(q, 0xFF)
    if band(q, 0x80) ~= 0 then q = bxor(q, 0x09) end
    SBOX[p] = bxor(q, rotl8(q, 1), rotl8(q, 2), rotl8(q, 3), rotl8(q, 4), 0x63)
  until p == 1
  SBOX[0] = 0x63
  for i = 0, 255 do INV[SBOX[i]] = i end
end

local function xtime(a)
  a = a * 2
  if a >= 256 then a = bxor(a - 256, 0x1B) end
  return a
end
local function gmul(a, b)
  local r = 0
  while b > 0 do
    if b % 2 == 1 then r = bxor(r, a) end
    a = xtime(a)
    b = floor(b / 2)
  end
  return r
end
local MUL = {}
for _, m in ipairs({ 2, 3, 9, 11, 13, 14 }) do
  local t = {}
  for i = 0, 255 do t[i] = gmul(i, m) end
  MUL[m] = t
end
local M2, M3, M9, M11, M13, M14 = MUL[2], MUL[3], MUL[9], MUL[11], MUL[13], MUL[14]

local function expandKey(key)
  local nk = #key / 4
  local rounds = nk + 6
  local w = bytesOf(key) -- 1-based bytes
  local rcon = 1
  local total = 16 * (rounds + 1)
  local i = #w
  while i < total do
    local t1, t2, t3, t4 = w[i - 3], w[i - 2], w[i - 1], w[i]
    local word = i / 4
    if word % nk == 0 then
      t1, t2, t3, t4 = bxor(SBOX[t2], rcon), SBOX[t3], SBOX[t4], SBOX[t1]
      rcon = xtime(rcon)
    elseif nk > 6 and word % nk == 4 then
      t1, t2, t3, t4 = SBOX[t1], SBOX[t2], SBOX[t3], SBOX[t4]
    end
    local base = i - nk * 4
    w[i + 1], w[i + 2], w[i + 3], w[i + 4] = bxor(w[base + 1], t1), bxor(w[base + 2], t2), bxor(w[base + 3], t3), bxor(w[base + 4], t4)
    i = i + 4
  end
  return w, rounds
end

local function addRoundKey(s, w, round)
  local base = round * 16
  for i = 1, 16 do s[i] = bxor(s[i], w[base + i]) end
end

local function encryptBlock(s, w, rounds)
  addRoundKey(s, w, 0)
  for round = 1, rounds do
    for i = 1, 16 do s[i] = SBOX[s[i]] end
    -- shift rows (column-major state: s[r + 4c + 1])
    s[2], s[6], s[10], s[14] = s[6], s[10], s[14], s[2]
    s[3], s[7], s[11], s[15] = s[11], s[15], s[3], s[7]
    s[4], s[8], s[12], s[16] = s[16], s[4], s[8], s[12]
    if round < rounds then
      for c = 0, 3 do
        local i = c * 4
        local a0, a1, a2, a3 = s[i + 1], s[i + 2], s[i + 3], s[i + 4]
        s[i + 1] = bxor(M2[a0], M3[a1], a2, a3)
        s[i + 2] = bxor(a0, M2[a1], M3[a2], a3)
        s[i + 3] = bxor(a0, a1, M2[a2], M3[a3])
        s[i + 4] = bxor(M3[a0], a1, a2, M2[a3])
      end
    end
    addRoundKey(s, w, round)
  end
end

local function decryptBlock(s, w, rounds)
  addRoundKey(s, w, rounds)
  for round = rounds - 1, 0, -1 do
    s[2], s[6], s[10], s[14] = s[14], s[2], s[6], s[10]
    s[3], s[7], s[11], s[15] = s[11], s[15], s[3], s[7]
    s[4], s[8], s[12], s[16] = s[8], s[12], s[16], s[4]
    for i = 1, 16 do s[i] = INV[s[i]] end
    addRoundKey(s, w, round)
    if round > 0 then
      for c = 0, 3 do
        local i = c * 4
        local a0, a1, a2, a3 = s[i + 1], s[i + 2], s[i + 3], s[i + 4]
        s[i + 1] = bxor(M14[a0], M11[a1], M13[a2], M9[a3])
        s[i + 2] = bxor(M9[a0], M14[a1], M11[a2], M13[a3])
        s[i + 3] = bxor(M13[a0], M9[a1], M14[a2], M11[a3])
        s[i + 4] = bxor(M11[a0], M13[a1], M9[a2], M14[a3])
      end
    end
  end
end

function C.aesEncrypt(data, key, iv)
  local w, rounds = expandKey(key)
  local padLen = 16 - #data % 16
  local bytes = bytesOf(data .. char(padLen):rep(padLen))
  local prev = bytesOf(iv)
  local out = {}
  for at = 0, #bytes - 1, 16 do
    work()
    local s = {}
    for i = 1, 16 do s[i] = bxor(bytes[at + i], prev[i]) end
    encryptBlock(s, w, rounds)
    for i = 1, 16 do out[at + i] = s[i] end
    prev = s
  end
  return stringOf(out)
end

--- Decrypt; nil and "padding" when the last block's padding is wrong (the caller has checked the length).
function C.aesDecrypt(data, key, iv)
  local w, rounds = expandKey(key)
  local bytes = bytesOf(data)
  local prev = bytesOf(iv)
  local out = {}
  for at = 0, #bytes - 1, 16 do
    work()
    local s, cipher = {}, {}
    for i = 1, 16 do s[i], cipher[i] = bytes[at + i], bytes[at + i] end
    decryptBlock(s, w, rounds)
    for i = 1, 16 do out[at + i] = bxor(s[i], prev[i]) end
    prev = cipher
  end
  local n = #out
  local count = out[n]
  if count == nil or count == 0 or count > 16 or count > n then return nil, "padding" end
  for i = n - count + 1, n do
    if out[i] ~= count then return nil, "padding" end
  end
  return stringOf(out, 1, n - count)
end

-- ===== base64, as java.util.Base64's basic encoder and decoder =====

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local B64_INDEX = {}
for i = 1, 64 do B64_INDEX[byte(B64, i)] = i - 1 end
B64_INDEX[byte("=")] = -2

function C.base64Encode(data)
  local out = {}
  for i = 1, #data, 3 do
    local a, b, c = byte(data, i, i + 2)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    local c1, c2, c3, c4 = floor(n / 262144) % 64, floor(n / 4096) % 64, floor(n / 64) % 64, n % 64
    out[#out + 1] = B64:sub(c1 + 1, c1 + 1) .. B64:sub(c2 + 1, c2 + 1)
      .. (b and B64:sub(c3 + 1, c3 + 1) or "=") .. (c and B64:sub(c4 + 1, c4 + 1) or "=")
  end
  return concat(out)
end

--- Base64.Decoder.decode (the basic, non-MIME decoder of JDK 17/21): the bytes, or nil and the exception message.
function C.base64Decode(data)
  local sl = #data
  if sl == 0 then return "" end
  if sl < 2 then return nil, "Input byte[] should at least have 2 bytes for base64 bytes" end
  local out = {}
  local bits, shiftto, sp = 0, 18, 1
  while sp <= sl do
    local raw = byte(data, sp)
    sp = sp + 1
    local b = B64_INDEX[raw] or -1
    if b < 0 then
      if b == -2 then
        if (shiftto == 6 and (sp > sl or byte(data, sp) ~= 61)) or shiftto == 18 then
          return nil, "Input byte array has wrong 4-byte ending unit"
        end
        if shiftto == 6 then sp = sp + 1 end
        break
      end
      -- Integer.toString of a signed Java byte, in base 16
      local signed = raw >= 128 and raw - 256 or raw
      local text = signed < 0 and ("-%x"):format(-signed) or ("%x"):format(signed)
      return nil, "Illegal base64 character " .. text
    end
    bits = bits + b * 2 ^ shiftto
    shiftto = shiftto - 6
    if shiftto < 0 then
      out[#out + 1] = char(floor(bits / 65536) % 256, floor(bits / 256) % 256, bits % 256)
      shiftto, bits = 18, 0
    end
  end
  if shiftto == 6 then
    out[#out + 1] = char(floor(bits / 65536) % 256)
  elseif shiftto == 0 then
    out[#out + 1] = char(floor(bits / 65536) % 256, floor(bits / 256) % 256)
  elseif shiftto == 12 then
    return nil, "Last unit does not have enough valid bits"
  end
  if sp <= sl then return nil, "Input byte array has incorrect ending byte at " .. (sp - 1) end
  return concat(out)
end

-- ===== curve25519 field arithmetic (TweetNaCl's, 16 limbs of 16 bits) =====

local function gf(init)
  local r = {}
  for i = 0, 15 do r[i] = init and init[i + 1] or 0 end
  return r
end

local gf0, gf1 = gf(), gf({ 1 })
local _121665 = gf({ 0xDB41, 1 })
local D = gf({ 0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070, 0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203 })
local D2 = gf({ 0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0, 0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406 })
local X = gf({ 0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c, 0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169 })
local Y = gf({ 0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666 })
local I = gf({ 0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43, 0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83 })

local function set25519(r, a) for i = 0, 15 do r[i] = a[i] end end

local function car25519(o)
  for i = 0, 15 do
    o[i] = o[i] + 65536
    local c = floor(o[i] / 65536)
    if i < 15 then
      o[i + 1] = o[i + 1] + c - 1
    else
      o[0] = o[0] + 38 * (c - 1)
    end
    o[i] = o[i] - c * 65536
  end
end

local function sel25519(p, q, b)
  if b == 1 then
    for i = 0, 15 do p[i], q[i] = q[i], p[i] end
  end
end

local function pack25519(o, n)
  local m, t = gf(), gf()
  for i = 0, 15 do t[i] = n[i] end
  car25519(t)
  car25519(t)
  car25519(t)
  for _ = 1, 2 do
    m[0] = t[0] - 0xffed
    for i = 1, 14 do
      m[i] = t[i] - 0xffff - (floor(m[i - 1] / 65536) % 2)
      m[i - 1] = m[i - 1] % 65536
    end
    m[15] = t[15] - 0x7fff - (floor(m[14] / 65536) % 2)
    local b = floor(m[15] / 65536) % 2
    m[14] = m[14] % 65536
    sel25519(t, m, 1 - b)
  end
  for i = 0, 15 do
    o[2 * i] = t[i] % 256
    o[2 * i + 1] = floor(t[i] / 256) % 256
  end
end

local function A(o, a, b) for i = 0, 15 do o[i] = a[i] + b[i] end end
local function Z(o, a, b) for i = 0, 15 do o[i] = a[i] - b[i] end end

local function M(o, a, b)
  local t = {}
  for i = 0, 30 do t[i] = 0 end
  for i = 0, 15 do
    local ai = a[i]
    if ai ~= 0 then
      for j = 0, 15 do t[i + j] = t[i + j] + ai * b[j] end
    end
  end
  for i = 0, 14 do t[i] = t[i] + 38 * t[i + 16] end
  for i = 0, 15 do o[i] = t[i] end
  car25519(o)
  car25519(o)
end

local function S(o, a) M(o, a, a) end

local function inv25519(o, i)
  local c = gf()
  set25519(c, i)
  for a = 253, 0, -1 do
    S(c, c)
    if a ~= 2 and a ~= 4 then M(c, c, i) end
  end
  set25519(o, c)
end

local function pow2523(o, i)
  local c = gf()
  set25519(c, i)
  for a = 250, 0, -1 do
    S(c, c)
    if a ~= 1 then M(c, c, i) end
  end
  set25519(o, c)
end

local function unpack25519(o, n)
  for i = 0, 15 do o[i] = n[2 * i] + n[2 * i + 1] * 256 end
  o[15] = o[15] % 32768
end

local function neq25519(a, b)
  local c, d = {}, {}
  pack25519(c, a)
  pack25519(d, b)
  for i = 0, 31 do if c[i] ~= d[i] then return true end end
  return false
end

local function par25519(a)
  local d = {}
  pack25519(d, a)
  return d[0] % 2
end

local function zeroBased(s)
  local t = {}
  for i = 1, #s do t[i - 1] = byte(s, i) end
  return t
end
local function toString0(t, n)
  local out = {}
  for i = 0, n - 1 do out[i + 1] = t[i] end
  return char(table.unpack(out))
end

-- ===== X25519 =====

function C.x25519(scalar, point)
  local z = zeroBased(scalar)
  z[31] = bor(band(z[31], 127), 64)
  z[0] = band(z[0], 248)
  local x = gf()
  unpack25519(x, zeroBased(point))
  local a, b, c, d, e, f = gf(), gf(), gf(), gf(), gf(), gf()
  for i = 0, 15 do b[i], d[i], a[i], c[i] = x[i], 0, 0, 0 end
  a[0], d[0] = 1, 1
  for i = 254, 0, -1 do
    local r = floor(z[floor(i / 8)] / 2 ^ (i % 8)) % 2
    sel25519(a, b, r)
    sel25519(c, d, r)
    A(e, a, c)
    Z(a, a, c)
    A(c, b, d)
    Z(b, b, d)
    S(d, e)
    S(f, a)
    M(a, c, a)
    M(c, b, e)
    A(e, a, c)
    Z(a, a, c)
    S(b, a)
    Z(c, d, f)
    M(a, c, _121665)
    A(a, a, d)
    M(c, c, a)
    M(a, d, f)
    M(d, b, x)
    S(b, e)
    sel25519(a, b, r)
    sel25519(c, d, r)
  end
  inv25519(c, c)
  M(a, a, c)
  local out = {}
  pack25519(out, a)
  return toString0(out, 32)
end

local BASE9 = "\9" .. ("\0"):rep(31)
function C.x25519Public(scalar) return C.x25519(scalar, BASE9) end

-- ===== Ed25519 =====

--- extended coordinates X, Y, Z, T, 0-based like TweetNaCl's gf p[4]
local function point() return { [0] = gf(), gf(), gf(), gf() } end

local function add(p, q)
  local a, b, c, d, t, e, f, gg, h = gf(), gf(), gf(), gf(), gf(), gf(), gf(), gf(), gf()
  Z(a, p[1], p[0])
  Z(t, q[1], q[0])
  M(a, a, t)
  A(b, p[0], p[1])
  A(t, q[0], q[1])
  M(b, b, t)
  M(c, p[3], q[3])
  M(c, c, D2)
  M(d, p[2], q[2])
  A(d, d, d)
  Z(e, b, a)
  Z(f, d, c)
  A(gg, d, c)
  A(h, b, a)
  M(p[0], e, f)
  M(p[1], h, gg)
  M(p[2], gg, f)
  M(p[3], e, h)
end

local function cswap(p, q, b)
  for i = 0, 3 do sel25519(p[i], q[i], b) end
end

local function pack(r, p)
  local tx, ty, zi = gf(), gf(), gf()
  inv25519(zi, p[2])
  M(tx, p[0], zi)
  M(ty, p[1], zi)
  pack25519(r, ty)
  r[31] = bxor(r[31], par25519(tx) * 128)
end

local function scalarmult(p, q, s)
  set25519(p[0], gf0)
  set25519(p[1], gf1)
  set25519(p[2], gf1)
  set25519(p[3], gf0)
  for i = 255, 0, -1 do
    local b = floor(s[floor(i / 8)] / 2 ^ (i % 8)) % 2
    cswap(p, q, b)
    add(q, p)
    add(p, p)
    cswap(p, q, b)
  end
end

local function scalarbase(p, s)
  local q = point()
  set25519(q[0], X)
  set25519(q[1], Y)
  set25519(q[2], gf1)
  M(q[3], X, Y)
  scalarmult(p, q, s)
end

local L = { [0] = 0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10 }

local function modL(r, x)
  for i = 63, 32, -1 do
    local carry = 0
    local j = i - 32
    while j < i - 12 do
      x[j] = x[j] + carry - 16 * x[i] * L[j - (i - 32)]
      carry = floor((x[j] + 128) / 256)
      x[j] = x[j] - carry * 256
      j = j + 1
    end
    x[j] = x[j] + carry
    x[i] = 0
  end
  local carry = 0
  for j = 0, 31 do
    x[j] = x[j] + carry - floor(x[31] / 16) * L[j]
    carry = floor(x[j] / 256)
    x[j] = x[j] % 256
  end
  for j = 0, 31 do x[j] = x[j] - carry * L[j] end
  for i = 0, 31 do
    x[i + 1] = (x[i + 1] or 0) + floor(x[i] / 256)
    r[i] = x[i] % 256
  end
end

local function reduce(r)
  local x = {}
  for i = 0, 63 do x[i] = r[i] end
  for i = 0, 63 do r[i] = 0 end
  modL(r, x)
end

local function expand(seed)
  local d = zeroBased(C.sha512(seed))
  d[0] = band(d[0], 248)
  d[31] = bor(band(d[31], 127), 64)
  return d
end

function C.ed25519Public(seed)
  local d = expand(seed)
  local p = point()
  scalarbase(p, d)
  local pk = {}
  pack(pk, p)
  return toString0(pk, 32)
end

function C.ed25519Sign(message, seed)
  local d = expand(seed)
  local pk = C.ed25519Public(seed)
  local prefix = toString0(d, 64):sub(33, 64)
  local r = zeroBased(C.sha512(prefix .. message))
  reduce(r)
  local p = point()
  scalarbase(p, r)
  local R = {}
  pack(R, p)
  local Rs = toString0(R, 32)
  local h = zeroBased(C.sha512(Rs .. pk .. message))
  reduce(h)
  local x = {}
  for i = 0, 63 do x[i] = 0 end
  for i = 0, 31 do x[i] = r[i] end
  for i = 0, 31 do
    for j = 0, 31 do x[i + j] = x[i + j] + h[i] * d[j] end
  end
  local s = {}
  modL(s, x)
  return Rs .. toString0(s, 32)
end

local function unpackneg(r, p)
  local t, chk, num, den, den2, den4, den6 = gf(), gf(), gf(), gf(), gf(), gf(), gf()
  set25519(r[2], gf1)
  unpack25519(r[1], p)
  S(num, r[1])
  M(den, num, D)
  Z(num, num, r[2])
  A(den, r[2], den)
  S(den2, den)
  S(den4, den2)
  M(den6, den4, den2)
  M(t, den6, num)
  M(t, t, den)
  pow2523(t, t)
  M(t, t, num)
  M(t, t, den)
  M(t, t, den)
  M(r[0], t, den)
  S(chk, r[0])
  M(chk, chk, den)
  if neq25519(chk, num) then M(r[0], r[0], I) end
  S(chk, r[0])
  M(chk, chk, den)
  if neq25519(chk, num) then return false end
  -- Bouncy Castle's decodePointVar: x = 0 with the sign bit set is not a point
  local packed = {}
  pack25519(packed, r[0])
  local zero = true
  for i = 0, 31 do if packed[i] ~= 0 then zero = false break end end
  if zero and floor(p[31] / 128) == 1 then return false end
  if par25519(r[0]) == floor(p[31] / 128) then Z(r[0], gf0, r[0]) end
  M(r[3], r[0], r[1])
  return true
end

-- little-endian 256-bit compare of byte arrays (0-based), a >= b
local function gte(a, b)
  for i = 31, 0, -1 do
    if a[i] ~= b[i] then return a[i] > b[i] end
  end
  return true
end

local P_BYTES = { [0] = 0xed }
for i = 1, 30 do P_BYTES[i] = 0xff end
P_BYTES[31] = 0x7f

-- y values of the points of order 8 (Bouncy Castle's ORDER8_y1, ORDER8_y2), little-endian bytes
local function wordsToBytes(words)
  local t = {}
  for i, w in ipairs(words) do
    for j = 0, 3 do t[(i - 1) * 4 + j] = floor(w / 256 ^ j) % 256 end
  end
  return t
end
local ORDER8_Y1 = wordsToBytes({ 0x706A17C7, 0x4FD84D3D, 0x760B3CBA, 0x0F67100D, 0xFA53202A, 0xC6CC392C, 0x77FDC74E, 0x7A03AC92 })
local ORDER8_Y2 = wordsToBytes({ 0x8F95E826, 0xB027B2C2, 0x89F4C345, 0xF098EFF2, 0x05ACDFD5, 0x3933C6D3, 0x880238B1, 0x05FC536D })

local function sameY(y, ref)
  for i = 0, 31 do if y[i] ~= ref[i] then return false end end
  return true
end

--- Bouncy Castle's checkPointFullVar: a canonical y, and not 0, 1, p - 1 or a point of order 8
local function checkPointFull(p)
  local y = {}
  for i = 0, 31 do y[i] = p[i] end
  y[31] = y[31] % 128
  local small = true
  for i = 1, 31 do if y[i] ~= 0 then small = false break end end
  if small and y[0] <= 1 then return false end
  local pm1 = {}
  for i = 0, 31 do pm1[i] = P_BYTES[i] end
  pm1[0] = 0xec
  if gte(y, pm1) then return false end
  if sameY(y, ORDER8_Y1) or sameY(y, ORDER8_Y2) then return false end
  return true
end

--- checkPointVar: y below p
local function checkPoint(p)
  local y = {}
  for i = 0, 31 do y[i] = p[i] end
  y[31] = y[31] % 128
  return not gte(y, P_BYTES)
end

--- true or false; nil when the public key is refused (Ed25519PublicKeyParameters' constructor validates it first)
function C.ed25519Verify(message, sig, pk)
  local R, Sb, pkb = zeroBased(sig:sub(1, 32)), zeroBased(sig:sub(33, 64)), zeroBased(pk)
  local q = point()
  if not checkPointFull(pkb) or not unpackneg(q, pkb) then return nil end
  if not checkPoint(R) then return false end
  if gte(Sb, L) then return false end
  local rPoint = point()
  if not unpackneg(rPoint, R) then return false end
  local h = zeroBased(C.sha512(sig:sub(1, 32) .. pk .. message))
  reduce(h)
  local p = point()
  scalarmult(p, q, h)
  local sb = point()
  scalarbase(sb, Sb)
  add(p, sb)
  local t = {}
  pack(t, p)
  for i = 0, 31 do
    if t[i] ~= R[i] then return false end
  end
  return true
end

return C
