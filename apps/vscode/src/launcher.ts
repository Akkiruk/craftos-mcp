// How the extension starts craftos-mcp: the command line for the MCP server, the browser app and the test runner,
// and how it stops what it started. No vscode import, so the tests can load it in plain Node.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";

/**
 * The npm package this extension was built and tested against. Pinned so every start runs the same version (npx
 * uses its cache instead of asking the registry for the latest each time) and so the engine zip it downloads matches.
 * A new craftos-mcp release means a new extension release with this bumped.
 */
export const NPM_PACKAGE = "craftos-mcp@0.3.0";

/**
 * The release before NPM_PACKAGE. When npm says the pinned version does not exist (the extension went out before
 * the npm release, or a mirror lags), the default command falls back to this one instead of failing.
 */
export const FALLBACK_PACKAGE = "craftos-mcp@0.2.0";

/** Whether npx failed because the pinned version is not on the registry (ETARGET), not for any other reason. */
export function missingVersion(output: string): boolean {
  return /ETARGET|No matching version found for craftos-mcp@/i.test(output);
}

/** The same command on FALLBACK_PACKAGE, if it is the default pinned one; undefined for anything else. */
export function fallbackFor(base: readonly string[]): string[] | undefined {
  const at = base.indexOf(NPM_PACKAGE);
  if (at < 0 || base[0] !== "npx") return undefined;
  const out = [...base];
  out[at] = FALLBACK_PACKAGE;
  return out;
}

/** The command for configs other clients keep (Claude Code, Cursor...): unpinned, so it never goes stale there. */
export const EXTERNAL_BASE = ["npx", "-y", "craftos-mcp"];

export interface Launch {
  readonly command: string;
  readonly args: string[];
}

/** The configured command (craftos-mcp.command) or `npx -y craftos-mcp@<pinned>`. */
export function baseCommand(override: readonly string[] | undefined): string[] {
  const clean = (override ?? []).filter((s) => typeof s === "string" && s);
  return clean.length ? [...clean] : ["npx", "-y", NPM_PACKAGE];
}

/**
 * Windows cannot start a .cmd file (npx, npm, a global npm bin) without a shell, and VS Code starts MCP servers
 * without one, so those go through cmd.exe. Anything with another extension (node.exe, a full path) starts directly.
 */
export function needsCmd(
  command: string,
  platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const name = command.split(/[\\/]/).pop()!.toLowerCase();
  if (/\.(cmd|bat)$/.test(name)) return true;
  // node is node.exe; other bare names (npx, claude) may be .cmd shims
  return name !== "node" && !/\.[a-z0-9]+$/.test(name);
}

/** The process to start for `craftos-mcp <sub...>`: what an MCP client is given, and what spawnCraftos runs. */
export function launchFor(
  base: readonly string[],
  sub: readonly string[],
  platform = process.platform,
  comspec = process.env["ComSpec"],
): Launch {
  const [command, ...rest] = base;
  if (!command) throw new Error("craftos-mcp.command is empty");
  const args = [...rest, ...sub];
  if (needsCmd(command, platform))
    return {
      command: comspec || "cmd.exe",
      args: ["/d", "/c", command, ...args],
    };
  return { command, args };
}

/** Quote one argument for a cmd.exe command line (paths with spaces; Windows paths cannot hold a quote). */
function cmdQuote(arg: string): string {
  return /[\s"&|<>^(),;=!%]/.test(arg) || arg === ""
    ? `"${arg.replace(/"/g, '""')}"`
    : arg;
}

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Start a command line (base + sub) with piped stdio. On Windows a .cmd goes through `cmd /d /s /c "<line>"`, quoted
 * by hand, since Node's own quoting and cmd's disagree on paths with spaces. Elsewhere the child leads its own
 * process group, so killTree reaches the engines it starts.
 */
export function spawnCommand(
  base: readonly string[],
  sub: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const [command, ...rest] = base;
  if (!command) throw new Error("craftos-mcp.command is empty");
  const args = [...rest, ...sub];
  const common = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  if (needsCmd(command)) {
    const line = [command, ...args].map(cmdQuote).join(" ");
    return spawn(
      process.env["ComSpec"] || "cmd.exe",
      ["/d", "/s", "/c", `"${line}"`],
      { ...common, windowsVerbatimArguments: true },
    );
  }
  return spawn(command, args, {
    ...common,
    detached: process.platform !== "win32",
  });
}

/** Stop a child and everything it started (npx, node, the engines). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export type SetupLine =
  | { kind: "setting-up"; detail: string }
  | { kind: "ready" }
  | { kind: "failed"; why: string };

/**
 * One line of craftos-mcp's first-run setup on stderr (scripts/npm/first-run.mjs): `craftos-mcp: setting up ...`,
 * `craftos-mcp:   engine: 50% of 9 MB`, `craftos-mcp: ready (40 s)`, `craftos-mcp: setup failed: ...`.
 */
export function readSetupLine(line: string): SetupLine | undefined {
  const m = /^craftos-mcp: (.*)$/.exec(line.trim());
  if (!m) return undefined;
  const text = m[1]!.trim();
  if (/^ready \(\d+ s\)$/.test(text)) return { kind: "ready" };
  const failed = /^setup failed: (.*)$/.exec(text);
  if (failed) return { kind: "failed", why: failed[1]! };
  if (/^setting up /.test(text))
    return { kind: "setting-up", detail: "starting" };
  const pct = /^(engine|ROM[^:]*|[\w .-]+): (\d+)% of (.+)$/.exec(text);
  if (pct) return { kind: "setting-up", detail: `${pct[1]} ${pct[2]}%` };
  if (/^(engine|ROM)\b/.test(text))
    return { kind: "setting-up", detail: text.split(" (")[0]! };
  if (/another craftos-mcp is setting up/.test(text))
    return { kind: "setting-up", detail: "waiting for another setup" };
  return undefined;
}

/** Whether a failed start means the command itself is missing (`'claude' is not recognized`, ENOENT, 127). */
export function commandMissing(
  code: number | null,
  output: string,
  error?: NodeJS.ErrnoException,
): boolean {
  if (error?.code === "ENOENT") return true;
  if (code === 9009 || code === 127) return true;
  return /is not recognized as an internal or external command|command not found|: not found/i.test(
    output,
  );
}
