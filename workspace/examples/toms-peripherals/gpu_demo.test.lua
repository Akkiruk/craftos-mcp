-- Runs gpu_demo.lua against a GPU with a 4x3 monitor wall (gpu_demo.world.json) and checks what
-- it draws: whole frames, ended with sync, that change over time, and a ripple after a touch.

-- The program talks to a wrapper that counts the GPU calls of every frame, then passes them on.
local realGpu = peripheral.find("tm_gpu")
local frames = {}        -- one entry per sync: { calls = n, text = {...} }
local current = { calls = 0, text = {} }
local gpu = setmetatable({}, {
  __index = function(_, name)
    return function(...)
      current.calls = current.calls + 1
      current[name] = (current[name] or 0) + 1
      if name == "drawText" then current.text[#current.text + 1] = select(3, ...) end
      local result = { realGpu[name](...) }
      if name == "sync" then
        frames[#frames + 1] = current
        current = { calls = 0, text = {} }
      end
      return table.unpack(result)
    end
  end,
})
local find = peripheral.find
peripheral.find = function(kind, ...)
  if kind == "tm_gpu" then return gpu end
  return find(kind, ...)
end

local seen = {}

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.1) end
  return condition()
end

-- The program draws a frame on each timer, 20 a second when it gets the time: every step waits for frames, not for the
-- clock, as a busy host draws fewer of them a second. A ripple lives for 20 frames.
local function scenario()
  waitFor(function() return #frames >= 10 end, 30)
  seen.framesSeen = #frames
  seen.firstFrame = frames[1]
  local before = #frames
  seen.rectanglesBeforeTouch = frames[before].filledRectangle
  -- a token starting with "sim:" is a command the emulator accepts from the computer itself (world.simProgram)
  os.queueEvent("ccsim_cmd", "sim:1:" .. os.epoch("utc"), textutils.serializeJSON({ cmd = "tmTouch", x = 128, y = 96 }))
  waitFor(function() return #frames >= before + 5 end, 30)
  seen.rectanglesAfterTouch = frames[before + 5] and frames[before + 5].filledRectangle or 0
  waitFor(function() return #frames >= before + 30 end, 60) -- the ripple dies out
  seen.rectanglesAfterRipple = frames[#frames].filledRectangle
  seen.width, seen.height = realGpu.getSize()
end

parallel.waitForAny(function() shell.run("examples/toms-peripherals/gpu_demo.lua") end, scenario)

ccunit.test("it sizes the screen to the monitor wall", function()
  ccunit.eq({ seen.width, seen.height }, { 256, 192 })
end)

ccunit.test("it draws whole frames, one after another", function()
  ccunit.truthy(seen.framesSeen >= 10, "only " .. seen.framesSeen .. " frames in 30 s")
  ccunit.eq(seen.firstFrame.sync, 1)
  ccunit.truthy(seen.firstFrame.line >= 12, "the cube was not drawn")
  ccunit.truthy(seen.firstFrame.filledRectangle >= 16, "the background was not drawn")
end)

ccunit.test("every frame is labelled", function()
  ccunit.eq(seen.firstFrame.text[1], "TOM'S GPU")
  ccunit.truthy(seen.firstFrame.text[2]:find("256x192", 1, true))
end)

ccunit.test("a touch sends a ripple that fades away", function()
  ccunit.truthy(seen.rectanglesAfterTouch > seen.rectanglesBeforeTouch, "no ripple after the touch")
  ccunit.eq(seen.rectanglesAfterRipple, seen.rectanglesBeforeTouch)
end)
