-- blocks.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Plays Blocks with real taps (action.world.json, a 6x6 monitor): a column tap aims the piece and it stays inside the
-- well however far out the tap is, the turn zones turn it, DROP drops it, and stacking pieces the way the idle screen's
-- bot would, all through taps, clears a line and scores it.

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.blocks.rules")
local CELL_W = 5

local function noSlips(n) if n then return 1 end return 0.99 end -- the bot never fumbles a piece in this test

--- Do what an action asks, by tapping the wall where a player would, and wait for the step that takes the tap: what
--- is checked next is the game after the tap, however late a busy machine runs the step (a fixed pause raced it).
local function act(action)
  local L = kit.S.L
  if action.kind == "turn" then
    kit.tap(action.dir < 0 and 5 or L.W - 6, L.y0 + 30, 0.25)
  elseif action.kind == "aim" then
    kit.tap(L.x0 + (action.col - 1) * CELL_W + 2, L.y0 + 20, 0.25)
  elseif action.kind == "drop" then
    kit.press("control", 1, 0.25)
  end
  -- the shell hands a tap to the game at once (rules.input); the game's next step takes it
  local s = kit.state()
  kit.waitFor(function() return not s or #s.inputs == 0 end, 60)
end

--- The columns the falling piece covers.
local function span(s)
  local p = s.piece
  local lo, hi = math.huge, -math.huge
  for _, c in ipairs(rules.cells(p.letter, p.rot, p.x, p.y)) do lo, hi = math.min(lo, c[1]), math.max(hi, c[1]) end
  return lo, hi
end

local seen = {}

kit.run(function()
  kit.open("blocks")
  seen.started = kit.start()
  local s = kit.state()

  -- Aim far left, then far right: the piece slides to the wall and no further
  act({ kind = "aim", col = 1 })
  seen.leftmost = { span(s) }
  act({ kind = "aim", col = rules.COLS })
  seen.rightmost = { span(s) }
  local rot = s.piece.rot
  act({ kind = "turn", dir = 1 })
  seen.turned = s.piece.rot == (rot + 1) % 4 or s.piece.letter == "O"
  local pieces = s.pieces
  act({ kind = "drop" }) -- the piece has lived three steps by now, past the guard on a new piece's DROP
  seen.dropped = s.pieces > pieces

  -- Stack pieces until a line clears
  kit.waitFor(function()
    local action = not s.over and not s.ending and rules.bot(s, noSlips)
    if action then act(action) end
    return s.lines >= 1 or s.over
  end, 120)
  seen.lines, seen.score, seen.level, seen.over = s.lines, s.score, s.level, s.over
  seen.lineSound = kit.heard("line")
  seen.lockSound = kit.heard("lock")
  seen.quit = kit.quit()
  seen.smooth = { steps = kit.S.steps or 0, late = kit.S.lateFrames or 0, slow = kit.S.slowFrames or 0,
    dropped = kit.S.droppedSteps or 0 }
end)

ccunit.test("a run starts from the menu", function()
  ccunit.truthy(seen.started)
end)

ccunit.test("a tap in the well aims the piece, which never leaves the well", function()
  ccunit.eq(seen.leftmost[1], 1)
  ccunit.eq(seen.rightmost[2], rules.COLS)
end)

ccunit.test("the side zones turn the piece and DROP drops it", function()
  ccunit.truthy(seen.turned, "the piece did not turn")
  ccunit.truthy(seen.dropped, "DROP did not lock the piece and bring the next")
  ccunit.truthy(seen.lockSound, "no sound as it locked")
end)

ccunit.test("a full row clears and scores 100 a line at level 1", function()
  ccunit.truthy(seen.lines >= 1, "no line cleared")
  ccunit.eq(seen.over, false)
  ccunit.truthy(seen.score >= 100, "score " .. seen.score)
  ccunit.truthy(seen.lineSound, "no sound for the line")
end)

ccunit.test("QUIT twice ends the run, and it kept up at full speed", function()
  ccunit.truthy(seen.quit)
  -- Full speed is the game's clock keeping to the real one: a late frame catches up (up to three steps at once), so only
  -- steps it had to drop count. Late and slow frames are timed on the clock, which runs on while a busy host keeps the
  -- computer waiting (slow timers do the same), so they are only reported.
  local m = seen.smooth
  ccunit.truthy(m.dropped <= m.steps / 20,
    m.dropped .. " steps dropped in " .. m.steps .. " (" .. m.slow .. " slow, " .. m.late .. " late frames)")
end)
