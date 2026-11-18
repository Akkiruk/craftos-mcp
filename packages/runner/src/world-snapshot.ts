/**
 * World snapshots: the whole world of a SessionManager saved under a name and put back later, or shared as one file.
 * A snapshot holds every computer's folder (its files, disks, label, world file and the sim's state.json: players,
 * balances, chat, inventories, machines, the turtle and the blocks it changed), a block world's own blocks and the
 * computers it started, and the world's time of day. Restoring stops each computer, puts its folder back, and starts
 * it again: it boots into the snapshot as a computer in a reloaded world does.
 *
 * The world file a computer starts from is the snapshot's live world (core.lua liveWorld): who is online and where they
 * stand, the weather, entities and the virtual peripherals put down or taken away since boot, which a plain reboot
 * would otherwise start over from the world file.
 *
 * Kept as `<name>.craftos-world` (gzipped JSON) in the snapshots folder; that same file is what export and import move.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { BlockWorldSnapshot } from "./blockworld.js";
import { worldClockFor } from "./clock.js";
import type { RunnerConfig } from "./config.js";
import { COPY_SKIP, MAX_COPY_BYTES, MAX_COPY_FILES } from "./copy.js";
import { RUN_OWNER_FILE } from "./engine.js";
import { type Session, type SessionManager, VIEWER_OWNER } from "./sessions.js";
import type { WorldConfig } from "./world.js";

export const SNAPSHOT_EXT = ".craftos-world";
const FORMAT = "craftos-world";

/** What the app knows about a computer (webapp.ts Meta): how to make it again. */
export interface ComputerInfo {
  readonly name: string;
  readonly kind: "computer" | "pocket" | "turtle";
  readonly advanced: boolean;
  readonly network?: string | null;
  readonly program?: string | null;
}

export interface SnapshotComputer extends ComputerInfo {
  /** The session id it had when saved: a restore puts it back into that computer when it is still there. */
  readonly key: string;
  readonly running: boolean;
  /** Files of the computer's folder, by path from it (base64), and its empty folders. */
  readonly files: Record<string, string>;
  readonly dirs: string[];
  /**
   * A computer whose files are a folder of the person's, live (EngineHandle.liveDir). A restore that makes the
   * computer again uses the folder again, when it is there.
   */
  readonly liveDir?: string;
  /**
   * That folder's files as the computer saw them (its .git, node_modules and the like left out, as the computer
   * cannot see them), held by the first computer on it. A restore puts the folder back to exactly this: changed files
   * are written back and files made since are removed, each copied to a backup first (RestoreResult.folders).
   * Snapshots made before this was kept have none, and leave the folder alone.
   */
  readonly liveFiles?: { files: Record<string, string>; dirs: string[] };
  /** A turtle's or placed computer's world: its blocks and counters, and the folder its computers share. */
  readonly blockWorld?: {
    readonly state: BlockWorldSnapshot;
    readonly files: Record<string, string>;
    readonly dirs: string[];
  };
}

export interface WorldSnapshot {
  readonly format: typeof FORMAT;
  readonly version: 1;
  readonly name: string;
  readonly createdAt: string;
  /** The world's time of day (ms since day 1, 06:00), null when no computer said. */
  readonly worldMs: number | null;
  readonly computers: SnapshotComputer[];
}

export interface SnapshotInfo {
  readonly name: string;
  readonly createdAt: string;
  readonly time: string | null;
  readonly computers: { name: string; kind: string }[];
  readonly bytes: number;
  /** Folders of the person's (a project folder, live) whose files a restore puts back as the snapshot has them. */
  readonly folders: string[];
}

export interface SnapshotHooks {
  /** What the app knows about a session; default: its id as the name, a computer. */
  describe?(session: Session): ComputerInfo;
  /** A computer the restore made (it was gone): the app records what it knows about it. */
  adopt?(session: Session, info: ComputerInfo): void;
  /** A computer the restore closed (made after the snapshot): the app forgets it. */
  forget?(session: Session): void;
  /** A computer the restore started again: the app can run what it ran at first (its program). */
  started?(session: Session): void;
  /** Every computer the restore put back, made or kept, once its files and world are in place. */
  restored?(session: Session): void;
}

const registeredHooks = new WeakMap<SessionManager, SnapshotHooks>();

/** The app over a SessionManager says what it knows of its computers, for snapshots made elsewhere (the MCP tools). */
export function registerSnapshotHooks(
  sessions: SessionManager,
  hooks: SnapshotHooks,
): void {
  registeredHooks.set(sessions, hooks);
}

/** The hooks the app registered for this SessionManager, or none. */
export function snapshotHooksFor(sessions: SessionManager): SnapshotHooks {
  return registeredHooks.get(sessions) ?? {};
}

/** Where named snapshots live: CRAFTOS_SNAPSHOTS, else `snapshots` in the runtime folder. */
export function snapshotsDir(
  config: RunnerConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env["CRAFTOS_SNAPSHOTS"] ?? join(config.runtimeDir, "snapshots");
}

/** A snapshot name: letters, digits, spaces, `-`, `_` and `.`, at most 64, not starting with a dot. */
export function checkSnapshotName(name: string): string {
  const trimmed = name.trim();
  if (!/^[\w][\w .-]{0,63}$/.test(trimmed))
    throw new Error(
      `a snapshot name is letters, digits, spaces, - _ and . (at most 64), not "${name}"`,
    );
  return trimmed;
}

// ───────────────────────── folders ─────────────────────────

/** The engine's own bookkeeping, never part of a computer's world. */
const VOLATILE = new Set([
  RUN_OWNER_FILE,
  "results/waiting.json",
  "results/trace.log",
  "results/clock.json",
]);

function readTree(
  root: string,
  skip: (rel: string) => boolean = () => false,
): { files: Record<string, string>; dirs: string[] } {
  const files: Record<string, string> = {};
  const dirs: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    if (names.length === 0 && rel) dirs.push(rel);
    for (const name of names) {
      const path = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      let st;
      try {
        st = statSync(path); // follows a linked folder (a network's economy, a block world's disks)
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, r);
      else if (st.isFile()) files[r] = readFileSync(path).toString("base64");
    }
  };
  walk(root, "");
  return { files, dirs };
}

/** Empty a folder but keep what `keep` names, and keep linked folders as links (emptying what they point at). */
function clearTree(
  root: string,
  keep: (rel: string) => boolean,
  rel = "",
): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    const r = rel ? `${rel}/${name}` : name;
    if (keep(r)) continue;
    const st = lstatSync(path);
    if (st.isSymbolicLink()) clearTree(path, keep, r);
    else rmSync(path, { recursive: true, force: true });
  }
}

function writeTree(
  root: string,
  tree: { files: Record<string, string>; dirs: string[] },
): void {
  for (const dir of tree.dirs) mkdirSync(join(root, dir), { recursive: true });
  for (const [rel, data] of Object.entries(tree.files)) {
    if (rel.split("/").includes("..")) continue;
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
  }
}

// ───────────────────────── a person's folder, live ─────────────────────────

/**
 * What of a live folder the computer sees (engine.ts liveFolderArgs): all of it but the folders a copy leaves out
 * (COPY_SKIP: .git, node_modules, ...) and the runtime folder, at its top.
 */
function liveSkip(
  dir: string,
  runtimeDir: string | undefined,
): (rel: string) => boolean {
  const inside = runtimeDir ? relative(resolve(dir), resolve(runtimeDir)) : "";
  const runtimeTop =
    inside && !/[\\/]/.test(inside) && inside !== ".." && !isAbsolute(inside)
      ? inside
      : undefined;
  return (rel) =>
    !rel.includes("/") && (COPY_SKIP.has(rel) || rel === runtimeTop);
}

function readLiveFolder(
  dir: string,
  runtimeDir: string | undefined,
): { files: Record<string, string>; dirs: string[] } {
  const tree = readTree(dir, liveSkip(dir, runtimeDir));
  const files = Object.keys(tree.files).length;
  const bytes = Object.values(tree.files).reduce(
    (n, data) => n + (data.length * 3) / 4,
    0,
  );
  if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES)
    throw new Error(
      `${dir} holds ${files} files (${Math.round(bytes / 1e6)} MB), too much for a snapshot to keep. Give the ` +
        "computer a smaller folder, or a scratch copy (the New computer form's files), whose files a snapshot keeps.",
    );
  return tree;
}

export interface FolderRestore {
  /** The person's folder put back. */
  readonly dir: string;
  /** Files written back (changed or deleted since the snapshot), by path in the folder. */
  readonly written: string[];
  /** Files made since the snapshot, removed. */
  readonly removed: string[];
  /** Where what the restore overwrote or removed was copied first; absent when nothing was. */
  readonly backup?: string;
}

/** Where a restore copies a folder's files before it overwrites or removes them. */
export function restoreBackupsDir(
  config: Pick<RunnerConfig, "runtimeDir">,
): string {
  return join(config.runtimeDir, "restore-backups");
}

/**
 * Put a live folder back to `saved`: files that differ or are gone are written, files the snapshot did not have are
 * removed, and folders left empty by that go too. Each file overwritten or removed is copied to `backupDir` first.
 */
function restoreLiveFolder(
  dir: string,
  saved: { files: Record<string, string>; dirs: string[] },
  runtimeDir: string | undefined,
  backupDir: string,
): FolderRestore {
  const now = readTree(dir, liveSkip(dir, runtimeDir));
  const written: string[] = [];
  const removed: string[] = [];
  let backedUp = false;
  const backup = (rel: string, data: string): void => {
    const to = join(backupDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, Buffer.from(data, "base64"));
    backedUp = true;
  };
  for (const [rel, data] of Object.entries(now.files)) {
    if (saved.files[rel] !== undefined) continue;
    backup(rel, data);
    rmSync(join(dir, rel), { force: true });
    removed.push(rel);
  }
  for (const [rel, data] of Object.entries(saved.files)) {
    if (rel.split("/").includes("..")) continue;
    const current = now.files[rel];
    if (current === data) continue;
    if (current !== undefined) backup(rel, current);
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
    written.push(rel);
  }
  for (const rel of saved.dirs) mkdirSync(join(dir, rel), { recursive: true });
  // folders emptied by the removals, unless the snapshot had them
  const keep = new Set(saved.dirs);
  for (const rel of Object.keys(saved.files)) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++)
      keep.add(parts.slice(0, i).join("/"));
  }
  for (const rel of removed) {
    const parts = rel.split("/");
    for (let i = parts.length - 1; i >= 1; i--) {
      const folder = parts.slice(0, i).join("/");
      if (keep.has(folder)) break;
      try {
        if (readdirSync(join(dir, folder)).length > 0) break;
        rmSync(join(dir, folder), { recursive: true, force: true });
      } catch {
        break;
      }
    }
  }
  return {
    dir,
    written: written.sort(),
    removed: removed.sort(),
    ...((backedUp as boolean) ? { backup: backupDir } : {}),
  };
}

// ───────────────────────── the live world ─────────────────────────

const LIVE_KEYS = [
  "players",
  "host",
  "environment",
  "entities",
  "position",
  "peripherals",
];
const LIST_KEYS = new Set(["players", "entities", "peripherals"]);

/**
 * The world file a restored computer starts from: the saved one with what the sim says the world is now (state.json
 * `live`). CC's JSON writes an empty list as {}, put back as [].
 */
export function liveWorldText(
  worldText: string,
  stateText: string | undefined,
): string {
  let world: Record<string, unknown>;
  try {
    world = JSON.parse(worldText) as Record<string, unknown>;
  } catch {
    return worldText;
  }
  let live: Record<string, unknown> | undefined;
  try {
    live = stateText
      ? ((JSON.parse(stateText) as { live?: Record<string, unknown> }).live ??
        undefined)
      : undefined;
  } catch {
    live = undefined;
  }
  if (!live) return worldText;
  for (const key of LIVE_KEYS) {
    let value = live[key];
    if (
      LIST_KEYS.has(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    )
      value = [];
    if (value === undefined) delete world[key];
    else world[key] = value;
  }
  return JSON.stringify(world, null, 2);
}

// ───────────────────────── save ─────────────────────────

function defaultInfo(session: Session): ComputerInfo {
  return {
    name: `session ${session.id}`,
    kind: session.blockWorld ? "turtle" : "computer",
    advanced: true,
  };
}

/**
 * The whole world as it stands. Pauses it first (and resumes it after, if it ran) so every computer is between events
 * and has written its state: the snapshot is one moment for all of them.
 */
export async function captureWorld(
  sessions: SessionManager,
  name: string,
  hooks: SnapshotHooks = {},
  config?: Pick<RunnerConfig, "runtimeDir">,
): Promise<WorldSnapshot> {
  const clock = worldClockFor(sessions);
  const wasPaused = clock.current.paused;
  if (!wasPaused) await clock.pause(5000);
  try {
    const worldMs = (await clock.status()).worldMs;
    const computers: SnapshotComputer[] = [];
    // a folder several computers share is kept once, with the first of them
    const folders = new Set<string>();
    for (const summary of sessions.list()) {
      const session = sessions.get(summary.id);
      const { handle } = session;
      const info = (hooks.describe ?? defaultInfo)(session);
      const tree = readTree(handle.dir, (rel) => VOLATILE.has(rel));
      const worldText = tree.files["results/world.json"];
      if (worldText !== undefined) {
        const stateText = tree.files["results/state.json"];
        tree.files["results/world.json"] = Buffer.from(
          liveWorldText(
            Buffer.from(worldText, "base64").toString("utf8"),
            stateText === undefined
              ? undefined
              : Buffer.from(stateText, "base64").toString("utf8"),
          ),
        ).toString("base64");
      }
      const host = session.blockWorld?.host;
      const liveDir = handle.liveDir;
      const firstOnFolder = !!liveDir && !folders.has(resolve(liveDir));
      if (liveDir) folders.add(resolve(liveDir));
      computers.push({
        ...info,
        key: session.id,
        running: handle.session.running,
        files: tree.files,
        dirs: tree.dirs,
        ...(liveDir && { liveDir }),
        ...(firstOnFolder && {
          liveFiles: readLiveFolder(liveDir!, config?.runtimeDir),
        }),
        ...(host && {
          blockWorld: {
            state: host.snapshotState(),
            ...readTree(host.sharedDir),
          },
        }),
      });
    }
    return {
      format: FORMAT,
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      worldMs,
      computers,
    };
  } finally {
    if (!wasPaused) await clock.resume();
  }
}

// ───────────────────────── restore ─────────────────────────

export interface RestoreResult {
  /** Computers put back into the snapshot, by session id. */
  readonly restored: string[];
  /** Of those, the ones that were gone and were made again. */
  readonly made: string[];
  /** The app's computers made after the snapshot, closed. */
  readonly closed: string[];
  /** The person's folders put back (computers on a project folder, live): what was written and removed. */
  readonly folders: FolderRestore[];
}

async function putBack(
  session: Session,
  saved: SnapshotComputer,
): Promise<void> {
  const { handle } = session;
  if (handle.session.running) await handle.session.stop();
  const host = session.blockWorld?.host;
  if (host && saved.blockWorld) {
    await host.restoreState(saved.blockWorld.state);
    clearTree(host.sharedDir, () => false);
    writeTree(host.sharedDir, saved.blockWorld);
  }
  clearTree(handle.dir, (rel) => rel === RUN_OWNER_FILE);
  writeTree(handle.dir, saved);
  if (saved.running) handle.restart();
  if (host && saved.blockWorld) host.startAgain(saved.blockWorld.state.running);
}

/** The live folder a saved computer used, if it is still there (a snapshot from another machine has none). */
function liveDirOf(saved: SnapshotComputer): string | undefined {
  return typeof saved.liveDir === "string" && existsSync(saved.liveDir)
    ? saved.liveDir
    : undefined;
}

function worldOf(saved: SnapshotComputer): WorldConfig {
  const text = saved.files["results/world.json"];
  if (text === undefined) return {};
  return JSON.parse(
    Buffer.from(text, "base64").toString("utf8"),
  ) as WorldConfig;
}

/**
 * Put the world back as the snapshot has it. Computers still here are restored in place; computers that are gone are
 * made again (a network's together); the app's own computers that the snapshot does not have are closed. An agent's
 * computers the snapshot does not have are left alone.
 */
export async function applyWorld(
  sessions: SessionManager,
  snapshot: WorldSnapshot,
  hooks: SnapshotHooks = {},
  config?: Pick<RunnerConfig, "runtimeDir">,
): Promise<RestoreResult> {
  if (
    snapshot.format !== FORMAT ||
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.computers)
  )
    throw new Error("not a craftos world snapshot");
  const describe = hooks.describe ?? defaultInfo;
  const live = new Map(sessions.list().map((s) => [s.id, sessions.get(s.id)]));
  const targets = new Map<SnapshotComputer, Session>();
  const taken = new Set<string>();
  // the same computer first, then one of the same name
  for (const saved of snapshot.computers) {
    const same = live.get(saved.key);
    if (same && !taken.has(same.id)) {
      targets.set(saved, same);
      taken.add(same.id);
    }
  }
  for (const saved of snapshot.computers) {
    if (targets.has(saved)) continue;
    const named = [...live.values()].find(
      (s) =>
        !taken.has(s.id) &&
        describe(s).name === saved.name &&
        !!s.blockWorld === !!saved.blockWorld,
    );
    if (named) {
      targets.set(saved, named);
      taken.add(named.id);
    }
  }
  // what is gone is made again: one computer alone, a network's computers together
  const made: string[] = [];
  const missing = snapshot.computers.filter((c) => !targets.has(c));
  const groups = new Map<string, SnapshotComputer[]>();
  for (const saved of missing) {
    const key = saved.network ? `net:${saved.network}` : `one:${saved.key}`;
    groups.set(key, [...(groups.get(key) ?? []), saved]);
  }
  for (const group of groups.values()) {
    if (group.length > 1 || group[0]!.network) {
      const linked = sessions.createNetwork({
        computers: group.map((saved) => ({
          name: saved.name,
          world: worldOf(saved),
          ...(liveDirOf(saved) && { liveDir: liveDirOf(saved) }),
        })),
      });
      group.forEach((saved) => {
        const session = linked.computers[saved.name]!;
        targets.set(saved, session);
      });
    } else {
      targets.set(
        group[0]!,
        sessions.create(
          [],
          1,
          worldOf(group[0]!),
          undefined,
          undefined,
          undefined,
          liveDirOf(group[0]!),
        ),
      );
    }
    for (const saved of group) {
      const session = targets.get(saved)!;
      sessions.setOwner(session.id, VIEWER_OWNER);
      hooks.adopt?.(session, saved);
      made.push(session.id);
    }
  }
  // the app's computers made after the snapshot go
  const closed: string[] = [];
  const kept = new Set([...targets.values()].map((s) => s.id));
  for (const session of live.values()) {
    if (kept.has(session.id) || sessions.ownerOf(session.id) !== VIEWER_OWNER)
      continue;
    hooks.forget?.(session);
    await sessions.destroy(session.id);
    closed.push(session.id);
  }
  // the person's folders: every computer on one stops first, so none writes while it is put back
  const folders: FolderRestore[] = [];
  const onFolders = [...targets].filter(([saved]) => saved.liveFiles);
  if (onFolders.length) {
    await Promise.all(
      [...targets.values()].map(async (session) => {
        if (session.handle.liveDir && session.handle.session.running)
          await session.handle.session.stop();
      }),
    );
    // the person's own clock: "2026-11-17 21.40.05"
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    const backupsRoot = config
      ? restoreBackupsDir(config)
      : join(tmpdir(), "craftos-restore-backups");
    for (const [saved, session] of onFolders) {
      const dir = session.handle.liveDir;
      // only the folder it was saved from: a computer now on another folder (another project) keeps that one as is
      if (!dir || !saved.liveFiles || !saved.liveDir) continue;
      if (resolve(dir) !== resolve(saved.liveDir)) continue;
      const backup = join(
        backupsRoot,
        `${checkSnapshotName(snapshot.name)} ${stamp}`,
        folders.length
          ? `${basename(dir)} ${folders.length + 1}`
          : basename(dir),
      );
      folders.push(
        restoreLiveFolder(dir, saved.liveFiles, config?.runtimeDir, backup),
      );
    }
  }
  await Promise.all(
    [...targets].map(([saved, session]) => putBack(session, saved)),
  );
  if (snapshot.worldMs !== null)
    await worldClockFor(sessions).setWorldTime(snapshot.worldMs);
  for (const [saved, session] of targets) {
    hooks.restored?.(session);
    if (saved.running) hooks.started?.(session);
  }
  return { restored: [...kept], made, closed, folders };
}

// ───────────────────────── the snapshots folder ─────────────────────────

function fileOf(config: RunnerConfig, name: string): string {
  return join(
    snapshotsDir(config),
    `${checkSnapshotName(name)}${SNAPSHOT_EXT}`,
  );
}

export function encodeSnapshot(snapshot: WorldSnapshot): Buffer {
  return gzipSync(JSON.stringify(snapshot));
}

export function decodeSnapshot(data: Buffer): WorldSnapshot {
  let snapshot: WorldSnapshot;
  try {
    snapshot = JSON.parse(gunzipSync(data).toString("utf8")) as WorldSnapshot;
  } catch {
    throw new Error("not a craftos world snapshot (a .craftos-world file)");
  }
  if (snapshot?.format !== FORMAT || !Array.isArray(snapshot.computers))
    throw new Error("not a craftos world snapshot (a .craftos-world file)");
  if (snapshot.version !== 1)
    throw new Error(
      `this snapshot is version ${snapshot.version}; this craftos-mcp reads version 1`,
    );
  return snapshot;
}

function infoOf(snapshot: WorldSnapshot, bytes: number): SnapshotInfo {
  const time =
    snapshot.worldMs === null
      ? null
      : (() => {
          const ms = snapshot.worldMs;
          const day = Math.floor(ms / 1_200_000) + 1;
          const hours = (((ms + 300_000) % 1_200_000) / 50_000) % 24;
          const h = Math.floor(hours);
          const m = Math.floor((hours - h) * 60);
          return `Day ${day}, ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        })();
  return {
    name: snapshot.name,
    createdAt: snapshot.createdAt,
    time,
    computers: snapshot.computers.map((c) => ({ name: c.name, kind: c.kind })),
    bytes,
    folders: snapshot.computers.flatMap((c) =>
      c.liveFiles && c.liveDir ? [c.liveDir] : [],
    ),
  };
}

/** Save the world under `name` (replacing a snapshot of that name). */
export async function saveSnapshot(
  sessions: SessionManager,
  config: RunnerConfig,
  name: string,
  hooks: SnapshotHooks = {},
): Promise<SnapshotInfo> {
  const clean = checkSnapshotName(name);
  if (sessions.list().length === 0)
    throw new Error("there are no computers to save");
  const snapshot = await captureWorld(sessions, clean, hooks, config);
  const data = encodeSnapshot(snapshot);
  mkdirSync(snapshotsDir(config), { recursive: true });
  writeFileSync(fileOf(config, clean), data);
  return infoOf(snapshot, data.length);
}

export function readSnapshot(
  config: RunnerConfig,
  name: string,
): WorldSnapshot {
  const file = fileOf(config, name);
  if (!existsSync(file)) throw new Error(`no snapshot named ${name}`);
  return decodeSnapshot(readFileSync(file));
}

/** The saved file itself, for export. */
export function snapshotFile(config: RunnerConfig, name: string): Buffer {
  const file = fileOf(config, name);
  if (!existsSync(file)) throw new Error(`no snapshot named ${name}`);
  return readFileSync(file);
}

export function listSnapshots(config: RunnerConfig): SnapshotInfo[] {
  const dir = snapshotsDir(config);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(SNAPSHOT_EXT));
  } catch {
    return [];
  }
  const out: SnapshotInfo[] = [];
  for (const file of names) {
    try {
      const data = readFileSync(join(dir, file));
      const snapshot = decodeSnapshot(data);
      out.push({
        ...infoOf(snapshot, data.length),
        name: file.slice(0, -SNAPSHOT_EXT.length),
      });
    } catch {
      // not ours, or half written: not listed
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteSnapshot(config: RunnerConfig, name: string): void {
  const file = fileOf(config, name);
  if (!existsSync(file)) throw new Error(`no snapshot named ${name}`);
  rmSync(file);
}

/** Take in a shared .craftos-world file, under `name` or the name inside it. */
export function importSnapshot(
  config: RunnerConfig,
  data: Buffer,
  name?: string,
): SnapshotInfo {
  const snapshot = decodeSnapshot(data);
  const clean = checkSnapshotName(name ?? snapshot.name);
  const renamed =
    clean === snapshot.name
      ? data
      : encodeSnapshot({ ...snapshot, name: clean });
  mkdirSync(snapshotsDir(config), { recursive: true });
  writeFileSync(fileOf(config, clean), renamed);
  return infoOf({ ...snapshot, name: clean }, renamed.length);
}

/** Put the world back as the named snapshot has it (applyWorld). */
export async function restoreSnapshot(
  sessions: SessionManager,
  config: RunnerConfig,
  name: string,
  hooks: SnapshotHooks = {},
): Promise<RestoreResult> {
  return applyWorld(sessions, readSnapshot(config, name), hooks, config);
}
