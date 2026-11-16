-- cabinet/base.lua
-- Part of the craftos-mcp examples (MIT).
-- What every game shares: board layouts, drawing helpers, the idle-screen demo, and sensible defaults, so a small
-- game only writes what makes it different. README.md ("Adding a game") lists what a game provides.

local ui = require("cabinet.ui")

local floor, max, min = math.floor, math.max, math.min

local function nowMs() return os.epoch("utc") end

-- ---------------------------------------------------------------- layouts

--- A layout for a board of bw x bh cells centred under the player cards, with the status line beneath it.
local function layout(W, H, bw, bh)
  local hdr = ui.fontHeight() + 4
  local statusH = ui.fontHeight() + 1
  local L = { W = W, H = H, hdr = hdr, statusH = statusH, side = false, bw = bw, bh = bh }
  L.x0 = floor((W - bw) / 2)
  L.y0 = hdr + 2
  L.statusY = L.y0 + bh + 1
  L.sideW = L.x0 - 2
  L.footY = L.statusY + statusH + 1
  return L
end

--- A layout for a board of cols x rows square cells, as large as the wall allows. A monitor's text cell is taller
-- than it is wide, so a cell 3 wide for every 2 tall is what looks square. The controls go beside the board when that
-- leaves it bigger, and in a row beneath it otherwise.
local function grid(W, H, cols, rows)
  local function candidate(side)
    local hdr, statusH = ui.fontHeight() + 4, ui.fontHeight() + 1
    local ch = floor((H - hdr - statusH - 3 - (side and 0 or 8)) / rows)
    local cw = min(floor(ch * 1.5), floor((W - (side and 28 or 4)) / cols))
    return { cw = cw, ch = min(ch, max(2, floor(cw / 1.5 + 0.5))), side = side }
  end
  local a, b = candidate(true), candidate(false)
  local pick = (a.cw * a.ch >= b.cw * b.ch) and a or b
  local L = layout(W, H, pick.cw * cols, pick.ch * rows)
  L.cw, L.ch, L.side, L.cols, L.rows = pick.cw, pick.ch, pick.side, cols, rows
  L.colX, L.rowY = {}, {}
  for i = 1, cols do L.colX[i] = L.x0 + (i - 1) * pick.cw end
  for i = 1, rows do L.rowY[i] = L.y0 + (i - 1) * pick.ch end
  return L
end

--- The grid cell under a touch, or nil.
local function cellAt(L, px, py)
  if px < L.x0 or px >= L.x0 + L.bw or py < L.y0 or py >= L.y0 + L.bh then return nil end
  return floor((px - L.x0) / L.cw) + 1, floor((py - L.y0) / L.ch) + 1
end

-- ---------------------------------------------------------------- drawing

--- A round piece filling a w x h box: a rectangle with its corners cut away a row at a time.
local function disc(x, y, w, h, color)
  local cut = min(floor(w / 4), floor(h / 3))
  for row = 0, h - 1 do
    local edge = min(row, h - 1 - row)
    local inset = edge < cut and (cut - edge) or 0
    ui.fill(x + inset, y + row, w - 2 * inset, 1, color)
  end
end

--- A draughtboard-style grid: every cell filled in one of two shades.
local function boardGrid(L, shade)
  for r = 1, L.rows do
    for c = 1, L.cols do
      ui.fill(L.colX[c], L.rowY[r], L.cw, L.ch, shade(c, r))
    end
  end
end

-- ---------------------------------------------------------------- animation

--- Start an animation on a match. The rules have already moved on, so an animation only changes what is drawn, and
-- the next touch simply replaces it. The cabinet redraws until it ends.
local function animate(match, ms, fields)
  fields.at, fields.ms = nowMs(), ms
  match.anim = fields
end

--- How far the animation has got, 0 to 1, or nil with none playing.
local function animT(match)
  local a = match.anim
  if not a then return nil end
  return min(1, (nowMs() - a.at) / a.ms)
end

-- ---------------------------------------------------------------- the idle screen

local function demoRng(n)
  if n then return math.random(n) end
  return math.random()
end

--- One move of the idle screen's demo game, played by the computer on easy. Returns true when it changed.
local function demoStep(plugin, demo, t, choose)
  if not demo.state or (demo.finishedAt and t - demo.finishedAt > 5000) then
    demo.state = plugin.rules.new({ first = math.random(2) })
    demo.nextAt, demo.finishedAt = t + 1200, nil
    demo.match = { state = demo.state, extras = plugin.newExtras(), hintUntil = 0, actions = {} }
    return true
  end
  if demo.finishedAt or t < demo.nextAt then return false end
  local action = choose(demo.state, "easy", { maxNodes = 200 })
  local _, events = plugin.rules.step(demo.state, action, demoRng)
  if plugin.view.onDemoEvents then plugin.view.onDemoEvents(demo.match, events or {}) end
  demo.nextAt = t + 900
  if demo.state.winner ~= 0 then demo.finishedAt = t end
  return true
end

--- The idle screen: the game's title over a live demo of its board. Returns the y for the TOUCH TO PLAY line.
local function drawAttract(plugin, W, H, demo)
  local L = plugin.view.layout(W, H)
  local title = plugin.title
  if ui.textWidth(title) > W - 2 then title = plugin.short or title end
  ui.text(title, floor(W / 2), 1, ui.C[plugin.color] or ui.C.hi, "center", W - 2)
  if demo.match then plugin.view.drawBoard(L, demo.match, nil) end
  if plugin.blurb and L.y0 - 1 > ui.fontHeight() + 1 then
    ui.small(plugin.blurb, floor(W / 2), L.y0 - 1, ui.C.line, ui.C.bg, "center", W - 2)
  end
  return L.statusY
end

-- ---------------------------------------------------------------- filling in

local function nothing() end

local VIEW_DEFAULTS = {
  seatLabels = { "RED", "BLUE" },
  tick = function() return false end,
  onEvents = nothing,
  onSelect = nothing,
  drawSides = nothing,
  moveNumber = function(state) return (state.moves or 0) + 1 end,
  hintText = function() return "Try this one" end,
  refusal = function(_, why) return tostring(why) end,
}

--- Fill in everything a game left out.
local function fill(plugin)
  local view = plugin.view
  for k, v in pairs(VIEW_DEFAULTS) do
    if view[k] == nil then view[k] = v end
  end
  view.score = view.score or function() return nil end
  view.prompt = view.prompt or function(state, name)
    return name .. " to move", state.turn == 1 and ui.C.red or ui.C.blue
  end
  view.finalLine = view.finalLine or function(match)
    local s = match.state
    if s.winner == 3 then return "DRAW", ui.C.hi end
    local w = s.winner == 1 and match.red or match.blue
    return w.name .. (s.forfeit and " WINS by forfeit" or " WINS"), s.winner == 1 and ui.C.red or ui.C.blue
  end
  view.howLine = view.howLine or function(r, duration)
    return string.format("%s  -  %d moves  -  %s", r.forfeit and "BY FORFEIT" or "PLAYED OUT", r.state.moves or 0, duration)
  end
  view.drawAttract = view.drawAttract or function(W, H, demo) return drawAttract(plugin, W, H, demo) end
  view.demoStep = view.demoStep or function(demo, t, choose) return demoStep(plugin, demo, t, choose) end
  plugin.cpuLevels = plugin.cpuLevels or {}
  plugin.help = plugin.help or {}
  plugin.color = plugin.color or "hi"
  plugin.accent = plugin.accent or 0xFFD257
  plugin.newExtras = plugin.newExtras or function() return {} end
  plugin.chooseAction = plugin.chooseAction or function() return nil end
  return plugin
end

return {
  fill = fill, layout = layout, grid = grid, cellAt = cellAt, disc = disc, boardGrid = boardGrid,
  animT = animT, animate = animate,
}
