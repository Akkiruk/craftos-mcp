## Working on craftos-mcp itself

This section is for changes to the craftos-mcp repository (github.com/Akkiruk/craftos-mcp), not for Lua projects that
use it.

```sh
npm ci
npm run build                               # TypeScript: tsc -b
node scripts/build-rom.mjs --download       # rom/cc-1.121.0 from the real CC:Tweaked jar
node scripts/build-rom.mjs --download 1.18.2  # rom/cc-1.101.3, for Minecraft 1.18.2
npx vitest run                              # the tests; they need the engine and a ROM
npx prettier --check .                      # formatting, as CI checks it
```

`npm run setup` does all of it in one go and also downloads the prebuilt engine for your OS from the latest release
(or build it: `engine/build.cmd` on Windows, `engine/build.sh` elsewhere). CI only builds and checks formatting, so
run the tests locally before a pull request; CONTRIBUTING.md says what a change that executes Lua must come with.

- Engine fork: `engine/` (CMake). Client and protocol: `packages/rawterm`. Orchestration: `packages/runner`. MCP
  tools: `apps/mcp-server`. Command line: `apps/cli`. VS Code extension: `apps/vscode` (its own package and lockfile:
  `npm ci`, `npm run typecheck`, `npm run test:unit` inside it).
- The simulation (peripherals, modems, turtles, addons): `rom-overlay/rom/ccsim`. After changing it, copy it into
  each ROM (`cp -r rom-overlay/. rom/cc-1.121.0/`, and `rom/cc-1.101.3/` for 1.18.2) or rebuild the ROMs.
- AGENTS.md, GEMINI.md, `.github/copilot-instructions.md`, `.cursor/rules/craftos-mcp.mdc` and the `cc-tweaked-dev`
  skills are generated from `scripts/agent-docs/`: edit those, then run `node scripts/build-agent-docs.mjs`
  (`--check` says whether any file is stale).
