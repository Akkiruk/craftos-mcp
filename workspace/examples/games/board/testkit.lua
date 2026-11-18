-- testkit.lua
-- Part of the craftos-mcp examples (MIT).
-- What the board game tests share: it starts the real cabinet beside a scenario, taps its buttons and board squares
-- with monitor_touch events (exactly what a player's touch sends), and waits for the cabinet to get somewhere.
-- The scenario reads the cabinet's own state (kit.S) to know what happened; nothing in the cabinet is mocked.

local kit = {}

-- Every sound the cabinet plays, recorded through a wrapper around the speaker.
kit.sounds = {}
local find = peripheral.find
peripheral.find = function(kind, ...)
  local found = find(kind, ...)
  if kind ~= "speaker" or not found then return found end
  return setmetatable({
    playSound = function(name, volume, pitch)
      kit.sounds[#kit.sounds + 1] = name
      return found.playSound(name, volume, pitch)
    end,
  }, { __index = found })
end

local main = require("cabinet.main")
kit.app = main.app
kit.S = main.app.S

-- Every toast the cabinet puts up, noted as it is set: a toast lasts a second or two of the cabinet's clock, which a
-- busy host can run past before the scenario gets to look at S.toast.
local touchToast
local setToast = kit.app.setToast
kit.app.setToast = function(text, ...)
  touchToast = text
  return setToast(text, ...)
end

--- The last toast the cabinet put up since the last touch, or nil.
function kit.toast() return touchToast end
kit.rules = function(id) return require("games." .. id .. ".rules") end
kit.plugin = function(id) return require("games." .. id .. ".plugin") end

--- Wait until condition() is true, or limit seconds have passed. Returns the condition's last answer.
function kit.waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < (limit or 10) do sleep(0.1) end
  return condition()
end

local function wall(index)
  return kit.app.env.walls[index or 1]
end

--- Let the cabinet take every event queued so far. It handles a touch and redraws as soon as it gets the event, so an
--- event queued behind the touch comes back only once the cabinet is done with it. A sleep instead let the cabinet's
--- own clock run on by however long a busy machine took to wake the scenario: a toast could be gone, or a computer
--- move made, before the scenario looked.
function kit.settle()
  os.queueEvent("testkit_settle")
  os.pullEvent("testkit_settle")
end

--- Touch the monitor at a surface cell (0-based, as the cabinet draws). wallIndex 1 is the main wall.
--- A player's pace goes before the touch (sounds and animations play out as they would), and the cabinet has taken
--- the touch when this returns, so what the scenario reads next is what the touch did.
function kit.touch(px, py, wallIndex)
  sleep(0.2)
  touchToast = nil
  os.queueEvent("monitor_touch", wall(wallIndex).name, px + 1, py + 1)
  kit.settle()
end

--- The button with this id (and data, if given) on a wall, or nil.
function kit.button(id, data, wallIndex)
  for _, b in ipairs(wall(wallIndex).buttons) do
    if b.id == id and (data == nil or b.data == data) and b.enabled then return b end
  end
  return nil
end

--- Tap the middle of a button. Fails the scenario if the button is not on the wall.
function kit.tap(id, data, wallIndex)
  local b = kit.waitFor(function() return kit.button(id, data, wallIndex) end, 5)
  if not b then error("no " .. id .. (data and (" " .. tostring(data)) or "") .. " button on wall " .. (wallIndex or 1), 2) end
  kit.touch(b.x + math.floor(b.w / 2), b.y + math.floor(b.h / 2), wallIndex)
end

--- Tap the middle of grid cell (col, row) of the current game's board.
function kit.tapCell(col, row, wallIndex)
  local L = kit.app.env.L
  kit.touch(L.colX[col] + math.floor(L.cw / 2), L.rowY[row] + math.floor(L.ch / 2), wallIndex)
end

--- The match being played (or the one just finished).
function kit.match() return kit.S.match or kit.S.finalMatch end

--- From any screen to the lobby of one game: touch the idle screen, then the game's tile on the menu.
function kit.openGame(id, wallIndex)
  kit.waitFor(function() return kit.S.view == "idle" and wall(wallIndex) and #wall(wallIndex).buttons > 0 end, 10)
  kit.touch(5, 5, wallIndex)
  kit.waitFor(function() return kit.S.view == "menu" end, 5)
  kit.tap("game", id, wallIndex)
  kit.waitFor(function() return kit.S.view == "lobby" end, 5)
end

--- Set both seats in the lobby: "player" or a computer level. Each is tapped from the wall given (default 1).
function kit.seats(red, blue, redWall, blueWall)
  kit.tap("redSeat", red, redWall)
  kit.tap("blueSeat", blue, blueWall)
end

--- START, and wait for the match to begin.
function kit.start(wallIndex)
  kit.tap("start", nil, wallIndex)
  return kit.waitFor(function() return kit.S.view == "game" and kit.S.match ~= nil end, 5)
end

--- Wait for the side to move to be seat (and no computer to be thinking). False if the match ends first.
function kit.waitTurn(seat, limit)
  kit.waitFor(function()
    local g = kit.S.match
    return not g or (g.state.turn == seat and not g.thinking)
  end, limit or 20)
  local g = kit.S.match
  return g ~= nil and g.state.turn == seat and not g.thinking
end

--- Wait for the match to end: the final board is up.
function kit.waitEnd(limit)
  return kit.waitFor(function() return kit.S.view == "final" end, limit or 60)
end

--- Run the cabinet with a scenario beside it. The cabinet stops when the scenario returns.
-- opts.thinkMs: the least time a computer move takes. Returns nil, or the error that stopped the scenario or the
-- cabinet.
function kit.run(scenario, opts)
  opts = opts or {}
  local dir = fs.getDir(shell.getRunningProgram())
  local problem
  parallel.waitForAny(function()
    local ok, err = pcall(main.run, { registry = require("games.registry"), dir = dir, thinkMs = opts.thinkMs })
    problem = ok and "the cabinet stopped" or ("cabinet: " .. tostring(err))
  end, function()
    kit.waitFor(function() return kit.app.env.walls[1] ~= nil end, 10)
    local ok, err = pcall(scenario)
    if not ok then problem = "scenario: " .. tostring(err) end
  end)
  return problem
end

--- How many times a sound was played.
function kit.played(name)
  local n = 0
  for _, s in ipairs(kit.sounds) do
    if s == name then n = n + 1 end
  end
  return n
end

return kit
