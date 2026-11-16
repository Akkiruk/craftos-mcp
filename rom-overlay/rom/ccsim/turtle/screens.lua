-- ccsim turtle screens: one monitor wall, one screen, whichever computers it is attached to (TileMonitor and
-- ServerMonitor in CC:Tweaked 1.101.3).
--
-- Each computer draws on its own engine monitor, so the wall's screen is kept the same everywhere by passing every
-- call that changes it through the block world host (packages/runner/src/blockworld.ts). The host keeps the calls
-- since the screen was last cleared; a computer that comes to the wall asks for them and plays them back, then keeps
-- up with what the others send. The wall is named by its origin block, as the real terminal lives in the origin.
--
-- A normal monitor shows greys (Palette with colour off: (r + g + b) / 3 for every entry) and says isColour() is
-- false; its palette still reads back the colours that were set.
return function(core)
  local S = {}
  local raw = core.rawPeripheral
  local nativeCall, nativeWrap = raw.call, raw.wrap
  local floor = math.floor

  local sides = {}    -- side -> { wall = origin key, advanced = bool }
  local palettes = {} -- wall -> { [index 0..15] = { r, g, b } } as set, for a normal monitor's getPaletteColour
  local waiting = {}  -- wall -> own calls made since asking for the screen, played again after it arrives
  local defaults      -- the palette of a fresh engine monitor
  local myId = tostring(core.computerId)

  local CHANGES = {
    write = true, blit = true, clear = true, clearLine = true, scroll = true, setCursorPos = true, setCursorBlink = true,
    setTextColour = true, setTextColor = true, setBackgroundColour = true, setBackgroundColor = true,
    setPaletteColour = true, setPaletteColor = true, setTextScale = true,
  }

  -- ===== the line format: <from>;<method>;<arg>;... with n<number>, s<text>, b<0|1>, z for nil =====

  local function escape(s)
    return (s:gsub("[%c%%;\127-\255]", function(c) return ("%%%02X"):format(c:byte()) end))
  end
  local function unescape(s) return (s:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)) end

  local function encodeArg(v)
    local t = type(v)
    if t == "number" then return "n" .. ("%.17g"):format(v) end
    if t == "string" then return "s" .. escape(v) end
    if t == "boolean" then return v and "b1" or "b0" end
    return "z"
  end
  local function decodeArg(s)
    local k, rest = s:sub(1, 1), s:sub(2)
    if k == "n" then return tonumber(rest) end
    if k == "s" then return unescape(rest) end
    if k == "b" then return rest == "1" end
    return nil
  end

  local function decodeOp(text)
    local parts = {}
    for part in (text .. ";"):gmatch("([^;]*);") do parts[#parts + 1] = part end
    local args = { n = #parts - 2 }
    for i = 3, #parts do args[i - 2] = decodeArg(parts[i]) end
    return parts[1], parts[2], args
  end

  local function send(wall, text)
    if core.sendHost then core.sendHost("Wscreen:" .. wall .. "\t" .. text) end
  end

  -- ===== palettes =====

  local function log2(c)
    local i = 0
    while c > 1 do c, i = floor(c / 2), i + 1 end
    return i
  end

  local function paletteOf(wall)
    local p = palettes[wall]
    if not p then
      p = {}
      for i = 0, 15 do p[i] = { defaults[i][1], defaults[i][2], defaults[i][3] } end
      palettes[wall] = p
    end
    return p
  end

  --- Palette.setColour with colour off: every channel the average, cut to a byte
  local function grey(r, g, b) return floor((r + g + b) / 3 * 255) / 255 end

  local function setPalette(side, info, i, r, g, b)
    if info.advanced then nativeCall(side, "setPaletteColour", 2 ^ i, r, g, b)
    else
      local v = grey(r, g, b)
      nativeCall(side, "setPaletteColour", 2 ^ i, v, v, v)
    end
  end

  -- ===== playing a call on this computer's own monitors =====

  local function sidesOf(wall)
    local out = {}
    for side, info in pairs(sides) do if info.wall == wall then out[#out + 1] = side end end
    table.sort(out)
    return out
  end

  --- One call on one engine monitor. Errors come from the engine's own checks, as the real ones would.
  local function play(side, method, args)
    local info = sides[side]
    if method == "setPaletteColour" or method == "setPaletteColor" then
      local results = table.pack(nativeCall(side, method, table.unpack(args, 1, args.n))) -- the argument checks
      local i = log2(args[1])
      local r, g, b = args[2], args[3], args[4]
      if g == nil then r, g, b = colours.unpackRGB(r) end
      paletteOf(info.wall)[i] = { r, g, b }
      setPalette(side, info, i, r, g, b)
      return table.unpack(results, 1, results.n)
    elseif method == "setTextScale" then
      local w0, h0 = nativeCall(side, "getSize")
      local results = table.pack(nativeCall(side, method, table.unpack(args, 1, args.n)))
      local w1, h1 = nativeCall(side, "getSize")
      if w0 ~= w1 or h0 ~= h1 then
        -- ServerMonitor.rebuild: a new size clears the terminal and every attached computer hears monitor_resize
        nativeCall(side, "clear")
        os.queueEvent("monitor_resize", side)
      end
      return table.unpack(results, 1, results.n)
    end
    return nativeCall(side, method, table.unpack(args, 1, args.n))
  end

  --- A call that arrived from another computer, played on every side of this one that shows the wall.
  local function playAll(wall, method, args, except)
    for _, side in ipairs(sidesOf(wall)) do
      if side ~= except then pcall(play, side, method, args) end
    end
  end

  --- Back to a fresh terminal: the state a new ServerMonitor starts in.
  local function reset(side)
    local info = sides[side]
    nativeCall(side, "setTextScale", 1)
    for i = 0, 15 do setPalette(side, info, i, defaults[i][1], defaults[i][2], defaults[i][3]) end
    nativeCall(side, "setTextColour", 1)
    nativeCall(side, "setBackgroundColour", 32768)
    nativeCall(side, "setCursorBlink", false)
    nativeCall(side, "setCursorPos", 1, 1)
    nativeCall(side, "clear")
  end

  -- ===== the peripheral the programs see =====

  function raw.call(name, method, ...)
    local info = sides[name]
    if not info then return nativeCall(name, method, ...) end
    if not info.advanced and (method == "isColour" or method == "isColor") then return false end
    if not info.advanced and (method == "getPaletteColour" or method == "getPaletteColor") then
      nativeCall(name, method, ...) -- the argument checks
      local p = paletteOf(info.wall)[log2((...))]
      return p[1], p[2], p[3]
    end
    if not CHANGES[method] then return nativeCall(name, method, ...) end
    local args = table.pack(...)
    if method == "write" and type(args[1]) == "number" then args[1] = tostring(args[1]) end
    local results = table.pack(play(name, method, args))
    -- the other sides of this computer on the same wall, then everyone else
    playAll(info.wall, method, args, name)
    local parts = { myId, method }
    for i = 1, args.n do parts[#parts + 1] = encodeArg(args[i]) end
    send(info.wall, table.concat(parts, ";"))
    if waiting[info.wall] then table.insert(waiting[info.wall], { method = method, args = args }) end
    return table.unpack(results, 1, results.n)
  end

  --- peripheral.wrap of a monitor: every method goes through raw.call, so it follows the side to whatever wall it shows.
  function raw.wrap(name)
    local wrapped = nativeWrap(name)
    if type(wrapped) ~= "table" or nativeCall == nil then return wrapped end
    local ok, ty = pcall(raw.getType, name)
    if not ok or ty ~= "monitor" then return wrapped end
    local out = {}
    for method in pairs(wrapped) do
      out[method] = function(...) return raw.call(name, method, ...) end
    end
    local mt = getmetatable(wrapped)
    if type(mt) == "table" then setmetatable(out, mt) end
    return out
  end

  -- ===== attaching =====

  --- A monitor on `side` shows `wall`. A side that comes to a wall, or whose wall changed, asks for its screen.
  function S.show(side, wall, advanced, force)
    if not defaults then
      defaults = {}
      for i = 0, 15 do defaults[i] = { nativeCall(side, "getPaletteColour", 2 ^ i) } end
    end
    local old = sides[side]
    sides[side] = { wall = wall, advanced = advanced }
    if not force and old and old.wall == wall and old.advanced == advanced then return end
    reset(side)
    waiting[wall] = {}
    send(wall, "?" .. myId)
  end

  function S.hide(side) sides[side] = nil end

  --- A `screen:<wall>` line from the host.
  function S.onLine(wall, text)
    local to, log = text:match("^~([^\30]*)\30?(.*)$")
    if to then
      if to ~= myId then return end
      local own = waiting[wall] or {}
      waiting[wall] = nil
      local list = sidesOf(wall)
      for _, side in ipairs(list) do pcall(reset, side) end
      palettes[wall] = nil
      for entry in log:gmatch("[^\30]+") do
        local _, method, args = decodeOp(entry)
        playAll(wall, method, args)
      end
      for _, call in ipairs(own) do playAll(wall, call.method, call.args) end
      return
    end
    if text:sub(1, 1) == "?" then return end
    local from, method, args = decodeOp(text)
    if from == myId or not CHANGES[method] then return end
    playAll(wall, method, args)
  end

  return S
end
