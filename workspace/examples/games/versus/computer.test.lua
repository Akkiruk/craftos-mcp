-- computer.test.lua
-- Part of the craftos-mcp examples (MIT).
-- One cabinet on its own (versus.world.json, a 6x6 monitor): with no other cabinet in range it offers only the
-- computer. A game of Paddle against it: the computer moves its paddle, a miss scores for it, QUIT ends the match, the
-- result isn't counted, REMATCH starts another and DONE goes back to the ready screen.

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.paddle.rules")
local CELL_H = 2

local seen = {}

kit.run(function()
  kit.open("paddle")
  sleep(2.5) -- long enough to hear any other cabinet's hello
  seen.noChallenge = kit.button("challenge") == nil
  kit.press("cpu")
  seen.count = kit.waitFor(function() return kit.S.view == "count" end, 2)
  seen.playing = kit.waitFor(function() return kit.S.view == "play" end, 5)
  local m = kit.match()
  local s = m.state
  local L = kit.S.L
  seen.mode = m.mode
  seen.countSound = kit.heard("count")

  -- Return the ball until the computer has hit it back, then stay away from it so the computer scores
  local start = s.paddles[2].y
  seen.cpuMoved = false
  kit.waitFor(function()
    local b = s.ball
    if s.wait == 0 and b.dir < 0 then kit.tap(30, L.y0 + math.floor(b.y * CELL_H), 0.05) end
    seen.cpuMoved = seen.cpuMoved or math.abs(s.paddles[2].y - start) > 0.5
    return s.hits >= 2
  end, 30)
  kit.waitFor(function()
    local away = s.ball.y < rules.ROWS / 2 and rules.BOTTOM - 4 or rules.TOP + 4
    if math.abs(s.paddles[1].target - away) > 2 then kit.tap(30, L.y0 + away * CELL_H, 0.05) end
    seen.cpuMoved = seen.cpuMoved or math.abs(s.paddles[2].y - start) > 0.5
    return s.score[2] > 0
  end, 40)
  seen.score = { s.score[1], s.score[2] }

  seen.quit = kit.quit()
  sleep(1.6)
  kit.press("seen")
  seen.over = kit.waitFor(function() return kit.S.view == "over" end, 3)
  seen.notCounted = not fs.exists("/.test-records/paddle.record")
  kit.press("rematch")
  seen.rematch = kit.waitFor(function() return kit.S.view == "count" and kit.match() ~= m end, 3)
  kit.waitFor(function() return kit.S.view == "play" end, 5)
  kit.quit()
  sleep(1.6)
  kit.press("seen")
  kit.waitFor(function() return kit.S.view == "over" end, 3)
  kit.press("done")
  seen.done = kit.waitFor(function() return kit.S.view == "ready" and kit.match() == nil end, 3)
end)

ccunit.test("alone, the cabinet offers only the computer", function()
  ccunit.truthy(seen.noChallenge, "it offered a cabinet that isn't there")
end)

ccunit.test("PLAY THE COMPUTER counts in, then plays", function()
  ccunit.truthy(seen.count, "no 3-2-1")
  ccunit.truthy(seen.countSound, "no count sound")
  ccunit.truthy(seen.playing)
  ccunit.eq(seen.mode, "cpu")
end)

ccunit.test("the computer plays its paddle and scores when North misses", function()
  ccunit.truthy(seen.cpuMoved, "the computer's paddle never moved")
  ccunit.eq(seen.score[2], 1)
end)

ccunit.test("QUIT ends it, and a game against the computer isn't counted", function()
  ccunit.truthy(seen.quit)
  ccunit.truthy(seen.over, "no scores screen")
  ccunit.truthy(seen.notCounted, "the computer game was recorded")
end)

ccunit.test("REMATCH starts another, and DONE goes back to the ready screen", function()
  ccunit.truthy(seen.rematch, "no rematch")
  ccunit.truthy(seen.done, "DONE didn't go back")
end)
