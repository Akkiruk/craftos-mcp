-- versus.lua
-- Part of the craftos-mcp examples (MIT).
-- A two-player games cabinet: Paddle, Trails and Artillery, played head to head across two computers, each with its own
-- monitor wall, linked by wireless modems. Run this on both. Pick a game on one wall, tap PLAY on it, and tap the other
-- wall to join. With no other cabinet in range you play the computer.
-- Attach a 6x6 monitor (text scale 0.5 gives about 121x81 cells), a wireless modem and, if you like, a speaker.
-- Terminate (hold Ctrl+T) to leave.

-- Modules load from this program's own folder, wherever it was copied to.
local root = fs.getDir(shell.getRunningProgram())
package.path = "/" .. fs.combine(root, "?.lua") .. ";" .. package.path

require("lib.shell").run({ root = root, name = "VERSUS", games = require("games.list") })
