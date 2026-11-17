# craftos-mcp for VS Code

Run and test ComputerCraft (CC:Tweaked) Lua without Minecraft, right in VS Code, and give your AI agent the same
emulator as an MCP server so it can run, test and fix the code it writes.

[craftos-mcp](https://github.com/Akkiruk/craftos-mcp) is a CC:Tweaked emulator: real CC:Tweaked behaviour (it passes
1189 of 1190 of CC:Tweaked's own tests at 1.101.3 and 1361 of 1362 at 1.121.0), monitors with touch, several computers on rednet, turtles in a
block world, and peripherals from Create, Mekanism, Advanced Peripherals, Tom's Peripherals and more.

![A Mekanism reactor controller on a monitor in craftos-mcp: the temperature climbs until the program scrams the reactor](https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/docs/media/demo.gif)

## Quick start

| You use                  | Do this                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| VS Code with Copilot     | Install the extension. Agent mode in Chat has the craftos tools straight away.                      |
| Claude Code              | Run **craftos-mcp: Add to Claude Code** from the Command Palette.                                   |
| Cursor or Windsurf       | Install the extension and say yes when it offers to add craftos to the editor's MCP config.         |
| Any other MCP client     | **craftos-mcp: Copy MCP Server JSON**, then paste it into the client's config.                      |
| No agent, just your code | Right-click a `.lua` file, **Run in CraftOS**. Put tests in `*.test.lua` and run them from Testing. |

**craftos-mcp: Get Started** walks through all of it.

## Features

- **An MCP server for VS Code's agents.** The extension registers `craftos-mcp` with VS Code, so agent mode in Chat
  sees its tools (`craftos_run`, `craftos_test`, `craftos_ui`, `craftos_sim_command` and the rest) with nothing to
  configure. It runs in your first workspace folder, or in `craftos-mcp.workspace`. If the server crashes it starts
  again by itself and the chat keeps its tools; after 3 crashes in 2 minutes it stops and offers Restart.
- **A status bar item.** `CraftOS` in the status bar shows whether the server is running, setting up (with the
  download's progress) or stopped. Click it for Run, Restart MCP Server, Show Log and the rest.
- **Run in CraftOS.** Right-click a `.lua` file (in the editor or the explorer) and pick **Run in CraftOS**, or use
  the Run button in the editor title. The emulator's app opens beside your code: the terminal takes the keyboard,
  monitors update live and a click is a touch, and the world panel adds players, moves the clock, fills chests and
  sends any sim command. If `name.world.json` sits next to `name.lua`, the computer runs in that world, with its
  monitors. Closing the panel stops the computers and the emulator.
- **Tests in the Testing view.** Every `*.test.lua` file shows up with its `ccunit.test` cases. Run them from the
  Testing view or the gutter; a failure points at the line Lua named. `name.test.lua` runs in `name.world.json` when
  there is one.
- **New Test for This File / New World for This File** make `name.test.lua` or `name.world.json` next to the open
  program, filled in for it.
- **Add to Claude Code.** The command **craftos-mcp: Add to Claude Code** runs
  `claude mcp add craftos -- npx -y craftos-mcp serve` for you, at the scope you pick. On Windows it passes
  `cmd /c npx -y craftos-mcp serve`, which Claude Code needs there.
- **Cursor and Windsurf.** They don't let extensions add MCP servers, so the extension can't give their agents the
  server by itself. Instead it offers once (and **craftos-mcp: Add to Cursor / Windsurf MCP Config** any time) to
  add a `craftos` entry to `.cursor/mcp.json`, `~/.cursor/mcp.json` or `~/.codeium/windsurf/mcp_config.json`. It
  never overwrites an entry that is already there. Run in CraftOS and the Testing view work the same in both.
- **Copy MCP Server JSON** for Claude Desktop or any other MCP client.
- **Lua autocomplete for CC:Tweaked.** With the [Lua extension](https://marketplace.visualstudio.com/items?itemName=sumneko.lua)
  (`sumneko.lua`) installed, every CC:Tweaked API, the peripherals, the mod peripherals the emulator knows and
  `ccunit` complete, show their docs on hover and get type checked, instead of a wall of "Undefined global `term`".
  `peripheral.find("monitor")` knows it's a monitor. In a ComputerCraft workspace the extension asks once whether to
  set it up (or offers to install the Lua extension first); **craftos-mcp: Set Up Lua Types** does it any time. See
  [Lua types](#lua-types) for what it writes.
- **World files are checked.** `*.world.json` gets completion for keys, peripheral types, addon ids and versions,
  hover docs, and a squiggle on a typo'd key or a bad value.
- **Snippets**: `cctest` writes a test file that reads a monitor back, `ccunit.test`, `ccunit.eq`, `ccunit.truthy` and
  `ccunit.raises` write single checks, and `ccworld` in a JSON file writes a world with monitors, a player, a chest
  and a battery.

## Requirements

- **Windows x64, Linux x64, or macOS 11+ (Apple silicon or Intel).**
- **Node.js 22 or newer** on your PATH. The extension starts the emulator with `npx -y craftos-mcp@0.3.0`.

The first start downloads the engine from the project's GitHub release and builds the CC:Tweaked ROM from the official
jar on your machine (CC:Tweaked's license does not allow shipping it). That takes about a minute, once per version, and
lands in `%LOCALAPPDATA%\craftos-mcp` or `~/.cache/craftos-mcp` (`CRAFTOS_HOME` moves it).

## Writing tests

A test file is plain Lua that calls the `ccunit` harness. It runs in a fresh computer whose files are your workspace
folder:

```lua
ccunit.test("addition", function() ccunit.eq(1 + 1, 2) end)
ccunit.test("tables compare deeply", function() ccunit.eq({ 1, { a = 2 } }, { 1, { a = 2 } }) end)
ccunit.test("raises on bad argument", function()
  ccunit.raises(function() error("boom") end, "boom")
end)
```

And a world next to it, `name.world.json`:

```json
{
  "addons": ["advanced-peripherals"],
  "monitors": [{ "name": "top", "blocksWide": 3, "blocksHigh": 2 }],
  "players": [{ "name": "Alice", "x": 2, "y": 64, "z": 0 }],
  "peripherals": [
    {
      "name": "playerDetector_0",
      "type": "playerDetector",
      "x": 0,
      "y": 64,
      "z": 0
    }
  ]
}
```

The same tests run from a terminal or CI with `npx craftos-mcp test`.

## Settings

| Setting                        | What it does                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `craftos-mcp.addons`           | The mods your pack has (`CRAFTOS_ADDONS`): `all`, `none` or ids such as `create,mekanism`.                                                       |
| `craftos-mcp.minecraftVersion` | `1.21.1` (the default, the newest) or `1.20.1` (CC:Tweaked 1.121.0), or `1.18.2` (CC:Tweaked 1.101.3, the most complete simulation of the mods). |
| `craftos-mcp.testTimeout`      | Seconds a test file may run (default 60).                                                                                                        |
| `craftos-mcp.workspace`        | The folder the computers see, relative to the workspace folder, such as `workspace` (see below).                                                 |
| `craftos-mcp.registerServer`   | `auto` (default), `always` or `never`: whether the extension gives VS Code its own MCP server.                                                   |
| `craftos-mcp.luaTypes`         | `ask` (default), `auto` or `off`: whether to add the CC:Tweaked Lua types to a CC workspace.                                                     |
| `craftos-mcp.command`          | Start craftos-mcp another way, such as `["node", "/path/to/craftos-mcp/apps/cli/dist/index.js"]`.                                                |

### Which folder the computers see

The emulator copies its workspace into every computer it starts, as a real computer has its own disk.

| What             | `craftos-mcp.workspace` empty | `craftos-mcp.workspace` set                  |
| ---------------- | ----------------------------- | -------------------------------------------- |
| The MCP server   | the first workspace folder    | that folder                                  |
| Run in CraftOS   | the program's own folder      | that folder, if the program is in it         |
| The Testing view | the test's workspace folder   | that folder; tests outside it are not listed |

So in a big repo (`node_modules`, thousands of files) set it to the folder your Lua lives in. When the extension
spots a repo like that with a `workspace/`, `lua/`, `src/` or similar folder full of Lua, it offers to set it, once.
It never sets it on its own.

### registerServer

`auto` leaves the extension's server out when the workspace's `.vscode/mcp.json` already has a server with
`craftos` in its name, command or arguments, so the agent doesn't get two sets of the same tools. `always` registers
it anyway, `never` never does (Run in CraftOS and the tests still work).

### Lua types

The types are copied into the extension's own storage folder (so an update doesn't break the path) and **Set Up
Lua Types** writes this into the workspace's `.vscode/settings.json`:

- that folder's `library` is appended to `Lua.workspace.library`. Whatever you had there stays;
- `Lua.runtime.version` becomes `Lua 5.2`, but only if the workspace doesn't set it already;
- `Lua.runtime.builtin` gets `os`, `io`, `ffi` and `jit` switched off (CraftOS has its own `os` and `io`), again
  only for the keys you haven't set.

Once, it also adds the storage folder to your user-level `Lua.workspace.userThirdParty`. That on its own changes
nothing: it lets the Lua extension notice CC code in other folders and offer the types there itself.

On `ask` the extension asks once per ComputerCraft workspace (a `startup.lua`, a `*.test.lua`, a `*.world.json`, a
`.craftos` folder or Lua that calls `peripheral`, `os.pullEvent` and the like). **Not Here** leaves that workspace
alone, **Never** sets `craftos-mcp.luaTypes` to `off`. On `auto` it doesn't ask. **craftos-mcp: Remove Lua Types**
takes the library and the `userThirdParty` entry out again and leaves the runtime settings.

The settings file then has an absolute path from your machine in it. If you commit `.vscode/settings.json` and mind
that, pick **Not Here** and use a `.luarc.json` pointing at your own copy of the types instead.

## Commands

Run in CraftOS, New Test for This File, New World for This File, Set Up Lua Types, Remove Lua Types, Restart MCP
Server, Show Log, Add to Claude Code,
Add to Cursor / Windsurf MCP Config, Copy MCP Server JSON, Refresh Tests, Settings and Get Started, all under
`craftos-mcp:` in the Command Palette, or from the status bar item.

## Troubleshooting

- **The first run failed.** The status bar says "setup failed" and **Show Log** has the reason. Usually it's the
  network: the setup fetches the engine from GitHub and the CC:Tweaked jar. Behind a proxy, set `HTTPS_PROXY` for
  VS Code. Then run `npx craftos-mcp setup` in a terminal to see it work, or just restart VS Code.
- **Tools time out or the server is slow to answer.** The workspace is probably huge. Set `craftos-mcp.workspace`.
- **The agent's craftos tools are gone after a crash.** The server restarts by itself and keeps its tools. If it
  stopped for good (3 crashes in 2 minutes, the status bar says "stopped"), click **Restart** on the notification,
  run **craftos-mcp: Restart MCP Server**, or use **MCP: List Servers** > craftos-mcp > Restart. A chat that was open
  while the server was down may need a new chat to see the tools again.
- **Two sets of craftos tools.** Your `.vscode/mcp.json` has its own craftos server. Leave
  `craftos-mcp.registerServer` on `auto` (it skips its own then), or remove one.
- **Claude Code on Windows says the server failed.** Its entry needs `cmd /c npx -y craftos-mcp serve`. **Add to
  Claude Code** writes it that way; an entry added by hand may not have it.
- **Cursor or Windsurf don't show the tools.** Run **craftos-mcp: Add to Cursor / Windsurf MCP Config**, then turn
  the server on in the editor's MCP settings.
- **Still "Undefined global `fs`".** The types need the Lua extension by sumneko. Run **craftos-mcp: Set Up Lua
  Types**; it offers to install it if it's missing. A `.luarc.json` in the folder wins over `settings.json`, so if
  you have one, add the library there.
- **macOS won't start the engine.** It is not signed or notarized. The extension downloads it itself, which leaves no
  quarantine mark; an engine zip you downloaded with a browser needs `xattr -dr com.apple.quarantine engine/build`
  once.

## Known limits

- `shell.run("lib/thing.lua")` in a test is relative to the computer's folder (see above), not to the test file.
- Run in CraftOS uses the emulator's app on 127.0.0.1 inside a webview. In a remote window (SSH, WSL, containers) it
  needs the emulator on the remote side, which means a Linux x64 or macOS remote.
- Only the mods listed in the [main README](https://github.com/Akkiruk/craftos-mcp#choose-your-mods) are simulated.

## License

MIT. CC:Tweaked is by SquidDev and contributors (<https://tweaked.cc>); craftos-mcp does not include it and builds its
ROM on your machine from the official jar. Not affiliated with Mojang or Microsoft.
