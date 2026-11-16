-- lib/base.lua
-- Part of the craftos-mcp examples (MIT).
-- What every game shares: the usual layout, steering by the whole wall, a round piece, and turning a game's events into
-- sounds. base.fill gives a game's plugin a default for everything it leaves out, so a small game stays small.

local ui = require("lib.ui")

local floor, min = math.floor, math.min

local function nothing() end

--- A game's layout: the board (bw x bh cells) centred under a thin header, with its controls in the space beneath.
local function actionLayout(W, H, bw, bh)
  local L = { W = W, H = H, bw = bw, bh = bh, hdr = 7 }
  L.x0 = floor((W - bw) / 2)
  L.y0 = L.hdr
  L.controlY = L.y0 + bh + 1
  L.statusY = L.controlY
  L.controlH = H - L.controlY - 1
  return L
end

--- The way a tap on the wall steers. The whole wall is the control, split corner to corner, so a player taps the side
--- they want without looking away from the game: the top of the wall goes up, the right side goes right.
local function splitAction(L, px, py)
  local dx = (px - (L.W - 1) / 2) / L.W
  local dy = (py - (L.H - 1) / 2) / L.H
  if math.abs(dx) >= math.abs(dy) then return { kind = "turn", dir = dx < 0 and "left" or "right" } end
  return { kind = "turn", dir = dy < 0 and "up" or "down" }
end

--- Shows the split for the first moments of a run: two dotted diagonals and a word in each quarter.
local function drawSplit(W, H)
  local C = ui.C
  for i = 0, 25 do
    local x, y = floor(W * i / 25), floor(H * i / 25)
    if y >= 7 then
      ui.fill(min(x, W - 2), min(y, H - 1), 2, 1, C.text)
      ui.fill(math.max(W - x - 2, 0), min(y, H - 1), 2, 1, C.text)
    end
  end
  local cx, cy = floor(W / 2), floor(H / 2)
  ui.small("TAP UP HERE", cx, 12, C.hi, C.bg, "center")
  ui.small("TAP DOWN HERE", cx, H - 10, C.hi, C.bg, "center")
  ui.small("LEFT", 8, cy, C.hi, C.bg, "center")
  ui.small("RIGHT", W - 8, cy, C.hi, C.bg, "center")
end

--- A round piece filling a w x h box.
local function disc(x, y, w, h, color)
  local cut = min(floor(w / 4), floor(h / 3))
  for row = 0, h - 1 do
    local edge = min(row, h - 1 - row)
    local inset = edge < cut and (cut - edge) or 0
    ui.fill(x + inset, y + row, w - 2 * inset, 1, color)
  end
end

--- Play what a game's table says for each event. An entry is a sound name (lib/sound.lua), or a function of the event
--- returning name, volume and pitch scale. Each sound plays once a step, however many events ask for it.
local function sfx(app, events, map)
  local heard = {}
  for _, ev in ipairs(events) do
    local name, vol, pitch = map[ev.type], nil, nil
    if type(name) == "function" then name, vol, pitch = name(ev, app) end
    if name and not heard[name] then
      heard[name] = true
      app.audio.play(name, vol, pitch)
    end
  end
end

--- Fill in everything a plugin left out.
local function fill(plugin)
  local view = plugin.view
  view.controls = view.controls or function() return {} end
  view.actionAt = view.actionAt or function() return nil end
  view.onEvents = view.onEvents or nothing
  plugin.help = plugin.help or {}
  plugin.color = plugin.color or "hi"
  plugin.accent = plugin.accent or 0xFFD257
  plugin.tickMs = plugin.tickMs or 100
  return plugin
end

return {
  actionLayout = actionLayout, splitAction = splitAction, drawSplit = drawSplit, disc = disc, sfx = sfx, fill = fill,
}
