-- ---------------------------------------------------------------- tapping the map
local kit = loadfile(fs.combine(fs.getDir(fs.getDir(shell.getRunningProgram())), "testkit.lua"), nil, _ENV)()

local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy
local overworld = require("games.blightmare.overworld")

do
  local seeded = require("lib.rng")
  local rules = require("games.blightmare.rules")

  local function onRoad(x, y, flags)
    local rng = seeded.rng(3)
    local s = rules.new({ rng = rng, player = "Ada" })
    s.run, s.mode, s.wx, s.wy, s.safeSteps = nil, "world", x, y, 9999
    for _, flag in ipairs(flags or {}) do s.flags[flag] = true end
    return s, rng
  end

  local function walk(s, rng, limit)
    for _ = 1, limit do
      rules.tick(s, rng)
      if not s.route and not s.heading then break end
    end
  end

  t("a tap on the map walks the party there, round whatever is in the way", function()
    local s, rng = onRoad(62, 60, { "finished" })
    s.wx, s.wy = 63, 60
    rules.input(s, { kind = "goto", x = 68, y = 53 })
    rules.tick(s, rng)
    truthy(s.route, "a route")
    walk(s, rng, 400)
    eq(s.wx, 68)
    eq(s.wy, 53)
    eq(s.mode, "world")
    truthy(not s.route and not s.heading, "stopped there")
  end)

  t("a tap on a town goes in, a tap on the party stops, and a tap on the sea gets as near as can be", function()
    local s, rng = onRoad(66, 46, { "finished" })
    rules.input(s, { kind = "goto", x = 67, y = 44 })
    walk(s, rng, 100)
    eq(s.map, "orrenshire")
    s, rng = onRoad(66, 50, { "finished" })
    rules.input(s, { kind = "goto", x = 66, y = 58 })
    for _ = 1, 8 do rules.tick(s, rng) end
    truthy(s.route, "still walking")
    local x, y = s.wx, s.wy
    rules.input(s, { kind = "goto", x = x, y = y })
    for _ = 1, 6 do rules.tick(s, rng) end
    eq(s.route, nil)
    s, rng = onRoad(66, 50, { "finished" })
    rules.input(s, { kind = "goto", x = 110, y = 75 })
    walk(s, rng, 600)
    truthy(overworld.walkable(s.wx, s.wy, s), "landed on ground")
  end)

  t("a route doesn't stop at a town in the way, and carries on after a fight", function()
    local s, rng = onRoad(66, 46, { "finished" })
    local stops = 0
    rules.input(s, { kind = "goto", x = 70, y = 41 })
    for _ = 1, 200 do
      rules.tick(s, rng)
      if s.mode == "walk" then stops = stops + 1 end
    end
    eq(stops, 0, "walked round Orrenshire")
    s, rng = onRoad(66, 50, { "finished" })
    rules.input(s, { kind = "goto", x = 66, y = 58 })
    for _ = 1, 3 do rules.tick(s, rng) end
    local kept = s.route
    s.mode, s.heading = "menu", nil
    s.menu = { page = "main", top = 0 }
    s.back = "world"
    rules.input(s, { kind = "back" })
    rules.tick(s, rng)
    eq(s.mode, "world")
    eq(s.route, kept)
  end)
end

t("on the far side of the wall the guide points at the way through, not across it", function()
  local seeded = require("lib.rng")
  local rules = require("games.blightmare.rules")
  local story = require("games.blightmare.story")
  local rng = seeded.rng(3)
  local s = rules.new({ rng = rng, player = "Ada" })
  s.run, s.mode, s.wx, s.wy = nil, "world", 47, 63
  for _, goal in ipairs(story.GOALS) do
    if goal.done == "ud_relieved" then break end
    s.flags[goal.done] = true
  end
  s.flags.wm_done, s.flags.em_done = true, true
  local goal = rules.goal(s)
  truthy(goal.x, "somewhere to go: " .. tostring(goal.text))
  eq(rules.landOf(s, goal.x, goal.y), rules.landOf(s, s.wx, s.wy), "a place that can be walked to")
end)

-- ---------------------------------------------------------------- the opening, as the idle screen

do
  local seeded = require("lib.rng")
  local rules = require("games.blightmare.rules")
  local player = require("games.blightmare.intro_player")
  local intro = require("games.blightmare.intro")
  local ORDER = { "oblivion", "binding", "embia", "empire", "ward", "plague", "wall", "dusk", "book", "night", "knock", "one" }

  t("the opening's pages show every picture in order, each long enough to read and to finish moving", function()
    local seen = {}
    for _, page in ipairs(player.pages()) do
      truthy(page.pic, "every page has a picture")
      if seen[#seen] ~= page.pic then seen[#seen + 1] = page.pic end
      truthy(page.text or page.big, "every page has words")
      if page.text then truthy(page.ticks * 120 >= #page.text * 60, "time to read: " .. page.text) end
    end
    eq(table.concat(seen, " "), table.concat(ORDER, " "))
    -- a picture that moves for a while has finished by the time its last page goes
    local last = {}
    for _, page in ipairs(player.pages()) do last[page.pic] = page.picFrom + page.ticks end
    for pic, ends in pairs(last) do
      local length = intro.length(pic)
      if type(length) == "number" then truthy(ends >= length, pic .. " is cut off before it finishes") end
    end
  end)

  t("idle, it plays silent and starts again at the end", function()
    local run = player.new(0)
    local pages, looped, ms = {}, false, 0
    for _ = 1, 4000 do
      ms = ms + 120
      local before = run.page
      player.loopStep(run, ms)
      if run.page ~= before then pages[#pages + 1] = run.page end
      if before > 1 and run.page == 1 then
        looped = true
        break
      end
    end
    truthy(looped, "it loops")
    eq(#pages, #player.pages(), "every page, then back to the first")
  end)

  t("taken over, it carries on from the same moment with its music and sounds, and ends", function()
    local run = player.new(0)
    for ms = 120, 120 * 300, 120 do player.loopStep(run, ms) end
    local page = run.page
    truthy(page > 1, "it had moved on")
    local played, music = {}, {}
    local play = function(name) played[#played + 1] = name end
    local tune = function(name) music[#music + 1] = name or "stop" end
    player.engage(run, tune)
    eq(run.page, page, "the same page")
    truthy(#music == 1 and music[1]:find("^intro_music_"), "its music starts at once")
    local done, ms = false, 120 * 300
    for _ = 1, 5000 do
      ms = ms + 120
      local _, finished = player.step(run, ms, play, tune)
      if finished then
        done = true
        break
      end
    end
    truthy(done, "it ends")
    truthy(#played > 3, "sounds played")
    local picks = require("lib.sound").SOUNDS
    for _, name in ipairs(played) do truthy(picks[name], "no sound " .. name) end
    for _, name in ipairs(music) do truthy(name == "stop" or picks[name], "no music " .. name) end
  end)

  t("a tap turns the page, and the last tap is the end", function()
    local run = player.new(0)
    player.engage(run)
    local view = require("games.blightmare.plugin").view
    local app = { audio = { play = function() end, music = function() end } }
    local taps = 0
    while not view.intro.tap(run, 0, app) do
      taps = taps + 1
      if taps > 100 then error("never ends") end
    end
    eq(taps, #player.pages() - 1)
  end)

  t("a new game starts in the morning, the opening being the idle screen now", function()
    local rng = seeded.rng(4)
    local s = rules.new({ rng = rng, player = "Ada" })
    rules.tick(s, rng)
    truthy(table.concat(rules.talk(s).lines, " "):find("Everyone in Scythebreak", 1, true))
    eq(s.pic, nil)
    eq(s.map, "scythebreak")
  end)
end

t("a save's progress: a share of the story by its goals, the goal now, and the time played", function()
  local seeded = require("lib.rng")
  local rules = require("games.blightmare.rules")
  local story = require("games.blightmare.story")
  local rng = seeded.rng(4)
  local s = rules.new({ rng = rng, player = "Ada" })
  local p = rules.progress(s)
  eq(p.percent, 0)
  eq(p.goal, story.GOALS[1].text)
  eq(p.hero, "Ada")
  for i = 1, math.floor(#story.GOALS / 2) do s.flags[story.GOALS[i].done] = true end
  s.frame = 5000 -- ten minutes of 120 ms ticks
  p = rules.progress(s)
  truthy(p.percent > 30 and p.percent < 70, "about half: " .. p.percent)
  eq(p.minutes, 10)
  s.ended = "wake"
  eq(rules.progress(s).percent, 100)
  local view = require("games.blightmare.plugin").view
  truthy(view.progress(s).place, "where they are")
end)
