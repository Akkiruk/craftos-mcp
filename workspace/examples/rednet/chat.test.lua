-- Runs chat.lua as "alice" on one computer of a two-computer network; the other computer runs
-- chat.peer.lua ("bob"), which answers the first hello. examples.integration.test.ts sets the
-- network up (two wireless modems in range of each other); without a modem there is nothing to
-- chat with and the test only says so.

if not peripheral.find("modem") then
  ccunit.test("needs two computers with modems (run by examples.integration.test.ts)", function() end)
  return
end

-- The program draws on a window over the terminal, so the test can read the screen back.
local width, height = term.getSize()
local screen = window.create(term.current(), 1, 1, width, height)
local original = term.redirect(screen)

local function screenText()
  local lines = {}
  for y = 1, height do lines[y] = screen.getLine(y) end
  return table.concat(lines, "\n")
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.25) end
  return condition()
end

--- Type a line the way a player does: one char event per letter, then Enter.
local function typeLine(text)
  for char in text:gmatch(".") do os.queueEvent("char", char) end
  os.queueEvent("key", keys.enter, false)
  sleep(0.5)
end

local seen = {}

local function scenario()
  -- bob may have started first; /who answers once alice has heard his "here" reply
  seen.foundBob = waitFor(function()
    typeLine("/who")
    return screenText():find("alice, bob", 1, true)
  end, 30)

  typeLine("hello bob")
  seen.sent = screenText()
  seen.gotReply = waitFor(function() return screenText():find("bob: hi alice", 1, true) end, 30)
  seen.afterReply = screenText()

  -- Type a letter and take it back
  os.queueEvent("char", "x")
  sleep(0.5)
  seen.whileTyping = screenText()
  os.queueEvent("key", keys.backspace, false)
  sleep(0.5)
  seen.afterBackspace = screenText()
end

parallel.waitForAny(function() shell.run("examples/rednet/chat.lua", "alice") end, scenario)
term.redirect(original)

ccunit.test("the title shows who you chat as", function()
  ccunit.truthy(seen.sent:find("Chat as alice", 1, true), seen.sent)
end)

ccunit.test("it finds the other computer", function()
  ccunit.truthy(seen.foundBob, "never heard bob")
end)

ccunit.test("what you send appears on your own screen", function()
  ccunit.truthy(seen.sent:find("alice: hello bob", 1, true), seen.sent)
end)

ccunit.test("the other computer's answer arrives", function()
  ccunit.truthy(seen.gotReply, seen.afterReply)
end)

ccunit.test("typing shows in the input row and backspace deletes it", function()
  ccunit.eq(seen.whileTyping:sub(-width):match("^> x"), "> x")
  ccunit.eq(seen.afterBackspace:sub(-width):match("^> *$"), "> " .. (" "):rep(width - 2))
end)
