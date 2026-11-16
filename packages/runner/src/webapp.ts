/**
 * The browser app: a local web server for people without an AI agent. It makes computers (one, or a network), shows
 * the terminal, every monitor and every pixel screen live, takes keys, touches and sim commands, and shows the
 * computer's files. The page itself is plain HTML, CSS and JS in ../webapp/, served as it is.
 *
 * The MCP server's viewer is this same app over the MCP server's own SessionManager, plus the screens of its last
 * one-shot run (`lastRun`).
 */
import {
  cpSync,
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
import { basename, dirname, extname, join } from "node:path";
import {
  type KeyName,
  Keys,
  type WindowState,
  renderPng,
} from "@craftos-mcp/rawterm";
import { ADDONS, resolveAddons } from "./addons.js";
import { type RunnerConfig, checkConfig } from "./config.js";
import {
  TERMINATE_HOLD_MS,
  holdKey,
  sendCommandResult,
  touchMonitorAs,
} from "./drive.js";
import { type ScreenCapture, pixelScreenPng, pixelScreens } from "./engine.js";
import { MONITOR_LIMIT, type MonitorSpec } from "./lua.js";
import type { Session, SessionManager } from "./sessions.js";
import { describeAll, readWaiting } from "./ui.js";
import { listWorkspace, resolveInWorkspace } from "./workspace.js";
import {
  type ModemSpec,
  type SimCommand,
  type WorldConfig,
  loadNamedWorld,
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
}

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
  monitors?: MonitorSpec[];
  program?: string;
  timeScale?: number;
  /** More than 1: a network of this many computers, each with a modem. */
  count?: number;
  modem?: "wireless" | "ender";
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
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const staticDir = new URL("../webapp/", import.meta.url);

/** Directory names never copied into the computer (as startEngine). */
const SKIP = new Set([".git", "node_modules", "__snapshots__"]);

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
  let networkCount = 0;

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
    // a person drives these computers: they get the emulator's `sim` program (rom/ccsim/sim_shell.lua)
    const world: WorldConfig = {
      ...base,
      ...(form.world ?? {}),
      simProgram: true,
    };
    if (form.addons) world.addons = form.addons;
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
    void session.handle.session
      .waitForText(">", 0, 20000)
      .then(() => session.handle.session.typeLine(program.trim()))
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
    if (count === 1) {
      const session = sessions.create(monitors, timeScale, worldOf(form));
      meta.set(session.id, {
        name: baseName,
        kind,
        advanced,
        ...(form.program ? { program: form.program } : {}),
      });
      startProgram(session, form.program);
      return { ids: [session.id] };
    }
    networkCount += 1;
    const network = `net${networkCount}`;
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
      return {
        name: `${baseName}${i + 1}`,
        monitors,
        world: { ...world, peripherals, label: `${baseName}${i + 1}` },
      };
    });
    const linked = sessions.createNetwork({ computers, timeScale });
    const ids: string[] = [];
    for (const [name, session] of Object.entries(linked.computers)) {
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
    return {
      id: session.id,
      name: m?.name ?? `session ${session.id}`,
      kind: m?.kind ?? (session.blockWorld ? "turtle" : "computer"),
      advanced: m?.advanced ?? true,
      network: m?.network ?? null,
      program: m?.program ?? null,
      fromApp: m !== undefined,
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
    const { handle } = session;
    if (!handle.session.running) {
      if (how === "reboot") handle.restart();
      return;
    }
    // The sim reboots before it can acknowledge the command, so send it once the program waits for an event: that
    // event is the command, and it is applied at once
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (readWaiting(handle)?.blocked) {
        handle.sendCommand({ cmd: how });
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    // the program never waits for an event (a busy loop): pull the plug
    await handle.session.stop();
    if (how === "reboot") handle.restart();
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

    if (method === "GET" && path === "/api/meta") {
      let defaults: string[] = [];
      try {
        defaults = resolveAddons(undefined);
      } catch {
        defaults = ADDONS.map((a) => a.id);
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
          version: a.version,
          requires: a.requires ?? [],
          on: defaults.includes(a.id),
        })),
        worlds: listWorlds(),
        programs,
        monitorLimit: MONITOR_LIMIT,
        workspaceDir: config.workspaceDir,
        problems: checkConfig(config),
        keys: Keys,
      });
    }

    let m = /^\/api\/worlds\/([\w.-]+)$/.exec(path);
    if (method === "GET" && m)
      return json(res, loadNamedWorld(config.worldsDir, m[1]!));

    if (method === "GET" && path === "/api/sessions") {
      const last = options.lastRun?.();
      return json(res, {
        sessions: sessions.list().map((s) => summary(sessions.get(s.id))),
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
        return json(res, createComputers(form));
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

    m = /^\/api\/sessions\/([\w-]+)(\/.*)?$/.exec(path);
    if (!m) throw new HttpError(404, "not found");
    let session: Session;
    try {
      session = sessions.get(m[1]!);
    } catch {
      throw new HttpError(404, `no such computer: ${m[1]}`);
    }
    const { handle } = session;
    const raw = handle.session;
    const sub = m[2] ?? "";

    if (method === "DELETE" && sub === "") {
      meta.delete(session.id);
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
      const result = await sendCommandResult(handle, command, 10000);
      return json(res, {
        ...result,
        ...(result.applied
          ? {}
          : {
              error:
                "the program has not applied it yet: it is not waiting for an event",
            }),
      });
    }

    if (method === "GET" && sub === "/state")
      return json(res, handle.readState() ?? {});

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
      return json(res, sessions.screens(session.id));

    const dir = computerDir(session);
    if (method === "GET" && sub === "/files") {
      mkdirSync(dir, { recursive: true });
      return json(res, { dir, entries: listWorkspace(dir).slice(0, 3000) });
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
      // copy the project folder onto the computer again, then reboot so the program picks it up
      mkdirSync(dir, { recursive: true });
      cpSync(config.workspaceDir, dir, {
        recursive: true,
        filter: (source) => !SKIP.has(basename(source)),
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
  server.on("error", (error) =>
    process.stderr.write(`craftos app: ${error.message}\n`),
  );
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
