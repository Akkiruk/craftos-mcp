-- events.lua
-- Part of the craftos-mcp showcase recorder (scripts/make-showcase.mjs).
-- Runs first on each recorded computer. It logs every monitor touch (and the marks the drivers make) to /events.log so
-- the recorder can draw a ring where each tap lands. Nothing about the games changes: os.queueEvent still queues the
-- same event, it just notes it on the way.

local queue = os.queueEvent

local function log(line)
  local f = fs.open("/events.log", "a")
  if f then
    f.writeLine(line)
    f.close()
  end
end

function os.queueEvent(name, a, b, c, ...)
  if name == "monitor_touch" then log("tap " .. tostring(a) .. " " .. tostring(b) .. " " .. tostring(c)) end
  return queue(name, a, b, c, ...)
end

--- A mark for the recorder: "go" starts the video, "still" saves a thumbnail, "done" ends it.
function _G.mark(what) log(what) end

--- A small random source the drivers pass to the games' bots, so every run plays a little differently.
function _G.rng(n)
  if n then return math.random(n) end
  return math.random()
end

--- Wait for a condition, for up to limit seconds.
function _G.waitFor(condition, limit)
  local started = os.clock()
  local value = condition()
  while not value and os.clock() - started < (limit or 10) do
    sleep(0.05)
    value = condition()
  end
  return value
end

--- The scene's settings, written by the recorder.
function _G.showcaseConfig()
  local f = fs.open("/showcase.json", "r")
  local cfg = textutils.unserialiseJSON(f.readAll())
  f.close()
  return cfg
end
