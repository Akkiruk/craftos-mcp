---
name: cc-tweaked-dev
description: Design, run and test ComputerCraft (CC:Tweaked 1.121.0 and 1.101.3) Lua programs, including monitors, touch input, modems, peripherals and turtles, in the local headless emulator through the craftos_* MCP tools. Use when writing or debugging computer/monitor/turtle scripts, verifying UI layouts, or adding regression tests for them.
---

# CC:Tweaked development loop

The `craftos-mcp` MCP server runs a forked CraftOS-PC engine (no Minecraft, no GUI) with the real CC:Tweaked ROM:
Minecraft **1.21.1** (CC:Tweaked 1.121.0) by default, or 1.20.1 / 1.18.2 per world (`world.version`). Call
`craftos_info` first; it lists anything missing, the versions and the addons that are on. `craftos_help` gives the full world schema, the ccunit API and the
saved worlds on request.

## Workflow

1. `craftos_write_file` the program (workspace-relative; the workspace is copied to the **root** of
   every emulated computer, so `dofile("surface")` and `require("lib.x")` behave like a real deployment).
2. `craftos_run` it. Pass `monitors: [{name:"top", blocksWide:3, blocksHigh:2}]` to attach monitors the
   way a monitor wall is built (1x1 block = 7x5 chars, 2x2 = 18x12, 3x2 = 29x12 at text scale 1).
   `setTextScale` resizes the grid like CC (5x6 blocks at 0.5 = 100x81; monitors are capped at 8x6 blocks);
   `textScale` in the spec sets it up front. Set `screenshots: true` to see PNGs of every screen. Programs that
   never exit end as `timed_out`; their screens are still captured, which is the normal way to check an idle screen.
3. For interaction use `craftos_session_create`, then `craftos_type`, `craftos_key`,
   `craftos_touch_monitor`, `craftos_wait_for_text`, `craftos_screenshot`, finally
   `craftos_session_destroy`. A viewer is served at http://127.0.0.1:7878 (click monitors, type).
   **Prefer data over pictures.** `craftos_ui` returns every screen as rectangles (buttons, cards,
   panels: colour, size, and the 1-based `cx,cy` cell to touch) plus text runs with colours for text-mode
   screens and a change `hash`, and reports what the program is blocked on (`waiting.blocked/filter`).
   `craftos_act` sends one touch, key or text, waits until the program actually consumed it
   (`consumed:false` means it was not listening) and until the screen stops changing, so no sleeps or
   polling. `craftos_settle` waits for quiet without acting. This works for any script, with no changes
   to it. Use `craftos_screenshot` only when you need to see how something looks. Text drawn with a
   pixel font cannot be read as characters: identify such buttons by colour and position.
   **Cheapest loop (fewest tokens), in this order:**
   - `craftos_labels` once per program: read a button's colour from one `craftos_ui` (or one screenshot), name it
     (`{DOUBLE:{color:"#f15c5c"}}`), `save` it, `load` it next time. Names then show inline in `craftos_ui`.
   - `craftos_script` runs a whole scenario in one call (`touch {name}`, `key`, `text`, `expect`, `sim`,
     `advance`, `seed`, `settle`); it stops at the first failure and returns only that step's reason, the
     nearest things that do exist, and `evidence` file paths (PNGs and a JSON dump) to open only if needed.
   - `craftos_expect` is one assertion batch (rect by colour/name, text, what it is `waiting` on, a sim value by
     path, `changed`).
   - `craftos_ui {delta:true}` after an action returns only what changed; `craftos_sim_state {delta:true}`
     likewise.
   - `craftos_trace` says what the program was handed and printed, plus errors, since the last call: use it
     when something is off instead of screenshots.
   - Determinism: `world.seed` (or `craftos_seed`) pins `math.random` and neutralises the program's own
     `math.randomseed`; `craftos_advance {seconds}` jumps the virtual clock and fires due timers, so
     timeouts and countdowns pass instantly. Only timers due inside the jump fire early.
4. Lock behaviour in with tests: put `*.test.lua` files in the workspace and call `craftos_test`.
   Inside, use the global `ccunit`: `test(name, fn [, {timeout}])`, `eq`, `neq`, `near`, `contains`, `truthy`,
   `raises`, `skip`, and `run(program, {seconds | script, args})` with `screen(monitor?)` and `touch(monitor, x, y)`
   to run a program and read its screens. A hanging file keeps its finished tests and names the one it was in. A
   failed `craftos_run` comes back with `error {kind, message, file, line}`. For screen layout use
   `craftos_run` with `snapshot: {name}` (golden files in `__snapshots__/`; `update:true` to accept).

## Facts that bite

- Every Advanced Peripherals and inventory method (except getName, getConfiguration, scanCost and the integrator's
  setters) waits a server tick and throws away every event that arrives meanwhile, timers and touches included. A
  loop that re-arms one timer dies the first time it is lost. Make those calls in their own coroutine with parallel.
- The event queue holds 256 events; more are dropped silently.
- A speaker never refuses playSound; playNote is capped at 8 per tick.
- Wireless modems reach 64 blocks low down, up to 384 at the top of the world, and the larger of the two modems'
  ranges counts. Ender modems reach everything in every dimension. Wired names (`computer_N`, `speaker_N`) come from
  a counter, never the computer id.
- rednet numbers messages with `math.random` and drops repeats, so computers on one network need different seeds.
  `createNetwork` refuses a shared one.
- Several computers talking: `craftos_network_create` (or `SessionManager.createNetwork`), one session each, with
  real rednet.
- The Lua VM follows the CC:Tweaked version the world runs (`world.version`, `--mc`, `CRAFTOS_VERSION`), matched
  against the real Cobalt jars. Minecraft 1.18.2 (CC:Tweaked 1.101.3, Cobalt 0.6): Lua 5.1 semantics,
  no `goto`/`::labels::` (5.1 syntax errors), `_VERSION` is `Lua 5.1`, no 5.2 library extras. Minecraft 1.20.1 and
  1.21.1 (CC:Tweaked 1.121.0, Cobalt 0.9.9, the default): Lua 5.2, with `goto`, `_VERSION` `Lua 5.2`, hex floats, `__name`, 5.2
  error positions. Pick the version your server runs.
- Mods on 1.20.1 and 1.21.1: a mod that also came out for 1.18.2 still behaves as its 1.18.2 version there (the
  versions named below), mods only out for newer Minecraft follow their own version, and
  a mod with no release for the version (Bigger Reactors on 1.21.1) is refused with the versions it does have. Use
  `world.version: "1.18.2"` for the most complete simulation.
- Key codes are GLFW (`keys.enter` = 257), not the old LWJGL values.
- Emulator only, not CC:Tweaked: in the headless runner `os.shutdown(code)` ends the run with that exit status (`0`
  completed, `1` program error, like `shell.run` returning false). Real CC:Tweaked's `os.shutdown()` takes no argument
  and ignores one, so never rely on it in code meant for a server.
- Engine peripherals are vanilla only (monitor, drive, printer). Pass a `world` to `craftos_run` / `craftos_test` /
  `craftos_session_create` for everything else: virtual inventories (chests, barrels) with pushItems/pullItems,
  every Advanced Peripherals 0.7.31r block (player, energy and environment detectors, chat box, redstone
  integrator, NBT storage, AR controller, ME and RS bridges) from fixtures (see `docs/advanced-peripherals.md` and
  `worlds/advanced-peripherals-demo.json`), and Mekanism 10.2.5 QIO blocks and the Quantum Entangloporter (see
  `docs/mekanism-qio.md` and `worlds/mekanism-qio-demo.json`). During a session `craftos_sim_command` changes the
  world (players join, chat, items appear, the clock jumps) and `craftos_sim_state` reads it, including the computer's own redstone (`redstone.outputs.<side>`, inputs, bundled), so check a door opened there, not by printing. `craftos_session_create` returns `front: "shell" | "program"`: a startup.lua program that never returns leaves no prompt.
- Other mods are addons (38 of them; `craftos_info` lists which are on). Use only the ones the user's pack has
  (`world.addons`, `CRAFTOS_ADDONS`, `--addons`): a peripheral of an addon that is off fails the world at boot. Create, Mekanism reactors and machines, Tom's Peripherals (GPU
  screens appear in screenshots), Bigger and Extreme Reactors each have a doc in `docs/` and a demo in `worlds/`.
  CC's own `energy_storage` and `fluid_storage` work on any block (`docs/generic-storage.md`).
- Turtles: give the world a `turtle` entry and blocks (`blocks`, `fills`, `ground`); the full turtle API runs in that
  block world with real drops, recipes and tick timing (`docs/turtle.md`). Computers a turtle places boot when
  turned on (floppies, drives, monitor walls and modem blocks work); `craftos_run` returns them under `computers`.
- Saved worlds live in `worlds/` (`worldFile: "advanced-peripherals-demo"`). A world's `deploy` list assembles the
  computer from workspace folders like an installer would, and `kind: "pocket"` gives a 26x20 terminal.
- Chests that scripts index beyond 27 slots need `size: 54`; out-of-range slots raise errors like real CC.
- Pass `timeScale` (e.g. 20) to `craftos_run`, `craftos_test` or `craftos_session_create` to run the virtual clock
  faster: `sleep(20)` then takes about one real second, and `os.clock()`/`os.epoch()` report the virtual time.
  `timeoutMs` stays in real time. Code that never yields is aborted after 7 s like CC.
- The terminal is 51x19; output that scrolls off is not in the captured text. Log to a file or print less when
  verifying.

## Where things live

- Engine fork: `engine/` (CMake; `engine/build.cmd` or `engine/build.sh`). ROM: `node scripts/build-rom.mjs --download`.
- Client/protocol: `packages/rawterm`. Orchestration: `packages/runner`. Tools: `apps/mcp-server`.
- The simulation (peripherals, modems, turtles): `rom-overlay/rom/ccsim`. After changing it, copy it into
  each ROM (`cp -r rom-overlay/. rom/cc-1.121.0/`, and `rom/cc-1.101.3/` for 1.18.2) or rebuild the ROMs.
