-- ccsim addon directgpu: CC: DirectGPU 1.0.25 (NeoForge, Minecraft 1.21.1), by tiktop101.
--
-- The mod's GitHub repository has only examples and a README; this is written from the release jar
-- (directgpu-1.0.25-neoforge-1.21.1.jar) decompiled with Vineflower 1.10.1: com/tom/directgpu/DirectGPUPeripheral
-- (type "directgpu", 149 @LuaFunction methods, none mainThread), DirectGPUDisplay (pixels, clip, the command stream
-- and how the server reads it back), DirectGPUBlockScopedManager (display ids, 10 per block), DirectGPUConfig.
--
-- Emulated: displays (on a monitor or anywhere), the 2D drawing calls and readback, clipping, mouse events. A display
-- is 164 pixels a block (times the resolution); its pixels are what the server keeps (the back buffer), drawn the way
-- the default config does it (clientAcceleratedRendering: every call is a command, rasterised as
-- applyCommandStreamToBackBuffer does). updateDisplay sends the frame, so that is when the screenshot changes: each
-- display is written to /results/pixels/<gpu name>.<display id>.ppm (packages/runner/src/engine.ts pixelScreens).
-- Every other method is there with its name, and raises an error saying the emulator does not do it.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local order = dofile("/rom/ccsim/addons/javamap.lua").order
  local NAMES = dofile("/rom/ccsim/addons/directgpu/methods.lua")
  local rawFs = { open = fs.open, exists = fs.exists, makeDir = fs.makeDir, delete = fs.delete }
  local floor, max, min = math.floor, math.max, math.min
  local M = {}
  local PPB = 164 -- PIXELS_PER_BLOCK
  local MAX_DISPLAYS = 10

  local function int(i, v) return C.int(i, v) end
  local function num(i, v)
    if type(v) ~= "number" then error(("bad argument #%d (number expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end
  local function str(i, v)
    if type(v) ~= "string" then error(("bad argument #%d (string expected, got %s)"):format(i, C.typeName(v)), 0) end
    return v
  end
  local function bool(i, v) return C.bool(i, v) end
  local function clamp(v) return max(0, min(255, v)) end

  local FACINGS = { north = true, south = true, east = true, west = true, up = true, down = true }
  local function validFacing(f)
    f = f:lower()
    if FACINGS[f] then return true end
    local a, b, c = f:match("^cc:(%a+):(%a+):(%a+)$")
    return a ~= nil and FACINGS[a] and FACINGS[b] and FACINGS[c]
  end

  local function safeName(name) return (tostring(name):gsub("[^%w_%-%.]", "_")) end

  local gpus = {}

  local function newGpu(def)
    local o = { name = def.name, displays = {}, freeIds = {}, nextId = 0, lastMonitor = nil }
    local monitors = type(def.monitors) == "table" and def.monitors or {}

    -- ===== a display: the back buffer as packed 0xRRGGBB per pixel =====

    local function newDisplay(x, y, z, facing, width, height, pw, ph, mult)
      local d = { x = x, y = y, z = z, facing = facing:lower(), width = width, height = height, pw = pw, ph = ph,
        mult = max(1, min(4, mult)), px = {}, clipOn = false, cx = 0, cy = 0, cw = 0, ch = 0, events = {},
        mouse = true }
      return d
    end
    local function allocate(d)
      local count = 0
      for _ in pairs(o.displays) do count = count + 1 end
      if count >= MAX_DISPLAYS then return -1 end
      local id
      if #o.freeIds > 0 then
        table.sort(o.freeIds)
        id = table.remove(o.freeIds, 1)
      else
        id = o.nextId
        o.nextId = o.nextId + 1
      end
      d.id = id
      o.displays[id] = d
      return id
    end
    local function displayOf(id, msg)
      local d = o.displays[id]
      if not d then error(msg or ("Display " .. id .. " does not exist or is not owned by this GPU block"), 0) end
      return d
    end

    -- the raster ops, as applyCommandStreamToBackBuffer runs them (rc = the clip in the stream)
    local function pixelLocal(d, x, y, c)
      if x < 0 or x >= d.pw or y < 0 or y >= d.ph then return end
      if d.clipOn and (x < d.cx or x >= d.cx + d.cw or y < d.cy or y >= d.cy + d.ch) then return end
      d.px[y * d.pw + x] = c
    end
    local function fillLocal(d, x, y, w, h, c)
      if w <= 0 or h <= 0 then return end
      local x0, y0, x1, y1 = max(0, x), max(0, y), min(d.pw, x + w), min(d.ph, y + h)
      if x0 >= x1 or y0 >= y1 then return end
      if d.clipOn then
        x0, y0, x1, y1 = max(x0, d.cx), max(y0, d.cy), min(x1, d.cx + d.cw), min(y1, d.cy + d.ch)
        if x0 >= x1 or y0 >= y1 then return end
      end
      local px, pw = d.px, d.pw
      for py = y0, y1 - 1 do
        local base = py * pw
        for xx = x0, x1 - 1 do px[base + xx] = c end
      end
    end
    local function lineLocal(d, x1, y1, x2, y2, c)
      local dx, dy = math.abs(x2 - x1), math.abs(y2 - y1)
      local sx, sy = x1 < x2 and 1 or -1, y1 < y2 and 1 or -1
      local err = dx - dy
      while true do
        pixelLocal(d, x1, y1, c)
        if x1 == x2 and y1 == y2 then return end
        local e2 = 2 * err
        if e2 > -dy then err = err - dy; x1 = x1 + sx end
        if e2 < dx then err = err + dx; y1 = y1 + sy end
      end
    end
    local function rgb(r, g, b) return clamp(r) * 65536 + clamp(g) * 256 + clamp(b) end

    local function writePpm(d)
      if not rawFs.exists("/results/pixels") then rawFs.makeDir("/results/pixels") end
      local h = rawFs.open("/results/pixels/" .. safeName(def.name) .. "." .. d.id .. ".ppm", "wb")
      if not h then return end
      h.write(("P6\n%d %d\n255\n"):format(d.pw, d.ph))
      local px, chunk = d.px, {}
      local n = 0
      for i = 0, d.pw * d.ph - 1 do
        local c = px[i] or 0
        chunk[n + 1] = floor(c / 65536)
        chunk[n + 2] = floor(c / 256) % 256
        chunk[n + 3] = c % 256
        n = n + 3
        if n >= 3 * 4096 then
          h.write(string.char(table.unpack(chunk, 1, n)))
          n = 0
        end
      end
      if n > 0 then h.write(string.char(table.unpack(chunk, 1, n))) end
      h.close()
    end
    local function dropPpm(d) pcall(rawFs.delete, "/results/pixels/" .. safeName(def.name) .. "." .. d.id .. ".ppm") end

    -- ===== creating displays =====

    local function checkScale(scale)
      if scale ~= scale or scale == math.huge or scale == -math.huge or scale < 0.1 or scale > 4.0 then
        error("resolution must be between 0.1 and 4.0 (1 = 164px per block, 0.5 = 82px per block, 2 = 328px per block)", 0)
      end
      local rounded = floor(scale + 0.5)
      if math.abs(scale - rounded) < 1e-9 then return rounded end
      return scale
    end
    local function checkAxis(v, name)
      if v < 1 or v > 4096 then error(name .. " must be between 1 and 4096", 0) end
      return v
    end
    local function failed(id)
      if id == -1 then error("Failed to create display - check resource limits or max displays per block", 0) end
      return id
    end
    local function withResolution(x, y, z, facing, width, height, mult)
      if width <= 0 or width > 16 then error("Width must be between 1 and 16", 0) end
      if height <= 0 or height > 16 then error("Height must be between 1 and 16", 0) end
      if mult < 1 or mult > 4 then error("Resolution multiplier must be between 1 and 4", 0) end
      if not validFacing(facing) then
        error("Invalid facing. Must be: north, south, east, west, up, down, or cc:<front>:<right>:<down>", 0)
      end
      return failed(allocate(newDisplay(x, y, z, facing, width, height, width * PPB * mult, height * PPB * mult, mult)))
    end
    local function fractional(x, y, z, facing, width, height, scale)
      if not validFacing(facing) then
        error("Invalid facing. Must be: north, south, east, west, up, down, or cc:<front>:<right>:<down>", 0)
      end
      if width <= 0 or width > 16 then error("Width must be between 1 and 16", 0) end
      if height <= 0 or height > 16 then error("Height must be between 1 and 16", 0) end
      local function scaled(blocks) return max(1, floor(blocks * PPB * scale + 0.5)) end
      return failed(allocate(newDisplay(x, y, z, facing, width, height, scaled(width), scaled(height),
        max(1, math.ceil(scale)))))
    end
    local function forScale(x, y, z, facing, width, height, scale)
      scale = checkScale(scale)
      if scale >= 1 and scale == floor(scale) then return withResolution(x, y, z, facing, width, height, scale) end
      return fractional(x, y, z, facing, width, height, scale)
    end
    local function sized(x, y, z, facing, width, height, resX, resY)
      if not validFacing(facing) then
        error("Invalid facing. Must be: north, south, east, west, up, down, or cc:<front>:<right>:<down>", 0)
      end
      if width <= 0 or width > 16 then error("Width must be between 1 and 16", 0) end
      if height <= 0 or height > 16 then error("Height must be between 1 and 16", 0) end
      checkAxis(resX, "resX")
      checkAxis(resY, "resY")
      local needed = max(resX / (PPB * width), resY / (PPB * height))
      local mult = max(1, min(4, math.ceil(needed)))
      return failed(allocate(newDisplay(x, y, z, facing, width, height, resX, resY, mult)))
    end

    -- monitors the GPU can find: the fixture's, by peripheral name
    local function monitorInfo(name)
      local m = monitors[name]
      if type(m) ~= "table" then return nil end
      return { name = name, x = floor(tonumber(m.x) or 0), y = floor(tonumber(m.y) or 0), z = floor(tonumber(m.z) or 0),
        facing = type(m.facing) == "string" and m.facing or "north", width = floor(tonumber(m.width) or 1),
        height = floor(tonumber(m.height) or 1) }
    end
    local function monitorNames()
      local names = {}
      for n in pairs(monitors) do names[#names + 1] = n end
      table.sort(names)
      return names
    end
    local function resolveMonitor(args)
      if type(args[1]) == "string" and args[1] ~= "" then
        local info = monitorInfo(args[1])
        if not info then
          error("Monitor peripheral not found: " .. args[1] .. ". Available monitors: " .. table.concat(monitorNames(), ", "), 0)
        end
        o.lastMonitor = info
        return info
      end
      local names = monitorNames()
      if #names == 0 then error("No monitor found within 32 blocks", 0) end
      o.lastMonitor = monitorInfo(names[1])
      return o.lastMonitor
    end
    local function matching(info, pw, ph)
      local ids = {}
      for id in pairs(o.displays) do ids[#ids + 1] = id end
      table.sort(ids)
      for _, id in ipairs(ids) do
        local d = o.displays[id]
        if d.x == info.x and d.y == info.y and d.z == info.z and d.facing == info.facing:lower() and d.width == info.width
            and d.height == info.height and d.pw == pw and d.ph == ph then
          return id
        end
      end
      return nil
    end
    local function autoCreate(args)
      local hasName = type(args[1]) == "string"
      local base = hasName and 1 or 0
      local isSized = args.n > base + 1 and type(args[base + 2]) == "number"
      if isSized then
        local resX, resY = int(base + 1, args[base + 1]), int(base + 2, args[base + 2])
        checkAxis(resX, "resX")
        checkAxis(resY, "resY")
        local info = resolveMonitor(args)
        return matching(info, resX, resY) or sized(info.x, info.y, info.z, info.facing, info.width, info.height, resX, resY)
      end
      local scale = checkScale(args.n > base and num(base + 1, args[base + 1]) or 1.0)
      local info = resolveMonitor(args)
      local pw, ph
      if scale >= 1 and scale == floor(scale) then
        pw, ph = info.width * PPB * scale, info.height * PPB * scale
      else
        pw, ph = max(1, floor(info.width * PPB * scale + 0.5)), max(1, floor(info.height * PPB * scale + 0.5))
      end
      return matching(info, pw, ph) or forScale(info.x, info.y, info.z, info.facing, info.width, info.height, scale)
    end

    -- ===== the methods =====

    local m = {}
    local function notEmulated(name)
      return function() error("ccsim: DirectGPU's " .. name .. " is not emulated (docs/directgpu.md)", 0) end
    end
    for _, name in ipairs(NAMES) do m[name] = notEmulated(name) end

    function m.createDisplay(...)
      local args = table.pack(...)
      if type(args[1]) == "string" then
        error("ccsim: DirectGPU's createDisplay(\"" .. args[1] .. "\", ...) (GUI and map displays) is not emulated", 0)
      end
      local x, y, z = int(1, args[1]), int(2, args[2]), int(3, args[3])
      local facing = str(4, args[4])
      local width, height = int(5, args[5]), int(6, args[6])
      if args.n > 7 and type(args[8]) == "number" then
        return sized(x, y, z, facing, width, height, int(7, args[7]), int(8, args[8]))
      end
      if args.n > 6 and type(args[7]) == "number" then return forScale(x, y, z, facing, width, height, args[7]) end
      return withResolution(x, y, z, facing, width, height, 1)
    end
    function m.createDisplayAt(...)
      local args = table.pack(...)
      local x, y, z = int(1, args[1]), int(2, args[2]), int(3, args[3])
      if args.n >= 6 then
        local facing = str(4, args[4])
        local width, height = int(5, args[5]), int(6, args[6])
        if args.n > 7 and type(args[8]) == "number" then
          return sized(x, y, z, facing, width, height, int(7, args[7]), int(8, args[8]))
        end
        return forScale(x, y, z, facing, width, height, args.n > 6 and num(7, args[7]) or 1.0)
      end
      local info = o.lastMonitor
      if not info then
        error("createDisplayAt(x, y, z) needs gpu.autoDetectMonitor() first, or pass facing, width, height", 0)
      end
      return withResolution(x, y, z, info.facing, info.width, info.height, 1)
    end
    function m.createDisplayWithResolution(x, y, z, facing, width, height, mult)
      x, y, z, facing = int(1, x), int(2, y), int(3, z), str(4, facing)
      width, height, mult = int(5, width), int(6, height), num(7, mult)
      return forScale(x, y, z, facing, width, height, mult)
    end
    function m.autoDetectAndCreateDisplay(...) return autoCreate(table.pack(...)) end
    function m.autoDetectAndCreateDisplayWithResolution(...) return autoCreate(table.pack(...)) end
    function m.removeDisplay(id)
      id = int(1, id)
      local d = o.displays[id]
      if not d then error("Failed to remove display: Display " .. id .. " not found or not owned by this GPU block", 0) end
      o.displays[id] = nil
      o.freeIds[#o.freeIds + 1] = id
      dropPpm(d)
      return true
    end
    function m.listDisplays()
      local ids = {}
      for id in pairs(o.displays) do ids[#ids + 1] = id end
      table.sort(ids)
      return ids
    end
    function m.clearAllDisplays()
      for id, d in pairs(o.displays) do dropPpm(d) o.displays[id] = nil end
      o.freeIds, o.nextId = {}, 0
    end
    function m.getDisplayInfo(id)
      local d = displayOf(int(1, id))
      return { id = d.id, x = d.x, y = d.y, z = d.z, facing = d.facing, width = d.width, height = d.height,
        pixelWidth = d.pw, pixelHeight = d.ph, resolutionMultiplier = d.mult,
        resolutionScale = d.width > 0 and d.pw / (d.width * PPB) or 1.0 }
    end
    function m.setPixel(id, x, y, r, g, b)
      id, x, y, r, g, b = int(1, id), int(2, x), int(3, y), int(4, r), int(5, g), int(6, b)
      local d = displayOf(id)
      pixelLocal(d, x, y, rgb(r, g, b))
    end
    function m.getPixel(id, x, y)
      id, x, y = int(1, id), int(2, x), int(3, y)
      local d = displayOf(id)
      if x < 0 or x >= d.pw or y < 0 or y >= d.ph then return { 0, 0, 0 } end
      local c = d.px[y * d.pw + x] or 0
      return { floor(c / 65536), floor(c / 256) % 256, c % 256 }
    end
    function m.clear(id, r, g, b)
      id, r, g, b = int(1, id), int(2, r), int(3, g), int(4, b)
      local d = displayOf(id)
      if d.clipOn then
        fillLocal(d, d.cx, d.cy, d.cw, d.ch, rgb(r, g, b))
      else
        local c = rgb(r, g, b)
        local px = d.px
        if c == 0 then d.px = {} else for i = 0, d.pw * d.ph - 1 do px[i] = c end end
      end
    end
    function m.fillRect(id, x, y, w, h, r, g, b)
      id, x, y, w, h = int(1, id), int(2, x), int(3, y), int(4, w), int(5, h)
      r, g, b = int(6, r), int(7, g), int(8, b)
      fillLocal(displayOf(id), x, y, w, h, rgb(r, g, b))
    end
    function m.clipRect(id, x, y, w, h)
      id, x, y, w, h = int(1, id), int(2, x), int(3, y), int(4, w), int(5, h)
      local d = displayOf(id)
      local x0, y0 = max(0, x), max(0, y)
      local x1, y1 = min(d.pw, x + max(0, w)), min(d.ph, y + max(0, h))
      local cw, ch = max(0, x1 - x0), max(0, y1 - y0)
      if cw == 0 or ch == 0 then x0, y0, cw, ch = 0, 0, 0, 0 end
      d.clipOn, d.cx, d.cy, d.cw, d.ch = true, x0, y0, cw, ch
    end
    function m.clearClip(id)
      displayOf(int(1, id)).clipOn = false
    end
    function m.drawLine(id, x1, y1, x2, y2, r, g, b)
      id, x1, y1, x2, y2 = int(1, id), int(2, x1), int(3, y1), int(4, x2), int(5, y2)
      r, g, b = int(6, r), int(7, g), int(8, b)
      lineLocal(displayOf(id), x1, y1, x2, y2, rgb(r, g, b))
    end
    local function points(obj, what, need)
      if type(obj) ~= "table" then error("Points must be a table", 0) end
      local size = 0
      for _ in pairs(obj) do size = size + 1 end
      local list = {}
      for i = 1, size do
        local p = obj[i]
        if p ~= nil then
          if type(p) == "table" then
            local n = 0
            for _ in pairs(p) do n = n + 1 end
            local coords = {}
            for j = 1, n do if p[j] ~= nil then coords[#coords + 1] = p[j] end end
            list[#list + 1] = coords
          else
            list[#list + 1] = p
          end
        end
      end
      if #list < need then error(what .. " requires at least " .. need .. " points", 0) end
      return list
    end
    local function toInt(v)
      if type(v) ~= "number" then C.java("java.lang.ClassCastException") end
      return C.toInt(v)
    end
    local function polyline(d, list, c)
      for i = 1, #list - 1 do
        local p1, p2 = list[i], list[i + 1]
        if type(p1) == "table" and type(p2) == "table" and #p1 >= 2 and #p2 >= 2 then
          lineLocal(d, toInt(p1[1]), toInt(p1[2]), toInt(p2[1]), toInt(p2[2]), c)
        end
      end
    end
    function m.drawPolylines(id, pts, r, g, b)
      id = int(1, id)
      r, g, b = int(3, r), int(4, g), int(5, b)
      local d = displayOf(id)
      polyline(d, points(pts, "drawPolylines", 2), rgb(r, g, b))
    end
    function m.drawPolygon(id, pts, r, g, b)
      id = int(1, id)
      r, g, b = int(3, r), int(4, g), int(5, b)
      local d = displayOf(id)
      local list = points(pts, "drawPolygon", 3)
      local c = rgb(r, g, b)
      polyline(d, list, c)
      local first, last = list[1], list[#list]
      if type(first) == "table" and type(last) == "table" and #first >= 2 and #last >= 2 then
        lineLocal(d, toInt(last[1]), toInt(last[2]), toInt(first[1]), toInt(first[2]), c)
      end
    end
    local function circle(d, cx, cy, radius, c, filled)
      if filled then
        for y = -radius, radius do
          local half = floor(math.sqrt(radius * radius - y * y))
          if half > 0 then fillLocal(d, cx - half, cy + y, half * 2, 1, c) end
        end
        return
      end
      local x, y, dd = 0, radius, 3 - 2 * radius
      while x <= y do
        for _, p in ipairs({ { x, y }, { -x, y }, { x, -y }, { -x, -y }, { y, x }, { -y, x }, { y, -x }, { -y, -x } }) do
          fillLocal(d, cx + p[1], cy + p[2], 1, 1, c)
        end
        if dd < 0 then dd = dd + 4 * x + 6 else dd = dd + 4 * (x - y) + 10; y = y - 1 end
        x = x + 1
      end
    end
    local function ellipse(d, cx, cy, rx, ry, c, filled)
      if filled then
        for y = -ry, ry do
          local half = floor(rx * math.sqrt(max(0, 1 - (y * y) / (ry * ry))))
          if half > 0 then fillLocal(d, cx - half, cy + y, half * 2, 1, c) end
        end
        return
      end
      local x, y = 0, ry
      local rx2, ry2 = rx * rx, ry * ry
      local twoRx2, twoRy2 = 2 * rx2, 2 * ry2
      local px, py = 0, twoRx2 * ry
      local function put()
        fillLocal(d, cx + x, cy + y, 1, 1, c); fillLocal(d, cx - x, cy + y, 1, 1, c)
        fillLocal(d, cx + x, cy - y, 1, 1, c); fillLocal(d, cx - x, cy - y, 1, 1, c)
      end
      local p = C.toInt((ry2 - rx2 * ry) + 0.25 * rx2)
      while px < py do
        put()
        x = x + 1
        px = px + twoRy2
        if p < 0 then p = p + ry2 + px else y = y - 1; py = py - twoRx2; p = p + ry2 + px - py end
      end
      p = C.toInt(ry2 * (x + 0.5) * (x + 0.5) + rx2 * (y - 1) * (y - 1) - rx2 * ry2)
      while y >= 0 do
        put()
        y = y - 1
        py = py - twoRx2
        if p > 0 then p = p + rx2 - py else x = x + 1; px = px + twoRy2; p = p + rx2 - py + px end
      end
    end
    function m.drawCircle(id, cx, cy, radius, r, g, b, filled)
      id, cx, cy, radius = int(1, id), int(2, cx), int(3, cy), int(4, radius)
      r, g, b, filled = int(5, r), int(6, g), int(7, b), bool(8, filled)
      circle(displayOf(id), cx, cy, radius, rgb(r, g, b), filled)
    end
    function m.drawEllipse(id, cx, cy, rx, ry, r, g, b, filled)
      id, cx, cy, rx, ry = int(1, id), int(2, cx), int(3, cy), int(4, rx), int(5, ry)
      r, g, b, filled = int(6, r), int(7, g), int(8, b), bool(9, filled)
      ellipse(displayOf(id), cx, cy, rx, ry, rgb(r, g, b), filled)
    end
    function m.fillEllipse(id, cx, cy, rx, ry, r, g, b)
      id, cx, cy, rx, ry = int(1, id), int(2, cx), int(3, cy), int(4, rx), int(5, ry)
      r, g, b = int(6, r), int(7, g), int(8, b)
      ellipse(displayOf(id), cx, cy, rx, ry, rgb(r, g, b), true)
    end
    function m.updateDisplay(id)
      local d = displayOf(int(1, id))
      writePpm(d)
    end
    -- mouse input (enableMouseEvents, pollEvent, hasEvents, clearEvents)
    local function displayForEvents(id)
      return displayOf(id, "No display with ID " .. id .. " exists")
    end
    function m.enableMouseEvents(id, enabled, hover)
      id, enabled = int(1, id), bool(2, enabled)
      if hover ~= nil then hover = bool(3, hover) end
      local d = displayForEvents(id)
      d.mouse = enabled
      if enabled then d.sink, d.hover = true, hover == true end
    end
    function m.pollEvent(id)
      local d = displayForEvents(int(1, id))
      return table.remove(d.events, 1)
    end
    function m.hasEvents(id) return #displayForEvents(int(1, id)).events > 0 end
    function m.clearEvents(id) displayForEvents(int(1, id)).events = {} end

    o.methods = m
    --- a player's mouse on a display (DirectGPUDisplay.addMouseEvent and enableMouseEvents' sink)
    function o.mouse(id, kind, x, y, button)
      local d = o.displays[id]
      if not d then return false, "no display " .. tostring(id) end
      if not d.mouse then return true end
      if #d.events >= 100 then table.remove(d.events, 1) end
      d.events[#d.events + 1] = { type = kind, x = x, y = y, button = button, timestamp = os.epoch("utc") }
      if d.sink and (d.hover or kind ~= "mouse_hover") then
        os.queueEvent("directgpu_mouse", id, kind, x, y, button)
      end
      return true
    end
    return o
  end

  function M.peripheral(def)
    local o = newGpu(def)
    gpus[def.name] = o
    return {
      methods = o.methods,
      methodOrder = order(NAMES),
      computerThread = setmetatable({}, { __index = function() return true end }),
      exactReturns = true,
      state = function()
        local displays = {}
        for id, d in pairs(o.displays) do
          displays[tostring(id)] = { pixelWidth = d.pw, pixelHeight = d.ph, width = d.width, height = d.height,
            facing = d.facing, x = d.x, y = d.y, z = d.z }
        end
        return { displays = displays }
      end,
      detach = function() gpus[def.name] = nil end,
    }
  end

  local handlers = {}
  --- dgMouse {peripheral, display, x, y, type?, button?}: a player clicks (or drags, scrolls...) on a display
  function handlers.dgMouse(cmd)
    local o = gpus[tostring(cmd.peripheral)]
    if not o then return false, "no directgpu named " .. tostring(cmd.peripheral) end
    return o.mouse(tonumber(cmd.display) or 0, tostring(cmd.type or "mouse_click"), math.floor(tonumber(cmd.x) or 0),
      math.floor(tonumber(cmd.y) or 0), math.floor(tonumber(cmd.button) or 1))
  end
  M.handlers = handlers
  return M
end
