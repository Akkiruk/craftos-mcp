# craftos-mcp for VS Code

Run and test ComputerCraft (CC:Tweaked) Lua without Minecraft, right in VS Code, and give your AI agent the same
emulator as an MCP server so it can run, test and fix the code it writes.

[craftos-mcp](https://github.com/Akkiruk/craftos-mcp) is a CC:Tweaked emulator: real CC:Tweaked behaviour (it passes
1190 of 1191 of CC:Tweaked's own tests at 1.101.3), monitors with touch, several computers on rednet, turtles in a
block world, and peripherals from Create, Mekanism, Advanced Peripherals, Tom's Peripherals and more.

![A Mekanism reactor controller on a monitor in craftos-mcp: the temperature climbs until the program scrams the reactor](https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/docs/media/demo.gif)

## Features

- **An MCP server for VS Code's agents.** The extension registers `craftos-mcp` with VS Code, so agent mode in Chat
  sees its tools (`craftos_run`, `craftos_test`, `craftos_ui`, `craftos_sim_command` and the rest) with nothing to
  configure. It runs in your first workspace folder.
- **Run in CraftOS.** Right-click a `.lua` file (in the editor or the explorer) and pick **Run in CraftOS**, or use
  the Run button in the editor title. The emulator's app opens beside your code: the terminal takes the keyboard,
  monitors update live and a click is a touch, and the world panel adds players, moves the clock, fills chests and
  sends any sim command. If `name.world.json` sits next to `name.lua`, the computer runs in that world, with its
  monitors. Closing the panel stops the computers and the emulator.
- **Tests in the Testing view.** Every `*.test.lua` file shows up with its `ccunit.test` cases. Run them from the
  Testing view or the gutter; a failure points at the line Lua named. `name.test.lua` runs in `name.world.json` when
  there is one.
- **Add to Claude Code.** The command **craftos-mcp: Add to Claude Code** runs
  `claude mcp add craftos -- npx -y craftos-mcp serve` for you, at the scope you pick.
- **Copy MCP Server JSON** for Claude Desktop, Cursor, Windsurf or any other MCP client.
- **Snippets**: `cctest` writes a test file that reads a monitor back, `ccunit.test`, `ccunit.eq`, `ccunit.truthy` and
  `ccunit.raises` write single checks, and `ccworld` in a JSON file writes a world with monitors, a player, a chest
  and a battery.

## Requirements

- **Windows or Linux (x64).** There is no macOS engine yet.
- **Node.js 22 or newer** on your PATH. The extension starts the emulator with `npx -y craftos-mcp@0.2.0`.

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

| Setting                        | What it does                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `craftos-mcp.addons`           | The mods your pack has (`CRAFTOS_ADDONS`): `all`, `none` or ids such as `create,mekanism`.        |
| `craftos-mcp.minecraftVersion` | `1.18.2` (CC:Tweaked 1.101.3, the default), `1.20.1` or `1.21.1` (CC:Tweaked 1.121.0).            |
| `craftos-mcp.testTimeout`      | Seconds a test file may run (default 60).                                                         |
| `craftos-mcp.command`          | Start craftos-mcp another way, such as `["node", "/path/to/craftos-mcp/apps/cli/dist/index.js"]`. |

## Known limits

- The computer's files are a workspace folder: the first one for the MCP server, the file's own for Run in CraftOS
  and the tests. So `shell.run("lib/thing.lua")` in a test is relative to the workspace folder, not to the test.
- Run in CraftOS uses the emulator's app on 127.0.0.1 inside a webview. In a remote window (SSH, WSL, containers) it
  needs the emulator on the remote side, which means a Linux x64 remote.
- Only the mods listed in the [main README](https://github.com/Akkiruk/craftos-mcp#choose-your-mods) are simulated.

## License

MIT. CC:Tweaked is by SquidDev and contributors (<https://tweaked.cc>); craftos-mcp does not include it and builds its
ROM on your machine from the official jar. Not affiliated with Mojang or Microsoft.
