-- Tom's Peripherals GPU: the drawing API (BaseGPU, GPUImpl, the GPU block's GPUExt), images, byte buffers,
-- windows, rects, fonts and VRAM. A port of these files, statement for statement where it matters:
--   api branch (commit 5dbf6fc, the API the 1.18.2-1.2.1 jar was built with), src/shared/java/com/tom/peripherals/:
--     gpu/BaseGPU, gpu/GPUImpl, gpu/LuaImage, gpu/LuaByteBuffer, gpu/WindowGPUContext, gpu/Rect, gpu/VRAM,
--     gpu/font/Font, gpu/font/FontManager, util/Image, util/ReferenceManager, api/TMLuaObject, api/ITMPeripheral
--   1.18 branch (commit 3b609fa, release 1.2.1), Forge/src/platform-shared/java/com/tom/peripherals/:
--     block/entity/GPUBlockEntity (GPUPeripheral, GPUExt), block/entity/MonitorBlockEntity, util/NativeImageIO
-- Contexts (GPUContext) are tables of closures: set(x, y, c), sync(), vram, width(), height(), bounds().
return function(core, J, fontData, png)
  local G = {}
  local P = J.P
  local i32, floor = J.i32, math.floor
  local band = bit32.band
  local function lerr(msg) error(msg, 0) end

  -- ===== Lua objects (TMLuaObject) =====
  -- Each class has its methods and their names in the order findLuaMethods' HashMap gives them (listMethods and
  -- the table CC builds). Worked out from String.hashCode with the method lists read from the jar (javap).
  G.ORDER = {
    GPUExt = { "newImage", "newBuffer", "addNewChar", "line", "freeChars", "createWindow", "getBounds", "clearChars",
      "setSize", "drawChar", "getFontDefaultCharID", "setFont", "delChar", "filledRectangle", "decodeImage",
      "drawBuffer", "drawText", "getUsedMemory", "setFontDefaultCharID", "fill", "sync", "drawImage", "getSize",
      "getTextLength", "refreshSize", "getMaxMemory", "listMethods", "imageFromBuffer", "getFont", "rectangle",
      "drawTextSmart", "lineS", "createWindow3D" },
    BaseGPU = { "addNewChar", "line", "freeChars", "createWindow", "getBounds", "clearChars", "drawChar",
      "getFontDefaultCharID", "setFont", "delChar", "filledRectangle", "drawBuffer", "drawText",
      "setFontDefaultCharID", "fill", "sync", "drawImage", "getSize", "getTextLength", "listMethods", "getFont",
      "rectangle", "drawTextSmart", "lineS", "createWindow3D" },
    GPUImpl = { "newImage", "newBuffer", "addNewChar", "line", "freeChars", "createWindow", "getBounds", "clearChars",
      "drawChar", "getFontDefaultCharID", "setFont", "delChar", "filledRectangle", "decodeImage", "drawBuffer",
      "drawText", "getUsedMemory", "setFontDefaultCharID", "fill", "sync", "drawImage", "getSize", "getTextLength",
      "getMaxMemory", "listMethods", "imageFromBuffer", "getFont", "rectangle", "drawTextSmart", "lineS",
      "createWindow3D" },
    LuaImage = { "getAsBuffer", "gpuDraw", "getHeight", "ref", "setRGB", "listMethods", "getWidth", "free",
      "saveImage", "getRGB" },
    LuaByteBuffer = { "ref", "read", "length", "available", "listMethods", "free", "write" },
    Rect = { "setW", "getW", "setY", "getX", "getH", "setX", "setH", "getY", "listMethods" },
  }

  local wrap
  --- CCComputer.mapTo: a returned TMLuaObject becomes a table of functions (a fresh one per return).
  local function mapTo(r, from)
    for k = from, r.n do
      local v = r[k]
      if type(v) == "table" and v.__class then r[k] = wrap(v) end
    end
    return table.unpack(r, from, r.n)
  end
  G.mapTo = mapTo

  --- The table CC hands Lua for a TMLuaObject. TMLuaObject.call turns any exception but a LuaException into
  --- "Java Exception: <exception>".
  function wrap(obj)
    local class = obj.__class
    local t = {}
    for _, name in ipairs(class.order) do
      if name == "listMethods" then
        t[name] = function() return table.unpack(class.order) end
      else
        local fn = class.methods[name]
        t[name] = function(...)
          local r = table.pack(pcall(fn, obj, table.pack(...)))
          if not r[1] then
            local e = r[2]
            if J.isJava(e) then e = "Java Exception: " .. tostring(e) end
            error(e, 2)
          end
          return mapTo(r, 2)
        end
      end
    end
    return t
  end
  G.wrap = wrap

  local function class(name, methods)
    return { name = name, order = G.ORDER[name], methods = methods }
  end
  G.class = class

  -- ===== VRAM and references =====

  --- VRAM: objects in a weak set (Java: a WeakHashMap), so what Lua drops stops counting once it is collected.
  function G.newVram(max)
    local v = { max = max, objects = setmetatable({}, { __mode = "k" }), intFonts = {},
      refs = setmetatable({}, { __mode = "v" }), seed = 0x2545F491 }
    function v.used()
      local sum = 0
      for o in pairs(v.objects) do sum = sum + o.vsize() end
      return sum
    end
    function v.alloc(o) v.objects[o] = true end
    function v.checkSize(size) return v.used() + size <= v.max end
    function v.checkSizeEx(size) if not v.checkSize(size) then lerr("Alloc failed: Out of VRAM") end end
    function v.allocEx(o, size)
      if not v.checkSize(size) then lerr("Alloc failed: Out of VRAM") end
      v.alloc(o)
    end
    function v.realloc(o, size)
      local sum = 0
      for other in pairs(v.objects) do if other ~= o then sum = sum + other.vsize() end end
      return sum + size <= v.max
    end
    function v.reallocEx(o, size) if not v.realloc(o, size) then lerr("Realloc failed: Out of VRAM") end end
    function v.free(o) v.objects[o] = nil end
    --- ReferenceManager.createReference: "ref:" + hex(hashCode ^ random). Here a fixed sequence, so runs repeat.
    function v.createReference(o)
      v.seed = (v.seed * 1103515245 + 12345) % 4294967296
      local key = string.format("ref:%x", v.seed)
      v.refs[key] = o
      return key
    end
    function v.get(ref) return v.refs[ref] end
    function v.remove(ref) v.refs[ref] = nil end
    return v
  end

  -- ===== fonts (Font, FontManager) =====

  local function prepare(name, d)
    local f = { name = name, h = d.h, n = d.n, widths = {}, rows = d.rows, partial = d.partial, index = {} }
    for i = 1, #d.widths do f.widths[i - 1] = d.widths[i] end
    if d.chars then
      for i, c in ipairs(d.chars) do if f.index[c] == nil then f.index[c] = i - 1 end end
    end
    f.UNKNOWN = f.index[0x3F] or 0
    return f
  end

  local MISSING = { missing = true, h = 0, UNKNOWN = 0 } -- Font.MISSING: no arrays, int fields 0, name null
  local fonts = {} -- FontManager.fonts: static, shared by every GPU
  local NULLKEY = {}

  local function newCustom(name)
    local f = { name = name, h = 16, n = 256, widths = {}, rows = {}, custom = true, chars = {}, UNKNOWN = 0 }
    for i = 0, 255 do f.widths[i], f.chars[i] = 1, 0 end
    return f
  end

  local function loadFont(name)
    local d = fontData and fontData[name]
    if not d then return nil end
    if d.custom then return { name = name, customProto = true } end
    return prepare(name, d)
  end

  local function getFont(f, intFonts)
    if f.customProto then
      local c = intFonts[f.name]
      if not c then c = newCustom(f.name); intFonts[f.name] = c end
      return c
    end
    return f
  end

  function G.getOrLoadFont(intFonts, s)
    local key = s == nil and NULLKEY or s
    local f = fonts[key]
    if f then return getFont(f, intFonts) end
    f = s ~= nil and loadFont(s) or nil
    if not f then
      fonts[key] = MISSING
      lerr("Font file not found")
    end
    fonts[key] = f
    return getFont(f, intFonts)
  end
  fonts.ascii = fontData and prepare("ascii", fontData.ascii) or nil -- no fonts.lua: init.lua refuses the GPU
  local DEF = fonts.ascii

  local function needFont(f, field, what)
    if f.missing then J.npe('Cannot ' .. what .. ' because "this.selectedFont.' .. field .. '" is null') end
  end

  --- chars2.indexOf(c)
  local function indexOf(f, c)
    if f.custom then
      for i = 0, 255 do if f.chars[i] == c then return i end end
      return -1
    end
    local i = f.index[c]
    return i == nil and -1 or i
  end
  --- chars[index], with Java's bounds check
  local function glyphRow(f, index, j)
    if f.custom then
      return f.rows[index * 16 + j] or 0
    end
    if f.partial and index ~= 0 then return 0 end
    return f.rows[(f.partial and 0 or index) * f.h + j + 1] or 0
  end
  local function checkIndex(f, index)
    if index < 0 or index >= f.n then J.aioobe(index, f.n) end
  end

  local function textLength(f, s, size, padding)
    if #s > 0 then needFont(f, "chars2", 'invoke "String.indexOf(int)"') end
    local l = 0
    for i = 1, #s do
      local d = s:byte(i)
      local index = indexOf(f, d)
      if index == -1 then index = f.UNKNOWN end
      checkIndex(f, index)
      local w = f.widths[index]
      if d == 32 then w = 5 end
      l = i32(l + (w + padding) * size)
    end
    return l
  end

  -- ===== BaseGPU =====

  local function fillPx(set, x, ox, y, oy, size, col)
    for i = 0, size - 1 do
      for j = 0, size - 1 do set(x + ox * size + i, y + oy * size + j, col) end
    end
  end

  local function isAioobe(e) return J.isJava(e) and e.class == "java.lang.ArrayIndexOutOfBoundsException" end

  --- One character, as drawText and drawTextSmart both draw it; returns the next x.
  local function drawGlyph(ctx, f, d, wx, y, size, padding, c, bg)
    local index = indexOf(f, d)
    if index == -1 then index = f.UNKNOWN end
    checkIndex(f, index)
    local h = f.h
    local w = f.widths[index]
    local set = ctx.set
    if d == 32 then
      w = 5
      if bg > -1 then
        for j = 0, h - 1 do
          for k = 0, w - 1 do fillPx(set, wx, k, y, j, size, bg) end
        end
      end
    else
      for j = 0, h - 1 do
        local b = glyphRow(f, index, j)
        for k = 0, w - 1 do
          if band(b, J.bit(k)) ~= 0 then
            fillPx(set, wx, k, y, j, size, c)
          elseif bg > -1 then
            fillPx(set, wx, k, y, j, size, bg)
          end
        end
      end
    end
    if bg > -1 then
      for j = 0, h - 1 do
        for k = 0, padding - 1 do fillPx(set, wx, w + k, y, j, size, bg) end
      end
    end
    return i32(wx + (w + padding) * size)
  end

  local function lineBresenham(set, x0, y0, x1, y1, col)
    local dx = math.abs(x1 - x0)
    local sx = x0 < x1 and 1 or -1
    local dy = -math.abs(y1 - y0)
    local sy = y0 < y1 and 1 or -1
    local err = dx + dy
    while true do
      set(x0, y0, col)
      if x0 == x1 and y0 == y1 then break end
      local e2 = 2 * err
      if e2 >= dy then err = err + dy; x0 = x0 + sx end
      if e2 <= dx then err = err + dx; y0 = y0 + sy end
    end
  end
  G.lineBresenham = lineBresenham

  local function lineF(ctx, x0, y0, x1, y1, col)
    local W, H = ctx.width(), ctx.height()
    if x0 < 0 or x1 < 0 or x0 > W or x1 > W then J.throw("java.lang.ArrayIndexOutOfBoundsException", "Out of bounds: x") end
    if y0 < 0 or y1 < 0 or y0 > H or y1 > H then J.throw("java.lang.ArrayIndexOutOfBoundsException", "Out of bounds: y") end
    local dx, dy = math.abs(x1 - x0), math.abs(y1 - y0)
    local sgnX = x0 < x1 and 1 or -1
    local sgnY = y0 < y1 and 1 or -1
    local e = 0
    for _ = 0, dx + dy - 1 do
      ctx.set(x0, y0, col)
      local e1, e2 = e + dy, e - dx
      if math.abs(e1) < math.abs(e2) then
        x0 = x0 + sgnX; e = e1
      else
        y0 = y0 + sgnY; e = e2
      end
    end
  end

  local function imageOf(vram, ref)
    local o = vram.get(ref)
    if not (o and o.__class and o.__class.name == "LuaImage") then lerr("Invalid reference") end
    return o
  end
  G.imageOf = imageOf

  local B = {} -- BaseGPU methods, (self, a): self.ctx, self.font

  function B.fill(self, a)
    local color = a.n == 0 and 0 or P.toColor(a, 0)
    local ctx = self.ctx
    local i = 0
    while i < ctx.width() do
      local j = 0
      while j < ctx.height() do ctx.set(i, j, color); j = j + 1 end
      i = i + 1
    end
    return true
  end

  local function rectArgs(a)
    if a.n < 4 then lerr("Too few arguments (expected x,y,width,height,[color])") end
    local color = a.n < 5 and 0 or P.toColor(a, 4)
    local xStart = i32(P.getInt(a, 0) - 1)
    local yStart = i32(P.getInt(a, 1) - 1)
    local xStop = i32(xStart + P.getInt(a, 2))
    local yStop = i32(yStart + P.getInt(a, 3))
    return color, xStart, yStart, xStop, yStop
  end

  function B.filledRectangle(self, a)
    local color, xStart, yStart, xStop, yStop = rectArgs(a)
    local ctx = self.ctx
    local W, H = ctx.width(), ctx.height()
    if xStart < W + 1 and yStart < H + 1 and xStart >= 0 and yStart >= 0 then
      if xStop > W then xStop = W end
      if yStop > H then yStop = H end
      for i = xStart, xStop - 1 do
        for y = yStart, yStop - 1 do ctx.set(i, y, color) end
      end
      return true
    end
    lerr("Out of boundary")
  end

  function B.rectangle(self, a)
    local color, xStart, yStart, xStop, yStop = rectArgs(a)
    local ctx = self.ctx
    local W, H = ctx.width(), ctx.height()
    if xStart < W + 1 and yStart < H + 1 and xStart >= 0 and yStart >= 0 then
      if xStop > W then xStop = W end
      if yStop > H then yStop = H end
      for i = xStart, xStop - 1 do
        for y = yStart, yStop - 1 do
          if i == xStart or i == xStop - 1 then ctx.set(i, y, color)
          elseif y == yStart or y == yStop - 1 then ctx.set(i, y, color) end
        end
      end
      return true
    end
    lerr("Out of boundary")
  end

  local function lineArgs(a)
    if a.n < 4 then lerr("Too few arguments (expected x1,y1,x2,y2,[color])") end
    local color = a.n < 5 and 0 or P.toColor(a, 4)
    return color, i32(P.getInt(a, 0) - 1), i32(P.getInt(a, 1) - 1), i32(P.getInt(a, 2) - 1), i32(P.getInt(a, 3) - 1)
  end

  function B.line(self, a)
    local color, x0, y0, x1, y1 = lineArgs(a)
    local ok, e = pcall(lineBresenham, self.ctx.set, x0, y0, x1, y1, color)
    if not ok then
      if isAioobe(e) then lerr(e.msg) end
      error(e, 0)
    end
    return true
  end

  function B.lineS(self, a)
    local color, x0, y0, x1, y1 = lineArgs(a)
    local ok, e = pcall(lineF, self.ctx, x0, y0, x1, y1, color)
    if not ok then
      if isAioobe(e) then lerr(e.msg) end
      error(e, 0)
    end
    return true
  end

  function B.getSize(self) return self.ctx.width(), self.ctx.height() end

  local TEXT_ARGS = "(number x,number y,String text, [number text_color], [number bg_color], [number size], [number padding])"
  function B.drawText(self, a)
    if a.n < 3 then lerr("Too few arguments, excepted " .. TEXT_ARGS) end
    if type(a[1]) == "number" and type(a[2]) == "number" and a[3] ~= nil then
      local ctx, f = self.ctx, self.font
      local x = i32(P.getInt(a, 0) - 1)
      local y = i32(P.getInt(a, 1) - 1)
      local c = P.optionalInt(a, 3, -1)
      local bg = P.optionalInt(a, 4, -1)
      local size = P.optionalInt(a, 5, 1)
      local padding = P.optionalInt(a, 6, 1)
      local s = P.getString(a, 2)
      local l = textLength(f, s, size, padding)
      if x < 0 or i32(l + x) > ctx.width() then
        lerr(string.format("Out of boundary x %d:%d", x, i32(l + x)))
      end
      if y < 0 or (y + f.h) > ctx.height() then lerr("Out of boundary y") end
      local ok, e = pcall(function()
        local wx = x
        for i = 1, #s do wx = drawGlyph(ctx, f, s:byte(i), wx, y, size, padding, c, bg) end
      end)
      if not ok and not J.indexOutOfBounds(e) then error(e, 0) end
      return true
    end
    lerr("Invalid Arguments, excepted " .. TEXT_ARGS)
  end

  function B.getFont(self)
    local f = self.font
    if f.missing then return nil, false end
    return f.name, f.custom == true
  end

  function B.setFont(self, a)
    if a.n > 0 then
      local f = G.getOrLoadFont(self.ctx.vram.intFonts, P.getString(a, 0))
      if f ~= nil then self.font = f end
      return true
    end
    lerr("Invalid Arguments, excepted (string font_name)")
  end

  function B.getTextLength(self, a)
    if a.n > 0 and a[1] ~= nil then
      local size = P.optionalInt(a, 1, 1)
      local padding = P.optionalInt(a, 2, 1)
      return textLength(self.font, J.toString(a[1]), size, padding)
    end
    lerr("Invalid Arguments, excepted (string text, [number size], [number padding])")
  end

  local SMART_ARGS = "(number x,number y,String text, [number text_color], [number bg_color], [boolean force_unicode], [number size], [number padding])"
  function B.drawTextSmart(self, a)
    if a.n < 3 then lerr("Too few arguments, excepted " .. SMART_ARGS) end
    local ctx = self.ctx
    local x = i32(P.getInt(a, 0) - 1)
    local y = i32(P.getInt(a, 1) - 1)
    local c = P.optionalInt(a, 3, -1)
    local bg = P.optionalInt(a, 4, -1)
    local forceUnicode = a.n > 5 and type(a[6]) == "boolean" and a[6] or false
    local sizeIn = P.optionalInt(a, 6, 1)
    local padding = P.optionalInt(a, 7, 1)
    local s = P.getString(a, 2)
    local l = textLength(self.font, s, sizeIn, padding)
    if x < 0 or i32(l + x) > ctx.width() then lerr("Out of boundary x") end
    if y < 0 or (y + self.font.h) > ctx.height() then lerr("Out of boundary y") end
    local name = self.font.name
    local ok, e = pcall(function()
      local wx = x
      for i = 1, #s do
        local size = sizeIn
        local d = s:byte(i)
        if not forceUnicode and d < 256 then
          size = size * 2
          self.font = G.getOrLoadFont(ctx.vram.intFonts, "ascii")
        else
          self.font = G.getOrLoadFont(ctx.vram.intFonts, string.format("unicode_page_%02x", floor(d / 256)))
        end
        wx = drawGlyph(ctx, self.font, d, wx, y, size, padding, c, bg)
      end
    end)
    if not ok and not J.indexOutOfBounds(e) then error(e, 0) end
    self.font = G.getOrLoadFont(ctx.vram.intFonts, name)
    return true
  end

  local function editable(self)
    if not self.font.custom then lerr("Selected font is not modifiable") end
  end

  function B.setFontDefaultCharID(self, a)
    editable(self)
    if a.n > 0 then
      local id = i32(P.getInt(a, 0) - 1)
      if id < 0 then lerr("Bad Argument #1, (too small number (" .. id .. ") minimum value is 1 )") end
      if id > 255 then lerr("Bad Argument #1, (too big number (" .. id .. ") maximum value is 256 )") end
      self.font.UNKNOWN = id
      return true
    end
    lerr("Invalid Arguments, excepted (number id)")
  end

  function B.getFontDefaultCharID(self)
    if self.font.missing then return 0 end
    return self.font.UNKNOWN
  end

  local CHAR_ARGS = "Invalid arguments, expected (string char, number width, 16 x number char_data)"
  function B.addNewChar(self, a)
    editable(self)
    if a.n > 17 then
      local c = P.getString(a, 0)
      if #c ~= 1 then lerr("Bad Argument #1 a sigle character expected") end
      local d = P.ints(a, 1)
      if #d ~= 17 then lerr(CHAR_ARGS) end
      local f, cIn = self.font, c:byte(1)
      for i = 0, 255 do if f.chars[i] == cIn then lerr("Character already exists in sprite") end end
      for i = 0, 255 do
        if f.chars[i] == 0 then
          f.chars[i] = cIn
          local wb = d[1] % 256
          f.widths[i] = wb >= 128 and wb - 256 or wb -- (byte)
          for j = 0, 15 do f.rows[i * 16 + j] = d[j + 2] end
          return i + 1
        end
      end
      lerr("Sprite is full")
    end
    lerr(CHAR_ARGS)
  end

  function B.delChar(self, a)
    editable(self)
    if a.n > 0 and a[1] ~= nil then
      local c = P.getString(a, 0)
      if #c ~= 1 then lerr("Bad Argument #1 a sigle character expected") end
      local f, cIn = self.font, c:byte(1)
      for i = 0, 255 do
        if f.chars[i] == cIn then f.chars[i] = 0; return true end
      end
      lerr("Character not found")
    end
    lerr("Invalid arguments, expected (string char)")
  end

  function B.freeChars(self)
    local f = self.font
    if not f.custom then return 0 end
    local n = 0
    for i = 0, 255 do if f.chars[i] == 0 then n = n + 1 end end
    return n
  end

  function B.clearChars(self)
    local f = self.font
    if not f.custom then lerr("Selected font is not modifiable") end
    for i = 0, 255 do f.widths[i], f.chars[i] = 1, 0 end
    f.rows = {}
    return true
  end

  function B.drawChar(self, a)
    if a.n < 3 then
      lerr("Too few arguments, excepted (number x,number y,number char, [number text_color], [number bg_color], [number size])")
    end
    local ctx, f = self.ctx, self.font
    local x = i32(P.getInt(a, 0) - 1)
    local y = i32(P.getInt(a, 1) - 1)
    local index = i32(P.getInt(a, 2) - 1)
    local c = P.optionalInt(a, 3, -1)
    local bg = P.optionalInt(a, 4, -1)
    local size = P.optionalInt(a, 5, 1)
    if index == -1 then index = f.UNKNOWN end
    needFont(f, "chars", "load from object array")
    checkIndex(f, index)
    local w = f.widths[index]
    local h = f.h
    if x < 0 or (w * size + x) > ctx.width() then lerr("Out of boundary x") end
    if y < 0 or (y + J.idiv(h, w) * size) > ctx.height() then lerr("Out of boundary y") end
    for j = 0, h - 1 do
      local b = glyphRow(f, index, j)
      for k = 0, w - 1 do
        if band(b, J.bit(k)) ~= 0 then fillPx(ctx.set, x, k, y, j, size, c)
        elseif bg > -1 then fillPx(ctx.set, x, k, y, j, size, bg) end
      end
    end
    return true
  end

  function B.drawBuffer(self, a)
    if a.n < 4 then lerr("Too few arguments, excepted (number x,number y,number w, number scale, number... data)") end
    local ctx = self.ctx
    local x = i32(P.getInt(a, 0) - 1)
    local y = i32(P.getInt(a, 1) - 1)
    local w = P.getInt(a, 2)
    local s = P.getInt(a, 3)
    local d = P.uints(a, 4)
    if x < 0 or (w * s + x) > ctx.width() then lerr("Out of boundary x") end
    if y < 0 or (y + J.idiv(#d, w) * s) > ctx.height() then lerr("Out of boundary y") end
    for i = 0, #d - 1 do fillPx(ctx.set, x, J.irem(i, w), y, J.idiv(i, w), s, d[i + 1]) end
    return true
  end

  function B.drawImage(self, a)
    if a.n < 3 then lerr("Too few arguments, excepted (number x, number y, image ref)") end
    local ctx = self.ctx
    local xS = i32(P.getInt(a, 0) - 1)
    local yS = i32(P.getInt(a, 1) - 1)
    local li = imageOf(ctx.vram, P.getString(a, 2))
    local img = li.getImage()
    local cW, cH = ctx.width(), ctx.height()
    local iW, iH = img.w, img.h
    local x = math.max(0, -xS)
    while x < iW and x + xS < cW do
      local y = math.max(0, -yS)
      while y < iH and y + yS < cH do
        ctx.set(x + xS, y + yS, img.get(x, y))
        y = y + 1
      end
      x = x + 1
    end
    return true
  end

  function B.sync(self) self.ctx.sync() end

  function B.getBounds(self) return self.ctx.bounds() end

  function B.createWindow(self, a)
    return G.newBaseGPU(G.newWindow(self.ctx, G.parseRect(a)), "BaseGPU")
  end

  function B.createWindow3D(self, a)
    return G.gpu3d.new(G.newWindow(self.ctx, G.parseRect(a)))
  end

  -- ===== GPUImpl =====

  local function imageFromBytes(vram, bytes)
    local w, h, reason = png.info(bytes)
    if not w then lerr("Could not load image: " .. reason) end
    vram.checkSizeEx(i32(w * h * 4))
    local img, why = png.decode(bytes)
    if not img then lerr("Could not load image: " .. why) end
    local li = G.newLuaImage(vram, G.newImage(img.w, img.h, img.data))
    vram.alloc(li)
    return li
  end

  function B.decodeImage(self, a)
    if a.n < 1 then lerr("Invalid arguments: expected buffer or unpacked numbers") end
    local vram = self.ctx.vram
    local bytes
    if type(a[1]) == "string" then
      local buf = vram.get(a[1])
      if not (buf and buf.__class and buf.__class.name == "LuaByteBuffer") then lerr("Invalid reference") end
      bytes = buf.bytes()
    else
      bytes = {}
      for _, v in ipairs(P.ints(a, 0)) do
        if v == -1 then break end -- IntInputStream hands back the int: -1 is the end of the stream
        bytes[#bytes + 1] = v % 256
      end
    end
    return imageFromBytes(vram, bytes)
  end

  function B.imageFromBuffer(self, a)
    local vram = self.ctx.vram
    local w = P.getInt(a, 0)
    local d = P.uints(a, 1)
    local img = G.newImage(w, J.idiv(#d, w), d, #d)
    local li = G.newLuaImage(vram, img)
    vram.allocEx(li, #d * 4)
    return li
  end

  function B.newImage(self, a)
    if a.n > 1 and type(a[1]) == "number" and type(a[2]) == "number" then
      local vram = self.ctx.vram
      local w = P.getInt(a, 0)
      local h = P.getInt(a, 1)
      if w < 0 or h < 0 then lerr("Image size out of bounds") end
      vram.checkSizeEx(i32(w * h * 4))
      local li = G.newLuaImage(vram, G.newImage(w, h))
      vram.alloc(li)
      return li
    end
    lerr("Invalid Arguments, excepted (number w,number h)")
  end

  function B.newBuffer(self, a)
    local init = P.optionalInt(a, 0, 32)
    return G.newByteBuffer(self.ctx.vram, init)
  end

  function B.getUsedMemory(self) return self.ctx.vram.used() end
  function B.getMaxMemory(self) return self.ctx.vram.max end

  G.B = B
  G.classes = {
    BaseGPU = class("BaseGPU", B),
    GPUImpl = class("GPUImpl", B),
  }

  --- A BaseGPU / GPUImpl object over a context.
  function G.newBaseGPU(ctx, className)
    return { __class = G.classes[className], ctx = ctx, font = DEF }
  end

  -- ===== Rect =====

  local R = {}
  local function modif(self) if not self.modif then lerr("Can't modify") end end
  function R.getX(self) return self.x end
  function R.getY(self) return self.y end
  function R.getW(self) return self.w end
  function R.getH(self) return self.h end
  function R.setX(self, a) modif(self); self.x = P.getInt(a, 0) end
  function R.setY(self, a) modif(self); self.y = P.getInt(a, 0) end
  function R.setW(self, a)
    modif(self)
    local n = P.getInt(a, 0)
    if n < 0 then lerr("Width value is less than 0") end
    self.w = n
  end
  function R.setH(self, a)
    modif(self)
    local n = P.getInt(a, 0)
    if n < 0 then lerr("Height value is less than 0") end
    self.h = n
  end
  local RectClass = class("Rect", R)
  function G.newRect(x, y, w, h, modifiable)
    return { __class = RectClass, x = x, y = y, w = w, h = h, modif = modifiable }
  end
  function G.parseRect(a)
    if a.n < 4 then lerr("Too few arguments (expected x,y,width,height)") end
    local xStart = i32(P.getInt(a, 0) - 1)
    local yStart = i32(P.getInt(a, 1) - 1)
    local w = P.getInt(a, 2)
    local h = P.getInt(a, 3)
    if w > 0 and h > 0 then return G.newRect(xStart, yStart, w, h, true) end
    lerr("Out of boundary")
  end

  -- ===== WindowGPUContext =====

  function G.newWindow(parent, rect)
    local win = { vram = parent.vram }
    local sw, sh, screen = rect.w, rect.h, {}
    function win.set(x, y, c)
      if x < sw and x >= 0 and y >= 0 and y < sh then screen[x * sh + y] = c end
    end
    function win.sync()
      local xs, ys, iw, ih = rect.x, rect.y, rect.w, rect.h
      if sw ~= iw or sh ~= ih then
        if iw < 1 or ih < 1 then lerr("Invalid window size") end
        win.vram.reallocEx(win, iw * ih * 4)
        sw, sh, screen = iw, ih, {}
        return
      end
      local w, h = parent.width(), parent.height()
      local x = math.max(-xs, 0)
      while x + xs < w and x < iw do
        local y = math.max(-ys, 0)
        while y + ys < h and y < ih do
          parent.set(x + xs, y + ys, screen[x * sh + y] or 0)
          y = y + 1
        end
        x = x + 1
      end
    end
    function win.width() return rect.w end
    function win.height() return rect.h end
    function win.bounds() return rect end
    function win.vsize() return rect.w + rect.h end -- WindowGPUContext.getSize (never allocated, see createWindow)
    return win
  end

  -- ===== Image, LuaImage =====

  --- util.Image: data[y * w + x], Java ints; len is the array's length (imageFromBuffer can leave a partial row).
  function G.newImage(w, h, data, len)
    local img = { w = w, h = h, len = len or w * h }
    local px = {}
    if data then for i = 1, #data do px[i - 1] = data[i] end end
    img.px = px
    function img.set(x, y, rgb)
      local i = y * img.w + x
      if i < 0 or i >= img.len then J.aioobe(i, img.len) end
      px[i] = rgb
    end
    function img.get(x, y)
      local i = y * img.w + x
      if i < 0 or i >= img.len then J.aioobe(i, img.len) end
      return px[i] or 0
    end
    --- new Image(Image): w * h ints copied
    function img.copy()
      local c = G.newImage(img.w, img.h)
      for k, v in pairs(px) do if k < c.len then c.px[k] = v end end
      return c
    end
    return img
  end

  local I = {}
  local function alive(self)
    if self.image == nil then lerr("Error: Use after free") end
    return self.image
  end
  function I.getWidth(self) return alive(self).w end
  function I.getHeight(self) return alive(self).h end
  function I.getAsBuffer(self)
    local img = alive(self)
    local n = img.w * img.h
    local out = { n = n }
    for i = 0, img.len - 1 do
      if i >= n then J.aioobe(i, n) end
      out[i + 1] = img.px[i] or 0
    end
    return table.unpack(out, 1, n)
  end
  function I.ref(self) alive(self); return self.refKey end
  function I.gpuDraw(self)
    alive(self)
    return G.newBaseGPU(self.ctx, "GPUImpl")
  end
  function I.free(self)
    if self.image == nil then return end
    self.vram.remove(self.refKey)
    self.vram.free(self)
    self.image = nil
  end
  function I.saveImage(self)
    local img = alive(self)
    local buf = G.newByteBuffer(self.vram, 32)
    buf.writeBytes(png.encode(img))
    return buf
  end
  function I.setRGB(self, a)
    local x = i32(P.getInt(a, 0) + 1)
    local y = i32(P.getInt(a, 1) + 1)
    local rgb = P.toColor(a, 2)
    if self.image == nil then
      J.npe('Cannot invoke "com.tom.peripherals.util.Image.setRGB(int, int, int)" because "this.image" is null')
    end
    self.image.set(x, y, rgb)
  end
  function I.getRGB(self, a)
    local x = i32(P.getInt(a, 0) + 1)
    local y = i32(P.getInt(a, 1) + 1)
    if self.image == nil then
      J.npe('Cannot invoke "com.tom.peripherals.util.Image.getRGB(int, int)" because "this.image" is null')
    end
    return self.image.get(x, y)
  end
  local ImageClass = class("LuaImage", I)

  function G.newLuaImage(vram, image)
    local li = { __class = ImageClass, vram = vram, image = image }
    li.refKey = vram.createReference(li)
    function li.vsize() return alive(li).w * alive(li).h * 4 end
    function li.getImage() return alive(li) end
    -- the image as a GPUContext (gpuDraw): no transform, no sync
    li.ctx = {
      vram = vram,
      set = function(x, y, c) alive(li).set(x, y, c) end,
      sync = function() end,
      width = function() return alive(li).w end,
      height = function() return alive(li).h end,
    }
    li.ctx.bounds = function() return G.newRect(0, 0, li.ctx.width(), li.ctx.height(), false) end
    return li
  end

  -- ===== LuaByteBuffer =====

  local Bf = {}
  local function bufAlive(self) if self.buf == nil then lerr("Error: Use after free") end end
  function Bf.length(self) bufAlive(self); return self.wi end
  function Bf.available(self) bufAlive(self); return self.wi - self.ri end
  function Bf.write(self, d)
    bufAlive(self)
    local dt = P.ints(d, 0)
    if #dt == 0 then return end
    self.ensure(self.wi + #dt)
    for i = 1, #dt do self.buf[self.wi + i - 1] = dt[i] % 256 end
    self.wi = self.wi + #dt
  end
  function Bf.read(self, d)
    bufAlive(self)
    local amount = P.optionalInt(d, 0, 1)
    if amount < 0 then amount = self.wi - self.ri
    elseif self.wi - self.ri < amount then lerr("Index out of bounds") end
    local r = { n = amount }
    for i = 1, amount do r[i] = self.buf[self.ri + i - 1] or 0 end
    self.ri = self.ri + amount
    return table.unpack(r, 1, amount)
  end
  function Bf.free(self)
    if self.buf == nil then return end
    self.vram.remove(self.refKey)
    self.vram.free(self)
    self.buf = nil
  end
  function Bf.ref(self) return self.refKey end
  local BufferClass = class("LuaByteBuffer", Bf)

  function G.newByteBuffer(vram, initSize)
    local b = { __class = BufferClass, vram = vram, wi = 0, ri = 0 }
    b.refKey = vram.createReference(b)
    local cap = 0
    function b.vsize()
      if b.buf == nil then J.npe('Cannot read the array length because "this.buf" is null') end
      return cap
    end
    vram.allocEx(b, initSize)
    if initSize < 0 then J.throw("java.lang.NegativeArraySizeException", tostring(initSize)) end
    b.buf, cap = {}, initSize
    function b.ensure(min)
      if min - cap > 0 then
        local new = i32(cap * 2)
        if new - min < 0 then new = min end
        vram.reallocEx(b, new)
        cap = new
      end
    end
    --- OutputStream.write(byte[]): the bytes of a string, as one write
    function b.writeBytes(s)
      b.ensure(b.wi + #s)
      for i = 1, #s do b.buf[b.wi + i - 1] = s:byte(i) end
      b.wi = b.wi + #s
    end
    --- asInputStream: readIndex to writeIndex, without moving either
    function b.bytes()
      local out = {}
      for i = b.ri, b.wi - 1 do out[#out + 1] = b.buf[i] or 0 end
      return out
    end
    return b
  end

  return G
end
