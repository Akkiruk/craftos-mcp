-- kiosk_admin.lua on a secure computer (kiosk_admin.world.json), then every Embedded Computer method.
local T, eq, ok = ccunit.test, ccunit.eq, ccunit.truthy
local kiosk, drive = peripheral.wrap("left"), peripheral.wrap("right")
local function err(fn, ...)
  local okc, e = pcall(fn, ...)
  if okc then error("expected an error", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local lines = {}
local function run(...)
  local env = setmetatable({ print = function(s) lines[#lines + 1] = s end }, { __index = _ENV })
  return assert(loadfile("examples/embedded-computer/kiosk_admin.lua", nil, env))(...)
end

T("the admin program", function()
  run("open sesame")
  eq(lines, { "kiosk #12 is on", "unlock sent", "backup drive at /backup", "desk hash " .. security.hashStrSHA256("desk"):sub(1, 12) })
  eq(fs.open("backup/notes.txt", "r").readAll(), "backup drive")
end)

T("a secure computer: security, no embedded; its terminal", function()
  eq(embedded, nil)
  eq({ term.getSize() }, { 49, 17 })
  eq(security.hashStrSHA256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  eq(security.hashStrSHA512("a"), "1f40fc92da241694750979ee6cf582f2d5d7d28e18335de05abc54d0560e0f5302860c652bf08d560252aa5e74210546f369fbbbce8c12cfc7957b2652fe9a75")
  eq(security.hashStrMurmur3("hello"), "029bbd41b3a7d8cb191dae486a901e5b")
  eq(security.hashStrAdler32("hello"), "15022c06")
  eq(security.hashStrSipHash24("hello"), "81df675798b34f00")
  eq(err(security.hashStrSHA256), "bad argument #1 (string expected, got nil)")
end)

T("the ROM's security.lua: lock, lockHashed, lockInsecure", function()
  eq(type(security.lock), "function")
  eq(err(security.lockHashed, "x", "md5"), "Invalid hash type!")
end)

T("embeddedcomputer methods", function()
  eq(peripheral.getType("left"), "embeddedcomputer")
  eq(#peripheral.getMethods("left"), 7)
  eq(kiosk.isOn(), true)
  eq(kiosk.getId(), 12)
  eq(select("#", kiosk.reboot()), 0)
  eq(select("#", kiosk.unlockPlainText("nope")), 0)
  eq(select("#", kiosk.unlockHashed("pw", "whirlpool")), 0)
  eq(select("#", kiosk.unlock("pw")), 0)
  -- the program's "open sesame" did not unlock it: the mod reads .LOCKED with a Scanner, joining its words
  eq(kiosk.format(), false)
  kiosk.unlockPlainText("opensesame")
  eq(kiosk.format(), true)
  eq(err(kiosk.unlockHashed, "x"), "bad argument #2 (string expected, got nil)")
end)

T("harddrive: mount, unmount, rom and a taken path", function()
  eq(peripheral.getMethods("right"), { "unmount", "mount" })
  eq(drive.mount("rom"), false)
  eq(drive.mount("backup"), false) -- already there
  eq(drive.mount("second"), true)
  eq(fs.getDrive("second"), "right")
  eq(fs.getCapacity("second"), 25000000)
  eq(drive.unmount("second"), true)
  eq(drive.unmount("second"), false)
  eq(fs.exists("second"), false)
  -- no path: 0.6.0 (Minecraft 1.20.1) wants a string, 1.3.0 (1.21.1) mounts at "drive"
  local okm, e = pcall(drive.mount)
  if okm then eq(fs.exists("drive"), true) else ok(tostring(e):find("bad argument #1 %(string expected, got nil%)"), e) end
end)
