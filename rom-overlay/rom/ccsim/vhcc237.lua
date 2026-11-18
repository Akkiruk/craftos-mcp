-- ccsim vhcc237: what vhcctweaks 2.2.37 adds (the mod's docs/SPEC_2_2_37.md): Gear Power, Temper and god reputation
-- of a player, Gear Score fields in item details, and ccvault.getLimits. Loaded by ccvault.lua only when the world
-- says `vhcctweaks: "2.2.37"`; vhcc.getUsage and moveMany's expectName are where their APIs are (vhcc.lua,
-- peripherals.lua).
--
-- Nothing here is worked out the way Vault Hunters does it: the scorer, the Temper ladder and the saved profiles are
-- the game's. A world says what a player's slots score, what each Temper category multiplies by and what a piece
-- scores; this module gives the answers the shape, the derived numbers and the errors the mod gives them
-- (GearPowerShape, TemperShape, VaultPlayers, GearScoreShape, PairLabels, LimitsShape).
return function(core, ccvault)
  local SLOTS = { "head", "chest", "legs", "feet", "weapon", "offhand" }
  local CATEGORIES = { "might", "magic", "vigor", "tool" }
  local GODS = { "velara", "tenos", "wendarr", "idona" }
  local UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"

  local function typeName(v) return v == nil and "nil" or type(v) end

  local function checkString(index, v)
    if type(v) == "string" then return v end
    error(("bad argument #%d (string expected, got %s)"):format(index, typeName(v)), 0)
  end

  --- Java's Math.round
  local function round(n) return math.floor(n + 0.5) end

  local function num(v, default)
    if type(v) == "number" then return v end
    return default
  end

  local function whole(v, default)
    local n = num(v, default)
    if n == nil then return nil end
    return math.max(0, math.floor(n))
  end

  --- This server's Vault Hunters has Gear Power and Temper (3.21.74 or newer). `gearPowerAvailable: false` is an older one.
  local function modern() return core.world.gearPowerAvailable ~= false end

  --- CCVaultAPI.playerRead: the name resolves as for getPlayerVaultLevel, first lookup of an offline name included.
  --- Returns the player, `false` for a well-formed UUID nobody here has, or nil and the error.
  local function resolve(playerName)
    -- mainThread = true: the arguments are checked in the task, after the wait
    core.waitForServerTick()
    playerName = checkString(1, playerName)
    local name = playerName:match("^%s*(.-)%s*$")
    if name == "" then return nil, "unknown player" end
    if name:match(UUID) then return core.byUuid[name:lower()] or core.byUuid[name] or false end
    local p = core.findPlayer(name)
    if not p then return nil, "unknown player" end
    if not p.online and not p.lookedUp and not p.onOtherServer then
      p.lookedUp = true
      return nil, "looking up player '" .. name .. "' - try again"
    end
    return p
  end

  --- What this server has saved for a player who is not on it: a level, a Temper section, both or neither.
  local function savedProfile(p)
    if not p then return nil end
    local hasTemper = type(p.temper) == "table" or type(p.gearPower) == "table"
    if type(p.vaultLevel) ~= "number" and not hasTemper then return nil end
    return { level = type(p.vaultLevel) == "number" and p.vaultLevel or nil, temper = hasTemper }
  end

  local function peakOf(p)
    return whole(type(p.gearPower) == "table" and p.gearPower.peak, 0)
  end

  local function categoryOf(p, id)
    local temper = type(p.temper) == "table" and p.temper or {}
    return type(temper[id]) == "table" and temper[id] or {}
  end

  --- What a category multiplies Gear Power by. The ladder from levels to multipliers is Vault Hunters' own, so the
  --- world gives the multiplier; with no levels bought it is 1. nil: the world left it out for a level above 0.
  local function multiplierOf(p, id)
    local category = categoryOf(p, id)
    if type(category.multiplier) == "number" then return category.multiplier end
    if whole(category.level, 0) == 0 then return 1 end
    return nil
  end

  local function powerOf(p, id)
    local category = categoryOf(p, id)
    if type(category.power) == "number" then return category.power end
    if whole(category.level, 0) == 0 then return 1 end
    return nil
  end

  -- ===== The hotbar and the weapon Gear Power counts (section 9.3) =====

  -- Vault Hunters gear types held in the main hand (Wold's Vaults' battlestaff, trident and rang included)
  local MAINHAND_TYPES = { SWORD = true, AXE = true, BATTLESTAFF = true, TRIDENT = true, RANG = true }

  --- The player's hotbar from the world: `equipment.hotbar` ({ [1..9] = item }) and `equipment.selectedHotbarSlot`
  --- (default 1). With no hotbar given, the held slot holds `mainhand`. Returns the items by slot, the held slot and
  --- whether the world gave a hotbar.
  local function hotbarOf(p)
    local worn = type(p.equipment) == "table" and p.equipment or {}
    local selected = whole(worn.selectedHotbarSlot, 1)
    selected = math.min(9, math.max(1, selected))
    local bar = {}
    if type(worn.hotbar) == "table" then
      for key, item in pairs(worn.hotbar) do
        local i = tonumber(key)
        if i and i >= 1 and i <= 9 and type(item) == "table" and item.name then bar[i] = item end
      end
      return bar, selected, true
    end
    if type(worn.mainhand) == "table" and worn.mainhand.name then bar[selected] = worn.mainhand end
    return bar, selected, false
  end

  --- A weapon Gear Power can count: identified, not broken, main-hand Vault Hunters gear (tools are not gear).
  local function isWeapon(item)
    local data = type(item) == "table" and item.vaultData
    if type(data) ~= "table" or data.itemType ~= "Gear" then return false end
    if data.identified == false or data.state == "UNIDENTIFIED" or data.state == "ROLLING" then return false end
    if data.gearScoreStatus ~= nil and data.gearScoreStatus ~= "COUNTED" then return false end
    if data.equipmentSlot ~= nil then return data.equipmentSlot == "mainhand" end
    return MAINHAND_TYPES[tostring(data.gearType):upper()] == true
  end

  --- The hotbar slot of the weapon Gear Power counts and how many hotbar weapons there are: the world's
  --- `equipment.weaponHotbarSlot` (or gearPower.slotDetails.weapon.hotbarSlot), else the best Gear Score among the
  --- hotbar's weapons, the held slot first on a tie, then the lowest slot.
  local function countedWeapon(p)
    local bar, selected = hotbarOf(p)
    local weapons = 0
    for _, item in pairs(bar) do if isWeapon(item) then weapons = weapons + 1 end end
    local worn = type(p.equipment) == "table" and p.equipment or {}
    local gear = type(p.gearPower) == "table" and p.gearPower or {}
    local given = type(gear.slotDetails) == "table" and type(gear.slotDetails.weapon) == "table"
      and gear.slotDetails.weapon.hotbarSlot or nil
    local forced = num(worn.weaponHotbarSlot, num(given))
    if forced and bar[forced] then return forced, weapons end
    local best, bestScore
    local order = { selected }
    for i = 1, 9 do if i ~= selected then order[#order + 1] = i end end
    for _, i in ipairs(order) do
      local item = bar[i]
      if isWeapon(item) then
        local score = num(item.vaultData.gearScoreExact, num(item.vaultData.gearScore, 0))
        if not best or score > bestScore then best, bestScore = i, score end
      end
    end
    return best, weapons
  end

  -- ===== Gear Power =====

  local function slotDetail(p, gear, slot, score)
    local given = type(gear.slotDetails) == "table" and gear.slotDetails[slot]
    given = type(given) == "table" and given or {}
    local status = given.status
    if type(status) ~= "string" then
      status = score > 0 and "COUNTED" or (slot == "weapon" and "NO_WEAPON" or "EMPTY")
    end
    local out = { status = status, score = score }
    local item, name = given.item, given.name
    if slot ~= "weapon" and status ~= "EMPTY" and item == nil then
      -- the piece in the slot, when the world says what the player wears
      local worn = type(p.equipment) == "table" and p.equipment[slot]
      if type(worn) == "table" and worn.name then
        item = worn.name
        if name == nil then name = core.itemDetail(worn).displayName end
      end
    end
    if slot == "weapon" and status ~= "NO_WEAPON" and item == nil and given.hotbarSlot == nil then
      -- the weapon getPlayerEquipment names, when the world gives a hotbar with one in it
      local hotbarSlot, weapons = countedWeapon(p)
      if hotbarSlot then
        local held = hotbarOf(p)[hotbarSlot]
        item = held.name
        if name == nil then name = core.itemDetail(held).displayName end
        given = { hotbarSlot = hotbarSlot, hotbarWeapons = weapons }
      end
    end
    if type(item) == "string" then out.item = item end
    if type(name) == "string" then out.name = name end
    if type(given.hotbarSlot) == "number" then
      out.hotbarSlot = given.hotbarSlot
      if type(given.hotbarWeapons) == "number" then out.hotbarWeapons = given.hotbarWeapons end
    end
    return out
  end

  local function gearPowerOnline(p)
    local level = whole(p.vaultLevel, 0)
    local minLevel = whole(core.config.gearPowerMinLevel, 100)
    local shown = level >= minLevel
    local out = {
      online = true,
      shown = shown,
      level = level,
      minLevel = minLevel,
      greedTier = whole(p.greedTier, 0),
      peakGearPower = peakOf(p),
    }
    if not shown then return out end

    local gear = type(p.gearPower) == "table" and p.gearPower or {}
    local given = type(gear.slots) == "table" and gear.slots or {}
    local details = type(gear.slotDetails) == "table" and gear.slotDetails or {}
    local scores, total = {}, 0
    for _, slot in ipairs(SLOTS) do
      local score = num(given[slot], 0)
      -- only a counted slot scores
      local status = type(details[slot]) == "table" and details[slot].status
      if type(status) == "string" and status ~= "COUNTED" then score = 0 end
      scores[slot] = score
      total = total + score
    end
    local might = multiplierOf(p, "might") or 1
    local magic = multiplierOf(p, "magic") or 1
    local vigor = multiplierOf(p, "vigor") or 1
    local temper = (math.max(might, magic) + vigor) / 2
    local exact = total / #SLOTS
    out.gearScoreExact = exact
    out.gearScore = round(exact)
    out.gearPower = round(exact * temper)
    out.temper = temper
    out.might, out.magic, out.vigor = might, magic, vigor
    out.slots = scores
    -- `slotDetails: false`: Vault Hunters could not explain the slots, so the field is left out
    if gear.slotDetails ~= false then
      out.slotDetails = {}
      for _, slot in ipairs(SLOTS) do out.slotDetails[slot] = slotDetail(p, gear, slot, scores[slot]) end
    end
    return out
  end

  function ccvault.getPlayerGearPower(playerName)
    local p, err = resolve(playerName)
    if p == nil then return nil, err end
    if not p or not p.online then
      local saved = savedProfile(p)
      if not saved then return nil, "no vault data" end
      return { online = false, shown = false, level = saved.level, peakGearPower = saved.temper and peakOf(p) or 0 }
    end
    if not modern() then return nil, "gear power not available" end
    return gearPowerOnline(p)
  end

  -- ===== Temper and Dust =====

  --- TemperShape.build. `ladder` false: the multipliers could not be read, so they and the powers are left out.
  local function temperTable(p, online, ladder)
    local temper = type(p.temper) == "table" and p.temper or {}
    local out = { online = online, dust = whole(temper.dust, 0), peakGearPower = peakOf(p) }
    local known = ladder
    for _, id in ipairs(CATEGORIES) do
      local category = { level = whole(categoryOf(p, id).level, 0) }
      if ladder then
        category.multiplier = multiplierOf(p, id)
        category.power = powerOf(p, id)
        if id ~= "tool" and category.multiplier == nil then known = false end
      end
      out[id] = category
    end
    if known then
      out.gearPowerMultiplier = (math.max(out.might.multiplier, out.magic.multiplier) + out.vigor.multiplier) / 2
    end
    out.trialsRecord = whole(temper.trialsRecord, 0)
    if online then
      out.bossesBeaten = whole(temper.bossesBeaten, 0)
      out.favorsUsed = whole(temper.favorsUsed, 0)
    end
    return out
  end

  function ccvault.getPlayerTemper(playerName)
    local p, err = resolve(playerName)
    if p == nil then return nil, err end
    if not p or not p.online then
      if not savedProfile(p) then return nil, "no vault data" end
      -- the saved profile has the Dust and the levels; the multipliers need the server's ladder
      return temperTable(p, false, modern())
    end
    if not modern() then return nil, "temper not available" end
    return temperTable(p, true, true)
  end

  -- ===== God reputation =====

  function ccvault.getPlayerReputation(playerName)
    local p, err = resolve(playerName)
    if p == nil then return nil, err end
    if not p or not p.online then return nil, "player offline" end
    local given = type(p.reputation) == "table" and p.reputation or {}
    local out = {}
    for _, god in ipairs(GODS) do out[god] = num(given[god], 0) end
    return out
  end

  -- ===== Skills, stat totals, the counted weapon (section 9) =====

  -- The capped stats and their caps as Vault Hunters 3.21.74 codes them (9.4)
  local STAT_CAPS = {
    ["the_vault:cooldown_reduction"] = { base = 0.8, max = 0.95 },
    ["the_vault:block"] = { base = 0.6, max = 0.95 },
    ["the_vault:resistance"] = { base = 0.5, max = 0.95 },
    ["the_vault:area_of_effect"] = { base = 0.8, max = 0.8 },
    ["the_vault:durability_wear_reduction"] = { base = 0.5, max = 1 },
    ["the_vault:lucky_hit_chance"] = { base = 0.562, max = 1 },
  }
  local TREES = { "abilities", "talents", "expertises", "prestige" }

  local function titleOf(id)
    local path = tostring(id):match(":(.+)$") or tostring(id)
    return (path:gsub("_", " "):gsub("(%a)([%w]*)", function(a, b) return a:upper() .. b end))
  end

  --- One learned skill as the mod lists it. Online, `level` is the world's (gear bonuses included, default
  --- `learned`) and an ability says whether it is `selected`; from the saved profile `level` is `learned`.
  local function skillEntry(tree, given, online, selectedId)
    if type(given) ~= "table" or type(given.id) ~= "string" then return nil end
    local learned = whole(given.learned, whole(given.level, 0))
    local name = type(given.name) == "string" and given.name or titleOf(given.id)
    local out = {
      id = given.id,
      name = name,
      learned = learned,
      level = online and whole(given.level, learned) or learned,
      maxLevel = whole(given.maxLevel, math.max(learned, 1)),
    }
    if tree == "abilities" then
      out.specializationIndex = whole(given.specializationIndex, 0)
      out.specialization = type(given.specialization) == "string" and given.specialization or given.id
      out.specializationName = type(given.specializationName) == "string" and given.specializationName
        or (out.specializationIndex == 0 and name or titleOf(out.specialization))
      if online then out.selected = given.selected == true or (selectedId ~= nil and given.id == selectedId) end
    end
    return out
  end

  function ccvault.getPlayerSkills(playerName)
    local p, err = resolve(playerName)
    if p == nil then return nil, err end
    local online = p and p.online == true or false
    if not p or (not online and not savedProfile(p) and type(p.skills) ~= "table") then return nil, "no vault data" end
    if p.skills == false then return nil, "skills not available" end
    local skills = type(p.skills) == "table" and p.skills or {}
    local spent = type(skills.spentPoints) == "table" and skills.spentPoints or {}
    local out = { online = online, spentPoints = {} }
    for _, tree in ipairs(TREES) do
      local given = skills[tree]
      -- a tree that can't be read (false in the world) is left out; the others are still there
      if given ~= false then
        local list, sum = {}, 0
        for _, entry in ipairs(type(given) == "table" and given or {}) do
          local skill = skillEntry(tree, entry, online, skills.selectedAbility)
          if skill and skill.learned > 0 then
            list[#list + 1] = skill
            sum = sum + skill.learned
          end
        end
        out[tree] = list
        -- what the points cost is Vault Hunters' tree config: without the world's count, one point a level
        out.spentPoints[tree] = whole(spent[tree], sum)
      end
    end
    return out
  end

  --- The stat screen's way of writing a number: percentages to one decimal place, others to two.
  local function display(value, percent)
    local function trim(s) return (s:gsub("%.?0+$", "")) end
    if percent then return trim(("%.1f"):format(value * 100)) .. "%" end
    return trim(("%.2f"):format(value))
  end

  function ccvault.getPlayerStats(playerName)
    local p, err = resolve(playerName)
    if p == nil then return nil, err end
    if not p or not p.online then return nil, "player offline" end
    if p.stats == false then return nil, "stats not available" end
    local out = {}
    for id, given in pairs(type(p.stats) == "table" and p.stats or {}) do
      if type(given) == "number" then given = { value = given } end
      if type(id) == "string" and type(given) == "table" then
        local raw = num(given.uncapped, num(given.value))
        -- each stat on its own: one the world gives no number has nothing to say
        if raw ~= nil then
          local cap = STAT_CAPS[id]
          local stat = { name = type(given.name) == "string" and given.name or titleOf(id) }
          if cap then
            local limit = math.min(num(given.limit, cap.base), cap.max)
            stat.limit, stat.uncapped = limit, raw
            stat.value = math.min(raw, limit)
            stat.hitLimit = raw > limit
          else
            stat.value = raw
          end
          local percent = given.percent
          if percent == nil then percent = cap ~= nil end
          stat.display = type(given.display) == "string" and given.display or display(stat.value, percent)
          if given.extra == true then stat.extra = true end
          out[id] = stat
        end
      end
    end
    return out
  end

  --- 9.3: getPlayerEquipment also gives the hotbar, the held slot and the weapon Gear Power counts.
  local baseEquipment = ccvault.getPlayerEquipment
  function ccvault.getPlayerEquipment(playerName)
    local out, err = baseEquipment(playerName)
    if type(out) ~= "table" then return out, err end
    local name = playerName:match("^%s*(.-)%s*$")
    local p = core.byUuid[name:lower()] or core.byUuid[name] or core.findPlayer(name)
    if not p then return out end
    local bar, selected, given = hotbarOf(p)
    out.hotbar = {}
    for i, item in pairs(bar) do out.hotbar[i] = core.itemDetail(item) end
    out.selectedHotbarSlot = selected
    -- mainhand is the held hotbar slot's item
    if given then out.mainhand = bar[selected] and core.itemDetail(bar[selected]) or nil end
    local slot = countedWeapon(p)
    if slot then
      out.weapon = core.itemDetail(bar[slot])
      out.weaponHotbarSlot = slot
    end
    return out
  end

  -- ===== Limits =====

  function ccvault.getLimits()
    local c = core.config
    local caps
    if modern() then
      caps = {}
      for id, cap in pairs(STAT_CAPS) do caps[id] = { base = cap.base, max = cap.max } end
    end
    return {
      statCaps = caps,
      maxTransferAmount = c.maxTransferAmount,
      interactionStaleSeconds = c.interactionStaleSeconds,
      nonceExpirySeconds = c.nonceExpirySeconds,
      authIdleTimeoutMinutes = c.authIdleTimeoutMinutes,
      maxHistoryResults = c.maxHistoryResults,
      maxAllowanceMinutes = c.maxAllowanceMinutes,
      maxLinksPerComputer = c.maxLinksPerComputer,
      maxBatchMoves = c.maxBatchMoves,
      batchTimeBudgetMicros = c.batchTimeBudgetMicros,
      maxWatchesPerComputer = c.maxWatchesPerComputer,
      vhccMaxBytesPerComputer = c.maxBytesPerComputer,
      gearScoreInDetails = c.gearScore ~= false,
      gearScoreLinesInDetails = c.gearScoreLines ~= false,
      containerItems = c.containerItems ~= false,
      identify = c.identify ~= false,
    }
  end

  -- ===== Sim commands =====

  core.extraHandlers = core.extraHandlers or {}

  --- Sim commands: change what Vault Hunters knows about a player. The value replaces the player's; null takes it
  --- away (a command's JSON null arrives as nil).
  local function setter(command, key, kind)
    core.extraHandlers[command] = function(cmd)
      local p = core.findPlayer(cmd.player)
      if not p then return false, "unknown player" end
      if cmd[key] ~= nil and type(cmd[key]) ~= kind then return false, key .. " must be a " .. kind .. " or null" end
      p[key] = cmd[key]
      return true
    end
  end
  setter("setGearPower", "gearPower", "table")
  setter("setTemper", "temper", "table")
  setter("setReputation", "reputation", "table")
  setter("setGreedTier", "greedTier", "number")
  setter("setSkills", "skills", "table")
  setter("setStats", "stats", "table")

  -- ===== Item details =====

  local MODIFIER_KEYS = { "implicits", "prefixes", "suffixes" }
  local HEAL_PAIRS = { ["the_vault:on_kill_heal"] = true, ["the_vault:block_heal"] = true }
  local SCORE_FIELDS = { "gearScore", "gearScoreExact", "gearScoreStatus", "gearScoreLines" }
  local LINE_FIELDS = {
    "scoreRatio", "scorePoints", "naturalBest", "naturalWorst", "naturalBestAtLevel", "naturalWorstAtLevel",
  }
  -- gear_power.json perfectSlotScore: what a perfect natural piece scores
  local PERFECT = 1000

  local function copy(value)
    if type(value) ~= "table" then return value end
    local out = {}
    for k, v in pairs(value) do out[k] = copy(v) end
    return out
  end
  -- fixture fields of container items and unidentified pieces (section 7 and 8 below): the world's, not the item's
  local FIXTURE_FIELDS = {
    "contents", "containerSlots", "itemHandler", "outputFilter", "blockEntityTag", "identifiesTo", "identifiable",
  }

  local function modifiersOf(data, visit)
    local count = 0
    for _, key in ipairs(MODIFIER_KEYS) do
      if type(data[key]) == "table" then
        for _, modifier in ipairs(data[key]) do
          if type(modifier) == "table" then
            count = count + 1
            if visit then visit(modifier) end
          end
        end
      end
    end
    return count
  end

  local function dropLines(data)
    modifiersOf(data, function(modifier)
      for _, field in ipairs(LINE_FIELDS) do modifier[field] = nil end
    end)
  end

  --- GearScoreShape.put, with the scorer's answer taken from the world: `gearScore` (or `gearScoreExact`) and,
  --- for a piece that does not count, `gearScoreStatus`.
  local function gearScore(data)
    local exact = num(data.gearScoreExact, num(data.gearScore))
    local status = type(data.gearScoreStatus) == "string" and data.gearScoreStatus or (exact and "COUNTED") or nil
    local lines = type(data.gearScoreLines) == "table" and data.gearScoreLines or {}
    for _, field in ipairs(SCORE_FIELDS) do data[field] = nil end
    local scored = data.itemType == "Gear" and data.identified ~= false
      and modern() and core.config.gearScore ~= false and status ~= nil
    if not scored then
      dropLines(data)
      return
    end
    data.gearScoreStatus = status
    if status ~= "COUNTED" or not exact then
      dropLines(data)
      return
    end
    local actual = modifiersOf(data)
    local expected = whole(lines.expected, actual)
    -- a unique counts its own line count as the expected count, so it is never marked down for having fewer
    if data.rarity == "UNIQUE" then expected = actual end
    data.gearScore = round(exact)
    data.gearScoreExact = exact
    data.gearScoreLines = { expected = expected, actual = actual }
    if core.config.gearScoreLines == false then
      dropLines(data)
      return
    end
    local divisor = math.max(expected, actual)
    local level = num(data.level, 100)
    modifiersOf(data, function(modifier)
      local value = modifier.value
      local ratio = num(modifier.scoreRatio)
      modifier.scorePoints = nil
      -- the scorer only rates numbers: an ability or talent level line is always 1 and has no range, and so is a
      -- heal pair the world gave no ratio
      local levelLine = type(value) == "table" and (value.ability ~= nil or value.talent ~= nil)
      if levelLine then ratio = 1 end
      if ratio == nil and HEAL_PAIRS[modifier.attribute] and type(value) == "table" then ratio = 1 end
      if levelLine then modifier.scoreRatio = 1 end
      if not ratio then
        -- a line the world gave no ratio has nothing to say
        for _, field in ipairs(LINE_FIELDS) do modifier[field] = nil end
        return
      end
      modifier.scoreRatio = ratio
      if divisor > 0 then modifier.scorePoints = PERFECT * ratio / divisor end
      local best, worst = modifier.naturalBest, modifier.naturalWorst
      if levelLine or type(best) ~= "number" or type(worst) ~= "number" then
        for _, field in ipairs({ "naturalBest", "naturalWorst", "naturalBestAtLevel", "naturalWorstAtLevel" }) do
          modifier[field] = nil
        end
        return
      end
      -- the range at the piece's own level: the world's, or the level 100 one at level 100 (and for a piece with no
      -- level); below 100 an approximation scaled by the level (Vault Hunters works it out from its tier table)
      local function atLevel(given, at100)
        if type(given) == "number" then return given end
        if level >= 100 then return at100 end
        local scaled = at100 * math.max(level, 1) / 100
        if at100 == math.floor(at100) then scaled = math.max(math.floor(scaled + 0.5), math.min(at100, 1)) end
        return scaled
      end
      modifier.naturalBestAtLevel = atLevel(modifier.naturalBestAtLevel, best)
      modifier.naturalWorstAtLevel = atLevel(modifier.naturalWorstAtLevel, worst)
    end)
  end

  --- What 2.2.37's detail provider always adds to the vaultData a world gives an item. The detail is a copy: the
  --- item in the chest keeps what the world said.
  function core.detailHook(detail)
    for _, field in ipairs(FIXTURE_FIELDS) do detail[field] = nil end
    if type(detail.vaultData) ~= "table" then return end
    local data = copy(detail.vaultData)
    detail.vaultData = data

    -- durability.max, the same number as durability.total
    if type(data.durability) == "table" and data.durability.total ~= nil then
      data.durability.max = data.durability.total
    end

    local legendary = false
    modifiersOf(data, function(modifier)
      if modifier.legendary == true then legendary = true end
      -- heal pairs say which number is which
      local value = modifier.value
      if HEAL_PAIRS[modifier.attribute] and type(value) == "table" and value.first ~= nil and value.second ~= nil then
        value.chance, value.amount = value.first, value.second
      end
    end)
    -- a piece is legendary when one of its modifiers is, whether or not the flag was set
    local kind = data.itemType
    if legendary and (kind == "Gear" or kind == "Tool" or kind == "Jewel") then data.isLegendary = true end

    -- greedTier is there only for a lock
    if type(data.greedTier) ~= "number" or data.greedTier <= 0 then data.greedTier = nil end

    gearScore(data)
  end

  -- ===== Items inside container items (spec section 7) and identifying gear (section 8) =====
  --
  -- A world gives a container item its contents as `contents = { ["innerSlot"] = item }` (kept keyed by strings, so
  -- state.json keeps the slots) and optionally `containerSlots`, `itemHandler = true` (another mod's bag with a Forge
  -- item handler), `outputFilter = { allow?, deny? }` (a backpack's filter upgrade) and `blockEntityTag` (a shulker
  -- box's other BlockEntityTag keys). An inventory with `canChangeItems: false` hands out copies, like one that does
  -- not let its slots be set. An unidentified piece is `vaultData.state = "UNIDENTIFIED"` (or "ROLLING"), with
  -- `identifiesTo` (the vaultData it gets) or `vaultData.rollPool` to say what identifying gives.

  local BACKPACK_SLOTS = {
    ["sophisticatedbackpacks:backpack"] = 27,
    ["sophisticatedbackpacks:iron_backpack"] = 54,
    ["sophisticatedbackpacks:gold_backpack"] = 81,
    ["sophisticatedbackpacks:diamond_backpack"] = 108,
    ["sophisticatedbackpacks:netherite_backpack"] = 120,
  }
  -- Vault Hunters counts 36 slots for the wooden barrel, 45 for the others
  local VAULT_BARRELS = {
    ["the_vault:wooden_barrel"] = 36,
    ["the_vault:living_barrel"] = 45,
    ["the_vault:gilded_barrel"] = 45,
    ["the_vault:ornate_barrel"] = 45,
  }

  local function shallow(t)
    local out = {}
    for k, v in pairs(t) do out[k] = v end
    return out
  end

  local function isShulker(name)
    return name == "minecraft:shulker_box" or name:match("^minecraft:[%a_]+_shulker_box$") ~= nil
  end

  --- What kind of container an item is, in the spec's order: "handler" (a backpack or another item with a Forge item
  --- handler), "shulker", "barrel" (a vault barrel), or nil. A stack of more than one never is.
  local function containerKind(item)
    if type(item) ~= "table" or type(item.name) ~= "string" or (item.count or 1) > 1 then return nil end
    if item.itemHandler == true or BACKPACK_SLOTS[item.name] then return "handler" end
    if isShulker(item.name) then return "shulker" end
    if VAULT_BARRELS[item.name] then return "barrel" end
    return nil
  end

  local function containerSize(item, kind)
    if type(item.containerSlots) == "number" then return math.max(0, math.floor(item.containerSlots)) end
    if kind == "handler" then return BACKPACK_SLOTS[item.name] or 27 end
    if kind == "barrel" then return VAULT_BARRELS[item.name] end
    return 27
  end

  --- The container's contents keyed by inner slot as a string, or nil when it has none (never set up by looking).
  local function contentsOf(item)
    local contents = item.contents
    if type(contents) ~= "table" then return nil end
    local numeric = {}
    for k in pairs(contents) do
      if type(k) == "number" then numeric[#numeric + 1] = k end
    end
    for _, k in ipairs(numeric) do
      contents[tostring(k)] = contents[k]
      contents[k] = nil
    end
    return contents
  end

  local function innerAt(item, innerSlot)
    local contents = contentsOf(item)
    local inner = contents and contents[tostring(innerSlot)]
    if type(inner) ~= "table" or (inner.count or 0) <= 0 then return nil end
    return inner
  end

  --- A deterministic text of a value, to hash; the sim's own "__" fields are left out.
  local function serial(v)
    if type(v) ~= "table" then return type(v) .. ":" .. tostring(v) end
    local keys = {}
    for k in pairs(v) do
      if type(k) ~= "string" or k:sub(1, 2) ~= "__" then keys[#keys + 1] = k end
    end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts + 1] = tostring(k) .. "=" .. serial(v[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
  end

  local function hash32(s, h)
    for i = 1, #s do h = (h * 33 + s:byte(i)) % 4294967296 end
    return h
  end

  --- 32 hex digits, standing in for the hash CC computes from the item's tag.
  local function hashHex(s)
    return ("%08x%08x%08x%08x"):format(hash32(s, 5381), hash32(s, 2166136261), hash32(s, 52711), hash32(s, 977))
  end

  --- A shulker box's or vault barrel's nbt for its contents now. Emptied, the Items list goes: with no other
  --- BlockEntityTag keys it has no tag at all, like a fresh one.
  local function blockItemNbt(item)
    local contents = contentsOf(item)
    local empty = not contents or next(contents) == nil
    if empty then item.contents = nil end
    if empty and type(item.blockEntityTag) ~= "table" then return nil end
    return hashHex(item.name .. "|" .. serial(item.blockEntityTag) .. "|" .. serial(not empty and contents or nil))
  end

  --- A backpack's filter upgrade: what may leave it.
  local function filterAllows(item, inner)
    local filter = item.outputFilter
    if type(filter) ~= "table" then return true end
    local function has(list)
      if type(list) ~= "table" then return false end
      for _, name in ipairs(list) do if name == inner.name then return true end end
      return false
    end
    local allow = filter.allow
    if allow == nil and filter[1] ~= nil then allow = filter end
    if type(allow) == "table" and not has(allow) then return false end
    return not has(filter.deny)
  end

  --- `player` for identify: online here and approved on this computer (the approval "player:Name" transfers use).
  --- The approval is touched: identifying counts as activity on it. Returns the player, or nil and the reason.
  function core.identifyPlayer(name)
    local p = core.findPlayer(name)
    if not p or not p.online then return nil, "player '" .. name .. "' is not online" end
    local session = core.sessions[p.uuid]
    if session and core.nowMs() - session.last > core.config.authIdleTimeoutMinutes * 60000 then
      core.sessions[p.uuid] = nil
      session = nil
    end
    if not session then return nil, "player '" .. name .. "' has not approved this computer" end
    session.last = core.nowMs()
    return p
  end

  -- ----- what identifying gives -----

  local RARITIES = { "COMMON", "RARE", "EPIC", "OMEGA" }
  local WEIGHTS = { COMMON = 40, RARE = 30, EPIC = 20, OMEGA = 10 }
  -- prefixes, suffixes per rarity
  local AFFIX_COUNTS = { SCRAPPY = { 0, 1 }, COMMON = { 1, 1 }, RARE = { 2, 1 }, EPIC = { 2, 2 }, OMEGA = { 3, 3 },
    UNIQUE = { 2, 2 } }
  local AFFIXES = {
    implicits = {
      { "the_vault:armor", "Armor", 2, 12 }, { "the_vault:attack_damage", "Attack Damage", 2, 10 },
      { "the_vault:block", "Block Chance", 1, 8 },
    },
    prefixes = {
      { "the_vault:max_health", "Health", 1, 8 }, { "the_vault:mana_additive", "Mana", 5, 40 },
      { "the_vault:armor", "Armor", 1, 10 }, { "the_vault:attack_damage", "Attack Damage", 1, 8 },
      { "the_vault:mana_regen", "Mana Regeneration", 1, 15 }, { "the_vault:resistance", "Resistance", 1, 6 },
    },
    suffixes = {
      { "the_vault:cooldown_reduction", "Cooldown Reduction", 1, 8 }, { "the_vault:attack_speed", "Attack Speed", 1, 6 },
      { "the_vault:item_quantity", "Item Quantity", 1, 5 }, { "the_vault:item_rarity", "Item Rarity", 1, 5 },
      { "the_vault:copiously", "Copiously", 1, 4 }, { "the_vault:knockback_resistance", "Knockback Resistance", 1, 10 },
    },
  }

  local rolls = 0
  --- A seeded roll: the same piece, player, world seed and count of identifies on this computer roll the same.
  local function roller(text)
    rolls = rolls + 1
    local state = hash32(text .. "#" .. rolls .. "#" .. tostring(core.world.seed or 0), 5381) % 2147483646 + 1
    return function(n)
      state = (state * 16807) % 2147483647
      return math.floor((state - 1) / 2147483646 * n) + 1
    end
  end

  --- The piece's rarity: rolled from its `rollPool` (a rarity, "Rare+" for that rarity and up, a list, or a pool name
  --- for the default weights); a piece with a `rarity` and no pool keeps it; otherwise the default weights.
  local function rollRarity(data, roll)
    local pool = data.rollPool
    if pool == nil and type(data.rarity) == "string" then return data.rarity end
    if type(pool) == "table" and #pool > 0 then return tostring(pool[roll(#pool)]):upper() end
    local weights = WEIGHTS
    if type(pool) == "string" then
      local up = pool:upper()
      if WEIGHTS[up] or up == "UNIQUE" then return up end
      local from = up:match("^(%a+)%+$")
      if from and WEIGHTS[from] then
        weights = {}
        local on = false
        for _, r in ipairs(RARITIES) do
          if r == from then on = true end
          if on then weights[r] = WEIGHTS[r] end
        end
      end
    end
    local total = 0
    for _, r in ipairs(RARITIES) do total = total + (weights[r] or 0) end
    local pick = roll(total)
    for _, r in ipairs(RARITIES) do
      pick = pick - (weights[r] or 0)
      if pick <= 0 then return r end
    end
    return "COMMON"
  end

  local function modifiers(kind, count, level, roll)
    local out, used = {}, {}
    local pool = AFFIXES[kind]
    for _ = 1, count do
      local pick
      for _ = 1, #pool do
        pick = pool[roll(#pool)]
        if not used[pick] then break end
      end
      used[pick] = true
      local tier = math.min(5, math.floor((level or 0) / 20) + 1)
      local value = pick[3] + roll(pick[4] - pick[3] + 1) - 1 + tier - 1
      out[#out + 1] = { name = pick[2], attribute = pick[1], value = tostring(value), tier = tier }
    end
    return out
  end

  --- The vaultData the piece has once identified: the world's `identifiesTo`, or a plausible piece that keeps the
  --- level, the rarity rules above and the legendary flag, with seeded modifiers. The real roll is Vault Hunters'.
  local function identifiedData(piece, player)
    local before = piece.vaultData
    local data
    if type(piece.identifiesTo) == "table" then
      data = copy(piece.identifiesTo)
      if data.level == nil then data.level = before.level end
      if data.itemType == nil then data.itemType = before.itemType end
      if data.name == nil then data.name = before.name end
    else
      data = copy(before)
      data.rollPool = nil
      local roll = roller(tostring(piece.name) .. serial(before) .. tostring(piece.nbt) .. tostring(player))
      data.rarity = rollRarity(before, roll)
      local kind = data.itemType
      if kind == "Gear" or kind == "Tool" or kind == "Jewel" then
        local counts = AFFIX_COUNTS[data.rarity] or AFFIX_COUNTS.COMMON
        local level = num(data.level, 0)
        if data.implicits == nil then data.implicits = modifiers("implicits", 1, level, roll) end
        if data.prefixes == nil then data.prefixes = modifiers("prefixes", counts[1], level, roll) end
        if data.suffixes == nil then data.suffixes = modifiers("suffixes", counts[2], level, roll) end
        if before.isLegendary == true then
          local legendary = data.prefixes[1] or data.suffixes[1]
          if legendary then legendary.legendary = true end
        end
      end
      if kind == "Gear" or kind == "Tool" then
        if data.repairSlots == nil then data.repairSlots = { total = 2 + roll(2), used = 0 } end
        if data.durability == nil then
          local total = 800 + roll(17) * 100
          data.durability = { total = total, current = total }
        end
        if data.rarity ~= "UNIQUE" and data.craftingPotential == nil then
          local max = 20 + roll(31)
          data.craftingPotential = { current = max, max = max }
        end
        if kind == "Gear" and data.rarity ~= "UNIQUE" then
          data.prefixSlots = data.prefixSlots or #data.prefixes
          data.suffixSlots = data.suffixSlots or #data.suffixes
        end
      end
    end
    data.state = "IDENTIFIED"
    data.identified = true
    return data
  end

  local STATES = { UNIDENTIFIED = true, ROLLING = true, IDENTIFIED = true }

  --- The 2.2.37 inventory methods of one inventory (peripherals.lua newInventory). `ctx` has the inventory's slots
  --- (`items`, a table that stays the same), `size`, `def`, and peripherals.lua's helpers. Sets inv.__listContents,
  --- __pushContents, __identify (the Lua methods, put on the peripheral by build), __pushInner (a moveMany move),
  --- __innerSource (one container as the source side of a transfer) and __inner (what a linked computer asks).
  function core.v37inventory(inv, ctx)
    local items, size, def = ctx.items, ctx.size, ctx.def
    local checkInt, checkString, slotInRange = ctx.checkInt, ctx.checkString, ctx.slotInRange

    local function fixed() return def.canChangeItems == false end

    -- A filled shulker box or barrel has a tag, so an nbt hash; a backpack or a shulker box stacks to 1
    for _, item in pairs(items) do
      local kind = containerKind(item)
      if kind and item.maxCount == nil and kind ~= "barrel" then item.maxCount = 1 end
      if (kind == "shulker" or kind == "barrel") and item.nbt == nil then
        local contents = contentsOf(item)
        if contents and next(contents) then item.nbt = blockItemNbt(item) end
      end
    end

    --- The container in `slot`, its kind and its slot count, or nil and the reason.
    local function container(slot, innerSlot)
      local item = items[slot]
      if not item then return nil, "empty slot" end
      if core.config.containerItems == false then return nil, "container items are turned off" end
      local kind = containerKind(item)
      if not kind then return nil, "not a container" end
      local n = containerSize(item, kind)
      if innerSlot ~= nil and (innerSlot < 1 or innerSlot > n) then
        return nil, ("inner slot out of range (between 1 and %d)"):format(n)
      end
      return item, kind, n
    end

    --- Put `inner` (nil: nothing) in an inner slot. A backpack changes through its own storage, so its nbt stays, and
    --- is set back in the slot (the block changes: watches see it); a shulker box or barrel is replaced by a copy with
    --- the new contents and nbt.
    local function setInner(slot, innerSlot, inner)
      local item = items[slot]
      local key = tostring(innerSlot)
      if containerKind(item) == "handler" then
        item.contents = contentsOf(item) or {}
        item.contents[key] = inner
        item.__rev = (item.__rev or 0) + 1
        return
      end
      local new = shallow(item)
      new.contents = shallow(contentsOf(item) or {})
      new.contents[key] = inner
      new.nbt = blockItemNbt(new)
      items[slot] = new
    end

    local function takeInner(slot, innerSlot, n)
      if n <= 0 then return end
      local left = shallow(innerAt(items[slot], innerSlot))
      left.count = left.count - n
      setInner(slot, innerSlot, left.count > 0 and left or nil)
    end

    local function putInner(slot, innerSlot, like, n)
      if innerSlot == nil or n <= 0 then return 0 end
      local inner = innerAt(items[slot], innerSlot)
      if inner and not (inner.name == like.name and inner.nbt == like.nbt) then return 0 end
      local new = shallow(inner or like)
      new.count = (inner and inner.count or 0) + n
      setInner(slot, innerSlot, new)
      return n
    end

    --- Why a move out of `innerSlot` cannot run: a reason, "" for a move of 0 with no reason, nil when it can.
    local function blocked(slot, innerSlot, expectName)
      local item, reason = container(slot, innerSlot)
      if not item then return reason end
      if fixed() then return "can't change items in this inventory" end
      local inner = innerAt(item, innerSlot)
      if not inner then return "" end
      if expectName and inner.name ~= expectName then return "" end
      if not filterAllows(item, inner) then return "" end
      return nil
    end

    function inv.__innerSource(slot)
      local source = {}
      function source.__peek(innerSlot)
        local inner = innerAt(items[slot], innerSlot)
        return inner and shallow(inner) or nil
      end
      function source.__take(innerSlot, n, like)
        local inner = innerAt(items[slot], innerSlot)
        if not inner or inner.name ~= like.name or inner.nbt ~= like.nbt then return 0 end
        n = math.min(n, inner.count)
        takeInner(slot, innerSlot, n)
        return n
      end
      function source.__insert(like, n, innerSlot) return putInner(slot, innerSlot, like, n) end
      return source
    end

    --- pushContents, and a moveMany move with `inner` (`expectName` checks the inner item; `save` false in a batch).
    local function pushInner(save, expectName, toName, slot, innerSlot, limit, toSlot)
      toName = checkString(1, toName)
      slot = checkInt(2, slot)
      innerSlot = checkInt(3, innerSlot)
      if limit ~= nil then limit = checkInt(4, limit) end
      if toSlot ~= nil then toSlot = checkInt(5, toSlot) end
      local target = ctx.resolveInventory(toName, "Target")
      slotInRange(slot, size, "From slot")
      if toSlot ~= nil then slotInRange(toSlot, ctx.slotsOf(target), "To slot") end
      if limit ~= nil and limit <= 0 then return 0 end
      local why = blocked(slot, innerSlot, expectName)
      if why == "" then return 0 end
      if why then return 0, why end
      local inner = innerAt(items[slot], innerSlot)
      -- a stack upgrade's big slot still gives at most one normal stack
      local stack = inner.maxCount or 64
      local want = math.min(limit or stack, stack, inner.count)
      local moved
      if target.__remote then
        moved = ctx.transfer(inv.__innerSource(slot), innerSlot, target, want, toSlot)
      else
        -- into the target first, then out of the container
        moved = target.__insert(inner, want, toSlot)
        takeInner(slot, innerSlot, moved)
      end
      if save then core.save() end
      return moved
    end
    inv.__pushInner = pushInner

    function inv.__pushContents(toName, slot, innerSlot, limit, toSlot)
      return pushInner(true, nil, toName, slot, innerSlot, limit, toSlot)
    end

    function inv.__listContents(slot, detailed)
      slot = checkInt(1, slot)
      if detailed ~= nil and type(detailed) ~= "boolean" then
        error(("bad argument #2 (boolean expected, got %s)"):format(typeName(detailed)), 0)
      end
      slotInRange(slot, size, "Slot")
      local item, kind, n = container(slot)
      if not item then return nil, kind end
      local out = {}
      for key, inner in pairs(contentsOf(item) or {}) do
        local i = tonumber(key)
        if i and i >= 1 and i <= n and type(inner) == "table" and (inner.count or 0) > 0 then
          if detailed then
            out[i] = ctx.itemDetail(inner)
          else
            out[i] = { name = inner.name, count = inner.count, nbt = inner.nbt }
          end
        end
      end
      return out, n
    end

    --- identify after the player checks: steps 3 to 7 of the spec. `player` is the player's name.
    local function identifyAt(slot, innerSlot, player)
      slotInRange(slot, size, "Slot")
      local item = items[slot]
      if not item then return nil, "empty slot" end
      local piece = item
      if innerSlot ~= nil then
        local found, reason = container(slot, innerSlot)
        if not found then return nil, reason end
        piece = innerAt(item, innerSlot)
        if not piece then return nil, "empty slot" end
      end
      local data = piece.vaultData
      if piece.identifiable == false or type(data) ~= "table" or not STATES[data.state] then
        return nil, "not identifiable"
      end
      if data.state == "IDENTIFIED" then return nil, "already identified" end
      if data.state == "ROLLING" then return nil, "being identified" end
      if (piece.count or 1) > 1 then return nil, "can't identify a stack" end
      if fixed() then return nil, "can't change items in this inventory" end
      if core.world.identifyAvailable == false then return nil, "identify not available" end
      -- identified as a copy, written back once that worked
      local new = shallow(piece)
      new.vaultData = identifiedData(piece, player)
      new.identifiesTo = nil
      new.nbt = hashHex(tostring(piece.name) .. "|" .. serial(new.vaultData))
      if innerSlot ~= nil then setInner(slot, innerSlot, new) else items[slot] = new end
      core.save()
      return ctx.itemDetail(new)
    end

    function inv.__identify(slot, player, innerSlot)
      slot = checkInt(1, slot)
      player = checkString(2, player)
      if innerSlot ~= nil then innerSlot = checkInt(3, innerSlot) end
      if core.config.identify == false then return nil, "identify is turned off" end
      local p, why = core.identifyPlayer(player)
      if not p then return nil, why end
      return identifyAt(slot, innerSlot, p.name)
    end

    -- what a linked computer asks of a container here (wiredrelay.lua ops.inner)
    inv.__inner = {
      blocked = function(slot, innerSlot, expectName) return blocked(slot, innerSlot, expectName) end,
      peek = function(slot, innerSlot) return inv.__innerSource(slot).__peek(innerSlot) end,
      take = function(slot, innerSlot, n, like) return inv.__innerSource(slot).__take(innerSlot, n, like) end,
      insert = function(slot, innerSlot, n, like) return putInner(slot, innerSlot, like, n) end,
      identify = function(slot, innerSlot, player) return identifyAt(slot, innerSlot, player) end,
    }
  end
end
