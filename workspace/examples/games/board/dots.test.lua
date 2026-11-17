-- Dots and Boxes: the rules on their own, a touch near each line drawing that line, then a whole game by two people
-- through touches, with a refused line, and the computer taking a box it is offered.
-- Run with arcade.world.json and two 6x6 monitors (see README.md).

local kit = require("testkit")
local rules = kit.rules("dots")
local plugin = kit.plugin("dots")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

t("rules: one line can close two boxes, and the same player goes again", function()
  local s = rules.new({ first = 1 })
  s.h[1][1], s.h[2][1], s.v[1][1] = 2, 2, 2 -- box 1,1 has all but its right side
  s.h[1][2], s.h[2][2], s.v[1][3] = 2, 2, 2 -- box 2,1 has all but its left side
  s.moves = 6
  rules.step(s, { kind = "line", dir = "v", x = 2, y = 1 })
  eq(s.score[1], 2)
  eq(s.boxes[1][1], 1)
  eq(s.boxes[1][2], 1)
  eq(s.turn, 1)
end)

t("rules: a line already drawn is refused", function()
  local s = rules.new({ first = 2 })
  rules.step(s, { kind = "line", dir = "h", x = 1, y = 1 })
  local ok, why = rules.step(s, { kind = "line", dir = "h", x = 1, y = 1 })
  eq(ok, nil)
  eq(why, "That line is already drawn")
end)

t("rules: the computer on medium takes a box it is offered", function()
  local s = rules.new({ first = 1 })
  s.h[1][1], s.h[2][1], s.v[1][1] = 2, 2, 2
  s.moves = 3
  eq(rules.key(plugin.chooseAction(s, "medium")), "v,2,1")
end)

-- ---------------------------------------------------------------- on the wall

local seen = {}

--- Touch the middle of a line, where a player would.
local function tapLine(a)
  local L = kit.app.env.L
  if a.dir == "h" then
    kit.touch(L.x0 + (a.x - 1) * L.sx + math.floor(L.sx / 2), L.y0 + (a.y - 1) * L.sy)
  else
    kit.touch(L.x0 + (a.x - 1) * L.sx, L.y0 + (a.y - 1) * L.sy + math.floor(L.sy / 2))
  end
end

local problem = kit.run(function()
  kit.openGame("dots")
  -- every line's middle means that line, and the very middle of a box means nothing
  local L = kit.app.env.L
  local wrong = {}
  for _, a in ipairs(rules.legalActions(rules.new({ first = 1 }))) do
    local px = a.dir == "h" and L.x0 + (a.x - 1) * L.sx + math.floor(L.sx / 2) or L.x0 + (a.x - 1) * L.sx
    local py = a.dir == "h" and L.y0 + (a.y - 1) * L.sy or L.y0 + (a.y - 1) * L.sy + math.floor(L.sy / 2)
    local got = plugin.view.actionAt(L, nil, px, py)
    if not got or rules.key(got) ~= rules.key(a) then wrong[#wrong + 1] = rules.key(a) end
  end
  seen.wrongLines = wrong
  seen.boxMiddle = plugin.view.actionAt(L, nil, L.x0 + math.floor(L.sx / 2) + 1, L.y0 + math.floor(L.sy / 2))

  kit.seats("player", "player")
  kit.start()
  tapLine({ dir = "h", x = 1, y = 1 })
  tapLine({ dir = "h", x = 1, y = 1 })
  seen.refused = kit.toast()
  seen.afterRefused = #kit.S.match.actions

  -- the rest: each side draws its first free line
  local stuck = false
  while kit.S.view == "game" and not stuck do
    local before = #kit.S.match.actions
    tapLine(rules.legalActions(kit.S.match.state)[1])
    stuck = #(kit.S.match or kit.S.finalMatch).actions == before
  end
  seen.stuck = stuck
  local f = kit.S.finalMatch
  seen.final = f and { winner = f.state.winner, score = { f.state.score[1], f.state.score[2] }, lines = f.state.moves }
  kit.touch(60, 40)
  kit.tap("newgame")

  -- against the computer: Red offers a box, and the computer takes it and goes again
  kit.tap("game", "dots")
  kit.seats("player", "medium")
  kit.start()
  for _, a in ipairs({ { dir = "h", x = 1, y = 1 } }) do tapLine(a) end
  kit.waitTurn(1, 30)
  seen.cpuMoved = #kit.S.match.actions >= 2
end, { thinkMs = 50 })

t("the scenario ran to the end", function() eq(problem, nil) end)

t("wall: a touch on the middle of each of the 60 lines means that line", function()
  eq(seen.wrongLines, {})
  eq(seen.boxMiddle, nil)
end)

t("wall: a line already drawn is refused", function()
  eq(seen.refused, "That line is already drawn")
  eq(seen.afterRefused, 1)
end)

t("wall: a whole game by touch draws all 60 lines and shares out all 25 boxes", function()
  eq(seen.stuck, false)
  truthy(seen.final, "the game ended")
  eq(seen.final.lines, 60)
  eq(seen.final.score[1] + seen.final.score[2], 25)
  eq(seen.final.winner, seen.final.score[1] > seen.final.score[2] and 1 or 2)
end)

t("wall: the computer answers", function() eq(seen.cpuMoved, true) end)

t("sound: lines and boxes", function()
  truthy(kit.played("minecraft:ui.cartography_table.take_result") > 5)
  truthy(kit.played("minecraft:entity.item.pickup") > 0)
end)
