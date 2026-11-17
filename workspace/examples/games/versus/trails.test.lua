-- trails.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Trails across two computers (games-versus.integration.test.ts starts both): this one is North, player 1, and the other
-- runs peer.lua as South, which steers by tapping the sides of its own wall. North steers into the top edge: the crash
-- ends the round on both walls, South takes it, and the next round counts in on both.

if not peripheral.find("modem") then
  ccunit.test("needs two computers with modems (run by games-versus.integration.test.ts)", function() end)
  return
end

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()

local seen = {}

kit.run(function()
  kit.open("trails")
  seen.playing = kit.challenge()
  local m = kit.match()
  local s = m.state
  seen.peerPlaying = kit.waitPeer(function(r) return r.view == "play" end, 60)

  -- Every turn either rider takes passes through the game's events on this computer, which runs the clock
  local turns = { 0, 0 }
  local onEvents = kit.S.game.view.onEvents
  kit.S.game.view.onEvents = function(app, state, events)
    for _, ev in ipairs(events) do
      if ev.type == "turn" then turns[ev.player] = turns[ev.player] + 1 end
    end
    return onEvents(app, state, events)
  end

  -- Waits below are for states, with generous limits: how long they take depends on how busy the machine is.
  -- North turns up, a tap on the top of the wall, and rides into the edge
  kit.tap(60, 10)
  seen.turned = kit.waitFor(function() return s.cycles[1].dir == "up" end, 60)
  seen.crash = kit.waitFor(function() return s.phase == "crash" end, 90)
  seen.roundWinner, seen.score = s.roundWinner, { s.score[1], s.score[2] }
  seen.crashSound = kit.heard("boom_small")
  seen.peerCrash = kit.waitPeer(function(r) return r.phase == "crash" and r.roundWinner == 2 end, 60)
  seen.peerScore = kit.peer().score

  -- The next round counts in on both walls
  seen.nextRound = kit.waitFor(function() return s.round == 2 end, 60)
  seen.peerNext = kit.waitPeer(function(r) return r.round == 2 end, 60)

  -- Round two: North rides the way the computer would, tapping its sides, while South steers from its own wall
  local SIDE = { up = { 60, 10 }, down = { 60, 72 }, left = { 4, 40 }, right = { 116, 40 } }
  local steady = function(n) if n then return 1 end return 0.5 end
  kit.waitFor(function() return s.phase == "run" end, 60)
  seen.southTurned = kit.waitFor(function()
    local action = s.phase == "run" and kit.game("trails").rules.bot(s, steady, 1)
    if action then kit.tap(SIDE[action.dir][1], SIDE[action.dir][2], 0.05) end
    return turns[2] > 0
  end, 90)
  seen.northTurns = turns[1]
  seen.peerTrail = kit.waitPeer(function(r) return r.trail2 and math.abs(r.trail2 - #s.cycles[2].trail) <= 2 end, 60)
  seen.quit = kit.quit()
  seen.peerEnd = kit.waitPeer(function(r) return r.winner == 2 end, 60)
  seen.smooth = { steps = kit.S.steps or 0, late = kit.S.lateFrames or 0, slow = kit.S.slowFrames or 0,
    dropped = kit.S.droppedSteps or 0 }
  seen.resyncs = kit.peer().resyncs
end)

ccunit.test("South joins, and its wall shows the match", function()
  ccunit.truthy(seen.playing, "the match never started")
  ccunit.truthy(seen.peerPlaying, "South's wall never showed it")
end)

ccunit.test("a tap on the top of the wall turns North's rider up", function()
  ccunit.truthy(seen.turned)
end)

ccunit.test("South steers from its own wall, and both walls show the same trail", function()
  ccunit.truthy(seen.southTurned, "South's rider never turned")
  ccunit.truthy(seen.peerTrail, "South's wall is behind")
end)

ccunit.test("North's crash ends the round on both walls, and South takes it", function()
  ccunit.truthy(seen.crash, "no crash")
  ccunit.eq(seen.roundWinner, 2)
  ccunit.eq(seen.score, { 0, 1 })
  ccunit.truthy(seen.crashSound, "no crash sound")
  ccunit.truthy(seen.peerCrash, "South's wall never showed the crash")
  ccunit.eq(seen.peerScore, { 0, 1 })
end)

ccunit.test("the next round counts in on both walls", function()
  ccunit.truthy(seen.nextRound)
  ccunit.truthy(seen.peerNext, "South's wall stayed on round 1")
end)

ccunit.test("QUIT ends it on both walls, and they stayed in step at full speed", function()
  ccunit.truthy(seen.quit)
  ccunit.truthy(seen.peerEnd, "South's wall never ended")
  ccunit.eq(seen.resyncs, 0)
  -- Full speed is the game's clock keeping to the real one: a late frame catches up (up to three steps at once), so
  -- only steps it had to drop count. Late and slow frames are timed on the clock, which a busy host runs on while the
  -- computer waits for the CPU, so they are only reported.
  local m = seen.smooth
  ccunit.truthy(m.steps > 50, "only " .. m.steps .. " steps")
  ccunit.truthy(m.dropped <= m.steps / 10,
    m.dropped .. " steps dropped in " .. m.steps .. " (" .. m.slow .. " slow, " .. m.late .. " late frames)")
end)
