-- vault.lua against a hard drive and a data coprocessor (vault.world.json), then every method of both.
local T, eq, ok, raises = ccunit.test, ccunit.eq, ccunit.truthy, ccunit.raises
local cp, drive = peripheral.wrap("right"), peripheral.wrap("left")
local function hex(s) return (s:gsub(".", function(c) return ("%02x"):format(c:byte()) end)) end
local function unhex(h) return (h:gsub("..", function(x) return string.char(tonumber(x, 16)) end)) end
local function run(...)
  local fn = assert(loadfile("examples/crickets-peripherals/vault.lua", nil, _ENV))
  return fn(...)
end

T("store and restore a file through the vault", function()
  local h = fs.open("notes.txt", "w")
  h.write(("meeting notes, again and again. "):rep(40))
  h.close()
  run("store", "notes.txt")
  ok(fs.exists("hdd/notes.txt.vault"), "packed file")
  ok(fs.getSize("hdd/notes.txt.vault") < 300, "compressed")
  run("restore", "notes.txt", "back.txt")
  eq(fs.open("back.txt", "r").readAll(), ("meeting notes, again and again. "):rep(40))
  eq(fs.open("hdd/readme.txt", "r").readAll(), "vault drive")
end)

T("method lists, in CC's HashMap order", function()
  eq(peripheral.getMethods("right"), { "deflate", "inflate", "sha256", "encrypt", "crc32", "decrypt", "uuid", "key" })
  eq(peripheral.getMethods("left"), { "getMountPath", "unmount", "mount" })
end)

T("deflate gives the JDK's bytes", function()
  eq(hex(cp.deflate("")), "789c030000000001")
  eq(hex(cp.deflate("hello hello hello hello")), "789ccb48cdc9c957c8402701680308b1")
  -- the same pseudo-random text Java deflated (see the integration test)
  local x = 1
  local function nextr()
    local hi, lo = math.floor(x / 65536), x % 65536
    x = ((hi * 1103515245 % 2147483648) * 65536 + lo * 1103515245 + 12345) % 2147483648
    return math.floor(x / 256)
  end
  local b = {}
  for i = 0, 2999 do
    local r = nextr()
    if i > 20 and r % 10 < 7 then b[i + 1] = b[i - nextr() % math.min(i, 300)] else b[i + 1] = 97 + nextr() % 16 end
  end
  local input = string.char(table.unpack(b))
  local z = cp.deflate(input)
  eq(#z, 1685)
  eq(hex(cp.sha256(z)), "1e87216c698f7cf17c127c8439991eab6a7323481b27b48c84c083299076de7e")
  eq(cp.inflate(z), input)
end)

T("inflate: zlib's errors, and what runs out of input", function()
  eq(select(2, pcall(cp.inflate, unhex("789d"))), "incorrect header check")
  eq(select(2, pcall(cp.inflate, unhex("789c07"))), "invalid block type")
  eq(select(2, pcall(cp.inflate, unhex("789c0001000000"))), "invalid stored block lengths")
  eq(cp.inflate(unhex("789c4b")), "")
  eq(cp.inflate(""), "")
end)

T("hashes", function()
  eq(hex(cp.sha256("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  eq(cp.crc32("hello"), 907060870)
  eq(cp.crc32(""), 0)
end)

T("AES-GCM: key, encrypt, decrypt and their errors", function()
  local key = cp.key()
  eq(#key, 32)
  local e = cp.encrypt("secret", key)
  eq(#e, 12 + 6 + 16)
  eq(cp.decrypt(e, key), "secret")
  local k = "" for i = 0, 31 do k = k .. string.char(i) end
  local iv = "" for i = 0, 11 do iv = iv .. string.char(100 + i) end
  eq(cp.decrypt(iv .. unhex("7b002dd27d31f16aac68dade247fc6fb07d165"), k:sub(1, 16)), "abc")
  eq(select(2, pcall(cp.encrypt, "abc", "short")), "Invalid AES key length: 5 bytes")
  eq(select(2, pcall(cp.encrypt, "abc", "")), "Java Exception Thrown: java.lang.IllegalArgumentException: Empty key")
  eq(select(2, pcall(cp.decrypt, "tiny", key)), "Java Exception Thrown: java.nio.BufferUnderflowException")
  eq(select(2, pcall(cp.decrypt, ("x"):rep(20), key)), "Input data too short to contain an expected tag length of 16bytes")
  eq(select(2, pcall(cp.decrypt, ("x"):rep(40), key)), "Tag mismatch")
end)

T("uuid is a random version 4 UUID", function()
  local a, b = cp.uuid(), cp.uuid()
  ok(a:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"), a)
  ok(a ~= b, "random")
end)

T("argument checks", function()
  for _, name in ipairs({ "deflate", "inflate", "sha256", "crc32" }) do
    eq(select(2, pcall(cp[name])), "bad argument #1 (string expected, got nil)")
  end
  eq(select(2, pcall(cp.encrypt, "x")), "bad argument #2 (string expected, got nil)")
  eq(select(2, pcall(cp.decrypt, 1, "k")), "bad argument #1 (string expected, got number)")
end)

T("hard drive: mount path, unmount, mount again", function()
  eq(drive.getMountPath(), "hdd")
  eq(fs.getDrive("hdd"), "left")
  eq(fs.getCapacity("hdd"), 2097152)
  eq(select("#", drive.unmount()), 0)
  eq(fs.exists("hdd"), false)
  eq(select("#", drive.getMountPath()), 1)
  eq(drive.getMountPath(), nil)
  fs.makeDir("hdd") -- the name is taken now: the drive mounts at hdd1
  eq(select("#", drive.mount()), 0)
  eq(drive.getMountPath(), "hdd1")
  drive.mount() -- already mounted: nothing
  eq(drive.getMountPath(), "hdd1")
  ok(fs.exists("hdd1/notes.txt.vault"), "same files")
end)
