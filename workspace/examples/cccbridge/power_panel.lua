-- Power panel for CC:C Bridge (Minecraft 1.18.2, CC:C Bridge 1.5.1).
--
-- A Scroller Pane picks a redstone strength from 0 to 15. The RedRouter sends it out of its front face, a Source
-- Block shows it on whatever Create display the source's display link points at, and the Animatronic on the desk
-- cheers when the power is on and sulks when it is off. A Target Block, fed by another display link (a stress
-- gauge, say), is shown on the source's last row. Turn the key (redstone into the RedRouter's back) to lock the
-- scroller so nobody can change the level.
local scroller = peripheral.find("scroller")
local router = peripheral.find("redrouter")
local source = peripheral.find("create_source")
local target = peripheral.find("create_target")
local puppet = peripheral.find("animatronic")
assert(scroller and router and source, "needs a scroller, a redrouter and a create_source")

scroller.setLimit(15)
scroller.toggleMinusSpectrum(false)

local function trim(s) return (s:gsub("%s+$", "")) end

local function draw()
  local level = scroller.getValue()
  if level < 0 then level = 0 end
  local w, h = source.getSize()
  source.clear()
  source.setCursorPos(1, 1)
  source.write(("Power %2d/15"):format(level))
  if h >= 2 then
    local bar = math.floor(level / 15 * w + 0.5)
    source.setCursorPos(1, 2)
    source.write(("#"):rep(bar) .. ("."):rep(w - bar))
  end
  if h >= 3 then
    source.setCursorPos(1, 3)
    source.write(scroller.isLocked() and "LOCKED" or "turn to set")
  end
  if target and h >= 4 then
    source.setCursorPos(1, h)
    source.write(trim(target.getLine(1)))
  end
end

local function apply()
  local level = math.max(0, scroller.getValue())
  router.setAnalogOutput("front", level)
  if puppet then
    puppet.setFace(level > 0 and "happy" or "sad")
    -- the right arm goes up with the power: 0 hangs down, 15 points straight up
    puppet.setRightArmRot(-level * 12, 0, 0)
    puppet.setHeadRot(level > 0 and -10 or 20, 0, 0)
    puppet.push()
  end
  draw()
end

apply()
local locked = router.getInput("back")
scroller.setLock(locked)
local timer = os.startTimer(1)
while true do
  local event, a = os.pullEvent()
  if event == "scroller_changed" or event == "monitor_resize" then
    apply()
  elseif event == "timer" and a == timer then
    -- CC:C Bridge 1.5.1 sends no redstone event, so the key switch is polled
    local now = router.getInput("back")
    if now ~= locked then
      locked = now
      scroller.setLock(locked)
    end
    draw()
    timer = os.startTimer(1)
  end
end
