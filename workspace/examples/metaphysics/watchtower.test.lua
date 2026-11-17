-- Runs watchtower.lua against watchtower.world.json (Minecraft 1.20.1), then calls every function of Metaphysics'
-- crypto and coord APIs: the happy path and the argument errors. The crypto vectors come from the JDK 21 the mod
-- runs on (MessageDigest SHA3-256/512; SHA1PRNG + KeyGenerator AES 256 + AES_256/GCM/NoPadding with a fixed IV).

local printed = {}
local realPrint = print
_G.print = function(...)
  local parts = table.pack(...)
  for i = 1, parts.n do parts[i] = tostring(parts[i]) end
  printed[#printed + 1] = table.concat(parts, "\t")
end
shell.run("examples/metaphysics/watchtower.lua")
_G.print = realPrint
local output = table.concat(printed, "\n")

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^[^:]*:%d+: ", ""))
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.1)
end

local function count(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  return n
end

ccunit.test("the watchtower reports the zombie under the open sky, sealed", function()
  ccunit.truthy(output:find("Watchtower at 0 70 0 (overworld)", 1, true), output)
  ccunit.truthy(output:find("Zombie 6.5 blocks away, 20 hp", 1, true), output)
  ccunit.truthy(not output:find("Skeleton", 1, true), "the skeleton stands under stone")
  local sealed = output:match("sealed (%x+)")
  local report = crypto.AESGCMDecrypt(sealed, "watchtower-shared-key")
  ccunit.truthy(report:find("^Watchtower at 0 70 0"), report)
  ccunit.eq(output:match("sha3 (%x+)"), crypto.SHA256HASH(report))
end)

ccunit.test("both names of each API are the same table", function()
  ccunit.truthy(crypto == cryptography, "crypto")
  ccunit.truthy(coord == coordinate, "coord")
  ccunit.eq(db, nil)
end)

ccunit.test("SHA3 digests match the JDK", function()
  ccunit.eq(crypto.SHA256HASH("abc"), "3A985DA74FE225B2045C172D6BD390BD855F086E3E9D525B46BFE24511431532")
  ccunit.eq(crypto.SHA512HASH("abc"),
    "B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0")
  -- a byte above 127 reaches Java as one char and is hashed as its two UTF-8 bytes
  ccunit.eq(crypto.SHA256HASH("h\233!"), "88C25A31308B687506A8C4F1FE0CB5BAA89CAD1608E0D41187253AEF1CD469F6")
  ccunit.eq(crypto.SHA512HASH(("The quick brown fox jumps over the lazy dog"):rep(5)),
    "B7B5A0B3667204A7C56B92E3EDF7FC210C8BACC6CB4377EEE7F27073A29D44239B5734C3F91AC5141DE9EC81F9157CD2347B969DC6D1BF67692512151E07B02E")
  -- SHA512HASH swallows its argument error and hashes nothing; SHA256HASH does not
  ccunit.eq(crypto.SHA512HASH(),
    "A69F73CCA23A9AC5C8B567DC185A756E97C982164FE25859E0D1DCC1475C80A615B2123AF1F5F94C11E3E9402C3AC558F500199D95B6D3E301758586281DCD26")
  ccunit.eq(err(crypto.SHA256HASH), "bad argument #1 (string expected, got nil)")
end)

ccunit.test("AES-GCM: Java's ciphertext opens here and the other way round", function()
  ccunit.eq(crypto.AESGCMDecrypt("031425364758697A8B9CADBE24379ED5FC61DB085B6B6EEF56645A78E2CA", "secret"), "hi")
  ccunit.eq(crypto.AESGCMDecrypt(
    "031425364758697A8B9CADBE2D2A9A3DCBC66AA4DD2F4857E9B7C86E71379CE483FBFD1F9AB650C573A5B87D79C0F04F7FB492F5933C43C5B8ECB5F93B632FBCC0111494",
    "secret"), "attack at dawn, bring snacks: 0123456789")
  ccunit.eq(crypto.AESGCMDecrypt("031425364758697A8B9CADBE249D477D30B41E37A99DE5F52AD1248C629EE345", "secret"), "h\233!")
  ccunit.eq(crypto.AESGCMDecrypt("031425364758697a8b9cadbe3b40789582dfffcdc5a92fcdf0c39dc6", "secret"), "")
  -- the wrong key fails the tag check, which the mod catches: an empty string
  ccunit.eq(crypto.AESGCMDecrypt("031425364758697A8B9CADBE24379ED5FC61DB085B6B6EEF56645A78E2CA", "wrong"), "")
  local sealed = crypto.AESGCMEncrypt("round trip", "k")
  ccunit.eq(#sealed, (12 + 10 + 16) * 2)
  ccunit.truthy(sealed:match("^[0-9A-F]+$"), sealed)
  ccunit.eq(crypto.AESGCMDecrypt(sealed, "k"), "round trip")
  ccunit.truthy(crypto.AESGCMEncrypt("round trip", "k") ~= sealed, "a fresh IV every time")
end)

ccunit.test("AES-GCM argument errors", function()
  -- the key (argument 2) is read before the text
  ccunit.eq(err(crypto.AESGCMEncrypt), "bad argument #2 (string expected, got nil)")
  ccunit.eq(err(crypto.AESGCMEncrypt, nil, "k"), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(crypto.AESGCMDecrypt), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(crypto.AESGCMDecrypt, "0011"), "Java Exception Thrown: java.lang.NegativeArraySizeException: -10")
  ccunit.truthy(err(crypto.AESGCMDecrypt, ""):find("NullPointerException", 1, true), "empty input")
  ccunit.eq(err(crypto.AESGCMDecrypt, ("00"):rep(28)), "bad argument #2 (string expected, got nil)")
end)

ccunit.test("Salt is 128 random bytes in hex", function()
  local a, b = crypto.Salt(), crypto.Salt()
  ccunit.eq(#a, 256)
  ccunit.truthy(a:match("^[0-9A-F]+$"), a)
  ccunit.truthy(a ~= b, "random")
end)

ccunit.test("coord: where the computer is and the blocks around it", function()
  ccunit.eq(coord.getCoord(), { x = 0, y = 70, z = 0 })
  ccunit.eq(coord.getAbsoluteCoordinates(), { x = 0, y = 70, z = 0 })
  ccunit.eq(coord.getSelfDimensionType(), "overworld")
  ccunit.eq(coord.getBlock(10, 70, 0), "minecraft:stone")
  ccunit.eq(coord.getBlock(0, 63, 0), "minecraft:grass_block")
  ccunit.eq(coord.getBlock(0, 90, 0), "minecraft:air")
  ccunit.eq(coord.isBlockAir(0, 90, 0), true)
  ccunit.eq(coord.isBlockAir(0, 63, 0), false)
  ccunit.eq(coord.getBlockIsSolid(0, 63, 0), true)
  ccunit.eq(coord.getBlockIsSolid(1, 64, 0), false)
  ccunit.eq(coord.getBlockIsReplaceable(1, 64, 0), true)
  ccunit.eq(coord.getBlockIsReplaceable(-3, 64, 0), true)
  ccunit.eq(coord.getBlockIsReplaceable(0, 63, 0), false)
  ccunit.eq(coord.getBlockExplosionResistance(0, 62, 0), 6)
  ccunit.eq(coord.getBlockExplosionResistance(0, 63, 0), 0)
  ccunit.eq(coord.getBlockExplosionResistance(0, 80, 0), 0)
  ccunit.eq(coord.isBlockLoaded(0, 64, 0), true)
  ccunit.eq(coord.isBlockLoaded(0, 400, 0), false)
  ccunit.eq(coord.canSeeSky(0, 64, 0), true)
  ccunit.eq(coord.canSeeSky(10, 64, 0), false)
  -- the position is rounded up first: 9.5 is block 10, under the stone
  ccunit.eq(coord.canSeeSky(9.5, 64, 0), false)
  ccunit.eq(err(coord.getBlock, 1, 2), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(coord.getBlock, 1.5, 2, 3), "bad argument #1 (number has no integer representation)")
  ccunit.eq(err(coord.canSeeSky, "x", 1, 1), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(coord.isBlockAir), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(coord.getBlockIsSolid, 0, 0), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(coord.getBlockIsReplaceable), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(coord.isBlockLoaded, 0), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(coord.getBlockExplosionResistance), "bad argument #1 (number expected, got nil)")
end)

ccunit.test("coord: entities, players, monsters and mobs", function()
  local all = coord.getEntitiesAll(-1)
  ccunit.eq(count(all), 6) -- four mobs, the dropped diamond, Alex
  local sky = coord.getEntities(32)
  local names = {}
  for _, e in pairs(sky) do names[#names + 1] = e.name end
  table.sort(names)
  -- under the sky and in the box: not the skeleton (roofed) nor the creeper (40 blocks out)
  ccunit.eq(names, { "Alex", "Cow", "Diamond", "Zombie" })
  local alex = all["6f1e2d3c-4b5a-4968-8776-655443322110"]
  ccunit.eq({ alex.isPlayer, alex.type, alex.playerInfo.isCreative, alex.isLivingEntity }, { true, "minecraft:player", false, true })
  ccunit.eq({ alex.health, alex.armor, alex.direction }, { 18, 7, "west" })
  ccunit.truthy(math.abs(alex.raw_euler_x + 1) < 1e-6 and math.abs(alex.raw_euler_z) < 1e-6, "looking west")
  local players = coord.getPlayers(16)
  ccunit.eq(count(players), 1)
  local p = players["6f1e2d3c-4b5a-4968-8776-655443322110"]
  ccunit.eq({ p.name, p.pose, p.isPassenger, p.maxHealth }, { "Alex", "STANDING", false, 20 })
  ccunit.eq(count(coord.getPlayersAll(16)), 1)
  ccunit.eq(count(coord.getPlayers(1)), 0)
  local monsters = coord.getMonster(32)
  ccunit.eq(count(monsters), 1)
  local _, zombie = next(monsters)
  ccunit.eq({ zombie.name, zombie.displayName, zombie.armor }, { "monster", "Zombie", 2 })
  local mobs = coord.getMobs(32)
  ccunit.eq(count(mobs), 2)
  ccunit.eq(err(coord.getEntities), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(coord.getEntitiesAll, "all"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(coord.getPlayers), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(coord.getPlayersAll), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(coord.getMonster), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(coord.getMobs), "bad argument #1 (number expected, got nil)")
end)

ccunit.test("coord: ships (Valkyrien Skies)", function()
  ccunit.eq(coord.isOnShipEntity(), false)
  ccunit.eq(coord.getSlug(), "NoSlug")
  coord.setSlug("ignored")
  local ships = coord.getShips(32)
  ccunit.eq(ships["7"].slug, "skyskipper")
  ccunit.eq({ ships["7"].x, ships["7"].y, ships["7"].z }, { 8, 83, 7 })
  ccunit.eq(ships["7"].dimension, "minecraft:dimension:minecraft:overworld")
  ccunit.eq(count(coord.getShipsAll(32)), 1)
  ccunit.eq(coord.getShips(2501), {})
  ccunit.eq(err(coord.getShips), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(coord.getShipsAll), "bad argument #1 (number expected, got nil)")
  sim({ cmd = "metaSetShips", ships = { { id = 7, slug = "skyskipper", min = { x = -2, y = 68, z = -2 }, max = { x = 2, y = 72, z = 2 },
    computerWorldPosition = { x = 100.5, y = 75.25, z = -3 } } }, computerShip = 7 })
  ccunit.eq(coord.isOnShipEntity(), true)
  ccunit.eq(coord.getCoord(), { x = 100.5, y = 75.25, z = -3 })
  coord.setSlug("renamed")
  ccunit.eq(coord.getSlug(), "renamed")
  ccunit.eq(err(coord.setSlug), "bad argument #1 (string expected, got nil)")
  sim({ cmd = "metaSetShips", ships = {}, leaveShip = true })
  ccunit.eq(coord.getCoord(), { x = 0, y = 70, z = 0 })
end)

ccunit.test("coord: map colours and topography", function()
  -- WORLD_SURFACE is the first free block above the ground, and air has no colour
  local colours = coord.getMapColor(-1, 0, 0, 1)
  ccunit.eq(count(colours), 4)
  for k, v in pairs(colours) do
    ccunit.eq({ #k, k[2], v }, { 3, 64, 0 })
  end
  ccunit.eq(count(coord.getMapColor(2, 0, 1, 0)), 0)
  ccunit.eq(err(coord.getMapColor, 0, 0, 1), "bad argument #4 (number expected, got nil)")
  local got
  parallel.waitForAll(function() coord.scanTopography(0, 0, 4, 2) end, function()
    got = { os.pullEvent("ComputerScanTopographyDone") }
  end)
  ccunit.eq(#got[2], 8) -- x 0..3, z 0..1: the max side is left out
  ccunit.eq(got[2][1], { 0, 63, 0 })
  ccunit.eq(err(coord.scanTopography, 0, 0, 1), "bad argument #4 (number expected, got nil)")
end)

ccunit.test("player_death goes to every computer", function()
  local got
  parallel.waitForAll(function()
    sim({ cmd = "metaPlayerDeath", name = "Alex", source = "mob", killer = "Zombie", killerTags = { "boss" } })
  end, function() got = { os.pullEvent("player_death") } end)
  ccunit.eq(got[2], { name = "Alex", source = "DamageSource (mob)", killer = "Zombie", tags = { "boss" } })
end)
