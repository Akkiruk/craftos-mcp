-- paddle.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Paddle across two computers (games-versus.integration.test.ts starts both): this one is North, player 1, and the
-- other runs peer.lua as South. North asks for a game, South joins, and they rally: a tap sets North's paddle and South
-- sees it move, South's paddle returns the ball, North misses and South scores on both screens, and North's QUIT twice
-- gives South the match, which both cabinets record.

if not peripheral.find("modem") then
  ccunit.test("needs two computers with modems (run by games-versus.integration.test.ts)", function() end)
  return
end

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.paddle.rules")
local CELL_H = 2

local seen = {}

kit.run(function()
  kit.open("paddle")
  seen.found = kit.waitFor(function() return kit.button("challenge") ~= nil end, 20)
  seen.playing = kit.challenge()
  local m = kit.match()
  local s = m.state
  local L = kit.S.L
  seen.mode = m.mode
  seen.names = { m.names[1], m.names[2] }
  seen.peerPlaying = kit.waitPeer(function(r) return r.view == "play" and r.mode == "guest" end, 10)

  -- A tap near the top sets North's paddle there, and South's wall shows it
  -- (the paddles go back to the middle as the serve counts in, which a busy host can still be doing: tap again then,
  -- as a player would)
  for _ = 1, 5 do
    kit.tap(30, L.y0 + 6 * CELL_H)
    if math.abs(s.paddles[1].target - 6.5) < 1 then break end
  end
  seen.target = s.paddles[1].target
  seen.peerTarget = kit.waitPeer(function(r) return r.paddles and math.abs(r.paddles[1] - s.paddles[1].target) < 0.01 end, 3)

  -- Return the ball until both paddles have hit it, then stay away from it
  seen.rally = 0
  kit.waitFor(function()
    local b = s.ball
    if s.wait == 0 and b.dir < 0 then kit.tap(30, L.y0 + math.floor(b.y * CELL_H), 0.05) end
    seen.rally = math.max(seen.rally, s.hits)
    return s.hits >= 2 or s.score[2] > 0
  end, 30)
  kit.waitFor(function()
    local away = s.ball.y < rules.ROWS / 2 and rules.BOTTOM - 4 or rules.TOP + 4
    if math.abs(s.paddles[1].target - away) > 2 then kit.tap(30, L.y0 + away * CELL_H, 0.05) end
    return s.score[2] > 0
  end, 30)
  seen.score = { s.score[1], s.score[2] }
  seen.peerScore = kit.waitPeer(function(r) return r.score and r.score[2] == s.score[2] and r.score[1] == s.score[1] end, 3)
  seen.pointSound = kit.heard("point")

  -- QUIT twice: North gives up, and South wins on both walls
  seen.quit = kit.quit()
  seen.winner, seen.forfeit = s.winner, m.forfeit
  seen.peerEnd = kit.waitPeer(function(r) return (r.view == "final" or r.view == "over") and r.winner == 2 and r.forfeit == 1 end, 5)
  seen.smooth = { steps = kit.S.steps or 0, late = kit.S.lateFrames or 0, dropped = kit.S.droppedSteps or 0 }
  seen.resyncs = kit.peer().resyncs

  -- North's record against South
  sleep(2)
  kit.press("seen")
  kit.waitFor(function() return kit.S.view == "over" end, 3)
  local h = fs.open("/.test-records/paddle.record", "r")
  seen.record = h and textutils.unserialise(h.readAll())
  if h then h.close() end
end)

ccunit.test("North finds South and asks for a game, and South joins", function()
  ccunit.truthy(seen.found, "no PLAY button: South was never heard")
  ccunit.truthy(seen.playing, "the match never started")
  ccunit.eq(seen.mode, "host")
  ccunit.eq(seen.names, { "North", "South" })
  ccunit.truthy(seen.peerPlaying, "South's wall never showed the match")
end)

ccunit.test("a tap sets North's paddle, and South's wall shows it move", function()
  ccunit.truthy(math.abs(seen.target - 6.5) < 1, "target " .. tostring(seen.target))
  ccunit.truthy(seen.peerTarget, "South never saw it")
end)

ccunit.test("both paddles hit the ball, and a miss scores for South on both walls", function()
  ccunit.truthy(seen.rally >= 1, "nobody hit the ball")
  ccunit.eq(seen.score[2], 1) -- North may have won a point of its own while it was still returning the ball
  ccunit.truthy(seen.peerScore, "South's wall shows a different score")
  ccunit.truthy(seen.pointSound, "no sound for the point")
end)

ccunit.test("QUIT twice gives South the match, on both walls", function()
  ccunit.truthy(seen.quit)
  ccunit.eq(seen.winner, 2)
  ccunit.eq(seen.forfeit, 1)
  ccunit.truthy(seen.peerEnd, "South's wall never showed the win")
end)

ccunit.test("North keeps its record against South", function()
  ccunit.eq(seen.record, { { name = "South", wins = 0, losses = 1 } })
end)

ccunit.test("both computers stayed in step at full speed", function()
  ccunit.eq(seen.resyncs, 0)
  local m = seen.smooth
  ccunit.truthy(m.steps > 50, "only " .. m.steps .. " steps")
  -- Full speed is the game's clock keeping to the real one: a late frame catches up (up to three steps at once), so
  -- only steps it had to drop count. How many frames came late is the machine's business: a busy host makes many.
  ccunit.truthy(m.dropped <= m.steps / 10, m.dropped .. " steps dropped in " .. m.steps .. " (" .. m.late .. " late frames)")
end)
