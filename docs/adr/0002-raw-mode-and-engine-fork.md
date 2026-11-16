# ADR 0002: Raw renderer transport and a forked engine

- Status: accepted (supersedes the headless-only parts of ADR 0001)
- Date: 2026-10-29

## Context

Spike results against CraftOS-PC 2.8.3 and a source build (2.8.4):

- `--headless` cannot create monitors ("Monitors are not available in this
  mode"); `--raw` can, and exposes each monitor as its own window.
- Raw mode carries text, colours, cursor, palette, pixel graphics, input
  events, file operations, and speaker output over framed Base64 packets.
- The target modpack runs CC:Tweaked 1.101.3; upstream HEAD emulates 1.116.1.
- `--script` support lives in `rom/startup.lua`, a CraftOS-PC addition. The
  vanilla jar ROM lacks it, so a pinned ROM needs an overlay.

## Decision

- Drive the engine in `--raw` mode from `@craftos-mcp/rawterm`.
- Fork the engine as `craftos-engine` (sibling repo, upstream remote kept) and
  build it with CMake + vcpkg. Strip GUI/platform code over time.
- Build the pinned ROM with `scripts/build-rom.mjs` from the modpack's
  CC:Tweaked jar plus `rom-overlay/`.

## Consequences

- Monitors, touch events and PNG screenshots work without Minecraft or a GUI.
- Engine version strings and native API behaviour still report 1.116.1 and
  must be gated down to 1.101.3 in the fork.
- `os.shutdown(code)` only propagates the exit code in `--script` mode.
