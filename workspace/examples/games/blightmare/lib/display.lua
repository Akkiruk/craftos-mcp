-- lib/display.lua
-- Part of the craftos-mcp examples (MIT).
-- The monitor wall: text scale 0.5, the game's palette, and one off-screen surface that everything draws on. The
-- surface goes to the monitor a row at a time, and only the rows that changed, so a still screen sends nothing.

local ui = require("lib.ui")

local M = {}

-- What each of CC's 16 colours looks like on the wall. ui.C names them for what they do.
M.PALETTE = {
  black = 0x14161C,      -- background
  gray = 0x232733,       -- panels
  lightGray = 0x7C8496,  -- grid lines and dim text
  white = 0xF2F4F8,
  red = 0xE5484D,        -- player 1
  blue = 0x3E82F7,       -- player 2
  brown = 0x4A2328,      -- player 1's dark tint
  lightBlue = 0x1F3560,  -- player 2's dark tint
  yellow = 0xFFD257,     -- highlights, and the game's accent
  magenta = 0x3B3722,    -- highlight background tint
  green = 0x35D07F,
  orange = 0xFF9F43,
  purple = 0x9B7BFF,
  cyan = 0x3CD3E6,
  pink = 0x4A4F60,       -- grey tint, for ghosts and ties
  lime = 0x8BE0A8,
}

--- The biggest monitor attached, and its name.
local function biggest()
  local best, bestName, bestArea
  for _, name in ipairs(peripheral.getNames()) do
    if peripheral.hasType(name, "monitor") then
      local mon = peripheral.wrap(name)
      mon.setTextScale(0.5)
      local w, h = mon.getSize()
      if not best or w * h > bestArea then best, bestName, bestArea = mon, name, w * h end
    end
  end
  return best, bestName
end

--- Take over a monitor (by name, or the biggest one) and draw on it. Returns the display, or nil and why.
--- root is the program's folder, where lib/surface.lua and lib/font live.
function M.open(root, monitorName)
  local mon, name
  if monitorName then
    mon, name = peripheral.wrap(monitorName), monitorName
  else
    mon, name = biggest()
  end
  if not mon then return nil, "no monitor attached" end
  local surface = require("lib.surface")
  local font = surface.loadFont(surface.load("/" .. fs.combine(root, "lib/font")))
  local d = { mon = mon, name = name }

  --- Set the wall up again: after a resize, or when the game's accent colour changes.
  function d.reset(accent)
    mon.setTextScale(0.5)
    for slot, hex in pairs(M.PALETTE) do mon.setPaletteColor(colors[slot], hex) end
    if accent then mon.setPaletteColor(colors.yellow, accent) end
    mon.setBackgroundColor(colors.black)
    mon.clear()
    d.W, d.H = mon.getSize()
    d.surf = surface.create(d.W, d.H)
    d.out = ui.changedRows(mon)
    ui.init(surface, font, d.surf)
  end

  --- The game's own highlight colour, without clearing the wall.
  function d.accent(hex)
    mon.setPaletteColor(colors.yellow, hex or M.PALETTE.yellow)
  end

  --- Start a frame: a clear surface and no buttons.
  function d.begin()
    d.surf:clear(ui.C.bg, nil, " ")
    ui.clearButtons()
  end

  --- Send the frame to the monitor.
  function d.show()
    d.surf:output(d.out, 0, 0)
  end

  --- Give the monitor back as CC left it.
  function d.close()
    for i = 0, 15 do mon.setPaletteColor(2 ^ i, term.nativePaletteColor(2 ^ i)) end
    mon.setBackgroundColor(colors.black)
    mon.clear()
  end

  d.reset()
  return d
end

return M
