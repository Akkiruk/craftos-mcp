# Get autocomplete

The extension carries type definitions for every CC:Tweaked API, the peripherals, the mod peripherals the emulator
knows (Advanced Peripherals, Mekanism, Create and the rest) and `ccunit`. They're for the Lua extension by sumneko.

```lua
local monitor = peripheral.find("monitor") -- knows it's a monitor
monitor.setCursorPos(1, 1)
local event, key = os.pullEvent("key") -- key is a key code
```

**Set Up Lua Types** adds them to this workspace's `.vscode/settings.json`: it appends to `Lua.workspace.library`
and only sets the Lua version where you haven't. In a ComputerCraft workspace the extension asks once on its own;
`craftos-mcp.luaTypes` turns that into `auto` or `off`.
