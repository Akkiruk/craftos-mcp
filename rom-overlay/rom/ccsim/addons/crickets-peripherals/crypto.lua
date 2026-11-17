-- What Cricket's data coprocessor takes from the JDK: SHA-256 (MessageDigest), CRC-32 (java.util.zip.CRC32) and
-- AES/GCM/NoPadding with a 12-byte IV and a 128-bit tag (javax.crypto, CryptoUtil). Plain Lua on bit32; checked
-- against the JDK's output in packages/runner/src/crickets-peripherals.integration.test.ts.
local band, bor, bxor, bnot = bit32.band, bit32.bor, bit32.bxor, bit32.bnot
local lshift, rshift, rrotate = bit32.lshift, bit32.rshift, bit32.rrotate
local byte, char, concat = string.byte, string.char, table.concat

local C = {}

-- ===== SHA-256 =====

local K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

local function be32(n) return char(band(rshift(n, 24), 255), band(rshift(n, 16), 255), band(rshift(n, 8), 255), band(n, 255)) end

function C.sha256(msg)
  local len = #msg
  local extra = 64 - ((len + 9) % 64)
  if extra == 64 then extra = 0 end
  local bitLen = len * 8
  msg = msg .. "\128" .. string.rep("\0", extra) .. be32(math.floor(bitLen / 4294967296)) .. be32(bitLen % 4294967296)
  local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
  local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  local w = {}
  for chunk = 1, #msg, 64 do
    for i = 0, 15 do
      local a, b, c, d = byte(msg, chunk + i * 4, chunk + i * 4 + 3)
      w[i] = bor(lshift(a, 24), lshift(b, 16), lshift(c, 8), d)
    end
    for i = 16, 63 do
      local v15, v2 = w[i - 15], w[i - 2]
      local s0 = bxor(rrotate(v15, 7), rrotate(v15, 18), rshift(v15, 3))
      local s1 = bxor(rrotate(v2, 17), rrotate(v2, 19), rshift(v2, 10))
      w[i] = band(w[i - 16] + s0 + w[i - 7] + s1, 0xffffffff)
    end
    local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
    for i = 0, 63 do
      local S1 = bxor(rrotate(e, 6), rrotate(e, 11), rrotate(e, 25))
      local ch = bxor(band(e, f), band(bnot(e), g))
      local t1 = h + S1 + ch + K[i + 1] + w[i]
      local S0 = bxor(rrotate(a, 2), rrotate(a, 13), rrotate(a, 22))
      local maj = bxor(band(a, b), band(a, c), band(b, c))
      local t2 = S0 + maj
      h, g, f, e, d, c, b, a = g, f, e, band(d + t1, 0xffffffff), c, b, a, band(t1 + t2, 0xffffffff)
    end
    h0, h1, h2, h3 = band(h0 + a, 0xffffffff), band(h1 + b, 0xffffffff), band(h2 + c, 0xffffffff), band(h3 + d, 0xffffffff)
    h4, h5, h6, h7 = band(h4 + e, 0xffffffff), band(h5 + f, 0xffffffff), band(h6 + g, 0xffffffff), band(h7 + h, 0xffffffff)
  end
  return be32(h0) .. be32(h1) .. be32(h2) .. be32(h3) .. be32(h4) .. be32(h5) .. be32(h6) .. be32(h7)
end

-- ===== CRC-32 =====

local crcTable = {}
for i = 0, 255 do
  local c = i
  for _ = 1, 8 do
    if band(c, 1) ~= 0 then c = bxor(0xedb88320, rshift(c, 1)) else c = rshift(c, 1) end
  end
  crcTable[i] = c
end

function C.crc32(s)
  local c = 0xffffffff
  for i = 1, #s do c = bxor(crcTable[band(bxor(c, byte(s, i)), 255)], rshift(c, 8)) end
  return bxor(c, 0xffffffff)
end

-- ===== AES =====

local SBOX = {}
do
  -- the S-box from GF(2^8) inverses and the affine map
  local p, q = 1, 1
  repeat
    p = bxor(p, lshift(p, 1), band(p, 0x80) ~= 0 and 0x1b or 0)
    p = band(p, 0xff)
    q = bxor(q, lshift(q, 1)); q = bxor(q, lshift(q, 2)); q = bxor(q, lshift(q, 4)); q = band(q, 0xff)
    if band(q, 0x80) ~= 0 then q = bxor(q, 0x09) end
    local x = bxor(q, bor(lshift(q, 1), rshift(q, 7)), bor(lshift(q, 2), rshift(q, 6)), bor(lshift(q, 3), rshift(q, 5)),
      bor(lshift(q, 4), rshift(q, 4)))
    SBOX[p] = band(bxor(x, 0x63), 0xff)
  until p == 1
  SBOX[0] = 0x63
end
local function xtime(b) return band(bxor(lshift(b, 1), band(b, 0x80) ~= 0 and 0x1b or 0), 0xff) end

--- The key schedule (FIPS 197) for a 16, 24 or 32 byte key
local function expandKey(key)
  local nk = #key / 4
  local nr = nk + 6
  local w = {}
  for i = 0, #key - 1 do w[i] = byte(key, i + 1) end
  local rcon = 1
  for i = nk, 4 * (nr + 1) - 1 do
    local t0, t1, t2, t3 = w[(i - 1) * 4], w[(i - 1) * 4 + 1], w[(i - 1) * 4 + 2], w[(i - 1) * 4 + 3]
    if i % nk == 0 then
      t0, t1, t2, t3 = bxor(SBOX[t1], rcon), SBOX[t2], SBOX[t3], SBOX[t0]
      rcon = xtime(rcon)
    elseif nk > 6 and i % nk == 4 then
      t0, t1, t2, t3 = SBOX[t0], SBOX[t1], SBOX[t2], SBOX[t3]
    end
    local j = (i - nk) * 4
    w[i * 4], w[i * 4 + 1], w[i * 4 + 2], w[i * 4 + 3] = bxor(w[j], t0), bxor(w[j + 1], t1), bxor(w[j + 2], t2), bxor(w[j + 3], t3)
  end
  return w, nr
end

--- One 16-byte block (a table of 16 bytes, 0-based) through the cipher
local function encryptBlock(w, nr, s)
  local st = {}
  for i = 0, 15 do st[i] = bxor(s[i], w[i]) end
  for round = 1, nr do
    -- SubBytes and ShiftRows
    local t = {}
    for c = 0, 3 do
      for r = 0, 3 do t[c * 4 + r] = SBOX[st[((c + r) % 4) * 4 + r]] end
    end
    if round < nr then
      for c = 0, 3 do
        local a0, a1, a2, a3 = t[c * 4], t[c * 4 + 1], t[c * 4 + 2], t[c * 4 + 3]
        local x = bxor(a0, a1, a2, a3)
        t[c * 4] = bxor(a0, x, xtime(bxor(a0, a1)))
        t[c * 4 + 1] = bxor(a1, x, xtime(bxor(a1, a2)))
        t[c * 4 + 2] = bxor(a2, x, xtime(bxor(a2, a3)))
        t[c * 4 + 3] = bxor(a3, x, xtime(bxor(a3, a0)))
      end
    end
    local k = round * 16
    for i = 0, 15 do st[i] = bxor(t[i], w[k + i]) end
  end
  return st
end

-- ===== GCM (NIST SP 800-38D) =====

--- X * Y in GF(2^128), both as four 32-bit words, big-endian
local function gmul(x, y)
  local z0, z1, z2, z3 = 0, 0, 0, 0
  local v0, v1, v2, v3 = y[1], y[2], y[3], y[4]
  for i = 0, 127 do
    local word = x[rshift(i, 5) + 1]
    if band(word, lshift(1, 31 - (i % 32))) ~= 0 then
      z0, z1, z2, z3 = bxor(z0, v0), bxor(z1, v1), bxor(z2, v2), bxor(z3, v3)
    end
    local lsb = band(v3, 1)
    v3 = bor(rshift(v3, 1), lshift(band(v2, 1), 31))
    v2 = bor(rshift(v2, 1), lshift(band(v1, 1), 31))
    v1 = bor(rshift(v1, 1), lshift(band(v0, 1), 31))
    v0 = rshift(v0, 1)
    if lsb ~= 0 then v0 = bxor(v0, 0xe1000000) end
  end
  return { z0, z1, z2, z3 }
end

local function words(bytes16)
  local out = {}
  for i = 0, 3 do
    out[i + 1] = bor(lshift(bytes16[i * 4], 24), lshift(bytes16[i * 4 + 1], 16), lshift(bytes16[i * 4 + 2], 8), bytes16[i * 4 + 3])
  end
  return out
end

local function blockOf(s, at)
  local b = {}
  for i = 0, 15 do b[i] = byte(s, at + i) or 0 end
  return b
end

local function ghash(h, data)
  local y = { 0, 0, 0, 0 }
  for at = 1, #data, 16 do
    local x = words(blockOf(data, at))
    y = gmul({ bxor(y[1], x[1]), bxor(y[2], x[2]), bxor(y[3], x[3]), bxor(y[4], x[4]) }, h)
  end
  return y
end

local function ctr(w, nr, j0, data)
  local counter = {}
  for i = 0, 15 do counter[i] = j0[i] end
  local out = {}
  for at = 1, #data, 16 do
    -- inc32: the last four bytes count up
    for i = 15, 12, -1 do
      counter[i] = (counter[i] + 1) % 256
      if counter[i] ~= 0 then break end
    end
    local ks = encryptBlock(w, nr, counter)
    local n = math.min(16, #data - at + 1)
    local part = {}
    for i = 0, n - 1 do part[i + 1] = bxor(byte(data, at + i), ks[i]) end
    out[#out + 1] = char(table.unpack(part))
  end
  return concat(out)
end

local function tagOf(w, nr, h, j0, ciphertext)
  local pad = (16 - #ciphertext % 16) % 16
  local lenBlock = string.rep("\0", 8) .. be32(math.floor(#ciphertext * 8 / 4294967296)) .. be32((#ciphertext * 8) % 4294967296)
  local s = ghash(h, ciphertext .. string.rep("\0", pad) .. lenBlock)
  local ek = encryptBlock(w, nr, j0)
  local out = {}
  for i = 0, 3 do
    local word = s[i + 1]
    for k = 0, 3 do out[i * 4 + k + 1] = bxor(band(rshift(word, 24 - 8 * k), 255), ek[i * 4 + k]) end
  end
  return char(table.unpack(out))
end

local function setup(key, iv)
  local w, nr = expandKey(key)
  local zero = {}
  for i = 0, 15 do zero[i] = 0 end
  local h = words(encryptBlock(w, nr, zero))
  local j0 = blockOf(iv .. "\0\0\0\1", 1)
  return w, nr, h, j0
end

--- AES-GCM encryption with a 12-byte IV and no associated data: ciphertext followed by the 16-byte tag
function C.gcmEncrypt(key, iv, plaintext)
  local w, nr, h, j0 = setup(key, iv)
  local ct = ctr(w, nr, j0, plaintext)
  return ct .. tagOf(w, nr, h, j0, ct)
end

--- The plaintext, or nil when the tag does not match
function C.gcmDecrypt(key, iv, data)
  local w, nr, h, j0 = setup(key, iv)
  local ct, tag = data:sub(1, -17), data:sub(-16)
  if tagOf(w, nr, h, j0, ct) ~= tag then return nil end
  return ctr(w, nr, j0, ct)
end

return C
