// Bring computers over from CraftOS-PC: read its data folder (computer/<id> files, config/global.json and
// config/<id>.json, the peripherals its startup files attach with periphemu.create) and write a craftos-mcp project
// from it: craftos.json, each computer's files under computer/<id>, and a world file for each. The CraftOS-PC folder is
// only read, never changed. `craftos-mcp import craftos-pc` and the browser app (/api/craftos-pc) both use this.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MonitorSpec } from "./lua.js";
import { PROJECT_FILE, type ProjectFile } from "./project.js";
import { NEWEST_MC } from "./versions.js";
import type { WorldFile } from "./world.js";

const PROJECT_SCHEMA =
  "https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/schemas/craftos.schema.json";
const WORLD_SCHEMA =
  "https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/schemas/world.schema.json";

/** A peripheral one of CraftOS-PC's startup files attaches: periphemu.create(side, type, ...). */
export interface CraftosPcAttach {
  readonly side: string;
  readonly type: string;
  /** The literal arguments after the type, as written. */
  readonly args: readonly string[];
  /** The file it is in, relative to the computer's folder. */
  readonly file: string;
}

export interface CraftosPcComputer {
  readonly id: number;
  /** Its folder in the CraftOS-PC data folder. */
  readonly dir: string;
  readonly label?: string;
  readonly isColor: boolean;
  /** Its own terminal size (CraftOS-PC's computerWidth / computerHeight), else the global default. */
  readonly width: number;
  readonly height: number;
  readonly files: number;
  readonly bytes: number;
  readonly attaches: readonly CraftosPcAttach[];
  /** Its Lua calls CraftOS-PC's periphemu or mounter (craftos-mcp hides them unless the world turns them on). */
  readonly usesCraftosPcApis: boolean;
}

export interface CraftosPcData {
  readonly folder: string;
  readonly computers: readonly CraftosPcComputer[];
  /** The id CraftOS-PC opens first (initialComputer). */
  readonly initial: number;
  /** Floppy disks (computer/disk/<id>), by id. */
  readonly disks: readonly number[];
  /** Things that do not come across, in plain words. */
  readonly notes: readonly string[];
}

/** Where CraftOS-PC keeps its data on this kind of machine, most likely first. */
export function craftosPcFolders(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  if (platform === "win32")
    return [
      join(env["APPDATA"] ?? join(home, "AppData", "Roaming"), "CraftOS-PC"),
    ];
  if (platform === "darwin")
    return [join(home, "Library", "Application Support", "CraftOS-PC")];
  const data = env["XDG_DATA_HOME"] || join(home, ".local", "share");
  return [join(data, "craftos-pc"), join(home, ".craftos")];
}

/** The CraftOS-PC data folder on this machine, if there is one. */
export function findCraftosPc(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | undefined {
  return craftosPcFolders(env, platform, home).find((f) =>
    isCraftosPcFolder(f),
  );
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A folder with computer/ or config/global.json, as CraftOS-PC makes. */
export function isCraftosPcFolder(folder: string): boolean {
  return (
    isDir(join(folder, "computer")) ||
    existsSync(join(folder, "config", "global.json"))
  );
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Every file under a folder, relative to it, with its size. Links are not followed. */
function walk(dir: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  const visit = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile())
        out.push({
          path: relative(dir, full).split("\\").join("/"),
          size: statSync(full).size,
        });
    }
  };
  visit(dir);
  return out;
}

const PERIPHEMU_CREATE =
  /\bperiphemu\s*\.\s*create\s*\(\s*(["'])([^"'\n]+)\1\s*,\s*(["'])([^"'\n]+)\3\s*((?:,[^)\n]*)?)\)/g;
const CRAFTOS_PC_API = /\b(?:periphemu|mounter)\s*\.\s*[A-Za-z_]/;

/** The periphemu.create calls with literal side and type in one Lua file. */
export function findAttaches(source: string, file: string): CraftosPcAttach[] {
  const out: CraftosPcAttach[] = [];
  for (const m of source.matchAll(PERIPHEMU_CREATE)) {
    const rest = (m[5] ?? "")
      .replace(/^\s*,/, "")
      .split(",")
      .map((a) => a.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    out.push({ side: m[2]!, type: m[4]!, args: rest, file });
  }
  return out;
}

/** The startup files CraftOS-PC runs at boot: startup, startup.lua and startup/*. */
const isStartup = (path: string): boolean =>
  /^startup(\.lua)?$/.test(path) || /^startup\/[^/]+$/.test(path);

/** Read a CraftOS-PC data folder. Throws when it is not one. */
export function readCraftosPc(folder: string): CraftosPcData {
  const root = resolve(folder);
  if (!isCraftosPcFolder(root))
    throw new Error(
      `${root} is not a CraftOS-PC data folder (it has no computer folder and no config/global.json)`,
    );
  const global = readJson(join(root, "config", "global.json")) ?? {};
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d;
  const defaultWidth = num(global["defaultWidth"], 51);
  const defaultHeight = num(global["defaultHeight"], 19);
  const notes: string[] = [];
  const computers: CraftosPcComputer[] = [];
  const computerRoot = join(root, "computer");
  const ids = isDir(computerRoot)
    ? readdirSync(computerRoot)
        .filter((n) => /^\d+$/.test(n) && isDir(join(computerRoot, n)))
        .map(Number)
        .sort((a, b) => a - b)
    : [];
  for (const id of ids) {
    const dir = join(computerRoot, String(id));
    const cfg = readJson(join(root, "config", `${id}.json`)) ?? {};
    let label: string | undefined;
    if (typeof cfg["label"] === "string" && cfg["label"]) {
      label =
        cfg["base64"] === true
          ? Buffer.from(cfg["label"], "base64").toString("utf8")
          : cfg["label"];
    }
    const files = walk(dir);
    const attaches: CraftosPcAttach[] = [];
    let usesApis = false;
    for (const f of files) {
      if (f.size > 1_000_000) continue;
      const lua = f.path.endsWith(".lua") || !f.path.includes(".");
      if (!lua) continue;
      let text: string;
      try {
        text = readFileSync(join(dir, f.path), "utf8");
      } catch {
        continue;
      }
      if (CRAFTOS_PC_API.test(text)) usesApis = true;
      if (isStartup(f.path)) attaches.push(...findAttaches(text, f.path));
    }
    computers.push({
      id,
      dir,
      ...(label && { label }),
      isColor: cfg["isColor"] !== false,
      width: num(cfg["computerWidth"], defaultWidth),
      height: num(cfg["computerHeight"], defaultHeight),
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
      attaches,
      usesCraftosPcApis: usesApis,
    });
  }
  const diskRoot = join(computerRoot, "disk");
  const disks = isDir(diskRoot)
    ? readdirSync(diskRoot)
        .filter((n) => /^\d+$/.test(n) && isDir(join(diskRoot, n)))
        .map(Number)
        .sort((a, b) => a - b)
    : [];
  if (global["http_enable"] === false)
    notes.push(
      "CraftOS-PC had HTTP turned off; here http is on, as on a server with the default config.",
    );
  if (global["mount_mode"] === 3 || global["showMountPrompt"] === false)
    notes.push(
      "Folders mounted from your PC (mount) do not come across: copy what a computer needs into its folder.",
    );
  const initial = num(global["initialComputer"], 0);
  return {
    folder: root,
    computers,
    initial: computers.some((c) => c.id === initial)
      ? initial
      : (computers[0]?.id ?? 0),
    disks,
    notes,
  };
}

/** What one imported computer became. */
export interface ImportedComputer {
  readonly id: number;
  readonly label?: string;
  /** Its files in the new project, absolute. */
  readonly dir: string;
  /** Its world file, absolute. */
  readonly worldFile: string;
  /** The world, as written (without $schema). */
  readonly world: WorldFile;
  readonly files: number;
}

export interface ImportResult {
  readonly from: string;
  readonly project: string;
  readonly projectFile: string;
  readonly computers: readonly ImportedComputer[];
  readonly notes: readonly string[];
}

export interface ImportOptions {
  /** Replace files of an earlier import in `out`. */
  readonly force?: boolean;
  /** Only these computer ids (default all). */
  readonly ids?: readonly number[];
}

/** A drive's floppy: text files only (a world's disks are text), up to 1 MB in all. */
function diskFiles(dir: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let total = 0;
  for (const f of walk(dir)) {
    total += f.size;
    if (total > 1_000_000) return undefined;
    const buf = readFileSync(join(dir, f.path));
    if (buf.includes(0)) return undefined;
    out[f.path] = buf.toString("utf8");
  }
  return out;
}

/** The world a CraftOS-PC computer starts in here. Notes say what changed on the way. */
export function worldFor(
  computer: CraftosPcComputer,
  notes: string[],
): WorldFile {
  const world: WorldFile = { computerId: computer.id };
  if (computer.label) world.label = computer.label;
  if (!computer.isColor) world.advanced = false;
  if (computer.width !== 51 || computer.height !== 19)
    world.terminal = { width: computer.width, height: computer.height };
  const peripherals: NonNullable<WorldFile["peripherals"]> = [];
  const monitors: MonitorSpec[] = [];
  const taken = new Set<string>();
  const name = `computer ${computer.id}${computer.label ? ` (${computer.label})` : ""}`;
  for (const a of computer.attaches) {
    if (taken.has(a.side)) continue;
    taken.add(a.side);
    switch (a.type) {
      case "monitor":
        // 5x3 blocks is 50x19 characters, about the size of CraftOS-PC's monitor window
        monitors.push({ name: a.side, blocksWide: 5, blocksHigh: 3 });
        break;
      case "speaker":
        peripherals.push({ name: a.side, type: "speaker" });
        break;
      case "modem":
        peripherals.push({ name: a.side, type: "modem" });
        break;
      case "drive": {
        const disk = Number(a.args[0]);
        peripherals.push({
          name: a.side,
          type: "drive",
          ...(Number.isInteger(disk) && disk >= 0 && { disk }),
        });
        break;
      }
      case "chest":
      case "minecraft:chest":
        peripherals.push({ name: a.side, type: "minecraft:chest", size: 27 });
        break;
      case "tank":
        peripherals.push({ name: a.side, type: "fluid_storage" });
        break;
      case "energy":
        peripherals.push({ name: a.side, type: "energy_storage" });
        break;
      case "printer":
        // CraftOS-PC's printer never runs out; a real one needs ink and paper, so it starts with a stack of each
        peripherals.push({ name: a.side, type: "printer", ink: 64, paper: 64 });
        notes.push(
          `${name}: the printer on ${a.side} (${a.file}) prints pages you see in the sim state and the app, not a file; it starts with 64 black dye and 64 paper.`,
        );
        break;
      case "computer":
        notes.push(
          `${name}: the computer attached on ${a.side} (${a.file}) is not brought over; computers here talk over modems (a network in the app).`,
        );
        break;
      default:
        notes.push(
          `${name}: the ${a.type} on ${a.side} (${a.file}) has no counterpart here and is left out.`,
        );
    }
  }
  if (monitors.length)
    notes.push(
      `${name}: its monitors are walls of 5x3 blocks here (50x19 characters; a real monitor is a wall of blocks); change blocksWide/blocksHigh in its world file.`,
    );
  if (peripherals.length) world.peripherals = peripherals;
  if (monitors.length) world.monitors = monitors;
  if (computer.usesCraftosPcApis) {
    world.craftosPcApis = true;
    notes.push(
      `${name}: its programs use CraftOS-PC's periphemu or mounter, which a real computer does not have. craftosPcApis is on in its world so they still run; the peripherals are in the world file too, so once those calls are gone you can turn it off.`,
    );
  }
  return world;
}

/** The world file's name for a computer. */
export const worldFileName = (id: number): string =>
  `computer-${id}.world.json`;

/**
 * Write a craftos-mcp project at `out` from a CraftOS-PC data folder: computer/<id> (the files), computer-<id>.world.json
 * and craftos.json (the first computer's). Refuses to write over an earlier one unless `force`.
 */
export function importCraftosPc(
  folder: string,
  out: string,
  options: ImportOptions = {},
): ImportResult {
  const data = readCraftosPc(folder);
  const project = resolve(out);
  const inside = relative(data.folder, project);
  if (!inside || (!inside.startsWith("..") && !isAbsolute(inside)))
    throw new Error(
      "the new project cannot go inside the CraftOS-PC folder: pick another folder",
    );
  const chosen = options.ids
    ? data.computers.filter((c) => options.ids!.includes(c.id))
    : data.computers;
  if (chosen.length === 0)
    throw new Error(
      options.ids
        ? `no computer ${options.ids.join(", ")} in ${data.folder}`
        : `${data.folder} has no computers (computer/<id> folders)`,
    );
  const projectFile = join(project, PROJECT_FILE);
  if (!options.force) {
    const clash = [
      projectFile,
      ...chosen.flatMap((c) => [
        join(project, "computer", String(c.id)),
        join(project, worldFileName(c.id)),
      ]),
    ].find((p) => existsSync(p));
    if (clash)
      throw new Error(
        `${clash} is there already from an earlier import: pick another folder, or replace it`,
      );
  }
  mkdirSync(project, { recursive: true });
  const notes = [...data.notes];
  const computers: ImportedComputer[] = [];
  for (const c of chosen) {
    const dir = join(project, "computer", String(c.id));
    mkdirSync(dir, { recursive: true });
    cpSync(c.dir, dir, { recursive: true, force: true, dereference: false });
    const world = worldFor(c, notes);
    const drives = (world.peripherals ?? []).filter((p) => p.type === "drive");
    if (drives.length && data.disks.length) {
      const disks: Record<string, Record<string, string>> = {};
      for (const id of data.disks) {
        const files = diskFiles(
          join(data.folder, "computer", "disk", String(id)),
        );
        if (files) disks[String(id)] = files;
        else
          notes.push(
            `disk ${id} is not brought over: a world's disks hold text files, up to 1 MB in all.`,
          );
      }
      if (Object.keys(disks).length) world.disks = disks;
    }
    const worldFile = join(project, worldFileName(c.id));
    writeFileSync(
      worldFile,
      `${JSON.stringify({ $schema: WORLD_SCHEMA, ...world }, null, 2)}\n`,
    );
    computers.push({
      id: c.id,
      ...(c.label && { label: c.label }),
      dir,
      worldFile,
      world,
      files: c.files,
    });
  }
  const main = computers.find((c) => c.id === data.initial) ?? computers[0]!;
  const projectData: ProjectFile = {
    $schema: PROJECT_SCHEMA,
    workspace: `computer/${main.id}`,
    // CraftOS-PC follows the newest CC:Tweaked, and has no mods
    minecraft: NEWEST_MC,
    addons: "none",
    world: worldFileName(main.id),
  };
  writeFileSync(projectFile, `${JSON.stringify(projectData, null, 2)}\n`);
  return { from: data.folder, project, projectFile, computers, notes };
}

/**
 * The computers of a project an import wrote (computer-<id>.world.json next to computer/<id>), to start them again.
 * Empty when the folder has none.
 */
export function importedComputers(project: string): ImportedComputer[] {
  const dir = resolve(project);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ImportedComputer[] = [];
  for (const name of names) {
    const m = /^computer-(\d+)\.world\.json$/.exec(name);
    if (!m) continue;
    const id = Number(m[1]);
    const files = join(dir, "computer", String(id));
    if (!isDir(files)) continue;
    const raw = readJson(join(dir, name));
    if (!raw) continue;
    const { $schema: _schema, ...world } = raw as WorldFile;
    out.push({
      id,
      ...(typeof world.label === "string" &&
        world.label && { label: world.label }),
      dir: files,
      worldFile: join(dir, name),
      world,
      files: walk(files).length,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}
