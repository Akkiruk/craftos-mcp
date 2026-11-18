import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  SessionManager,
  checkConfig,
  checkProject,
  findProject,
  loadConfig,
  projectEnv,
  resolveVersion,
  startWebApp,
  troubleshootingLink,
  versionChoices,
} from "@craftos-mcp/runner";
import type { Command } from "../command.js";
import { configFor, openBrowser } from "../shared.js";

/** The browser app: make computers, type into them, touch monitors and change the world, without an AI agent. */
const app: Command = {
  name: "app",
  summary: "open the emulator in your browser (no AI agent needed)",
  usage: [
    "  craftos-mcp app [--port 7878] [--dir <folder>] [--copy] [--worlds <folder>] [--mc <version>] [--snapshot <name|file>]",
    "                  [--no-open]",
    "",
    "  --port      port on 127.0.0.1 (default 7878; 0 picks a free one)",
    `  --mc        the Minecraft version new computers start on (${versionChoices()}); the form can change it`,
    "  --dir       your Lua project (default: the current folder). It is the computers' own folder, live: what a",
    "              program saves appears there, and what you save there in your editor the computer sees at once.",
    "              The New computer form can give each computer its own folder in it (computer/<id>) instead.",
    "  --copy      new computers get a scratch copy of the folder instead, gone when they close (the form can",
    "              still choose)",
    "  --worlds    folder of saved worlds (<name>.json) the New computer form offers (default worlds/)",
    "  --snapshot  open with a saved world: a snapshot's name, or a .craftos-world file someone shared",
    "  --no-open   do not open the browser, just print the address",
    "",
    "  The bar along the bottom pauses, steps, speeds up and jumps the clock of every computer, shows the",
    "  world's time of day, and saves or restores snapshots of the whole world. Keys: Alt+P pause or resume,",
    "  Alt+. one tick, Alt+] faster, Alt+[ slower, Alt+J / Alt+N / Alt+H a minute / a Minecraft day (20 min) / an hour ahead,",
    "  Alt+S snapshots.",
  ].join("\n"),
  async run(args) {
    let port = 7878;
    let open = true;
    let snapshot: string | undefined;
    let files: "copy" | undefined;
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
        } else if (arg === "--snapshot") {
          const v = value();
          snapshot = v.endsWith(".craftos-world") ? resolve(v) : v;
        } else if (arg === "--no-open") open = false;
        else if (arg === "--copy") files = "copy";
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
    // craftos.json: its workspace, Minecraft version and mods, where no flag or variable says otherwise
    try {
      const found = findProject(env["CRAFTOS_WORKSPACE"] ?? process.cwd());
      const errors = found ? checkProject(found.data, found.dir) : [];
      if (errors.length)
        throw new Error(`${found!.file}: ${errors.join("; ")}`);
      const { CRAFTOS_WORKSPACE: workspace, ...rest } = projectEnv(found, {
        ...process.env,
        ...env,
      });
      if (workspace) env["CRAFTOS_WORKSPACE"] = workspace;
      Object.assign(process.env, rest);
    } catch (error) {
      console.error((error as Error).message);
      return 2;
    }
    // no --dir, CRAFTOS_WORKSPACE or craftos.json: the current folder, as window, run and test take it
    if (!env["CRAFTOS_WORKSPACE"]) {
      try {
        env["CRAFTOS_WORKSPACE"] = configFor(undefined).workspaceDir;
      } catch (error) {
        console.error((error as Error).message);
        return 2;
      }
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
      ...(snapshot && { snapshot }),
      ...(files && { files }),
      onListening: (url) => {
        console.log(`craftos-mcp app: ${url}`);
        console.log(
          files === "copy"
            ? `project folder: ${config.workspaceDir} (computers get a scratch copy)`
            : `project folder: ${config.workspaceDir} (the computers' files, live)`,
        );
        console.log("Ctrl+C stops it.");
        if (open) openBrowser(url);
      },
    });
    return new Promise<number>((done) => {
      server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          const message = `port ${port} is taken (the MCP server's viewer uses 7878): try --port 0 for a free one`;
          console.error(message);
          const help = troubleshootingLink(message);
          if (help) console.error(`More help: ${help}`);
        }
        done(1);
      });
      const stop = (): void => {
        server.close();
        void sessions.destroyAll().finally(() => done(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // A host that started this as a child with a message channel (the desktop app) stops it with "stop", or by
      // going away: the computers are shut down either way, never left running.
      if (process.send) {
        process.on("message", (message) => {
          // closing the channel fires "disconnect" below, and lets this process end once the computers are down
          if (message === "stop" && process.connected) process.disconnect();
        });
        process.once("disconnect", stop);
      }
    });
  },
};
export default app;
