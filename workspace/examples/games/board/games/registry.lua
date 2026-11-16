-- games/registry.lua
-- Part of the craftos-mcp examples (MIT).
-- Every game in the cabinet, in menu order. A new game is one folder under games/ and one line here.

return {
  require("games.uttt.plugin"),
  require("games.fourinarow.plugin"),
  require("games.reversi.plugin"),
  require("games.checkers.plugin"),
  require("games.dots.plugin"),
  require("games.mancala.plugin"),
  require("games.fleet.plugin"),
  require("games.codebreaker.plugin"),
}
