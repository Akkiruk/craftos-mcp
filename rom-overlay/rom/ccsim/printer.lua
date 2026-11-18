-- ccsim printer: CC:Tweaked's own printer, after PrinterPeripheral and TilePrinter (1.101.3) / PrinterBlockEntity
-- (1.121.0). The two versions behave the same but for how write() turns its argument into text.
--
-- The block has 13 slots: 1 the ink (any dye), 2-7 paper (paper, or a printed page to print over), 8-13 the printed
-- pages that come out. newPage takes one dye and one sheet and starts a 25x21 page in the dye's colour; endPage puts
-- the page in the first empty output slot as a computercraft:printed_page (stacks of 1). newPage while a page is
-- being printed ends that page first. Other inventories reach the slots with pushItems/pullItems by the printer's
-- name, as a hopper or a wired modem would in the game (a dye only goes in slot 1, paper only in 2-7, nothing in
-- 8-13). Only `printer` is its type: CC gives a block with its own peripheral no generic inventory methods.
--
-- The page's text lives on the item under __page (title, text, colours), the NBT CC writes (Title, Text0-20,
-- Color0-20); the item's nbt is a hash of it, as list() shows one. state.json's peripherals.<name> has the page being
-- printed, the ink and paper levels and every page printed so far (the newest 50), for the app to show.
return function(core, host)
  local WIDTH, HEIGHT = 25, 21
  local HEX = "0123456789abcdef"
  local KEEP = 50
  -- DyeColor ids: the dye's colour is the page's text colour, "0123456789abcdef":charAt(id)
  local DYES = {
    white = 0, orange = 1, magenta = 2, light_blue = 3, yellow = 4, lime = 5, pink = 6, gray = 7, light_gray = 8,
    cyan = 9, purple = 10, blue = 11, brown = 12, green = 13, red = 14, black = 15,
  }
  local PAGE_ITEM = "computercraft:printed_page"

  local function dyeOf(item)
    if type(item) ~= "table" or type(item.name) ~= "string" or (item.count or 0) <= 0 then return nil end
    local colour = item.name:match("^minecraft:([%a_]+)_dye$")
    return colour and DYES[colour] or nil
  end
  local function isPaper(item)
    return type(item) == "table" and (item.name == "minecraft:paper" or item.name == PAGE_ITEM) and (item.count or 0) > 0
  end

  -- ----- values to text -----

  --- Java's Double.toString: the shortest digits that read back as the same double; plain between 1e-3 and 1e7,
  --- else d.dddE<n>.
  local function javaDouble(d)
    if d ~= d then return "NaN" end
    if d == math.huge then return "Infinity" end
    if d == -math.huge then return "-Infinity" end
    if d == 0 then return (1 / d < 0) and "-0.0" or "0.0" end
    local s
    for p = 1, 17 do
      s = ("%." .. p .. "e"):format(d)
      if tonumber(s) == d then break end
    end
    local sign, int, frac, exp = s:match("^(-?)(%d)%.?(%d*)e([-+]%d+)$")
    local digits = (int .. frac):gsub("0+$", "")
    if digits == "" then digits = "0" end
    exp = tonumber(exp)
    local a = math.abs(d)
    if a >= 1e-3 and a < 1e7 then
      local point = exp + 1 -- digits before the decimal point
      local whole, rest
      if point <= 0 then
        whole, rest = "0", string.rep("0", -point) .. digits
      elseif point >= #digits then
        whole, rest = digits .. string.rep("0", point - #digits), "0"
      else
        whole, rest = digits:sub(1, point), digits:sub(point + 1)
      end
      return sign .. whole .. "." .. rest
    end
    local mantissa = digits:sub(1, 1) .. "." .. (#digits > 1 and digits:sub(2) or "0")
    return sign .. mantissa .. "E" .. exp
  end

  --- (int) of a double, as Java casts it: NaN is 0, out of range sticks at the ends.
  local function javaInt(d)
    if d ~= d then return 0 end
    if d >= 2147483647 then return 2147483647 end
    if d <= -2147483648 then return -2147483648 end
    return d < 0 and math.ceil(d) or math.floor(d)
  end

  local function hashText(v) return ("%08x"):format(tonumber(tostring(v):match("0x(%x+)") or tostring(v):match(": (%x+)") or "0", 16) % 4294967296) end

  --- What write(value) prints. 1.101.3: StringUtil.toString(arguments.get(0)), the Java object's toString (nil is
  --- "", a number is a Double, so 5 is "5.0"). 1.121.0: Coerced<String>, IArguments.getStringCoerced (nil is "nil",
  --- a whole number has no ".0").
  local function coerce(v)
    local t = type(v)
    if t == "string" then return v end
    if t == "boolean" then return tostring(v) end
    if core.cc121 then
      if v == nil then return "nil" end
      if t == "number" then
        local i = javaInt(v)
        if i == v then return ("%d"):format(i) end
        return javaDouble(v)
      end
      return ("%s: %s"):format(t, hashText(v))
    end
    if v == nil then return "" end
    if t == "number" then return javaDouble(v) end
    if t == "table" then
      -- a HashMap's toString; its order is the hash's, not the table's
      local parts = {}
      for k, x in pairs(v) do
        local function java(o)
          if type(o) == "number" then return javaDouble(o) end
          if type(o) == "table" then return "{...}" end
          return tostring(o)
        end
        parts[#parts + 1] = java(k) .. "=" .. java(x)
      end
      return "{" .. table.concat(parts, ", ") .. "}"
    end
    return "" -- a function or coroutine reaches Java as null
  end

  --- StringUtil.normaliseLabel: 32 characters at most, the ones a label cannot hold become "?".
  local function normaliseLabel(text)
    local out = {}
    for i = 1, math.min(32, #text) do
      local c = text:byte(i)
      local ok
      if core.cc121 then
        ok = (c >= 32 and c <= 126) or (c >= 161 and c <= 255 and c ~= 167)
      else
        ok = (c >= 32 and c <= 126) or (c >= 161 and c <= 172) or (c >= 174 and c <= 255)
      end
      out[#out + 1] = ok and string.char(c) or "?"
    end
    return table.concat(out)
  end

  local function pad(line, ch)
    line = type(line) == "string" and line or ""
    if #line >= WIDTH then return line:sub(1, WIDTH) end
    return line .. string.rep(ch, WIDTH - #line)
  end

  --- A printed page item from a page's lines. `page` may come from a world file: title, text (lines), colours.
  local function pageItem(title, text, colours)
    local page = { title = title, text = {}, colours = {} }
    for y = 1, HEIGHT do
      page.text[y] = pad(text and text[y], " ")
      page.colours[y] = pad(colours and colours[y], "f")
    end
    local nbt = host.md5(title .. "\0" .. table.concat(page.text, "\n") .. "\0" .. table.concat(page.colours, "\n"))
    return { name = PAGE_ITEM, count = 1, maxCount = 1, nbt = nbt, __page = page }
  end

  --- A world file's slots: shortcuts `ink` (black dye) and `paper`, and printed pages given as title/text/colours.
  local function startingItems(def)
    local items = {}
    for key, item in pairs(def.items or {}) do
      local slot = tonumber(key)
      if slot and type(item) == "table" then
        if item.name == PAGE_ITEM and not item.__page then
          item = pageItem(type(item.title) == "string" and item.title or "", item.text, item.colours)
        end
        items[tostring(slot)] = item
      end
    end
    if type(def.ink) == "number" and def.ink > 0 and not items["1"] then
      items["1"] = { name = "minecraft:black_dye", count = math.min(64, math.floor(def.ink)) }
    end
    if type(def.paper) == "number" and def.paper > 0 then
      local left = math.floor(def.paper)
      for slot = 2, 7 do
        if left <= 0 then break end
        if not items[tostring(slot)] then
          local n = math.min(64, left)
          items[tostring(slot)] = { name = "minecraft:paper", count = n }
          left = left - n
        end
      end
    end
    return items
  end

  return function(def)
    local self = { methods = {}, computerThread = {} }
    local m = self.methods
    local saved = core.savedState and type(core.savedState.peripherals) == "table" and core.savedState.peripherals[def.name]
    saved = type(saved) == "table" and saved or nil

    local invDef = { name = def.name, size = 13, items = startingItems(def) }
    local savedSlots = core.savedInventories and core.savedInventories[def.name]
    if savedSlots then invDef.items = savedSlots end
    local inv = host.newInventory(invDef)
    local items = inv.__state()

    -- the page in the printer (NetworkedTerminal(25, 21)): text and colour lines, the cursor, the ink's colour
    local printing = saved and saved.printing == true or false
    local title = saved and type(saved.title) == "string" and saved.title or ""
    local text, colours = {}, {}
    local cx, cy, ink = 0, 0, 15
    local printed = {} -- every page that came out, the newest last
    local function clearPage(colour)
      for y = 1, HEIGHT do
        text[y] = string.rep(" ", WIDTH)
        colours[y] = string.rep(HEX:sub(colour + 1, colour + 1), WIDTH)
      end
    end
    clearPage(0)
    if saved and type(saved.page) == "table" then
      for y = 1, HEIGHT do
        text[y] = pad(saved.page[y], " ")
        colours[y] = pad(saved.colours and saved.colours[y], "f")
      end
      if type(saved.cursor) == "table" then cx, cy = (saved.cursor[1] or 1) - 1, (saved.cursor[2] or 1) - 1 end
      if type(saved.printed) == "table" then printed = saved.printed end
    end

    -- the slots' own rules (canPlaceItem): a dye in 1, paper in 2-7, nothing in 8-13
    local function allowed(slot, item)
      if slot == 1 then return dyeOf(item) ~= nil end
      if slot >= 2 and slot <= 7 then return isPaper(item) end
      return false
    end
    local rawInsert, rawRoom = inv.__insert, inv.__room
    inv.__insert = function(item, count, toSlot)
      if toSlot then return allowed(toSlot, item) and rawInsert(item, count, toSlot) or 0 end
      local moved = 0
      for slot = 1, 13 do
        if moved >= count then break end
        if allowed(slot, item) then moved = moved + rawInsert(item, count - moved, slot) end
      end
      return moved
    end
    inv.__room = function(item, count, toSlot)
      if toSlot then return allowed(toSlot, item) and rawRoom(item, count, toSlot) or 0 end
      local n = 0
      for slot = 1, 13 do
        if allowed(slot, item) then n = n + rawRoom(item, count - n, slot) end
        if n >= count then break end
      end
      return n
    end
    self.inventory = inv

    local function inkLevel()
      local stack = items[1]
      return dyeOf(stack) and stack.count or 0
    end
    local function paperLevel()
      local n = 0
      for slot = 2, 7 do
        if isPaper(items[slot]) then n = n + items[slot].count end
      end
      return n
    end
    local function take(slot)
      local stack = items[slot]
      stack.count = stack.count - 1
      if stack.count <= 0 then items[slot] = nil end
    end

    local function inputPage()
      local colour = dyeOf(items[1])
      if not colour then return false end
      for slot = 2, 7 do
        local sheet = items[slot]
        if isPaper(sheet) then
          ink = colour
          clearPage(colour)
          if sheet.name == PAGE_ITEM then
            local page = sheet.__page or {}
            title = type(page.title) == "string" and page.title or ""
            for y = 1, HEIGHT do
              text[y] = pad(page.text and page.text[y], " ")
              colours[y] = pad(page.colours and page.colours[y], "f")
            end
          else
            title = ""
          end
          cx, cy = 0, 0
          take(1)
          take(slot)
          printing = true
          core.touch()
          return true
        end
      end
      return false
    end

    local function outputPage()
      for slot = 8, 13 do
        if not items[slot] then
          local item = pageItem(title, text, colours)
          items[slot] = item
          -- its own copies: state.json may hold a table once only
          printed[#printed + 1] = {
            title = title,
            text = { table.unpack(item.__page.text, 1, HEIGHT) },
            colours = { table.unpack(item.__page.colours, 1, HEIGHT) },
          }
          if #printed > KEEP then table.remove(printed, 1) end
          printing = false
          core.touch()
          return true
        end
      end
      return false
    end

    local function currentPage()
      if not printing then error("Page not started", 0) end
    end

    function m.write(...)
      local value = (...)
      local s = coerce(value)
      currentPage()
      if cy >= 0 and cy < HEIGHT then
        local line, cline = text[cy + 1], colours[cy + 1]
        local from, to = math.max(cx, 0), math.min(cx + #s, WIDTH)
        if to > from then
          local c = HEX:sub(ink + 1, ink + 1)
          text[cy + 1] = line:sub(1, from) .. s:sub(from - cx + 1, to - cx) .. line:sub(to + 1)
          colours[cy + 1] = cline:sub(1, from) .. string.rep(c, to - from) .. cline:sub(to + 1)
        end
      end
      cx = cx + #s
    end
    function m.getCursorPos()
      currentPage()
      return cx + 1, cy + 1
    end
    function m.setCursorPos(x, y)
      x, y = host.checkInt(1, x), host.checkInt(2, y)
      currentPage()
      cx, cy = x - 1, y - 1
    end
    function m.getPageSize()
      currentPage()
      return WIDTH, HEIGHT
    end
    function m.newPage()
      if inkLevel() <= 0 or paperLevel() <= 0 then return false end
      if printing and not outputPage() then return false end
      return inputPage()
    end
    function m.endPage()
      currentPage()
      return printing and outputPage()
    end
    function m.setPageTitle(t)
      if t ~= nil and type(t) ~= "string" then
        error(("bad argument #1 (string expected, got %s)"):format(type(t)), 0)
      end
      currentPage()
      title = normaliseLabel(t or "")
    end
    function m.getInkLevel() return inkLevel() end
    function m.getPaperLevel() return paperLevel() end

    -- newPage and endPage are @LuaFunction(mainThread = true); the rest answer at once
    for _, name in ipairs({ "write", "getCursorPos", "setCursorPos", "getPageSize", "setPageTitle", "getInkLevel", "getPaperLevel" }) do
      self.computerThread[name] = true
    end

    function self.state()
      local page = {}
      for y = 1, HEIGHT do page[y] = text[y] end
      return {
        printing = printing,
        title = title,
        page = page,
        colours = { table.unpack(colours, 1, HEIGHT) },
        cursor = { cx + 1, cy + 1 },
        ink = inkLevel(),
        inkColour = dyeOf(items[1]) and items[1].name or nil,
        paper = paperLevel(),
        printed = printed,
      }
    end
    return self
  end
end
