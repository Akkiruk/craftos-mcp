-- Runs porch.lua against porch.world.json (Minecraft 1.20.1, Ducky Peripherals 1.20.1-1.3.1) and moves the world
-- with sim commands: players come and go, the weather turns, something steps near the sculkophone, then q on the
-- keyboard stops the program. Afterwards every method is called directly.

local width, height = term.getSize()
local screen = window.create(term.current(), 1, 1, width, height, false)

local function screenText()
  local lines = {}
  for y = 1, height do lines[y] = screen.getLine(y) end
  return table.concat(lines, "\n")
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  -- one yield so the sim runs it, without throwing away the events it queues (sleep would)
  os.queueEvent("sim_done")
  os.pullEvent("sim_done")
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.2) end
  return condition()
end
local function shows(text) return function() return screenText():find(text, 1, true) ~= nil end end

local seen = {}

local function program()
  local old = term.redirect(screen)
  shell.run("examples/ducky-peripherals/porch.lua")
  term.redirect(old)
  seen.finished = true
end

local function scenario()
  seen.first = waitFor(shows("Porch"), 10) and screenText()
  sim({ cmd = "duckyAddEntity", entity = { name = "Alex", player = true, x = -1.5, y = 0, z = 6.5 } })
  seen.arrived = waitFor(shows("Alex arrived"), 10)
  seen.twoPlayers = screenText()
  sim({ cmd = "duckyMoveEntity", entity = "Steve", x = 40 })
  seen.left = waitFor(shows("Steve left"), 10)
  sim({ cmd = "duckySetWeather", thundering = true })
  sim({ cmd = "duckyVibration", event = "minecraft:step", distance = 2.5 })
  seen.heard = waitFor(shows("heard step 2.5m away"), 10)
  seen.stormy = screenText()
  sim({ cmd = "duckyChar", char = "q" })
  seen.stopped = waitFor(function() return seen.finished end, 10)
end

parallel.waitForAll(program, scenario)

ccunit.test("the porch shows who is near and the weather", function()
  ccunit.truthy(seen.first, "porch.lua never drew")
  ccunit.truthy(seen.first:find("minecraft:taiga, raining (0.25)", 1, true), seen.first)
  ccunit.truthy(seen.first:find("Players: Steve 4m", 1, true), seen.first)
  ccunit.truthy(seen.first:find("Mobs: 1", 1, true), seen.first) -- the zombie is out of range
end)

ccunit.test("arrivals and departures come as events", function()
  ccunit.truthy(seen.arrived, screenText())
  ccunit.truthy(seen.twoPlayers:find("Alex 7m", 1, true), seen.twoPlayers)
  ccunit.truthy(seen.left, screenText())
end)

ccunit.test("thunder and the sculkophone", function()
  ccunit.truthy(seen.heard, screenText())
  ccunit.truthy(seen.stormy:find("thunderstorm", 1, true), seen.stormy)
end)

ccunit.test("q on the keyboard stops it", function()
  ccunit.truthy(seen.stopped, screenText())
  ccunit.truthy(screenText():find("Porch watch stopped", 1, true), screenText())
end)

-- ===== every method directly =====

ccunit.test("entity_detector.nearbyEntities", function()
  local d = peripheral.wrap("entity_detector_0")
  ccunit.eq(peripheral.getType("entity_detector_0"), "entity_detector")
  ccunit.eq(peripheral.getMethods("entity_detector_0"), { "nearbyEntities" })
  local list = d.nearbyEntities("ignored", 1) -- no parameters: extra arguments are ignored
  ccunit.eq(#list, 2)
  ccunit.eq(list[1].type, "Cow")
  ccunit.eq(list[1].isPlayer, false)
  ccunit.eq(list[2], { uuid = list[2].uuid, name = "Alex", isPlayer = true, type = "Player", x = -1.5, y = 0, z = 6.5 })
end)

ccunit.test("entity events carry the peripheral name and a table", function()
  sim({ cmd = "duckyMoveEntity", entity = "Steve", x = 3.5 })
  local event, name, e = os.pullEvent("new_entity")
  ccunit.eq({ event, name }, { "new_entity", "entity_detector_0" })
  ccunit.eq(e, { uuid = "8667ba71-b85a-4004-af54-457a9734eed7", name = "Steve", isPlayer = true, type = "Player",
    x = 3.5, y = 0, z = -2.5 })
  sim({ cmd = "duckyRemoveEntity", entity = "Alex" })
  local _, name2, e2 = os.pullEvent("removed_entity")
  ccunit.eq({ name2, e2.name }, { "entity_detector_0", "Alex" })
end)

ccunit.test("weather_machine", function()
  local w = peripheral.wrap("weather_machine_0")
  ccunit.eq(peripheral.getMethods("weather_machine_0"),
    { "canSnow", "getBiome", "getTemperature", "isPrecipitating", "isRaining", "isSnowing", "isThundering" })
  ccunit.eq(w.getBiome(), "minecraft:taiga")
  ccunit.eq(w.getTemperature(), 0.25)
  ccunit.eq({ w.isRaining(), w.isThundering(), w.isPrecipitating(), w.isSnowing(), w.canSnow() },
    { true, true, true, false, false })
  sim({ cmd = "duckySetBiome", biome = "minecraft:snowy_taiga", temperature = -0.5 })
  ccunit.eq(w.getTemperature(), -0.5)
  ccunit.eq({ w.isRaining(), w.isSnowing(), w.canSnow(), w.isPrecipitating() }, { false, true, true, true })
  sim({ cmd = "duckySetBiome", biome = "minecraft:desert", temperature = 2, precipitation = "none" })
  ccunit.eq({ w.isRaining(), w.isSnowing(), w.canSnow(), w.isPrecipitating() }, { false, false, false, false })
  sim({ cmd = "duckySetBiome", temperature = 0.8, precipitation = "rain" })
  ccunit.eq(w.getTemperature(), 0.800000011920929) -- a Java float
  sim({ cmd = "duckySetWeather", raining = false })
  ccunit.eq({ w.isRaining(), w.isThundering(), w.isPrecipitating() }, { false, false, false })
end)

ccunit.test("keyboard: events only, with its name last", function()
  ccunit.eq(peripheral.getType("keyboard_0"), "keyboard")
  ccunit.eq(peripheral.getMethods("keyboard_0"), {})
  sim({ cmd = "duckyKey", key = "enter", ["repeat"] = true })
  ccunit.eq({ os.pullEvent("key") }, { "key", keys.enter, true, "keyboard_0" })
  sim({ cmd = "duckyKeyUp", key = keys.a })
  ccunit.eq({ os.pullEvent("key_up") }, { "key_up", keys.a, "keyboard_0" })
  sim({ cmd = "duckyType", text = "hi" })
  ccunit.eq({ os.pullEvent("char") }, { "char", "h", "keyboard_0" })
  ccunit.eq({ os.pullEvent("char") }, { "char", "i", "keyboard_0" })
  sim({ cmd = "duckyKeyboardEvent", event = "terminate" })
  ccunit.eq({ os.pullEventRaw("terminate") }, { "terminate", "keyboard_0" })
end)

ccunit.test("sculkophone: one vibration, then 21 ticks deaf", function()
  ccunit.eq(peripheral.getMethods("sculkophone_0"), {})
  sleep(1.2) -- the porch's vibration has worn off
  sim({ cmd = "duckyVibration", event = "block_place", distance = 1.1 })
  ccunit.eq({ os.pullEvent("vibration") }, { "vibration", "sculkophone_0", "block_place", 1.100000023841858 })
  sim({ cmd = "duckyVibration", event = "step", distance = 1 }) -- still active: not heard
  sim({ cmd = "duckyVibration", event = "step", distance = 9 }) -- out of range anyway
  local timer = os.startTimer(0.5)
  local event = os.pullEvent()
  while event ~= "timer" and event ~= "vibration" do event = os.pullEvent() end
  ccunit.eq(event, "timer")
end)
