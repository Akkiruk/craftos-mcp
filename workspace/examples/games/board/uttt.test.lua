-- Ultimate Tic-Tac-Toe: the rules on their own (where a move sends you, decided boards, the big line), then a whole
-- game by two people through touches, with a refused move, and the computer answering.
-- Run with arcade.world.json and two 6x6 monitors (see README.md).

local kit = require("testkit")
local rules = kit.rules("uttt")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

local function play(s, list)
  for _, m in ipairs(list) do assert(rules.play(s, m[1], m[2])) end
  return s
end

t("rules: a new game has 81 moves, and a move sends the opponent to the matching board", function()
  local s = rules.new({ first = 1 })
  eq(#rules.legalMoves(s), 81)
  play(s, { { 5, 3 } })
  eq(s.forced, 3)
  eq(s.turn, 2)
  eq(#rules.legalMoves(s), 9)
  local ok, why = rules.checkAction(s, { kind = "move", b = 4, c = 1 })
  eq(ok, false)
  eq(why, "must play in board 3")
end)

t("rules: coordinates convert both ways for every cell", function()
  for b = 1, 9 do
    for c = 1, 9 do
      local x, y = rules.toXY(b, c)
      local b2, c2 = rules.fromXY(x, y)
      eq({ b2, c2 }, { b, c })
    end
  end
end)

t("rules: a won board is decided, and being sent to it is a free move", function()
  -- Red takes board 5 with its top row
  local w = play(rules.new({ first = 1 }), { { 5, 1 }, { 1, 5 }, { 5, 2 }, { 2, 5 }, { 5, 3 } })
  eq(w.sub[5], 1)
  eq(w.forced, 3)
  -- sent to a decided board: anywhere open
  local f = play(rules.new({ first = 1 }), { { 5, 1 }, { 1, 5 }, { 5, 2 }, { 2, 5 }, { 5, 3 }, { 3, 5 } })
  eq(f.forced, nil)
  local ok, why = rules.checkAction(f, { kind = "move", b = 5, c = 4 })
  eq(ok, false)
  eq(why, "that board is already decided")
end)

t("rules: three boards in a line win the game", function()
  local s = rules.new({ first = 1 })
  s.sub = { 1, 1, 0, 0, 0, 0, 0, 0, 0 }
  s.boards = { 2, 0, 0 }
  -- Red completes board 3 (cells 1 and 2 already Red)
  s.cells[rules.idx(3, 1)], s.cells[rules.idx(3, 2)] = 1, 1
  s.forced = 3
  assert(rules.play(s, 3, 3))
  eq(s.winner, 1)
  eq(rules.LINES[s.metaLine], { 1, 2, 3 })
end)

t("rules: random games always finish legally, and undo goes back to the start", function()
  for seed = 1, 20 do
    local s = rules.new({ first = 1 })
    local n = seed
    while s.winner == 0 do
      local list = rules.legalMoves(s)
      n = (n * 16807) % 2147483647
      local idx = list[n % #list + 1]
      assert(rules.play(s, rules.boardOf(idx), rules.cellOf(idx)))
    end
    while rules.undo(s) do end
    eq(s.moves, 0)
    eq(#rules.legalMoves(s), 81)
  end
end)

-- ---------------------------------------------------------------- on the wall

local seen = {}

local function tapMove(b, c)
  kit.tapCell(rules.toXY(b, c))
end

local problem = kit.run(function()
  kit.openGame("uttt")
  kit.seats("player", "player")
  kit.start()

  tapMove(5, 3)
  seen.forced = kit.S.match.state.forced
  tapMove(4, 1) -- not board 3
  seen.refused = kit.S.toast and kit.S.toast.text
  seen.afterRefused = #kit.S.match.actions

  local stuck = false
  while kit.S.view == "game" and not stuck do
    local before = #kit.S.match.actions
    local a = rules.legalActions(kit.S.match.state)[1]
    tapMove(a.b, a.c)
    stuck = #(kit.S.match or kit.S.finalMatch).actions == before
  end
  seen.stuck = stuck
  local f = kit.S.finalMatch
  seen.final = f and { winner = f.state.winner, metaLine = f.state.metaLine, open = #rules.legalMoves(f.state) }
  seen.finalLine = f and kit.app.plugin.view.finalLine(f)
  kit.touch(60, 40)
  kit.tap("newgame")

  kit.tap("game", "uttt")
  kit.seats("player", "hard")
  kit.start()
  tapMove(5, 5)
  seen.cpuAnswered = kit.waitTurn(1, 30) and kit.S.match.state.history[2] ~= nil and kit.S.match.state.history[2].b
end, { thinkMs = 50 })

t("the scenario ran to the end", function() eq(problem, nil) end)

t("wall: a move sends the opponent, and a move in another board is refused", function()
  eq(seen.forced, 3)
  eq(seen.refused, "You must play in board 3")
  eq(seen.afterRefused, 1)
end)

t("wall: a whole game by touch ends with a line of boards or a full board", function()
  eq(seen.stuck, false)
  truthy(seen.final, "the game ended")
  if seen.final.winner == 3 then
    eq(seen.final.metaLine, nil)
  else
    truthy(seen.final.metaLine ~= nil, "a winning line")
    truthy(seen.finalLine:find("in a line", 1, true), seen.finalLine)
  end
end)

t("wall: the computer answers in the board it was sent to", function() eq(seen.cpuAnswered, 5) end)
