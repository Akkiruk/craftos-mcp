-- ccsim cccbridge: CC:C Bridge, its five peripherals (animatronic, redrouter, scroller, create_source, create_target).
--
-- Written from tweaked-programs/cccbridge and checked against the Modrinth jars with javap (method names, signatures,
-- @LuaFunction names and mainThread flags, every error string):
--   1.18.2: branch archived/mc1.18.2 at 4a2d26a (8 Jul 2023), cccbridge-mc1.18.2-forge-v1.5.1.jar ("1.5.1-forge");
--     forge/src/main/java/cc/tweaked_programs/cccbridge/{peripherals,blockEntity,behaviour,display,entity/animatronic,
--     block/RedRouterBlock,Misc}.
--   1.20.1: branch mc1.20.1, cccbridge-mc1.20.1-v1.7.1-forge.jar; 1.21.1: branch mc1.21.1 at 73f2efa,
--     cccbridge-mc1.21.1-v1.7.3-neoforge.jar. The 1.7 line changes the API (see docs/cccbridge.md); `core.version.mc`
--     picks it.
-- CC:Tweaked's own parts (argument checks, Terminal, TermMethods, Palette) were read from cc-tweaked 1.18.2-1.101.3
-- and 1.20.1-1.121.0 with javap. Create's ScrollValueBehaviour from Create 0.5.1 (via ../create).
return function(core, host)
  local create = core.loadAddon("create")
  local C = create.C
  local floor, abs, fmod = math.floor, math.abs, math.fmod
  local MC = core.version and core.version.mc or "1.18.2"
  local V17 = MC ~= "1.18.2" -- CC:C Bridge 1.7.x (1.20.1 and 1.21.1)
  local V1211 = MC == "1.21.1"
  local CC121 = core.cc121

  local M = {}
  local objects, order = {}, {}

  -- ===== CC:Tweaked's argument checks (VarargArguments / IArguments / LuaValues) =====

  -- getString/getBoolean go through get(), which turns a function, thread or userdata into null on 1.101.3
  local function typeOf(v)
    local t = type(v)
    if not CC121 and (t == "function" or t == "thread" or t == "userdata") then return "nil" end
    return t
  end
  local function bad(i, want, got) error(("bad argument #%d (%s expected, got %s)"):format(i, want, got), 0) end
  local J = {}
  function J.str(i, v)
    if type(v) ~= "string" then bad(i, "string", typeOf(v)) end
    return v
  end
  function J.bool(i, v)
    if type(v) ~= "boolean" then bad(i, "boolean", typeOf(v)) end
    return v
  end
  function J.num(i, v) -- getDouble: any number, NaN and infinities too
    if type(v) ~= "number" then bad(i, "number", type(v)) end
    return v
  end
  local function finite(i, v)
    if v ~= v then bad(i, "number", "nan") end
    if v == math.huge then bad(i, "number", "inf") end
    if v == -math.huge then bad(i, "number", "-inf") end
    return v
  end
  function J.finite(i, v) return finite(i, J.num(i, v)) end
  -- getInt: getLong (finite, then d2l: toward zero, saturating to a long) and l2i (the low 32 bits)
  function J.int(i, v)
    v = J.finite(i, v)
    local t = v >= 0 and floor(v) or -floor(-v)
    if t >= 9223372036854775807 then return -1 end
    if t <= -9223372036854775808 then return 0 end
    local m = fmod(t, 4294967296)
    if m < 0 then m = m + 4294967296 end
    if m >= 2147483648 then m = m - 4294967296 end
    return m
  end
  -- getEnum(ComputerSide): a string, matched to the enum names ignoring case
  local SIDES = { bottom = true, top = true, back = true, front = true, right = true, left = true }
  function J.side(i, v)
    v = J.str(i, v)
    local s = v:lower()
    if not SIDES[s] then error(("bad argument #%d (unknown option %s)"):format(i, v), 0) end
    return s
  end
  local function luaError(message) error(message, 0) end

  -- ===== events (TweakedPeripheral.sendEvent) =====
  -- queueEvent(event, getAttachmentName(), arguments): the varargs array is passed as ONE argument, so Lua gets the
  -- peripheral's name and then a table of the arguments (empty when there are none).
  -- 1.7.x keeps the attached computers in an interface field, which is static: one list for every CC:C Bridge
  -- peripheral, so each event goes out once per attached CC:C Bridge peripheral, under that peripheral's name.
  local function sendEvent(o, event, ...)
    local args = { ... }
    if V17 then
      for _, name in ipairs(order) do
        local p = objects[name]
        if p.attached then os.queueEvent(event, name, C.deepCopy(args)) end
      end
    elseif o.attached then
      os.queueEvent(event, o.name, args)
    end
  end

  -- ===== CC's Terminal (only the text matters: the colour buffers never reach Lua through these blocks) =====

  local function blank(w) return (" "):rep(math.max(w, 0)) end

  local function newTerminal(w, h, colour)
    local t = { width = w, height = h, colour = colour, x = 0, y = 0, blink = false, fg = 0, bg = 15, text = {} }
    for y = 0, h - 1 do t.text[y] = blank(w) end
    -- TextBuffer.write(text, start): the characters that land inside [0, width)
    local function put(line, s, x, w2)
      local start, stop = math.max(x, 0), math.min(x + #s, w2)
      if stop <= start then return line end
      return line:sub(1, start) .. s:sub(start - x + 1, stop - x) .. line:sub(stop + 1)
    end
    function t.write(s)
      if t.y >= 0 and t.y < t.height then t.text[t.y] = put(t.text[t.y], s, t.x, t.width) end
    end
    function t.setCursorPos(x, y) t.x, t.y = x, y end
    function t.clear()
      for y = 0, t.height - 1 do t.text[y] = blank(t.width) end
    end
    function t.clearLine()
      if t.y >= 0 and t.y < t.height then t.text[t.y] = blank(t.width) end
    end
    function t.scroll(n)
      if n == 0 then return end
      local new = {}
      for y = 0, t.height - 1 do
        local old = y + n
        new[y] = (old >= 0 and old < t.height) and t.text[old] or blank(t.width)
      end
      t.text = new
    end
    function t.resize(w2, h2)
      if w2 == t.width and h2 == t.height then return end
      local new = {}
      for y = 0, h2 - 1 do
        if y >= t.height then
          new[y] = blank(w2)
        elseif w2 == t.width then
          new[y] = t.text[y]
        else
          new[y] = put(blank(w2), t.text[y], 0, w2)
        end
      end
      t.width, t.height, t.text = w2, h2, new
    end
    function t.lines()
      local out = {}
      for y = 0, t.height - 1 do out[y + 1] = t.text[y] end
      return out
    end
    -- Palette: index i is Colour.VALUES[i] (BLACK first); TermMethods reaches it as 15 - the colour's bit
    local HEX = { 0x111111, 0xCC4C4C, 0x57A64E, 0x7F664C, 0x3366CC, 0xB266E5, 0x4C99B2, 0x999999, 0x4C4C4C,
      0xF2B2CC, 0x7FCC19, 0xDEDE6C, 0x99B2F2, 0xE57FD8, 0xF2B233, 0xF0F0F0 }
    t.palette = {}
    for i, hex in ipairs(HEX) do
      t.palette[i - 1] = { C.float(floor(hex / 65536) % 256 / 255), C.float(floor(hex / 256) % 256 / 255),
        C.float(hex % 256 / 255) }
    end
    return t
  end

  -- ===== Create text <-> CC characters (Misc / CharsetManipulator) =====

  local CHARSET = {
    0x0020, 0x263A, 0x263B, 0x2665, 0x2666, 0x2663, 0x2660, 0x25CF, 0x25CB, 0x0020, 0x0020, 0x2642, 0x2640, 0x0020,
    0x266A, 0x266C, 0x25B6, 0x25C0, 0x2195, 0x203C, 0x00B6, 0x2591, 0x25AC, 0x21A8, 0x2B06, 0x2B07, 0x27A1, 0x2B05,
    0x221F, 0x29FA, 0x25B2, 0x25BC,
  }
  for c = 0x20, 0x7E do CHARSET[#CHARSET + 1] = c end
  CHARSET[#CHARSET + 1] = 0x2592
  for _, c in ipairs({ 0x2800, 0x2801, 0x2808, 0x2809, 0x2802, 0x2803, 0x280A, 0x280B, 0x2810, 0x2811, 0x2818, 0x2819,
    0x2812, 0x2813, 0x281A, 0x281B, 0x2804, 0x2805, 0x280C, 0x280D, 0x2806, 0x2807, 0x280E, 0x280F, 0x2814, 0x2815,
    0x281C, 0x281D, 0x2816, 0x2817, 0x281E, 0x281F, 0x2593 }) do
    CHARSET[#CHARSET + 1] = c
  end
  for c = 0xA1, 0xFF do CHARSET[#CHARSET + 1] = c end
  CHARSET[167 + 1] = 0x2588 -- 0xA7 is the full block
  local INDEX = {}
  for i = #CHARSET, 1, -1 do INDEX[CHARSET[i]] = i - 1 end -- findCharIndex: the first match wins

  local function utf8Encode(cp)
    if cp < 0x80 then return string.char(cp) end
    if cp < 0x800 then return string.char(0xC0 + floor(cp / 64), 0x80 + cp % 64) end
    if cp < 0x10000 then
      return string.char(0xE0 + floor(cp / 4096), 0x80 + floor(cp / 64) % 64, 0x80 + cp % 64)
    end
    return string.char(0xF0 + floor(cp / 262144), 0x80 + floor(cp / 4096) % 64, 0x80 + floor(cp / 64) % 64,
      0x80 + cp % 64)
  end
  -- Java chars of a sim command's (UTF-8) text; a character beyond the BMP is two chars, as in Java
  local function utf8Chars(s)
    local out, i = {}, 1
    while i <= #s do
      local b = s:byte(i)
      local cp, n = b, 1
      if b >= 0xF0 then cp, n = b % 8, 4 elseif b >= 0xE0 then cp, n = b % 16, 3 elseif b >= 0xC0 then cp, n = b % 32, 2 end
      for k = 1, n - 1 do cp = cp * 64 + (s:byte(i + k) or 0x80) % 64 end
      i = i + n
      if cp >= 0x10000 then
        out[#out + 1] = 0xD800 + floor((cp - 0x10000) / 1024)
        out[#out + 1] = 0xDC00 + (cp - 0x10000) % 1024
      else
        out[#out + 1] = cp
      end
    end
    return out
  end
  -- toMCTxt: a CC line (bytes are chars 0-255) as the Create text it becomes, in UTF-8
  local function toMC(line)
    local out = {}
    for i = 1, #line do
      local c = line:byte(i)
      out[i] = utf8Encode(c == 223 and 0x1E9E or CHARSET[c + 1])
    end
    return table.concat(out)
  end
  -- Sim command text reaches Lua as UTF-8 (a command from the computer, through textutils.unserializeJSON) or as
  -- CC's own bytes (a host command read through CC's file decoding, which turns what it cannot carry into '?')
  local function isUtf8(s)
    local i, multi = 1, false
    while i <= #s do
      local b = s:byte(i)
      local n = b < 0x80 and 1 or (b >= 0xC2 and b < 0xE0) and 2 or (b >= 0xE0 and b < 0xF0) and 3
        or (b >= 0xF0 and b < 0xF5) and 4 or 0
      if n == 0 then return false end
      for k = 1, n - 1 do
        local c = s:byte(i + k)
        if not c or c < 0x80 or c > 0xBF then return false end
      end
      if n > 1 then multi = true end
      i = i + n
    end
    return multi
  end
  -- toCCTxt: Create text as CC characters; a space stays, anything outside the charset is '?'
  local function toCC(text)
    local out = {}
    local chars = {}
    if isUtf8(text) then chars = utf8Chars(text) else for i = 1, #text do chars[i] = text:byte(i) end end
    for _, c in ipairs(chars) do
      local idx = c == 0x20 and 0x20 or INDEX[c] or 63
      out[#out + 1] = string.char(idx)
    end
    return table.concat(out)
  end
  M.toMC, M.toCC = toMC, toCC

  -- ===== animatronic =====

  local PARTS = { "head", "body", "leftArm", "rightArm" }
  local FACES = { normal = true, happy = true, question = true, sad = true }
  local TRANSITIONS = { rusty = true, none = true, linear = true }

  -- new Rotations(x, y, z): each float taken modulo 360 (Java's %, keeping the sign), NaN and infinities are 0
  local function rotations(x, y, z)
    local function r(v)
      if v ~= v or v == math.huge or v == -math.huge then return 0 end
      return C.float(fmod(v, 360))
    end
    return { r(x), r(y), r(z) }
  end

  local function newAnimatronic(def)
    local o = { kind = "animatronic", face = "normal", transition = "rusty", stored = {}, applied = {} }
    if def.face ~= nil then o.face = tostring(def.face) end
    if def.transition ~= nil then o.transition = tostring(def.transition) end
    for _, part in ipairs(PARTS) do
      o.stored[part] = { 0, 0, 0 }
      local a = type(def.pose) == "table" and def.pose[part] or nil
      o.applied[part] = type(a) == "table" and rotations(tonumber(a[1]) or 0, tonumber(a[2]) or 0, tonumber(a[3]) or 0)
        or { 0, 0, 0 }
    end
    return o
  end

  local function clamp(v, lo, hi) -- Mth.clamp(double): NaN passes through as NaN
    if v < lo then return lo end
    if v > hi then return hi end
    return v
  end

  local function animatronicMethods(o)
    local m = {}
    function m.setFace(face)
      face = J.str(1, face)
      if V17 then
        local f = face:lower()
        if not FACES[f] then luaError("Given string must be one of the following options: { normal, happy, question, sad }") end
        o.face = f
      else
        if not FACES[face] then luaError("Given string must be either 'normal', 'happy', 'question' or 'sad'") end
        o.face = face
      end
    end
    if V17 then
      function m.setTransition(kind)
        kind = J.str(1, kind):lower()
        if not TRANSITIONS[kind] then luaError("Given string must be one of the following options: { rusty, none, linear }") end
        o.transition = kind
      end
    end
    function m.push()
      for _, part in ipairs(PARTS) do
        local s = o.stored[part]
        o.applied[part] = rotations(s[1], s[2], s[3])
        o.stored[part] = { 0, 0, 0 }
      end
      o.pushes = (o.pushes or 0) + 1
    end
    local function setter(part, xLimit)
      return function(x, y, z)
        x, y, z = J.num(1, x), J.num(2, y), J.num(3, z)
        o.stored[part] = { C.float(clamp(x, -xLimit, xLimit)), C.float(clamp(y, -180, 180)), C.float(clamp(z, -180, 180)) }
      end
    end
    m.setHeadRot = setter("head", 180)
    m.setBodyRot = setter("body", 360)
    m.setLeftArmRot = setter("leftArm", 180)
    m.setRightArmRot = setter("rightArm", 180)
    local function getter(which, part)
      return function()
        local r = o[which][part]
        return r[1], r[2], r[3]
      end
    end
    m.getStoredHeadRot, m.getStoredBodyRot = getter("stored", "head"), getter("stored", "body")
    m.getStoredLeftArmRot, m.getStoredRightArmRot = getter("stored", "leftArm"), getter("stored", "rightArm")
    m.getAppliedHeadRot, m.getAppliedBodyRot = getter("applied", "head"), getter("applied", "body")
    m.getAppliedLeftArmRot, m.getAppliedRightArmRot = getter("applied", "leftArm"), getter("applied", "rightArm")
    local decl = { "setFace" }
    if V17 then decl[#decl + 1] = "setTransition" end
    for _, n in ipairs({ "push", "setHeadRot", "setBodyRot", "setLeftArmRot", "setRightArmRot", "getStoredHeadRot",
      "getStoredBodyRot", "getStoredLeftArmRot", "getStoredRightArmRot", "getAppliedHeadRot", "getAppliedBodyRot",
      "getAppliedLeftArmRot", "getAppliedRightArmRot" }) do
      decl[#decl + 1] = n
    end
    return m, decl, V1211 and { push = true } or {}
  end

  -- ===== redrouter =====
  -- The block entity keeps its outputs and inputs by direction name. getActualSide turns a computer side into one,
  -- and the stored direction is the opposite of the neighbour it belongs to (getSignal is asked with the direction
  -- from the neighbour, updateInputs reads the neighbour at the key's opposite). So "front" is the neighbour the block
  -- faces, "left" the one counter-clockwise of that, "top" the one above. Fixtures and commands use those neighbours.

  local OPP = { north = "south", south = "north", east = "west", west = "east", up = "down", down = "up" }
  local CW = { north = "east", east = "south", south = "west", west = "north" }
  local CCW = { north = "west", west = "south", south = "east", east = "north" }
  local DIRS = { "up", "down", "north", "east", "south", "west" }

  -- getActualSide: the direction key the block entity stores this side under
  local function actualSide(o, side)
    local f = o.facing
    if side == "front" then return OPP[f] end
    if side == "back" then return f end
    if side == "left" then return CW[f] end
    if side == "right" then return CCW[f] end
    if side == "top" then return "down" end
    if side == "bottom" then return "up" end
    return "north"
  end
  -- a fixture/command side: a neighbour's direction, or a side relative to the block; returns the stored key
  local function keyOf(o, side)
    side = tostring(side):lower()
    if OPP[side] then return OPP[side] end
    if SIDES[side] then return actualSide(o, side) end
    return nil
  end

  local function level(v) return math.max(0, math.min(15, C.toInt(tonumber(v) or 0))) end

  local function newRedRouter(def)
    local o = { kind = "redrouter", facing = "north", output = {}, input = {} }
    local f = def.facing and tostring(def.facing):lower()
    if f and CW[f] then o.facing = f end
    for _, d in ipairs(DIRS) do o.output[d], o.input[d] = 0, 0 end
    for side, v in pairs(type(def.inputs) == "table" and def.inputs or {}) do
      local key = keyOf(o, side)
      if not key then error("ccsim: redrouter input side '" .. tostring(side) .. "' is not a side or direction", 0) end
      o.input[key] = level(v)
    end
    for side, v in pairs(type(def.outputs) == "table" and def.outputs or {}) do
      local key = keyOf(o, side)
      if not key then error("ccsim: redrouter output side '" .. tostring(side) .. "' is not a side or direction", 0) end
      o.output[key] = level(v)
    end
    return o
  end

  local function redRouterMethods(o)
    local m = {}
    function m.setOutput(side, on)
      side, on = J.side(1, side), J.bool(2, on)
      o.output[actualSide(o, side)] = on and 15 or 0
    end
    function m.getOutput(side) return o.output[actualSide(o, J.side(1, side))] > 0 end
    function m.getInput(side) return o.input[actualSide(o, J.side(1, side))] > 0 end
    function m.setAnalogOutput(side, value)
      side, value = J.side(1, side), J.int(2, value)
      if value < 0 or value > 15 then luaError("Expected number in range 0-15") end
      o.output[actualSide(o, side)] = value
    end
    m.setAnalogueOutput = m.setAnalogOutput
    function m.getAnalogOutput(side) return o.output[actualSide(o, J.side(1, side))] end
    m.getAnalogueOutput = m.getAnalogOutput
    function m.getAnalogInput(side) return o.input[actualSide(o, J.side(1, side))] end
    m.getAnalogueInput = m.getAnalogInput
    return m, { "setOutput", "getOutput", "getInput", "setAnalogOutput", "setAnalogueOutput", "getAnalogOutput",
      "getAnalogueOutput", "getAnalogInput", "getAnalogueInput" }, {}
  end

  -- ===== scroller =====

  local function newScroller(def)
    local o = { kind = "scroller", min = -15, max = 15, value = 0, minus = def.minus == true }
    if def.limit ~= nil then
      local l = C.toInt(tonumber(def.limit) or 15)
      o.min, o.max = -l, l
    end
    o.value = math.max(o.min, math.min(o.max, C.toInt(tonumber(def.value) or 0)))
    o.lockedState = def.locked == true -- the block state's LOCKED
    o.locked, o.updateLock = o.lockedState, false
    -- ScrollValueBehaviour.setValue: clamp, then the callback (the event) when it changed
    function o.setValue(v, quiet)
      if quiet then
        v = math.max(-o.max, math.min(o.max, v)) -- 1.7.x setValueQuietly clamps to the limit
      else
        v = math.max(o.min, math.min(o.max, v))
      end
      if v == o.value then return false end
      o.value = v
      if not quiet then sendEvent(o, "scroller_changed", v) end
      return true
    end
    -- ScrollerBlockEntity.tick: the lock reaches the block state on the next server tick
    function o.tick()
      if o.updateLock and o.lockedState ~= o.locked then
        o.lockedState = o.locked
        o.updateLock = false
        return true
      end
      return false
    end
    function o.busy() return o.updateLock and o.lockedState ~= o.locked end
    return o
  end

  local function scrollerMethods(o)
    local m = {}
    function m.isLocked() create.catchUp() return o.lockedState end
    function m.setLock(state)
      create.catchUp()
      o.locked, o.updateLock = J.bool(1, state), true
    end
    function m.getValue() return o.value end
    function m.setValue(value) o.setValue(J.int(1, value), V17) end
    function m.getLimit() return o.max end
    function m.hasMinusSpectrum() return o.minus end
    function m.toggleMinusSpectrum(state) o.minus = J.bool(1, state) end
    function m.setLimit(limit)
      limit = J.int(1, limit)
      -- Mth.clamp(Math.abs(limit), 1, 200): abs of the smallest int is itself, which clamps to 1
      local a = limit == -2147483648 and limit or abs(limit)
      a = math.max(1, math.min(200, a))
      o.min, o.max = -a, a -- between(-limit, limit); the value is not clamped again
    end
    return m, { "isLocked", "setLock", "getValue", "setValue", "getLimit", "hasMinusSpectrum", "toggleMinusSpectrum",
      "setLimit" }, {}
  end

  -- ===== source block =====
  -- A Create display link reads it (SourceBlockDisplaySource.provideText): the terminal takes the target's size,
  -- sending monitor_resize when that changes, and its lines go to the target. A link refreshes it every 20 ticks.

  -- Nothing else looks at the world while a program only waits for monitor_resize, so a sim timer catches the clock
  -- up every second while some source has a link.
  local pumping = false
  local function pump()
    if pumping then return end
    local any = false
    for _, p in pairs(objects) do
      if p.link then any = true end
    end
    if not any then return end
    pumping = true
    core.after(1, function()
      pumping = false
      create.catchUp()
      pump()
    end)
  end

  local function newSource(def)
    local o = { kind = "create_source", term = newTerminal(4, 2, false), sent = nil, reads = 0 }
    local link = def.link
    if type(link) == "table" then
      o.link = { rows = C.toInt(tonumber(link.rows) or 1), columns = C.toInt(tonumber(link.columns) or 1),
        powered = link.powered == true, ticks = 0 }
    end
    function o.setSize(w, h)
      if o.term.width == w and o.term.height == h then return end
      o.term.resize(w, h)
      sendEvent(o, "monitor_resize")
    end
    -- provideText runs twice for a display board target (flap text, then text); it is the same both times here
    function o.read()
      o.setSize(o.link.columns, o.link.rows)
      local out = {}
      for i, line in ipairs(o.term.lines()) do out[i] = toMC(line) end
      o.sent, o.reads = out, o.reads + 1
    end
    -- DisplayLinkBlockEntity.tick: count to the source's refresh ticks, then send unless redstone holds the link
    function o.tick()
      local l = o.link
      if not l then return false end
      l.ticks = l.ticks + 1
      if l.ticks < 20 then return false end
      l.ticks = 0
      if not l.powered then o.read() end
      return true
    end
    function o.skip(n)
      local l = o.link
      if not l then return end
      local total = l.ticks + n
      if total >= 20 and not l.powered then o.read() end
      l.ticks = total % 20
    end
    return o
  end

  local function sourceMethods(o)
    local t = o.term
    local m = {}
    function m.write(text)
      text = J.str(1, text)
      t.write(text)
      t.setCursorPos(t.x + #text, t.y)
    end
    function m.getLine(y)
      y = J.int(1, y)
      if y < 1 or y > t.height then luaError("Expected number in range 1-" .. t.height) end
      return t.text[y - 1]
    end
    function m.setCursorPos(x, y)
      x, y = J.int(1, x), J.int(2, y)
      t.setCursorPos(x - 1, y - 1)
    end
    function m.scroll(n) t.scroll(J.int(1, n)) end
    function m.clear() t.clear() end
    function m.clearLine() t.clearLine() end
    function m.getCursorPos() return t.x + 1, t.y + 1 end
    function m.getSize() return t.width, t.height end
    if not V17 then
      return m, { "setCursorPos", "write", "scroll", "clear", "clearLine", "getLine", "getCursorPos", "getSize" }, {}
    end

    -- 1.7.x: the source extends CC's TermMethods (CC:Tweaked 1.121.0) and keeps its own write(String) and getLine
    local function parseColour(c)
      if c <= 0 then luaError("Colour out of range") end
      local bit = 0
      while c >= 2 ^ bit and bit < 32 do bit = bit + 1 end -- 32 - numberOfLeadingZeros
      bit = bit - 1
      if bit < 0 or bit > 15 then luaError("Colour out of range") end
      return bit
    end
    function m.getCursorBlink() return t.blink end
    function m.setCursorBlink(b) t.blink = J.bool(1, b) end
    function m.getTextColour() return 2 ^ t.fg end
    function m.setTextColour(c) t.fg = parseColour(J.int(1, c)) end
    function m.getBackgroundColour() return 2 ^ t.bg end
    function m.setBackgroundColour(c) t.bg = parseColour(J.int(1, c)) end
    function m.isColour() return t.colour end
    function m.blit(text, fg, bg)
      text, fg, bg = J.str(1, text), J.str(2, fg), J.str(3, bg)
      if #text ~= #fg or #fg ~= #bg then luaError("Arguments must be the same length") end
      t.write(text)
      t.setCursorPos(t.x + #text, t.y)
    end
    function m.setPaletteColour(...)
      local n = select("#", ...)
      local a1, a2, a3, a4 = ...
      local idx = 15 - parseColour(J.int(1, a1))
      if n == 2 then
        local rgb = J.int(2, a2)
        local function ch(shift) return C.float((floor(rgb / 2 ^ shift) % 256) / 255) end
        t.palette[idx] = { ch(16), ch(8), ch(0) }
      else
        t.palette[idx] = { J.finite(2, a2), J.finite(3, a3), J.finite(4, a4) }
      end
    end
    function m.getPaletteColour(c)
      local p = t.palette[15 - parseColour(J.int(1, c))]
      return p[1], p[2], p[3]
    end
    m.getTextColor, m.setTextColor = m.getTextColour, m.setTextColour
    m.getBackgroundColor, m.setBackgroundColor = m.getBackgroundColour, m.setBackgroundColour
    m.isColor, m.setPaletteColor, m.getPaletteColor = m.isColour, m.setPaletteColour, m.getPaletteColour
    return m, { "write", "getLine", "scroll", "getCursorPos", "setCursorPos", "getCursorBlink", "setCursorBlink",
      "getSize", "clear", "clearLine", "getTextColour", "getTextColor", "setTextColour", "setTextColor",
      "getBackgroundColour", "getBackgroundColor", "setBackgroundColour", "setBackgroundColor", "isColour", "isColor",
      "blit", "setPaletteColour", "setPaletteColor", "getPaletteColour", "getPaletteColor" }, {}
  end

  -- ===== target block =====
  -- A Create display link writes into it (TargetBlockDisplayTarget.acceptFlapText): each line is its text pieces,
  -- each followed by a space, in CC characters.

  local function newTarget(def)
    local w, h = 32, V17 and 8 or 24
    if V1211 then -- 1.21.1 keeps the size in the block entity (afterResize), so it survives a reload
      w = math.max(1, C.toInt(tonumber(def.width) or w))
      h = math.max(1, C.toInt(tonumber(def.height) or h))
    end
    local o = { kind = "create_target", term = newTerminal(w, h, V17), received = 0 }
    function o.accept(offset, lines)
      local content = {}
      for i, line in ipairs(lines) do content[i] = toCC(line .. " ") end
      local t = o.term
      o.received = o.received + 1
      if V17 then
        t.clear()
        for i, line in ipairs(content) do
          t.setCursorPos(0, offset + i - 1)
          t.write(line)
        end
      else
        -- TargetBlockEntity.updateContent / replaceLine
        for i, line in ipairs(content) do
          local y = offset + i - 1
          if i - 1 < t.height and y >= 0 and y < t.height then
            t.setCursorPos(0, y)
            t.clearLine()
            t.write(line)
          end
        end
      end
    end
    return o
  end

  local function targetMethods(o)
    local t = o.term
    local m = {}
    function m.getLine(y)
      y = J.int(1, y)
      if y < 1 or y > t.height then luaError("Expected number in range 1-" .. t.height) end
      return t.text[y - 1]
    end
    function m.getSize() return t.width, t.height end
    if not V17 then
      function m.setWidth(width)
        width = J.int(1, width)
        if width < 1 or width > 164 then luaError("Expected number in range 1-164") end
        t.resize(width, 16) -- the height becomes 16, whatever it was
      end
      function m.clear() t.clear() end
      function m.clearLine(y)
        y = J.int(1, y)
        if y < 1 or y > t.height then return end
        t.setCursorPos(0, y - 1)
        t.clearLine()
      end
      return m, { "setWidth", "clear", "clearLine", "getLine", "getSize" }, {}
    end
    function m.resize(width, height)
      width, height = J.int(1, width), J.int(2, height)
      if width < 1 or height < 1 then luaError("The width and height of the terminal must be bigger than zero.") end
      t.resize(width, height)
    end
    function m.dump() return t.lines() end
    return m, { "resize", "getLine", "dump", "getSize" }, V1211 and { resize = true } or {}
  end

  -- ===== peripherals =====

  local CONSTRUCT = {
    animatronic = { newAnimatronic, animatronicMethods },
    redrouter = { newRedRouter, redRouterMethods },
    scroller = { newScroller, scrollerMethods },
    create_source = { newSource, sourceMethods },
    create_target = { newTarget, targetMethods },
  }

  local function state(o)
    if o.kind == "animatronic" then
      return { face = o.face, transition = V17 and o.transition or nil, stored = C.deepCopy(o.stored),
        applied = C.deepCopy(o.applied), pushes = o.pushes or 0 }
    end
    if o.kind == "redrouter" then
      local outputs, inputs = {}, {}
      for _, d in ipairs(DIRS) do
        outputs[d] = o.output[OPP[d]] -- what the neighbour on that side receives
        inputs[d] = o.input[OPP[d]]   -- what the neighbour on that side sends
      end
      return { facing = o.facing, outputs = outputs, inputs = inputs }
    end
    if o.kind == "scroller" then
      return { value = o.value, limit = o.max, minus = o.minus, locked = o.lockedState, lockPending = o.busy() }
    end
    if o.kind == "create_source" then
      local t = o.term
      return { width = t.width, height = t.height, cursor = { t.x + 1, t.y + 1 }, lines = t.lines(),
        link = o.link and { rows = o.link.rows, columns = o.link.columns, powered = o.link.powered } or nil,
        sent = o.sent and C.deepCopy(o.sent) or nil, reads = o.reads }
    end
    local t = o.term
    return { width = t.width, height = t.height, lines = t.lines(), received = o.received }
  end

  function M.peripheral(def)
    local entry = CONSTRUCT[def.type]
    local o = entry[1](def)
    o.name, o.def, o.attached = def.name, def, true
    if not objects[def.name] then order[#order + 1] = def.name end
    objects[def.name] = o
    create.register(def.name, o)
    if o.tick then create.addTicker(o) end
    if o.link then pump() end
    local methods, decl, mainThread = entry[2](o)
    local computerThread = {}
    for _, name in ipairs(decl) do
      if not mainThread[name] then computerThread[name] = true end
    end
    return {
      methods = methods,
      methodOrder = C.hashMapOrder(decl),
      computerThread = computerThread,
      exactReturns = true,
      state = function() create.catchUp() return state(o) end,
      -- TweakedPeripheral.detach: 1.5.1 drops this attachment; 1.7.x removes every attachment of the computer from
      -- the shared list, so no CC:C Bridge peripheral sends it events any more
      detach = function()
        if V17 then
          for _, p in pairs(objects) do p.attached = false end
        else
          o.attached = false
        end
      end,
    }
  end

  function M.catchUp() create.catchUp() end

  function M.state() return { version = V17 and (V1211 and "1.7.3" or "1.7.1") or "1.5.1" } end

  -- ===== sim commands =====

  local function find(cmd, kind)
    local o = objects[cmd.peripheral]
    if not o then return nil, "no CC:C Bridge block named " .. tostring(cmd.peripheral) end
    if kind and o.kind ~= kind then return nil, tostring(cmd.peripheral) .. " is a " .. o.kind .. ", not a " .. kind end
    return o
  end

  local handlers = {}

  -- a neighbour's redstone signal into a redrouter; 1.7.x sends "redstone" when an input changed (1.5.1 never does)
  function handlers.cccbSetInput(cmd)
    create.catchUp()
    local o, err = find(cmd, "redrouter")
    if not o then return false, err end
    local key = keyOf(o, cmd.side or "")
    if not key then return false, "side must be up, down, north, east, south, west or front, back, left, right, top, bottom" end
    local v = level(cmd.level)
    local changed = o.input[key] ~= v
    o.input[key] = v
    if changed and V17 then sendEvent(o, "redstone") end
    return true
  end

  -- a player turns the scroller (refused while the block state is locked, as Create's onlyActiveWhen does)
  function handlers.cccbScroll(cmd)
    create.catchUp()
    local o, err = find(cmd, "scroller")
    if not o then return false, err end
    if o.lockedState then return false, tostring(cmd.peripheral) .. " is locked" end
    local v = C.toInt(tonumber(cmd.value) or 0)
    if v < 0 and not o.minus then return false, "the minus spectrum is off: a player can only pick 0 to " .. o.max end
    if abs(v) > o.max then return false, "a player can only pick up to " .. o.max end
    o.setValue(v, false)
    return true
  end

  -- a display link on the source block: its target's size (rows, columns), redstone on the link, or no link
  function handlers.cccbLinkSource(cmd)
    create.catchUp()
    local o, err = find(cmd, "create_source")
    if not o then return false, err end
    if cmd.linked == false then
      o.link = nil
      return true
    end
    o.link = o.link or { rows = 1, columns = 1, powered = false, ticks = 0 }
    if cmd.rows ~= nil then o.link.rows = math.max(1, C.toInt(tonumber(cmd.rows) or 1)) end
    if cmd.columns ~= nil then o.link.columns = math.max(1, C.toInt(tonumber(cmd.columns) or 1)) end
    if cmd.powered ~= nil then o.link.powered = cmd.powered == true end
    if cmd.read == true then o.read() end
    pump()
    return true
  end

  -- a display link writes into the target block, from its target line (1-based) down
  function handlers.cccbLinkTarget(cmd)
    create.catchUp()
    local o, err = find(cmd, "create_target")
    if not o then return false, err end
    if type(cmd.lines) ~= "table" then return false, "lines must be a list of strings" end
    local lines = {}
    for i, l in ipairs(cmd.lines) do lines[i] = tostring(l) end
    o.accept(C.toInt(tonumber(cmd.line) or 1) - 1, lines)
    return true
  end

  M.handlers = handlers
  return M
end
