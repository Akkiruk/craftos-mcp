-- testkit.lua
-- Part of the craftos-mcp examples (MIT).
-- What every versus test shares. A test runs on one computer (the host, player 1) and starts the cabinet there beside a
-- scenario, the way versus.lua does, playing it with real monitor_touch events. The second computer runs peer.lua: the
-- same cabinet, with a stand-in player who joins when asked and plays player 2's side. The peer reports what its own
-- wall is showing over rednet a few times a second, so a test can check both screens of one match.

local kit = {}

kit.root = fs.getDir(shell.getRunningProgram())
package.path = "/" .. fs.combine(kit.root, "?.lua") .. ";" .. package.path

kit.shell = require("lib.shell")
kit.ui = require("lib.ui")
kit.S = kit.shell.S
kit.games = require("games.list")
kit.sounds = {}
kit.REPORT = "craftos-versus-test" -- the protocol peer.lua reports on

local DATA = "/.test-records"
local monitorName
local report = nil   -- the peer's latest report

function kit.waitFor(condition, limit)
  local started = os.clock()
  local value = condition()
  while not value and os.clock() - started < limit do
    sleep(0.05)
    value = condition()
  end
  return value
end

function kit.tap(px, py, pause)
  os.queueEvent("monitor_touch", monitorName, px + 1, py + 1)
  sleep(pause or 0.15)
end

function kit.button(id, data)
  for _, b in ipairs(kit.ui.buttons()) do
    if b.id == id and (data == nil or b.data == data) then return b end
  end
  return nil
end

function kit.press(id, data, pause)
  local b = kit.button(id, data)
  if not b then return false end
  kit.tap(b.x + math.floor(b.w / 2), b.y + math.floor(b.h / 2), pause)
  return true
end

function kit.game(id)
  for i, plugin in ipairs(kit.games) do
    if plugin.id == id then return plugin, i end
  end
end

--- From the idle screen to a game's ready screen.
function kit.open(id)
  local _, index = kit.game(id)
  kit.waitFor(function() return kit.S.view == "idle" end, 10)
  kit.tap(60, 40)
  kit.waitFor(function() return kit.S.view == "menu" end, 5)
  kit.press("game", index)
  return kit.waitFor(function() return kit.S.view == "ready" and kit.S.game.id == id end, 5)
end

--- The match in play, or nil.
function kit.match() return kit.S.match end

--- The other cabinet's latest report of its own screen, or nil if it hasn't sent one.
function kit.peer() return report end

--- Wait until the other cabinet's report passes check(report).
function kit.waitPeer(check, limit)
  return kit.waitFor(function() return report ~= nil and check(report) end, limit)
end

--- From the ready screen, ask the other cabinet for a game, and wait for the match to start on both.
function kit.challenge()
  kit.waitFor(function() return kit.button("challenge") ~= nil end, 15)
  kit.press("challenge")
  return kit.waitFor(function() return kit.S.view == "play" end, 20)
end

function kit.quit()
  kit.press("quit")
  kit.press("quit")
  return kit.waitFor(function() return kit.S.view == "final" end, 5)
end

function kit.heard(name)
  local id = require("lib.sound").SOUNDS[name][1]
  for _, played in ipairs(kit.sounds) do
    if played == id then return true end
  end
  return false
end

--- Collect the peer's reports. They arrive as rednet messages the cabinet itself ignores.
local function listen()
  while true do
    local _, msg = rednet.receive(kit.REPORT)
    if type(msg) == "table" then report = msg end
  end
end

--- Run the cabinet beside scenario() until the scenario returns.
function kit.run(scenario)
  if fs.exists(DATA) then fs.delete(DATA) end
  os.setComputerLabel("North")
  local monitor = peripheral.find("monitor")
  if not monitor then error("this test needs a 6x6 monitor (see the README)", 0) end
  monitorName = peripheral.getName(monitor)
  local find = peripheral.find
  peripheral.find = function(kind, ...)
    local found = find(kind, ...)
    if kind ~= "speaker" or not found then return found end
    return setmetatable({
      playSound = function(name, ...)
        kit.sounds[#kit.sounds + 1] = name
        return found.playSound(name, ...)
      end,
    }, { __index = found })
  end
  local failure
  parallel.waitForAny(function()
    kit.shell.run({ root = kit.root, name = "VERSUS", games = kit.games, data = DATA })
  end, listen, function()
    local ok, err = pcall(scenario)
    if not ok then failure = err end
  end)
  peripheral.find = find
  if failure then error(failure, 0) end
end

return kit
