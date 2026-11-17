-- BLIGHTMARE's battles: Wait mode, every command, statuses, the end of a fight, saving mid-battle, the screen and its taps, the
-- Foreman's balance measured with the bot, and the whole game's: foes by number, bosses from data, elements, the party to level
-- 50, gear, XP, and a simulation of standard parties at tiers 5 to 40.
local kit = loadfile(fs.combine(fs.getDir(fs.getDir(shell.getRunningProgram())), "testkit.lua"), nil, _ENV)()
local seeded = require("lib.rng")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

local surfaceApi = require("lib.surface")
local font = surfaceApi.loadFont(surfaceApi.load("/" .. fs.combine(kit.root, "lib/font")))
local ui = require("lib.ui")
ui.init(surfaceApi, font, surfaceApi.create(121, 81))

local art = require("games.blightmare.art_battle")
local battle = require("games.blightmare.battle")
local enemies = require("games.blightmare.enemies")
local party = require("games.blightmare.party")
local view = require("games.blightmare.view_battle")

local L = { W = 121, H = 81, x0 = 0, y0 = 0, bw = 121, bh = 81, statusY = 60 }

local function breathe()
  os.queueEvent("blightmare")
  os.pullEvent("blightmare")
end

--- A state the battle can run on. team: { { id, lvl, weapon, armour }, ... }
local function newState(team, bag)
  local s = { rev = 0, score = 0, level = 1, gold = 0, party = {}, bag = bag or { potion = 3 }, mode = "walk" }
  for i, entry in ipairs(team) do
    local m = party.new(entry[1], entry[2] or 5)
    m.weapon, m.armour = entry[3] or m.weapon, entry[4] or m.armour
    party.restore(m)
    s.party[i] = m
  end
  return s
end

local function trio(lvl) return { { "hero", lvl or 5 }, { "deserter", lvl or 5 }, { "cleric", lvl or 5 } } end

--- A fight with nothing stirring: no gauge anywhere near full, and no beat left.
local function quiet(team, enc, bag, seed)
  local s = newState(team or trio(), bag)
  local rng = seeded.rng(seed or 11)
  battle.begin(s, enc or "mine_3", rng)
  local b = s.battle
  b.beat = 0
  for _, u in ipairs(b.allies) do u.atb = 0 end
  for _, f in ipairs(b.foes) do f.atb = 0 end
  return s, rng, b
end

--- Open the command screen for one member.
local function openFor(s, rng, i)
  local b = s.battle
  b.allies[i].atb = battle.GAUGE
  battle.tick(s, rng)
  eq(b.phase, "cmd")
  eq(b.active, i)
end

local function send(s, rng, action)
  battle.input(s, action)
  return battle.tick(s, rng)
end

local function cmd(s, rng, name) return send(s, rng, { kind = "cmd", cmd = name }) end
local function target(s, rng, side, i) return send(s, rng, { kind = "target", side = side, i = i }) end

--- Pick a row of the open list by id.
local function pick(s, rng, id)
  for i, row in ipairs(battle.rows(s)) do
    if row.id == id then return send(s, rng, { kind = "pick", i = i }) end
  end
  error("no row " .. id)
end

local function hasEvent(events, kind)
  for _, ev in ipairs(events) do
    if ev.type == kind then return ev end
  end
  return nil
end

--- Rng that always gives the same roll, for a blow or status that must land.
local function fixed(roll)
  return function(n)
    if n then return math.min(n, roll) end
    return 0.5
  end
end

--- Let time run until a test says stop, or fail.
local function runUntil(s, rng, done, most)
  for _ = 1, most or 600 do
    battle.tick(s, rng)
    if done() then return true end
  end
  error("it never happened")
end

local function fight(s, enc, rng)
  battle.begin(s, enc, rng)
  local ticks = 0
  while not s.battle.result and ticks < 20000 do
    local action = battle.bot(s, rng)
    if action then battle.input(s, action) end
    battle.tick(s, rng)
    ticks = ticks + 1
  end
  return s.battle.result, ticks
end

-- ---------------------------------------------------------------- the data the contract promises

t("every character the spec names is there with the right special", function()
  local specials = { hero = "FOCUS", deserter = "MIX", cleric = "PRAY", owlin = "MAGIC", jezzara = "STEAL", asphodel = "BLOOD" }
  for id, word in pairs(specials) do
    eq(party.CHARS[id].special, word)
    local m = party.new(id, 3)
    local st = party.stats(m)
    eq(m.hp, st.hp)
    eq(m.mp, st.mp)
    truthy(st.atk > 0 and st.def >= 0 and st.spd > 0, id .. " has stats")
    truthy(party.GEAR[m.weapon] and party.GEAR[m.armour], id .. " has gear")
  end
  local h = party.new("hero", 1)
  eq(h.hp, 40)
  eq(h.mp, 0)
  eq(h.weapon, "knife")
  eq(h.armour, "rags")
  eq(h.xp, 0)
end)

t("every foe and encounter the spec names is there, and each list reaches real things", function()
  for _, id in ipairs({ "rat", "harpy", "frogman", "stalker", "orderly", "doctor", "blighted", "miner", "crawler", "foreman" }) do
    local foe = enemies.FOES[id]
    truthy(foe and foe.name and foe.hp > 0 and foe.xp and foe.gold, id)
    truthy(art.SPRITES[foe.sprite], id .. " has a sprite")
    for _, entry in ipairs(foe.abilities) do truthy(enemies.ABILITIES[entry[1]], id .. " " .. entry[1]) end
  end
  local ids = { "tut_crawler", "wall_breach", "gate_orderlies", "boss_foreman" }
  for i = 1, 3 do ids[#ids + 1] = "field_heart_" .. i end
  for i = 1, 2 do ids[#ids + 1] = "field_road_" .. i end
  for i = 1, 4 do ids[#ids + 1] = "mine_" .. i end
  for _, id in ipairs(ids) do
    local enc = enemies.ENCOUNTERS[id]
    truthy(enc, id)
    truthy(enc.bg == "grass" or enc.bg == "town" or enc.bg == "mine", id .. " bg")
    for _, foe in ipairs(enc.foes) do truthy(enemies.FOES[foe], id .. " " .. foe) end
  end
  for _, list in pairs(enemies.FIELD) do
    for _, id in ipairs(list) do truthy(enemies.ENCOUNTERS[id], id) end
  end
  truthy(enemies.ENCOUNTERS.boss_foreman.boss, "the boss is a boss")
end)

t("begin sets the battle and the mode, and takes at most four", function()
  local s = newState({ { "hero" }, { "deserter" }, { "cleric" }, { "owlin" }, { "jezzara" } })
  battle.begin(s, "mine_4", seeded.rng(1))
  eq(s.mode, "battle")
  eq(#s.battle.allies, 4)
  eq(#s.battle.foes, 2)
  eq(s.battle.phase, "run")
end)

-- ---------------------------------------------------------------- Wait mode

local function fingerprint(s)
  local out = {}
  for _, u in ipairs(s.battle.allies) do out[#out + 1] = u.atb .. ":" .. s.party[u.m].hp .. ":" .. u.poison end
  for _, f in ipairs(s.battle.foes) do out[#out + 1] = f.atb .. ":" .. f.hp .. ":" .. f.charge .. ":" .. f.poison end
  return table.concat(out, ",")
end

t("Wait mode: a gauge filling opens the command screen and time stops, in every menu", function()
  local s, rng, b = quiet()
  b.allies[1].poison = 3
  b.foes[1].poison = 3
  runUntil(s, rng, function() return b.phase == "cmd" end)
  local still = fingerprint(s)
  for _ = 1, 300 do battle.tick(s, rng) end
  eq(fingerprint(s), still)
  cmd(s, rng, "attack")
  eq(b.phase, "target")
  for _ = 1, 300 do battle.tick(s, rng) end
  eq(fingerprint(s), still)
  send(s, rng, { kind = "back" })
  cmd(s, rng, "item")
  eq(b.phase, "list")
  for _ = 1, 300 do battle.tick(s, rng) end
  eq(fingerprint(s), still)
end)

t("Wait mode: running time moves every gauge, foes included", function()
  local s, rng, b = quiet()
  for _ = 1, 5 do battle.tick(s, rng) end
  truthy(b.allies[1].atb > 0, "the party's gauges fill")
  truthy(b.foes[1].atb > 0, "and the foes'")
end)

t("a gauge at average speed takes about three seconds at 120 ms a tick", function()
  local ticks = math.ceil(battle.GAUGE / battle.gain(7))
  truthy(ticks * 0.12 >= 2.5 and ticks * 0.12 <= 3.5, "ticks " .. ticks)
  truthy(battle.gain(9) > battle.gain(5), "faster is faster")
end)

t("input takes effect in the tick, not before", function()
  local s, rng, b = quiet()
  openFor(s, rng, 1)
  battle.input(s, { kind = "cmd", cmd = "attack" })
  eq(b.phase, "cmd")
  battle.tick(s, rng)
  eq(b.phase, "target")
end)

-- ---------------------------------------------------------------- commands

t("attack: choosing a target hurts it, resets the gauge and time runs again", function()
  local s, rng, b = quiet()
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  eq(b.phase, "target")
  local side, list = battle.targets(s)
  eq(side, "foe")
  eq(#list, 1)
  local before = b.foes[1].hp
  target(s, fixed(1), "foe", 1)
  truthy(b.foes[1].hp < before, "it was hurt")
  eq(b.phase, "run")
  eq(b.allies[1].atb, 0)
end)

t("target: a dead foe or the wrong side can't be chosen", function()
  local s, rng, b = quiet(nil, "mine_4")
  b.foes[2].hp = 0
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  local _, list = battle.targets(s)
  eq(#list, 1)
  eq(list[1], 1)
  target(s, rng, "foe", 2)
  eq(b.phase, "target")
  target(s, rng, "ally", 1)
  eq(b.phase, "target")
end)

t("back steps out of a target, and out of a list", function()
  local s, rng, b = quiet()
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  send(s, rng, { kind = "back" })
  eq(b.phase, "cmd")
  cmd(s, rng, "item")
  pick(s, rng, "potion")
  eq(b.phase, "target")
  send(s, rng, { kind = "back" })
  eq(b.phase, "list")
  send(s, rng, { kind = "back" })
  eq(b.phase, "cmd")
  eq(s.bag.potion, 3)
end)

t("defend halves what lands, until the next turn", function()
  local s, rng, b = quiet()
  local m = s.party[1]
  m.hp = 80
  openFor(s, rng, 1)
  cmd(s, rng, "defend")
  truthy(b.allies[1].guard, "guarding")
  eq(b.phase, "run")
  -- the same blow on the same rolls, guarded then not
  b.beat = 0
  local cases = {}
  for _, guard in ipairs({ true, false }) do
    local c = newState(trio())
    battle.begin(c, "boss_foreman", seeded.rng(3))
    local u = c.battle.allies[1]
    u.guard = guard
    c.battle.foes[1].charge, c.battle.foes[1].charging = 1, "cavein"
    c.battle.beat = 0
    local hp = c.party[1].hp
    for _, ally in ipairs(c.battle.allies) do ally.atb = 0 end
    battle.tick(c, fixed(5))
    cases[#cases + 1] = hp - c.party[1].hp
  end
  eq(cases[1], math.ceil(cases[2] / 2))
  openFor(s, rng, 1)
  eq(b.allies[1].guard, false)
end)

t("FOCUS: takes the turn, then the next hit is far stronger and only that one", function()
  local plain = quiet()
  local srng = fixed(5)
  openFor(plain, srng, 1)
  cmd(plain, srng, "attack")
  local hp = plain.battle.foes[1].hp
  target(plain, srng, "foe", 1)
  local weak = hp - plain.battle.foes[1].hp

  local s, rng, b = quiet()
  rng = fixed(5)
  openFor(s, rng, 1)
  local events = cmd(s, rng, "special")
  truthy(hasEvent(events, "focus"), "focus event")
  truthy(b.allies[1].focus, "focused")
  eq(b.phase, "run")
  eq(b.allies[1].atb, 0)
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  hp = 1000
  b.foes[1].hp = hp
  target(s, rng, "foe", 1)
  local strong = hp - b.foes[1].hp
  truthy(strong >= weak * 3 - 3, strong .. " against " .. weak)
  eq(b.allies[1].focus, false)
end)

t("MIX is a list, spends MP, and CAUSTIC hits every foe without a target", function()
  local s, rng, b = quiet(nil, "mine_4")
  openFor(s, rng, 2)
  cmd(s, rng, "special")
  eq(b.phase, "list")
  truthy(#battle.rows(s) >= 3, "several rows")
  local hpA, hpB, mp = b.foes[1].hp, b.foes[2].hp, s.party[2].mp
  pick(s, rng, "caustic")
  eq(b.phase, "run")
  truthy(b.foes[1].hp < hpA and b.foes[2].hp < hpB, "both burn")
  eq(s.party[2].mp, mp - party.SPELLS.caustic.mp)
end)

t("PRAY: MEND asks who and heals; a spell the MP can't pay for stays on the list", function()
  local s, rng, b = quiet()
  s.party[1].hp = 10
  openFor(s, rng, 3)
  cmd(s, rng, "special")
  pick(s, rng, "mend")
  eq(b.phase, "target")
  local side = battle.targets(s)
  eq(side, "ally")
  target(s, rng, "ally", 1)
  truthy(s.party[1].hp > 10, "healed")
  eq(s.party[3].mp, party.stats(s.party[3]).mp - party.SPELLS.mend.mp)

  b.beat = 0
  s.party[3].mp = 0
  openFor(s, rng, 3)
  cmd(s, rng, "special")
  for _, row in ipairs(battle.rows(s)) do eq(row.ok, false) end
  pick(s, rng, "mend")
  eq(b.phase, "list")
  eq(s.party[3].mp, 0)
end)

t("RISE only reaches the fallen, and only when someone has fallen", function()
  local s, rng, b = quiet(nil, nil, nil)
  openFor(s, rng, 3)
  cmd(s, rng, "special")
  for _, row in ipairs(battle.rows(s)) do
    if row.id == "rise" then eq(row.ok, false) end
  end
  send(s, rng, { kind = "back" })
  s.party[1].hp = 0
  cmd(s, rng, "special")
  pick(s, rng, "rise")
  local side, list = battle.targets(s)
  eq(side, "ally")
  eq(#list, 1)
  eq(list[1], 1)
  target(s, rng, "ally", 1)
  truthy(s.party[1].hp > 0, "up again")
end)

t("item: takes a turn, uses one up, and an empty bag doesn't open a list", function()
  local s, rng, b = quiet()
  s.party[2].hp = 10
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  eq(b.phase, "list")
  pick(s, rng, "potion")
  target(s, rng, "ally", 2)
  eq(s.party[2].hp, 10 + party.ITEMS.potion.hp)
  eq(s.bag.potion, 2)
  eq(b.phase, "run")
  eq(b.allies[1].atb, 0)

  s = quiet(nil, "boss_foreman", {})
  rng = seeded.rng(4)
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  eq(s.battle.phase, "cmd")
end)

t("the last of an item leaves the bag, and every item does its job", function()
  local s, rng, b = quiet(nil, nil, { potion = 1, ether = 1, antidote = 1, tonic = 2 })
  s.party[3].mp = 1
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  pick(s, rng, "ether")
  target(s, rng, "ally", 3)
  eq(s.party[3].mp, 1 + party.ITEMS.ether.mp)
  eq(s.bag.ether, nil)

  b.beat = 0
  b.allies[2].poison = 9
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  pick(s, rng, "antidote")
  target(s, rng, "ally", 2)
  eq(b.allies[2].poison, 0)

  b.beat = 0
  s.party[3].hp = 0
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  pick(s, rng, "tonic")
  local _, list = battle.targets(s)
  eq(#list, 3)
  target(s, rng, "ally", 3)
  truthy(s.party[3].hp > 0, "a tonic raises the fallen")
end)

t("STEAL and BLOOD work for those who have them", function()
  local s, rng, b = quiet({ { "jezzara" }, { "asphodel" } }, "mine_3", { potion = 0 })
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  eq(b.phase, "target")
  target(s, fixed(1), "foe", 1)
  eq(s.bag.potion, 1)
  b.beat = 0
  openFor(s, rng, 2)
  cmd(s, rng, "special")
  local hp, foe = s.party[2].hp, b.foes[1].hp
  target(s, fixed(5), "foe", 1)
  truthy(s.party[2].hp < hp, "it costs blood")
  truthy(b.foes[1].hp < foe, "and it bites")
end)

-- ---------------------------------------------------------------- statuses

t("poison stings in running time, never kills, and stops for a menu", function()
  local s, rng, b = quiet({ { "hero" }, { "cleric" } })
  local m = s.party[1]
  b.foes[1].hp, b.foes[1].atb = 999, 0
  b.foes[1].spd = -100
  b.allies[1].poison, b.allies[2].atb = 1, 0
  b.allies[1].spd, b.allies[2].spd = -100, -100
  m.hp = 3
  local stung
  for _ = 1, battle.POISON_EVERY * 4 do
    local events = battle.tick(s, rng)
    stung = stung or hasEvent(events, "sting")
  end
  truthy(stung, "it stung")
  eq(m.hp, 1)
end)

t("sleep stops a gauge, a hit wakes them, and it wears off", function()
  local s, rng, b = quiet()
  local u = b.allies[1]
  u.sleep, u.atb = 20, battle.GAUGE
  b.allies[2].spd, b.allies[3].spd, b.foes[1].spd = -100, -100, -100
  battle.tick(s, rng)
  eq(b.phase, "run")
  eq(u.sleep, 19)
  u.sleep = 2
  runUntil(s, rng, function() return b.phase == "cmd" end, 5)
  eq(b.active, 1)

  local c, crng, cb = quiet()
  cb.allies[1].sleep = 30
  c.party[1].hp = 60
  cb.foes[1].charge, cb.foes[1].charging = 1, "cavein"
  battle.tick(c, crng)
  eq(cb.allies[1].sleep, 0)
end)

t("nightmare: acts without a menu, thrashing at anyone, and wears off in turns", function()
  local s, rng, b = quiet()
  local u = b.allies[2]
  u.nightmare, u.atb = 2, battle.GAUGE
  local events = battle.tick(s, rng)
  eq(b.phase, "run")
  eq(u.nightmare, 1)
  eq(u.atb, 0)
  truthy(hasEvent(events, "hit") or hasEvent(events, "hurt") or hasEvent(events, "miss"), "swung at someone")
  truthy(b.msg:find("THRASHES"), b.msg)
end)

t("nightmare: the hero is immune, the others are not", function()
  -- a foe's ability that always lands, on whoever it happens to reach
  enemies.ABILITIES.stare_test = { name = "T", power = 10, magic = true, status = "nightmare", chance = 100 }
  local kept = enemies.FOES.miner.abilities
  enemies.FOES.miner.abilities = { { "stare_test", 1 } }
  local hit = {}
  for seed = 1, 60 do
    local s, rng, b = quiet({ { "hero" }, { "deserter" } }, "mine_3", nil, seed)
    b.foes[1].atb = battle.GAUGE
    battle.tick(s, rng)
    if b.allies[1].nightmare > 0 then hit.hero = true end
    if b.allies[2].nightmare > 0 then hit.deserter = true end
  end
  enemies.FOES.miner.abilities = kept
  enemies.ABILITIES.stare_test = nil
  eq(hit.hero, nil)
  eq(hit.deserter, true)
end)

t("CLEANSE lifts sleep, nightmare and poison", function()
  local s, rng, b = quiet()
  local u = b.allies[2]
  u.poison, u.nightmare, u.sleep = 5, 2, 30
  openFor(s, rng, 3)
  cmd(s, rng, "special")
  pick(s, rng, "cleanse")
  target(s, rng, "ally", 2)
  eq(u.poison, 0)
  eq(u.nightmare, 0)
  eq(u.sleep, 0)
end)

t("the Foreman shrugs off sleep and nightmare", function()
  local s, rng, b = quiet(nil, "boss_foreman")
  openFor(s, rng, 2)
  cmd(s, rng, "special")
  pick(s, fixed(1), "knockout")
  eq(b.foes[1].sleep, 0)
end)

-- ---------------------------------------------------------------- flee

t("flee: only where the encounter allows it, it takes a turn, and failing costs the turn", function()
  local s, rng, b = quiet(nil, "boss_foreman")
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  for _, row in ipairs(battle.rows(s)) do truthy(row.id ~= "flee", "no way out of the boss") end
  send(s, rng, { kind = "back" })
  cmd(s, rng, "flee")
  eq(b.phase, "cmd")

  s, rng, b = quiet(nil, "mine_1")
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  pick(s, fixed(1), "flee")
  eq(b.phase, "spoils")
  eq(b.outcome, "fled")
  for _ = 1, 60 do battle.tick(s, rng) end
  eq(b.result, "fled")
  eq(s.score, 0)
  eq(s.gold, 0)

  s, rng, b = quiet(nil, "mine_1")
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  pick(s, fixed(100), "flee")
  eq(b.phase, "run")
  eq(b.result, nil)
  eq(b.allies[1].atb, 0)
end)

-- ---------------------------------------------------------------- ends

t("winning pays XP and gold once, moves the score, and the end card gives the result", function()
  local s, rng, b = quiet({ { "hero", 1 }, { "deserter", 1 } }, "tut_crawler")
  b.foes[1].hp = 1
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  local events = target(s, fixed(5), "foe", 1)
  truthy(hasEvent(events, "win"), "a win")
  eq(b.phase, "spoils")
  local foe = enemies.FOES.crawler
  eq(s.score, foe.xp)
  eq(s.gold, foe.gold)
  eq(s.party[1].xp, foe.xp)
  eq(s.party[2].xp, foe.xp)
  eq(b.result, nil)
  for _ = 1, 3 do send(s, rng, { kind = "tap" }) end
  eq(b.result, nil) -- too soon to skip
  for _ = 1, 6 do send(s, rng, { kind = "tap" }) end
  eq(b.result, "won")
  eq(s.score, foe.xp)
end)

t("level ups: the curve, the maximums, the current HP and s.level", function()
  eq(party.xpFor(1), 0)
  for lvl = 2, 12 do truthy(party.xpFor(lvl) > party.xpFor(lvl - 1), "the curve climbs") end
  local s, rng, b = quiet({ { "hero", 1 }, { "cleric", 3 } }, "tut_crawler")
  b.foes[1].hp = 1
  s.party[1].xp = party.xpFor(2) - 1
  s.party[1].hp = 20
  local maxBefore = party.stats(s.party[1]).hp
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  local events = target(s, fixed(5), "foe", 1)
  eq(s.party[1].lvl, 2)
  eq(s.level, 2)
  eq(party.stats(s.party[1]).hp, maxBefore + party.CHARS.hero.growth.hp)
  eq(s.party[1].hp, 20 + party.CHARS.hero.growth.hp)
  local ev = hasEvent(events, "levelup")
  eq(ev.id, "hero")
  eq(ev.lvl, 2)
  eq(b.spoils.ups[1].id, "hero")
end)

t("spells are learned by level", function()
  local function knows(m, id)
    for _, have in ipairs(party.known(m)) do
      if have == id then return true end
    end
    return false
  end
  local c = party.new("cleric", 1)
  eq(knows(c, "mend"), true)
  eq(knows(c, "rise"), false)
  party.gainXp(c, party.xpFor(3) - c.xp)
  eq(c.lvl, 3)
  eq(knows(c, "rise"), true)
end)

t("a loss is a loss: no XP, and the result says so", function()
  local s, rng, b = quiet({ { "hero", 1 } }, "boss_foreman")
  b.allies[1].atb = 0
  s.party[1].hp = 1
  b.foes[1].charge, b.foes[1].charging = 1, "cavein"
  local events = battle.tick(s, rng)
  truthy(hasEvent(events, "lose"), "lost")
  for _ = 1, 60 do battle.tick(s, rng) end
  eq(b.result, "lost")
  eq(s.score, 0)
  eq(s.party[1].hp, 0)
end)

t("a win leaves nobody down, and status ends with the fight", function()
  local s, rng, b = quiet(nil, "tut_crawler")
  s.party[2].hp = 0
  b.allies[3].poison = 5
  b.foes[1].hp = 1
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  target(s, fixed(5), "foe", 1)
  eq(s.party[2].hp, 1)
  eq(b.allies[3].poison, 0)
end)

-- ---------------------------------------------------------------- the Foreman

t("the Foreman telegraphs: a warning, a long wait, and a turn for everyone before the blow", function()
  local s, rng = newState(trio()), seeded.rng(5)
  battle.begin(s, "boss_foreman", rng)
  local b = s.battle
  local boss = b.foes[1]
  boss.turns = 4 -- his next turn is the fifth
  boss.atb = battle.GAUGE
  b.beat = 0
  for _, u in ipairs(b.allies) do u.atb = 0 end
  local events = battle.tick(s, rng)
  truthy(hasEvent(events, "telegraph"), "he warns")
  truthy(boss.charge > 0, "he is winding up")
  eq(battle.blowIn(b), boss.charge)
  local waited = boss.charge
  for _, u in ipairs(b.allies) do
    truthy(waited >= math.ceil(battle.GAUGE / battle.gain(u.spd)), "everyone gets a turn in")
  end
  -- a DEFEND on the first turn in the wait, then a heal for anything after: the guard holds until the blow, for all
  local turns = { 0, 0, 0 }
  local landed
  for _ = 1, 300 do
    if b.phase == "cmd" then
      local i = b.active
      turns[i] = turns[i] + 1
      if turns[i] == 1 then
        battle.input(s, { kind = "cmd", cmd = "defend" })
      else
        truthy(b.allies[i].guard, "member " .. i .. " still on guard on a later turn")
        battle.input(s, { kind = "cmd", cmd = "item" })
        battle.tick(s, rng)
        battle.input(s, { kind = "pick", i = 1 })
        battle.tick(s, rng)
        battle.input(s, { kind = "target", side = "ally", i = i })
      end
    end
    landed = hasEvent(battle.tick(s, rng), "cavein")
    if landed then break end
  end
  truthy(landed, "the blow fell")
  for i = 1, 3 do
    truthy(turns[i] >= 1, "member " .. i .. " had a turn")
    truthy(b.allies[i].guard, "member " .. i .. " is guarded")
    eq(b.allies[i].braced, nil, "the brace is done with once the blow has landed")
  end
  eq(boss.charge, 0)
end)

t("a guard raised against a wind-up holds through later turns, and a second DEFEND is refused rather than wasted", function()
  local s, rng, b = quiet(nil, "boss_foreman")
  local boss = b.foes[1]
  boss.charge, boss.charging = 30, "cavein"
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "defend")
  truthy(b.allies[1].guard and b.allies[1].braced, "braced")
  b.beat = 0
  openFor(s, rng, 1)
  truthy(b.allies[1].guard, "the guard didn't drop at the next turn")
  cmd(s, rng, "defend")
  eq(b.phase, "cmd", "the turn isn't spent")
  eq(b.msg, "ALREADY GUARDING")
  cmd(s, rng, "attack")
  target(s, rng, "foe", 1)
  truthy(b.allies[1].guard, "attacking keeps the guard up")
  boss.charge = 1
  b.beat = 0
  truthy(hasEvent(battle.tick(s, rng), "cavein"), "the blow fell")
  truthy(b.allies[1].guard, "guarded when it fell")
  b.beat = 0
  b.beat = 0
  openFor(s, rng, 1)
  eq(b.allies[1].guard, false, "and the next turn after it, the guard is down as usual")
end)

t("without a wind-up a guard lasts until the next turn, and DEFEND can be chosen again", function()
  local s, rng, b = quiet(nil, "boss_foreman")
  b.beat = 0
  openFor(s, rng, 2)
  cmd(s, rng, "defend")
  truthy(b.allies[2].guard)
  eq(b.allies[2].braced, nil)
  b.beat = 0
  openFor(s, rng, 2)
  eq(b.allies[2].guard, false)
  cmd(s, rng, "defend")
  truthy(b.allies[2].guard, "chosen again")
end)

t("FOCUS doesn't stack: a second is refused and the turn isn't spent, and the focused hit uses it up", function()
  local s, rng, b = quiet(nil, "boss_foreman")
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  truthy(b.allies[1].focus)
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  eq(b.phase, "cmd", "the turn isn't spent")
  eq(b.msg, "ALREADY FOCUSED")
  cmd(s, rng, "attack")
  target(s, rng, "foe", 1)
  eq(b.allies[1].focus, false, "spent on the hit")
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  truthy(b.allies[1].focus, "and can be had again")
end)

t("the Foreman changes phase at two thirds and one third, and calls for help", function()
  local s, rng, b = quiet(nil, "boss_foreman")
  local boss = b.foes[1]
  eq(boss.phase, 1)
  boss.hp = math.floor(boss.mhp * 0.6)
  boss.atb = battle.GAUGE
  battle.tick(s, rng)
  eq(boss.phase, 2)
  truthy(b.msg:find("SHIFT"), b.msg)
  b.beat = 0
  boss.turns = 1
  boss.atb = battle.GAUGE
  battle.tick(s, rng)
  eq(boss.called, 1)
  eq(#b.foes, 2)
  eq(b.foes[2].id, "miner")
  eq(b.foes[2].added, true)
  boss.hp = math.floor(boss.mhp * 0.2)
  b.beat = 0
  boss.atb = battle.GAUGE
  battle.tick(s, rng)
  eq(boss.phase, 3)
end)

t("an unguarded cave in nearly fells the frailest at level 5, and a guarded one doesn't", function()
  local ab, foe = enemies.ABILITIES.cavein, enemies.FOES.foreman
  local blow = foe.atk * ab.power / 100
  local frail = party.stats(party.new("cleric", 5)).hp
  truthy(blow >= frail * 0.7, "blow " .. blow .. " on " .. frail)
  truthy(blow / 2 < frail * 0.6, "a guard saves you")
end)

-- ---------------------------------------------------------------- saving

--- Every number in a table is whole, except the speeds that come from the data.
local function plain(value, where)
  if type(value) == "table" then
    for k, v in pairs(value) do plain(v, where .. "." .. tostring(k)) end
  elseif type(value) == "number" and not where:find("spd", 1, true) then
    truthy(value == math.floor(value), where .. " is not whole: " .. value)
  else
    truthy(type(value) ~= "function", where .. " is a function")
  end
end

--- The same value all the way down. Serialised text won't do: key order differs after a load.
local function same(x, y, where)
  if type(x) ~= "table" or type(y) ~= "table" then
    truthy(x == y, where .. ": " .. tostring(x) .. " against " .. tostring(y))
    return
  end
  for k, v in pairs(x) do same(v, y[k], where .. "." .. tostring(k)) end
  for k in pairs(y) do truthy(x[k] ~= nil, where .. "." .. tostring(k) .. " appeared") end
end

--- A running trace of a fight, tick by tick.
local function resume(s, rng, ticks)
  local trail = {}
  for _ = 1, ticks do
    if s.battle.result then break end
    local action = battle.bot(s, rng)
    if action then battle.input(s, action) end
    battle.tick(s, rng)
    trail[#trail + 1] = fingerprint(s) .. s.battle.phase .. (s.battle.active or "") .. s.battle.msg
  end
  return table.concat(trail, "\n")
end

t("serialise round trip: a battle saved mid-fight resumes exactly", function()
  local seed = 77
  local rngA, stateOf = seeded.tracked(seed)
  local s = newState(trio(), { potion = 5, ether = 2, tonic = 1, antidote = 1 })
  battle.begin(s, "boss_foreman", rngA)
  resume(s, rngA, 500)
  plain(s.battle, "battle")
  local saved = textutils.serialise(s)
  local copy = textutils.unserialise(saved)
  local rngB = seeded.tracked(stateOf() - 1)
  local a = resume(s, rngA, 900)
  local b = resume(copy, rngB, 900)
  truthy(#a > 1000, "it played on")
  eq(a, b)
  same(s, copy, "s")
end)

t("every phase of a battle is plain enough to save", function()
  local s, rng, b = quiet(nil, "mine_4")
  textutils.serialise(s)
  openFor(s, rng, 2)
  textutils.serialise(s)
  cmd(s, rng, "special")
  textutils.serialise(s)
  pick(s, rng, "salve")
  textutils.serialise(s)
  eq(b.phase, "target")
  plain(s.battle, "battle")
end)

t("the same seed gives the same fight, using only the rng it is given", function()
  local function run(seed, noise)
    math.randomseed(noise)
    local rng = seeded.rng(seed)
    local s = newState(trio())
    battle.begin(s, "mine_4", rng)
    return resume(s, rng, 400)
  end
  eq(run(9, 1), run(9, 999))
end)

-- ---------------------------------------------------------------- the screen

local function drawEvery(s)
  ui.setScreen(surfaceApi.create(121, 81))
  s.rev = s.rev + 1
  view.draw(L, s)
end

t("view: every phase draws, with every background, party size and foe count", function()
  for _, enc in ipairs({ "tut_crawler", "wall_breach", "mine_1", "field_heart_1", "boss_foreman" }) do
    for _, team in ipairs({ { { "hero" } }, trio(), { { "hero" }, { "deserter" }, { "cleric" }, { "owlin" } } }) do
      local s, rng, b = quiet(team, enc, { potion = 2, ether = 1 })
      drawEvery(s)
      openFor(s, rng, 1)
      drawEvery(s)
      cmd(s, rng, "attack")
      drawEvery(s)
      send(s, rng, { kind = "back" })
      cmd(s, rng, "item")
      drawEvery(s)
      pick(s, rng, "potion")
      drawEvery(s)
      target(s, rng, "ally", 1)
      drawEvery(s)
      s.party[1].hp = 0
      b.foes[1].poison, b.foes[1].sleep = 5, 5
      drawEvery(s)
      -- the last foe nearly gone, and the end card
      s.party[1].hp = 5
      for _, f in ipairs(b.foes) do f.hp = 0 end
      b.foes[1].hp, b.beat = 1, 0
      openFor(s, rng, 1)
      cmd(s, rng, "attack")
      target(s, fixed(5), "foe", 1)
      eq(b.phase, "spoils")
      drawEvery(s)
    end
    breathe()
  end
end)

t("view: a telegraph, statuses and floats draw", function()
  local s, rng, b = quiet(nil, "boss_foreman")
  local boss = b.foes[1]
  boss.turns, boss.atb = 4, battle.GAUGE
  battle.tick(s, rng)
  truthy(boss.charge > 0, "charging")
  drawEvery(s)
  b.allies[1].poison, b.allies[2].sleep, b.allies[3].nightmare, b.allies[1].guard, b.allies[1].focus = 5, 5, 2, true, true
  drawEvery(s)
  b.beat = 0
  openFor(s, rng, 1)
  drawEvery(s)
end)

t("view: the picture is painted once for each rev", function()
  local s, rng = quiet()
  openFor(s, rng, 1)
  local a = surfaceApi.create(121, 81)
  ui.setScreen(a)
  view.draw(L, s)
  local paints = 0
  local real = ui.setScreen
  ui.setScreen = function(...) paints = paints + 1 return real(...) end
  view.draw(L, s)
  view.draw(L, s)
  ui.setScreen = real
  eq(paints, 0)
end)

t("tap map: the 2x2 block is the four commands, and nothing else on the wall is", function()
  local s, rng = quiet()
  openFor(s, rng, 1)
  local function at(x, y) return view.actionAt(L, s, x, y) end
  local attack, special, defend, item = at(17, 63), at(53, 63), at(17, 74), at(53, 74)
  eq(attack.kind, "cmd")
  eq(attack.cmd, "attack")
  eq(special.kind, "cmd")
  eq(special.cmd, "special")
  eq(defend.cmd, "defend")
  eq(item.cmd, "item")
  -- the corners of each button
  eq(at(0, 58).cmd, "attack")
  eq(at(34, 68).cmd, "attack")
  eq(at(36, 58).cmd, "special")
  eq(at(70, 68).cmd, "special")
  eq(at(0, 79).cmd, "defend")
  eq(at(70, 79).cmd, "item")
  -- the field, the message and the status strip do nothing while a command is wanted
  eq(at(30, 30), nil)
  eq(at(60, 2), nil)
  eq(at(80, 60), nil)
end)

t("the four command words fit their buttons in the big font", function()
  for _, word in ipairs({ "ATTACK", "DEFEND", "ITEM" }) do truthy(ui.textWidth(word) <= 33, word) end
  for _, ch in pairs(party.CHARS) do truthy(ui.textWidth(ch.special) <= 33, ch.special) end
end)

t("tap map: choosing a target taps the target, and tapping away goes back", function()
  local s, rng, b = quiet(nil, "mine_4")
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  for i = 1, 2 do
    local r = view.foeRect(b, i)
    local a = view.actionAt(L, s, r.x + 2, r.y + 2)
    eq(a.kind, "target")
    eq(a.side, "foe")
    eq(a.i, i)
  end
  eq(view.actionAt(L, s, 118, 2).kind, "back")
  local mate = view.allyRect(b, 2)
  eq(view.actionAt(L, s, mate.x + 2, mate.y + 2).kind, "back") -- a friend isn't a foe
  b.foes[2].hp = 0
  local gone = view.foeRect(b, 2)
  eq(view.actionAt(L, s, gone.x + 2, gone.y + 2).kind, "back")
  send(s, rng, { kind = "back" })
  cmd(s, rng, "item")
  pick(s, rng, "potion")
  local a = view.actionAt(L, s, mate.x + 2, mate.y + 2)
  eq(a.kind, "target")
  eq(a.side, "ally")
  eq(a.i, 2)
end)

t("tap map: rows of a list, in order, and away goes back", function()
  local s, rng, b = quiet(nil, "mine_1", { potion = 2, ether = 1 })
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  eq(b.phase, "list")
  local rows = battle.rows(s)
  eq(#rows, 3) -- potion, ether, flee
  eq(rows[3].id, "flee")
  local top, tall = 8, 8
  for i = 1, 3 do
    local a = view.actionAt(L, s, 40, top + (i - 1) * tall + 3)
    eq(a.kind, "pick")
    eq(a.i, i)
  end
  eq(view.actionAt(L, s, 2, 2).kind, "back")
  eq(view.actionAt(L, s, 40, top + 3 * tall + 2).kind, "back") -- under the last row
  eq(view.actionAt(L, s, 100, 20).kind, "back")                -- over the party
  eq(view.actionAt(L, s, 17, 63).kind, "back")                 -- the block is away too
end)

t("the longest list, five rows and FLEE, stays above the line and readable", function()
  local s, rng, b = quiet(nil, "mine_1", { potion = 1, ether = 1, antidote = 1, tonic = 1 })
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  eq(b.phase, "list")
  local rows = battle.rows(s)
  rows[6] = rows[5]
  local real = battle.rows
  battle.rows = function() return rows end
  drawEvery(s)
  for i = 1, 6 do
    local a = view.actionAt(L, s, 40, 8 + (i - 1) * 8 + 7)
    eq(a.kind, "pick")
    eq(a.i, i)
  end
  eq(view.actionAt(L, s, 40, 56).kind, "back") -- the line itself
  battle.rows = real
end)

t("tap map: time running gives nothing, the end card takes a tap, and nil state is safe", function()
  local s, rng, b = quiet()
  eq(view.actionAt(L, s, 60, 2), nil)
  eq(view.actionAt(L, nil, 60, 2), nil)
  eq(view.actionAt(L, {}, 60, 2), nil)
  b.foes[1].hp = 1
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  target(s, fixed(5), "foe", 1)
  eq(b.phase, "spoils")
  eq(view.actionAt(L, s, 60, 40).kind, "tap")
end)

--- Do two boxes share a cell? A foe's box counts its two rows of bars.
local function meet(a, c, extra)
  return a.x < c.x + c.w and c.x < a.x + a.w and a.y < c.y + c.h + extra and c.y < a.y + a.h + extra
end

--- Everything standing on the field, for a fight of so many foes and allies.
local function checkField(b, label)
  for i = 1, #b.foes do
    local r = view.foeRect(b, i)
    truthy(r.x >= 0 and r.y >= 8 and r.x + r.w <= 121 and r.y + r.h + 2 <= 56, label .. " foe " .. i .. " stays on the field")
    for j = i + 1, #b.foes do truthy(not meet(r, view.foeRect(b, j), 2), label .. " foes " .. i .. " and " .. j .. " overlap") end
    for j = 1, #b.allies do truthy(not meet(r, view.allyRect(b, j), 2), label .. " foe " .. i .. " stands on ally " .. j) end
  end
  for i = 1, #b.allies do
    local r = view.allyRect(b, i)
    truthy(r.x >= 0 and r.y >= 8 and r.x + r.w <= 121 and r.y + r.h <= 56, label .. " ally " .. i .. " stays on the field")
    truthy(r.w >= 10 and r.h >= 5, "big enough to tap")
    for j = i + 1, #b.allies do truthy(not meet(r, view.allyRect(b, j), 0), label .. " allies " .. i .. " and " .. j .. " overlap") end
  end
end

t("nobody overlaps on the field, whatever the numbers, and all of it is above the line", function()
  for foes = 1, 5 do
    for allies = 1, 4 do
      local b = { foes = {}, allies = {}, boss = false }
      for i = 1, foes do b.foes[i] = {} end
      for i = 1, allies do b.allies[i] = {} end
      checkField(b, foes .. "v" .. allies)
    end
  end
end)

t("the Foreman fills the left of the field and his miners stay in view", function()
  for allies = 1, 4 do
    local b = { foes = { {}, {}, {} }, allies = {}, boss = true }
    for i = 1, allies do b.allies[i] = {} end
    checkField(b, "boss v" .. allies)
  end
  local b = { foes = { {} }, allies = {}, boss = true }
  local r = view.foeRect(b, 1)
  truthy(r.x <= 2 and r.w >= 45 and r.h >= 40, "he is the biggest thing on the wall")
end)

t("the status strip stays clear of SAVE & QUIT, and four rows fit under the line", function()
  local strip = view.STRIP
  truthy(strip.x >= 71, "beside the block")
  truthy(strip.x + strip.w <= 107, "clear of SAVE & QUIT on every row")
  truthy(strip.y >= 57, "under the line")
  truthy(strip.y + 3 * strip.rowH + 1 <= 80, "the fourth row and its bars are on the wall")
end)

--- What the wall shows on a row, as text and background colours.
local function wallRow(y)
  local rows = {}
  ui.screen():output({
    getSize = function() return 121, 81 end,
    setCursorPos = function(_, row) rows.at = row end,
    blit = function(text, _, bg) rows[rows.at] = { text = text, bg = bg } end,
  })
  return rows[y + 1]
end

t("the strip draws the player's name, cut to fit, and all four gauges", function()
  local s, _, b = quiet({ { "hero" }, { "deserter" }, { "cleric" }, { "owlin" } })
  s.heroName = "Bartholomew"
  for _, u in ipairs(b.allies) do u.atb = 500 end
  s.rev = s.rev + 1
  drawEvery(s)
  truthy(wallRow(58).text:find("BARTHOLO", 1, true), "the hero's name")
  truthy(not wallRow(58).text:find("BARTHOLOM", 1, true), "cut to fit")
  truthy(wallRow(64).text:find("DOCTOR", 1, true), "the doctor")
  local atbInk = ("%x"):format(math.floor(math.log(ui.C.info) / math.log(2) + 0.5))
  for i = 1, 4 do
    local row = wallRow(58 + (i - 1) * 6 + 1)
    truthy(row.bg:sub(94, 98):find(atbInk, 1, true), "row " .. i .. " has an ATB gauge left of x 107: " .. row.bg:sub(94, 107))
    eq(row.bg:sub(108, 119), string.rep(row.bg:sub(120, 120), 12)) -- nothing under SAVE & QUIT
  end
end)

t("while time runs the block shows the latest message, wrapped to fit", function()
  local s = quiet()
  local ink = ("%x"):format(math.floor(math.log(ui.C.text) / math.log(2) + 0.5))
  local function inBlock(y) return wallRow(y).bg:sub(1, 71):find(ink, 1, true) ~= nil end
  s.battle.msg = "HI"
  drawEvery(s)
  eq(inBlock(68), true)
  eq(inBlock(73), false)
  s.battle.msg = "FOREMAN: NO MORE SLEEP"
  drawEvery(s)
  eq(inBlock(63), true)
  eq(inBlock(73), true)
end)

t("sprites: all sixteen palette colours only, and solid enough to read at wall size", function()
  local legal = {}
  for _, c in pairs(ui.C) do legal[c] = true end
  local seen = {}
  for name in pairs(art.SPRITES) do
    for _, size in ipairs({ { 26, 18 }, { 20, 14 }, { 37, 50 }, { 22, 15 } }) do
      local runs = art.bake(name, size[1], size[2])
      local filled = 0
      for i = 1, #runs, 4 do
        truthy(legal[runs[i + 3]], name .. " uses a colour off the palette")
        truthy(runs[i] >= 0 and runs[i] + runs[i + 2] <= size[1], name .. " stays in its box")
        filled = filled + runs[i + 2]
      end
      truthy(filled >= size[1] * size[2] * 0.12, name .. " is too thin at " .. size[1])
    end
    local key = table.concat(art.bake(name, 26, 18), ",")
    truthy(not seen[key], name .. " looks just like " .. tostring(seen[key]))
    seen[key] = name
    art.bake(name, 26, 18, "flash")
    art.bake(name, 26, 18, "dim")
  end
end)

t("every string a battle can show is plain ASCII", function()
  local function ascii(str) truthy(not str:find("[^\32-\126]"), str) end
  for _, c in pairs(party.CHARS) do ascii(c.name) end
  for _, x in pairs(party.SPELLS) do ascii(x.name) end
  for _, x in pairs(party.ITEMS) do ascii(x.name) end
  for _, x in pairs(party.GEAR) do ascii(x.name) end
  for _, x in pairs(enemies.FOES) do ascii(x.name) end
  for _, x in pairs(enemies.ABILITIES) do
    ascii(x.name)
    if x.warn then ascii(x.warn) end
  end
end)

t("messages and list rows fit the big font", function()
  for _, x in pairs(party.SPELLS) do truthy(ui.textWidth(x.name) <= 50, x.name) end
  for _, x in pairs(party.ITEMS) do truthy(x.key or ui.textWidth(x.name) <= 50, x.name) end
  for _, foe in pairs(enemies.FOES) do
    for _, entry in ipairs(foe.abilities) do
      local name = enemies.ABILITIES[entry[1]].name
      local line = (foe.short or foe.name) .. ": " .. name
      if #line > battle.LABEL_LONGEST then line = name end -- as battle.foeLabel does
      truthy(ui.textWidth(line) <= 119, line)
    end
  end
  for _, id in ipairs({ "shaft", "bile", "scream", "whistle", "cavein" }) do
    local line = enemies.FOES.foreman.short .. ": " .. enemies.ABILITIES[id].name
    truthy(ui.textWidth(line) <= 119, line)
  end
end)

-- ---------------------------------------------------------------- the bot

t("the bot heals the low, defends a telegraph, and always finishes", function()
  -- low: the cleric mends
  local s, rng, b = quiet()
  s.party[1].hp = 5
  openFor(s, rng, 3)
  eq(battle.bot(s, rng).cmd, "special")
  cmd(s, rng, "special")
  local a = battle.bot(s, rng)
  eq(a.kind, "pick")
  eq(battle.rows(s)[a.i].id, "mend")
  pick(s, rng, "mend")
  a = battle.bot(s, rng)
  eq(a.kind, "target")
  eq(a.side, "ally")
  eq(a.i, 1)

  -- a blow coming, and no second turn before it: defend
  s, rng, b = quiet(nil, "boss_foreman")
  b.foes[1].charge, b.foes[1].charging = 4, "cavein"
  openFor(s, rng, 1)
  eq(battle.bot(s, rng).cmd, "defend")

  -- no menu, nothing to do
  s, rng, b = quiet()
  eq(battle.bot(s, rng), nil)
end)

t("the bot only ever sends what the rules accept: every field fight ends", function()
  for id in pairs(enemies.ENCOUNTERS) do
    for seed = 1, 6 do
      local s = newState({ { "hero", 3 }, { "deserter", 3 }, { "cleric", 3 } }, { potion = 3, ether = 1, tonic = 1, antidote = 1 })
      local result = fight(s, id, seeded.rng(seed))
      truthy(result == "won" or result == "lost" or result == "fled", id .. " ended: " .. tostring(result))
    end
    breathe()
  end
end)

local BOSS_BAG = { potion = 5, ether = 2, tonic = 2, antidote = 2 }

local function bossTeam(lvl, geared)
  if not geared then return trio(lvl) end
  -- what rules.bot arrives with: the mine's sword and leathers, and the hero's old knife passed down
  return { { "hero", lvl, "shortsword", "leathers" }, { "deserter", lvl, "knife", "leathers" }, { "cleric", lvl } }
end

local function bossRate(lvl, geared, runs)
  local wins = 0
  for seed = 1, runs do
    local bag = {}
    for k, v in pairs(BOSS_BAG) do bag[k] = v end
    local s = newState(bossTeam(lvl, geared), bag)
    if fight(s, "boss_foreman", seeded.rng(seed * 31)) == "won" then wins = wins + 1 end
    if seed % 8 == 0 then breathe() end
  end
  return wins * 100 / runs
end

t("balance: the Foreman at level 5 is challenging but fair, and levels matter", function()
  local runs = 80
  local geared, bare = bossRate(5, true, runs), bossRate(5, false, runs)
  local low, high = bossRate(3, true, runs), bossRate(7, true, runs)
  local report = ("L5 with shop gear %.0f%%, L5 in starting gear %.0f%%, L3 %.0f%%, L7 %.0f%%"):format(geared, bare, low, high)
  print(report)
  truthy(geared >= 60 and geared <= 92, report)
  truthy(bare >= 50, report)
  truthy(low < 30, report)
  truthy(high >= 95, report)
end)

t("balance: a field fight costs little and doesn't drag", function()
  local cases = {
    { "field_road_1", { { "hero", 2 }, { "deserter", 2 } } },
    { "field_road_2", { { "hero", 3 }, { "deserter", 3 } } },
    { "field_heart_1", { { "hero", 3 }, { "deserter", 3 } } },
    { "field_heart_2", { { "hero", 3 }, { "deserter", 3 } } },
    { "field_heart_3", { { "hero", 3 }, { "deserter", 3 } } },
    { "mine_1", trio(3) }, { "mine_2", trio(3) }, { "mine_3", trio(4) }, { "mine_4", trio(4) },
  }
  for _, case in ipairs(cases) do
    local lost, won, longest = 0, 0, 0
    local runs = 30
    for seed = 1, runs do
      local s = newState(case[2])
      local total = 0
      for _, m in ipairs(s.party) do total = total + m.hp end
      local result, ticks = fight(s, case[1], seeded.rng(seed))
      if result == "won" then won = won + 1 end
      longest = math.max(longest, ticks)
      local left = 0
      for _, m in ipairs(s.party) do left = left + m.hp end
      lost = lost + (total - left) / total
    end
    truthy(won == runs, case[1] .. " won " .. won)
    truthy(lost / runs <= 0.2, case[1] .. " cost " .. lost / runs)
    truthy(longest * 0.12 <= 30, case[1] .. " took " .. longest * 0.12 .. "s")
    breathe()
  end
end)

t("balance: the opening fights are safe for a new hero alone", function()
  for _, enc in ipairs({ "tut_crawler", "wall_breach" }) do
    for seed = 1, 40 do
      local s = newState({ { "hero", 1 } })
      eq(fight(s, enc, seeded.rng(seed)), "won")
    end
  end
  for seed = 1, 40 do
    local s = newState({ { "hero", 2 }, { "deserter", 2 } })
    eq(fight(s, "gate_orderlies", seeded.rng(seed)), "won")
  end
end)

-- ---------------------------------------------------------------- foes by number

--- Add a test foe, and an encounter of just that foe, once.
local function testFoe(id, def, bossFight)
  enemies.addFoe(id, def)
  enemies.ENCOUNTERS[id] = { foes = { id }, flee = not bossFight, bg = "mine", boss = bossFight or false }
  return enemies.FOES[id]
end

t("a tier and a shape make a whole foe, and an explicit number stands", function()
  local def = testFoe("t_leech", { name = "LEECH", tier = 7, shape = "quick", sprite = "rat", abilities = { { "gnaw", 1 } }, weak = { "fire" } })
  for _, key in ipairs({ "hp", "mp", "atk", "def", "spd", "xp", "gold" }) do
    truthy(type(def[key]) == "number" and def[key] == math.floor(def[key]), key)
  end
  truthy(def.weak.fire, "a list of weaknesses becomes a set too")
  local kept = enemies.finish({ tier = 7, shape = "quick", hp = 5, atk = 3 })
  eq(kept.hp, 5)
  eq(kept.atk, 3)
  truthy(kept.def ~= nil, "and the rest is filled in")
  local again = enemies.finish(enemies.finish({ tier = 9, shape = "tank", immune = { "sleep" } }))
  truthy(again.immune.sleep, "safe to do twice")
end)

t("the formula continues the slice's foes, and climbs all the way to tier 50", function()
  local cases = { { "crawler", 1, "small" }, { "harpy", 2, "quick" }, { "frogman", 2, "brute" }, { "stalker", 3, "quick" }, { "miner", 4, "brute" } }
  for _, case in ipairs(cases) do
    local real, made = enemies.FOES[case[1]], enemies.numbers(case[2], case[3])
    for _, key in ipairs({ "hp", "atk", "xp" }) do
      truthy(math.abs(made[key] - real[key]) <= math.max(3, real[key] * 0.45), case[1] .. " " .. key .. " " .. made[key] .. " against " .. real[key])
    end
  end
  for shape in pairs(enemies.SHAPES) do
    for tier = 2, enemies.MAX_TIER do
      local now, was = enemies.numbers(tier, shape), enemies.numbers(tier - 1, shape)
      for _, key in ipairs({ "hp", "atk", "xp", "gold" }) do truthy(now[key] >= was[key], shape .. " " .. key .. " at " .. tier) end
    end
  end
  local boss = enemies.numbers(30, "brute", true)
  truthy(boss.hp > 8 * enemies.numbers(30, "brute").hp, "a boss is a boss")
end)

-- ---------------------------------------------------------------- bosses from data

local function testBoss(id, tier, extra)
  enemies.ABILITIES.t_big = { name = "BIG", power = 180, magic = true, target = "all", windup = 34, warn = "IT GATHERS" }
  local def = {
    name = "TEST BOSS", short = "BOSS", tier = tier, sprite = "foreman", boss = { hpx = 1, phases = {
      { at = 100, moves = { { "shaft", 1 } }, every = 5, big = "t_big" },
      { at = 50, moves = { { "shaft", 1 } }, every = 3, big = "t_big", say = "IT WAKES", speedUp = 2, summon = "miner" },
    } },
  }
  for k, v in pairs(extra or {}) do def[k] = v end
  return testFoe(id, def, true)
end

t("a boss built from the format changes phase, speeds up, says its line and calls for help", function()
  local def = testBoss("t_boss", 10)
  truthy(def.hp > 1000 and def.immune.sleep and def.immune.tadpole and def.immune.doom, "numbers and a boss's immunities")
  truthy(def.abilities, "abilities default to the first phase")
  local s, rng, b = quiet(nil, "t_boss")
  local boss = b.foes[1]
  eq(boss.phase, 1)
  local spd = boss.spd
  boss.hp, boss.atb = math.floor(boss.mhp * 0.4), battle.GAUGE
  battle.tick(s, rng)
  eq(boss.phase, 2)
  eq(boss.spd, spd + 2)
  eq(b.msg, "IT WAKES")
  b.beat, boss.atb, boss.turns = 0, battle.GAUGE, 0
  battle.tick(s, rng)
  eq(#b.foes, 2)
  eq(b.foes[2].added, true)
  truthy(b.msg:find("CALLS FOR HELP"), b.msg)
  -- the beat of the big move
  b.beat, boss.atb, boss.turns = 0, battle.GAUGE, 2
  battle.tick(s, rng)
  eq(boss.charging, "t_big")
end)

t("two bosses in one fight: each has its own phases, and both must fall", function()
  testBoss("t_twin", 10, { size = 1 })
  enemies.ENCOUNTERS.t_twins = { foes = { "t_twin", "t_twin" }, flee = false, bg = "mine", boss = true }
  local s, rng, b = quiet(nil, "t_twins")
  b.foes[1].hp = 0
  b.foes[2].atb = battle.GAUGE
  battle.tick(s, rng)
  eq(b.phase == "spoils", false)
  truthy(b.phase == "run" or b.phase == "cmd", "the fight goes on")
  -- a helper never takes a fallen boss's place: its XP is still owed
  local boss = b.foes[2]
  b.beat, boss.hp, boss.atb, boss.turns = 0, 100, battle.GAUGE, 0
  for _ = 1, 2 do
    boss.atb, b.beat = battle.GAUGE, 0
    battle.tick(s, rng)
  end
  eq(b.foes[1].id, "t_twin")
  eq(#b.foes, 3)
end)

-- ---------------------------------------------------------------- elements

t("a weakness does half as much again and says so, a resistance half", function()
  testFoe("t_weak", { name = "W", tier = 5, shape = "tank", sprite = "rat", hp = 900, abilities = { { "bite", 1 } }, weak = { "fire" }, resist = { "ice" } })
  local function burn(spell)
    local s, rng, b = quiet({ { "owlin", 12 } }, "t_weak")
    rng = fixed(5)
    openFor(s, rng, 1)
    cmd(s, rng, "special")
    while not (function()
      for _, row in ipairs(battle.rows(s)) do
        if row.id == spell then return true end
      end
      return false
    end)() do
      send(s, rng, { kind = "pick", i = #battle.rows(s) })
    end
    pick(s, rng, spell)
    if b.phase == "target" then target(s, rng, "foe", 1) end
    return 900 - b.foes[1].hp, b
  end
  local plain = burn("bolt")
  local weak, b = burn("blaze")
  local found = false
  for _, f in ipairs(b.floats) do found = found or (f.text == "WEAK" and f.small == true) end
  truthy(found, "a small WEAK float")
  local base = party.SPELLS.blaze.power + party.stats(party.new("owlin", 12)).mag
  truthy(weak >= base * 1.25, weak .. " on a base of " .. base)
  truthy(plain > 0, "plain")
  local cold = burn("sleet")
  truthy(cold < (party.SPELLS.sleet.power + party.stats(party.new("owlin", 12)).mag) * 0.7, "resisted " .. cold)
end)

t("every element is carried by a spell, and every damage spell's element is a real one", function()
  local real = {}
  for _, e in ipairs(enemies.ELEMENTS) do real[e] = true end
  local seen = {}
  for id, spell in pairs(party.SPELLS) do
    if spell.element then
      truthy(real[spell.element], id)
      seen[spell.element] = true
    end
  end
  for _, e in ipairs(enemies.ELEMENTS) do truthy(seen[e], e) end
  for id, ab in pairs(enemies.ABILITIES) do
    if ab.element then truthy(real[ab.element], id) end
  end
end)

t("gear that resists an element halves it", function()
  local function blowOn(accessory)
    enemies.ABILITIES.t_fire = { name = "F", power = 100, magic = true, element = "fire" }
    testFoe("t_burner", { name = "B", tier = 10, shape = "brute", sprite = "rat", abilities = { { "t_fire", 1 } } })
    local s, rng, b = quiet({ { "hero", 10 } }, "t_burner")
    s.party[1].accessory = accessory
    party.restore(s.party[1])
    local hp = s.party[1].hp
    b.foes[1].atb = battle.GAUGE
    battle.tick(s, fixed(5))
    return hp - s.party[1].hp
  end
  local bare, warded = blowOn(nil), blowOn("fire_ward")
  truthy(warded <= math.ceil(bare / 2), warded .. " against " .. bare)
end)

-- ---------------------------------------------------------------- new statuses

local function landed(status, team, accessory)
  enemies.ABILITIES.t_status = { name = "T", status = status, chance = 100 }
  testFoe("t_hexer", { name = "H", tier = 5, shape = "caster", sprite = "rat", abilities = { { "t_status", 1 } } })
  local s, rng, b = quiet(team or { { "deserter", 10 } }, "t_hexer")
  s.party[1].accessory = accessory
  b.foes[1].atb = battle.GAUGE
  battle.tick(s, rng)
  return b.allies[1][status] > 0, s, rng, b
end

t("thrall: no menu, turns on the party, and a hard hit or a cure frees them", function()
  local s, rng, b = quiet({ { "hero", 10 }, { "cleric", 10 } })
  local u = b.allies[1]
  u.thrall, u.atb = 3, battle.GAUGE
  local hp = s.party[2].hp
  battle.tick(s, fixed(5))
  eq(b.phase, "run")
  eq(u.thrall, 2)
  truthy(s.party[2].hp < hp, "the friend was hit")
  truthy(b.msg:find("TURNS ON"), b.msg)
  -- a small hit doesn't free them, a hard one does
  local weak = { name = "T", power = 1, magic = true }
  enemies.ABILITIES.t_tap, enemies.ABILITIES.t_hard = weak, { name = "T", power = 400, magic = true }
  testFoe("t_tapper", { name = "H", tier = 5, shape = "caster", sprite = "rat", abilities = { { "t_tap", 1 } } })
  s, rng, b = quiet({ { "hero", 10 } }, "t_tapper")
  b.allies[1].thrall, b.foes[1].atb = 3, battle.GAUGE
  battle.tick(s, rng)
  eq(b.allies[1].thrall, 3)
  enemies.FOES.t_tapper.abilities = { { "t_hard", 1 } }
  b.beat, b.foes[1].atb = 0, battle.GAUGE
  battle.tick(s, rng)
  eq(b.allies[1].thrall, 0)
end)

t("a thrall alone stands lost, and wears off in the end", function()
  local s, rng, b = quiet({ { "hero", 10 } })
  b.allies[1].thrall, b.allies[1].atb = 1, battle.GAUGE
  battle.tick(s, rng)
  truthy(b.msg:find("STANDS LOST"), b.msg)
  eq(b.allies[1].thrall, 0)
end)

t("foes don't hit their own thralls while anyone else stands", function()
  for seed = 1, 20 do
    local s, rng, b = quiet({ { "hero", 10 }, { "cleric", 10 } }, "mine_3", nil, seed)
    b.allies[1].thrall = 3
    local hp = s.party[1].hp
    b.foes[1].atb = battle.GAUGE
    battle.tick(s, rng)
    eq(s.party[1].hp, hp)
  end
end)

t("tadpole: lashes past armour, and a circlet stops it and nightmare", function()
  eq((landed("tadpole")), true)
  eq((landed("tadpole", nil, "circlet")), false)
  eq((landed("nightmare", nil, "circlet")), false)
  eq((landed("thrall", nil, "circlet")), true)
  local s, rng, b = quiet({ { "owlin", 10 }, { "hero", 10 } })
  b.allies[1].tadpole, b.allies[1].atb = 2, battle.GAUGE
  local hp = s.party[2].hp
  battle.tick(s, fixed(5))
  truthy(s.party[2].hp < hp, "lashed")
  eq(b.allies[1].tadpole, 1)
end)

t("the hero stays immune to nightmare and sleep, in old gear or new", function()
  eq((landed("sleep", { { "hero", 10 } })), false)
  eq((landed("nightmare", { { "hero", 10 } })), false)
  eq((landed("blind", { { "hero", 10 } })), true)
end)

t("blind misses often", function()
  local hits = 0
  for seed = 1, 200 do
    local s, rng, b = quiet({ { "hero", 10 } }, "mine_3", nil, seed)
    b.allies[1].blind = 50
    b.foes[1].hp = 500
    openFor(s, rng, 1)
    cmd(s, rng, "attack")
    target(s, rng, "foe", 1)
    if b.foes[1].hp < 500 then hits = hits + 1 end
  end
  truthy(hits < 100, "hit " .. hits .. " of 200")
end)

t("silence stops PRAY and MAGIC, not MIX, and wears off", function()
  local s, rng, b = quiet({ { "cleric", 10 }, { "deserter", 10 } })
  b.allies[1].silence, b.allies[2].silence = 50, 50
  s.party[1].hp = 5
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  for _, row in ipairs(battle.rows(s)) do eq(row.ok, false) end
  send(s, rng, { kind = "back" })
  cmd(s, rng, "defend")
  b.beat = 0
  openFor(s, rng, 2)
  cmd(s, rng, "special")
  truthy(battle.rows(s)[1].ok, "a flask needs no voice")
  send(s, rng, { kind = "back" })
  cmd(s, rng, "defend")
  b.beat = 0
  b.allies[1].atb, b.allies[2].atb = 0, 0
  b.foes[1].atb = 0
  local left = b.allies[1].silence
  battle.tick(s, rng)
  eq(b.allies[1].silence, left - 1)
end)

t("doom fells them when the count runs out, unless cured, and bosses laugh at it", function()
  local s, rng, b = quiet({ { "hero", 10 }, { "cleric", 10 } })
  b.allies[1].doom = 2
  b.foes[1].spd, b.allies[1].spd, b.allies[2].spd = -100, -100, -100
  runUntil(s, rng, function() return s.party[1].hp == 0 end, 10)
  s, rng, b = quiet({ { "hero", 10 } }, nil, { lastrites = 1 })
  b.allies[1].doom = 40
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  pick(s, rng, "lastrites")
  target(s, rng, "ally", 1)
  eq(b.allies[1].doom, 0)
  truthy(enemies.FOES.foreman.immune.doom, "the Foreman")
end)

t("a lone doomed hero ends the fight", function()
  local s, rng, b = quiet({ { "hero", 10 } })
  b.allies[1].doom = 1
  b.foes[1].spd, b.allies[1].spd = -100, -100
  runUntil(s, rng, function() return b.phase == "spoils" end, 10)
  eq(b.outcome, "lost")
end)

t("every status has a cure, and each new one shows on the wall", function()
  for _, status in ipairs({ "poison", "sleep", "nightmare", "thrall", "tadpole", "blind", "silence", "doom" }) do
    local found = false
    for _, item in pairs(party.ITEMS) do
      for _, name in ipairs(item.cures or {}) do found = found or name == status end
    end
    truthy(found, status .. " has an item")
    found = false
    for _, spell in pairs(party.SPELLS) do
      for _, name in ipairs(spell.cures or {}) do found = found or name == status end
    end
    truthy(found, status .. " has a spell")
  end
  local s, rng, b = quiet({ { "hero" }, { "cleric" } })
  local u = b.allies[1]
  u.thrall, u.tadpole, u.blind, u.silence, u.doom = 1, 1, 1, 1, 1
  drawEvery(s)
end)

t("a battle saved before these statuses plays on", function()
  local s, rng, b = quiet({ { "jezzara" } })
  for _, u in ipairs({ b.allies[1], b.foes[1] }) do
    u.thrall, u.tadpole, u.blind, u.silence, u.doom, u.hidden, u.oath = nil, nil, nil, nil, nil, nil, nil
  end
  b.v = nil
  b.phase, b.active, b.pick = "target", 1, "steal"
  drawEvery(s)
  eq(type(battle.bot(s, rng)), "table")
  battle.tick(s, rng)
  eq(b.pickId, "steal")
  eq(b.allies[1].thrall, 0)
end)

-- ---------------------------------------------------------------- the party to level 50

t("each of the six has a full and distinct list, and every spell is real", function()
  local owner = {}
  for id, ch in pairs(party.CHARS) do
    for lvl, spell in pairs(ch.learns) do
      truthy(party.SPELLS[spell], id .. " " .. spell)
      truthy(lvl <= party.MAX_LEVEL, spell)
      truthy(not owner[spell], spell .. " belongs to one person")
      owner[spell] = id
    end
  end
  for id, spell in pairs(party.SPELLS) do truthy(owner[id], id .. " is known by someone") end
  eq(#party.known(party.new("hero", 50)), 0)
  truthy(#party.known(party.new("deserter", 50)) >= 14, "MIX")
  truthy(#party.known(party.new("cleric", 50)) >= 13, "PRAY")
  truthy(#party.known(party.new("owlin", 50)) >= 16, "MAGIC")
  truthy(#party.known(party.new("jezzara", 50)) >= 6, "STEAL")
  truthy(#party.known(party.new("asphodel", 50)) >= 5, "BLOOD")
end)

t("level 50 keeps HP in the strip's three digits", function()
  for id in pairs(party.CHARS) do
    local m = party.new(id, 50)
    truthy(party.stats(m).hp < 1000 and party.stats(m).mp < 1000, id)
  end
end)

t("a list longer than the screen pages round with MORE, and the bot finds what it wants", function()
  local s, rng, b = quiet({ { "owlin", 50 } })
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  local rows = battle.rows(s)
  eq(#rows, 6)
  eq(rows[6].id, "more")
  local seen, turns = {}, 0
  repeat
    for _, row in ipairs(battle.rows(s)) do seen[row.id] = true end
    send(s, rng, { kind = "pick", i = #battle.rows(s) })
    turns = turns + 1
  until b.top == 0 or turns > 10
  for _, id in ipairs(party.known(s.party[1])) do truthy(seen[id], id .. " can be reached") end
  drawEvery(s)
  -- FLEE at the very end of a long bag
  local bag = {}
  for _, id in ipairs(party.ITEM_ORDER) do bag[id] = 1 end
  s, rng, b = quiet({ { "hero" } }, "mine_1", bag)
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  local flee = false
  for _ = 1, 5 do
    for _, row in ipairs(battle.rows(s)) do flee = flee or row.id == "flee" end
    send(s, rng, { kind = "pick", i = #battle.rows(s) })
  end
  truthy(flee, "FLEE can be reached")
end)

t("FOCUS grows: a sweep at 14, a brace at 28, four times at 40", function()
  local s, rng, b = quiet({ { "hero", 14 } }, "mine_4")
  rng = fixed(5)
  b.foes[1].hp, b.foes[2].hp = 900, 900
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  eq(b.allies[1].guard, false)
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  target(s, rng, "foe", 1)
  truthy(b.foes[2].hp < 900 and b.foes[1].hp < b.foes[2].hp, "it swept the other, for less")
  s, rng, b = quiet({ { "hero", 28 } })
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  eq(b.allies[1].guard, true)
  eq(party.focusOf(party.new("hero", 40)).times, 4)
  eq(party.focusOf(party.new("hero", 5)).times, 3)
end)

t("STEAL's real use: a boss's rare gear, once, and it lands in the bag", function()
  local def = testBoss("t_rich", 15)
  truthy(party.GEAR[def.steal], "bosses carry gear by default")
  local s, rng, b = quiet({ { "jezzara", 15 } }, "t_rich", {})
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  eq(b.phase, "target")
  target(s, fixed(1), "foe", 1)
  eq(s.bag[def.steal], 1)
  b.beat = 0
  b.allies[1].atb, b.foes[1].atb = 0, 0
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  target(s, fixed(1), "foe", 1)
  eq(s.bag[def.steal], 1)
  -- every default can be found in the data
  for _, tier in ipairs({ 5, 15, 25, 35, 45 }) do
    for _, boss in ipairs({ true, false }) do
      local one = enemies.finish({ tier = tier, shape = "brute", boss = boss and { phases = { { at = 100, moves = { { "bite", 1 } } } } } or nil })
      truthy(party.ITEMS[one.steal] or party.GEAR[one.steal], tostring(one.steal))
    end
  end
end)

t("Jezzara's second skills: a list once she has them, grit then backstab, and vanish", function()
  local s, rng, b = quiet({ { "jezzara", 36 } }, "mine_3")
  rng = fixed(5)
  b.foes[1].hp = 900
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  eq(b.phase, "list")
  pick(s, rng, "backstab")
  target(s, rng, "foe", 1)
  local plain = 900 - b.foes[1].hp
  b.beat, b.foes[1].hp, b.foes[1].blind = 0, 900, 40
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  pick(s, rng, "backstab")
  target(s, rng, "foe", 1)
  truthy(900 - b.foes[1].hp > 2 * plain, "the blind can't see it coming")
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  pick(s, rng, "vanish")
  truthy(b.allies[1].hidden, "gone")
  local hp = s.party[1].hp
  b.beat, b.foes[1].atb = 0, battle.GAUGE
  battle.tick(s, rng)
  eq(s.party[1].hp, hp)
  b.beat = 0
  openFor(s, rng, 1)
  eq(b.allies[1].hidden, false)
end)

t("COIN SHOT spends gold, and can't be paid for without it", function()
  local s, rng, b = quiet({ { "jezzara", 36 } })
  s.gold = 1
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  for _, row in ipairs(battle.rows(s)) do
    if row.id == "coinshot" then eq(row.ok, false) end
  end
  send(s, rng, { kind = "back" })
  s.gold = 1000
  cmd(s, rng, "special")
  b.foes[1].hp = 900
  pick(s, rng, "coinshot")
  target(s, rng, "foe", 1)
  eq(s.gold, 1000 - party.SPELLS.coinshot.cost * 36)
  truthy(b.foes[1].hp < 900, "it hurts")
end)

t("Asphodel's BLOOD: everything costs HP, never the last point, and she can feed and give", function()
  local s, rng, b = quiet({ { "asphodel", 36 }, { "hero", 36 } }, "mine_3")
  b.foes[1].hp = 900
  local m = s.party[1]
  m.hp = 1
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  pick(s, rng, "bleed")
  target(s, rng, "foe", 1)
  eq(m.hp, 1)
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  pick(s, fixed(5), "leech")
  target(s, fixed(5), "foe", 1)
  truthy(m.hp > 1, "she feeds")
  party.restore(m)
  s.party[2].hp = 10
  b.beat = 0
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  pick(s, rng, "transfuse")
  local before = m.hp
  target(s, rng, "ally", 2)
  truthy(m.hp < before and s.party[2].hp > 10, "she gives")
end)

t("the second skills fit the wall in their rows", function()
  for _, x in pairs(party.SPELLS) do truthy(ui.textWidth(x.name) <= 50, x.name) end
end)

-- ---------------------------------------------------------------- gear, items, XP

t("the shop tiers are complete: real stock, in every class, for all seven", function()
  eq(#party.SHOP_TIERS, 7)
  for tier, list in ipairs(party.SHOP_TIERS) do
    local weapons, armours = {}, {}
    for _, row in ipairs(list) do
      local def = party.ITEMS[row.item] or party.GEAR[row.item]
      truthy(def, row.item)
      truthy(row.price > 0, row.item)
      if party.GEAR[row.item] then
        for id in pairs(party.CHARS) do
          if party.canWear({ id = id }, row.item) then
            if def.slot == "weapon" then weapons[id] = true elseif def.slot == "armour" then armours[id] = true end
          end
        end
      end
    end
    for id in pairs(party.CHARS) do
      truthy(weapons[id] and armours[id], "tier " .. tier .. " dresses " .. id)
    end
  end
end)

t("each tier of gear beats the last, for everyone", function()
  for id in pairs(party.CHARS) do
    local last = 0
    for tier = 1, 7 do
      local weapon, armour = party.kit(id, tier)
      eq(party.canWear({ id = id }, weapon), true)
      eq(party.canWear({ id = id }, armour), true)
      local score = party.gearScore({ id = id }, weapon) + party.gearScore({ id = id }, armour)
      truthy(score > last, id .. " tier " .. tier)
      last = score
    end
  end
  eq(party.canWear({ id = "cleric" }, "falchion"), false)
  eq(party.gearScore({ id = "cleric" }, "falchion"), nil)
  eq(party.canWear({ id = "cleric" }, "knife"), true)
end)

t("the accessory: nil works, and it counts when worn", function()
  local m = party.new("owlin", 20)
  eq(m.accessory, nil)
  local mag = party.stats(m).mag
  m.accessory = "sage_ring"
  eq(party.stats(m).mag, mag + party.GEAR.sage_ring.mag)
  m.accessory = "no_such_thing"
  eq(party.stats(m).mag, mag)
  eq(party.immune({ id = "owlin", lvl = 5 }, "tadpole"), false)
end)

t("items: ITEM_ORDER is complete, key items stay out of a fight, and a tent is for the camp", function()
  local inOrder = {}
  for _, id in ipairs(party.ITEM_ORDER) do
    truthy(party.ITEMS[id], id)
    inOrder[id] = true
  end
  for id in pairs(party.ITEMS) do truthy(inOrder[id], id .. " is in the order") end
  party.addItem("t_seal", { name = "THE SEAL", key = true })
  eq(party.ITEMS.t_seal.price, 0)
  eq(party.ITEM_ORDER[#party.ITEM_ORDER], "t_seal")
  local s, rng = quiet(nil, "mine_1", { t_seal = 1, tent = 1, potion = 1 })
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  for _, row in ipairs(battle.rows(s)) do truthy(row.id ~= "t_seal" and row.id ~= "tent", row.id) end
  -- nothing but a key item leaves nothing to list
  s, rng = quiet(nil, "boss_foreman", { t_seal = 1 })
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  eq(s.battle.phase, "cmd")
  party.ITEMS.t_seal = nil
  party.ITEM_ORDER[#party.ITEM_ORDER] = nil

  local team = { party.new("hero", 10), party.new("cleric", 10) }
  team[1].hp, team[2].hp, team[2].mp = 1, 1, 0
  party.useField(team, team[1], "tent")
  eq(team[1].hp, party.stats(team[1]).hp)
  eq(team[2].hp, party.stats(team[2]).hp)
  eq(team[2].mp, party.stats(team[2]).mp)
  local alone = { party.new("hero", 10), party.new("cleric", 10) }
  alone[1].hp, alone[2].hp = 1, 1
  party.useField(alone, alone[1], "potion")
  eq(alone[2].hp, 1)
end)

t("a raising item waits for the fallen, and raises them", function()
  local s, rng, b = quiet(nil, nil, { feather = 1 })
  openFor(s, rng, 1)
  cmd(s, rng, "item")
  eq(battle.rows(s)[1].ok, false)
  send(s, rng, { kind = "back" })
  s.party[2].hp = 0
  cmd(s, rng, "item")
  pick(s, rng, "feather")
  local _, list = battle.targets(s)
  eq(list[1], 2)
  target(s, rng, "ally", 2)
  eq(s.party[2].hp, math.floor(party.stats(s.party[2]).hp * 0.6))
end)

t("the bench gets three quarters of the XP, and only four fight", function()
  local s, rng, b = quiet({ { "hero", 10 }, { "cleric", 10 }, { "owlin", 10 }, { "deserter", 10 }, { "jezzara", 10 }, { "asphodel", 10 } }, "tut_crawler")
  eq(#b.allies, 4)
  local before = {}
  for i, m in ipairs(s.party) do before[i] = m.xp end
  b.foes[1].hp = 1
  openFor(s, rng, 1)
  cmd(s, rng, "attack")
  target(s, fixed(5), "foe", 1)
  local xp = enemies.FOES.crawler.xp
  for i = 1, 4 do eq(s.party[i].xp - before[i], xp) end
  for i = 5, 6 do eq(s.party[i].xp - before[i], math.floor(xp * party.BENCH_SHARE / 100)) end
end)

t("one person alone can fight, win and lose", function()
  local s = newState({ { "hero", 30 } })
  eq(fight(s, "mine_4", seeded.rng(3)), "won")
  s = newState({ { "hero", 1 } })
  s.party[1].hp = 1
  local result = fight(s, "boss_foreman", seeded.rng(3))
  eq(result, "lost")
end)

t("joining late brings the shop's gear, and the slice's join stays as it was", function()
  eq(party.new("jezzara", 28).weapon, (party.kit("jezzara", party.tierOf(28))))
  eq(party.new("deserter", 2).weapon, "scalpel")
  eq(party.new("owlin", 8).armour, "robe")
end)

--- A region's worth of fights: foes per fight at the going tier, and bosses at the end. Keeps the party on the spec's table.
local REGIONS = {
  { "heart", 6, 12, 34, 3 }, { "plexios", 12, 15, 30, 3 }, { "sindal", 15, 18, 30, 3 }, { "windmill", 18, 21, 16, 2 },
  { "empire", 21, 25, 30, 3 }, { "underdark", 25, 30, 36, 3 }, { "vault", 30, 32, 12, 2 }, { "ruin_south", 32, 36, 30, 3 },
  { "ruin_north", 36, 39, 30, 3 }, { "ruin_deep", 39, 42, 30, 3 }, { "finale", 42, 45, 20, 3 },
}

t("the XP curve keeps the party on the spec's table, about 45 at the end, with 50 left for Chylbad", function()
  local m = party.new("hero", 6)
  for _, r in ipairs(REGIONS) do
    for i = 0, r[4] - 1 do
      local tier = r[2] + (r[3] - r[2]) * i / r[4]
      party.gainXp(m, math.floor(enemies.numbers(tier, "quick").xp * 2.5))
    end
    party.gainXp(m, r[5] * enemies.numbers(r[3], "brute", true).xp)
    truthy(math.abs(m.lvl - r[3]) <= 1, r[1] .. " ends at " .. m.lvl .. ", the table says " .. r[3])
  end
  truthy(m.lvl < 50, "grinding is for Chylbad")
  -- from 45 to 50 is a real grind, not a few fights
  local fights = (party.xpFor(50) - party.xpFor(45)) / (enemies.numbers(48, "quick").xp * 2.5)
  truthy(fights >= 25, fights .. " fights")
end)

t("a region's gold buys the next tier's weapons and armour for four", function()
  local cases = { { 2, 9 }, { 3, 15 }, { 4, 22 }, { 5, 27 }, { 6, 36 }, { 7, 43 } }
  for _, case in ipairs(cases) do
    local tier, level = case[1], case[2]
    local gold = 30 * 2.5 * enemies.numbers(level, "quick").gold + 3 * enemies.numbers(level, "brute", true).gold
    local bill = 0
    for _, id in ipairs({ "hero", "deserter", "cleric", "owlin" }) do
      local weapon, armour = party.kit(id, tier)
      bill = bill + party.GEAR[weapon].price + party.GEAR[armour].price
    end
    truthy(gold >= bill * 0.8 and gold <= bill * 3, "tier " .. tier .. ": " .. gold .. " gold for " .. bill)
  end
end)

t("regions merge at the tail of each data module", function()
  local name = "games.blightmare.content"
  local realContent, realEnemies, realParty = package.loaded[name], package.loaded["games.blightmare.enemies"], package.loaded["games.blightmare.party"]
  package.loaded[name] = { regions = function()
    return { {
      foes = { t_merged = { name = "M", tier = 8, shape = "small", sprite = "rat", abilities = { { "t_ab", 1 } } } },
      abilities = { t_ab = { name = "A", power = 90 } },
      encounters = { t_enc = { foes = { "t_merged" }, flee = true, bg = "grass" } },
      field = { heart = { "t_enc" }, shaid = { "t_enc" } },
      items = { t_b = { name = "B", key = true }, t_a = { name = "A", key = true } },
    } }
  end }
  package.loaded["games.blightmare.enemies"], package.loaded["games.blightmare.party"] = nil, nil
  local e, p = require("games.blightmare.enemies"), require("games.blightmare.party")
  package.loaded[name], package.loaded["games.blightmare.enemies"], package.loaded["games.blightmare.party"] = realContent, realEnemies, realParty
  truthy(e.FOES.t_merged.hp > 0, "the foe has its numbers")
  truthy(e.ABILITIES.t_ab, "the ability")
  truthy(e.ENCOUNTERS.t_enc, "the encounter")
  eq(e.FIELD.heart[#e.FIELD.heart], "t_enc")
  eq(e.FIELD.heart[1], "field_heart_1")
  eq(e.FIELD.shaid[1], "t_enc")
  eq(p.ITEMS.t_a.price, 0)
  eq(p.ITEM_ORDER[#p.ITEM_ORDER - 1], "t_a")
  eq(p.ITEM_ORDER[#p.ITEM_ORDER], "t_b")
end)

-- ---------------------------------------------------------------- the screen, for the whole game

t("an unknown sprite or ground draws a stand-in, and never stops a fight", function()
  testFoe("t_undrawn", { name = "U", tier = 5, shape = "brute", sprite = "nobody_drew_this", abilities = { { "bite", 1 } } })
  local s = quiet(nil, "t_undrawn")
  s.battle.bg = "ash"
  drawEvery(s)
  testFoe("t_nosprite", { name = "U", tier = 5, shape = "brute", abilities = { { "bite", 1 } } })
  s = quiet(nil, "t_nosprite")
  drawEvery(s)
end)

t("a huge boss, a big pair, and a boss with helpers all fit beside four allies", function()
  local function setup(foes, added)
    local b = { foes = {}, allies = { {}, {}, {}, {} }, boss = true }
    for i, id in ipairs(foes) do b.foes[i] = { id = id, added = added and added[i] or nil } end
    return b
  end
  testBoss("t_huge", 40, { size = 3 })
  testBoss("t_big", 40, { size = 2 })
  checkField(setup({ "t_huge" }), "huge")
  checkField(setup({ "t_huge", "miner", "miner" }, { false, true, true }), "huge with helpers")
  checkField(setup({ "t_big", "t_big" }), "pair")
  checkField(setup({ "t_big", "t_big", "miner", "miner" }, { false, false, true, true }), "pair with helpers")
  checkField(setup({ "foreman", "miner", "miner" }, { false, true, true }), "the Foreman with helpers")
  truthy(view.foeRect(setup({ "t_huge" }), 1).w > view.foeRect(setup({ "t_big" }), 1).w, "huge is bigger than big")
  -- a group of equals falls back to plain places
  testBoss("t_equal", 20, {})
  checkField(setup({ "t_equal", "t_equal", "t_equal", "t_equal" }), "four bosses")
  local b = setup({ "t_equal", "t_equal", "t_equal", "t_equal" })
  eq(view.foeRect(b, 1).w, 30)
end)

t("the status strip keeps a long fight readable: four allies with HP at 999", function()
  local s, _, b = quiet({ { "hero", 50 }, { "jezzara", 50 }, { "asphodel", 50 }, { "owlin", 50 } })
  b.allies[1].thrall, b.allies[1].blind, b.allies[1].doom, b.allies[1].poison = 1, 1, 1, 1
  drawEvery(s)
end)

-- ---------------------------------------------------------------- the bot, for the whole game

local function ask(s, rng)
  return battle.bot(s, rng)
end

t("the bot raises with the best it has, spell or item", function()
  local s, rng = quiet({ { "cleric", 30 }, { "hero", 30 } })
  s.party[2].hp = 0
  openFor(s, rng, 1)
  eq(ask(s, rng).cmd, "special")
  cmd(s, rng, "special")
  local a = ask(s, rng)
  local guard = 0
  while battle.rows(s)[a.i].id == "more" and guard < 6 do
    send(s, rng, a)
    a = ask(s, rng)
    guard = guard + 1
  end
  eq(battle.rows(s)[a.i].id, "ravenwing")

  s, rng = quiet({ { "hero", 30 }, { "owlin", 30 } }, nil, { feather = 1, tonic = 1 })
  s.party[2].hp = 0
  openFor(s, rng, 1)
  eq(ask(s, rng).cmd, "item")
  cmd(s, rng, "item")
  a = ask(s, rng)
  eq(battle.rows(s)[a.i].id, "feather")
end)

t("the bot cures a thrall by spell or by item", function()
  local s, rng, b = quiet({ { "cleric", 30 }, { "hero", 30 } })
  b.allies[2].thrall = 4
  openFor(s, rng, 1)
  local a = ask(s, rng)
  eq(a.cmd, "special")
  cmd(s, rng, "special")
  a = ask(s, rng)
  local guard = 0
  while battle.rows(s)[a.i].id == "more" and guard < 6 do
    send(s, rng, a)
    a = ask(s, rng)
    guard = guard + 1
  end
  eq(battle.rows(s)[a.i].id, "absolve")

  s, rng, b = quiet({ { "hero", 30 }, { "jezzara", 30 } }, nil, { wakeroot = 1 })
  b.allies[2].tadpole = 4
  openFor(s, rng, 1)
  eq(ask(s, rng).cmd, "item")
end)

t("the bot uses a weakness", function()
  testFoe("t_icy", { name = "I", tier = 20, shape = "tank", sprite = "rat", abilities = { { "bite", 1 } }, weak = { "fire" }, resist = { "ice", "bolt" } })
  local s, rng = quiet({ { "owlin", 20 } }, "t_icy")
  openFor(s, rng, 1)
  cmd(s, rng, "special")
  local a = ask(s, rng)
  local guard = 0
  while battle.rows(s)[a.i].id == "more" and guard < 6 do
    send(s, rng, a)
    a = ask(s, rng)
    guard = guard + 1
  end
  eq(party.SPELLS[battle.rows(s)[a.i].id].element, "fire")
end)

t("a bot that sees nothing to cast never loops: silenced casters still act", function()
  local s, rng, b = quiet({ { "owlin", 30 }, { "cleric", 30 } }, "mine_4")
  b.allies[1].silence, b.allies[2].silence = 500, 500
  eq(fight(s, "mine_4", rng) ~= nil, true)
end)

-- ---------------------------------------------------------------- the balance of the whole game

local TIER_BAGS = {
  [5] = { potion = 5, ether = 2, tonic = 2, antidote = 2 },
  [10] = { potion = 8, ether = 3, tonic = 3, antidote = 2, eyewash = 1, echoherb = 1 },
  [20] = { hipotion = 6, ether = 5, tonic = 3, wakeroot = 2, eyewash = 2, echoherb = 2 },
  [30] = { hipotion = 8, hiether = 3, feather = 3, wakeroot = 3, eyewash = 2, echoherb = 2, panacea = 1 },
  [40] = { xpotion = 6, hiether = 4, feather = 4, wakeroot = 3, panacea = 2 },
}

--- A standard party at a level, in that tier's gear.
local function standardParty(ids, lvl)
  local s = { rev = 0, score = 0, level = lvl, gold = 5000, party = {}, bag = {}, mode = "walk" }
  for k, v in pairs(TIER_BAGS[lvl]) do s.bag[k] = v end
  for i, id in ipairs(ids) do
    local m = party.new(id, lvl)
    m.weapon, m.armour = party.kit(id, party.tierOf(lvl))
    party.restore(m)
    s.party[i] = m
  end
  return s
end

--- Foes of each shape at a tier, a spread of field fights, a boss built from the format as a region would, and a pair.
local function buildTier(T)
  local function n(shape) return "sim" .. T .. shape end
  local function add(shape, abilities, extra)
    local def = { name = "SIM", tier = T, shape = shape, sprite = "rat", abilities = abilities }
    for k, v in pairs(extra or {}) do def[k] = v end
    enemies.addFoe(n(shape), def)
  end
  add("small", { { "bite", 3 }, { "spit", 1 } })
  add("quick", { { "claw", 3 }, { "lunge", 1 } }, { weak = { "ice" } })
  add("brute", { { "swing", 4 }, { "blind_dust", 1 } }, { weak = { "fire" } })
  add("tank", { { "baton", 4 }, { "needle", 1 } }, { resist = { "fire" }, weak = { "bolt" } })
  add("caster", { { "scorch", 3 }, { "mind_wave", 1 }, { "hush_word", 1 } }, { weak = { "holy" } })
  add("healer", { { "baton", 3 }, { "field_surgery", 2 } }, { weak = { "mind" } })
  local abilities = enemies.ABILITIES
  abilities.simbig = { name = "BIG", power = 210, magic = true, target = "all", windup = 34, warn = "IT GATHERS" }
  abilities.simhit = { name = "HIT", power = 100 }
  abilities.simaoe = { name = "AOE", power = 45, target = "all", status = "poison", chance = 50 }
  abilities.simmag = { name = "MAG", mp = 5, power = 70, magic = true, target = "all", element = "mind" }
  abilities["simhex" .. T] = { name = "HEX", mp = 5, power = 45, magic = true, status = T >= 20 and "tadpole" or "blind", chance = 60 }
  local hex = "simhex" .. T
  enemies.addFoe(n("boss"), { name = "SIMBOSS", tier = T, shape = "brute", sprite = "foreman", weak = { "holy" }, boss = { hpx = 1, phases = {
    { at = 100, moves = { { "simhit", 5 }, { "simaoe", 2 } }, every = 5, big = "simbig" },
    { at = 66, moves = { { "simhit", 5 }, { "simaoe", 2 }, { hex, 3 } }, every = 4, big = "simbig", say = "X", speedUp = 1, summon = n("brute") },
    { at = 33, moves = { { "simhit", 6 }, { "simmag", 2 }, { hex, 2 } }, every = 3, big = "simbig", say = "Y", speedUp = 1, summon = n("brute") },
  } } })
  enemies.addFoe(n("twin"), { name = "SIMTWIN", tier = T, shape = "brute", sprite = "foreman", size = 1, atkx = 0.7, boss = { hpx = 0.45, phases = {
    { at = 100, moves = { { "simhit", 5 }, { "simaoe", 2 } }, every = 5, big = "simbig" },
    { at = 50, moves = { { "simhit", 5 }, { hex, 3 } }, every = 4, big = "simbig", speedUp = 1 },
  } } })
  local out = {}
  local field = {
    { n("small"), n("small"), n("small") }, { n("quick"), n("brute") }, { n("caster"), n("healer"), n("brute") },
    { n("tank"), n("quick"), n("small") }, { n("brute"), n("brute") }, { n("caster"), n("caster"), n("quick") },
  }
  for i, foes in ipairs(field) do
    out[i] = "sim" .. T .. "f" .. i
    enemies.ENCOUNTERS[out[i]] = { foes = foes, flee = true, bg = "grass" }
  end
  enemies.ENCOUNTERS["sim" .. T .. "boss"] = { foes = { n("boss") }, flee = false, bg = "mine", boss = true }
  enemies.ENCOUNTERS["sim" .. T .. "twin"] = { foes = { n("twin"), n("twin") }, flee = false, bg = "mine", boss = true }
  return out
end

local STANDARD = { "hero", "deserter", "cleric", "owlin" }

local function hpLost(s)
  local hp, top = 0, 0
  for _, m in ipairs(s.party) do hp, top = hp + m.hp, top + party.stats(m).hp end
  return 1 - hp / top
end

local function winRate(enc, ids, T, runs)
  local wins = 0
  for seed = 1, runs do
    if fight(standardParty(ids, T), enc, seeded.rng(seed * 13)) == "won" then wins = wins + 1 end
    if seed % 5 == 0 then breathe() end
  end
  return wins * 100 / runs
end

for _, T in ipairs({ 5, 10, 20, 30, 40 }) do
  t("balance at tier " .. T .. ": a field fight is quick and cheap", function()
    for _, enc in ipairs(buildTier(T)) do
      local runs, won, longest, lost = 12, 0, 0, 0
      for seed = 1, runs do
        local s = standardParty(STANDARD, T)
        local result, ticks = fight(s, enc, seeded.rng(seed * 7))
        if result == "won" then won = won + 1 end
        longest = math.max(longest, ticks)
        lost = lost + hpLost(s)
      end
      eq(won, runs)
      truthy(longest * 0.12 <= 25, enc .. " took " .. longest * 0.12 .. "s")
      truthy(lost / runs <= 0.15, enc .. " cost " .. lost / runs)
      breathe()
    end
  end)

  t("balance at tier " .. T .. ": a boss built from the format is beaten about 85% of the time", function()
    buildTier(T)
    local rate = winRate("sim" .. T .. "boss", STANDARD, T, 40)
    truthy(rate >= 70 and rate <= 100, "boss won " .. rate)
    truthy(winRate("sim" .. T .. "twin", STANDARD, T, 16) >= 40, "a pair of bosses can be beaten")
  end)
end

t("balance: Jezzara and Asphodel pull their weight in place of the doctor", function()
  buildTier(40)
  truthy(winRate("sim40boss", { "hero", "jezzara", "cleric", "owlin" }, 40, 16) >= 70, "with Jezzara")
  truthy(winRate("sim40boss", { "hero", "asphodel", "cleric", "owlin" }, 40, 16) >= 70, "with Asphodel")
end)
