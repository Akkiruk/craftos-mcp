/**
 * Which Minecraft / CC:Tweaked version a computer behaves as. One engine binary and one runner serve every version:
 * the version picks the ROM, the engine's `--cc-version` (every behaviour the engine pinned to 1.101.3 is gated on
 * it), the addons' mod versions and the turtle block data.
 *
 * Which version a world runs, first match wins:
 *   1. `world.version`: "1.18.2", "1.20.1", "1.21.1", or { mc, cc?, loader? }.
 *   2. The CRAFTOS_VERSION environment variable: the same forms, the object as JSON.
 *   3. The newest version in VERSIONS (NEWEST_MC): 1.21.1 (CC:Tweaked 1.121.0) today, the next one once it is added.
 *
 * Accuracy on 1.20.1 and 1.21.1 rests on CC:Tweaked's source and its own test suite (docs/conformance), not on a
 * real game: there is no instance of those versions to compare against.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerConfig } from "./config.js";

/** A CC:Tweaked jar on Modrinth: build-rom.mjs --download builds the ROM from it after checking the sha512. */
export interface CcJar {
  readonly loader: string;
  readonly file: string;
  readonly url: string;
  readonly sha512: string;
}

export interface McVersionInfo {
  /** Minecraft version, the id used in `world.version` and CRAFTOS_VERSION. */
  readonly mc: string;
  /** The CC:Tweaked version computers behave as (the newest for that Minecraft). */
  readonly cc: string;
  /** Mod loaders it exists for; the first is the default. The ROM is the same for each (byte-identical). */
  readonly loaders: readonly string[];
  /** The jars build-rom.mjs can download; the first one is used. */
  readonly jars: readonly CcJar[];
  /** ROM directory under rom/ (scripts/build-rom.mjs writes it). */
  readonly romDir: string;
  /**
   * Turtle block data in the ROM (rom-overlay/rom/ccsim/turtle/data/, made by tools/turtledata/extract.py --mc): 1.18.2
   * and 1.20.1 have their own sets; 1.21.1 has none yet, and ccsim falls back to 1.18.2's (turtle/data.lua).
   */
  readonly blockDataDir: string;
}

/** The CC:Tweaked version the engine behaves as without --cc-version. */
export const ENGINE_DEFAULT_CC = "1.101.3";

const CC_121_DIR = "cc-1.121.0";

export const VERSIONS: readonly McVersionInfo[] = [
  {
    mc: "1.18.2",
    cc: "1.101.3",
    loaders: ["forge"],
    jars: [
      {
        loader: "forge",
        file: "cc-tweaked-1.18.2-1.101.3.jar",
        url: "https://cdn.modrinth.com/data/gu7yAYhd/versions/fmRxKFx2/cc-tweaked-1.18.2-1.101.3.jar",
        sha512:
          "dff864e824f111b5901414b633e13ca2ff3685195f1d2992bdf6a3470fb6e1119ba7e995d99575296415fccb00c6cb99939e6a47fdc7983b322f3f65e805a27f",
      },
    ],
    romDir: "cc-1.101.3",
    blockDataDir: "/rom/ccsim/turtle/data/",
  },
  {
    mc: "1.20.1",
    cc: "1.121.0",
    loaders: ["forge", "fabric"],
    jars: [
      {
        loader: "forge",
        file: "cc-tweaked-1.20.1-forge-1.121.0.jar",
        url: "https://cdn.modrinth.com/data/gu7yAYhd/versions/Qm9iIIEY/cc-tweaked-1.20.1-forge-1.121.0.jar",
        sha512:
          "6ebe4c1e8e6165cb97f071a5a54acd942c234ae62d36330369fdae4bf720a93e99b84e833385f0f103e8fb03425ed20c9f9122411f0008e8ac9efa24b719522d",
      },
      {
        loader: "fabric",
        file: "cc-tweaked-1.20.1-fabric-1.121.0.jar",
        url: "https://cdn.modrinth.com/data/gu7yAYhd/versions/LFj8qZ7a/cc-tweaked-1.20.1-fabric-1.121.0.jar",
        sha512:
          "20d29a7f0c239433fe35d4607ccba8b5a65e30f0bfdeba6f0b5a4307c83dc257b3eff4bc25644009f517b062c54d7d3e54ef58ae63db8ac6e43498d73757557a",
      },
    ],
    romDir: CC_121_DIR,
    blockDataDir: "/rom/ccsim/turtle/data/1.20.1/",
  },
  {
    mc: "1.21.1",
    cc: "1.121.0",
    loaders: ["neoforge", "fabric"],
    jars: [
      {
        // Modrinth names the NeoForge build "forge"
        loader: "neoforge",
        file: "cc-tweaked-1.21.1-forge-1.121.0.jar",
        url: "https://cdn.modrinth.com/data/gu7yAYhd/versions/KNdTEfUA/cc-tweaked-1.21.1-forge-1.121.0.jar",
        sha512:
          "042f9c2de7f73f83dbe848c79ddab6383ecef5e6c4a9b51f50fdcae70caa4759d4a2cf5d14e8a3ba4d94ce4a79340c4d2fe0c8b33c33a268e21b164021d25ae3",
      },
      {
        loader: "fabric",
        file: "cc-tweaked-1.21.1-fabric-1.121.0.jar",
        url: "https://cdn.modrinth.com/data/gu7yAYhd/versions/ThbQoK4I/cc-tweaked-1.21.1-fabric-1.121.0.jar",
        sha512:
          "7f00c7ed5011d817c8c1405400c1738ddf13971c4a0b7f7a9aa5d98f5e41cc7ac0915c99e36a751e134f009158a1c0078ca354da8395058671d7c40eafc738fd",
      },
    ],
    romDir: CC_121_DIR,
    blockDataDir: "/rom/ccsim/turtle/data/1.21.1/",
  },
];

/** What a world (or CRAFTOS_VERSION) may say. */
export type VersionSpec =
  | string
  | {
      /** Minecraft version. */
      readonly mc: string;
      /** CC:Tweaked version; must be the one this Minecraft version has. */
      readonly cc?: string;
      /** Mod loader (forge, fabric, neoforge). Default: the version's first. */
      readonly loader?: string;
    };

/** A version resolved against VERSIONS: what the runner, the engine and ccsim (core.version) get. */
export interface ResolvedVersion {
  readonly mc: string;
  readonly cc: string;
  readonly loader: string;
  /** rom/<romDir> */
  readonly romDir: string;
  readonly blockDataDir: string;
}

const numbers = (mc: string): number[] => mc.split(".").map(Number);
/** The newest Minecraft version there is a ROM for, by its numbers (1.21.1 over 1.20.1 over 1.18.2). */
export const NEWEST_MC: string = VERSIONS.map((v) => v.mc).reduce((a, b) => {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
  return a;
});

/** The version a world runs with none given: the newest there is (NEWEST_MC), so a new version moves it. */
export const DEFAULT_MC: string = NEWEST_MC;

/** The versions for a help line: "1.18.2 (CC:Tweaked 1.101.3), 1.20.1 or 1.21.1 (CC:Tweaked 1.121.0); default ...". */
export function versionChoices(): string {
  const groups: string[] = [];
  for (const cc of new Set(VERSIONS.map((v) => v.cc))) {
    const mcs = VERSIONS.filter((v) => v.cc === cc).map((v) => v.mc);
    groups.push(`${mcs.join(" or ")} (CC:Tweaked ${cc})`);
  }
  return `${groups.join(", ")}; default ${DEFAULT_MC}`;
}

const BY_MC = new Map(VERSIONS.map((v) => [v.mc, v]));
const KNOWN_CC = [...new Set(VERSIONS.map((v) => v.cc))];

export function versionInfo(mc: string): McVersionInfo | undefined {
  return BY_MC.get(mc);
}

function known(): string {
  return VERSIONS.map((v) => `${v.mc} (CC:Tweaked ${v.cc})`).join(", ");
}

function parseSpec(spec: VersionSpec, from: string): ResolvedVersion {
  let mc: string;
  let cc: string | undefined;
  let loader: string | undefined;
  if (typeof spec === "string") {
    const text = spec.trim();
    if (text.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`${from}: not valid JSON: ${(error as Error).message}`);
      }
      return parseSpec(parsed as VersionSpec, from);
    }
    mc = text;
  } else if (spec && typeof spec === "object" && typeof spec.mc === "string") {
    mc = spec.mc.trim();
    if (spec.cc !== undefined) {
      if (typeof spec.cc !== "string")
        throw new Error(`${from}.cc must be a string like "1.121.0"`);
      cc = spec.cc.trim();
    }
    if (spec.loader !== undefined) {
      if (typeof spec.loader !== "string")
        throw new Error(`${from}.loader must be a string like "forge"`);
      loader = spec.loader.trim().toLowerCase();
    }
  } else {
    throw new Error(
      `${from} must be a Minecraft version ("1.20.1") or { mc, cc?, loader? }`,
    );
  }
  const info = BY_MC.get(mc);
  if (!info)
    throw new Error(
      `${from}: unknown Minecraft version ${JSON.stringify(mc)}; known: ${known()}`,
    );
  if (cc !== undefined && !KNOWN_CC.includes(cc))
    throw new Error(
      `${from}: unknown CC:Tweaked version ${JSON.stringify(cc)}; known: ${KNOWN_CC.join(", ")}`,
    );
  if (loader !== undefined && !info.loaders.includes(loader))
    throw new Error(
      `${from}: CC:Tweaked for Minecraft ${mc} has no ${JSON.stringify(loader)} build; loaders: ${info.loaders.join(", ")}`,
    );
  const ccVersion = cc ?? info.cc;
  return {
    mc,
    cc: ccVersion,
    loader: loader ?? info.loaders[0]!,
    // the ROM follows the CC version (one ROM serves every Minecraft on that CC)
    romDir:
      VERSIONS.find((v) => v.cc === ccVersion && v.mc === mc)?.romDir ??
      `cc-${ccVersion}`,
    blockDataDir: info.blockDataDir,
  };
}

/** The version a world runs as: world.version, else CRAFTOS_VERSION, else DEFAULT_MC. Unknown versions are refused. */
export function resolveVersion(
  worldVersion: VersionSpec | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedVersion {
  if (worldVersion !== undefined)
    return parseSpec(worldVersion, "world.version");
  const envSpec = env["CRAFTOS_VERSION"];
  if (envSpec !== undefined && envSpec.trim() !== "")
    return parseSpec(envSpec, "CRAFTOS_VERSION");
  return parseSpec(DEFAULT_MC, "default");
}

/** Whether this is the version the emulator behaves as with no version given (no engine flag, the default ROM). */
export function isDefaultVersion(version: ResolvedVersion): boolean {
  return version.mc === DEFAULT_MC && version.cc === ENGINE_DEFAULT_CC;
}

/**
 * The ROM for a version. The default version (DEFAULT_MC) uses config.romDir, as every run did before versions
 * existed; other versions use rom/<romDir>. CRAFTOS_ROM (config.romsDir then unset) names one ROM for every version.
 */
export function romDirFor(
  config: RunnerConfig,
  version: ResolvedVersion,
): string {
  if (!config.romsDir || version.romDir === versionInfo(DEFAULT_MC)!.romDir)
    return config.romDir;
  return join(config.romsDir, version.romDir);
}

/** Engine arguments for a version: none for 1.101.3 (the engine's own default), else --cc-version. */
export function engineVersionArgs(version: ResolvedVersion): string[] {
  return version.cc === ENGINE_DEFAULT_CC ? [] : ["--cc-version", version.cc];
}

/** What ccsim reads as core.version (world.json `version`). */
export function versionForSim(version: ResolvedVersion): {
  mc: string;
  cc: string;
  loader: string;
  blockData: string;
} {
  return {
    mc: version.mc,
    cc: version.cc,
    loader: version.loader,
    blockData: version.blockDataDir,
  };
}

/** For craftos_info and `craftos-mcp info`: the default version and every version there is. */
export function versionReport(env: NodeJS.ProcessEnv = process.env): {
  source: string;
  default: { mc: string; cc: string; loader: string } | undefined;
  versions: { mc: string; cc: string; loaders: readonly string[] }[];
} {
  let current: ResolvedVersion | undefined;
  let source: string;
  try {
    current = resolveVersion(undefined, env);
    source =
      env["CRAFTOS_VERSION"] !== undefined && env["CRAFTOS_VERSION"] !== ""
        ? `CRAFTOS_VERSION=${env["CRAFTOS_VERSION"]}`
        : `default: Minecraft ${DEFAULT_MC} (set world.version or CRAFTOS_VERSION for another)`;
  } catch (error) {
    source = `CRAFTOS_VERSION is invalid: ${(error as Error).message}`;
  }
  return {
    source,
    default: current && {
      mc: current.mc,
      cc: current.cc,
      loader: current.loader,
    },
    versions: VERSIONS.map((v) => ({
      mc: v.mc,
      cc: v.cc,
      loaders: v.loaders,
    })),
  };
}

/**
 * Builds a missing ROM: an installed npm package sets one (scripts/npm/craftos-mcp.mjs, from first-run.mjs), so its
 * first run builds only the ROM of the version in use and the others when a world asks for them. Kept on globalThis
 * under a registered symbol, so the package's bin and the runner it imports agree whatever path each was loaded by.
 */
export type RomBuilder = (
  romDir: string,
  version: ResolvedVersion,
) => Promise<void>;

const ROM_BUILDER = Symbol.for("craftos-mcp.romBuilder");
const builderSlot = globalThis as { [ROM_BUILDER]?: RomBuilder };

export function setRomBuilder(builder: RomBuilder | undefined): void {
  if (builder) builderSlot[ROM_BUILDER] = builder;
  else delete builderSlot[ROM_BUILDER];
}

/**
 * Build the ROM a world's version needs when it is missing and a builder is set; otherwise nothing (startEngine then
 * says what is missing). Never for CRAFTOS_ROM (one ROM of the user's own) or an invalid version (startEngine says so).
 */
export async function ensureRom(
  config: RunnerConfig,
  worldVersion: VersionSpec | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const builder = builderSlot[ROM_BUILDER];
  if (!builder || !config.romsDir) return;
  let version: ResolvedVersion;
  try {
    version = resolveVersion(worldVersion, env);
  } catch {
    return;
  }
  const dir = romDirFor(config, version);
  if (existsSync(join(dir, "bios.lua"))) return;
  await builder(dir, version);
}
