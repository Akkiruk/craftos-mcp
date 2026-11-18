import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { Command } from "../command.js";
import {
  UsageError,
  configFor,
  guarded,
  loadWorld,
  number,
  parse,
  monitorsFor,
  workspacePath,
} from "../shared.js";
import {
  type ScreenCapture,
  DEFAULT_TIMEOUT_MS,
  WorkspaceError,
  checkProgram,
  versionChoices,
  resolveInWorkspace,
  runProgram,
} from "@craftos-mcp/runner";

const USAGE = [
  "usage: craftos-mcp run <program.lua> [args...] [--world x.json] [--mc 1.20.1] [--addons a,b] [--monitor name:WxH]",
  "                      [--timeout seconds] [--timescale n] [--screenshot out.png] [--dir folder]",
  "",
  `--mc picks the Minecraft version: ${versionChoices()}.`,
  "Runs the program in a fresh computer and prints the terminal and every monitor as text. Put program arguments",
  "that start with - after --. --screenshot saves the terminal as out.png and each monitor as out-<name>.png.",
  'Monitors: each --monitor (top:3x2, blocks wide x high) and the ones a world file lists under "monitors".',
  "Exit code: 0 finished, 1 the program failed, 124 timed out, 2 engine or usage error.",
].join("\n");

const trimBlank = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  return lines.slice(0, end);
};

function title(screen: ScreenCapture): string {
  return screen.peripheral
    ? `monitor ${screen.peripheral} (${screen.width}x${screen.height})`
    : `terminal (${screen.width}x${screen.height})`;
}

/** Terminal and monitors as text blocks. Exported for tests. */
export function formatScreens(screens: readonly ScreenCapture[]): string {
  const out: string[] = [];
  for (const s of screens) {
    out.push(`--- ${title(s)} ---`);
    if (s.pixels)
      out.push(
        `(pixel screen ${s.width}x${s.height}px, hash ${s.pixels.hash}; use --screenshot to see it)`,
      );
    else out.push(...trimBlank(s.lines));
  }
  return out.join("\n");
}

function savePngs(screens: readonly ScreenCapture[], out: string): string[] {
  const ext = extname(out) || ".png";
  const base = extname(out) ? out.slice(0, -ext.length) : out;
  const saved: string[] = [];
  for (const s of screens) {
    if (!s.png) continue;
    const file = s.peripheral
      ? `${base}-${s.peripheral.replace(/[^\w.-]/g, "_")}${ext}`
      : `${base}${ext}`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(s.png, "base64"));
    saved.push(file);
  }
  return saved;
}

const run: Command = {
  name: "run",
  summary: "run a Lua program and print its terminal and monitors as text",
  usage: USAGE,
  run: (args) =>
    guarded(USAGE, async () => {
      const { values, positionals } = parse(args, {
        timescale: { type: "string" },
        timeout: { type: "string" },
        monitor: { type: "string", multiple: true },
        screenshot: { type: "string" },
      });
      if (values.help) {
        console.log(USAGE);
        return 0;
      }
      const [typed, ...programArgs] = positionals;
      if (!typed) throw new UsageError("give a program to run");
      const config = configFor(values.dir);
      const program = workspacePath(config, typed);
      try {
        resolveInWorkspace(config.workspaceDir, program);
      } catch (error) {
        throw new UsageError((error as Error).message);
      }
      const timeout = number("timeout", values.timeout);
      const world = loadWorld(config, values.world, values.addons, values.mc);
      const missing = checkProgram(config, program, world);
      if (missing) throw new WorkspaceError(missing);
      const result = await runProgram(config, {
        program,
        args: programArgs,
        monitors: monitorsFor(world, values.monitor),
        world,
        timeScale: number("timescale", values.timescale),
        screenshots: values.screenshot !== undefined,
        ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
      });
      const exit =
        result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
      console.log(
        `${program}: ${result.status} (${exit}, ${result.durationMs} ms)`,
      );
      console.log(formatScreens(result.screens));
      for (const c of result.computers ?? []) {
        console.log(
          `\n=== computer ${c.name} #${c.id} at ${c.pos} (${c.running ? "running" : "stopped"}) ===`,
        );
        console.log(formatScreens(c.screens));
      }
      for (const m of result.messages)
        console.log(`\n[${m.title}] ${m.message}`);
      if (result.error) {
        const at = result.error.file
          ? `${result.error.file}${result.error.line ? `:${result.error.line}` : ""}: `
          : "";
        console.log(
          `\nerror (${result.error.kind}): ${at}${result.error.message}`,
        );
      }
      if (result.status === "timed_out") {
        // a program that runs for good (a monitor UI) ends this way too; a slow one (a turtle moves as slowly as in
        // the game) needs more time, or a faster clock
        const seconds =
          Math.round((timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 10) / 10;
        console.log(
          `\nStill running after ${seconds} s, so it was stopped there. For a program that needs longer, give it ` +
            `--timeout 120, or run the clock faster with --timescale 5 (sleep and turtle moves go 5 times faster).`,
        );
      }
      if (result.stderr) console.error(`\nengine stderr:\n${result.stderr}`);
      if (values.screenshot !== undefined) {
        for (const file of savePngs(result.screens, values.screenshot))
          console.log(`saved ${file}`);
      }
      return result.status === "completed"
        ? 0
        : result.status === "program_failed"
          ? 1
          : result.status === "timed_out"
            ? 124
            : 2;
    }),
};
export default run;
