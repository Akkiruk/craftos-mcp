import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MC,
  resolveVersion,
  romDirFor,
  versionInfo,
} from "./versions.js";

/** The default version's ROM folder under rom/ (cc-1.101.3 for 1.18.2, cc-1.121.0 for 1.20.1 and 1.21.1). */
const DEFAULT_ROM_DIR = versionInfo(DEFAULT_MC)!.romDir;

export interface RunnerConfig {
  /** The forked engine binary. */
  readonly engineExe: string;
  /** ROM directory containing bios.lua and rom/ (see scripts/build-rom.mjs): Minecraft 1.18.2's, or CRAFTOS_ROM. */
  readonly romDir: string;
  /**
   * Where the ROM of each CC:Tweaked version lives (rom/cc-<version>, versions.ts picks one per world). Unset when
   * CRAFTOS_ROM names one ROM for every run.
   */
  readonly romsDir?: string;
  /** Directory of authored Lua files; copied to the root of each computer. */
  readonly workspaceDir: string;
  /** Named world files (`<name>.json`) that tools can load with `worldFile`. */
  readonly worldsDir: string;
  /** Scratch space; every run gets its own subdirectory. */
  readonly runtimeDir: string;
  /** Helper Lua libraries shipped with this package (ccunit). */
  readonly luaLibDir: string;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The file that marks an installed npm package (scripts/pack-npm.mjs writes it at the package root, with the package
 * version). A package ships no engine and no ROM: they live in a per-user folder, set up on first run
 * (scripts/npm/first-run.mjs). A clone has no such file and keeps everything in the clone, as always.
 */
export const PACKAGE_MARKER = "craftos-package.json";

let packaged: { version: string } | null | undefined;

/** The installed npm package's version, or undefined in a clone. */
export function packageVersion(): string | undefined {
  if (packaged === undefined) {
    try {
      packaged = JSON.parse(
        readFileSync(join(repoRoot, PACKAGE_MARKER), "utf8"),
      ) as { version: string };
    } catch {
      packaged = null;
    }
  }
  return packaged?.version;
}

/**
 * The per-user folder of an installed package: CRAFTOS_HOME, else %LOCALAPPDATA%\craftos-mcp on Windows and
 * $XDG_CACHE_HOME/craftos-mcp (~/.cache/craftos-mcp) elsewhere.
 */
export function craftosHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env["CRAFTOS_HOME"]) return resolve(env["CRAFTOS_HOME"]);
  if (process.platform === "win32")
    return join(
      env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
      "craftos-mcp",
    );
  return join(
    env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"),
    "craftos-mcp",
  );
}

/**
 * Where engine/build and rom/ are: the clone itself, or for an installed package <home>/<version> (the ROM holds this
 * version's overlay, so every package version gets its own).
 */
export function installRoot(env: NodeJS.ProcessEnv = process.env): string {
  const version = packageVersion();
  return version ? join(craftosHome(env), version) : repoRoot;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const exeName = process.platform === "win32" ? "craftos.exe" : "craftos";
  const pkg = packageVersion() !== undefined;
  const base = installRoot(env);
  const config: RunnerConfig = {
    engineExe: resolve(
      env["CRAFTOS_ENGINE"] ?? join(base, "engine", "build", exeName),
    ),
    romDir: resolve(env["CRAFTOS_ROM"] ?? join(base, "rom", DEFAULT_ROM_DIR)),
    ...(env["CRAFTOS_ROM"] === undefined && { romsDir: join(base, "rom") }),
    // an installed package works on the folder it is run in
    workspaceDir: resolve(
      env["CRAFTOS_WORKSPACE"] ??
        (pkg ? process.cwd() : join(repoRoot, "workspace")),
    ),
    worldsDir: resolve(env["CRAFTOS_WORLDS"] ?? join(repoRoot, "worlds")),
    runtimeDir: resolve(
      env["CRAFTOS_RUNTIME_ROOT"] ??
        (pkg ? join(craftosHome(env), "runtime") : join(repoRoot, ".runtime")),
    ),
    luaLibDir: fileURLToPath(new URL("../lua/", import.meta.url)),
  };
  mkdirSync(config.workspaceDir, { recursive: true });
  mkdirSync(config.runtimeDir, { recursive: true });
  return config;
}

const PACKAGE_FIX =
  "every craftos-mcp command sets it up on first run; craftos-mcp setup does it again";

/** A version's ROM is missing: say how to build it (scripts/build-rom.mjs --download <mc>). */
export function missingRomProblem(
  romDir: string,
  mc: string,
): string | undefined {
  if (existsSync(join(romDir, "bios.lua"))) return undefined;
  if (packageVersion())
    return `ROM for Minecraft ${mc} not found at ${romDir} (craftos-mcp builds it when a world asks for it; craftos-mcp setup --all builds every version's now)`;
  return (
    `ROM for Minecraft ${mc} not found at ${romDir} (run: node scripts/build-rom.mjs --download ${mc}, ` +
    `or npm run setup -- --mc ${mc})`
  );
}

/** Explain what is missing instead of failing later with an opaque spawn error. */
export function checkConfig(config: RunnerConfig): string[] {
  const problems: string[] = [];
  if (packageVersion()) {
    if (!existsSync(config.engineExe))
      problems.push(`engine not found at ${config.engineExe} (${PACKAGE_FIX})`);
    // the first run builds only the ROM of the version in use (CRAFTOS_VERSION, else the default); others on demand
    const rom = romInUse(config);
    if (!existsSync(join(rom, "bios.lua")))
      problems.push(`ROM not found at ${rom} (${PACKAGE_FIX})`);
    return problems;
  }
  if (!existsSync(config.engineExe)) {
    problems.push(
      `engine not found at ${config.engineExe} (build it with engine/build.cmd on Windows or engine/build.sh on Linux and macOS)`,
    );
  }
  if (!existsSync(join(config.romDir, "bios.lua"))) {
    problems.push(
      `ROM not found at ${config.romDir} (run: node scripts/build-rom.mjs --download, ` +
        `or node scripts/build-rom.mjs <cc-tweaked.jar> rom/${DEFAULT_ROM_DIR} with a jar you have)`,
    );
  }
  return problems;
}

/** The ROM of the version runs use when a world names none (CRAFTOS_VERSION, else the default); invalid: the default's. */
function romInUse(config: RunnerConfig): string {
  try {
    return romDirFor(config, resolveVersion(undefined));
  } catch {
    return config.romDir;
  }
}
