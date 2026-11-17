# CIDE 1.1.0 emulation

Addon id `cide`. Lua in `rom-overlay/rom/ccsim/addons/cide/init.lua`; the jar's ROM files in `rom/` next to it.

Source of truth: `cide-1.1.0.jar` from [Modrinth](https://modrinth.com/mod/cide-cc) (NeoForge, Minecraft 1.21.1,
CC:Tweaked 1.114+), decompiled with Vineflower 1.10.1 (no source is published): `dev/kivts/cide/server/CideDebugAPI`
and `CideDebugService`, and `data/computercraft/lua/rom/cide/`.

## Versions

| Minecraft      | Mod release |
| -------------- | ----------- |
| 1.21.1         | 1.1.0       |
| 1.18.2, 1.20.1 | none        |

## What it adds

CIDE is an in-game code editor: a client GUI with a file tree, a console and a debugger, and server services that
answer that GUI. A computer sees two things of it, both emulated:

- `rom/cide/run.lua` and `rom/cide/agent.lua`, unchanged: the editor runs a program as `/rom/cide/run.lua <program>`,
  which loads the agent (a line hook that pauses at breakpoints) around `shell.run`.
- a global API on every computer, `cide_dbg` (`CideDebugAPI`): `isActive()`, `getBreakpoints()`, `paused(file,
line, locals)`, `finished()`. They talk to `CideDebugService`, which has a session only while a player debugs the
  computer from the editor. Here there is never one: `isActive()` is false, `getBreakpoints()` is `{}`, and
  `paused`/`finished` check their arguments and do nothing. With no session the agent's hook returns at once, so a
  program under `run.lua` runs straight through, as it does in game when nobody is debugging it.

## Fixtures and sim commands

None.

## Not emulated

The editor itself and its debug sessions (breakpoints, pausing, stepping): they need a player at the GUI.
