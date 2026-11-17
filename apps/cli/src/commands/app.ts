import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  SessionManager,
  checkConfig,
  loadConfig,
  resolveVersion,
  startWebApp,
  versionChoices,
} from "@craftos-mcp/runner";
import type { Command } from "../command.js";

/** Open a URL in the default browser, quietly: a machine without one just prints the link. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no browser to open
  }
}

/** The browser app: make computers, type into them, touch monitors and change the world, without an AI agent. */
const app: Command = {
  name: "app",
  summary: "open the emulator in your browser (no AI agent needed)",
  usage: [
    "  craftos-mcp app [--port 7878] [--dir <folder>] [--worlds <folder>] [--mc <version>] [--no-open]",
    "",
    "  --port     port on 127.0.0.1 (default 7878; 0 picks a free one)",
    `  --mc       the Minecraft version new computers start on (${versionChoices()}); the form can change it`,
    "  --dir      your Lua project: copied onto every computer you make (default the workspace folder)",
    "  --worlds   folder of saved worlds (<name>.json) the New computer form offers (default worlds/)",
    "  --no-open  do not open the browser, just print the address",
  ].join("\n"),
  async run(args) {
    let port = 7878;
    let open = true;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const value = (): string => {
        const v = args[++i];
        if (v === undefined) throw new Error(`${arg} needs a value`);
        return v;
      };
      try {
        if (arg === "--port") port = Number(value());
        else if (arg === "--dir") env["CRAFTOS_WORKSPACE"] = resolve(value());
        else if (arg === "--worlds") env["CRAFTOS_WORLDS"] = resolve(value());
        else if (arg === "--mc") {
          const mc = value();
          resolveVersion(mc); // refuses an unknown version
          // the default for every computer this app makes (world.version still wins)
          process.env["CRAFTOS_VERSION"] = mc;
        } else if (arg === "--no-open") open = false;
        else throw new Error(`unknown option ${arg}`);
      } catch (error) {
        console.error((error as Error).message);
        return 2;
      }
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error("--port must be a number from 0 to 65535");
      return 2;
    }
    const dir = env["CRAFTOS_WORKSPACE"];
    if (dir && (!existsSync(dir) || !statSync(dir).isDirectory())) {
      console.error(`--dir: ${dir} is not a folder`);
      return 2;
    }
    const config = loadConfig(env);
    for (const problem of checkConfig(config))
      console.error(`warning: ${problem}`);
    const sessions = new SessionManager(config);
    const server = startWebApp({
      port,
      sessions,
      config,
      onListening: (url) => {
        console.log(`craftos-mcp app: ${url}`);
        console.log(`project folder: ${config.workspaceDir}`);
        console.log("Ctrl+C stops it.");
        if (open) openBrowser(url);
      },
    });
    return new Promise<number>((done) => {
      server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE")
          console.error(
            `port ${port} is taken (the MCP server's viewer uses 7878): try --port 0 for a free one`,
          );
        done(1);
      });
      const stop = (): void => {
        server.close();
        void sessions.destroyAll().finally(() => done(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  },
};
export default app;
