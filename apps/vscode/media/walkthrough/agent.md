# Let your agent use it

- **VS Code (Copilot agent mode):** nothing to do. The extension registers the `craftos-mcp` server and its tools
  (`craftos_run`, `craftos_test`, `craftos_ui` and the rest). The status bar item shows what the server is doing.
- **Claude Code:** **Add to Claude Code** runs `claude mcp add` for you. On Windows it passes `cmd /c npx ...`, as
  Claude Code needs there.
- **Cursor and Windsurf:** they do not let extensions add MCP servers, so **Add to Cursor / Windsurf** writes a
  `craftos` entry into their config (`.cursor/mcp.json`, `~/.cursor/mcp.json` or
  `~/.codeium/windsurf/mcp_config.json`). It never overwrites an entry that is there already.
- **Anything else:** **Copy MCP Server JSON** and paste it into the client's config.
