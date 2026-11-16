import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RunnerConfig {
  /** The forked engine binary. */
  readonly engineExe: string;
  /** ROM directory containing bios.lua and rom/ (see scripts/build-rom.mjs). */
  readonly romDir: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const exeName = process.platform === "win32" ? "craftos.exe" : "craftos";
  const config: RunnerConfig = {
    engineExe: resolve(
      env["CRAFTOS_ENGINE"] ?? join(repoRoot, "engine", "build", exeName),
    ),
    romDir: resolve(env["CRAFTOS_ROM"] ?? join(repoRoot, "rom", "cc-1.101.3")),
    workspaceDir: resolve(
      env["CRAFTOS_WORKSPACE"] ?? join(repoRoot, "workspace"),
    ),
    worldsDir: resolve(env["CRAFTOS_WORLDS"] ?? join(repoRoot, "worlds")),
    runtimeDir: resolve(
      env["CRAFTOS_RUNTIME_ROOT"] ?? join(repoRoot, ".runtime"),
    ),
    luaLibDir: fileURLToPath(new URL("../lua/", import.meta.url)),
  };
  mkdirSync(config.workspaceDir, { recursive: true });
  mkdirSync(config.runtimeDir, { recursive: true });
  return config;
}

/** Explain what is missing instead of failing later with an opaque spawn error. */
export function checkConfig(config: RunnerConfig): string[] {
  const problems: string[] = [];
  if (!existsSync(config.engineExe)) {
    problems.push(
      `engine not found at ${config.engineExe} (build it with engine/build.cmd on Windows or engine/build.sh on Linux)`,
    );
  }
  if (!existsSync(join(config.romDir, "bios.lua"))) {
    problems.push(
      `ROM not found at ${config.romDir} (run: node scripts/build-rom.mjs --download, ` +
        `or node scripts/build-rom.mjs <cc-tweaked.jar> rom/cc-1.101.3 with a jar you have)`,
    );
  }
  return problems;
}
