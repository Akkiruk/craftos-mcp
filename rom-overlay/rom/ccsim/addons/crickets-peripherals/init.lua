-- ccsim addon crickets-peripherals: Cricket's Peripherals 0.1.1 (NeoForge, Minecraft 1.21.1), by PewPewCricket.
--
-- Written from the mod's source, github.com/PewPewCricket/crickets-peripherals at tag 0.1.1 (commit 5a263c0):
--   peripheral/PeripheralHardDrive.java, blockentity/BlockEntityHardDrive.java, main/Config.java (hddSize)
--   peripheral/PeripheralDataCoprocessor.java, util/CryptoUtil.java
-- under src/main/java/com/pewpewcricket/cricketsperipherals/. What the JDK does for the data coprocessor (Deflater,
-- Inflater, MessageDigest, CRC32, AES/GCM) is ported in zlib.lua and crypto.lua.
--
-- Every method is a plain @LuaFunction, so it answers at once on the computer thread. No events.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua") -- CC's argument checks, Java exceptions
  local order = dofile("/rom/ccsim/addons/javamap.lua").order -- getMethods order on CC 1.121
  local Z = dofile("/rom/ccsim/addons/crickets-peripherals/zlib.lua")
  local X = dofile("/rom/ccsim/addons/crickets-peripherals/crypto.lua")
  local M = {}
  local cfg = core.world.cricketsPeripherals or {}
  local HDD_SIZE = math.floor(tonumber(cfg.hddSize) or 2097152) -- Config.HDD_SIZE, default 2 MiB

  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end

  --- IArguments.getBytes: a string argument, as its bytes
  local function bytesArg(i, v)
    if type(v) ~= "string" then error(("bad argument #%d (string expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end

  local function randomBytes(n)
    local t = {}
    for i = 1, n do t[i] = math.random(0, 255) end
    return string.char(table.unpack(t))
  end

  -- ===== data_coprocessor =====

  local function newCoprocessor()
    local m = {}
    function m.deflate(data)
      return Z.deflate(bytesArg(1, data))
    end
    function m.inflate(data)
      local out, why = Z.inflate(bytesArg(1, data))
      if out then return out end
      -- why == "dictionary": a stream with a preset dictionary (FDICT). Java's inflate returns 0 with needsInput()
      -- false while input is left, and the mod's loop then never ends.
      error("ccsim: inflate of a zlib stream with a preset dictionary never returns in game (Cricket's loop spins)", 0)
    end
    function m.sha256(data)
      return X.sha256(bytesArg(1, data))
    end
    function m.crc32(data)
      return X.crc32(bytesArg(1, data))
    end
    function m.key()
      return randomBytes(32) -- KeyGenerator "AES" with init(256)
    end
    local function aesKey(keyBytes)
      -- new SecretKeySpec(keyBytes, "AES") refuses an empty key; Cipher.init refuses any length but 16, 24 or 32
      if #keyBytes == 0 then C.java("java.lang.IllegalArgumentException", "Empty key") end
      if #keyBytes ~= 16 and #keyBytes ~= 24 and #keyBytes ~= 32 then
        error(("Invalid AES key length: %d bytes"):format(#keyBytes), 0)
      end
      return keyBytes
    end
    function m.encrypt(data, key)
      data = bytesArg(1, data)
      key = bytesArg(2, key)
      key = aesKey(key)
      local iv = randomBytes(12) -- SecureRandom
      return iv .. X.gcmEncrypt(key, iv, data)
    end
    function m.decrypt(data, key)
      data = bytesArg(1, data)
      key = bytesArg(2, key)
      if #key == 0 then C.java("java.lang.IllegalArgumentException", "Empty key") end
      -- the IV is read before the key is used: fewer than 12 bytes is a BufferUnderflowException
      if #data < 12 then C.java("java.nio.BufferUnderflowException") end
      key = aesKey(key)
      local iv, rest = data:sub(1, 12), data:sub(13)
      if #rest < 16 then error("Input data too short to contain an expected tag length of 16bytes", 0) end
      local plain = X.gcmDecrypt(key, iv, rest)
      if not plain then error("Tag mismatch", 0) end
      return plain
    end
    function m.uuid()
      -- UUID.randomUUID(): version 4, IETF variant
      local b = { randomBytes(16):byte(1, 16) }
      b[7] = bit32.bor(bit32.band(b[7], 0x0f), 0x40)
      b[9] = bit32.bor(bit32.band(b[9], 0x3f), 0x80)
      local hex = ("%02x"):rep(16):format(table.unpack(b))
      return hex:sub(1, 8) .. "-" .. hex:sub(9, 12) .. "-" .. hex:sub(13, 16) .. "-" .. hex:sub(17, 20) .. "-" .. hex:sub(21)
    end
    return m, { "deflate", "inflate", "sha256", "crc32", "key", "encrypt", "decrypt", "uuid" }
  end

  -- ===== hard_drive =====
  -- BlockEntityHardDrive.attach mounts the drive's save folder (betterperipherals/hdd/<mountId>) writable at "hdd",
  -- or "hdd1", "hdd2"... when that name is taken (ComputerAccess.findFreeLocation: any existing file or folder). Here
  -- the folder is /results/addons/hdd/<mountId> on the host, mounted with the engine's own mounter, so files written
  -- through it are real files and survive a reboot of the same run.

  core.mounts = core.mounts or dofile("/rom/ccsim/addons/mounts.lua")(core)
  local mounts = core.mounts
  local nextMountId = 0

  local function newHardDrive(def)
    local o = { name = def.name }
    local s = saved(def.name)
    o.mountId = s and s.mountId or tonumber(def.mountId)
    if o.mountId then nextMountId = math.max(nextMountId, o.mountId + 1) end

    function o.attach()
      if o.path then return end -- computers.containsKey(computer)
      if not o.mountId then
        o.mountId = nextMountId -- createUniqueNumberedSaveDir
        nextMountId = nextMountId + 1
      end
      -- `files` in the fixture: what the drive held before the world started
      mounts.folder("hdd/" .. o.mountId, not (s and s.mountId) and def.files or nil)
      for i = 0, math.huge do
        local location = mounts.mount(i == 0 and "hdd" or "hdd" .. i, "hdd/" .. o.mountId, def.name, HDD_SIZE)
        if location then
          o.path = location
          break
        end
      end
    end
    function o.detach()
      if not o.path then return end
      mounts.unmount(o.path)
      o.path = nil
    end

    local m = {}
    function m.getMountPath() return o.path end
    function m.mount() o.attach() end
    function m.unmount() o.detach() end
    o.attach() -- the computer attaches the peripheral at boot
    return o, m, { "getMountPath", "mount", "unmount" }
  end

  local hardDrives = {}

  function M.peripheral(def)
    local methods, decl, o
    if def.type == "hard_drive" then
      o, methods, decl = newHardDrive(def)
      hardDrives[def.name] = o
    else
      methods, decl = newCoprocessor()
    end
    local computer = {}
    for _, name in ipairs(decl) do computer[name] = true end
    return {
      methods = methods,
      methodOrder = order(decl),
      computerThread = computer,
      exactReturns = true,
      state = o and function() return { mountId = o.mountId, mountPath = o.path } end or nil,
      detach = o and function()
        o.detach()
        hardDrives[def.name] = nil
      end or nil,
    }
  end

  return M
end
