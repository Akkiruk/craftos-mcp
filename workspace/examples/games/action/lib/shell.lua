-- lib/shell.lua
-- Part of the craftos-mcp examples (MIT).
-- The cabinet: one monitor wall, a menu of games, one player at a time, for the high score.
-- The shell owns the wall. It shows an idle screen (a game playing itself), the menu, each game's ready screen with its
-- high scores, HOW TO PLAY, the run itself with a header and QUIT, the final board, name entry and the scores. A game is a
-- plugin under games/ that brings only its rules and its board (see "Writing a game" in the README).
--
-- Screens ("views"): idle -> menu -> ready -> play -> final -> name (a new high score) -> over -> ready or menu.
-- Everything the shell knows is in M.S, so a test can watch a run as it plays.

local base = require("lib.base")
local display = require("lib.display")
local scores = require("lib.scores")
local sound = require("lib.sound")
local ui = require("lib.ui")

local M = {}
local C = ui.C
local floor = math.floor

local TICK = 0.05             -- seconds between the shell's own ticks; a game steps every plugin.tickMs
local MAX_CATCH_UP = 3        -- a late frame runs at most this many steps, so a stall can't kill the player
local QUIT_WINDOW_MS = 3000   -- how long QUIT waits for its second tap
local SPLIT_HINT_MS = 4000    -- how long a game steered by the whole wall shows how
local FINAL_HOLD_MS = 1500    -- taps this soon after the end were aimed at the game, not at the final board
local IDLE_MS = 120000        -- no taps on a menu for this long goes back to the idle screen
local DEMO_MS = 25000         -- each game plays itself on the idle screen for this long
local NAME_LETTERS = 3
local KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

local S = {}                  -- the shell's state: see M.S
local app = { audio = sound } -- what a game's view gets: app.audio.play(name)
local disp, games, opts

local function nowMs() return os.epoch("utc") end

local function dirty() S.dirty = true end

-- ---------------------------------------------------------------- moving between screens

local function selectGame(plugin)
  S.game = plugin
  S.L = plugin.view.layout(disp.W, disp.H)
  S.scores = scores.open(opts.data, plugin.id)
  disp.accent(plugin.accent)
end

local function show(view)
  if view == "menu" then disp.accent(nil) end -- the menu wears the cabinet's own yellow, not the last game's colour
  S.view = view
  S.lastTouch = nowMs()
  dirty()
end

--- A fresh random number source in the form the rules want: rng() is 0 to 1, rng(n) is 1 to n.
local function newRng()
  return function(n)
    if n then return math.random(n) end
    return math.random()
  end
end

local function startRun()
  local plugin = S.game
  local rng = newRng()
  S.run = {
    rng = rng, state = plugin.rules.new({ rng = rng }),
    startedAt = nowMs(), nextAt = nowMs() + plugin.tickMs, quitUntil = nil,
  }
  sound.play("start")
  show("play")
end

local function finish()
  local r = S.run
  r.overAt = nowMs()
  r.place = S.scores:placeFor(r.state.score)
  if r.place == 1 then
    sound.play("win")
    sound.later("fanfare", 450)
  else
    sound.play("lose")
  end
  show("final")
end

local function saveScore(name)
  local r = S.run
  r.name = name
  r.place = S.scores:add(name, r.state.score, r.state.level or 1)
  sound.play("rank")
  show("over")
end

-- ---------------------------------------------------------------- the idle screen

--- The game that plays itself next, going round the list.
local function nextDemo()
  S.demoIndex = (S.demoIndex or 0) % #games + 1
  local plugin = games[S.demoIndex]
  selectGame(plugin)
  S.demo = { since = nowMs() }
end

--- One step of the idle screen's game: its own bot plays. A finished game stays up for a few seconds, then starts again.
local function demoStep(t)
  local demo, plugin = S.demo, S.game
  if not demo.state or (demo.finishedAt and t - demo.finishedAt > 5000) then
    demo.rng = newRng()
    demo.state, demo.nextAt, demo.finishedAt = plugin.rules.new({ rng = demo.rng }), t + 800, nil
    return true
  end
  if demo.finishedAt or t < demo.nextAt then return false end
  demo.nextAt = t + plugin.tickMs
  local action = plugin.rules.bot and plugin.rules.bot(demo.state, demo.rng)
  if action then plugin.rules.input(demo.state, action) end
  plugin.rules.tick(demo.state, demo.rng)
  if demo.state.over then demo.finishedAt = t end
  return true
end

--- A game's board, for the idle screen: its own drawAttract, or the title over the board.
local function drawAttract(plugin, state)
  local W = disp.W
  if plugin.view.drawAttract then return plugin.view.drawAttract(W, disp.H, state) end
  local L = S.L
  ui.text(plugin.title, floor(W / 2), 1, C[plugin.color] or C.hi, "center", W - 2)
  if plugin.view.drawBoard then plugin.view.drawBoard(L, state) else plugin.view.draw(L, state) end
  return L.statusY
end

local function drawIdle()
  local W, H = disp.W, disp.H
  local y = S.demo.state and drawAttract(S.game, S.demo.state) or floor(H / 2)
  if floor(nowMs() / 700) % 2 == 0 then ui.text("TOUCH TO PLAY", floor(W / 2), math.min(y, H - 8), C.text, "center") end
  ui.region("play", 0, 0, W, H)
end

-- ---------------------------------------------------------------- the menu, ready and help screens

local function drawMenu()
  local W, H = disp.W, disp.H
  ui.text(opts.name, floor(W / 2), 2, C.hi, "center")
  ui.small("Pick a game", floor(W / 2), 10, C.line, C.bg, "center")
  ui.button("back", 2, 1, 16, 7, "BACK", C.panel, { small = true })
  local rows = math.ceil(#games / 2)
  local rowH = math.max(7, math.min(18, floor((H - 16) / math.max(rows, 4)) - 2))
  local tileW = floor((W - 10) / 2)
  for i, plugin in ipairs(games) do
    local x = 4 + ((i - 1) % 2) * (tileW + 2)
    local y = 13 + floor((i - 1) / 2) * (rowH + 2)
    local color = C[plugin.color] or C.hi
    ui.button("game", x, y, tileW, rowH, "", C.panel, { data = i, frame = color })
    local cx = x + floor(tileW / 2)
    if ui.textWidth(plugin.title) <= tileW - 6 and rowH >= ui.fontHeight() + 6 then
      ui.text(plugin.title, cx, y + floor((rowH - ui.fontHeight()) / 2) - 1, C.text, "center")
    else
      ui.small(plugin.title, cx, y + 2, C.text, C.panel, "center", tileW - 2)
    end
    ui.small(plugin.blurb or "", cx, y + rowH - 3, C.line, C.panel, "center", tileW - 2)
  end
end

--- The high score table, from row y down.
local function drawTable(y, highlight)
  local W = disp.W
  ui.small("HIGH SCORES", floor(W / 2), y, C.hi, C.bg, "center")
  if #S.scores.rows == 0 then ui.small("Nobody yet. Be the first!", floor(W / 2), y + 2, C.line, C.bg, "center") end
  for i, row in ipairs(S.scores.rows) do
    local color = i == highlight and C.hi or (i == 1 and C.text or C.line)
    local line = y + i * 2
    ui.small(i .. ".", 34, line, color, C.bg, "right")
    ui.small(row.name, 36, line, color, C.bg, "left", 30)
    ui.small(tostring(row.score), W - 34, line, color, C.bg, "right")
  end
end

local function drawReady()
  local W, H = disp.W, disp.H
  local plugin = S.game
  ui.text(plugin.title, floor(W / 2), 2, C[plugin.color] or C.hi, "center", W - 40)
  if plugin.blurb then ui.small(plugin.blurb, floor(W / 2), 12, C.line, C.bg, "center", W - 4) end
  drawTable(15)
  ui.button("start", floor(W / 2) - 25, H - 22, 50, 11, "START", C.ok)
  ui.button("back", 2, 1, 16, 7, "BACK", C.panel, { small = true })
  ui.button("rules", W - 18, 1, 16, 7, "HOW TO PLAY", C.panel, { small = true })
end

local function drawRules()
  local W, H = disp.W, disp.H
  local plugin = S.game
  ui.text(plugin.title, floor(W / 2), 1, C[plugin.color] or C.hi, "center", W - 4)
  local y = 12
  for _, line in ipairs(plugin.help) do
    if line == "" then
      y = y + 2
    else
      for _, part in ipairs(ui.wrap(line, W - 16)) do
        ui.small(part, 8, y, C.text, C.bg, "left")
        y = y + 2
      end
    end
  end
  ui.button("rulesDone", floor(W / 2) - 20, H - 10, 40, 8, "GOT IT", C.ok, { small = true })
end

-- ---------------------------------------------------------------- a run

local function drawHeader()
  local W = disp.W
  local s = S.run.state
  ui.small("BEST " .. math.max(S.scores:best(), s.score), 2, 1, C.line, C.bg, "left", 24)
  ui.text(s.score, floor(W / 2), 1, C.hi, "center")
  ui.small("LEVEL " .. (s.level or 1), W - 2, 1, C.line, C.bg, "right")
  if s.lives then
    ui.small((S.game.livesName or "LIVES") .. " " .. s.lives, W - 2, 3, s.lives <= 1 and C.warn or C.text, C.bg, "right")
  end
end

local function drawControls()
  local controls = S.game.view.controls(S.L, S.run.state)
  -- one size for the whole set, or some labels shout and the rest whisper
  local small = false
  for _, control in ipairs(controls) do small = small or ui.textWidth(control.label) > control.w - 2 end
  for i, control in ipairs(controls) do
    ui.button("control", control.x, control.y, control.w, control.h, control.label, C.panel, { data = i, small = small })
  end
end

local function drawPlay()
  local W, H = disp.W, disp.H
  local r = S.run
  drawHeader()
  S.game.view.draw(S.L, r.state)
  drawControls()
  if S.game.split and nowMs() - r.startedAt < SPLIT_HINT_MS then base.drawSplit(W, H) end
  local asking = r.quitUntil and nowMs() < r.quitUntil
  ui.button("quit", W - 14, H - 8, 12, 7, asking and "SURE?" or "QUIT", asking and C.warn or C.panel, { small = true })
end

local function endLine(s) return s.won and "YOU WON!" or "GAME OVER" end

--- The last moment of the run stays up until someone taps, so it can be looked over.
local function drawFinal()
  local W = disp.W
  local s = S.run.state
  drawHeader()
  S.game.view.draw(S.L, s)
  local y = floor(disp.H / 2) - 6
  ui.fill(4, y, W - 8, 13, C.panel)
  ui.frame(4, y, W - 8, 13, s.won and C.ok or C.warn, 1)
  ui.text(endLine(s), floor(W / 2), y + 2, s.won and C.ok or C.warn, "center")
  ui.small("TAP TO SEE THE SCORES", floor(W / 2), y + 10, C.text, C.panel, "center")
  ui.region("seen", 0, 0, W, disp.H)
end

--- A new high score: three letters, the way arcade tables always had them.
local function drawName()
  local W = disp.W
  local r = S.run
  ui.text(r.place == 1 and "NEW HIGH SCORE!" or ("NUMBER " .. r.place .. " ON THE TABLE"), floor(W / 2), 2, C.ok, "center")
  ui.text(r.state.score, floor(W / 2), 10, C.hi, "center")
  ui.small("ENTER YOUR NAME", floor(W / 2), 19, C.line, C.bg, "center")
  local slotW = 10
  local x0 = floor(W / 2) - floor(NAME_LETTERS * (slotW + 2) / 2)
  for i = 1, NAME_LETTERS do
    local x = x0 + (i - 1) * (slotW + 2)
    local letter = r.typed:sub(i, i)
    ui.fill(x, 29, slotW, 1, i == #r.typed + 1 and C.hi or C.line)
    if letter ~= "" then ui.text(letter, x + floor(slotW / 2), 22, C.text, "center") end
  end
  local cols, bw, bh = 7, 15, 9
  local left = floor((W - cols * (bw + 1)) / 2)
  local keys = {}
  for i = 1, #KEYS do keys[i] = KEYS:sub(i, i) end
  keys[#keys + 1] = "DEL"
  keys[#keys + 1] = "OK"
  for i, key in ipairs(keys) do
    local x = left + ((i - 1) % cols) * (bw + 1)
    local y = 33 + floor((i - 1) / cols) * (bh + 1)
    local color = key == "OK" and C.ok or (key == "DEL" and C.warn or C.panel)
    ui.button("key", x, y, bw, bh, key, color, { data = key })
  end
end

local function drawOver()
  local W, H = disp.W, disp.H
  local r = S.run
  local s = r.state
  ui.text(endLine(s), floor(W / 2), 2, s.won and C.ok or C.warn, "center")
  ui.text(s.score, floor(W / 2), 11, C.hi, "center")
  local line = r.place == 1 and "A NEW HIGH SCORE!" or (r.place and ("Number " .. r.place .. " on the table"))
    or ("Level " .. (s.level or 1))
  ui.small(line, floor(W / 2), 20, r.place and C.ok or C.line, C.bg, "center", W - 4)
  drawTable(23, r.place)
  ui.button("start", floor(W / 2) - 42, H - 14, 40, 11, "AGAIN", C.ok)
  ui.button("done", floor(W / 2) + 2, H - 14, 40, 11, "DONE", C.panel)
end

local DRAW = {
  idle = drawIdle, menu = drawMenu, ready = drawReady, rules = drawRules, play = drawPlay, final = drawFinal,
  name = drawName, over = drawOver,
}

local function render()
  S.dirty = false
  disp.begin()
  DRAW[S.view]()
  disp.show()
end

-- ---------------------------------------------------------------- taps and keys

local function typeLetter(key)
  local r = S.run
  if key == "OK" then
    saveScore(r.typed ~= "" and r.typed or "???")
  elseif key == "DEL" then
    r.typed = r.typed:sub(1, -2)
    sound.play("back")
  elseif #r.typed < NAME_LETTERS then
    r.typed = r.typed .. key
    sound.play("tap")
  end
  dirty()
end

local function input(action)
  if action and S.run and not S.run.state.over then
    S.game.rules.input(S.run.state, action)
    S.lastAction = action
    dirty()
  end
end

local function askToQuit()
  local r = S.run
  if r.quitUntil and nowMs() < r.quitUntil then
    r.state.over = true
    finish()
  else
    r.quitUntil = nowMs() + QUIT_WINDOW_MS
    sound.play("tap")
    dirty()
  end
end

local function press(b, px, py)
  local id = b and b.id
  if S.view == "idle" then
    show("menu")
    sound.play("select")
  elseif id == "back" then
    sound.play("back")
    if S.view == "ready" then show("menu") else nextDemo(); show("idle") end
  elseif id == "game" then
    selectGame(games[b.data])
    sound.play("select")
    show("ready")
  elseif id == "rules" then
    sound.play("tap")
    show("rules")
  elseif id == "rulesDone" then
    sound.play("tap")
    show("ready")
  elseif id == "start" then
    startRun()
  elseif id == "done" then
    sound.play("back")
    show("menu")
  elseif id == "quit" then
    askToQuit()
  elseif id == "control" then
    input(S.game.view.controls(S.L, S.run.state)[b.data].action)
  elseif id == "seen" then
    if nowMs() - S.run.overAt < FINAL_HOLD_MS then return end
    sound.play("tap")
    if S.run.place then
      S.run.typed = ""
      show("name")
    else
      show("over")
    end
  elseif id == "key" then
    typeLetter(b.data)
  elseif S.view == "play" then
    input(S.game.view.actionAt(S.L, S.run.state, px, py))
  end
end

--- A tap at surface cell (px, py), 0-based.
local function touch(px, py)
  S.lastTouch = nowMs()
  press(ui.hit(px, py), px, py)
end

local ARROWS = { [keys.up] = "up", [keys.down] = "down", [keys.left] = "left", [keys.right] = "right" }

--- Arrow keys steer a game that the whole wall steers, for playing at the computer itself.
local function key(code)
  if S.view == "play" and S.game.split and ARROWS[code] then
    input({ kind = "turn", dir = ARROWS[code] })
  elseif S.view == "name" then
    if code == keys.enter then typeLetter("OK") elseif code == keys.backspace then typeLetter("DEL") end
  end
end

local function char(c)
  c = c:upper()
  if S.view == "name" and KEYS:find(c, 1, true) then typeLetter(c) end
end

-- ---------------------------------------------------------------- the clock

local function tick()
  local t = nowMs()
  sound.pump()
  if S.view == "idle" then
    if t - S.demo.since > DEMO_MS and (not S.demo.state or S.demo.finishedAt) then nextDemo() end
    if demoStep(t) then dirty() end
    if floor(t / 700) ~= S.blink then S.blink = floor(t / 700); dirty() end
  elseif S.view == "play" then
    local r, plugin = S.run, S.game
    local steps = 0
    while t >= r.nextAt and steps < MAX_CATCH_UP and S.view == "play" do
      steps = steps + 1
      r.nextAt = r.nextAt + plugin.tickMs
      plugin.view.onEvents(app, r.state, plugin.rules.tick(r.state, r.rng) or {})
      if r.state.over then finish() end
    end
    if t >= r.nextAt then
      -- too far behind to catch up: the steps it would have taken are lost, and it carries on from now
      if S.view == "play" then
        S.droppedSteps = (S.droppedSteps or 0) + math.floor((t - r.nextAt) / plugin.tickMs) + 1
      end
      r.nextAt = t + plugin.tickMs
    end
    -- how smoothly it runs: steps taken, and frames that had to catch up on more than one
    S.steps = (S.steps or 0) + steps
    if steps > 1 then S.lateFrames = (S.lateFrames or 0) + 1 end
    if steps > 0 then dirty() end
    if r.quitUntil and t >= r.quitUntil then r.quitUntil = nil; dirty() end
  elseif S.view ~= "final" and t - S.lastTouch > IDLE_MS then
    if S.view == "name" then saveScore("???") end
    nextDemo()
    show("idle")
  end
end

-- ---------------------------------------------------------------- running it

--- What a test can watch: the screen, the game, the run in play, the buttons on the wall.
M.S = S

--- Run the cabinet until terminated. o.root is the program's folder; o.games the plugins, in menu order; o.name the
--- cabinet's title; o.monitor a monitor name (default the biggest); o.data where the high scores go.
function M.run(o)
  opts = o
  games = o.games
  opts.name = opts.name or "CLASSICS"
  opts.data = opts.data or fs.combine(o.root, "scores")
  local err
  disp, err = display.open(o.root, o.monitor)
  if not disp then error(err, 0) end
  sound.init(peripheral.find("speaker"))
  S.display = disp
  nextDemo()
  show("idle")
  render()
  local timer = os.startTimer(TICK)
  local lastTick = nowMs()
  local ok, failure = pcall(function()
    while true do
      local ev, a, b, c = os.pullEventRaw()
      local busyFrom = nowMs()
      if ev == "terminate" then
        error("Terminated", 0)
      elseif ev == "timer" and a == timer then
        timer = os.startTimer(TICK)
        lastTick = nowMs()
        tick()
      elseif ev == "monitor_touch" and a == disp.name then
        touch(b - 1, c - 1)
      elseif ev == "key" then
        key(a)
      elseif ev == "char" then
        char(a)
      elseif ev == "monitor_resize" and a == disp.name then
        disp.reset(S.game and S.game.accent)
        if S.game then S.L = S.game.view.layout(disp.W, disp.H) end
        dirty()
      elseif ev == "peripheral" or ev == "peripheral_detach" then
        sound.init(peripheral.find("speaker"))
      end
      -- a lost timer would stop the clock for good, so any event late enough runs the tick itself
      if nowMs() - lastTick > 250 then
        timer = os.startTimer(TICK)
        lastTick = nowMs()
        tick()
      end
      if S.dirty then render() end
      -- the shell's own share of a late frame: handling one event (a step and its drawing, a tap) that takes more
      -- than the room a step leaves past the shell's tick holds the next frame back by itself, however quiet the
      -- machine; a frame that is late with nothing slow before it was held back by the machine, not the game
      if S.view == "play" and S.game and nowMs() - busyFrom > S.game.tickMs - TICK * 1000 then
        S.slowFrames = (S.slowFrames or 0) + 1
      end
    end
  end)
  disp.close()
  if not ok then error(failure, 0) end
end

return M
