import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  RawSession,
  encodePng,
  renderPng,
  type WindowState,
} from "@craftos-mcp/rawterm";
import type { RunnerConfig } from "./config.js";
import {
  type SimCommand,
  type SimState,
  type WorldConfig,
  enginePeripheralLua,
  terminalSize,
  worldJson,
  worldVersion,
} from "./world.js";
import { engineVersionArgs, isDefaultVersion, romDirFor } from "./versions.js";
import { checkConfig, missingRomProblem } from "./config.js";
import { mobComputer } from "./mobs.js";
import { resolveInWorkspace } from "./workspace.js";
import { type CopyOptions, copyWorkspace, copyWorkspaceAsync } from "./copy.js";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";

export interface EngineHandle {
  /** The running engine. `restart` puts a new one here. */
  readonly session: RawSession;
  /** Per-run scratch directory (computer data, results, boot script). */
  readonly dir: string;
  readonly resultsDir: string;
  readonly stderr: string[];
  /** Change the simulated world while the computer runs (interact, approve, chat, ...). */
  sendCommand(command: SimCommand): number;
  /** Balances, ledger, chat log and inventories as last written by the sim. */
  readState(): SimState | undefined;
  /** Start a computer that shut down again, with its files, results and boot script as they are. */
  restart(): void;
  dispose(): void;
}

// computer_space_limit on the real server, which raised it from CC:Tweaked's 1 MB default (StartOptions)
const COMPUTER_SPACE_LIMIT = 25_000_000;
/** Cobalt (CC:Tweaked's Lua VM) against native Lua: a 2,000,000-step loop takes about 90 ms real, 12 ms native. */
export const COBALT_SLOWDOWN = 8;
/**
 * The slowdown a world gets when it does not say (WorldConfig.cobaltSpeed): CRAFTOS_COBALT_SPEED, else native speed.
 * Off by default: the suites' timing budgets were set at native speed, and at 8x they take several times as long.
 * A test that times work against a budget (a search that runs until its time is up) turns it on for its world, and
 * CRAFTOS_COBALT_SPEED=8 runs a whole suite at server speed.
 */
export const DEFAULT_COBALT_SPEED =
  Number(process.env["CRAFTOS_COBALT_SPEED"] ?? 1) || 1;

function cobaltSlowdown(world: WorldConfig | undefined): number {
  const v = world?.cobaltSpeed;
  if (v === true) return COBALT_SLOWDOWN;
  if (typeof v === "number" && v > 1) return v;
  if (v === false || typeof v === "number") return 1;
  return DEFAULT_COBALT_SPEED;
}

/**
 * A debug adapter listening on 127.0.0.1 (the VS Code extension's). The engine connects to it before the computer
 * boots (--debug-connect), says hello with the token, takes the adapter's breakpoints and waits for its "run". The
 * protocol is in engine/src/debug_server.hpp. Without this no debugger code runs in the engine at all.
 */
export interface DebugLink {
  readonly port: number;
  /** Sent back in the engine's hello, so the adapter knows the engine it started from a stranger. */
  readonly token: string;
}

/** A DebugLink from untrusted JSON (the app's computer form), or an error saying what is wrong with it. */
export function parseDebugLink(value: unknown): DebugLink | undefined {
  if (value === undefined || value === null) return undefined;
  const { port, token } = value as { port?: unknown; token?: unknown };
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("debug.port must be a port number");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(token))
    throw new Error("debug.token must be 1-128 letters, digits, _ or -");
  return { port, token };
}

/**
 * Start one engine process with an isolated computer. The workspace is copied
 * into the computer's root, so programs see the same layout as on a real
 * server (for example `dofile("surface")` resolves from /). Helper libraries
 * are at /ccunit and a writable /results is mounted for the harness.
 */
export interface StartOptions {
  readonly label?: string;
  /** Virtual clock: sleep(), os.clock() and os.epoch() run this many times faster. */
  readonly timeScale?: number;
  /** Simulated world (players, virtual peripherals, modems, turtles). */
  readonly world?: WorldConfig;
  /**
   * Block worlds: the floppy disks every computer in the world shares (`computer/disk/<id>`), and where this
   * computer's own files live, so they outlast a shutdown. `fresh` starts it empty, as a new computer is.
   */
  readonly shared?: { diskDir: string; computerDir?: string; fresh?: boolean };
  /** A linked network's one economy (balances, ledger, refusals), which the computer finds at /results/economy. */
  readonly economyDir?: string;
  /**
   * The computer's disk size in bytes. Default 25 MB, the real server's computer_space_limit. CC:Tweaked's own default
   * is 1 MB (ComputerCraft.computerSpaceLimit); its test suite runs on a 10 MB disk (ComputerTestDelegate), which the
   * conformance run (scripts/run-cct-conformance.mjs) asks for here.
   */
  readonly computerSpaceLimit?: number;
  /**
   * The http address rules (the engine's http_whitelist / http_blacklist). Default: everything allowed except
   * `$private`, as CC:Tweaked's own default. Tests that talk to a local server pass `deny: []`.
   */
  readonly httpRules?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  /** A debug adapter the engine connects to before the computer boots (DebugLink). */
  readonly debug?: DebugLink;
  /** A run folder stageEngine already copied the files into: startEngine copies nothing and blocks nothing. */
  readonly staged?: StagedRun;
}

/**
 * The bios applies default_computer_settings with settings.set, which queues `setting_changed` for motd.enable before
 * any program runs. A server with no default settings has no such event, so the boot script takes it out of the queue
 * (and puts back anything else, in order) before the program starts.
 */
const DROP_MOTD_EVENT_LUA = `do
  local marker = "ccsim_boot_drain"
  os.queueEvent(marker)
  local keep = {}
  while true do
    local e = table.pack(os.pullEventRaw())
    if e[1] == marker then break end
    if not (e[1] == "setting_changed" and e[2] == "motd.enable") then keep[#keep + 1] = e end
  end
  for _, e in ipairs(keep) do os.queueEvent(table.unpack(e, 1, e.n)) end
end`;

/** A directory link that needs no rights on Windows (a junction). */
function linkDir(target: string, path: string): void {
  mkdirSync(target, { recursive: true });
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, ".."), { recursive: true });
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** The file in each run folder that names the process using it, so a later start can clean up after a dead one. */
export const RUN_OWNER_FILE = "owner.json";

export function makeRuntimeDir(config: RunnerConfig, label: string): string {
  mkdirSync(config.runtimeDir, { recursive: true });
  const dir = mkdtempSync(join(config.runtimeDir, `${label}-`));
  writeFileSync(
    join(dir, RUN_OWNER_FILE),
    JSON.stringify({ pid: process.pid, started: Date.now() }),
  );
  return dir;
}

/** What goes onto a computer: the world's deploy list, else the whole workspace. */
function copiesFor(
  config: RunnerConfig,
  world: WorldConfig | undefined,
  computerDir: string,
): [string, { dest: string; deploy: boolean }][] {
  if (world?.deploy && world.deploy.length > 0)
    return world.deploy.map((entry) => [
      resolveInWorkspace(config.workspaceDir, entry.from),
      {
        dest: resolveInWorkspace(computerDir, entry.to ?? "."),
        deploy: true,
      },
    ]);
  return [[config.workspaceDir, { dest: computerDir, deploy: false }]];
}

/**
 * Never the runtime folder: a workspace that holds it (the CLI run from a clone's root) would copy every old run. A
 * deploy list is explicit, so it copies what it names even when .gitignore ignores it.
 */
const copyOptions = (
  config: RunnerConfig,
  deploy: boolean,
  signal?: AbortSignal,
): CopyOptions => ({
  exclude: [config.runtimeDir],
  gitignore: !deploy,
  ...(signal && { signal }),
});

/** A run folder with the computer's files already copied in, made without blocking (stageEngine). */
export interface StagedRun {
  readonly dir: string;
  readonly computerId: number;
}

/**
 * Make a run folder and copy the computer's files in without blocking the event loop, so the MCP server answers other
 * clients meanwhile; pass the result to startEngine as `staged`. Stops on `signal` and removes the folder. Not for
 * a block world's computers (their files live in the world's shared folders).
 */
export async function stageEngine(
  config: RunnerConfig,
  options: { label?: string; world?: WorldConfig; signal?: AbortSignal } = {},
): Promise<StagedRun> {
  const computerId = options.world?.computerId ?? 0;
  const dir = makeRuntimeDir(config, options.label ?? "run");
  try {
    const computerDir = join(dir, "computer", String(computerId));
    await mkdir(computerDir, { recursive: true });
    for (const [from, to] of copiesFor(config, options.world, computerDir))
      await copyWorkspaceAsync(
        from,
        to.dest,
        copyOptions(config, to.deploy, options.signal),
      );
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { dir, computerId };
}

/**
 * stageEngine within a run's timeout: "timed_out" when the copy outlasts it or `signal` cancels it (the folder is
 * gone either way), so a run answers with a timeout instead of hanging. A too-big workspace still throws.
 */
export async function stageWithin(
  config: RunnerConfig,
  label: string,
  world: WorldConfig | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StagedRun | "timed_out"> {
  const limit = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([limit, signal]) : limit;
  try {
    return await stageEngine(config, {
      label,
      signal: both,
      ...(world && { world }),
    });
  } catch (error) {
    if (both.aborted) return "timed_out";
    throw error;
  }
}

/** The scratch folders the runner makes (makeRuntimeDir); anything else in the runtime folder is left alone. */
const RUNTIME_LABELS = /^(run|test|session|blockworld|economy)-[A-Za-z0-9]{6}$/;
const HOUR = 3_600_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it is there, it is just not ours to signal
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove scratch folders left by runs whose process is gone (a crash, a kill, a request that timed out in an older
 * build). A folder with an owner file goes once its process is dead, never while it lives. One from before owner
 * files goes only when it is old: a day for a one-shot run or test, a week for a session or its world. Returns what
 * it removed.
 */
export async function cleanStaleRuntime(
  config: RunnerConfig,
  now = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(config.runtimeDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!RUNTIME_LABELS.test(name)) continue;
    const dir = join(config.runtimeDir, name);
    try {
      let stale: boolean;
      const owner = await readFile(join(dir, RUN_OWNER_FILE), "utf8")
        .then((t) => JSON.parse(t) as { pid?: unknown })
        .catch(() => undefined);
      if (owner && typeof owner.pid === "number") {
        stale = owner.pid !== process.pid && !processAlive(owner.pid);
      } else {
        const age = now - (await stat(dir)).mtimeMs;
        const oneShot = name.startsWith("run-") || name.startsWith("test-");
        stale = age > (oneShot ? 24 : 7 * 24) * HOUR;
      }
      if (!stale) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // in use (Windows keeps open files) or gone already: leave it for next time
    }
  }
  return removed;
}

/** Remove a staged run folder that never got started. */
export function discardStaged(staged: StagedRun): void {
  rmSync(staged.dir, { recursive: true, force: true });
}

export function startEngine(
  config: RunnerConfig,
  bootLua: string,
  options: StartOptions = {},
): EngineHandle {
  const {
    label = "run",
    timeScale = 1,
    world,
    shared,
    economyDir,
    computerSpaceLimit = COMPUTER_SPACE_LIMIT,
    httpRules,
    debug,
  } = options;
  // no engine (a failed first run, an unbuilt clone): say so, instead of a spawn error later
  const noEngine = checkConfig(config).find((p) => p.startsWith("engine "));
  if (noEngine) {
    if (options.staged) discardStaged(options.staged);
    throw new Error(noEngine);
  }
  const computerId = world?.computerId ?? 0;
  if (options.staged && options.staged.computerId !== computerId)
    throw new Error("staged for another computer id");
  if (options.staged && shared)
    throw new Error("a block world's computer is not staged");
  const dir = options.staged?.dir ?? makeRuntimeDir(config, label);
  const resultsDir = join(dir, "results");
  const computerDir = join(dir, "computer", String(computerId));
  if (!options.staged) {
    try {
      if (shared) {
        linkDir(shared.diskDir, join(dir, "computer", "disk"));
        if (shared.computerDir) linkDir(shared.computerDir, computerDir);
      }
      mkdirSync(computerDir, { recursive: true });
      if (!shared?.fresh) {
        // a computer a turtle placed (fresh) has nothing on it but what it was given before
        for (const [from, to] of copiesFor(config, world, computerDir))
          copyWorkspace(from, to.dest, copyOptions(config, to.deploy));
      }
    } catch (error) {
      // the half-made run folder goes, as dispose would
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  // Floppy disks a plain world starts with (a block world's host writes its own, shared by every computer in it)
  if (!shared)
    for (const [id, files] of Object.entries(world?.disks ?? {})) {
      const diskDir = join(dir, "computer", "disk", String(Number(id)));
      mkdirSync(diskDir, { recursive: true });
      for (const [path, text] of Object.entries(files)) {
        const file = resolveInWorkspace(diskDir, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
    }
  mkdirSync(resultsDir, { recursive: true });
  if (economyDir) linkDir(economyDir, join(resultsDir, "economy"));

  // The Minecraft / CC:Tweaked version (versions.ts) picks the ROM and the engine's --cc-version
  const version = worldVersion(world);
  const romDir = romDirFor(config, version);
  if (!isDefaultVersion(version)) {
    const missing = missingRomProblem(romDir, version.mc);
    if (missing) throw new Error(missing);
  }
  writeFileSync(join(resultsDir, "world.json"), worldJson(world));

  const size = terminalSize(world);
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "global.json"),
    JSON.stringify({
      computerSpaceLimit,
      // The ROM's random tip under "CraftOS 1.8" is noise in every captured screen: off, as a server admin can set
      // it (CC:Tweaked's default_computer_settings). world.motd: true brings it back.
      ...(world?.motd !== true && {
        default_computer_settings: "motd.enable=false",
      }),
      ...(size && { defaultWidth: size.width, defaultHeight: size.height }),
      ...(httpRules?.allow && { http_whitelist: httpRules.allow }),
      ...(httpRules?.deny && { http_blacklist: httpRules.deny }),
    }),
  );
  // A normal turtle or computer has no colour (ServerComputer: family != NORMAL); an advanced one does
  if (
    (world?.turtle && !world.turtle.advanced) ||
    world?.placed?.block?.endsWith("_normal") ||
    mobComputer(world as Record<string, unknown> | undefined)?.colour ===
      false ||
    world?.advanced === false
  ) {
    writeFileSync(
      join(dir, "config", `${computerId}.json`),
      JSON.stringify({ isColor: false }),
    );
  }

  const bootPath = join(dir, "boot.lua");
  writeFileSync(
    bootPath,
    [
      world?.motd === true ? "" : DROP_MOTD_EVENT_LUA,
      enginePeripheralLua(world),
      bootLua,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const stderr: string[] = [];
  const spawnEngine = (): RawSession => {
    const started = new RawSession({
      executable: config.engineExe,
      cwd: dir,
      args: [
        "--directory",
        dir,
        "--rom",
        romDir,
        ...engineVersionArgs(version),
        ...(computerId !== 0 ? ["--id", String(computerId)] : []),
        "--mount-ro",
        `ccunit=${config.luaLibDir}`,
        "--mount-rw",
        `results=${resultsDir}`,
        // lets the sim mount a mod's drive writable at run time (mounter.mount(name, dir, false), as Cricket's hard
        // drive mounts its folder); programs never see `mounter` (emulator.hide)
        "-o",
        "mount_mode=ro",
        ...(timeScale !== 1 ? ["--time-scale", String(timeScale)] : []),
        ...(cobaltSlowdown(world) > 1
          ? ["--cobalt-speed", String(cobaltSlowdown(world))]
          : []),
        ...(debug ? ["--debug-connect", `127.0.0.1:${debug.port}`] : []),
        "--script",
        bootPath,
      ],
      // the token goes in the environment, not on the command line other users of the machine can read
      ...(debug && {
        env: { ...process.env, CRAFTOS_DEBUG_TOKEN: debug.token },
      }),
    });
    started.on("stderr", (text) => stderr.push(text));
    return started;
  };
  let session = spawnEngine();
  let commandSeq = 0;
  return {
    get session() {
      return session;
    },
    dir,
    resultsDir,
    stderr,
    sendCommand: (command) => {
      commandSeq += 1;
      session.event("ccsim_cmd", commandSeq, JSON.stringify(command));
      return commandSeq;
    },
    readState: () => {
      try {
        const state = JSON.parse(
          readFileSync(join(resultsDir, "state.json"), "utf8"),
        ) as Record<string, unknown>;
        // CC's JSON encoder writes an empty list as {}; restore arrays.
        for (const key of ["ledger", "rejections", "chat"]) {
          const value = state[key];
          if (
            value &&
            !Array.isArray(value) &&
            Object.keys(value as object).length === 0
          ) {
            state[key] = [];
          }
        }
        return state as SimState;
      } catch {
        return undefined;
      }
    },
    restart: () => {
      if (session.running) return;
      session = spawnEngine();
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface ScreenCapture {
  readonly window: number;
  /** Set for monitors; the main terminal has no peripheral name. */
  readonly peripheral: string | undefined;
  readonly open: boolean;
  readonly width: number;
  readonly height: number;
  readonly lines: string[];
  readonly cursor: { x: number; y: number };
  /** Base64 PNG when screenshots were requested. */
  readonly png?: string;
  /** Set for a pixel screen (pixelScreens): width and height are pixels, there are no lines. */
  readonly pixels?: { readonly hash: string };
}

/**
 * Screens a mod draws pixel by pixel (Tom's Peripherals' GPU monitors): the Lua side writes each one as a binary
 * PPM (P6, 8-bit RGB) to /results/pixels/<name>.ppm. Generic: any addon can show a pixel screen this way.
 */
export interface PixelScreen {
  readonly peripheral: string;
  readonly width: number;
  readonly height: number;
  /** First 16 hex digits of the SHA-1 of the pixels: changes whenever the picture does. */
  readonly hash: string;
  readonly rgba: Uint8Array;
}

export function pixelScreens(resultsDir: string): PixelScreen[] {
  const dir = join(resultsDir, "pixels");
  if (!existsSync(dir)) return [];
  const out: PixelScreen[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".ppm")) continue;
    let data: Buffer;
    try {
      data = readFileSync(join(dir, file));
    } catch {
      continue;
    }
    const head = /^P6\n(\d+) (\d+)\n255\n/.exec(
      data.subarray(0, 32).toString("latin1"),
    );
    if (!head) continue;
    const width = Number(head[1]);
    const height = Number(head[2]);
    const body = data.subarray(head[0].length);
    if (body.length < width * height * 3) continue; // being written
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = body[i * 3]!;
      rgba[i * 4 + 1] = body[i * 3 + 1]!;
      rgba[i * 4 + 2] = body[i * 3 + 2]!;
      rgba[i * 4 + 3] = 255;
    }
    const hash = createHash("sha1")
      .update(body.subarray(0, width * height * 3))
      .digest("hex")
      .slice(0, 16);
    out.push({ peripheral: file.slice(0, -4), width, height, hash, rgba });
  }
  return out;
}

/** A pixel screen as a PNG, scaled up so small screens stay visible (at most 1024 pixels on the long side). */
export function pixelScreenPng(screen: PixelScreen, scale = 2): Buffer {
  const s = Math.max(
    1,
    Math.min(
      scale,
      Math.floor(1024 / Math.max(screen.width, screen.height, 1)),
    ),
  );
  const width = screen.width * s;
  const height = screen.height * s;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / s);
    for (let x = 0; x < width; x++) {
      const so = (sy * screen.width + Math.floor(x / s)) * 4;
      rgba.set(screen.rgba.subarray(so, so + 4), (y * width + x) * 4);
    }
  }
  return encodePng({ width, height, rgba });
}

export function captureScreens(
  session: RawSession,
  options: { png?: boolean; scale?: number; resultsDir?: string } = {},
): ScreenCapture[] {
  const open = new Set(session.windows.keys());
  const seen = new Map<number, WindowState>();
  // Later windows with the same id (reused after close) win.
  for (const w of session.allWindows()) seen.set(w.id, w);
  const captures: ScreenCapture[] = [];
  for (const w of seen.values()) {
    const frame = w.frame;
    if (!frame) continue;
    const lines: string[] = [];
    if (frame.mode === 0) {
      for (let y = 0; y < frame.height; y++) {
        lines.push(
          Buffer.from(
            frame.text.subarray(y * frame.width, (y + 1) * frame.width),
          )
            .toString("latin1")
            .replace(/\s+$/, ""),
        );
      }
    }
    captures.push({
      window: w.id,
      peripheral: w.peripheral,
      open: open.has(w.id),
      width: frame.width,
      height: frame.height,
      lines,
      cursor: { x: frame.cursorX, y: frame.cursorY },
      ...(options.png
        ? {
            png: renderPng(frame, { scale: options.scale ?? 2 }).toString(
              "base64",
            ),
          }
        : {}),
    });
  }
  // pixel screens (pixelScreens) after the terminal and monitors: no window, no text, sized in pixels
  for (const p of options.resultsDir ? pixelScreens(options.resultsDir) : []) {
    captures.push({
      window: -1,
      peripheral: p.peripheral,
      open: true,
      width: p.width,
      height: p.height,
      lines: [],
      cursor: { x: 0, y: 0 },
      pixels: { hash: p.hash },
      ...(options.png
        ? { png: pixelScreenPng(p, options.scale ?? 2).toString("base64") }
        : {}),
    });
  }
  return captures;
}
