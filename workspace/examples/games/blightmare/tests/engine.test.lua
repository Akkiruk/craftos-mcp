-- BLIGHTMARE's engine: the script runner, walking, the overworld, the wipe rule, the menu and saves, against small stand-ins
-- for the maps, the story and the battle, so each rule is checked on a map made for it. Then the real content, with the bot.
-- play.test.lua covers the shell around it.
local kit = loadfile(fs.combine(fs.getDir(fs.getDir(shell.getRunningProgram())), "testkit.lua"), nil, _ENV)()
local seeded = require("lib.rng")
local eq, truthy = ccunit.eq, ccunit.truthy

local surfaceApi = require("lib.surface")
local font = surfaceApi.loadFont(surfaceApi.load("/" .. fs.combine(kit.root, "lib/font")))
local ui = require("lib.ui")
ui.init(surfaceApi, font, surfaceApi.create(121, 81))

local PREFIX = "games.blightmare."
local STOOD_IN = { "maps", "story", "battle", "enemies", "overworld", "art", "view_world", "view_battle" }

local function breathe()
  os.queueEvent("blightmare")
  os.pullEvent("blightmare")
end

-- ---------------------------------------------------------------- stand-ins

local fake = {} -- what the next fight does: outcome, and how many ticks it lasts

local battleStub = {}
function battleStub.begin(s, id)
  s.battle = { enc = id, left = fake.ticks or 2 }
  s.mode = "battle"
  s.rev = s.rev + 1
end
function battleStub.input(s, action) s.battle.seen = action.kind end
function battleStub.tick(s, rng)
  local b = s.battle
  b.rolled = rng(1000)
  b.left = b.left - 1
  if b.left <= 0 then
    b.result = fake.outcome or "won"
    s.score = s.score + 5
  end
  s.rev = s.rev + 1
  return { { type = "win" } }
end
function battleStub.bot() return nil end

local enemiesStub = {
  ENCOUNTERS = { t1 = { foes = { "x" } }, doom = { foes = { "x" }, mustLose = true }, f1 = { foes = { "x" } } },
  FIELD = { heart = { "f1" }, road = { "f1" } },
}

local LONG = ("the quick brown fox jumps over the lazy dog and keeps on running through the night "):rep(20)

local storyStub = {
  START = "intro",
  SHOPS = { town = { { item = "potion", price = 12 }, { item = "shortsword", price = 60 }, { item = "ether", price = 40 } } },
  SCRIPTS = {
    intro = { { say = "hero", text = "Hello {hero}." } },
    plain = { { text = "One." }, { say = "smith", text = "Two." }, { big = "THREE" }, { set = "after" } },
    long = { { say = "deserter", text = LONG }, { text = "done" } },
    ask = {
      { text = "Well?" },
      { choice = { { "Yes", { { set = "yes" }, { text = "good" } } }, { "No", { { set = "no" } } } } },
      { set = "asked" },
    },
    twig = {
      { when = "a", steps = { { set = "had_a" }, { when = "b", steps = { { set = "had_b" } }, other = { { set = "no_b" } } } }, other = { { set = "no_a" } } },
      { set = "end" },
    },
    bits = {
      { set = "x" }, { set = "y" }, { unset = "y" }, { give = "potion", n = 2 }, { give = "ether" }, { gold = 50 }, { gold = -20 },
      { join = "deserter", lvl = 2 }, { join = "deserter", lvl = 9 }, { sfx = "hit" }, { text = "end of bits" },
    },
    healer = { { heal = true } },
    fight = { { text = "here it comes" }, { battle = "t1" }, { set = "fought" }, { text = "over" } },
    trap = { { battle = "doom" }, { set = "doomed" } },
    deadly = { { battle = "t1" }, { set = "survived" } },
    warpy = { { warp = { "scythebreak", 5, 3, 2 } }, { text = "arrived" } },
    outdoors = { { world = { 3, 3 } }, { text = "outside" } },
    store = { { shop = "town" }, { set = "shopped" } },
    bed = { { inn = 20 }, { set = "slept" } },
    mark = { { save = true } },
    dark = { { fade = true }, { set = "faded" } },
    finale = { { fin = true }, { set = "after_fin" } },
    guard = { { text = "halt" } },
    trip = { { text = "a step" }, { set = "tripped" } },
    gated = { { text = "shut" } },
    arrive = { { set = "arrived" } },
  },
}

local mapsStub = {
  DATA = {
    scythebreak = {
      name = "TOWN", theme = "town", savepoint = true,
      rows = {
        "##########",
        "#........#",
        "#........#",
        "#..+..L..#",
        "#........#",
        "#........>",
        "##########",
      },
      npcs = {
        { id = "g", x = 8, y = 2, sprite = "gnome", script = "guard" },
        { id = "gone", x = 8, y = 3, sprite = "gnome", script = "guard", unless = "guard_left" },
        { id = "late", x = 2, y = 5, sprite = "gnome", script = "guard", when = "late" },
      },
      steps = {
        { x = 5, y = 2, script = "trip", once = true },
        { x = 6, y = 2, script = "deadly", once = true },
        { x = 7, y = 5, script = "guard", when = "armed" },
      },
      chests = { { id = "c1", x = 9, y = 4, give = "potion", n = 2, gold = 7 } },
      foes = {},
      exits = { { x = 10, y = 6, map = "cave", mx = 2, my = 2, dir = 2 }, { x = 1, y = 2, world = { 3, 3 } } },
    },
    cave = {
      name = "CAVE", theme = "mine",
      rows = {
        "##########",
        "#........#",
        "#........#",
        "#........#",
        "#........#",
        "##########",
      },
      steps = { { x = 2, y = 3, script = "arrive", once = true } },
      foes = { { id = "f1", x = 6, y = 2, enc = "t1", sprite = "miner" }, { id = "f2", x = 9, y = 5, enc = "t1", sprite = "miner" } },
      exits = { { x = 1, y = 3, map = "deep", mx = 2, my = 2, dir = 2 }, { x = 10, y = 3, map = "shut", mx = 2, my = 2, dir = 2, when = "never" } },
    },
    deep = {
      name = "DEEP", theme = "mine",
      rows = { "#####", "#...#", "#...#", "#####" },
      exits = { { x = 3, y = 1, map = "cave", mx = 2, my = 3, dir = 2 } },
    },
    shut = { name = "SHUT", theme = "mine", rows = { "#####", "#...#", "#####" }, exits = {} },
  },
}

local overworldStub = {
  ROWS = {
    "~~~~~~~~~~~~",
    "~..........~",
    "~....====..~",
    "~.=.......~~",
    "~.O.....^^^~",
    "~~~~~~~~~~~~",
  },
  SITES = { { id = "t", x = 3, y = 5, map = "scythebreak", mx = 2, my = 2, dir = 2, name = "TOWN" }, { id = "s", x = 11, y = 2, map = "cave", mx = 3, my = 3, dir = 1, name = "SHUT", when = "unlocked" } },
  GATES = { { x = 10, y = 3, script = "gated" } },
}
function overworldStub.gateAt(x, y, s)
  for _, gate in ipairs(overworldStub.GATES) do
    local flags = s and s.flags or {}
    local closed = (not gate.when or flags[gate.when]) and not (gate.unless and flags[gate.unless])
    if gate.x == x and gate.y == y and closed then return gate end
  end
  return nil
end

function overworldStub.tileAt(x, y)
  local row = overworldStub.ROWS[y]
  if not row or x < 1 or x > #row then return "~" end
  return row:sub(x, x)
end
function overworldStub.walkable(x, y)
  local c = overworldStub.tileAt(x, y)
  return c ~= "~" and c ~= "^"
end
function overworldStub.region(x, y)
  local c = overworldStub.tileAt(x, y)
  if c == "=" or c == "O" then return "road" end
  return "heart"
end

local viewWorldStub = { HUD_Y = 72 }
function viewWorldStub.drawWalk() end
function viewWorldStub.drawWorld() end

local viewBattleStub = {}
function viewBattleStub.draw() end
function viewBattleStub.actionAt() return { kind = "cmd", cmd = "attack" } end

local artStub = { portrait = function() end }

local stubs = {
  maps = mapsStub, story = storyStub, battle = battleStub, enemies = enemiesStub, overworld = overworldStub,
  art = artStub, view_world = viewWorldStub, view_battle = viewBattleStub,
}

local real = {} -- the real parts, kept between tests once loaded

local function useStubs()
  for _, name in ipairs(STOOD_IN) do
    local loaded = package.loaded[PREFIX .. name]
    if loaded and loaded ~= stubs[name] then real[name] = loaded end
    package.loaded[PREFIX .. name] = stubs[name]
  end
end

local function useReal()
  for _, name in ipairs(STOOD_IN) do package.loaded[PREFIX .. name] = real[name] end
end

-- The test runner may hold a test until later, so each one sets up its own world as it starts.
local function t(name, fn)
  ccunit.test(name, function()
    useStubs()
    fn()
  end)
end

local function tReal(name, fn)
  ccunit.test(name, function()
    useReal()
    fn()
  end)
end

useStubs()
local rules = require(PREFIX .. "rules")
local plugin = require(PREFIX .. "plugin")
local view = plugin.view

-- ---------------------------------------------------------------- driving it

local TAP, ACT, MENU = { kind = "tap" }, { kind = "act" }, { kind = "menu" }
local UP, DOWN, LEFT, RIGHT = { kind = "turn", dir = "up" }, { kind = "turn", dir = "down" }, { kind = "turn", dir = "left" }, { kind = "turn", dir = "right" }

local function press(s, rng, action)
  rules.input(s, action)
  return rules.tick(s, rng)
end

--- A new game, past the opening line, standing in the town.
local function fresh(x, y, dir)
  local rng = seeded.rng(11)
  fake.outcome, fake.ticks = "won", 2
  local s = rules.new({ rng = rng, player = "Ada" })
  rules.tick(s, rng)
  press(s, rng, TAP)
  eq(s.mode, "walk")
  s.x, s.y, s.dir = x or 2, y or 2, dir or 2
  return s, rng
end

--- Run a script from where the player stands, up to the first thing it waits for.
local function script(s, rng, id)
  truthy(rules.startScript(s, id), "no script " .. id)
  rules.tick(s, rng)
end

local function has(events, kind)
  for _, ev in ipairs(events) do
    if ev.type == kind then return ev end
  end
  return nil
end

--- Everything in a value, in a set order: two tables with the same content give the same string however they were built.
local function canon(v)
  if type(v) ~= "table" then return type(v) .. ":" .. tostring(v) end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys, function(a, b)
    if type(a) ~= type(b) then return type(a) < type(b) end
    return a < b
  end)
  local out = {}
  for _, k in ipairs(keys) do out[#out + 1] = tostring(k) .. "=" .. canon(v[k]) end
  return "{" .. table.concat(out, ",") .. "}"
end

local function throughSave(s)
  return textutils.unserialise(textutils.serialise(s))
end

--- Two rngs at the same place, one for the game that goes on and one for its copy from a save.
local function twoRngs(seed) return seeded.rng(seed), seeded.rng(seed) end

--- The state and its copy from a save must go on in step, tap by tap.
local function sameFuture(s, copy, rngA, rngB, actions, ticks)
  eq(canon(copy), canon(s), "the copy from a save differs")
  for i = 1, ticks do
    local action = actions and actions[i]
    if action then
      rules.input(s, action)
      rules.input(copy, action)
    end
    rules.tick(s, rngA)
    rules.tick(copy, rngB)
    eq(canon(copy), canon(s), "the games parted at tick " .. i)
  end
end

-- ---------------------------------------------------------------- the state

t("a new game follows the contract", function()
  local rng = seeded.rng(3)
  local s = rules.new({ rng = rng, player = "Ada" })
  eq(s.v, 3)
  eq(s.score, 0)
  eq(s.level, 1)
  eq(s.over, false)
  eq(s.won, false)
  eq(s.mode, "talk")
  eq(s.heroName, "Ada")
  eq(s.party[1].id, "hero")
  eq(s.bag.potion, 3)
  eq(s.savepoint.map, "scythebreak", "a map with savepoint = true sets one on arrival")
  eq(rules.new({ rng = rng }).heroName, "Hero")
  textutils.serialise(s)
end)

t("the state has no functions, metatables or shared tables", function()
  local s, rng = fresh()
  local seen = {}
  local function walk(v, path)
    if type(v) == "function" then error("a function at " .. path) end
    if type(v) ~= "table" then return end
    truthy(getmetatable(v) == nil, "a metatable at " .. path)
    truthy(not seen[v], "a shared table at " .. path)
    seen[v] = true
    for k, value in pairs(v) do walk(value, path .. "." .. tostring(k)) end
  end
  script(s, rng, "fight")
  press(s, rng, TAP)
  walk(s, "s")
end)

-- ---------------------------------------------------------------- text

t("text wraps by words and never over its width", function()
  for _, width in ipairs({ rules.SAY_WIDE, rules.NARRATE_WIDE, 20 }) do
    local lines = rules.wrap(LONG, width)
    local again = {}
    for i, line in ipairs(lines) do
      truthy(#line <= width, "line " .. i .. " is too long")
      again[i] = line
    end
    eq(table.concat(again, " "), LONG:gsub("%s+$", ""), "wrapping lost or broke a word")
  end
end)

t("a word longer than a line is cut, and a newline starts a line", function()
  local lines = rules.wrap("ab " .. ("x"):rep(25) .. " cd", 10)
  eq(lines[1], "ab")
  eq(lines[2], ("x"):rep(10))
  eq(lines[3], ("x"):rep(10))
  eq(lines[4], "xxxxx cd")
  local two = rules.wrap("one\ntwo", 40)
  eq(#two, 2)
  eq(two[2], "two")
  eq(rules.wrap("", 10)[1], "")
end)

t("a long text pages itself, and each page fits the box", function()
  local s, rng = fresh()
  script(s, rng, "long")
  local talk = rules.talk(s)
  truthy(talk.pages > 2, "the text should need pages")
  eq(talk.say, "deserter")
  eq(talk.name, "THE DOCTOR")
  local read = {}
  for page = 1, talk.pages do
    talk = rules.talk(s)
    eq(talk.page, page)
    eq(talk.more, page < talk.pages)
    truthy(#talk.lines <= rules.TEXT_LINES, "page " .. page .. " is too long")
    for _, line in ipairs(talk.lines) do read[#read + 1] = line end
    press(s, rng, TAP)
  end
  eq(table.concat(read, " "), LONG:gsub("%s+$", ""), "paging lost a word")
  eq(rules.talk(s).lines[1], "done")
end)

t("{hero} is the hero's name, and the hero speaks as themselves", function()
  local rng = seeded.rng(3)
  local s = rules.new({ rng = rng, player = "Ada%1" })
  rules.tick(s, rng)
  local talk = rules.talk(s)
  eq(talk.lines[1], "Hello Ada%1.")
  eq(talk.name, "Ada%1")
end)

-- ---------------------------------------------------------------- the script runner

t("say, text and big each wait for a tap, in order", function()
  local s, rng = fresh()
  script(s, rng, "plain")
  eq(s.mode, "talk")
  eq(s.run.back, "walk")
  local talk = rules.talk(s)
  eq(talk.say, nil)
  eq(talk.lines[1], "One.")
  press(s, rng, TAP)
  talk = rules.talk(s)
  eq(talk.say, "smith")
  eq(talk.name, "SMITH")
  eq(talk.lines[1], "Two.")
  press(s, rng, ACT) -- any tap goes on
  talk = rules.talk(s)
  eq(talk.big[1], "THREE")
  eq(talk.lines, nil)
  eq(s.flags.after, nil)
  press(s, rng, TAP)
  eq(s.flags.after, true)
  eq(s.mode, "walk")
  eq(s.run, nil)
end)

t("a choice shows under its question, and takes only a real pick", function()
  local s, rng = fresh()
  script(s, rng, "ask")
  local talk = rules.talk(s)
  eq(talk.lines[1], "Well?")
  eq(#talk.choices, 2)
  eq(talk.choices[2], "No")
  press(s, rng, TAP)
  press(s, rng, ACT)
  press(s, rng, { kind = "pick", i = 3 })
  eq(s.mode, "talk")
  eq(s.flags.asked, nil)
  press(s, rng, { kind = "pick", i = 1 })
  eq(s.flags.yes, true)
  eq(rules.talk(s).lines[1], "good")
  press(s, rng, TAP)
  eq(s.flags.asked, true, "the script carries on after the branch")
  eq(s.mode, "walk")
end)

t("the second choice takes its own branch", function()
  local s, rng = fresh()
  script(s, rng, "ask")
  press(s, rng, { kind = "pick", i = 2 })
  eq(s.flags.no, true)
  eq(s.flags.yes, nil)
  eq(s.flags.asked, true)
end)

t("an again option returns to the list, a way out leaves, and a save mid-list resumes exactly", function()
  storyStub.SCRIPTS.topics = {
    { say = "smith", text = "Anything else?", choice = {
      { "The mine?", { { set = "heard" }, { text = "It's deep." } }, again = true },
      { "That's all.", { { set = "left" } } },
    } },
    { set = "after" },
  }
  local s, rng = fresh()
  script(s, rng, "topics")
  local talk = rules.talk(s)
  eq(talk.lines[1], "Anything else?", "the list has someone asking")
  eq(#talk.choices, 2)
  eq(rules.bot(s, rng).i, 2, "the bot takes the way out, not a topic")
  press(s, rng, { kind = "pick", i = 1 })
  eq(s.flags.heard, true)
  eq(rules.talk(s).lines[1], "It's deep.")

  local rngA, rngB = twoRngs(5)
  sameFuture(s, throughSave(s), rngA, rngB, { TAP }, 3)
  talk = rules.talk(s)
  eq(s.mode, "talk", "still in the conversation")
  eq(talk.lines[1], "Anything else?", "the topic came back to the list")
  eq(#talk.choices, 2)
  eq(s.flags.left, nil)

  local copy = throughSave(s)
  local rngC = seeded.rng(5)
  rules.input(copy, { kind = "pick", i = 2 })
  rules.tick(copy, rngC)
  eq(copy.flags.left, true, "a save taken at the list takes its picks")
  eq(copy.flags.after, true, "and carries on past it")
  eq(copy.mode, "walk")

  press(s, rng, { kind = "pick", i = 2 })
  eq(s.flags.left, true)
  eq(s.flags.after, true, "the way out goes on with the script")
  eq(s.mode, "walk")
end)

t("when takes steps or other, nested, and then goes on", function()
  local s, rng = fresh()
  script(s, rng, "twig")
  eq(s.flags.no_a, true)
  eq(s.flags["end"], true)
  s = fresh()
  s.flags.a = true
  rng = seeded.rng(1)
  script(s, rng, "twig")
  eq(s.flags.had_a, true)
  eq(s.flags.no_b, true)
  eq(s.flags.no_a, nil)
  s = fresh()
  s.flags.a, s.flags.b = true, true
  script(s, rng, "twig")
  eq(s.flags.had_b, true)
  eq(s.flags["end"], true)
end)

t("set, unset, give, gold and join", function()
  local s, rng = fresh()
  local before = s.bag.potion
  rules.startScript(s, "bits")
  local events = rules.tick(s, rng)
  eq(s.flags.x, true)
  eq(s.flags.y, nil)
  eq(s.bag.potion, before + 2)
  eq(s.bag.ether, 1)
  eq(s.gold, 30)
  eq(#s.party, 2, "someone already in the party doesn't join twice")
  eq(s.party[2].id, "deserter")
  eq(s.party[2].lvl, 2)
  eq(has(events, "sfx").name, "hit")
end)

t("gold can't go below nothing", function()
  local s, rng = fresh()
  s.gold = 5
  rules.startScript(s, "bits")
  rules.tick(s, rng)
  eq(s.gold, 35)
  storyStub.SCRIPTS.take = { { gold = -99 } }
  script(s, rng, "take")
  eq(s.gold, 0)
end)

t("heal puts the whole party right", function()
  local s, rng = fresh()
  s.party[1].hp = 1
  script(s, rng, "healer")
  eq(s.party[1].hp, 40)
end)

t("a script's battle waits, and the script goes on after it", function()
  local s, rng = fresh()
  script(s, rng, "fight")
  press(s, rng, TAP)
  eq(s.mode, "battle")
  eq(s.back, "talk")
  rules.input(s, ACT)
  eq(s.battle.seen, "act", "a tap in a battle goes straight to the battle")
  rules.tick(s, rng)
  local events = rules.tick(s, rng)
  truthy(has(events, "win"), "the battle's events come through")
  eq(s.battle, nil)
  eq(s.fight, nil)
  eq(s.flags.fought, true)
  eq(s.mode, "talk")
  eq(rules.talk(s).lines[1], "over")
  press(s, rng, TAP)
  eq(s.mode, "walk")
  eq(s.back, nil)
end)

t("a fled script battle carries on too", function()
  local s, rng = fresh()
  script(s, rng, "fight")
  press(s, rng, TAP)
  fake.outcome = "fled"
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.flags.fought, true)
end)

t("warp moves the party, sets a save point on such a map, and fires what's there when the script ends", function()
  local s, rng = fresh()
  mapsStub.DATA.scythebreak.steps[#mapsStub.DATA.scythebreak.steps + 1] = { x = 5, y = 3, script = "guard", once = true }
  s.map, s.x, s.y = "cave", 3, 3
  s.savepoint = nil
  script(s, rng, "warpy")
  eq(s.map, "scythebreak")
  eq(s.x, 5)
  eq(s.y, 3)
  eq(s.dir, 2)
  eq(s.savepoint.map, "scythebreak")
  eq(rules.talk(s).lines[1], "arrived")
  press(s, rng, TAP)
  eq(s.mode, "talk", "the step under the warp fires")
  press(s, rng, TAP)
  eq(s.mode, "walk")
  table.remove(mapsStub.DATA.scythebreak.steps)
end)

t("world puts the party on the overworld at the end of the script", function()
  local s, rng = fresh()
  script(s, rng, "outdoors")
  eq(s.wx, 3)
  eq(s.wy, 3)
  press(s, rng, TAP)
  eq(s.mode, "world")
end)

t("shop opens and comes back to the script", function()
  local s, rng = fresh()
  s.gold = 100
  script(s, rng, "store")
  eq(s.mode, "shop")
  eq(#rules.shopRows(s), 3)
  press(s, rng, { kind = "pick", i = 1 })
  eq(s.gold, 88)
  eq(s.bag.potion, 4)
  press(s, rng, { kind = "pick", i = 2 })
  eq(s.gold, 28)
  eq(s.bag.shortsword, 1)
  press(s, rng, { kind = "pick", i = 3 })
  eq(s.gold, 28, "too dear")
  eq(s.bag.ether, nil)
  eq(s.shop.line, "You can't afford that.")
  press(s, rng, { kind = "back" })
  eq(s.flags.shopped, true)
  eq(s.mode, "walk")
end)

t("inn takes the money and heals, and turns away the poor", function()
  local s, rng = fresh()
  s.party[1].hp = 1
  s.gold = 25
  script(s, rng, "bed")
  eq(s.gold, 5)
  eq(s.party[1].hp, 40)
  press(s, rng, TAP)
  eq(s.flags.slept, true)
  s.flags.slept = nil
  s.party[1].hp = 1
  script(s, rng, "bed")
  eq(s.gold, 5)
  eq(s.party[1].hp, 1)
  truthy(rules.talk(s).lines[1]:find("can't pay"), "says why")
  press(s, rng, TAP)
  eq(s.flags.slept, true)
end)

t("save marks a save point here", function()
  local s, rng = fresh(4, 5, 3)
  s.savepoint = nil
  script(s, rng, "mark")
  eq(s.savepoint.map, "scythebreak")
  eq(s.savepoint.x, 4)
  eq(s.savepoint.y, 5)
  eq(s.savepoint.dir, 3)
end)

t("fade holds the script for a moment, and taps wait", function()
  local s, rng = fresh()
  script(s, rng, "dark")
  eq(s.run.wait, "fade")
  truthy(s.fx.fade > 0, "fading")
  press(s, rng, TAP)
  eq(s.flags.faded, nil)
  for _ = 1, 10 do rules.tick(s, rng) end
  eq(s.flags.faded, true)
  eq(s.mode, "walk")
end)

t("fin shows TO BE CONTINUED, then leaves the player free to walk with the game not over", function()
  local s, rng = fresh()
  local events
  rules.startScript(s, "finale")
  events = rules.tick(s, rng)
  truthy(has(events, "fin"), "a fin event")
  eq(s.fin, true)
  eq(rules.talk(s).big[1], "TO BE CONTINUED")
  press(s, rng, TAP)
  eq(s.flags.after_fin, true)
  eq(s.mode, "walk")
  eq(s.over, false)
  press(s, rng, UP)
  eq(s.x, 3)
end)

t("a step the running version doesn't know is passed over, and a script missing a place just ends", function()
  local s, rng = fresh()
  storyStub.SCRIPTS.odd = { { nonsense = true }, { set = "passed" } }
  script(s, rng, "odd")
  eq(s.flags.passed, true)
  script(s, rng, "plain")
  s.run.at[1].i = 99 -- a save from before a script was shortened
  press(s, rng, TAP)
  eq(s.mode, "walk")
  eq(rules.startScript(s, "no_such_script"), false)
end)

-- ---------------------------------------------------------------- walking

t("up steps forward, down steps back, and the sides turn on the spot", function()
  local s, rng = fresh(2, 2, 2)
  local events = press(s, rng, UP)
  eq(s.x, 3)
  truthy(has(events, "step"), "a step event")
  press(s, rng, DOWN)
  eq(s.x, 2)
  eq(s.dir, 2)
  press(s, rng, RIGHT)
  eq(s.dir, 3)
  press(s, rng, LEFT)
  press(s, rng, LEFT)
  eq(s.dir, 1)
  press(s, rng, LEFT)
  eq(s.dir, 4)
  eq(s.x, 2)
  eq(s.y, 2)
end)

t("walls stop you with a bump, and NPCs and chests stand in the way", function()
  local s, rng = fresh(2, 3, 1)
  truthy(has(press(s, rng, UP), "step"), "row 2 is floor")
  truthy(has(press(s, rng, UP), "bump"), "a wall")
  eq(s.y, 2)
  s.x, s.y, s.dir = 7, 2, 2
  truthy(has(press(s, rng, UP), "bump"), "an NPC")
  eq(s.x, 7)
  s.x, s.y, s.dir = 9, 3, 3
  truthy(has(press(s, rng, UP), "bump"), "a chest")
  eq(s.y, 3)
end)

t("ACT talks to the NPC ahead, and when and unless choose who's there", function()
  local s, rng = fresh(7, 2, 2)
  eq(rules.target(s), "npc")
  press(s, rng, ACT)
  eq(s.mode, "talk")
  eq(rules.talk(s).lines[1], "halt")
  press(s, rng, TAP)
  s.x, s.y, s.dir = 3, 5, 4
  eq(rules.target(s), nil, "late isn't here yet")
  s.flags.late = true
  eq(rules.target(s), "npc")
  s.x, s.y, s.dir = 7, 3, 2
  eq(rules.target(s), "npc")
  s.flags.guard_left = true
  eq(rules.target(s), nil, "gone has gone")
  press(s, rng, UP)
  eq(s.x, 8, "and the square is free")
end)

t("doors open with ACT and stay open, and a locked one wants a key", function()
  local s, rng = fresh(4, 3, 3)
  eq(rules.target(s), "door")
  truthy(has(press(s, rng, UP), "bump"), "a shut door stops you")
  eq(s.y, 3)
  truthy(has(press(s, rng, ACT), "door"), "it opens")
  eq(rules.target(s), nil)
  press(s, rng, UP)
  eq(s.y, 4)
  press(s, rng, UP)
  press(s, rng, DOWN)
  press(s, rng, DOWN)
  eq(s.y, 3, "open both ways, still open")
  truthy(rules.isOpen(s, 4, 4), "s.opened holds it")
  truthy(not rules.isOpen(s, 3, 4), "only that one")
  s.x, s.y, s.dir = 7, 3, 3
  eq(rules.target(s), "locked")
  truthy(has(press(s, rng, ACT), "bump"), "locked")
  eq(s.mode, "walk")
  s.bag.key = 1
  truthy(has(press(s, rng, ACT), "unlock"), "unlocked")
  eq(s.bag.key, nil, "the key is used up")
  press(s, rng, UP)
  eq(s.y, 4)
end)

t("a chest gives once", function()
  local s, rng = fresh(9, 3, 3)
  local potions = s.bag.potion
  eq(rules.target(s), "chest")
  press(s, rng, ACT)
  eq(s.bag.potion, potions + 2)
  eq(s.gold, 7)
  truthy(s.opened["scythebreak:c1"], "kept in s.opened by map:id")
  eq(rules.target(s), nil)
  press(s, rng, UP)
  eq(s.y, 4, "an open chest is out of the way")
  s.x, s.y = 9, 3
  press(s, rng, ACT)
  eq(s.mode, "walk", "no second helping: ACT finds nothing and walks on")
  eq(s.bag.potion, potions + 2)
end)

t("the info bar opens the menu, and BACK returns to the same place", function()
  local s, rng = fresh(2, 3, 3)
  eq(rules.target(s), nil)
  press(s, rng, MENU)
  eq(s.mode, "menu")
  eq(s.back, "walk")
  press(s, rng, { kind = "back" })
  eq(s.mode, "walk")
  eq(s.menu, nil)
end)

t("a step trigger with once fires once, and a when keeps it asleep", function()
  local s, rng = fresh(4, 2, 2)
  press(s, rng, UP)
  eq(s.mode, "talk")
  rules.tick(s, rng)
  eq(rules.talk(s).lines[1], "a step")
  press(s, rng, TAP)
  eq(s.flags.tripped, true)
  s.flags.tripped = nil
  press(s, rng, DOWN)
  press(s, rng, UP)
  eq(s.mode, "walk", "once")
  eq(s.flags.tripped, nil)
  s.x, s.y, s.dir = 6, 5, 2
  press(s, rng, UP)
  eq(s.mode, "walk", "asleep")
  s.flags.armed = true
  press(s, rng, DOWN)
  press(s, rng, UP)
  eq(s.mode, "talk", "without once it fires each time")
end)

t("a step with a lost fight in it can be had again", function()
  local s, rng = fresh(5, 2, 2)
  s.opened["scythebreak:step:5,2"] = true
  press(s, rng, UP)
  eq(s.x, 6)
  rules.tick(s, rng)
  eq(s.mode, "battle")
  fake.outcome = "lost"
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.mode, "talk", "the wipe says what happened")
  press(s, rng, TAP)
  eq(s.mode, "walk")
  eq(s.opened["scythebreak:step:6,2"], nil, "the trigger is still armed")
  fake.outcome = "won"
  s.x, s.y, s.dir = 5, 2, 2
  press(s, rng, UP)
  rules.tick(s, rng)
  eq(s.mode, "battle")
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.opened["scythebreak:step:6,2"], true, "a win spends it")
  eq(s.flags.survived, true)
end)

t("walking onto an exit changes map and fires a trigger at the far end", function()
  local s, rng = fresh(9, 6, 2)
  eq(rules.target(s), "exit")
  press(s, rng, UP)
  eq(s.map, "cave")
  eq(s.x, 2)
  eq(s.y, 2)
  eq(s.dir, 2)
  eq(#s.foes, 2)
  press(s, rng, RIGHT)
  press(s, rng, UP)
  eq(s.y, 3)
  rules.tick(s, rng)
  eq(s.flags.arrived, true)
  s = fresh(9, 6, 2)
  rng = seeded.rng(8)
  mapsStub.DATA.cave.steps[1].x, mapsStub.DATA.cave.steps[1].y = 2, 2
  press(s, rng, ACT)
  eq(s.map, "cave", "ACT takes an exit too")
  rules.tick(s, rng)
  eq(s.flags.arrived, true, "arriving by an exit counts as stepping there")
  mapsStub.DATA.cave.steps[1].x, mapsStub.DATA.cave.steps[1].y = 2, 3
end)

t("an exit with world goes to the overworld, standing still", function()
  local s, rng = fresh(2, 2, 4)
  press(s, rng, UP)
  eq(s.mode, "world")
  eq(s.wx, 3)
  eq(s.wy, 3)
  eq(s.heading, nil)
end)

t("a map with savepoint sets one on arrival, and one without leaves it", function()
  local s, rng = fresh(9, 6, 2)
  press(s, rng, UP)
  eq(s.map, "cave")
  eq(s.savepoint.map, "scythebreak")
end)

-- ---------------------------------------------------------------- visible foes

local function inCave(x, y, dir)
  local s, rng = fresh(9, 6, 2)
  press(s, rng, UP)
  s.x, s.y, s.dir = x, y, dir
  return s, rng
end

t("a foe stands still until you're within three squares, then closes one square a step", function()
  local s, rng = inCave(2, 2, 2)
  s.foes[1].x = 8
  press(s, rng, UP)
  eq(s.foes[1].x, 8, "five squares off")
  press(s, rng, UP)
  eq(s.foes[1].x, 8, "four squares off")
  press(s, rng, UP)
  eq(s.x, 5)
  eq(s.foes[1].x, 7, "within three, it comes")
end)

t("a foe that reaches you starts its fight, and beaten stays beaten", function()
  local s, rng = inCave(4, 2, 2)
  press(s, rng, DOWN)
  eq(s.mode, "walk")
  press(s, rng, UP)
  press(s, rng, UP)
  eq(s.mode, "battle")
  eq(s.back, "walk")
  eq(s.fight.foe, "f1")
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.mode, "walk")
  eq(s.beaten["cave:f1"], true)
  eq(#s.foes, 1)
  eq(s.foes[1].id, "f2")
end)

t("walking into a foe or ACT on one starts the fight", function()
  local s, rng = inCave(5, 2, 2)
  eq(rules.target(s), "foe")
  press(s, rng, UP)
  eq(s.mode, "battle")
  s, rng = inCave(5, 2, 2)
  press(s, rng, ACT)
  eq(s.mode, "battle")
end)

t("a foe you flee from is gone for now and back on the next visit", function()
  local s, rng = inCave(5, 2, 2)
  press(s, rng, UP)
  fake.outcome = "fled"
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.mode, "walk")
  eq(#s.foes, 1)
  eq(s.beaten["cave:f1"], nil)
end)

t("a foe won't walk through a wall, an NPC or another foe", function()
  local s, rng = inCave(2, 3, 3)
  s.foes = { { id = "f1", x = 5, y = 4 }, { id = "f2", x = 4, y = 4 } }
  press(s, rng, UP)
  eq(s.y, 4)
  eq(s.mode, "walk")
  eq(s.foes[1].x, 5, "f1 waits behind f2")
  eq(s.foes[2].x, 3, "f2 closes")
  s.foes = { { id = "f1", x = 2, y = 5 } }
  s.x, s.y, s.dir = 2, 3, 1
  mapsStub.DATA.cave.rows[4] = "####.#####" -- a wall between it and the player
  press(s, rng, UP)
  mapsStub.DATA.cave.rows[4] = "#........#"
  eq(s.foes[1].y, 5, "a wall stops it")
end)

-- ---------------------------------------------------------------- the wipe rule

t("a loss goes back to the save point for a small toll, with everyone well", function()
  local s, rng = inCave(5, 2, 2)
  s.gold = 500
  s.party[1].hp = 3
  s.savepoint = { map = "scythebreak", x = 4, y = 2, dir = 3 }
  press(s, rng, UP)
  fake.outcome = "lost"
  rules.tick(s, rng)
  local events = rules.tick(s, rng)
  truthy(has(events, "wipe"), "a wipe event")
  eq(s.map, "scythebreak")
  eq(s.x, 4)
  eq(s.y, 2)
  eq(s.dir, 3)
  local toll = rules.tollFor(s)
  truthy(toll > 0 and toll < 250, "a small toll, not half")
  eq(s.gold, 500 - toll)
  eq(s.party[1].hp, 40)
  eq(s.battle, nil)
  eq(s.back, nil)
  eq(s.over, false)
  eq(s.mode, "talk")
  truthy(table.concat(rules.talk(s).lines, " "):find(toll .. " gold"), "it says what it cost")
  press(s, rng, TAP)
  eq(s.mode, "walk")
end)

t("a loss puts the pack and purse back as they were going in, stolen things too, so losing on purpose never pays", function()
  local s, rng = inCave(5, 2, 2)
  s.gold = 300
  s.bag = { potion = 3, ether = 1 }
  s.savepoint = { map = "scythebreak", x = 4, y = 2, dir = 3 }
  press(s, rng, UP)
  eq(s.mode, "battle")
  s.bag.potion = 1   -- drunk in the fight
  s.bag.ether = nil  -- the last one, gone
  s.bag.elixir = 1   -- stolen from a foe
  s.gold = 100       -- thrown at a foe
  fake.outcome = "lost"
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.bag.potion, 3)
  eq(s.bag.ether, 1)
  eq(s.bag.elixir, nil, "what was stolen goes with the fight")
  eq(s.gold, 300 - rules.tollFor(s))
end)

t("a broke party is waved through, and the toll is the same each time", function()
  local s, rng = inCave(5, 2, 2)
  s.gold = 0
  s.savepoint = { map = "scythebreak", x = 4, y = 2, dir = 3 }
  press(s, rng, UP)
  fake.outcome = "lost"
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.gold, 0)
  eq(s.flags.toll_free, true)
  eq(s.deaths, 1)
  press(s, rng, TAP)
  eq(s.mode, "walk")
  s.gold = 1000
  local toll = rules.tollFor(s)
  script(s, rng, "deadly")
  eq(s.mode, "battle")
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.gold, 1000 - toll, "a flat toll, not a share of the purse")
  eq(s.flags.toll_free, nil)
  eq(s.deaths, 2)
end)

t("a loss in a script drops the script", function()
  local s, rng = fresh(3, 3, 1)
  s.gold = 10
  script(s, rng, "deadly")
  eq(s.mode, "battle")
  fake.outcome = "lost"
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.gold, 0, "the toll is more than 10 gold, so it takes what there is")
  eq(s.flags.toll_free, nil, "something was paid")
  press(s, rng, TAP)
  eq(s.mode, "walk")
  eq(s.flags.survived, nil)
  eq(s.run, nil)
end)

t("a mustLose fight counts as won, and the party isn't left dead", function()
  local s, rng = fresh(3, 3, 1)
  s.gold = 10
  s.party[1].hp = 0
  script(s, rng, "trap")
  fake.outcome = "lost"
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.flags.doomed, true)
  eq(s.gold, 10)
  eq(s.mode, "walk")
  truthy(s.party[1].hp > 0, "standing")
  eq(s.map, "scythebreak")
  eq(s.x, 3)
end)

-- ---------------------------------------------------------------- the overworld

local function onWorld(x, y)
  local s, rng = fresh(2, 2, 4)
  press(s, rng, UP)
  s.wx, s.wy = x, y
  s.safeSteps = 1000000 -- no encounters until a test wants them
  return s, rng
end

t("a tap sets a heading, and the party walks until a wall stops it", function()
  local s, rng = onWorld(2, 2)
  press(s, rng, RIGHT)
  eq(s.heading, 2)
  eq(s.wx, 3, "the first tile answers the tap")
  rules.tick(s, rng)
  eq(s.wx, 3)
  rules.tick(s, rng)
  eq(s.wx, 4, "about 4 tiles a second")
  for _ = 1, 40 do rules.tick(s, rng) end
  eq(s.wx, 11)
  eq(s.heading, nil, "the sea stopped it")
end)

t("the middle stops a walk and starts it again, and the info bar opens the menu", function()
  local s, rng = onWorld(2, 2)
  press(s, rng, RIGHT)
  press(s, rng, ACT)
  eq(s.heading, nil)
  eq(s.mode, "world")
  local x = s.wx
  for _ = 1, 6 do rules.tick(s, rng) end
  eq(s.wx, x)
  press(s, rng, MENU)
  eq(s.mode, "menu")
  eq(s.back, "world")
  press(s, rng, { kind = "back" })
  eq(s.mode, "world")
end)

t("another side changes the heading", function()
  local s, rng = onWorld(2, 2)
  press(s, rng, RIGHT)
  press(s, rng, DOWN)
  eq(s.heading, 3)
  eq(s.wy, 3)
end)

t("a road walk stops where the road bends", function()
  local s, rng = onWorld(7, 3)
  press(s, rng, RIGHT)
  for _ = 1, 8 do rules.tick(s, rng) end
  eq(s.wx, 9, "the end of the road, with nothing to the side: it runs on until the gate")
  s, rng = onWorld(3, 3)
  overworldStub.ROWS[3] = "~.======...~"
  overworldStub.ROWS[4] = "~.=....=..~~"
  s.wx, s.wy = 3, 3
  press(s, rng, RIGHT)
  for _ = 1, 16 do rules.tick(s, rng) end
  eq(s.wx, 8)
  eq(s.heading, nil, "stopped at the corner")
  overworldStub.ROWS[3] = "~....====..~"
  overworldStub.ROWS[4] = "~.=.......~~"
end)

t("walking onto a site goes in, and one whose flag isn't set is plain ground", function()
  local s, rng = onWorld(3, 4)
  press(s, rng, DOWN)
  eq(s.mode, "walk")
  eq(s.map, "scythebreak")
  eq(s.x, 2)
  eq(s.dir, 2)
  eq(s.heading, nil)
  s, rng = onWorld(11, 3)
  overworldStub.GATES[1].x = 99
  press(s, rng, UP)
  eq(s.mode, "world", "the flag isn't set")
  eq(s.wy, 2)
  s.flags.unlocked = true
  press(s, rng, DOWN)
  press(s, rng, UP)
  eq(s.mode, "walk")
  eq(s.map, "cave")
  overworldStub.GATES[1].x = 10
end)

t("a gate stops the party and runs its script", function()
  local s, rng = onWorld(9, 3)
  press(s, rng, RIGHT)
  eq(s.mode, "talk")
  eq(s.wx, 9, "not through it")
  eq(s.heading, nil)
  rules.tick(s, rng)
  eq(rules.talk(s).lines[1], "shut")
  press(s, rng, TAP)
  eq(s.mode, "world")
end)

t("encounters come about one in 25 steps, half as often on roads, and never right after a fight", function()
  local function steps(y, row)
    local saved = overworldStub.ROWS[y]
    overworldStub.ROWS[y] = row
    local s = onWorld(2, y)
    local rng = seeded.rng(1234)
    s.safeSteps = 5
    local fights, walked = 0, 0
    fake.ticks = 1
    for _ = 1, 8000 do
      if s.mode == "battle" then
        rules.tick(s, rng)
        fights = fights + 1
        truthy(s.safeSteps == 5, "grace after a fight")
      else
        s.wx = 2
        s.heading = 2
        s.walkClock = 1
        rules.tick(s, rng)
        walked = walked + 1
      end
    end
    overworldStub.ROWS[y] = saved
    return walked / fights
  end
  local grass = steps(2, "~.........~~")
  local road = steps(3, "~=========.~")
  truthy(grass > 20 and grass < 32, "one in " .. grass .. " on grass")
  truthy(road > 35 and road < 60, "one in " .. road .. " on the road")
end)

t("no region means no encounters", function()
  local s, rng = onWorld(2, 2)
  local region = overworldStub.region
  overworldStub.region = function() return nil end
  s.safeSteps = 0
  for _ = 1, 500 do
    s.wx, s.heading, s.walkClock = 2, 2, 1
    rules.tick(s, rng)
    eq(s.mode, "world")
  end
  overworldStub.region = region
end)

t("a win or flee from an encounter comes back to the overworld", function()
  local s, rng = onWorld(2, 2)
  s.safeSteps = 0
  local tries = 0
  while s.mode == "world" and tries < 2000 do
    s.wx, s.heading, s.walkClock = 2, 2, 1
    rules.tick(s, rng)
    tries = tries + 1
  end
  eq(s.mode, "battle")
  eq(s.back, "world")
  eq(s.heading, nil)
  rules.tick(s, rng)
  rules.tick(s, rng)
  eq(s.mode, "world")
end)

t("a wipe on the overworld lands on foot at the save point", function()
  local s, rng = onWorld(2, 2)
  s.savepoint = { map = "scythebreak", x = 4, y = 2, dir = 3 }
  s.fight = { enc = "t1" }
  s.back = "world"
  battleStub.begin(s, "t1")
  fake.outcome = "lost"
  s.battle.left = 1
  rules.tick(s, rng)
  press(s, rng, TAP)
  eq(s.mode, "walk")
  eq(s.map, "scythebreak")
end)

-- ---------------------------------------------------------------- the menu

local function inMenu()
  local s, rng = fresh(2, 3, 3)
  press(s, rng, MENU)
  return s, rng
end

local function pick(s, rng, i) press(s, rng, { kind = "pick", i = i }) end

t("items use from the menu, down to the last, and back", function()
  local s, rng = inMenu()
  s.party[1].hp = 2
  s.bag.potion = 1
  pick(s, rng, 1)
  eq(s.menu.page, "items")
  eq(rules.menuRows(s)[1].item, "potion")
  pick(s, rng, 1)
  eq(s.menu.page, "useon")
  pick(s, rng, 1)
  eq(s.party[1].hp, 37)
  eq(s.bag.potion, nil, "the last one leaves the bag")
  eq(s.menu.page, "items")
  press(s, rng, { kind = "back" })
  eq(s.menu.page, "main")
  press(s, rng, { kind = "back" })
  eq(s.mode, "walk")
end)

t("an item that would do nothing stays in the bag", function()
  local s, rng = inMenu()
  local potions = s.bag.potion
  pick(s, rng, 1)
  pick(s, rng, 1)
  pick(s, rng, 1)
  eq(s.bag.potion, potions)
  eq(s.menu.line, "It would do nothing.")
end)

t("an item only a battle can use doesn't get a target", function()
  local s, rng = inMenu()
  s.bag = { antidote = 1 }
  pick(s, rng, 1)
  pick(s, rng, 1)
  eq(s.menu.page, "items")
  eq(s.bag.antidote, 1)
  eq(s.menu.line, "That's for a fight.")
end)

t("gear swaps with what's worn, and the old piece goes in the bag", function()
  local s, rng = inMenu()
  s.bag.shortsword = 1
  s.bag.ringmail = 1
  pick(s, rng, 2)
  eq(s.menu.page, "gear")
  pick(s, rng, 1)
  eq(s.menu.page, "equip")
  local rows = rules.menuRows(s)
  eq(rows[1].gear, "shortsword", "weapons first")
  eq(rows[2].gear, "ringmail")
  local atk = require(PREFIX .. "party").stats(s.party[1]).atk
  pick(s, rng, 1)
  eq(s.party[1].weapon, "shortsword")
  eq(s.bag.shortsword, nil)
  eq(s.bag.knife, 1)
  truthy(require(PREFIX .. "party").stats(s.party[1]).atk > atk, "stronger")
  press(s, rng, { kind = "back" })
  eq(s.menu.page, "gear")
end)

t("status shows whoever is tapped", function()
  local s, rng = inMenu()
  s.party[2] = require(PREFIX .. "party").new("deserter", 2)
  pick(s, rng, 3)
  eq(s.menu.page, "status")
  pick(s, rng, 2)
  eq(s.menu.who, 2)
  local L = view.layout(121, 81)
  ui.setScreen(surfaceApi.create(121, 81))
  view.draw(L, s)
end)

t("a list too long for a page has MORE, and comes round", function()
  local s, rng = inMenu()
  for i = 1, 12 do
    if i % 2 == 0 then s.bag.shortsword = i else s.bag.ringmail = i end
  end
  for _, id in ipairs({ "knife", "scalpel", "cudgel", "miners_pick", "rags", "robe", "clinic_coat", "leathers" }) do s.bag[id] = 1 end
  pick(s, rng, 2)
  pick(s, rng, 1)
  local rows = rules.menuRows(s)
  eq(#rows, 8)
  eq(rows[8].label, "MORE")
  local first = rows[1].gear
  pick(s, rng, 8)
  rows = rules.menuRows(s)
  truthy(rows[1].gear ~= first, "the next page")
  eq(#rows, 4, "the last three and MORE")
end)

t("the menu tells taps from taps: rows, BACK, and the gaps", function()
  local s = inMenu()
  local L = view.layout(121, 81)
  local action = view.actionAt(L, s, 5, 13)
  eq(action.kind, "pick")
  eq(action.i, 1)
  eq(view.actionAt(L, s, 5, 19).i, 2)
  eq(view.actionAt(L, s, 5, 16), nil, "the gap between rows")
  eq(view.actionAt(L, s, 110, 3).kind, "back")
  eq(view.actionAt(L, s, 5, 50), nil, "past the last row")
end)

-- ---------------------------------------------------------------- the view

t("actionAt copes with no state", function()
  local L = view.layout(121, 81)
  eq(view.actionAt(L, nil, 60, 40), nil)
  eq(view.actionAt(L, nil, 1, 1), nil)
end)

t("the layout is the whole wall, with no buttons", function()
  local L = view.layout(121, 81)
  eq(L.W, 121)
  eq(L.H, 81)
  eq(L.x0, 0)
  eq(L.y0, 0)
  eq(L.bw, 121)
  eq(L.bh, 81)
  eq(L.statusY, 60)
  eq(#view.controls(L, nil), 0)
end)

t("the plugin is what the contract asks", function()
  eq(plugin.id, "blightmare")
  eq(plugin.title, "BLIGHTMARE")
  eq(plugin.story, true)
  eq(plugin.saves, true)
  eq(plugin.action, true)
  eq(plugin.tickMs, 120)
  eq(plugin.color, "red")
  eq(plugin.accent, 0xE5484D)
  eq(plugin.minSize.w, 120)
  eq(plugin.minSize.h, 78)
  truthy(not plugin.split, "the game draws its own hints")
  truthy(#plugin.help > 0, "help")
  -- the idle demo is the opening, which starts on its first step and carries on into play when touched
  local demo = {}
  eq(view.demoStep(demo, 1000), true, "the opening starts")
  truthy(demo.run and demo.run.page == 1)
  truthy(view.intro and view.intro.from and view.intro.step and view.intro.tap and view.intro.draw and view.intro.stop)
end)

t("walking taps: the middle is ACT and the sides steer", function()
  local s = fresh()
  local L = view.layout(121, 81)
  eq(view.actionAt(L, s, 60, 40).kind, "act")
  eq(view.actionAt(L, s, 60, 2).dir, "up")
  eq(view.actionAt(L, s, 60, 70).dir, "down")
  eq(view.actionAt(L, s, 60, 76).kind, "menu", "the info bar")
  eq(view.actionAt(L, s, 2, 40).dir, "left")
  eq(view.actionAt(L, s, 118, 40).dir, "right")
end)

t("talk taps: any tap goes on, but a choice wants its own row, clear of SAVE & QUIT", function()
  local s, rng = fresh()
  local L = view.layout(121, 81)
  script(s, rng, "plain")
  eq(view.actionAt(L, s, 10, 10).kind, "tap")
  script(s, rng, "ask")
  s.run.wait = nil
  s = fresh()
  script(s, rng, "ask")
  eq(view.actionAt(L, s, 10, 10), nil, "a stray tap doesn't answer")
  local hits = {}
  for y = 0, 80 do
    local action = view.actionAt(L, s, 40, y)
    if action then
      truthy(y < 73, "a row under SAVE & QUIT's height")
      hits[action.i] = true
    end
  end
  truthy(hits[1] and hits[2], "both rows can be tapped")
end)

t("battle taps go to the battle's view", function()
  local s, rng = fresh()
  script(s, rng, "deadly")
  eq(view.actionAt(view.layout(121, 81), s, 10, 10).cmd, "attack")
end)

--- What's on a row of the screen, as characters.
local function rowText(surf, y)
  local out = {}
  for x = 0, surf.width - 1 do
    local c = surf.buffer and surf.buffer[y * surf.width + x * 3 + 1]
    out[#out + 1] = c or " "
  end
  return table.concat(out)
end

t("every mode draws, and a picture is only painted when rev moves", function()
  local s, rng = fresh()
  local L = view.layout(121, 81)
  ui.setScreen(surfaceApi.create(121, 81))
  local paints = 0
  local draw = viewWorldStub.drawWalk
  viewWorldStub.drawWalk = function() paints = paints + 1 end
  view.draw(L, s)
  view.draw(L, s)
  view.draw(L, s)
  eq(paints, 1)
  press(s, rng, UP)
  view.draw(L, s)
  eq(paints, 2)
  viewWorldStub.drawWalk = draw
  script(s, rng, "long")
  view.draw(L, s)
  press(s, rng, TAP)
  view.draw(L, s)
  for _ = 1, 40 do press(s, rng, TAP) end
  script(s, rng, "ask")
  view.draw(L, s)
  press(s, rng, { kind = "pick", i = 2 })
  rules.tick(s, rng)
  script(s, rng, "dark")
  view.draw(L, s)
  for _ = 1, 8 do rules.tick(s, rng) end
  script(s, rng, "deadly")
  view.draw(L, s)
  rules.tick(s, rng)
  rules.tick(s, rng)
  script(s, rng, "store")
  view.draw(L, s)
  press(s, rng, { kind = "back" })
  press(s, rng, ACT)
  view.draw(L, s)
  s = fresh()
  script(s, rng, "finale")
  view.draw(L, s)
  eq(rowText(ui.screen(), 0) ~= nil, true)
end)

t("a text box fits the smallest wall allowed", function()
  local s, rng = fresh()
  local L = view.layout(120, 78)
  ui.setScreen(surfaceApi.create(120, 78))
  script(s, rng, "long")
  view.draw(L, s)
  script(s, rng, "ask")
  view.draw(L, s)
  ui.setScreen(surfaceApi.create(121, 81))
end)

t("the save line names the level and the place", function()
  local s = fresh()
  s.level, s.gold = 3, 12
  eq(view.saveSummary(s), "Level 3, TOWN, 12 gold")
  s.mode = "world"
  eq(view.saveSummary(s), "Level 3, the road, 12 gold")
end)

t("the idle screen is a title and leaves room for TOUCH TO PLAY", function()
  ui.setScreen(surfaceApi.create(121, 81))
  local py = view.drawAttract(121, 81, {})
  truthy(py + ui.fontHeight() < 81, "the prompt fits")
  eq(view.drawAttract(121, 81, {}), py)
end)

t("events make their sounds, and an unknown sfx is still a sound", function()
  local plays = {}
  local app = { audio = { play = function(name) plays[#plays + 1] = name end, later = function(name) plays[#plays + 1] = name end } }
  view.onEvents(app, nil, { { type = "step" }, { type = "step" }, { type = "sfx", name = "nobody_knows" }, { type = "fin" } })
  truthy(#plays >= 2 and #plays <= 3, "one of each: " .. #plays)
end)

-- ---------------------------------------------------------------- the rest of the game

local function stepsFor(s, rng, name, list)
  storyStub.SCRIPTS[name] = list
  rules.startScript(s, name)
  rules.tick(s, rng)
end

t("forks read the bag, the purse, and several flags", function()
  local s, rng = fresh()
  s.gold, s.flags.a, s.flags.b = 50, true, true
  stepsFor(s, rng, "forks", {
    { has = "potion", steps = { { set = "got" } }, other = { { set = "lacked" } } },
    { has = "ether", steps = { { set = "got2" } }, other = { { set = "lacked2" } } },
    { paid = 30, steps = { { set = "paid" } }, other = { { set = "broke" } } },
    { paid = 30, steps = { { set = "paid2" } }, other = { { set = "broke2" } } },
    { all = { "a", "b" }, steps = { { set = "both" } }, other = { { set = "not_both" } } },
    { all = { "a", "zz" }, steps = { { set = "both2" } }, other = { { set = "not_both2" } } },
    { count = { "a", "b", "zz" }, at = 2, steps = { { set = "two" } }, other = { { set = "few" } } },
    { count = { "a", "b", "zz" }, at = 3, steps = { { set = "three" } }, other = { { set = "few3" } } },
    { take = "potion", n = 99 },
  })
  for _, flag in ipairs({ "got", "lacked2", "paid", "broke2", "both", "not_both2", "two", "few3" }) do truthy(s.flags[flag], flag) end
  for _, flag in ipairs({ "lacked", "got2", "paid2", "broke", "not_both", "both2", "few", "three" }) do eq(s.flags[flag], nil, flag) end
  eq(s.gold, 20)
  eq(s.bag.potion, nil)
end)

t("people leave with their levels, and come back no lower than the party less one", function()
  local s, rng = fresh()
  stepsFor(s, rng, "in", { { join = "deserter", lvl = 3 }, { leave = "deserter" }, { leave = "hero" } })
  eq(#s.party, 1)
  eq(s.party[1].id, "hero")
  eq(s.away.deserter.lvl, 3)
  local party = require("games.blightmare.party")
  party.gainXp(s.party[1], party.xpFor(10))
  stepsFor(s, rng, "back", { { join = "deserter", lvl = 2 } })
  eq(s.party[2].id, "deserter")
  eq(s.party[2].lvl, 9)
  eq(s.party[2].hp, party.stats(s.party[2]).maxHp, "rested")
  eq(s.away.deserter, nil)
end)

t("solo sets the rest aside and brings them back, and a wipe brings them back too", function()
  local s, rng = fresh()
  stepsFor(s, rng, "in", { { join = "deserter", lvl = 3 }, { solo = "deserter" } })
  eq(#s.party, 1)
  eq(s.party[1].id, "deserter")
  stepsFor(s, rng, "out", { { unsolo = true } })
  eq(#s.party, 2)
  eq(s.stash, nil)
end)

t("the party page swaps who fights, and travel goes anywhere been", function()
  local s, rng = fresh()
  stepsFor(s, rng, "in", { { join = "deserter", lvl = 3 }, { join = "cleric", lvl = 3 } })
  press(s, rng, { kind = "menu" })
  local rows = rules.menuRows(s)
  local at
  for i, row in ipairs(rows) do if row.go == "party" then at = i end end
  truthy(at, "a party row")
  press(s, rng, { kind = "pick", i = at })
  press(s, rng, { kind = "pick", i = 1 })
  press(s, rng, { kind = "pick", i = 3 })
  eq(s.party[1].id, "cleric")
  eq(s.party[3].id, "hero")
  press(s, rng, { kind = "back" })
  press(s, rng, { kind = "back" })
  eq(s.mode, "walk")
end)

t("the end says so, wins the game, keeps the save, and goes back to the last safe place", function()
  local s, rng = fresh()
  s.savepoint = { map = "scythebreak", x = 2, y = 2, dir = 2 }
  stepsFor(s, rng, "bye", { { dark = true }, { ending = "wake" } })
  eq(rules.talk(s).big[1], "THE END")
  eq(s.won, true)
  eq(s.ended, "wake")
  eq(s.flags.cleared, true)
  press(s, rng, TAP)
  eq(s.mode, "walk")
  eq(s.over, false)
  eq(s.dark, nil)
end)

t("a save at the old TO BE CONTINUED walks on, with the flag that opens the road", function()
  local s, rng = fresh()
  s.v, s.fin, s.flags.finished = 2, true, true
  rules.tick(s, rng)
  eq(s.v, 3)
  eq(s.fin, nil)
  eq(s.mode, "walk")
end)

-- ---------------------------------------------------------------- saves

t("a save mid-talk resumes on the same page and goes on the same", function()
  local a, b = twoRngs(5)
  local s = fresh()
  script(s, a, "long")
  b = seeded.rng(5)
  a = seeded.rng(5)
  press(s, a, TAP)
  b() -- the same place in the sequence
  local copy = throughSave(s)
  eq(rules.talk(copy).page, 2)
  sameFuture(s, copy, seeded.rng(9), seeded.rng(9), { TAP, nil, TAP, nil, TAP, TAP, TAP, TAP, TAP, TAP }, 16)
  eq(copy.mode, s.mode)
end)

t("a save at a choice, deep in a branch, resumes at that choice", function()
  storyStub.SCRIPTS.deep = {
    { when = "a", steps = { { choice = { { "Up", { { choice = { { "Left", { { set = "ul" } } }, { "Right", { { set = "ur" }, { text = "fine" } } } } }, { set = "up_done" } } }, { "Down", { { set = "down" } } } } }, { set = "a_done" } } },
    { set = "deep_done" },
  }
  local s, rng = fresh()
  s.flags.a = true
  script(s, rng, "deep")
  press(s, rng, { kind = "pick", i = 1 })
  local copy = throughSave(s)
  eq(#rules.talk(copy).choices, 2)
  eq(rules.talk(copy).choices[2], "Right")
  sameFuture(s, copy, seeded.rng(9), seeded.rng(9), { { kind = "pick", i = 2 }, TAP }, 3)
  eq(copy.flags.ur, true)
  eq(copy.flags.up_done, true)
  eq(copy.flags.a_done, true)
  eq(copy.flags.deep_done, true)
  eq(copy.mode, "walk")
end)

t("a save mid-battle resumes the battle and then the script around it", function()
  local s, rng = fresh()
  fake.ticks = 4
  script(s, rng, "fight")
  press(s, rng, TAP)
  rules.tick(s, rng)
  eq(s.mode, "battle")
  local copy = throughSave(s)
  sameFuture(s, copy, seeded.rng(9), seeded.rng(9), nil, 8)
  eq(copy.flags.fought, true)
  eq(copy.mode, "talk")
  eq(rules.talk(copy).lines[1], "over")
end)

t("a save in the menu, a shop, a fade, the overworld and the middle of a foe's chase all resume", function()
  local s, rng = inMenu()
  press(s, rng, { kind = "pick", i = 1 })
  sameFuture(s, throughSave(s), seeded.rng(9), seeded.rng(9), { { kind = "back" }, { kind = "back" } }, 3)
  s, rng = fresh()
  s.gold = 50
  script(s, rng, "store")
  sameFuture(s, throughSave(s), seeded.rng(9), seeded.rng(9), { { kind = "pick", i = 1 }, { kind = "back" } }, 3)
  s, rng = fresh()
  script(s, rng, "dark")
  sameFuture(s, throughSave(s), seeded.rng(9), seeded.rng(9), nil, 10)
  s, rng = onWorld(2, 2)
  press(s, rng, RIGHT)
  s.safeSteps = 0
  sameFuture(s, throughSave(s), seeded.rng(9), seeded.rng(9), nil, 30)
  s, rng = inCave(3, 2, 2)
  sameFuture(s, throughSave(s), seeded.rng(9), seeded.rng(9), { UP, UP, UP }, 6)
end)

t("a queued tap survives a save", function()
  local s, rng = fresh(3, 2, 2)
  rules.input(s, UP)
  local copy = throughSave(s)
  rules.tick(copy, rng)
  eq(copy.x, 4)
end)

t("a tap can't reach what comes after a script: the queue empties when a script or a fight begins", function()
  local s, rng = fresh(4, 2, 2)
  rules.input(s, UP)
  rules.input(s, UP)
  rules.tick(s, rng)
  eq(s.mode, "talk")
  eq(#s.queue, 0, "the second tap was aimed at the walk")
end)

t("more than two taps waiting are dropped", function()
  local s = fresh()
  for _ = 1, 5 do rules.input(s, UP) end
  eq(#s.queue, 2)
end)

-- ---------------------------------------------------------------- the real thing


local function allThere()
  for _, name in ipairs({ "maps", "story", "battle", "enemies", "overworld", "art", "scene", "view_world", "view_battle" }) do
    if not fs.exists(fs.combine(kit.root, "games/blightmare/" .. name .. ".lua")) then return false, name end
  end
  return true
end

local whole, missing = allThere()

if not whole then
  tReal("the real parts are all here", function() error("missing: " .. tostring(missing)) end)
else
  --- Every step in a script, nested ones too.
  local function eachStep(list, visit)
    for _, step in ipairs(list or {}) do
      visit(step)
      eachStep(step.steps, visit)
      eachStep(step.other, visit)
      for _, option in ipairs(step.choice or {}) do eachStep(option[2], visit) end
    end
  end

  local KNOWN = {
    say = true, text = true, big = true, choice = true, when = true, set = true, unset = true, give = true, gold = true,
    join = true, heal = true, battle = true, warp = true, world = true, shop = true, inn = true, save = true, fade = true,
    sfx = true, fin = true, site = true, leave = true, take = true, solo = true, unsolo = true, dark = true, ending = true, has = true, paid = true, all = true, count = true,
    pic = true, music = true, mark = true,
  }

  tReal("the shipped scripts and maps only use what exists", function()
    local story = require(PREFIX .. "story")
    local maps = require(PREFIX .. "maps")
    local enemies = require(PREFIX .. "enemies")
    local party = require(PREFIX .. "party")
    local art = require(PREFIX .. "art")
    truthy(story.SCRIPTS[story.START], "START")
    for id, script_ in pairs(story.SCRIPTS) do
      eachStep(script_, function(step)
        local known = false
        for k in pairs(step) do known = known or KNOWN[k] end
        truthy(known, id .. " has a step the engine doesn't know")
        if step.say then truthy(art.PORTRAITS[step.say], id .. ": no portrait " .. step.say) end
        if step.battle then truthy(enemies.ENCOUNTERS[step.battle], id .. ": no encounter " .. step.battle) end
        if step.warp then truthy(maps.DATA[step.warp[1]], id .. ": no map " .. step.warp[1]) end
        if step.join then truthy(party.CHARS[step.join], id .. ": no character " .. step.join) end
        if step.shop then truthy(story.SHOPS[step.shop], id .. ": no shop " .. step.shop) end
        if step.give then truthy(party.ITEMS[step.give] or party.GEAR[step.give] or step.give == "key", id .. ": no item " .. step.give) end
        if step.pic then truthy(require(PREFIX .. "intro").PICS[step.pic], id .. ": no picture " .. step.pic) end
        if step.music then truthy(require("lib.sound").SOUNDS[step.music], id .. ": no music " .. step.music) end
        if type(step.sfx) == "string" and step.sfx:find("^intro_") then truthy(require("lib.sound").SOUNDS[step.sfx], id .. ": no sound " .. step.sfx) end
        for _, text in ipairs({ step.text or "", step.big or "" }) do
          truthy(not text:find("[^\32-\126\n]"), id .. ": not plain ASCII: " .. text)
        end
        if step.big then
          for _, line in ipairs(rules.wrap(step.big, rules.BIG_WIDE)) do
            truthy(ui.textWidth(line) <= 115, id .. ": too wide in big letters: " .. line)
          end
        end
      end)
    end
    for mapId, map in pairs(maps.DATA) do
      for _, npc in ipairs(map.npcs or {}) do truthy(story.SCRIPTS[npc.script], mapId .. ": no script " .. tostring(npc.script)) end
      for _, step in ipairs(map.steps or {}) do truthy(story.SCRIPTS[step.script], mapId .. ": no script " .. tostring(step.script)) end
      for _, f in ipairs(map.foes or {}) do truthy(enemies.ENCOUNTERS[f.enc], mapId .. ": no encounter " .. tostring(f.enc)) end
      for _, e in ipairs(map.exits or {}) do
        truthy(e.world or e.script or maps.DATA[e.map], mapId .. ": an exit to nowhere")
      end
    end
  end)

  --- Play with the bot. Returns the state, the ticks it took, and how often the party was wiped out.
  local function playThrough(seed, longest, onTick)
    local rng = seeded.rng(seed)
    local s = rules.new({ rng = rng, player = "Ada" })
    local wipes, last = 0, 0
    local ticks = 0
    while ticks < longest and not (s.flags.finished and s.mode == "walk") do
      ticks = ticks + 1
      local action = rules.bot(s, rng)
      if action then rules.input(s, action) end
      local events = rules.tick(s, rng)
      if has(events, "wipe") then wipes = wipes + 1 end
      assert(s.score >= last, "the score went down")
      last = s.score
      if onTick then onTick(s, rng, ticks) end
      if ticks % 300 == 0 then breathe() end
    end
    return s, ticks, wipes
  end

  for _, seed in ipairs({ 1, 2, 3 }) do
    tReal("the bot plays the whole slice to fin, seed " .. seed, function()
      local s, ticks, wipes = playThrough(seed, 30000)
      truthy(s.flags.finished, "stuck at " .. s.map .. " " .. s.x .. "," .. s.y .. " in " .. s.mode .. " after " .. ticks)
      print("seed " .. seed .. ": fin in " .. ticks .. " ticks, level " .. s.level .. ", " .. wipes .. " wipes, score " .. s.score)
    end)
  end

  tReal("a save anywhere along the way goes on the same", function()
    local every = 0
    playThrough(4, 2500, function(s, _, ticks)
      if ticks % 97 == 0 then
        every = every + 1
        eq(canon(throughSave(s)), canon(s), "tick " .. ticks)
        local a, b = seeded.rng(ticks), seeded.rng(ticks)
        local copy = throughSave(s)
        local mine = throughSave(s)
        for i = 1, 12 do
          local action = rules.bot(mine, a)
          rules.bot(copy, b)
          if action then
            rules.input(mine, action)
            rules.input(copy, action)
          end
          rules.tick(mine, a)
          rules.tick(copy, b)
        end
        eq(canon(copy), canon(mine), "parted after a save at tick " .. ticks)
      end
    end)
    truthy(every > 20, "enough saves tried")
  end)

  tReal("every picture along the way draws on the wall", function()
    local L = view.layout(121, 81)
    ui.setScreen(surfaceApi.create(121, 81))
    local modes = {}
    playThrough(5, 2500, function(s, _, ticks)
      if ticks % 7 == 0 or s.mode ~= modes.last then
        view.draw(L, s)
        view.saveSummary(s)
        view.actionAt(L, s, 40, 40)
        modes[s.mode] = true
        modes.last = s.mode
      end
    end)
    truthy(modes.walk and modes.talk and modes.battle, "saw walking, talk and battle")
  end)
end

-- ---------------------------------------------------------------- the guide

--- Run a test with these goals in the stand-in story.
local function withGoals(goals, fn)
  storyStub.GOALS = goals
  local ok, err = pcall(fn)
  storyStub.GOALS = nil
  if not ok then error(err, 0) end
end

t("the goal is the first with done unset and when set, and moves on as flags are set", function()
  withGoals({
    { done = "one", text = "First", map = "scythebreak", x = 5, y = 3 },
    { done = "two", when = "ready", text = "Later", map = "scythebreak", x = 6, y = 3 },
    { done = "three", text = "Third", map = "scythebreak", x = 7, y = 3 },
  }, function()
    local s = fresh()
    eq(rules.goal(s).text, "First")
    eq(rules.goal(s).x, 5)
    eq(rules.goal(s).y, 3)
    s.flags.one = true
    eq(rules.goal(s).text, "Third", "skips one whose when isn't set")
    s.flags.ready = true
    eq(rules.goal(s).text, "Later", "and comes back to it")
    s.flags.two, s.flags.three = true, true
    eq(rules.goal(s), nil)
  end)
end)

t("no goals, an old state, or a goal with nowhere to go don't crash", function()
  local s = fresh()
  eq(rules.goal(s), nil, "a story with no GOALS")
  withGoals({}, function() eq(rules.goal(s), nil) end)
  withGoals({ { done = "x", text = "Nowhere", map = "no_such_map", x = 1, y = 1 } }, function()
    eq(rules.goal(s).text, "Nowhere")
    eq(rules.goal(s).x, nil, "the text stays, with no place")
  end)
  withGoals({ { done = "x", text = "No site", site = "no_such_site" } }, function()
    eq(rules.goal(s).x, nil)
  end)
  withGoals({ { done = "x", text = "Nothing given" } }, function() eq(rules.goal(s).x, nil) end)
  local copy = throughSave(s)
  copy.botMem, copy.hints = nil, nil
  withGoals({ { done = "x", text = "Old", map = "scythebreak", x = 3, y = 3 } }, function() eq(rules.goal(copy).x, 3) end)
end)

t("a goal on another map points at the exit that leads there, through maps between", function()
  withGoals({ { done = "x", text = "Down", map = "deep", x = 2, y = 2 } }, function()
    local s = fresh(5, 5, 2)
    local g = rules.goal(s)
    eq(g.x, 10, "the town's exit to the cave")
    eq(g.y, 6)
    s, rng = inCave(5, 3, 2)
    g = rules.goal(s)
    eq(g.x, 1, "the cave's exit to the deep")
    eq(g.y, 3)
  end)
end)

t("the way back up works, and a closed exit doesn't count", function()
  withGoals({ { done = "x", text = "Up", map = "scythebreak", x = 2, y = 2 } }, function()
    local s = inCave(5, 3, 2)
    eq(rules.goal(s).x, nil, "the cave has no way back to the town here")
    mapsStub.DATA.cave.exits[3] = { x = 10, y = 4, map = "scythebreak", mx = 9, my = 6, dir = 4 }
    eq(rules.goal(s).x, 10)
    eq(rules.goal(s).y, 4)
    s.map, s.x, s.y = "deep", 2, 2
    eq(rules.goal(s).x, 3, "from further down, up through the cave")
    eq(rules.goal(s).y, 1)
    mapsStub.DATA.cave.exits[3] = nil
  end)
  withGoals({ { done = "x", text = "Shut", map = "shut", x = 2, y = 2 } }, function()
    local s = inCave(5, 3, 2)
    eq(rules.goal(s).x, nil, "its exit's when isn't set")
    s.flags.never = true
    eq(rules.goal(s).x, 10)
  end)
end)

t("of two ways there the nearer is shown, and a way that's walled off loses to one that isn't", function()
  local exits = mapsStub.DATA.scythebreak.exits
  local extra = { x = 1, y = 5, map = "cave", mx = 2, my = 2, dir = 2 }
  exits[#exits + 1] = extra
  withGoals({ { done = "x", text = "Cave", map = "cave", x = 2, y = 2 } }, function()
    local s = fresh(9, 5, 2)
    eq(rules.goal(s).x, 10)
    s.x, s.y = 2, 3
    eq(rules.goal(s).x, 1)
    eq(rules.goal(s).y, 5)
    s.flags.late = true -- the NPC at 2,5 now stands between that exit and the room
    eq(rules.goal(s).x, 10, "the near one can't be reached")
  end)
  exits[#exits] = nil
end)

t("on the overworld a goal on a map or a site points at the site tile", function()
  withGoals({ { done = "x", text = "Cave", map = "deep", x = 2, y = 2 } }, function()
    local s = onWorld(5, 3)
    eq(rules.goal(s).x, 3, "the cave site isn't known yet, so through the town")
    s.flags.unlocked = true
    eq(rules.goal(s).x, 11)
    eq(rules.goal(s).y, 2)
  end)
  withGoals({ { done = "x", text = "Town", site = "t" } }, function()
    local s = onWorld(5, 3)
    eq(rules.goal(s).x, 3)
    eq(rules.goal(s).y, 5)
  end)
end)

t("a site goal from on foot heads out, and on its own map it's the way in", function()
  withGoals({ { done = "x", text = "Town", site = "t" } }, function()
    local s = inCave(5, 3, 2)
    mapsStub.DATA.cave.exits[3] = { x = 10, y = 4, world = { 3, 3 } }
    eq(rules.goal(s).x, 10, "to the overworld first")
    mapsStub.DATA.cave.exits[3] = nil
    s = fresh(5, 5, 2)
    eq(rules.goal(s).x, 2, "the site's own square")
    eq(rules.goal(s).y, 2)
  end)
end)

t("behind speech, a menu or a fight the goal is worked out from the ground underneath", function()
  withGoals({ { done = "x", text = "Town", site = "t" } }, function()
    local s, rng = onWorld(5, 3)
    press(s, rng, { kind = "menu" })
    eq(s.mode, "menu")
    eq(rules.goal(s).x, 3)
    eq(rules.goal(s).y, 5)
    s = onWorld(5, 3)
    rules.startScript(s, "gated")
    rules.tick(s, rng)
    eq(rules.goal(s).y, 5)
  end)
end)

t("the goal leaves nothing in the state", function()
  withGoals({ { done = "x", text = "Cave", map = "cave", x = 2, y = 2 } }, function()
    local s = fresh()
    local before = canon(s)
    rules.goal(s)
    eq(canon(s), before)
  end)
end)

--- The ink behind a cell of a surface.
local function inkAt(surf, x, y) return surf.buffer[(y * surf.width + x) * 3 + 1] end

local function countInk(surf, ink, x0, y0, x1, y1)
  local n = 0
  for y = y0, y1 do
    for x = x0, x1 do
      if inkAt(surf, x, y) == ink then n = n + 1 end
    end
  end
  return n
end

--- Draw the real walking or overworld view with these goals, and hand back the wall.
local function drawnWith(goals, s, draw)
  local story = require(PREFIX .. "story")
  local saved = story.GOALS
  story.GOALS = goals
  local surf = surfaceApi.create(121, 81)
  ui.setScreen(surf)
  local ok, err = pcall(draw, view.layout(121, 81), s)
  story.GOALS = saved
  if not ok then error(err, 0) end
  return surf
end

local MAP_X0, MAP_X1, MAP_Y0, MAP_Y1 = 121 - 33, 119, 1, 13

local function walkingAt(map, x, y, dir)
  local s = rules.new({ rng = seeded.rng(1), player = "Ada" })
  s.mode, s.run = "walk", nil
  s.map, s.x, s.y, s.dir = map, x, y, dir
  s.rev = s.rev + 1
  return s
end

tReal("the marker sits on its square, once, in a colour nothing else on the minimap uses", function()
  local worldView = require(PREFIX .. "view_world")
  local s = walkingAt("orrenshire", 12, 9, 2)
  local plain = drawnWith({}, s, worldView.drawWalk)
  eq(countInk(plain, ui.C.accent, MAP_X0, MAP_Y0, MAP_X1, MAP_Y1), 0, "the minimap never uses it")
  s.rev = s.rev + 1
  local surf = drawnWith({ { done = "x", text = "Near", map = "orrenshire", x = 15, y = 9 } }, s, worldView.drawWalk)
  eq(countInk(surf, ui.C.accent, MAP_X0, MAP_Y0, MAP_X1, MAP_Y1), 2, "one square, two cells wide")
  local centreX = 121 - 33 - 1 + 1 + 1 + 7 * 2
  eq(inkAt(surf, centreX + 3 * 2, 1 + 1 + 5), ui.C.accent, "three squares east of the player")
end)

tReal("off the minimap it's an arrow on the edge, on the right side", function()
  local worldView = require(PREFIX .. "view_world")
  local goal = { { done = "x", text = "Far", map = "mine_1", x = 19, y = 3 } }
  local s = walkingAt("mine_1", 2, 7, 2)
  local surf = drawnWith(goal, s, worldView.drawWalk)
  local n = countInk(surf, ui.C.accent, MAP_X0, MAP_Y0, MAP_X1, MAP_Y1)
  eq(n, 2, "a two-cell arrow")
  truthy(countInk(surf, ui.C.accent, MAP_X1 - 3, MAP_Y0, MAP_X1, MAP_Y1) == 2, "on the east edge")
end)

tReal("the arrow at the top of the view turns with the player", function()
  local worldView = require(PREFIX .. "view_world")
  local goal = { { done = "x", text = "East", map = "orrenshire", x = 20, y = 9 } }
  local function word(dir)
    local s = walkingAt("orrenshire", 12, 9, dir)
    local surf = drawnWith(goal, s, worldView.drawWalk)
    local out = {}
    for x = 40, 80 do out[#out + 1] = surf.buffer[(1 * surf.width + x) * 3 + 3] or " " end
    return table.concat(out)
  end
  truthy(word(2):find("AHEAD"), "facing east")
  truthy(word(1):find("RIGHT"), "facing north")
  truthy(word(3):find("LEFT"), "facing south")
  truthy(word(4):find("BEHIND"), "facing west")
end)

tReal("the bar says the goal, clear of SAVE & QUIT", function()
  local worldView = require(PREFIX .. "view_world")
  local long = ("A very long goal indeed "):rep(4)
  local s = walkingAt("orrenshire", 12, 9, 2)
  local surf = drawnWith({ { done = "x", text = long, map = "orrenshire", x = 15, y = 9 } }, s, worldView.drawWalk)
  local y = worldView.HUD_Y + 5
  local out = {}
  for x = 60, 120 do out[#out + 1] = surf.buffer[(y * surf.width + x) * 3 + 3] or " " end
  local line = table.concat(out)
  truthy(line:find("GOAL: A very"), "the text: " .. line)
  eq(line:sub(107 - 60 + 1):gsub(" ", ""), "", "nothing at x 107 or over")
end)

tReal("the overworld shows an arrow by the party, and a ring on the goal's tile only when it's in view", function()
  local worldView = require(PREFIX .. "view_world")
  local s = walkingAt("scythebreak", 3, 3, 2)
  s.mode, s.wx, s.wy = "world", 66, 47
  local goal = { { done = "x", text = "Town", site = "orrenshire" } }
  local surf = drawnWith(goal, s, worldView.drawWorld)
  local cx, cy = 57 + 3, 38 + 1
  truthy(countInk(surf, ui.C.accent, cx - 16, cy - 8, cx + 16, cy + 8) >= 5, "an arrow by the party")
  local ringX, ringY = 57 + 1 * 6, 38 - 3 * 4
  eq(inkAt(surf, ringX, ringY), ui.C.accent, "the ring, three tiles north and one east")
  s.wx, s.wy = 62, 60
  s.rev = s.rev + 1
  surf = drawnWith(goal, s, worldView.drawWorld)
  truthy(countInk(surf, ui.C.accent, cx - 16, cy - 16, cx + 16, cy + 8) >= 5, "still an arrow when it's far off")
end)

tReal("redrawing without a change doesn't work the goal out again", function()
  local worldView = require(PREFIX .. "view_world")
  local s = walkingAt("orrenshire", 12, 9, 2)
  local calls = 0
  local goal = rules.goal
  rules.goal = function(state)
    calls = calls + 1
    return goal(state)
  end
  ui.setScreen(surfaceApi.create(121, 81))
  local L = view.layout(121, 81)
  worldView.drawWalk(L, s)
  worldView.drawWalk(L, s)
  worldView.drawWalk(L, s)
  rules.goal = goal
  eq(calls, 1)
end)

tReal("every shipped goal fits the bar", function()
  for _, goal in ipairs(require(PREFIX .. "story").GOALS) do
    truthy(#("GOAL: " .. goal.text) <= 45, "too long for the bar: " .. goal.text)
  end
end)

--- Can the player get from here to the place the guide names, on the ground they're on?
local function reachable(s, g, onWorld)
  local worldMap = require(PREFIX .. "world")
  local overworld = require(PREFIX .. "overworld")
  local sx, sy = onWorld and s.wx or s.x, onWorld and s.wy or s.y
  local function open(x, y)
    if onWorld then return overworld.walkable(x, y) end
    if rules.npcAt(s, x, y) or rules.chestAt(s, x, y) then return false end
    local c = worldMap.tileAt(s.map, x, y)
    return c == "+" or not worldMap.solid(s.map, x, y, s)
  end
  local seen, order, head = { [sy * 1000 + sx] = true }, { { sx, sy } }, 1
  while order[head] do
    local at = order[head]
    head = head + 1
    if math.abs(at[1] - g.x) + math.abs(at[2] - g.y) <= 1 then return true end
    for _, d in ipairs(rules.DIRS) do
      local x, y = at[1] + d[1], at[2] + d[2]
      if not seen[y * 1000 + x] and open(x, y) then
        seen[y * 1000 + x] = true
        order[#order + 1] = { x, y }
      end
    end
  end
  return false
end

tReal("from a new game to fin the guide always names a place the player can get to", function()
  local story = require(PREFIX .. "story")
  local rng = seeded.rng(21)
  local s = rules.new({ rng = rng, player = "Ada" })
  local seenGoals, steps, lastKey = {}, 0, nil
  local ticks = 0
  while ticks < 30000 and not (s.flags.finished and s.mode == "walk") do
    ticks = ticks + 1
    local action = rules.bot(s, rng)
    if action then rules.input(s, action) end
    rules.tick(s, rng)
    if (s.mode == "walk" or s.mode == "world") and not s.flags.finished then
      local g = rules.goal(s)
      truthy(g, "no goal at tick " .. ticks .. " on " .. s.map)
      seenGoals[g.text] = true
      local onWorld = s.mode == "world"
      local key = s.mode .. s.map .. (onWorld and (s.wx .. "," .. s.wy) or (s.x .. "," .. s.y)) .. g.text
      if key ~= lastKey then
        lastKey = key
        steps = steps + 1
        local where = g.text .. " from " .. s.mode .. " " .. s.map .. " " .. tostring(onWorld and s.wx or s.x) .. "," .. tostring(onWorld and s.wy or s.y)
        truthy(g.x, "no place for " .. where)
        truthy(reachable(s, g, onWorld), "can't reach " .. g.x .. "," .. g.y .. " for " .. where)
      end
    end
    if ticks % 300 == 0 then breathe() end
  end
  truthy(s.flags.finished, "the bot reached the end")
  truthy(steps > 300, "enough places checked: " .. steps)
  for _, goal in ipairs(story.GOALS) do
    truthy(seenGoals[goal.text], "the guide never showed: " .. goal.text)
    if goal.done == "finished" then break end
  end
end)

t("the middle walks forward with nothing to act on", function()
  local s, rng = fresh(2, 3, 3)
  local x, y = s.x, s.y
  press(s, rng, ACT)
  truthy(s.x ~= x or s.y ~= y, "a step forward")
  eq(s.mode, "walk")
end)

t("a save from the first version drops a conversation in progress and carries on", function()
  local s, rng = fresh(2, 3, 3)
  s.v = 1
  s.mode, s.run = "talk", { id = "no_such_script", at = { { i = 99 } }, back = "walk", page = 1, wait = "tap" }
  s.flags.foreman_down = true
  rules.tick(s, rng)
  eq(s.v, 3)
  eq(s.mode, "walk")
  eq(s.run, nil)
  eq(s.flags.saw_shift, true)
  local again = s.rev
  rules.tick(s, rng)
  eq(s.rev, again, "it only happens once")
end)

t("a save from the first version inside a script's fight comes back to the ground", function()
  local s, rng = fresh(2, 3, 3)
  s.v = 1
  s.mode, s.back, s.run = "battle", "talk", { id = "no_such_script", at = { { i = 99 } }, back = "walk", page = 1 }
  s.battle = {}
  rules.input(s, { kind = "tap" })
  eq(s.back, "walk")
  eq(s.run, nil)
end)

t("someone with no name is asked at the very start, and a tap keyboard spells it", function()
  local rng = seeded.rng(21)
  local s = rules.new({ rng = rng, player = "Player" })
  rules.tick(s, rng)
  eq(s.mode, "name")
  press(s, rng, { kind = "pick", i = 1 })
  press(s, rng, { kind = "pick", i = 4 })
  press(s, rng, { kind = "pick", i = 1 })
  press(s, rng, { kind = "pick", i = 25 })
  press(s, rng, { kind = "pick", i = rules.NAME_DELETE })
  press(s, rng, { kind = "pick", i = rules.NAME_DONE })
  eq(s.heroName, "Ada")
  eq(s.mode, "talk")
  eq(s.naming, nil)
end)

t("a real name is never asked for, and an old unnamed save is asked once", function()
  local s, rng = fresh(2, 3, 3)
  rules.tick(s, rng)
  eq(s.mode, "walk")
  s.heroName = "Player"
  rules.tick(s, rng)
  eq(s.mode, "name")
  press(s, rng, { kind = "pick", i = rules.NAME_DONE })
  eq(s.heroName, "Hero")
  eq(s.mode, "walk")
end)
