# Changelog

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
