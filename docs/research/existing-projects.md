# Existing project research

Reviewed on 2026-10-29. Repository metadata and claims can change; re-verify
before dependency or redistribution decisions.

## Findings

| Project                                                             | What it provides                                                                            | Fit and gaps                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [CraftOS-PC 2](https://github.com/MCJack123/craftos2)               | MIT-licensed native ComputerCraft emulator; headless, raw, CLI, scripting, mounts, debugger | Best primary engine. Latest release found was v2.8.3. No MCP server; native dependency stack is substantial.                        |
| [CCEmuX](https://github.com/CCEmuX/CCEmuX)                          | MIT-licensed Java emulator using the CC:Tweaked/Cobalt ecosystem                            | Valuable future fidelity oracle. Less documented for headless CI and no MCP integration.                                            |
| [CC:Tweaked](https://github.com/cc-tweaked/CC-Tweaked) test harness | Upstream Cobalt-based Java tests and Lua fixtures                                           | Excellent reference for conformance fixtures, but not packaged as a standalone external emulator.                                   |
| [craftos-mcp](https://github.com/r33drichards/craftos-mcp)          | Rust MCP proof of concept embedding a CraftOS-PC fork                                       | Demonstrates feasibility but exposes a single GPS self-test, depends on a fork, and is not a general local coding/test environment. |

No mature browser-native emulator or other general-purpose ComputerCraft MCP
server was found.

## Conclusion

There is no existing high-quality project that meets the complete target:
general local file authoring, arbitrary program execution, structured tests,
terminal/event control, peripheral and multi-computer fixtures, isolation, and
a broad MCP interface.

The high-quality emulator part already exists. Reimplementing it would add
years of fidelity work. This project should integrate CraftOS-PC behind a thin
adapter, learn from `craftos-mcp`, and use upstream CC:Tweaked fixtures and a
secondary engine for compatibility checks.

## Licensing notes

- CraftOS-PC is MIT. Its license identifies some bundled sounds as CC BY 3.0
  or public domain.
- CC:Tweaked is MPL-2.0. Confirm the exact provenance and license of every ROM
  file before redistribution; do not assume the wrapper's MIT license applies.
- Do not vendor binaries, ROM sources, or audio into this repository until
  notices and redistribution obligations are documented.
