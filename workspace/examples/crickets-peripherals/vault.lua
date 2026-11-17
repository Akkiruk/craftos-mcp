-- A file vault: `vault store <file>` compresses the file, encrypts it with the vault's key and keeps it on the hard
-- drive with its checksum; `vault restore <name> <to>` brings it back and checks it. The key lives on the drive too.
local drive = peripheral.find("hard_drive")
local cp = peripheral.find("data_coprocessor")
if not drive or not cp then error("needs a hard drive and a data coprocessor", 0) end

local root = drive.getMountPath()
if not root then
  drive.mount()
  root = drive.getMountPath()
end

local function read(path)
  local h = assert(fs.open(path, "rb"))
  local data = h.readAll()
  h.close()
  return data
end
local function write(path, data)
  local h = assert(fs.open(path, "wb"))
  h.write(data)
  h.close()
end
local function hex(s) return (s:gsub(".", function(c) return ("%02x"):format(c:byte()) end)) end

local keyPath = fs.combine(root, "vault.key")
if not fs.exists(keyPath) then write(keyPath, cp.key()) end
local key = read(keyPath)

local command, a, b = ...
if command == "store" then
  local data = read(a)
  local packed = cp.encrypt(cp.deflate(data), key)
  local name = fs.getName(a)
  write(fs.combine(root, name .. ".vault"), packed)
  write(fs.combine(root, name .. ".sum"), hex(cp.sha256(data)))
  print(("stored %s: %d bytes, %d on the drive, crc %08x"):format(name, #data, #packed, cp.crc32(data)))
elseif command == "restore" then
  local data = cp.inflate(cp.decrypt(read(fs.combine(root, a .. ".vault")), key))
  if hex(cp.sha256(data)) ~= read(fs.combine(root, a .. ".sum")) then error("checksum mismatch", 0) end
  write(b, data)
  print(("restored %s to %s (%d bytes)"):format(a, b, #data))
else
  print("usage: vault store <file> | vault restore <name> <to>")
  print(("drive at /%s, %d bytes free, id %s"):format(root, fs.getFreeSpace(root), cp.uuid()))
end
