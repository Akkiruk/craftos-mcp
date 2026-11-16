-- board.lua (copied into the board cabinet's folder as showcase.lua)
-- Part of the craftos-mcp showcase recorder. From the idle screen to the menu to a game's lobby, then plays red with
-- taps (moves picked by the game's own computer player) against a computer player, for cfg.seconds.

local cfg = showcaseConfig()
local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local plugin = kit.plugin(cfg.game)

local function tapMove(a)
  if a.kind == "place" then
    kit.tapCell(a.x, a.y)
  elseif a.kind == "move" then
    kit.tapCell(a.fx, a.fy)
    sleep(0.35)
    kit.tapCell(a.tx, a.ty)
  elseif a.kind == "drop" then
    kit.tapCell(a.col, 1)
  elseif a.kind == "sow" then
    kit.tapCell(a.pit, 2)
  end
end

local problem = kit.run(function()
  mark("go")
  kit.waitFor(function() return kit.S.view == "idle" and #kit.app.env.walls[1].buttons > 0 end, 10)
  sleep(cfg.idle or 0.6)
  kit.touch(5, 5)
  kit.waitFor(function() return kit.S.view == "menu" end, 5)
  sleep(cfg.menu or 0.8)
  kit.tap("game", cfg.game)
  kit.waitFor(function() return kit.S.view == "lobby" end, 5)
  sleep(0.3)
  kit.tap("redSeat", "player")
  kit.tap("blueSeat", cfg.cpu or "medium")
  sleep(0.3)
  kit.start()
  mark("play")
  local started = os.clock()
  local stilled = false
  while kit.S.view == "game" and os.clock() - started < cfg.seconds do
    if kit.waitTurn(1, 20) then
      sleep(0.5)
      local g = kit.S.match
      if g and g.state.turn == 1 then
        local a = plugin.chooseAction(g.state, "medium", { ms = 150 })
        if a then tapMove(a) end
      end
      if not stilled and os.clock() - started > (cfg.stillAt or 8) then
        stilled = true
        mark("still")
      end
    end
  end
  sleep(1)
  mark("done")
end, { thinkMs = cfg.thinkMs })

if problem then
  print(problem)
  mark("done")
end
