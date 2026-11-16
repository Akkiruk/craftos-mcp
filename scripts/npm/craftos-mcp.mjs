#!/usr/bin/env node
// The `craftos-mcp` command of the npm package (scripts/pack-npm.mjs makes this its bin).
//
// It sets up the engine and ROMs on first run (first-run.mjs), then hands over to the command line (apps/cli).
//   craftos-mcp setup [--force]   set up again, or just check
//   craftos-mcp serve             the MCP server over stdio. On a first run it answers the client at once and sets up
//                                 in the background; tools that need the engine wait for that (about a minute).
//   anything else                 sets up first (progress on stderr), then runs
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = pathToFileURL(join(ROOT, "apps", "cli", "dist", "index.js")).href;

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(
    `craftos-mcp needs Node.js 22 or newer (this is ${process.version}).`,
  );
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  const { packageVersion } = await import(
    "../../packages/runner/dist/config.js"
  );
  console.log(packageVersion() ?? "clone");
} else if (!command || ["help", "--help", "-h"].includes(command)) {
  await import(CLI);
  if (!rest.length)
    console.log(
      "  setup   (re)do the first-run setup: engine and ROMs, in CRAFTOS_HOME",
    );
} else if (command === "setup") {
  const { setUp } = await import("./first-run.mjs");
  process.exitCode = (await setUp({ force: rest.includes("--force") })).ok
    ? 0
    : 1;
} else if (command === "serve") {
  await serve();
} else {
  const { isSetUp, setUp } = await import("./first-run.mjs");
  if (!isSetUp()) {
    const result = await setUp();
    if (!result.ok)
      console.error(
        "craftos-mcp: carrying on; craftos-mcp info shows what is missing",
      );
  }
  await import(CLI);
}

async function serve() {
  // stdout is the MCP channel: anything printed with console.log goes to stderr instead
  console.log = console.info = console.debug = console.error;
  const { isSetUp, setUp } = await import("./first-run.mjs");
  if (!isSetUp()) {
    const setup = setUp();
    let done = false;
    let failed;
    void setup.then((r) => {
      done = true;
      failed = r.ok ? undefined : r.error;
    });
    // Tools that need no engine answer at once; the rest wait for the setup. Hooked on the SDK the server itself
    // imports (the same module instance), before the server registers its tools.
    const NO_WAIT = new Set([
      "craftos_info",
      "craftos_write_file",
      "craftos_read_file",
      "craftos_list_files",
      "craftos_session_list",
    ]);
    const { McpServer } = await import(
      "@modelcontextprotocol/sdk/server/mcp.js"
    );
    const register = McpServer.prototype.registerTool;
    McpServer.prototype.registerTool = function (name, config, handler) {
      if (typeof handler !== "function")
        return register.call(this, name, config, handler);
      const note = () => ({
        type: "text",
        text: done
          ? `first-run setup failed: ${failed}; run  npx craftos-mcp setup  in a terminal to see why`
          : "first-run setup is still downloading the engine and building the ROM (about a minute); tools that run computers wait for it",
      });
      const wrapped =
        name === "craftos_info"
          ? async (...args) => {
              const result = await handler(...args);
              if (done && !failed) return result;
              return {
                ...result,
                content: [...(result.content ?? []), note()],
              };
            }
          : NO_WAIT.has(name)
            ? handler
            : async (...args) => {
                await setup;
                if (failed) return { isError: true, content: [note()] };
                return handler(...args);
              };
      return register.call(this, name, config, wrapped);
    };
  }
  await import(CLI);
}
