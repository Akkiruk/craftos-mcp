local m = peripheral.wrap("top")
local n = 0
local function draw() m.clear() m.setCursorPos(1,1) m.write("touches: " .. n) end
draw()
while true do local _, _, x, y = os.pullEvent("monitor_touch") n = n + 1 draw() end
