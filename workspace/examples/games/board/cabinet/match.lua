-- cabinet/match.lua
-- Part of the craftos-mcp examples (MIT).
-- A match from first move to result, for any game. Everything goes through the game's rules.step, so the rules stay
-- pure; what happened comes back as events for the game's view to turn into sound and animation.
--
-- A seat ("slot") is { name = "Player 1" } for a person, or { name = "CPU Hard", cpu = "hard" } for the computer.
-- On a cabinet with two walls a slot also has `wall`, the name of the monitor that seat plays on.

local audio = require("cabinet.audio")
local ui = require("cabinet.ui")

local M = {}

local AI_THINK_MS = 700  -- the least a computer move takes, so it does not feel instant
local GAME_IDLE_MS = 600000 -- ten minutes with no move ends a match with no result

local app, S

function M.bind(appTable)
  app, S = appTable, appTable.S
end

local function nowMs() return os.epoch("utc") end

--- A small seeded random number generator, the only source of chance a game's rules are given. The same seed gives
--- the same numbers, so a finished match can be replayed exactly from its seed and its actions.
function M.rng(seed)
  local state = seed % 2147483646 + 1
  return function(n)
    state = state * 16807 % 2147483647 -- small enough to stay exact in a double
    local value = state - 1
    if n then return value % n + 1 end
    return value / 2147483646
  end
end

function M.moverSlot(g)
  return g.state.turn == 1 and g.red or g.blue
end
local moverSlot = M.moverSlot

--- The seat a wall belongs to in a game with hidden pieces. A computer has no eyes, so its wall belongs to nobody
--- and shows nothing secret.
function M.wallSeat(g, wall)
  if g.red.wall == wall and not g.red.cpu then return 1 end
  if g.blue.wall == wall and not g.blue.cpu then return 2 end
  return nil
end

local function newRecord(red, blue, first, seed)
  local plugin = app.plugin
  local g = {
    red = red, blue = blue, first = first, seed = seed, actions = {}, extras = plugin.newExtras(),
    startedAt = nowMs(), moveStart = nowMs(), hint = nil, hintUntil = 0, paused = false, thinking = false,
    confirmResign = false,
  }
  g.rng = M.rng(seed)
  g.state = plugin.rules.new({ first = first })
  return g
end

local function armTurn(g)
  g.moveStart = nowMs()
  g.hint = nil
  g.aiAt = moverSlot(g).cpu and (nowMs() + (app.thinkMs or AI_THINK_MS)) or nil
end

--- Start a match. first is the seat to move first (1 is Red).
function M.start(red, blue, first)
  local g = newRecord(red, blue, first or 1, math.random(1, 2147483646))
  S.match, S.result, S.finalMatch = g, nil, nil
  S.view = "game"
  audio.cue("start")
  armTurn(g)
  S.dirty = true
  return g
end

local function sideOf(g, seat) return seat == 1 and g.red or g.blue end

--- The match is over: keep it for the final board, the results screen and a replay.
local function finish(g)
  local s = g.state
  S.finalMatch, S.match = g, nil
  S.view = "final"
  S.toast = nil
  S.lastTouch = nowMs()
  S.result = {
    red = g.red, blue = g.blue, winner = s.winner, forfeit = s.forfeit, state = s,
    seconds = (nowMs() - g.startedAt) / 1000,
  }
  S.lastGame = { red = g.red, blue = g.blue, first = g.first, seed = g.seed, actions = g.actions }
  -- against the computer the human's result picks the sound; two people (or two computers) get the winner's fanfare
  local human = (not g.red.cpu) and 1 or ((not g.blue.cpu) and 2 or nil)
  if s.winner == 3 then
    audio.cue("draw")
  elseif human and (g.red.cpu or g.blue.cpu) then
    audio.cue(s.winner == human and "win" or "lose")
  else
    audio.cue("win")
  end
  S.dirty = true
end

--- Apply an action through the rules: then the view's events, then whatever comes next.
-- @return boolean, reason
function M.apply(g, action)
  local stepped, events = app.plugin.rules.step(g.state, action, g.rng)
  if not stepped then return false, events end
  g.actions[#g.actions + 1] = action
  app.plugin.view.onEvents(app, g, events or {})
  if g.state.winner ~= 0 then
    finish(g)
  else
    armTurn(g)
  end
  S.dirty = true
  return true
end

--- Forfeit a seat: a real result, with the other seat the winner.
function M.forfeit(g, seat)
  return M.apply(g, { kind = "forfeit", seat = seat })
end

--- End the match with no result.
function M.abandon(g, text)
  if S.match == g then S.match = nil end
  S.view = "menu"
  app.setToast(text or "Game abandoned", ui.C.warn)
  S.dirty = true
end

--- What the seat to move may see. In a game with hidden pieces this is all a computer player is given, so it cannot
--- cheat: rules.viewFor builds it from the fields that seat may know.
function M.seen(state)
  local rules = app.plugin.rules
  if rules.viewFor then return rules.viewFor(state, state.turn) end
  return state
end

--- Let the rest of the computer run while the computer player thinks, keeping every other event for later. A touch
--- is dropped: kept, it would land on the board after the computer's move, as a move the player never saw.
local function aiYield()
  local saved = {}
  os.queueEvent("cabinet_yield")
  while true do
    local ev = table.pack(os.pullEventRaw())
    if ev[1] == "cabinet_yield" then break end
    if ev[1] == "terminate" then error("Terminated", 0) end
    if ev[1] ~= "monitor_touch" then saved[#saved + 1] = ev end
  end
  for _, ev in ipairs(saved) do os.queueEvent(table.unpack(ev, 1, ev.n)) end
end

local function randomAction(g)
  local list = app.plugin.rules.legalActions(g.state)
  return list[math.random(#list)]
end

local function doAiMove(g)
  local slot = moverSlot(g)
  local ok, action = pcall(app.plugin.chooseAction, M.seen(g.state), slot.cpu, { yield = aiYield })
  if not ok then
    if tostring(action):find("Terminated", 1, true) then error(action, 0) end
    action = nil -- a computer player that fails plays any legal move rather than stopping the game
  end
  if not action or not app.plugin.rules.checkAction(g.state, action) then action = randomAction(g) end
  M.apply(g, action)
end

--- The clock for the match in progress: the computer's moves, fading marks, and a match left alone too long.
function M.tick(g, t)
  if app.plugin.view.tick(g, t) then S.dirty = true end
  if g.confirmResign and t > (g.confirmUntil or 0) then g.confirmResign = false; S.dirty = true end
  if g.hint and t > g.hintUntil then g.hint = nil; S.dirty = true end
  if g.paused then return end
  if t - g.moveStart > GAME_IDLE_MS then
    M.abandon(g, "Nobody moved for ten minutes - game called off")
    return
  end
  if moverSlot(g).cpu and g.aiAt and t >= g.aiAt then
    g.aiAt = nil
    g.thinking = true
    app.render() -- show "thinking..." before the search starts
    doAiMove(g)
    g.thinking = false
    S.dirty = true
  end
end

-- ---------------------------------------------------------------- replays

--- The last finished match, set up to play back. It looks like a match to the views, with replay set.
function M.newReplay(game)
  local g = newRecord(game.red, game.blue, game.first, game.seed)
  g.script, g.replay, g.step = game.actions, true, 0
  return g
end

--- One action of a replay. Returns false once there are no more.
function M.replayStep(g)
  g.step = g.step + 1
  local action = g.script[g.step]
  if not action then return false end
  local stepped, events = app.plugin.rules.step(g.state, action, g.rng)
  if not stepped then return false end
  app.plugin.view.onEvents(app, g, events or {})
  return true
end

M.sideOf = sideOf

return M
