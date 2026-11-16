-- Checkers: the rules on their own (forced jumps, multi-jumps, kings, the draw rule), then two people on the wall
-- tapping a piece and its square, with a refused move, and a whole game against the computer.
-- Run with arcade.world.json and two 6x6 monitors (see README.md).

local kit = require("testkit")
local rules = kit.rules("checkers")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

--- A position from 8 rows of text: r and b are men, R and B kings.
local function board(rows, turn)
  local s = rules.new({ first = turn or 1 })
  local values = { ["."] = 0, r = 1, b = 2, R = 11, B = 12 }
  s.pieces = { 0, 0 }
  for y = 1, 8 do
    for x = 1, 8 do
      local v = values[rows[y]:sub(x, x)]
      s.board[y][x] = v
      if v ~= 0 then s.pieces[v % 10] = s.pieces[v % 10] + 1 end
    end
  end
  return s
end

local function move(s, fx, fy, tx, ty) return rules.step(s, { kind = "move", fx = fx, fy = fy, tx = tx, ty = ty }) end

local function perft(s, depth)
  if depth == 0 then return 1 end
  local total = 0
  for _, a in ipairs(rules.legalActions(s)) do
    local c = textutils.unserialise(textutils.serialise(s))
    assert(rules.step(c, a))
    -- a jump that carries on stays on the same move
    total = total + perft(c, c.chain and depth or depth - 1)
  end
  return total
end

t("rules: the number of positions after 1 to 4 moves is the published 7, 49, 302, 1469", function()
  for depth, want in ipairs({ 7, 49, 302, 1469 }) do eq(perft(rules.new({ first = 1 }), depth), want) end
end)

t("rules: a capture must be taken", function()
  local s = board({ "........", "........", "........", "........", "...b....", "....r...", ".r......", "........" })
  local ok, why = move(s, 2, 7, 1, 6)
  eq(ok, nil)
  eq(why, "must jump")
  truthy(move(s, 5, 6, 3, 4))
  eq(s.pieces[2], 0)
  eq(s.winner, 1)
end)

t("rules: a double jump keeps the turn and locks the piece", function()
  local s = board({ "........", "........", "...b....", "........", ".....b..", "......r.", ".r......", "..b....." })
  assert(move(s, 7, 6, 5, 4))
  eq(s.turn, 1)
  eq(s.chain, { 5, 4 })
  local ok, why = move(s, 2, 7, 1, 6)
  eq(ok, nil)
  eq(why, "keep jumping")
  assert(move(s, 5, 4, 3, 2))
  eq(s.chain, nil)
  eq(s.pieces[2], 1)
end)

t("rules: crowning ends the turn even with a jump on offer", function()
  local s = board({ "........", "..b.b...", ".....r..", "........", "........", "........", "........", "........" })
  assert(move(s, 6, 3, 4, 1))
  eq(s.board[1][4], 11)
  eq(s.chain, nil)
  eq(s.turn, 2)
end)

t("rules: a king moves both ways and a man does not", function()
  local k = board({ "........", "........", "........", "........", "...R....", "........", "..r.....", "b......." })
  truthy(move(k, 4, 5, 5, 6))
  local m = board({ "........", "........", "........", "........", "...r....", "........", "........", "b......." })
  eq(move(m, 4, 5, 5, 6), nil)
end)

t("rules: forty moves each with no capture or man moved is a draw", function()
  local s = board({ "........", "........", "........", "........", ".......R", "........", "........", "B......." })
  s.quiet = 78
  assert(move(s, 8, 5, 7, 4))
  eq(s.winner, 0)
  assert(move(s, 1, 8, 2, 7))
  eq(s.quiet, 80)
  eq(s.winner, 3)
end)

t("rules: a player left with no move loses", function()
  -- Blue's man at 2,7 has both forward squares taken and nothing to jump to
  local s = board({ "........", "........", "........", "........", "........", "r.r.....", ".b...R..", "r.r....." })
  assert(move(s, 6, 7, 5, 6))
  eq(s.winner, 1)
end)

-- ---------------------------------------------------------------- on the wall

local seen = {}

--- Tap a piece, then its square.
local function play(fx, fy, tx, ty)
  kit.tapCell(fx, fy)
  kit.tapCell(tx, ty)
end

local problem = kit.run(function()
  kit.openGame("checkers")
  kit.seats("player", "player")
  kit.start()

  -- Red steps forward, Blue steps into its path: now Red has a jump, and must take it
  play(3, 6, 4, 5)
  play(6, 3, 5, 4)
  seen.selected = nil
  kit.tapCell(7, 6) -- another Red piece: it has no legal move while a jump is on offer
  seen.mustJump = kit.S.toast and kit.S.toast.text
  play(4, 5, 6, 3)
  local s = kit.S.match.state
  seen.afterJump = { pieces = { s.pieces[1], s.pieces[2] }, turn = s.turn, at = s.board[3][6] }
  -- Blue resigns: two taps of RESIGN on Blue's turn
  kit.tap("resign")
  kit.tap("resign")
  kit.waitEnd(5)
  seen.forfeit = kit.S.finalMatch.state.forfeit
  kit.touch(60, 40)
  kit.tap("newgame")

  -- a whole game against the computer on easy: the person plays their first legal move every time
  kit.tap("game", "checkers")
  kit.seats("player", "easy")
  kit.start()
  local turns = 0
  while kit.S.view == "game" and turns < 200 do
    if kit.waitTurn(1, 30) and kit.S.view == "game" then
      local a = rules.legalActions(kit.S.match.state)[1]
      play(a.fx, a.fy, a.tx, a.ty)
      turns = turns + 1
    end
  end
  kit.waitEnd(30)
  local f = kit.S.finalMatch
  seen.cpuGame = f and { winner = f.state.winner, moves = f.state.moves, pieces = f.state.pieces, legal = #rules.legalActions(f.state) }
end, { thinkMs = 50 })

t("the scenario ran to the end", function() eq(problem, nil) end)

t("wall: with a jump on offer, another piece is refused", function()
  eq(seen.mustJump, "You must jump")
end)

t("wall: tapping the piece and its square makes the jump", function()
  eq(seen.afterJump, { pieces = { 12, 11 }, turn = 2, at = 1 })
end)

t("wall: resigning forfeits the side to move", function() eq(seen.forfeit, 2) end)

t("wall: a whole game against the computer ends with a winner or the draw rule", function()
  truthy(seen.cpuGame, "the game ended")
  local g = seen.cpuGame
  truthy(g.winner == 1 or g.winner == 2 or g.winner == 3, tostring(g.winner))
  if g.winner ~= 3 then
    -- the loser has no piece left, or no move
    eq(g.legal, 0)
  end
end)

t("sound: steps and captures", function()
  truthy(kit.played("minecraft:entity.armor_stand.place") > 0)
  truthy(kit.played("minecraft:entity.item.pickup") > 0)
end)
