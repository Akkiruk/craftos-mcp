-- A power dashboard on a DirectGPU display: a bar chart of the last readings and a round gauge, redrawn every frame.
local gpu = peripheral.find("directgpu")
if not gpu then error("no DirectGPU attached", 0) end
local frames = tonumber(...) or 3

-- half resolution: 82 pixels a block, 164x82 on a 2x1 monitor
local display = gpu.autoDetectAndCreateDisplay("monitor_0", 0.5)
local info = gpu.getDisplayInfo(display)
local w, h = info.pixelWidth, info.pixelHeight

local readings = {}
for frame = 1, frames do
  readings[#readings + 1] = 20 + (frame * 37) % 60
  gpu.clear(display, 12, 14, 24)
  -- the bars, in a clipped chart area
  gpu.clipRect(display, 4, 4, w - 60, h - 8)
  for i, value in ipairs(readings) do
    local barH = math.floor((h - 8) * value / 100)
    gpu.fillRect(display, 4 + (i - 1) * 12, h - 4 - barH, 10, barH, 60, 200, 120)
  end
  gpu.clearClip(display)
  -- the gauge: a ring and a needle for the latest reading
  local cx, cy, r = w - 28, math.floor(h / 2), 22
  gpu.drawCircle(display, cx, cy, r, 200, 200, 220, false)
  local angle = math.pi * (0.75 + 1.5 * readings[#readings] / 100)
  gpu.drawLine(display, cx, cy, cx + math.floor(math.cos(angle) * (r - 3)), cy + math.floor(math.sin(angle) * (r - 3)), 255, 90, 60)
  gpu.drawCircle(display, cx, cy, 3, 255, 90, 60, true)
  gpu.updateDisplay(display)
  sleep(0.05)
end
return display, readings
