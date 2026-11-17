// Helpers the command-line commands share: the workspace folder, worlds, monitors and number options.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type MonitorSpec,
  type RunnerConfig,
  type WorldConfig,
  WorkspaceError,
  checkWorld,
  loadConfig,
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

/**
 * The runner's config with the workspace set to --dir (default: the current folder). In a clone, run from the clone's
 * own root, the default is its workspace/ folder (as the MCP server): the root is the whole repo, runtime folder too.
 */
export function configFor(dir: string | undefined): RunnerConfig {
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
  const loaded = loadWorldAddons(config, world, addons);
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
  const { errors, warnings } = checkWorld(merged);
  if (errors.length)
    throw new WorkspaceError(
      `${world ? `--world ${world}` : "the world"}: ${errors.length === 1 ? errors[0] : `\n- ${errors.join("\n- ")}`}`,
    );
  for (const w of warnings) console.error(`warning: ${w}`);
  return merged;
}

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
      try {
        loaded = loadNamedWorld(
          config.worldsDir,
          world.replace(/\.json$/i, ""),
        );
      } catch (error) {
        throw new UsageError((error as Error).message);
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

/** `name:WxH` or `name:WxH@scale` (`top:2x2`, `monitor_0:4x3@0.5`; `top` alone is 1x1). */
export function parseMonitor(spec: string): MonitorSpec {
  const m = /^([^:@]+)(?::(\d+)x(\d+))?(?:@([\d.]+))?$/.exec(spec);
  if (!m)
    throw new UsageError(
      `bad --monitor ${JSON.stringify(spec)}: use name:WxH, like top:2x2`,
    );
  return {
    name: m[1]!,
    blocksWide: m[2] ? Number(m[2]) : 1,
    blocksHigh: m[3] ? Number(m[3]) : 1,
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
      console.error(usage);
      return 2;
    }
    if (error instanceof WorkspaceError || isSetupProblem(error)) {
      console.error(error.message);
      return 2;
    }
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return 2;
  }
}
