-- blightmare.lua (copied into the BLIGHTMARE folder as showcase.lua)
-- Part of the craftos-mcp showcase recorder. Each scene starts from the idle screen like a player at the wall: a touch,
-- SKIP, and CONTINUE on a saved game the driver wrote first, which puts the party just before one moment of the story
-- (the way the game's own tests build a region's state). From there the game is played by touch: the game's own bot
-- says what to do, and the driver taps where the wall reads that, at a pace a person could follow.
-- Marks for the recorder: "go" starts the video, "at <name>" notes a moment the reel cuts from, "still" saves a picture,
-- "done" ends it.

local cfg = showcaseConfig()
local kit = loadfile(fs.combine(fs.getDir(shell.getRunningProgram()), "testkit.lua"), nil, _ENV)()
local rules = require("games.blightmare.rules")
local party = require("games.blightmare.party")
local story = require("games.blightmare.story")
local content = require("games.blightmare.content")
local saves = require("lib.saves")
local seeded = require("lib.rng")

local HERO = "Alex"
local botRng = seeded.rng(cfg.seed or 11)

-- ---------------------------------------------------------------- a saved game just before the moment

local function region(id)
  for _, r in ipairs(content.regions()) do
    if r.id == id then return r end
  end
  error("no region " .. id)
end

--- A state as if the player had come this far: the first act's goals done (up to upTo, or all of them), the regions
--- before this one finished, the party at lvl in that tier's gear.
local function stateFor(o)
  local rng = seeded.rng(o.seed or 3)
  local s = rules.new({ rng = rng, player = HERO })
  s.run, s.mode = nil, "walk"
  for _, goal in ipairs(story.GOALS) do
    if goal.done == o.upTo then break end
    s.flags[goal.done] = true
    if goal.done == "finished" then break end
  end
  for _, id in ipairs(o.before or {}) do
    local r = region(id)
    for _, goal in ipairs(r.goals or {}) do s.flags[goal.done] = true end
    s.flags[r.exit] = true
  end
  for _, flag in ipairs(o.flags or {}) do s.flags[flag] = true end
  for _, flag in ipairs(o.unset or {}) do s.flags[flag] = nil end
  s.party = { party.new("hero", o.lvl) }
  for _, id in ipairs(o.cast or {}) do s.party[#s.party + 1] = party.new(id, o.lvl) end
  local tier = party.tierOf(o.lvl)
  for _, m in ipairs(s.party) do
    m.weapon, m.armour = party.kit(m.id, tier)
    party.restore(m)
  end
  s.level, s.gold = o.lvl, o.lvl * 120
  s.bag = { potion = 5, hipotion = o.lvl >= 12 and 6 or nil, ether = 4, feather = 2 }
  s.foes, s.safeSteps = o.foes or {}, 999
  if o.world then
    s.mode, s.wx, s.wy = "world", o.world[1], o.world[2]
  else
    s.map, s.x, s.y, s.dir = o.map, o.x, o.y, o.dir
    s.savepoint = { map = o.map, x = o.x, y = o.y, dir = o.dir }
  end
  s.hints = {}
  return s
end

local BEFORE_EMPIRE = { "heart", "plexios", "sindal", "windmill" }
local BEFORE_FINALE = { "heart", "plexios", "sindal", "windmill", "empire", "underdark", "vault", "ruin_south", "ruin_north",
  "ruin_deep" }

local SAVES = {
  -- on the road a few steps from Orrenshire, the first town, with the deserter along
  town = function()
    return stateFor({ upTo = "arrived", lvl = 4, cast = { "deserter" }, world = { 69, 48 } })
  end,
  -- the Empire's cracks, facing a nest of wall crawlers, the party of four at level 21
  battle = function()
    return stateFor({ lvl = 17, cast = { "deserter", "cleric", "owlin" }, before = BEFORE_EMPIRE,
      flags = region("empire").entry.flags, map = "em_crack_1", x = 23, y = 12, dir = 2,
      foes = { { id = "f1", x = 24, y = 12 } } })
  end,
  -- the last act: the vault where Colette waits, one step away
  boss = function()
    return stateFor({ lvl = 43, cast = { "deserter", "cleric", "owlin" }, before = BEFORE_FINALE,
      flags = { "ruined", "rn_done", "rd_done", "fn_arrived", "fn_stacks", "fn_read_him" }, unset = { "fn_colette_down" },
      map = "fn_vault_4", x = 11, y = 11, dir = 1 })
  end,
  -- the cot at the bottom of the vault, where the hero goes under, after the goodbyes
  dream = function()
    return stateFor({ lvl = 44, cast = { "deserter", "cleric", "owlin" }, before = BEFORE_FINALE,
      flags = { "ruined", "rn_done", "rd_done", "fn_arrived", "fn_stacks", "fn_read_him", "fn_colette_down", "fn_truth",
        "fn_q_down", "fn_bye_a", "fn_bye_b", "fn_bye_c", "fn_bye_d", "fn_bye_e" },
      map = "fn_vault_5", x = 24, y = 8, dir = 2 })
  end,
}

-- ---------------------------------------------------------------- playing it

--- How long a person takes over what's on the wall before tapping on.
local function readTime(s)
  if s.mode == "talk" and s.run then
    local run = s.run
    if run.big then return 2.6 end
    if run.wait == "pick" then return 2.4 end
    local text = tostring(run.text or "")
    return math.max(1.4, math.min(4.2, 0.9 + #text * 0.03))
  end
  if s.mode == "battle" then
    if s.battle and s.battle.phase == "spoils" then return 2.6 end -- what was won stays up long enough to read
    return cfg.battlePace or 0.55
  end
  if s.mode == "walk" then return 0.32 end
  if s.mode == "name" then return 0.2 end
  return 0.4
end

--- Play by touch until done(s), for up to limit seconds of the computer's own time.
local function play(done, limit)
  local started = os.clock()
  while os.clock() - started < limit do
    local s = kit.state()
    if not s or done(s) then return true end
    local action = rules.bot(s, botRng)
    if action then
      sleep(readTime(s))
      s = kit.state()
      if not s or done(s) then return true end
      action = rules.bot(s, botRng) -- what's on the wall may have moved on meanwhile
      if action then kit.act(action, 0.05) end
    end
    sleep(0.05)
  end
  return false
end

local function frontDoor()
  kit.waitFor(function() return kit.S.view == "idle" and kit.S.demo.run ~= nil end, 10)
  sleep(0.6)
  kit.tap(60, 40)
  kit.waitFor(function() return kit.S.view == "intro" end, 3)
  sleep(0.5)
  kit.press("skip")
  kit.waitFor(function() return kit.S.view == "ready" end, 3)
  sleep(0.8)
end

local function continueSaved()
  frontDoor()
  kit.press("continue")
  kit.waitFor(function() return kit.S.view == "play" end, 3)
end

local function stillAfter(seconds)
  local at = os.clock() + seconds
  return function()
    if at and os.clock() >= at then
      at = nil
      mark("still")
    end
  end
end

local SCENES = {}

--- The opening on the idle screen, a touch, and then heard, page by page.
function SCENES.opening()
  kit.waitFor(function() return kit.S.view == "idle" and kit.S.demo.run ~= nil end, 10)
  mark("at idle")
  sleep(2.5)
  kit.tap(60, 40)
  kit.waitFor(function() return kit.S.view == "intro" end, 3)
  mark("at intro")
  local still = stillAfter(cfg.stillAt or 6)
  for _ = 1, cfg.pages or 6 do
    local until_ = os.clock() + (cfg.pageTime or 3.2)
    while os.clock() < until_ do
      still()
      sleep(0.1)
    end
    kit.tap(60, 30)
  end
  sleep(1.5)
end

--- Tap the town on the map: the party walks there and goes in, and the town has something to say.
function SCENES.town()
  continueSaved()
  mark("at world")
  sleep(2)
  kit.act({ kind = "goto", x = 67, y = 44 })
  kit.waitFor(function() return kit.state().map == "orrenshire" end, 20)
  mark("at town")
  local still = stillAfter(cfg.stillAt or 30)
  local choices, asking, walked = 0, false, false
  play(function(s)
    still()
    -- each question asked is a mark (choice1, choice2, ...), and so is the first walk through the town
    local now = s.mode == "talk" and s.run and s.run.wait == "pick"
    if now and not asking then
      choices = choices + 1
      mark("at choice" .. choices)
    end
    asking = now
    if not walked and s.mode == "walk" and not s.run then
      walked = true
      mark("at walking")
    end
    return s.flags.mine_pass and s.mode == "walk" and not s.run
  end, cfg.seconds or 120)
  mark("at mayor done")
  sleep(1)
end

--- Face the foe and ACT: a fight with spells, played by touch until it's won.
function SCENES.battle()
  continueSaved()
  sleep(1)
  mark("at walk")
  kit.act({ kind = "act" })
  kit.waitFor(function() return kit.state().mode == "battle" end, 5)
  mark("at battle")
  -- the picture: a hit landing, with every foe in view, once the fight has got going
  local from, stilled = os.clock() + (cfg.stillAt or 4), false
  play(function(s)
    local b = s.battle
    if not stilled and os.clock() >= from and b and b.phase == "run" and tostring(b.msg):upper():find("HITS FOR") then
      stilled = true
      mark("still")
    end
    return s.mode ~= "battle"
  end, cfg.seconds or 90)
  mark("at won")
  sleep(2)
end

--- One step on, and the last act's doctor is waiting: a word with her, then the fight, by touch.
function SCENES.boss()
  continueSaved()
  sleep(1)
  kit.act({ kind = "turn", dir = "up" })
  mark("at step")
  local still = stillAfter(1e9)
  play(function(s)
    if s.mode == "battle" and not SCENES.fighting then
      SCENES.fighting = true
      mark("at fight")
      still = stillAfter(cfg.stillAt or 14)
    end
    still()
    for _, f in ipairs(s.battle and s.battle.foes or {}) do
      if f.charging and not SCENES.warned then
        SCENES.warned = true
        mark("at telegraph")
      end
    end
    return SCENES.fighting and s.mode ~= "battle"
  end, cfg.seconds or 150)
  mark("at boss done")
  sleep(1)
end

--- The cot: the hero lies down and goes under, into the dream.
function SCENES.dream()
  continueSaved()
  sleep(1)
  kit.act({ kind = "act" })
  mark("at cot")
  local still = stillAfter(cfg.stillAt or 1e9)
  play(function(s)
    still()
    if s.map ~= "fn_vault_5" and not SCENES.under then
      SCENES.under = true
      mark("at dream")
    end
    return SCENES.under and s.mode == "walk" and not s.run
  end, cfg.seconds or 90)
  sleep(1)
  -- a few steps in the dream
  for _ = 1, 4 do
    local s = kit.state()
    local action = rules.bot(s, botRng)
    if action then kit.act(action, 0.05) end
    sleep(0.5)
  end
  mark("at dream walk")
  sleep(1.5)
end

-- ---------------------------------------------------------------- go

local scene = cfg.scene
if SAVES[scene] then
  local s = SAVES[scene]()
  saves.init(kit.DATA)
  if fs.exists(kit.DATA) then fs.delete(kit.DATA) end
  local ok, why = saves.write("Player", s, 12345)
  if not ok then error("could not write the save: " .. tostring(why), 0) end
end

kit.run(function()
  mark("go")
  local ok, err = pcall(SCENES[scene])
  if not ok then mark("note error " .. tostring(err):gsub("%s+", " ")) end
  local s = kit.state()
  if s then mark("note ended in " .. s.mode .. " on " .. tostring(s.map)) end
  mark("done")
end, { keepSaves = true })
