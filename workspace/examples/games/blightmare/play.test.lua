-- play.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Plays BLIGHTMARE through the whole cabinet with real taps on a 6x6 wall (blightmare.world.json, no player detector):
-- the opening on the idle screen, a touch that carries it on heard, SKIP, START, the game asking the hero's name on its
-- own keyboard, the story's first scenes played by touch the way the game's bot would choose, SAVE & QUIT, and CONTINUE
-- from the save with everything as it was.

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.blightmare.rules")

local seen = {}
local botRng = kit.rng.rng(7)

--- Play by touch for up to limit seconds, or until done(state) says so: the bot says what to do, and the tap goes
--- where the wall reads that. A name screen gets the name typed instead.
local function playUntil(done, limit)
  local started = os.clock()
  while os.clock() - started < limit do
    local s = kit.state()
    if not s or done(s) then return true end
    local action = rules.bot(s, botRng)
    if action and not kit.act(action, 0.05) then
      seen.untappable = seen.untappable or textutils.serialise(action, { compact = true }) .. " in " .. s.mode
    end
    sleep(0.05)
  end
  return false
end

kit.run(function()
  seen.idle = kit.waitFor(function() return kit.S.view == "idle" and kit.S.demo.run ~= nil end, 10)
  sleep(1)
  seen.demoPage = kit.S.demo.run and kit.S.demo.run.page
  kit.tap(60, 40)
  seen.intro = kit.waitFor(function() return kit.S.view == "intro" end, 3)
  seen.music = kit.waitFor(function() return #kit.sounds > 0 end, 3)
  kit.press("skip")
  seen.ready = kit.waitFor(function() return kit.S.view == "ready" end, 3)
  seen.noSave = kit.button("start") ~= nil and kit.button("continue") == nil
  seen.rules = kit.press("rules") and kit.waitFor(function() return kit.S.view == "rules" end, 2)
  kit.press("rulesDone")
  kit.press("start")
  seen.play = kit.waitFor(function() return kit.S.view == "play" end, 3)

  -- no detector, so the game asks who this is, on its own keyboard
  seen.asked = kit.waitFor(function() local s = kit.state() return s and s.mode == "name" end, 3)
  for _, key in ipairs({ 1, 4, 1 }) do kit.act({ kind = "pick", i = key }) end
  kit.act({ kind = "pick", i = rules.NAME_DONE })
  seen.hero = kit.state().heroName

  -- the story's first scenes, by touch: on foot in Scythebreak, to the Dream Book, and on to the first fight and past it
  seen.walked = playUntil(function(s) return s.mode == "walk" and not s.run end, 120)
  seen.signed = playUntil(function(s) return s.flags.signed end, 300)
  seen.stepSound = kit.heard("step")
  seen.fought = playUntil(function(s) return s.mode == "battle" end, 300)
  seen.fightSound = playUntil(function() return kit.heard("battle", 0) end, 10)
  seen.won = playUntil(function(s) return s.mode ~= "battle" end, 300)
  seen.hitSound = kit.heard("sword_hit")
  playUntil(function(s) return s.mode == "walk" and not s.run end, 300)
  kit.drained() -- the last taps queued are walked
  local s = kit.state()

  -- SAVE & QUIT, then back in by CONTINUE
  local before = { map = s.map, x = s.x, y = s.y, dir = s.dir, hero = s.heroName, rev = s.rev }
  kit.press("quit")
  seen.asking = kit.button("quit") and kit.button("quit").label
  kit.press("quit")
  seen.left = kit.waitFor(function() return kit.S.view == "idle" end, 3)
  seen.saveFile = fs.exists(fs.combine(kit.DATA, "Player.save"))
  kit.waitFor(function() return kit.S.demo.run ~= nil end, 5)
  kit.tap(60, 40)
  kit.waitFor(function() return kit.S.view == "intro" end, 3)
  kit.press("skip")
  kit.waitFor(function() return kit.S.view == "ready" end, 3)
  seen.saveLine = kit.S.ready.saved and kit.S.ready.saved.line
  kit.press("continue")
  seen.back = kit.waitFor(function() return kit.S.view == "play" end, 3)
  local after = kit.state()
  seen.same = after.map == before.map and after.x == before.x and after.y == before.y and after.dir == before.dir
    and after.heroName == before.hero
end)

ccunit.test("the opening plays on the idle screen, and a touch carries it on with sound", function()
  ccunit.truthy(seen.idle, "no opening on the idle screen")
  ccunit.truthy(seen.intro, "a touch didn't open the opening")
  ccunit.truthy(seen.music, "the opening was silent")
end)

ccunit.test("SKIP goes to the ready screen, with START and HOW TO PLAY", function()
  ccunit.truthy(seen.ready, "never reached the ready screen")
  ccunit.truthy(seen.noSave, "a fresh computer offered a saved game")
  ccunit.truthy(seen.rules, "no HOW TO PLAY")
  ccunit.truthy(seen.play, "START did not start the game")
end)

ccunit.test("with no player detector the game asks the hero's name, typed by touch", function()
  ccunit.truthy(seen.asked, "the name screen never came")
  ccunit.eq(seen.hero, "Ada")
end)

ccunit.test("the first scenes play by touch: Scythebreak, the Dream Book, and the first fight won", function()
  ccunit.eq(seen.untappable, nil)
  ccunit.truthy(seen.walked, "still in the opening scenes")
  ccunit.truthy(seen.signed, "never signed the Dream Book")
  ccunit.truthy(seen.stepSound, "no footsteps")
  ccunit.truthy(seen.fought, "no fight")
  ccunit.truthy(seen.fightSound, "a fight with no sound")
  ccunit.truthy(seen.won, "the fight never ended")
  ccunit.truthy(seen.hitSound, "nobody was hit")
end)

ccunit.test("SAVE & QUIT asks first, saves to a file, and CONTINUE comes back to the same place", function()
  ccunit.eq(seen.asking, "SURE?")
  ccunit.truthy(seen.left, "didn't leave")
  ccunit.truthy(seen.saveFile, "no save file")
  ccunit.truthy(seen.saveLine and seen.saveLine:find("^Your game: Level"), tostring(seen.saveLine))
  ccunit.truthy(seen.back, "CONTINUE didn't go back in")
  ccunit.truthy(seen.same, "somewhere else after CONTINUE")
end)
