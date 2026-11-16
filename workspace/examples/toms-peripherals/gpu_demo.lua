-- Tom's Peripherals GPU demo.
--
-- Draws pixel graphics on a monitor wall with the GPU block: a spinning wireframe cube over a
-- colour-cycling background, a sine ribbon and a frame counter. Right-click the monitor to send
-- a ripple out from where you clicked.
--
-- Needs a GPU (tm_gpu) with a monitor wall next to it. Usage: gpu_demo

local FPS = 20
local gpu = peripheral.find("tm_gpu")
if not gpu then error("no GPU (tm_gpu) found", 0) end

gpu.refreshSize()          -- find the monitor wall
gpu.setSize(64)            -- 64 pixels per monitor block
local width, height = gpu.getSize()
if width == 0 then error("the GPU has no monitor next to it", 0) end

--- Pack red, green and blue (0-255) into the colour number the GPU takes.
local function rgb(r, g, b)
  return math.floor(r) * 65536 + math.floor(g) * 256 + math.floor(b)
end

--- A rainbow: hue 0..1 around the wheel.
local function hue(h)
  h = h % 1
  local i = math.floor(h * 6)
  local f = h * 6 - i
  local q = 255 * (1 - f)
  local t = 255 * f
  if i == 0 then return rgb(255, t, 0)
  elseif i == 1 then return rgb(q, 255, 0)
  elseif i == 2 then return rgb(0, 255, t)
  elseif i == 3 then return rgb(0, q, 255)
  elseif i == 4 then return rgb(t, 0, 255)
  else return rgb(255, 0, q) end
end

-- The cube: eight corners and the twelve edges between them
local CORNERS = {
  { -1, -1, -1 }, { 1, -1, -1 }, { 1, 1, -1 }, { -1, 1, -1 },
  { -1, -1, 1 }, { 1, -1, 1 }, { 1, 1, 1 }, { -1, 1, 1 },
}
local EDGES = {
  { 1, 2 }, { 2, 3 }, { 3, 4 }, { 4, 1 },
  { 5, 6 }, { 6, 7 }, { 7, 8 }, { 8, 5 },
  { 1, 5 }, { 2, 6 }, { 3, 7 }, { 4, 8 },
}

--- Rotate a corner around the y then x axis and project it onto the screen.
local function project(corner, angle)
  local x, y, z = corner[1], corner[2], corner[3]
  local c, s = math.cos(angle), math.sin(angle)
  x, z = x * c - z * s, x * s + z * c
  c, s = math.cos(angle * 0.7), math.sin(angle * 0.7)
  y, z = y * c - z * s, y * s + z * c
  local scale = math.min(width, height) * 0.22 / (1 - z / 5)
  return width / 2 + x * scale, height / 2 + y * scale, z
end

local ripples = {} -- {x, y, age}

local function drawFrame(frame)
  local t = frame / FPS

  -- Background: horizontal bands that slowly cycle through dark colours
  local bands = 16
  for i = 0, bands - 1 do
    local y = math.floor(i * height / bands) + 1
    local colour = hue(t / 12 + i / bands / 2)
    local r = math.floor(colour / 65536) % 256 * 0.25
    local g = math.floor(colour / 256) % 256 * 0.25
    local b = colour % 256 * 0.25
    gpu.filledRectangle(1, y, width, math.ceil(height / bands) + 1, rgb(r, g, b))
  end

  -- Sine ribbon across the lower third
  local previousY
  for x = 1, width, 2 do
    local y = height * 0.82 + math.sin(x / 14 + t * 3) * height * 0.07
    if previousY then gpu.line(x - 2, previousY, x, y, hue(x / width + t / 4)) end
    previousY = y
  end

  -- Cube
  local points = {}
  for i, corner in ipairs(CORNERS) do
    local px, py = project(corner, t)
    points[i] = { math.floor(px), math.floor(py) }
  end
  for i, edge in ipairs(EDGES) do
    local a, b = points[edge[1]], points[edge[2]]
    gpu.line(a[1], a[2], b[1], b[2], hue(t / 3 + i / #EDGES))
  end

  -- Ripples from touches: rings that grow and are gone after a second
  for i = #ripples, 1, -1 do
    local ripple = ripples[i]
    local radius = ripple.age * 4
    if ripple.age > FPS then
      table.remove(ripples, i)
    else
      local colour = hue(ripple.age / FPS)
      for step = 0, 23 do
        local angle = step / 24 * math.pi * 2
        local x = math.floor(ripple.x + math.cos(angle) * radius)
        local y = math.floor(ripple.y + math.sin(angle) * radius)
        if x >= 1 and x <= width and y >= 1 and y <= height - 7 then
          gpu.filledRectangle(x, y, 2, 2, colour)
        end
      end
      ripple.age = ripple.age + 1
    end
  end

  gpu.drawText(4, 4, "TOM'S GPU", 0xFFFFFF)
  gpu.drawText(4, height - 10, ("%dx%d px  frame %d"):format(width, height, frame), 0xAAAAAA)
  gpu.sync() -- hand the finished picture to the monitors
end

local frame = 0
local timer = os.startTimer(1 / FPS)
while true do
  local event, a, b, c = os.pullEvent()
  if event == "timer" and a == timer then
    frame = frame + 1
    drawFrame(frame)
    timer = os.startTimer(1 / FPS)
  elseif event == "tm_monitor_touch" then
    ripples[#ripples + 1] = { x = b, y = c, age = 0 }
  end
end
