-- BLIGHTMARE's world pictures: the continent, how far the slice reaches, and that every theme and face can be drawn.
local kit = loadfile(fs.combine(fs.getDir(fs.getDir(shell.getRunningProgram())), "testkit.lua"), nil, _ENV)()
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

local surfaceApi = require("lib.surface")
local font = surfaceApi.loadFont(surfaceApi.load("/" .. fs.combine(kit.root, "lib/font")))
local ui = require("lib.ui")
local screen = surfaceApi.create(121, 81)
ui.init(surfaceApi, font, screen)

-- Stand-in maps with every kind of tile, whatever maps.lua has reached. Real maps are checked on their own, further down.
local realMaps
do
  local ok, maps = pcall(require, "games.blightmare.maps")
  realMaps = ok and maps or nil
  package.loaded["games.blightmare.maps"] = nil
end

local stand = {
  DATA = {
    street = {
      name = "STREET", theme = "town",
      rows = {
        "WWWWWWWWW",
        "W.......W",
        "W.##+h>.W",
        "W.#...L.W",
        "W.......W",
        "WWWWWWWWW",
      },
      npcs = {
        { id = "a", x = 3, y = 5, sprite = "doctor" },
        { id = "gone", x = 4, y = 5, sprite = "gnome", when = "never" },
        { id = "new", x = 5, y = 5, sprite = "nobody we have drawn" },
      },
      chests = { { id = "c1", x = 7, y = 5, give = "potion" } },
      foes = { { id = "f1", x = 6, y = 2, enc = "mine_1", sprite = "miner" } },
      exits = { { x = 7, y = 3, map = "shaft", mx = 2, my = 2, dir = 2 }, { x = 2, y = 2, world = { 62, 60 } } },
    },
    shaft = {
      name = "SHAFT", theme = "mine",
      rows = {
        "#########",
        "#...h...#",
        "#.#.+.#.#",
        "#.#.L.#>#",
        "#.......#",
        "#########",
      },
      npcs = { { id = "g", x = 2, y = 4, sprite = "gnome" } },
      chests = { { id = "c1", x = 4, y = 2, give = "potion" } },
      foes = { { id = "f1", x = 6, y = 5, enc = "mine_1", sprite = "foreman" } },
    },
  },
}
package.loaded["games.blightmare.maps"] = stand

local art = require("games.blightmare.art")
local overworld = require("games.blightmare.overworld")
local party = require("games.blightmare.party")
local scene = require("games.blightmare.scene")
local view = require("games.blightmare.view_world")
local world = require("games.blightmare.world")

local L = { W = 121, H = 81, x0 = 0, y0 = 0, bw = 121, bh = 81, statusY = 60 }
local PORTRAIT_IDS = { "hero", "deserter", "cleric", "captain", "doctor", "mayor", "smith", "innkeeper", "child", "foreman", "gnome", "villager" }
local TILES = { ["~"] = true, ["."] = true, ['"'] = true, T = true, ["^"] = true, ["="] = true, s = true, W = true, B = true, O = true }
local RUINED_TILES = { x = true, X = true, t = true, a = true }

local function state(over)
  local s = {
    v = 1, score = 0, level = 1, over = false, won = false, rev = 1, heroName = "Hero", mode = "walk", map = "street", x = 2, y = 5, dir = 2,
    wx = 63, wy = 60, party = { party.new("hero", 2), party.new("deserter", 2), party.new("cleric", 2) }, bag = {}, gold = 0,
    flags = {}, opened = {}, beaten = {}, foes = {}, fx = { flash = 0, hurt = 0, fade = 0 }, msg = "", hints = {},
  }
  for k, v in pairs(over or {}) do s[k] = v end
  return s
end

--- Every tile the party can walk to from a place, by four-way steps, keyed y * 1000 + x.
local function flood(fromX, fromY, s)
  local seen, todo = {}, { { fromX, fromY } }
  while #todo > 0 do
    local at = table.remove(todo)
    local key = at[2] * 1000 + at[1]
    if not seen[key] and overworld.walkable(at[1], at[2], s) then
      seen[key] = true
      todo[#todo + 1] = { at[1] + 1, at[2] }
      todo[#todo + 1] = { at[1] - 1, at[2] }
      todo[#todo + 1] = { at[1], at[2] + 1 }
      todo[#todo + 1] = { at[1], at[2] - 1 }
    end
  end
  return seen
end

local function count(tile)
  local n = 0
  for _, row in ipairs(overworld.ROWS) do
    for _ in row:gmatch(tile == '"' and '"' or ("%" .. tile)) do n = n + 1 end
  end
  return n
end

-- ---------------------------------------------------------------- the continent

t("the overworld is 80 rows of exactly 120 known tiles", function()
  eq(#overworld.ROWS, 80)
  for y, row in ipairs(overworld.ROWS) do
    eq(#row, 120, "row " .. y)
    for x = 1, 120 do truthy(TILES[row:sub(x, x)], "tile at " .. x .. "," .. y) end
  end
end)

t("the map looks like the continent in the notes, not noise", function()
  local function share(x1, y1, x2, y2, tiles)
    local n, of = 0, 0
    for y = y1, y2 do
      for x = x1, x2 do
        of = of + 1
        if tiles:find(overworld.tileAt(x, y), 1, true) then n = n + 1 end
      end
    end
    return n / of
  end
  truthy(share(1, 1, 120, 80, "~") > 0.3, "sea all round")
  truthy(share(53, 14, 66, 40, "^") > 0.7, "the Empyreal Mountains down the middle")
  truthy(share(30, 2, 60, 12, "sT") > 0.5, "Thuluan's swamp in the far north")
  truthy(share(87, 48, 107, 62, '"') > 0.7, "the Verdant Sea in the Heart")
  truthy(share(14, 20, 34, 28, "T") > 0.5, "Ebrein's pine forests")
  truthy(count("W") > 80, "the pandemic wall")
  truthy(share(1, 1, 120, 2, "~") > 0.9 and share(1, 1, 2, 44, "~") > 0.9 and share(118, 1, 120, 80, "~") > 0.8, "sea at the edges")
  -- the wall really is unbroken from the mountains to the south coast
  local at = 51
  while overworld.tileAt(61, at) == "W" do at = at + 1 end
  truthy(at >= 66, "the east wall runs down past Scythebreak")
end)

t("tileAt answers off the edge of the map with sea, and that can't be walked", function()
  eq(overworld.tileAt(0, 10), "~")
  eq(overworld.tileAt(121, 10), "~")
  eq(overworld.tileAt(10, 0), "~")
  eq(overworld.tileAt(10, 81), "~")
  eq(overworld.walkable(0, 0), false)
end)

t("the sites stand on O tiles, against the wall, against the mountains and on the road", function()
  local byId = {}
  for _, site in ipairs(overworld.SITES) do
    byId[site.id] = site
    eq(overworld.tileAt(site.x, site.y), "O", site.id)
    truthy(site.map and site.name, site.id .. " complete")
  end
  for _, site in ipairs(overworld.sites()) do
    truthy(site.mx and site.my and site.dir, site.id .. " has a way in")
  end
  truthy(byId.scythebreak and byId.orrenshire and byId.mine, "all three sites")
  eq(byId.scythebreak.map, "scythebreak")
  eq(byId.orrenshire.map, "orrenshire")
  eq(byId.mine.map, "mine_1")
  eq(overworld.tileAt(byId.scythebreak.x - 1, byId.scythebreak.y), "W")
  eq(overworld.tileAt(byId.orrenshire.x - 1, byId.orrenshire.y), "^")
  eq(overworld.tileAt(byId.mine.x, byId.mine.y - 1), "^")
end)

t("a road joins every site, by road tiles alone", function()
  local seen, todo = {}, { { overworld.SITES[1].x, overworld.SITES[1].y } }
  local slice = overworld.sites()
  while #todo > 0 do
    local at = table.remove(todo)
    local key = at[2] * 1000 + at[1]
    local c = overworld.tileAt(at[1], at[2])
    if not seen[key] and (c == "=" or c == "B" or c == "O") and overworld.walkable(at[1], at[2]) then
      seen[key] = true
      for _, d in ipairs(world.DIRS) do todo[#todo + 1] = { at[1] + d[1], at[2] + d[2] } end
    end
  end
  for _, site in ipairs(slice) do truthy(seen[site.y * 1000 + site.x], site.id .. " on the road") end
end)

t("every site is reachable, and nothing past the slice is", function()
  local first = overworld.SITES[1]
  local seen = flood(first.x, first.y)
  eq(#overworld.sites(), 3, "only the slice's sites are open")
  for _, site in ipairs(overworld.sites()) do truthy(seen[site.y * 1000 + site.x], site.id) end
  local n = 0
  for key in pairs(seen) do
    n = n + 1
    local x, y = key % 1000, math.floor(key / 1000)
    truthy(x >= 61 and x <= 83 and y >= 41 and y <= 74, "stray tile at " .. x .. "," .. y)
    local c = overworld.tileAt(x, y)
    truthy(c ~= "~" and c ~= "^" and c ~= "W", "standing on " .. c)
  end
  truthy(n > 300, "a real stretch of country, not a corridor: " .. n)
end)

t("the slice has the country it needs: open grass, tall grass, wood, marsh and a bridge", function()
  local first = overworld.SITES[1]
  local tiles = {}
  for key in pairs(flood(first.x, first.y)) do
    local c = overworld.tileAt(key % 1000, math.floor(key / 1000))
    tiles[c] = (tiles[c] or 0) + 1
  end
  truthy((tiles["."] or 0) > 40, "grass")
  truthy((tiles['"'] or 0) > 40, "tall grass")
  truthy((tiles.T or 0) > 20, "forest")
  truthy((tiles.s or 0) > 5, "swamp")
  truthy((tiles.B or 0) >= 1, "a bridge")
  truthy((tiles["="] or 0) > 30, "a road long enough to be a journey")
end)

t("the gate holds: open it and the rest of the Heart would be there", function()
  local gate = overworld.GATES[1]
  eq(gate.script, "gate_greywater")
  truthy(gate.script, "a script to run")
  eq(overworld.walkable(gate.x, gate.y), false)
  eq(overworld.tileAt(gate.x, gate.y), "=")
  truthy(overworld.gateAt(gate.x, gate.y))
  -- the Greywater bridge is the next tile, and the road runs on past it
  eq(overworld.tileAt(gate.x + 1, gate.y), "B")
  eq(overworld.tileAt(gate.x + 3, gate.y), "=")
  local past = flood(gate.x, gate.y, { flags = { finished = true } })
  truthy(past[gate.y * 1000 + 90], "the road on into the Verdant Sea")
end)

t("region is road on the road, heart in the country, nil anywhere else", function()
  eq(overworld.region(64, 60), "road")
  eq(overworld.region(62, 60), "road")
  eq(overworld.region(66, 62), "heart")
  eq(overworld.region(74, 59), "heart")
  eq(overworld.region(10, 10), nil)    -- the sea
  eq(overworld.region(60, 30), nil)    -- the mountains
  eq(overworld.region(97, 56), nil)    -- the Verdant Sea, walkable but out of reach
  eq(overworld.region(30, 24), nil)    -- Syndalia
  local gate = overworld.GATES[1]
  eq(overworld.region(gate.x, gate.y), nil)
end)

-- ---------------------------------------------------------------- the whole game's land

local SPEC_SITES = {
  scythebreak = { 62, 60 }, orrenshire = { 67, 44 }, mine = { 74, 41 },
  hayford = { 106, 65 }, oplinas = { 108, 47 }, glamouth = { 92, 71 }, windmill = { 96, 60 },
  blackpool = { 97, 39 }, killerth = { 86, 26 }, murkwell = { 72, 30 }, adaphis = { 104, 28 },
  crevice = { 52, 33 }, syndalia = { 36, 28 }, upriftin = { 30, 24 }, eighstead = { 11, 31 }, antarith = { 20, 38 },
  thuluan = { 45, 8 }, crack_east = { 62, 67 }, crack_west = { 57, 67 }, agoshull = { 30, 57 }, evrastin = { 47, 62 },
  abyss = { 60, 27 },
}

--- A state with these flags.
local function withFlags(list)
  local flags = {}
  for _, f in ipairs(list) do flags[f] = true end
  return { flags = flags }
end

-- Each stage of the story: the flags so far, and what's newly in reach on foot from Scythebreak. crack_west and the Empire are
-- never on this list: they're only got to through the crack.
local STAGES = {
  { {}, { "scythebreak", "orrenshire", "mine" } },
  { { "finished" }, { "hayford", "oplinas", "glamouth" } },
  { { "hr_verdant_open" }, { "windmill" } },
  { { "hr_done" }, { "blackpool", "killerth", "murkwell", "adaphis", "crevice", "syndalia", "upriftin", "eighstead", "antarith" } },
  { { "px_done", "sn_done", "wm_bargain" }, { "thuluan" } },
  { { "wm_done" }, { "crack_east" } },
  { { "em_done" }, { "abyss" } },
}

--- Which sites a flood from a tile found, as a sorted list of ids.
local function sitesIn(seen)
  local found = {}
  for id, at in pairs(SPEC_SITES) do
    if seen[at[2] * 1000 + at[1]] then found[#found + 1] = id end
  end
  table.sort(found)
  return table.concat(found, " ")
end

t("every site in the spec is in the table, exactly on its tile, on an O in both maps", function()
  local n, ruined = 0, { flags = { ruined = true } }
  for id, at in pairs(SPEC_SITES) do
    local found
    for _, site in ipairs(overworld.SITES) do
      if site.id == id then found = site end
    end
    truthy(found, id)
    eq(found.x, at[1], id)
    eq(found.y, at[2], id)
    eq(overworld.tileAt(at[1], at[2]), "O", id)
    eq(overworld.tileAt(at[1], at[2], ruined), "O", id .. " ruined")
    n = n + 1
  end
  eq(n, 22)
end)

t("no O stands anywhere but on a site, in either map", function()
  local ruined = { flags = { ruined = true } }
  for y = 1, 80 do
    for x = 1, 120 do
      if overworld.tileAt(x, y) == "O" or overworld.tileAt(x, y, ruined) == "O" then truthy(overworld.siteOn(x, y), x .. "," .. y) end
    end
  end
end)

t("the story opens the land in order: at each stage what can be reached is exactly what should be", function()
  local flags, want = {}, {}
  for i, stage in ipairs(STAGES) do
    for _, f in ipairs(stage[1]) do flags[#flags + 1] = f end
    for _, id in ipairs(stage[2]) do want[#want + 1] = id end
    table.sort(want)
    local s = withFlags(flags)
    eq(sitesIn(flood(62, 60, s)), table.concat(want, " "), "stage " .. i)
  end
end)

t("every site a stage reaches is open by then, and none is open before it can be reached", function()
  local flags = {}
  for i, stage in ipairs(STAGES) do
    for _, f in ipairs(stage[1]) do flags[#flags + 1] = f end
    local s = withFlags(flags)
    for _, id in ipairs(stage[2]) do
      local at = SPEC_SITES[id]
      local site = overworld.siteAt(at[1], at[2], s)
      truthy(site and site.id == id, id .. " open at stage " .. i)
    end
  end
  eq(overworld.siteAt(96, 60, withFlags({ "finished" })), nil, "not the windmill yet")
  eq(overworld.siteAt(97, 39, withFlags({ "finished", "hr_verdant_open" })), nil, "not Blackpool yet")
end)

t("a road joins each land's sites", function()
  local function onRoad(fromX, fromY, s)
    local seen, todo = {}, { { fromX, fromY } }
    while #todo > 0 do
      local at = table.remove(todo)
      local key = at[2] * 1000 + at[1]
      local c = overworld.tileAt(at[1], at[2], s)
      if not seen[key] and (c == "=" or c == "B" or c == "O") and overworld.walkable(at[1], at[2], s) then
        seen[key] = true
        for _, d in ipairs(world.DIRS) do todo[#todo + 1] = { at[1] + d[1], at[2] + d[2] } end
      end
    end
    return seen
  end
  local all = withFlags({ "finished", "hr_verdant_open", "hr_done", "wm_bargain", "wm_done", "em_done" })
  local heartSide = onRoad(62, 60, all)
  for id, at in pairs(SPEC_SITES) do
    if id ~= "crack_west" and id ~= "agoshull" and id ~= "evrastin" then truthy(heartSide[at[2] * 1000 + at[1]], id .. " on the road") end
  end
  local empire = onRoad(57, 67, all)
  truthy(empire[57 * 1000 + 30] and empire[62 * 1000 + 47], "the Empire's own road")
end)

t("gates stand until their flag, and an open gate is plain ground", function()
  local want = {
    gate_greywater = "finished", gate_verdant = "hr_verdant_open", gate_portal = "hr_done", gate_crevice = "hr_done",
    gate_thuluan = "wm_bargain", gate_crack = "wm_done", gate_abyss = "em_done",
  }
  eq(#overworld.GATES, 7)
  eq(#overworld.gates(), 7)
  for _, gate in ipairs(overworld.GATES) do
    eq(gate.unless, want[gate.script], gate.script)
    eq(overworld.walkable(gate.x, gate.y), false, gate.script)
    truthy(overworld.gateAt(gate.x, gate.y), gate.script)
    local s = withFlags({ gate.unless })
    eq(overworld.gateAt(gate.x, gate.y, s), nil, gate.script)
    truthy(overworld.walkable(gate.x, gate.y, s), gate.script .. " open")
    local some = overworld.gates(s)
    for _, g in ipairs(some) do truthy(g.unless ~= gate.unless, gate.script) end
    eq(overworld.gateAt(gate.x, gate.y, { flags = { ruined = true } }), nil, gate.script .. " ruined")
  end
  eq(#overworld.gates({ flags = { ruined = true } }), 0)
end)

t("the Empire is sealed: nothing leads in but the crack, even with every flag set", function()
  local all = withFlags({ "finished", "hr_verdant_open", "hr_done", "wm_bargain", "wm_done", "em_done" })
  local heartSide = flood(62, 60, all)
  local empire = flood(57, 67, all)
  eq(sitesIn(empire), "agoshull crack_west evrastin")
  for key in pairs(empire) do truthy(not heartSide[key], "the Empire side touches the rest at " .. key) end
  truthy(heartSide[67 * 1000 + 62], "the east end of the crack")
  -- and isReachable knows the dungeon joins them, only once it's open
  eq(overworld.isReachable(30, 57, withFlags({ "finished", "hr_verdant_open", "hr_done", "wm_bargain" })), false)
  eq(overworld.isReachable(30, 57, all), true)
end)

t("sites sort by when and unless, and sites(nil) is the slice", function()
  local ids = {}
  for _, site in ipairs(overworld.sites()) do ids[#ids + 1] = site.id end
  eq(table.concat(ids, " "), "scythebreak orrenshire mine")
  local ruined = { flags = { ruined = true } }
  for _, site in ipairs(overworld.sites(ruined)) do
    truthy(site.id:find("_r$"), "only ruined sites stay open: " .. site.id)
  end
end)

t("addSite merges over an entry, and makes ruined sites on the same tile", function()
  local hay = overworld.addSite("hayford", { mx = 4, my = 5, dir = 3 })
  eq(hay.x, 106)
  eq(hay.mx, 4)
  eq(hay.map, "hr_hayford")
  local r = overworld.addSite("hayford_r", { map = "rs_hayford", mx = 2, my = 2, dir = 1 })
  eq(r.x, 106)
  eq(r.y, 65)
  eq(r.when, "ruined")
  local ruined = { flags = { ruined = true } }
  eq(overworld.siteAt(106, 65, ruined).id, "hayford_r")
  eq(overworld.siteAt(106, 65, withFlags({ "finished" })).id, "hayford")
end)

t("the ruined map is 80 rows of 120 known tiles, walkable from end to end", function()
  local ruined = { flags = { ruined = true } }
  eq(#overworld.ROWS_RUINED, 80)
  local seen = flood(62, 60, ruined)
  local n, kinds = 0, {}
  for y, row in ipairs(overworld.ROWS_RUINED) do
    eq(#row, 120, "row " .. y)
    for x = 1, 120 do
      local c = row:sub(x, x)
      truthy(TILES[c] or RUINED_TILES[c], "tile at " .. x .. "," .. y)
      kinds[c] = (kinds[c] or 0) + 1
      if overworld.walkable(x, y, ruined) then
        n = n + 1
        truthy(seen[y * 1000 + x], "cut off at " .. x .. "," .. y)
      end
    end
  end
  truthy(n > 3000, "a whole continent: " .. n)
  for id, at in pairs(SPEC_SITES) do
    truthy(seen[at[2] * 1000 + at[1]], id)
    truthy(overworld.isReachable(at[1], at[2], ruined), id .. " isReachable")
  end
  truthy(kinds.x > 300 and kinds.X > 10 and kinds.t > 200 and kinds.a > 300, "blight, spires, dead wood and ash")
  truthy(kinds.W > 10 and kinds.W < 90, "some of the wall stands: " .. kinds.W)
  eq(kinds.B or 0, 0, "the bridges are gone")
end)

t("the Verdant Sea burned, and blight spires can't be walked", function()
  local ruined = { flags = { ruined = true } }
  local tall, of = 0, 0
  for y = 48, 62 do
    for x = 87, 107 do
      of = of + 1
      if overworld.tileAt(x, y, ruined) == '"' then tall = tall + 1 end
    end
  end
  truthy(tall / of < 0.05, "no grass left: " .. tall)
  local spire
  for y = 1, 80 do
    for x = 1, 120 do
      if overworld.tileAt(x, y, ruined) == "X" then spire = { x, y } end
    end
  end
  eq(overworld.walkable(spire[1], spire[2], ruined), false)
end)

t("regions go by land, and the slice's stretch doesn't move", function()
  local s = withFlags({ "finished" })
  eq(overworld.region(64, 60, s), "road")
  eq(overworld.region(66, 62, s), "heart")
  eq(overworld.region(97, 56, s), "verdant")
  eq(overworld.region(100, 66, s), "heart_east")
  eq(overworld.region(90, 30, s), "shaid")
  eq(overworld.region(36, 27, s), "ebrein")
  eq(overworld.region(45, 9, s), "thuluan")
  eq(overworld.region(30, 50, s), "owlundia")
  eq(overworld.region(10, 10, s), nil)
  eq(overworld.region(60, 45, s), nil)
  local ruined = { flags = { ruined = true } }
  eq(overworld.region(66, 62, ruined), "ruin_south")
  eq(overworld.region(30, 57, ruined), "ruin_west")
  eq(overworld.region(104, 28, ruined), "ruin_north")
  eq(overworld.region(36, 28, ruined), "ruin_north")
  for _, id in ipairs({ "heart", "road", "heart_east", "verdant", "shaid", "ebrein", "thuluan", "owlundia", "ruin_south", "ruin_north", "ruin_west" }) do
    truthy(overworld.REGION_NAME[id], id)
    eq(overworld.REGION_NAME[id]:find("[^%u%s]"), nil, id)
  end
  -- every walkable tile has a field table's name, in both worlds
  local all = withFlags({ "finished", "hr_verdant_open", "hr_done", "wm_bargain", "wm_done", "em_done" })
  for key in pairs(overworld.reach(all)) do truthy(overworld.region(key % 1000, math.floor(key / 1000), all), key) end
  for key in pairs(overworld.reach(ruined)) do truthy(overworld.region(key % 1000, math.floor(key / 1000), ruined), key) end
end)

-- ---------------------------------------------------------------- squares

t("the world knows north and the square ahead", function()
  eq(#world.DIRS, 4)
  eq(world.DIRS[1][2], -1)
  eq(world.DIRS[2][1], 1)
  local x, y = world.ahead({ x = 4, y = 4, dir = 3 })
  eq(x, 4)
  eq(y, 5)
end)

t("walls, doors, stairs and the map's edge", function()
  eq(world.tileAt("street", 1, 1), "W")
  eq(world.tileAt("street", 0, 1), "#")
  eq(world.tileAt("street", 1, 99), "#")
  eq(world.tileAt("nowhere", 1, 1), "#")
  eq(world.solid("street", 1, 1), true)
  eq(world.solid("street", 2, 2), false)
  eq(world.solid("street", 6, 3), true)  -- h
  eq(world.solid("street", 5, 3), true)  -- +
  eq(world.solid("street", 7, 3), false) -- > is walked onto
  eq(world.solid("street", 7, 4), true)  -- L
  local s = state()
  s.opened[world.doorKey("street", 5, 3)] = true
  eq(world.solid("street", 5, 3, s), false)
  eq(world.solid("street", 7, 4, s), true)
end)

-- ---------------------------------------------------------------- the pictures

t("every portrait is 20 by 15 and draws without error", function()
  eq(art.PORTRAIT_W, 20)
  eq(art.PORTRAIT_H, 15)
  for _, id in ipairs(PORTRAIT_IDS) do
    truthy(art.PORTRAITS[id] or art.LOOKS[id], id)
    art.portrait(id, 3, 3)
  end
  for id, face in pairs(art.PORTRAITS) do
    eq(#face, art.LOOKS[id] and 0 or 15, id) -- a look is drawn from its description, and has no rows
    for row, line in ipairs(face) do
      eq(#line, 20, id .. " row " .. row)
      for col = 1, 20 do
        local c = line:sub(col, col)
        truthy(c == "." or c:match("[kgGlwrbBnyovcesm]"), id .. " colour " .. c)
      end
    end
  end
  art.portrait("somebody new", 0, 0)
end)

--- Run fn, and hand back the bounds of everything it filled.
local function filled(fn)
  local real = ui.fill
  local x1, y1, x2, y2 = 999, 999, -1, -1
  ui.fill = function(x, y, w, h, color)
    x1, y1, x2, y2 = math.min(x1, x), math.min(y1, y), math.max(x2, x + w), math.max(y2, y + h)
    return real(x, y, w, h, color)
  end
  local ok, err = pcall(fn)
  ui.fill = real
  if not ok then error(err, 0) end
  return x1, y1, x2, y2
end

t("a portrait fills exactly its own 20 by 15 cells", function()
  for _, id in ipairs(PORTRAIT_IDS) do
    local x1, y1, x2, y2 = filled(function() art.portrait(id, 10, 20) end)
    eq(x1, 10, id)
    eq(y1, 20, id)
    eq(x2, 30, id)
    eq(y2, 35, id)
  end
end)

t("every sprite bakes at every distance it's seen from", function()
  for name in pairs(art.SPRITES) do
    for _, size in ipairs({ { 4, 3 }, { 16, 11 }, { 40, 27 }, { 80, 53 } }) do
      truthy(#art.bake(name, size[1], size[2]) >= 0, name)
    end
  end
  eq(art.spriteName("miner"), "miner")
  eq(art.spriteName("nobody"), "villager")
end)

t("every foe in enemies.lua has a sprite on the map", function()
  local enemies = require("games.blightmare.enemies")
  for id, foe in pairs(enemies.FOES) do truthy(art.SPRITES[foe.sprite], id .. " as " .. tostring(foe.sprite)) end
end)

t("the town and the mine draw from every square, facing every way", function()
  for mapId, map in pairs(stand.DATA) do
    local theme = map.theme
    truthy(scene.THEMES[theme], theme)
    for y, row in ipairs(map.rows) do
      for x = 1, #row do
        for dir = 1, 4 do
          scene.draw(0, 0, state({ map = mapId, x = x, y = y, dir = dir, foes = { { id = "f1", x = 4, y = 4 } } }))
        end
      end
      os.queueEvent("blightmare_world")
      os.pullEvent("blightmare_world")
    end
  end
end)

t("the view keeps inside its rectangle, sprites and all", function()
  eq(scene.VIEW_W, 121)
  truthy(scene.VIEW_H <= 73, "room for the status strip above the wall's bottom edge")
  for mapId, map in pairs(stand.DATA) do
    for y, row in ipairs(map.rows) do
      for x = 1, #row do
        for dir = 1, 4 do
          local x1, y1, x2, y2 = filled(function() scene.draw(0, 0, state({ map = mapId, x = x, y = y, dir = dir })) end)
          truthy(x1 >= 0 and y1 >= 0 and x2 <= scene.VIEW_W and y2 <= scene.VIEW_H, mapId .. " " .. x .. "," .. y)
        end
      end
    end
  end
end)

t("an opened door is a gap, and an open chest stays there but changes", function()
  local baked = {}
  local real = art.bake
  art.bake = function(name, ...)
    baked[name] = true
    return real(name, ...)
  end
  local ok, err = pcall(function()
    local shut = state({ map = "street", x = 5, y = 4, dir = 1 })
    local _, top = filled(function() scene.draw(0, 0, shut) end)
    truthy(top ~= nil)
    local s = state({ map = "street", x = 5, y = 5, dir = 2 })
    scene.draw(0, 0, s)
    truthy(baked.chest, "the chest two squares ahead")
    baked = {}
    s.opened["street:c1"] = true
    scene.draw(0, 0, s)
    truthy(baked.openChest, "opened")
    truthy(not baked.chest, "no longer shut")
    -- a door shuts the view behind it, and opening it lets the eye through to what's in the next square
    local look = state({ map = "shaft", x = 5, y = 5, dir = 1 })
    eq(world.solid("shaft", 5, 3, look), true)
    baked = {}
    scene.draw(0, 0, state({ map = "street", x = 5, y = 5, dir = 1, foes = {} }))
    truthy(not baked.miner, "nobody out")
    baked = {}
    scene.draw(0, 0, state({ map = "street", x = 3, y = 2, dir = 2, foes = { { id = "f1", x = 6, y = 2 } } }))
    truthy(baked.miner, "a live foe is drawn from s.foes")
    baked = {}
    scene.draw(0, 0, state({ map = "street", x = 2, y = 5, dir = 2, foes = {} }))
    truthy(baked.doctor, "an npc whose flag passes")
    truthy(not baked.gnome, "and not one whose flag doesn't")
    truthy(baked.villager, "someone not yet drawn looks like a villager")
  end)
  art.bake = real
  if not ok then error(err, 0) end
end)

t("drawWalk draws every party size, with the hurt frame, on both themes", function()
  for _, mapId in ipairs({ "street", "shaft" }) do
    for n = 1, 4 do
      local s = state({ map = mapId, x = 2, y = 2, dir = 3 })
      s.party = {}
      for i = 1, n do s.party[i] = party.new(({ "hero", "deserter", "cleric", "jezzara" })[i], 3) end
      s.party[1].hp = 1
      s.fx.hurt = 2
      s.rev = n
      view.drawWalk(L, s)
      view.drawWalk(L, s)
    end
  end
end)

t("drawWalk paints once for each rev, and the status strip stays clear of SAVE & QUIT", function()
  local fills, real = 0, ui.fill
  ui.fill = function(...)
    fills = fills + 1
    return real(...)
  end
  local s = state({ rev = 77, x = 3, y = 2, dir = 3 })
  local ok, err = pcall(function()
    view.drawWalk(L, s)
    local painted = fills
    truthy(painted > 100, "painted the first time")
    fills = 0
    view.drawWalk(L, s)
    view.drawWalk(L, s)
    eq(fills, 0, "a copy, not a repaint")
    s.rev = 78
    view.drawWalk(L, s)
    truthy(fills > 100, "painted again when the rev moves")
  end)
  ui.fill = real
  if not ok then error(err, 0) end
end)

t("the pictures stay cheap: fills for a frame, once baked", function()
  local fills, real = 0, ui.fill
  ui.fill = function(...)
    fills = fills + 1
    return real(...)
  end
  local worst = {}
  local ok, err = pcall(function()
    for mapId, map in pairs(stand.DATA) do
      worst[mapId] = 0
      for y, row in ipairs(map.rows) do
        for x = 1, #row do
          for dir = 1, 4 do
            fills = 0
            scene.draw(0, 0, state({ map = mapId, x = x, y = y, dir = dir }))
            worst[mapId] = math.max(worst[mapId], fills)
          end
        end
      end
    end
    fills = 0
    view.drawWorld(L, state({ mode = "world", wx = 70, wy = 50, rev = 901 }))
    worst.world = fills
  end)
  ui.fill = real
  if not ok then error(err, 0) end
  print("fills a frame: town " .. worst.street .. ", mine " .. worst.shaft .. ", world " .. worst.world)
  truthy(worst.street < 12000, "town " .. worst.street)
  truthy(worst.shaft < 12000, "mine " .. worst.shaft)
  truthy(worst.world < 2500, "world " .. worst.world)
end)

t("drawWorld draws everywhere the party can stand, and at the edges of the map", function()
  local first = overworld.SITES[1]
  local n = 0
  for key in pairs(flood(first.x, first.y)) do
    n = n + 1
    if n % 25 == 0 then
      local s = state({ mode = "world", wx = key % 1000, wy = math.floor(key / 1000), rev = n, heading = n % 4 + 1 })
      view.drawWorld(L, s)
      os.queueEvent("blightmare_world")
      os.pullEvent("blightmare_world")
    end
  end
  for _, at in ipairs({ { 1, 1 }, { 120, 1 }, { 1, 80 }, { 120, 80 } }) do
    view.drawWorld(L, state({ mode = "world", wx = at[1], wy = at[2], rev = at[1] + at[2] }))
  end
end)

t("tall grass hides the map: a far site can't be seen from inside it", function()
  local shown = {}
  local real = ui.small
  ui.small = function(str, ...)
    shown[#shown + 1] = str
    return real(str, ...)
  end
  local ok, err = pcall(function()
    view.drawWorld(L, state({ mode = "world", wx = 66, wy = 60, rev = 501 }))
    local near = table.concat(shown, "|")
    truthy(near:find("SCYTHEBREAK", 1, true), "out on the road its name shows")
    shown = {}
    local x, y
    for key in pairs(flood(overworld.SITES[1].x, overworld.SITES[1].y)) do
      local kx, ky = key % 1000, math.floor(key / 1000)
      if overworld.tileAt(kx, ky) == '"' and math.abs(kx - 67) <= 7 and math.abs(ky - 44) <= 7 then x, y = kx, ky end
    end
    truthy(x, "tall grass near Orrenshire")
    view.drawWorld(L, state({ mode = "world", wx = x, wy = y, rev = 502 }))
    truthy(not table.concat(shown, "|"):find(" ORRENSHIRE ", 1, true), "the town's name is hidden")
  end)
  ui.small = real
  if not ok then error(err, 0) end
end)

t("the region's name is on the wall", function()
  local shown = {}
  local real = ui.small
  ui.small = function(str, ...)
    shown[#shown + 1] = str
    return real(str, ...)
  end
  local ok, err = pcall(function()
    view.drawWorld(L, state({ mode = "world", wx = 66, wy = 62, rev = 601 }))
    truthy(table.concat(shown, "|"):find(overworld.REGION_NAME.heart, 1, true))
  end)
  ui.small = real
  if not ok then error(err, 0) end
end)

t("the ruined world draws, stays cheap, and every new tile is painted", function()
  local fills, real = 0, ui.fill
  ui.fill = function(...)
    fills = fills + 1
    return real(...)
  end
  local worst = 0
  local ok, err = pcall(function()
    local flags = { ruined = true }
    local n = 0
    for key in pairs(overworld.reach({ flags = flags })) do
      n = n + 1
      if n % 40 == 0 then
        fills = 0
        view.drawWorld(L, state({ mode = "world", wx = key % 1000, wy = math.floor(key / 1000), rev = 1000 + n, flags = flags }))
        worst = math.max(worst, fills)
        os.queueEvent("blightmare_world")
        os.pullEvent("blightmare_world")
      end
    end
  end)
  ui.fill = real
  if not ok then error(err, 0) end
  print("fills a frame, ruined: " .. worst)
  -- the worst of many frames, so a screen full of mountains, where the check above is one spot on the plain
  truthy(worst < 3000, "ruined " .. worst)
end)

t("a gate shows, and goes when it's open", function()
  local fills = {}
  local real = ui.fill
  ui.fill = function(x, y, w, h, color)
    if color == ui.C.red then fills[#fills + 1] = true end
    return real(x, y, w, h, color)
  end
  local ok, err = pcall(function()
    view.drawWorld(L, state({ mode = "world", wx = 78, wy = 52, rev = 2001 }))
    local shut = #fills
    fills = {}
    view.drawWorld(L, state({ mode = "world", wx = 78, wy = 52, rev = 2002, flags = { finished = true } }))
    truthy(shut > #fills, "fewer red bars once it's open")
  end)
  ui.fill = real
  if not ok then error(err, 0) end
end)

t("a site's name shows only once it's open", function()
  local shown = {}
  local real = ui.small
  ui.small = function(str, ...)
    shown[#shown + 1] = str
    return real(str, ...)
  end
  local ok, err = pcall(function()
    view.drawWorld(L, state({ mode = "world", wx = 107, wy = 49, rev = 2101 }))
    truthy(not table.concat(shown, "|"):find("OPLINAS", 1, true), "closed")
    shown = {}
    view.drawWorld(L, state({ mode = "world", wx = 107, wy = 49, rev = 2102, flags = { finished = true } }))
    truthy(table.concat(shown, "|"):find("OPLINAS", 1, true), "open")
  end)
  ui.small = real
  if not ok then error(err, 0) end
end)

t("the automap treats a drop as open, not as a door", function()
  stand.DATA.pit = { name = "PIT", theme = "town", rows = { "#####", "#.~.#", "#...#", "#####" } }
  view.drawWalk(L, state({ map = "pit", x = 2, y = 3, dir = 1, rev = 2201 }))
  stand.DATA.pit = nil
end)

-- ---------------------------------------------------------------- looks

--- Each person's description as text, with only what was written down: the same text means the same picture.
local function described(look)
  local keys = {}
  for k in pairs(look) do
    if k ~= "settled" then keys[#keys + 1] = k end
  end
  table.sort(keys)
  local out = {}
  for _, k in ipairs(keys) do
    local v = look[k]
    out[#out + 1] = k .. "=" .. (type(v) == "table" and table.concat(v, "+") or tostring(v))
  end
  return table.concat(out, ";")
end

--- A person's outline at the size they're seen three squares away: which cells they fill, as a string.
local function outlineOf(id, w, h)
  local runs = art.bake("look:" .. id, w, h, nil, "outline")
  local cells = {}
  for i = 1, w * h do cells[i] = 0 end
  for i = 1, #runs, 4 do
    for col = runs[i], runs[i] + runs[i + 2] - 1 do cells[runs[i + 1] * w + col + 1] = 1 end
  end
  return cells
end

-- A region's people are told apart on their own maps, further down: with hundreds of them, two strangers a continent apart can match.
local function fromRegion(id) return id:match("^%a%a_") ~= nil end

t("looks hold their people apart: nobody shares a description, by text", function()
  local seen = {}
  for id, look in pairs(art.LOOKS) do
    local text = fromRegion(id) and id or described(look)
    truthy(not seen[text], id .. " is described the same as " .. tostring(seen[text]))
    seen[text] = id
  end
end)

t("every look bakes as a sprite at every size, near, faded and flashing", function()
  for id in pairs(art.LOOKS) do
    local name = art.lookSprite(id)
    truthy(art.SPRITES[name], id)
    for row = 1, 5 do
      local w, h = math.floor(80 / row * art.SPRITES[name].size + 0.5), math.floor(53 / row * art.SPRITES[name].size + 0.5)
      truthy(#art.bake(name, w, h) > 0, id .. " at " .. w .. "x" .. h)
      truthy(#art.bake(name, w, h, { [ui.C.text] = ui.C.line }, "test") > 0, id .. " remapped")
    end
    os.queueEvent("blightmare_world")
    os.pullEvent("blightmare_world")
  end
end)

t("every look stands in a town and in a mine, seen from each distance", function()
  for _, theme in ipairs({ "town", "mine" }) do
    for id in pairs(art.LOOKS) do
      stand.DATA.looks = { name = "LOOKS", theme = theme, rows = { "#########", "#.......#", "#.......#", "#.......#", "#.......#", "#.......#", "#########" },
        npcs = { { id = id, x = 4, y = 3, sprite = "villager" } } }
      for far = 1, 3 do
        scene.draw(0, 0, state({ map = "looks", x = 4, y = 3 + far, dir = 1 }))
      end
      os.queueEvent("blightmare_world")
      os.pullEvent("blightmare_world")
    end
  end
  stand.DATA.looks = nil
end)

t("scene draws a person's own look, and falls back to the map's sprite", function()
  local baked = {}
  local real = art.bake
  art.bake = function(name, ...)
    baked[name] = true
    return real(name, ...)
  end
  local ok, err = pcall(function()
    stand.DATA.looks = { name = "LOOKS", theme = "town", rows = { "#####", "#...#", "#...#", "#...#", "#####" },
      npcs = { { id = "nan", x = 3, y = 2, sprite = "shroud" }, { id = "nobody_yet", x = 3, y = 3, sprite = "doctor" } } }
    scene.draw(0, 0, state({ map = "looks", x = 3, y = 4, dir = 1 }))
    truthy(baked["look:nan"], "a look wins over the sprite field")
    truthy(not baked.shroud, "and the sprite field isn't drawn")
    truthy(baked.doctor, "no look: the map's sprite stands")
  end)
  art.bake = real
  stand.DATA.looks = nil
  if not ok then error(err, 0) end
end)

t("every look is a portrait of exactly 20 by 15", function()
  for id in pairs(art.LOOKS) do
    local x1, y1, x2, y2 = filled(function() art.portrait(id, 4, 6) end)
    eq(x1, 4, id)
    eq(y1, 6, id)
    eq(x2, 24, id)
    eq(y2, 21, id)
  end
end)

t("a portrait is baked once", function()
  local fills, real = 0, ui.fill
  art.portrait("nan", 0, 0)
  ui.fill = function(...)
    fills = fills + 1
    return real(...)
  end
  local ok, err = pcall(function()
    local first = art.bake("look:nan", 40, 27)
    eq(art.bake("look:nan", 40, 27), first, "the same runs, not new ones")
    art.portrait("nan", 0, 0)
    truthy(fills > 0 and fills < 225, "a short list of runs: " .. fills)
  end)
  ui.fill = real
  if not ok then error(err, 0) end
end)

t("different people have different outlines at wall size", function()
  -- the same person in the queue or the ward is meant to match, and twins nearly do: they're mirrored, and the test allows that
  local ids = {}
  for id, look in pairs(art.LOOKS) do
    if look.pose ~= "lying" and not id:match("^[qn]_") and id ~= "wick_changed" and not fromRegion(id) then ids[#ids + 1] = id end
  end
  table.sort(ids)
  local shapes = {}
  for _, id in ipairs(ids) do shapes[id] = outlineOf(id, 20, 14) end
  local pairsSeen = {}
  for i = 1, #ids do
    for j = i + 1, #ids do
      local a, b, differ = shapes[ids[i]], shapes[ids[j]], 0
      for c = 1, #a do
        if a[c] ~= b[c] then differ = differ + 1 end
      end
      pairsSeen[#pairsSeen + 1] = { differ, ids[i] .. " and " .. ids[j] }
    end
    os.queueEvent("blightmare_world")
    os.pullEvent("blightmare_world")
  end
  table.sort(pairsSeen, function(p, q) return p[1] < q[1] end)
  for i = 1, 8 do print("close outlines: " .. pairsSeen[i][2] .. ", " .. pairsSeen[i][1]) end
  truthy(pairsSeen[1][1] >= 6, pairsSeen[1][2] .. " are only " .. pairsSeen[1][1] .. " cells apart")
end)

t("the Clinic are one group: beaks and grey, told apart by rank", function()
  local beaks = 0
  for _, id in ipairs({ "corner", "doorman", "gateman", "chalker", "satchel", "bascombe", "captain", "doctor", "handler_big" }) do
    local look = art.LOOKS[id]
    truthy(look and look.beak, id .. " wears the beak")
    beaks = beaks + 1
  end
  truthy(art.LOOKS.doctor.beak > art.LOOKS.corner.beak and art.LOOKS.corner.beak > art.LOOKS.gateman.beak, "the longer the beak, the higher the rank")
  truthy(beaks == 9)
  truthy(not art.LOOKS.watch.beak, "the lad on the wall has his down, for the bread")
end)

t("gnomes are clearly short, and nobody tall is", function()
  for id, look in pairs(art.LOOKS) do
    if look.kind == "gnome" and look.pose ~= "lying" then truthy(look.tall <= 0.62, id .. " is too tall for a gnome") end
    if look.kind == "human" and look.pose ~= "lying" and not fromRegion(id) then truthy(look.tall >= 0.74, id .. " is too short for a person") end
  end
end)

t("a talk box finds the person: by name, by who you're facing, then by the script's id", function()
  eq(art.faceFor("villager", "NAN"), "nan")
  eq(art.faceFor("villager", "NAN", "w_nan"), "nan")
  eq(art.faceFor("gnome", "NIB", "nib"), "nib")
  eq(art.faceFor("villager", "GENTLEMAN BOGG", "frog"), "frog")
  eq(art.faceFor("gnome", "GNOME", "chair"), "chair")
  eq(art.faceFor("villager", "VILLAGER", "widow"), "widow")
  eq(art.faceFor("captain", "SOLDIER", "watch"), "watch")
  eq(art.faceFor("captain", "SOLDIER"), "corner")
  eq(art.faceFor("doctor", "ORDERLY", "gateman"), "gateman")
  eq(art.faceFor("gnome", "GNOME"), "gnome")
  eq(art.faceFor("gnome", "GNOME", "nobody_yet"), "gnome")
  eq(art.faceFor("deserter", "DESERTER", "chair"), "deserter") -- speaking to someone isn't being them
  eq(art.faceFor("mayor", "MAYOR", "innkeeper"), "mayor")
end)

-- ---------------------------------------------------------------- the real maps, once they're there

if realMaps then
  t("every npc on every real map has a look of their own", function()
    local count = 0 -- the same id on two maps is one person who travels, and rightly looks the same
    for mapId, map in pairs(realMaps.DATA) do
      for _, n in ipairs(map.npcs or {}) do
        -- a wheel or a chained book is a thing, and something the artist drew whole brings its own picture: neither needs a look
        if not art.isProp(n.sprite) then
          truthy(art.LOOKS[n.id] or art.PORTRAITS[n.id] or art.drawnWhole(n.sprite), mapId .. ": " .. n.id .. " has no look")
          count = count + 1
        end
      end
    end
    truthy(count >= 50, "the town is full: " .. count)
    print("npcs with looks: " .. count)
  end)

  t("no two npcs have the same description", function()
    for mapId, map in pairs(realMaps.DATA) do
      local seen = {}
      for _, n in ipairs(map.npcs or {}) do
        -- someone with a when or unless may be the same person before and after, and a look with empty is a piece of furniture
        local look = art.LOOKS[n.id]
        if look and not look.empty and not n.when and not n.unless then
          local text = described(look)
          truthy(not seen[text], mapId .. ": " .. n.id .. " is described the same as " .. tostring(seen[text]))
          seen[text] = n.id
        end
      end
    end
  end)

  t("every name spoken in the story finds a look, and every say id a face", function()
    local story = require("games.blightmare.story")
    local names, walked = {}, {}
    local function walk(steps)
      if type(steps) ~= "table" or walked[steps] then return end
      walked[steps] = true
      if steps.say then
        truthy(art.LOOKS[steps.say] or art.PORTRAITS[steps.say], "say " .. tostring(steps.say))
        if steps.name then names[steps.name] = steps.say end
      end
      for _, v in pairs(steps) do walk(v) end
    end
    walk(story.SCRIPTS)
    local n = 0
    for name, say in pairs(names) do
      n = n + 1
      truthy(art.LOOKS[art.faceFor(say, name)] or art.PORTRAITS[art.faceFor(say, name)], "nobody looks like " .. name)
    end
    truthy(n >= 15, "names found: " .. n)
  end)

  t("the talk box shows the person in front of you, not the portrait they borrowed", function()
    package.loaded["games.blightmare.maps"] = realMaps
    local rules = require("games.blightmare.rules")
    local talk = require("games.blightmare.view_talk")
    local shown
    local realPortrait, realTalk = art.portrait, rules.talk
    art.portrait = function(id, ...)
      shown = id
      return realPortrait(id, ...)
    end
    local line = { say = "gnome", name = "GNOME", lines = { "It's a technique." } }
    rules.talk = function() return line end
    local ok, err = pcall(function()
      local chair
      for _, n in ipairs(realMaps.DATA.orrenshire.npcs) do
        if n.id == "chair" then chair = n end
      end
      -- stand just west of the Chair and face east
      local s = state({ map = "orrenshire", x = chair.x - 1, y = chair.y, dir = 2, run = { back = "walk" } })
      talk.draw(L, s)
      eq(shown, "chair")
      s.dir = 4
      talk.draw(L, s)
      eq(shown, "gnome", "facing away, the line keeps its own face")
      line = { say = "deserter", name = "DESERTER", lines = { "Friend." } }
      s.dir = 2
      talk.draw(L, s)
      eq(shown, "deserter")
    end)
    art.portrait, rules.talk = realPortrait, realTalk
    package.loaded["games.blightmare.maps"] = stand
    if not ok then error(err, 0) end
  end)

  t("the real maps have the ids, the themes, and exits and sites that agree", function()
    for _, id in ipairs({ "scythebreak", "orrenshire", "mine_1", "mine_2", "mine_3" }) do
      local map = realMaps.DATA[id]
      truthy(map, id)
      truthy(scene.THEMES[map.theme], id .. " theme")
    end
    for _, site in ipairs(overworld.sites()) do
      local map = realMaps.DATA[site.map]
      local row = map.rows[site.my]
      truthy(row, site.id .. " arrival row")
      local c = row:sub(site.mx, site.mx)
      truthy(c == "." or c == ">", site.id .. " arrives on a floor square, not " .. c)
    end
    for id, map in pairs(realMaps.DATA) do
      for _, e in ipairs(map.exits or {}) do
        if e.world then
          local late = { flags = { finished = true, hr_verdant_open = true, hr_done = true, wm_bargain = true, wm_done = true, em_done = true } }
          truthy(overworld.walkable(e.world[1], e.world[2], late) or overworld.walkable(e.world[1], e.world[2], { flags = { ruined = true } }), id .. " exit lands on ground")
        end
      end
    end
  end)

  t("the real maps draw from every floor square", function()
    package.loaded["games.blightmare.maps"] = realMaps
    for id, map in pairs(realMaps.DATA) do
      for y, row in ipairs(map.rows) do
        for x = 1, #row do
          if row:sub(x, x) == "." then scene.draw(0, 0, state({ map = id, x = x, y = y, dir = (x + y) % 4 + 1 })) end
        end
        os.queueEvent("blightmare_world")
        os.pullEvent("blightmare_world")
      end
    end
    package.loaded["games.blightmare.maps"] = stand
  end)

  t("every sprite a real map names has been drawn", function()
    for id, map in pairs(realMaps.DATA) do
      for _, n in ipairs(map.npcs or {}) do truthy(art.SPRITES[n.sprite] or art.LOOKS[n.id], id .. " " .. n.id .. " " .. tostring(n.sprite)) end
      for _, f in ipairs(map.foes or {}) do truthy(art.SPRITES[f.sprite], id .. " " .. tostring(f.sprite)) end
    end
  end)
end
