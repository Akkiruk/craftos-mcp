-- peer.lua
-- Part of the craftos-mcp examples (MIT).
-- The second computer in the versus tests: the cabinet itself, with a stand-in player 2. It joins when the other
-- cabinet asks, plays its side the way the idle screen's computer player would (by tapping the wall where it can),
-- looks at the final board and the scores, and agrees to a rematch. A few times a second it reports what its wall is
-- showing over rednet, so the test on the other computer can check both screens.

local root = fs.getDir(shell.getRunningProgram())
package.path = "/" .. fs.combine(root, "?.lua") .. ";" .. package.path

local cabinet = require("lib.shell")
local ui = require("lib.ui")
local S = cabinet.S
local REPORT = "craftos-versus-test"

os.setComputerLabel("South")
local monitor = peripheral.find("monitor")
local monitorName = peripheral.getName(monitor)

local function tap(px, py)
  os.queueEvent("monitor_touch", monitorName, px + 1, py + 1)
end

local function press(id)
  for _, b in ipairs(ui.buttons()) do
    if b.id == id then
      tap(b.x + math.floor(b.w / 2), b.y + math.floor(b.h / 2))
      return true
    end
  end
  return false
end

-- Where to tap for each way, on a wall split corner to corner (lib/base.lua splitAction).
local SIDE = { up = { 60, 10 }, down = { 60, 72 }, left = { 4, 40 }, right = { 116, 40 } }

local function steady(n) if n then return 1 end return 0.5 end -- the stand-in never fumbles

--- Player 2's next move, by game.
local PLAY = {}

--- Paddle: follow the ball's height, tapping where the paddle should go.
function PLAY.paddle(m, L)
  local s = m.state
  local goal = s.ball.y
  if math.abs(s.paddles[2].target - goal) > 1.5 then tap(60, L.y0 + math.floor(goal * 2)) end
end

--- Trails: tap the side the computer player would turn to.
function PLAY.trails(m)
  local action = S.game.rules.bot(m.state, steady, 2)
  if action and action.kind == "turn" then tap(SIDE[action.dir][1], SIDE[action.dir][2]) end
end

--- Artillery: the computer player sets angle and power together, which no single tap does, so its move goes in as one.
function PLAY.artillery(m)
  local s = m.state
  if s.phase ~= "aim" or s.turn ~= 2 or s.turnClock < 15 then return end
  local action = S.game.rules.bot(s, steady, 2, "easy")
  if action then cabinet.input(action) end
end

local function player()
  while true do
    local m = S.match
    if S.invite and not S.invite.joined and not m then
      tap(60, 40)
    elseif m and S.view == "play" and m.mode == "guest" then
      PLAY[S.game.id](m, S.L)
    elseif m and S.view == "final" and os.epoch("utc") - m.overAt > 2000 then
      press("seen")
    elseif m and S.view == "over" and m.rematch[1] and not m.rematch[2] then
      press("rematch")
    end
    sleep(0.2)
  end
end

local function reporter()
  while true do
    local m = S.match
    local s = m and m.state
    rednet.broadcast({
      view = S.view, mode = m and m.mode, n = m and m.n, resyncs = S.resyncs or 0,
      score = s and { s.score[1], s.score[2] }, over = s and s.over, winner = s and s.winner, forfeit = m and m.forfeit,
      phase = s and s.phase, round = s and s.round, roundWinner = s and s.roundWinner, turn = s and s.turn,
      paddles = s and s.paddles and { s.paddles[1].target, s.paddles[2].target },
      trail2 = s and s.cycles and #s.cycles[2].trail,
      hp = s and s.tanks and { s.tanks[1].hp, s.tanks[2].hp }, turnNo = s and s.turnNo,
    }, REPORT)
    sleep(0.2)
  end
end

parallel.waitForAny(function()
  cabinet.run({ root = root, name = "VERSUS", games = require("games.list"), data = "/.test-records" })
end, player, reporter)
