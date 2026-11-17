-- Every boss in the game against a party of the level players reach it at, in that tier's gear, played by the battle bot.
-- FF4 normal: a boss should make you think and usually lose you someone, not wipe you every time or fall over.
local kit = loadfile(fs.combine(fs.getDir(fs.getDir(shell.getRunningProgram())), "testkit.lua"), nil, _ENV)()
local seeded = require("lib.rng")
local battle = require("games.blightmare.battle")
local enemies = require("games.blightmare.enemies")
local party = require("games.blightmare.party")
local t = ccunit.test

local RUNS = 16
local SKIP = { boss_foreman = true }

local function breathe()
  os.queueEvent("blightmare_bosses")
  os.pullEvent("blightmare_bosses")
end

local function castFor(lvl, id)
  if id:sub(1, 3) == "rn_" then return { "hero", "deserter", "owlin", "asphodel" } end -- the north can come before the sister is found
  local cast = { "hero", "deserter", "cleric" }
  if lvl >= 9 then cast[#cast + 1] = "owlin" end
  return cast
end

local function partyAt(lvl, id)
  local tier = party.tierOf(lvl)
  local s = { party = {}, flags = {}, rev = 0, score = 0, gold = 0, beaten = {}, opened = {}, fx = { flash = 0, hurt = 0, fade = 0 } }
  for i, id in ipairs(castFor(lvl, id)) do
    local member = party.new(id, lvl)
    member.weapon, member.armour = party.kit(id, tier)
    party.restore(member)
    s.party[i] = member
  end
  s.bag = { potion = 5, hipotion = lvl >= 12 and 8 or nil, xpotion = lvl >= 30 and 5 or nil, ether = lvl >= 30 and 8 or 4, feather = 3, tonic = 3 }
  return s
end

local function fight(id, lvl, seed)
  local rng = seeded.rng(seed)
  local s = partyAt(lvl, id)
  battle.begin(s, id, rng)
  local ticks = 0
  while ticks < 6000 and s.battle and not s.battle.result do
    ticks = ticks + 1
    local action = battle.bot(s, rng)
    if action then battle.input(s, action) end
    battle.tick(s, rng)
    if ticks % 500 == 0 then breathe() end
  end
  local left = 0
  for _, f in ipairs(s.battle.foes) do left = left + math.max(0, f.hp) * 100 / f.mhp end
  return s.battle.result == "won", ticks, left / #s.battle.foes
end

t("every boss, at its own tier", function()
  local ids = {}
  for id, enc in pairs(enemies.ENCOUNTERS) do
    if enc.boss and not enc.mustLose and not SKIP[id] then ids[#ids + 1] = id end
  end
  table.sort(ids, function(a, b)
    local ta, tb = enemies.FOES[enemies.ENCOUNTERS[a].foes[1]].tier or 0, enemies.FOES[enemies.ENCOUNTERS[b].foes[1]].tier or 0
    if ta ~= tb then return ta < tb end
    return a < b
  end)
  local lines, lows = {}, {}
  for _, id in ipairs(ids) do
    local def = enemies.FOES[enemies.ENCOUNTERS[id].foes[1]]
    local lvl = math.min(50, math.max(1, (def.tier or 5) - 1))
    local wins, total, leftAll = 0, 0, 0
    for seed = 1, RUNS do
      local won, ticks, left = fight(id, lvl, seed * 7)
      if won then wins = wins + 1 else leftAll = leftAll + left end
      total = total + ticks
      breathe()
    end
    if id ~= "rd_e_chylbad" and wins * 100 / RUNS < 25 then lows[#lows + 1] = id .. " " .. wins .. "/" .. RUNS end
    lines[#lines + 1] = string.format("%3d%% L%d %ds left %d %s", wins * 100 / RUNS, lvl, total * 0.12 / RUNS, leftAll / math.max(1, RUNS - wins), id)
  end
  print(table.concat(lines, " | "))
  ccunit.eq(#lows, 0, "too hard at their level: " .. table.concat(lows, ", "))
end)
