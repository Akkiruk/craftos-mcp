-- testkit.lua
-- Part of the craftos-mcp examples (MIT).
-- What the tests share. A test that plays starts the game the way blightmare.lua does, beside a scenario in
-- parallel.waitForAny, and plays it with real monitor_touch events. It loads the shell with the same require, so it can
-- watch the shell's state (shell.S) and the buttons on the wall (ui.buttons()) as it plays: nothing is mocked except the
-- speaker, which is wrapped so the test hears what was played. A test of the rules alone only needs kit.root and
-- package.path, which loading this file sets.

local kit = {}

-- the game's folder: the test's own, or the one above it for the tests in tests/
kit.root = fs.getDir(shell.getRunningProgram())
if fs.getName(kit.root) == "tests" then kit.root = fs.getDir(kit.root) end
package.path = "/" .. fs.combine(kit.root, "?.lua") .. ";" .. package.path

kit.rng = require("lib.rng")
kit.sounds = {} -- every sound the speaker was asked to play, in order

kit.DATA = "/.test-saves" -- saves go here, fresh for every test
local monitorName

--- The shell and the drawing module, loaded only by a test that plays.
function kit.load()
  kit.shell = require("lib.shell")
  kit.ui = require("lib.ui")
  kit.S = kit.shell.S
  kit.plugin = require("games.blightmare.plugin")
  return kit
end

--- A surface to draw on, for a test of the pictures without the shell: the wall's own size.
function kit.screen(W, H)
  local surface = require("lib.surface")
  local font = surface.loadFont(surface.load("/" .. fs.combine(kit.root, "lib/font")))
  local ui = require("lib.ui")
  ui.init(surface, font, surface.create(W or 121, H or 81))
  return ui, surface, font
end

--- Give the rest of the computer a turn, in a long loop of pure Lua.
function kit.breathe()
  os.queueEvent("testkit_breathe")
  os.pullEvent("testkit_breathe")
end

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

--- Let the shell take every event queued so far: it handles a touch (and redraws) the moment it gets one, so an event
--- queued behind the touch comes back only when that's done. A fixed sleep instead let the game's clock run on for as
--- long as a busy machine took to wake the scenario. Twice round: with some mods on, the emulator queues a touch
--- again behind its own touch event, which puts it behind the first marker.
function kit.settle()
  for _ = 1, 2 do
    os.queueEvent("testkit_settle")
    os.pullEvent("testkit_settle")
  end
end

--- In play a tap only queues its action: the game takes one a tick. Wait until it has taken them all (a fight takes
--- its taps at once and never queues), so whoever looks next sees the state the taps made.
function kit.drained(limit)
  return kit.waitFor(function()
    local s = kit.state()
    return not s or s.mode == "battle" or not s.queue or #s.queue == 0
  end, limit or 20)
end

local function touchNow(px, py)
  os.queueEvent("monitor_touch", monitorName, px + 1, py + 1)
  kit.settle()
end

--- Touch the wall at surface cell (px, py), 0-based, as a player would. A player's pace (pause, default 0.1 s) goes
--- before the touch; the shell has taken the touch when this returns, so what the test reads next is what it did.
function kit.tap(px, py, pause)
  sleep(pause or 0.1)
  touchNow(px, py)
end

--- The button on the wall with this id (and data, if given), or nil.
function kit.button(id, data)
  for _, b in ipairs(kit.ui.buttons()) do
    if b.id == id and (data == nil or b.data == data) then return b end
  end
  return nil
end

--- Tap the middle of a button, once it is on the wall (the screen before it may still be on its way out). Returns
--- false if it never shows. The pause goes first, so the button found is the one touched.
function kit.press(id, data, pause)
  sleep(pause or 0.1)
  local b = kit.waitFor(function() return kit.button(id, data) end, 10)
  if not b then return false end
  touchNow(b.x + math.floor(b.w / 2), b.y + math.floor(b.h / 2))
  return true
end

--- The game's live state, or nil.
function kit.state()
  return kit.S.run and kit.S.run.state
end

--- Where on the wall (surface cell, 0-based) a tap gives this action, by asking the game's own view: nil if nowhere.
--- Searches every other cell, which is quick enough for a test.
function kit.spotFor(action)
  local L, s = kit.S.L, kit.state()
  local view = kit.plugin.view
  local function same(got)
    if type(got) ~= "table" or got.kind ~= action.kind then return false end
    for k, v in pairs(action) do
      if got[k] ~= v then return false end
    end
    return true
  end
  for py = 0, L.H - 1 do
    for px = 0, L.W - 1, 2 do
      if same(view.actionAt(L, s, px, py)) then return px, py end
    end
  end
  return nil
end

--- Tap the wall where the game reads this action, and wait until the game has taken it. Returns false if no spot on
--- the wall gives it.
function kit.act(action, pause)
  -- the action was chosen from the state as it is now: tap at once, and pause (if asked) after
  local px, py = kit.spotFor(action)
  if not px then return false end
  touchNow(px, py)
  kit.drained()
  if pause then sleep(pause) end
  return true
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

--- Run the game beside scenario() until the scenario returns. o.preload: load every part first, as the game does.
function kit.run(scenario, o)
  o = o or {}
  kit.load()
  if fs.exists(kit.DATA) and not o.keepSaves then fs.delete(kit.DATA) end
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
    kit.shell.run({ root = kit.root, plugin = kit.plugin, data = kit.DATA, log = "/.test-blightmare.log", preload = o.preload })
  end, function()
    local ok, err = pcall(scenario)
    if not ok then failure = err end
  end)
  peripheral.find = find
  if failure then error(failure, 0) end
end

return kit
