# CraftOS Agent

A headless CC:Tweaked emulator built for testing. Write a ComputerCraft program, run it, touch its monitors, check
its screens and lock the behaviour in with tests, all without starting Minecraft. It speaks
[MCP](https://modelcontextprotocol.io), so an AI coding agent (Claude Code, VS Code, Cursor, ...) can do the whole
loop for you, and it works just as well from plain scripts and CI.

It targets **CC:Tweaked 1.101.3 for Minecraft 1.18.2**: the engine passes 1189 of 1191 of CC:Tweaked's own tests at
that version, and the ROM is built from the real CC:Tweaked jar.

## What it does

- **Run and test**: run a program in a fresh computer and get the terminal and every monitor back as text, PNGs or
  golden snapshots; run `*.test.lua` files with the built-in `ccunit` harness.
- **Interactive sessions**: type, press keys, touch monitors, send events, wait for text. `craftos_ui` reads every
  screen as buttons and text runs with colours, so an agent can drive a UI without screenshots.
- **Monitors** at any wall size and text scale, with real touch events.
- **Several computers at once**: wireless, ender and wired modems with real rednet, ranges and wired names.
- **Turtles** in a block world built from vanilla 1.18.2 data: the whole turtle API with its tick timing, digging
  with loot-table drops, placing, inventories, refuelling, upgrades and crafting. What a turtle places comes alive:
  computers boot, disk drives take floppies, monitors join into walls.
- **CC's generic peripherals**: chests, barrels and any modded block as an inventory, fluid tank and energy store,
  with `pushItems`, `pullItems`, `pushFluid` and levels that move over time.
- **Peripherals from other mods**, written from each mod's source and checked against its jar, each one an addon
  you switch on only if your pack has it (see [Choose your mods](#choose-your-mods)):
  - Advanced Peripherals 0.7.31r: player, energy and environment detectors, chat box, redstone integrator, NBT
    storage, AR controller, ME and RS bridges.
  - Mekanism 10.2.5: QIO, the Quantum Entangloporter, the boiler and induction matrix; with Mekanism Generators, the
    fission reactor, turbine and fusion reactor, running tick by tick (a reactor left alone melts down).
  - Create 0.5.1: train stations with schedules and trains on the clock, gauges, speed controllers, sequenced
    gearshifts and the display link; Create Crafts & Additions 1.0.0's motor, accumulator, relay and digital adapter.
  - Tom's Peripherals 1.2.1: the GPU with its full drawing API, pixel-exact and in screenshots, keyboard, redstone
    port and watchdog.
  - Bigger Reactors 0.6.0 and Extreme Reactors 2.0.71: reactors and turbines with their real heat, fuel and rotor
    physics.
- **Determinism**: seed `math.random`, run the clock faster, or jump it forward so timers fire instantly.
- **A live viewer** at <http://127.0.0.1:7878>: watch sessions, click monitors, type into terminals.

## Setup

You need Node.js 22 or newer.

### 1. The engine

Download the prebuilt engine for your OS from the
[latest release](../../releases/latest) and unzip it over the repository, or build it yourself:

- **Windows**: Visual Studio 2022 (or its Build Tools) with C++, CMake, Ninja and a [vcpkg](https://vcpkg.io)
  checkout in `VCPKG_ROOT`. Then `engine\build.cmd`.
- **Linux**: a C++17 compiler, CMake, Ninja and vcpkg in `VCPKG_ROOT`. Then `engine/build.sh`.

macOS is not supported yet.

### 2. The ROM

CC:Tweaked's license does not allow its ROM to be redistributed with this project, so you build it on your own
machine. This downloads CC:Tweaked 1.101.3 from Modrinth, checks its hash, and builds `rom/cc-1.101.3`:

```sh
node scripts/build-rom.mjs --download
```

If you already have the jar: `node scripts/build-rom.mjs path/to/cc-tweaked-1.18.2-1.101.3.jar rom/cc-1.101.3`.

The same step downloads Tom's Peripherals 1.18.2-1.2.1 (MIT) and builds the GPU's fonts from it, since they are not
shipped here either (`node scripts/build-toms-fonts.mjs` does it alone).

### 3. The tools

```sh
npm install
npm run build
```

### 4. Connect your agent

Claude Code:

```sh
claude mcp add craftos -- node /path/to/craftos-agent/apps/mcp-server/dist/index.js
```

VS Code: `.vscode/mcp.json` is already set up for this folder. Other MCP clients: run
`node apps/mcp-server/dist/index.js` over stdio. Then call `craftos_info`; it lists anything that is missing.

Point `CRAFTOS_WORKSPACE` at your own Lua project to work on it in place. Other settings: `CRAFTOS_ENGINE`,
`CRAFTOS_ROM`, `CRAFTOS_RUNTIME_ROOT`, `CRAFTOS_VIEWER_PORT` (`off` turns the viewer off).

## Choose your mods

Every mod besides CC:Tweaked is an addon. Switch on only the ones your pack has, so a program cannot come to rely on
a peripheral your server does not have. Set `CRAFTOS_ADDONS` for the MCP server (the `.vscode/mcp.json` here lists
them all: delete the ones you do not use), or give one world its own list with `addons`:

```json
{
  "addons": ["create", "mekanism"],
  "peripherals": [{ "name": "station_0", "type": "Create_Station" }]
}
```

| Id                     | Mod                                              |
| ---------------------- | ------------------------------------------------ |
| `advanced-peripherals` | Advanced Peripherals 0.7.31r                     |
| `mekanism`             | Mekanism 10.2.5                                  |
| `mekanism-generators`  | Mekanism Generators 10.2.5 (needs `mekanism`)    |
| `create`               | Create 0.5.1.i                                   |
| `create-additions`     | Create Crafts & Additions 1.0.0 (needs `create`) |
| `toms-peripherals`     | Tom's Peripherals 1.18.2-1.2.1                   |
| `bigger-reactors`      | Bigger Reactors 1.18.2-0.6.0-beta.1.4            |
| `extreme-reactors`     | Extreme Reactors 1.18.2-2.0.71                   |

`"all"` and `"none"` work too. With no setting at all, everything is on. A world that uses a block from an addon that
is off fails before the computer boots and names the addon; `craftos_info` lists what is on.

## Tools

| Tool                                                                                  | Purpose                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `craftos_info`                                                                        | Engine, ROM and workspace status                                                     |
| `craftos_write_file`, `craftos_read_file`, `craftos_list_files`                       | Workspace files (copied to the root of each computer)                                |
| `craftos_run`                                                                         | Run a program in a fresh computer: terminal and monitor text, PNGs, golden snapshots |
| `craftos_test`                                                                        | Run `*.test.lua` files with the `ccunit` harness                                     |
| `craftos_session_create`, `craftos_type`, `craftos_key`, `craftos_touch_monitor`, ... | Interactive computers                                                                |
| `craftos_ui`, `craftos_act`, `craftos_settle`, `craftos_expect`, `craftos_script`     | Read screens as data, act and wait until the program is done, assert                 |
| `craftos_network_create`, `craftos_network_update`                                    | Several computers with modems                                                        |
| `craftos_sim_command`, `craftos_sim_state`                                            | Change and read the simulated world during a session                                 |
| `craftos_seed`, `craftos_advance`, `craftos_trace`, `craftos_screenshot`              | Determinism, the virtual clock, what the program saw, pictures                       |

For an agent, `.claude/skills/cc-tweaked-dev/SKILL.md` is a short guide to using these well.

## Your own modpack

The turtle world ships with vanilla Minecraft, Forge and CC:Tweaked data. To give it every block, item, recipe and
loot table in your modpack, generate the data from your own instance:

```sh
python -I tools/turtledata/extract.py --instance "<your instance>/minecraft"
```

## Layout

```text
engine/        Forked CraftOS-PC 2 (MIT, see engine/UPSTREAM.md)
packages/      rawterm (engine protocol, PNG renderer), runner (runs, tests, sessions, networks), protocol
apps/          The MCP server and the web viewer
rom-overlay/   The simulation layered over the CC:Tweaked ROM (peripherals, modems, turtles)
scripts/       ROM builder and CC:Tweaked conformance runner
tools/         Data extraction for turtles
worlds/        Example worlds
docs/          Architecture, security model, peripherals, turtles, conformance
```

## Known limits

- One CC:Tweaked version: 1.101.3 (Minecraft 1.18.2). Newer versions changed APIs this emulator measures exactly.
- Only the mods listed above are simulated, and each from its source: where a mechanic is too large to copy (Create's
  stress network and track graph, multiblock formation) it is a fixture instead. Each mod's doc ends with what is not
  simulated or not confirmed. Advanced Peripherals' turtle and pocket upgrades are not simulated.
- A pattern that never finishes inside one C function (a pathological `string.find`) cannot be aborted by the
  engine; the runner's timeout ends the process instead.
- The virtual clock can run faster, but it is not a fully deterministic scheduler.
- Lua runs in a scratch directory per run, but the engine is not sandboxed by the OS. Only run code you trust; see
  [docs/security.md](docs/security.md).

## Credits

The engine is a fork of [CraftOS-PC 2](https://github.com/MCJack123/craftos2) by JackMacWindows (MIT).
[CC:Tweaked](https://github.com/cc-tweaked/CC-Tweaked) is by SquidDev and contributors; this project does not
include it. Not affiliated with Mojang or Microsoft.

## License

MIT, see [LICENSE](LICENSE). The engine keeps CraftOS-PC's MIT license ([engine/LICENSE](engine/LICENSE)). See
[NOTICE.md](NOTICE.md) for third-party parts.
