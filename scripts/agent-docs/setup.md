## Setting up the MCP server

The server is `npx -y craftos-mcp serve`, over stdio, and needs Node.js 22 or newer. Its first start downloads the
engine and builds the CC:Tweaked ROM, once (about a minute); the server answers straight away and the tools that run
computers wait for it. The computers' files are the folder the server starts in (`CRAFTOS_WORKSPACE` sets another).
`CRAFTOS_VERSION` (`1.21.1`, `1.20.1` or `1.18.2`) and `CRAFTOS_ADDONS` go in the server's `env`, or in a
`craftos.json` at the project root. On Windows, if a client cannot start `npx`, give it `cmd` with the arguments
`/c npx -y craftos-mcp serve`.

Codex, in `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project), or
`codex mcp add craftos -- npx -y craftos-mcp serve`:

```toml
[mcp_servers.craftos]
command = "npx"
args = ["-y", "craftos-mcp", "serve"]
# a test run can take longer than the default 60 seconds per call
tool_timeout_sec = 300
```

VS Code with Copilot: the extension (below) registers the server by itself. Without it, `.vscode/mcp.json`:

```json
{
  "servers": {
    "craftos": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "craftos-mcp", "serve"]
    }
  }
}
```

Copilot's own config files (`.mcp.json` at the workspace root, `~/.copilot/mcp-config.json`) take the same entry
under `mcpServers` instead of `servers`.

Cursor, in `.cursor/mcp.json` (or `~/.cursor/mcp.json` for every project); the same `mcpServers` entry goes in
Windsurf's `~/.codeium/windsurf/mcp_config.json` and Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "craftos": { "command": "npx", "args": ["-y", "craftos-mcp", "serve"] }
  }
}
```

Gemini CLI, in `.gemini/settings.json` (or `~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "craftos": { "command": "npx", "args": ["-y", "craftos-mcp", "serve"] }
  }
}
```

Claude Code: `claude mcp add craftos -- npx -y craftos-mcp serve` (on native Windows,
`claude mcp add craftos -- cmd /c npx -y craftos-mcp serve`), or the plugin, which brings this guide as the
`cc-tweaked-dev` skill: `/plugin marketplace add Akkiruk/craftos-mcp`, then `/plugin install craftos-mcp@craftos-mcp`.

`CRAFTOS_TOOLS=core` offers a lean set of 17 tools instead of all 32, for clients that pay for every tool in every
request.
