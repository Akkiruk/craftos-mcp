-- ccsim classic-peripherals: Classic Peripherals by AlexDevs (Ale32bit/ClassicPeripherals), its five peripherals
-- and the os.nfc / os.ban modules.
--
-- Two releases, picked by the world's Minecraft version:
--   1.20.1: 0.5.1 (Fabric only), tag v0.5.1, src/main/java/me/alexdevs/classicPeripherals/
--   1.21.1: 0.6.6 (Fabric and NeoForge), tag v0.6.6, common/src/main/java/me/alexdevs/classicPeripherals/
-- Paths in the comments are relative to those roots; `051:` and `066:` mark which release a rule comes from.
-- The mod's Crypto and Compression classes were run on a JVM (JDK 17 for 0.5.1, 21 for 0.6.6, Bouncy Castle 1.78.1
-- from the mod's jar) to make the vectors the integration test checks crypto.lua and zlib.lua against.
-- docs/classic-peripherals.md lists the fixture fields, sim commands and what is not emulated.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/classic-peripherals/crypto.lua")
  local Z = dofile("/rom/ccsim/addons/classic-peripherals/zlib.lua")
  -- the JVM's crypto and zlib cost the computer no time; the Lua ports' long loops count as the server's work
  if core.serverWork then C.work, Z.work = core.serverWork, core.serverWork end
  local floor, ceil, sqrt, huge = math.floor, math.ceil, math.sqrt, math.huge
  local queueEvent = os.queueEvent

  local V066 = core.version.mc ~= "1.20.1" -- 1.21.1 runs 0.6.6; the addon has no 1.18.2 release
  local world = core.world.classicPeripherals or {}
  local conf = world.config or {}
  local function cfg(key, default)
    local v = conf[key]
    if v == nil then return default end
    return v
  end
  -- ClassicPeripheralsConfig defaults
  local CONFIG = {
    radioTowerMaxHeight = cfg("radioTowerMaxHeight", 24),
    radioTowerMinHeight = cfg("radioTowerMinHeight", 2),
    radioTowerSegmentRange = cfg("radioTowerSegmentRange", 128),
    radioTowerMinY = V066 and cfg("radioTowerMinY", 96) or 96, -- 051 has 96 written in getEffectiveMaxRange
    radioTowerLossFactor = cfg("radioTowerLossFactor", 0.15),
    radioTowerMaxMessageSize = cfg("radioTowerMaxMessageSize", 8 * 1024 * 1024),
    antennaCanBroadcast = cfg("antennaCanBroadcast", true),
    nfcMaxDataSize = cfg("nfcMaxDataSize", 128),
    rfidScanRange = cfg("rfidScanRange", 8),
    cryptographicRandomBytesMaxSize = cfg("cryptographicRandomBytesMaxSize", 65536), -- 066
  }

  local M = {}

  --- peripheral.getMethods order: CC puts the @LuaFunction methods into `new HashMap<>(count)` in Class.getMethods
  --- order (taken as declaration order, which only matters inside a bucket); String.hashCode picks the bucket.
  local function hashMapOrder(keys)
    local n = #keys
    local cap = 1
    while cap < n do cap = cap * 2 end
    local threshold = floor(cap * 0.75)
    for size = 1, n do
      if size > threshold then
        cap = cap * 2
        threshold = floor(cap * 0.75)
      end
    end
    local rows = {}
    for i, k in ipairs(keys) do
      local h = 0
      for j = 1, #k do h = (h * 31 + k:byte(j)) % 4294967296 end
      h = bit32.bxor(h, bit32.rshift(h, 16))
      rows[i] = { k = k, i = i, b = bit32.band(h, cap - 1) }
    end
    table.sort(rows, function(a, b)
      if a.b ~= b.b then return a.b < b.b end
      return a.i < b.i
    end)
    local out = {}
    for i, r in ipairs(rows) do out[i] = r.k end
    return out
  end

  -- declaration order in each peripheral class
  local CRYPTO_DECL = { "md5", "sha1", "sha256", "sha512" }
  if V066 then CRYPTO_DECL[#CRYPTO_DECL + 1] = "blake3" end
  for _, name in ipairs({ "hmacMd5", "hmacSha1", "hmacSha256", "hmacSha512", "random", "randomBytes", "encodeBase64",
    "decodeBase64", "encryptAes", "decryptAes", "generatePrivateKey", "derivePublicKey", "sign", "verify",
    "deriveEcdhPublicKey", "computeSharedSecret" }) do
    CRYPTO_DECL[#CRYPTO_DECL + 1] = name
  end
  if V066 then
    CRYPTO_DECL[#CRYPTO_DECL + 1] = "deflate"
    CRYPTO_DECL[#CRYPTO_DECL + 1] = "inflate"
  end
  local ORDER = {
    crypto = hashMapOrder(CRYPTO_DECL),
    radio = hashMapOrder({ "isValid", "broadcast", "canBroadcast", "setFrequency", "getFrequency", "getHeight" }),
    nfc = hashMapOrder({ "write", "cancelWrite", "sign", "cancelSign" }),
    scanner = hashMapOrder({ "hasPages", "getLabel", "getPageCount", "eject", "scan" }),
  }

  -- ===== Java-side helpers =====

  local function fail(message) error(message, 0) end
  local function javaThrow(text) fail("Java Exception Thrown: " .. text) end

  local function typeOf(v) return v == nil and "nil" or type(v) end
  local function badType(index, expected, v)
    fail(("bad argument #%d (%s expected, got %s)"):format(index, expected, typeOf(v)))
  end

  -- IArguments.getString / optString / optBoolean / getFiniteDouble / getLong, and (int) of a long
  local function str(index, v)
    if type(v) ~= "string" then badType(index, "string", v) end
    return v
  end
  local function optStr(index, v)
    if v == nil then return nil end
    return str(index, v)
  end
  local function optBool(index, v, default)
    if v == nil then return default end
    if type(v) ~= "boolean" then badType(index, "boolean", v) end
    return v
  end
  local function finite(index, v)
    if type(v) ~= "number" then badType(index, "number", v) end
    if v ~= v then fail(("bad argument #%d (number expected, got nan)"):format(index)) end
    if v == huge or v == -huge then fail(("bad argument #%d (number expected, got %s)"):format(index, v > 0 and "inf" or "-inf")) end
    return v
  end
  local function javaInt(index, v)
    finite(index, v)
    local n = v < 0 and ceil(v) or floor(v)
    if n >= 9223372036854775807 then return -1 end
    if n <= -9223372036854775808 then return 0 end
    n = n % 4294967296
    if n >= 2147483648 then n = n - 4294967296 end
    return n
  end
  local function optInt(index, v, default)
    if v == nil then return default end
    return javaInt(index, v)
  end

  -- CryptoUtils.assertKey / assertSignature (051: LuaUtils.validateKey / validateSignature, same messages)
  local function assertKey(key)
    if key ~= nil and #key ~= 32 then fail("Invalid key length, expected 32 bytes.") end
    return key
  end
  local function assertSignature(sig)
    if sig ~= nil and #sig ~= 64 then fail("Invalid signature length, expected 64 bytes.") end
    return sig
  end
  -- 066 CryptoUtils.assertLength
  local function assertLength(index, value, ...)
    local lengths = { ... }
    for _, len in ipairs(lengths) do
      if value == len then return value end
    end
    local parts = {}
    for i, len in ipairs(lengths) do parts[i] = tostring(len) end
    fail(("bad argument length #%d (expected %s, got %d)"):format(index + 1, table.concat(parts, ", "), value))
  end

  --- CC's StringUtil.normaliseLabel (1.121.0): 32 characters at most, anything not printable is "?"
  local function normaliseLabel(label)
    local out = {}
    for i = 1, math.min(32, #label) do
      local c = label:byte(i)
      if (c >= 32 and c <= 126) or (c >= 161 and c <= 255) then out[i] = string.char(c) else out[i] = "?" end
    end
    return table.concat(out)
  end

  -- ===== randomness: SecureRandom, here a xorshift seeded from the world (classicPeripherals.seed) or the clock =====

  local rngState = { tonumber(world.seed) or os.epoch("utc"), 0x9E3779B9, 0x2545F491, 0x6C8E9CF5 }
  for i = 1, 4 do rngState[i] = math.floor(rngState[i]) % 4294967296 end
  if rngState[1] == 0 then rngState[1] = 1 end
  local function next32()
    local t = bit32.bxor(rngState[1], bit32.lshift(rngState[1], 11))
    rngState[1], rngState[2], rngState[3] = rngState[2], rngState[3], rngState[4]
    rngState[4] = bit32.bxor(rngState[4], bit32.rshift(rngState[4], 19), t, bit32.rshift(t, 8))
    return rngState[4]
  end
  for _ = 1, 8 do next32() end
  -- Random.nextDouble: 53 random bits
  local function nextDouble() return (floor(next32() / 32) * 67108864 + floor(next32() / 64)) / 9007199254740992 end
  local function randomBytes(n)
    local t = {}
    for i = 1, n do t[i] = next32() % 256 end
    return C.stringOf(t)
  end

  local function out(bytes, hex)
    if hex then return C.hex(bytes) end
    return bytes
  end

  -- ===== cryptographic accelerator (peripherals/crypto/AbstractCryptographicAcceleratorPeripheral.java) =====

  local function cryptoMethods()
    local m = {}
    local function hash(name, fn)
      m[name] = function(data, hex)
        data = str(1, data)
        hex = optBool(2, hex, true)
        return out(fn(data), hex)
      end
    end
    hash("md5", C.md5)
    hash("sha1", C.sha1)
    hash("sha256", C.sha256)
    hash("sha512", C.sha512)
    local function hmac(name, algo)
      m[name] = function(key, data, hex)
        key, data = str(1, key), str(2, data)
        hex = optBool(3, hex, true)
        return out(C.hmac(algo, key, data), hex)
      end
    end
    hmac("hmacMd5", "md5")
    hmac("hmacSha1", "sha1")
    hmac("hmacSha256", "sha256")
    hmac("hmacSha512", "sha512")

    function m.random(...)
      local n = select("#", ...)
      local a, b = ...
      if V066 then
        if n == 0 then return nextDouble() end
        if n == 1 then
          local max = finite(1, a)
          if max < 0 then fail("bad argument #1 (interval is empty)") end
          -- Crypto.secureRandom(max): 0 is nextDouble(Long.MIN_VALUE, Long.MAX_VALUE), like Lua's random(0)
          if max == 0 then return -9223372036854775808 + nextDouble() * 18446744073709551616 end
          local r = nextDouble() * max
          if r >= max then r = max - max * 2 ^ -53 end
          return r
        end
        local min, max = finite(1, a), finite(2, b)
        if max - min <= 0 then fail("bad argument #1 (interval is empty)") end
        if max - min == huge then javaThrow("java.lang.IllegalArgumentException: bound must be greater than origin") end
        local r = nextDouble() * (max - min) + min
        if r >= max then r = max - math.abs(max) * 2 ^ -53 end
        return r
      end
      -- 051: an int bound, and floor(value * max) + min for two (the mod's own formula)
      local value = nextDouble()
      if n == 0 then return value end
      if n == 1 then return floor(value * javaInt(1, a)) end
      local min, max = javaInt(1, a), javaInt(2, b)
      return floor(value * max) + min
    end

    function m.randomBytes(length)
      length = javaInt(1, length)
      local limit = V066 and CONFIG.cryptographicRandomBytesMaxSize or 0x7ffffff0
      if length > limit then fail("buffer size limit exceeded") end
      if length < 0 then javaThrow("java.lang.NegativeArraySizeException: " .. length) end
      return randomBytes(length)
    end

    function m.encodeBase64(data) return C.base64Encode(str(1, data)) end
    function m.decodeBase64(data)
      local decoded, problem = C.base64Decode(str(1, data))
      if decoded then return decoded end
      if V066 then return nil end -- caught: null
      javaThrow("java.lang.IllegalArgumentException: " .. problem)
    end

    local function aes(encrypt)
      return function(data, key, iv)
        data, key, iv = str(1, data), str(2, key), str(3, iv)
        if V066 then
          assertLength(1, #key, 16, 24, 32)
          assertLength(2, #iv, 16)
          if encrypt then return C.aesEncrypt(data, key, iv) end
          -- PaddedBufferedBlockCipher.doFinal: a part block is a DataLengthException, which nobody catches
          if #data == 0 or #data % 16 ~= 0 then
            javaThrow("org.bouncycastle.crypto.DataLengthException: last block incomplete in decryption")
          end
          local plain = C.aesDecrypt(data, key, iv)
          if not plain then fail("pad block corrupted") end
          return plain
        end
        -- 051: javax.crypto AES/CBC/PKCS5Padding (SunJCE). SecretKeySpec throws for an empty key (not caught);
        -- the IV length is checked before the key length.
        if #key == 0 then javaThrow("java.lang.IllegalArgumentException: Empty key") end
        if #iv ~= 16 then fail("Wrong IV length: must be 16 bytes long") end
        if #key ~= 16 and #key ~= 24 and #key ~= 32 then fail(("Invalid AES key length: %d bytes"):format(#key)) end
        if encrypt then return C.aesEncrypt(data, key, iv) end
        if #data % 16 ~= 0 then fail("Input length must be multiple of 16 when decrypting with padded cipher") end
        if #data == 0 then return "" end
        local plain = C.aesDecrypt(data, key, iv)
        if not plain then
          fail("Given final block not properly padded. Such issues can arise if a bad key is used during decryption.")
        end
        return plain
      end
    end
    m.encryptAes = aes(true)
    m.decryptAes = aes(false)

    function m.generatePrivateKey() return randomBytes(32) end
    function m.derivePublicKey(privateKey)
      return C.ed25519Public(assertKey(str(1, privateKey)))
    end
    function m.sign(message, privateKey)
      message, privateKey = str(1, message), str(2, privateKey)
      assertKey(privateKey)
      return C.ed25519Sign(message, privateKey)
    end
    function m.verify(message, signature, publicKey)
      message, signature, publicKey = str(1, message), str(2, signature), str(3, publicKey)
      assertKey(publicKey)
      assertSignature(signature)
      -- new Ed25519PublicKeyParameters(pub) refuses a key that is not a valid point of large order
      local valid, result = C.ed25519Verify(message, signature, publicKey)
      if valid == nil then javaThrow("java.lang.IllegalArgumentException: invalid public key") end
      return valid
    end
    function m.deriveEcdhPublicKey(privateKey)
      return C.x25519Public(assertKey(str(1, privateKey)))
    end
    function m.computeSharedSecret(privateKey, peerPublicKey)
      privateKey, peerPublicKey = str(1, privateKey), str(2, peerPublicKey)
      assertKey(privateKey)
      assertKey(peerPublicKey)
      local secret = C.x25519(privateKey, peerPublicKey)
      if secret == ("\0"):rep(32) then javaThrow("java.lang.IllegalStateException: X25519 agreement failed") end
      return secret
    end

    if V066 then
      local MODES = { hash = true, keyed = true, derive = true }
      function m.blake3(...)
        local args = table.pack(...)
        local data = str(1, args[1])
        local hex = optBool(2, args[2], true)
        local mode = "hash"
        if args[3] ~= nil then
          local name = str(3, args[3])
          mode = name:lower()
          if not MODES[mode] then fail(("bad argument #3 (unknown option %s)"):format(name)) end
        end
        local size = optInt(5, args[5], 32)
        if size <= 0 then fail("output size must be greater than 0") end
        if size > 4096 then fail("output size must be less than or equal to 4096") end
        if mode == "hash" then return out(C.blake3Hash(data, size), hex) end
        local extra = str(4, args[4])
        if mode == "keyed" then return out(C.blake3Keyed(data, assertKey(extra), size), hex) end
        return out(C.blake3Derive(data, extra, size), hex)
      end
      function m.deflate(data) return Z.deflate(str(1, data)) end
      function m.inflate(data)
        local result = Z.inflate(str(1, data))
        if not result then fail("invalid compressed data format") end
        return result
      end
    end
    return m
  end

  local function computerThreadAll(methods)
    local t = {}
    for name in pairs(methods) do t[name] = true end
    return t
  end

  local function newCrypto(def)
    local p = { exactReturns = true, types = { "cryptographic_accelerator" }, methodOrder = ORDER.crypto }
    p.methods = cryptoMethods()
    p.computerThread = computerThreadAll(p.methods)
    return p
  end

  -- ===== positions =====

  local function positionOf(def)
    local pos = core.position or {}
    return tonumber(def.x) or tonumber(pos.x) or 0, tonumber(def.y) or tonumber(pos.y) or 0,
      tonumber(def.z) or tonumber(pos.z) or 0, def.dimension or pos.dimension or "minecraft:overworld"
  end

  -- ===== radio towers (peripherals/radio/*, core/RadioNetwork.java; 051: TowerNetwork) =====

  local radios = {} -- in world order
  local broadcasts = {} -- what this world's radios sent, for sim state
  local MAX_BROADCAST_LOG = 50

  -- Random flips of ceil(bits * fraction) bits, as AbstractRadioPeripheral.flipString draws them
  local function flipString(data, fraction)
    local total = #data * 8
    local toFlip = ceil(total * fraction)
    if toFlip <= 0 or total == 0 then return data end
    local bytes = C.bytesOf(data)
    for _ = 1, toFlip do
      local bit = next32() % total
      local index = floor(bit / 8) + 1
      bytes[index] = bit32.bxor(bytes[index], 2 ^ (bit % 8))
    end
    return C.stringOf(bytes)
  end

  local function newRadio(def)
    local kind = def.kind or "tower" -- tower | antenna | pocket | turtle
    local r = { def = def, name = def.name, kind = kind }
    r.channel = javaInt(1, tonumber(def.frequency) or 0) -- radio_channel; one channel per frequency (STEP 1)
    r.lastPing = nil

    local function towerValid()
      local height = floor(tonumber(def.height) or 2)
      if def.complete == false then return false, height end
      if height > CONFIG.radioTowerMaxHeight then return false, height end
      if height < CONFIG.radioTowerMinHeight then return false, height end
      return true, height
    end

    function r.isValid()
      if kind == "tower" then
        if def.valid == false then return false end
        return (towerValid())
      end
      if kind == "antenna" then return def.valid ~= false end
      return true
    end
    function r.height()
      if kind == "tower" then
        local _, height = towerValid()
        return r.isValid() and height or 1
      end
      return 1
    end
    -- getPosition: the antenna block's lower corner (a tower's head), the pocket's holder, the turtle's block
    function r.position()
      local x, y, z, dim = positionOf(def)
      if kind == "tower" then y = y + r.height() - 1 end
      if kind ~= "pocket" then x, y, z = floor(x), floor(y), floor(z) end
      return x, y, z, dim
    end
    function r.range()
      if kind ~= "tower" or not r.isValid() then return 0 end
      local maxRange = r.height() * CONFIG.radioTowerSegmentRange
      local _, y = r.position()
      if V066 then y = y + 0.5 end -- getAntennaRadioPos: the block's centre
      if y >= CONFIG.radioTowerMinY then return maxRange end
      local v = maxRange * 1.0375 ^ (y - CONFIG.radioTowerMinY)
      return v < 0 and ceil(v) or floor(v)
    end
    function r.canBroadcast()
      if kind == "tower" then return r.isValid() end
      return CONFIG.antennaCanBroadcast == true
    end

    --- AbstractRadioPeripheral.receive
    function r.receive(data, distance, range)
      if not r.isValid() then return end
      local safe = range - range * CONFIG.radioTowerLossFactor
      if distance > safe then
        data = flipString(data, (distance - safe) / (range - safe))
      end
      queueEvent("radio_message", r.name, data, distance)
      r.lastPing = os.epoch("utc")
    end

    local p = { exactReturns = true, types = { "radio_tower" }, methodOrder = ORDER.radio }
    local m = {}
    function m.isValid() return r.isValid() end
    function m.canBroadcast() return r.canBroadcast() end
    function m.broadcast(data)
      data = str(1, data)
      if not r.isValid() then fail("The radio tower is not built correctly.") end
      if not r.canBroadcast() then fail("This antenna is not capable of broadcasting.") end
      M.broadcast(r, data)
      r.lastPing = os.epoch("utc")
    end
    function m.setFrequency(frequency)
      frequency = javaInt(1, frequency)
      if frequency < 0 or frequency > 65535 then fail("Frequency out of range. Must be between 0 and 65535.") end
      if not r.isValid() then fail("The radio tower is not built correctly.") end
      r.channel = frequency
    end
    function m.getFrequency()
      if not r.isValid() then fail("The radio tower is not built correctly.") end
      return r.channel
    end
    function m.getHeight()
      if not r.isValid() then fail("The radio tower is not built correctly.") end
      return r.height()
    end
    p.methods = m
    p.computerThread = { isValid = true, canBroadcast = true, broadcast = true, getFrequency = true, getHeight = true }
    function p.state()
      local x, y, z = r.position()
      return { kind = kind, frequency = r.channel, valid = r.isValid(), height = r.height(), range = r.range(), x = x, y = y, z = z }
    end
    function p.detach()
      for i, other in ipairs(radios) do
        if other == r then table.remove(radios, i) break end
      end
    end
    radios[#radios + 1] = r
    return p
  end

  --- RadioNetwork.tryBroadcast to every receiver in this world. `sender` has position, range, channel and dimension.
  local function deliver(sender, data)
    for _, receiver in ipairs(radios) do
      if receiver ~= sender.radio then
        local sx, sy, sz, sdim = sender.x, sender.y, sender.z, sender.dimension
        local rx, ry, rz, rdim = receiver.position()
        if sdim == rdim and sender.channel == receiver.channel then
          local range = math.max(sender.range, receiver.range())
          local dx, dy, dz = rx - sx, ry - sy, rz - sz
          if V066 then dy = 0 end -- 066 measures across the ground: Y is set to 0 on both
          local square = dx * dx + dy * dy + dz * dz
          if square <= range * range then receiver.receive(data, sqrt(square), range) end
        end
      end
    end
  end

  function M.broadcast(r, data)
    if not r.canBroadcast() then return end
    data = data:sub(1, CONFIG.radioTowerMaxMessageSize)
    local x, y, z, dim = r.position()
    broadcasts[#broadcasts + 1] = { from = r.name, frequency = r.channel, data = data, x = x, y = y, z = z }
    if #broadcasts > MAX_BROADCAST_LOG then table.remove(broadcasts, 1) end
    deliver({ radio = r, x = x, y = y, z = z, dimension = dim, channel = r.channel, range = r.range() }, data)
  end

  -- ===== NFC cards and the reader (peripherals/nfc/*, core/dataHolder/DataHolderHandler; 051: ItemDataHandler) =====

  -- A card: { data, label, readOnly, privateKey, id }. `id` stands for the item's uuid: a card has one once it held
  -- data or was written, and only then can it hold a private key.
  local cards = {}
  for id, card in pairs(world.cards or {}) do
    cards[id] = {
      data = card.data or "", label = card.label, readOnly = card.readOnly == true, privateKey = card.privateKey,
      id = card.data ~= nil and card.data ~= "" or card.privateKey ~= nil or card.id == true,
    }
  end

  local function cardPrivateKey(card)
    if not card.id then return nil end
    if card.privateKey == nil or card.privateKey == "" then card.privateKey = randomBytes(32) end
    return card.privateKey
  end

  -- os.nfc, the pocket computer's module (peripherals/nfc/luaApi/*): this computer's own data and key
  local pocketNfc = { data = nil, key = nil }

  local function newReader(def)
    local reader = { state = "idle", pendingWrite = nil, pendingSign = nil, lastRead = nil }
    local name = def.name
    local function read(data, publicKey) queueEvent("nfc_data", name, data, publicKey) end
    local function cancelWrite()
      reader.state, reader.pendingWrite = "idle", nil
    end
    local function cancelSign()
      reader.state, reader.pendingSign = "idle", nil
    end
    local function doSigning(privateKey)
      if privateKey == nil or reader.pendingSign == nil then return false end
      local signature = C.ed25519Sign(reader.pendingSign, privateKey)
      queueEvent("nfc_sign", name, signature, C.ed25519Public(privateKey))
      cancelSign()
      return true
    end

    --- NfcReaderBlockEntity.onUse: a card held to the reader
    function reader.tapCard(card)
      if reader.state == "writing" and reader.pendingWrite then
        if card.readOnly then
          queueEvent("nfc_write", name, false, "read_only")
          cancelWrite()
          return
        end
        local w = reader.pendingWrite
        card.label = w.label
        card.data = w.data
        card.id = true
        card.readOnly = w.readOnly
        if w.privateKey ~= nil then card.privateKey = w.privateKey end
        queueEvent("nfc_write", name, true, "success")
        cancelWrite()
      elseif reader.state == "signing" then
        local key = cardPrivateKey(card)
        if key then doSigning(key) end
      else
        local key = cardPrivateKey(card)
        local publicKey = key and C.ed25519Public(key) or nil
        if card.id and card.data ~= "" then
          read(card.data, publicKey)
          reader.lastRead = os.epoch("utc")
        end
      end
    end

    --- onPocketUse: a pocket computer with the NFC module held to the reader. `pocket` is { data, key, self }.
    function reader.tapPocket(pocket)
      if reader.state == "writing" and reader.pendingWrite then
        if pocket.self then
          local w = reader.pendingWrite
          queueEvent("nfc_data", "internal", w.data, w.label, w.readOnly, w.privateKey)
        end
        cancelWrite()
      end
      -- PocketNfcAccess.getPrivateKey answers the public key of the stored key, and the reader takes that for the key
      local privateKey = pocket.key and C.ed25519Public(pocket.key) or nil
      local publicKey = privateKey and C.ed25519Public(privateKey) or nil
      if reader.state == "signing" and reader.pendingSign then
        if not doSigning(privateKey) then return end
      end
      local data = pocket.data
      pocket.data = nil
      if data ~= nil then read(data, publicKey) end
    end

    local p = { exactReturns = true, types = { "nfc_reader" }, methodOrder = ORDER.nfc }
    local m = {}
    function m.write(data, label, readOnly, privateKey)
      data = str(1, data)
      label = optStr(2, label)
      readOnly = optBool(3, readOnly, false)
      privateKey = optStr(4, privateKey)
      if privateKey ~= nil then assertKey(privateKey) end
      -- flagWrite
      if reader.state == "signing" then cancelSign() end
      reader.state = "writing"
      reader.pendingWrite = {
        data = data:sub(1, CONFIG.nfcMaxDataSize),
        label = label and normaliseLabel(label) or nil,
        readOnly = readOnly,
        privateKey = privateKey,
      }
    end
    function m.cancelWrite()
      local was = reader.state == "writing"
      cancelWrite()
      return was
    end
    function m.sign(data)
      data = str(1, data)
      if reader.state == "writing" then cancelWrite() end
      reader.state, reader.pendingSign = "signing", data
    end
    function m.cancelSign()
      local was = reader.state == "signing"
      cancelSign()
      return was
    end
    p.methods = m
    p.computerThread = {} -- all four are mainThread = true
    function p.state()
      return { mode = reader.state, pendingWrite = reader.pendingWrite, pendingSign = reader.pendingSign }
    end
    p.reader = reader
    return p
  end

  -- ===== RFID scanner (peripherals/rfid/*; 051: peripherals/RfidScannerPeripheral, tiles/RfidScannerBlockEntity) =====

  local entities = world.entities or {}

  local FACING = {
    north = { 0, 0, -1 }, south = { 0, 0, 1 }, east = { 1, 0, 0 }, west = { -1, 0, 0 }, up = { 0, 1, 0 }, down = { 0, -1, 0 },
  }

  local function newRfid(def)
    local kind = def.kind or "block" -- block | pocket | turtle
    local function origin()
      local x, y, z, dim = positionOf(def)
      if kind == "block" then
        -- the block in front of the scanner, its lower corner
        local f = FACING[def.facing or "north"] or FACING.north
        x, y, z = floor(x) + f[1], floor(y) + f[2], floor(z) + f[3]
      elseif kind == "turtle" then
        x, y, z = floor(x), floor(y), floor(z)
      end
      return x, y, z, dim
    end

    local function scanBadges()
      local ox, oy, oz, dim = origin()
      local range = CONFIG.rfidScanRange
      local badges = {}
      local function add(data, distance)
        if data ~= nil and data ~= "" then badges[#badges + 1] = { data = data, distance = distance } end
      end
      local function distanceTo(e)
        local dx, dy, dz = (e.x or 0) - ox, (e.y or 0) - oy, (e.z or 0) - oz
        return dx * dx + dy * dy + dz * dz
      end
      -- players within range (a sphere)
      for _, e in ipairs(entities) do
        if e.kind == "player" and (e.dimension or "minecraft:overworld") == dim then
          local square = distanceTo(e)
          if square <= range * range then
            local distance = sqrt(square)
            for _, data in ipairs(e.inventory or {}) do add(data, distance) end
            add(e.equipped, distance)
          end
        end
      end
      -- AABB.ofSize(origin, range, range, range): a box `range` wide around the origin, hit by bounding boxes
      local half = range / 2
      local function inBox(e, width, height)
        local w2 = (tonumber(e.width) or width) / 2
        local h = tonumber(e.height) or height
        local x, y, z = e.x or 0, e.y or 0, e.z or 0
        return x - w2 < ox + half and x + w2 > ox - half and y < oy + half and y + h > oy - half
          and z - w2 < oz + half and z + w2 > oz - half
      end
      for _, e in ipairs(entities) do
        if e.kind == "mob" and (e.dimension or "minecraft:overworld") == dim and inBox(e, 0.6, 1.8) then
          local distance = sqrt(distanceTo(e))
          add(e.injected, distance)
          for _, data in ipairs(e.hands or {}) do add(data, distance) end
        end
      end
      for _, e in ipairs(entities) do
        if e.kind == "item" and (e.dimension or "minecraft:overworld") == dim and inBox(e, 0.25, 0.25) then
          add(e.data, sqrt(distanceTo(e)))
        end
      end
      return badges
    end

    local scanning = false
    local p = { exactReturns = true, types = { "rfid_scanner" }, methodOrder = { "scan" } }
    local m = {}
    --- scan(): the scan runs SCAN_TIME (4) ticks later and queues rfid_scan; the call waits for the first rfid_scan
    --- event (any scanner's) like MethodResult.pullEvent, and returns its table.
    function m.scan()
      scanning = true
      core.after(0.2, function()
        scanning = false
        queueEvent("rfid_scan", def.name, scanBadges())
      end)
      while true do
        local ev = table.pack(os.pullEventRaw("rfid_scan"))
        if ev[1] == "rfid_scan" then
          if ev.n ~= 3 then fail("Java Exception Thrown: java.lang.NullPointerException") end
          return ev[3]
        elseif ev[1] == "terminate" then
          -- the callback answers null here and CC fails outside its handler; see docs/classic-peripherals.md
          fail("Terminated")
        end
      end
    end
    p.methods = m
    p.computerThread = { scan = true }
    function p.state()
      local x, y, z = origin()
      return { kind = kind, scanning = scanning, x = x, y = y, z = z }
    end
    return p
  end

  -- ===== scanner (peripherals/scanner/*; 051: peripherals/ScannerPeripheral, tiles/ScannerBlockEntity) =====

  local LINES_PER_PAGE, LINE_LENGTH = 21, 25

  --- A printout from the fixture: { title, pages, lines = { "text" | { text, color } } } or { item = "id" }.
  local function newPrintout(spec)
    if spec == nil then return nil end
    if spec.item and spec.item ~= "computercraft:printed_page" and spec.item ~= "computercraft:printed_pages"
        and spec.item ~= "computercraft:printed_book" then
      return { item = spec.item }
    end
    local pages = math.max(1, floor(tonumber(spec.pages) or 1))
    local text, colors = {}, {}
    local lines = spec.lines or {}
    for i = 1, pages * LINES_PER_PAGE do
      local line = lines[i]
      local t, c
      if type(line) == "table" then t, c = line.text or line[1], line.color or line[2] else t = line end
      t = tostring(t or ""):sub(1, LINE_LENGTH)
      text[i] = t .. (" "):rep(LINE_LENGTH - #t)
      c = tostring(c or ""):sub(1, LINE_LENGTH)
      colors[i] = c .. ("f"):rep(LINE_LENGTH - #c)
    end
    return { item = spec.item or "computercraft:printed_page", title = spec.title or "", pages = pages, text = text, colors = colors }
  end

  local function samePrintout(a, b)
    if a == nil or b == nil then return a == b end
    if a.item ~= b.item or a.title ~= b.title or a.pages ~= b.pages then return false end
    for i = 1, #(a.text or {}) do
      if a.text[i] ~= b.text[i] or a.colors[i] ~= b.colors[i] then return false end
    end
    return #(a.text or {}) == #(b.text or {})
  end

  local function newScanner(def)
    local s = { stored = newPrintout(def.printout), ejected = {} }
    s.seen = s.stored -- printoutStack: what the last updateState saw
    local name = def.name
    local function isPrintout(item) return item ~= nil and item.text ~= nil end

    --- ScannerBlockEntity.updateState: events when the slot's item changed
    local function updateState()
      if samePrintout(s.stored, s.seen) then return end
      if s.seen ~= nil then queueEvent("scanner_eject", name) end
      s.seen = s.stored
      if s.stored ~= nil then queueEvent("scanner", name) end
    end
    function s.set(item)
      s.stored = item
      updateState()
    end

    local p = { exactReturns = true, types = { "scanner" }, methodOrder = ORDER.scanner }
    local m = {}
    function m.hasPages() return isPrintout(s.stored) end
    function m.getLabel()
      if not isPrintout(s.stored) then return nil end
      if s.stored.title == "" then return nil end
      return s.stored.title
    end
    function m.getPageCount()
      if not isPrintout(s.stored) then return 0 end
      return s.stored.pages
    end
    function m.eject()
      -- ejectQueued: done on the next block tick
      core.after(0.05, function()
        if s.stored == nil then return end
        s.ejected[#s.ejected + 1] = s.stored.title ~= nil and s.stored.title or s.stored.item
        s.set(nil)
      end)
    end
    function m.scan()
      local item = s.stored
      if not isPrintout(item) then return nil end
      -- extractPages: page i holds its lines under their index in the whole printout (j + 1), not 1..21
      local pages = {}
      for i = 0, item.pages - 1 do
        local texts, colors = {}, {}
        for j = i * LINES_PER_PAGE, (i + 1) * LINES_PER_PAGE - 1 do
          texts[j + 1] = item.text[j + 1]
          colors[j + 1] = item.colors[j + 1]
        end
        pages[i + 1] = { texts, colors }
      end
      return pages
    end
    p.methods = m
    p.computerThread = computerThreadAll(m)
    function p.state()
      local item = s.stored
      return { printout = item and { item = item.item, title = item.title, pages = item.pages } or nil, ejected = s.ejected }
    end
    p.scanner = s
    return p
  end

  -- ===== os.nfc and os.ban (ModRegistry.LuaApis; 051: luaApi/ModLuaApiProvider, os.nfc only) =====

  local loaded = debug and debug.getregistry and debug.getregistry()._LOADED
  if world.pocket and type(loaded) == "table" then
    -- PocketNfcAPI: only a pocket computer gets it
    loaded["os.nfc"] = {
      write = function(data)
        data = optStr(1, data)
        if data == nil then pocketNfc.data = nil else pocketNfc.data = data:sub(1, CONFIG.nfcMaxDataSize) end
      end,
      setPrivateKey = function(key)
        key = optStr(1, key)
        assertKey(key)
        pocketNfc.key = key
      end,
      pop = function()
        local data = pocketNfc.data
        pocketNfc.data = nil
        return data
      end,
    }
  end
  if V066 and type(loaded) == "table" then
    -- BanModem: a modem on the wearer's own network, range 1. A computer that is not carried has a network of its
    -- own every time, so what it sends reaches nobody (and with one computer per world, so does a pocket's).
    local open, count = {}, 0
    local function channel(index, v)
      local c = javaInt(index, v)
      if c < 0 or c > 65535 then fail("Expected number in range 0-65535") end
      return c
    end
    loaded["os.ban"] = {
      open = function(c)
        c = channel(1, c)
        if not open[c] then
          if count >= 128 then fail("Too many open channels") end
          open[c], count = true, count + 1
        end
      end,
      isOpen = function(c) return open[channel(1, c)] == true end,
      close = function(c)
        c = channel(1, c)
        if open[c] then open[c], count = nil, count - 1 end
      end,
      closeAll = function() open, count = {}, 0 end,
      transmit = function(c, reply, _)
        channel(1, c)
        channel(2, reply)
      end,
      isWireless = function() return true end,
    }
  end

  -- ===== the module =====

  local readers, scanners = {}, {}

  function M.peripheral(def)
    local ty = def.type
    if ty == "cryptographic_accelerator" then return newCrypto(def) end
    if ty == "radio_tower" then return newRadio(def) end
    if ty == "nfc_reader" then
      local p = newReader(def)
      readers[def.name] = p.reader
      return p
    end
    if ty == "rfid_scanner" then return newRfid(def) end
    local p = newScanner(def)
    scanners[def.name] = p.scanner
    return p
  end

  local function needReader(cmd)
    local reader = readers[cmd.peripheral]
    if not reader then return nil, "no nfc_reader " .. tostring(cmd.peripheral) end
    return reader
  end

  M.handlers = {
    --- a card held to a reader: { peripheral, card } with a card id from classicPeripherals.cards, or a card table
    cpNfcTap = function(cmd)
      local reader, problem = needReader(cmd)
      if not reader then return false, problem end
      local card = cmd.card
      if type(card) == "string" then
        card = cards[card]
        if not card then return false, "no card " .. tostring(cmd.card) end
      elseif type(card) == "table" then
        card = { data = card.data or "", label = card.label, readOnly = card.readOnly == true, privateKey = card.privateKey,
          id = (card.data or "") ~= "" or card.privateKey ~= nil }
      else
        return false, "card must be a card id or a table"
      end
      reader.tapCard(card)
      return true
    end,
    --- a pocket computer held to a reader: { peripheral, self = true } is this computer (its os.nfc), or
    --- { peripheral, data?, privateKey? } another pocket
    cpNfcTapPocket = function(cmd)
      local reader, problem = needReader(cmd)
      if not reader then return false, problem end
      if cmd.self then
        local pocket = { data = pocketNfc.data, key = pocketNfc.key, self = true }
        reader.tapPocket(pocket)
        pocketNfc.data = pocket.data
      else
        reader.tapPocket({ data = cmd.data, key = cmd.privateKey })
      end
      return true
    end,
    --- someone uses a card on the player carrying this pocket computer: nfc_data "internal" (NfcCardItem)
    cpNfcCardToPocket = function(cmd)
      local card = type(cmd.card) == "string" and cards[cmd.card] or cmd.card
      if type(card) ~= "table" then return false, "no card " .. tostring(cmd.card) end
      if card.data and card.data ~= "" and world.pocket then queueEvent("nfc_data", "internal", card.data) end
      return true
    end,
    --- a broadcast from a radio outside this world: { frequency, data, x?, y?, z?, dimension?, range? }
    cpRadioReceive = function(cmd)
      if type(cmd.data) ~= "string" then return false, "data must be a string" end
      local pos = core.position or {}
      deliver({
        x = tonumber(cmd.x) or tonumber(pos.x) or 0, y = tonumber(cmd.y) or tonumber(pos.y) or 0, z = tonumber(cmd.z) or tonumber(pos.z) or 0,
        dimension = cmd.dimension or pos.dimension or "minecraft:overworld",
        channel = floor(tonumber(cmd.frequency) or 0), range = tonumber(cmd.range) or 0,
      }, cmd.data:sub(1, CONFIG.radioTowerMaxMessageSize))
      return true
    end,
    --- change a radio: { peripheral, valid?, height?, complete?, x?, y?, z? }
    cpSetRadio = function(cmd)
      for _, r in ipairs(radios) do
        if r.name == cmd.peripheral then
          for _, key in ipairs({ "valid", "height", "complete", "x", "y", "z", "dimension" }) do
            if cmd[key] ~= nil then r.def[key] = cmd[key] end
          end
          return true
        end
      end
      return false, "no radio_tower " .. tostring(cmd.peripheral)
    end,
    --- the entities RFID scanners see: { entities = [...] } (classicPeripherals.entities)
    cpSetEntities = function(cmd)
      if type(cmd.entities) ~= "table" then return false, "entities must be a list" end
      entities = cmd.entities
      return true
    end,
    --- put a printout in a scanner, or take it out with printout = null: { peripheral, printout }
    cpSetPrintout = function(cmd)
      local s = scanners[cmd.peripheral]
      if not s then return false, "no scanner " .. tostring(cmd.peripheral) end
      local spec = cmd.printout
      if spec == textutils.json_null then spec = nil end
      s.set(newPrintout(spec))
      return true
    end,
  }

  function M.state()
    local cardState = {}
    for id, card in pairs(cards) do
      cardState[id] = { data = card.data, label = card.label, readOnly = card.readOnly, hasKey = card.privateKey ~= nil }
    end
    return {
      version = V066 and "0.6.6" or "0.5.1",
      broadcasts = broadcasts,
      cards = next(cardState) and cardState or nil,
      pocketNfc = world.pocket and { data = pocketNfc.data, hasKey = pocketNfc.key ~= nil } or nil,
    }
  end

  return M
end
