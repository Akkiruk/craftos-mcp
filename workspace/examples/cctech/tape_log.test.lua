-- tape_log.lua on a locked reel to reel (tape_log.world.json), then every CCTech method: both drives, the card writer
-- and the reader's event. A tape operation finishes on a later server tick, so these tests take real seconds.
local T, eq, ok = ccunit.test, ccunit.eq, ccunit.truthy
local reel, deck, writer = peripheral.wrap("right"), peripheral.wrap("left"), peripheral.wrap("back")
local function err(fn, ...)
  local okc, e = pcall(fn, ...)
  if okc then error("expected an error", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local lines = {}
local function run(...)
  local env = setmetatable({ print = function(...) lines[#lines + 1] = table.concat({ ... }, " ") end }, { __index = _ENV })
  return assert(loadfile("examples/cctech/tape_log.lua", nil, env))(...)
end

T("the log program writes and lists records", function()
  run("add", "boot", "ok")
  run("add", "door opened")
  lines = {}
  run("list")
  eq(lines, { "1 boot ok", "2 door opened", "2 records" })
end)

T("types and method lists", function()
  eq(peripheral.getType("right"), "reel_to_reel")
  eq(peripheral.getType("left"), "cassette_deck")
  eq(peripheral.getType("back"), "magnetic_card_reader")
  eq(peripheral.getType("top"), "magnetic_card_reader")
  eq(#peripheral.getMethods("right"), 10)
  eq(#peripheral.getMethods("left"), 7)
  eq(#peripheral.getMethods("back"), 6)
  eq(peripheral.getMethods("top"), {})
end)

T("cassette: a fixture tape's data, read, write, seek, size, labels", function()
  eq(deck.isReady(), true)
  eq(deck.getSize(), 64)
  eq(deck.read(5), "HELLO")
  eq(deck.seek(-5), -5)
  eq(deck.read(), "H")
  eq(deck.seek(-100), -1) -- clamped at the start
  eq(deck.write("hey"), true)
  deck.seek(-3)
  eq(deck.read(3), "hey")
  eq(deck.seek(1000), 61) -- clamped at the end
  eq(err(deck.read, 1), "Attempt to read past tape end.")
  eq(deck.write("x"), false) -- at the very end: the overflow branch writes 0 bytes and says false
  deck.seek(-2)
  -- two bytes from the end: the mod works out pointer - maxPointer = -2 bytes to copy
  eq(err(deck.write, "xyz"), "Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: arraycopy: length -2 is negative")
  eq(err(deck.read, 0), "Cannot read <1 bytes.")
  eq(select("#", deck.setLabel("songs")), 0)
  eq(select("#", deck.clearLabel()), 0)
end)

T("async calls return at once; the event follows", function()
  deck.seek(-1000)
  eq(deck.read(2, true), true)
  local ev, side, okv, value = os.pullEvent("tape_read")
  eq({ ev, side, okv, value }, { "tape_read", "left", true, "he" })
  eq(deck.write("Z", true), true)
  eq({ select(2, os.pullEvent("tape_write")) }, { "left", true, true })
  eq(deck.seek(3, true), true)
  eq({ select(2, os.pullEvent("tape_seek")) }, { "left", true, 3 })
end)

T("reel to reel: position, seekAbs, lock", function()
  eq(reel.getPos() >= 0, true)
  local p = reel.getPos()
  eq(reel.seekAbs(10), 10 - p)
  eq(reel.getPos(), 10)
  reel.seekAbs(0)
  eq(reel.getPos(), 0)
  eq(reel.lock(false), false)
  eq(reel.isReady(), false)
  sleep(0.1) -- the block unlocks on its next tick
  eq(err(reel.read, 1), "Door unlocked")
  eq(reel.lock(), true) -- no argument: toggles
  eq(err(reel.read, 1), "Door unlocked") -- the block's LOCKED follows on its next tick
  sleep(0.1)
  eq(reel.read(2) ~= nil, true)
end)

T("argument errors", function()
  eq(err(deck.read, "x"), "bad argument #1 (number expected, got string)")
  eq(err(deck.read, 1, 1), "bad argument #2 (boolean expected, got number)")
  eq(err(deck.write), "bad argument #1 (string expected, got nil)")
  eq(err(deck.seek), "bad argument #1 (number expected, got nil)")
  eq(err(reel.seekAbs, 1.5), "bad argument #1 (number has no integer representation)")
  eq(err(reel.lock, "y"), "bad argument #1 (boolean expected, got string)")
  eq(err(writer.writeCard), "bad argument #1 (string expected, got nil)")
end)

T("card writer: write, read, labels, uuid", function()
  eq(writer.getUUID(), "11111111-2222-4333-8444-555555555555")
  eq(writer.readCard(), nil) -- a blank card
  eq(select("#", writer.writeCard("staff:42")), 0)
  eq(writer.readCard(), { uuid = "11111111-2222-4333-8444-555555555555", contents = "staff:42" })
  writer.setLabel("Alice")
  eq(writer.getLabel(), "Alice")
  eq(writer.clearLabel(), true)
  eq(select("#", writer.getLabel()), 1)
end)
