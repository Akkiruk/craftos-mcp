-- Wrong CC:Tweaked code. scripts/check.mjs runs lua-language-server over this file and fails unless every line marked
-- `--> code` gets that diagnostic: the library has to catch mistakes, not only stay quiet. It is never run.

term.setCurserPos(1, 1) --> undefined-field
term.setCursorPos(1) --> missing-parameter
term.setCursorPos("one", 2) --> param-type-mismatch
term.clear(true) --> redundant-parameter
os.pullEvnt() --> undefined-field
os.execute("ls") --> undefined-field
io.popen("ls") --> undefined-field
fs.open("file.txt") --> missing-parameter
http.get() --> missing-parameter
textutils.formatTime() --> missing-parameter
print(colors.grey) --> undefined-field
print(bit.band(1, 3)) --> deprecated
peripheral.find() --> missing-parameter
redstone.setOutput("left") --> missing-parameter
rednet.send("everyone", "hi") --> param-type-mismatch
sleep("a while") --> param-type-mismatch
undefinedApi.call() --> undefined-global

local monitor = peripheral.find("monitor")
monitor.setTextSize(2) --> undefined-field
monitor.setTextScale() --> missing-parameter

local reactor = peripheral.find("fissionReactorLogicAdapter")
reactor.getTemprature() --> undefined-field

local handle = fs.open("file.txt", "r")
handle.readAll() --> need-check-nil
if handle then
  handle.write("text") --> undefined-field
end

local _, key = os.pullEvent("key")
key:upper() --> undefined-field

local old = os.loadAPI("api.lua") --> deprecated
print(old, turtle and turtle.getItemDetail("first")) --> param-type-mismatch

local expect = require("cc.expect")
expect.expcet(1, "x", "string") --> undefined-field
local pretty = require("cc.pretty")
pretty.text() --> missing-parameter
