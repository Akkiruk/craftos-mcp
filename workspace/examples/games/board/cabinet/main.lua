-- cabinet/main.lua
-- Part of the craftos-mcp examples (MIT).
-- The cabinet: one computer, a list of games, and a monitor wall (built for 6x6 monitors at text scale 0.5, which is
-- 121x81 cells). It owns the wall: the idle screen, the game menu, the lobby, the match, the results and replays.
-- Each game is a plugin under games/ that brings its rules, its board and its computer player.
--
-- Peripherals: one or two monitors (the largest is the wall; a second of the same size is a second wall, back to back
-- with the first), and a speaker if there is one. On two walls every screen shows on both, except in a game with
-- hidden pieces (Fleet, Codebreaker), where each player's wall draws only their own side.

local audio = require("cabinet.audio")
local matches = require("cabinet.match")
local play = require("cabinet.play")
local screens = require("cabinet.screens")
local ui = require("cabinet.ui")

local C = ui.C
local floor = math.floor

local TICK = 0.1             -- seconds between clock ticks
local TOAST_MS = 4000
local IDLE_AFTER_MS = 120000 -- two minutes with no touch outside a match goes back to the idle screen
local IDLE_END_HOLD_MS = 4000 -- how long an idle game's last move stays up before the next game
local REPLAY_STEP_MS = 700

-- The wall's colours. The names are CC's colour slots; the values are what this cabinet shows in them.
local PALETTE = {
  black = 0x14161C,      -- background
  gray = 0x232733,       -- panels
  lightGray = 0x7C8496,  -- grid lines and dim text
  white = 0xF2F4F8,
  red = 0xE5484D,        -- the Red player
  blue = 0x3E82F7,       -- the Blue player
  brown = 0x4A2328,      -- Red's dark tint
  lightBlue = 0x1F3560,  -- Blue's dark tint
  yellow = 0xFFD257,     -- highlights, and each game's own accent
  magenta = 0x3B3722,    -- highlight background tint
  green = 0x35D07F,
  orange = 0xFF9F43,
  purple = 0x9B7BFF,
  cyan = 0x3CD3E6,
  pink = 0x4A4F60,       -- tied areas
  lime = 0x8BE0A8,
}

local function nowMs() return os.epoch("utc") end

-- ------------------------------------------------------------------ state

local S = {
  view = "idle", -- idle, menu, lobby, rules, game, final, result, replay
  dirty = true,
  lastTouch = nowMs(),
  toast = nil,   -- { text, color, untilAt }
  lobby = nil,
  match = nil,   -- the match being played
  finalMatch = nil, result = nil, lastGame = nil, replay = nil,
  idle = nil,    -- per wall: { plugin, demo, since }
}

local env = { W = 0, H = 0, walls = {} }
local app = { S = S, env = env, audio = audio, name = "ARCADE" }
local surfaceApi, font

function app.setToast(text, color, ms)
  S.toast = { text = text, color = color or C.text, untilAt = nowMs() + (ms or TOAST_MS) }
  S.dirty = true
end

local function refuse(text, ms)
  audio.play("error")
  app.setToast(text, C.warn, ms or 2500)
end

function app.pluginById(id)
  for _, plugin in ipairs(app.registry) do
    if plugin.id == id then return plugin end
  end
  return nil
end

--- Can this cabinet play this game? A game with hidden pieces needs a wall for each player.
function app.fits(plugin)
  local size = plugin.minSize
  if size and (env.W < size.w or env.H < size.h) then return false, "wall too small" end
  if plugin.walls == 2 and #env.walls < 2 then return false, "needs two walls" end
  return true
end

local function setAccent(hex)
  for _, wall in ipairs(env.walls) do wall.mon.setPaletteColor(colors.yellow, hex) end
end

--- Make a game the current one: its accent colour and its board layout.
function app.selectGame(plugin)
  app.plugin = plugin
  setAccent(plugin.accent)
  env.L = plugin.view.layout(env.W, env.H)
end

-- ------------------------------------------------------------------ display

local function prepareMonitor(mon)
  mon.setTextScale(0.5)
  for name, hex in pairs(PALETTE) do mon.setPaletteColor(colors[name], hex) end
  mon.setBackgroundColor(colors.black)
  mon.clear()
end

--- The walls: the largest monitor, and a second one of the same size if there is one.
local function findWalls()
  local found = {}
  for _, name in ipairs(peripheral.getNames()) do
    if peripheral.hasType(name, "monitor") then
      local mon = peripheral.wrap(name)
      mon.setTextScale(0.5)
      local w, h = mon.getSize()
      found[#found + 1] = { name = name, mon = mon, area = w * h, w = w, h = h }
    end
  end
  table.sort(found, function(a, b)
    if a.area ~= b.area then return a.area > b.area end
    return a.name < b.name
  end)
  local walls = { found[1] }
  if found[2] and found[2].w == found[1].w and found[2].h == found[1].h then walls[2] = found[2] end
  return found[1] and walls or {}
end

local function setupDisplay()
  local walls = findWalls()
  if #walls == 0 then error("The cabinet needs a monitor (6x6 advanced monitors are best)", 0) end
  env.walls = {}
  for i, wall in ipairs(walls) do
    prepareMonitor(wall.mon)
    env.W, env.H = wall.w, wall.h
    env.walls[i] = {
      name = wall.name, mon = wall.mon, out = ui.changedRows(wall.mon), surf = surfaceApi.create(env.W, env.H), buttons = {},
    }
  end
  ui.init(surfaceApi, font, env.walls[1].surf)
  if app.plugin then app.selectGame(app.plugin) end
  S.idle = nil
end

local function wallIndex(name)
  for i, wall in ipairs(env.walls) do
    if wall.name == name then return i end
  end
  return nil
end

local function otherWall(name)
  return env.walls[1].name == name and env.walls[2].name or env.walls[1].name
end

-- ------------------------------------------------------------------ idle screen

--- A computer's action for a game's demo, or any legal one. It sees only what the seat to move may see.
local function demoChooser(plugin)
  return function(state, level, opts)
    local rules = plugin.rules
    local seen = rules.viewFor and rules.viewFor(state, state.turn) or state
    local action = plugin.chooseAction(seen, level, opts)
    if action then return action end
    local list = rules.legalActions(state)
    return list[math.random(#list)]
  end
end

local attractIndex = 0

--- The next game this cabinet can play, going round the list.
local function nextIdleGame()
  for _ = 1, #app.registry do
    attractIndex = attractIndex % #app.registry + 1
    if app.fits(app.registry[attractIndex]) then return app.registry[attractIndex] end
  end
  return app.registry[1]
end

local function idleSlot(plugin)
  return { plugin = plugin, demo = {}, choose = demoChooser(plugin), since = nowMs() }
end

--- Each wall wears the accent of the game it is showing.
local function dressIdleWalls()
  app.selectGame(S.idle[1].plugin)
  for i, wall in ipairs(env.walls) do
    wall.mon.setPaletteColor(colors.yellow, (S.idle[i] or S.idle[1]).plugin.accent)
  end
end

--- Give every wall a game of its own to show.
local function pickIdleGames()
  S.idle = {}
  for i = 1, #env.walls do S.idle[i] = idleSlot(nextIdleGame()) end
  dressIdleWalls()
end

--- Each wall plays its game right through, then moves on to the next by itself.
local function idleStep(t)
  if not S.idle then pickIdleGames(); S.dirty = true end
  if not S.idleDressed then dressIdleWalls(); S.idleDressed = true end
  for i, slot in ipairs(S.idle) do
    if slot.plugin.view.demoStep(slot.demo, t, slot.choose) then S.dirty = true end
    if slot.demo.finishedAt and t - slot.demo.finishedAt > IDLE_END_HOLD_MS then
      S.idle[i] = idleSlot(nextIdleGame())
      dressIdleWalls()
      S.dirty = true
    end
  end
  if floor(t / 700) ~= S.blinkPhase then S.blinkPhase = floor(t / 700); S.dirty = true end
end

-- ------------------------------------------------------------------ drawing

--- Draw the current view onto every wall. Most views are one picture shown on both walls; a game with hidden pieces
--- is drawn once per wall, for the player that wall belongs to.
local function render()
  S.dirty = false
  local g = S.view == "game" and S.match
  if S.view == "idle" and not S.idle then pickIdleGames() end
  if S.view == "idle" or (g and app.plugin.private) then
    for i, wall in ipairs(env.walls) do
      ui.setScreen(wall.surf)
      if S.view == "idle" then
        screens.drawIdle(S.idle[i] or S.idle[1])
      else
        play.draw(g, false, matches.wallSeat(g, wall.name))
      end
      wall.buttons = ui.buttons()
      wall.surf:output(wall.out, 0, 0)
    end
    return
  end
  local surf = env.walls[1].surf
  ui.setScreen(surf)
  if S.view == "menu" then screens.drawMenu()
  elseif S.view == "lobby" then screens.drawLobby()
  elseif S.view == "rules" then screens.drawRules()
  elseif S.view == "game" then play.draw(S.match)
  elseif S.view == "final" then play.draw(S.finalMatch, true)
  elseif S.view == "result" then screens.drawResult()
  elseif S.view == "replay" then play.draw(S.replay)
  end
  for _, wall in ipairs(env.walls) do
    wall.buttons = ui.buttons()
    surf:output(wall.out, 0, 0)
  end
end
app.render = render

-- ------------------------------------------------------------------ the lobby

local function personSlot(taken, wall)
  local n = 1
  while taken == "Player " .. n do n = n + 1 end
  return { name = "Player " .. n, wall = wall }
end

local function cpuSlot(level)
  return { name = "CPU " .. level:sub(1, 1):upper() .. level:sub(2), cpu = level }
end

local function openLobby(wall)
  local plugin = app.plugin
  local red = personSlot(nil, wall)
  local blue
  if #plugin.cpuLevels > 0 then
    blue = cpuSlot(plugin.cpuLevels[math.min(2, #plugin.cpuLevels)])
  else
    blue = personSlot(red.name, #env.walls > 1 and otherWall(wall) or nil)
  end
  S.lobby = { red = red, blue = blue, first = "red" }
  S.view = "lobby"
end

--- Give each seat its wall: a person plays where they tapped PLAYER, and the other seat gets the other wall. Two
--- people at one wall in a game with hidden pieces would see each other's, so that is refused.
local function chooseWalls(l)
  if #env.walls < 2 then
    l.red.wall, l.blue.wall = nil, nil
    return true
  end
  local redPerson, bluePerson = not l.red.cpu, not l.blue.cpu
  if redPerson and bluePerson and l.red.wall == l.blue.wall and l.red.wall then
    if app.plugin.private then return false end
    l.blue.wall = nil
  end
  local redWall = (redPerson and l.red.wall) or (bluePerson and l.blue.wall and otherWall(l.blue.wall)) or env.walls[1].name
  l.red.wall, l.blue.wall = redWall, otherWall(redWall)
  return true
end

local function startFromLobby()
  local l = S.lobby
  if not chooseWalls(l) then
    refuse(l.blue.name .. ": go to the other wall and tap PLAYER there", 3500)
    return
  end
  local first = l.first == "blue" and 2 or (l.first == "random" and math.random(2) or 1)
  S.lobby = nil
  matches.start(l.red, l.blue, first)
end

-- ------------------------------------------------------------------ touches

local handlers = {}

handlers.play = function()
  audio.play("select")
  setAccent(PALETTE.yellow) -- the menu belongs to no game, so it wears the cabinet's own accent
  S.view = "menu"
end

handlers.back = function()
  audio.play("back")
  S.view, S.lobby = "idle", nil
end

handlers.game = function(b, wall)
  local plugin = app.pluginById(b.data)
  if not plugin then return end
  audio.play("select")
  app.selectGame(plugin)
  openLobby(wall)
end

--- A seat button: PLAYER, or one of the computer's levels.
local function setSeat(key, b, wall)
  local l = S.lobby
  local other = key == "red" and l.blue or l.red
  if b.data == "player" then
    l[key] = personSlot(not other.cpu and other.name or nil, wall)
  else
    l[key] = cpuSlot(b.data)
  end
  audio.play("select")
end
handlers.redSeat = function(b, wall) setSeat("red", b, wall) end
handlers.blueSeat = function(b, wall) setSeat("blue", b, wall) end

handlers.swap = function()
  local l = S.lobby
  l.red, l.blue = l.blue, l.red
  audio.play("tap")
end

handlers.first = function()
  local l = S.lobby
  l.first = ({ red = "blue", blue = "random", random = "red" })[l.first]
  audio.play("tap")
end

handlers.start = function() startFromLobby() end

handlers.rules = function()
  audio.play("page")
  S.view = "rules"
end

handlers.rulesDone = function()
  audio.play("select")
  S.view = "lobby"
end

handlers.menu = function()
  local g = S.match
  if not g then return end
  g.paused = true
  g.pausedAt = nowMs()
  audio.play("tap")
end

handlers.resume = function()
  local g = S.match
  if not g then return end
  g.paused = false
  -- the time spent paused does not count towards the ten minutes a move may take
  g.moveStart = g.moveStart + (nowMs() - (g.pausedAt or nowMs()))
  audio.play("select")
end

handlers.abandon = function()
  local g = S.match
  if g then
    audio.play("back")
    matches.abandon(g, "Game ended - no result")
  end
end

handlers.hint = function()
  local g = S.match
  if not g or g.paused or matches.moverSlot(g).cpu or app.plugin.noHints then return end
  local action = app.plugin.chooseAction(matches.seen(g.state), "hard", { ms = 600 })
  if action then
    g.hint, g.hintUntil = action, nowMs() + 4000
    audio.play("hint")
    app.setToast(app.plugin.view.hintText(action), C.ok, 3000)
  end
end

--- Resign takes two taps. On two walls it counts against the wall it was tapped on; on one wall against the seat to
--- move (or, with the computer to move, against the person playing it).
handlers.resign = function(_, wall)
  local g = S.match
  if not g or g.paused then return end
  local seat
  if app.plugin.private then
    seat = matches.wallSeat(g, wall)
    if not seat then return end -- the computer's wall speaks for nobody
  else
    seat = g.state.turn
    if matches.moverSlot(g).cpu then seat = 3 - seat end
  end
  if g.confirmResign ~= seat then
    g.confirmResign, g.confirmUntil = seat, nowMs() + 4000
    audio.play("tap")
    return
  end
  audio.cue("resign")
  matches.forfeit(g, seat)
end

handlers.sound = function()
  audio.setEnabled(not audio.isEnabled())
  audio.play("select")
end

handlers.skipFinal = function()
  audio.play("tap")
  S.view = "result"
end

handlers.rematch = function()
  local r = S.result
  -- colours swap, and whoever lost moves first (Red losing means they are now Blue)
  audio.play("select")
  matches.start(r.blue, r.red, r.winner == 2 and 2 or 1)
end

handlers.newgame = function()
  audio.play("back")
  S.result = nil
  handlers.play()
end

handlers.replay = function()
  if not S.lastGame then return end
  audio.play("select")
  S.replay, S.replayAt, S.view = matches.newReplay(S.lastGame), nowMs() + 800, "replay"
end

handlers.stopReplay = function()
  audio.play("back")
  S.replay, S.view = nil, S.result and "result" or "idle"
end

handlers.done = function()
  audio.play("back")
  S.result, S.view = nil, "idle"
end

--- A touch on the board of the match in progress.
local function boardTouch(px, py, wall)
  local g = S.match
  if not g or g.paused or g.state.winner ~= 0 then return end
  local plugin = app.plugin
  local mover = matches.moverSlot(g)
  local viewer = plugin.private and matches.wallSeat(g, wall) or nil
  -- with hidden pieces a move only comes from the wall of the player whose turn it is
  if plugin.private and viewer ~= g.state.turn then
    if not mover.cpu then refuse("It is " .. mover.name .. "'s turn, on the other wall", 1500) end
    return
  end
  if mover.cpu then
    refuse("The computer is thinking...", 1200)
    return
  end
  local action = plugin.view.actionAt(env.L, g, px, py, viewer)
  if not action then return end
  -- picking up a piece (or a peg) is the player's business: it never reaches the rules
  if action.kind == "select" then
    plugin.view.onSelect(g, action)
    audio.play("tap")
    S.dirty = true
    return
  end
  local ok, why = plugin.rules.checkAction(g.state, action)
  if not ok then
    refuse(plugin.view.refusal(g.state, why), 2000)
    return
  end
  g.confirmResign = false
  matches.apply(g, action)
end

local function onTouch(side, x, y)
  local index = wallIndex(side)
  if not index then return end
  S.lastTouch = nowMs()
  S.dirty = true
  local px, py = x - 1, y - 1 -- monitor_touch is 1-based; the surface is 0-based
  if S.view == "idle" then
    handlers.play()
    return
  end
  ui.setButtons(env.walls[index].buttons)
  local b = ui.hit(px, py)
  if b and handlers[b.id] then
    if b.id ~= "resign" and S.match then S.match.confirmResign = false end
    handlers[b.id](b, side)
    return
  end
  if S.view == "game" then boardTouch(px, py, side) end
end

-- ------------------------------------------------------------------ the clock

local function onTick()
  local t = nowMs()
  audio.pump()
  if S.view ~= "idle" then S.idleDressed = false end
  if S.toast and t > S.toast.untilAt then S.toast = nil; S.dirty = true end
  -- an animation redraws itself until it ends
  local showing = S.replay or S.match or (S.view == "final" and S.finalMatch)
  if showing and showing.anim then
    if t >= showing.anim.at + showing.anim.ms then showing.anim = nil end
    S.dirty = true
  end
  if S.view == "idle" then
    idleStep(t)
  elseif S.view == "game" and S.match then
    matches.tick(S.match, t)
  elseif S.view == "replay" then
    S.lastTouch = t
    if t >= S.replayAt then
      S.replayAt = t + REPLAY_STEP_MS
      if not matches.replayStep(S.replay) then S.replay, S.view = nil, "result" end
      S.dirty = true
    end
  elseif t - S.lastTouch > IDLE_AFTER_MS then
    S.view, S.lobby = "idle", nil
    S.dirty = true
  end
end

-- ------------------------------------------------------------------ startup

local M = { app = app }

--- Run the cabinet until it is terminated.
-- opts.registry: the games, in menu order. opts.dir: the folder holding cabinet/ (for the font file).
-- opts.name: what the menu is called. opts.thinkMs: the least time a computer move takes (tests set it lower).
function M.run(opts)
  app.registry = opts.registry
  app.name = opts.name or app.name
  app.thinkMs = opts.thinkMs
  matches.bind(app)
  play.bind(app)
  screens.bind(app)
  surfaceApi = require("cabinet.surface")
  font = surfaceApi.loadFont(surfaceApi.load(fs.combine(opts.dir or "", "cabinet/font")))
  setupDisplay()
  app.selectGame(app.registry[1])
  audio.init()
  audio.play("boot")

  local tick = os.startTimer(TICK)
  local lastTickAt = nowMs()
  render()
  while true do
    local ev, a, b, c = os.pullEventRaw()
    if ev == "terminate" then
      for _, wall in ipairs(env.walls) do
        wall.mon.setBackgroundColor(colors.black)
        wall.mon.clear()
      end
      return
    elseif ev == "timer" and a == tick then
      tick = os.startTimer(TICK)
    elseif ev == "monitor_touch" then
      onTouch(a, b, c)
    elseif ev == "monitor_resize" or ev == "peripheral" or ev == "peripheral_detach" then
      if ev ~= "peripheral" or peripheral.hasType(a, "monitor") then setupDisplay() end
      if ev ~= "monitor_resize" then audio.init() end
      S.dirty = true
    end
    -- the clock also runs on any other event, so a burst of touches can't hold it up
    if nowMs() - lastTickAt >= TICK * 1000 then
      lastTickAt = nowMs()
      onTick()
    end
    if S.dirty then render() end
  end
end

return M
