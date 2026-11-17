---@meta

-- Hand-written: the globals bios.lua adds, the names shared by the other files, and the Lua 5.1 functions CC:Tweaked
-- keeps on top of Lua 5.2. Checked against CC:Tweaked 1.101.3 and 1.121.0 (doc/stub/global.lua, bios.lua).

---A side of a computer, or the name of a peripheral on a wired network (`monitor_0`).
---@alias cc.Side "top"|"bottom"|"left"|"right"|"front"|"back"|string

---One of the six sides of a computer.
---@alias cc.ComputerSide "top"|"bottom"|"left"|"right"|"front"|"back"|string

---A colour of the `colors` API: one bit of 16, `colors.white` (1) to `colors.black` (32768).
---@alias cc.Colour integer

---Several colours added together (`colors.combine`), as bundled cables use.
---@alias cc.ColourSet integer

---A string of hex digits, one per character cell, as `term.blit` takes: `"0"` is white, `"f"` black.
---@alias cc.BlitString string

---The host string, such as `ComputerCraft 1.101.3 (Minecraft 1.18.2)`.
---@type string
_HOST = nil

---The settings the server set for every computer, as `set` would take them (`shell.autocomplete=false,...`).
---@type string
_CC_DEFAULT_SETTINGS = nil

---Wait for a number of seconds. Rounded up to the next game tick (0.05 s). Every event that arrives meanwhile is
---thrown away: use `os.startTimer` and `os.pullEvent` to keep them.
---
---[tweaked.cc](https://tweaked.cc/module/_G.html#v:sleep)
---@param time? number Seconds to wait. Default 0.
function sleep(time) end

---Write text at the cursor of the current terminal, wrapping at the right edge and scrolling at the bottom. No
---newline is added.
---
---[tweaked.cc](https://tweaked.cc/module/_G.html#v:write)
---@param text string|number The text to write.
---@return integer lines How many lines were printed.
function write(text) end

---Write every argument (through `tostring`), then a newline.
---
---[tweaked.cc](https://tweaked.cc/module/_G.html#v:print)
---@param ... any The values to print.
---@return integer lines How many lines were printed.
function print(...) end

---Like `print`, in red where the terminal has colour.
---
---[tweaked.cc](https://tweaked.cc/module/_G.html#v:printError)
---@param ... any The values to print.
function printError(...) end

---Read a line the user types, with editing, history and completion.
---
---[tweaked.cc](https://tweaked.cc/module/_G.html#v:read)
---@param replaceChar? string Shown in place of each typed character (a password field). Only its first character is used.
---@param history? string[] Earlier lines, reached with the up and down keys. Oldest first.
---@param completeFn? fun(partial: string): string[]? Returns what could follow the text typed so far.
---@param default? string Text already in the line.
---@return string line What was typed, without the newline.
function read(replaceChar, history, completeFn, default) end

---Load a file as a function. CC:Tweaked takes the environment as a third argument, or as the second in place of
---the mode.
---@param filename string
---@param mode? "b"|"t"|"bt"|string|table The mode, or the environment.
---@param env? table The environment the chunk runs in. Default `_G`.
---@return function? chunk
---@return string? message Why the file could not be loaded.
function loadfile(filename, mode, env) end

---Run a file and return what it returns. Errors are thrown.
---@param filename string
---@return any ...
function dofile(filename) end

---Load a chunk from a string or from a function that returns its pieces.
---@param chunk string|fun(): string?
---@param chunkname? string
---@param mode? "b"|"t"|"bt"
---@param env? table
---@return function? chunk
---@return string? message
function load(chunk, chunkname, mode, env) end

---Lua 5.1's name for `load` with a string. Still there in CC:Tweaked.
---@param text string
---@param chunkname? string
---@return function? chunk
---@return string? message
function loadstring(text, chunkname) end

---Lua 5.1's name for `table.unpack`. Still there in CC:Tweaked.
---@generic T
---@param list T[]
---@param i? integer
---@param j? integer
---@return T ...
function unpack(list, i, j) end

---The environment of a function, or of the function `f` levels up the stack. Lua 5.1; CC:Tweaked keeps it on
---Lua 5.2 too.
---@param f? integer|function
---@return table
function getfenv(f) end

---Set the environment of a function, or of the function `f` levels up the stack. Lua 5.1; CC:Tweaked keeps it on
---Lua 5.2 too.
---@param f integer|function
---@param env table
---@return function
function setfenv(f, env) end
