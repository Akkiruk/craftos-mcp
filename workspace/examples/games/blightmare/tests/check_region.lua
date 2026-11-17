-- Checks one region of BLIGHTMARE: that its data is well formed, and that it can be finished from its entry state on every
-- path, through a small model of the engine, so it says what's wrong with the content whatever the battle balance is.
-- Each tests/region_<id>.test.lua is just: require("tests.check_region")("<id>")
local seeded = require("lib.rng")
local maps = require("games.blightmare.maps")
local story = require("games.blightmare.story")
local enemies = require("games.blightmare.enemies")
local party = require("games.blightmare.party")
local overworld = require("games.blightmare.overworld")
local rules = require("games.blightmare.rules")
local content = require("games.blightmare.content")

local TILES = { ["#"] = true, ["."] = true, ["+"] = true, L = true, [">"] = true, h = true, W = true, ["~"] = true }
local OPEN = { ["."] = true, ["+"] = true, ["L"] = true, [">"] = true }
local THEMES, GROUNDS, FIELDS, SHAPES, STEP_KEYS = {}, {}, {}, {}, {}
for id in ("town mine city marble swamp grass ruin cave web coral chain ash dream library"):gmatch("%S+") do THEMES[id] = true end
for id in ("grass town mine city marble swamp ruin cave web brine chain snow ash dream"):gmatch("%S+") do GROUNDS[id] = true end
for id in ("heart road heart_east verdant shaid ebrein thuluan owlundia ruin_south ruin_north ruin_west"):gmatch("%S+") do FIELDS[id] = true end
for id in ("small quick brute tank caster healer"):gmatch("%S+") do SHAPES[id] = true end
for key in ("say name text big choice when steps other set unset give take n gold join lvl heal battle warp world site shop inn save fade sfx leave solo unsolo has paid all count at dark ending"):gmatch("%S+") do STEP_KEYS[key] = true end

-- Flags that cross regions, by design.
local HANDOFF = {}
for id in ([[finished hr_done px_done sn_done wm_done wm_bargain em_done ud_done ruined rs_done rn_done rd_done
  px_token sn_token px_revolt_started side_frogs side_revolution side_barnabas side_lovers side_zalabarula side_chylbad
  hr_verdant_open can_travel fn_truth fn_lie cleared]]):gmatch("%S+") do HANDOFF[id] = true end

local function breathe()
  os.queueEvent("blightmare_check")
  os.pullEvent("blightmare_check")
end

local function tileAt(map, x, y)
  local row = map.rows[y]
  if not row or x < 1 or x > #row then return "#" end
  return row:sub(x, x)
end

local function walkSteps(list, visit)
  for _, step in ipairs(list) do
    visit(step)
    if step.steps then walkSteps(step.steps, visit) end
    if step.other then walkSteps(step.other, visit) end
    for _, option in ipairs(step.choice or {}) do walkSteps(option[2], visit) end
  end
end

local function findRegion(id)
  for _, region in ipairs(content.regions()) do
    if region.id == id then return region end
  end
  error("no region " .. id .. ": is regions/" .. id .. ".lua there and in content.ORDER?")
end

local function known(id)
  for _, region in ipairs(content.regions()) do
    if region.looks and region.looks[id] then return true end
  end
  return false
end

local CORE_FACES = {}
for id in ("hero deserter cleric owlin jezzara asphodel captain doctor mayor smith innkeeper child foreman gnome villager colette colette_changed fabian sindal barnabas ceiridwen lucilda vierrela halryna murgrum sevria qarhuul father"):gmatch("%S+") do CORE_FACES[id] = true end

return function(regionId)
  local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy
  local R = findRegion(regionId)

  local function report(problems) eq(#problems, 0, table.concat(problems, "\n")) end

  local function everyStep(visit)
    for id, list in pairs(R.scripts or {}) do
      walkSteps(list, function(step) visit(step, id) end)
    end
  end

  local function everyThing(visit)
    for mapId, map in pairs(R.maps or {}) do
      for _, kind in ipairs({ "npcs", "steps", "chests", "foes", "exits" }) do
        for _, thing in ipairs(map[kind] or {}) do visit(mapId, kind, thing) end
      end
    end
  end

  t(regionId .. ": every id starts with the region's prefix", function()
    local problems = {}
    local function check(kind, tbl)
      for id in pairs(tbl or {}) do
        if id:sub(1, #R.prefix) ~= R.prefix and id ~= "gate" then problems[#problems + 1] = kind .. " " .. id end
      end
    end
    check("map", R.maps) check("script", R.scripts) check("foe", R.foes) check("ability", R.abilities)
    check("encounter", R.encounters) check("shop", R.shops)
    report(problems)
  end)

  t(regionId .. ": maps are 15 to 32 a side, equal rows of known tiles, enclosed, with a known theme", function()
    local problems = {}
    for id, map in pairs(R.maps or {}) do
      truthy(map.name and map.theme, id .. " has a name and a theme")
      if not THEMES[map.theme] then problems[#problems + 1] = id .. " has theme " .. tostring(map.theme) end
      local h, w = #map.rows, #map.rows[1]
      if h < 15 or h > 32 or w < 15 or w > 32 then problems[#problems + 1] = id .. " is " .. w .. "x" .. h end
      for y, row in ipairs(map.rows) do
        if #row ~= w then problems[#problems + 1] = id .. " row " .. y .. " is " .. #row .. " not " .. w end
        for x = 1, #row do
          local c = row:sub(x, x)
          if not TILES[c] then problems[#problems + 1] = id .. " has a strange tile " .. c end
          if (x == 1 or y == 1 or x == w or y == h) and OPEN[c] and c ~= "L" and c ~= "+" and c ~= ">" then
            problems[#problems + 1] = id .. " is open at " .. x .. "," .. y
          end
        end
      end
    end
    report(problems)
  end)

  t(regionId .. ": things stand on legal squares, and all they name exists", function()
    local problems = {}
    local seen = {}
    everyThing(function(mapId, kind, thing)
      local where = mapId .. " " .. kind .. " " .. (thing.id or (thing.x .. "," .. thing.y))
      local c = tileAt(R.maps[mapId], thing.x, thing.y)
      if not (c == "." or (kind == "exits" and c == ">")) then problems[#problems + 1] = where .. " is on " .. c end
      if thing.script and not story.SCRIPTS[thing.script] then problems[#problems + 1] = where .. " wants script " .. thing.script end
      if kind == "npcs" then
        if not thing.id or seen[thing.id] then problems[#problems + 1] = where .. " repeats its id" end
        seen[thing.id] = true
      end
      if kind == "foes" and not enemies.ENCOUNTERS[thing.enc] then problems[#problems + 1] = where .. " wants encounter " .. tostring(thing.enc) end
      if kind == "chests" and thing.give and not (party.ITEMS[thing.give] or party.GEAR[thing.give]) then problems[#problems + 1] = where .. " gives " .. thing.give end
      if kind == "exits" and thing.map and maps.DATA[thing.map] and tileAt(maps.DATA[thing.map], thing.mx, thing.my) ~= "." then
        problems[#problems + 1] = where .. " lands on a wall"
      end
    end)
    for id, enc in pairs(R.encounters or {}) do
      if not GROUNDS[enc.bg] then problems[#problems + 1] = id .. " has ground " .. tostring(enc.bg) end
      for _, foe in ipairs(enc.foes) do
        if not enemies.FOES[foe] then problems[#problems + 1] = id .. " has foe " .. foe end
      end
    end
    for id, def in pairs(R.foes or {}) do
      if not def.boss and not SHAPES[def.shape] then problems[#problems + 1] = id .. " has shape " .. tostring(def.shape) end
      if not def.tier then problems[#problems + 1] = id .. " has no tier" end
      if not def.family then problems[#problems + 1] = id .. " has no sound family" end
      if #def.name > 16 and not def.short then problems[#problems + 1] = id .. " needs a short name" end
      for _, entry in ipairs(def.abilities or {}) do
        if not enemies.ABILITIES[entry[1]] then problems[#problems + 1] = id .. " uses " .. tostring(entry[1]) end
      end
    end
    for region, list in pairs(R.field or {}) do
      if not FIELDS[region] then problems[#problems + 1] = "field " .. region end
      for _, enc in ipairs(list) do
        if not enemies.ENCOUNTERS[enc] then problems[#problems + 1] = "field encounter " .. enc end
      end
    end
    report(problems)
  end)

  t(regionId .. ": the script is well formed", function()
    local problems = {}
    everyStep(function(step, id)
      for key in pairs(step) do
        if not STEP_KEYS[key] then problems[#problems + 1] = id .. " has a step with " .. tostring(key) end
      end
      if step.say and not (CORE_FACES[step.say] or known(step.say)) then problems[#problems + 1] = id .. " speaks as " .. step.say end
      if step.battle and not enemies.ENCOUNTERS[step.battle] then problems[#problems + 1] = id .. " fights " .. step.battle end
      local item = step.give or step.take or step.has
      if item and not (party.ITEMS[item] or party.GEAR[item]) then problems[#problems + 1] = id .. " names item " .. item end
      if step.join and not party.CHARS[step.join] then problems[#problems + 1] = id .. " joins " .. step.join end
      if step.shop and not story.SHOPS[step.shop] then problems[#problems + 1] = id .. " opens shop " .. step.shop end
      if step.warp then
        local map = maps.DATA[step.warp[1]]
        if not map or tileAt(map, step.warp[2], step.warp[3]) ~= "." then problems[#problems + 1] = id .. " warps to a bad square" end
      end
      if step.say == "deserter" and step.name then problems[#problems + 1] = id .. " renames a party member" end
      local function text(s, kind)
        if s:find("[^\32-\126]") then problems[#problems + 1] = id .. " isn't plain ASCII: " .. s end
        if s:gsub("{hero}", ""):find("[{}]") then problems[#problems + 1] = id .. " has a stray brace: " .. s end
        if s:lower():find("deserter", 1, true) then problems[#problems + 1] = id .. " says deserter out loud: " .. s end
        if kind == "choice" and #s > 70 then problems[#problems + 1] = id .. " has a long option: " .. s end
        if kind == "big" and #s > 36 then problems[#problems + 1] = id .. " is too big: " .. s end
      end
      if step.text then
        text(step.text)
        local width = step.say and rules.SAY_WIDE or rules.NARRATE_WIDE
        local pages = math.ceil(#rules.wrap(step.text, width) / rules.TEXT_LINES)
        if pages > 2 then problems[#problems + 1] = id .. " runs to " .. pages .. " pages: " .. step.text end
        if step.choice and pages > 1 then problems[#problems + 1] = id .. " has a question of " .. pages .. " pages: " .. step.text end
      end
      if step.big then text(step.big, "big") end
      if step.choice then
        local ways, topics = 0, 0
        for _, option in ipairs(step.choice) do
          text(option[1], "choice")
          if option.again then
            topics = topics + 1
            walkSteps(option[2], function(inner)
              if inner.give or inner.gold or inner.battle or inner.warp or inner.world or inner.join or inner.shop or inner.fade then
                problems[#problems + 1] = id .. ": topic '" .. option[1] .. "' can be repeated for gain"
              end
            end)
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

  t(regionId .. ": shops and goals are sound, and the region's own flags all line up", function()
    local problems = {}
    for id in pairs(R.shops or {}) do
      for _, ware in ipairs(story.SHOPS[id]) do
        if not (party.ITEMS[ware.item] or party.GEAR[ware.item]) then problems[#problems + 1] = id .. " sells " .. tostring(ware.item) end
      end
    end
    local set, read = {}, {}
    everyStep(function(step)
      if step.set then set[step.set] = true end
      for _, key in ipairs({ "when" }) do
        if step[key] then read[step[key]] = true end
      end
      for _, flag in ipairs(step.all or {}) do read[flag] = true end
      for _, flag in ipairs(step.count or {}) do read[flag] = true end
    end)
    everyThing(function(_, _, thing)
      if thing.when then read[thing.when] = true end
      if thing.unless then read[thing.unless] = true end
    end)
    for _, goal in ipairs(R.goals or {}) do
      read[goal.done] = true
      if goal.when then read[goal.when] = true end
      local where = "goal '" .. tostring(goal.text) .. "'"
      if not set[goal.done] and not HANDOFF[goal.done] then problems[#problems + 1] = where .. ": nothing sets " .. tostring(goal.done) end
      if type(goal.text) ~= "string" or #goal.text >= 30 then problems[#problems + 1] = where .. ": bad text" end
      if goal.map and not (maps.DATA[goal.map] and tileAt(maps.DATA[goal.map], goal.x, goal.y) == ".") then problems[#problems + 1] = where .. " is on a wall" end
      if goal.site then
        local there = false
        for _, site in ipairs(overworld.SITES) do there = there or site.id == goal.site end
        if not there then problems[#problems + 1] = where .. ": no site " .. goal.site end
      end
    end
    truthy(#(R.goals or {}) >= 5, "a region needs a goal for each step of its story")
    local mine = {}
    for _, flag in ipairs(R.entry.flags or {}) do mine[flag] = true end
    for _, flag in ipairs(R.exports or {}) do mine[flag] = true end
    for flag in pairs(read) do
      if not set[flag] and not mine[flag] and not HANDOFF[flag] then problems[#problems + 1] = "nothing sets " .. flag end
    end
    for flag in pairs(set) do
      if not read[flag] and not mine[flag] and not HANDOFF[flag] then problems[#problems + 1] = "nothing reads " .. flag .. " (list it in R.exports if a later region does)" end
    end
    report(problems)
  end)

  -- ---------------------------------------------------------------- playing it

  local function passes(st, thing)
    if thing.when and not st.flags[thing.when] then return false end
    if thing.unless and st.flags[thing.unless] then return false end
    return true
  end

  local crowd = {}

  -- The model stays out of other regions, or it wanders off through them and never gets back to this one.
  local others = {}
  for _, region in ipairs(content.regions()) do
    if region ~= R then
      for id in pairs(region.maps or {}) do others[id] = true end
    end
  end

  local function enter(st, id, x, y)
    local map = maps.DATA[id]
    if not map then return false end
    st.map, st.x, st.y, st.world = id, x, y, false
    if map.savepoint then st.save = { id, x, y } end
    st.seenMaps[id] = true
    local n = 0
    for _, npc in ipairs(map.npcs or {}) do
      if passes(st, npc) then n = n + 1 end
    end
    if n > (crowd[id] or 0) then crowd[id] = n end
    return true
  end

  local function firstWayOut(choice)
    for i, option in ipairs(choice) do
      if not option.again then return i end
    end
    return 1
  end

  local function forkOf(st, step)
    if not (step.steps or step.other) then return nil end
    local yes
    if step.when then
      yes = st.flags[step.when]
    elseif step.has then
      yes = (st.bag[step.has] or 0) > 0
    elseif step.paid then
      yes = true -- money is fights' business: the model always has it
    elseif step.all then
      yes = true
      for _, flag in ipairs(step.all) do yes = yes and st.flags[flag] end
    elseif step.count then
      local n = 0
      for _, flag in ipairs(step.count) do
        if st.flags[flag] then n = n + 1 end
      end
      yes = n >= step.at
    else
      return nil
    end
    return yes and "steps" or "other"
  end

  local function runList(st, list, ctx)
    for _, step in ipairs(list) do
      local fork = forkOf(st, step)
      if fork then
        if step[fork] and not runList(st, step[fork], ctx) then return false end
      elseif step.choice then
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
      elseif step.give then
        st.bag[step.give] = (st.bag[step.give] or 0) + (step.n or 1)
      elseif step.take then
        st.bag[step.take] = math.max(0, (st.bag[step.take] or 0) - (step.n or 1))
      elseif step.warp then
        enter(st, step.warp[1], step.warp[2], step.warp[3])
        ctx.arrived = true
      elseif step.site then
        for _, site in ipairs(overworld.SITES) do
          if site.id == step.site then enter(st, site.map, site.mx, site.my) end
        end
        ctx.arrived = true
      elseif step.world then
        st.world, ctx.arrived = true, false
      elseif step.save then
        if not st.world then st.save = { st.map, st.x, st.y } end
      elseif step.battle then
        local enc = enemies.ENCOUNTERS[step.battle]
        if ctx.wipe() and not (enc and enc.mustLose) and st.save then
          enter(st, st.save[1], st.save[2], st.save[3])
          return false
        end
      end
    end
    return true
  end

  local checkStep

  local function runScript(st, id, ctx, onceKey)
    local inner = { pick = ctx.pick, wipe = ctx.wipe }
    if not runList(st, story.SCRIPTS[id] or {}, inner) then return end
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

  local function copyTable(tbl)
    local out = {}
    for k, v in pairs(tbl) do out[k] = v end
    return out
  end

  local function copyState(st)
    return {
      map = st.map, x = st.x, y = st.y, world = st.world, save = st.save, flags = copyTable(st.flags), once = copyTable(st.once),
      bag = copyTable(st.bag), opened = copyTable(st.opened), seenMaps = st.seenMaps,
    }
  end

  local function restore(st, here)
    st.map, st.x, st.y, st.world, st.save = here.map, here.x, here.y, here.world, here.save
    st.flags, st.once, st.bag, st.opened = copyTable(here.flags), copyTable(here.once), copyTable(here.bag), copyTable(here.opened)
  end

  local function keysOf(tbl)
    local keys = {}
    for k, v in pairs(tbl) do
      if v then keys[#keys + 1] = tostring(k) end
    end
    table.sort(keys)
    return table.concat(keys, ",")
  end

  local function sameState(a, b)
    return a.map == b.map and a.x == b.x and a.y == b.y and a.world == b.world and keysOf(a.flags) == keysOf(b.flags) and keysOf(a.once) == keysOf(b.once)
  end

  local QUIET = { pick = firstWayOut, wipe = function() return false end }

  local function actions(st)
    local out = {}
    if st.world then
      for _, site in ipairs(overworld.SITES) do
        if passes(st, site) and maps.DATA[site.map] and not others[site.map] then
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
    for _, thing in ipairs(map.chests or {}) do
      if not st.opened[st.map .. ":" .. thing.id] then chests[thing.y * 100 + thing.x] = thing end
    end
    while #todo > 0 do
      local at = table.remove(todo)
      for _, d in ipairs({ { 0, -1 }, { 1, 0 }, { 0, 1 }, { -1, 0 } }) do
        local x, y = at[1] + d[1], at[2] + d[2]
        local key = y * 100 + x
        local npc, exit, chest = npcs[key], exits[key], chests[key]
        local c = tileAt(map, x, y)
        if npc then
          if not offered[npc] then
            offered[npc] = true
            out[#out + 1] = function(ctx)
              st.x, st.y = at[1], at[2]
              runScript(st, npc.script, ctx)
            end
          end
        elseif chest then
          if not offered[chest] then
            offered[chest] = true
            out[#out + 1] = function()
              st.opened[st.map .. ":" .. chest.id] = true
              if chest.give then st.bag[chest.give] = (st.bag[chest.give] or 0) + (chest.n or 1) end
            end
          end
        elseif exit then
          if not offered[exit] then
            offered[exit] = true
            out[#out + 1] = function(ctx)
              if exit.script then
                runScript(st, exit.script, ctx)
              elseif exit.world then
                st.world = true
              elseif enter(st, exit.map, exit.mx, exit.my) then
                checkStep(st, ctx)
              end
            end
          end
        elseif not seen[key] and (c == "." or c == "+" or c == ">" or (c == "L" and ((st.bag.key or 0) > 0 or st.opened[key]))) then
          seen[key] = true
          local trigger = false
          for _, thing in ipairs(map.steps or {}) do
            if thing.x == x and thing.y == y and passes(st, thing) then trigger = true end
          end
          if trigger then
            local trial = copyState(st)
            trial.x, trial.y = x, y
            local before = copyState(trial)
            checkStep(trial, QUIET)
            trigger = not sameState(before, trial)
          end
          if trigger then
            out[#out + 1] = function(ctx)
              st.x, st.y = x, y
              checkStep(st, ctx)
            end
          else
            todo[#todo + 1] = { x, y }
          end
        end
      end
    end
    return out
  end

  local function newState()
    local st = { world = true, flags = {}, once = {}, bag = {}, opened = {}, seenMaps = {}, map = "?", x = 0, y = 0 }
    for _, flag in ipairs(R.entry.flags or {}) do st.flags[flag] = true end
    if R.entry.map then enter(st, R.entry.map, R.entry.x, R.entry.y) end
    if R.entry.script then runScript(st, R.entry.script, QUIET) end
    return st
  end

  local function finishFrom(st, ctx)
    local seenStates, moves = {}, 0
    local function search(depth)
      if st.flags[R.exit] then return true end
      if depth > 500 or moves > 40000 then return false end
      local key = st.map .. "|" .. tostring(st.world) .. "|" .. keysOf(st.once) .. "|" .. keysOf(st.flags) .. "|" .. keysOf(st.bag)
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
        restore(st, here)
      end
      return false
    end
    return search(1)
  end

  t(regionId .. ": the first way out of every scene carries the story to the region's end", function()
    local st = newState()
    truthy(finishFrom(st, QUIET), "the region's exit flag " .. R.exit .. " can't be reached")
    local problems = {}
    for id in pairs(R.maps or {}) do
      if not st.seenMaps[id] then problems[#problems + 1] = "the way through never sees " .. id end
    end
    print(regionId .. " maps not on the way through: " .. #problems)
  end)

  t(regionId .. ": after any wandering with wipes the end can still be reached, every map and answer can be reached", function()
    local picked, seenMaps = {}, {}
    for seed = 1, 10 do
      local rng = seeded.rng(seed)
      local function pick(choice)
        for i, option in ipairs(choice) do
          if not picked[option] then
            picked[option] = true
            return i
          end
        end
        return rng(#choice)
      end
      local wipeChance = seed % 3 == 0 and 25 or 5
      local ctx = { pick = pick, wipe = function() return rng(100) <= wipeChance end }
      local st = newState()
      st.seenMaps = seenMaps
      for move = 1, 60 + seed * 30 do
        if st.flags[R.exit] then break end
        local list = actions(st)
        truthy(#list > 0, "stuck on " .. st.map .. " at " .. st.x .. "," .. st.y .. " with " .. keysOf(st.flags))
        list[rng(#list)](ctx)
        if move % 25 == 0 then breathe() end
      end
      truthy(st.flags[R.exit] or finishFrom(st, QUIET), "seed " .. seed .. " can't finish from " .. st.map .. " with " .. keysOf(st.flags))
      breathe()
    end
    local problems = {}
    for id in pairs(R.maps or {}) do
      if not seenMaps[id] then problems[#problems + 1] = "nobody ever reached " .. id end
    end
    for id, n in pairs(crowd) do
      if n > 14 then problems[#problems + 1] = id .. " holds " .. n .. " people" end
    end
    report(problems)
  end)

  t(regionId .. ": size", function()
    local words, choices, floors = 0, 0, 0
    everyStep(function(step)
      if step.choice then choices = choices + 1 end
      for _, s in ipairs({ step.text or "", step.big or "" }) do
        for _ in s:gmatch("%S+") do words = words + 1 end
      end
    end)
    for _ in pairs(R.maps or {}) do floors = floors + 1 end
    print(regionId .. ": " .. words .. " words, " .. choices .. " choices, " .. floors .. " maps")
    truthy(words >= 3000, "only " .. words .. " words")
  end)
end
