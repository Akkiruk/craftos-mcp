-- Four in a Row, and the cabinet around every game: the rules on their own, then two people playing through touches on
-- the wall (a refused move, a win, the results, a rematch), the computer answering a move, a hint, a resignation and a
-- replay. Run with arcade.world.json and two 6x6 monitors (see README.md).

local kit = require("testkit")
local rules = kit.rules("fourinarow")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

local function drops(s, list)
  for _, c in ipairs(list) do assert(rules.step(s, { kind = "drop", col = c })) end
  return s
end

--- How many positions lie exactly this many moves ahead.
local function perft(s, depth)
  if depth == 0 then return 1 end
  local total = 0
  for _, a in ipairs(rules.legalActions(s)) do
    local c = textutils.unserialise(textutils.serialise(s))
    assert(rules.step(c, a))
    total = total + perft(c, depth - 1)
  end
  return total
end

t("rules: the number of positions after 1 to 4 moves is the published 7, 49, 343, 2401", function()
  for depth, want in ipairs({ 7, 49, 343, 2401 }) do eq(perft(rules.new({ first = 1 }), depth), want) end
end)

t("rules: a full column is refused, and a vertical four wins", function()
  local s = drops(rules.new({ first = 1 }), { 1, 2, 1, 2, 1, 2, 1 })
  eq(s.winner, 1)
  eq(#s.line, 4)
  local f = drops(rules.new({ first = 1 }), { 1, 1, 1, 1, 1, 1 })
  local ok, why = rules.step(f, { kind = "drop", col = 1 })
  eq(ok, nil)
  eq(why, "That column is full")
end)

t("rules: a filled board with no line is a draw", function()
  local s = rules.new({ first = 1 })
  -- every other row swaps colours, which leaves no line of four in any direction
  local rows = { "1121122", "2212211", "1121122", "2212211", "1121122", "2212211" }
  for r = 1, 6 do
    for c = 1, 7 do s.cells[c][r] = tonumber(rows[r]:sub(c, c)) end
  end
  s.cells[7][6] = nil
  s.moves, s.turn = 41, 1
  assert(rules.step(s, { kind = "drop", col = 7 }))
  eq(s.winner, 3)
end)

t("rules: a forfeit ends the game for either seat", function()
  for seat = 1, 2 do
    local s = rules.new({ first = 1 })
    assert(rules.step(s, { kind = "forfeit", seat = seat }))
    eq(s.winner, 3 - seat)
    eq(#rules.legalActions(s), 0)
  end
end)

-- ---------------------------------------------------------------- on the wall

local seen = {}

local function drop(col)
  kit.tapCell(col, 3)
end

local problem = kit.run(function()
  -- two people, one wall
  kit.openGame("fourinarow")
  kit.seats("player", "player")
  seen.started = kit.start()
  seen.names = { kit.S.match.red.name, kit.S.match.blue.name }

  -- column 1 filled with alternating discs, so nobody has a line, then a seventh disc is refused
  for _ = 1, 6 do drop(1) end
  seen.afterSix = #kit.S.match.actions
  drop(1)
  seen.refused = kit.S.toast and kit.S.toast.text
  seen.afterRefused = #kit.S.match.actions

  -- Red builds a column in 2 while Blue builds one in 3, and Red's fourth wins
  for _, col in ipairs({ 2, 3, 2, 3, 2, 3, 2 }) do drop(col) end
  seen.ended = kit.waitEnd(5)
  local g = kit.S.finalMatch
  seen.winner, seen.line, seen.moves = g.state.winner, #g.state.line, g.state.moves
  seen.finalLine = g and (kit.app.plugin.view.finalLine(g))

  -- the final board, then the results
  kit.touch(60, 40)
  seen.result = kit.S.view == "result" and kit.S.result.winner

  -- the replay plays every move again, and a touch stops it
  kit.tap("replay")
  seen.replaying = kit.S.view == "replay"
  kit.waitFor(function() return kit.S.replay and kit.S.replay.step >= 3 end, 10)
  seen.replayStep = kit.S.replay and kit.S.replay.step
  kit.touch(60, 40)
  seen.afterReplay = kit.S.view

  -- a rematch swaps colours, and the loser (now Red) moves first
  kit.tap("rematch")
  local m = kit.S.match
  seen.rematch = m and { m.red.name, m.blue.name, m.state.turn }

  -- resigning takes two taps; on one wall it counts against the side to move
  kit.tap("resign")
  seen.confirm = kit.S.match and kit.S.match.confirmResign
  kit.tap("resign")
  kit.waitEnd(5)
  seen.resigned = kit.S.finalMatch.state.forfeit
  kit.touch(60, 40)
  kit.tap("newgame")

  -- against the computer: it answers a move, and a hint is offered on the player's turn
  kit.tap("game", "fourinarow")
  kit.seats("player", "hard")
  kit.start()
  kit.tap("hint")
  seen.hint = kit.S.match.hint and kit.S.match.hint.col
  drop(4)
  seen.cpuAnswered = kit.waitTurn(1, 30) and #kit.S.match.actions
  -- the pause box: END THIS GAME leaves with no result
  kit.tap("menu")
  seen.paused = kit.S.match.paused
  kit.tap("abandon")
  seen.abandoned = kit.S.view == "menu" and kit.S.match == nil
end, { thinkMs = 100 })

t("the scenario ran to the end", function() eq(problem, nil) end)

t("wall: two people take Red and Blue", function()
  truthy(seen.started)
  eq(seen.names, { "Player 1", "Player 2" })
end)

t("wall: a disc in a full column is refused, and nothing changes", function()
  eq(seen.afterSix, 6)
  eq(seen.refused, "That column is full")
  eq(seen.afterRefused, 6)
end)

t("wall: four in a column wins, and the final board says so", function()
  truthy(seen.ended)
  eq(seen.winner, 1)
  eq(seen.line, 4)
  eq(seen.moves, 13)
  eq(seen.finalLine, "Player 1 has four in a row!")
  eq(seen.result, 1)
end)

t("wall: the replay plays the match back until a touch stops it", function()
  truthy(seen.replaying)
  truthy((seen.replayStep or 0) >= 3, tostring(seen.replayStep))
  eq(seen.afterReplay, "result")
end)

t("wall: a rematch swaps colours and the loser moves first", function()
  eq(seen.rematch, { "Player 2", "Player 1", 1 })
end)

t("wall: resign asks once, then forfeits the side to move", function()
  eq(seen.confirm, 1)
  eq(seen.resigned, 1)
end)

t("wall: the computer answers, and a hint names a column", function()
  truthy(type(seen.hint) == "number", tostring(seen.hint))
  eq(seen.cpuAnswered, 2)
  truthy(seen.paused)
  truthy(seen.abandoned)
end)

t("sound: a dropped disc, the start and the win all play on the speaker", function()
  truthy(kit.played("minecraft:block.slime_block.fall") >= 13)
  truthy(kit.played("minecraft:item.trident.return") >= 1)
  truthy(kit.played("minecraft:entity.player.levelup") >= 1)
end)
