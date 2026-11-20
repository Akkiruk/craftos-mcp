/**
 * Checks that run before a computer boots, so a mistake in a world or a program name comes back at once as a clear
 * message (with "did you mean") instead of a computer that starts and then fails somewhere else.
 *
 * - checkWorld: unknown top-level keys, peripheral entries with no name, peripheral types the sim cannot build, and
 *   addons or versions the world cannot have. A key that is close to a real one ("peripheralz") is an error; any other
 *   unknown key only a warning, since it does nothing either way.
 * - checkProgram: the program a run starts is on the computer (the workspace, the world's deploy list or the ROM).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import {
  ADDONS,
  addonOfType,
  addonSource,
  addonTypeNames,
  checkWorldAddons,
  resolveAddons,
} from "./addons.js";
import type { RunnerConfig } from "./config.js";
import { didYouMean } from "./did-you-mean.js";
import { MONITOR_LIMIT } from "./lua.js";
import { COPY_SKIP } from "./copy.js";
import { resolveVersion, romDirFor } from "./versions.js";
import type { WorldConfig } from "./world.js";
import { listWorkspace, resolveInWorkspace } from "./workspace.js";

/**
 * Every top-level key of WorldConfig (world.ts) that is not an addon's own (those are each addon's worldKeys in
 * addons.ts); validate.test.ts checks the two together stay in step with WorldConfig.
 */
export const WORLD_KEYS: readonly string[] = [
  "addons",
  "version",
  "simProgram",
  "craftosPcApis",
  "motd",
  "players",
  "host",
  "interacting",
  "autoApprove",
  "economyAvailable",
  "holdInteraction",
  "vhcctweaks",
  "economyDelayTicks",
  "gearPowerAvailable",
  "identifyAvailable",
  "internalErrors",
  "vhccStore",
  "linkLatency",
  "computerId",
  "kind",
  "advanced",
  "terminal",
  "config",
  "position",
  "cobaltSpeed",
  "label",
  "modemLink",
  "deploy",
  "peripherals",
  "environment",
  "entities",
  "ap",
  "mekanism",
  "turtle",
  "placed",
  "disks",
  "blocks",
  "fills",
  "ground",
  "items",
  "gameRules",
  "turtleConfig",
  "spawnProtection",
  "worldBorder",
  "loadedChunks",
  "unloadedChunks",
  "nextDiskId",
  "gameData",
  "seed",
];

/**
 * Keys a world file may carry for people (and editors), which the sim ignores; and `monitors` (WorldFile in
 * world.ts), which the command line, the VS Code extension and test runs read from the file, not the sim.
 */
const NOTE_KEYS = new Set([
  "$schema",
  "monitors",
  "description",
  "name",
  "comment",
  "notes",
]);

/** CC:Tweaked's own peripheral types the sim builds, besides the addons' (addons.ts) and generic storage blocks. */
const CC_TYPES = [
  "modem",
  "computer",
  "speaker",
  "printer",
  "drive",
  "inventory",
  "fluid_storage",
  "energy_storage",
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:barrel",
  "minecraft:hopper",
  "minecraft:dispenser",
  "minecraft:dropper",
  "minecraft:shulker_box",
  "minecraft:furnace",
];
/** CC:Tweaked's types that only exist from 1.114 (the 1.121.0 versions). */
const CC_121_TYPES = ["redstone_relay"];

/** Fields that make any block name a generic peripheral (inventory, fluid_storage, energy_storage). */
const GENERIC_FIELDS = [
  "size",
  "items",
  "tanks",
  "fluid",
  "energy",
  "energyCapacity",
];

export interface WorldCheck {
  /** The world cannot work as given: refuse it before booting. */
  readonly errors: string[];
  /** Probably not what was meant, but harmless: say so in the result. */
  readonly warnings: string[];
}

export { didYouMean };

const mean = (hint: string | undefined, from?: string): string =>
  hint
    ? ` Did you mean ${JSON.stringify(hint)}${from ? ` (${from})` : ""}?`
    : "";

/** Every peripheral type the sim can build on this Minecraft version, with what provides it. */
export function knownPeripheralTypes(mc: string): Map<string, string> {
  const types = new Map<string, string>();
  for (const t of CC_TYPES) types.set(t, "CC:Tweaked");
  if (resolveVersion(mc).cc !== "1.101.3")
    for (const t of CC_121_TYPES) types.set(t, "CC:Tweaked");
  // every name a type has (a world may use the 1.18.2 one or its version's rename); one a version lacks is still
  // known here, so checkWorldAddons says which versions have it instead of "not a peripheral the sim can build"
  for (const addon of ADDONS)
    for (const t of addonTypeNames(addon))
      types.set(t, `${addon.name} (addon "${addon.id}")`);
  return types;
}

/** Check a world before it boots. Never throws. */
export function checkWorld(
  world: unknown,
  env: NodeJS.ProcessEnv = process.env,
): WorldCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (world === undefined || world === null) return { errors, warnings };
  if (typeof world !== "object" || Array.isArray(world))
    return { errors: ["world must be an object"], warnings };
  const w = world as Record<string, unknown>;

  const keys = new Set([
    ...WORLD_KEYS,
    ...ADDONS.flatMap((a) => a.worldKeys ?? []),
  ]);
  for (const key of Object.keys(w)) {
    if (keys.has(key) || NOTE_KEYS.has(key) || key.startsWith("_")) continue;
    // "monitor" for "monitors" is a typo too, though the sim itself never reads the monitors
    const hint = didYouMean(key, [...keys, ...NOTE_KEYS]);
    if (hint) errors.push(`world.${key} is not a world field.${mean(hint)}`);
    else
      warnings.push(
        `world.${key} is not a world field and does nothing (the world schema lists them: craftos://schema/world)`,
      );
  }

  // a wall bigger than the game allows would otherwise only fail when the computer boots
  const monitors = w["monitors"];
  if (Array.isArray(monitors))
    monitors.forEach((m: unknown) => {
      if (!m || typeof m !== "object") return;
      const { name, blocksWide, blocksHigh } = m as Record<string, unknown>;
      const wide = typeof blocksWide === "number" ? blocksWide : 1;
      const high = typeof blocksHigh === "number" ? blocksHigh : 1;
      if (wide > MONITOR_LIMIT.width || high > MONITOR_LIMIT.height)
        errors.push(monitorTooBig(String(name), wide, high));
    });

  let mc: string | undefined;
  try {
    mc = resolveVersion(w["version"] as WorldConfig["version"], env).mc;
  } catch (error) {
    errors.push((error as Error).message);
  }

  const peripherals = w["peripherals"];
  if (peripherals !== undefined && !Array.isArray(peripherals))
    errors.push("world.peripherals must be a list of {name, type, ...}");
  if (Array.isArray(peripherals) && mc) {
    const types = knownPeripheralTypes(mc);
    const names = new Set<string>();
    peripherals.forEach((p: unknown, i) => {
      const at = `world.peripherals[${i}]`;
      if (!p || typeof p !== "object") {
        errors.push(`${at} must be an object {name, type, ...}`);
        return;
      }
      const def = p as Record<string, unknown>;
      if (typeof def["name"] !== "string" || def["name"] === "")
        errors.push(
          `${at}.name is missing (the peripheral's side or network name, e.g. "left" or "chest_0")`,
        );
      else if (names.has(def["name"]))
        errors.push(`${at}.name ${JSON.stringify(def["name"])} is used twice`);
      else names.add(def["name"]);
      const type = def["type"];
      const generic = GENERIC_FIELDS.some((f) => def[f] !== undefined);
      if (type === "monitor") {
        errors.push(
          `${at}: monitors are not world peripherals; pass them in "monitors" ([{name, blocksWide, blocksHigh}])`,
        );
        return;
      }
      if (typeof type !== "string") {
        if (!generic)
          errors.push(
            `${at}.type is missing (e.g. "minecraft:chest", "modem", "playerDetector")`,
          );
        return;
      }
      if (types.has(type)) return;
      // CC:Tweaked's own types first: a near miss of "printer" is not some mod's "grinder"
      const own = [...types]
        .filter(([, from]) => from === "CC:Tweaked")
        .map(([t]) => t);
      const hint = didYouMean(type, own) ?? didYouMean(type, types.keys());
      if (generic) {
        // any block name works with generic storage fields; only a near miss of a known type is worth a word
        if (hint)
          warnings.push(
            `${at}.type "${type}" is not a type the sim knows, so it is a generic storage block.${mean(hint)}`,
          );
      } else {
        const from = hint ? types.get(hint) : undefined;
        errors.push(
          `${at}.type "${type}" is not a peripheral the sim can build.${mean(hint, from)} ` +
            "A block of your own name needs storage fields: size or items (inventory), tanks or fluid (fluid_storage), " +
            "energy or energyCapacity (energy_storage).",
        );
      }
    });
  }

  // an addon that is off or has no release for this version, as worldJson would refuse it at boot
  if (mc) {
    try {
      checkWorldAddons(
        w as Parameters<typeof checkWorldAddons>[0],
        resolveAddons(w["addons"] as WorldConfig["addons"], env, mc),
        mc,
        addonSource(w["addons"] as WorldConfig["addons"], env),
      );
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return { errors, warnings };
}

/** checkWorld, throwing its errors as one message. Returns the warnings. */
export function assertWorld(
  world: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const { errors, warnings } = checkWorld(world, env);
  if (errors.length)
    throw new WorldError(
      errors.length === 1
        ? errors[0]!
        : `the world has ${errors.length} problems:\n- ${errors.join("\n- ")}`,
    );
  return warnings;
}

export class WorldError extends Error {}

/** A monitor wall past the game's limit, said the same way wherever it is caught. */
export const monitorTooBig = (
  name: string,
  wide: number,
  high: number,
): string =>
  `monitor "${name}" is ${wide}x${high} blocks; a monitor wall is at most ${MONITOR_LIMIT.width}x${MONITOR_LIMIT.height} blocks (wide x high)`;

/** ROM program names (shell.resolveProgram finds them on the path): the file names under rom/programs. */
function romPrograms(romDir: string): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.add(name.replace(/\.lua$/, ""));
    }
  };
  walk(join(romDir, "rom", "programs"));
  return found;
}

/**
 * Whether the program a run starts will be on the computer: undefined when it is (or when that cannot be known
 * without copying, as with a deploy list of single files), else the message, with the nearest workspace program.
 */
export function checkProgram(
  config: RunnerConfig,
  program: string,
  world?: WorldConfig,
): string | undefined {
  // shell.run splits the command line: the program is the first word
  const name = program.trim().split(/\s+/)[0] ?? "";
  if (!name) return "program is empty";
  const path = posix.normalize(name.replace(/\\/g, "/").replace(/^\/+/, ""));
  const candidates = [path, `${path}.lua`];
  const deploy = world?.deploy?.length ? world.deploy : undefined;
  const onComputer = (p: string): boolean => {
    if (!deploy) return fileIn(config.workspaceDir, p);
    for (const entry of deploy) {
      const to = posix
        .normalize((entry.to ?? ".").replace(/\\/g, "/"))
        .replace(/^\/+|\/+$/g, "");
      const rest =
        to === "." || to === ""
          ? p
          : p.startsWith(`${to}/`)
            ? p.slice(to.length + 1)
            : undefined;
      try {
        const from = resolveInWorkspace(config.workspaceDir, entry.from);
        if (!existsSync(from)) continue;
        if (!statSync(from).isDirectory()) return true; // a single file: where it lands is the copy's business
        if (rest !== undefined && fileIn(from, rest)) return true;
      } catch {
        // a deploy entry that escapes the workspace fails the run itself, with its own message
      }
    }
    return false;
  };
  if (candidates.some(onComputer)) return undefined;
  if (!path.includes("/")) {
    try {
      const rom = romDirFor(config, resolveVersion(world?.version));
      if (romPrograms(rom).has(path.replace(/\.lua$/, ""))) return undefined;
    } catch {
      // an unknown version: checkWorld says so
    }
  }
  const where = deploy
    ? "on the computer (from the world's deploy list)"
    : `in the workspace ${config.workspaceDir}`;
  return `no program "${name}" ${where}.${mean(nearestProgram(config, path))}`;
}

/** Test paths that are not in the workspace, each with the nearest test file. Empty when all are there. */
export function checkTestPaths(
  config: RunnerConfig,
  paths: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const raw of paths) {
    const path = raw.replace(/\\/g, "/");
    let full: string;
    try {
      full = resolveInWorkspace(config.workspaceDir, path);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }
    if (existsSync(full)) continue;
    problems.push(
      `no ${path.endsWith(".lua") ? "file" : "folder"} "${raw}" in the workspace ${config.workspaceDir}.${mean(nearestProgram(config, path))}`,
    );
  }
  return problems;
}

function fileIn(root: string, rel: string): boolean {
  try {
    const full = resolveInWorkspace(root, rel);
    return existsSync(full) && statSync(full).isFile();
  } catch {
    return false;
  }
}

/** The workspace's Lua file most like `path`: the same file name in another folder first, then the closest name. */
function nearestProgram(
  config: RunnerConfig,
  path: string,
): string | undefined {
  let files: string[];
  try {
    files = listWorkspace(config.workspaceDir, ".", COPY_SKIP)
      .filter((e) => e.kind === "file" && e.path.endsWith(".lua"))
      .map((e) => e.path)
      .slice(0, 5000);
  } catch {
    return undefined;
  }
  const base = posix.basename(path).replace(/\.lua$/, "");
  const sameName = files.filter((f) => posix.basename(f, ".lua") === base);
  if (sameName.length) return sameName.sort((a, b) => a.length - b.length)[0];
  return didYouMean(path.endsWith(".lua") ? path : `${path}.lua`, files);
}
