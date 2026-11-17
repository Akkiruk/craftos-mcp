-- UnlimitedPeripheralWorks' vanilla integrations (SpecificPluginProvider): note block, jukebox, beacon and lectern.
-- Each is a PluggablePeripheral: its type is the block id, its configuration says implementationProvider = "upw".
return function(U)
  local C, Q, core, gameData = U.C, U.Q, U.core, U.gameData

  local function pluggable(def, methods, computerThread, extra)
    function methods.getConfiguration() return { implementationProvider = "upw" } end
    computerThread = computerThread or {}
    computerThread.getConfiguration = true
    return U.peripheral(def, methods, computerThread, extra)
  end

  local function between(v, lo, hi, name)
    if v < lo or v > hi then error(("%s should be between %d and %d"):format(name, lo, hi), 0) end
  end

  -- ===== note block =====

  -- NoteBlockInstrument (1.20.1), in declaration order
  local INSTRUMENTS = { "harp", "basedrum", "snare", "hat", "bass", "flute", "bell", "guitar", "chime", "xylophone",
    "iron_xylophone", "cow_bell", "didgeridoo", "bit", "banjo", "pling", "zombie", "skeleton", "creeper", "dragon",
    "wither_skeleton", "piglin", "custom_head" }
  local IS_INSTRUMENT = {}
  for _, i in ipairs(INSTRUMENTS) do IS_INSTRUMENT[i] = true end

  U.builders["minecraft:note_block"] = function(def)
    local saved = U.saved(def.name) or {}
    local b = {
      note = saved.note or C.toInt(tonumber(def.note) or 0),
      instrument = saved.instrument or (type(def.instrument) == "string" and def.instrument or "harp"),
      plays = saved.plays or 0,
    }
    local methods = {}
    function methods.getNote() return b.note end
    function methods.getInstrument() return b.instrument end
    function methods.setNote(note)
      note = C.int(1, note)
      between(note, 0, 24, "note")
      b.note = note
      core.save()
    end
    function methods.setInstrument(instrument)
      instrument = C.str(1, instrument)
      -- NoteBlockInstrument.valueOf(instrument.uppercase())
      local want = instrument:upper():lower()
      if not IS_INSTRUMENT[want] or instrument:upper() ~= want:upper() then
        error("Instrument should be one of: " .. table.concat(INSTRUMENTS, ", "), 0)
      end
      b.instrument = want
      core.save()
    end
    function methods.play()
      b.plays = b.plays + 1
      core.save()
    end
    U.blocks[def.name] = b
    return pluggable(def, methods, nil, {
      state = function()
        return { note = b.note, instrument = b.instrument, plays = b.plays,
          restore = { note = b.note, instrument = b.instrument, plays = b.plays } }
      end,
    })
  end

  -- ===== jukebox =====

  U.builders["minecraft:jukebox"] = function(def)
    local saved = U.saved(def.name) or {}
    local b = { disc = saved.disc, playing = saved.playing }
    if saved.disc == nil and type(def.disc) == "table" then b.disc = U.copyItem(def.disc, 1) b.disc.name = gameData.id(b.disc.name) end
    if b.playing == nil then b.playing = b.disc ~= nil and def.playing ~= false end
    local function assertDisc() if not b.disc then error("Disc should present in jukebox", 0) end end
    local function assertNoDisc() if b.disc then error("Jukebox should be empty", 0) end end

    local methods = {}
    function methods.getDisc()
      if not b.disc then return nil end
      return U.itemRepr(b.disc, "DETAILED")
    end
    local function replay()
      assertDisc()
      if not b.playing then b.playing = true end
    end
    function methods.replay()
      replay()
      core.save()
    end
    function methods.stop()
      if b.playing then b.playing = false end
      core.save()
    end
    function methods.ejectDisc(toName)
      toName = C.str(1, toName)
      assertDisc()
      local to = U.findStorage(toName, "Target '" .. toName .. "' does not exist", "Target '" .. toName .. "' is not an item inventory")
      if U.store(to, U.copyItem(b.disc)) > 0 then
        -- the part that went in stays there: AgnosticSink.store does not roll back
        return nil, "Not enough space in target inventory"
      end
      -- JukeboxBlockEntity.removeItem stops the record
      b.disc, b.playing = nil, false
      core.save()
      return true
    end
    function methods.injectDisc(fromName, query)
      fromName = C.str(1, fromName)
      assertNoDisc()
      local from = U.findStorage(fromName, "Target '" .. fromName .. "' does not exist", "Target '" .. fromName .. "' is not an item inventory")
      local predicate = function(it) return Q.itemHasTag(it, "minecraft:music_discs") end
      if query ~= nil then
        local q = Q.item(query)
        local base = predicate
        predicate = function(it) return base(it) and q(it) end
      end
      local disc = U.take(from, predicate, 1)
      if not disc then return nil, "Cannot find disc in desired inventory" end
      b.disc = disc
      replay()
      core.save()
      return true
    end
    U.blocks[def.name] = b
    return pluggable(def, methods, nil, {
      state = function()
        return { disc = b.disc, playing = b.playing, restore = { disc = b.disc, playing = b.playing } }
      end,
    })
  end

  -- ===== beacon =====

  -- BeaconBlockEntity.BEACON_EFFECTS (1.20.1): tier 1 speed, haste; 2 resistance, jump boost; 3 strength; 4 regeneration
  local EFFECTS = {
    { "minecraft:speed", "minecraft:haste" },
    { "minecraft:resistance", "minecraft:jump_boost" },
    { "minecraft:strength" },
    { "minecraft:regeneration" },
  }
  local EFFECT_NAME = {
    ["minecraft:speed"] = "Speed", ["minecraft:haste"] = "Haste", ["minecraft:resistance"] = "Resistance",
    ["minecraft:jump_boost"] = "Jump Boost", ["minecraft:strength"] = "Strength", ["minecraft:regeneration"] = "Regeneration",
  }
  local PAYMENT = { ["minecraft:netherite_ingot"] = true, ["minecraft:emerald"] = true, ["minecraft:diamond"] = true,
    ["minecraft:gold_ingot"] = true, ["minecraft:iron_ingot"] = true } -- ItemTags.BEACON_PAYMENT_ITEMS

  U.builders["minecraft:beacon"] = function(def)
    local saved = U.saved(def.name) or {}
    local b = {
      levels = saved.levels or C.toInt(tonumber(def.levels) or 0),
      primary = saved.primary or def.primary,
      secondary = saved.secondary or def.secondary,
    }
    local function effect(id, duration, amplifier)
      return { displayName = EFFECT_NAME[id] or id, name = id, duration = duration, amplifier = amplifier, isAmbient = true }
    end
    local function tiers()
      local out = {}
      for i = 0, math.min(b.levels - 1, 2) do
        for _, e in ipairs(EFFECTS[i + 1]) do out[#out + 1] = e end
      end
      return out
    end

    local methods = {}
    function methods.getLevel() return b.levels end
    function methods.getPossiblePowers() return tiers() end
    function methods.getPowers()
      local time = (9 + b.levels * 2) * 20
      if b.primary == nil then return {} end
      local out = { effect(b.primary, time, b.secondary == b.primary and 1 or 0) }
      if b.secondary ~= nil and b.secondary ~= b.primary then out[2] = effect(b.secondary, time, 0) end
      return out
    end
    function methods.configure(...)
      local args = table.pack(...)
      local primary = C.str(1, args[1])
      local fromName = C.str(2, args[2])
      local query = args[3]
      local regeneration = args[4]
      if regeneration == nil then regeneration = false else regeneration = C.bool(4, regeneration) end
      local found
      for _, e in ipairs(tiers()) do if e == primary then found = e end end
      if not found then return nil, "Cannot find desired effect in list of available effects" end
      local from = U.findStorage(fromName, "Target '" .. fromName .. "' does not exist", "Target '" .. fromName .. "' is not an item inventory")
      local predicate = function(it) return PAYMENT[it.name] == true end
      if query ~= nil then
        local q = Q.item(query)
        local base = predicate
        predicate = function(it) return base(it) and q(it) end
      end
      if not U.take(from, predicate, 1) then return nil, "Target storage cannot provide desired items" end
      b.primary = found
      if b.levels == 4 then
        b.secondary = regeneration and "minecraft:regeneration" or found
      end
      core.save()
      return true
    end
    U.blocks[def.name] = b
    return pluggable(def, methods, nil, {
      state = function()
        return { levels = b.levels, primary = b.primary, secondary = b.secondary,
          restore = { levels = b.levels, primary = b.primary, secondary = b.secondary } }
      end,
    })
  end

  -- ===== lectern =====

  local BOOK_MAX_LINES, MAX_WIDTH = 14, 95
  local WIDTH = {}
  for c in (" !',.:;i|"):gmatch(".") do WIDTH[c] = 1 end
  for c in ("`l"):gmatch(".") do WIDTH[c] = 2 end
  for c in ('"()*I[]t{}'):gmatch(".") do WIDTH[c] = 3 end
  for c in ("<>fk"):gmatch(".") do WIDTH[c] = 4 end
  for c in ("@~"):gmatch(".") do WIDTH[c] = 6 end

  --- TextBookUtils.stripText: cut the text where a book page runs out (14 lines of 95 pixels); a section sign hides
  --- the character after it
  local function stripText(text)
    local lines, width, skip = 0, 0, false
    local out = {}
    for i = 1, #text do
      local c = text:sub(i, i)
      if skip then
        skip = false
      else
        if c == "\n" then
          width = 0
          lines = lines + 1
          if lines > BOOK_MAX_LINES then return table.concat(out) end
        elseif c == "\167" then
          skip = true
        else
          local w = WIDTH[c] or 5
          if width + w > MAX_WIDTH then
            lines = lines + 1
            width = w
            if lines > BOOK_MAX_LINES then return table.concat(out) end
          else
            width = width + w
          end
        end
        out[#out + 1] = c
      end
    end
    return table.concat(out)
  end
  U.stripText = stripText

  --- a written book's page is a text component as JSON: its text, then its extra parts; anything that does not parse
  --- is shown as it is (Component.translatable of an unknown key)
  local function componentText(v)
    if type(v) == "string" then return v end
    if type(v) == "number" or type(v) == "boolean" then return tostring(v) end
    if type(v) ~= "table" then return "" end
    if v[1] ~= nil then
      local parts = {}
      for i, x in ipairs(v) do parts[i] = componentText(x) end
      return table.concat(parts)
    end
    local s = v.text or v.translate or ""
    if type(s) ~= "string" then s = tostring(s) end
    for _, x in ipairs(type(v.extra) == "table" and v.extra or {}) do s = s .. componentText(x) end
    return s
  end
  local function resolvePage(page)
    local ok, parsed = pcall(textutils.unserializeJSON, page)
    if ok and parsed ~= nil then return componentText(parsed) end
    return page
  end

  local WRITABLE, WRITTEN = "minecraft:writable_book", "minecraft:written_book"

  local function bookOf(item)
    local book = item.__book or {}
    local pages = {}
    for i, p in ipairs(type(book.pages) == "table" and book.pages or type(item.pages) == "table" and item.pages or {}) do
      pages[i] = tostring(p)
    end
    return { name = gameData.id(item.name), pages = pages, title = book.title or item.title, author = book.author or item.author }
  end

  U.builders["minecraft:lectern"] = function(def)
    local saved = U.saved(def.name) or {}
    local b = { book = saved.book, page = saved.page or 0 }
    if saved.book == nil and type(def.book) == "table" then
      b.book = bookOf(def.book)
      b.page = math.max(0, math.min(#b.book.pages - 1, (tonumber(def.page) or 1) - 1))
    end
    local function hasBook() return b.book ~= nil and (b.book.name == WRITABLE or b.book.name == WRITTEN) end
    local function count() return #b.book.pages end
    local function assertBook() if not hasBook() then error("Lectern should contain book", 0) end end
    local function assertNoBook() if hasBook() then error("Lectern shouldn't contain book", 0) end end
    local function editable()
      assertBook()
      return b.book.name == WRITABLE
    end
    local function assertEditable() if not editable() then error("Book should be editable", 0) end end
    local function hoverName()
      if b.book.name == WRITTEN and type(b.book.title) == "string" and b.book.title ~= "" then return b.book.title end
      return b.book.name == WRITTEN and "Written Book" or "Book and Quill"
    end
    local function asItem()
      local item = { name = b.book.name, count = 1, __book = { pages = b.book.pages, title = b.book.title, author = b.book.author } }
      if b.book.name == WRITTEN and b.book.title then item.displayName = b.book.title end
      return item
    end
    local subscribed = true -- the plugin subscribes on the first attach: the computer is attached from boot

    local function event(...) if subscribed then os.queueEvent(...) end end
    --- LecternBlockEntity.setPage clamps to the book and changes the page only when it is new; LecternMixin injects
    --- at its TAIL, so the event comes every time, with the page asked for
    local function setPage(p)
      b.page = math.max(0, math.min(p, count() - 1))
      event("lectern_page_changed", p + 1)
    end

    local methods = {}
    function methods.hasBook() return hasBook() end
    function methods.getPageCount()
      assertBook()
      return count()
    end
    function methods.getActivePage()
      assertBook()
      return b.page + 1
    end
    function methods.setActivePage(page)
      page = C.int(1, page)
      assertBook()
      between(page, 1, count(), "page")
      setPage(page - 1)
      core.save()
    end
    function methods.getText()
      assertBook()
      local out = {}
      for i, p in ipairs(b.book.pages) do out[i] = b.book.name == WRITTEN and resolvePage(p) or p end
      return out
    end
    function methods.isBookEditable() return editable() end
    function methods.addPage(text)
      if text ~= nil then text = C.str(1, text) end
      assertEditable()
      b.book.pages[#b.book.pages + 1] = stripText(text or "")
      core.save()
      return true
    end
    function methods.removePage(page)
      page = C.int(1, page)
      assertEditable()
      between(page, 1, count(), "page")
      table.remove(b.book.pages, page)
      core.save()
      return true
    end
    function methods.editPage(page, text)
      page = C.int(1, page)
      text = C.str(2, text)
      assertEditable()
      between(page, 1, count(), "page")
      b.book.pages[page] = stripText(text)
      core.save()
      return true
    end
    function methods.ejectBook(toName)
      toName = C.str(1, toName)
      assertBook()
      local to = U.findStorage(toName, "Target '" .. toName .. "' does not exist", "Target '" .. toName .. "' is not an item inventory")
      if U.store(to, asItem()) > 0 then return nil, "Not enough space in target inventory" end
      b.book, b.page = nil, 0
      event("lectern_book_removed")
      core.save()
      return true
    end
    function methods.injectBook(fromName, query)
      fromName = C.str(1, fromName)
      assertNoBook()
      local from = U.findStorage(fromName, "Target '" .. fromName .. "' does not exist", "Target '" .. fromName .. "' is not an item inventory")
      local predicate = function(it) return it.name == WRITABLE or it.name == WRITTEN end
      if query ~= nil then
        local q = Q.item(query)
        local base = predicate
        predicate = function(it) return base(it) and q(it) end
      end
      local item = U.take(from, predicate, 1)
      if not item then return nil, "Cannot find book in desired inventory" end
      b.book, b.page = bookOf(item), 0
      event("lectern_book_changed", hoverName())
      core.save()
      return true
    end

    -- a player at the lectern (sim commands)
    function b.turnPage(page)
      if not hasBook() then return false, "the lectern has no book" end
      setPage(C.toInt(tonumber(page) or 1) - 1)
      return true
    end
    function b.place(book, player)
      if book == nil then
        if not hasBook() then return false, "the lectern has no book" end
        b.book, b.page = nil, 0
        event("lectern_book_removed")
        return true
      end
      if hasBook() then return false, "the lectern already has a book" end
      b.book, b.page = bookOf(book), 0
      if player then event("lectern_book_changed", hoverName(), player) else event("lectern_book_changed", hoverName()) end
      return true
    end

    U.blocks[def.name] = b
    return pluggable(def, methods, nil, {
      state = function()
        return { book = b.book, page = b.page + 1, restore = { book = b.book, page = b.page } }
      end,
    })
  end

  function U.handlers.upwTurnPage(cmd)
    local b, err = U.block(cmd)
    if not b or not b.turnPage then return false, err or "not a lectern" end
    return b.turnPage(cmd.page)
  end

  function U.handlers.upwPlaceBook(cmd)
    local b, err = U.block(cmd)
    if not b or not b.place then return false, err or "not a lectern" end
    if cmd.book ~= nil and type(cmd.book) ~= "table" then return false, "book must be an item or null" end
    return b.place(cmd.book, cmd.player)
  end

  function U.handlers.upwSetJukebox(cmd)
    local b, err = U.block(cmd)
    if not b or b.disc == nil and b.playing == nil then return false, err or "not a jukebox" end
    if cmd.playing ~= nil then b.playing = cmd.playing == true and b.disc ~= nil end
    return true
  end

  function U.handlers.upwSetBeacon(cmd)
    local b, err = U.block(cmd)
    if not b or b.levels == nil then return false, err or "not a beacon" end
    if cmd.levels ~= nil then b.levels = math.max(0, math.min(4, C.toInt(tonumber(cmd.levels) or 0))) end
    return true
  end
end
