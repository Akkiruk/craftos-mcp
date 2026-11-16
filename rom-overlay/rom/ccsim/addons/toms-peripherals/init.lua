-- ccsim addon toms-peripherals: Tom's Peripherals 1.18.2-1.2.1 (Forge), every peripheral it has.
--
-- Written from the mod's source and checked against the release jar (toms-peripherals-1.18.2-1.2.1.jar, javap):
--   1.18 branch, commit 3b609fa ("1.2.1"), Forge/src/platform-shared/java/com/tom/peripherals/:
--     block/entity/GPUBlockEntity, MonitorBlockEntity, KeyboardBlockEntity, RedstonePortBlockEntity,
--     WatchDogTimerBlockEntity; menu/KeyboardMenu; client/MonHandler, KeyboardWidget; cc/CCPeripheral, CCComputer;
--     util/NativeImageIO; Config
--   api branch, commit 5dbf6fc (the API built into 1.2.1), src/shared/java/com/tom/peripherals/: gpu/*, util/*,
--     api/* (see gpu.lua, gpu3d.lua, png.lua, java.lua)
-- docs/toms-peripherals.md lists every behaviour with its source, and what could not be confirmed.
--
-- Peripherals: tm_gpu (its monitors are blocks, not peripherals: the fixture's `monitor` wall), tm_keyboard (the
-- keyboard and the keyboard dongle), tm_rsPort, tm_wdt. Every method is an IDynamicPeripheral method, so all of them
-- run at once on the computer thread. What the mod hands to the server thread (Platform.getServer().execute:
-- refreshSize, sync's monitor update, the watchdog's setters) runs at once too, as it does on an idle server.
-- The GPU's monitors are written to /results/pixels/<name>.ppm on every save, for screenshots.
return function(core, host)
  local J = dofile("/rom/ccsim/addons/toms-peripherals/java.lua")()
  -- fonts.lua is generated from the mod's jar (scripts/build-toms-fonts.mjs), so a copy without it can exist
  local FONTS = "/rom/ccsim/addons/toms-peripherals/fonts.lua"
  local NO_FONTS = "Tom's Peripherals fonts missing: run node scripts/build-toms-fonts.mjs"
  local fontData = fs.exists(FONTS) and dofile(FONTS) or nil
  local png = dofile("/rom/ccsim/addons/toms-peripherals/png.lua")()
  local G = dofile("/rom/ccsim/addons/toms-peripherals/gpu.lua")(core, J, fontData, png)
  G.gpu3d = dofile("/rom/ccsim/addons/toms-peripherals/gpu3d.lua")(J, G)
  local P = J.P
  local floor = math.floor
  local rawFs = { open = fs.open, exists = fs.exists, makeDir = fs.makeDir, delete = fs.delete }
  local queue = os.queueEvent

  local cfg = core.world.tomsPeripherals or {}
  local maxScreenSize = tonumber(cfg.maxScreenSize) or 16 -- Config.Server maxScreenSize, 1-64, default 16

  local function saved(name)
    local s = core.savedState
    return s and type(s.peripherals) == "table" and s.peripherals[name] or nil
  end
  local function allOnComputerThread(order)
    local set = {}
    for _, name in ipairs(order) do set[name] = true end
    return set
  end
  local function now() return os.epoch("utc") end
  --- The first server tick after now (a task handed to the server runs between ticks, the block ticks on them)
  local function nextTick(t) return (floor(t / 50) + 1) * 50 end

  -- ===== tm_gpu =====

  local gpus, gpuOrder = {}, {}
  local VRAM_SIZE = 16 * 1024 * 1024 -- GPUPeripheral: new VRAM(16 * 1024 * 1024) (the config's maxVRAMSize is unused)

  local function safeName(name) return (tostring(name):gsub("[^%w_%-%.]", "_")) end
  local function pixelPath(name) return "/results/pixels/" .. safeName(name) .. ".ppm" end

  local function readPpm(path)
    if not rawFs.exists(path) then return nil end
    local h = rawFs.open(path, "rb")
    if not h then return nil end
    local data = h.readAll()
    h.close()
    local w, hh, rest = data:match("^P6\n(%d+) (%d+)\n255\n()")
    if not w then return nil end
    w, hh = tonumber(w), tonumber(hh)
    local px = {}
    for i = 0, w * hh - 1 do
      local o = rest + i * 3
      local r, g, b = data:byte(o, o + 2)
      if not b then break end
      local v = (r * 256 + g) * 256 + b
      if v ~= 0 then px[i] = v end
    end
    return { w = w, h = hh, px = px }
  end

  local function writePpm(path, d)
    if not rawFs.exists("/results/pixels") then rawFs.makeDir("/results/pixels") end
    local h = rawFs.open(path, "wb")
    if not h then return end
    h.write(string.format("P6\n%d %d\n255\n", d.w, d.h))
    local px, w = d.px, d.w
    local bytes, n = {}, 0
    for i = 0, w * d.h - 1 do
      local v = px[i] or 0
      bytes[n + 1] = floor(v / 65536) % 256
      bytes[n + 2] = floor(v / 256) % 256
      bytes[n + 3] = v % 256
      n = n + 3
      if n >= 3000 then
        h.write(string.char(table.unpack(bytes, 1, n)))
        n = 0
      end
    end
    if n > 0 then h.write(string.char(table.unpack(bytes, 1, n))) end
    h.close()
  end

  local function newGpu(def)
    local name = def.name
    if not fontData then
      -- every call says what is missing; the other blocks of the mod still work
      local methods = {}
      for _, m in ipairs(G.ORDER.GPUExt) do methods[m] = function() error(NO_FONTS, 0) end end
      return { methods = methods, methodOrder = G.ORDER.GPUExt, computerThread = allOnComputerThread(G.ORDER.GPUExt) }
    end
    local mon = type(def.monitor) == "table" and def.monitor or {}
    local g = {
      name = name,
      wall = { w = tonumber(mon.width) or 0, h = tonumber(mon.height) or 0 },
      maxX = 0, maxY = 0, size = 16,
      sw = 16, sh = 16, screen = {}, -- GPUPeripheral.screen: int[16][16] until the monitors connect
      err = 0,
      monitors = nil,                -- nil: never looked for; else { cols, rows } (cols == 0: none)
      linked = { cols = 0, rows = 0 }, -- monitors that know this GPU (MonitorBlockEntity.gpuPos), for touches
      monWidth = 0,                  -- MonitorBlockEntity.width: the size at the last sync, 0 before
      display = nil, frames = 0, dirty = false,
    }
    g.vram = G.newVram(VRAM_SIZE)

    local ctx = { vram = g.vram }
    g.ctx = ctx
    function ctx.set(x, y, c)
      if x < 0 or x >= g.sw then J.aioobe(x, g.sw) end
      if y < 0 or y >= g.sh then J.aioobe(y, g.sh) end
      -- Integer.reverseBytes(c) >> 8 | 0xFF000000: the colour's RGB as NativeImage ABGR, alpha always opaque
      g.screen[x * g.sh + y] = c % 16777216
    end
    function ctx.width() return g.maxX * g.size end
    function ctx.height() return g.maxY * g.size end
    function ctx.bounds() return G.newRect(0, 0, ctx.width(), ctx.height(), false) end
    function ctx.vsize() return g.maxX * g.size * g.maxY * g.size * 4 end
    g.vram.alloc(ctx)

    local function newScreen(w, h) g.sw, g.sh, g.screen = w, h, {} end

    --- connectMonitors: the wall the GPU touches, grown right and up from the monitor next to it
    local function connectMonitors()
      g.err = 0
      local w, h = g.wall.w, g.wall.h
      if w <= 0 or h <= 0 then return { cols = 0, rows = 0 } end
      if w > maxScreenSize or h > maxScreenSize then
        g.err = 1
        return { cols = 0, rows = 0 }
      end
      if w > g.linked.cols then g.linked.cols = w end
      if h > g.linked.rows then g.linked.rows = h end
      local oldX, oldY = g.maxX, g.maxY
      g.maxX, g.maxY = w, h
      if oldX ~= w or oldY ~= h then
        local newSize = w * g.size * h * g.size * 4
        if g.vram.realloc(ctx, newSize) then
          newScreen(w * g.size, h * g.size)
        else
          g.err = 2
          return { cols = 0, rows = 0 }
        end
      end
      return { cols = w, rows = h }
    end
    function g.getMonitors(force)
      if g.monitors == nil or force then g.monitors = connectMonitors() end
      return g.monitors
    end

    --- sync0: every monitor of the wall takes its square of the screen (separateIntArray) and the GPU's size
    function ctx.sync()
      local m = g.getMonitors(false)
      if m.cols == 0 then return end
      local size = g.size
      local w, h = m.cols * size, m.rows * size
      local px, sh = {}, g.sh
      for k, v in pairs(g.screen) do
        local x, y = floor(k / sh), k % sh
        if x < w and y < h and v ~= 0 then px[y * w + x] = v end
      end
      g.display = { w = w, h = h, px = px }
      g.monWidth = size
      g.frames = g.frames + 1
      g.dirty = true
      core.touch()
    end

    -- GPUExt: the GPU block's own methods on top of GPUImpl
    local ext = setmetatable({}, { __index = G.B })
    function ext.setSize(_, a)
      local s = P.getInt(a, 0)
      if s < 16 then error("Bad Argument #1, (too small number (" .. s .. ") minimum value is 16 )", 0) end
      if s > 64 then error("Bad Argument #1, (too big number (" .. s .. ") maximum value is 64 )", 0) end
      g.vram.reallocEx(ctx, J.i32(s * g.maxX * s * g.maxY * 4))
      newScreen(s * g.maxX, s * g.maxY)
      g.size = s
    end
    function ext.refreshSize() g.getMonitors(true) end
    function ext.getSize() return ctx.width(), ctx.height(), g.maxX, g.maxY, g.size end
    local extClass = { name = "GPUExt", order = G.ORDER.GPUExt, methods = ext }
    local impl = { __class = extClass, ctx = ctx, font = G.getOrLoadFont(g.vram.intFonts, "ascii") }
    g.impl = impl

    -- GPUPeripheral.call: a broken screen fails every call; otherwise callInt, so any Java exception reaches CC
    -- ("Java Exception Thrown: ...")
    local methods = {}
    for _, mname in ipairs(G.ORDER.GPUExt) do
      methods[mname] = function(...)
        if g.err == 1 then error("Attached screen too big", 0) end
        if g.err == 2 then error("Not enough VRAM for screen buffer", 0) end
        if mname == "listMethods" then return table.unpack(G.ORDER.GPUExt) end
        local r = table.pack(pcall(ext[mname], impl, table.pack(...)))
        if not r[1] then
          local e = r[2]
          if J.isJava(e) then e = "Java Exception Thrown: " .. tostring(e) end
          error(e, 0)
        end
        return G.mapTo(r, 2)
      end
    end

    -- what survives a reboot: the block keeps its size, monitors and picture
    local old = saved(name)
    if old and type(old.restore) == "table" then
      local r = old.restore
      g.maxX, g.maxY, g.size, g.err = r.maxX or 0, r.maxY or 0, r.size or 16, r.err or 0
      g.sw, g.sh, g.monWidth, g.frames = r.sw or 16, r.sh or 16, r.monWidth or 0, r.frames or 0
      if r.cols then g.monitors = { cols = r.cols, rows = r.rows } end
      g.linked = { cols = r.linkedCols or 0, rows = r.linkedRows or 0 }
      g.display = readPpm(pixelPath(name))
      if g.display then
        for k, v in pairs(g.display.px) do
          local x, y = k % g.display.w, floor(k / g.display.w)
          if x < g.sw and y < g.sh then g.screen[x * g.sh + y] = v end
        end
      end
    end

    function g.state()
      if g.dirty and g.display then
        writePpm(pixelPath(name), g.display)
        g.dirty = false
      end
      return {
        width = ctx.width(), height = ctx.height(), size = g.size,
        monitor = { width = g.wall.w, height = g.wall.h },
        error = g.err ~= 0 and (g.err == 1 and "Attached screen too big" or "Not enough VRAM for screen buffer") or nil,
        display = g.display and { width = g.display.w, height = g.display.h, frames = g.frames } or nil,
        usedMemory = g.vram.used(),
        restore = {
          maxX = g.maxX, maxY = g.maxY, size = g.size, err = g.err, sw = g.sw, sh = g.sh, monWidth = g.monWidth,
          frames = g.frames, cols = g.monitors and g.monitors.cols, rows = g.monitors and g.monitors.rows,
          linkedCols = g.linked.cols, linkedRows = g.linked.rows,
        },
      }
    end

    gpus[name] = g
    gpuOrder[#gpuOrder + 1] = name
    return {
      methods = methods,
      methodOrder = G.ORDER.GPUExt, -- CC's HashMap(33) of these names keeps this order
      computerThread = allOnComputerThread(G.ORDER.GPUExt),
      state = g.state,
    }
  end

  --- A pixel of the wall (1-based, top-left, at the GPU's current size) -> the event coordinates the mod sends.
  --- nil when no event comes (the monitor does not know the GPU, or is not in its list).
  local function wallEvent(g, x, y)
    local size = g.size
    local px, py = floor(x) - 1, floor(y) - 1
    if px < 0 or py < 0 then return nil, "x and y start at 1" end
    local bx, byTop = floor(px / size), floor(py / size)
    if bx >= g.wall.w or byTop >= g.wall.h then return nil, "no monitor at that pixel" end
    local rowFromBottom = g.wall.h - 1 - byTop
    if bx >= g.linked.cols or rowFromBottom >= g.linked.rows then return false end -- gpuPos is null: nothing
    -- getMonitorPixel: the hit, here the pixel's centre, times the monitor's width (0 before the first sync)
    local xP = floor(((px % size) + 0.5) / size * g.monWidth)
    local yP = floor(((py % size) + 0.5) / size * g.monWidth)
    local m = g.getMonitors(false)
    if bx >= m.cols or rowFromBottom >= m.rows then return false end
    local index2 = m.rows - 1 - rowFromBottom
    return xP + size * bx + 1, yP + size * index2 + 1
  end

  local function gpuFor(cmd)
    local g = gpus[cmd.peripheral or gpuOrder[1]]
    if not g then return nil, "no tm_gpu named " .. tostring(cmd.peripheral) end
    return g
  end

  local MON_EVENTS = { mouse_click = true, mouse_up = true, mouse_scroll = true, mouse_drag = true,
    mouse_move = true, mouse_enter = true, mouse_exit = true }

  -- ===== tm_keyboard =====

  local keyboards, keyboardOrder = {}, {}

  local function newKeyboard(def)
    local k = { name = def.name, native = false, dongle = def.dongle == true }
    keyboards[def.name] = k
    keyboardOrder[#keyboardOrder + 1] = def.name
    --- Peripheral.queueEvent: the event itself with native events on, else tm_keyboard_<event> with the name
    function k.queue(event, ...)
      if k.native then queue(event, ...) else queue("tm_keyboard_" .. event, k.name, ...) end
    end
    return {
      methods = {
        setFireNativeEvents = function(...)
          k.native = P.getBoolean(table.pack(...), 0)
        end,
      },
      methodOrder = { "setFireNativeEvents" },
      computerThread = { setFireNativeEvents = true },
      state = function() return { nativeEvents = k.native, dongle = k.dongle } end,
    }
  end

  local function keyboardFor(cmd)
    local k = keyboards[cmd.peripheral or keyboardOrder[1]]
    if not k then return nil, "no tm_keyboard named " .. tostring(cmd.peripheral) end
    return k
  end
  local function keyCode(v)
    if type(v) == "number" then return floor(v) end
    if type(v) == "string" and type(keys) == "table" and type(keys[v]) == "number" then return keys[v] end
    return nil
  end

  -- ===== tm_rsPort =====

  local SIDES = { "down", "up", "north", "south", "west", "east" } -- Direction ordinal order, getSerializedName
  local SIDE_INDEX = {}
  for i, s in ipairs(SIDES) do SIDE_INDEX[s] = i end
  local ports = {}

  local function sidesOf(t, default)
    local out = {}
    for i, s in ipairs(SIDES) do out[i] = type(t) == "table" and tonumber(t[s]) or default end
    return out
  end
  local function bySide(arr)
    local out = {}
    for i, s in ipairs(SIDES) do out[s] = arr[i] end
    return out
  end

  local function newPort(def)
    local old = saved(def.name)
    old = old and old.restore
    local r = {
      name = def.name,
      input = sidesOf(old and old.input or def.inputs, 0),
      bundledInput = sidesOf(old and old.bundledInput or def.bundledInputs, 0),
      output = sidesOf(old and old.output, 0), bundledOutput = sidesOf(old and old.bundledOutput, 0),
      external = sidesOf(old and old.external, 0), externalBundled = sidesOf(old and old.externalBundled, 0),
      pending = false, inputPending = false,
    }
    ports[def.name] = r

    --- updateServer on the next tick: tm_redstone for a changed input, the outputs reach the world
    local function scheduleTick()
      if r.pending then return end
      r.pending = true
      core.after((nextTick(now()) - now()) / 1000, function()
        r.pending = false
        if r.inputPending then
          r.inputPending = false
          queue("tm_redstone", r.name)
        end
        for i = 1, 6 do r.external[i], r.externalBundled[i] = r.output[i], r.bundledOutput[i] end
        core.save()
      end)
    end
    r.scheduleTick = scheduleTick

    local function getDir(v)
      local side = J.toString(v):lower()
      local i = SIDE_INDEX[side]
      if not i then error("Bad argument #1: expected one of: up, down, north, south, east, west", 0) end
      return i
    end
    local function need(a, what)
      if a.n < 1 then error("Too few arguments (expected " .. what .. ")", 0) end
    end
    local function need2(a, what)
      if a.n < 2 then error("Too few arguments (expected " .. what .. ")", 0) end
    end

    local m = {}
    function m.getSides() return table.unpack(SIDES) end
    function m.getInput(a) need(a, "direction"); return r.input[getDir(a[1])] > 0 end
    function m.getAnalogInput(a) need(a, "direction"); return r.input[getDir(a[1])] end
    m.getAnalogueInput = m.getAnalogInput
    function m.getBundledInput(a) need(a, "direction"); return r.bundledInput[getDir(a[1])] end
    function m.getOutput(a) need(a, "direction"); return r.output[getDir(a[1])] > 0 end
    function m.getAnalogOutput(a) need(a, "direction"); return r.output[getDir(a[1])] end
    m.getAnalogueOutput = m.getAnalogOutput
    function m.getBundledOutput(a) need(a, "direction"); return r.bundledOutput[getDir(a[1])] end
    local function setOut(i, v)
      if r.output[i] ~= v then r.output[i] = v; scheduleTick() end
    end
    function m.setOutput(a)
      need2(a, "direction, value")
      if type(a[2]) ~= "boolean" then error("Bad argument #2 (expected Boolean)", 0) end
      setOut(getDir(a[1]), a[2] and 15 or 0)
    end
    function m.setAnalogOutput(a)
      need2(a, "direction, value")
      if type(a[2]) ~= "number" then error("Bad argument #2 (expected Number)", 0) end
      local dir = getDir(a[1])
      local out = J.floor(a[2])
      if out < 0 or out > 15 then error("Bad argument #2: Expected number in range 0-15", 0) end
      setOut(dir, out)
    end
    m.setAnalogueOutput = m.setAnalogOutput
    function m.setBundledOutput(a)
      need2(a, "direction, value")
      if type(a[2]) ~= "number" then error("Bad argument #2 (expected Number)", 0) end
      local dir = getDir(a[1])
      local out = J.floor(a[2])
      if r.bundledOutput[dir] ~= out then r.bundledOutput[dir] = out; scheduleTick() end
    end
    function m.testBundledInput(a)
      need2(a, "direction, mask")
      if type(a[2]) ~= "number" then error("Bad argument #2 (expected Number)", 0) end
      local value = r.bundledInput[getDir(a[1])]
      local mask = J.floor(a[2])
      return J.band(J.u32(value), J.u32(mask)) == J.u32(mask)
    end

    local ORDER = { "getSides", "getBundledOutput", "setAnalogueOutput", "getBundledInput", "getInput",
      "getAnalogInput", "testBundledInput", "setAnalogOutput", "getAnalogOutput", "getAnalogueInput",
      "getAnalogueOutput", "listMethods", "setOutput", "setBundledOutput", "getOutput" }
    local methods = {}
    for _, mname in ipairs(ORDER) do
      methods[mname] = function(...)
        if mname == "listMethods" then return table.unpack(ORDER) end
        local res = table.pack(pcall(m[mname], table.pack(...)))
        if not res[1] then
          local e = res[2]
          if J.isJava(e) then e = "Java Exception Thrown: " .. tostring(e) end
          error(e, 0)
        end
        return table.unpack(res, 2, res.n)
      end
    end
    return {
      methods = methods,
      methodOrder = ORDER, -- CC's HashMap(15) keeps the mod's order
      computerThread = allOnComputerThread(ORDER),
      state = function()
        return {
          inputs = bySide(r.input), bundledInputs = bySide(r.bundledInput),
          outputs = bySide(r.external), bundledOutputs = bySide(r.externalBundled),
          restore = { input = bySide(r.input), bundledInput = bySide(r.bundledInput), output = bySide(r.output),
            bundledOutput = bySide(r.bundledOutput), external = bySide(r.external),
            externalBundled = bySide(r.externalBundled) },
        }
      end,
    }
  end

  -- ===== tm_wdt =====

  local function newWdt(def)
    local old = saved(def.name)
    old = old and old.restore
    local w = {
      name = def.name,
      enabled = (old and old.enabled) or (not old and def.enabled == true) or false,
      timeLimit = old and old.timeLimit or J.floor(tonumber(def.timeout) or 0),
      deadline = old and old.deadline or nil,
      fired = old and old.fired or 0,
      target = def.target ~= false, -- the block faces this computer
      gen = 0,
    }
    local function schedule()
      w.gen = w.gen + 1
      if not (w.enabled and w.deadline) then return end
      local gen = w.gen
      core.after(math.max(0, w.deadline - now()) / 1000, function()
        if gen ~= w.gen or not w.enabled then return end
        -- updateServer: timer > timeLimit, so it stops and restarts the computer it faces
        w.enabled = false
        w.deadline = nil
        w.fired = w.fired + 1
        core.save()
        if w.target then os.reboot() end
      end)
    end
    --- timer = 0 now: the next tick counts it to 1, and the tick it is above timeLimit restarts the computer
    local function restart() w.deadline = nextTick(now()) + (w.timeLimit + 1) * 50 end
    if not old and w.enabled then restart() end
    schedule()

    local m = {}
    function m.isEnabled() return w.enabled end
    function m.getTimeout() return w.timeLimit end
    function m.setEnabled(a)
      if a.n < 1 then error("Too few arguments (expected enable)", 0) end
      local enable = P.getBoolean(a, 0)
      w.enabled = enable
      if enable then restart() else w.deadline = nil end
      schedule()
      core.touch()
    end
    function m.setTimeout(a)
      if w.enabled then error("Can't edit timeout value while the timer is enabled", 0) end
      if a.n < 1 then error("Too few arguments (expected enable)", 0) end
      local time = P.getInt(a, 0)
      if time < 20 then error("Bad argument #1 (expected value must be larger than 20 ticks)", 0) end
      w.timeLimit = time
      core.touch()
    end
    function m.reset()
      if w.enabled then restart(); schedule() end
    end
    local ORDER = { "setEnabled", "setTimeout", "getTimeout", "isEnabled", "reset", "listMethods" }
    local methods = {}
    for _, mname in ipairs(ORDER) do
      methods[mname] = function(...)
        if mname == "listMethods" then return table.unpack(ORDER) end
        local res = table.pack(pcall(m[mname], table.pack(...)))
        if not res[1] then
          local e = res[2]
          if J.isJava(e) then e = "Java Exception Thrown: " .. tostring(e) end
          error(e, 0)
        end
        return table.unpack(res, 2, res.n)
      end
    end
    return {
      methods = methods,
      methodOrder = { "setEnabled", "reset", "listMethods", "setTimeout", "getTimeout", "isEnabled" }, -- HashMap(6)
      computerThread = allOnComputerThread(ORDER),
      state = function()
        return {
          enabled = w.enabled, timeout = w.timeLimit, fired = w.fired,
          restartsInMs = w.deadline and math.max(0, w.deadline - now()) or nil,
          restore = { enabled = w.enabled, timeLimit = w.timeLimit, deadline = w.deadline, fired = w.fired },
        }
      end,
    }
  end

  -- ===== sim commands =====

  local handlers = {}

  --- tmTouch {peripheral?, x, y, sneak?}: a player right-clicks the wall at pixel x, y (1-based, the GPU's size)
  function handlers.tmTouch(cmd)
    local g, err = gpuFor(cmd)
    if not g then return false, err end
    local ex, ey = wallEvent(g, tonumber(cmd.x) or 0, tonumber(cmd.y) or 0)
    if ex == nil then return false, ey end
    if ex then queue("tm_monitor_touch", g.name, ex, ey, cmd.sneak == true) end
    return true
  end

  --- tmMonitorEvent {peripheral?, event, x, y, param?}: a keyboard pointed at the wall (KeyboardMenu monEvent)
  function handlers.tmMonitorEvent(cmd)
    local g, err = gpuFor(cmd)
    if not g then return false, err end
    if not MON_EVENTS[cmd.event] then return false, "event must be one of mouse_click, mouse_up, mouse_scroll, mouse_drag, mouse_move, mouse_enter, mouse_exit" end
    local ex, ey = wallEvent(g, tonumber(cmd.x) or 0, tonumber(cmd.y) or 0)
    if ex == nil then return false, ey end
    if ex then
      local param = cmd.param ~= nil and floor(tonumber(cmd.param) or 0) or nil
      queue("tm_monitor_" .. cmd.event, g.name, ex, ey, param)
    end
    return true
  end

  --- tmSetMonitors {peripheral?, width, height}: the wall is rebuilt (the GPU sees it after refreshSize)
  function handlers.tmSetMonitors(cmd)
    local g, err = gpuFor(cmd)
    if not g then return false, err end
    g.wall = { w = floor(tonumber(cmd.width) or 0), h = floor(tonumber(cmd.height) or 0) }
    core.touch()
    return true
  end

  --- tmReloadGpu {peripheral?}: the chunk reloads: a fresh GPU (no size, no VRAM, no error), blank monitors
  function handlers.tmReloadGpu(cmd)
    local g, err = gpuFor(cmd)
    if not g then return false, err end
    g.maxX, g.maxY, g.size, g.err, g.monitors, g.monWidth = 0, 0, 16, 0, nil, 0
    g.sw, g.sh, g.screen = 16, 16, {}
    g.linked = { cols = 0, rows = 0 }
    g.display, g.dirty = nil, false
    local fresh = G.newVram(VRAM_SIZE)
    for k in pairs(g.vram) do g.vram[k] = nil end
    for k, v in pairs(fresh) do g.vram[k] = v end
    g.vram.alloc(g.ctx)
    g.impl.font = G.getOrLoadFont(g.vram.intFonts, "ascii")
    if rawFs.exists(pixelPath(g.name)) then rawFs.delete(pixelPath(g.name)) end
    core.touch()
    return true
  end

  local function withKeyboard(cmd, fn)
    local k, err = keyboardFor(cmd)
    if not k then return false, err end
    return fn(k)
  end

  --- tmKey {peripheral?, key, repeat?}: key is a key code or a keys name ("enter")
  function handlers.tmKey(cmd)
    return withKeyboard(cmd, function(k)
      local code = keyCode(cmd.key)
      if not code then return false, "key must be a key code or a name from keys" end
      k.queue("key", code, cmd["repeat"] == true)
      return true
    end)
  end
  function handlers.tmKeyUp(cmd)
    return withKeyboard(cmd, function(k)
      local code = keyCode(cmd.key)
      if not code then return false, "key must be a key code or a name from keys" end
      k.queue("key_up", code)
      return true
    end)
  end
  function handlers.tmChar(cmd)
    return withKeyboard(cmd, function(k)
      if type(cmd.char) ~= "string" or #cmd.char ~= 1 then return false, "char must be one character" end
      k.queue("char", cmd.char)
      return true
    end)
  end
  --- tmType {peripheral?, text}: one char event per character
  function handlers.tmType(cmd)
    return withKeyboard(cmd, function(k)
      if type(cmd.text) ~= "string" then return false, "text must be a string" end
      for i = 1, #cmd.text do k.queue("char", cmd.text:sub(i, i)) end
      return true
    end)
  end
  function handlers.tmPaste(cmd)
    return withKeyboard(cmd, function(k)
      if type(cmd.text) ~= "string" then return false, "text must be a string" end
      k.queue("paste", cmd.text)
      return true
    end)
  end
  --- tmKeyboardEvent {peripheral?, event}: the keyboard screen's terminate / shutdown / reboot buttons
  function handlers.tmKeyboardEvent(cmd)
    return withKeyboard(cmd, function(k)
      if cmd.event ~= "terminate" and cmd.event ~= "shutdown" and cmd.event ~= "reboot" then
        return false, "event must be terminate, shutdown or reboot"
      end
      k.queue(cmd.event)
      return true
    end)
  end
  --- tmPortable {peripheral?, connected, id?}: a portable keyboard opens or closes on a dongle
  function handlers.tmPortable(cmd)
    return withKeyboard(cmd, function(k)
      if not k.dongle then return true end -- onKeyboardOpen/Closed only queue for the dongle
      if cmd.connected == false then
        k.queue("portable_disconnect", floor(tonumber(cmd.id) or 1))
      else
        k.queue("portable_connect", 0) -- KeyboardMenu passes randomId before it is set: always 0
      end
      return true
    end)
  end

  --- tmSetRedstoneInput {peripheral, side, level?, bundled?}
  function handlers.tmSetRedstoneInput(cmd)
    local r = ports[cmd.peripheral]
    if not r then return false, "no tm_rsPort named " .. tostring(cmd.peripheral) end
    local i = SIDE_INDEX[tostring(cmd.side):lower()]
    if not i then return false, "side must be one of down, up, north, south, west, east" end
    local changed = false
    if cmd.level ~= nil then
      local v = math.max(0, math.min(15, floor(tonumber(cmd.level) or 0)))
      if r.input[i] ~= v then r.input[i] = v; changed = true end
    end
    if cmd.bundled ~= nil then
      local v = floor(tonumber(cmd.bundled) or 0)
      if r.bundledInput[i] ~= v then r.bundledInput[i] = v; changed = true end
    end
    if changed then r.inputPending = true; r.scheduleTick() end
    core.touch()
    return true
  end

  local builders = { tm_gpu = newGpu, tm_keyboard = newKeyboard, tm_rsPort = newPort, tm_wdt = newWdt }
  return {
    peripheral = function(def) return builders[def.type](def) end,
    handlers = handlers,
  }
end
