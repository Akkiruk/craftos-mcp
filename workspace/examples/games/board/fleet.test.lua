-- Fleet, on two walls: the rules on their own, then two people each at their own wall (placing ships by touch, a
-- refused overlap, a refused second shot, a touch on the wrong wall) playing a whole game, and a whole game against
-- the computer. Run with arcade.world.json and two 6x6 monitors (see README.md).

local kit = require("testkit")
local rules = kit.rules("fleet")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

local SIZE = rules.SIZE

t("rules: ships cannot overlap or hang off the grid", function()
  local s = rules.new({ first = 1 })
  assert(rules.step(s, { kind = "place", x = 1, y = 1, dir = "h" }))
  local ok, why = rules.step(s, { kind = "place", x = 2, y = 1, dir = "v" })
  eq(ok, nil)
  eq(why, "That ship does not fit there")
  eq(rules.step(s, { kind = "place", x = 8, y = 2, dir = "h" }), nil)
end)

t("rules: RANDOM always makes a legal fleet of 17 squares", function()
  for seed = 1, 30 do
    local s = rules.new({ first = 1 })
    local n = seed
    local function rng(k)
      n = (n * 16807) % 2147483647
      if k then return n % k + 1 end
      return n / 2147483647
    end
    rules.step(s, { kind = "auto" }, rng)
    local cells = 0
    for y = 1, SIZE do
      for x = 1, SIZE do
        if s.grids[1][y][x] ~= 0 then cells = cells + 1 end
      end
    end
    eq(cells, 17)
    eq(s.turn, 2)
  end
end)

t("rules: placing comes first, and a square cannot be shot twice", function()
  local s = rules.new({ first = 2 })
  local ok, why = rules.step(s, { kind = "fire", x = 1, y = 1 })
  eq(ok, nil)
  eq(why, "Place your ships first")
  rules.step(s, { kind = "auto" }, math.random)
  rules.step(s, { kind = "auto" }, math.random)
  eq(s.phase, "fire")
  eq(s.turn, 2)
  assert(rules.step(s, { kind = "fire", x = 3, y = 3 }))
  assert(rules.step(s, { kind = "fire", x = 1, y = 1 }))
  ok, why = rules.step(s, { kind = "fire", x = 3, y = 3 })
  eq(ok, nil)
  eq(why, "You already fired there")
end)

t("rules: what a seat is shown holds no enemy ship", function()
  local s = rules.new({ first = 1 })
  rules.step(s, { kind = "auto" }, math.random)
  rules.step(s, { kind = "auto" }, math.random)
  local v = rules.viewFor(s, 1)
  eq(v.fleets[2], nil)
  eq(v.grids[2], nil)
  truthy(v.grids[1] ~= nil)
end)

-- ---------------------------------------------------------------- on the walls

local seen = {}

--- The first square this seat has not fired at.
local function nextTarget(state, seat)
  for y = 1, SIZE do
    for x = 1, SIZE do
      if state.shots[seat][y][x] == 0 then return x, y end
    end
  end
end

local problem = kit.run(function()
  seen.walls = #kit.app.env.walls
  kit.openGame("fleet", 1)

  -- two people tapping PLAYER at the same wall would see each other's ships: refused
  kit.tap("blueSeat", "player", 1)
  kit.tap("start", nil, 1)
  seen.sameWall = kit.toast()
  -- Blue walks round and taps PLAYER on the other wall
  kit.tap("blueSeat", "player", 2)
  kit.start(1)
  local g = kit.S.match
  seen.wallsOk = g.red.wall == kit.app.env.walls[1].name and g.blue.wall == kit.app.env.walls[2].name

  -- a touch on Blue's wall while Red places is refused
  kit.tapCell(5, 5, 2)
  seen.wrongWall = kit.toast()
  -- Red places the Carrier across from the corner, then a Battleship down through it is refused
  kit.tapCell(1, 1, 1)
  seen.placed = g.state.placed[1]
  kit.tap("rotate", nil, 1)
  kit.tapCell(2, 1, 1)
  seen.overlap = kit.toast()
  -- RANDOM places the rest, and it is Blue's turn: only Blue's wall offers RANDOM now
  kit.tap("auto", nil, 1)
  seen.blueToPlace = g.state.turn == 2 and kit.button("auto", nil, 2) ~= nil and kit.button("auto", nil, 1) == nil
  kit.tap("auto", nil, 2)
  seen.firing = g.state.phase == "fire" and g.state.turn == 1

  -- Red fires at 1,1, Blue fires back, then Red's second shot at 1,1 is refused
  kit.tapCell(1, 1, 1)
  kit.tapCell(1, 1, 2)
  kit.tapCell(1, 1, 1)
  seen.twice = kit.toast()

  -- then each fires along the rows from their own wall until a fleet is gone
  local stuck = false
  while kit.S.view == "game" and not stuck do
    local s = kit.S.match.state
    local before = s.moves
    local x, y = nextTarget(s, s.turn)
    kit.tapCell(x, y, s.turn)
    stuck = (kit.S.match or kit.S.finalMatch).state.moves == before
  end
  seen.stuck = stuck
  local f = kit.S.finalMatch
  seen.final = f and { winner = f.state.winner, sunk = { f.state.sunk[1], f.state.sunk[2] } }
  kit.touch(60, 40)
  kit.tap("newgame")

  -- against the computer: the person plays on wall 1, and the computer's wall shows nothing of either fleet
  kit.tap("game", "fleet")
  kit.seats("player", "medium")
  kit.start()
  seen.cpuWallHidden = kit.button("auto", nil, 2) == nil and kit.button("auto", nil, 1) ~= nil
  kit.tap("auto", nil, 1)
  local turns = 0
  while kit.S.view == "game" and turns < 120 do
    if kit.waitTurn(1, 30) and kit.S.view == "game" then
      local s = kit.S.match.state
      local x, y = nextTarget(s, 1)
      kit.tapCell(x, y, 1)
      turns = turns + 1
    end
  end
  kit.waitEnd(30)
  local c = kit.S.finalMatch
  seen.cpuGame = c and { winner = c.state.winner, sunk = { c.state.sunk[1], c.state.sunk[2] } }
end, { thinkMs = 50 })

t("the scenario ran to the end", function() eq(problem, nil) end)

t("walls: the cabinet found both walls, and each player plays on their own", function()
  eq(seen.walls, 2)
  eq(seen.sameWall, "Player 2: go to the other wall and tap PLAYER there")
  eq(seen.wallsOk, true)
end)

t("walls: a touch on the other player's wall is refused", function()
  eq(seen.wrongWall, "It is Player 1's turn, on the other wall")
end)

t("walls: ships are placed by touch, and an overlap is refused", function()
  eq(seen.placed, 1)
  eq(seen.overlap, "That ship does not fit there")
  eq(seen.blueToPlace, true)
  eq(seen.firing, true)
end)

t("walls: a square cannot be shot twice", function()
  eq(seen.twice, "You already fired there")
end)

t("walls: a whole game by touch ends when one fleet is sunk", function()
  eq(seen.stuck, false)
  truthy(seen.final, "the game ended")
  eq(seen.final.sunk[seen.final.winner], 5)
  truthy(seen.final.sunk[3 - seen.final.winner] < 5)
end)

t("walls: against the computer, its wall shows no controls and the game is played out", function()
  eq(seen.cpuWallHidden, true)
  truthy(seen.cpuGame, "the game ended")
  eq(seen.cpuGame.sunk[seen.cpuGame.winner], 5)
end)

t("sound: shots splash and hit", function()
  truthy(kit.played("minecraft:entity.firework_rocket.launch") > 10)
  truthy(kit.played("minecraft:block.pointed_dripstone.drip_water_into_cauldron") > 0)
  truthy(kit.played("minecraft:entity.firework_rocket.large_blast_far") > 0)
end)
