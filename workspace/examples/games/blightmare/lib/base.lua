-- lib/base.lua
-- Part of the craftos-mcp examples (MIT).
-- What the game shares with the shell: steering by the whole wall, the middle of the wall as one more control, turning the
-- game's events into sounds, and base.fill, which gives a plugin a default for everything it leaves out.

local sound = require("lib.sound")
local ui = require("lib.ui")

local floor, min = math.floor, math.min

local function nothing() end

--- The way a tap on the wall steers. The whole wall is the control, split corner to corner, so a player taps the side
--- they want without looking away from the game: the top of the wall goes up, the right side goes right.
local function splitAction(L, px, py)
  local dx = (px - (L.W - 1) / 2) / L.W
  local dy = (py - (L.H - 1) / 2) / L.H
  if math.abs(dx) >= math.abs(dy) then return { kind = "turn", dir = dx < 0 and "left" or "right" } end
  return { kind = "turn", dir = dy < 0 and "up" or "down" }
end

local MIDDLE_W, MIDDLE_H = 31, 21

--- Is a tap in the middle of the wall? The game keeps one more control there than the four ways.
local function inMiddle(L, px, py)
  return math.abs(px - (L.W - 1) / 2) <= MIDDLE_W / 2 and math.abs(py - (L.H - 1) / 2) <= MIDDLE_H / 2
end

--- Corner marks around the middle of the wall.
local function drawMiddle(L, color)
  local x0, y0 = floor((L.W - MIDDLE_W) / 2), floor((L.H - MIDDLE_H) / 2)
  local x1, y1 = x0 + MIDDLE_W - 2, y0 + MIDDLE_H - 1
  for _, at in ipairs({ { x0, y0 }, { x1, y0 }, { x0, y1 }, { x1, y1 } }) do ui.fill(at[1], at[2], 2, 1, color) end
end

--- Shows the split for the first moments on foot. middle names the control in the centre, if there is one.
local function drawSplit(W, H, middle)
  local C = ui.C
  for i = 0, 25 do
    local x, y = floor(W * i / 25), floor(H * i / 25)
    local clear = middle and math.abs(y - H / 2) <= MIDDLE_H / 2
    if not clear and y >= 7 then
      ui.fill(min(x, W - 2), min(y, H - 1), 2, 1, C.text)
      ui.fill(math.max(W - x - 2, 0), min(y, H - 1), 2, 1, C.text)
    end
  end
  local cx, cy = floor(W / 2), floor(H / 2)
  ui.small("TAP UP HERE", cx, 12, C.hi, C.bg, "center")
  ui.small("TAP DOWN HERE", cx, H - 10, C.hi, C.bg, "center")
  ui.small("LEFT", 8, cy, C.hi, C.bg, "center")
  ui.small("RIGHT", W - 8, cy, C.hi, C.bg, "center")
  if middle then ui.small(middle, cx, cy, C.hi, C.bg, "center") end
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

--- A monster's own sound, for "attack", "hurt" or "die". A monster with no family gets the plain ones.
local function monster(family, what)
  if family then return "mon_" .. family .. "_" .. what end
  return what == "hurt" and "monster_hurt" or what == "die" and "monster_die" or nil
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
  plugin.tickMs = plugin.tickMs or 120
  return plugin
end

return {
  splitAction = splitAction, inMiddle = inMiddle, drawMiddle = drawMiddle, drawSplit = drawSplit, sfx = sfx,
  monster = monster, fill = fill, SOUNDS = sound.SOUNDS,
}
