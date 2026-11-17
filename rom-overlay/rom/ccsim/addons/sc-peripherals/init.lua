-- ccsim addon sc-peripherals: SwitchCraft Peripherals 1.10.5 (Fabric, Minecraft 1.20.1), by Lemmmy.
--
-- Written from the mod's source, github.com/SwitchCraftCC/sc-peripherals at commit 50e801b ("feat: 1.10.5"),
-- src/main/kotlin/io/sc3/peripherals/: prints/printer/PrinterPeripheral and PrinterBlockEntity (type "3d_printer"),
-- prints/PrintData, Shapes, posters/printer/PosterPrinterPeripheral and PosterPrinterBlockEntity (type
-- "poster_printer"), posters/PosterPrintData, util/InventoryPeripheral, util/LuaTableExt, and the default config
-- (resources/data/sc-peripherals/default-config.toml). The poster's default palette is MapColor's, as for
-- lakes-cc-additions (read from Minecraft's own jar).
--
-- Both printers tick every server tick: the input slots are taken in (chamelium, ink cartridges), a committed job
-- takes its materials, and the item comes out maxPrintProgress ticks later. Here the ticks run on the virtual clock.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local order = dofile("/rom/ccsim/addons/javamap.lua").order
  local band, bor, lshift, rshift = bit32.band, bit32.bor, bit32.lshift, bit32.rshift
  local M = {}
  local cfg = core.world.scPeripherals or {}
  local function conf(key, default) return tonumber(cfg[key]) or default end
  local PRINT_TICKS = conf("printTicks", 100)
  local CHAMELIUM_VALUE = conf("chameliumValue", 2000)
  local INK_VALUE = conf("inkValue", 50000)
  local MAX_LIGHT = conf("maxBaseLightLevel", 7)
  local MAX_SHAPES = conf("maxShapes", 128)
  local REDSTONE_COST = conf("customRedstoneCost", 300)
  local NOCLIP_MULT = conf("noclipCostMultiplier", 2)
  local POSTER_TICKS = conf("posterPrintTicks", 100)
  local POSTER_INK = conf("posterInkCost", 5000)
  local MAX_CHAMELIUM, MAX_INK = 256000, 100000
  local MAX_LABEL, MAX_TOOLTIP = 48, 256
  local MAPCOLOR = { [0] = 0, 8368696, 16247203, 13092807, 16711680, 10526975, 10987431, 31744, 16777215, 10791096,
    9923917, 7368816, 4210943, 9402184, 16776437, 14188339, 11685080, 6724056, 15066419, 8375321, 15892389, 5000268,
    10066329, 5013401, 8339378, 3361970, 6704179, 6717235, 10040115, 1644825, 16445005, 6085589, 4882687, 55610,
    8476209, 7340544, 13742497, 10441252, 9787244, 7367818, 12223780, 6780213, 10505550, 3746083, 8874850, 5725276,
    8014168, 4996700, 4993571, 5001770, 9321518, 2430480, 12398641, 9715553, 6035741, 1474182, 3837580, 5647422,
    1356933, 6579300, 14200723, 8365974, [62] = 0, [63] = 0 }
  local CHAMELIUM, INK, EMPTY_INK = "sc-peripherals:chamelium", "sc-peripherals:ink_cartridge",
    "sc-peripherals:empty_ink_cartridge"

  local function now() return os.epoch("utc") end
  local function tickOf(t) return math.floor(t / 50) end
  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end
  local function coerce(v, lo, hi) return math.max(lo, math.min(hi, v)) end

  -- ===== text (Lua bytes -> Java strings -> Lua bytes) =====

  --- UTF-8 bytes to code points (malformed bytes become U+FFFD, as StandardCharsets.UTF_8.decode does)
  local function utf8Decode(s)
    local out, i = {}, 1
    while i <= #s do
      local c = s:byte(i)
      local n, cp = 0, c
      if c < 0x80 then n = 0
      elseif c >= 0xC2 and c < 0xE0 then n, cp = 1, c - 0xC0
      elseif c >= 0xE0 and c < 0xF0 then n, cp = 2, c - 0xE0
      elseif c >= 0xF0 and c < 0xF5 then n, cp = 3, c - 0xF0
      else n, cp = -1, 0xFFFD end
      if n > 0 then
        local okSeq = true
        for k = 1, n do
          local d = s:byte(i + k)
          if not d or d < 0x80 or d >= 0xC0 then okSeq = false break end
          cp = cp * 64 + (d - 0x80)
        end
        if okSeq then
          out[#out + 1] = cp
          i = i + n + 1
        else
          out[#out + 1] = 0xFFFD
          i = i + 1
        end
      else
        out[#out + 1] = cp
        i = i + 1
      end
    end
    return out
  end
  --- a Java String (as code points; above U+FFFF counts twice) back to Lua: chars above 255 become "?"
  local function toLua(cps)
    local out = {}
    for i, cp in ipairs(cps) do out[i] = cp <= 255 and string.char(cp) or "?" end
    return table.concat(out)
  end
  local function jlen(cps)
    local n = 0
    for _, cp in ipairs(cps) do n = n + (cp > 0xFFFF and 2 or 1) end
    return n
  end
  local function latin1(s) local t = {} for i = 1, #s do t[i] = s:byte(i) end return t end

  --- PrintData.sanitiseLabel / sanitiseTooltip: 1..max chars, else none; then the invalid chars go
  local function sanitise(cps, max, newlines)
    if not cps or jlen(cps) < 1 or jlen(cps) > max then return nil end
    local out = {}
    for _, cp in ipairs(cps) do
      -- SharedConstants.isValidChar: not the section sign, not below a space, not DEL; the mod allows § and U+E000
      if (cp ~= 0xA7 and cp >= 32 and cp ~= 127) or cp == 0xA7 or cp == 0xE000 or (newlines and cp == 10) then
        out[#out + 1] = cp
      end
    end
    return out
  end

  -- ===== the 3D printer =====

  local printers = {}

  local function newPrintData()
    return { label = nil, tooltip = nil, isButton = false, collideWhenOn = true, collideWhenOff = true,
      lightWhenOn = true, lightWhenOff = true, lightLevel = 0, redstoneLevel = 0, seatPos = nil,
      shapesOff = {}, shapesOn = {} }
  end
  local function shapeKey(s) return table.concat({ s[1], s[2], s[3], s[4], s[5], s[6], s.texture or "", s.tint }, ",") end
  local function costs(d)
    local volume, surface = 0, 0
    for _, set in ipairs({ d.shapesOff, d.shapesOn }) do
      for _, s in pairs(set) do
        local x, y, z = s[4] - s[1], s[5] - s[2], s[6] - s[3]
        volume = volume + x * y * z
        surface = surface + 2 * (x * y + y * z + x * z)
      end
    end
    if volume <= 0 then return nil end
    local redstone = (d.redstoneLevel >= 1 and d.redstoneLevel <= 14) and REDSTONE_COST or 0
    local noclip = (not d.collideWhenOff or not d.collideWhenOn) and NOCLIP_MULT or 1
    local chamelium = (math.max(volume / 2, 1) + redstone) * noclip
    local ink = math.max(surface / 6, 1)
    return math.floor(chamelium), math.floor(ink)
  end
  local function count(set) local n = 0 for _ in pairs(set) do n = n + 1 end return n end
  local function dataKey(d)
    local function shapes(set)
      local keys = {}
      for k in pairs(set) do keys[#keys + 1] = k end
      table.sort(keys)
      return table.concat(keys, ";")
    end
    return table.concat({ d.label and toLua(d.label) or "", d.tooltip and toLua(d.tooltip) or "", tostring(d.isButton),
      tostring(d.collideWhenOn), tostring(d.collideWhenOff), tostring(d.lightWhenOn), tostring(d.lightWhenOff),
      d.lightLevel, d.redstoneLevel, d.seatPos and table.concat(d.seatPos, ",") or "", shapes(d.shapesOff), "|",
      shapes(d.shapesOn) }, "#")
  end

  local function newPrinter(def, poster)
    local s = saved(def.name)
    local inv = host.newInventory({ name = def.name, size = 3, items = s and s.items or def.items })
    local items = inv.__state()
    local o = { name = def.name, poster = poster, inv = inv }
    o.chamelium = math.floor(tonumber(s and s.chamelium or def.chamelium) or 0)
    o.ink = math.floor(tonumber(s and s.ink or def.ink) or 0)
    o.printing, o.printCount, o.printProgress, o.output = false, 0, 0, nil
    o.lastTick = tickOf(now())
    o.data = newPrintData()
    if poster then
      o.data = { colors = {}, palette = {}, posterId = nil }
      for i = 0, 63 do o.data.palette[i] = MAPCOLOR[i] end
    end
    local nextPoster = 0

    local function event(name, ...) os.queueEvent(name, ...) end
    local STATE = poster and "poster_printer_state" or "3d_printer_state"
    local COMPLETE = poster and "poster_printer_complete" or "3d_printer_complete"

    local function canPrint3d()
      return count(o.data.shapesOff) > 0 and count(o.data.shapesOff) <= MAX_SHAPES and count(o.data.shapesOn) <= MAX_SHAPES
    end
    local function posterCost()
      local pixels = 0
      for i = 0, 16383 do if (o.data.colors[i] or 0) ~= 0 then pixels = pixels + 1 end end
      local cost = math.floor(POSTER_INK * (pixels / 16384) + 0.5)
      return math.max(cost, pixels > 0 and 1 or 0)
    end
    local function outputItem()
      if poster then
        local id = o.data.posterId
        if not id then
          nextPoster = nextPoster + 1
          id = def.name .. "-" .. nextPoster -- PosterItem.create gives a new poster its own id
        end
        return { name = "sc-peripherals:poster", count = 1, key = "poster:" .. id, posterId = id }
      end
      return { name = "sc-peripherals:print", count = 1, key = "print:" .. dataKey(o.data),
        displayName = o.data.label and toLua(o.data.label) or nil }
    end
    local function canMerge(out)
      local cur = items[3]
      return cur == nil or (cur.key ~= nil and cur.key == out.key)
    end
    local function canPrintPoster()
      if o.output == nil then
        local out = outputItem()
        if poster and not o.data.posterId then nextPoster = nextPoster - 1 end -- a look, not a print
        if canMerge(out) and o.ink >= posterCost() and items[1] and items[1].count >= 1 then return true end
      end
      return false
    end
    local function status()
      if o.printing or o.printProgress > 0 then return "busy", o.printProgress end
      if poster then return "idle", canPrintPoster() end
      return "idle", canPrint3d()
    end
    local function setPrinting(v)
      local old = o.printing
      o.printing = v
      o.printProgress = 0
      if not old and v then event(STATE, (status())) end
    end
    o.setPrinting = setPrinting
    local function dataUpdated()
      local was = o.printing
      setPrinting(false)
      if was then event(STATE, (status())) end
    end

    -- one server tick (PrinterBlockEntity / PosterPrinterBlockEntity.onTick)
    local function tickOnce()
      -- tickInputSlot
      if not poster then
        local c = items[1]
        local value = c and c.name == CHAMELIUM and CHAMELIUM_VALUE or 0
        if value > 0 and MAX_CHAMELIUM - o.chamelium >= value then
          c.count = c.count - 1
          if c.count <= 0 then items[1] = nil end
          o.chamelium = o.chamelium + value
        end
      end
      local k = items[2]
      if k and k.name == INK and MAX_INK - o.ink >= INK_VALUE then
        o.ink = o.ink + INK_VALUE
        items[2] = { name = EMPTY_INK, count = 1 } -- the stack of one is taken, an empty cartridge put back
      end
      -- tickOutputSlot
      if poster then
        if o.printing and canPrintPoster() then
          o.ink = o.ink - posterCost()
          items[1].count = items[1].count - 1
          if items[1].count <= 0 then items[1] = nil end
          o.printCount = o.printCount - 1
          o.output = outputItem()
          o.data.posterId = o.output.posterId
          if o.printCount < 1 then setPrinting(false) end
        end
      elseif o.printing and o.output == nil and canMerge(outputItem()) then
        local ch, ink = costs(o.data)
        if ch then
          if o.chamelium >= ch and o.ink >= ink then
            o.chamelium, o.ink = o.chamelium - ch, o.ink - ink
            o.printCount = o.printCount - 1
            o.output = outputItem()
            if o.printCount < 1 then setPrinting(false) end
          end
        else
          setPrinting(false)
          o.data = newPrintData()
          dataUpdated()
        end
      end
      if o.output then
        local max = poster and POSTER_TICKS or PRINT_TICKS
        o.printProgress = math.min(o.printProgress + 1, max)
        if o.printProgress >= max then
          local result = items[3]
          if result == nil then
            items[3] = o.output
          elseif result.count < 64 and canMerge(o.output) then
            result.count = result.count + 1
          else
            return
          end
          o.printProgress = 0
          o.output = nil
          event(COMPLETE, o.printCount)
          event(STATE, (status()))
        end
      end
    end
    local function idle()
      if o.printing or o.output then return false end
      local c, k = items[1], items[2]
      if not poster and c and c.name == CHAMELIUM and MAX_CHAMELIUM - o.chamelium >= CHAMELIUM_VALUE then return false end
      if k and k.name == INK and MAX_INK - o.ink >= INK_VALUE then return false end
      return true
    end
    function o.catchUp()
      local target = tickOf(now())
      while o.lastTick < target do
        o.lastTick = o.lastTick + 1
        tickOnce()
        if idle() then o.lastTick = target end
      end
    end
    function o.nextBusyTick()
      if idle() then return nil end
      if o.output and not o.printing then
        return o.lastTick + math.max(1, (poster and POSTER_TICKS or PRINT_TICKS) - o.printProgress)
      end
      return o.lastTick + 1
    end
    o.status, o.dataUpdated = status, dataUpdated
    return o
  end

  local timerAt
  local function schedule()
    local soonest
    for _, o in pairs(printers) do
      o.catchUp()
      local at = o.nextBusyTick()
      if at and (not soonest or at < soonest) then soonest = at end
    end
    if not soonest or (timerAt and timerAt <= soonest) then return end
    timerAt = soonest
    core.after(math.max(0, soonest * 50 - now()) / 1000, function()
      timerAt = nil
      schedule()
      core.touch() -- the sim state shows what the ticks did
    end)
  end

  local function optBool(i, v) if v == nil then return nil end return C.bool(i, v) end
  local function optNum(i, v)
    if v == nil then return nil end
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end
  local function optBytes(i, v)
    if v == nil then return nil end
    if type(v) ~= "string" then error(("bad argument #%d (string expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end

  local function printerMethods(o)
    local m = {}
    local d = function() return o.data end
    local function wrap(fn) return function(...) o.catchUp() local r = table.pack(fn(...)) schedule() return table.unpack(r, 1, r.n) end end
    function m.reset() o.data = newPrintData() o.dataUpdated() end
    function m.getLabel() local l = d().label return l and toLua(l) or nil end
    function m.setLabel(s)
      s = optBytes(1, s)
      d().label = s and sanitise(utf8Decode(s), MAX_LABEL, false) or nil
      o.dataUpdated()
    end
    function m.getTooltip() local t = d().tooltip return t and toLua(t) or nil end
    function m.setTooltip(s)
      s = optBytes(1, s)
      d().tooltip = s and sanitise(utf8Decode(s), MAX_TOOLTIP, true) or nil
      o.dataUpdated()
    end
    function m.getLightLevel() return d().lightLevel end
    function m.setLightLevel(v) d().lightLevel = coerce(C.int(1, v), 0, MAX_LIGHT) o.dataUpdated() end
    function m.getRedstoneLevel() return d().redstoneLevel end
    function m.setRedstoneLevel(v) d().redstoneLevel = coerce(C.int(1, v), 0, 15) o.dataUpdated() end
    function m.getButtonMode() return d().isButton end
    function m.setButtonMode(v) d().isButton = C.bool(1, v) o.dataUpdated() end
    function m.isCollidable() return d().collideWhenOff, d().collideWhenOn end
    function m.setCollidable(off, on)
      off, on = C.bool(1, off), C.bool(2, on)
      d().collideWhenOff, d().collideWhenOn = off, on
      o.dataUpdated()
    end
    function m.getStateLighting() return d().lightWhenOff, d().lightWhenOn end
    function m.setStateLighting(off, on)
      off, on = C.bool(1, off), C.bool(2, on)
      d().lightWhenOff, d().lightWhenOn = off, on
      o.dataUpdated()
    end
    function m.getSeatPos()
      local p = d().seatPos
      if p then return p[1], p[2], p[3] end
      return nil, nil, nil
    end
    function m.setSeatPos(x, y, z)
      x, y, z = optNum(1, x), optNum(2, y), optNum(3, z)
      local pos
      if x ~= nil and y ~= nil and z ~= nil then
        local function ok(v) return v >= 0.1 and v <= 0.9 end
        if not (ok(x) and ok(y) and ok(z)) then error("Seat position must be between 0.1 and 0.9 on all axes", 0) end
        pos = { x, y, z }
      end
      d().seatPos = pos
      o.dataUpdated()
    end
    function m.getShapeCount() return count(d().shapesOff), count(d().shapesOn) end
    function m.getMaxShapeCount() return MAX_SHAPES end
    local function addShape(minX, minY, minZ, maxX, maxY, maxZ, texture, state, tint)
      if count(d().shapesOff) >= MAX_SHAPES or count(d().shapesOn) >= MAX_SHAPES then error("Too many shapes", 0) end
      local a = { coerce(minX, 0, 16), coerce(minY, 0, 16), coerce(minZ, 0, 16), coerce(maxX, 0, 16),
        coerce(maxY, 0, 16), coerce(maxZ, 0, 16) }
      -- a Box puts the smaller corner first
      local box = { math.min(a[1], a[4]), math.min(a[2], a[5]), math.min(a[3], a[6]), math.max(a[1], a[4]),
        math.max(a[2], a[5]), math.max(a[3], a[6]) }
      if box[4] - box[1] <= 0 or box[5] - box[2] <= 0 or box[6] - box[3] <= 0 then error("Empty block", 0) end
      local tex
      if texture ~= nil and #texture > 0 then
        tex = texture:sub(1, 64)
        if not tex:find(":") then tex = "minecraft:" .. tex end
        -- new Identifier(...): its namespace and path are checked, and a bad one is an unchecked exception
        local ns, p = tex:match("^(.-):(.*)$")
        if not ns:match("^[a-z0-9_%.%-]*$") then
          error("Java Exception Thrown: net.minecraft.util.InvalidIdentifierException: Non [a-z0-9_.-] character in namespace of location: " .. tex, 0)
        elseif not p:match("^[a-z0-9_%.%-/]*$") then
          error("Java Exception Thrown: net.minecraft.util.InvalidIdentifierException: Non [a-z0-9/._-] character in path of location: " .. tex, 0)
        end
      end
      box.texture = tex
      box.tint = band(tint or 0xFFFFFF, 0xFFFFFF)
      local set = state and d().shapesOn or d().shapesOff
      set[shapeKey(box)] = box -- a HashSet: an equal shape is there once
      o.dataUpdated()
    end
    function m.addShape(minX, minY, minZ, maxX, maxY, maxZ, texture, state, tint)
      minX, minY, minZ = C.int(1, minX), C.int(2, minY), C.int(3, minZ)
      maxX, maxY, maxZ = C.int(4, maxX), C.int(5, maxY), C.int(6, maxZ)
      if texture ~= nil then texture = C.str(7, texture) end
      state = optBool(8, state)
      tint = C.optInt(9, tint)
      addShape(minX, minY, minZ, maxX, maxY, maxZ, texture, state == true, tint)
    end
    function m.addShapes(shapes)
      shapes = C.table(1, shapes)
      for i, shape in pairs(shapes) do
        if type(i) ~= "number" or i ~= i or i == math.huge or i == -math.huge then error("Invalid shape table", 0) end
        if type(shape) ~= "table" then
          error(("bad item #%d (table expected, got %s)"):format(C.toInt(i), C.typeName(shape)), 0)
        end
        local texture = shape.texture
        if texture ~= nil and type(texture) ~= "string" then
          error(("bad field 'texture' (string expected, got %s)"):format(C.typeName(texture)), 0)
        end
        local function int(k)
          local v = shape[k]
          if type(v) ~= "number" then
            if type(k) == "string" then error(("bad field '%s' (number expected, got %s)"):format(k, C.typeName(v)), 0) end
            error(("bad item #%d (number expected, got %s)"):format(k, C.typeName(v)), 0)
          end
          if v ~= v or v == math.huge or v == -math.huge then
            local t = v ~= v and "nan" or (v > 0 and "inf" or "-inf")
            if type(k) == "string" then error(("bad field '%s' (number expected, got %s)"):format(k, t), 0) end
            error(("bad item #%d (number expected, got %s)"):format(k, t), 0)
          end
          return C.toInt(v)
        end
        addShape(int(1), int(2), int(3), int(4), int(5), int(6), texture, shape.state == true,
          shape.tint ~= nil and int("tint") or nil)
      end
    end
    function m.commit(n)
      n = C.int(1, n)
      if not (count(d().shapesOff) > 0 and count(d().shapesOff) <= MAX_SHAPES and count(d().shapesOn) <= MAX_SHAPES) then
        error("Model is invalid", 0)
      end
      o.printCount = coerce(n, 0, 2147483647)
      o.setPrinting(o.printCount > 0)
      return o.printCount > 0
    end
    function m.stop() o.printCount = 0 o.setPrinting(false) end
    function m.status() return o.status() end
    function m.getChameliumLevel() return o.chamelium, MAX_CHAMELIUM end
    function m.getInkLevel() return o.ink, MAX_INK end
    for k, fn in pairs(m) do m[k] = wrap(fn) end
    return m, { "reset", "getLabel", "setLabel", "getTooltip", "setTooltip", "getLightLevel", "setLightLevel",
      "getRedstoneLevel", "setRedstoneLevel", "getButtonMode", "setButtonMode", "isCollidable", "setCollidable",
      "getStateLighting", "setStateLighting", "getSeatPos", "setSeatPos", "getShapeCount", "getMaxShapeCount",
      "addShape", "addShapes", "commit", "stop", "status", "getChameliumLevel", "getInkLevel" }
  end

  local function posterMethods(o)
    local m = {}
    local function wrap(fn) return function(...) o.catchUp() local r = table.pack(fn(...)) schedule() return table.unpack(r, 1, r.n) end end
    local function byte(v) -- Number.toByte(): to int (toward zero), then the low 8 bits, signed
      local i = C.toInt(v) % 256
      return i >= 128 and i - 256 or i
    end
    local function list(t, transform)
      local size = 0
      for _ in pairs(t) do size = size + 1 end
      local out = {}
      for i = 1, size do
        local v = t[i]
        if v == nil then break end
        out[i] = transform(v)
      end
      return out
    end
    local function num(v)
      if type(v) ~= "number" then error("Expected number", 0) end
      return v
    end
    function m.reset()
      o.data = { colors = {}, palette = {}, posterId = nil }
      for i = 0, 63 do o.data.palette[i] = MAPCOLOR[i] end
      o.dataUpdated()
    end
    function m.getLabel() return o.data.label end
    function m.setLabel(s)
      if s ~= nil then s = C.str(1, s) end
      s = s and s:sub(1, MAX_LABEL) or nil
      o.data.label = (s and #s >= 1) and s or nil
      o.dataUpdated()
    end
    function m.getTooltip() return o.data.tooltip end
    function m.setTooltip(s)
      if s ~= nil then s = C.str(1, s) end
      s = s and s:sub(1, MAX_TOOLTIP) or nil
      o.data.tooltip = (s and #s >= 1) and s or nil
      o.dataUpdated()
    end
    function m.setPaletteColor(index, r, g, b)
      index, r, g, b = C.int(1, index), C.int(2, r), C.int(3, g), C.int(4, b)
      if index < 1 or index > 63 then
        error(("Palette index %d out of range [1, 63]"):format(index) .. (index == 0 and " (0 is reserved for transparent)" or ""), 0)
      end
      o.data.posterId = nil
      o.data.palette[index] = bor(lshift(r, 16), lshift(g, 8), b)
      o.dataUpdated()
    end
    m.setPaletteColour = m.setPaletteColor
    function m.setPixel(x, y, color)
      x, y, color = C.int(1, x), C.int(2, y), C.int(3, color)
      if x < 1 or x > 128 or y < 1 or y > 128 then error("Invalid pixel coordinates", 0) end
      if color < 0 or color > 63 then error(("Color index %d out of range [0, 63]"):format(color), 0) end
      o.data.posterId = nil
      o.data.colors[(x - 1) + (y - 1) * 128] = color
      o.dataUpdated()
    end
    function m.blitPixels(x, y, pixels)
      x, y = C.int(1, x), C.int(2, y)
      pixels = C.table(3, pixels)
      if x < 1 or x > 128 or y < 1 or y > 128 then error("Invalid pixel coordinates", 0) end
      local px = list(pixels, function(v) return byte(num(v)) end)
      if #px > 128 * 128 then error("Too many pixels", 0) end
      o.data.posterId = nil
      for i = 1, #px do
        local color = px[i]
        if color < 0 or color > 63 then error(("Color index %d out of range [0, 63]"):format(color), 0) end
        local index = (x - 1) + (y - 1) * 128 + (i - 1)
        if index >= 128 * 128 then error("Too many pixels", 0) end
        o.data.colors[index] = color
      end
      o.dataUpdated()
    end
    function m.blitPalette(palette)
      palette = C.table(1, palette)
      local p = list(palette, function(v) return C.toInt(num(v)) end)
      if #p > 63 then error(("Too many palette colors (max 63, got %d)"):format(#p), 0) end
      o.data.posterId = nil
      for i = 1, #p do
        if p[i] < 0 or p[i] > 0xFFFFFF then error("Invalid color", 0) end
        o.data.palette[i] = p[i]
      end
      o.dataUpdated()
    end
    function m.commit(n)
      n = C.int(1, n)
      o.printCount = coerce(n, 0, 2147483647)
      o.setPrinting(o.printCount > 0)
      return o.printCount > 0
    end
    function m.stop() o.printCount = 0 o.setPrinting(false) end
    function m.status() return o.status() end
    function m.getInkLevel() return o.ink, MAX_INK end
    for k, fn in pairs(m) do m[k] = wrap(fn) end
    return m, { "reset", "getLabel", "setLabel", "getTooltip", "setTooltip", "setPaletteColor", "setPaletteColour",
      "setPixel", "blitPixels", "blitPalette", "commit", "stop", "status", "getInkLevel" }
  end

  function M.peripheral(def)
    local poster = def.type == "poster_printer"
    local o = newPrinter(def, poster)
    printers[def.name] = o
    local methods, decl
    if poster then methods, decl = posterMethods(o) else methods, decl = printerMethods(o) end
    -- InventoryPeripheral's methods, all mainThread
    local invDecl = { "size", "list", "getItemDetail", "getItemLimit", "pushItems", "pullItems" }
    for _, name in ipairs(invDecl) do
      local fn = o.inv[name]
      methods[name] = function(...) o.catchUp() local r = table.pack(fn(...)) schedule() return table.unpack(r, 1, r.n) end
    end
    for _, name in ipairs(invDecl) do decl[#decl + 1] = name end
    schedule()
    return {
      methods = methods,
      methodOrder = order(decl),
      computerThread = poster and {} or { getMaxShapeCount = true },
      exactReturns = true,
      inventory = o.inv,
      state = function()
        o.catchUp()
        local st, progress = o.status()
        local out = { status = st, progress = progress, printing = o.printing, printCount = o.printCount, ink = o.ink,
          items = {} }
        for slot, it in pairs(o.inv.__state()) do out.items[tostring(slot)] = { name = it.name, count = it.count } end
        if not poster then
          out.chamelium = o.chamelium
          out.shapes = { count(o.data.shapesOff), count(o.data.shapesOn) }
        end
        return out
      end,
      detach = function() printers[def.name] = nil end,
    }
  end

  function M.catchUp() for _, o in pairs(printers) do o.catchUp() end end

  local handlers = {}
  --- scSetItem {peripheral, slot, item|null}: a hopper or player fills or empties a slot (1 input, 2 ink, 3 output)
  function handlers.scSetItem(cmd)
    local o = printers[tostring(cmd.peripheral)]
    if not o then return false, "no 3d_printer or poster_printer named " .. tostring(cmd.peripheral) end
    local slot = tonumber(cmd.slot)
    if slot ~= 1 and slot ~= 2 and slot ~= 3 then return false, "slot must be 1, 2 or 3" end
    o.catchUp()
    local items = o.inv.__state()
    if type(cmd.item) == "table" and type(cmd.item.name) == "string" then
      items[slot] = { name = cmd.item.name, count = math.floor(tonumber(cmd.item.count) or 1) }
    else
      items[slot] = nil
    end
    schedule()
    return true
  end
  M.handlers = handlers
  return M
end
