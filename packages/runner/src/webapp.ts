/**
 * The browser app: a local web server for people without an AI agent. It makes computers (one, or a network), shows
 * the terminal, every monitor and every pixel screen live, takes keys, touches and sim commands, and shows the
 * computer's files. The page itself is plain HTML, CSS and JS in ../webapp/, served as it is.
 *
 * The MCP server's viewer is this same app over the MCP server's own SessionManager, plus the screens of its last
 * one-shot run (`lastRun`).
 */
import {
  existsSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { craftosPcApi } from "./craftospc-webapp.js";
import { findProject } from "./project.js";
import {
  type KeyName,
  Keys,
  type WindowState,
  renderPng,
} from "@craftos-mcp/rawterm";
import { ADDONS, addonVersion, resolveAddons } from "./addons.js";
import { DEFAULT_MC, VERSIONS, ensureRom, resolveVersion } from "./versions.js";
import { type RunnerConfig, checkConfig } from "./config.js";
import {
  TERMINATE_HOLD_MS,
  holdKey,
  powerCycle,
  sendCommandResult,
  touchMonitorAs,
} from "./drive.js";
import {
  type ScreenCapture,
  captureScreens,
  parseDebugLink,
  pixelScreenPng,
  pixelScreens,
} from "./engine.js";
import { MONITOR_LIMIT, type MonitorSpec } from "./lua.js";
import {
  type Session,
  type SessionManager,
  VIEWER_OWNER,
  waitForBoot,
} from "./sessions.js";
import { describeAll } from "./ui.js";
import { listWorkspace, resolveInWorkspace } from "./workspace.js";
import { COPY_SKIP, copyWorkspaceAsync } from "./copy.js";
import { assertWorld } from "./validate.js";
// time controls: the clock bar and world snapshots (webapp-time.ts, webapp/timecontrol.js)
import { worldClockFor } from "./clock.js";
import { timeRoutes } from "./webapp-time.js";
import {
  SNAPSHOT_EXT,
  type SnapshotHooks,
  importSnapshot,
  registerSnapshotHooks,
  restoreSnapshot,
} from "./world-snapshot.js";
import { createViews } from "./webapp-views.js";
import { WorldPanel } from "./webapp-world.js";
import {
  type ModemSpec,
  type SimCommand,
  type WorldConfig,
  loadNamedWorld,
  shownState,
} from "./world.js";

export interface WebAppOptions {
  readonly port: number;
  readonly sessions: SessionManager;
  readonly config: RunnerConfig;
  /** Screens of the most recent one-shot run (the MCP server's craftos_run), shown read-only. */
  readonly lastRun?: () =>
    | { label: string; screens: ScreenCapture[] }
    | undefined;
  /** Called once the server listens, with its URL. Default: a line on stderr. */
  readonly onListening?: (url: string) => void;
  /** When `port` is taken, listen on a free one instead of failing (the MCP server's viewer). */
  readonly portFallback?: boolean;
  /** Time controls: open with this world snapshot restored (a name in the snapshots folder, or a .craftos-world file). */
  readonly snapshot?: string;
  /**
   * Where a new computer's files are when the form does not say (FilesMode): "project", the project folder itself,
   * live (the default: a person's work lands in their folder); or "copy", a scratch copy that goes with the computer.
   */
  readonly files?: FilesMode;
}

/**
 * Where a computer's files are: "project" the project folder itself, live; "own" its own folder in it,
 * computer/<id> as CraftOS-PC keeps them (made when missing); "copy" a scratch copy of the project folder.
 */
export type FilesMode = "project" | "own" | "copy";
const FILES_MODES: readonly FilesMode[] = ["project", "own", "copy"];

/** What the app knows about a computer it made (sessions made elsewhere have none of this). */
interface Meta {
  name: string;
  kind: "computer" | "pocket" | "turtle";
  advanced: boolean;
  network?: string;
  program?: string;
}

/** The computer form, as the page sends it. */
interface ComputerForm {
  name?: string;
  kind?: "computer" | "pocket" | "turtle";
  advanced?: boolean;
  world?: WorldConfig;
  worldFile?: string;
  addons?: string[];
  /** Minecraft version (versions.ts): "1.18.2", "1.20.1", "1.21.1". */
  version?: string;
  monitors?: MonitorSpec[];
  program?: string;
  timeScale?: number;
  /** More than 1: a network of this many computers, each with a modem. */
  count?: number;
  modem?: "wireless" | "ender";
  /** Run `program` as a ccunit test file (/ccunit/runtest), as `craftos-mcp test` does; the computer shuts down after. */
  test?: boolean;
  /** A debug adapter for this computer (engine.ts DebugLink). One computer only, not a network. */
  debug?: { port?: unknown; token?: unknown };
  /** CraftOS-PC import: the folder copied onto this computer instead of the workspace. One computer only. */
  dir?: string;
  /** Where its files are (FilesMode). Default the app's (WebAppOptions.files), else "project". */
  files?: FilesMode;
}

/** The form's own folder of files, checked; undefined for the workspace. */
function formDir(form: ComputerForm): string | undefined {
  if (typeof form.dir !== "string" || !form.dir.trim()) return undefined;
  const dir = resolve(form.dir.trim());
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`${dir} is not a folder`);
  return dir;
}

/** Sim commands every world knows (core.lua), with what they take. Addons add their own (ADDONS[].commands). */
const CORE_COMMANDS: { cmd: string; args: string; help: string }[] = [
  {
    cmd: "addPlayer",
    args: "{name, online?}",
    help: "a player joins the world's player list",
  },
  { cmd: "join", args: "{player}", help: "a player logs in" },
  { cmd: "leave", args: "{player}", help: "a player logs out" },
  {
    cmd: "chat",
    args: "{player, message}",
    help: "a player says something in chat",
  },
  {
    cmd: "playerClick",
    args: "{player, device?}",
    help: "a player right-clicks a detector",
  },
  {
    cmd: "setPlayerPos",
    args: "{player, x, y, z, dimension?}",
    help: "move a player",
  },
  {
    cmd: "setComputerPos",
    args: "{x?, y?, z?, dimension?}",
    help: "move this computer",
  },
  {
    cmd: "setItem",
    args: "{peripheral, slot, item|null}",
    help: "put an item in an inventory slot",
  },
  {
    cmd: "setEnergy",
    args: "{peripheral, energy}",
    help: "what an energy store holds",
  },
  {
    cmd: "setFluid",
    args: "{peripheral, tank?, fluid|null}",
    help: "what a tank holds",
  },
  {
    cmd: "setEnvironment",
    args: "{values}",
    help: "time, rain, thunder, biome, light, moon",
  },
  {
    cmd: "addEntity",
    args: "{entity}",
    help: "an entity the detectors can see",
  },
  {
    cmd: "attachPeripheral",
    args: "{peripheral}",
    help: "place a block next to the computer",
  },
  { cmd: "detachPeripheral", args: "{name}", help: "break it again" },
  {
    cmd: "resizeMonitor",
    args: "{monitor, blocksWide, blocksHigh}",
    help: "grow or shrink a monitor wall",
  },
  { cmd: "seed", args: "{value}", help: "pin math.random" },
  {
    cmd: "advance",
    args: "{seconds}",
    help: "jump the clock; due timers fire",
  },
  { cmd: "reboot", args: "{}", help: "reboot the computer" },
  { cmd: "shutdown", args: "{}", help: "shut the computer down" },
  { cmd: "unload", args: "{}", help: "the computer's chunk unloads" },
  { cmd: "load", args: "{}", help: "the chunk loads again" },
  {
    cmd: "crashServer",
    args: "{onReboot?}",
    help: "the server crashes and comes back",
  },
];

/** "a/b {x, y?}, c {z}" -> [{cmd: a, args}, {cmd: b, args}, {cmd: c, args}]. */
function parseCommandList(text: string): { cmd: string; args: string }[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "{" || ch === "(") depth++;
    if (ch === "}" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const out: { cmd: string; args: string }[] = [];
  for (const part of parts) {
    const m = /^\s*([\w/]+)\s*(.*)$/.exec(part);
    if (!m) continue;
    const args = /\{[^}]*\}/.exec(m[2] ?? "")?.[0] ?? "{}";
    for (const cmd of m[1]!.split("/")) if (cmd) out.push({ cmd, args });
  }
  return out;
}

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/app.css": "app.css",
  // CraftOS-PC import (craftospc-webapp.ts)
  "/craftospc.js": "craftospc.js",
  "/craftospc.css": "craftospc.css",
  // time controls
  "/timecontrol.js": "timecontrol.js",
  "/timecontrol.css": "timecontrol.css",
  // world panel (webapp-world.ts)
  "/worldpanel.js": "worldpanel.js",
  "/worldpanel.css": "worldpanel.css",
  // printed pages, and forms for the common sim commands
  "/printer.js": "printer.js",
  "/printer.css": "printer.css",
  "/simforms.js": "simforms.js",
  "/simforms.css": "simforms.css",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const staticDir = new URL("../webapp/", import.meta.url);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 5_000_000) reject(new HttpError(413, "body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  send(res, status, "application/json", JSON.stringify(value));
}

/** Width and height of a pixel screen from its PPM header, without reading the pixels. */
function ppmSize(
  file: string,
): { width: number; height: number; mtime: number } | undefined {
  try {
    const fd = openSync(file, "r");
    const head = Buffer.alloc(32);
    readSync(fd, head, 0, 32, 0);
    closeSync(fd);
    const m = /^P6\n(\d+) (\d+)\n/.exec(head.toString("latin1"));
    if (!m) return undefined;
    return {
      width: Number(m[1]),
      height: Number(m[2]),
      mtime: statSync(file).mtimeMs,
    };
  } catch {
    return undefined;
  }
}

function computerDir(session: Session): string {
  // a live folder, or the copy in the run folder (EngineHandle.computerDir)
  if (session.handle.computerDir) return session.handle.computerDir;
  let id = 0;
  try {
    const world = JSON.parse(
      readFileSync(join(session.handle.resultsDir, "world.json"), "utf8"),
    ) as WorldConfig;
    id = world.computerId ?? 0;
  } catch {
    // no world written: computer 0
  }
  return join(session.handle.dir, "computer", String(id));
}

function sessionAddons(session: Session): string[] {
  try {
    const world = JSON.parse(
      readFileSync(join(session.handle.resultsDir, "world.json"), "utf8"),
    ) as WorldConfig;
    if (Array.isArray(world.addons)) return world.addons;
  } catch {
    // fall through
  }
  try {
    return resolveAddons(undefined);
  } catch {
    return [];
  }
}

/** Start the app's web server on 127.0.0.1. Only pages it served itself may drive it. */
export function startWebApp(options: WebAppOptions): Server {
  const { sessions, config } = options;
  const meta = new Map<string, Meta>();
  // world panel: the surroundings of each computer, changed live (webapp-world.ts)
  const worldPanel = new WorldPanel(sessions, config);
  // time controls: the clock of every computer, and snapshots of the whole world with what the app knows of each
  const snapshotHooks: SnapshotHooks = {
    describe: (s) => {
      const m = meta.get(s.id);
      return {
        name: m?.name ?? `session ${s.id}`,
        kind: m?.kind ?? (s.blockWorld ? "turtle" : "computer"),
        advanced: m?.advanced ?? true,
        network: m?.network ?? null,
        program: m?.program ?? null,
      };
    },
    adopt: (s, info) =>
      meta.set(s.id, {
        name: info.name,
        kind: info.kind,
        advanced: info.advanced,
        ...(info.network ? { network: info.network } : {}),
        ...(info.program ? { program: info.program } : {}),
      }),
    forget: (s) => {
      meta.delete(s.id);
      worldPanel.forget(s.id); // world panel
    },
    started: (s) => startProgram(s, meta.get(s.id)?.program),
    // world panel: a restored computer's surroundings are the snapshot's now
    restored: (s) => {
      if (meta.has(s.id)) worldPanel.reread(s);
    },
  };
  registerSnapshotHooks(sessions, snapshotHooks);
  const time = timeRoutes({ sessions, config, hooks: snapshotHooks });
  if (options.snapshot) {
    const from = options.snapshot;
    void (async () => {
      const name =
        from.endsWith(SNAPSHOT_EXT) && existsSync(from)
          ? importSnapshot(config, readFileSync(from)).name
          : from;
      await restoreSnapshot(sessions, config, name, snapshotHooks);
    })().catch((error: unknown) =>
      process.stderr.write(
        `craftos app: snapshot ${from}: ${error instanceof Error ? error.message : String(error)}
`,
      ),
    );
  }
  // views: the block world and the network messages the page's views read (webapp-views.ts)
  const views = createViews({ sessions, config, json });

  const listWorlds = (): string[] => {
    try {
      return readdirSync(config.worldsDir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  };

  /** Merge the form into one world for one computer. */
  const worldOf = (form: ComputerForm): WorldConfig => {
    const base = form.worldFile
      ? loadNamedWorld(config.worldsDir, form.worldFile)
      : {};
    const world: WorldConfig = { ...base, ...(form.world ?? {}) };
    if (form.addons) world.addons = form.addons;
    if (form.version) world.version = form.version;
    // checked before the computer boots, as the command line does: a misspelt key or peripheral type comes back to
    // the form with "did you mean", not as a red line on the new computer's screen
    assertWorld(world);
    // a person drives these computers: they get the emulator's `sim` program (rom/ccsim/sim_shell.lua)
    world.simProgram = true;
    const kind = form.kind ?? "computer";
    const advanced = form.advanced !== false;
    if (kind === "turtle") {
      world.turtle = { fuel: 1000, ...(world.turtle ?? {}), advanced };
    } else {
      if (kind === "pocket") world.kind = "pocket";
      if (!advanced) world.advanced = false;
    }
    return world;
  };

  const startProgram = (
    session: Session,
    program: string | undefined,
  ): void => {
    if (!program?.trim()) return;
    void waitForBoot(session.handle.session)
      .then((front) => {
        // a startup program already in front has no prompt to type at
        if (front === "shell") session.handle.session.typeLine(program.trim());
      })
      .catch(() => undefined);
  };

  const createComputers = (
    form: ComputerForm,
  ): { ids: string[]; network?: string } => {
    const monitors = (form.monitors ?? []).filter((m) => m.name);
    const timeScale = Math.min(
      Math.max(Number(form.timeScale) || 1, 0.1),
      1000,
    );
    const count = Math.min(Math.max(Math.floor(Number(form.count) || 1), 1), 8);
    const kind = form.kind ?? "computer";
    const advanced = form.advanced !== false;
    const baseName =
      form.name?.trim() ||
      (kind === "turtle"
        ? "turtle"
        : kind === "pocket"
          ? "pocket"
          : "computer");
    const debug = parseDebugLink(form.debug);
    if (debug && count !== 1)
      throw new Error("a debugger takes one computer, not a network");
    // a test file runs under ccunit, as `craftos-mcp test` runs it
    const line =
      form.test && form.program?.trim()
        ? `/ccunit/runtest ${form.program.trim()}`
        : form.program;
    // CraftOS-PC import: a computer started with its own files (form.dir) instead of the workspace
    const dir = formDir(form);
    if (dir && count !== 1)
      throw new Error("a folder of files is for one computer, not a network");
    // where the files are: the folder itself (live), each computer's own folder in it, or a scratch copy
    const files = form.files ?? options.files ?? "project";
    if (!FILES_MODES.includes(files))
      throw new Error(`files must be ${FILES_MODES.join(", ")}, not ${files}`);
    const liveFor = (id: number): string | undefined => {
      const base = dir ?? config.workspaceDir;
      if (files === "copy") return undefined;
      if (files === "project") return base;
      const own = join(base, "computer", String(id));
      mkdirSync(own, { recursive: true });
      return own;
    };
    if (count === 1) {
      const world = worldOf(form);
      const session = sessions.create(
        monitors,
        timeScale,
        world,
        undefined,
        debug,
        dir,
        liveFor(world.computerId ?? 0),
      );
      worldPanel.remember(session.id, world, monitors); // world panel
      meta.set(session.id, {
        name: baseName,
        kind,
        advanced,
        ...(line ? { program: line } : {}),
      });
      startProgram(session, line);
      return { ids: [session.id] };
    }
    const computers = Array.from({ length: count }, (_, i) => {
      const world = worldOf(form);
      const peripherals = [...(world.peripherals ?? [])];
      if (!peripherals.some((p) => p.type === "modem")) {
        const modem: ModemSpec = {
          name: "back",
          type: "modem",
          kind: form.modem ?? "wireless",
        };
        peripherals.push(modem);
      }
      delete world.computerId;
      // linkedWorlds numbers them from 0 in this order
      const liveDir = liveFor(i);
      return {
        // "computer 1", "computer 2": the tab also names the network, so "net1" next to "net1" is not two names alike
        name: `${baseName} ${i + 1}`,
        monitors,
        world: { ...world, peripherals, label: `${baseName} ${i + 1}` },
        ...(liveDir && { liveDir }),
      };
    });
    const linked = sessions.createNetwork({ computers, timeScale });
    const network = sessions.listNetworks().at(-1)!.name;
    const ids: string[] = [];
    for (const [name, session] of Object.entries(linked.computers)) {
      const index = computers.findIndex((c) => c.name === name);
      const made = computers[index];
      // world panel: with the id linkedWorlds gave it (0, 1, 2 in order), not the 0 of a world without one
      if (made)
        worldPanel.remember(
          session.id,
          { ...made.world, computerId: index },
          monitors,
        );
      meta.set(session.id, {
        name,
        kind,
        advanced,
        network,
        ...(form.program ? { program: form.program } : {}),
      });
      startProgram(session, form.program);
      ids.push(session.id);
    }
    return { ids, network };
  };

  const summary = (session: Session) => {
    const raw = session.handle.session;
    const open = new Set(raw.windows.keys());
    const byId = new Map<number, WindowState>();
    for (const w of raw.allWindows()) byId.set(w.id, w);
    const windows = [...byId.values()]
      .filter((w) => w.frame && (open.has(w.id) || !raw.running))
      .map((w) => ({
        id: w.id,
        peripheral: w.peripheral ?? null,
        width: w.frame!.width,
        height: w.frame!.height,
        mode: w.frame!.mode,
        version: w.version,
      }));
    const pixelDir = join(session.handle.resultsDir, "pixels");
    const pixels = existsSync(pixelDir)
      ? readdirSync(pixelDir)
          .filter((f) => f.endsWith(".ppm"))
          .sort()
          .flatMap((f) => {
            const size = ppmSize(join(pixelDir, f));
            return size ? [{ peripheral: f.slice(0, -4), ...size }] : [];
          })
      : [];
    const m = meta.get(session.id);
    const forViews = views.summary(session);
    return {
      id: session.id,
      name: m?.name ?? forViews.name ?? `session ${session.id}`,
      kind:
        m?.kind ??
        forViews.kind ??
        (session.blockWorld ? "turtle" : "computer"),
      advanced: m?.advanced ?? true,
      network: m?.network ?? forViews.network,
      blocks: forViews.blocks,
      placedBy: forViews.placedBy,
      program: m?.program ?? null,
      fromApp: m !== undefined,
      // its files: a folder of the person's, live, or null for a scratch copy
      liveDir: session.handle.liveDir ?? null,
      running: raw.running,
      exitCode: raw.exitInfo?.code ?? null,
      createdAt: session.createdAt,
      windows,
      pixels,
    };
  };

  const reboot = async (
    session: Session,
    how: "reboot" | "shutdown",
  ): Promise<void> => {
    await powerCycle(session.handle, how);
  };

  const route = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    const file = STATIC[path];
    if (method === "GET" && file) {
      const body = readFileSync(new URL(file, staticDir));
      return send(
        res,
        200,
        TYPES[extname(file)] ?? "application/octet-stream",
        body,
      );
    }

    // views: their own files (webapp/views*.js, views*.css) and their routes
    if (method === "GET" && /^\/views[\w-]*\.(js|css)$/.test(path)) {
      const own = new URL(path.slice(1), staticDir);
      if (!existsSync(own)) throw new HttpError(404, "not found");
      return send(res, 200, TYPES[extname(path)]!, readFileSync(own));
    }
    if (views.route(method, path, url, res)) return;
    if (await worldPanel.handle(req, res, url)) return; // world panel

    if (method === "GET" && path === "/api/meta") {
      let defaultMc = DEFAULT_MC;
      try {
        defaultMc = resolveVersion(undefined).mc;
      } catch {
        // CRAFTOS_VERSION is invalid: offer the default
      }
      // New computer ticks the mods the project names (craftos.json's addons, CRAFTOS_ADDONS); with none named, no
      // mods: a person ticks the ones their pack has, so a program cannot lean on a mod their server lacks
      let defaults: string[] = [];
      if (process.env["CRAFTOS_ADDONS"] !== undefined)
        try {
          defaults = resolveAddons(undefined, process.env, defaultMc);
        } catch {
          defaults = [];
        }
      let programs: string[] = [];
      try {
        programs = listWorkspace(config.workspaceDir)
          .filter(
            (e) =>
              e.kind === "file" &&
              e.path.endsWith(".lua") &&
              !e.path.endsWith(".test.lua"),
          )
          .map((e) => e.path)
          .slice(0, 500);
      } catch {
        programs = [];
      }
      return json(res, {
        addons: ADDONS.map((a) => ({
          id: a.id,
          name: a.name,
          version: addonVersion(a, defaultMc) ?? "",
          versions: a.versions,
          simulates: a.simulates ?? null,
          requires: a.requires ?? [],
          on: defaults.includes(a.id),
        })),
        versions: VERSIONS.map((v) => ({ mc: v.mc, cc: v.cc })),
        version: defaultMc,
        worlds: listWorlds(),
        programs,
        monitorLimit: MONITOR_LIMIT,
        workspaceDir: config.workspaceDir,
        files: options.files ?? "project",
        problems: checkConfig(config),
        keys: Keys,
      });
    }

    // time controls
    if (path === "/api/clock" || path.startsWith("/api/snapshots"))
      if (await time(req, res, url)) return;

    let m = /^\/api\/worlds\/([\w.-]+)$/.exec(path);
    if (method === "GET" && m)
      return json(res, loadNamedWorld(config.worldsDir, m[1]!));

    if (method === "GET" && path === "/api/sessions") {
      const last = options.lastRun?.();
      return json(res, {
        sessions: sessions
          .list()
          .flatMap((s) => views.withPlaced(sessions.get(s.id))) // views
          .map(summary),
        lastRun: last
          ? {
              label: last.label,
              screens: last.screens
                .filter((s) => s.png)
                .map((s, i) => ({
                  index: i,
                  peripheral: s.peripheral ?? null,
                  pixel: !!s.pixels,
                })),
            }
          : null,
      });
    }

    if (method === "POST" && path === "/api/sessions") {
      const form = (await readJson(req)) as ComputerForm;
      try {
        // a version whose ROM an installed package has not built yet is built first
        await ensureRom(config, worldOf(form).version);
        const made = createComputers(form);
        // a person's computers: the MCP server's agent lists them apart from its own and does not stop them by accident
        for (const id of made.ids) sessions.setOwner(id, VIEWER_OWNER);
        return json(res, made);
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    m = /^\/api\/last-run\/(\d+)\.png$/.exec(path);
    if (method === "GET" && m) {
      const screen = options.lastRun?.()?.screens.filter((s) => s.png)[
        Number(m[1])
      ];
      if (!screen?.png) throw new HttpError(404, "no screenshot");
      return send(res, 200, "image/png", Buffer.from(screen.png, "base64"));
    }

    // CraftOS-PC import (craftospc-webapp.ts)
    if (path.startsWith("/api/craftos-pc")) {
      let projectDir: string | undefined;
      try {
        projectDir = findProject(config.workspaceDir)?.dir;
      } catch {
        // a broken craftos.json: no project to list
      }
      const answer = await craftosPcApi(method, url, () => readJson(req), {
        ...(projectDir && { projectDir }),
      });
      if (answer) return json(res, answer.body, answer.status);
    }

    m = /^\/api\/sessions\/([\w-]+)(\/.*)?$/.exec(path);
    if (!m) throw new HttpError(404, "not found");
    let session: Session;
    try {
      session = views.find(m[1]!) ?? sessions.get(m[1]!); // views
    } catch {
      throw new HttpError(404, `no such computer: ${m[1]}`);
    }
    const { handle } = session;
    const raw = handle.session;
    const sub = m[2] ?? "";

    if (method === "DELETE" && sub === "") {
      if (views.summary(session).placedBy)
        throw new HttpError(
          400,
          "a turtle placed this computer: dig it up, or close the turtle",
        );
      meta.delete(session.id);
      worldPanel.forget(session.id); // world panel
      await sessions.destroy(session.id);
      return json(res, {});
    }

    if (method === "PATCH" && sub === "") {
      const body = await readJson(req);
      const mine = meta.get(session.id);
      if (typeof body["name"] === "string" && body["name"].trim()) {
        if (mine) mine.name = body["name"].trim();
        else
          meta.set(session.id, {
            name: body["name"].trim(),
            kind: "computer",
            advanced: true,
          });
      }
      return json(res, {});
    }

    let w = /^\/window\/(\d+)\.png$/.exec(sub);
    if (method === "GET" && w) {
      const state = raw
        .allWindows()
        .filter((x) => x.id === Number(w![1]))
        .pop();
      if (!state?.frame) throw new HttpError(404, "window has no frame yet");
      const scale = Math.min(
        Math.max(Number(url.searchParams.get("scale")) || 2, 1),
        4,
      );
      return send(res, 200, "image/png", renderPng(state.frame, { scale }));
    }

    w = /^\/pixels\/(.+)\.png$/.exec(sub);
    if (method === "GET" && w) {
      const name = decodeURIComponent(w[1]!);
      const screen = pixelScreens(handle.resultsDir).find(
        (p) => p.peripheral === name,
      );
      if (!screen) throw new HttpError(404, "no such pixel screen");
      const scale = Math.min(
        Math.max(Number(url.searchParams.get("scale")) || 2, 1),
        4,
      );
      return send(res, 200, "image/png", pixelScreenPng(screen, scale));
    }

    if (method === "POST" && sub === "/input") {
      // [{type: key|keyup|char|paste|mouse, ...}] in order
      const body = await readJson(req);
      const events = Array.isArray(body["events"])
        ? (body["events"] as Record<string, unknown>[])
        : [];
      for (const e of events) {
        const type = String(e["type"]);
        if (type === "key" || type === "keyup") {
          const key = String(e["key"]);
          if (!(key in Keys)) throw new HttpError(400, `unknown key ${key}`);
          if (type === "keyup") raw.key(key as KeyName, { up: true });
          else raw.key(key as KeyName, { held: e["held"] === true });
        } else if (type === "char") {
          raw.char(String(e["text"] ?? ""));
        } else if (type === "paste") {
          // CC pastes one line at most, up to 512 characters (TerminalWidget.paste)
          const text = String(e["text"] ?? "")
            .split(/\r?\n/)[0]!
            .slice(0, 512);
          if (text) raw.event("paste", text);
        } else if (type === "mouse") {
          const kind = String(e["kind"] ?? "click");
          const x = Math.floor(Number(e["x"]));
          const y = Math.floor(Number(e["y"]));
          if (kind === "scroll")
            raw.event("mouse_scroll", Number(e["dir"]) < 0 ? -1 : 1, x, y);
          else if (kind === "click" || kind === "up" || kind === "drag")
            raw.event(
              `mouse_${kind}`,
              Math.max(1, Math.floor(Number(e["button"]) || 1)),
              x,
              y,
            );
        } else throw new HttpError(400, `unknown input ${type}`);
      }
      return json(res, {});
    }

    if (method === "POST" && sub === "/shortcut") {
      // Ctrl+T/R/S as CC's terminal does them: held for a second
      const body = await readJson(req);
      const which = String(body["key"]);
      if (which === "t")
        await holdKey(handle, "t", { ms: TERMINATE_HOLD_MS, ctrl: true });
      else if (which === "r") await reboot(session, "reboot");
      else if (which === "s") await reboot(session, "shutdown");
      else throw new HttpError(400, "shortcut must be t, r or s");
      return json(res, {});
    }

    if (method === "POST" && (sub === "/reboot" || sub === "/shutdown")) {
      await reboot(session, sub === "/reboot" ? "reboot" : "shutdown");
      return json(res, {});
    }

    if (method === "POST" && sub === "/start") {
      if (!raw.running) handle.restart();
      return json(res, {});
    }

    if (method === "POST" && sub === "/touch") {
      const body = await readJson(req);
      const player =
        typeof body["player"] === "string" && body["player"]
          ? body["player"]
          : undefined;
      try {
        touchMonitorAs(
          handle,
          String(body["monitor"]),
          Number(body["x"]),
          Number(body["y"]),
          player,
        );
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      return json(res, {});
    }

    if (method === "POST" && sub === "/command") {
      const body = await readJson(req);
      const command = (body["command"] ?? body) as SimCommand;
      if (typeof (command as { cmd?: unknown }).cmd !== "string")
        throw new HttpError(400, 'a sim command needs "cmd"');
      // time controls: a paused computer takes the command when the clock runs again
      const paused = worldClockFor(sessions).current.paused;
      const result = await sendCommandResult(
        handle,
        command,
        paused ? 1500 : 10000,
      );
      return json(res, {
        ...result,
        ...(result.applied
          ? {}
          : {
              error: paused
                ? "the world is paused: it happens when the clock runs again (Resume, or Step one tick)"
                : "the program has not applied it yet: it is not waiting for an event",
            }),
      });
    }

    // as results show it: without the sim's own bookkeeping (and, in the public build, the empty sections)
    if (method === "GET" && sub === "/state")
      return json(res, shownState(handle.readState()) ?? {});

    if (views.sessionRoute(session, method, sub, url, res)) return; // views

    if (method === "GET" && sub === "/commands") {
      const on = new Set(sessionAddons(session));
      const list = CORE_COMMANDS.map((c) => ({
        ...c,
        addon: null as string | null,
      }));
      for (const addon of ADDONS) {
        if (!on.has(addon.id) || !addon.commands) continue;
        for (const c of parseCommandList(addon.commands))
          list.push({ ...c, help: "", addon: addon.name });
      }
      return json(res, { commands: list, addons: [...on] });
    }

    if (method === "GET" && sub === "/ui") {
      return json(
        res,
        describeAll(handle, { minArea: 4, minSide: 1 }).map((s) => ({
          window: s.window,
          peripheral: s.peripheral ?? null,
          unit: s.unit,
          rects: s.rects,
        })),
      );
    }

    // every screen as text (terminal and monitors), for scripts that drive the app
    if (method === "GET" && sub === "/screens")
      return json(
        res,
        captureScreens(handle.session, { resultsDir: handle.resultsDir }),
      );

    const dir = computerDir(session);
    if (method === "GET" && sub === "/files") {
      mkdirSync(dir, { recursive: true });
      return json(res, {
        dir,
        live: !!handle.liveDir,
        // never a repository's or the packages' insides (a live folder holds them; the computer does not see them)
        entries: listWorkspace(dir, ".", COPY_SKIP).slice(0, 3000),
      });
    }

    if (sub === "/file") {
      const rel = url.searchParams.get("path") ?? "";
      let target: string;
      try {
        target = resolveInWorkspace(dir, rel);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      if (method === "GET") {
        if (!existsSync(target) || statSync(target).isDirectory())
          throw new HttpError(404, "no such file");
        return send(
          res,
          200,
          "text/plain; charset=utf-8",
          readFileSync(target),
        );
      }
      if (method === "PUT") {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, await readBody(req));
        return json(res, {});
      }
    }

    if (method === "POST" && sub === "/sync") {
      // a live folder is the project's own: there is nothing to copy, a reboot is all it takes
      if (handle.liveDir) {
        await reboot(session, "reboot");
        return json(res, {});
      }
      // copy the project folder onto the computer again, then reboot so the program picks it up
      mkdirSync(dir, { recursive: true });
      await copyWorkspaceAsync(config.workspaceDir, dir, {
        exclude: [config.runtimeDir],
      });
      await reboot(session, "reboot");
      return json(res, {});
    }

    throw new HttpError(404, "not found");
  };

  const server = createServer((req, res) => {
    // Loopback only, and only pages this server served: a site in another tab cannot drive the computers
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host))
      return send(res, 403, "text/plain", "forbidden host");
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === host;
      } catch {
        ok = false;
      }
      if (!ok) return send(res, 403, "text/plain", "forbidden");
    }
    route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent)
        send(
          res,
          status,
          "text/plain",
          error instanceof Error ? error.message : String(error),
        );
    });
  });
  let fellBack = false;
  server.on("error", (error: NodeJS.ErrnoException) => {
    // the port is taken (another MCP server's viewer, say): any free one will do
    if (
      error.code === "EADDRINUSE" &&
      options.portFallback &&
      options.port !== 0 &&
      !fellBack
    ) {
      fellBack = true;
      process.stderr.write(
        `craftos app: port ${options.port} is taken, using a free one\n`,
      );
      server.listen(0, "127.0.0.1");
      return;
    }
    process.stderr.write(`craftos app: ${error.message}\n`);
  });
  server.listen(options.port, "127.0.0.1", () => {
    const address = server.address();
    const port =
      typeof address === "object" && address ? address.port : options.port;
    const url = `http://127.0.0.1:${port}/`;
    if (options.onListening) options.onListening(url);
    else process.stderr.write(`craftos app: ${url}\n`);
  });
  return server;
}
