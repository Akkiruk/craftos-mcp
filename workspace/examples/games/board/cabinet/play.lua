-- cabinet/play.lua
-- Part of the craftos-mcp examples (MIT).
-- The match screen every game shares: the two player cards, the score, the status line, the controls and the pause
-- box. The game draws its own board in the middle.

local matches = require("cabinet.match")
local ui = require("cabinet.ui")

local M = {}
local C = ui.C
local floor, min = math.floor, math.min

local app, S, env

function M.bind(appTable)
  app, S, env = appTable, appTable.S, appTable.env
end

local function nowMs() return os.epoch("utc") end

--- One player's card across the top: their name, what they are, and a bar under it while it is their move.
local function playerCard(num, slot, x, w, active)
  local color = num == 1 and C.red or C.blue
  local hdr = env.L.hdr
  ui.fill(x, 0, w, hdr, C.panel)
  ui.fill(num == 1 and x or x + w - 2, 0, 2, hdr, color)
  local tx = num == 1 and x + 4 or x + w - 4
  local align = num == 1 and "left" or "right"
  ui.name(slot.name, tx, 1, w - 8, active and C.text or C.line, align, C.panel)
  local sub = app.plugin.view.seatLabels[num] .. (slot.cpu and "  -  COMPUTER" or "")
  ui.small(sub, tx, hdr - 3, active and color or C.line, C.panel, align, w - 8)
  if active then ui.fill(x, hdr - 1, w, 1, color) end
end

local function statusLine(g, viewer)
  local mover = matches.moverSlot(g)
  if g.paused then return "PAUSED", C.warn end
  if g.thinking or mover.cpu then return mover.name .. " is thinking...", C.info end
  return app.plugin.view.prompt(g.state, mover.name, viewer)
end

local function drawControls(g, L, viewer)
  local hintOn = not matches.moverSlot(g).cpu and #app.plugin.cpuLevels > 0 and not app.plugin.noHints
  local soundLabel = app.audio.isEnabled() and "SOUND ON" or "SOUND OFF"
  local resignLabel = g.confirmResign and "SURE?" or "RESIGN"
  local resignColor = g.confirmResign and C.warn or C.panel
  local bw = L.sideW - 1
  if L.side and bw >= 10 then
    -- beside the board: MENU and HINT on the left, RESIGN and SOUND on the right
    local bx1, bx2, y = 1, L.x0 + L.bw + 1, L.y0
    ui.button("menu", bx1, y, bw, 7, "MENU", C.panel, { small = true })
    ui.button("hint", bx1, y + 9, bw, 7, "HINT", C.panel, { small = true, enabled = hintOn })
    ui.button("resign", bx2, y, bw, 7, resignLabel, resignColor, { small = true })
    ui.button("sound", bx2, y + 9, bw, 7, soundLabel, C.panel, { small = true })
    app.plugin.view.drawSides(L, g, bx1, bx2, bw, viewer)
  else
    -- in a row under the board
    local y = L.footY
    local w = floor((env.W - 10) / 4)
    ui.button("menu", 2, y, w, 7, "MENU", C.panel, { small = true })
    ui.button("hint", 2 + (w + 2), y, w, 7, "HINT", C.panel, { small = true, enabled = hintOn })
    ui.button("resign", 2 + 2 * (w + 2), y, w, 7, resignLabel, resignColor, { small = true })
    ui.button("sound", 2 + 3 * (w + 2), y, w, 7, soundLabel, C.panel, { small = true })
  end
end

local function drawPause()
  ui.clearButtons() -- nothing behind the box answers
  local W, H = env.W, env.H
  local w, h = min(W - 10, 60), 36
  local x, y = floor((W - w) / 2), floor((H - h) / 2)
  ui.fill(x, y, w, h, C.panel)
  ui.frame(x, y, w, h, C.hi, 1)
  ui.text("PAUSED", floor(W / 2), y + 3, C.hi, "center")
  ui.button("resume", x + 3, y + 13, w - 6, 8, "RESUME", C.ok, { small = true })
  ui.button("abandon", x + 3, y + 23, w - 6, 8, "END THIS GAME (NO RESULT)", C.warn, { small = true })
end

--- Draw a match. final shows the finished board under its headline. viewer is the seat whose wall this is, when a
--- game keeps things hidden; nil draws only what anyone may see.
function M.draw(g, final, viewer)
  local s = g.state
  local L = env.L
  local view = app.plugin.view
  ui.screen():clear(C.bg, nil, " ")
  ui.clearButtons()
  local W = env.W
  local cardW = floor((W - 30) / 2)
  playerCard(1, g.red, 0, cardW, s.turn == 1 and s.winner == 0)
  playerCard(2, g.blue, W - cardW, cardW, s.turn == 2 and s.winner == 0)
  -- between the cards: the score and the move number
  local cx = floor(W / 2)
  local a, b = view.score(s)
  if a then
    ui.text(a, cx - 4, 1, C.red, "right")
    ui.text("-", cx, 1, C.line, "center")
    ui.text(b, cx + 4, 1, C.blue, "left")
  end
  ui.small("MOVE " .. view.moveNumber(s), cx, L.hdr - 3, C.line, C.bg, "center")

  view.drawBoard(L, g, viewer)

  local text, color
  if g.replay then
    text, color = "REPLAY - TAP TO STOP", C.hi
  elseif final then
    text, color = view.finalLine(g)
  else
    text, color = statusLine(g, viewer)
    if S.toast and nowMs() <= S.toast.untilAt then text, color = S.toast.text, S.toast.color end
  end
  ui.fill(0, L.statusY, W, L.statusH, C.bg)
  if ui.textWidth(text) <= W - 2 then
    ui.text(text, cx, L.statusY, color, "center")
  else
    ui.small(text, cx, L.statusY + 3, color, C.bg, "center", W - 2)
  end

  if g.replay then
    ui.region("stopReplay", 0, 0, W, env.H)
    return
  end
  if final then
    ui.small("TOUCH FOR RESULTS", cx, L.statusY + L.statusH, C.line, C.bg, "center")
    ui.region("skipFinal", 0, 0, W, env.H)
    return
  end
  drawControls(g, L, viewer)
  if g.paused then drawPause() end
end

return M
