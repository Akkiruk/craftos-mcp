-- artillery.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Artillery across two computers (games-versus.integration.test.ts starts both): this one is North, player 1, and the
-- other runs peer.lua as South, whose computer player aims and fires on its turns. On North's turn a tap in the sky aims
-- the barrel, + nudges the power, FIRE sends the shot, and the turn goes over to South on both walls. On South's turn
-- North's taps do nothing.

if not peripheral.find("modem") then
  ccunit.test("needs two computers with modems (run by games-versus.integration.test.ts)", function() end)
  return
end

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()

local seen = {}

kit.run(function()
  kit.open("artillery")
  seen.playing = kit.challenge()
  local m = kit.match()
  local s = m.state
  local L = kit.S.L

  -- If South has the first turn, North's taps are refused, and South shoots
  kit.waitFor(function() return s.phase == "aim" end, 20)
  seen.first = s.turn
  if s.turn == 2 then
    local angle = s.tanks[1].angle
    kit.tap(L.x0 + 20, L.y0 + 10)
    seen.refused = s.tanks[1].angle == angle
    local turnNo = s.turnNo
    seen.southShot = kit.waitFor(function() return s.turnNo > turnNo and s.phase == "aim" end, 60)
  end

  -- North's turn: aim in the sky, a notch more power, FIRE
  seen.northTurn = kit.waitFor(function() return s.phase == "aim" and s.turn == 1 end, 60)
  local t = s.tanks[1]
  local before = { t.angle, t.power }
  kit.tap(L.x0 + 70, L.y0 + 5, 0.3)
  seen.aimed = { before[1], before[2], t.angle, t.power, s.phase, s.turn, kit.S.lastAction and kit.S.lastAction.kind }
  seen.aimChanged = t.angle ~= before[1] or t.power ~= before[2]
  local power = t.power
  kit.press("tankPowerUp", nil, 0.3)
  seen.powerUp = t.power == math.min(100, power + 1)
  local turnNo = s.turnNo
  kit.press("tankFire", nil, 0.3)
  seen.fired = kit.waitFor(function() return s.phase == "fly" or s.turnNo > turnNo end, 3)
  seen.fireSound = kit.heard("cannon")

  -- The shot plays out, and it's South's turn on both walls
  seen.southTurn = kit.waitFor(function() return s.phase == "aim" and s.turn == 2 end, 30)
  seen.peerSouthTurn = kit.waitPeer(function(r) return r.turn == 2 and r.phase == "aim" and r.turnNo == s.turnNo end, 5)
  seen.hp = { s.tanks[1].hp, s.tanks[2].hp }
  seen.peerHp = kit.waitPeer(function(r) return r.hp and r.hp[1] == s.tanks[1].hp and r.hp[2] == s.tanks[2].hp end, 5)

  -- South aims and fires from its own computer, and the turn comes back
  local southTurn = s.turnNo
  seen.southFired = kit.waitFor(function() return s.turnNo > southTurn end, 60)
  seen.quit = kit.quit()
  seen.peerEnd = kit.waitPeer(function(r) return r.winner == 2 end, 5)
  seen.resyncs = kit.peer().resyncs
end)

ccunit.test("South joins and the first turn comes round", function()
  ccunit.truthy(seen.playing, "the match never started")
  ccunit.truthy(seen.first == 1 or seen.first == 2)
  if seen.first == 2 then
    ccunit.truthy(seen.refused, "North aimed on South's turn")
    ccunit.truthy(seen.southShot, "South never shot")
  end
end)

ccunit.test("a tap in the sky aims North's barrel, and + adds power", function()
  ccunit.truthy(seen.northTurn, "North's turn never came")
  ccunit.truthy(seen.aimChanged, "aim stayed at " .. textutils.serialise(seen.aimed))
  ccunit.truthy(seen.powerUp, "power didn't go up")
end)

ccunit.test("FIRE sends the shot, and then it's South's turn on both walls", function()
  ccunit.truthy(seen.fired, "no shot")
  ccunit.truthy(seen.fireSound, "no sound for the shot")
  ccunit.truthy(seen.southTurn, "the turn never passed")
  ccunit.truthy(seen.peerSouthTurn, "South's wall disagrees about the turn")
  ccunit.truthy(seen.peerHp, "the walls disagree about the damage")
end)

ccunit.test("South fires from its own computer, and QUIT ends it on both walls", function()
  ccunit.truthy(seen.southFired, "South never fired")
  ccunit.truthy(seen.quit)
  ccunit.truthy(seen.peerEnd, "South's wall never ended")
  ccunit.eq(seen.resyncs, 0)
end)
