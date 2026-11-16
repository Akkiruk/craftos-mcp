# ADR 0001: Start with CraftOS-PC as a subprocess

- Status: accepted
- Date: 2026-10-29

## Context

The project needs broad CC:Tweaked behavior without recreating an emulator.
CraftOS-PC offers headless execution and host mounts. Native embedding gives
more control but couples the MCP server to a large C++ dependency graph and
often requires a maintained engine fork.

## Decision

Use a pinned upstream CraftOS-PC executable through an `EmulatorAdapter`.
Create a new process and runtime directory for each non-interactive run.
Exchange versioned request/result files through a private harness mount.

Do not make raw stdout, CraftOS-PC command flags, or filesystem layout part of
the public MCP contract.

## Consequences

- Engine upgrades and installation remain independent from the Node server.
- Process isolation and cleanup are easier to reason about.
- Interactive event injection may need raw WebSocket mode or a small upstream
  extension later.
- Process startup cost is accepted for early correctness and safety.
- Native embedding requires a replacement ADR with measured benefits.
