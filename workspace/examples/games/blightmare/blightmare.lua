-- blightmare.lua
-- Part of the craftos-mcp examples (MIT).
-- BLIGHTMARE: a dark first-person RPG for one monitor wall. A continent, a plague, and a hero who has never dreamed.
-- Attach a 6x6 wall of advanced monitors (text scale 0.5 gives about 121x81 cells) and, if you like, a speaker and an
-- Advanced Peripherals player detector, then run this program. Every part of it is played by touching the wall.
-- Hold Ctrl+T to stop: the game in play is saved first.

-- Modules load from this program's own folder, wherever it was copied to. An installed copy (see build.mjs) keeps them
-- packed in blightmare.pak, which pack.lua opens; a copy of the source has them as plain files.
local root = fs.getDir(shell.getRunningProgram())
package.path = "/" .. fs.combine(root, "?.lua") .. ";" .. package.path

local modules = {}
local pak = fs.combine(root, "blightmare.pak")
if fs.exists(pak) then
  local pack = dofile("/" .. fs.combine(root, "pack.lua"))
  for _, name in ipairs(pack.open("/" .. pak, package, _ENV)) do
    if name:find("^games%.") then modules[#modules + 1] = name end
  end
else
  local function walk(dir, prefix)
    for _, file in ipairs(fs.list(dir)) do
      local path = fs.combine(dir, file)
      if fs.isDir(path) then
        walk(path, prefix .. file .. ".")
      elseif file:sub(-4) == ".lua" then
        modules[#modules + 1] = prefix .. file:sub(1, -5)
      end
    end
  end
  walk(fs.combine(root, "games"), "games.")
end
table.sort(modules)

require("lib.shell").run({ root = root, plugin = require("games.blightmare.plugin"), preload = modules })
