-- Mancala: the rules on their own (extra turns, captures, the end), then a whole game by two people through touches,
-- with a refused move, and a move against the computer. Run with arcade.world.json and two 6x6 monitors (README.md).

local kit = require("testkit")
local rules = kit.rules("mancala")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

t("rules: four seeds from the third pit end in the store, and the same player goes again", function()
  local s = rules.new({ first = 1 })
  local _, events = rules.step(s, { kind = "sow", pit = 3 })
  eq(s.turn, 1)
  eq(s.stores[1], 1)
  eq(s.pits[1], { 4, 4, 0, 5, 5, 5 })
  truthy(events[1].again)
end)

t("rules: the last seed in an empty pit of your own takes the seeds opposite", function()
  local s = rules.new({ first = 1 })
  s.pits[1] = { 1, 0, 4, 4, 4, 4 }
  s.pits[2] = { 4, 4, 4, 4, 7, 4 } -- Blue's pit 5 faces Red's pit 2
  local _, events = rules.step(s, { kind = "sow", pit = 1 })
  eq(events[1].captured, 8)
  eq(s.stores[1], 8)
  eq(s.pits[1][2], 0)
  eq(s.pits[2][5], 0)
  eq(s.turn, 2)
end)

t("rules: an empty pit is refused", function()
  local s = rules.new({ first = 1 })
  rules.step(s, { kind = "sow", pit = 3 })
  local ok, why = rules.step(s, { kind = "sow", pit = 3 })
  eq(ok, nil)
  eq(why, "That pit is empty")
end)

t("rules: when one side runs dry each keeps what is left, and all 48 seeds are counted", function()
  for seed = 1, 20 do
    local s = rules.new({ first = seed % 2 + 1 })
    local n = seed
    while s.winner == 0 do
      local list = rules.legalActions(s)
      n = (n * 16807) % 2147483647
      assert(rules.step(s, list[n % #list + 1]))
    end
    eq(s.stores[1] + s.stores[2], 48)
    eq(s.winner, s.stores[1] > s.stores[2] and 1 or (s.stores[2] > s.stores[1] and 2 or 3))
  end
end)

-- ---------------------------------------------------------------- on the wall

local seen = {}

--- Tap one of the mover's pits. Red's run left to right along the bottom; Blue's right to left along the top.
local function tapPit(seat, pit)
  local L = kit.app.env.L
  local x = seat == 1 and L.x0 + pit * L.cw or L.x0 + (7 - pit) * L.cw
  local y = seat == 1 and L.bottomY or L.topY
  kit.touch(x + math.floor(L.cw / 2), y + math.floor(L.ch / 2))
end

local problem = kit.run(function()
  kit.openGame("mancala")
  kit.seats("player", "player")
  kit.start()

  tapPit(1, 3)
  seen.again = { turn = kit.S.match.state.turn, store = kit.S.match.state.stores[1], toast = kit.toast() }
  tapPit(1, 3)
  seen.refused = kit.toast()
  seen.afterRefused = #kit.S.match.actions

  -- the rest of the game: each side sows its first pit with seeds
  local stuck = false
  while kit.S.view == "game" and not stuck do
    local s = kit.S.match.state
    local before = #kit.S.match.actions
    tapPit(s.turn, rules.legalActions(s)[1].pit)
    stuck = #(kit.S.match or kit.S.finalMatch).actions == before
  end
  seen.stuck = stuck
  local f = kit.S.finalMatch
  seen.final = f and { winner = f.state.winner, stores = { f.state.stores[1], f.state.stores[2] } }
  kit.touch(60, 40)
  kit.tap("newgame")

  kit.tap("game", "mancala")
  kit.seats("player", "hard")
  kit.start()
  tapPit(1, 1)
  seen.cpuAnswered = kit.waitTurn(1, 30) and #kit.S.match.actions >= 2
end, { thinkMs = 50 })

t("the scenario ran to the end", function() eq(problem, nil) end)

t("wall: the last seed in the store gives another turn, and the wall says so", function()
  eq(seen.again.turn, 1)
  eq(seen.again.store, 1)
  eq(seen.again.toast, "Player 1 landed in the store and goes again")
end)

t("wall: an empty pit is refused", function()
  eq(seen.refused, "That pit is empty")
  eq(seen.afterRefused, 1)
end)

t("wall: a whole game by touch ends with all 48 seeds in the stores", function()
  eq(seen.stuck, false)
  truthy(seen.final, "the game ended")
  eq(seen.final.stores[1] + seen.final.stores[2], 48)
  local a, b = seen.final.stores[1], seen.final.stores[2]
  eq(seen.final.winner, a > b and 1 or (b > a and 2 or 3))
end)

t("wall: the computer answers a move", function() eq(seen.cpuAnswered, true) end)

t("sound: seeds are sown", function()
  truthy(kit.played("minecraft:block.nether_sprouts.fall") > 5)
end)
