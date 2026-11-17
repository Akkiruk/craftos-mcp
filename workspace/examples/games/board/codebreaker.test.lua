-- Codebreaker, on two walls: the rules on their own (how answers are counted, the code kept out of the other seat's
-- view, the computer cracking a code), then two people hiding and cracking codes by touch, and a whole game against
-- the computer. Run with arcade.world.json and two 6x6 monitors (see README.md).

local kit = require("testkit")
local rules = kit.rules("codebreaker")
local plugin = kit.plugin("codebreaker")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

t("rules: answers count repeated colours properly", function()
  local b, w = rules.feedback("1122", "2211")
  eq({ b, w }, { 0, 4 })
  b, w = rules.feedback("1123", "1312")
  eq({ b, w }, { 1, 3 })
  b, w = rules.feedback("1111", "1112")
  eq({ b, w }, { 3, 0 })
end)

t("rules: a seat's view holds its own code and never the other's", function()
  local a, x = rules.new({ first = 1 }), rules.new({ first = 1 })
  rules.step(a, { kind = "set", code = "1234" }); rules.step(a, { kind = "set", code = "5566" })
  rules.step(x, { kind = "set", code = "1234" }); rules.step(x, { kind = "set", code = "2211" })
  eq(rules.viewFor(a, 1).secrets[2], nil)
  eq(rules.viewFor(a, 1).secrets[1], "1234")
  -- two different hidden codes look exactly the same to the other seat
  eq(textutils.serialise(rules.viewFor(a, 1)), textutils.serialise(rules.viewFor(x, 1)))
end)

t("rules: the second player always gets their guess, so both cracking in one round is a draw", function()
  local s = rules.new({ first = 1 })
  rules.step(s, { kind = "set", code = "1234" })
  rules.step(s, { kind = "set", code = "5566" })
  rules.step(s, { kind = "guess", code = "5566" })
  eq(s.winner, 0)
  rules.step(s, { kind = "guess", code = "1234" })
  eq(s.winner, 3)
end)

t("rules: the computer on hard cracks a code within ten guesses, seeing only its own view", function()
  for _ = 1, 4 do
    local s = rules.new({ first = 1 })
    rules.step(s, { kind = "set", code = "3142" })
    rules.step(s, { kind = "set", code = "6251" })
    while s.winner == 0 do
      assert(rules.step(s, plugin.chooseAction(rules.viewFor(s, s.turn), "hard")))
    end
    truthy(s.log[1][#s.log[1]].black == 4 or s.log[2][#s.log[2]].black == 4, "someone cracked it")
  end
end)

-- ---------------------------------------------------------------- on the walls

local seen = {}

local function tapPeg(colour, wallIndex)
  local L = kit.app.env.L
  kit.touch(L.x0 + (colour - 1) * L.pickW + math.floor(L.pickW / 2), L.pickY + 2, wallIndex)
end

--- Tap a whole code, then GO.
local function enter(code, wallIndex)
  for i = 1, #code do tapPeg(tonumber(code:sub(i, i)), wallIndex) end
  kit.tap("go", nil, wallIndex)
end

local problem = kit.run(function()
  kit.openGame("codebreaker", 1)
  kit.tap("blueSeat", "player", 2)
  kit.start(1)
  local g = kit.S.match

  -- three pegs are not a code
  enter("123", 1)
  seen.short = kit.toast()
  -- the fourth peg, and Red's code is hidden; then Blue hides theirs on the other wall
  tapPeg(4, 1)
  kit.tap("go", nil, 1)
  seen.redSet = g.state.secrets[1]
  seen.goOnlyOnBlue = kit.button("go", nil, 2) ~= nil and kit.button("go", nil, 1) == nil
  enter("5566", 2)
  seen.playing = g.state.phase == "play" and g.state.turn == 1

  -- Red cracks it first time; Blue still gets a guess, misses, and Red wins
  enter("5566", 1)
  seen.cracked = kit.toast()
  seen.blueToAnswer = g.state.turn == 2 and g.state.winner == 0
  enter("1111", 2)
  kit.waitEnd(5)
  seen.finalLine = kit.S.finalMatch and kit.app.plugin.view.finalLine(kit.S.finalMatch)
  kit.touch(60, 40)
  kit.tap("newgame")

  -- against the computer on hard: the person keeps guessing wrong, the computer cracks the code
  kit.tap("game", "codebreaker")
  kit.seats("player", "hard")
  kit.start()
  enter("1234", 1)
  -- never the computer's own code: it is drawn at random, and could be one of these
  local guesses = { "5555", "6666", "5656", "6565", "5566", "6655", "5665", "6556", "5565", "6656" }
  local n, tried = 0, 0
  while kit.S.view == "game" and tried < #guesses do
    if kit.waitTurn(1, 30) and kit.S.view == "game" then
      n = n + 1
      local secret = kit.S.match.state.secrets[2]
      if guesses[n] ~= secret then
        tried = tried + 1
        enter(guesses[n], 1)
      end
      if n >= #guesses then break end
    end
  end
  kit.waitEnd(30)
  local f = kit.S.finalMatch
  seen.cpuGame = f and { winner = f.state.winner, blue = f.state.log[2], code = f.state.secrets[1] }
end, { thinkMs = 50 })

t("the scenario ran to the end", function() eq(problem, nil) end)

t("walls: a code needs four pegs", function()
  eq(seen.short, "Pick all four pegs first")
  eq(seen.redSet, "1234")
end)

t("walls: each player hides their code on their own wall", function()
  eq(seen.goOnlyOnBlue, true)
  eq(seen.playing, true)
end)

t("walls: cracking first still lets the other player answer, then wins", function()
  eq(seen.cracked, "Player 1 cracked it! One guess left to match it")
  eq(seen.blueToAnswer, true)
  eq(seen.finalLine, "Player 1 cracked Player 2's code in 1")
end)

t("walls: the computer cracks the person's code", function()
  truthy(seen.cpuGame, "the game ended")
  eq(seen.cpuGame.code, "1234")
  eq(seen.cpuGame.winner, 2)
  eq(seen.cpuGame.blue[#seen.cpuGame.blue].code, "1234")
end)
