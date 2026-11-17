# Debug it

Set a breakpoint by clicking left of a line number, then press **F5** with the `.lua` file open (or pick
**Debug in CraftOS** from the Run button's menu). The program runs in the Run in CraftOS panel and stops on your line.

```lua
local total = 0
for i = 1, 5 do
  total = total + i -- breakpoint here, then watch total in Variables
end
print(total)
```

While it is stopped:

- **Variables** shows the locals, the upvalues and the globals; double-click a value to change it;
- hover a name in the editor, or type an expression in the Debug Console;
- step over, into and out. Step Into skips the ROM's own Lua (`print`, `textutils`) unless the launch
  configuration sets `stepIntoRom`;
- an error nothing catches stops on the line that raised it.

A right-click on a breakpoint gives it a condition, a hit count or a log message. In a `*.test.lua`, **Debug test**
above a test (or Debug in the Testing view) runs the file under `ccunit` with the debugger attached.

No `launch.json` is needed. If you want one, the `craftos` type takes `program`, `test`, `stopOnEntry` and
`stepIntoRom`.
