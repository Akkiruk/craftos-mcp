-- ccsim addon lakes-cc-additions: Lake's CC Additions 1.7.0 (Forge, Minecraft 1.20.1), by lakehouse.
--
-- Written from the mod's source, github.com/lakehouse445/lakes-cc-additions at commit 6ecd001 ("release: 1.7.0"),
-- src/main/java/gg/lakehouse/scanner/: ScannerPeripheral (type "scanner", every method), ScannerBlockEntity (its
-- slot and events), ScannerBlock (the biometric scan), DrawingData, StampItem, FolderItem, ScannerConfig.
-- Map colours are Minecraft's MapColor table (ids 0-61), read from the 1.18.2 client jar's MaterialColor; 1.20.1
-- renamed the class and kept the colours.
--
-- The scanned item is a fixture: { name, count, displayName, damage, maxDamage, nbt = "<SNBT>" , map = {...} }, its
-- NBT read and written as Minecraft does (nbt.lua), so fingerprint() hashes the same text as in game.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local order = dofile("/rom/ccsim/addons/javamap.lua").order
  local N = dofile("/rom/ccsim/addons/lakes-cc-additions/nbt.lua")
  local sha = dofile("/rom/ccsim/addons/crickets-peripherals/crypto.lua").sha256
  local band, rshift, lshift, bor, bnot = bit32.band, bit32.rshift, bit32.lshift, bit32.bor, bit32.bnot
  local M = {}
  local cfg = core.world.lakesCcAdditions or {}
  local REQUIRE_MATERIALS = cfg.requirePrintoutMaterials == true
  local EXPOSURE = cfg.exposure == true

  local LINES, WIDTH = 21, 25
  local DW, DH = 172, 209
  local DBYTES = math.floor((DW * DH + 3) / 4)
  local STAMP, STAMP_BYTES = 32, 32 * 32 / 4
  local SLOTS = 27
  local MAPCOLOR = { [0] = 0, 8368696, 16247203, 13092807, 16711680, 10526975, 10987431, 31744, 16777215, 10791096,
    9923917, 7368816, 4210943, 9402184, 16776437, 14188339, 11685080, 6724056, 15066419, 8375321, 15892389, 5000268,
    10066329, 5013401, 8339378, 3361970, 6704179, 6717235, 10040115, 1644825, 16445005, 6085589, 4882687, 55610,
    8476209, 7340544, 13742497, 10441252, 9787244, 7367818, 12223780, 6780213, 10505550, 3746083, 8874850, 5725276,
    8014168, 4996700, 4993571, 5001770, 9321518, 2430480, 12398641, 9715553, 6035741, 1474182, 3837580, 5647422,
    1356933, 6579300, 14200723, 8365974 }
  local ATLAS = { 0x000000, 0xFFFFFF, 0x7FB238, 0x007C00, 0x4040FF, 0x3030B0, 0xF7E9A3, 0x976D4D, 0x8F7748, 0x707070,
    0x969696, 0x4C4C4C, 0xD87F33, 0x993333, 0xE5E533, 0xA0A0FF }

  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end

  --- a Java String's UTF-8 bytes, the string coming from Lua bytes (each one a char 0-255)
  local function utf8(s)
    return (s:gsub("[\128-\255]", function(c)
      local b = c:byte()
      return string.char(0xC0 + rshift(b, 6), 0x80 + band(b, 0x3F))
    end))
  end
  local function hex(s) return (s:gsub(".", function(c) return ("%02x"):format(c:byte()) end)) end

  -- ===== items =====

  local function titleCase(path)
    return (path:gsub("_", " "):gsub("(%a)([%w]*)", function(a, b) return a:upper() .. b end))
  end

  --- a fixture item, or nil for an empty slot
  local function newItem(spec)
    if type(spec) ~= "table" or type(spec.name) ~= "string" then return nil end
    local it = { name = spec.name, count = math.floor(tonumber(spec.count) or 1), displayName = spec.displayName,
      damage = spec.damage, maxDamage = spec.maxDamage, map = spec.map }
    if type(spec.nbt) == "string" and spec.nbt ~= "" then it.tag = N.parse(spec.nbt)
    elseif type(spec.nbt) == "table" then it.tag = spec.nbt end
    -- conveniences that write what the mod keeps in NBT: pen drawings per page, a stamp's emblem
    local function packed(rows, w, h, bytes)
      local data = {}
      for i = 1, bytes do data[i] = 0 end
      for y = 1, h do
        local row = rows[y] or rows[tostring(y)]
        if type(row) == "string" then
          for x = 1, math.min(#row, w) do
            local v = row:byte(x) - 48
            if v >= 1 and v <= 3 then
              local i = (y - 1) * w + (x - 1)
              local at = rshift(i, 2) + 1
              data[at] = bor(data[at], lshift(v, (i % 4) * 2))
            end
          end
        end
      end
      for i = 1, bytes do if data[i] >= 128 then data[i] = data[i] - 256 end end
      return { t = "byte_array", v = data }
    end
    if type(spec.drawings) == "table" then
      it.tag = it.tag or N.compound()
      for page, rows in pairs(spec.drawings) do
        it.tag.v["LakeDrawing" .. (tonumber(page) - 1)] = packed(rows, DW, DH, DBYTES)
      end
    end
    if type(spec.emblem) == "table" then
      it.tag = it.tag or N.compound()
      it.tag.v.Emblem = packed(spec.emblem, STAMP, STAMP, STAMP_BYTES)
    end
    return it
  end
  local function path(it) return it.name:match(":(.*)$") or it.name end
  local function namespace(it) return it.name:match("^(.-):") or "minecraft" end
  local function isFolder(it) return it.name == "lakescanner:folder" end
  local function isPaper(it) return it.name == "minecraft:paper" end
  local function isStamp(it) return it.name == "lakescanner:stamp" end
  local function itemOfEntry(entry) -- ItemStack.of(compound)
    local tag = N.get(entry, "tag")
    return { name = N.getString(entry, "id"), count = N.getByte(entry, "Count"), tag = tag }
  end
  local function payload(id, tag) return id .. "|" .. (tag and N.write(tag) or "") end

  --- tagToLua: compounds and lists to tables, numbers to integers when whole, the rest to strings
  local function toLua(tag)
    local t = tag.t
    if t == "compound" then
      local out = {}
      for k, v in pairs(tag.v) do out[k] = toLua(v) end
      return out
    elseif t == "list" then
      local out = {}
      for i, v in ipairs(tag.v) do out[i] = toLua(v) end
      return out
    elseif t == "byte_array" or t == "int_array" or t == "long_array" then
      local out = {}
      for i, v in ipairs(tag.v) do out[i] = v end
      return out
    elseif N.isNumeric(tag) then
      local v = tag.v
      if t == "float" then v = N.fround(v) end
      return v
    end
    return tag.v
  end

  -- 2bpp layers (DrawingData, StampItem): the pixel at x, y of a signed byte array
  local function pixel(data, w, x, y)
    local i = y * w + x
    local b = data[rshift(i, 2) + 1] % 256
    return band(rshift(b, (i % 4) * 2), 3)
  end
  local function layer(tag, key, bytes)
    local a = N.get(tag, key)
    if not a or a.t ~= "byte_array" or #a.v ~= bytes then return nil end
    return a.v
  end

  -- ===== map colours =====

  local function packedToRgb(packed)
    packed = packed % 256
    local id, brightness = rshift(packed, 2), packed % 4
    if id == 0 or not MAPCOLOR[id] then return 0 end
    local mult = ({ [0] = 180, 220, 255, 135 })[brightness]
    local base = MAPCOLOR[id]
    local r = math.floor(band(rshift(base, 16), 255) * mult / 255)
    local g = math.floor(band(rshift(base, 8), 255) * mult / 255)
    local b = math.floor(band(base, 255) * mult / 255)
    return r * 65536 + g * 256 + b
  end
  local function dist(a, b)
    local dr = band(rshift(a, 16), 255) - band(rshift(b, 16), 255)
    local dg = band(rshift(a, 8), 255) - band(rshift(b, 8), 255)
    local db = band(a, 255) - band(b, 255)
    return dr * dr + dg * dg + db * db
  end
  local function blit(rgb, w, h, palette)
    local chars = "0123456789abcdef"
    local cache, rows = {}, {}
    for z = 0, h - 1 do
      local row = {}
      for x = 0, w - 1 do
        local c = rgb[x + z * w + 1]
        local ch = cache[c]
        if not ch then
          local best, bestD = 0, math.huge
          for p = 0, 15 do
            local d = dist(c, palette[p + 1])
            if d < bestD then bestD, best = d, p end
          end
          ch = chars:sub(best + 1, best + 1)
          cache[c] = ch
        end
        row[#row + 1] = ch
      end
      rows[z + 1] = table.concat(row)
    end
    local pal = {}
    for p = 1, 16 do pal[p] = palette[p] end
    return { width = w, height = h, palette = pal, rows = rows }
  end
  local function mapColors(map)
    local colors = {}
    if type(map.colors) == "table" then
      for i = 1, 16384 do colors[i] = math.floor(tonumber(map.colors[i]) or 0) % 256 end
    else
      local fill = math.floor(tonumber(map.fill) or 0) % 256
      for i = 1, 16384 do colors[i] = fill end
    end
    return colors
  end

  -- ===== the scanner =====

  local scanners = {}

  local function newScanner(def)
    local s = saved(def.name)
    local o = { name = def.name }
    o.item = newItem(s and s.item or def.item)

    local function setItem(it)
      o.item = it
      os.queueEvent("scanner", def.name, it ~= nil) -- fireScannerEvent, to every attached computer
    end
    o.setItem = setItem
    local function requireItem()
      if not o.item then error("Nothing to scan", 0) end
      return o.item
    end
    local function resolveDocument(folderSlot)
      local it = requireItem()
      if folderSlot == nil then return it end
      if not isFolder(it) then error("Slot index given but the item is not a folder", 0) end
      if folderSlot < 1 or folderSlot > SLOTS then error("Folder slot out of range (1-27)", 0) end
      local items = N.get(it.tag, "Items")
      for _, entry in ipairs(items and items.v or {}) do
        if N.getByte(entry, "Slot") == folderSlot - 1 then return itemOfEntry(entry) end
      end
      error("Folder slot " .. folderSlot .. " is empty", 0)
    end
    local function mapData()
      local it = requireItem()
      if it.name ~= "minecraft:filled_map" then error("Item is not a filled map", 0) end
      if type(it.map) ~= "table" then error("Map data is not available (unexplored or foreign map?)", 0) end
      return it.map
    end
    local function padLine(str)
      if #str > WIDTH then return str:sub(1, WIDTH) end
      return str .. (" "):rep(WIDTH - #str)
    end
    local function padColour(str)
      if #str > WIDTH then return str:sub(1, WIDTH) end
      return str .. ("f"):rep(WIDTH - #str)
    end

    local m = {}
    function m.hasItem() return o.item ~= nil end
    function m.getItem()
      local it = o.item
      if not it then return nil end
      local out = { name = it.name, count = it.count, displayName = it.displayName or titleCase(path(it)) }
      if it.maxDamage then
        out.damage = math.floor(tonumber(it.damage) or 0)
        out.maxDamage = math.floor(tonumber(it.maxDamage))
      end
      return out
    end
    function m.scanNBT()
      local it = requireItem()
      local out = { name = it.name, count = it.count }
      if it.tag then out.nbt = toLua(it.tag) end
      return out
    end
    function m.fingerprint()
      local it = requireItem()
      return hex(sha(utf8(payload(it.name, it.tag))))
    end
    function m.scanContainer()
      local it = requireItem()
      local bet = N.get(it.tag, "BlockEntityTag")
      if not bet or not N.get(bet, "Items") then
        if path(it):sub(-#"shulker_box") == "shulker_box" then return {} end
        error("Item has no container contents", 0)
      end
      local out = {}
      for i, entry in ipairs(N.get(bet, "Items").v) do
        local itemTag = N.get(entry, "tag")
        local nestedBet = itemTag and N.get(itemTag, "BlockEntityTag")
        out[i] = { slot = N.getByte(entry, "Slot") + 1, name = N.getString(entry, "id"), count = N.getByte(entry, "Count"),
          hasNbt = itemTag ~= nil, nested = nestedBet ~= nil and N.get(nestedBet, "Items") ~= nil }
      end
      return out
    end
    function m.sha256(text)
      text = C.str(1, text)
      return hex(sha(utf8(text)))
    end
    function m.scanFolder()
      local it = requireItem()
      if not isFolder(it) then error("Item is not a folder", 0) end
      local items = N.get(it.tag, "Items")
      local out = {}
      for i, entry in ipairs(items and items.v or {}) do
        local doc = itemOfEntry(entry)
        local p = doc.name:match(":(.*)$") or doc.name
        local e = { slot = N.getByte(entry, "Slot") + 1, name = doc.name, count = doc.count,
          type = ({ printed_page = "page", printed_pages = "pages", printed_book = "book", paper = "paper" })[p] or p }
        if N.get(doc.tag, "Title") then e.title = N.getString(doc.tag, "Title") end
        e.fingerprint = hex(sha(utf8(payload(doc.name, doc.tag))))
        out[i] = e
      end
      return out
    end
    function m.countInk(x, y, w, h, page, folderSlot)
      x, y, w, h = C.int(1, x), C.int(2, y), C.int(3, w), C.int(4, h)
      page, folderSlot = C.optInt(5, page), C.optInt(6, folderSlot)
      local doc = resolveDocument(folderSlot)
      local result = function(d, r, b) return { total = d + r + b, dark = d, red = r, blue = b } end
      if not doc.tag then return result(0, 0, 0) end
      local data = layer(doc.tag, "LakeDrawing" .. ((page or 1) - 1), DBYTES)
      if not data then return result(0, 0, 0) end
      local counts = { 0, 0, 0 }
      for py = math.max(0, y), math.min(DH, y + h) - 1 do
        for px = math.max(0, x), math.min(DW, x + w) - 1 do
          local v = pixel(data, DW, px, py)
          if v > 0 then counts[v] = counts[v] + 1 end
        end
      end
      return result(counts[1], counts[2], counts[3])
    end
    function m.scanStamp()
      local it = requireItem()
      if not isStamp(it) then error("Item is not a stamp", 0) end
      local data = layer(it.tag, "Emblem", STAMP_BYTES)
      if not data then error("Stamp has no emblem", 0) end
      local rows = {}
      for y = 0, STAMP - 1 do
        local row = {}
        for x = 0, STAMP - 1 do row[#row + 1] = string.char(48 + pixel(data, STAMP, x, y)) end
        rows[y + 1] = table.concat(row)
      end
      return { size = STAMP, rows = rows }
    end
    function m.scanPrintout(folderSlot)
      folderSlot = C.optInt(1, folderSlot)
      local doc = resolveDocument(folderSlot)
      local ns, p = doc.name:match("^(.-):(.*)$")
      if ns ~= "computercraft" or not p or p:sub(1, 8) ~= "printed_" then error("Item is not a printout", 0) end
      local nbt = doc.tag
      local title = N.get(nbt, "Title") and N.getString(nbt, "Title") or ""
      local pageCount = N.get(nbt, "Pages") and N.getInt(nbt, "Pages") or 1
      local pages = {}
      for page = 0, pageCount - 1 do
        local text, color = {}, {}
        for line = 0, LINES - 1 do
          local i = page * LINES + line
          text[line + 1] = padLine(nbt and N.getString(nbt, "Text" .. i) or "")
          color[line + 1] = padColour(nbt and N.getString(nbt, "Color" .. i) or "")
        end
        local pt = { text = text, color = color }
        local data = nbt and layer(nbt, "LakeDrawing" .. page, DBYTES)
        if data then
          local drawing = {}
          for y = 0, DH - 1 do
            local row = {}
            for x = 0, DW - 1 do row[#row + 1] = string.char(48 + pixel(data, DW, x, y)) end
            drawing[y + 1] = table.concat(row)
          end
          pt.drawing = drawing
        end
        pages[page + 1] = pt
      end
      return { type = ({ printed_page = "page", printed_pages = "pages", printed_book = "book" })[p] or p,
        title = title, pageCount = pageCount, pages = pages, width = WIDTH, height = LINES }
    end
    function m.createPrintout(pagesArg, title)
      pagesArg = C.table(1, pagesArg)
      if title ~= nil then title = C.str(2, title) end
      local existing = o.item
      if existing and not isFolder(existing) and not isPaper(existing) then
        error("Scanner slot must be empty (or hold a folder to file into)", 0)
      end
      if existing and isPaper(existing) and not REQUIRE_MATERIALS then
        error("Scanner slot must be empty (or hold a folder to file into)", 0)
      end
      local pages = {}
      local i = 1
      while type(pagesArg[i]) == "table" do pages[#pages + 1] = pagesArg[i]; i = i + 1 end
      if #pages == 0 then error("No pages given", 0) end
      if #pages > 16 then error("Too many pages (max 16)", 0) end
      local tag = N.compound()
      tag.v.Title = N.str(title or "")
      tag.v.Pages = N.int(#pages)
      for pi, page in ipairs(pages) do
        local p = pi - 1
        local text, color = page.text, page.color
        if type(text) ~= "table" then error("Page " .. pi .. " has no text table", 0) end
        if type(color) ~= "table" then color = {} end
        for l = 0, LINES - 1 do
          local tl, cl = text[l + 1], color[l + 1]
          tag.v["Text" .. (p * LINES + l)] = N.str(padLine(type(tl) == "string" and tl or ""))
          tag.v["Color" .. (p * LINES + l)] = N.str(padColour(type(cl) == "string" and cl or ""))
        end
        if type(page.drawing) == "table" then
          local data, any = {}, false
          for k = 1, DBYTES do data[k] = 0 end
          for y = 0, DH - 1 do
            local row = page.drawing[y + 1]
            if type(row) == "string" then
              for x = 0, math.min(#row, DW) - 1 do
                local v = row:byte(x + 1) - 48
                if v >= 1 and v <= 3 then
                  local idx = y * DW + x
                  local at = rshift(idx, 2) + 1
                  local shift = (idx % 4) * 2
                  data[at] = bor(band(data[at] % 256, bnot(lshift(3, shift))), lshift(v, shift)) % 256
                  any = true
                end
              end
            end
          end
          if any then
            for k = 1, DBYTES do if data[k] >= 128 then data[k] = data[k] - 256 end end
            tag.v["LakeDrawing" .. p] = { t = "byte_array", v = data }
          end
        end
      end
      local stack = { name = "computercraft:" .. (#pages == 1 and "printed_page" or "printed_pages"), count = 1, tag = tag }
      local inSlot = o.item
      if inSlot and isFolder(inSlot) then
        inSlot.tag = inSlot.tag or N.compound()
        local items = N.get(inSlot.tag, "Items") or { t = "list", v = {} }
        if REQUIRE_MATERIALS then
          local available = 0
          for _, e in ipairs(items.v) do if N.getString(e, "id") == "minecraft:paper" then available = available + N.getByte(e, "Count") end end
          if available < #pages then
            error("Not enough paper in the folder (need " .. #pages .. ", found " .. available .. ")", 0)
          end
          local out, remaining = {}, #pages
          for _, e in ipairs(items.v) do
            if remaining > 0 and N.getString(e, "id") == "minecraft:paper" then
              local count = N.getByte(e, "Count")
              local take = math.min(remaining, count)
              remaining = remaining - take
              if count - take > 0 then
                local copy = N.copy(e)
                copy.v.Count = N.byte(count - take)
                out[#out + 1] = copy
              end
            else
              out[#out + 1] = e
            end
          end
          items = { t = "list", v = out }
        end
        local used = {}
        for _, e in ipairs(items.v) do used[N.getByte(e, "Slot")] = true end
        local free
        for k = 0, SLOTS - 1 do if not used[k] then free = k break end end
        if not free then error("Folder is full", 0) end
        local entry = N.compound({ Slot = N.byte(free), id = N.str(stack.name), Count = N.byte(1), tag = tag })
        items.v[#items.v + 1] = entry
        inSlot.tag.v.Items = items
        setItem(inSlot)
      elseif REQUIRE_MATERIALS then
        if not (inSlot and isPaper(inSlot)) or inSlot.count ~= #pages then
          error(("Printing requires paper: a folder containing %d+ paper, or an exact stack of %d paper in the slot")
            :format(#pages, #pages), 0)
        end
        setItem(stack)
      else
        setItem(stack)
      end
    end
    function m.scanBook()
      local it = requireItem()
      local nbt = it.tag
      local out, pages = {}, {}
      if it.name == "minecraft:writable_book" then
        out.type = "writable"
        local list = N.get(nbt, "pages")
        for i, p in ipairs(list and list.t == "list" and list.v or {}) do pages[i] = p.t == "string" and p.v or "" end
      elseif it.name == "minecraft:written_book" then
        out.type = "written"
        if nbt then
          out.title = N.getString(nbt, "title")
          out.author = N.getString(nbt, "author")
          out.generation = N.getInt(nbt, "generation")
          local list = N.get(nbt, "pages")
          for i, p in ipairs(list and list.t == "list" and list.v or {}) do
            local raw = p.t == "string" and p.v or ""
            -- Component.Serializer.fromJson(raw).getString(): the plain text of a JSON text component
            local plain = raw
            local okj, comp = pcall(textutils.unserializeJSON, raw)
            if okj and comp ~= nil then
              local function flatten(c)
                if type(c) == "string" then return c end
                if type(c) == "number" or type(c) == "boolean" then return tostring(c) end
                if type(c) ~= "table" then return "" end
                if c[1] ~= nil then
                  local parts = {}
                  for _, e in ipairs(c) do parts[#parts + 1] = flatten(e) end
                  return table.concat(parts)
                end
                local s = type(c.text) == "string" and c.text or ""
                for _, e in ipairs(type(c.extra) == "table" and c.extra or {}) do s = s .. flatten(e) end
                return s
              end
              plain = flatten(comp)
            end
            pages[i] = plain
          end
        end
      else
        error("Item is not a book and quill or written book", 0)
      end
      out.pages = pages
      out.pageCount = #pages
      return out
    end
    function m.scanMap()
      local d = mapData()
      local decorations = {}
      for i, dec in ipairs(type(d.decorations) == "table" and d.decorations or {}) do
        decorations[i] = { type = tostring(dec.type or "player"):lower(), x = math.floor(tonumber(dec.x) or 0),
          y = math.floor(tonumber(dec.y) or 0), rotation = math.floor(tonumber(dec.rotation) or 0),
          name = type(dec.name) == "string" and dec.name or nil }
      end
      return { centerX = math.floor(tonumber(d.centerX) or 0), centerZ = math.floor(tonumber(d.centerZ) or 0),
        scale = math.floor(tonumber(d.scale) or 0), locked = d.locked == true,
        dimension = type(d.dimension) == "string" and d.dimension or "minecraft:overworld", decorations = decorations }
    end
    function m.scanMapPixels()
      local colors = mapColors(mapData())
      local rows = {}
      for z = 0, 127 do rows[z + 1] = string.char(table.unpack(colors, z * 128 + 1, z * 128 + 128)) end
      return { width = 128, height = 128, rows = rows }
    end
    local function rgbOf(colors)
      local rgb = {}
      for i = 1, #colors do rgb[i] = packedToRgb(colors[i]) end
      return rgb
    end
    function m.scanMapForMonitor()
      local rgb = rgbOf(mapColors(mapData()))
      local counts, firstSeen, keys = {}, {}, {}
      for i, c in ipairs(rgb) do
        if not counts[c] then counts[c] = 0; firstSeen[c] = i; keys[#keys + 1] = c end
        counts[c] = counts[c] + 1
      end
      -- a HashMap's entries sorted by count: a stable sort keeps the map's order among equal counts
      local hmOrder = {}
      local strs = {}
      for _, c in ipairs(keys) do strs[#strs + 1] = tostring(c) end
      local cap = 16
      while #keys > cap * 0.75 do cap = cap * 2 end
      for _, c in ipairs(keys) do
        local h = c % 4294967296 -- Integer.hashCode is the value itself
        hmOrder[c] = band(bit32.bxor(h, rshift(h, 16)), cap - 1) * 1e9 + firstSeen[c]
      end
      table.sort(keys, function(a, b)
        if counts[a] ~= counts[b] then return counts[a] > counts[b] end
        return hmOrder[a] < hmOrder[b]
      end)
      local palette = {}
      for i = 1, math.min(16, #keys) do palette[i] = keys[i] end
      while #palette < 16 do palette[#palette + 1] = 0 end
      return blit(rgb, 128, 128, palette)
    end
    function m.scanMapTile()
      local d = mapData()
      local out = blit(rgbOf(mapColors(d)), 128, 128, ATLAS)
      local scale = math.floor(tonumber(d.scale) or 0)
      local cx, cz = math.floor(tonumber(d.centerX) or 0), math.floor(tonumber(d.centerZ) or 0)
      local per = 128 * 2 ^ scale
      out.scale, out.centerX, out.centerZ = scale, cx, cz
      out.gridX = math.floor((cx + 64) / per)
      out.gridZ = math.floor((cz + 64) / per)
      out.dimension = type(d.dimension) == "string" and d.dimension or "minecraft:overworld"
      return out
    end
    local function photo()
      if not EXPOSURE then error("The Exposure mod is not installed", 0) end
      error("ccsim: Exposure photographs are not emulated", 0)
    end
    function m.scanPhoto(index) C.optInt(1, index) photo() end
    function m.scanPhotoForMonitor(index) C.optInt(1, index) photo() end
    function m.scanPhotoForPrint(index, options)
      C.optInt(1, index)
      if options ~= nil then C.table(2, options) end
      photo()
    end
    return o, m
  end

  local DECL = { "hasItem", "getItem", "scanNBT", "fingerprint", "scanContainer", "sha256", "scanFolder", "countInk",
    "scanStamp", "scanPrintout", "createPrintout", "scanBook", "scanMap", "scanMapPixels", "scanMapForMonitor",
    "scanMapTile", "scanPhoto", "scanPhotoForMonitor", "scanPhotoForPrint" }

  local function itemState(it)
    if not it then return nil end
    return { name = it.name, count = it.count, displayName = it.displayName, damage = it.damage,
      maxDamage = it.maxDamage, nbt = it.tag and N.write(it.tag) or nil, map = it.map }
  end

  function M.peripheral(def)
    local o, methods = newScanner(def)
    scanners[def.name] = o
    return {
      methods = methods,
      methodOrder = order(DECL),
      computerThread = { sha256 = true }, -- the one method without mainThread = true
      exactReturns = true,
      state = function() return { item = itemState(o.item) } end,
      detach = function() scanners[def.name] = nil end,
    }
  end

  local handlers = {}
  --- lkSetItem {peripheral, item|null}: a player (or a hopper) puts an item in the slot or takes it out
  function handlers.lkSetItem(cmd)
    local o = scanners[tostring(cmd.peripheral)]
    if not o then return false, "no scanner named " .. tostring(cmd.peripheral) end
    local ok, it = pcall(newItem, cmd.item)
    if not ok then return false, tostring(it) end
    o.setItem(it)
    return true
  end
  --- lkBiometric {peripheral, player, uuid}: a player sneak-clicks the scanner with an empty hand
  function handlers.lkBiometric(cmd)
    local o = scanners[tostring(cmd.peripheral)]
    if not o then return false, "no scanner named " .. tostring(cmd.peripheral) end
    os.queueEvent("scanner_biometric", o.name, tostring(cmd.player or "Steve"),
      tostring(cmd.uuid or "00000000-0000-0000-0000-000000000000"))
    return true
  end
  M.handlers = handlers
  return M
end
