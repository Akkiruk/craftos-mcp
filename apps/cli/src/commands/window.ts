import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type BridgedComputer,
  type LinkedComputerSpec,
  type ModemSpec,
  type MonitorSpec,
  type RunnerConfig,
  type WorldConfig,
  SessionManager,
  VIEWER_OWNER,
  WindowBridge,
  checkConfig,
  computerConfigJson,
  copyWorkspace,
  engineVersionArgs,
  ensureRom,
  isBlockWorld,
  liveFolderArgs,
  luaString,
  missingRomProblem,
  monitorSetupLua,
  romDirFor,
  startWebApp,
  terminalSize,
  vhccVersion,
  worldJson,
  versionChoices,
  worldVersion,
} from "@craftos-mcp/runner";
import type { Command } from "../command.js";
import {
  UsageError,
  configFor,
  guarded,
  loadWorld,
  openBrowser,
  parse,
  parseMonitor,
} from "../shared.js";

const USAGE = `
  craftos-mcp window [world...] [--computers <n>] [--mc <version>] [--addons <ids>] [--dir <folder>] [--copy]
                     [--own-folders] [--monitor <name>:<w>x<h>[@<scale>]]... [--speed <x>] [--browser | --no-browser] [--keep]

  Opens the emulated computer in a desktop window, with the same simulated world as craftos_run.
  world           a world JSON file or the name of one in worlds/ (also --world): players, peripherals, addons,
                  and for this command "monitors": [{ name, blocksWide, blocksHigh, textScale }]. Default: none.
                  A turtle world (a "turtle" entry, or blocks) opens the turtle. Two or more worlds open a network:
                  one computer for each, every one in its own window, rednet working between them.
  --computers     open this many computers on one network, all in the same world (each gets a wireless modem on
                  its back unless the world gives it a modem)
  --mc            the Minecraft version: ${versionChoices()}
                  (overrides the world's version and CRAFTOS_VERSION)
  --addons        all, none, or addon ids separated by commas (overrides the world's and CRAFTOS_ADDONS)
  --dir           the computer's files: this folder itself, live. What the computer saves appears there, and what
                  you save there in your editor the computer sees at once. Default: the current folder.
                  Its .git, node_modules and .runtime folders show as empty and cannot be changed from the computer.
  --copy          give the computer a scratch copy of the folder instead: nothing it writes reaches your folder,
                  and the copy goes when the window closes
  --own-folders   on a network, each computer gets its own folder, <dir>/computer/<id>, as CraftOS-PC keeps them
                  (made when missing). Without it they share the folder, except a computer whose computer/<id>
                  folder is there already.
  --monitor       a monitor wall in its own window, e.g. --monitor top:3x2@0.5 (blocks wide x high); click to touch
  --speed         start the clock this many times faster (0.1 to 1000), as the app's speed buttons do
  --browser       also open the browser app on these computers: a turtle's blocks in 3D, a network's messages, the
                  clock and the world panel. On by default for a turtle; --no-browser keeps it closed.
  --keep          keep the scratch folder (results/state.json, trace.log) after the window closes

  F2 saves a screenshot and F3 starts and stops a recording, in Pictures/craftos-mcp (CRAFTOS_SCREENSHOTS to change
  it); each one prints where it went. F12 copies a screenshot to the clipboard.

  The clock's keys in a single computer's window: Alt+P pause or resume, Alt+. one tick (1/20 s), Alt+] faster,
  Alt+[ slower, Alt+\\ normal speed, Alt+J a minute ahead, Alt+H an hour ahead, Alt+N a Minecraft day ahead. The
  title shows [Paused] or the speed. A turtle's or a network's clock is in the browser app (--browser).

  In the computer, \`sim help\` changes the world: players join and chat, items appear, time moves on.
  CraftOS-PC's attach, detach, config and mount work too, and say what the game does instead. Hold Ctrl+T, Ctrl+R
  or Ctrl+S as in the game. Closing a computer's window turns it off; closing the last one ends the command.`;

/**
 * One computer runs the engine with its SDL renderer instead of the raw protocol the runner speaks. Everything else is
 * startEngine's setup (packages/runner/src/engine.ts): the ROM with the ccsim overlay, /results with world.json, the
 * boot script that attaches monitors and hides the emulator's own APIs. The computer's files are the folder itself
 * (--start-dir), so edits show up at once.
 *
 * A turtle and a network need the runner's hosts (the block world, the modem relay), so their computers run as the
 * runner's sessions and one `craftos --raw-client` draws them all (WindowBridge, packages/runner/src/window-bridge.ts).
 */
const window: Command = {
  name: "window",
  summary:
    "open the emulated computer in a desktop window (no AI agent needed)",
  usage: USAGE,
  run: (args) => guarded(USAGE, () => openWindow(args)),
};
export default window;

/**
 * Where F2 screenshots and F3 recordings of a window go: a folder the person keeps (the engine's own data folder is a
 * scratch one, gone when the window closes). CRAFTOS_SCREENSHOTS, else "craftos-mcp" in the Pictures folder (the
 * home folder when there is none).
 */
export function screenshotFolder(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (env["CRAFTOS_SCREENSHOTS"]) return env["CRAFTOS_SCREENSHOTS"];
  const pictures = join(env["USERPROFILE"] ?? home, "Pictures");
  return join(existsSync(pictures) ? pictures : home, "craftos-mcp");
}

/** The engine's environment for a window: where F2 and F3 save, which the engine prints as each one is saved. */
export function windowEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, CRAFTOS_SCREENSHOT_DIR: screenshotFolder(env) };
}

type Values = {
  world?: string;
  addons?: string;
  mc?: string;
  dir?: string;
  help?: boolean;
  monitor?: string[];
  keep?: boolean;
  speed?: string;
  computers?: string;
  copy?: boolean;
  "own-folders"?: boolean;
  browser?: boolean;
  "no-browser"?: boolean;
};

async function openWindow(args: string[]): Promise<number> {
  const parsed = parse(args, {
    monitor: { type: "string", multiple: true },
    keep: { type: "boolean" },
    speed: { type: "string" },
    computers: { type: "string" },
    copy: { type: "boolean" },
    "own-folders": { type: "boolean" },
    browser: { type: "boolean" },
    "no-browser": { type: "boolean" },
  });
  const values = parsed.values as Values;
  const { positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const config = configFor(values.dir);
  const filesDir = config.workspaceDir;
  if (!statSync(filesDir).isDirectory())
    throw new UsageError(`--dir ${filesDir} is not a folder`);
  const problems = checkConfig(config);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    return 1;
  }
  const extraMonitors = (values.monitor ?? []).map(parseMonitor);
  const speedText = values.speed;
  const speed = speedText === undefined ? 1 : Number(speedText);
  if (!(speed >= 0.1 && speed <= 1000))
    throw new UsageError(`--speed is 0.1 to 1000, not ${speedText}`);
  const count =
    values.computers === undefined ? undefined : Number(values.computers);
  if (
    count !== undefined &&
    !(Number.isInteger(count) && count >= 1 && count <= 16)
  )
    throw new UsageError(`--computers is 1 to 16, not ${values.computers}`);

  const names = [...(values.world ? [values.world] : []), ...positionals];
  if (count !== undefined && count > 1 && names.length > 1)
    throw new UsageError(
      "give one world with --computers, or one world for each computer",
    );
  const worlds = (names.length ? names : [undefined]).map((name) => ({
    name,
    world: (loadWorld(config, name, values.addons, values.mc) ??
      {}) as WorldConfig & { monitors?: MonitorSpec[] },
  }));
  if (values["own-folders"] && values.copy)
    throw new UsageError("--own-folders is for the folder itself, not --copy");
  const live = !values.copy;

  // a network: several worlds, or --computers
  if (worlds.length > 1 || (count ?? 1) > 1) {
    const blocky = worlds.find((w) => isBlockWorld(w.world));
    if (blocky)
      throw new UsageError(
        `${blocky.name ?? "the world"} has a turtle or blocks: a turtle world opens on its own, not on a network`,
      );
    const list =
      worlds.length > 1
        ? worlds
        : Array.from({ length: count! }, () => worlds[0]!);
    return openLinked(config, values, {
      kind: "network",
      computers: networkComputers(config, list, extraMonitors, {
        live,
        ownFolders: values["own-folders"] === true,
      }),
      speed,
    });
  }

  const { monitors: worldMonitors = [], ...world } = worlds[0]!.world;
  if (isBlockWorld(world)) {
    const monitors = [...worldMonitors, ...extraMonitors];
    return openLinked(config, values, {
      kind: "turtle",
      world: { ...world, simProgram: true },
      monitors,
      ...(live && { liveDir: filesDir }),
      speed,
    });
  }
  return openOne(config, values, world, [...worldMonitors, ...extraMonitors], {
    live,
    speed,
  });
}

/** The name a world file gives its computer: "sender.world.json" -> "sender". */
function nameFrom(file: string | undefined): string | undefined {
  if (!file) return undefined;
  return basename(file).replace(/(\.world)?\.json$/i, "") || undefined;
}

/**
 * The computers of a network: one per world, each with a modem (a wireless one on its back when the world has none),
 * its own id and seed, a name from its world file (or computer1, computer2, ...), and its folder.
 */
export function networkComputers(
  config: Pick<RunnerConfig, "workspaceDir">,
  list: readonly {
    name?: string | undefined;
    world: WorldConfig & { monitors?: MonitorSpec[] };
  }[],
  extraMonitors: readonly MonitorSpec[],
  files: { live: boolean; ownFolders: boolean },
): (LinkedComputerSpec & { name: string; folder: string })[] {
  const fromFiles = list.map((w) => nameFrom(w.name));
  const distinct =
    fromFiles.every(Boolean) && new Set(fromFiles).size === fromFiles.length;
  // CraftOS-PC's layout keeps computers side by side in computer/<id>: a project folder that is one of them (an
  // imported project's craftos.json picks computer/<id>) finds the others next to it
  const inLayout =
    /^\d+$/.test(basename(config.workspaceDir)) &&
    basename(dirname(config.workspaceDir)) === "computer";
  const computersDir = inLayout
    ? dirname(config.workspaceDir)
    : join(config.workspaceDir, "computer");
  const ids = new Set<number>();
  return list.map(({ world: full }, index) => {
    const { monitors: worldMonitors = [], ...world } = full;
    const peripherals = [...(world.peripherals ?? [])];
    if (!peripherals.some((p) => p.type === "modem")) {
      // on a side nothing else is on
      const taken = new Set([
        ...peripherals.map((p) => p.name),
        ...worldMonitors.map((m) => m.name),
        ...extraMonitors.map((m) => m.name),
      ]);
      const side =
        ["back", "top", "bottom", "left", "right", "front"].find(
          (s) => !taken.has(s),
        ) ?? "back";
      peripherals.push({
        name: side,
        type: "modem",
        kind: "wireless",
      } as ModemSpec);
    }
    // the same world twice is two computers: each its own id and, if the world pins one, its own random seed
    let id = world.computerId ?? index;
    while (ids.has(id)) id += 1;
    ids.add(id);
    const name = distinct ? fromFiles[index]! : `computer${index + 1}`;
    const own =
      inLayout && basename(config.workspaceDir) === String(id)
        ? config.workspaceDir
        : join(computersDir, String(id));
    const folder = !files.live
      ? config.workspaceDir
      : files.ownFolders || existsSync(own)
        ? own
        : config.workspaceDir;
    if (files.live && folder === own) mkdirSync(own, { recursive: true });
    return {
      name,
      folder,
      world: {
        ...world,
        peripherals,
        computerId: id,
        label: typeof world.label === "string" ? world.label : name,
        simProgram: true,
        ...(world.seed !== undefined && { seed: world.seed + index }),
      },
      monitors: [...worldMonitors, ...extraMonitors],
      ...(files.live && { liveDir: folder }),
    };
  });
}

type Linked =
  | {
      kind: "turtle";
      world: WorldConfig;
      monitors: MonitorSpec[];
      liveDir?: string;
      speed: number;
    }
  | {
      kind: "network";
      computers: (LinkedComputerSpec & { name: string; folder: string })[];
      speed: number;
    };

/**
 * A turtle or a network: the computers run as the runner's sessions (the block world and the modem relay are the
 * runner's), and one raw client draws every window. The browser app over the same sessions shows what a window
 * cannot: the turtle's blocks in 3D, the messages between computers, the clock.
 */
async function openLinked(
  config: RunnerConfig,
  values: Values,
  what: Linked,
): Promise<number> {
  const sessions = new SessionManager(config);
  for (const w of what.kind === "turtle"
    ? [what.world]
    : what.computers.map((c) => c.world!))
    await ensureRom(config, w.version);

  let computers: () => BridgedComputer[];
  // the names the browser app shows for these computers (it names sessions it did not make by their id)
  const named: [string, string][] = [];
  if (what.kind === "turtle") {
    const session = sessions.create(
      what.monitors,
      what.speed,
      what.world,
      undefined,
      undefined,
      undefined,
      what.liveDir,
    );
    const label =
      typeof what.world.label === "string" ? what.world.label : "turtle";
    named.push([session.id, label]);
    const network = session.blockWorld?.network;
    // the turtle, and every computer or turtle it places and turns on
    computers = () =>
      (network?.computers() ?? [{ name: "main", handle: session.handle }]).map(
        (c) => ({ name: c.name === "main" ? label : c.name, handle: c.handle }),
      );
    console.log(
      `turtle files:   ${what.liveDir ?? "a scratch copy of " + config.workspaceDir}`,
    );
  } else {
    const linked = sessions.createNetwork({
      computers: what.computers,
      timeScale: what.speed,
    });
    computers = () =>
      Object.entries(linked.computers).map(([name, s]) => ({
        name,
        handle: s.handle,
      }));
    for (const [name, s] of Object.entries(linked.computers))
      named.push([s.id, name]);
    const shared =
      new Set(what.computers.map((c) => c.folder)).size === 1 &&
      what.computers.length > 1 &&
      what.computers[0]!.liveDir;
    for (const c of what.computers)
      console.log(
        `${c.name} (id ${c.world!.computerId}): ${c.liveDir ? c.folder : `a scratch copy of ${c.folder}`}`,
      );
    if (shared)
      console.log(
        "These computers share one folder: a file one of them saves, the others see. --own-folders gives each its own.",
      );
  }

  // the browser app on the same computers, for the views a window cannot draw
  const openPage =
    values["no-browser"] !== true &&
    (values.browser === true || what.kind === "turtle");
  const server = startWebApp({
    port: 0,
    sessions,
    config,
    onListening: (url) => {
      const page = `${url}?view=${what.kind === "turtle" ? "blocks" : "network"}`;
      console.log(
        what.kind === "turtle"
          ? `the turtle's blocks in 3D: ${page}`
          : `messages between the computers, the clock and the world: ${page}`,
      );
      // a person's computers, as the app's own are (a snapshot restore keeps them)
      for (const [id] of named) sessions.setOwner(id, VIEWER_OWNER);
      void Promise.all(
        named.map(([id, name]) =>
          fetch(new URL(`api/sessions/${id}`, url), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          }).catch(() => undefined),
        ),
      ).then(() => {
        if (openPage) openBrowser(page);
      });
    },
  });

  const clientDir = mkdtempSync(join(config.runtimeDir, "window-"));
  const client = spawn(
    config.engineExe,
    ["--raw-client", "--directory", clientDir],
    { cwd: clientDir, stdio: ["pipe", "pipe", "inherit"], env: windowEnv() },
  );
  console.log(`F2 screenshots and F3 recordings: ${screenshotFolder()}`);
  console.log("type `sim help` in a computer; close the windows to stop");
  let finish: (status: number) => void = () => undefined;
  const ended = new Promise<number>((done) => {
    finish = done;
  });
  const bridge = new WindowBridge(computers, client, {
    names: true,
    onEmpty: () => finish(0),
  });
  client.on("error", (error) => {
    console.error(`could not start ${config.engineExe}: ${error.message}`);
    finish(1);
  });
  client.on("exit", () => finish(0));
  const interrupted = (): void => finish(130);
  process.once("SIGINT", interrupted);
  const code = await ended;
  process.off("SIGINT", interrupted);
  bridge.close();
  server.close();
  await sessions.destroyAll();
  // the client quits when the bridge tells it; one that does not, goes
  if (client.exitCode === null && client.signalCode === null) {
    await new Promise((r) => setTimeout(r, 500));
    if (client.exitCode === null) client.kill();
  }
  if (values.keep) console.log(`kept ${clientDir}`);
  else rmSync(clientDir, { recursive: true, force: true });
  return code;
}

/** One computer in the engine's own window: real speaker sound and the clock's keys. */
async function openOne(
  config: RunnerConfig,
  values: Values,
  base: WorldConfig,
  monitors: MonitorSpec[],
  options: { live: boolean; speed: number },
): Promise<number> {
  const world = { ...base };
  const filesDir = config.workspaceDir;
  const speed = options.speed;
  // Speakers make real sound here: the engine's own speaker (SDL_mixer) stands in for the silent sim one
  const speakers = (world.peripherals ?? [])
    .filter((p) => p.type === "speaker")
    .map((p) => p.name);
  world.peripherals = (world.peripherals ?? []).filter(
    (p) => p.type !== "speaker",
  ) as WorldConfig["peripherals"];
  let worldText: string;
  try {
    // a person drives this computer: it gets the emulator's `sim` program (rom/ccsim/sim_shell.lua)
    worldText = worldJson({ ...world, simProgram: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  // the Minecraft / CC:Tweaked version (world.version, --mc or CRAFTOS_VERSION) picks the ROM and --cc-version
  const version = worldVersion(world);
  const romDir = romDirFor(config, version);
  // an installed package builds a version's ROM the first time it is asked for
  await ensureRom(config, world.version);
  const missingRom = missingRomProblem(romDir, version.mc);
  if (missingRom) {
    console.error(missingRom);
    return 1;
  }

  const dir = mkdtempSync(join(config.runtimeDir, "window-"));
  const resultsDir = join(dir, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, "world.json"), worldText);
  const vhccOn =
    vhccVersion(world, version) !== false &&
    existsSync(join(romDir, "rom", "ccsim", "vhcc.lua"));
  const vhccDir = join(dir, "vhcc_data");
  if (vhccOn) mkdirSync(vhccDir, { recursive: true });
  const size = terminalSize(world);
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "global.json"),
    JSON.stringify({
      computerSpaceLimit: 25_000_000,
      checkUpdates: false,
      // the sim mounts its own folders (a mod's drive, a certificate store); the engine's "Mount requested" box
      // would stop the boot until it is answered, and programs never see `mounter` anyway
      showMountPrompt: false,
      ...(size && { defaultWidth: size.width, defaultHeight: size.height }),
    }),
  );
  // the label (os.getComputerLabel) and a normal computer's lack of colour, as startEngine writes them
  const perComputer = computerConfigJson(world, world.advanced !== false);
  if (perComputer)
    writeFileSync(
      join(dir, "config", `${world.computerId ?? 0}.json`),
      perComputer,
    );
  const enginePeripherals = [
    ...(world.peripherals ?? [])
      .filter((p) => p.type === "drive")
      .map((p) => ({ name: p.name, type: "drive" })),
    ...speakers.map((name) => ({ name, type: "speaker" })),
  ].map(
    (p) =>
      `periphemu.create(${luaString(p.name)}, ${luaString(p.type)})\n` +
      `if peripheral.__ccsimNamed then peripheral.__ccsimNamed(${luaString(p.name)}) end`,
  );
  const bootPath = join(dir, "boot.lua");
  writeFileSync(
    bootPath,
    [...enginePeripherals, monitorSetupLua(monitors)].join("\n"),
  );

  const id = world.computerId ?? 0;
  // the folder itself, live; or with --copy a scratch copy in the run folder, as the app's copies are made
  const copyDir = join(dir, "computer", String(id));
  if (!options.live) {
    mkdirSync(copyDir, { recursive: true });
    copyWorkspace(filesDir, copyDir, {
      exclude: [config.runtimeDir],
      gitignore: true,
    });
  }
  const engineArgs = [
    "--directory",
    dir,
    "--rom",
    romDir,
    ...engineVersionArgs(version),
    ...(options.live
      ? liveFolderArgs(config, filesDir, join(dir, "empty"))
      : []),
    ...(id !== 0 ? ["--id", String(id)] : []),
    "--mount-ro",
    `ccunit=${config.luaLibDir}`,
    "--mount-rw",
    `results=${resultsDir}`,
    // as the headless runs: the sim can mount a mod's drive writable
    "-o",
    "mount_mode=ro",
    ...(vhccOn ? ["--mount-rw", `.vhcc_data=${vhccDir}`] : []),
    ...(speed !== 1 ? ["--time-scale", String(speed)] : []),
    "--script",
    bootPath,
  ];
  console.log(
    options.live
      ? `computer files: ${filesDir} (the folder itself: edits show at once)`
      : `computer files: a scratch copy of ${filesDir} (it goes when the window closes)`,
  );
  console.log(`world state:    ${join(resultsDir, "state.json")}`);
  console.log(`screenshots:    ${screenshotFolder()} (F2, and F3 to record)`);
  console.log("type `sim help` in the computer; close the window to stop");
  const code = await new Promise<number>((done) => {
    const child = spawn(config.engineExe, engineArgs, {
      cwd: dir,
      stdio: "inherit",
      env: windowEnv(),
    });
    child.on("error", (error) => {
      console.error(`could not start ${config.engineExe}: ${error.message}`);
      done(1);
    });
    child.on("exit", (status) => done(status ?? 0));
  });
  if (values.keep) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
  return code;
}
