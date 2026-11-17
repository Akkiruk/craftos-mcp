-- Correct CC:Tweaked code, the way people write it. scripts/check.mjs runs lua-language-server over this file and
-- fails on any undefined name, wrong argument count or type mismatch: each one would be a mistake in the library.
-- It is never run.

-- ===== globals =====
print("a", 1, true, nil)
write("text")
printError("bad", 2)
sleep(0.5)
sleep()
local line = read()
local secret = read("*")
local picked = read(nil, { "one", "two" }, function(text) return { text .. "x" } end, "default")
print(line:upper(), secret:len(), picked:sub(1, 2), _HOST, _VERSION)
local chunk = loadstring("return 1")
local fn = load("return 1", "=chunk", "t", {})
local fromFile = loadfile("startup.lua", "t", _ENV)
local fromFileOld = loadfile("startup.lua", _ENV)
print(chunk, fn, fromFile, fromFileOld, unpack({ 1, 2 }), table.unpack({ 1, 2 }), table.pack(1, 2).n)
setfenv(1, getfenv(1))

-- ===== os =====
local timer = os.startTimer(1)
os.cancelTimer(timer)
local alarm = os.setAlarm(6.5)
os.cancelAlarm(alarm)
os.queueEvent("my_event", 1, "two", { 3 })
local event, a, b, c = os.pullEvent()
local name, key, held = os.pullEvent("key")
local _, button, x, y = os.pullEvent("mouse_click")
local _, side, channel, reply, message, distance = os.pullEvent("modem_message")
local raw = { os.pullEventRaw() }
local mine = { os.pullEvent("my_event") }
print(event, a, b, c, name, key + 1, held, button + x + y, side, channel + reply, message, distance, #raw, #mine)
print(os.time(), os.time("utc"), os.time(os.date("*t")), os.day(), os.day("local"), os.epoch("utc"), os.epoch())
print(os.clock(), os.date(), os.date("%H:%M"), os.date("!%c", 0), os.version())
print(os.getComputerID() + 1, os.computerID(), os.getComputerLabel(), os.computerLabel())
os.setComputerLabel("box")
os.setComputerLabel()
os.setComputerLabel(nil)
os.run({}, "/rom/programs/shell.lua", "arg")
os.sleep(0)

-- ===== term, windows, monitors =====
term.clear()
term.setCursorPos(1, 1)
term.setTextColor(colors.white)
term.setTextColour(colours.lightGrey)
term.setBackgroundColor(colors.black)
term.write("text")
term.write(12)
term.blit("abc", "000", "fff")
term.scroll(1)
term.setCursorBlink(true)
term.setPaletteColour(colours.red, 0xff0000)
term.setPaletteColor(colors.red, 1, 0, 0)
local width, height = term.getSize()
local cx, cy = term.getCursorPos()
local r, g, bl = term.getPaletteColor(colors.red)
print(width * height, cx + cy, r + g + bl, term.isColor(), term.isColour(), term.getTextColor(), term.getBackgroundColour())
print(term.nativePaletteColor(colors.red))

local monitor = peripheral.find("monitor")
monitor.setTextScale(0.5)
monitor.clear()
monitor.setCursorPos(1, 1)
monitor.write("hello")
local previous = term.redirect(monitor)
term.redirect(previous)
term.redirect(term.native())
local win = window.create(term.current(), 1, 1, 10, 5)
local hidden = window.create(monitor, 1, 1, 10, 5, false)
win.setVisible(false)
win.write("in a window")
win.setCursorPos(1, 2)
win.setBackgroundColor(colors.blue)
win.clear()
win.reposition(2, 2, 8, 4)
win.redraw()
hidden.setVisible(true)
print(win.getPosition(), win.getLine(1), win.isVisible())
paintutils.drawPixel(1, 1, colors.red)
paintutils.drawLine(1, 1, 5, 5, colors.red)
paintutils.drawBox(1, 1, 5, 5)
paintutils.drawFilledBox(1, 1, 5, 5, colors.blue)
local image = paintutils.loadImage("picture.nfp")
if image then paintutils.drawImage(image, 1, 1) end

-- ===== colours, keys =====
local both = colors.combine(colors.red, colors.blue)
print(colors.test(both, colors.red), colors.subtract(both, colors.red), colors.toBlit(colors.red))
print(colors.packRGB(1, 0, 0), colors.unpackRGB(0xff0000), colours.grey, colours.lightGrey, colors.gray)
print(keys.getName(keys.a), keys.enter, keys.up, keys.leftCtrl, keys.space, keys.one)

-- ===== files =====
local out = fs.open("file.txt", "w")
if out then
  out.write("text")
  out.writeLine("line")
  out.flush()
  out.close()
end
local input = fs.open("file.txt", "r")
if input then
  local all = input.readAll()
  local one = input.readLine()
  print(all, one, input.read(4))
  input.close()
end
local bytes = fs.open("file.bin", "rb")
if bytes then
  local byte = bytes.read()
  local some = bytes.read(10)
  print(byte and byte + 1, some and #some, bytes.seek("set", 0))
  bytes.close()
end
local mode = "r"
local any = fs.open("file.txt", mode)
print(any)
print(fs.exists("a"), fs.isDir("a"), fs.isReadOnly("rom"), fs.getSize("a"), fs.getFreeSpace("/"), fs.getCapacity("/"))
print(fs.combine("a", "b", "c"), fs.getName("a/b"), fs.getDir("a/b"), fs.getDrive("rom"), fs.attributes("a").size)
print(#fs.list("/"), #fs.find("*.lua"), fs.isDriveRoot("/"), #fs.complete("st", "/"), #fs.complete("st", "/", true, false))
fs.makeDir("dir")
fs.copy("a", "b")
fs.move("b", "c")
fs.delete("c")
local file = io.open("file.txt", "r")
if file then
  print(file:read("*a"), file:read("*l"))
  for l in file:lines() do print(l) end
  file:close()
end
for l in io.lines("file.txt") do print(l) end
io.write("a", 1)

-- ===== http =====
local response, failure, failed = http.get("https://example.tweaked.cc")
if response then
  print(response.getResponseCode(), response.readAll(), response.getResponseHeaders()["Content-Type"])
  response.close()
else
  print(failure, failed)
end
local posted = http.post("https://example.tweaked.cc", "body", { ["Content-Type"] = "text/plain" })
local withTable = http.get({ url = "https://example.tweaked.cc", binary = true, timeout = 5 })
local binary = http.get("https://example.tweaked.cc", nil, true)
http.request("https://example.tweaked.cc")
http.request({ url = "https://example.tweaked.cc", method = "PUT", body = "x" })
print(posted, withTable, binary, http.checkURL("https://example.tweaked.cc"))
local socket, why = http.websocket("wss://example.tweaked.cc/echo")
if socket then
  socket.send("hello")
  socket.send("bytes", true)
  print(socket.receive(), socket.receive(5))
  socket.close()
else
  print(why)
end

-- ===== peripherals =====
for _, attached in ipairs(peripheral.getNames()) do
  print(attached, peripheral.getType(attached), peripheral.hasType(attached, "inventory"), peripheral.isPresent(attached))
  local wrapped = peripheral.wrap(attached)
  if wrapped then print(peripheral.getName(wrapped), #peripheral.getMethods(attached)) end
end
print(peripheral.call("left", "getSize"))
local speaker = peripheral.find("speaker")
speaker.playNote("harp", 1, 12)
speaker.playSound("entity.creeper.primed")
speaker.playAudio({ 0, 127, -128 })
speaker.stop()
local modem = peripheral.find("modem", function(_, m) return m.isWireless() end)
modem.open(1)
modem.transmit(1, 2, { hello = "world" })
print(modem.isOpen(1), modem.getNameLocal())
modem.closeAll()
local chest = peripheral.find("inventory")
for slot, item in pairs(chest.list()) do print(slot, item.name, item.count) end
local detail = chest.getItemDetail(1)
print(chest.size(), detail and detail.displayName, chest.pushItems("minecraft:chest_1", 1), chest.pullItems("minecraft:chest_1", 1, 64, 2))
local first, second = peripheral.find("drive")
print(first.isDiskPresent(), second and second.getDiskLabel())
local printer = peripheral.find("printer")
if printer.newPage() then
  printer.write("page")
  printer.setPageTitle("title")
  printer.endPage()
end
local unknown = peripheral.find("some_other_mod:machine")
unknown.whatever(1, 2, 3)
local kind = settings.get("my.kind", "monitor")
local dynamic = peripheral.find(kind)
print(dynamic)
local typed = peripheral.wrap("left") --[[@as cc.Monitor]]
typed.setTextScale(1)

-- ===== redstone =====
for _, s in ipairs(redstone.getSides()) do
  print(redstone.getInput(s), rs.getAnalogInput(s), rs.getBundledInput(s))
end
redstone.setOutput("left", true)
rs.setAnalogOutput("back", 15)
rs.setBundledOutput("top", colors.combine(colors.red, colors.white))
print(rs.testBundledInput("top", colors.red), redstone.getAnalogueOutput("left"))

-- ===== rednet, gps, parallel =====
rednet.open("back")
rednet.send(1, { any = "value" }, "protocol")
rednet.broadcast("to all")
local sender, text, protocol = rednet.receive("protocol", 5)
if sender then print(sender + 1, text, protocol) end
rednet.host("protocol", "name")
print(rednet.lookup("protocol"), rednet.lookup("protocol", "name"), rednet.isOpen(), rednet.isOpen("back"))
rednet.close()
local gx, gy, gz = gps.locate(2)
if gx then print(vector.new(gx, gy, gz):length()) end
parallel.waitForAny(function() sleep(1) end, function() os.pullEvent("key") end)
parallel.waitForAll(function() end)

-- ===== textutils, settings, vector =====
local saved = textutils.serialise({ 1, 2 })
local compact = textutils.serialize({ 1, 2 }, { compact = true })
local json = textutils.serialiseJSON({ a = 1 })
local nbt = textutils.serializeJSON({ a = 1 }, true)
print(textutils.unserialise(saved), textutils.unserialize(compact), textutils.unserialiseJSON(json), textutils.unserializeJSON(nbt, { parse_null = true }))
print(textutils.formatTime(os.time(), true), textutils.urlEncode("a b"), textutils.empty_json_array, textutils.json_null)
textutils.slowPrint("slow")
textutils.tabulate({ "a", "b" }, colors.red, { "c", "d" })
textutils.pagedPrint("long text")
settings.define("my.setting", { description = "A setting", default = 1, type = "number" })
settings.set("my.setting", 2)
print(settings.get("my.setting"), settings.get("my.other", "fallback"), #settings.getNames(), settings.save(), settings.load())
settings.unset("my.setting")
local v = vector.new(1, 2, 3)
local sum = v + vector.new(1, 1, 1)
print(sum.x, (v * 2).y, (-v).z, v:dot(sum), v:cross(sum):normalize():tostring(), v:add(sum):sub(v):round().x)

-- ===== shell, multishell, disk, help =====
shell.run("ls", "rom")
print(shell.dir(), shell.resolve("file"), shell.resolveProgram("ls"), shell.getRunningProgram(), shell.path(), #shell.programs())
shell.setDir("rom")
shell.setAlias("l", "ls")
local tab = shell.openTab("lua")
if tab then shell.switchTab(tab) end
if multishell then
  local launched = multishell.launch({}, "/rom/programs/lua.lua")
  multishell.setTitle(launched, "lua")
  multishell.setFocus(launched)
  print(multishell.getCount(), multishell.getCurrent(), multishell.getFocus(), multishell.getTitle(1))
end
print(disk.isPresent("left"), disk.getMountPath("left"), disk.getLabel("left"), disk.hasData("left"))
print(help.lookup("fs"), #help.topics())

-- ===== turtle, pocket, commands =====
if turtle then
  turtle.select(1)
  turtle.refuel()
  turtle.refuel(1)
  local moved, reason = turtle.forward()
  if not moved then print(reason) end
  turtle.dig()
  turtle.dig("left")
  turtle.place()
  turtle.place("sign text")
  turtle.drop(1)
  turtle.suckUp()
  local found, block = turtle.inspect()
  if found and type(block) == "table" then print(block.name, block.state.facing, block.tags["minecraft:logs"]) end
  local held = turtle.getItemDetail()
  local full = turtle.getItemDetail(2, true)
  print(held and held.name, full and full.displayName, turtle.getItemCount(), turtle.getItemSpace(3), turtle.getFuelLevel(), turtle.getFuelLimit())
  print(turtle.compareTo(2), turtle.transferTo(2, 1), turtle.getSelectedSlot(), turtle.equipLeft(), turtle.detectDown(), turtle.attack())
  if turtle.craft then turtle.craft(1) end
end
if pocket then print(pocket.equipBack(), pocket.unequipBack()) end
if commands then
  local ok, output, affected = commands.exec("say hi")
  print(ok, #output, affected, commands.execAsync("say hi"), commands.getBlockPosition())
  commands.say("hi")
  commands.async.say("hi")
  print(commands.getBlockInfo(0, 64, 0).name, #commands.getBlockInfos(0, 64, 0, 1, 64, 1), #commands.list("gamerule"))
end

-- ===== cc.* modules =====
local expect = require("cc.expect")
local expectFn, field, range = expect.expect, expect.field, expect.range
expect(1, "text", "string")
expectFn(1, 5, "number", "nil")
print(field({ a = 1 }, "a", "number"), range(5, 1, 10))
local pretty = require("cc.pretty")
pretty.pretty_print({ 1, 2, 3 })
pretty.print(pretty.text("hello", colours.red) .. pretty.space .. pretty.text("world"))
print(pretty.render(pretty.pretty({ 1 }), 20))
local strings = require("cc.strings")
print(#strings.wrap("a long line", 5), strings.ensure_width("a", 5))
local completion = require("cc.completion")
print(#completion.choice("a", { "apple", "avocado" }), #completion.peripheral("mo"))
local shellCompletion = require("cc.shell.completion")
shell.setCompletionFunction("program", shellCompletion.build(shellCompletion.file, { shellCompletion.choice, { "a", "b" } }))
local dfpwm = require("cc.audio.dfpwm")
local decoder = dfpwm.make_decoder()
speaker.playAudio(decoder("encoded"))
print(#dfpwm.encode({ 0, 1 }), #dfpwm.decode("encoded"))
local nft = require("cc.image.nft")
local picture = nft.load("image.nft")
if picture then nft.draw(picture, 1, 1) end

-- ===== Lua as CC:Tweaked has it =====
print(bit32.band(1, 3), bit32.lshift(1, 4), utf8.char(228), utf8.len("ä"), string.pack(">I2", 1), math.floor(1.5))
print(("x"):rep(3), ("%d"):format(1), #string.unpack(">s2", "\0\1a"), select("#", 1, 2), rawlen({}), math.log(8, 2))
print(coroutine.running(), debug.traceback(), package.path, next({}), tostring(nil), tonumber("1"), type(1))
