import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBlockWorld, startInBlockWorld } from "./blockworld.js";
import type { RunnerConfig } from "./config.js";
import { type ScreenCapture, captureScreens, startEngine } from "./engine.js";
import {
  type MonitorSpec,
  REDRAW_TERMINAL_LUA,
  luaString,
  monitorSetupLua,
} from "./lua.js";
import type { SimState, WorldConfig } from "./world.js";

export interface RunRequest {
  /** Workspace-relative program path, e.g. "hello.lua". */
  readonly program: string;
  readonly args?: readonly string[];
  readonly monitors?: readonly MonitorSpec[];
  /** Simulated world: players, owner, virtual peripherals and their state. */
  readonly world?: WorldConfig;
  readonly timeoutMs?: number;
  /** Run the virtual clock this many times faster than real time (default 1). */
  readonly timeScale?: number;
  /** Include base64 PNGs of every terminal and monitor. */
  readonly screenshots?: boolean;
  /** PNG pixel multiplier (default 2). */
  readonly scale?: number;
  /** Keep the scratch directory (for debugging) instead of deleting it. */
  readonly keepRuntime?: boolean;
}

export type RunStatus =
  | "completed"
  | "program_failed"
  | "timed_out"
  | "engine_error";

export interface RunResult {
  readonly status: RunStatus;
  /** os.shutdown code: 0 when the program returned normally, 1 when it errored. */
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly screens: ScreenCapture[];
  readonly stderr: string;
  readonly messages: { title: string; message: string }[];
  /** Balances, ledger and chat log from the simulated server at the end of the run. */
  readonly sim?: SimState;
  readonly runtimeDir?: string;
  /** Block worlds: every computer block a turtle placed that something turned on. */
  readonly computers?: {
    name: string;
    id: number;
    pos: string;
    running: boolean;
    screens: ScreenCapture[];
    sim?: SimState;
  }[];
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export function programBoot(request: RunRequest): string {
  const args = (request.args ?? []).map(luaString).join(", ");
  return [
    monitorSetupLua(request.monitors ?? []),
    `local ok = shell.run(${luaString(request.program)}${args ? ", " + args : ""})`,
    REDRAW_TERMINAL_LUA,
    `os.shutdown(ok and 0 or 1)`,
  ].join("\n");
}

export async function runProgram(
  config: RunnerConfig,
  request: RunRequest,
): Promise<RunResult> {
  const started = Date.now();
  const boot = programBoot(request);
  // a turtle's world: the host that shares its blocks and starts the computers it places
  const blocks =
    request.world && isBlockWorld(request.world)
      ? startInBlockWorld(config, boot, {
          label: "run",
          timeScale: request.timeScale,
          world: request.world,
        })
      : undefined;
  const handle =
    blocks?.handle ??
    startEngine(config, boot, {
      label: "run",
      timeScale: request.timeScale,
      world: request.world,
    });
  const { session } = handle;
  let timedOut = false;
  let exitCode: number | null = null;
  try {
    const exit = await session
      .waitForExit(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      .catch(async () => {
        timedOut = true;
        return session.stop(0);
      });
    exitCode = exit.code;
  } finally {
    // give any last frames a moment to arrive before reading the screens
    await new Promise((r) => setTimeout(r, 50));
  }
  const screens = captureScreens(session, {
    png: request.screenshots ?? false,
    scale: request.scale ?? 2,
    resultsDir: handle.resultsDir,
  });
  const result: RunResult = {
    status: timedOut
      ? "timed_out"
      : exitCode === 0
        ? "completed"
        : exitCode === 1
          ? "program_failed"
          : "engine_error",
    exitCode,
    durationMs: Date.now() - started,
    screens,
    stderr: handle.stderr.join("").trim(),
    messages: session.messages,
    ...(request.world ? { sim: handle.readState() } : {}),
    ...(request.keepRuntime ? { runtimeDir: handle.dir } : {}),
    ...(blocks && {
      computers: blocks.host.computers().map((c) => ({
        name: c.name,
        id: c.id,
        pos: c.pos,
        running: c.handle.session.running,
        screens: captureScreens(c.handle.session, {
          png: request.screenshots ?? false,
          scale: request.scale ?? 2,
          resultsDir: c.handle.resultsDir,
        }),
        sim: c.handle.readState(),
      })),
    }),
  };
  if (blocks) {
    blocks.network.close();
    await blocks.host.dispose(request.keepRuntime);
  }
  if (!request.keepRuntime) handle.dispose();
  return result;
}

/** Read a JSON file the Lua side wrote into /results. */
export function readResultFile<T>(
  resultsDir: string,
  name: string,
): T | undefined {
  try {
    return JSON.parse(readFileSync(join(resultsDir, name), "utf8")) as T;
  } catch {
    return undefined;
  }
}
