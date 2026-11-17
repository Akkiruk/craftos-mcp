// A tiny stdio MCP server for supervise.test.mjs: answers initialize and tools/list, dies on the "die" tool, never
// answers "hang". FAKE_ETARGET=1 makes it fail the way npx does for a version that is not on npm.
if (process.env.FAKE_ETARGET && !process.argv.includes("fallback")) {
  process.stderr.write(
    "npm error code ETARGET\nnpm error notarget No matching version found for craftos-mcp@9.9.9.\n",
  );
  process.exit(1);
}
let initialized = 0;
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const answer = (result) =>
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`,
      );
    if (msg.method === "initialize")
      answer({ serverInfo: { name: "fake", version: "0" }, pid: process.pid });
    else if (msg.method === "notifications/initialized") initialized++;
    else if (msg.method === "tools/list")
      answer({
        tools: [{ name: "craftos_info" }],
        pid: process.pid,
        initialized,
      });
    else if (msg.method === "tools/call" && msg.params.name === "die")
      process.exit(3);
    else if (msg.method === "tools/call" && msg.params.name === "hang") {
      // never answers
    }
  }
});
process.stdin.on("end", () => process.exit(0));
