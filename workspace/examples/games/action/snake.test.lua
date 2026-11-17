-- snake.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Plays Snake through the whole cabinet with real taps (action.world.json, a 6x6 monitor): the menu, HOW TO PLAY, a run
-- steered by tapping the sides of the wall until the snake has eaten and grown, a U-turn that is refused, a crash, the
-- final board, a name for the high score table, and a second run ended with QUIT.

-- the kit runs in this test's own environment, so it shares its shell and require
local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.snake.rules")

-- Where to tap for each way: the wall is split corner to corner (lib/base.lua splitAction).
local SIDE = { up = { 60, 10 }, down = { 60, 72 }, left = { 4, 40 }, right = { 116, 40 } }

local function steer(dir)
  kit.tap(SIDE[dir][1], SIDE[dir][2], 0.05)
end

local seen = {}

kit.run(function()
  seen.ready = kit.open("snake")
  seen.ruleScreen = kit.press("rules") and kit.waitFor(function() return kit.S.view == "rules" end, 3)
  kit.press("rulesDone")
  seen.started = kit.start()
  local s = kit.state()
  seen.startLength = #s.snake

  -- A U-turn is refused: the snake starts heading right, so a tap on the left does nothing
  steer("left")
  seen.afterUturn = s.want

  -- Play the way the idle screen's bot does, but through the wall: tap the side it would turn to
  kit.waitFor(function()
    local action = rules.bot(s)
    if action and action.dir ~= s.want then steer(action.dir) end
    return s.eaten >= 3 or s.over
  end, 60)
  seen.eaten, seen.score, seen.length = s.eaten, s.score, #s.snake
  seen.ateSound = kit.heard("pickup")

  -- Now drive into the top wall
  if s.dir == "down" then steer("left") end
  kit.waitFor(function()
    if s.want ~= "up" and s.dir ~= "down" then steer("up") end
    return kit.S.view == "final"
  end, 30)
  seen.final = kit.S.view
  -- the run's score as it ended: the snake can eat again on the way to the wall (a busy host lets it take more steps)
  seen.finalScore = s.score
  seen.crashSound = kit.heard("death")
  kit.press("seen") -- too soon: a tap meant for the snake must not skip the final board
  seen.heldFinal = kit.S.view
  sleep(1.6)
  kit.press("seen")
  seen.nameScreen = kit.waitFor(function() return kit.S.view == "name" end, 3)
  for _, letter in ipairs({ "S", "N", "K", "DEL", "X" }) do kit.press("key", letter) end
  kit.press("key", "OK")
  seen.scoreScreen = kit.waitFor(function() return kit.S.view == "over" end, 3)
  seen.table = kit.S.scores.rows[1]
  seen.place = kit.S.run.place
  seen.saved = fs.exists("/.test-scores/snake.scores")

  -- AGAIN, then QUIT twice ends the run
  kit.press("start")
  seen.again = kit.waitFor(function() return kit.S.view == "play" end, 3)
  seen.quit = kit.quit()
  seen.smooth = { steps = kit.S.steps or 0, late = kit.S.lateFrames or 0, dropped = kit.S.droppedSteps or 0 }
end)

ccunit.test("the menu opens Snake's ready screen and HOW TO PLAY", function()
  ccunit.truthy(seen.ready, "never reached the ready screen")
  ccunit.truthy(seen.ruleScreen, "no HOW TO PLAY")
  ccunit.truthy(seen.started, "START did not start a run")
end)

ccunit.test("the snake can't turn straight back on itself", function()
  ccunit.eq(seen.afterUturn, "right")
end)

ccunit.test("tapping the sides steers it to food: it eats and grows", function()
  ccunit.truthy(seen.eaten >= 3, "ate " .. tostring(seen.eaten))
  ccunit.eq(seen.score, seen.eaten * 10)
  ccunit.truthy(seen.length > seen.startLength, "length " .. seen.length)
  ccunit.truthy(seen.ateSound, "no eating sound")
end)

ccunit.test("hitting the wall ends the run on the final board, which waits for a real tap", function()
  ccunit.eq(seen.final, "final")
  ccunit.truthy(seen.crashSound, "no crash sound")
  ccunit.eq(seen.heldFinal, "final")
  ccunit.truthy(seen.nameScreen, "no name entry for a new high score")
end)

ccunit.test("the high score goes on the table under the name typed, and is saved", function()
  ccunit.truthy(seen.scoreScreen, "never reached the scores")
  ccunit.eq(seen.place, 1)
  ccunit.eq(seen.table.name, "SNX")
  ccunit.eq(seen.table.score, seen.finalScore)
  ccunit.truthy(seen.saved, "no scores file")
end)

ccunit.test("AGAIN starts a new run and QUIT twice ends it", function()
  ccunit.truthy(seen.again, "AGAIN did not start a run")
  ccunit.truthy(seen.quit, "QUIT did not end the run")
end)

ccunit.test("it keeps up at full speed: hardly a step is dropped", function()
  local m = seen.smooth
  ccunit.truthy(m.steps > 100, "only " .. m.steps .. " steps")
  -- Full speed is the game's clock keeping to the real one: a late frame catches up (up to three steps at once), so only
  -- steps it had to drop count. Late and slow frames are timed on the clock, which runs on while a busy host keeps the
  -- computer waiting (slow timers do the same), so they are only reported.
  ccunit.truthy(m.dropped <= m.steps / 20, m.dropped .. " steps dropped in " .. m.steps .. " (" .. m.late .. " late frames)")
end)
