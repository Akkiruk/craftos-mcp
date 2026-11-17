-- Runs badge_door.lua against badge_door.world.json: players walk up to the scanner with good, forged and far-off
-- badges, and the test watches the door's redstone and the guard post's antenna.

local crypto = peripheral.wrap("left")
local guard = peripheral.wrap("guardpost")

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end

local function waitFor(condition, limit)
  for _ = 1, limit * 4 do
    if condition() then return true end
    sleep(0.25)
  end
  return condition()
end

-- the badges, made with the door's own command (it writes /door.key on first use)
local function issue(name)
  local out = {}
  local print0 = _G.print
  _G.print = function(text) out[#out + 1] = text end
  shell.run("examples/classic-peripherals/badge_door.lua", "issue", name)
  _G.print = print0
  return out[1]
end
local alice = issue("alice")
local forged = "mallory:" .. crypto.encodeBase64(("x"):rep(64))

-- the scanner at (10, 64, 10) faces north: it reads around (10, 64, 9)
local function player(name, badge, dz)
  return { kind = "player", name = name, x = 10.5, y = 64, z = 9 - dz, inventory = { badge } }
end

local seen = {}
local heard = {}

local function scenario()
  sleep(1)
  seen.closedAtStart = redstone.getOutput("back")
  sim({ cmd = "cpSetEntities", entities = { player("mallory", forged, 1) } })
  sleep(2.5)
  seen.forged = redstone.getOutput("back")
  sim({ cmd = "cpSetEntities", entities = { player("alice", alice, 6) } })
  sleep(2.5)
  seen.tooFar = redstone.getOutput("back")
  sim({ cmd = "cpSetEntities", entities = { player("alice", alice, 1) } })
  seen.opened = waitFor(function() return redstone.getOutput("back") end, 5)
  sim({ cmd = "cpSetEntities", entities = {} })
  seen.closedAgain = waitFor(function() return not redstone.getOutput("back") end, 5)
end

local function listen()
  while true do
    local _, side, message, distance = os.pullEvent("radio_message")
    heard[#heard + 1] = { side = side, message = message, distance = distance }
  end
end

parallel.waitForAny(function() shell.run("examples/classic-peripherals/badge_door.lua") end, scenario, listen)

ccunit.test("badges are signed with the door's key", function()
  ccunit.truthy(alice and alice:match("^alice:"), tostring(alice))
  local signature = crypto.decodeBase64(alice:sub(7))
  ccunit.eq(#signature, 64)
end)

ccunit.test("a forged or far-off badge keeps the door shut", function()
  ccunit.eq(seen.closedAtStart, false)
  ccunit.eq(seen.forged, false)
  ccunit.eq(seen.tooFar, false)
end)

ccunit.test("alice's badge opens it and it shuts when she leaves", function()
  ccunit.eq(seen.opened, true)
  ccunit.eq(seen.closedAgain, true)
end)

ccunit.test("the guard post hears who came in", function()
  ccunit.eq(guard.getFrequency(), 1471)
  ccunit.eq(#heard, 1)
  ccunit.eq(heard[1].side, "guardpost")
  ccunit.eq(heard[1].message, "door opened for alice")
  -- 0.6.6 measures across the ground: the tower's head is 190 blocks east
  ccunit.eq(heard[1].distance, 190)
end)
