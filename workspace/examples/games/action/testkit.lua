-- testkit.lua
-- Part of the craftos-mcp examples (MIT).
-- What every game's test shares. A test starts the cabinet the way action.lua does, beside a scenario in
-- parallel.waitForAny, and plays it with real monitor_touch events. It loads the shell with the same require, so it can
-- watch the shell's state (shell.S) and the buttons on the wall (ui.buttons()) as it plays: nothing is mocked except the
-- speaker, which is wrapped so the test hears what was played.

local kit = {}

kit.root = fs.getDir(shell.getRunningProgram())
package.path = "/" .. fs.combine(kit.root, "?.lua") .. ";" .. package.path

kit.shell = require("lib.shell")
kit.ui = require("lib.ui")
kit.S = kit.shell.S
kit.games = require("games.list")
kit.sounds = {}  -- every sound the speaker was asked to play, in order

local DATA = "/.test-scores" -- high scores go here, fresh for every test
local monitorName

--- Wait until condition() is true, for up to limit seconds. Returns its last value.
function kit.waitFor(condition, limit)
  local started = os.clock()
  local value = condition()
  while not value and os.clock() - started < limit do
    sleep(0.05)
    value = condition()
  end
  return value
end

--- Touch the wall at surface cell (px, py), 0-based, as a player would, and give the shell a moment.
--- Let the shell take every event queued so far: it handles a touch (and redraws) the moment it gets one, so an event
--- queued behind the touch comes back only when that's done. Twice round: with some mods on, the emulator queues a
--- touch again behind its own touch event, which puts it behind the first marker.
function kit.settle()
  for _ = 1, 2 do
    os.queueEvent("testkit_settle")
    os.pullEvent("testkit_settle")
  end
end

--- In play a tap is only noted: the game's next step acts on it. So the touch is done once the shell has taken it and,
--- in play, the game has stepped since.
local function touchNow(px, py)
  local steps = kit.S.steps or 0
  os.queueEvent("monitor_touch", monitorName, px + 1, py + 1)
  kit.settle()
  if kit.S.view == "play" then
    kit.waitFor(function() return kit.S.view ~= "play" or (kit.S.steps or 0) > steps end, 10)
  end
end

--- Touch the wall at surface cell (px, py), 0-based, and wait until the game has acted on it (see touchNow): what the
--- test reads next is what the touch did. A fixed sleep after the touch raced a busy machine's next step. pause, if
--- given, is a further wait after that.
function kit.tap(px, py, pause)
  touchNow(px, py)
  if pause then sleep(pause) end
end

--- The button on the wall with this id (and data, if given), or nil.
function kit.button(id, data)
  for _, b in ipairs(kit.ui.buttons()) do
    if b.id == id and (data == nil or b.data == data) then return b end
  end
  return nil
end

--- Tap the middle of a button. Returns false if it isn't on the wall.
function kit.press(id, data, pause)
  -- the screen before may still be on its way out: wait for the button, then touch the one found
  local b = kit.waitFor(function() return kit.button(id, data) end, 10)
  if not b then return false end
  touchNow(b.x + math.floor(b.w / 2), b.y + math.floor(b.h / 2))
  if pause then sleep(pause) end
  return true
end

--- The plugin with this id, and its place on the menu.
function kit.game(id)
  for i, plugin in ipairs(kit.games) do
    if plugin.id == id then return plugin, i end
  end
end

--- From the idle screen to a game's ready screen. Returns true once it's there.
function kit.open(id)
  local _, index = kit.game(id)
  kit.waitFor(function() return kit.S.view == "idle" end, 10)
  kit.tap(60, 40)
  kit.waitFor(function() return kit.S.view == "menu" end, 5)
  kit.press("game", index)
  return kit.waitFor(function() return kit.S.view == "ready" and kit.S.game.id == id end, 5)
end

--- START, and wait for the run to begin.
function kit.start()
  kit.press("start")
  return kit.waitFor(function() return kit.S.view == "play" end, 5)
end

--- The run's live state, or nil.
function kit.state()
  return kit.S.run and kit.S.run.state
end

--- QUIT twice, as a player who wants out.
function kit.quit()
  kit.press("quit")
  kit.press("quit")
  return kit.waitFor(function() return kit.S.view == "final" end, 5)
end

--- Has the speaker been asked for this sound (a name from lib/sound.lua)? A sound that comes right after another waits
--- its turn in the shell's queue, which plays it on a later tick: a busy host can make that later than the moment the
--- test asks, so wait up to `limit` seconds (default 5) for it.
function kit.heard(name, limit)
  local id = require("lib.sound").SOUNDS[name][1]
  return kit.waitFor(function()
    for _, played in ipairs(kit.sounds) do
      if played == id then return true end
    end
    return false
  end, limit or 5)
end

--- Run the cabinet beside scenario() until the scenario returns.
function kit.run(scenario)
  if fs.exists(DATA) then fs.delete(DATA) end
  local monitor = peripheral.find("monitor")
  if not monitor then error("this test needs a 6x6 monitor (see the README)", 0) end
  monitorName = peripheral.getName(monitor)
  -- the speaker the shell finds is a proxy that notes each sound and passes it on
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
    kit.shell.run({ root = kit.root, name = "CLASSICS", games = kit.games, data = DATA })
  end, function()
    local ok, err = pcall(scenario)
    if not ok then failure = err end
  end)
  peripheral.find = find
  if failure then error(failure, 0) end
end

return kit
