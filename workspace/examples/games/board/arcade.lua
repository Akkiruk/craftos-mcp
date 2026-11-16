-- arcade.lua
-- Part of the craftos-mcp examples (MIT).
-- Eight board games on one monitor wall: Ultimate Tic-Tac-Toe, Four in a Row, Reversi, Checkers, Dots and Boxes,
-- Mancala, Fleet and Codebreaker. Two people at the wall, or one against the computer.
--
-- Build a 6x6 wall of advanced monitors next to the computer (a second 6x6 wall on the other side lets Fleet and
-- Codebreaker keep each player's pieces hidden), add a speaker if you like, and run this program. Ctrl+T stops it.

local dir = fs.getDir(shell.getRunningProgram())

require("cabinet.main").run({
  registry = require("games.registry"),
  dir = dir,
  name = "ARCADE",
})
