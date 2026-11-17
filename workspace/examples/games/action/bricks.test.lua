-- bricks.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Plays Bricks with real taps (action.world.json, a 6x6 monitor): a tap anywhere sets where the paddle slides to, keeping
-- the ball up knocks bricks out for points, and letting it past the paddle costs a ball.

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.bricks.rules")
local CELL_W = 3

local function dead(n) if n then return 1 end return 0.5 end -- the bot aims for the middle of the paddle

local seen = {}

kit.run(function()
  kit.open("bricks")
  seen.started = kit.start()
  local s = kit.state()
  local L = kit.S.L
  seen.lives = s.lives

  -- A tap high on the wall still aims the paddle across the board: only how far across counts
  -- (the paddle's goal is worked out by the game's next step after the tap, however late a busy machine runs it)
  local steps = kit.S.steps or 0
  kit.tap(L.x0 + 6 * CELL_W, L.y0 + 2, 0.3)
  kit.waitFor(function() return s.target ~= rules.COLS / 2 and (kit.S.steps or 0) > steps end, 60)
  seen.goal = s.goal

  -- Follow the ball as the bot would, by tapping where it will come down
  local aimed
  kit.waitFor(function()
    local action = rules.bot(s, dead)
    if action and (not aimed or math.abs(action.x - aimed) > 0.5) then
      aimed = action.x
      kit.tap(L.x0 + math.floor(action.x * CELL_W), L.y0 + 40, 0.05)
    end
    return s.score >= 60 or s.over
  end, 60)
  seen.score, seen.left = s.score, s.left
  seen.brickSound, seen.paddleSound = kit.heard("brick"), kit.heard("blip")

  -- Now stand at the far side from the ball and let it go past
  local lives = s.lives
  kit.waitFor(function()
    local away = s.ball.x < rules.COLS / 2 and rules.COLS - 1 or 1
    if math.abs(s.goal - away) > 3 then kit.tap(L.x0 + away * CELL_W, L.y0 + 40, 0.05) end
    return s.lives < lives or s.over
  end, 60)
  seen.livesAfter = s.lives
  seen.lostSound = kit.heard("death")
  seen.quit = kit.quit()
  seen.smooth = { steps = kit.S.steps or 0, late = kit.S.lateFrames or 0, slow = kit.S.slowFrames or 0,
    dropped = kit.S.droppedSteps or 0 }
end)

ccunit.test("a run starts with three balls", function()
  ccunit.truthy(seen.started)
  ccunit.eq(seen.lives, 3)
end)

ccunit.test("a tap anywhere sets where the paddle goes", function()
  ccunit.truthy(math.abs(seen.goal - 6.5) <= 1, "goal " .. tostring(seen.goal))
end)

ccunit.test("keeping the ball up knocks bricks out and scores them", function()
  ccunit.truthy(seen.score >= 60, "score " .. seen.score)
  ccunit.truthy(seen.left < rules.BRICK_ROWS * rules.BRICK_COLS, "no brick gone")
  ccunit.truthy(seen.brickSound and seen.paddleSound, "no brick or paddle sound")
end)

ccunit.test("a ball past the paddle costs one of the three", function()
  ccunit.eq(seen.livesAfter, 2)
  ccunit.truthy(seen.lostSound, "no sound for the lost ball")
end)

ccunit.test("QUIT twice ends the run, and it kept up at full speed", function()
  ccunit.truthy(seen.quit)
  -- Full speed is the game's clock keeping to the real one: a late frame catches up (up to three steps at once), so only
  -- steps it had to drop count. Late and slow frames are timed on the clock, which runs on while a busy host keeps the
  -- computer waiting (slow timers do the same), so they are only reported.
  local m = seen.smooth
  ccunit.truthy(m.dropped <= m.steps / 20,
    m.dropped .. " steps dropped in " .. m.steps .. " (" .. m.slow .. " slow, " .. m.late .. " late frames)")
end)
