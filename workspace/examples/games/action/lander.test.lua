-- lander.test.lua
-- Part of the craftos-mcp examples (MIT).
-- Plays Lander with its three buttons (action.world.json, a 6x6 monitor): LEFT and RIGHT tilt the craft a notch, THRUST
-- burns fuel, and flying the way the autopilot would, through the buttons, brings it down safely on a pad for points.

local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.lander.rules")
local BUTTON = { -1, "thrust", 1 } -- the controls in order: LEFT, THRUST, RIGHT

--- Press the button that does what the action asks.
local function act(action)
  local index = action.kind == "thrust" and 2 or (action.dir < 0 and 1 or 3)
  kit.press("control", index, 0.25)
end

local seen = {}

kit.run(function()
  kit.open("lander")
  seen.started = kit.start()
  local s = kit.state()
  seen.controls = #kit.S.game.view.controls(kit.S.L, s)

  -- One notch right and back again
  act({ kind = "tilt", dir = 1 })
  seen.tilted = s.tilt
  act({ kind = "tilt", dir = -1 })
  seen.straight = s.tilt

  -- Fly it down the way the autopilot would, with a tap only every so often, as a person can. A crash costs fuel and
  -- moves on to the next site, so it simply tries again there.
  local fuel = s.fuel
  kit.waitFor(function()
    if s.result then
      seen.result = s.result
      return s.result.landed
    end
    local action = rules.bot(s)
    if action then act(action) end
    return s.over
  end, 150)
  seen.burnt = fuel > s.fuel
  seen.score = s.score
  seen.landedSound = kit.heard("win")
  seen.thrustSound = kit.heard("thrust")
  seen.quit = kit.quit()
end)

ccunit.test("three buttons: LEFT, THRUST and RIGHT", function()
  ccunit.truthy(seen.started)
  ccunit.eq(seen.controls, #BUTTON)
end)

ccunit.test("LEFT and RIGHT tilt the craft a notch each", function()
  ccunit.eq(seen.tilted, rules.TILT_STEP)
  ccunit.eq(seen.straight, 0)
end)

ccunit.test("THRUST burns fuel", function()
  ccunit.truthy(seen.burnt, "no fuel used")
  ccunit.truthy(seen.thrustSound, "no engine sound")
end)

ccunit.test("flown well, it lands on a pad and scores", function()
  ccunit.truthy(seen.result, "never came down")
  ccunit.truthy(seen.result.landed, "crashed: " .. tostring(seen.result.why))
  ccunit.truthy(seen.score > 0, "no points")
  ccunit.truthy(seen.landedSound, "no landing sound")
end)

ccunit.test("QUIT twice ends the run", function()
  ccunit.truthy(seen.quit)
end)
