-- ccsim addon embedded-computer: Embedded Computer by WindClan (Fabric), 0.6.0 for Minecraft 1.20.1 and 1.3.0 for 1.21.1.
--
-- Written from the mod's source, github.com/WindClan/EmbeddedComputerMod at tags v0.6.0 (d840fad) and v1.3.0
-- (2be48cf); the Lua APIs and peripherals are the same in both but for HardDrivePeripheral's @Nullable path in 1.3.0.
-- Paths under src/main/java/net/rabiesland/embeddedcomputer/:
--   embedded/EmbeddedComputerAPI (`embedded`), secure/SecureComputerAPI and HashUtil (`security`)
--   embedded/EmbeddedComputerPeripheral (type "embeddedcomputer", for both computers), secure/SecureComputerPeripheral
--   embedded/block/EmbeddedComputerBlockEntity, secure/block/SecureComputerBlockEntity (components, terminal size,
--   always on), storage/harddrive/HardDrivePeripheral and HardDriveBlockEntity (type "harddrive"), Config
-- The jar's ROM files (rom/autorun/embedded.lua, rom/apis/secure/security.lua) are in rom/, unchanged.
--
-- This computer is an embedded or secure computer when the world says so (embeddedComputer.kind): it gets the mod's
-- global APIs, and its terminal size (packages/runner/src/world.ts). The peripherals are for any computer.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local order = dofile("/rom/ccsim/addons/javamap.lua").order
  local H = dofile("/rom/ccsim/addons/embedded-computer/hashes.lua")
  core.mounts = core.mounts or dofile("/rom/ccsim/addons/mounts.lua")(core)
  local mounts = core.mounts
  local rawFs = fs
  local M = {}
  local cfg = core.world.embeddedComputer or {}
  local v130 = core.version.mc ~= "1.20.1"
  local HARD_DRIVE_STORAGE = math.floor(tonumber(cfg.hardDriveStorage) or 25000000) -- Config.HARD_DRIVE_STORAGE

  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end
  --- a mainThread method: it runs on the next server tick
  local function onTick(fn, ...)
    local args = table.pack(...)
    local r = core.waitForServerTick(function() return fn(table.unpack(args, 1, args.n)) end)
    if not r[1] then error(r[2], 0) end
    return table.unpack(r, 2, r.n)
  end

  local HASH = { sha256 = H.sha256, murmur3 = H.murmur3, adler32 = H.adler32, siphash24 = H.siphash24 }

  -- ===== this computer's APIs (ComputerComponents SECURE_COMPONENT, EMBEDDED_COMPONENT) =====

  local kind = cfg.kind
  if kind == "embedded" or kind == "secure" then
    local security = {}
    function security.hashStrSHA256(s) return H.sha256(C.str(1, s)) end
    function security.hashStrSHA512(s) return H.sha512(C.str(1, s)) end
    function security.hashStrMurmur3(s) return H.murmur3(C.str(1, s)) end
    function security.hashStrAdler32(s) return H.adler32(C.str(1, s)) end
    function security.hashStrSipHash24(s) return H.siphash24(C.str(1, s)) end
    _G.security = security
  end
  if kind == "embedded" then
    local embedded = {}
    --- format(): every file on the computer's own drive goes, then the computer reboots
    function embedded.format()
      onTick(function()
        for _, name in ipairs(rawFs.list("")) do
          if rawFs.getDrive(name) == "hdd" then pcall(rawFs.delete, name) end
        end
      end)
      os.reboot()
    end
    _G.embedded = embedded
  end

  -- ===== embeddedcomputer: the block of another embedded or secure computer =====

  local computers = {}

  local function newComputer(def)
    local s = saved(def.name)
    local o = { name = def.name, id = math.floor(tonumber(def.id) or 1), kind = def.kind == "secure" and "secure" or "embedded" }
    o.dir = mounts.folder("embedded/" .. o.id, not s and def.files or nil)
    o.reboots = s and s.reboots or 0
    local function path(name) return o.dir .. "/" .. name end
    local function readTokens(name)
      local h = rawFs.open(path(name), "rb")
      local text = h.readAll()
      h.close()
      local out = {}
      for token in text:gmatch("%S+") do out[#out + 1] = token end -- Scanner.next(): whitespace splits tokens
      return table.concat(out)
    end
    local function chain(pass, hashType)
      local f = HASH[hashType:lower()]
      if not f then return nil end
      local hashed = f(pass)
      for _ = 0, #pass do hashed = f(hashed) end
      for _ = 0, #pass do hashed = H.sha512(hashed) end
      return hashed
    end
    local function rebootIt() o.reboots = o.reboots + 1 end

    local m = {}
    -- the block turns its computer on every tick it finds it off (serverTick), so it is always on
    function m.isOn() return true end
    function m.getId() return o.id end
    function m.reboot() rebootIt() end
    function m.format()
      if rawFs.exists(path(".LOCKED")) or rawFs.exists(path(".LOCKED_HASHED")) then return false end
      for _, name in ipairs(rawFs.list(o.dir)) do rawFs.delete(path(name)) end
      rebootIt()
      return true
    end
    function m.unlockPlainText(pass)
      pass = C.str(1, pass)
      if rawFs.exists(path(".LOCKED")) and readTokens(".LOCKED") == pass then rawFs.delete(path(".LOCKED")) end
    end
    function m.unlockHashed(pass, hashType)
      pass = C.str(1, pass)
      hashType = C.str(2, hashType)
      local hashed = chain(pass, hashType)
      if not hashed then return end
      if rawFs.exists(path(".LOCKED_HASHED")) and readTokens(".LOCKED_HASHED") == hashed then
        rawFs.delete(path(".LOCKED_HASHED"))
      end
    end
    function m.unlock(pass)
      pass = C.str(1, pass)
      m.unlockHashed(pass, "sha256")
    end
    return o, m, { "isOn", "getId", "reboot", "format", "unlockPlainText", "unlockHashed", "unlock" },
      { isOn = true, getId = true, reboot = true }
  end

  -- ===== harddrive =====

  local function newDrive(def)
    local s = saved(def.name)
    local o = { name = def.name, uuid = (s and s.uuid) or (type(def.uuid) == "string" and def.uuid) or nil }
    local function folder()
      if not o.uuid then
        local b = {}
        for i = 1, 16 do b[i] = ("%02x"):format(math.random(0, 255)) end
        local h = table.concat(b)
        o.uuid = h:sub(1, 8) .. "-" .. h:sub(9, 12) .. "-4" .. h:sub(14, 16) .. "-a" .. h:sub(18, 20) .. "-" .. h:sub(21)
      end
      mounts.folder("ec-hdd/" .. o.uuid, not (s and s.uuid) and def.files or nil)
      return "ec-hdd/" .. o.uuid
    end
    local m = {}
    local function where(i, str)
      if str == nil and v130 then return "drive" end -- 1.3.0: a nil path is "drive"
      return C.str(i, str)
    end
    function m.mount(str)
      str = where(1, str)
      if str == "rom" then return false end
      o.mount = str
      return mounts.mount(str, folder(), def.name, HARD_DRIVE_STORAGE) ~= nil
    end
    function m.unmount(str)
      str = where(1, str)
      return mounts.unmount(str)
    end
    if s and s.mounts then
      -- mounts made before a reboot are gone with it, as in game: the computer starts with none
      o.mount = nil
    end
    return o, m, { "mount", "unmount" }, {}
  end

  function M.peripheral(def)
    local o, methods, decl, computer
    if def.type == "harddrive" then
      o, methods, decl, computer = newDrive(def)
    else
      o, methods, decl, computer = newComputer(def)
      computers[def.name] = o
    end
    return {
      methods = methods,
      methodOrder = order(decl),
      computerThread = computer,
      exactReturns = true,
      state = function()
        if def.type == "harddrive" then return { uuid = o.uuid, mount = o.mount } end
        local files = rawFs.list(o.dir)
        table.sort(files)
        return { id = o.id, files = files, reboots = o.reboots }
      end,
      detach = function()
        if def.type == "harddrive" and o.mount then mounts.unmount(o.mount) end
      end,
    }
  end

  return M
end
