# Architecture

## Goals

1. Let an MCP client create, execute, inspect, and test CC:Tweaked programs.
2. Match CC:Tweaked behavior closely enough that tests predict in-game results.
3. Make failures actionable: terminal state, structured errors, logs, and
   reproducible fixture directories.
4. Run on Windows x64, Linux x64 and macOS 11+ (arm64 and x64).
5. Avoid trusting the emulator's internal sandbox as the only host boundary.

## Non-goals

- Reimplementing Lua, CraftOS, or the CC:Tweaked API.
- Full Minecraft world/block simulation: the world file states what the
  computers see (blocks, peripherals, mod machines).
- Public multi-tenant hosting.

## Components

```text
MCP client          VS Code extension (apps/vscode)
    |                     | starts the CLI and the MCP server
    | stdio               v
    v              CLI (apps/cli)
MCP server (apps/mcp-server)    |
    |                           |
    v                           v
runner (packages/runner)
    |-- validation and error mapping
    |-- workspace service (safe authored-file access)
    |-- session manager (limits, lifecycle, cleanup)
    |-- world files, addons, Minecraft version selection
    v
rawterm (packages/rawterm)
    |
    | child process, raw-mode framed packets, private control/result files
    v
CraftOS-PC --raw (forked, engine/)
    |-- pinned CC:Tweaked ROM plus rom-overlay/ (ccsim: peripherals, modems, turtles, mods)
    |-- mounted read-only fixture input
    |-- isolated writable computer/runtime data
    `-- structured result and terminal snapshots
```

The MCP server must not expose a generic shell tool. Authored paths are
workspace-relative and resolved through a single containment helper. A local
web viewer (port 7878, `CRAFTOS_VIEWER_PORT=off` turns it off) shows the
sessions and the last run.

## MCP surface

32 tools, all named `craftos_*` (`apps/mcp-server/src/index.ts`).
`CRAFTOS_TOOLS=core` offers 17 of them. `craftos_info` reports the server,
the engine, the Minecraft versions and the addons; `craftos_help` explains the
rest.

| Group             | Tools                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Files             | `write_file`, `read_file`, `list_files`                                                        |
| One-shot runs     | `run`, `test`                                                                                  |
| Sessions          | `session_create`, `session_list`, `session_destroy`, `network_create`, `network_update`        |
| Input             | `type`, `key`, `touch_monitor`, `send_event`, `act`, `script`                                  |
| Reading the state | `ui`, `read_terminal`, `screenshot`, `wait_for_text`, `expect`, `labels`, `trace`, `sim_state` |
| World and clock   | `sim_command`, `seed`, `advance`, `settle`                                                     |
| Help              | `info`, `help`                                                                                 |

## Execution model

`run` and `test` start one fresh CraftOS-PC process each. A boot harness loads
a request file, invokes the target program with `shell.run`, and writes a
versioned JSON result before calling `os.shutdown(exitCode)`.

Sessions keep computers running between calls: one or more computers, their
monitors and peripherals, joined by modems or wired networks. Input goes in as
events and the terminal, monitors and simulated world come back as text,
structure or PNG.

### Shared engines (pool mode)

Every computer can instead run in an engine process it shares with others
(`CRAFTOS_POOL=<computers per engine>`, or `pool` in `startEngine`'s options).
The engine starts with `craftos --raw --pool` and no computer of its own; the
runner (rawterm's `EnginePool`) asks it for each computer with the settings
its own command line would have had: its folders, mounts, boot script, clock
file and speed. Every packet about a computer travels in an envelope naming
it, with window ids the computer's own (its terminal is window 0), so a
`RawSession` reads the same whether it has a process to itself or not. The
wire format is at `CCPC_RAW_POOL_ENVELOPE` in
`engine/src/terminal/RawTerminal.cpp`.

What a computer keeps: its files, its `os.shutdown` code, its screens and
monitors, and its own clock: pause, step, speed, max and jumps act on that
computer only (`simclock::Domain`, `engine/src/simclock.hpp`). What it shares:
the engine's flags that every computer of one engine has in common (ROM and
CC:Tweaked version, `config/global.json`, Cobalt speed); the runner keeps an
engine per combination. A crash of the engine takes all its computers down,
and the engine's stderr reaches them only then. Debugger and live-folder
computers always get an engine of their own.

Cost on Windows (an idle computer at the shell, measured in
`docs/research/emulator-footprint.md`): an engine of its own is about 10 MB of
private memory, 10 threads and 275 handles; in a shared engine a computer adds
about 4.3 MB, one thread and one handle.

## Compatibility strategy

- Pin engine and ROM versions together, one ROM per CC:Tweaked version
  (1.101.3 for Minecraft 1.18.2, 1.121.0 for 1.20.1 and 1.21.1).
- Run CC:Tweaked's own test suite against each (see
  [conformance](conformance/README.md)).
- Compare probe programs on real game computers with the emulator, value by
  value, and treat every difference as a bug.
- Record the exact engine/version in every result.

See [ADR 0001](adr/0001-craftos-pc-subprocess.md) and
[ADR 0002](adr/0002-raw-mode-and-engine-fork.md), which supersedes its headless-only parts.
