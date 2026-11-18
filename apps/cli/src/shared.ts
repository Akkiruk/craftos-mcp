// Helpers the command-line commands share: the workspace folder, worlds, monitors and number options.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type MonitorSpec,
  type Project,
  type RunnerConfig,
  type WorldConfig,
  MONITOR_LIMIT,
  WorkspaceError,
  checkProject,
  monitorTooBig,
  troubleshootingLink,
  checkWorld,
  findProject,
  loadConfig,
  projectEnv,
  projectWorkspace,
  projectWorld,
  loadNamedWorld,
  packageVersion,
  resolveVersion,
  withoutEditorKeys,
} from "@craftos-mcp/runner";

type OptionSet = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

/** Options every command takes. */
const COMMON_OPTIONS = {
  dir: { type: "string" },
  world: { type: "string" },
  addons: { type: "string" },
  // the Minecraft version (world.version): not --version, which reads as "print this tool's version"
  mc: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export class UsageError extends Error {}

/** The options a command parsed; `values` has the common ones plus its own. */
export interface Parsed {
  values: {
    dir?: string;
    world?: string;
    addons?: string;
    mc?: string;
    help?: boolean;
    timescale?: string;
    timeout?: string;
    monitor?: string[];
    screenshot?: string;
  };
  positionals: string[];
}

/** parseArgs that turns its errors into a UsageError. */
export function parse(args: string[], options: OptionSet): Parsed {
  try {
    return parseArgs({
      args,
      options: { ...COMMON_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    }) as Parsed;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** The environment variables the last configFor took from craftos.json (so the next one can take them back). */
const fromProject = new Map<string, string>();
let currentProject: Project | undefined;

/** The craftos.json the last configFor found, if any. */
export function project(): Project | undefined {
  return currentProject;
}

/**
 * Find craftos.json from `start` upwards and let it stand in for CRAFTOS_VERSION and CRAFTOS_ADDONS where the
 * environment leaves them unset (a flag still wins: --mc and --addons go into the world). Returns the project.
 */
export function useProject(start: string): Project | undefined {
  // what the last project set, unless someone set it since
  for (const [key, value] of fromProject)
    if (process.env[key] === value) delete process.env[key];
  fromProject.clear();
  let found: Project | undefined;
  try {
    found = findProject(start);
  } catch (error) {
    throw new WorkspaceError((error as Error).message);
  }
  if (found) {
    const errors = checkProject(found.data, found.dir);
    if (errors.length)
      throw new WorkspaceError(
        `${found.file}: ${errors.length === 1 ? errors[0] : `\n- ${errors.join("\n- ")}`}`,
      );
  }
  const { CRAFTOS_WORKSPACE: _, ...env } = projectEnv(found);
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
    fromProject.set(key, value);
  }
  currentProject = found;
  return found;
}

/**
 * The runner's config with the workspace set to --dir, else craftos.json's workspace, else the current folder. In a
 * clone, run from the clone's own root, the default is its workspace/ folder (as the MCP server): the root is the
 * whole repo, runtime folder too.
 */
export function configFor(dir: string | undefined): RunnerConfig {
  const found = useProject(resolve(dir ?? process.cwd()));
  const fromFile = found && projectWorkspace(found);
  if (dir === undefined && fromFile) {
    process.env["CRAFTOS_WORKSPACE"] = fromFile;
    return loadConfig();
  }
  if (dir === undefined && packageVersion() === undefined) {
    const { CRAFTOS_WORKSPACE: _, ...env } = process.env;
    const clone = loadConfig(env);
    const same = (a: string, b: string): boolean =>
      process.platform === "win32"
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    if (same(resolve(clone.workspaceDir, ".."), resolve(process.cwd()))) {
      process.env["CRAFTOS_WORKSPACE"] = clone.workspaceDir;
      return loadConfig();
    }
  }
  const workspace = resolve(dir ?? process.cwd());
  if (!existsSync(workspace))
    throw new UsageError(`no such folder: ${workspace}`);
  process.env["CRAFTOS_WORKSPACE"] = workspace;
  return loadConfig();
}

/** A path typed on the command line, as the workspace-relative path the runner wants. */
export function workspacePath(config: RunnerConfig, typed: string): string {
  const abs = resolve(process.cwd(), typed);
  // The current folder is always the real path, so compare with the workspace's real path too: on macOS /tmp and
  // /var are links into /private, and a workspace under one would otherwise never contain the current folder.
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const rel = relative(real(config.workspaceDir), abs);
  if (!rel.startsWith("..") && !isAbsolute(rel))
    return rel.split("\\").join("/") || ".";
  return typed;
}

/**
 * --world: a JSON file (relative to the current folder or the workspace) or the name of a world in worlds/. --addons
 * overrides its mod list and --mc its Minecraft version (world.version).
 */
export function loadWorld(
  config: RunnerConfig,
  world: string | undefined,
  addons: string | undefined,
  mc?: string,
): WorldConfig | undefined {
  // no --world: craftos.json's world, if it names one
  const fromProject = currentProject && projectWorld(currentProject);
  const loaded = loadWorldAddons(config, world ?? fromProject, addons);
  if (world === undefined && fromProject)
    world = `${fromProject} (craftos.json)`;
  if (mc !== undefined) {
    try {
      resolveVersion(mc);
    } catch (error) {
      throw new UsageError(
        `--mc: ${(error as Error).message.replace(/^world\.version: /, "")}`,
      );
    }
  }
  const merged = mc === undefined ? loaded : { ...loaded, version: mc };
  // checked before a computer boots: a typo in a key or a peripheral type is a message, not a confusing run
  const checked = checkWorld(merged);
  const { warnings } = checked;
  // --addons is what put the world's addons there: say so, not world.addons
  const errors =
    addons === undefined
      ? checked.errors
      : checked.errors.map((e) => e.replace(/\bworld\.addons\b/g, "--addons"));
  if (errors.length)
    throw new WorkspaceError(
      `${world ? `--world ${world}` : addons !== undefined ? `--addons ${addons}` : "the world"}: ${errors.length === 1 ? errors[0] : `\n- ${errors.join("\n- ")}`}`,
    );
  for (const w of warnings) console.error(`warning: ${w}`);
  return merged;
}

/** Where a saved world of that name would be (worlds/<name>.json). */
const savedFile = (config: RunnerConfig, world: string): string =>
  join(config.worldsDir, `${world.replace(/\.json$/i, "")}.json`);

function loadWorldAddons(
  config: RunnerConfig,
  world: string | undefined,
  addons: string | undefined,
): WorldConfig | undefined {
  let loaded: WorldConfig | undefined;
  if (world) {
    const candidates = [
      resolve(process.cwd(), world),
      join(config.workspaceDir, world),
    ];
    const file = candidates.find((c) => /\.json$/i.test(c) && existsSync(c));
    if (file) {
      try {
        loaded = withoutEditorKeys(
          JSON.parse(readFileSync(file, "utf8")) as WorldConfig,
        );
      } catch (error) {
        throw new UsageError(`${file}: ${(error as Error).message}`);
      }
    } else {
      // a path (a slash or a file extension in it) to a file that is not there, not the name of a saved world
      if (/[\\/]|\.\w+$/.test(world) && !existsSync(savedFile(config, world)))
        throw new UsageError(
          `no world file ${world} (looked in ${process.cwd()}${
            resolve(process.cwd()) === resolve(config.workspaceDir)
              ? ""
              : ` and ${config.workspaceDir}`
          }; a world file's name ends in .json)`,
        );
      try {
        loaded = loadNamedWorld(
          config.worldsDir,
          world.replace(/\.json$/i, ""),
        );
      } catch (error) {
        // the names there are, so a typo is one look away
        let saved: string[] = [];
        try {
          saved = readdirSync(config.worldsDir)
            .filter((f) => f.endsWith(".json") && !f.startsWith("."))
            .map((f) => f.slice(0, -5))
            .sort();
        } catch {
          // no worlds folder
        }
        throw new UsageError(
          `${(error as Error).message}${
            existsSync(savedFile(config, world)) || !saved.length
              ? ""
              : ` (it has: ${saved.slice(0, 20).join(", ")}${saved.length > 20 ? ", ..." : ""}). A world file of your own: give its path, ending in .json`
          }`,
        );
      }
    }
  }
  if (addons === undefined) return loaded;
  const list = addons
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const value =
    list.length === 1 && /^(all|none)$/.test(list[0]!) ? list[0]! : list;
  return { ...loaded, addons: value };
}

/**
 * The monitors of a run: the world file's `"monitors"` (as the window and the VS Code extension read them), then each
 * --monitor, which replaces the world's monitor of the same name.
 */
export function monitorsFor(
  world: WorldConfig | undefined,
  flags: string[] | undefined,
): MonitorSpec[] {
  const fromWorld =
    (world as { monitors?: MonitorSpec[] } | undefined)?.monitors ?? [];
  const typed = (flags ?? []).map(parseMonitor);
  const names = new Set(typed.map((m) => m.name));
  return [
    ...(Array.isArray(fromWorld) ? fromWorld : []).filter(
      (m) => m && typeof m.name === "string" && !names.has(m.name),
    ),
    ...typed,
  ];
}

/** `name:WxH` or `name:WxH@scale` (`top:2x2`, `monitor_0:4x3@0.5`; `top` alone is 1x1). */
export function parseMonitor(spec: string): MonitorSpec {
  const m = /^([^:@]+)(?::(\d+)x(\d+))?(?:@([\d.]+))?$/.exec(spec);
  if (!m)
    throw new UsageError(
      `bad --monitor ${JSON.stringify(spec)}: use name:WxH, like top:2x2`,
    );
  const blocksWide = m[2] ? Number(m[2]) : 1;
  const blocksHigh = m[3] ? Number(m[3]) : 1;
  if (blocksWide > MONITOR_LIMIT.width || blocksHigh > MONITOR_LIMIT.height)
    throw new UsageError(
      `--monitor ${spec}: ${monitorTooBig(m[1]!, blocksWide, blocksHigh)}`,
    );
  return {
    name: m[1]!,
    blocksWide,
    blocksHigh,
    ...(m[4] ? { textScale: Number(m[4]) } : {}),
  };
}

export function number(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new UsageError(
      `--${name} must be a positive number, got ${JSON.stringify(value)}`,
    );
  return n;
}

/** A missing engine or ROM (checkConfig, missingRomProblem): the message says what to do, a stack adds nothing. */
const isSetupProblem = (error: unknown): error is Error =>
  error instanceof Error &&
  /^(engine not found|ROM (for Minecraft \S+ )?not found)/.test(error.message);

/** Run a command body: usage mistakes print the message and exit 2; anything else is a crash worth a stack. */
export async function guarded(
  usage: string,
  body: () => Promise<number>,
): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      const help = troubleshootingLink(error.message);
      // a message the guide explains needs no option list under it
      console.error(help ? `More help: ${help}` : usage);
      return 2;
    }
    if (error instanceof WorkspaceError || isSetupProblem(error)) {
      console.error(error.message);
      const help = troubleshootingLink(error.message);
      if (help) console.error(`More help: ${help}`);
      return 2;
    }
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return 2;
  }
}

/** Open a URL in the default browser, quietly: a machine without one just prints the link. */
export function openBrowser(url: string): void {
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
