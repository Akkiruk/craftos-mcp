-- games/codebreaker/plugin.lua
-- Part of the craftos-mcp examples (MIT).
-- Codebreaker on the cabinet, for two walls back to back: each player's code stays on their own side.
-- Your wall shows your guesses on the left, and your opponent's guesses at your code on the right.

local audio = require("cabinet.audio")
local base = require("cabinet.base")
local rules = require("games.codebreaker.rules")
local ui = require("cabinet.ui")

local C = ui.C
local floor = math.floor
local PEGS, COLOURS, ROUNDS = rules.PEGS, rules.COLOURS, rules.ROUNDS

local view = { scoreName = "CRACKED" }

local PEG_COLOURS = { "red", "blue", "ok", "hi", "accent", "warn" }

local function pegColor(c) return C[PEG_COLOURS[tonumber(c)]] end
local function seatColor(p) return p == 1 and C.red or C.blue end

function view.layout(W, H)
  local rowH, panelW = 4, math.min(44, floor((W - 3) / 2))
  local L = base.layout(W, H, 2 * panelW + 2, ROUNDS * rowH + 11)
  L.side, L.rowH, L.panelW, L.pegW = true, rowH, panelW, panelW >= 44 and 5 or 3
  L.leftX, L.rightX = L.x0, L.x0 + panelW + 2
  -- the row of colours to pick from, then CLEAR and GO
  L.pickY, L.pickH, L.pickW = L.y0 + ROUNDS * rowH + 2, 8, floor((L.bw - 2 * 14) / COLOURS)
  L.clearX = L.x0 + COLOURS * L.pickW
  L.goX = L.clearX + 14
  return L
end

local function drawCode(L, x, y, code, shown)
  for i = 1, PEGS do
    local c = code and code:sub(i, i) or ""
    local color = c ~= "" and shown and pegColor(c) or C.panel
    ui.fill(x + (i - 1) * (L.pegW + 1), y, L.pegW, L.rowH - 1, color)
  end
end

local function drawLog(L, x, log, title, color)
  if title then ui.small(title, x + 4, L.y0 - 1, color, C.bg, "left", L.panelW - 4) end
  for n = 1, ROUNDS do
    local y = L.y0 + (n - 1) * L.rowH
    local g = log[n]
    ui.small(tostring(n), x + 1, y + 1, C.line, C.bg, "left")
    drawCode(L, x + 4, y, g and g.code, true)
    if g then
      local px = x + 4 + PEGS * (L.pegW + 1) + 1
      local cracked = g.black == PEGS
      local answer = L.pegW >= 5 and string.format("%d right %d close", g.black, g.white) or (g.black .. "+" .. g.white)
      ui.small(cracked and (L.pegW >= 5 and "CRACKED!" or "YES") or answer, px, y + 1, cracked and C.ok or C.text, C.bg,
        "left", L.panelW - (px - x))
    end
  end
end

--- The code a seat is building, kept outside the rules until GO.
local function picking(match, seat) return (match.extras.picks or {})[seat] or "" end

local function drawPicker(L, match, seat)
  for c = 1, COLOURS do
    ui.fill(L.x0 + (c - 1) * L.pickW + 1, L.pickY, L.pickW - 2, L.pickH, pegColor(c))
  end
  local pick = picking(match, seat)
  ui.button("clear", L.clearX, L.pickY, 12, L.pickH, "CLEAR", C.panel, { small = true })
  ui.button("go", L.goX, L.pickY, 12, L.pickH, "GO", #pick == PEGS and C.ok or C.panel, { small = true })
end

function view.drawBoard(L, match, viewer)
  local s = match.state
  local over = s.winner ~= 0 or match.replay
  local me = viewer or (over and 1 or s.turn)
  local function who(seat)
    local slot = seat == 1 and match.red or match.blue
    if not slot then return nil end -- the idle demo has no players to name
    if seat == viewer then return "YOUR GUESSES" end
    return slot.name .. "'s guesses"
  end
  ui.fill(L.x0, L.y0, L.bw, L.bh, C.bg)
  drawLog(L, L.leftX, s.log[me], who(me), seatColor(me))
  drawLog(L, L.rightX, s.log[3 - me], who(3 - me), seatColor(3 - me))
  if over then
    if not match.red then return end
    for seat = 1, 2 do
      -- each code sits under the guesses aimed at it, so the two can be checked against each other
      local code = s.secrets[3 - seat]
      local slot = seat == 1 and match.blue or match.red
      local x = (seat == me and L.leftX or L.rightX) + 4
      ui.small("Target: " .. slot.name .. "'s code", x, L.pickY, seatColor(3 - seat), C.bg, "left", L.panelW - 6)
      drawCode(L, x, L.pickY + 2, code, code ~= nil)
    end
    return
  end
  if viewer == s.turn then drawPicker(L, match, viewer) end
end

--- Beside the board: your own code, and the guess you are building.
function view.drawSides(L, match, leftX, rightX, w, viewer)
  if not viewer then return end
  local s = match.state
  local mine = s.secrets[viewer]
  local pick = picking(match, viewer)
  local y = L.y0 + 19
  ui.small(mine and "YOUR CODE" or "PICKING", rightX, y, C.hi, C.bg, "left", w)
  local shown = mine or pick
  for i = 1, PEGS do
    local c = shown:sub(i, i)
    ui.fill(rightX, y + i * 3 - 1, w, 2, c ~= "" and pegColor(c) or C.panel)
  end
  if mine and viewer == s.turn then
    ui.small("GUESS", leftX, y, C.hi, C.bg, "left", w)
    for i = 1, PEGS do
      local c = pick:sub(i, i)
      ui.fill(leftX, y + i * 3 - 1, w, 2, c ~= "" and pegColor(c) or C.panel)
    end
  end
end

function view.actionAt(L, match, px, py, viewer)
  if py < L.pickY or py >= L.pickY + L.pickH or px < L.x0 then return nil end
  local s = match.state
  local c = floor((px - L.x0) / L.pickW) + 1
  if c <= COLOURS then return { kind = "select", seat = viewer, peg = c } end
  if px >= L.clearX and px < L.clearX + 12 then return { kind = "select", seat = viewer, clear = true } end
  if px >= L.goX and px < L.goX + 12 then
    return { kind = s.phase == "setup" and "set" or "guess", code = picking(match, viewer) }
  end
  return nil
end

function view.onSelect(match, action)
  local picks = match.extras.picks or {}
  local pick = picks[action.seat] or ""
  if action.clear then
    pick = ""
  elseif #pick < PEGS then
    pick = pick .. action.peg
    audio.play("piece_b")
  end
  picks[action.seat] = pick
  match.extras.picks = picks
end

function view.prompt(state, name, viewer)
  local color = state.turn == 1 and C.red or C.blue
  if viewer ~= state.turn then
    return name .. (state.phase == "setup" and " is hiding a code" or " is thinking"), color
  end
  if state.phase == "setup" then return name .. ": hide your code", color end
  return name .. ": guess " .. (#state.log[state.turn] + 1) .. " of " .. ROUNDS, color
end

function view.finalLine(match)
  local s = match.state
  if s.winner == 3 then return "DRAW", C.hi end
  local w = s.winner == 1 and match.red or match.blue
  if s.forfeit then return w.name .. " WINS by forfeit", seatColor(s.winner) end
  local l = s.winner == 1 and match.blue or match.red
  return string.format("%s cracked %s's code in %d", w.name, l.name, #s.log[s.winner]), seatColor(s.winner)
end

function view.howLine(r, duration)
  local s = r.state
  return string.format("%s  -  %d guesses  -  %s", r.forfeit and "BY FORFEIT" or (r.winner == 3 and "NOBODY AHEAD" or "CODE CRACKED"),
    s.moves, duration)
end

function view.onEvents(app, match, events)
  local s = match.state
  for _, ev in ipairs(events) do
    match.extras.picks = {}
    if ev.type == "guess" then
      app.audio.play(ev.black == PEGS and "cracked" or "select")
      if ev.black == PEGS and s.winner == 0 then
        app.setToast((ev.seat == 1 and match.red or match.blue).name .. " cracked it! One guess left to match it",
          seatColor(ev.seat), 3000)
      end
    else
      app.audio.play("select")
    end
  end
end

--- Does this code fit every answer so far?
local function fits(log, code)
  for _, g in ipairs(log) do
    local black, white = rules.feedback(code, g.code)
    if black ~= g.black or white ~= g.white then return false end
  end
  return true
end

local M = {
  id = "codebreaker", title = "Codebreaker", short = "Codes", blurb = "Crack the code on the other wall", color = "hi", accent = 0xFFD257,
  minSize = { w = 118, h = 66 }, walls = 2, private = true, noHints = true,
  cpuLevels = { "easy", "medium", "hard" },
  rules = rules, view = view,
  help = {
    "Each player hides a code of four colours on their own wall. Colours can repeat. Stay on your side of the cabinet.",
    "",
    "Tap colours to build a code, CLEAR to start again, and GO to play it. Then take turns guessing the other player's code, with up to ten guesses each.",
    "",
    "After each guess you are told how many are right, meaning the right colour in the right place, and how many are close, meaning a right colour in the wrong place.",
    "",
    "Crack the code to win. The second player always gets their guess, so a code cracked by both in the same round is a draw. So is ten rounds with no winner.",
  },
}

--- Hard opens the classic way and then only plays codes that could be right, medium plays any that could, easy guesses.
--- It is given rules.viewFor's view, which holds no other code than its own.
function M.chooseAction(state, level, opts)
  if state.winner ~= 0 then return nil end
  local all = rules.legalActions(state)
  if state.phase == "setup" then return all[math.random(#all)] end
  if level == "easy" then return all[math.random(#all)] end
  local log = state.log[state.turn]
  if level == "hard" and #log == 0 then return { kind = "guess", code = "1122" } end
  local possible = {}
  for i, a in ipairs(all) do
    if fits(log, a.code) then possible[#possible + 1] = a end
    if opts and opts.yield and i % 300 == 0 then opts.yield() end
  end
  if #possible == 0 then return all[math.random(#all)] end
  return possible[math.random(#possible)]
end

return base.fill(M)
