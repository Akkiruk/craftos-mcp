import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type MonitorSpec,
  type WorldConfig,
  checkConfig,
  engineVersionArgs,
  isBlockWorld,
  luaString,
  missingRomProblem,
  monitorSetupLua,
  romDirFor,
  terminalSize,
  worldJson,
  worldVersion,
} from "@craftos-mcp/runner";
import type { Command } from "../command.js";
import {
  UsageError,
  configFor,
  guarded,
  loadWorld,
  parse,
  parseMonitor,
} from "../shared.js";

const USAGE = `
  craftos-mcp window [world] [--mc <version>] [--addons <ids>] [--dir <folder>] [--monitor <name>:<w>x<h>[@<scale>]]... [--keep]

  Opens the emulated computer in a desktop window, with the same simulated world as craftos_run.
  world           a world JSON file or the name of one in worlds/ (also --world): players, peripherals, addons,
                  and for this command "monitors": [{ name, blocksWide, blocksHigh, textScale }]. Default: none.
  --mc            the Minecraft version: 1.18.2 (CC:Tweaked 1.101.3, the default), 1.20.1 or 1.21.1 (CC:Tweaked 1.121.0)
                  (overrides the world's version and CRAFTOS_VERSION)
  --addons        all, none, or addon ids separated by commas (overrides the world's and CRAFTOS_ADDONS)
  --dir           the computer's files, live: edit them in your editor, hold Ctrl+R in the window to reboot.
                  Default: the current folder.
  --monitor       a monitor wall in its own window, e.g. --monitor top:3x2@0.5 (blocks wide x high); click to touch
  --keep          keep the scratch folder (results/state.json, trace.log) after the window closes

  In the computer, \`sim help\` changes the world: players join and chat, items appear, time moves on.
  Not in the window yet: turtle and block worlds, several computers on one network.`;

/**
 * The window runs the engine with its SDL renderer instead of the raw protocol the runner speaks. Everything else is
 * startEngine's setup (packages/runner/src/engine.ts): the ROM with the ccsim overlay, /results with world.json, the
 * boot script that attaches monitors and hides the emulator's own APIs. The computer's files are the folder itself
 * (--start-dir), so edits show up on the next reboot.
 */
const window: Command = {
  name: "window",
  summary:
    "open the emulated computer in a desktop window (no AI agent needed)",
  usage: USAGE,
  run: (args) => guarded(USAGE, () => openWindow(args)),
};
export default window;

async function openWindow(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    monitor: { type: "string", multiple: true },
    keep: { type: "boolean" },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length > 1)
    throw new UsageError(`one world only (got ${positionals.join(" ")})`);
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

  const { monitors: worldMonitors = [], ...world } = (loadWorld(
    config,
    values.world ?? positionals[0],
    values.addons,
    values.mc,
  ) ?? {}) as WorldConfig & { monitors?: MonitorSpec[] };
  if (isBlockWorld(world)) {
    console.error(
      "turtle and block worlds (turtle, placed) do not open in a window yet: use craftos-mcp run or the app",
    );
    return 1;
  }
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
  const missingRom = missingRomProblem(romDir, version.mc);
  if (missingRom) {
    console.error(missingRom);
    return 1;
  }

  const dir = mkdtempSync(join(config.runtimeDir, "window-"));
  const resultsDir = join(dir, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, "world.json"), worldText);
  const size = terminalSize(world);
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "global.json"),
    JSON.stringify({
      computerSpaceLimit: 25_000_000,
      checkUpdates: false,
      ...(size && { defaultWidth: size.width, defaultHeight: size.height }),
    }),
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
    [
      ...enginePeripherals,
      monitorSetupLua([...worldMonitors, ...extraMonitors]),
    ].join("\n"),
  );

  const id = world.computerId ?? 0;
  const engineArgs = [
    "--directory",
    dir,
    "--rom",
    romDir,
    ...engineVersionArgs(version),
    "--start-dir",
    filesDir,
    ...(id !== 0 ? ["--id", String(id)] : []),
    "--mount-ro",
    `ccunit=${config.luaLibDir}`,
    "--mount-rw",
    `results=${resultsDir}`,
    "--script",
    bootPath,
  ];
  console.log(`computer files: ${filesDir}`);
  console.log(`world state:    ${join(resultsDir, "state.json")}`);
  console.log("type `sim help` in the computer; close the window to stop");
  const code = await new Promise<number>((done) => {
    const child = spawn(config.engineExe, engineArgs, {
      cwd: dir,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`could not start ${config.engineExe}: ${error.message}`);
      done(1);
    });
    child.on("exit", (status) => done(status ?? 0));
  });
  if ((values as { keep?: boolean }).keep) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
  return code;
}
