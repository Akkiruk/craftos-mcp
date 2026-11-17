-- BLIGHTMARE's pictures for the whole game: every theme, tile, ground, look and foe paints, stays in its box, doesn't cost much, and
-- none of them can be crashed by a name that hasn't been drawn yet.
local kit = loadfile(fs.combine(fs.getDir(fs.getDir(shell.getRunningProgram())), "testkit.lua"), nil, _ENV)()
local t, eq, truthy = ccunit.test, ccunit.eq, ccunit.truthy

local surfaceApi = require("lib.surface")
local font = surfaceApi.loadFont(surfaceApi.load("/" .. fs.combine(kit.root, "lib/font")))
local ui = require("lib.ui")
ui.init(surfaceApi, font, surfaceApi.create(121, 81))

local THEMES = { "town", "mine", "city", "marble", "swamp", "grass", "ruin", "cave", "web", "coral", "chain", "ash", "dream", "library" }
local GROUNDS = { "grass", "town", "mine", "city", "marble", "swamp", "ruin", "cave", "web", "brine", "chain", "snow", "ash", "dream" }
local CAST = { "owlin", "jezzara", "asphodel", "colette", "colette_changed", "fabian", "sindal", "barnabas", "ceiridwen", "lucilda", "vierrela", "halryna", "murgrum", "sevria", "father" }
local KINDS = { "vampire", "tiefling", "drow", "drider", "duergar", "deepgnome", "illithid", "gith", "hag", "harpyfolk", "tabaxi", "nothic" }
local FOES = { "mindflayer", "vampire_knight", "thrall", "drider", "ettercap", "owl_beast", "nothic", "chain_worm", "tyamet", "qarhuul", "colette_changed", "vierrela_husk", "chylbad", "plague_surgeon",
  "leech", "bat", "skeleton", "harpy_queen", "hooded" }

-- every tile there is, a bridge over a drop, and someone on the far side of it
local rows = {
  "###################",
  "#.................#",
  "#.h#+#h.L.#>#.....#",
  "#.................#",
  "#.~~~.~~~~~~~.....#",
  "#.~~~.~~~~~~~..W..#",
  "#.~~~.~~~~~~~.....#",
  "#.................#",
  "###################",
}
local data = {}
for _, theme in ipairs(THEMES) do
  data[theme] = {
    name = theme, theme = theme, rows = rows,
    npcs = { { id = "sindal", x = 3, y = 8, sprite = "villager" }, { id = "nobody", x = 5, y = 2, sprite = "not drawn yet" } },
    chests = { { id = "c", x = 10, y = 8, give = "potion" } },
    foes = { { id = "f1", x = 4, y = 2, enc = "x", sprite = "chain_worm" }, { id = "f2", x = 16, y = 2, enc = "x", sprite = "not drawn yet" } },
  }
end
data.mystery = { name = "mystery", theme = "a theme nobody has written", rows = rows }

local realMaps = package.loaded["games.blightmare.maps"]
package.loaded["games.blightmare.maps"] = { DATA = data }
local world = require("games.blightmare.world")
local art = require("games.blightmare.art")
local scene = require("games.blightmare.scene")
local battle = require("games.blightmare.art_battle")

local function state(map, x, y, dir)
  return { map = map, x = x, y = y, dir = dir, flags = {}, opened = {}, beaten = {}, fx = { flash = 0 }, foes = { { id = "f1", x = 4, y = 2 }, { id = "f2", x = 16, y = 2 } } }
end

--- Runs fn with every fill counted and the box they fall in measured.
local function measured(fn)
  local real = ui.fill
  local n, x1, y1, x2, y2 = 0, 1e9, 1e9, -1e9, -1e9
  local marks = {}
  ui.fill = function(x, y, w, h, color)
    if w > 0 and h > 0 then
      n = n + 1
      x1, y1, x2, y2 = math.min(x1, x), math.min(y1, y), math.max(x2, x + w), math.max(y2, y + h)
      marks[#marks + 1] = x .. "," .. y .. "," .. w .. "," .. h .. "," .. color
    end
  end
  local ok, err = pcall(fn)
  ui.fill = real
  if not ok then error(err, 0) end
  return { n = n, x1 = x1, y1 = y1, x2 = x2, y2 = y2, marks = marks }
end

local function breathe()
  os.queueEvent("blightmare_art")
  os.pullEvent("blightmare_art")
end

t("every theme there's meant to be exists, and each paints from every square, facing every way, inside the view", function()
  for _, theme in ipairs(THEMES) do
    truthy(scene.THEMES[theme], theme)
    for y, row in ipairs(rows) do
      for x = 1, #row do
        if not world.solid(theme, x, y) then
          for dir = 1, 4 do
            local m = measured(function() scene.draw(0, 0, state(theme, x, y, dir)) end)
            truthy(m.x1 >= 0 and m.y1 >= 0 and m.x2 <= scene.VIEW_W and m.y2 <= scene.VIEW_H, theme .. " at " .. x .. "," .. y)
          end
        end
      end
      breathe()
    end
  end
end)

t("the first look at a theme is cheap, and after that a view is only a short list of fills", function()
  for _, theme in ipairs(THEMES) do
    if theme ~= "town" and theme ~= "mine" then
      local most = 0
      for y = 2, 8, 2 do
        for dir = 1, 4 do
          most = math.max(most, measured(function() scene.draw(0, 0, state(theme, 6, y, dir)) end).n)
        end
      end
      truthy(most < 9000, theme .. " paints " .. most .. " fills at most")
    end
  end
  -- a theme not yet seen by anybody, faces and all, against the clock
  local started = os.epoch("utc")
  scene.draw(0, 0, state("chain", 13, 8, 4))
  truthy(os.epoch("utc") - started < 1500, "one frame")
end)

t("no two themes look alike", function()
  local seen = {}
  for _, theme in ipairs(THEMES) do
    local m = measured(function() scene.draw(0, 0, state(theme, 2, 4, 2)) end)
    local print = table.concat(m.marks, ";")
    truthy(not seen[print], theme .. " looks the same as " .. tostring(seen[print]))
    seen[print] = theme
  end
end)

t("a map with a theme nobody has written still draws", function()
  scene.draw(0, 0, state("mystery", 6, 4, 1))
end)

t("~ stops your feet and not your eye", function()
  eq(world.solid("chain", 3, 5), true)
  local baked = {}
  local real = art.bake
  art.bake = function(name, ...)
    baked[name] = true
    return real(name, ...)
  end
  local ok, err = pcall(function()
    -- across the whole drop to someone standing on the far bank, in a theme with no sky to help
    local s = state("library", 3, 8, 1)
    data.library.rows = { "#######", "#.....#", "#.....#", "#.....#", "#.~~~.#", "#.~~~.#", "#.~~~.#", "#.....#", "#######" }
    s.foes = { { id = "f1", x = 3, y = 4 } }
    scene.draw(0, 0, s)
    truthy(baked.chain_worm, "the far bank")
  end)
  art.bake = real
  data.library.rows = rows
  if not ok then error(err, 0) end
end)

t("the slice's maps have no drops in them", function()
  if realMaps then
    for id, map in pairs(realMaps.DATA) do
      if not id:find("_", 1, true) or map.theme == "town" or map.theme == "mine" then
        for _, row in ipairs(map.rows) do truthy(not row:find("~", 1, true), id) end
      end
    end
  end
end)

t("every battle ground stays on the field, and a ground nobody drew is the mine", function()
  local mine
  for _, bg in ipairs(GROUNDS) do
    truthy(battle.GROUNDS[bg], bg)
    local m = measured(function() battle.ground(bg, 0, 7, 121, 49) end)
    truthy(m.x1 >= 0 and m.y1 >= 7 and m.x2 <= 121 and m.y2 <= 56, bg .. " stays on the field")
    truthy(m.n < 800, bg .. " is " .. m.n .. " fills")
    if bg == "mine" then mine = table.concat(m.marks, ";") end
  end
  eq(table.concat(measured(function() battle.ground("somewhere new", 0, 7, 121, 49) end).marks, ";"), mine)
  eq(table.concat(measured(function() battle.ground(nil, 0, 7, 121, 49) end).marks, ";"), mine)
end)

t("every foe that's certain is drawn, reads at each size, and differs from the rest", function()
  local seen = {}
  for _, name in ipairs(FOES) do
    truthy(battle.SPRITES[name], name)
    for _, size in ipairs({ { 22, 18 }, { 34, 23 }, { 50, 34 }, { 60, 40 } }) do
      truthy(#battle.bake(name, size[1], size[2]) > 8, name)
      battle.bake(name, size[1], size[2], "flash")
      battle.bake(name, size[1], size[2], "dim")
    end
    local key = table.concat(battle.bake(name, 34, 23), ",")
    truthy(not seen[key], name .. " and " .. tostring(seen[key]))
    seen[key] = name
  end
end)

t("a foe with no sprite yet is a hooded shape, in a fight and on a map", function()
  eq(table.concat(battle.bake("not drawn yet", 30, 20), ","), table.concat(battle.bake("hooded", 30, 20), ","))
  battle.draw("not drawn yet", 0, 0, 30, 20, "flash")
  eq(art.spriteName("not drawn yet", true), "hooded")
  eq(art.spriteName("not drawn yet"), "villager")
  truthy(art.SPRITES.hooded)
  for _, name in ipairs(FOES) do truthy(art.SPRITES[name], name .. " on a map") end
end)

t("everything the regions asked for is drawn, for a fight and a map", function()
  local foes = require("games.blightmare.art_foes")
  local content = require("games.blightmare.content")
  local asked = 0
  for _, region in ipairs(content.regions()) do
    for name in pairs(region.art or {}) do
      asked = asked + 1
      truthy(foes.SPRITES[name], region.id .. " asked for " .. name)
    end
  end
  print("sprites the regions asked for: " .. asked)
  local n, seen = 0, {}
  for name, build in pairs(foes.SPRITES) do
    n = n + 1
    truthy(battle.SPRITES[name] == build, name .. " in battle")
    truthy(art.SPRITES[name], name .. " on a map")
    for _, size in ipairs({ { 22, 18 }, { 30, 20 }, { 50, 34 }, { 58, 45 } }) do truthy(#battle.bake(name, size[1], size[2]) >= 4, name) end
    truthy(#art.bake(name, 40, 26) >= 4, name)
    local key = table.concat(battle.bake(name, 34, 23), ",")
    truthy(not seen[key], name .. " and " .. tostring(seen[key]) .. " are the same picture")
    seen[key] = name
    if n % 10 == 0 then breathe() end
  end
  truthy(art.isProp("px_wheel"), "a wheel is a thing")
  truthy(not art.isProp("px_leech"), "a leech is not")
end)

t("the cast and every kind have a face and a body, all the same size of picture", function()
  local ids = { "qarhuul", "deserter", "cleric", "owlin", "hero" }
  for _, id in ipairs(CAST) do ids[#ids + 1] = id end
  for _, kind in ipairs(KINDS) do
    art.addLooks({ ["px_kind_" .. kind] = { kind = kind } })
    ids[#ids + 1] = "px_kind_" .. kind
  end
  for _, id in ipairs(ids) do
    truthy(art.PORTRAITS[id], id)
    local m = measured(function() art.portrait(id, 10, 20) end)
    eq(m.x1, 10, id)
    eq(m.y1, 20, id)
    eq(m.x2, 30, id)
    eq(m.y2, 35, id)
    if art.LOOKS[id] then truthy(#art.bake("look:" .. id, 30, 40) > 8, id) end
  end
end)

t("every look there is bakes, and the big sprites stay cheap enough", function()
  local n = 0
  for id in pairs(art.LOOKS) do
    art.bake("look:" .. id, 40, 26)
    art.portrait(id, 0, 0)
    n = n + 1
    if n % 20 == 0 then breathe() end
  end
  truthy(n > 100, "a game's worth")
end)

t("a region's looks go everywhere at once, colours by name, starting from someone else if it likes", function()
  art.addLooks({
    px_test = { kind = "vampire", coat = "red", hairInk = "hi", hair = "long", wear = { "ribbon", "a thing nobody drew" }, carry = "not a thing", hat = "not a hat" },
    px_changed = { like = "px_test", coat = "soft", blight = true, carry = "none" },
    px_stranger = { kind = "a kind nobody drew", build = "not a build", cut = "not a cut", eyes = "?", mouth = "?" },
    px_cloud = {},
  }, { ["MISTER TEST"] = "px_test" })
  eq(art.LOOKS.px_test.coat, ui.C.red)
  eq(art.LOOKS.px_changed.coat, ui.C.soft)
  eq(art.LOOKS.px_changed.hairInk, ui.C.hi)
  eq(art.NAMES["MISTER TEST"], "px_test")
  for _, id in ipairs({ "px_test", "px_changed", "px_stranger", "px_cloud" }) do
    truthy(art.PORTRAITS[id], id)
    eq(art.lookSprite(id), "look:" .. id)
    truthy(art.SPRITES["look:" .. id], id)
    art.portrait(id, 0, 0)
    truthy(#art.bake("look:" .. id, 30, 40) > 0, id)
    eq(#art.PORTRAITS[id], 0, "a look has no rows")
  end
  eq(art.faceFor("villager", "MISTER TEST"), "px_test")
  art.addLooks(nil, nil)
  -- said again, the new one wins, in the picture too
  local before = table.concat(art.bake("look:px_cloud", 30, 40), ",")
  art.addLooks({ px_cloud = { kind = "illithid", coat = "accent" } })
  truthy(table.concat(art.bake("look:px_cloud", 30, 40), ",") ~= before, "baked afresh")
end)

t("the wear, the carry and the kinds the regions were promised are all there", function()
  art.addLooks({
    px_a = { kind = "human", wear = { "ribbon", "sash", "surgeon", "blood", "armour", "fur", "rags", "necklace" }, carry = "saw", hat = "thorns" },
    px_b = { kind = "clinic", beak = 0.14, beakStyle = "hook", hat = "circlet", carry = "scalpel" },
    px_c = { kind = "clinic", beak = 0.08, beakStyle = "snout", hat = "crown", carry = "tome" },
    px_d = { kind = "clinic", beak = 0.1, beakStyle = "brass", beakInk = "hi", hat = "mitre", carry = "eye" },
    px_e = { kind = "human", tail = "cat", wings = "red", tendrils = true, horns = "spike", lower = "spider", hat = "tricorn", carry = "goblet", mark = "scar" },
  })
  for _, id in ipairs({ "px_a", "px_b", "px_c", "px_d", "px_e" }) do
    art.portrait(id, 0, 0)
    truthy(#art.bake("look:" .. id, 30, 40) > 20, id)
  end
end)

package.loaded["games.blightmare.maps"] = realMaps

t("every picture of the opening draws at every tick it moves and long after, in its box, with sounds that exist", function()
  local intro = require("games.blightmare.intro")
  local picks = require("lib.sound").SOUNDS
  local L = { W = 121, H = 81 }
  for pic in pairs(intro.PICS) do
    local length = intro.length(pic)
    local last = length == true and 120 or (length or 0) + 3
    for tick = 0, last do intro.draw(L, pic, tick) end
    intro.draw(L, pic, 5000)
    for _, cue in ipairs(intro.cues(pic)) do
      truthy(type(cue[1]) == "number" and cue[1] >= 1, pic .. ": a cue at a tick")
      truthy(picks[cue[2]], pic .. ": no sound " .. tostring(cue[2]))
      if length ~= true then truthy(cue[1] <= (length or 0), pic .. ": a cue after it stops moving never plays") end
    end
  end
end)
