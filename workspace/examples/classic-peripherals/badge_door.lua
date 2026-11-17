-- A door that opens for signed RFID badges (Classic Peripherals, Minecraft 1.21.1).
--
-- Every badge carries "name:signature", the signature being the accelerator's Ed25519 signature of the name in
-- base64. The door scans every second, opens (redstone on the back) for a badge signed by the guard's key that is
-- within 3 blocks, and tells the guard post over the radio tower who came in.
--
-- Usage: badge_door [public key file]   (default /door.pub, written by `badge_door issue <name>` the first time)

local crypto = peripheral.find("cryptographic_accelerator")
local rfid = peripheral.find("rfid_scanner")
local radio = peripheral.find("radio_tower")
local REACH = 3
local FREQUENCY = 1471
local KEY_FILE = "/door.key"

local function readFile(path)
  local h = fs.open(path, "rb")
  if not h then return nil end
  local data = h.readAll()
  h.close()
  return data
end

local function writeFile(path, data)
  local h = fs.open(path, "wb")
  h.write(data)
  h.close()
end

--- The guard's private key, made once and kept on this computer.
local function privateKey()
  local key = readFile(KEY_FILE)
  if not key then
    key = crypto.generatePrivateKey()
    writeFile(KEY_FILE, key)
  end
  return key
end

local args = { ... }
if args[1] == "issue" then
  -- the text to write on a new badge
  local name = assert(args[2], "usage: badge_door issue <name>")
  print(name .. ":" .. crypto.encodeBase64(crypto.sign(name, privateKey())))
  return
end

local publicKey = crypto.derivePublicKey(privateKey())

--- The name on a badge, when its signature checks out.
local function holder(data)
  local name, signature = data:match("^([^:]+):(.+)$")
  if not name then return nil end
  signature = crypto.decodeBase64(signature)
  if not signature or #signature ~= 64 then return nil end
  if crypto.verify(name, signature, publicKey) then return name end
  return nil
end

if radio.isValid() then radio.setFrequency(FREQUENCY) end
term.clear()
term.setCursorPos(1, 1)
print("Badge door ready")

local open = false
while true do
  local inside
  for _, badge in ipairs(rfid.scan()) do
    if badge.distance <= REACH then
      inside = inside or holder(badge.data)
    end
  end
  if inside and not open then
    print("Welcome, " .. inside)
    if radio.isValid() then radio.broadcast("door opened for " .. inside) end
  end
  open = inside ~= nil
  redstone.setOutput("back", open)
  sleep(1)
end
