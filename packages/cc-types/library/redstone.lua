---@meta

-- Hand-written from CC:Tweaked's RedstoneAPI.java and RedstoneMethods.java (1.101.3 and 1.121.0, the same in both).

---Redstone on the six sides of the computer: on and off, strength 0 to 15, and bundled cables.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html)
---@class cc.redstone
redstone = {}

---The same table as `redstone`.
rs = redstone

---The six sides: `{ "bottom", "top", "back", "front", "right", "left" }`.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getSides)
---@return string[] sides
function redstone.getSides() end

---Turn the signal of a side on (strength 15) or off.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:setOutput)
---@param side cc.ComputerSide
---@param on boolean
function redstone.setOutput(side, on) end

---Whether the computer outputs a signal on a side.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getOutput)
---@param side cc.ComputerSide
---@return boolean
function redstone.getOutput(side) end

---Whether a signal comes in on a side.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getInput)
---@param side cc.ComputerSide
---@return boolean
function redstone.getInput(side) end

---Set the strength of the signal of a side.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:setAnalogOutput)
---@param side cc.ComputerSide
---@param value integer 0 to 15.
function redstone.setAnalogOutput(side, value) end

---Set the strength of the signal of a side.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:setAnalogOutput)
---@param side cc.ComputerSide
---@param value integer 0 to 15.
function redstone.setAnalogueOutput(side, value) end

---The strength the computer outputs on a side.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getAnalogOutput)
---@param side cc.ComputerSide
---@return integer strength 0 to 15.
function redstone.getAnalogOutput(side) end

---The strength the computer outputs on a side.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getAnalogOutput)
---@param side cc.ComputerSide
---@return integer strength 0 to 15.
function redstone.getAnalogueOutput(side) end

---The strength of the signal coming in on a side.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getAnalogInput)
---@param side cc.ComputerSide
---@return integer strength 0 to 15.
function redstone.getAnalogInput(side) end

---The strength of the signal coming in on a side.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getAnalogInput)
---@param side cc.ComputerSide
---@return integer strength 0 to 15.
function redstone.getAnalogueInput(side) end

---Set which colours of a bundled cable are on.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:setBundledOutput)
---@param side cc.ComputerSide
---@param output cc.ColourSet Colours added together (`colors.combine`).
function redstone.setBundledOutput(side, output) end

---Which colours of a bundled cable the computer turns on.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getBundledOutput)
---@param side cc.ComputerSide
---@return cc.ColourSet output
function redstone.getBundledOutput(side) end

---Which colours of a bundled cable come in.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:getBundledInput)
---@param side cc.ComputerSide
---@return cc.ColourSet input
function redstone.getBundledInput(side) end

---Whether every colour of `mask` comes in on a bundled cable.
---
---[tweaked.cc](https://tweaked.cc/module/redstone.html#v:testBundledInput)
---@param side cc.ComputerSide
---@param mask cc.ColourSet
---@return boolean
function redstone.testBundledInput(side, mask) end
