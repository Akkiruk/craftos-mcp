import type { Command } from "../command.js";

/** The MCP server over stdio, for agents: `claude mcp add craftos -- npx craftos-mcp serve`. */
const serve: Command = {
  name: "serve",
  summary: "run the MCP server over stdio (what AI agents connect to)",
  async run() {
    await import("@craftos-mcp/mcp-server");
    return new Promise<number>(() => {}); // the server runs until stdin closes
  },
};
export default serve;
