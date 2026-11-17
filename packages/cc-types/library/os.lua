---@meta

-- Hand-written from CC:Tweaked's OSAPI.java, bios.lua and doc/events (1.101.3 and 1.121.0). CraftOS has its own `os`:
-- of Lua's it keeps only clock, date and time, and time works differently. Switch the built-in one off
-- ("Lua.runtime.builtin": { "os": "disable" }) so its other functions are not offered.

---Every event CC:Tweaked queues, and those of the mods the emulator has. Any other string is fine too: programs
---queue their own with `os.queueEvent`.
---@alias cc.Event
---| "alarm" # (id) an `os.setAlarm` alarm went off
---| "char" # (character) a character was typed
---| "computer_command" # (...) the `/computercraft queue` command, command computers only
---| "disk" # (side) a disk was put in a drive
---| "disk_eject" # (side) a disk was taken out of a drive
---| "file_transfer" # (files) files were dropped on the computer
---| "http_check" # (url, ok, reason?) `http.checkURLAsync` finished
---| "http_failure" # (url, reason, response?) `http.request` failed
---| "http_success" # (url, response) `http.request` finished
---| "key" # (key, isHeld) a key went down
---| "key_up" # (key) a key was let go
---| "modem_message" # (side, channel, replyChannel, message, distance?) a modem received a message
---| "monitor_resize" # (side) a monitor changed size
---| "monitor_touch" # (side, x, y) an advanced monitor was right-clicked
---| "mouse_click" # (button, x, y) the terminal was clicked
---| "mouse_drag" # (button, x, y) the mouse moved with a button down
---| "mouse_scroll" # (direction, x, y) the wheel turned: -1 up, 1 down
---| "mouse_up" # (button, x, y) a mouse button was let go
---| "paste" # (text) text was pasted
---| "peripheral" # (side) a peripheral was attached
---| "peripheral_detach" # (side) a peripheral was removed
---| "rednet_message" # (sender, message, protocol?) a rednet message arrived
---| "redstone" # a redstone input changed
---| "setting_changed" # (name, value, oldValue) a setting was set
---| "speaker_audio_empty" # (side) a speaker can take more audio
---| "task_complete" # (id, ok, ...) `commands.execAsync` finished
---| "term_resize" # the terminal changed size
---| "terminate" # Ctrl+T was held: only `os.pullEventRaw` sees it
---| "timer" # (id) an `os.startTimer` timer ran out
---| "turtle_inventory" # the turtle's inventory changed
---| "websocket_closed" # (url, reason?, code?) a websocket was closed
---| "websocket_failure" # (url, reason) a websocket could not connect
---| "websocket_message" # (url, message, isBinary) a websocket message arrived
---| "websocket_success" # (url, websocket) a websocket connected
---| "chat" # Advanced Peripherals chat box: (username, message, uuid, isHidden)
---| "playerClick" # Advanced Peripherals player detector: (username)
---| "crafting" # Advanced Peripherals ME/RS bridge: (ok, message)
---| "tm_keyboard_key" # Tom's Peripherals keyboard: (keyboard, key, isHeld)
---| "tm_keyboard_key_up" # Tom's Peripherals keyboard: (keyboard, key)
---| "tm_keyboard_char" # Tom's Peripherals keyboard: (keyboard, character)
---| "tm_keyboard_paste" # Tom's Peripherals keyboard: (keyboard, text)
---| "tm_monitor_touch" # Tom's Peripherals GPU: (gpu, x, y, sneaking)
---| "tm_monitor_mouse_click" # Tom's Peripherals GPU: (gpu, x, y, button); also tm_monitor_mouse_up, _drag, _scroll
---| "tm_redstone" # Tom's Peripherals redstone port: (port)
---| string

---A date as `os.date("*t")` returns it and `os.time` takes it.
---@class cc.Date
---@field year integer
---@field month integer 1 to 12.
---@field day integer 1 to 31.
---@field hour integer 0 to 23.
---@field min integer 0 to 59.
---@field sec integer 0 to 61.
---@field wday integer 1 (Sunday) to 7.
---@field yday integer 1 to 366.
---@field isdst boolean

---Lua's `os` library as CraftOS has it: the computer's clock, timers, events, label and power.
---
---[tweaked.cc](https://tweaked.cc/module/os.html)
---@class cc.os
os = {}

---The CraftOS version, such as `CraftOS 1.8`.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:version)
---@return string
function os.version() end

---Wait for the next event, or the next one named `filter`. Stops the program with "Terminated" when Ctrl+T is held.
---Returns the event's name, then its values (listed under `cc.Event`).
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:pullEvent)
---@param filter? cc.Event Only return this event; the others that arrive meanwhile are dropped.
---@return string event The event's name.
---@return any ... The event's values.
---@overload fun(filter: "alarm"): "alarm", integer
---@overload fun(filter: "char"): "char", string
---@overload fun(filter: "computer_command"): "computer_command", string ...
---@overload fun(filter: "disk"): "disk", string
---@overload fun(filter: "disk_eject"): "disk_eject", string
---@overload fun(filter: "file_transfer"): "file_transfer", cc.TransferredFiles
---@overload fun(filter: "http_check"): "http_check", string, boolean, string?
---@overload fun(filter: "http_failure"): "http_failure", string, string, cc.http.Response?
---@overload fun(filter: "http_success"): "http_success", string, cc.http.Response
---@overload fun(filter: "key"): "key", integer, boolean
---@overload fun(filter: "key_up"): "key_up", integer
---@overload fun(filter: "modem_message"): "modem_message", string, integer, integer, any, number?
---@overload fun(filter: "monitor_resize"): "monitor_resize", string
---@overload fun(filter: "monitor_touch"): "monitor_touch", string, integer, integer
---@overload fun(filter: "mouse_click"): "mouse_click", integer, integer, integer
---@overload fun(filter: "mouse_drag"): "mouse_drag", integer, integer, integer
---@overload fun(filter: "mouse_scroll"): "mouse_scroll", integer, integer, integer
---@overload fun(filter: "mouse_up"): "mouse_up", integer, integer, integer
---@overload fun(filter: "paste"): "paste", string
---@overload fun(filter: "peripheral"): "peripheral", string
---@overload fun(filter: "peripheral_detach"): "peripheral_detach", string
---@overload fun(filter: "rednet_message"): "rednet_message", integer, any, string?
---@overload fun(filter: "redstone"): "redstone"
---@overload fun(filter: "setting_changed"): "setting_changed", string, any, any
---@overload fun(filter: "speaker_audio_empty"): "speaker_audio_empty", string
---@overload fun(filter: "task_complete"): "task_complete", integer, boolean, any ...
---@overload fun(filter: "term_resize"): "term_resize"
---@overload fun(filter: "timer"): "timer", integer
---@overload fun(filter: "turtle_inventory"): "turtle_inventory"
---@overload fun(filter: "websocket_closed"): "websocket_closed", string, string?, integer?
---@overload fun(filter: "websocket_failure"): "websocket_failure", string, string
---@overload fun(filter: "websocket_message"): "websocket_message", string, string, boolean
---@overload fun(filter: "websocket_success"): "websocket_success", string, cc.http.Websocket
function os.pullEvent(filter) end

---Like `os.pullEvent`, but `terminate` is returned like any other event and does not stop the program.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:pullEventRaw)
---@param filter? cc.Event Only return this event (and `terminate`).
---@return string event The event's name.
---@return any ... The event's values.
---@overload fun(filter: "alarm"): "alarm"|"terminate", integer
---@overload fun(filter: "char"): "char"|"terminate", string
---@overload fun(filter: "key"): "key"|"terminate", integer, boolean
---@overload fun(filter: "key_up"): "key_up"|"terminate", integer
---@overload fun(filter: "modem_message"): "modem_message"|"terminate", string, integer, integer, any, number?
---@overload fun(filter: "monitor_touch"): "monitor_touch"|"terminate", string, integer, integer
---@overload fun(filter: "mouse_click"): "mouse_click"|"terminate", integer, integer, integer
---@overload fun(filter: "mouse_drag"): "mouse_drag"|"terminate", integer, integer, integer
---@overload fun(filter: "mouse_scroll"): "mouse_scroll"|"terminate", integer, integer, integer
---@overload fun(filter: "mouse_up"): "mouse_up"|"terminate", integer, integer, integer
---@overload fun(filter: "paste"): "paste"|"terminate", string
---@overload fun(filter: "rednet_message"): "rednet_message"|"terminate", integer, any, string?
---@overload fun(filter: "timer"): "timer"|"terminate", integer
function os.pullEventRaw(filter) end

---The same as the global `sleep`.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:sleep)
---@param time? number Seconds to wait, rounded up to the next 0.05. Default 0.
function os.sleep(time) end

---Run a program file with an environment and arguments. Does not look the name up like the shell does, and the
---program gets no `shell`. Prints the error and returns false when it fails.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:run)
---@param env table The program's environment.
---@param path string The exact path of the file.
---@param ... any Arguments for the program.
---@return boolean ok
function os.run(env, path, ...) end

---Load a file as a global table named after it.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:loadAPI)
---@deprecated It fills the global table. Use `require`.
---@param path string
---@return boolean ok
function os.loadAPI(path) end

---Remove a table `os.loadAPI` loaded.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:unloadAPI)
---@deprecated See `os.loadAPI`.
---@param name string
function os.unloadAPI(name) end

---Add an event to the queue. `os.pullEvent` returns it later.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:queueEvent)
---@param name cc.Event The event's name.
---@param ... any Its values: booleans, numbers, strings and tables. Functions and metatables are not kept.
function os.queueEvent(name, ...) end

---Start a timer. A `timer` event with the returned id is queued when it runs out.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:startTimer)
---@param time number Seconds, rounded up to the next 0.05.
---@return integer id
function os.startTimer(time) end

---Cancel a timer of `os.startTimer`. Its event is not queued.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:cancelTimer)
---@param id integer
function os.cancelTimer(id) end

---Set an alarm for an in-game time of day. An `alarm` event with the returned id is queued then.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:setAlarm)
---@param time number The time of day, 0.0 up to 24.0.
---@return integer id
function os.setAlarm(time) end

---Cancel an alarm of `os.setAlarm`.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:cancelAlarm)
---@param id integer
function os.cancelAlarm(id) end

---Turn the computer off at once.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:shutdown)
function os.shutdown() end

---Restart the computer at once.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:reboot)
function os.reboot() end

---The computer's id.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:getComputerID)
---@return integer id
function os.getComputerID() end

---The computer's id.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:computerID)
---@return integer id
function os.computerID() end

---The computer's label, or nil when it has none.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:getComputerLabel)
---@return string? label
function os.getComputerLabel() end

---The computer's label, or nil when it has none.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:computerLabel)
---@return string? label
function os.computerLabel() end

---Set the computer's label, or clear it with nil.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:setComputerLabel)
---@param label? string
function os.setComputerLabel(label) end

---Seconds the computer has been running.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:clock)
---@return number seconds
function os.clock() end

---The time of day. Without an argument, or with `"ingame"`, the Minecraft world's time as hours (0.0 to 24.0).
---`"utc"` and `"local"` give the real hour of the day. A table from `os.date("*t")` gives its UNIX timestamp in
---seconds.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:time)
---@param locale? "ingame"|"utc"|"local"|cc.Date Default `"ingame"`.
---@return number time
function os.time(locale) end

---The day. Without an argument, or with `"ingame"`, days the Minecraft world has existed. `"utc"` and `"local"` give
---days since 1 January 1970.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:day)
---@param locale? "ingame"|"utc"|"local" Default `"ingame"`.
---@return integer day
function os.day(locale) end

---Milliseconds since an epoch. Without an argument, or with `"ingame"`, since the world began (a Minecraft hour is
---3,600,000 of them, 72 times real speed). `"utc"` and `"local"` give real milliseconds since 1 January 1970.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:epoch)
---@param locale? "ingame"|"utc"|"local" Default `"ingame"`.
---@return number milliseconds
function os.epoch(locale) end

---A date as text or as a table, like Lua's `os.date`.
---
---[tweaked.cc](https://tweaked.cc/module/os.html#v:date)
---@param format? string A `strftime` format; `"*t"` returns a table; a leading `!` means UTC. Default `"%c"`.
---@param time? integer A UNIX timestamp in seconds. Default now.
---@return string|cc.Date
function os.date(format, time) end
