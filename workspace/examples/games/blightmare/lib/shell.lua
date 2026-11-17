-- lib/shell.lua
-- Part of the craftos-mcp examples (MIT).
-- The cabinet around one long story game: one monitor wall, one player at a time, the game saved as it goes.
-- The shell owns the wall. Its screens ("views"):
--   idle     the game's opening plays by itself on a loop, silent, under TOUCH TO PLAY
--   intro    a touch carries the opening on from the same moment, heard, with a SKIP; a tap turns the page
--   ready    the title, CONTINUE and NEW GAME for a saved game (or START), HOW TO PLAY, PLAYERS
--   rules    HOW TO PLAY
--   players  everyone's saved game on this computer and how far each has got
--   play     the game itself, with SAVE & QUIT; it saves every 30 seconds, and on the way out
--   final    a game that has ended (the rules set state.over), until a tap
-- Who is playing comes from a player detector if there is one (lib/detector.lua), and is "Player" otherwise: the game
-- then asks the hero's name itself. Everything the shell knows is in M.S, so a test can watch a run as it plays.

local detector = require("lib.detector")
local display = require("lib.display")
local rngLib = require("lib.rng")
local saves = require("lib.saves")
local sound = require("lib.sound")
local ui = require("lib.ui")

local M = {}
local C = ui.C
local floor, max, min = math.floor, math.max, math.min

local TICK = 0.05              -- seconds between the shell's own ticks; the game steps every plugin.tickMs
local MAX_CATCH_UP = 3         -- a late frame runs at most this many steps
local QUIT_WINDOW_MS = 3000    -- how long a two-tap button waits for its second tap
local MENU_IDLE_MS = 120000    -- no taps outside the game for this long goes back to the idle screen
local GAME_IDLE_MS = 600000    -- no taps in the game for this long saves it and frees the wall
local AWAY_MS = 20000          -- a named player the detector has lost for this long has walked away: saved, wall freed
local TOAST_MS = 2500
local ANYONE = "Player"        -- who is playing when nobody can be told apart; the game asks for a name

local S = {}                   -- the shell's state: see M.S
local app = { audio = sound, S = S }
local disp, plugin, opts

local function nowMs() return os.epoch("utc") end
local function dirty() S.dirty = true end

local function log(text)
  local h = fs.open(opts.log, "a")
  if h then
    h.writeLine(os.date("%Y-%m-%d %H:%M:%S") .. " " .. tostring(text))
    h.close()
  end
end
app.log = log

local function setToast(text, color, ms)
  S.toast = { text = text, color = color or C.text, untilAt = nowMs() + (ms or TOAST_MS) }
  dirty()
end
app.setToast = setToast

local function drawToast()
  local t = S.toast
  if not t then return end
  if nowMs() > t.untilAt then S.toast = nil; return end
  local w = min(disp.W - 4, #t.text + 6)
  local x = floor((disp.W - w) / 2)
  local y = disp.H - 9
  ui.fill(x, y, w, 7, C.panel)
  ui.frame(x, y, w, 7, t.color, 1)
  ui.small(t.text, floor(disp.W / 2), y + 3, t.color, C.panel, "center", w - 2)
end

local function show(view)
  S.view = view
  S.lastTouch = nowMs()
  dirty()
end

--- Who is at the wall: the player closest to the detector, or "Player" with no detector or nobody in range.
local function whoIsHere()
  return detector.closest() or ANYONE
end

-- ---------------------------------------------------------------- the idle screen and the opening

local function toIdle()
  S.run, S.demo = nil, {}
  sound.music(nil)
  show("idle")
end

local function drawIdle()
  local W, H = disp.W, disp.H
  local y = plugin.view.drawAttract(W, H, S.demo) or floor(H / 2)
  if floor(nowMs() / 700) % 2 == 0 then ui.text("TOUCH TO PLAY", floor(W / 2), min(y, H - 8), C.text, "center") end
  ui.region("play", 0, 0, W, H)
end

--- This player's save, if the game can show it: a sound file may still not suit the game as it is now.
local function readSave(owner)
  local save = saves.read(owner)
  if not save then return nil end
  local ok, summary = pcall(function()
    plugin.view.draw(S.L, save.state)
    return plugin.view.saveSummary and plugin.view.saveSummary(save.state)
  end)
  if not ok then
    log("the save for " .. tostring(owner) .. " can't be shown: " .. tostring(summary))
    return nil
  end
  local who = owner == ANYONE and "Your game" or owner
  save.line = who .. ": " .. (summary and tostring(summary):gsub("%c", " ") or "saved")
  return save
end

local function offerSave()
  local r = S.ready
  r.owner = whoIsHere()
  r.saved, r.newUntil = readSave(r.owner), nil
  dirty()
end

local function toReady()
  S.ready = {}
  offerSave()
  show("ready")
end

--- A touch on the idle screen: the opening carries on, heard, from the same moment (or straight to the ready screen).
local function openFront()
  local hook = plugin.view.intro
  local run = hook and S.demo and hook.from(S.demo, nowMs(), app) or nil
  if run then
    S.intro = run
    show("intro")
  else
    sound.play("select")
    toReady()
  end
end

local function introDone()
  plugin.view.intro.stop(app)
  S.intro = nil
  toReady()
end

local function drawIntro()
  plugin.view.intro.draw(disp.W, disp.H, S.intro)
  ui.button("skip", disp.W - 18, 1, 16, 7, "SKIP", C.panel, { small = true })
end

-- ---------------------------------------------------------------- the ready, rules and players screens

local function drawReady()
  local W, H = disp.W, disp.H
  local r = S.ready
  ui.text(plugin.title, floor(W / 2), 2, C[plugin.color] or C.hi, "center", W - 40)
  if plugin.blurb then ui.small(plugin.blurb, floor(W / 2), 12, C.line, C.bg, "center", W - 4) end
  local y = H - 22
  if r.saved then
    local asking = r.newUntil and nowMs() < r.newUntil
    local line = asking and "Tap again to lose your saved game" or r.saved.line
    ui.small(line, floor(W / 2), y - 3, asking and C.warn or C.text, C.bg, "center", W - 4)
    ui.button("continue", floor(W / 2) - 44, y, 50, 11, "CONTINUE", C.ok)
    ui.button("new", floor(W / 2) + 8, y, 36, 11, asking and "SURE?" or "NEW GAME", asking and C.warn or C.panel)
  else
    local who = r.owner ~= ANYONE and (" for " .. r.owner) or ""
    ui.small("No saved game" .. who .. " on this computer", floor(W / 2), y - 3, C.line, C.bg, "center", W - 4)
    ui.button("start", floor(W / 2) - 25, y, 50, 11, "START", C.ok)
  end
  ui.button("back", 2, 1, 16, 7, "BACK", C.panel, { small = true })
  ui.button("rules", W - 18, 1, 16, 7, "HOW TO PLAY", C.panel, { small = true })
  if plugin.view.progress then ui.button("players", W - 18, H - 9, 16, 7, "PLAYERS", C.panel, { small = true }) end
  drawToast()
end

--- HOW TO PLAY: the plugin's help, a blank line between paragraphs, closer together if the wall is short of room.
local function drawRules()
  local W, H = disp.W, disp.H
  ui.text(plugin.title, floor(W / 2), 1, C[plugin.color] or C.hi, "center", W - 4)
  local paragraphs, lines = {}, 0
  for _, line in ipairs(plugin.help) do
    local wrapped = line == "" and {} or ui.wrap(line, W - 16)
    paragraphs[#paragraphs + 1] = wrapped
    lines = lines + #wrapped
  end
  local top, room = 12, H - 12 - 12
  local gap = (lines * 2 + (#paragraphs - lines) * 2 <= room) and 2 or 1
  local y = top
  for _, wrapped in ipairs(paragraphs) do
    if #wrapped == 0 then y = y + (gap == 2 and 2 or 1) end
    for _, part in ipairs(wrapped) do
      ui.small(part, 8, y, C.text, C.bg, "left")
      y = y + gap
    end
  end
  ui.button("rulesDone", floor(W / 2) - 20, H - 10, 40, 8, "GOT IT", C.ok, { small = true })
end

--- "3 days ago", from a save's time.
local function ago(at)
  if not at then return "" end
  local mins = floor((os.epoch("utc") - at) / 60000)
  if mins < 2 then return "just now" end
  if mins < 60 then return mins .. " min ago" end
  local hours = floor(mins / 60)
  if hours < 24 then return hours .. (hours == 1 and " hour ago" or " hours ago") end
  local days = floor(hours / 24)
  return days .. (days == 1 and " day ago" or " days ago")
end

local function playedFor(minutes)
  if minutes < 60 then return minutes .. " min" end
  return floor(minutes / 60) .. "h " .. (minutes % 60) .. "m"
end

local PLAYER_ROW_H = 6

local function drawPlayers()
  local W, H = disp.W, disp.H
  ui.text("PLAYERS", floor(W / 2), 2, C[plugin.color] or C.hi, "center")
  ui.small("Everyone's saved game on this computer", floor(W / 2), 10, C.line, C.bg, "center", W - 4)
  ui.button("playersBack", 2, 1, 16, 7, "BACK", C.panel, { small = true })
  local rows = S.players or {}
  if #rows == 0 then
    ui.small("Nobody has a saved game here yet.", floor(W / 2), 20, C.text, C.bg, "center", W - 4)
    return
  end
  local fits = floor((H - 16) / PLAYER_ROW_H)
  for i, p in ipairs(rows) do
    if i > fits then
      ui.small("and " .. (#rows - fits) .. " more", floor(W / 2), H - 3, C.line, C.bg, "center")
      break
    end
    local y = 14 + (i - 1) * PLAYER_ROW_H
    ui.fill(2, y, W - 4, PLAYER_ROW_H - 1, C.panel)
    local name = p.player == ANYONE and (p.hero or ANYONE)
      or (p.player .. ((p.hero and p.hero ~= p.player) and (" (" .. p.hero .. ")") or ""))
    ui.small(name, 4, y + 1, C.text, C.panel, "left", 46)
    ui.small("LV " .. p.level, 52, y + 1, C.hi, C.panel, "left")
    ui.small(p.percent .. "%", 62, y + 1, p.ended and C.ok or C.hi, C.panel, "left")
    ui.small(playedFor(p.minutes or 0) .. " played", 70, y + 1, C.line, C.panel, "left")
    ui.small(ago(p.at), W - 4, y + 1, C.line, C.panel, "right")
    -- the share of the story as a bar, and where they are
    local barW = W - 8
    ui.fill(4, y + 3, barW, 1, C.bg)
    ui.fill(4, y + 3, floor(barW * p.percent / 100), 1, p.ended and C.ok or C.hi)
    local where = p.goal and (p.goal .. (p.place and (" - " .. p.place) or "")) or (p.place or "")
    ui.small(where, 4, y + 4, C.line, C.panel, "left", W - 8)
  end
end

local function showPlayers()
  local rows = {}
  for _, save in ipairs(saves.list()) do
    local ok, p = pcall(plugin.view.progress, save.state)
    if ok and p then
      p.player, p.at = save.player, save.at
      rows[#rows + 1] = p
    end
  end
  table.sort(rows, function(x, y)
    if x.percent ~= y.percent then return x.percent > y.percent end
    return (x.at or 0) > (y.at or 0)
  end)
  S.players = rows
  show("players")
end

-- ---------------------------------------------------------------- a run

--- Keep the run's place on disk. Returns false if it couldn't, which never stops the run.
local function saveRun()
  local r = S.run
  if not r or r.midRules or r.state.over then return false end
  local ok, why = saves.write(r.player, r.state, r.rngAt())
  if not ok then
    log("could not save the game for " .. tostring(r.player) .. ": " .. tostring(why))
    setToast("Could not save your game: is the disk full?", C.warn, 4000)
  end
  return ok
end

local function begin(r)
  local t = nowMs()
  r.nextAt = t + plugin.tickMs
  r.startedAt, r.touchedAt, r.saveAt = t, t, t + saves.AUTOSAVE_MS
  S.run = r
  sound.cue("start")
  show("play")
end

local function startNew()
  local player = whoIsHere()
  saves.delete(player)
  local seed = math.random(1, 2147483646)
  local rng, rngAt = rngLib.tracked(seed)
  local r = { player = player, rng = rng, rngAt = rngAt }
  r.state = plugin.rules.new({ rng = rng, player = player })
  begin(r)
  saveRun()
end

local function continueSaved()
  local save = S.ready.saved
  local rng, rngAt = rngLib.tracked(save.rng - 1)
  begin({ player = save.player, state = save.state, rng = rng, rngAt = rngAt })
end

--- The run stops without ending: saved, and the wall goes back to the opening.
local function pause(why)
  saveRun()
  sound.play("back")
  if why then log(why) end
  toIdle()
end

local function finish()
  local r = S.run
  saves.delete(r.player)
  r.overAt = nowMs()
  sound.cue(r.state.won and "win" or "lose")
  show("final")
end

--- A tap for the game: the rules take it now, so a still clock still shows what it did.
local function input(action)
  local r = S.run
  if not action or r.state.over then return end
  r.midRules = true
  plugin.rules.input(r.state, action)
  r.midRules = nil
  r.lastAction = action
  if r.state.over then finish() end
  dirty()
end

--- SAVE & QUIT takes two taps, so a stray one can't end a sitting. A failed save says so, and a third tap goes anyway.
local function askToQuit()
  local r = S.run
  if r.quitUntil and nowMs() < r.quitUntil then
    if saveRun() or r.leaveUnsaved then
      sound.play("back")
      toIdle()
    else
      r.leaveUnsaved, r.quitUntil = true, nil
      setToast("Not saved! SAVE & QUIT again to leave anyway", C.warn, 4000)
    end
  else
    r.quitUntil = nowMs() + QUIT_WINDOW_MS
    sound.play("tap")
    dirty()
  end
end

local function drawPlay()
  local W, H = disp.W, disp.H
  local r = S.run
  plugin.view.draw(S.L, r.state)
  local asking = r.quitUntil and nowMs() < r.quitUntil
  ui.button("quit", W - 14, H - 8, 12, 7, asking and "SURE?" or "SAVE & QUIT", asking and C.warn or C.panel, { small = true })
  drawToast()
end

local function drawFinal()
  local W, H = disp.W, disp.H
  local s = S.run.state
  plugin.view.draw(S.L, s)
  local y = floor(H / 2) - 6
  ui.fill(4, y, W - 8, 13, C.panel)
  ui.frame(4, y, W - 8, 13, s.won and C.ok or C.warn, 1)
  ui.text(s.won and "THE END" or "GAME OVER", floor(W / 2), y + 2, s.won and C.ok or C.warn, "center")
  ui.small("TAP TO GO ON", floor(W / 2), y + 10, C.text, C.panel, "center")
  ui.region("seen", 0, 0, W, H)
end

local DRAW = {
  idle = drawIdle, intro = drawIntro, ready = drawReady, rules = drawRules, players = drawPlayers, play = drawPlay,
  final = drawFinal,
}

local function render()
  S.dirty = false
  disp.begin()
  DRAW[S.view]()
  disp.show()
end

-- ---------------------------------------------------------------- taps

local function press(b, px, py)
  local id = b and b.id
  local view = S.view
  if view == "idle" then
    openFront()
  elseif view == "intro" then
    if id == "skip" then
      sound.play("tap")
      introDone()
    elseif plugin.view.intro.tap(S.intro, nowMs(), app) then
      introDone() -- the last page turned
    end
    dirty()
  elseif id == "back" then
    sound.play("back")
    toIdle()
  elseif id == "rules" then
    sound.play("tap")
    show("rules")
  elseif id == "rulesDone" then
    sound.play("tap")
    show("ready")
  elseif id == "players" then
    sound.play("select")
    showPlayers()
  elseif id == "playersBack" then
    sound.play("back")
    show("ready")
  elseif id == "start" then
    startNew()
  elseif id == "continue" then
    -- a different player at the wall now: the screen turns to them first
    if S.ready.owner ~= whoIsHere() then offerSave() return end
    continueSaved()
  elseif id == "new" then
    if S.ready.owner ~= whoIsHere() then offerSave() return end
    local r = S.ready
    if r.newUntil and nowMs() < r.newUntil then
      startNew()
    else
      r.newUntil = nowMs() + QUIT_WINDOW_MS
      sound.play("tap")
      dirty()
    end
  elseif id == "quit" then
    askToQuit()
  elseif id == "seen" then
    if nowMs() - S.run.overAt < 1500 then return end
    sound.play("tap")
    toIdle()
  elseif view == "play" then
    S.run.touchedAt = nowMs()
    input(plugin.view.actionAt(S.L, S.run.state, px, py))
  elseif view == "ready" then
    if S.ready.owner ~= whoIsHere() then offerSave() end
  end
end

--- A tap at surface cell (px, py), 0-based.
local function touch(px, py)
  S.lastTouch = nowMs()
  press(ui.hit(px, py), px, py)
end

-- ---------------------------------------------------------------- the clock

local function tickPlay(t)
  local r = S.run
  local steps = 0
  r.midRules = true
  while t >= r.nextAt and steps < MAX_CATCH_UP and S.view == "play" do
    steps = steps + 1
    r.nextAt = r.nextAt + plugin.tickMs
    local events = plugin.rules.tick(r.state, r.rng)
    plugin.view.onEvents(app, r.state, events or {})
    if r.state.over then
      r.midRules = nil
      finish()
      return
    end
  end
  r.midRules = nil
  if t >= r.nextAt then r.nextAt = t + plugin.tickMs end -- too far behind to catch up: carry on from now
  S.steps = (S.steps or 0) + steps
  if steps > 1 then S.lateFrames = (S.lateFrames or 0) + 1 end
  if steps > 0 then dirty() end
  if r.quitUntil and t >= r.quitUntil then r.quitUntil = nil; dirty() end
  if t >= r.saveAt then
    r.saveAt = t + saves.AUTOSAVE_MS
    saveRun()
  end
  if t - r.touchedAt > GAME_IDLE_MS then
    pause("nobody played for ten minutes: saved")
    return
  end
  -- a named player who has walked away from the wall gets their game saved, and the wall is free for the next
  if r.player ~= ANYONE and detector.present() then
    if detector.isNear(r.player) then
      r.awaySince = nil
    else
      r.awaySince = r.awaySince or t
      if t - r.awaySince > AWAY_MS then pause(r.player .. " walked away: saved") end
    end
  end
end

local function tick()
  local t = nowMs()
  sound.pump()
  if S.toast and t > S.toast.untilAt then S.toast = nil; dirty() end
  local view = S.view
  if view == "idle" then
    if plugin.view.demoStep(S.demo, t) then dirty() end
    if floor(t / 700) ~= S.blink then S.blink = floor(t / 700); dirty() end
  elseif view == "intro" then
    local changed, done = plugin.view.intro.step(S.intro, t, app)
    if done then introDone() elseif changed then dirty() end
  elseif view == "play" then
    tickPlay(t)
  elseif view ~= "final" then
    if S.ready and S.ready.newUntil and t >= S.ready.newUntil then S.ready.newUntil = nil; dirty() end
    if t - S.lastTouch > MENU_IDLE_MS then toIdle() end
  end
end

-- ---------------------------------------------------------------- starting up

--- A wall too small for the game says so, on itself and on the computer, until it's built bigger.
local function tooSmall()
  local need = plugin.minSize
  return need and (disp.W < need.w or disp.H < need.h)
end

local function drawTooSmall()
  local need = plugin.minSize
  disp.begin()
  ui.small(plugin.title, floor(disp.W / 2), 1, C.hi, C.bg, "center")
  local lines = ui.wrap("This monitor is " .. disp.W .. " x " .. disp.H .. " at text scale 0.5. The game needs "
    .. need.w .. " x " .. need.h .. ": a wall of 6 x 6 advanced monitors.", max(10, disp.W - 2))
  for i, line in ipairs(lines) do ui.small(line, floor(disp.W / 2), 2 + i, C.text, C.bg, "center") end
  disp.show()
end

--- Load every part of the game before the first touch, with a bar, so nothing stalls a tap later on.
local function preload(list)
  local W, H = disp.W, disp.H
  for i, name in ipairs(list) do
    disp.begin()
    ui.text(plugin.title, floor(W / 2), floor(H / 2) - 10, C.hi, "center", W - 4)
    ui.small("Loading", floor(W / 2), floor(H / 2), C.line, C.bg, "center")
    local barW = W - 30
    ui.fill(15, floor(H / 2) + 3, barW, 1, C.panel)
    ui.fill(15, floor(H / 2) + 3, floor(barW * i / #list), 1, C.hi)
    disp.show()
    require(name)
    os.queueEvent("blightmare_loading")
    os.pullEvent("blightmare_loading")
  end
end

--- What a test can watch: the screen, the run in play, the ready screen's save.
M.S = S

--- Run the cabinet until terminated. o.root is the program's folder; o.plugin the game; o.monitor a monitor name
--- (default the biggest); o.data where the saves go (default saves/ beside the program); o.preload modules to load first.
function M.run(o)
  opts = o
  plugin = o.plugin
  opts.data = opts.data or fs.combine(o.root, "saves")
  opts.log = opts.log or fs.combine(o.root, "blightmare.log")
  saves.init(opts.data)
  local err
  disp, err = display.open(o.root, o.monitor)
  if not disp then error(err, 0) end
  disp.accent(plugin.accent)
  sound.init(peripheral.find("speaker"))
  detector.init()
  S.display = disp
  S.L = plugin.view.layout(disp.W, disp.H)
  print(plugin.title .. " is on the monitor " .. disp.name .. " (" .. disp.W .. " x " .. disp.H .. ").")
  print(detector.present() and "Player detector found: the hero takes the name of whoever is at the wall."
    or "No player detector: the game asks the hero's name.")
  print("Hold Ctrl+T to stop.")
  if o.preload then preload(o.preload) end
  toIdle()
  local function loop()
    local timer = os.startTimer(TICK)
    local lastTick = nowMs()
    while true do
      local ev, a, b, c = os.pullEventRaw()
      if ev == "terminate" then
        if S.view == "play" then saveRun() end
        error("Terminated", 0)
      elseif ev == "timer" and a == timer then
        timer = os.startTimer(TICK)
        lastTick = nowMs()
        if not tooSmall() then tick() end
      elseif ev == "monitor_touch" and a == disp.name then
        if not tooSmall() then touch(b - 1, c - 1) end
      elseif ev == "monitor_resize" and a == disp.name then
        disp.reset(plugin.accent)
        disp.accent(plugin.accent)
        S.L = plugin.view.layout(disp.W, disp.H)
        dirty()
      elseif ev == "peripheral" or ev == "peripheral_detach" then
        sound.init(peripheral.find("speaker"))
        detector.init()
      end
      -- a lost timer would stop the clock for good, so any event late enough runs the tick itself
      if nowMs() - lastTick > 250 then
        timer = os.startTimer(TICK)
        lastTick = nowMs()
        if not tooSmall() then tick() end
      end
      if tooSmall() then
        if S.dirty then drawTooSmall(); S.dirty = false end
      elseif S.dirty then
        render()
      end
    end
  end
  local ok, failure = pcall(parallel.waitForAny, loop, detector.worker)
  sound.music(nil)
  disp.close()
  if not ok then error(failure, 0) end
end

return M
