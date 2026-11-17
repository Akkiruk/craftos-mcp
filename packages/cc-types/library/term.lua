---@meta

-- Hand-written from CC:Tweaked's TermMethods.java and TermAPI.java (1.101.3 and 1.121.0, the same in both).
-- `term` itself is declared in generated/term.lua (redirect, current, native) and inherits every function here.

---Something text can be drawn on: the terminal, a monitor, a window. `term` has the same functions and sends them
---to the current redirect target.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#ty:Redirect)
---@class cc.Redirect
local Redirect = {}

---Write text at the cursor and move the cursor to its end. Does not wrap or scroll: see the global `write`.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:write)
---@param text string|number|boolean|nil Converted with `tostring`.
function Redirect.write(text) end

---Move everything up by `y` lines (down when negative). The lines that come in are blank.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:scroll)
---@param y integer
function Redirect.scroll(y) end

---Where the cursor is. The top left is 1, 1.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getCursorPos)
---@return integer x
---@return integer y
function Redirect.getCursorPos() end

---Move the cursor. It may be off the screen; text written there is not shown.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:setCursorPos)
---@param x integer
---@param y integer
function Redirect.setCursorPos(x, y) end

---Whether the cursor blinks.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getCursorBlink)
---@return boolean blink
function Redirect.getCursorBlink() end

---Show the cursor (blinking) or hide it.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:setCursorBlink)
---@param blink boolean
function Redirect.setCursorBlink(blink) end

---The size in characters.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getSize)
---@return integer width
---@return integer height
function Redirect.getSize() end

---Fill everything with the background colour. The cursor stays where it is.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:clear)
function Redirect.clear() end

---Fill the cursor's line with the background colour.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:clearLine)
function Redirect.clearLine() end

---The colour new text is written in.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getTextColour)
---@return cc.Colour colour
function Redirect.getTextColour() end

---The colour new text is written in.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getTextColour)
---@return cc.Colour color
function Redirect.getTextColor() end

---Set the colour new text is written in.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:setTextColour)
---@param colour cc.Colour One colour of the `colours` API.
function Redirect.setTextColour(colour) end

---Set the colour new text is written in.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:setTextColour)
---@param color cc.Colour One colour of the `colors` API.
function Redirect.setTextColor(color) end

---The colour behind new text, and of `clear`.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getBackgroundColour)
---@return cc.Colour colour
function Redirect.getBackgroundColour() end

---The colour behind new text, and of `clear`.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getBackgroundColour)
---@return cc.Colour color
function Redirect.getBackgroundColor() end

---Set the colour behind new text, and of `clear`.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:setBackgroundColour)
---@param colour cc.Colour One colour of the `colours` API.
function Redirect.setBackgroundColour(colour) end

---Set the colour behind new text, and of `clear`.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:setBackgroundColour)
---@param color cc.Colour One colour of the `colors` API.
function Redirect.setBackgroundColor(color) end

---Whether this shows colour: an advanced computer or monitor.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:isColour)
---@return boolean
function Redirect.isColour() end

---Whether this shows colour: an advanced computer or monitor.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:isColour)
---@return boolean
function Redirect.isColor() end

---Write text with a colour per character. The three strings must be the same length. Each colour is a hex digit:
---`"0"` white to `"f"` black (`colors.toBlit`).
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:blit)
---@param text string
---@param textColour cc.BlitString
---@param backgroundColour cc.BlitString
function Redirect.blit(text, textColour, backgroundColour) end

---Change what a colour looks like: one 24-bit RGB number (`0xFF0000`), or red, green and blue from 0 to 1.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:setPaletteColour)
---@param index cc.Colour The colour to change.
---@param r number Red from 0 to 1.
---@param g number Green from 0 to 1.
---@param b number Blue from 0 to 1.
---@overload fun(index: cc.Colour, rgb: integer)
function Redirect.setPaletteColour(index, r, g, b) end

---Change what a colour looks like: one 24-bit RGB number (`0xFF0000`), or red, green and blue from 0 to 1.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:setPaletteColour)
---@param index cc.Colour The colour to change.
---@param r number Red from 0 to 1.
---@param g number Green from 0 to 1.
---@param b number Blue from 0 to 1.
---@overload fun(index: cc.Colour, rgb: integer)
function Redirect.setPaletteColor(index, r, g, b) end

---What a colour looks like now.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getPaletteColour)
---@param colour cc.Colour
---@return number r Red from 0 to 1.
---@return number g Green from 0 to 1.
---@return number b Blue from 0 to 1.
function Redirect.getPaletteColour(colour) end

---What a colour looks like now.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:getPaletteColour)
---@param color cc.Colour
---@return number r Red from 0 to 1.
---@return number g Green from 0 to 1.
---@return number b Blue from 0 to 1.
function Redirect.getPaletteColor(color) end

---What a colour looks like before any program changes it.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:nativePaletteColour)
---@param colour cc.Colour
---@return number r Red from 0 to 1.
---@return number g Green from 0 to 1.
---@return number b Blue from 0 to 1.
function term.nativePaletteColour(colour) end

---What a colour looks like before any program changes it.
---
---[tweaked.cc](https://tweaked.cc/module/term.html#v:nativePaletteColour)
---@param color cc.Colour
---@return number r Red from 0 to 1.
---@return number g Green from 0 to 1.
---@return number b Blue from 0 to 1.
function term.nativePaletteColor(color) end
