# Run a program

Right-click a `.lua` file and pick **Run in CraftOS**, or use the Run button in the editor title.

The emulator opens beside your code:

- the terminal takes the keyboard;
- monitors update live, and a click on one is a touch;
- the world panel adds players, moves the clock, fills chests and sends sim commands.

The computer's files are the program's own folder, or `craftos-mcp.workspace` if the file is inside it. Closing the
panel stops the computers and the emulator.

Try it with this:

```lua
term.clear()
term.setCursorPos(1, 1)
print("Hello from " .. os.version())
```
