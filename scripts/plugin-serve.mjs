// What the Claude Code plugin runs as its MCP server (see .claude-plugin/plugin.json).
//
// A plugin is installed as a plain copy of this repository: no node_modules, no build output, no ROM, no engine.
// So on its first start this runs `scripts/setup.mjs` (npm install, build, ROM, engine download) in the background,
// waits for it, and then starts the MCP server in this same process. If Claude Code gives up waiting on that first
// start, setup carries on; /mcp then reconnects to a finished install. Later starts skip straight to the server.
//
// stdout belongs to the MCP protocol, so everything here goes to stderr or to .cache/setup.log.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(REPO, "apps", "mcp-server", "dist", "index.js");
const LOG = join(REPO, ".cache", "setup.log");
const WINDOWS = process.platform === "win32";

// The user's project is the folder Claude Code was started in: that is the workspace unless they set one.
process.env.CRAFTOS_WORKSPACE ||= process.cwd();
// Claude Code passes an unset plugin option through as an empty string.
if (!process.env.CRAFTOS_ADDONS) delete process.env.CRAFTOS_ADDONS;

const ready = () =>
  existsSync(SERVER) &&
  existsSync(join(REPO, "node_modules", "@modelcontextprotocol", "sdk")) &&
  existsSync(
    join(REPO, "engine", "build", WINDOWS ? "craftos.exe" : "craftos"),
  ) &&
  existsSync(join(REPO, "rom", "cc-1.101.3", "bios.lua"));

if (!ready()) {
  console.error(
    "craftos-mcp: first start, setting up (a few minutes); progress is in " +
      LOG,
  );
  mkdirSync(dirname(LOG), { recursive: true });
  const log = openSync(LOG, "a");
  const child = spawn(process.execPath, [join(REPO, "scripts", "setup.mjs")], {
    cwd: REPO,
    detached: true, // outlives this process if Claude Code stops waiting
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  closeSync(log);
  const code = await new Promise((done) => {
    child.on("exit", (c) => done(c));
    child.on("error", () => done(-1));
  });
  if (!existsSync(SERVER)) {
    let tail = "";
    try {
      tail = readFileSync(LOG, "utf8").split("\n").slice(-25).join("\n");
    } catch {}
    console.error(`craftos-mcp: setup failed (exit ${code}):\n${tail}`);
    console.error(`Run "npm run setup" in ${REPO} to see it.`);
    process.exit(1);
  }
  if (code !== 0)
    console.error(
      "craftos-mcp: setup did not finish everything; craftos_info lists what is missing.",
    );
}

await import(pathToFileURL(SERVER).href);
