-- Prints a glowing lamp on the 3D printer: a stand and a shade that lights when the print is switched on, then
-- waits for the copies to come out.
local printer = peripheral.find("3d_printer")
if not printer then error("no 3D printer attached", 0) end
local copies = tonumber(...) or 1

printer.reset()
printer.setLabel("Desk lamp")
printer.setTooltip("Right-click to switch")
printer.setButtonMode(false)
printer.setLightLevel(7)
printer.setStateLighting(false, true)
printer.addShapes({
  { 6, 0, 6, 10, 1, 10, texture = "minecraft:block/iron_block" },
  { 7, 1, 7, 9, 10, 9, texture = "minecraft:block/iron_block" },
  { 4, 10, 4, 12, 14, 12, texture = "minecraft:block/white_wool", tint = 0xFFE0A0 },
  { 4, 10, 4, 12, 14, 12, texture = "minecraft:block/glowstone", state = true },
})
local off, on = printer.getShapeCount()
print(("%d shapes off, %d on"):format(off, on))

-- the printer takes its chamelium and ink in on its own ticks
sleep(0.2)
assert(printer.commit(copies), "nothing to print")
local done = 0
while done < copies do
  local _, remaining = os.pullEvent("3d_printer_complete")
  done = done + 1
  print(("lamp %d done, %d to go"):format(done, remaining))
end
