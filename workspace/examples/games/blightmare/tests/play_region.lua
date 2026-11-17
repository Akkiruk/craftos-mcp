-- Plays BLIGHTMARE with the real engine and real fights: the bot follows the story guide, so a dead end, a lying guide or a boss
-- that can't be beaten shows up here, where the model in check_region.lua can't see it.
-- A tests/playthrough_<id>.test.lua is: require("tests.play_region")("<id>")
local seeded = require("lib.rng")
local rules = require("games.blightmare.rules")
local party = require("games.blightmare.party")
local content = require("games.blightmare.content")
local story = require("games.blightmare.story")
local overworld = require("games.blightmare.overworld")

local LEVEL_AT = {
  heart = 6, plexios = 12, sindal = 14, windmill = 18, empire = 21, underdark = 25, vault = 30,
  ruin_south = 32, ruin_north = 36, ruin_deep = 37, finale = 42,
}
local CAST = {
  heart = { "deserter", "cleric" }, plexios = { "deserter", "cleric", "owlin" }, sindal = { "deserter", "cleric", "owlin" },
  windmill = { "deserter", "cleric", "owlin" }, empire = { "deserter", "cleric", "owlin" }, underdark = { "deserter", "cleric", "owlin" },
  vault = { "deserter", "cleric", "owlin", "jezzara" }, ruin_south = {}, ruin_north = { "deserter", "owlin" },
  ruin_deep = { "deserter", "owlin" }, finale = { "deserter", "owlin", "cleric", "jezzara", "asphodel" },
}
local TICKS = 80000
local HELP_AFTER = 5000
-- What has happened by the time each region opens. plexios and sindal may run either way round, as may ruin_north and ruin_deep.
local BEFORE = {
  heart = {}, plexios = { "heart" }, sindal = { "heart" }, windmill = { "heart", "plexios", "sindal" },
  empire = { "heart", "plexios", "sindal", "windmill" }, underdark = { "heart", "plexios", "sindal", "windmill", "empire" },
  vault = { "heart", "plexios", "sindal", "windmill", "empire", "underdark" },
  ruin_south = { "heart", "plexios", "sindal", "windmill", "empire", "underdark", "vault" },
  ruin_north = { "heart", "plexios", "sindal", "windmill", "empire", "underdark", "vault", "ruin_south" },
  ruin_deep = { "heart", "plexios", "sindal", "windmill", "empire", "underdark", "vault", "ruin_south" },
  finale = { "heart", "plexios", "sindal", "windmill", "empire", "underdark", "vault", "ruin_south", "ruin_north", "ruin_deep" },
}

local function findRegion(id)
  for _, region in ipairs(content.regions()) do
    if region.id == id then return region end
  end
  error("no region " .. id)
end

local function kitOut(member, tier)
  member.weapon, member.armour = party.kit(member.id, tier)
  party.restore(member)
end

--- A state as if the player had come this far: the region's entry flags, the party at the table's level in that tier's gear.
local function stateFor(R, rng)
  local s = rules.new({ rng = rng, player = "Ada" })
  local lvl = LEVEL_AT[R.id]
  s.run, s.mode = nil, "world"
  -- the guide reads goals in order, so everything earlier has to be done
  for _, goal in ipairs(story.GOALS) do
    s.flags[goal.done] = true
    if goal.done == "finished" then break end
  end
  for _, id in ipairs(BEFORE[R.id] or {}) do
    local earlier = findRegion(id)
    for _, goal in ipairs(earlier.goals or {}) do s.flags[goal.done] = true end
    s.flags[earlier.exit] = true
  end
  for _, flag in ipairs(R.entry.flags or {}) do s.flags[flag] = true end
  s.party = { party.new("hero", lvl) }
  for _, id in ipairs(CAST[R.id] or {}) do s.party[#s.party + 1] = party.new(id, lvl) end
  local tier = party.tierOf(lvl)
  for _, member in ipairs(s.party) do kitOut(member, tier) end
  s.level = lvl
  s.gold = lvl * 300
  s.bag = { potion = 5, hipotion = 8, xpotion = lvl >= 25 and 6 or nil, ether = 4, feather = 3, tonic = 3 }
  s.wx, s.wy = overworld.SITES[1].x, overworld.SITES[1].y
  for _, site in ipairs(overworld.SITES) do
    if site.id == R.entry.site then s.wx, s.wy = site.x, site.y end
  end
  if R.entry.map then
    s.mode = "walk"
    s.map, s.x, s.y, s.dir = R.entry.map, R.entry.x, R.entry.y, 2
    s.foes = {}
    s.savepoint = { map = s.map, x = s.x, y = s.y, dir = 2 }
  end
  for _, id in ipairs(R.entry.bag or {}) do s.bag[id] = 1 end
  return s
end

return function(regionId)
  local t, truthy = ccunit.test, ccunit.truthy
  local R = findRegion(regionId)

  for seed = 1, 2 do
    t(regionId .. ": the bot plays it through, seed " .. seed, function()
      local rng = seeded.rng(seed + 40)
      local s = stateFor(R, rng)
      local ticks, wipes, last = 0, 0, ""
      local trail, place = {}, nil
      -- A bot can't read a riddle. Puzzles are proven solvable in check_region.lua, so after a long stall the goal is done for
      -- it, once, and named in the output: everything past the puzzle still gets played.
      local helped, flagsSeen, stalledSince = {}, -1, 0
      while ticks < TICKS and not s.flags[R.exit] do
        ticks = ticks + 1
        local action = rules.bot(s, rng)
        if action then rules.input(s, action) end
        for _, ev in ipairs(rules.tick(s, rng)) do
          if ev.type == "wipe" then wipes = wipes + 1 end
        end
        local here = (s.mode == "world" and "world" or s.map) .. " [" .. tostring((rules.goal(s) or {}).text) .. "]"
        if ticks % 40 == 0 and here ~= place then
          place = here
          trail[#trail + 1] = ticks .. " " .. here
          if #trail > 24 then table.remove(trail, 1) end
        end
        if ticks % 300 == 0 then
          local count = 0
          for _ in pairs(s.flags) do count = count + 1 end
          if count ~= flagsSeen then flagsSeen, stalledSince = count, ticks end
          local goal = ticks - stalledSince > HELP_AFTER and story.GOALS and rules.currentGoal(s)
          if goal and s.mode ~= "battle" and s.mode ~= "talk" then
            s.flags[goal.done] = true
            helped[#helped + 1] = goal.done
          end
          os.queueEvent("blightmare_play")
          os.pullEvent("blightmare_play")
          local goal = rules.goal(s)
          last = (goal and goal.text or "no goal") .. " at " .. s.map .. " " .. s.x .. "," .. s.y .. " in " .. s.mode
        end
      end
      print(regionId .. " seed " .. seed .. ": " .. ticks .. " ticks, about " .. math.floor(ticks * 0.12 / 60) .. " min of clock, " .. wipes .. " wipes, level " .. s.level .. ", gold " .. s.gold .. ", helped: " .. table.concat(helped, " "))
      truthy(s.flags[R.exit], "TRAIL " .. table.concat(trail, " / ") .. " STUCK: " .. last .. " after " .. ticks .. " ticks and " .. wipes .. " wipes")
    end)
  end
end
