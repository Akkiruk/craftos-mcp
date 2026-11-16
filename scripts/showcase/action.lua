-- action.lua (copied into the action cabinet's folder as showcase.lua)
-- Part of the craftos-mcp showcase recorder. From the idle screen through the menu and the ready screen into a run, then
-- plays the game for cfg.seconds the way a person would, with taps: the game's own bot says what to do, and the driver
-- finds the place on the wall (a button, or a spot the game reads as that action) and taps it.

local cfg = showcaseConfig()
local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games." .. cfg.game .. ".rules")

--- How far a game's reading of a tap is from the action wanted: nil if it is a different action.
local function distance(want, got)
  if type(got) ~= "table" or got.kind ~= want.kind then return nil end
  local d = 0
  for k, v in pairs(want) do
    if type(v) == "number" then
      if type(got[k]) ~= "number" then return nil end
      d = d + math.abs(v - got[k])
    elseif got[k] ~= v then
      return nil
    end
  end
  return d
end

local cache = {}

--- Where on the wall (surface cell, 0-based) a tap makes this action.
local function spotFor(action)
  local S = kit.S
  local plugin, L, state = S.game, S.L, S.run.state
  local key = textutils.serialise(action)
  if cache[key] then return cache[key][1], cache[key][2] end
  for _, c in ipairs(plugin.view.controls(L, state)) do
    if distance(action, c.action) == 0 then
      local spot = { c.x + math.floor(c.w / 2), c.y + math.floor(c.h / 2) }
      cache[key] = spot
      return spot[1], spot[2]
    end
  end
  local best, bx, by = nil, nil, nil
  local function look(px, py)
    local d = distance(action, plugin.view.actionAt(L, state, px, py))
    if d and (not best or d < best) then best, bx, by = d, px, py end
    return best and best <= 0.6
  end
  local H, W = L.H or 81, L.W or 121
  for _, row in ipairs({ math.floor(H / 2), math.floor(H / 3), math.floor(H * 2 / 3) }) do
    for px = 0, W - 1 do if look(px, row) then break end end
    if best and best <= 0.6 then break end
  end
  if not best or best > 0.6 then
    for py = 0, H - 1, 2 do
      for px = 0, W - 1, 2 do if look(px, py) then break end end
      if best and best <= 0.6 then break end
    end
  end
  if not best then return nil end
  local spot = { bx, by }
  if best == 0 then cache[key] = spot end
  return bx, by
end

kit.run(function()
  mark("go")
  kit.waitFor(function() return kit.S.view == "idle" end, 10)
  sleep(cfg.idle or 0.7)
  kit.tap(60, 40)
  kit.waitFor(function() return kit.S.view == "menu" end, 5)
  sleep(cfg.menu or 0.8)
  local _, index = kit.game(cfg.game)
  kit.press("game", index)
  kit.waitFor(function() return kit.S.view == "ready" end, 5)
  sleep(cfg.ready or 0.7)
  kit.start()
  mark("play")
  local started = os.clock()
  local stilled = false
  local lastKey, lastTap = nil, 0
  while kit.S.view == "play" and os.clock() - started < cfg.seconds do
    local s = kit.state()
    if not s or s.over then break end
    local action = rules.bot(s, rng)
    if action and not (action.dir ~= nil and action.dir == s.want) then
      -- the same action twice running is one tap, and a paddle that only needs to move a little stays put
      local key = action.kind
      for _, k in ipairs({ "dir", "col", "x", "y" }) do
        local v = action[k]
        key = key .. ":" .. (type(v) == "number" and math.floor(v / 3) or tostring(v))
      end
      if key ~= lastKey or os.clock() - lastTap > 1.2 then
        local px, py = spotFor(action)
        if px then
          kit.tap(px, py, 0.02)
          lastKey, lastTap = key, os.clock()
        end
      end
    end
    if not stilled and os.clock() - started > (cfg.stillAt or 8) then
      stilled = true
      mark("still")
    end
    sleep(0.05)
  end
  sleep(1)
  mark("done")
end)
