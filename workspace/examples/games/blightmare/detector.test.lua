-- detector.test.lua
-- Part of the craftos-mcp examples (MIT).
-- BLIGHTMARE with an Advanced Peripherals player detector beside the wall (detector.world.json: Alex stands at the wall
-- and Steve a little further off). The hero takes the name of whoever is closest, with no name screen, and each player
-- has a save of their own; a player who walks away has their game saved and the wall freed. play.test.lua covers the
-- same game with no detector, where it asks for a name instead.

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()

local seen = {}
local simCount = 0

--- Change the world, as the emulator's sim program does (detector.world.json turns it on).
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end

--- Wait until the detector's last look round found this player closest to the wall. It looks once a second, with
--- calls that each wait for a server tick, so on a busy machine a fixed wait could be over before it had looked.
local function closest(name)
  local detector = require("lib.detector")
  return kit.waitFor(function() return detector.closest() == name end, 20)
end

local function toReady()
  kit.waitFor(function() return kit.S.view == "idle" and kit.S.demo.run ~= nil end, 10)
  kit.tap(60, 40)
  kit.waitFor(function() return kit.S.view == "intro" end, 20)
  kit.press("skip")
  return kit.waitFor(function() return kit.S.view == "ready" end, 20)
end

local function quit()
  kit.press("quit")
  kit.press("quit")
  return kit.waitFor(function() return kit.S.view == "idle" end, 20)
end

kit.run(function()
  seen.alexFound = closest("Alex") -- the detector's first look round
  toReady()
  seen.firstOwner = kit.S.ready.owner
  kit.press("start")
  kit.waitFor(function() return kit.S.view == "play" end, 20)
  sleep(1)
  local s = kit.state()
  seen.alexHero, seen.alexMode = s.heroName, s.mode
  seen.alexQuit = quit()
  seen.alexSave = fs.exists(fs.combine(kit.DATA, "Alex.save"))

  -- Alex goes, Steve comes up to the wall: a game of his own
  sim({ cmd = "setPlayerPos", player = "Alex", x = 60, y = 64, z = 0 })
  sim({ cmd = "setPlayerPos", player = "Steve", x = 1, y = 64, z = 1 })
  seen.steveFound = closest("Steve")
  toReady()
  seen.secondOwner = kit.S.ready.owner
  seen.secondFresh = kit.button("start") ~= nil
  kit.press("start")
  kit.waitFor(function() return kit.S.view == "play" end, 20)
  sleep(1)
  seen.steveHero = kit.state() and kit.state().heroName

  -- Steve walks off mid-game: after a while it's saved and the wall goes back to the opening
  sim({ cmd = "setPlayerPos", player = "Steve", x = 80, y = 64, z = 0 })
  seen.walkedOff = kit.waitFor(function() return kit.S.view == "idle" end, 40)
  seen.steveSave = fs.exists(fs.combine(kit.DATA, "Steve.save"))

  -- Alex comes back: his own save, and PLAYERS lists both
  sim({ cmd = "setPlayerPos", player = "Alex", x = 2, y = 64, z = 0 })
  seen.alexBack = closest("Alex")
  toReady()
  seen.backOwner = kit.S.ready.owner
  seen.backLine = kit.S.ready.saved and kit.S.ready.saved.line
  kit.press("players")
  kit.waitFor(function() return kit.S.view == "players" end, 20)
  seen.players = #(kit.S.players or {})
  kit.press("playersBack")
  kit.press("continue")
  kit.waitFor(function() return kit.S.view == "play" end, 20)
  seen.continued = kit.state() and kit.state().heroName
end)

ccunit.test("the hero takes the name of the player at the wall, with no name screen", function()
  ccunit.truthy(seen.alexFound, "the detector never found Alex at the wall")
  ccunit.eq(seen.firstOwner, "Alex")
  ccunit.eq(seen.alexHero, "Alex")
  ccunit.truthy(seen.alexMode ~= "name", "asked for a name anyway")
  ccunit.truthy(seen.alexQuit, "SAVE & QUIT didn't leave")
  ccunit.truthy(seen.alexSave, "no save for Alex")
end)

ccunit.test("another player at the wall gets a game of their own", function()
  ccunit.truthy(seen.steveFound, "the detector never found Steve at the wall")
  ccunit.eq(seen.secondOwner, "Steve")
  ccunit.truthy(seen.secondFresh, "Steve was offered Alex's game")
  ccunit.eq(seen.steveHero, "Steve")
end)

ccunit.test("a player who walks away has their game saved and the wall freed", function()
  ccunit.truthy(seen.walkedOff, "the game stayed on the wall")
  ccunit.truthy(seen.steveSave, "no save for Steve")
end)

ccunit.test("back at the wall, a player finds their own save, and PLAYERS lists everyone's", function()
  ccunit.truthy(seen.alexBack, "the detector never found Alex back at the wall")
  ccunit.eq(seen.backOwner, "Alex")
  ccunit.truthy(seen.backLine and seen.backLine:find("^Alex: Level"), tostring(seen.backLine))
  ccunit.eq(seen.players, 2)
  ccunit.eq(seen.continued, "Alex")
end)
