-- One whole game: a new save to the ending, with the real engine and real fights, earning every level and coin on the way. The bot
-- follows the story guide. It can't read riddles, so after a long stall a goal is done for it and named: those are listed.
local kit = loadfile(fs.combine(fs.getDir(fs.getDir(shell.getRunningProgram())), "testkit.lua"), nil, _ENV)()
local seeded = require("lib.rng")
local rules = require("games.blightmare.rules")

local TICKS, HELP_AFTER = 700000, 6000

ccunit.test("a whole game, new save to the end", function()
  local rng = seeded.rng(77)
  local s = rules.new({ rng = rng, player = "Ada" })
  local ticks, wipes, seen, since = 0, 0, -1, 0
  local helped, marks = {}, {}
  local lastGoal
  while ticks < TICKS and not s.flags.fn_ended do
    ticks = ticks + 1
    kit.pace()
    local action = rules.bot(s, rng)
    if action then rules.input(s, action) end
    for _, ev in ipairs(rules.tick(s, rng)) do
      if ev.type == "wipe" then wipes = wipes + 1 end
    end
    if ticks % 300 == 0 then
      local count = 0
      for _ in pairs(s.flags) do count = count + 1 end
      if count ~= seen then seen, since = count, ticks end
      local goal = rules.currentGoal(s)
      if goal and goal.text ~= lastGoal then
        lastGoal = goal.text
        marks[#marks + 1] = ticks .. " L" .. s.level .. " g" .. s.gold .. " w" .. wipes .. " " .. goal.text
      end
      if goal and ticks - since > HELP_AFTER and s.mode ~= "battle" and s.mode ~= "talk" then
        s.flags[goal.done] = true
        helped[#helped + 1] = goal.done
        since = ticks
      end
      os.queueEvent("blightmare_full")
      os.pullEvent("blightmare_full")
    end
  end
  print("whole game: ended " .. tostring(s.ended) .. ", " .. ticks .. " ticks, about " .. math.floor(ticks * 0.12 / 60) .. " minutes, " .. wipes .. " wipes, level " .. s.level .. ", helped: " .. table.concat(helped, " "))
  ccunit.truthy(s.flags.fn_ended, "stuck at " .. tostring(lastGoal) .. " on " .. s.map .. ": " .. table.concat(marks, " | "))
  ccunit.truthy(#helped <= 20, "too much help: " .. table.concat(helped, " "))
end)
