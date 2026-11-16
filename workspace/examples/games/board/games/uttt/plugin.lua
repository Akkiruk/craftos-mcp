-- games/uttt/plugin.lua
-- Part of the craftos-mcp examples (MIT).
-- Ultimate Tic-Tac-Toe on the cabinet: nine small boards in one big one, and where you play sends your opponent.

local ai = require("games.uttt.ai")
local base = require("cabinet.base")
local board = require("games.uttt.board")
local rules = require("games.uttt.rules")
local ui = require("cabinet.ui")

local C = ui.C
local floor, max, min = math.floor, math.max, math.min
local FLASH_MS = 350

local function nowMs() return os.epoch("utc") end

local view = { seatLabels = { "RED  (X)", "BLUE  (O)" }, scoreName = "BOARDS" }

function view.layout(W, H) return board.layout(W, H) end

function view.score(state) return state.boards[1], state.boards[2] end

function view.drawBoard(L, match)
  local x = match.extras
  local flash = x.flash and x.flash.on and x.flash or nil
  local hint = (match.hint and nowMs() < match.hintUntil) and { match.hint.b, match.hint.c } or nil
  board.board(L, { state = match.state, last = x.last, hint = hint, flash = flash })
end

--- A map of the nine boards on one side, the last few moves on the other.
function view.drawSides(L, match, leftX, rightX, w)
  local mx, my = leftX + floor((w - 11) / 2), L.y0 + L.bh - 12
  ui.small("BOARDS", leftX + floor(w / 2), my - 2, C.line, C.bg, "center")
  local s = match.state
  for b = 1, 9 do
    local x = mx + ((b - 1) % 3) * 4
    local y = my + floor((b - 1) / 3) * 3
    local o = s.sub[b]
    local col = o == 1 and C.red or (o == 2 and C.blue or (o == 3 and C.tie or C.panel))
    if o == 0 and (s.forced == nil or s.forced == b) then col = C.hiTint end
    ui.fill(x, y, 3, 2, col)
  end
  local hist = s.history
  local ry = L.y0 + 19
  ui.small("MOVES", rightX + floor(w / 2), ry, C.line, C.bg, "center")
  for i = 0, 4 do
    local h = hist[#hist - i]
    if h then
      ui.small(string.format("%d %s%d-%d", #hist - i, h.p == 1 and "X" or "O", h.b, h.c), rightX, ry + 2 + i * 2,
        h.p == 1 and C.red or C.blue, C.bg, "left", w)
    end
  end
end

function view.actionAt(L, _, px, py)
  local b, c = board.cellAt(L, px, py)
  if not b then return nil end
  return { kind = "move", b = b, c = c }
end

function view.refusal(state, why)
  if why == "cell taken" then return "That square is taken" end
  if why == "that board is already decided" then return "That board is already decided" end
  if state.forced then return string.format("You must play in board %d", state.forced) end
  return why
end

function view.prompt(state, moverName)
  if state.forced then
    return string.format("%s: play in board %d (lit)", moverName, state.forced), state.turn == 1 and C.red or C.blue
  end
  return string.format("%s: FREE MOVE - anywhere!", moverName), C.hi
end

function view.hintText(action) return string.format("Hint: board %d, square %d", action.b, action.c) end

function view.finalLine(match)
  local s = match.state
  if s.winner == 3 then return "DRAW - no boards left to play", C.hi end
  local w = s.winner == 1 and match.red or match.blue
  local color = s.winner == 1 and C.red or C.blue
  if s.forfeit then return w.name .. " WINS by forfeit", color end
  if s.metaLine then
    local l = rules.LINES[s.metaLine]
    return string.format("%s WINS - boards %d, %d, %d in a line", w.name, l[1], l[2], l[3]), color
  end
  return string.format("%s WINS - most boards (%d-%d)", w.name, s.boards[s.winner], s.boards[3 - s.winner]), color
end

function view.howLine(r, duration)
  local s = r.state
  local how = r.forfeit and "BY FORFEIT" or (r.winner == 3 and "NOTHING LEFT TO PLAY" or "THREE BOARDS IN A LINE")
  return string.format("%s  -  %d moves  -  %s  -  boards %d-%d", how, s.moves, duration, s.boards[1], s.boards[2])
end

--- Sound and marks for what the rules reported. Nothing here blocks, so touches stay live.
function view.onEvents(app, match, events)
  local s = match.state
  local x = match.extras
  for _, ev in ipairs(events) do
    if ev.type == "placed" then
      x.last = { ev.b, ev.c }
      x.flash = { b = ev.b, c = ev.c, on = true, untilAt = nowMs() + FLASH_MS }
      if s.winner == 0 then
        if ev.captured then
          app.audio.play("capture")
          app.audio.later("capture", 110, 0.6, ev.seat == 2 and 0.8 or 1.2)
          local name = (ev.seat == 1 and match.red or match.blue).name
          app.setToast(string.format("%s takes board %d!", name, ev.b), ev.seat == 1 and C.red or C.blue, 2500)
        else
          app.audio.play(ev.seat == 2 and "piece_b" or "piece_a")
        end
      end
    elseif ev.type == "free" then
      app.audio.later("hint", 160)
    elseif ev.type == "sent" then
      app.audio.later("tick", 140)
      if ev.threat then app.audio.later("warning", 320) end -- the board they are sent to can be won right now
    end
  end
end

--- The last-move flash fades by itself. Returns true when the screen needs redrawing.
function view.tick(match, t)
  local flash = match.extras.flash
  if flash and flash.on and t > flash.untilAt then
    flash.on = false
    return true
  end
  return false
end

-- ------------------------------------------------------------------ the idle screen

function view.demoStep(demo, t, choose)
  if not demo.state or (demo.finishedAt and t - demo.finishedAt > 5000) then
    demo.state, demo.nextAt, demo.last, demo.finishedAt = rules.new({ first = math.random(2) }), t + 1200, nil, nil
    return true
  end
  if demo.finishedAt or t < demo.nextAt then return false end
  local s = demo.state
  local action = choose(s, "easy", { ms = 0, maxNodes = 200 })
  rules.play(s, action.b, action.c)
  demo.last = { action.b, action.c }
  demo.nextAt = t + 900
  if s.winner ~= 0 then demo.finishedAt = t end
  return true
end

--- The title in three colours over a live demo board.
function view.drawAttract(W, H, demo)
  ui.text("ULTIMATE", floor(W / 2), 2, C.hi, "center")
  local tw1, tw2, tw3 = ui.textWidth("TIC-"), ui.textWidth("TAC-"), ui.textWidth("TOE")
  local tx = floor((W - (tw1 + tw2 + tw3 + 2)) / 2)
  ui.text("TIC-", tx, 11, C.red, "left")
  ui.text("TAC-", tx + tw1 + 1, 11, C.text, "left")
  ui.text("TOE", tx + tw1 + tw2 + 2, 11, C.blue, "left")
  local cw = min(max(3, floor((W - 44) / 9)), 7)
  local ch = max(2, min(floor(cw * 2 / 3 + 0.5), floor((H - 21 - 17) / 9)))
  local bw, bh = 9 * cw + 4, 9 * ch + 2
  local Ld = board.layoutAt(floor((W - bw) / 2), 21, cw, ch, 2, 1)
  if demo.state then board.board(Ld, { state = demo.state, last = demo.last }) end
  return 21 + bh + 3
end

local M = {
  id = "uttt", title = "Ultimate Tic-Tac-Toe", short = "Ultimate", blurb = "Tic-Tac-Toe: nine boards in one",
  color = "hi", accent = 0xFFD257, minSize = { w = 80, h = 54 },
  cpuLevels = { "easy", "medium", "hard" },
  rules = rules, view = view,
  help = {
    "Nine small tic-tac-toe boards make one big board. Win three small boards in a line to win the game.",
    "",
    "Where you play decides where your opponent plays next: the square you pick inside a small board sends them to the matching board on the big one. The board they must use is lit.",
    "",
    "If that board is already won or full, they can play anywhere. That is a FREE MOVE.",
    "",
    "Win a small board with three in a line, the normal way.",
  },
}

function M.chooseAction(state, level, opts)
  local b, c = ai.choose(state, level, opts)
  if not b then return nil end
  return { kind = "move", b = b, c = c }
end

return base.fill(M)
