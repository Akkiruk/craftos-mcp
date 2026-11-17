-- Guava's hash functions as Embedded Computer's HashUtil uses them: Hashing.sha256/sha512/murmur3_128/adler32/
-- sipHash24().hashString(s, ISO_8859_1).toString(), the lowercase hex of the HashCode's bytes. For the int and long
-- codes (adler32, sipHash24) those bytes are little-endian; murmur3_128 is h1 then h2, each little-endian.
-- 64-bit words are { hi, lo } pairs of 32-bit numbers. Checked against Guava 32.1.2 in the integration test.
local band, bor, bxor, bnot, lshift, rshift = bit32.band, bit32.bor, bit32.bxor, bit32.bnot, bit32.lshift, bit32.rshift
local byte = string.byte

local H = {}
local sha256 = dofile("/rom/ccsim/addons/crickets-peripherals/crypto.lua").sha256

local function hex(s) return (s:gsub(".", function(c) return ("%02x"):format(c:byte()) end)) end

-- ===== 64-bit words =====

local function add(a, b)
  local lo = a[2] + b[2]
  local carry = lo >= 4294967296 and 1 or 0
  return { (a[1] + b[1] + carry) % 4294967296, lo % 4294967296 }
end
local function xor(a, b) return { bxor(a[1], b[1]), bxor(a[2], b[2]) } end
local function andw(a, b) return { band(a[1], b[1]), band(a[2], b[2]) } end
local function notw(a) return { bnot(a[1]), bnot(a[2]) } end
local function rotl(a, n)
  n = n % 64
  if n == 0 then return { a[1], a[2] } end
  local hi, lo = a[1], a[2]
  if n >= 32 then hi, lo, n = lo, hi, n - 32 end
  if n == 0 then return { hi, lo } end
  return { bor(lshift(hi, n), rshift(lo, 32 - n)), bor(lshift(lo, n), rshift(hi, 32 - n)) }
end
local function rotr(a, n) return rotl(a, 64 - n) end
local function shr(a, n)
  if n >= 32 then return { 0, rshift(a[1], n - 32) } end
  if n == 0 then return { a[1], a[2] } end
  return { rshift(a[1], n), bor(rshift(a[2], n), lshift(a[1], 32 - n)) }
end
--- low 64 bits of a * b, in 16-bit limbs
local function mul(a, b)
  local x = { band(a[2], 0xffff), rshift(a[2], 16), band(a[1], 0xffff), rshift(a[1], 16) }
  local y = { band(b[2], 0xffff), rshift(b[2], 16), band(b[1], 0xffff), rshift(b[1], 16) }
  local r = { 0, 0, 0, 0 }
  for i = 1, 4 do
    local carry = 0
    for j = 1, 5 - i do
      local k = i + j - 1
      local t = r[k] + x[i] * y[j] + carry
      r[k] = t % 65536
      carry = math.floor(t / 65536)
    end
  end
  return { r[4] * 65536 + r[3], r[2] * 65536 + r[1] }
end
local function w(h, l) return { h, l } end
local function leBytes(a)
  local out = {}
  for i = 0, 3 do out[#out + 1] = band(rshift(a[2], 8 * i), 255) end
  for i = 0, 3 do out[#out + 1] = band(rshift(a[1], 8 * i), 255) end
  return out
end
local function le64(s, at) -- 8 bytes little-endian from s at 1-based `at`
  local b = { byte(s, at, at + 7) }
  return { b[5] + b[6] * 256 + b[7] * 65536 + b[8] * 16777216, b[1] + b[2] * 256 + b[3] * 65536 + b[4] * 16777216 }
end
local function hexBytes(t)
  local out = {}
  for i, b in ipairs(t) do out[i] = ("%02x"):format(b) end
  return table.concat(out)
end

-- ===== SHA-512 =====

local K512 = {}
do
  local k = {
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
  for i, h in ipairs(k) do K512[i] = { tonumber(h:sub(1, 8), 16), tonumber(h:sub(9, 16), 16) } end
end

function H.sha512(msg)
  local len = #msg
  local extra = (112 - (len + 1) % 128) % 128
  local bits = len * 8
  msg = msg .. "\128" .. string.rep("\0", extra) .. string.rep("\0", 8)
    .. string.char(0, 0, band(rshift(math.floor(bits / 4294967296), 8), 255), band(math.floor(bits / 4294967296), 255),
      band(rshift(bits % 4294967296, 24), 255), band(rshift(bits % 4294967296, 16), 255),
      band(rshift(bits % 4294967296, 8), 255), band(bits % 4294967296, 255))
  local hv = {
    w(0x6a09e667, 0xf3bcc908), w(0xbb67ae85, 0x84caa73b), w(0x3c6ef372, 0xfe94f82b), w(0xa54ff53a, 0x5f1d36f1),
    w(0x510e527f, 0xade682d1), w(0x9b05688c, 0x2b3e6c1f), w(0x1f83d9ab, 0xfb41bd6b), w(0x5be0cd19, 0x137e2179),
  }
  for chunk = 1, #msg, 128 do
    local W = {}
    for i = 0, 15 do
      local a, b, c, d, e, f, g, h = byte(msg, chunk + i * 8, chunk + i * 8 + 7)
      W[i] = { ((a * 256 + b) * 256 + c) * 256 + d, ((e * 256 + f) * 256 + g) * 256 + h }
    end
    for i = 16, 79 do
      local s0 = xor(xor(rotr(W[i - 15], 1), rotr(W[i - 15], 8)), shr(W[i - 15], 7))
      local s1 = xor(xor(rotr(W[i - 2], 19), rotr(W[i - 2], 61)), shr(W[i - 2], 6))
      W[i] = add(add(W[i - 16], s0), add(W[i - 7], s1))
    end
    local a, b, c, d, e, f, g, h = hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], hv[8]
    for i = 0, 79 do
      local S1 = xor(xor(rotr(e, 14), rotr(e, 18)), rotr(e, 41))
      local ch = xor(andw(e, f), andw(notw(e), g))
      local t1 = add(add(add(h, S1), add(ch, K512[i + 1])), W[i])
      local S0 = xor(xor(rotr(a, 28), rotr(a, 34)), rotr(a, 39))
      local maj = xor(xor(andw(a, b), andw(a, c)), andw(b, c))
      local t2 = add(S0, maj)
      h, g, f, e, d, c, b, a = g, f, e, add(d, t1), c, b, a, add(t1, t2)
    end
    hv = { add(hv[1], a), add(hv[2], b), add(hv[3], c), add(hv[4], d), add(hv[5], e), add(hv[6], f), add(hv[7], g),
      add(hv[8], h) }
  end
  local out = {}
  for i = 1, 8 do out[i] = ("%08x%08x"):format(hv[i][1], hv[i][2]) end
  return table.concat(out)
end

-- ===== Murmur3 x64 128, seed 0 =====

local C1, C2 = w(0x87c37b91, 0x114253d5), w(0x4cf5ad43, 0x2745937f)
local function fmix(k)
  k = xor(k, shr(k, 33))
  k = mul(k, w(0xff51afd7, 0xed558ccd))
  k = xor(k, shr(k, 33))
  k = mul(k, w(0xc4ceb9fe, 0x1a85ec53))
  return xor(k, shr(k, 33))
end

function H.murmur3(s)
  local h1, h2 = w(0, 0), w(0, 0)
  local n = #s
  local blocks = math.floor(n / 16)
  for i = 0, blocks - 1 do
    local k1, k2 = le64(s, i * 16 + 1), le64(s, i * 16 + 9)
    k1 = mul(rotl(mul(k1, C1), 31), C2)
    h1 = xor(h1, k1)
    h1 = add(mul(add(rotl(h1, 27), h2), w(0, 5)), w(0, 0x52dce729))
    k2 = mul(rotl(mul(k2, C2), 33), C1)
    h2 = xor(h2, k2)
    h2 = add(mul(add(rotl(h2, 31), h1), w(0, 5)), w(0, 0x38495ab5))
  end
  local tail = s:sub(blocks * 16 + 1) .. string.rep("\0", 16)
  local rem = n % 16
  if rem > 0 then
    local function part(at, count)
      local t = {}
      for i = 1, 8 do t[i] = i <= count and byte(tail, at + i - 1) or 0 end
      return { t[5] + t[6] * 256 + t[7] * 65536 + t[8] * 16777216, t[1] + t[2] * 256 + t[3] * 65536 + t[4] * 16777216 }
    end
    if rem > 8 then
      local k2 = part(9, rem - 8)
      h2 = xor(h2, mul(rotl(mul(k2, C2), 33), C1))
    end
    local k1 = part(1, math.min(rem, 8))
    h1 = xor(h1, mul(rotl(mul(k1, C1), 31), C2))
  end
  h1 = xor(h1, w(0, n))
  h2 = xor(h2, w(0, n))
  h1 = add(h1, h2)
  h2 = add(h2, h1)
  h1, h2 = fmix(h1), fmix(h2)
  h1 = add(h1, h2)
  h2 = add(h2, h1)
  local out = leBytes(h1)
  for _, b in ipairs(leBytes(h2)) do out[#out + 1] = b end
  return hexBytes(out)
end

-- ===== Adler-32 =====

function H.adler32(s)
  local a, b = 1, 0
  for i = 1, #s do
    a = (a + byte(s, i)) % 65521
    b = (b + a) % 65521
  end
  local v = b * 65536 + a
  return hexBytes({ band(v, 255), band(rshift(v, 8), 255), band(rshift(v, 16), 255), band(rshift(v, 24), 255) })
end

-- ===== SipHash-2-4, Guava's default key 00 01 02 ... 0f =====

function H.siphash24(s)
  local k0, k1 = w(0x07060504, 0x03020100), w(0x0f0e0d0c, 0x0b0a0908)
  local v0 = xor(w(0x736f6d65, 0x70736575), k0)
  local v1 = xor(w(0x646f7261, 0x6e646f6d), k1)
  local v2 = xor(w(0x6c796765, 0x6e657261), k0)
  local v3 = xor(w(0x74656462, 0x79746573), k1)
  local function round()
    v0 = add(v0, v1); v1 = rotl(v1, 13); v1 = xor(v1, v0); v0 = rotl(v0, 32)
    v2 = add(v2, v3); v3 = rotl(v3, 16); v3 = xor(v3, v2)
    v0 = add(v0, v3); v3 = rotl(v3, 21); v3 = xor(v3, v0)
    v2 = add(v2, v1); v1 = rotl(v1, 17); v1 = xor(v1, v2); v2 = rotl(v2, 32)
  end
  local n = #s
  local full = math.floor(n / 8)
  for i = 0, full - 1 do
    local m = le64(s, i * 8 + 1)
    v3 = xor(v3, m); round(); round(); v0 = xor(v0, m)
  end
  local t = { byte(s, full * 8 + 1, n) }
  for i = #t + 1, 7 do t[i] = 0 end
  t[8] = n % 256
  local m = { t[5] + t[6] * 256 + t[7] * 65536 + t[8] * 16777216, t[1] + t[2] * 256 + t[3] * 65536 + t[4] * 16777216 }
  v3 = xor(v3, m); round(); round(); v0 = xor(v0, m)
  v2 = xor(v2, w(0, 0xff))
  round(); round(); round(); round()
  return hexBytes(leBytes(xor(xor(v0, v1), xor(v2, v3))))
end

function H.sha256(s) return hex(sha256(s)) end

return H
