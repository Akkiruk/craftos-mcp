-- Runs ore_scout.lua against ore_scout.world.json (a chat box, geo explorer, player finder, event relayer and
-- holographic display next to the computer; two iron ores and a diamond ore under it), asks it for ores through
-- chat, then calls every method of those blocks, happy path and argument errors. The pocket and turtle upgrades
-- are covered by packages/runner/src/finer-peripherals.integration.test.ts.

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end

local width, height = term.getSize()
local screen = window.create(term.current(), 1, 1, width, height)
local seen = {}
local function screenText()
  local lines = {}
  for y = 1, height do lines[y] = screen.getLine(y) end
  return table.concat(lines, "\n")
end
parallel.waitForAny(function()
  local old = term.redirect(screen)
  local ok, e = pcall(shell.run, "examples/finer-peripherals/ore_scout.lua")
  term.redirect(old)
  if not ok then seen.error = e end
end, function()
  sleep(0.5)
  sim({ cmd = "finerChat", player = "Alex", message = "!ores" })
  sleep(0.5)
  seen.screen = screenText()
end)

ccunit.test("the scout answers !ores with what is under it", function()
  ccunit.eq(seen.error, nil)
  ccunit.truthy(seen.screen:find("Ore scout listening", 1, true), seen.screen)
  ccunit.truthy(seen.screen:find("Alex: 1 diamond_ore, 2 iron_ore", 1, true), seen.screen)
end)

ccunit.test("chatBox", function()
  local chat = peripheral.find("chatBox")
  ccunit.eq(peripheral.getType(chat), "chatBox")
  ccunit.eq(chat.sendMessage("hello", "Bot", "<>"), true)
  ccunit.eq(chat.sendMessageToPlayer("psst", "alex", "Bot", "[]"), true) -- names ignore case
  ccunit.eq(chat.tellraw("plain"), true)
  ccunit.eq(chat.tellrawToPlayer("plain to one", "Steve"), true)
  ccunit.eq(err(chat.tellrawToPlayer, "x", "Nobody"), "Java Exception Thrown: java.lang.NullPointerException")
  ccunit.eq(err(chat.sendMessageToPlayer, "x", "Nobody", "Bot", "[]"), "Java Exception Thrown: java.lang.NullPointerException")
  ccunit.eq(err(chat.sendMessage, "x", "Bot", "["), "Java Exception Thrown: java.lang.StringIndexOutOfBoundsException: String index out of range: 1")
  ccunit.eq(err(chat.sendMessage, "x", 5, "[]"), "bad argument #2 (string expected, got number)")
  ccunit.eq(err(chat.tellraw), "bad argument #1 (string expected, got nil)")
  parallel.waitForAll(function()
    local _, who, message, uuid = os.pullEvent("chat")
    ccunit.eq({ who, message, type(uuid) }, { "Steve", "hi box", "string" })
  end, function() sim({ cmd = "finerChat", player = "Steve", message = "hi box" }) end)
end)

ccunit.test("geoExplorer", function()
  sleep(2.1) -- the scout's scan started the cooldown
  local geo = peripheral.find("geoExplorer")
  local blocks = geo.scan(4)
  ccunit.eq(#blocks, 325) -- 9 x 9 x 4 of ground and the torch
  local byPos = {}
  for _, b in ipairs(blocks) do byPos[b.x .. "," .. b.y .. "," .. b.z] = b end
  ccunit.eq(byPos["0,0,1"].name, "minecraft:torch") -- a wall torch reads by its item's translation key
  ccunit.eq(byPos["0,0,1"].direction, "south")
  ccunit.eq(byPos["1,-2,0"].name, "minecraft:iron_ore")
  ccunit.truthy(geo.getOperationCooldown() > 1000)
  ccunit.eq({ geo.scan(1) }, { nil, "On cooldown!" })
  sleep(2.1)
  ccunit.eq(err(geo.scan), "bad argument #1 (number expected, got nil)")
  ccunit.truthy(geo.getOperationCooldown() > 0) -- the cooldown starts before the argument is read
end)

ccunit.test("playerFinder", function()
  local finder = peripheral.find("playerFinder")
  ccunit.eq({ finder.getOnlinePlayers() }, { true, { "Alex", "Steve" } })
  ccunit.eq({ finder.getPlayerPos("Alex") }, { true, { x = 2.5, y = 64, z = -3.5, dimension = "minecraft:overworld",
    respawnPos = { x = 0, y = 65, z = 0, dimension = "minecraft:overworld" } } })
  local ok, pos = finder.getPlayerPos("STEVE")
  ccunit.eq(ok, true)
  ccunit.eq({ pos.x, pos.dimension, pos.respawnPos }, { -10.25, "minecraft:the_nether", nil })
  ccunit.eq({ finder.getPlayerPos("Nobody") }, { false, "Player not online!" })
  ccunit.eq(err(finder.getPlayerPos), "bad argument #1 (string expected, got nil)")
end)

ccunit.test("eventRelayer", function()
  local relay = peripheral.find("eventRelayer")
  parallel.waitForAll(function()
    local _, from, message = os.pullEvent("secure_message")
    ccunit.eq({ from, message }, { os.getComputerID(), "to myself" })
  end, function() ccunit.eq(relay.relayEvent(os.getComputerID(), "to myself"), true) end)
  ccunit.eq(relay.relayEvent(999, "nobody"), true)
  ccunit.eq(err(relay.relayEvent, "1", "x"), "bad argument #1 (number expected, got string)")
end)

ccunit.test("holographic_item_display", function()
  local holo = peripheral.find("holographic_item_display")
  ccunit.eq(holo.setItem("minecraft:diamond"), true)
  ccunit.truthy(holo.getOperationCooldown() > 1000)
  ccunit.eq({ holo.setItem("minecraft:stone") }, { nil, "On cooldown!" })
  sleep(2.1)
  ccunit.eq({ holo.setItem("minecraft:not_an_item") }, { false, "Not a real item id!" })
  sleep(2.1)
  ccunit.eq(err(holo.setItem, "Bad Id"),
    "Java Exception Thrown: net.minecraft.ResourceLocationException: Non [a-z0-9/._-] character in path of location: minecraft:Bad Id")
  ccunit.eq(err(holo.setItem, 3), "bad argument #1 (string expected, got number)")
end)
