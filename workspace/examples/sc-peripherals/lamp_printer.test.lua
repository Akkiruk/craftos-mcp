-- lamp_printer.lua on a 3D printer with chamelium and ink in its slots (lamp_printer.world.json), then every
-- 3D printer and poster printer method. A print takes 100 ticks (5 s).
local T, eq, ok = ccunit.test, ccunit.eq, ccunit.truthy
local p, poster = peripheral.wrap("left"), peripheral.wrap("right")
local function err(fn, ...)
  local okc, e = pcall(fn, ...)
  if okc then error("expected an error", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local lines = {}
local function run(...)
  local env = setmetatable({ print = function(t) lines[#lines + 1] = t end }, { __index = _ENV })
  return assert(loadfile("examples/sc-peripherals/lamp_printer.lua", nil, env))(...)
end

T("the lamp prints", function()
  run("1")
  eq(lines, { "3 shapes off, 1 on", "lamp 1 done, 0 to go" })
  local out = p.getItemDetail(3)
  eq({ out.name, out.count }, { "sc-peripherals:print", 1 })
  eq(p.list()[2].name, "sc-peripherals:empty_ink_cartridge")
end)

T("materials and costs", function()
  local ch, maxCh = p.getChameliumLevel()
  eq(maxCh, 256000)
  -- 4 chamelium went in (8000); the lamp cost its volume / 2: (16 + 36 + 256 off, 256 on) / 2 = 282
  eq(ch, 8000 - 282)
  local ink, maxInk = p.getInkLevel()
  eq(maxInk, 100000)
  ok(ink < 50000 and ink > 49000, tostring(ink))
end)

T("print data getters and setters", function()
  eq(p.getLabel(), "Desk lamp")
  eq(p.getTooltip(), "Right-click to switch")
  p.setLabel(("x"):rep(49)) -- too long: no label
  eq(p.getLabel(), nil)
  p.setLabel("caf\195\169") -- UTF-8 in, a Java string; back to Lua as one byte per char
  eq(p.getLabel(), "caf\233")
  p.setLightLevel(20)
  eq(p.getLightLevel(), 7)
  p.setRedstoneLevel(-3)
  eq(p.getRedstoneLevel(), 0)
  p.setButtonMode(true)
  eq(p.getButtonMode(), true)
  p.setCollidable(false, true)
  eq({ p.isCollidable() }, { false, true })
  eq({ p.getStateLighting() }, { false, true })
  eq({ p.getSeatPos() }, { nil, nil, nil })
  eq(select("#", p.getSeatPos()), 3)
  p.setSeatPos(0.5, 0.5, 0.5)
  eq({ p.getSeatPos() }, { 0.5, 0.5, 0.5 })
  eq(err(p.setSeatPos, 0, 0.5, 0.5), "Seat position must be between 0.1 and 0.9 on all axes")
  eq(p.getMaxShapeCount(), 128)
end)

T("shapes: a set, clamped, and their errors", function()
  p.reset()
  eq(p.status(), "idle")
  eq(select(2, p.status()), false)
  eq(err(p.commit, 1), "Model is invalid")
  p.addShape(0, 0, 0, 16, 16, 16)
  p.addShape(0, 0, 0, 99, 16, 16) -- clamped to 16: the same shape, once in the set
  eq({ p.getShapeCount() }, { 1, 0 })
  p.addShape(16, 16, 16, 0, 0, 0, "", true) -- corners swap
  eq({ p.getShapeCount() }, { 1, 1 })
  eq(err(p.addShape, 0, 0, 0, 0, 16, 16), "Empty block")
  eq(err(p.addShapes, { "x" }), "bad item #1 (table expected, got string)")
  eq(err(p.addShapes, { { 0, 0, 0, 1, 1 } }), "bad item #6 (number expected, got nil)")
  eq(err(p.addShapes, { a = {} }), "Invalid shape table")
  eq(err(p.addShapes, { { 0, 0, 0, 1, 1, 1, texture = 5 } }), "bad field 'texture' (string expected, got number)")
  eq(err(p.addShape), "bad argument #1 (number expected, got nil)")
  eq(p.commit(0), false)
  eq(select(2, p.status()), true)
  eq(p.commit(2), true)
  eq(p.status(), "busy")
  p.stop()
  eq(p.status(), "idle")
end)

T("inventory methods", function()
  eq(p.size(), 3)
  eq(p.getItemLimit(1), 64)
  eq(err(p.getItemDetail, 4), "Slot out of range (between 1 and 3)")
end)

T("poster printer: palette, pixels, a print", function()
  eq(peripheral.getType("right"), "poster_printer")
  eq({ poster.getInkLevel() }, { 20000, 100000 })
  eq({ poster.status() }, { "idle", true }) -- an empty poster costs no ink
  poster.setLabel("Map")
  eq(poster.getLabel(), "Map")
  poster.setTooltip("")
  eq(poster.getTooltip(), nil)
  poster.setPaletteColour(1, 255, 0, 0)
  eq(err(poster.setPaletteColor, 0, 0, 0, 0), "Palette index 0 out of range [1, 63] (0 is reserved for transparent)")
  poster.setPixel(1, 1, 1)
  eq(err(poster.setPixel, 0, 1, 1), "Invalid pixel coordinates")
  eq(err(poster.setPixel, 1, 1, 64), "Color index 64 out of range [0, 63]")
  local row = {}
  for i = 1, 128 do row[i] = 1 end
  poster.blitPixels(1, 2, row)
  poster.blitPixels(1, 1, { 300 }) -- toByte(): 300 wraps to 44, a valid index
  eq(err(poster.blitPixels, 1, 1, { 200 }), "Color index -56 out of range [0, 63]")
  eq(err(poster.blitPixels, 1, 1, { "a" }), "Expected number")
  poster.blitPalette({ 0x112233 })
  eq(err(poster.blitPalette, { -1 }), "Invalid color")
  eq(poster.commit(1), true)
  local _, remaining = os.pullEvent("poster_printer_complete")
  eq(remaining, 0)
  eq(poster.getItemDetail(3).name, "sc-peripherals:poster")
  -- 129 pixels of 16384 at 5000 ink a full poster: round(39.4) = 39
  eq(poster.getInkLevel(), 20000 - 39)
  eq(poster.list()[1].count, 1)
  poster.stop()
  poster.reset()
end)
