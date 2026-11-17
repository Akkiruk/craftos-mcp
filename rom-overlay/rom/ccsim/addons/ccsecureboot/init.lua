-- ccsim addon ccsecureboot: CCSecureBoot 1.0.2 by JackMacWindows (Minecraft 1.20.1 and 1.21.1, CC:Tweaked 1.112+).
--
-- Written from the mod's source, github.com/MCJack123/CCSecureBoot tag 1.0.2 (commit 707fb68, branch mc-1.20.1):
-- common/src/main/java/cc/madefor/phoenix/ccsecureboot/CCSecureBootAPI.java, the ILuaAPI behind
-- require "secureboot". Its ROM files (pxboot, libcert, ccryptolib, the enroll/sign/unenroll programs, the autorun
-- file that hands an enrolled computer to pxboot) are in rom/, unchanged.
--
-- The Java side is the server's certificate authority: an Ed25519 root key (root.key) and a self-signed root
-- certificate (certs/root.pem), a CRL (certs/revoked.crl), and certs/enrolled/<id> for each enrolled computer. The
-- certs folder is mounted read-only on every computer at /rom/pxboot/certs (startup()). Bouncy Castle does the
-- signing in game; here it is the mod's own Lua libraries (libcert and ccryptolib, loaded from rom/), so the
-- certificates are real Ed25519 certificates that pxboot checks exactly as in game. The server's files live in
-- results/addons/secureboot of the run, so an enrolment survives a reboot.
return function(core, host)
  local M = {}
  local rawFs = fs
  local mounter = core.mounter
  local HERE = "rom/ccsim/addons/ccsecureboot/rom/modules/main/"
  local DIR = "results/addons/secureboot"

  -- ===== the mod's Lua libraries, for the simulation's own use =====

  local loaded = {}
  local env
  local function simRequire(name)
    if loaded[name] ~= nil then return loaded[name] end
    local rel = name:gsub("%.", "/")
    for _, base in ipairs({ HERE, "rom/modules/main/" }) do
      for _, p in ipairs({ base .. rel .. ".lua", base .. rel .. "/init.lua" }) do
        if rawFs.exists(p) then
          local h = rawFs.open(p, "r")
          local text = h.readAll()
          h.close()
          local fn = assert(load(text, "@/" .. p, "t", env))
          local v = fn(name)
          if v == nil then v = true end
          loaded[name] = v
          return v
        end
      end
    end
    error("module '" .. name .. "' not found", 2)
  end
  env = setmetatable({ require = simRequire, fs = rawFs }, { __index = _G })
  local libs
  local function lib()
    if libs then return libs end
    local random = simRequire("ccryptolib.random")
    if not random.isInit() then
      local seed = {}
      for i = 1, 32 do seed[i] = math.random(0, 255) end
      random.init(string.char(table.unpack(seed)) .. tostring(os.epoch("utc")))
    end
    libs = {
      random = random,
      container = simRequire("cert.container"),
      csr = simRequire("cert.csr"),
      ed25519 = simRequire("ccryptolib.ed25519"),
      util = simRequire("cert.util"),
    }
    return libs
  end

  -- ===== the server's files =====

  local function path(p) return DIR .. "/" .. p end
  local function read(p)
    local h = rawFs.open(path(p), "rb")
    if not h then return nil end
    local s = h.readAll()
    h.close()
    return s
  end
  local function write(p, s)
    local d = rawFs.getDir(path(p))
    if not rawFs.exists(d) then rawFs.makeDir(d) end
    local h = rawFs.open(path(p), "wb")
    h.write(s)
    h.close()
  end

  local function nowTime(offsetMs)
    local t = os.date("!*t", math.floor((os.epoch("utc") + (offsetMs or 0)) / 1000))
    return { year = t.year, month = t.month, day = t.day, hour = t.hour, min = t.min, sec = t.sec }
  end
  local ROOT_NAME = { rdnSequence = { { { type = "2.5.4.3", value = { uTF8String = "CCSecureBoot Root" } } } } }

  local rootKey, rootCert, rootCRL
  --- startup(): load or make the root key, certificate and CRL
  local function startup()
    local L = lib()
    local C = L.container
    if not rootKey then
      local pem = read("root.key")
      if pem then
        rootKey = C.loadPKCS8(C.decodePEM(pem))
      else
        rootKey = { version = 1, privateKeyAlgorithm = { type = C.signatureAlgorithmOIDs.ED25519 }, privateKey = L.random.random(32) }
        write("root.key", C.encodePEM(C.savePKCS8(rootKey), "PRIVATE KEY"))
      end
    end
    if not rootCert then
      local pem = read("certs/root.pem")
      if pem then
        rootCert = C.loadX509(C.decodePEM(pem))
      else
        local pub = L.ed25519.publicKey(rootKey.privateKey)
        rootCert = {
          toBeSigned = {
            version = 3, serialNumber = { type = "INTEGER", data = L.random.random(32) },
            signature = { type = C.signatureAlgorithmOIDs.ED25519 }, issuer = ROOT_NAME, subject = ROOT_NAME,
            validity = { notBefore = { utcTime = nowTime() }, notAfter = { generalTime = nowTime(30 * 365 * 86400000) } },
            subjectPublicKeyInfo = { algorithm = { type = C.signatureAlgorithmOIDs.ED25519 },
              subjectPublicKey = { type = "BIT STRING", data = pub, unused = 0 } },
          },
          signatureAlgorithm = { type = C.signatureAlgorithmOIDs.ED25519 },
          signature = { type = "BIT STRING", data = "", unused = 0 },
        }
        rootCert.signature.data = L.ed25519.sign(rootKey.privateKey, pub, C.encodeX509InnerCertificate(rootCert))
        write("certs/root.pem", C.encodePEM(C.saveX509(rootCert), "CERTIFICATE"))
        rootCert = C.loadX509(C.saveX509(rootCert))
      end
    end
    if not rootCRL then
      local pem = read("certs/revoked.crl")
      if pem then
        rootCRL = C.loadX509CRL(C.decodePEM(pem))
      else
        rootCRL = { toBeSigned = { version = 1, signature = { type = C.signatureAlgorithmOIDs.ED25519 }, issuer = ROOT_NAME,
          thisUpdate = { utcTime = nowTime() } },
          signatureAlgorithm = { type = C.signatureAlgorithmOIDs.ED25519 }, signature = { type = "BIT STRING", data = "", unused = 0 } }
        rootCRL.signature.data = L.ed25519.sign(rootKey.privateKey, L.ed25519.publicKey(rootKey.privateKey),
          C.encodeX509CRLInnerCertificate(rootCRL))
        write("certs/revoked.crl", C.encodePEM(C.saveX509CRL(rootCRL), "X509 CRL"))
      end
    end
  end

  local function enrolledPath() return "certs/enrolled/" .. os.getComputerID() end

  -- ===== require "secureboot" =====

  local api = {}
  function api.enroll(pem)
    if type(pem) ~= "string" then error(("bad argument #1 (string expected, got %s)"):format(pem == nil and "nil" or type(pem)), 0) end
    if not rootKey then error("An error occurred while loading the root key; check the server logs for more information.", 0) end
    if rawFs.exists(path(enrolledPath())) then error("This computer is already enrolled in secure boot", 0) end
    local L = lib()
    local C = L.container
    local ok, result = pcall(function()
      local pk10 = C.loadPKCS10((C.decodePEM(pem)))
      local id
      for _, rdn in ipairs(pk10.toBeSigned.subject.rdnSequence or {}) do
        for _, atv in ipairs(rdn) do
          if (atv.type.string or atv.type) == "2.5.4.45" and id == nil then id = atv.value end
        end
      end
      if id == nil then error({ lua = "CSR does not contain computer ID" }) end
      if type(id) == "table" then id = id.data or id.value or id[1] end
      if tostring(id) ~= tostring(os.getComputerID()) then error({ lua = "CSR ID does not match computer ID" }) end
      local cert = {
        toBeSigned = {
          version = 3, serialNumber = { type = "INTEGER", data = L.random.random(32) },
          signature = { type = C.signatureAlgorithmOIDs.ED25519 }, issuer = rootCert.toBeSigned.subject,
          subject = pk10.toBeSigned.subject, subjectPublicKeyInfo = pk10.toBeSigned.subjectPKInfo,
          validity = { notBefore = { utcTime = nowTime() }, notAfter = { generalTime = nowTime(30 * 365 * 86400000) } },
        },
        signatureAlgorithm = { type = C.signatureAlgorithmOIDs.ED25519 },
        signature = { type = "BIT STRING", data = "", unused = 0 },
      }
      cert.signature.data = L.ed25519.sign(rootKey.privateKey, L.ed25519.publicKey(rootKey.privateKey),
        C.encodeX509InnerCertificate(cert))
      return C.encodePEM(C.saveX509(cert), "CERTIFICATE")
    end)
    if not ok then
      if type(result) == "table" and result.lua then error(result.lua, 0) end
      error("Could not sign certificate: " .. tostring(result):gsub("^[^:]*:%d+: ", ""), 0)
    end
    write(enrolledPath(), "")
    core.touch()
    return result
  end

  function api.unenroll(certPem, sig)
    if type(certPem) ~= "string" then error(("bad argument #1 (string expected, got %s)"):format(certPem == nil and "nil" or type(certPem)), 0) end
    if type(sig) ~= "string" then error(("bad argument #2 (string expected, got %s)"):format(sig == nil and "nil" or type(sig)), 0) end
    if not rootCert then
      return false, "An error occurred while loading the root certificate; check the server logs for more information."
    end
    -- the computer running this, not the certificate's: unenroll only ever removes this computer's file
    if not rawFs.exists(path(enrolledPath())) then return true end
    local L = lib()
    local C = L.container
    local ok, a, b = pcall(function()
      local cert = C.loadX509((C.decodePEM(certPem)))
      local serial = cert.toBeSigned.serialNumber
      for _, e in ipairs(rootCRL.toBeSigned.revokedCertificates or {}) do
        local s = e.serialNumber
        if s == serial or (type(s) == "table" and type(serial) == "table" and s.data == serial.data) then
          return false, "Certificate has been revoked"
        end
      end
      if not L.ed25519.verify(rootCert.toBeSigned.subjectPublicKeyInfo.subjectPublicKey.data, C.encodeX509InnerCertificate(cert),
          cert.signature.data) then
        return false, "Signature does not match."
      end
      local id
      for _, rdn in ipairs(cert.toBeSigned.subject.rdnSequence or {}) do
        for _, atv in ipairs(rdn) do
          if (atv.type.string or atv.type) == "2.5.4.45" and id == nil then id = atv.value end
        end
      end
      if id == nil then return false, "Certificate does not contain computer ID" end
      if type(id) == "table" then id = id.data or id.value or id[1] end
      if not L.ed25519.verify(cert.toBeSigned.subjectPublicKeyInfo.subjectPublicKey.data, tostring(id), sig) then
        return false, "Could not verify signature"
      end
      -- the serial goes on the CRL (reason superseded), signed again
      local list = rootCRL.toBeSigned.revokedCertificates or {}
      list[#list + 1] = { serialNumber = serial, revocationDate = { utcTime = nowTime() } }
      rootCRL.toBeSigned.revokedCertificates = list
      rootCRL.signature.data = L.ed25519.sign(rootKey.privateKey, L.ed25519.publicKey(rootKey.privateKey),
        C.encodeX509CRLInnerCertificate(rootCRL))
      write("certs/revoked.crl", C.encodePEM(C.saveX509CRL(rootCRL), "X509 CRL"))
      rawFs.delete(path(enrolledPath()))
      core.touch()
      return true
    end)
    if not ok then return false, tostring(a):gsub("^[^:]*:%d+: ", "") end
    if b ~= nil then return a, b end
    return a
  end

  -- ===== at every boot =====

  startup()
  -- the save mount at /rom/pxboot/certs (read-only, as IComputerAccess.mount gives it)
  if mounter and mounter.list then
    local r = mounter.list()["results"]
    local root = type(r) == "table" and r[1]
    if root then
      if not rawFs.exists(path("certs/enrolled")) then rawFs.makeDir(path("certs/enrolled")) end
      pcall(mounter.unmount, "rom/pxboot/certs")
      mounter.mount("rom/pxboot/certs", root .. "/addons/secureboot/certs", true)
    end
  end
  -- an ILuaAPI's module: registry._LOADED, which every require copies when it is made
  local reg = debug.getregistry and debug.getregistry()
  if reg then
    reg._LOADED = reg._LOADED or {}
    reg._LOADED.secureboot = api
  end
  if package and package.loaded then package.loaded.secureboot = api end
  M.api = api

  function M.state()
    return { enrolled = rawFs.exists(path(enrolledPath())), revoked = #(rootCRL and rootCRL.toBeSigned.revokedCertificates or {}) }
  end
  return M
end
