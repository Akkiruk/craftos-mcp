# Architecture

## Goals

1. Let an MCP client create, execute, inspect, and test CC:Tweaked programs.
2. Match CC:Tweaked behavior closely enough that tests predict in-game results.
3. Make failures actionable: terminal state, structured errors, logs, and
   reproducible fixture directories.
4. Support Windows and Linux local development.
5. Avoid trusting the emulator's internal sandbox as the only host boundary.

## Non-goals for the first release

- Reimplementing Lua, CraftOS, or the CC:Tweaked API.
- Full Minecraft world/block simulation.
- Public multi-tenant hosting.
- A graphical IDE or browser emulator.
- Native embedding of CraftOS-PC.

## Components

```text
MCP client
    |
    | stdio (initially)
    v
MCP server
    |-- tool validation and error mapping
    |-- workspace service (safe authored-file access)
    |-- session manager (limits, lifecycle, cleanup)
    v
EmulatorAdapter
    |
    | child process + private control/result files
    v
CraftOS-PC --raw (forked, engine/)
    |-- boot harness
    |-- mounted read-only fixture input
    |-- isolated writable computer/runtime data
    `-- structured result and terminal snapshots
```

The MCP server must not expose a generic shell tool. Authored paths are
workspace-relative and resolved through a single containment helper.

## Planned MCP surface

| Tool                      | Purpose                                            | Milestone |
| ------------------------- | -------------------------------------------------- | --------- |
| `craftos_workspace_info`  | Discover server and engine status                  | scaffold  |
| `craftos_write_file`      | Write a workspace-relative Lua/text file           | 1         |
| `craftos_read_file`       | Read a workspace-relative file                     | 1         |
| `craftos_run`             | Run a program with arguments and bounded resources | 1         |
| `craftos_test`            | Run one or more structured Lua fixtures            | 2         |
| `craftos_session_create`  | Start a persistent isolated computer               | 3         |
| `craftos_send_event`      | Inject key, char, mouse, timer, or modem events    | 3         |
| `craftos_read_terminal`   | Return text, colors, cursor, and dimensions        | 3         |
| `craftos_session_destroy` | Stop and clean a session                           | 3         |
| `craftos_network_create`  | Create isolated multi-computer topology            | 4         |

Resources may later expose read-only API documentation, terminal snapshots,
and test reports. Prompts are out of scope until the tool contracts stabilize.

## Execution model

Start with one fresh CraftOS-PC process for each `run` or test suite. A boot
harness loads a request file, invokes the target program with `shell.run`, and
writes a versioned JSON result before calling `os.shutdown(exitCode)`.

Persistent interactive sessions come later because they require a framed
control channel, backpressure, crash recovery, and deterministic ownership.
Raw WebSocket mode is a candidate transport but must not leak its wire format
into the adapter interface.

## Compatibility strategy

- Pin engine and ROM versions together.
- Build a fixture corpus for filesystem, shell, terminal, HTTP policy,
  peripherals, rednet, and turtle behavior.
- Record the exact engine/version in every result.
- Later run the same corpus against CCEmuX or an upstream CC:Tweaked harness;
  classify intentional engine differences rather than hiding them.

See [ADR 0001](adr/0001-craftos-pc-subprocess.md) and
[ADR 0002](adr/0002-raw-mode-and-engine-fork.md), which supersedes its headless-only parts.
