-- lib/shell.lua
-- Part of the craftos-mcp examples (MIT).
-- The versus cabinet: two players in real time, each at their own computer and monitor, linked by wireless modems.
-- A cabinet with no other cabinet in range plays the computer.
--
-- Screens ("views"): idle -> menu -> ready -> count (3-2-1) -> play -> final -> over (wins and REMATCH).
-- A cabinet that is asked for a game shows "invited" over whatever it was doing, until someone taps it.
--
-- Two computers, one match. The cabinet that asks is the host and player 1; the one that joins is player 2. Both run the
-- same rules from the same seed (lib/rng.lua), and the host decides the order things happen in: each step of the clock
-- it sends the taps it took that step, and the guest applies the same taps and takes the same step. A tap on the guest
-- goes to the host first, so it lands one step later than a tap on the host, which at 100 ms a step nobody notices.
-- If the guest ever misses a step, it asks for the host's whole state and carries on from there.
-- Everything the shell knows is in M.S, so a test can watch a match as it plays.

local base = require("lib.base")
local display = require("lib.display")
local link = require("lib.link")
local newRng = require("lib.rng").new
local sound = require("lib.sound")
local ui = require("lib.ui")

local M = {}
local C = ui.C
local floor = math.floor

local TICK = 0.05             -- seconds between the shell's own ticks; a game steps every plugin.tickMs
local MAX_CATCH_UP = 3        -- a late frame runs at most this many steps
local COUNT_MS = 3000         -- the 3-2-1
local QUIT_WINDOW_MS = 3000   -- how long QUIT waits for its second tap
local SPLIT_HINT_MS = 4000    -- how long a game steered by the whole wall shows how
local FINAL_HOLD_MS = 1500    -- taps this soon after the end were aimed at the game, not at the final board
local SILENT_MS = 6000        -- a match whose other cabinet says nothing for this long is called off
local INVITE_MS = 30000       -- how long an invitation stands
local IDLE_MS = 120000        -- no taps on a menu for this long goes back to the idle screen
local DEMO_MS = 30000         -- each game plays itself on the idle screen for this long
local TOAST_MS = 2500
local PLAYER_COLOR = { C.red, C.blue }

local S = {}                  -- the shell's state: see M.S
local app = { audio = sound } -- what a game's view gets: app.audio.play(name)
local disp, games, opts

local function nowMs() return os.epoch("utc") end
local function dirty() S.dirty = true end

local function toast(text, color)
  S.toast = { text = text, color = color or C.warn, untilAt = nowMs() + TOAST_MS }
  dirty()
end

-- ---------------------------------------------------------------- wins and losses

--- This cabinet's record in a game, against each cabinet it has played: { name, wins, losses }, most wins first.
local function recordPath(id) return fs.combine(opts.data, id .. ".record") end

local function readRecord(id)
  local path = recordPath(id)
  if not fs.exists(path) then return {} end
  local h = fs.open(path, "r")
  local ok, rows = pcall(textutils.unserialise, h.readAll() or "")
  h.close()
  return ok and type(rows) == "table" and rows or {}
end

local function addResult(id, opponent, won)
  local rows = readRecord(id)
  local row
  for _, r in ipairs(rows) do
    if r.name == opponent then row = r end
  end
  if not row then
    row = { name = opponent, wins = 0, losses = 0 }
    rows[#rows + 1] = row
  end
  if won then row.wins = row.wins + 1 else row.losses = row.losses + 1 end
  table.sort(rows, function(a, b) return a.wins > b.wins or (a.wins == b.wins and a.losses < b.losses) end)
  local h = fs.open(recordPath(id), "w")
  h.write(textutils.serialise(rows))
  h.close()
end

-- ---------------------------------------------------------------- moving between screens

local function selectGame(plugin)
  S.game = plugin
  S.L = plugin.view.layout(disp.W, disp.H)
  disp.accent(plugin.accent)
end

local function gameById(id)
  for _, plugin in ipairs(games) do
    if plugin.id == id then return plugin end
  end
end

local function show(view)
  if view == "menu" then disp.accent(nil) end
  S.view = view
  S.lastTouch = nowMs()
  dirty()
end

--- What the other cabinet is told about this one with every hello.
local function busy()
  return S.match ~= nil and S.match.mode ~= "cpu"
end

-- ---------------------------------------------------------------- a match

--- A new match. mode is "cpu" (against the computer here), "host" (player 1, running the clock) or "guest" (player 2).
local function newMatch(mode, seed, names, level)
  local plugin = S.game
  local rng = newRng(seed)
  local state = plugin.rules.new({ rng = rng })
  state.names = names
  S.match = {
    mode = mode, me = mode == "guest" and 2 or 1, names = names, level = level, seed = seed,
    rng = rng, state = state, n = 0, inputs = {},
    countUntil = nowMs() + COUNT_MS, heardAt = nowMs(), rematch = {},
  }
  S.invite, S.asking = nil, nil
  sound.play("count")
  show("count")
end

local function playComputer(level)
  newMatch("cpu", math.random(1, 2147483646), { link.name(), "COMPUTER" }, level)
end

--- The host starts a match against the cabinet that joined, and tells it how.
local function hostMatch(peerId, peerName)
  local seed = math.random(1, 2147483646)
  local names = { link.name(), peerName }
  link.send({ t = "start", game = S.game.id, seed = seed, names = names }, peerId)
  newMatch("host", seed, names)
  S.match.peer = peerId
end

local function startPlay()
  local m = S.match
  m.startedAt = nowMs()
  m.nextAt = nowMs() + S.game.tickMs
  sound.play("go")
  show("play")
end

--- The match is over: the final board, and the result kept for a match between two cabinets.
local function finish(forfeit)
  local m = S.match
  if m.overAt then return end
  m.overAt, m.forfeit = nowMs(), forfeit
  local s = m.state
  local won = s.winner == m.me
  if m.mode ~= "cpu" and (s.winner == 1 or s.winner == 2) then addResult(S.game.id, m.names[3 - m.me], won) end
  if s.winner ~= 1 and s.winner ~= 2 then
    sound.play("draw")
  elseif won then
    sound.play("win")
    sound.later("fanfare", 450)
  else
    sound.play("lose")
  end
  show("final")
end

--- The other cabinet has gone quiet mid-match: call it off, with no result.
local function lostPeer()
  local m = S.match
  m.state.over, m.lost = true, true
  m.overAt = nowMs()
  sound.play("timeout")
  show("final")
end

--- Apply one step's taps and take the step, on either cabinet. Returns the step's events.
local function step(m, inputs)
  local rules = S.game.rules
  for _, input in ipairs(inputs) do rules.input(m.state, input[1], input[2]) end
  m.n = m.n + 1
  local events = rules.tick(m.state, m.rng) or {}
  S.game.view.onEvents(app, m.state, events)
  return events
end

--- One step on the cabinet that runs the clock: the computer's move, everyone's taps, the step, and the news to the guest.
local function hostStep(m)
  local s, rules = m.state, S.game.rules
  if m.mode == "cpu" then
    local action = rules.bot(s, m.rng, 2, m.level)
    if action then m.inputs[#m.inputs + 1] = { 2, action } end
  end
  local inputs = m.inputs
  m.inputs = {}
  step(m, inputs)
  if m.mode == "host" then
    link.send({ t = "frame", n = m.n, inputs = inputs, score = { s.score[1], s.score[2] } }, m.peer)
  end
  if s.over then finish() end
end

--- A tap on this cabinet's wall during play: the host queues it for the next step, the guest sends it to the host.
local function input(action)
  local m = S.match
  if not action or m.state.over then return end
  S.lastAction = action
  if m.mode == "guest" then
    link.send({ t = "input", action = action }, m.peer)
  else
    m.inputs[#m.inputs + 1] = { 1, action }
  end
end

local function forfeit(player)
  local m = S.match
  local s = m.state
  s.over, s.winner = true, 3 - player
  if m.mode == "host" then link.send({ t = "end", winner = s.winner, forfeit = player }, m.peer) end
  finish(player)
end

local function askToQuit()
  local m = S.match
  if m.quitUntil and nowMs() < m.quitUntil then
    if m.mode == "guest" then
      link.send({ t = "quit" }, m.peer)
      m.quitUntil = nil -- the host ends it, and says so
    else
      forfeit(1)
    end
  else
    m.quitUntil = nowMs() + QUIT_WINDOW_MS
    sound.play("tap")
  end
  dirty()
end

local function leaveMatch()
  local m = S.match
  if m and m.mode ~= "cpu" and not m.lost then link.send({ t = "done" }, m.peer) end
  S.match = nil
  show("ready")
end

local function rematch()
  local m = S.match
  if m.mode == "cpu" then
    playComputer(m.level)
    return
  end
  if m.lost or m.peerDone then return end
  m.rematch[m.me] = true
  link.send({ t = "rematch" }, m.peer)
  if m.mode == "host" and m.rematch[2] then hostMatch(m.peer, m.names[2]) end
  sound.play("tap")
  dirty()
end

-- ---------------------------------------------------------------- messages from the other cabinet

local handle = {}

function handle.invite(sender, msg)
  local plugin = gameById(msg.game)
  if not plugin or (S.match and S.match.mode ~= "cpu" and not S.match.overAt) then return end
  S.invite = { from = sender, name = msg.name, game = msg.game, at = nowMs() }
  sound.play("hint")
  dirty()
end

function handle.cancel(sender)
  if S.invite and S.invite.from == sender then S.invite = nil; dirty() end
end

function handle.join(sender, msg)
  local ask = S.asking
  if ask and ask.to == sender and S.view == "ready" and S.game.id == ask.game then
    hostMatch(sender, msg.name)
  else
    link.send({ t = "cancel" }, sender) -- too late: this cabinet has moved on
  end
end

function handle.start(sender, msg)
  local plugin = gameById(msg.game)
  if not plugin or type(msg.names) ~= "table" then return end
  selectGame(plugin)
  newMatch("guest", msg.seed, msg.names)
  S.match.peer = sender
end

function handle.frame(sender, msg)
  local m = S.match
  if not m or m.mode ~= "guest" or m.peer ~= sender or m.overAt then return end
  m.heardAt = nowMs()
  if S.view == "count" then startPlay() end
  if m.syncing then return end
  if msg.n ~= m.n + 1 then
    m.syncing = true
    link.send({ t = "sync" }, sender)
    return
  end
  step(m, msg.inputs or {})
  local s = m.state
  if s.score[1] ~= msg.score[1] or s.score[2] ~= msg.score[2] then
    m.syncing = true
    link.send({ t = "sync" }, sender)
    return
  end
  dirty()
  if s.over then finish() end
end

function handle.sync(sender)
  local m = S.match
  if m and m.mode == "host" and m.peer == sender then
    link.send({ t = "state", n = m.n, state = m.state, rng = m.rng.state() }, sender)
  end
end

function handle.state(sender, msg)
  local m = S.match
  if not m or m.mode ~= "guest" or m.peer ~= sender or type(msg.state) ~= "table" then return end
  m.state, m.n, m.syncing = msg.state, msg.n, false
  m.rng.set(msg.rng)
  S.resyncs = (S.resyncs or 0) + 1
  dirty()
end

function handle.input(sender, msg)
  local m = S.match
  if m and m.mode == "host" and m.peer == sender and S.view == "play" and type(msg.action) == "table" then
    m.inputs[#m.inputs + 1] = { 2, msg.action }
    m.heardAt = nowMs()
  end
end

function handle.quit(sender)
  local m = S.match
  if m and m.mode == "host" and m.peer == sender and not m.overAt then forfeit(2) end
end

--- The host ended the match early: somebody gave up.
handle["end"] = function(sender, msg)
  local m = S.match
  if not m or m.mode ~= "guest" or m.peer ~= sender or m.overAt then return end
  m.state.over, m.state.winner = true, msg.winner
  finish(msg.forfeit)
end

function handle.done(sender)
  local m = S.match
  if m and m.peer == sender then
    if m.overAt then
      m.peerDone = true
      toast(m.names[3 - m.me] .. " has left")
    else
      lostPeer()
    end
  end
end

function handle.rematch(sender)
  local m = S.match
  if not m or m.peer ~= sender or not m.overAt then return end
  m.rematch[3 - m.me] = true
  if m.mode == "host" and m.rematch[1] then
    hostMatch(m.peer, m.names[2])
  else
    toast(m.names[3 - m.me] .. " wants a rematch", C.ok)
  end
end

local function message(sender, msg, protocol)
  local id
  id, msg = link.read(sender, msg, protocol)
  if not id then return end
  local m = S.match
  if m and m.peer == id then m.heardAt = nowMs() end
  if handle[msg.t] then handle[msg.t](id, msg) end
end

-- ---------------------------------------------------------------- the idle screen

local function nextDemo()
  S.demoIndex = (S.demoIndex or 0) % #games + 1
  selectGame(games[S.demoIndex])
  S.demo = { since = nowMs() }
end

--- One step of the idle screen's match: the computer plays both sides.
local function demoStep(t)
  local demo, plugin = S.demo, S.game
  if not demo.state or (demo.finishedAt and t - demo.finishedAt > 5000) then
    demo.rng = newRng(math.random(1, 2147483646))
    demo.state, demo.nextAt, demo.finishedAt = plugin.rules.new({ rng = demo.rng }), t + 800, nil
    return true
  end
  if demo.finishedAt or t < demo.nextAt then return false end
  demo.nextAt = t + plugin.tickMs
  for p = 1, 2 do
    local action = plugin.rules.bot(demo.state, demo.rng, p, plugin.cpuLevels and plugin.cpuLevels[1])
    if action then plugin.rules.input(demo.state, p, action) end
  end
  plugin.rules.tick(demo.state, demo.rng)
  if demo.state.over then demo.finishedAt = t end
  return true
end

local function drawIdle()
  local W, H = disp.W, disp.H
  local plugin = S.game
  ui.text(plugin.title, floor(W / 2), 1, C[plugin.color] or C.hi, "center", W - 2)
  if S.demo.state then plugin.view.draw(S.L, S.demo.state, 1) end
  if floor(nowMs() / 700) % 2 == 0 then
    local y = math.min(S.L.statusY, H - 8)
    ui.fill(floor(W / 2) - 34, y - 1, 68, ui.fontHeight() + 2, C.bg)
    ui.text("TOUCH TO PLAY", floor(W / 2), y, C.text, "center")
  end
  ui.region("play", 0, 0, W, H)
end

-- ---------------------------------------------------------------- the menus

local function drawMenu()
  local W, H = disp.W, disp.H
  ui.text(opts.name, floor(W / 2), 2, C.hi, "center")
  local peer = link.peer()
  local line = peer and ("Pick a game to play with " .. peer.name) or "Pick a game"
  ui.small(line, floor(W / 2), 10, C.line, C.bg, "center", W - 4)
  ui.button("back", 2, 1, 16, 7, "BACK", C.panel, { small = true })
  local tileH = math.min(18, floor((H - 16) / #games) - 2)
  for i, plugin in ipairs(games) do
    local y = 14 + (i - 1) * (tileH + 2)
    local color = C[plugin.color] or C.hi
    ui.button("game", 4, y, W - 8, tileH, "", C.panel, { data = i, frame = color })
    ui.text(plugin.title, floor(W / 2), y + floor((tileH - ui.fontHeight()) / 2) - 1, C.text, "center")
    ui.small(plugin.blurb or "", floor(W / 2), y + tileH - 3, C.line, C.panel, "center", W - 12)
  end
end

--- This cabinet's record in the game, from row y down, at most limit rows.
local function drawRecord(y, limit)
  local W = disp.W
  local rows = readRecord(S.game.id)
  ui.small("THIS CABINET'S WINS AND LOSSES", floor(W / 2), y, C.hi, C.bg, "center")
  if #rows == 0 then ui.small("No games against another cabinet yet", floor(W / 2), y + 2, C.line, C.bg, "center") end
  for i, row in ipairs(rows) do
    if i > limit then break end
    local line = y + i * 2
    ui.small("against " .. row.name, 26, line, i == 1 and C.text or C.line, C.bg, "left", 44)
    ui.small(row.wins .. "W", W - 36, line, C.ok, C.bg, "right")
    ui.small(row.losses .. "L", W - 26, line, C.warn, C.bg, "right")
  end
end

local function drawReady()
  local W, H = disp.W, disp.H
  local plugin = S.game
  local cx = floor(W / 2)
  ui.text(plugin.title, cx, 2, C[plugin.color] or C.hi, "center", W - 40)
  ui.small(plugin.blurb or "", cx, 12, C.line, C.bg, "center", W - 4)
  ui.button("back", 2, 1, 16, 7, "BACK", C.panel, { small = true })
  ui.button("rules", W - 18, 1, 16, 7, "HOW TO PLAY", C.panel, { small = true })
  drawRecord(16, 6)
  local peer = link.peer()
  local y = H - 40
  if S.asking then
    ui.small("Waiting for " .. S.asking.name .. " to tap their wall", cx, y - 3, C.text, C.bg, "center", W - 4)
    ui.button("cancel", cx - 25, y, 50, 11, "CANCEL", C.warn)
  elseif peer and not peer.busy then
    ui.small(peer.name .. " is here", cx, y - 3, C.ok, C.bg, "center", W - 4)
    ui.button("challenge", cx - 40, y, 80, 11, "PLAY " .. string.upper(peer.name), C.ok)
  else
    local why = not link.online() and "No wireless modem: attach one to play another cabinet"
      or (peer and (peer.name .. " is busy") or "No other cabinet in range")
    ui.small(why, cx, y - 3, C.line, C.bg, "center", W - 4)
  end
  ui.button("cpu", cx - 30, y + 14, 60, 9, "PLAY THE COMPUTER", (peer and not S.asking) and C.panel or C.ok,
    { small = true })
  local levels = plugin.cpuLevels or {}
  local w = floor(60 / math.max(#levels, 1))
  for i, level in ipairs(levels) do
    ui.button("level", cx - 30 + (i - 1) * w, y + 25, w - 1, 7, string.upper(level),
      level == S.level and C.hi or C.panel, { small = true, data = level })
  end
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

--- Another cabinet wants a game: the whole wall is the answer.
local function drawInvited()
  local W, H = disp.W, disp.H
  local plugin = gameById(S.invite.game)
  ui.text(plugin.title, floor(W / 2), 2, C[plugin.color] or C.hi, "center", W - 4)
  ui.small(plugin.blurb or "", floor(W / 2), 12, C.line, C.bg, "center", W - 4)
  ui.region("join", 0, 14, W, H - 30)
  local y = floor(H / 2) - 6
  ui.text(S.invite.joined and "JOINING..." or "TAP TO JOIN", floor(W / 2), y, C.hi, "center", W - 4)
  ui.small(S.invite.name .. " wants a game", floor(W / 2), y + 10, C.text, C.bg, "center", W - 4)
  ui.button("decline", floor(W / 2) - 15, H - 14, 30, 9, "NO THANKS", C.panel, { small = true })
end

-- ---------------------------------------------------------------- the match on the wall

local function drawHeader(m)
  local W = disp.W
  local s = m.state
  local mine, theirs = m.me, 3 - m.me
  local cx = floor(W / 2)
  ui.small(m.names[mine], 2, 1, PLAYER_COLOR[mine], C.bg, "left", cx - 12)
  ui.small(m.names[theirs], W - 2, 1, PLAYER_COLOR[theirs], C.bg, "right", cx - 12)
  ui.text(s.score[mine], cx - 4, 1, PLAYER_COLOR[mine], "right")
  ui.text("-", cx, 1, C.line, "center")
  ui.text(s.score[theirs], cx + 4, 1, PLAYER_COLOR[theirs], "left")
end

local function drawGame(m)
  drawHeader(m)
  S.game.view.draw(S.L, m.state, m.me)
end

local function drawCount()
  local m = S.match
  local left = math.max(1, math.ceil((m.countUntil - nowMs()) / 1000))
  m.shownCount = left
  drawGame(m)
  local cx, y = floor(disp.W / 2), floor(disp.H / 2) - 6
  ui.fill(cx - 12, y, 24, 13, C.panel)
  ui.frame(cx - 12, y, 24, 13, C.hi, 1)
  ui.text(left, cx, y + 4, C.hi, "center")
end

local function drawPlay()
  local W, H = disp.W, disp.H
  local m = S.match
  drawGame(m)
  if S.game.split and nowMs() - m.startedAt < SPLIT_HINT_MS then base.drawSplit(W, H) end
  local asking = m.quitUntil and nowMs() < m.quitUntil
  ui.button("quit", W - 14, H - 8, 12, 7, asking and "SURE?" or "QUIT", asking and C.warn or C.panel, { small = true })
end

local function headline(m)
  if m.lost then return "CALLED OFF", C.warn end
  local w = m.state.winner
  if w ~= 1 and w ~= 2 then return "DRAW", C.hi end
  if m.mode ~= "cpu" then return w == m.me and "YOU WIN!" or (m.names[w] .. " WINS"), PLAYER_COLOR[w] end
  return m.names[w] .. " WINS", PLAYER_COLOR[w]
end

--- The last moment of the match stays up until someone taps.
local function drawFinal()
  local W = disp.W
  local m = S.match
  drawGame(m)
  local y = floor(disp.H / 2) - 6
  local text, color = headline(m)
  ui.fill(4, y, W - 8, 13, C.panel)
  ui.frame(4, y, W - 8, 13, color, 1)
  ui.text(text, floor(W / 2), y + 2, color, "center", W - 12)
  local why = m.lost and "The other cabinet went quiet - tap to go on"
    or (m.forfeit and (m.names[m.forfeit] .. " gave up - tap to go on")) or "TAP TO SEE THE SCORES"
  ui.small(why, floor(W / 2), y + 10, C.text, C.panel, "center", W - 12)
  ui.region("seen", 0, 0, W, disp.H)
end

local function drawOver()
  local W, H = disp.W, disp.H
  local cx = floor(W / 2)
  local m = S.match
  local s = m.state
  local text, color = headline(m)
  ui.text(text, cx, 2, color, "center", W - 4)
  ui.small(string.format("%s %d - %d %s", m.names[m.me], s.score[m.me], s.score[3 - m.me], m.names[3 - m.me]), cx, 11,
    C.text, C.bg, "center", W - 4)
  if m.mode == "cpu" then ui.small("Games against the computer aren't counted", cx, 13, C.line, C.bg, "center", W - 4) end
  drawRecord(16, 8)
  local y = H - 14
  local label, enabled = "REMATCH", not (m.lost or m.peerDone)
  if m.rematch[m.me] then label = "WAITING" elseif m.rematch[3 - m.me] then label = "AGREE" end
  ui.button("rematch", cx - 42, y, 40, 11, label, m.rematch[m.me] and C.panel or C.ok, { enabled = enabled })
  ui.button("done", cx + 2, y, 40, 11, "DONE", C.panel)
end

local DRAW = {
  idle = drawIdle, menu = drawMenu, ready = drawReady, rules = drawRules, invited = drawInvited, count = drawCount,
  play = drawPlay, final = drawFinal, over = drawOver,
}

--- An invitation stands over any screen that isn't part of a match.
local function screen()
  if S.invite and not S.match then return "invited" end
  return S.view
end

local function render()
  S.dirty = false
  disp.begin()
  DRAW[screen()]()
  local t = S.toast
  if t and nowMs() < t.untilAt then
    local W = disp.W
    ui.fill(10, disp.H - 24, W - 20, 7, C.panel)
    ui.small(t.text, floor(W / 2), disp.H - 21, t.color, C.panel, "center", W - 24)
  end
  disp.show()
end

-- ---------------------------------------------------------------- taps and keys

local function press(b, px, py)
  local id = b and b.id
  local view = screen()
  if view == "idle" then
    sound.play("select")
    show("menu")
  elseif view == "invited" then
    if id == "join" then
      link.send({ t = "join" }, S.invite.from)
      sound.play("select")
      S.invite.joined = true
    elseif id == "decline" then
      link.send({ t = "cancel" }, S.invite.from)
      S.invite = nil
      sound.play("back")
    end
    dirty()
  elseif id == "back" then
    sound.play("back")
    if view == "ready" then show("menu") else nextDemo(); show("idle") end
  elseif id == "game" then
    selectGame(games[b.data])
    S.level = S.game.cpuLevels and S.game.cpuLevels[math.min(2, #S.game.cpuLevels)]
    sound.play("select")
    show("ready")
  elseif id == "rules" then
    sound.play("tap")
    show("rules")
  elseif id == "rulesDone" then
    sound.play("tap")
    show("ready")
  elseif id == "challenge" then
    local peer = link.peer()
    if peer then
      S.asking = { to = peer.id, name = peer.name, game = S.game.id, at = nowMs() }
      link.send({ t = "invite", game = S.game.id }, peer.id)
      sound.play("select")
      dirty()
    end
  elseif id == "cancel" then
    link.send({ t = "cancel" }, S.asking.to)
    S.asking = nil
    sound.play("back")
    dirty()
  elseif id == "cpu" then
    if S.asking then link.send({ t = "cancel" }, S.asking.to) end
    playComputer(S.level)
  elseif id == "level" then
    S.level = b.data
    sound.play("tap")
    dirty()
  elseif id == "quit" then
    askToQuit()
  elseif id == "seen" then
    if nowMs() - S.match.overAt < FINAL_HOLD_MS then return end
    sound.play("tap")
    show("over")
  elseif id == "rematch" then
    rematch()
  elseif id == "done" then
    sound.play("back")
    leaveMatch()
  elseif view == "play" then
    input(S.game.view.actionAt(S.L, S.match.state, px, py, S.match.me))
  end
end

local function touch(px, py)
  S.lastTouch = nowMs()
  press(ui.hit(px, py), px, py)
end

local ARROWS = { [keys.up] = "up", [keys.down] = "down", [keys.left] = "left", [keys.right] = "right" }

local function key(code)
  if S.view == "play" and S.game.split and ARROWS[code] then input({ kind = "turn", dir = ARROWS[code] }) end
end

-- ---------------------------------------------------------------- the clock

local function tick()
  local t = nowMs()
  sound.pump()
  link.hello({ busy = busy() })
  local m = S.match
  if S.invite and t - S.invite.at > INVITE_MS then S.invite = nil; dirty() end
  if S.asking and t - S.asking.at > INVITE_MS then S.asking = nil; dirty() end
  if S.toast and t >= S.toast.untilAt then S.toast = nil; dirty() end
  if floor(t / 2000) ~= S.peerBeat then S.peerBeat = floor(t / 2000); dirty() end -- the other cabinet comes and goes
  if m and m.mode ~= "cpu" and not m.overAt and t - m.heardAt > SILENT_MS then
    lostPeer()
    return
  end
  local view = screen()
  if view == "idle" then
    if t - S.demo.since > DEMO_MS and (not S.demo.state or S.demo.finishedAt) then nextDemo() end
    if demoStep(t) then dirty() end
    if floor(t / 700) ~= S.blink then S.blink = floor(t / 700); dirty() end
  elseif view == "count" then
    if t >= m.countUntil and m.mode ~= "guest" then
      startPlay() -- the guest starts when the host's first step arrives
    elseif math.ceil((m.countUntil - t) / 1000) ~= m.shownCount then
      if m.shownCount then sound.play("count") end
      dirty()
    end
  elseif view == "play" and m.mode ~= "guest" then
    local steps = 0
    while t >= m.nextAt and steps < MAX_CATCH_UP and S.view == "play" do
      steps = steps + 1
      m.nextAt = m.nextAt + S.game.tickMs
      hostStep(m)
    end
    if t >= m.nextAt then
      -- too far behind to catch up: the steps it would have taken are lost, and the game runs on from now
      if S.view == "play" then
        S.droppedSteps = (S.droppedSteps or 0) + math.floor((t - m.nextAt) / S.game.tickMs) + 1
      end
      m.nextAt = t + S.game.tickMs
    end
    S.steps = (S.steps or 0) + steps
    if steps > 1 then S.lateFrames = (S.lateFrames or 0) + 1 end
    if steps > 0 then dirty() end
  elseif (view == "menu" or view == "ready" or view == "rules") and t - S.lastTouch > IDLE_MS then
    if S.asking then link.send({ t = "cancel" }, S.asking.to); S.asking = nil end
    nextDemo()
    show("idle")
  end
  if m and m.quitUntil and t >= m.quitUntil then m.quitUntil = nil; dirty() end
end

-- ---------------------------------------------------------------- running it

--- What a test can watch: the screen, the game, the match in play, the buttons on the wall.
M.S = S

--- Play an action as if this wall had been tapped for it: the computer player's moves, for a test standing in for a
--- player whose game has no single tap for what it wants (Artillery's computer sets angle and power at once).
M.input = input

--- Run the cabinet until terminated. o.root is the program's folder; o.games the plugins, in menu order; o.name the
--- cabinet's title; o.monitor a monitor name (default the biggest); o.data where the wins and losses go.
function M.run(o)
  opts = o
  games = o.games
  opts.name = opts.name or "VERSUS"
  opts.data = opts.data or fs.combine(o.root, "records")
  local err
  disp, err = display.open(o.root, o.monitor)
  if not disp then error(err, 0) end
  sound.init(peripheral.find("speaker"))
  link.open()
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
      elseif ev == "rednet_message" then
        message(a, b, c)
      elseif ev == "monitor_touch" and a == disp.name then
        touch(b - 1, c - 1)
      elseif ev == "key" then
        key(a)
      elseif ev == "monitor_resize" and a == disp.name then
        disp.reset(S.game and S.game.accent)
        if S.game then S.L = S.game.view.layout(disp.W, disp.H) end
        dirty()
      elseif ev == "peripheral" or ev == "peripheral_detach" then
        sound.init(peripheral.find("speaker"))
        link.open()
      end
      if nowMs() - lastTick > 250 then
        timer = os.startTimer(TICK)
        lastTick = nowMs()
        tick()
      end
      if S.dirty then render() end
      -- the shell's own share of a late frame: one event (a step and its drawing, a tap) that takes more than the room a
      -- step leaves past the shell's tick holds the next frame back by itself; a late frame with nothing slow before it
      -- was held back by the machine, not the game
      if S.view == "play" and S.game and nowMs() - busyFrom > S.game.tickMs - TICK * 1000 then
        S.slowFrames = (S.slowFrames or 0) + 1
      end
    end
  end)
  disp.close()
  if not ok then error(failure, 0) end
end

return M
