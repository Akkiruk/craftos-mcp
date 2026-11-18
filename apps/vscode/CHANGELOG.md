# Changelog

## 0.4.1

- New command: Watch the Agent's Computers. It opens the MCP server's viewer in a panel, so you can see every
  computer the agent made while it works, and type or click monitors yourself
- If port 7878 is taken (two VS Code windows, say) the server's viewer just picks another port. Before, the second
  one had no viewer at all
- A `craftos.json` in your project fills in the Minecraft version, addons and workspace when you haven't set them
  yourself. Your own settings still win. `npx craftos-mcp init` writes one, and it gets checked as you type
- The terminal side got `craftos-mcp doctor` (tells you what's broken and how to fix it), `test --watch` and
  `cache prune`, which clears out old versions piling up in the cache folder
- The extension fetches its own copy of craftos-mcp from npm the first time, into its storage folder, and checks
  every file against npm's hashes. After that it starts with plain `node`, no npx in the way. If the download fails
  it just goes through npx like before
- The MCP server only turns up in workspaces that look like ComputerCraft projects now: Lua files, world files, a
  `craftos.json` or the Lua types in your settings. Your other projects' agents don't get 30 emulator tools they'll
  never use. Set `craftos-mcp.registerServer` to `everywhere` if you want it in all of them
- Add your first Lua file to a folder and the server shows up, no reload

## 0.4.0

Big one. You can debug a ComputerCraft program now: breakpoints, stepping, the lot. World files got a real editor, and
the extension runs on vscode.dev. Needs craftos-mcp 0.4.0 for the debugger, which is what this version starts.

### Debugger

- Press F5 on a `.lua` file and it runs in the Run in CraftOS panel with the debugger attached. No `launch.json`
- Breakpoints, with conditions, hit counts and log messages. Step over, into and out, and pause
- Locals, upvalues and globals in Variables, and you can change a value while it's stopped. Hover a name, add a watch,
  or type in the Debug Console
- Stops on the line that raised an error nothing caught. Tick All Errors if you want the caught ones too
- Step Into skips the ROM's own Lua, so you don't end up inside `print`. `stepIntoRom` in a launch config if you do
  want to go in there
- Debug test above each test, and Debug in the Testing view. A failing assertion stops right where it's raised
- The computer's clock stands still while you're stopped, so your timers don't all go off at once afterwards

### World Editor

- `*.world.json` opens as the computer with what's on each side, the blocks on its network, the players and a map,
  not a wall of JSON. Click an empty side to put something there, drag things around
- The form on the right has every field the emulator knows for the block you picked, with its description
- It's still the same text file underneath. Undo works, git diffs stay small, and Show Text opens the JSON next to it
- The other world files in the folder show up as the other computers, with which modems reach which

### In the browser

- Works on vscode.dev and github.dev. Run in CraftOS runs your program on a WebAssembly build of the engine, also
  straight from a GitHub repo
- It's 1.18.2 only there, no turtles, and no MCP server, tests, debugger or World Editor. Those need the desktop

### Smaller things

- Pick the Minecraft version and the addons from the status bar. The server and any open panel start again in the new
  pack by themselves
- Save the file and the program in the Run in CraftOS panel runs over
- Run test above every test in a `*.test.lua`, and the line that failed stays marked
- Warnings in `.lua` files for things your pack can't do: `goto` on 1.18.2, CraftOS-PC's own APIs, a peripheral from
  an addon you switched off. Most come with a quick fix
- F1, Ctrl+P and friends finally work while the emulator's terminal has the keyboard. They used to get typed into the
  computer
- The terminal in the panel isn't jagged in a narrow panel any more, and it's crisp when there's room
- The two status bar items are one now: `CraftOS 1.21.1`, and a menu with everything in it
- Opening a ComputerCraft folder for the first time asks its questions one at a time, not three notifications at once
- A failed first-run setup says what actually went wrong (it used to show npm's "a complete log can be found in" line)
  and has a Try Again button
- If the emulator dies, the panel has a Start Again button. Before, you had to close it and run the file again
- Settings are in a sensible order, version and addons first
- About a second faster to start the server, a test run or Run in CraftOS once craftos-mcp is installed: it runs
  straight from npx's cache instead of asking npx every time. Run in CraftOS shows the first frame in under half a
  second now
- Opening a big folder with no Lua in it doesn't scan it any more
- Agents get much shorter replies: a big test run's result is about a twelfth of the size (every failure still in
  full), `craftos_read_terminal` can say a screen is unchanged, and a missing program, wrong key name or unknown
  network says what to do instead

## 0.3.0

Started as a small fix release after a long session with an agent hammering the tools, and grew. Runs on craftos-mcp
0.3.0 (falls back to 0.2.0 if npm doesn't have 0.3.0 yet), so new computers start on Minecraft 1.21.1 now, there are
about 30 more mods to switch on, and it works on macOS too.

### The MCP server

- If the server crashes it comes back by itself, and the chat keeps its tools. Before, they just vanished until you
  restarted it by hand from MCP: List Servers. After 3 crashes in 2 minutes it stops and gives you a Restart button
- Killed from outside, it gets started again too
- New command: Restart MCP Server
- New setting `craftos-mcp.workspace`, the folder the computers see. In a big repo the emulator was copying the whole
  thing (node_modules and all) into every computer, which is where the timeouts came from. If your repo looks like
  that and has a `workspace/` or `lua/` folder, it asks once whether to use it
- Run in CraftOS uses the program's own folder now, not the repo root
- New setting `craftos-mcp.registerServer`. On `auto` it stays out of the way when your `.vscode/mcp.json` already has
  a craftos server, so the agent doesn't see every tool twice

### Other editors and clients

- Add to Claude Code passes `cmd /c npx ...` on Windows, which Claude Code needs there
- Cursor and Windsurf don't let extensions add MCP servers. The extension used to skip that quietly; now it offers to
  write a `craftos` entry into their MCP config, and never touches one that's already there

### Autocomplete

- The extension now comes with types for the Lua extension (sumneko.lua): every CC:Tweaked API, the peripherals,
  the mod ones the emulator does (Mekanism, Create, Advanced Peripherals and so on) and `ccunit`. No more red
  squiggles on every `term` and `fs`, and `peripheral.find("monitor")` knows what it gave you
- In a ComputerCraft folder it asks once before touching your settings. Say yes and it adds itself to
  `Lua.workspace.library`, after anything you already had, and only sets the Lua version where you hadn't
- Don't have the Lua extension? It offers to install it, once
- New commands Set Up Lua Types and Remove Lua Types, and a `craftos-mcp.luaTypes` setting (`ask`, `auto`, `off`)
- `*.world.json` files get checked: completion for every key and peripheral type, hover docs, and a squiggle on a
  typo'd key or a bad value

### Everything else

- Status bar item: running, setting up (with the download's progress), restarting or stopped. Click it for a menu
- The first-run download happens when the extension starts, with a progress notification, instead of on your first
  tool call
- The log (craftos-mcp in the Output panel) gets the server's own output too
- Get Started walkthrough
- New Test for This File and New World for This File
- The Testing view listed the same test over and over from `.runtime`, `.claude/worktrees` and `node_modules`. It
  skips those now and goes by your `files.exclude` and `search.exclude`

## 0.2.0

First release, on craftos-mcp 0.2.0.

- craftos-mcp shows up as an MCP server in VS Code, no config needed
- Run in CraftOS on any `.lua` file: the emulator opens beside the editor with monitors and the world panel
- `*.test.lua` files in the Testing view, with failures at the right line
- Add to Claude Code, and Copy MCP Server JSON for other clients
- Snippets for test files and world files
