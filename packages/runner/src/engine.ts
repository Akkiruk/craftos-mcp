import {
  cpSync,
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
import { basename, join } from "node:path";
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
import { missingRomProblem } from "./config.js";
import { resolveInWorkspace } from "./workspace.js";

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

/** Directory names never copied into the computer. */
const SKIP = new Set([".git", "node_modules", "__snapshots__"]);
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
}

/** A directory link that needs no rights on Windows (a junction). */
function linkDir(target: string, path: string): void {
  mkdirSync(target, { recursive: true });
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, ".."), { recursive: true });
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
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
  } = options;
  const dir = mkdtempSync(join(config.runtimeDir, `${label}-`));
  const resultsDir = join(dir, "results");
  const computerId = world?.computerId ?? 0;
  const computerDir = join(dir, "computer", String(computerId));
  if (shared) {
    linkDir(shared.diskDir, join(dir, "computer", "disk"));
    if (shared.computerDir) linkDir(shared.computerDir, computerDir);
  }
  mkdirSync(computerDir, { recursive: true });
  const copyFilter = (source: string): boolean =>
    !SKIP.has(basename(source) ?? "");
  if (shared?.fresh) {
    // a computer a turtle placed: nothing on it but what it was given before
  } else if (world?.deploy && world.deploy.length > 0) {
    for (const entry of world.deploy) {
      cpSync(
        resolveInWorkspace(config.workspaceDir, entry.from),
        resolveInWorkspace(computerDir, entry.to ?? "."),
        { recursive: true, filter: copyFilter },
      );
    }
  } else {
    cpSync(config.workspaceDir, computerDir, {
      recursive: true,
      filter: copyFilter,
    });
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
      ...(size && { defaultWidth: size.width, defaultHeight: size.height }),
      ...(httpRules?.allow && { http_whitelist: httpRules.allow }),
      ...(httpRules?.deny && { http_blacklist: httpRules.deny }),
    }),
  );
  // A normal turtle or computer has no colour (ServerComputer: family != NORMAL); an advanced one does
  if (
    (world?.turtle && !world.turtle.advanced) ||
    world?.placed?.block?.endsWith("_normal") ||
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
    [enginePeripheralLua(world), bootLua].filter(Boolean).join("\n"),
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
        ...(timeScale !== 1 ? ["--time-scale", String(timeScale)] : []),
        ...(cobaltSlowdown(world) > 1
          ? ["--cobalt-speed", String(cobaltSlowdown(world))]
          : []),
        "--script",
        bootPath,
      ],
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
