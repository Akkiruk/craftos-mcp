-- mines.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Plays Mines with real taps (action.world.json, a 6x6 monitor): the first dig is always safe, FLAG mode flags a
-- square, a flagged square can't be dug, opening every safe square clears the board for a bonus and a bigger board, and
-- digging a mine ends the run.

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.mines.rules")

local view -- the game's view, for where its squares are

--- Tap the square at column x, row y of the board.
local function tapSquare(s, x, y)
  local x0, y0, cw, ch = view.tiles(kit.S.L, s)
  kit.tap(x0 + (x - 1) * cw + math.floor(cw / 2), y0 + (y - 1) * ch + math.floor(ch / 2), 0.15)
end

local function tapMode()
  local L = kit.S.L
  kit.tap(L.panelX + 5, L.modeY + 5, 0.2)
end

--- The first square of the board that is (or isn't) a mine and isn't open, or nil.
local function find(s, mine)
  for y = 1, s.rows do
    for x = 1, s.cols do
      local cell = s.grid[y][x]
      if cell.mine == mine and not cell.open and not cell.flag then return x, y end
    end
  end
end

local seen = {}

kit.run(function()
  kit.open("mines")
  view = kit.S.game.view
  seen.started = kit.start()
  local s = kit.state()

  -- The first dig, in a corner, opens ground and never a mine
  tapSquare(s, 1, 1)
  kit.waitFor(function() return s.placed end, 2)
  seen.firstOpened, seen.firstSafe = s.opened, not s.grid[1][1].mine and s.grid[1][1].open

  -- FLAG mode, flag a mine, back to DIG, and try to dig the flag
  tapMode()
  seen.flagMode = s.mode
  local mx, my = find(s, true)
  tapSquare(s, mx, my)
  seen.flagged, seen.left = s.grid[my][mx].flag, rules.minesLeft(s)
  tapMode()
  tapSquare(s, mx, my)
  seen.stillShut = not s.grid[my][mx].open and not s.over and s.ending == 0

  -- Dig every safe square: the board clears
  local level, score = s.level, s.score
  kit.waitFor(function()
    if s.banner or s.level > level then return true end
    local x, y = find(s, false)
    if x then tapSquare(s, x, y) end
    return false
  end, 60)
  seen.banner = s.banner
  seen.clearSound = kit.heard("win")
  seen.bonus = s.score > score
  seen.nextBoard = kit.waitFor(function() return s.level == level + 1 end, 5)
  seen.size = { s.cols, s.rows }

  -- On the new board, dig once to lay the mines, then dig a mine
  tapSquare(s, 1, 1)
  kit.waitFor(function() return s.placed end, 2)
  local bx, by = find(s, true)
  tapSquare(s, bx, by)
  seen.boom = kit.waitFor(function() return s.hit ~= nil end, 2) and kit.heard("boom_big")
  seen.final = kit.waitFor(function() return kit.S.view == "final" end, 10)
  seen.score = s.score
end)

ccunit.test("the first dig is safe and opens ground", function()
  ccunit.truthy(seen.started)
  ccunit.truthy(seen.firstSafe, "the first square was a mine or stayed shut")
  ccunit.truthy(seen.firstOpened > 1, "opened " .. seen.firstOpened)
end)

ccunit.test("FLAG mode flags a square, and a flagged square can't be dug", function()
  ccunit.eq(seen.flagMode, "flag")
  ccunit.truthy(seen.flagged, "no flag")
  ccunit.eq(seen.left, 9)
  ccunit.truthy(seen.stillShut, "the flagged square opened")
end)

ccunit.test("opening every safe square clears the board for a bonus and a bigger board", function()
  ccunit.truthy(seen.banner, "no BOARD CLEAR")
  ccunit.truthy(seen.bonus)
  ccunit.truthy(seen.clearSound, "no sound for the clear")
  ccunit.truthy(seen.nextBoard, "no next board")
  ccunit.eq(seen.size, { 12, 12 })
end)

ccunit.test("digging a mine ends the run", function()
  ccunit.truthy(seen.boom, "no boom")
  ccunit.truthy(seen.final, "the run did not end")
  ccunit.truthy(seen.score > 0)
end)
