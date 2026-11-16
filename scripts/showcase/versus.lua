-- versus.lua (copied into the versus cabinet's folder as showcase.lua)
-- Part of the craftos-mcp showcase recorder. This is North, player 1: the idle screen, the menu, the game's ready
-- screen, a challenge to the other cabinet (South, which runs peer.lua, the player 2 stand-in from the tests), and then a
-- match for cfg.seconds, played by tapping North's own wall.

local cfg = showcaseConfig()
local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()

local CELL_H = 2
local SIDE = { up = { 60, 10 }, down = { 60, 72 }, left = { 4, 40 }, right = { 116, 40 } }
local function steady(n) if n then return 1 end return 0.5 end

local PLAY = {}

--- Paddle: a match steered to North 3, South 2. When North is level or behind it stays with the ball until South's
-- slower tapping falls behind the rally; when ahead (and South has fewer than 2) it returns a few and lets one by.
local ROWS = require("games.paddle.rules").ROWS
local lastScore = ""

function PLAY.paddle(m, L)
  local s = m.state
  -- North tries to win a point when it is level or behind, and gives one away when it is ahead, so the match stays close
  local point = not (s.score[1] > s.score[2] and s.score[2] < 2)
  local now = s.score[1] .. "-" .. s.score[2]
  if now ~= lastScore then lastScore = now; mark("note score " .. now) end
  if s.wait ~= 0 or s.ball.dir >= 0 then return end
  if os.clock() - (m.lastShowcaseTap or 0) < (point and 0.05 or 0.25) then return end
  local aim
  if point or s.hits < 3 then
    aim = s.ball.y -- stay with the ball: as the rally speeds up, South's slower taps fall behind and miss
  else
    aim = s.ball.y < ROWS / 2 and ROWS - 3 or 3 -- let it by
  end
  if math.abs(s.paddles[1].target - aim) > 0.4 then
    m.lastShowcaseTap = os.clock()
    kit.tap(30, L.y0 + math.floor(aim * CELL_H), 0.02)
  end
end

local function finished()
  local m = kit.S.match
  local s = m and m.state
  return cfg.game == "paddle" and s and (s.score[1] >= 3 or s.score[2] >= 3)
end

--- Trails: tap the side the computer player would turn to.
function PLAY.trails(m)
  local action = kit.S.game.rules.bot(m.state, steady, 1)
  if action and action.kind == "turn" then kit.tap(SIDE[action.dir][1], SIDE[action.dir][2], 0.02) end
end

kit.run(function()
  mark("go")
  kit.waitFor(function() return kit.S.view == "idle" end, 10)
  sleep(cfg.idle or 0.7)
  kit.tap(60, 40)
  kit.waitFor(function() return kit.S.view == "menu" end, 5)
  sleep(cfg.menu or 0.7)
  local _, index = kit.game(cfg.game)
  kit.press("game", index)
  kit.waitFor(function() return kit.S.view == "ready" end, 5)
  kit.waitFor(function() return kit.button("challenge") ~= nil end, 25)
  sleep(cfg.ready or 0.6)
  kit.challenge()
  mark("play")
  local started = os.clock()
  local stilled = false
  while kit.S.view == "play" and os.clock() - started < cfg.seconds and not finished() do
    local m = kit.S.match
    if m then PLAY[cfg.game](m, kit.S.L) end
    if not stilled and os.clock() - started > (cfg.stillAt or 8) then
      stilled = true
      mark("still")
    end
    sleep(0.05)
  end
  local m = kit.S.match
  if m and m.state.score then mark("note final " .. m.state.score[1] .. "-" .. m.state.score[2]) end
  sleep(1.5)
  mark("done")
end)
