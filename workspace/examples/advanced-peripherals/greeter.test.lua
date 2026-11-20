-- Runs greeter.lua against a detector with one player standing next to it and one far away
-- (greeter.world.json). Players walk in and out with sim commands; a wrapper around the chat box
-- records what the greeter says to whom.

-- chat_box from Minecraft 1.21.1 on
local realChat = peripheral.find("chatBox") or peripheral.find("chat_box")
local said = {} -- { to = "Alice", text = "..." }
local chat = setmetatable({}, {
  __index = function(_, name)
    return function(...)
      local results = { realChat[name](...) }
      if name == "sendMessageToPlayer" and results[1] then
        said[#said + 1] = { to = select(2, ...), text = (...) }
      end
      return table.unpack(results)
    end
  end,
})
local find = peripheral.find
peripheral.find = function(kind, ...)
  if kind == "chatBox" or kind == "chat_box" then return chat end
  return find(kind, ...)
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end

local function say(player, message) sim({ cmd = "chat", player = player, message = message }) end

--- The messages `player` has received so far.
local function heardBy(player)
  local texts = {}
  for _, m in ipairs(said) do
    if m.to == player then texts[#texts + 1] = m.text end
  end
  return texts
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.25) end
  return condition()
end

local seen = {}

local function scenario()
  -- Alice is in range from the start and is welcomed once; Bob is too far away
  waitFor(function() return #heardBy("Alice") >= 1 end, 20)
  sleep(5) -- several more looks: she must not be greeted again while she stays
  seen.alice = heardBy("Alice")
  seen.bob = heardBy("Bob")

  -- Bob walks up
  sim({ cmd = "setPlayerPos", player = "Bob", x = 5, y = 64, z = 5 })
  waitFor(function() return #heardBy("Bob") >= 1 end, 20)
  seen.bobWelcome = heardBy("Bob")

  -- Chat commands. Each answer waits a server tick for the detector, and the chat box's 100 ms between messages: on a
  -- 20x clock a busy host can spend ten seconds of it on that, so the limits are wide (they only cost time on a failure)
  say("Alice", "!players")
  waitFor(function() return #heardBy("Alice") >= 2 end, 60)
  seen.players = heardBy("Alice")[2]
  say("Bob", "!where")
  waitFor(function() return #heardBy("Bob") >= 2 end, 60)
  seen.where = heardBy("Bob")[2]

  -- Bob leaves and comes back: greeted again
  sim({ cmd = "setPlayerPos", player = "Bob", x = 90, y = 64, z = 0 })
  sleep(5)
  sim({ cmd = "setPlayerPos", player = "Bob", x = 5, y = 64, z = 5 })
  waitFor(function() return #heardBy("Bob") >= 3 end, 20)
  seen.bobAgain = #heardBy("Bob")
end

parallel.waitForAny(function() shell.run("examples/advanced-peripherals/greeter.lua") end, scenario)

ccunit.test("a player in range is welcomed once", function()
  ccunit.eq(#seen.alice, 1)
  ccunit.truthy(seen.alice[1]:find("Welcome, Alice!", 1, true), seen.alice[1])
end)

ccunit.test("a player out of range hears nothing until they walk up", function()
  ccunit.eq(#seen.bob, 0)
  ccunit.truthy(seen.bobWelcome[1]:find("Welcome, Bob!", 1, true), seen.bobWelcome[1])
end)

ccunit.test("!players lists everyone in range", function()
  ccunit.eq(seen.players, "2 player(s) in range: Alice, Bob")
end)

ccunit.test("!where gives the player's own position", function()
  ccunit.eq(seen.where, "You are at 5, 64, 5.")
end)

ccunit.test("a player who left and returned is greeted again", function()
  ccunit.eq(seen.bobAgain, 3)
end)
