# Match your pack

The **CraftOS** item in the status bar shows the Minecraft version computers start on, and how many addons are on
once you switch some off. Click it to pick either; the choice is saved for this workspace, and the MCP server and any
open Run in CraftOS panel start again in it.

| Setting                        | What it does                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `craftos-mcp.minecraftVersion` | `1.18.2` (CC:Tweaked 1.101.3), `1.20.1` or `1.21.1` (CC:Tweaked 1.121.0).      |
| `craftos-mcp.addons`           | The mods your pack has: `all`, `none` or ids such as `create,mekanism`.        |
| `craftos-mcp.workspace`        | In a big repo, the folder the computers see, such as `workspace` or `src/lua`. |
| `craftos-mcp.registerServer`   | `auto`: only in ComputerCraft projects; `everywhere` for every workspace.      |
| `craftos-mcp.luaTypes`         | `ask`, `auto` or `off`: adding the CC:Tweaked Lua types to a CC workspace.     |

The emulator copies its workspace into every computer it starts, so in a repo with `node_modules` or thousands of
files set `craftos-mcp.workspace` to the folder your Lua is in. The extension offers this once when it spots one.
