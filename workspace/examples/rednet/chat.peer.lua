-- The other end of the chat test: runs the chat as "bob" and answers the first "hello" it hears.
-- Only the examples test starts this; it is not a program to use.

local function bot()
  while true do
    local _, _, message = os.pullEvent("rednet_message")
    if type(message) == "table" and message.kind == "say" and tostring(message.text):find("hello", 1, true) then
      sleep(0.5)
      for char in ("hi " .. message.name):gmatch(".") do os.queueEvent("char", char) end
      os.queueEvent("key", keys.enter, false)
      return
    end
  end
end

parallel.waitForAll(function() shell.run("examples/rednet/chat.lua", "bob") end, bot)
