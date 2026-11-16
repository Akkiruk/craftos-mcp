-- action.lua
-- Part of the craftos-mcp examples (MIT).
-- A games cabinet on a monitor wall: Snake, Blocks, Bricks, Lander and Mines, one player at a time, for the high score.
-- Attach a 6x6 monitor (text scale 0.5 gives about 121x81 cells) and, if you like, a speaker, then run this program.
-- Every game is played by touching the monitor. Terminate (hold Ctrl+T) to leave.

-- Modules load from this program's own folder, wherever it was copied to.
local root = fs.getDir(shell.getRunningProgram())
package.path = "/" .. fs.combine(root, "?.lua") .. ";" .. package.path

require("lib.shell").run({ root = root, name = "CLASSICS", games = require("games.list") })
