-- boot_check.lua, then the secureboot API end to end without a disk: the client side is the mod's libcert.
local T, eq, ok = ccunit.test, ccunit.eq, ccunit.truthy
local lines = {}
local function run()
  local env = setmetatable({ print = function(t) lines[#lines + 1] = t end }, { __index = _ENV })
  return assert(loadfile("examples/ccsecureboot/boot_check.lua", nil, env))()
end
local function err(fn, ...)
  local okc, e = pcall(fn, ...)
  if okc then error("expected an error", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end

T("an unenrolled computer with an unsigned startup", function()
  local h = fs.open("startup.lua", "w") h.write("print('hi')") h.close()
  eq(run(), false)
  eq(lines[1], ("computer %d: secure boot off"):format(os.getComputerID()))
  ok(lines[2]:find("^/startup.lua: not trusted"), lines[2])
  fs.delete("startup.lua")
end)

T("enroll and unenroll through require 'secureboot'", function()
  local secureboot = require("secureboot")
  local libcert = require("cert")
  local ed25519 = require("ccryptolib.ed25519")
  require("ccryptolib.random").init("a seed for the test, not for real keys")
  local key, pk8 = libcert.generatePrivateKeyForSigning()
  -- a CSR without the computer's ID, and one with another computer's
  local noId = libcert.generateCSR(pk8, { [libcert.container.nameOIDs.commonName] = "Alex" })
  eq(err(secureboot.enroll, noId), "CSR does not contain computer ID")
  local other = libcert.generateCSR(pk8, { [libcert.container.nameOIDs.uniqueIdentifier] = tostring(os.getComputerID() + 1) })
  eq(err(secureboot.enroll, other), "CSR ID does not match computer ID")
  local pk10 = libcert.generateCSR(pk8, { [libcert.container.nameOIDs.commonName] = "Alex",
    [libcert.container.nameOIDs.uniqueIdentifier] = tostring(os.getComputerID()) })
  local cert = secureboot.enroll(pk10)
  ok(cert:find("^%-%-%-%-%-BEGIN CERTIFICATE"), cert)
  eq(fs.exists("/rom/pxboot/certs/enrolled/" .. os.getComputerID()), true)
  eq(err(secureboot.enroll, pk10), "This computer is already enrolled in secure boot")
  -- the certificate chains to the server's root, as pxboot checks it
  local x509 = libcert.container.loadX509(libcert.container.decodePEM(cert))
  eq(libcert.chain.validate(x509, {}, "/rom/pxboot/certs"), true)
  -- a signature from the wrong key is refused; the right one unenrolls
  eq({ secureboot.unenroll(cert, ed25519.sign(("\1"):rep(32), ed25519.publicKey(("\1"):rep(32)), "x")) },
    { false, "Could not verify signature" })
  local pub = x509.toBeSigned.subjectPublicKeyInfo.subjectPublicKey.data
  eq({ secureboot.unenroll(cert, ed25519.sign(key, pub, tostring(os.getComputerID()))) }, { true })
  eq(fs.exists("/rom/pxboot/certs/enrolled/" .. os.getComputerID()), false)
  -- the revoked certificate no longer validates
  eq({ libcert.chain.validate(x509, {}, "/rom/pxboot/certs") }, { false, "Certificate was revoked" })
  eq(err(secureboot.enroll), "bad argument #1 (string expected, got nil)")
end)
