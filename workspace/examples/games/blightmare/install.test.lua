-- install.test.lua
-- Part of the craftos-mcp examples (MIT).
-- The installed game (build.mjs's install/) on a computer with CC:Tweaked's default disk, 1,000,000 bytes, and nothing
-- else on it but this test: that it fits with room for saves, that every packed module comes out and compiles, and that
-- it boots from the pack and plays by touch through to a saved game, written to that same small disk.
-- games-blightmare.integration.test.ts builds install/ and gives this test the small disk; on a bigger one it says so.

local here = fs.getDir(shell.getRunningProgram())
local root = fs.combine(here, "install")
local seen = {}
if not fs.exists(fs.combine(root, "blightmare.pak")) then
  error("no install/ here: make it first with node examples/games/blightmare/build.mjs", 0)
end

-- what CC:Tweaked counts: every file its size, but at least 500 bytes, and every folder 500
local function counted(path)
  if fs.isDir(path) then
    local total = 500
    for _, name in ipairs(fs.list(path)) do total = total + counted(fs.combine(path, name)) end
    return total
  end
  return math.max(500, fs.getSize(path))
end

seen.capacity = fs.getCapacity and fs.getCapacity("/")
seen.installed = counted(root)
seen.freeBefore = fs.getFreeSpace("/")

-- load the game the way blightmare.lua does, into this test's own require, so the test can watch the shell
package.path = "/" .. fs.combine(root, "?.lua") .. ";" .. package.path
local pack = dofile("/" .. fs.combine(root, "pack.lua"))
local started = os.epoch("utc")
local names = pack.open("/" .. fs.combine(root, "blightmare.pak"), package, _ENV)
seen.modules = #names
seen.failed = {}
for _, name in ipairs(names) do
  local ok, err = pcall(require, name)
  if not ok then seen.failed[#seen.failed + 1] = name .. ": " .. tostring(err) end
  os.queueEvent("install_test")
  os.pullEvent("install_test")
end
seen.loadMs = os.epoch("utc") - started

local shellLib, ui, rules = require("lib.shell"), require("lib.ui"), require("games.blightmare.rules")
local S = shellLib.S
local monitor = peripheral.find("monitor")
local monitorName = monitor and peripheral.getName(monitor)
local data = fs.combine(root, "saves")

local function waitFor(condition, limit)
  local t0 = os.clock()
  while not condition() and os.clock() - t0 < limit do sleep(0.05) end
  return condition()
end

-- the same touches as testkit.lua (which isn't on this computer): a player's pace before the touch, and the shell has
-- taken it on return (two markers round, as with some mods on the emulator queues a touch a second time)
local function touchNow(px, py)
  os.queueEvent("monitor_touch", monitorName, px + 1, py + 1)
  for _ = 1, 2 do
    os.queueEvent("install_test_settle")
    os.pullEvent("install_test_settle")
  end
end

local function tap(px, py)
  sleep(0.1)
  touchNow(px, py)
end

local function button(id)
  for _, b in ipairs(ui.buttons()) do
    if b.id == id then return b end
  end
end

local function press(id)
  sleep(0.1)
  local b = waitFor(function() return button(id) end, 10)
  if not b then return false end
  touchNow(b.x + math.floor(b.w / 2), b.y + math.floor(b.h / 2))
  return true
end

-- in play a tap only queues its action, taken one a tick: wait until they are all taken
local function drained()
  return waitFor(function()
    local s = S.run and S.run.state
    return not s or s.mode == "battle" or #s.queue == 0
  end, 20)
end

local function act(action)
  local L, s = S.L, S.run.state
  local view = require("games.blightmare.plugin").view
  for py = 0, L.H - 1 do
    for px = 0, L.W - 1, 2 do
      local got = view.actionAt(L, s, px, py)
      if type(got) == "table" and got.kind == action.kind and got.i == action.i and got.dir == action.dir
        and got.x == action.x and got.y == action.y then
        touchNow(px, py)
        drained()
        return true
      end
    end
  end
  return false
end

if monitor then
  parallel.waitForAny(function()
    shellLib.run({ root = root, plugin = require("games.blightmare.plugin"), data = data })
  end, function()
    seen.idle = waitFor(function() return S.view == "idle" and S.demo.run ~= nil end, 10)
    tap(60, 40)
    waitFor(function() return S.view == "intro" end, 3)
    press("skip")
    waitFor(function() return S.view == "ready" end, 3)
    press("start")
    seen.play = waitFor(function() return S.view == "play" end, 3)
    waitFor(function() return S.run.state.mode == "name" end, 3)
    for _, key in ipairs({ 18, 15, 23, 1, 14 }) do act({ kind = "pick", i = key }) end
    act({ kind = "pick", i = rules.NAME_DONE })
    seen.hero = S.run.state.heroName
    local rng = require("lib.rng").rng(5)
    local t0 = os.clock()
    -- the limit only matters when it never signs: a busy host gets through fewer taps a second (play.test.lua: 300)
    while os.clock() - t0 < 300 and not S.run.state.flags.signed do
      local action = rules.bot(S.run.state, rng)
      if action then act(action) end
      sleep(0.05)
    end
    seen.signed = S.run.state.flags.signed
    press("quit")
    press("quit")
    seen.left = waitFor(function() return S.view == "idle" end, 3)
  end)
end
seen.saved = fs.exists(fs.combine(data, "Player.save"))
seen.saveBytes = seen.saved and fs.getSize(fs.combine(data, "Player.save")) or 0
seen.freeAfter = fs.getFreeSpace("/")
print(string.format("installed %d bytes as CC counts them, %d modules loaded in %d ms, %d bytes free after a save of %d",
  seen.installed, seen.modules, seen.loadMs, seen.freeAfter, seen.saveBytes))

ccunit.test("the installed game fits CC:Tweaked's default disk with room to spare", function()
  ccunit.truthy(seen.installed < 1000000, "installed: " .. seen.installed)
  ccunit.truthy(seen.installed < 600000, "installed: " .. seen.installed .. ", less room for saves than there was")
  if seen.capacity and seen.capacity > 1000000 then
    print("note: this disk is " .. seen.capacity .. " bytes; games-blightmare.integration.test.ts runs this on 1,000,000")
  end
end)

ccunit.test("every packed module comes out and loads", function()
  ccunit.truthy(seen.modules >= 40, "only " .. seen.modules .. " modules")
  ccunit.eq(#seen.failed, 0, table.concat(seen.failed, "\n"))
end)

ccunit.test("it boots from the pack and plays by touch to a saved game on the small disk", function()
  ccunit.truthy(monitor, "this test needs a 6x6 monitor")
  ccunit.truthy(seen.idle, "no idle screen")
  ccunit.truthy(seen.play, "START did nothing")
  ccunit.eq(seen.hero, "Rowan")
  ccunit.truthy(seen.signed, "never signed the Dream Book")
  ccunit.truthy(seen.left, "SAVE & QUIT didn't leave")
  ccunit.truthy(seen.saved, "no save on the disk")
  ccunit.truthy(seen.freeAfter > 300000, "only " .. seen.freeAfter .. " bytes left")
end)
