-- cabinet/screens.lua
-- Part of the craftos-mcp examples (MIT).
-- The screens around a match: the idle screen, the game menu, the lobby (who is playing), how to play, and the
-- results. A game only supplies its words, through its plugin.

local ui = require("cabinet.ui")

local M = {}
local C = ui.C
local floor, max, min = math.floor, math.max, math.min

local app, S, env

function M.bind(appTable)
  app, S, env = appTable, appTable.S, appTable.env
end

local function nowMs() return os.epoch("utc") end

local function fmtDuration(sec)
  sec = floor(sec or 0)
  if sec >= 3600 then return string.format("%dh%02dm", floor(sec / 3600), floor(sec % 3600 / 60)) end
  return string.format("%d:%02d", floor(sec / 60), sec % 60)
end

local function background()
  ui.screen():clear(C.bg, nil, " ")
  ui.clearButtons()
end

--- A message box near the foot of the wall, for a few seconds.
function M.drawToast()
  local t = S.toast
  if not t or nowMs() > t.untilAt then return end
  local w = min(env.W - 4, #t.text + 6)
  local x = floor((env.W - w) / 2)
  local y = env.H - 9
  ui.fill(x, y, w, 7, C.panel)
  ui.frame(x, y, w, 7, t.color, 1)
  ui.small(t.text, floor(env.W / 2), y + 3, t.color, C.panel, "center", w - 2)
end

-- ------------------------------------------------------------------ idle

--- One wall's idle screen: a game playing itself, and the invitation to touch.
function M.drawIdle(slot)
  background()
  local W, H = env.W, env.H
  local py = slot.plugin.view.drawAttract(W, H, slot.demo)
  if floor(nowMs() / 700) % 2 == 0 then ui.text("TOUCH TO PLAY", floor(W / 2), py, C.text, "center") end
  if py + ui.fontHeight() + 2 < H then
    ui.small("Two players or play the computer", floor(W / 2), py + ui.fontHeight() + 2, C.line, C.bg, "center", W - 2)
  end
  ui.region("play", 0, 0, W, H)
end

-- ------------------------------------------------------------------ menu

function M.drawMenu()
  background()
  local W, H = env.W, env.H
  ui.text(app.name, floor(W / 2), 2, C.hi, "center")
  ui.small("Free to play - pick a game", floor(W / 2), 10, C.line, C.bg, "center", W - 2)
  ui.button("back", 2, 1, 16, 7, "BACK", C.panel, { small = true })
  local list = app.registry
  local rows = math.ceil(#list / 2)
  local rowH = max(7, min(18, floor((H - 15) / max(rows, 4)) - 2))
  local tileW = floor((W - 10) / 2)
  for i, plugin in ipairs(list) do
    local x = 4 + ((i - 1) % 2) * (tileW + 2)
    local y = 13 + floor((i - 1) / 2) * (rowH + 2)
    local fits, why = app.fits(plugin)
    local color = C[plugin.color] or C.hi
    ui.button("game", x, y, tileW, rowH, "", C.panel, { data = plugin.id, enabled = fits, frame = fits and color or nil })
    local title = plugin.short or plugin.title
    local cx = x + floor(tileW / 2)
    local fg = fits and C.text or C.line
    if ui.textWidth(title) <= tileW - 4 and rowH >= ui.fontHeight() + 6 then
      ui.text(title, cx, y + floor((rowH - ui.fontHeight()) / 2) - 1, fg, "center")
    else
      ui.small(title, cx, y + 2, fg, C.panel, "center", tileW - 2)
    end
    ui.small(fits and (plugin.blurb or "") or why, cx, y + rowH - 3, C.line, C.panel, "center", tileW - 2)
  end
  M.drawToast()
end

-- ------------------------------------------------------------------ lobby

--- Who is playing: each colour is a person or the computer at one of its levels. On two walls a person plays on the
--- wall they tapped PLAYER from.
function M.drawLobby()
  background()
  local W, H = env.W, env.H
  local l = S.lobby
  local plugin = app.plugin
  ui.text(plugin.short or plugin.title, floor(W / 2), 1, C[plugin.color] or C.hi, "center", W - 40)
  ui.button("back", 2, 1, 16, 7, "BACK", C.panel, { small = true })
  if #plugin.help > 0 then ui.button("rules", W - 18, 1, 16, 7, "HOW TO PLAY", C.panel, { small = true }) end
  ui.small("WHO IS PLAYING?", floor(W / 2), 10, C.text, C.bg, "center")

  local sw = floor((W - 10) / 2)
  local choices = { { label = "PLAYER" } }
  for _, level in ipairs(plugin.cpuLevels) do choices[#choices + 1] = { label = "CPU " .. level:upper(), cpu = level } end
  local function seatPanel(num, x)
    local slot = num == 1 and l.red or l.blue
    local color = num == 1 and C.red or C.blue
    local y, h = 13, 15 + #choices * 8
    ui.fill(x, y, sw, h, C.panel)
    ui.fill(x, y, 3, h, color)
    ui.small(plugin.view.seatLabels[num], x + 5, y + 1, color, C.panel, "left")
    ui.name(slot.name, x + 5, y + 4, sw - 8, C.text, "left", C.panel)
    local sub = slot.cpu and "COMPUTER" or "PERSON"
    if slot.cpu == nil and #env.walls > 1 and plugin.private then
      sub = "PLAYS ON " .. (slot.wall == env.walls[2].name and "WALL 2" or "WALL 1")
    end
    ui.small(sub, x + 5, y + 12, C.line, C.panel, "left", sw - 7)
    for i, choice in ipairs(choices) do
      local on = (choice.cpu == nil and slot.cpu == nil) or (choice.cpu ~= nil and choice.cpu == slot.cpu)
      ui.button(num == 1 and "redSeat" or "blueSeat", x + 5, y + 14 + (i - 1) * 8, sw - 10, 7, choice.label,
        on and color or C.bg, { small = true, data = choice.cpu or "player", frame = on and C.hi or nil })
    end
    return y + h
  end
  seatPanel(1, 4)
  local bottom = seatPanel(2, 6 + sw)

  local y = min(bottom + 2, H - 19)
  local firstText = l.first == "random" and "RANDOM" or (l.first == "blue" and "BLUE" or "RED")
  ui.button("first", 4, y, sw, 7, firstText .. " MOVES FIRST", C.panel, { small = true })
  ui.button("swap", 6 + sw, y, sw, 7, "SWAP COLORS", C.panel, { small = true })
  ui.button("start", 4, y + 9, W - 8, min(9, H - y - 10), "START", C.ok)
  M.drawToast()
end

-- ------------------------------------------------------------------ how to play

function M.drawRules()
  background()
  local W, H = env.W, env.H
  local plugin = app.plugin
  ui.text(plugin.title, floor(W / 2), 1, C[plugin.color] or C.hi, "center", W - 4)
  local y = 13
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

-- ------------------------------------------------------------------ results

function M.drawResult()
  background()
  local r = S.result
  local W, H = env.W, env.H
  local plugin = app.plugin
  local winnerColor = r.winner == 1 and C.red or (r.winner == 2 and C.blue or C.hi)
  local title = r.winner == 3 and "DRAW" or ((r.winner == 1 and r.red or r.blue).name .. " WINS!")
  if ui.textWidth(title) > W - 4 then title = r.winner == 3 and "DRAW" or "WINNER" end
  ui.text(title, floor(W / 2), 2, winnerColor, "center")
  ui.small(plugin.view.howLine(r, fmtDuration(r.seconds)), floor(W / 2), 11, C.line, C.bg, "center", W - 2)

  -- the two players, the winner framed
  local pw = floor((W - 10) / 2)
  local a, b = plugin.view.score(r.state)
  local function panel(num, x)
    local slot = num == 1 and r.red or r.blue
    local color = num == 1 and C.red or C.blue
    ui.fill(x, 15, pw, 20, C.panel)
    ui.fill(x, 15, 3, 20, color)
    if r.winner == num then ui.frame(x, 15, pw, 20, C.hi, 1) end
    ui.name(slot.name, x + 6, 17, pw - 10, C.text, "left", C.panel)
    ui.small(plugin.view.seatLabels[num] .. (slot.cpu and "  -  COMPUTER" or ""), x + 6, 26, color, C.panel, "left", pw - 8)
    if a then
      ui.small(string.format("%s %s", tostring(num == 1 and a or b), plugin.view.scoreName or "POINTS"), x + 6, 29,
        C.text, C.panel, "left", pw - 8)
    end
    if r.winner == num then ui.small("WINNER", x + pw - 3, 17, C.hi, C.panel, "right") end
  end
  panel(1, 3)
  panel(2, 7 + pw)

  local bw, by = W - 8, max(38, H - 40)
  ui.button("rematch", 4, by, bw, 8, "REMATCH (SWAP COLORS)", C.ok, { small = true })
  ui.button("newgame", 4, by + 10, bw, 8, "PICK ANOTHER GAME", C.panel, { small = true })
  local half = floor((bw - 2) / 2)
  ui.button("replay", 4, by + 20, half, 8, "WATCH THE REPLAY", C.panel, { small = true, enabled = not r.forfeit })
  ui.button("done", 6 + half, by + 20, bw - half - 2, 8, "DONE", C.panel, { small = true })
  M.drawToast()
end

return M
