-- games/list.lua
-- Part of the craftos-mcp examples (MIT).
-- Every game on the cabinet, in menu order. A new game is a folder here and one line below.

return {
  require("games.paddle.plugin"),
  require("games.trails.plugin"),
  require("games.artillery.plugin"),
}
