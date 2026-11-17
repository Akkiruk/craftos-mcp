-- BLIGHTMARE's maps and script: that they're well formed, and that the slice can be finished. This walks the data itself and
-- plays it through a small model of the engine, so it says what's wrong with the content, whatever the battle balance is.
-- The bot in blightmare_engine.test.lua plays the same slice through the real engine.
local kit = loadfile(fs.combine(fs.getDir(fs.getDir(shell.getRunningProgram())), "testkit.lua"), nil, _ENV)()
local seeded = require("lib.rng")
local maps = require("games.blightmare.maps")
local story = require("games.blightmare.story")
local enemies = require("games.blightmare.enemies")
local party = require("games.blightmare.party")
local overworld = require("games.blightmare.overworld")
local rules = require("games.blightmare.rules")
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

local MAP_IDS = { "scythebreak", "orrenshire", "mine_1", "mine_2", "mine_3" }
local TILES = { ["#"] = true, ["."] = true, ["+"] = true, L = true, [">"] = true, h = true, W = true }
local OPEN = { ["."] = true, ["+"] = true, [">"] = true }
local PORTRAITS = {}
for id in ("hero deserter cleric captain doctor mayor smith innkeeper child foreman gnome villager"):gmatch("%S+") do PORTRAITS[id] = true end
local ENCOUNTERS = {}
for id in ("tut_crawler wall_breach gate_orderlies field_heart_1 field_heart_2 field_heart_3 field_road_1 field_road_2 mine_1 mine_2 mine_3 mine_4 boss_foreman"):gmatch("%S+") do ENCOUNTERS[id] = true end
local FOE_SPRITES = {}
for id in ("rat harpy frogman stalker orderly doctor blighted miner crawler foreman"):gmatch("%S+") do FOE_SPRITES[id] = true end
local STEP_KEYS = {}
for key in ("say name text big choice when steps other set unset give n gold join lvl heal battle warp world shop inn save fade sfx all pic music mark dark"):gmatch("%S+") do STEP_KEYS[key] = true end

-- Everything art.lua can draw on a map, kept here so the test needn't set up a screen.
local NPC_SPRITES = {}
for id in ("hero villager child deserter cleric guard soldier captain doctor mayor gnome smith innkeeper foreman miner orderly blighted frogman harpy stalker crawler rat shroud"):gmatch("%S+") do NPC_SPRITES[id] = true end

local function breathe()
  os.queueEvent("blightmare_content")
  os.pullEvent("blightmare_content")
end

local function report(problems)
  eq(#problems, 0, table.concat(problems, "\n"))
end

local function tileAt(map, x, y)
  local row = map.rows[y]
  if not row or x < 1 or x > #row then return "#" end
  return row:sub(x, x)
end

--- Calls visit(step) for every step of a list, down through its branches.
local function walkSteps(list, visit)
  for _, step in ipairs(list) do
    visit(step)
    if step.steps then walkSteps(step.steps, visit) end
    if step.other then walkSteps(step.other, visit) end
    for _, option in ipairs(step.choice or {}) do walkSteps(option[2], visit) end
  end
end

-- This file is the slice. Each region has its own test, through tests/check_region.lua.
local REGION_SCRIPT = {}
for _, region in ipairs(require("games.blightmare.content").regions()) do
  for id in pairs(region.scripts or {}) do REGION_SCRIPT[id] = true end
end
local SLICE_GOALS = {}
for _, goal in ipairs(story.GOALS) do
  SLICE_GOALS[#SLICE_GOALS + 1] = goal
  if goal.done == "finished" then break end
end

-- The scenes the engine itself runs after a lost fight, checked on their own at the end of this file.
local ENGINE_SCRIPT = { fallen_first = true, fallen_1 = true, fallen_2 = true, fallen_3 = true, fallen_4 = true }

local function everyStep(visit)
  for id, list in pairs(story.SCRIPTS) do
    if not REGION_SCRIPT[id] and not ENGINE_SCRIPT[id] then walkSteps(list, function(step) visit(step, id) end) end
  end
end

--- Each thing on a map that carries a script, a place, or a flag.
local function everyThing(visit)
  for _, mapId in ipairs(MAP_IDS) do
    local map = maps.DATA[mapId]
    for _, kind in ipairs({ "npcs", "steps", "chests", "foes", "exits" }) do
      for _, thing in ipairs(map[kind] or {}) do visit(mapId, kind, thing) end
    end
  end
end

-- ---------------------------------------------------------------- the maps

t("every map exists, 15 to 25 squares a side, with equal rows of known tiles, enclosed", function()
  local problems = {}
  for _, id in ipairs(MAP_IDS) do
    local map = maps.DATA[id]
    truthy(map, id .. " exists")
    truthy(map.name and map.theme, id .. " has a name and a theme")
    local h, w = #map.rows, #map.rows[1]
    if h < 15 or h > 25 or w < 15 or w > 25 then problems[#problems + 1] = id .. " is " .. w .. "x" .. h end
    for y, row in ipairs(map.rows) do
      if #row ~= w then problems[#problems + 1] = id .. " row " .. y .. " is " .. #row .. " not " .. w end
      for x = 1, #row do
        local c = row:sub(x, x)
        if not TILES[c] then problems[#problems + 1] = id .. " has a strange tile " .. c end
        local edge = x == 1 or y == 1 or x == w or y == h
        if edge and OPEN[c] then problems[#problems + 1] = id .. " is open at " .. x .. "," .. y end
      end
    end
  end
  report(problems)
end)

t("Scythebreak shows the wall, and the mines look like mines", function()
  local found = 0
  for _, row in ipairs(maps.DATA.scythebreak.rows) do
    if row:find("W", 1, true) then found = found + 1 end
  end
  truthy(found >= 10, "the wall runs the length of the town")
  eq(maps.DATA.mine_1.theme, "mine")
  eq(maps.DATA.scythebreak.theme, "town")
  eq(maps.DATA.orrenshire.savepoint, true)
end)

t("everything stands on a legal square", function()
  local problems = {}
  local taken = {}
  everyThing(function(mapId, kind, thing)
    local c = tileAt(maps.DATA[mapId], thing.x, thing.y)
    local legal = c == "." or (kind == "exits" and c == ">")
    if not legal then problems[#problems + 1] = mapId .. " " .. kind .. " " .. (thing.id or "") .. " at " .. thing.x .. "," .. thing.y .. " is on " .. c end
    if kind == "chests" or kind == "foes" or ((kind == "npcs") and not thing.when and not thing.unless) then
      local key = mapId .. ":" .. thing.x .. "," .. thing.y
      if taken[key] then problems[#problems + 1] = key .. " holds two things" end
      taken[key] = true
    end
  end)
  report(problems)
end)

t("every sprite, script and encounter a map names exists", function()
  local problems = {}
  everyThing(function(mapId, kind, thing)
    local where = mapId .. " " .. kind .. " " .. (thing.id or (thing.x .. "," .. thing.y))
    if thing.script and not story.SCRIPTS[thing.script] then problems[#problems + 1] = where .. " wants script " .. thing.script end
    if kind == "npcs" and not NPC_SPRITES[thing.sprite] then problems[#problems + 1] = where .. " wants sprite " .. tostring(thing.sprite) end
    if kind == "foes" then
      if not FOE_SPRITES[thing.sprite] then problems[#problems + 1] = where .. " wants foe sprite " .. tostring(thing.sprite) end
      if not ENCOUNTERS[thing.enc] or not enemies.ENCOUNTERS[thing.enc] then problems[#problems + 1] = where .. " wants encounter " .. tostring(thing.enc) end
    end
    if kind == "chests" and thing.give and not (party.ITEMS[thing.give] or party.GEAR[thing.give]) then
      problems[#problems + 1] = where .. " gives " .. thing.give
    end
  end)
  report(problems)
end)

--- Squares the player can stand on, from a way in, with always-there people and chests in the way. People who come and go
-- are left out here: when they're there is what the play-through below is for.
local function flood(map, x, y)
  local solid = {}
  for _, npc in ipairs(map.npcs or {}) do
    if not npc.when and not npc.unless then solid[npc.y * 100 + npc.x] = true end
  end
  for _, chest in ipairs(map.chests or {}) do solid[chest.y * 100 + chest.x] = true end
  local seen, todo = { [y * 100 + x] = true }, { { x, y } }
  while #todo > 0 do
    local at = table.remove(todo)
    for _, d in ipairs({ { 0, -1 }, { 1, 0 }, { 0, 1 }, { -1, 0 } }) do
      local nx, ny = at[1] + d[1], at[2] + d[2]
      local key = ny * 100 + nx
      if not seen[key] and OPEN[tileAt(map, nx, ny)] and not solid[key] then
        seen[key] = true
        todo[#todo + 1] = { nx, ny }
      end
    end
  end
  return seen
end

--- Each map's way in: a site on the overworld, or the far end of an exit.
local function entrance(id)
  for _, site in ipairs(overworld.SITES) do
    if site.map == id then return site.mx, site.my end
  end
  for _, mapId in ipairs(MAP_IDS) do
    for _, e in ipairs(maps.DATA[mapId].exits or {}) do
      if e.map == id then return e.mx, e.my end
    end
  end
  return nil
end

t("everything on a map can be reached from its way in", function()
  local problems = {}
  local seen = {}
  for _, id in ipairs(MAP_IDS) do
    local x, y = entrance(id)
    truthy(x, id .. " has a way in")
    seen[id] = flood(maps.DATA[id], x, y)
  end
  everyThing(function(mapId, kind, thing)
    local reach = seen[mapId]
    local x, y = thing.x, thing.y
    local near = reach[y * 100 + x] or reach[(y - 1) * 100 + x] or reach[(y + 1) * 100 + x] or reach[y * 100 + x - 1] or reach[y * 100 + x + 1]
    if not near then problems[#problems + 1] = mapId .. " " .. kind .. " " .. (thing.id or "") .. " at " .. x .. "," .. y .. " can't be reached" end
  end)
  for _, id in ipairs(MAP_IDS) do
    local map = maps.DATA[id]
    for y, row in ipairs(map.rows) do
      for x = 1, #row do
        local solidThing = false
        for _, list in ipairs({ map.npcs or {}, map.chests or {} }) do
          for _, thing in ipairs(list) do
            if thing.x == x and thing.y == y then solidThing = true end
          end
        end
        if row:sub(x, x) == "." and not solidThing and not seen[id][y * 100 + x] then
          problems[#problems + 1] = id .. " has a dead floor at " .. x .. "," .. y
        end
      end
    end
  end
  report(problems)
end)

t("every exit and site lands on floor, and stairs go somewhere", function()
  local problems = {}
  local sites = {}
  for _, site in ipairs(overworld.SITES) do
    sites[site.x .. "," .. site.y] = true
    local c = maps.DATA[site.map] and tileAt(maps.DATA[site.map], site.mx, site.my) or "."
    if c ~= "." then problems[#problems + 1] = "site " .. site.id .. " lands on " .. c end
  end
  for _, id in ipairs(MAP_IDS) do
    local map = maps.DATA[id]
    local stairs = {}
    for y, row in ipairs(map.rows) do
      for x = 1, #row do
        if row:sub(x, x) == ">" then stairs[x .. "," .. y] = true end
      end
    end
    for _, e in ipairs(map.exits or {}) do
      stairs[e.x .. "," .. e.y] = nil
      if e.world then
        if not sites[e.world[1] .. "," .. e.world[2]] then problems[#problems + 1] = id .. " exit lands off every site" end
      else
        local c = tileAt(maps.DATA[e.map], e.mx, e.my)
        if c ~= "." then problems[#problems + 1] = id .. " exit lands on " .. c end
      end
    end
    for at in pairs(stairs) do problems[#problems + 1] = id .. " stairs at " .. at .. " lead nowhere" end
  end
  report(problems)
end)

t("the mines have what the slice promises", function()
  local chests, foes = 0, 0
  for _, id in ipairs({ "mine_1", "mine_2", "mine_3" }) do
    local map = maps.DATA[id]
    truthy(#map.chests >= 3 and #map.foes >= 4, id .. " has chests and foes")
    chests, foes = chests + #map.chests, foes + #map.foes
  end
  truthy(foes >= 12, "enough fights to reach about level 5")
  truthy(chests >= 9, "enough to find")
  local bossAt = {}
  for _, npc in ipairs(maps.DATA.mine_3.npcs) do bossAt[npc.id] = true end
  truthy(bossAt.foreman and bossAt.nob, "the Foreman and the bottom of the lift")
end)

-- ---------------------------------------------------------------- the script

t("every script step is one the engine knows, pointing at something real", function()
  local problems = {}
  local sites = {}
  for _, site in ipairs(overworld.SITES) do sites[site.x .. "," .. site.y] = true end
  everyStep(function(step, id)
    for key in pairs(step) do
      if not STEP_KEYS[key] then problems[#problems + 1] = id .. " has a step with " .. tostring(key) end
    end
    if step.say and not PORTRAITS[step.say] then problems[#problems + 1] = id .. " speaks as " .. step.say end
    if step.battle and (not ENCOUNTERS[step.battle] or not enemies.ENCOUNTERS[step.battle]) then problems[#problems + 1] = id .. " fights " .. step.battle end
    if step.give and not (party.ITEMS[step.give] or party.GEAR[step.give]) then problems[#problems + 1] = id .. " gives " .. step.give end
    if step.join and not party.CHARS[step.join] then problems[#problems + 1] = id .. " joins " .. step.join end
    if step.shop and not story.SHOPS[step.shop] then problems[#problems + 1] = id .. " opens shop " .. step.shop end
    if step.warp then
      local map = maps.DATA[step.warp[1]]
      if not map or tileAt(map, step.warp[2], step.warp[3]) ~= "." then problems[#problems + 1] = id .. " warps to a bad square" end
    end
    if step.world and not sites[step.world[1] .. "," .. step.world[2]] then problems[#problems + 1] = id .. " lands off every site" end
    if step.choice then
      for _, option in ipairs(step.choice) do
        if type(option[1]) ~= "string" or type(option[2]) ~= "table" then problems[#problems + 1] = id .. " has a bad choice" end
      end
    end
  end)
  report(problems)
end)

t("the start script and the overworld's gates exist, and every script is used", function()
  truthy(story.SCRIPTS[story.START], "START")
  local used = { [story.START] = true }
  everyThing(function(_, _, thing)
    if thing.script then used[thing.script] = true end
  end)
  for _, gate in ipairs(overworld.GATES) do
    truthy(story.SCRIPTS[gate.script], "gate script " .. gate.script)
    used[gate.script] = true
  end
  local problems = {}
  for id in pairs(story.SCRIPTS) do
    if not used[id] and not REGION_SCRIPT[id] and not ENGINE_SCRIPT[id] and not id:find("^gate_") then problems[#problems + 1] = id .. " is never used" end
  end
  report(problems)
end)

t("every shop sells real things at a sensible price, and the inn's rate fits", function()
  local problems = {}
  for id, shop in pairs(story.SHOPS) do
    for _, ware in ipairs(shop) do
      local def = party.ITEMS[ware.item] or party.GEAR[ware.item]
      if not def then
        problems[#problems + 1] = id .. " sells " .. tostring(ware.item)
      elseif ware.price < def.price * 0.75 or ware.price > def.price * 1.25 then
        problems[#problems + 1] = id .. " sells " .. ware.item .. " at " .. ware.price .. ", party.lua says " .. tostring(def.price)
      end
    end
  end
  report(problems)
  truthy(story.SHOPS.orrenshire and story.SHOPS.orrenshire_goods, "the smith and the stores")
end)

--- Every string the wall will show, with where it came from.
local function everyString(visit)
  everyStep(function(step, id)
    if step.text then visit(step.text, id, "text") end
    if step.big then visit(step.big, id, "big") end
    if step.name then visit(step.name, id, "name") end
    for _, option in ipairs(step.choice or {}) do visit(option[1], id, "choice") end
  end)
  for _, id in ipairs(MAP_IDS) do visit(maps.DATA[id].name, id, "map name") end
end

t("every line is plain ASCII, short enough, and fills in only {hero}", function()
  local problems = {}
  everyString(function(text, id, kind)
    if text:find("[^\32-\126]") then problems[#problems + 1] = id .. " isn't plain ASCII: " .. text end
    local rest = text:gsub("{hero}", "")
    if rest:find("[{}]") then problems[#problems + 1] = id .. " has a stray brace: " .. text end
    if text:lower():find("deserter", 1, true) then problems[#problems + 1] = id .. " says deserter out loud: " .. text end
    if kind == "choice" and #text > 70 then problems[#problems + 1] = id .. " has a long option: " .. text end
    if kind == "big" and #text > 36 then problems[#problems + 1] = id .. " is too big: " .. text end
  end)
  report(problems)
end)

--- How many talk-box pages a line takes.
local function pagesOf(step)
  local width = step.say and rules.SAY_WIDE or rules.NARRATE_WIDE
  return math.ceil(#rules.wrap(step.text, width) / rules.TEXT_LINES)
end

t("nobody talks for more than two pages, and a question fits on one", function()
  local problems = {}
  everyStep(function(step, id)
    if step.text then
      local pages = pagesOf(step)
      if pages > 2 then problems[#problems + 1] = id .. " runs to " .. pages .. " pages: " .. step.text end
      if step.choice and pages > 1 then problems[#problems + 1] = id .. " has a question of " .. pages .. " pages: " .. step.text end
    end
  end)
  report(problems)
end)

--- Does this branch, or anything under it, do what can't safely be done over and over?
local function repeatable(list)
  local safe = true
  walkSteps(list, function(step)
    if step.give or step.gold or step.battle or step.warp or step.world or step.fin or step.join or step.shop or step.fade then safe = false end
  end)
  return safe
end

t("every list has a question, a way out, and at most 5 rows, and a topic can't be farmed", function()
  local problems = {}
  everyStep(function(step, id)
    if step.choice then
      local ways, topics = 0, 0
      for _, option in ipairs(step.choice) do
        if option.again then
          topics = topics + 1
          if not repeatable(option[2]) then problems[#problems + 1] = id .. ": topic '" .. option[1] .. "' can be repeated for gain" end
        else
          ways = ways + 1
        end
      end
      if #step.choice > 5 then problems[#problems + 1] = id .. " has " .. #step.choice .. " rows" end
      if #step.choice < 2 then problems[#problems + 1] = id .. " has a choice of one" end
      if ways == 0 then problems[#problems + 1] = id .. " has a list with no way out" end
      if topics > 0 and not step.text then problems[#problems + 1] = id .. " has a list with nobody asking" end
    end
  end)
  report(problems)
end)

t("there are plenty of choices, and every named person and key scene has one", function()
  local choices = 0
  everyStep(function(step)
    if step.choice then choices = choices + 1 end
  end)
  print("choices: " .. choices)
  truthy(choices >= 35, "only " .. choices .. " choices")
  local problems = {}
  local function hasChoice(id)
    local found = false
    walkSteps(story.SCRIPTS[id], function(step) found = found or step.choice ~= nil end)
    return found
  end
  everyThing(function(mapId, kind, thing)
    if kind == "npcs" and thing.sprite ~= "shroud" and not hasChoice(thing.script) then
      problems[#problems + 1] = mapId .. " " .. thing.id .. " (" .. thing.script .. ") offers no choice"
    end
  end)
  for _, id in ipairs({ "scene_wick", "scene_test", "scene_gate", "scene_orrenshire", "scene_cleric", "scene_gas", "scene_valve", "scene_deep_shift", "scene_foreman" }) do
    if not hasChoice(id) then problems[#problems + 1] = id .. " offers no choice" end
  end
  report(problems)
end)

t("every person on a map has their own id, for the artist", function()
  local problems, seen = {}, {}
  everyThing(function(mapId, kind, thing)
    if kind == "npcs" then
      if not thing.id or seen[thing.id] then problems[#problems + 1] = mapId .. " repeats npc id " .. tostring(thing.id) end
      seen[thing.id] = true
    end
  end)
  report(problems)
end)

--- How many people stand on a map with these flags set.
local function headcount(mapId, flags)
  local st, n = { flags = {} }, 0
  for _, flag in ipairs(flags) do st.flags[flag] = true end
  for _, npc in ipairs(maps.DATA[mapId].npcs) do
    if (not npc.when or st.flags[npc.when]) and (not npc.unless or not st.flags[npc.unless]) then n = n + 1 end
  end
  return n
end

t("the towns are never crowded", function()
  local phases = {
    { "scythebreak", 10, {} },
    { "scythebreak", 10, { "signed", "bread_done", "horn", "breach" } },
    { "scythebreak", 10, { "signed", "bread_done", "horn", "breach", "wick_down", "lockdown" } },
    { "scythebreak", 10, { "signed", "bread_done", "horn", "breach", "wick_down", "lockdown", "tested", "escaped" } },
    { "orrenshire", 12, {} },
    { "orrenshire", 12, { "freed_dunnock" } },
    { "orrenshire", 12, { "freed_dunnock", "foreman_down", "finished" } },
  }
  local seen = {}
  for _, phase in ipairs(phases) do
    local n = headcount(phase[1], phase[3])
    seen[#seen + 1] = phase[1] .. " " .. n
    truthy(n <= phase[2], phase[1] .. " holds " .. n .. " with " .. table.concat(phase[3], ","))
  end
  print(table.concat(seen, ", "))
end)

--- Every flag any script can set.
local function flagsSet()
  local set = {}
  everyStep(function(step)
    if step.set then set[step.set] = true end
  end)
  return set
end

t("the story guide runs the whole slice, on squares and sites that exist", function()
  local problems = {}
  local set = flagsSet()
  local sites = {}
  for _, site in ipairs(overworld.SITES) do sites[site.id] = true end
  truthy(#SLICE_GOALS >= 10, "a goal for each part of the slice")
  for i, goal in ipairs(SLICE_GOALS) do
    local where = "goal " .. i .. " (" .. tostring(goal.text) .. ")"
    if not set[goal.done] then problems[#problems + 1] = where .. ": nothing sets " .. tostring(goal.done) end
    if goal.when and not set[goal.when] then problems[#problems + 1] = where .. ": nothing sets " .. goal.when end
    if type(goal.text) ~= "string" or #goal.text >= 30 or goal.text:find("[^\32-\126]") then problems[#problems + 1] = where .. ": bad text" end
    if goal.site then
      if not sites[goal.site] then problems[#problems + 1] = where .. ": no site " .. goal.site end
    else
      local map = maps.DATA[goal.map]
      if not map then
        problems[#problems + 1] = where .. ": no map " .. tostring(goal.map)
      elseif tileAt(map, goal.x, goal.y) ~= "." then
        problems[#problems + 1] = where .. " is on a wall"
      end
    end
  end
  eq(SLICE_GOALS[#SLICE_GOALS].done, "finished", "the last goal is the end")
  report(problems)
end)

--- The first goal not yet done, skipping any not yet in play.
local function currentGoal(flags)
  for i, goal in ipairs(SLICE_GOALS) do
    if not flags[goal.done] and (not goal.when or flags[goal.when]) then return i end
  end
  return nil
end

t("the script is 9,000 to 16,000 words", function()
  local words = 0
  everyString(function(text, _, kind)
    if kind == "text" or kind == "big" or kind == "choice" then
      for _ in text:gmatch("%S+") do words = words + 1 end
    end
  end)
  print("script words: " .. words)
  truthy(words >= 9000 and words <= 16000, "the script is " .. words .. " words")
end)

t("the hero mostly speaks through choices, and the three unnamed keep no names", function()
  local lines = 0
  everyStep(function(step)
    if step.say == "hero" then lines = lines + 1 end
    if step.name and (step.say == "deserter" or step.say == "cleric" or step.say == "hero") then
      error("a party member's label comes from party.CHARS")
    end
  end)
  truthy(lines >= 3 and lines <= 12, "the hero has " .. lines .. " lines")
end)

t("every flag read is set somewhere, and every flag set is read", function()
  local set, read = {}, {}
  everyStep(function(step)
    if step.set then set[step.set] = true end
    if step.when then read[step.when] = true end
  end)
  everyThing(function(_, _, thing)
    if thing.when then read[thing.when] = true end
    if thing.unless then read[thing.unless] = true end
  end)
  for _, goal in ipairs(SLICE_GOALS) do read[goal.done] = true end
  local problems = {}
  for flag in pairs(read) do
    if not set[flag] and flag ~= "wm_done" then problems[#problems + 1] = "nothing sets " .. flag end
  end
  for flag in pairs(set) do
    if not read[flag] then problems[#problems + 1] = "nothing reads " .. flag end
  end
  report(problems)
end)

-- ---------------------------------------------------------------- playing it

-- A small model of rules.lua: no fights, no gold, just where the player is and what's true. Every battle is either won or,
-- when wipe says so, a loss back to the save point, which is how a softlock would usually get in.

local function passes(st, thing)
  if thing.when and not st.flags[thing.when] then return false end
  if thing.unless and st.flags[thing.unless] then return false end
  return true
end

local function enter(st, id, x, y)
  st.map, st.x, st.y, st.world = id, x, y, false
  if maps.DATA[id].savepoint then st.save = { id, x, y } end
end

--- The first option that doesn't come back, which is the one the real bot takes.
local function firstWayOut(choice)
  for i, option in ipairs(choice) do
    if not option.again then return i end
  end
  return 1
end

local function runList(st, list, ctx)
  for _, step in ipairs(list) do
    if step.when and (step.steps or step.other) then
      local branch = st.flags[step.when] and step.steps or (not st.flags[step.when] and step.other)
      if branch and not runList(st, branch, ctx) then return false end
    elseif step.choice then
      -- a topic comes back to the list, so a picker that likes topics is cut off after a few and sent to the way out
      local rounds = 0
      repeat
        rounds = rounds + 1
        local option = step.choice[rounds > 6 and firstWayOut(step.choice) or ctx.pick(step.choice)]
        if not runList(st, option[2], ctx) then return false end
      until not option.again
    elseif step.set then
      st.flags[step.set] = true
    elseif step.unset then
      st.flags[step.unset] = nil
    elseif step.warp then
      enter(st, step.warp[1], step.warp[2], step.warp[3])
      ctx.arrived = true
    elseif step.world then
      st.world, ctx.arrived = true, false
    elseif step.save then
      if not st.world then st.save = { st.map, st.x, st.y } end
    elseif step.join then
      st.party[step.join] = true
    elseif step.battle and ctx.wipe() then
      enter(st, st.save[1], st.save[2], st.save[3])
      return false
    end
  end
  return true
end

local checkStep

local function runScript(st, id, ctx, onceKey)
  local inner = { pick = ctx.pick, wipe = ctx.wipe }
  if not runList(st, story.SCRIPTS[id], inner) then return end
  if onceKey then st.once[onceKey] = true end
  if inner.arrived then checkStep(st, ctx) end
end

checkStep = function(st, ctx)
  if st.world then return false end
  for _, step in ipairs(maps.DATA[st.map].steps or {}) do
    if step.x == st.x and step.y == st.y and passes(st, step) then
      local key = st.map .. ":" .. step.x .. "," .. step.y
      if not (step.once and st.once[key]) then
        runScript(st, step.script, ctx, step.once and key or nil)
        return true
      end
    end
  end
  return false
end

local function copyState(st)
  local out = { map = st.map, x = st.x, y = st.y, world = st.world, flags = {}, once = {}, party = {}, save = st.save }
  for k, v in pairs(st.flags) do out.flags[k] = v end
  for k, v in pairs(st.once) do out.once[k] = v end
  for k, v in pairs(st.party) do out.party[k] = v end
  return out
end

local function flagsKey(st)
  local keys = {}
  for k in pairs(st.flags) do keys[#keys + 1] = k end
  table.sort(keys)
  return table.concat(keys, ",")
end

local function onceCount(st)
  local n = 0
  for _ in pairs(st.once) do n = n + 1 end
  return n
end

local function same(a, b)
  return a.map == b.map and a.x == b.x and a.y == b.y and a.world == b.world and flagsKey(a) == flagsKey(b)
    and onceCount(a) == onceCount(b)
end

local QUIET = { pick = firstWayOut, wipe = function() return false end }

--- What the player could do next, as a list of functions of ctx.
local function actions(st)
  local out = { who = {} } -- who: the person behind each action, if there is one
  if st.world then
    for _, site in ipairs(overworld.SITES) do
      local inSlice = false
      for _, id in ipairs(MAP_IDS) do inSlice = inSlice or id == site.map end
      if passes(st, site) and inSlice then
        out[#out + 1] = function(ctx)
          enter(st, site.map, site.mx, site.my)
          checkStep(st, ctx)
        end
      end
    end
    return out
  end
  local map = maps.DATA[st.map]
  local seen, todo, offered = { [st.y * 100 + st.x] = true }, { { st.x, st.y } }, {}
  local npcs, exits, chests = {}, {}, {}
  for _, thing in ipairs(map.npcs or {}) do
    if passes(st, thing) then npcs[thing.y * 100 + thing.x] = thing end
  end
  for _, thing in ipairs(map.exits or {}) do
    if passes(st, thing) then exits[thing.y * 100 + thing.x] = thing end
  end
  for _, thing in ipairs(map.chests or {}) do chests[thing.y * 100 + thing.x] = thing end
  while #todo > 0 do
    local at = table.remove(todo)
    for _, d in ipairs({ { 0, -1 }, { 1, 0 }, { 0, 1 }, { -1, 0 } }) do
      local x, y = at[1] + d[1], at[2] + d[2]
      local key = y * 100 + x
      local npc, exit, chest = npcs[key], exits[key], chests[key]
      if npc then
        if not offered[npc] then
          offered[npc] = true
          out[#out + 1] = function(ctx)
            st.x, st.y = at[1], at[2]
            runScript(st, npc.script, ctx)
          end
          out.who[#out] = npc
        end
      elseif exit then
        if not offered[exit] then
          offered[exit] = true
          out[#out + 1] = function(ctx)
            if exit.world then
              st.world = true
            else
              enter(st, exit.map, exit.mx, exit.my)
              checkStep(st, ctx)
            end
          end
        end
      elseif not seen[key] and OPEN[tileAt(map, x, y)] and not chest then
        seen[key] = true
        local trigger = false
        for _, thing in ipairs(map.steps or {}) do
          if thing.x == x and thing.y == y and passes(st, thing) then trigger = true end
        end
        local trial
        if trigger then
          trial = copyState(st)
          trial.x, trial.y = x, y
          local before = copyState(trial)
          checkStep(trial, QUIET)
          trigger = not same(before, trial)
        end
        if not trigger then
          todo[#todo + 1] = { x, y } -- no trigger here, or one that changes nothing
        else
          out[#out + 1] = function(ctx)
            st.x, st.y = x, y
            checkStep(st, ctx)
          end
        end
      end
    end
  end
  return out
end

local function newGame(ctx)
  local st = { map = "scythebreak", x = 3, y = 3, world = false, flags = {}, once = {}, party = {} }
  enter(st, "scythebreak", 3, 3)
  runScript(st, story.START, ctx or QUIET)
  return st
end

--- Depth first over states that differ, so nothing relies on luck. True if the end can be reached from here.
local function finishFrom(st, ctx)
  local seenStates, moves = {}, 0
  local function search(depth)
    if st.flags.finished then return true end
    if depth > 400 or moves > 20000 then return false end
    local key = st.map .. "|" .. tostring(st.world) .. "|" .. onceCount(st) .. "|" .. flagsKey(st)
    if seenStates[key] then return false end
    seenStates[key] = true
    local here = copyState(st)
    local count = #actions(st)
    for i = 1, count do
      local list = actions(st)
      if list[i] then list[i](ctx) end
      moves = moves + 1
      if moves % 100 == 0 then breathe() end
      if search(depth + 1) then return true end
      st.map, st.x, st.y, st.world, st.save = here.map, here.x, here.y, here.world, here.save
      st.flags, st.once, st.party = {}, {}, {}
      for k, v in pairs(here.flags) do st.flags[k] = v end
      for k, v in pairs(here.once) do st.once[k] = v end
      for k, v in pairs(here.party) do st.party[k] = v end
    end
    return false
  end
  return search(1)
end

t("the first way out of every scene carries the story to the end", function()
  local st = newGame()
  truthy(finishFrom(st, QUIET), "the end can be reached taking every first way out")
  truthy(st.party.deserter and st.party.cleric, "both joined on the way")
end)

t("the guide only ever moves forward, on every path, and ends at the end", function()
  for seed = 1, 12 do
    local rng = seeded.rng(seed + 100)
    local ctx = { pick = function(choice) return rng(#choice) end, wipe = function() return rng(100) <= 10 end }
    local st = newGame(ctx)
    local at = currentGoal(st.flags)
    eq(at, 1, "the guide starts at the first goal")
    for _ = 1, 3000 do
      local list = actions(st)
      list[rng(#list)](ctx)
      local now = currentGoal(st.flags)
      truthy(now == nil or now >= at, "the guide went back to '" .. SLICE_GOALS[now or 1].text .. "'")
      at = now or #SLICE_GOALS + 1
      if st.flags.finished then break end
    end
    if st.flags.finished then eq(currentGoal(st.flags), nil, "nothing left to do at the end") end
    breathe()
  end
  -- a goal done by a scene must be done on every branch of it: nothing here is left to a choice
  local checked = {}
  everyStep(function(step, id)
    for _, option in ipairs(step.choice or {}) do
      walkSteps(option[2], function(inner)
        for _, goal in ipairs(SLICE_GOALS) do
          if inner.set == goal.done then checked[#checked + 1] = id .. " sets " .. goal.done .. " only inside '" .. option[1] .. "'" end
        end
      end)
    end
  end)
  report(checked)
end)

t("after any random wandering with wipes the end can still be reached, and every answer can be given", function()
  local picked = {}
  local reachedFlags = {}
  for seed = 1, 16 do
    local rng = seeded.rng(seed)
    local function pick(choice)
      -- an option nobody has tried yet comes first, so every answer gets played in some run
      for i, option in ipairs(choice) do
        if not picked[option] then
          picked[option] = true
          return i
        end
      end
      return rng(#choice)
    end
    local wipeChance = seed % 3 == 0 and 30 or 5
    local ctx = { pick = pick, wipe = function() return rng(100) <= wipeChance end }
    local st = newGame(ctx)
    for move = 1, 40 + seed * 10 do
      local list = actions(st)
      truthy(#list > 0, "stuck on " .. st.map .. " at " .. st.x .. "," .. st.y .. " with " .. flagsKey(st))
      list[rng(#list)](ctx)
      if move % 25 == 0 then breathe() end
    end
    local calm = { pick = pick, wipe = function() return false end }
    truthy(st.flags.finished or finishFrom(st, calm), "seed " .. seed .. " can't finish from " .. st.map .. " with " .. flagsKey(st))
    for _ = 1, 30 do
      local list = actions(st)
      truthy(#list > 0, "stuck after the end")
      list[rng(#list)](ctx)
    end
    for k in pairs(st.flags) do reachedFlags[k] = true end
  end
  local problems = {}
  everyStep(function(step)
    if step.set and not reachedFlags[step.set] then problems[#problems + 1] = step.set .. " was never set in play" end
    for _, option in ipairs(step.choice or {}) do
      if not picked[option] then problems[#problems + 1] = "nobody could pick: " .. option[1] end
    end
  end)
  report(problems)
end)

t("the hero really does cross the gas alone, and only past it are the stairs", function()
  local map = maps.DATA.mine_2
  local blocked = {}
  for _, npc in ipairs(map.npcs) do
    if npc.id == "valve" then blocked = npc end
  end
  eq(blocked.unless, "gas_off", "the wheel is what stands in the way")
  local solid = {}
  for y, row in ipairs(map.rows) do solid[y] = row end
  local copy = { rows = {}, npcs = { { x = blocked.x, y = blocked.y } }, chests = {} }
  for y, row in ipairs(solid) do copy.rows[y] = row end
  local reach = flood(copy, 3, 2)
  truthy(not reach[2 * 100 + 19], "the stairs down can't be reached past the wheel")
  truthy(flood(map, 3, 2)[2 * 100 + 19], "and they can once the wheel is turned")
end)

t("the lift is a real shortcut, freed from the bottom", function()
  local st = newGame()
  st.flags.lift_free = true
  st.map, st.x, st.y = "mine_1", 16, 14
  runScript(st, "talk_nib", QUIET)
  eq(st.map, "mine_3", "down in one")
  local c = tileAt(maps.DATA.mine_3, st.x, st.y)
  eq(c, ".")
end)

t("what the Foreman carries gets read before the end, and Colette's scene comes last", function()
  local names = {}
  walkSteps(story.SCRIPTS.scene_foreman, function(step)
    if step.text and step.text:find("seal", 1, true) then names.seal = true end
    if step.battle then names.battle = step.battle end
  end)
  truthy(names.seal, "the seal")
  eq(names.battle, "boss_foreman")
  local finished = false
  walkSteps(story.SCRIPTS.talk_mayor, function(step) finished = finished or step.set == "finished" end)
  truthy(finished, "the Mayor's scene ends the slice")
end)

-- ---------------------------------------------------------------- the Raven Queen's scenes after a loss

t("the scenes after a loss use only steps they may, fill in only {hero} and {toll}, and every answer ends back on foot", function()
  local problems = {}
  local ok = { text = true, choice = true, when = true, steps = true, other = true, dark = true }
  for id in pairs(ENGINE_SCRIPT) do
    local list = story.SCRIPTS[id]
    if not list then
      problems[#problems + 1] = id .. " is missing"
    else
      walkSteps(list, function(step)
        for key in pairs(step) do
          if not ok[key] then problems[#problems + 1] = id .. " has a step with " .. tostring(key) end
        end
        local strings = { step.text }
        for _, option in ipairs(step.choice or {}) do strings[#strings + 1] = option[1] end
        for _, text in ipairs(strings) do
          if text:find("[^\32-\126]") then problems[#problems + 1] = id .. " isn't plain ASCII: " .. text end
          if text:gsub("{hero}", ""):gsub("{toll}", ""):find("[{}]") then problems[#problems + 1] = id .. " has a stray brace: " .. text end
        end
        if step.when and step.when ~= "toll_free" then problems[#problems + 1] = id .. " reads " .. step.when end
      end)
    end
  end
  report(problems)

  -- through the real engine, every answer of the first, both purses, each scene
  local runs = { { "fallen_first", 1, 50 }, { "fallen_first", 2, 0 }, { "fallen_first", 3, 50 }, { "fallen_first", 4, 0 } }
  for i = 1, 4 do runs[#runs + 1] = { "fallen_" .. i, 1, i % 2 == 0 and 0 or 70 } end
  for _, run in ipairs(runs) do
    local id, answer, toll = run[1], run[2], run[3]
    local rng = seeded.rng(3)
    local s = rules.new({ rng = rng, player = "Ada" })
    s.run, s.mode = nil, "walk"
    s.toll, s.flags.toll_free = toll, toll == 0 or nil
    truthy(rules.startScript(s, id), id)
    local said, picks = {}, 0
    for _ = 1, 40 do
      rules.tick(s, rng)
      if s.mode ~= "talk" then break end
      local talk = rules.talk(s)
      for _, line in ipairs(talk.lines or {}) do said[#said + 1] = line end
      if talk.choices then
        picks = picks + 1
        rules.input(s, { kind = "pick", i = picks == 1 and answer or #talk.choices })
      else
        rules.input(s, { kind = "tap" })
      end
    end
    local all = table.concat(said, " ")
    eq(s.mode, "walk", id .. " ends on foot")
    eq(s.dark, nil, id .. " ends in the light")
    truthy(not all:find("[{}]"), id .. " filled everything in: " .. all)
    if toll > 0 then truthy(all:find(toll .. " gold", 1, true), id .. " says the toll") else truthy(all:find("empty purse", 1, true), id .. " waves a broke party through") end
  end
end)
