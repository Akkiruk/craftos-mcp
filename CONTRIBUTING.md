# Contributing

Start with [the architecture](docs/architecture.md),
[security model](docs/security.md), and [roadmap](docs/roadmap.md).

## Development

```powershell
npm install
npm run check
```

Use conventional, focused changes. A feature that executes Lua must include:

- a fixture demonstrating expected CC:Tweaked behavior,
- tests for invalid input, timeout, and cleanup,
- path/process handling that is safe on Windows, Linux and macOS,
- documentation for any known emulator difference.

Do not commit CraftOS-PC binaries, ROM sources, runtime computer directories,
or generated test output. Engine acquisition must verify a pinned version and
checksum.

## Decision records

Add an ADR under `docs/adr/` before changing the engine, embedding it natively,
adding a network transport, or weakening an isolation boundary.
