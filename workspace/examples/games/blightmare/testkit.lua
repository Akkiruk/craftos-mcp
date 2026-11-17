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

--- Touch the wall at surface cell (px, py), 0-based, as a player would, and give the shell a moment.
function kit.tap(px, py, pause)
  os.queueEvent("monitor_touch", monitorName, px + 1, py + 1)
  sleep(pause or 0.15)
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
  local b = kit.button(id, data)
  if not b then return false end
  kit.tap(b.x + math.floor(b.w / 2), b.y + math.floor(b.h / 2), pause)
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

--- Tap the wall where the game reads this action. Returns false if no spot on the wall gives it.
function kit.act(action, pause)
  local px, py = kit.spotFor(action)
  if not px then return false end
  kit.tap(px, py, pause)
  return true
end

--- Did the speaker get asked for this sound (a name from lib/sound.lua)?
function kit.heard(name)
  local id = require("lib.sound").SOUNDS[name][1]
  for _, played in ipairs(kit.sounds) do
    if played == id then return true end
  end
  return false
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
