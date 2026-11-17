-- Reversi: the rules on their own, then a whole game played by two people through touches on the wall, and a move
-- against the computer. Run with arcade.world.json and two 6x6 monitors (see README.md).

local kit = require("testkit")
local rules = kit.rules("reversi")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

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

t("rules: the number of positions after 1 to 4 moves is the published 4, 12, 56, 244", function()
  for depth, want in ipairs({ 4, 12, 56, 244 }) do eq(perft(rules.new({ first = 1 }), depth), want) end
end)

t("rules: a player with no move passes and the other goes again", function()
  local s = rules.new({ first = 1 })
  for y = 1, 8 do for x = 1, 8 do s.board[y][x] = 0 end end
  -- Red takes the only blue disc in reach, leaving Blue nothing, with a second Blue group Red can still reach
  s.board[1][1], s.board[1][2] = 1, 2
  s.board[8][1], s.board[8][2] = 1, 2
  s.score = { 2, 2 }
  local _, events = rules.step(s, { kind = "place", x = 3, y = 1 })
  eq(s.turn, 1)
  eq(events[2].type, "pass")
  eq(s.winner, 0)
  rules.step(s, { kind = "place", x = 3, y = 8 })
  eq(s.winner, 1)
  eq(s.score, { 6, 0 })
end)

t("rules: a move that flips nothing is refused, with the reason", function()
  local s = rules.new({ first = 1 })
  local ok, why = rules.step(s, { kind = "place", x = 1, y = 1 })
  eq(ok, nil)
  eq(why, "That flips nothing")
end)

-- ---------------------------------------------------------------- on the wall

local seen = {}

local problem = kit.run(function()
  kit.openGame("reversi")
  kit.seats("player", "player")
  kit.start()

  -- a corner flips nothing at the start
  kit.tapCell(1, 1)
  seen.refused = kit.toast()
  seen.afterRefused = #kit.S.match.actions

  -- then a whole game: each side plays its first legal square, by touch, until neither can move
  local stuck = false
  while kit.S.view == "game" and not stuck do
    local g = kit.S.match
    local before = #g.actions
    local a = rules.legalActions(g.state)[1]
    kit.tapCell(a.x, a.y)
    stuck = #(kit.S.match or kit.S.finalMatch).actions == before
  end
  seen.stuck = stuck
  local s = kit.S.finalMatch and kit.S.finalMatch.state
  seen.final = s and { winner = s.winner, score = { s.score[1], s.score[2] }, legal = #rules.legalActions(s) }
  -- the discs on the board are the score
  if s then
    local count = { 0, 0 }
    for y = 1, 8 do
      for x = 1, 8 do
        local v = s.board[y][x]
        if v ~= 0 then count[v] = count[v] + 1 end
      end
    end
    seen.counted = count
  end
  kit.touch(60, 40)
  seen.result = kit.S.view
  kit.tap("newgame")

  -- the computer answers a move
  kit.tap("game", "reversi")
  kit.seats("player", "hard")
  kit.start()
  local a = rules.legalActions(kit.S.match.state)[1]
  kit.tapCell(a.x, a.y)
  seen.cpuAnswered = kit.waitTurn(1, 30) and #kit.S.match.actions
end, { thinkMs = 50 })

t("the scenario ran to the end", function() eq(problem, nil) end)

t("wall: a move that flips nothing is refused, and nothing changes", function()
  eq(seen.refused, "That flips nothing")
  eq(seen.afterRefused, 0)
end)

t("wall: a whole game by touch ends with nobody able to move, and the most discs wins", function()
  eq(seen.stuck, false)
  truthy(seen.final, "the game ended")
  eq(seen.final.legal, 0)
  eq(seen.counted, seen.final.score)
  local a, b = seen.final.score[1], seen.final.score[2]
  eq(seen.final.winner, a > b and 1 or (b > a and 2 or 3))
  eq(seen.result, "result")
end)

t("wall: the computer answers a move", function() eq(seen.cpuAnswered, 2) end)

t("sound: discs are placed and flipped", function()
  truthy(kit.played("minecraft:entity.armor_stand.place") > 5)
  truthy(kit.played("minecraft:item.book.page_turn") > 5)
end)
