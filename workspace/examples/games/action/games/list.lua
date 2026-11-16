-- games/list.lua
-- Part of the craftos-mcp examples (MIT).
-- Every game on the cabinet, in menu order. A new game is a folder here and one line below.

return {
  require("games.snake.plugin"),
  require("games.blocks.plugin"),
  require("games.bricks.plugin"),
  require("games.lander.plugin"),
  require("games.mines.plugin"),
}
