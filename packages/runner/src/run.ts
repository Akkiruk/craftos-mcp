import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBlockWorld, startInBlockWorld } from "./blockworld.js";
import type { RunnerConfig } from "./config.js";
import {
  type EngineHandle,
  type ScreenCapture,
  captureScreens,
  stageWithin,
  startEngine,
} from "./engine.js";
import {
  type MonitorSpec,
  REDRAW_TERMINAL_LUA,
  luaString,
  monitorSetupLua,
} from "./lua.js";
import { type SimState, type WorldConfig, shownState } from "./world.js";

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
  /** Stops the run (a cancelled request): the computer stops and its scratch folder goes. */
  readonly signal?: AbortSignal;
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
  /** program_failed: why, with the file and line when the error names them. */
  readonly error?: RunError;
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

/**
 * Lua around the program: remembers what printError showed while it ran, and when it fails writes
 * /results/error.json saying why (no such program, a syntax error, or the error the shell printed), so the result can
 * name the file and line instead of leaving them in wrapped screen text.
 */
const RUN_ERROR_LUA = `
local function ccsimRun(program, ...)
  local shown, rawPrintError = {}, _G.printError
  _G.printError = function(...)
    local t = table.pack(...)
    for i = 1, t.n do t[i] = tostring(t[i]) end
    shown[#shown + 1] = table.concat(t, "\\t")
    return rawPrintError(...)
  end
  local ok = shell.run(program, ...)
  _G.printError = rawPrintError
  if ok then return true end
  local name = program:match("^%S+") or program
  local path = shell.resolveProgram(name)
  local info
  if not path then
    info = { kind = "not_found", message = "No such program: " .. name }
  else
    local h = fs.open(path, "r")
    local src = h and h.readAll() or ""
    if h then h.close() end
    local fn, syntax = load(src, "@/" .. path)
    if not fn then info = { kind = "syntax", message = tostring(syntax) }
    else info = { kind = "runtime", message = shown[#shown] or "the program failed without an error message" } end
  end
  local out = fs.open("/results/error.json", "w")
  if out then out.write(textutils.serializeJSON(info)) out.close() end
  return false
end`;

export function programBoot(request: RunRequest): string {
  const args = (request.args ?? []).map(luaString).join(", ");
  return [
    monitorSetupLua(request.monitors ?? []),
    RUN_ERROR_LUA,
    `local ok = ccsimRun(${luaString(request.program)}${args ? ", " + args : ""})`,
    REDRAW_TERMINAL_LUA,
    `os.shutdown(ok and 0 or 1)`,
  ].join("\n");
}

/** Why a program failed, from /results/error.json (RUN_ERROR_LUA), with the file and line pulled out of the message. */
export interface RunError {
  readonly kind: "not_found" | "syntax" | "runtime";
  readonly message: string;
  /** Computer path of the file the error points at, without the leading slash (e.g. "src/main.lua"). */
  readonly file?: string;
  readonly line?: number;
}

/** "file:line: message" (Lua's error position) split into its parts; anything else is just the message. */
export function parseLuaError(
  text: string,
  kind: RunError["kind"] = "runtime",
): RunError {
  const m = /^([^\s:][^:\n]*):(\d+): ([\s\S]*)$/.exec(text.trim());
  if (!m) return { kind, message: text.trim() };
  return {
    kind,
    message: m[3]!.trim(),
    file: m[1]!.replace(/^\/+/, ""),
    line: Number(m[2]),
  };
}

function readRunError(resultsDir: string): RunError | undefined {
  const raw = readResultFile<{ kind?: string; message?: string }>(
    resultsDir,
    "error.json",
  );
  if (!raw || typeof raw.message !== "string") return undefined;
  const kind =
    raw.kind === "not_found" || raw.kind === "syntax" ? raw.kind : "runtime";
  return kind === "not_found"
    ? { kind, message: raw.message }
    : parseLuaError(raw.message, kind);
}

export async function runProgram(
  config: RunnerConfig,
  request: RunRequest,
): Promise<RunResult> {
  const started = Date.now();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const boot = programBoot(request);
  const blockWorld = request.world && isBlockWorld(request.world);
  // the copy counts against the timeout, and never blocks: other clients of the MCP server go on meanwhile
  const staged = blockWorld
    ? undefined
    : await stageWithin(
        config,
        "run",
        request.world,
        timeoutMs,
        request.signal,
      );
  if (staged === "timed_out")
    return copyTimedOut(started, timeoutMs, request.signal);
  // a turtle's world: the host that shares its blocks and starts the computers it places
  const blocks = blockWorld
    ? startInBlockWorld(config, boot, {
        label: "run",
        timeScale: request.timeScale,
        world: request.world!,
      })
    : undefined;
  const handle =
    blocks?.handle ??
    startEngine(config, boot, {
      label: "run",
      timeScale: request.timeScale,
      world: request.world,
      ...(staged && { staged }),
    });
  try {
    return await finishRun(request, handle, blocks, started, timeoutMs);
  } finally {
    if (blocks) {
      blocks.network.close();
      await blocks.host.dispose(request.keepRuntime);
    }
    if (!request.keepRuntime) handle.dispose();
  }
}

/** A run whose workspace copy outlasted its timeout (or was cancelled): a result, not a hung request. */
function copyTimedOut(
  started: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): RunResult {
  return {
    status: "timed_out",
    exitCode: null,
    durationMs: Date.now() - started,
    screens: [],
    stderr: "",
    messages: [
      {
        title: signal?.aborted ? "cancelled" : "timed out",
        message: signal?.aborted
          ? "cancelled while copying the workspace onto the computer"
          : `copying the workspace onto the computer took more than ${timeoutMs} ms: the workspace is too big. ` +
            'Point it at the folder with your programs, or give the world a deploy list ({"deploy": [{"from": "src"}]}).',
      },
    ],
  };
}

async function finishRun(
  request: RunRequest,
  handle: EngineHandle,
  blocks: ReturnType<typeof startInBlockWorld> | undefined,
  started: number,
  timeoutMs: number,
): Promise<RunResult> {
  const { session } = handle;
  let timedOut = false;
  let exitCode: number | null = null;
  const remaining = Math.max(100, timeoutMs - (Date.now() - started));
  const onAbort = (): void => {
    void session.stop(0).catch(() => undefined);
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const exit = await session.waitForExit(remaining).catch(async () => {
      timedOut = true;
      return session.stop(0);
    });
    exitCode = exit.code;
    if (request.signal?.aborted) timedOut = true;
  } finally {
    // the session says it exited only once stdout is drained, so the last frames are in by now
    request.signal?.removeEventListener("abort", onAbort);
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
    ...(!timedOut &&
      exitCode === 1 && {
        error: readRunError(handle.resultsDir) ?? {
          kind: "runtime" as const,
          message: "the program failed; see the terminal",
        },
      }),
    ...(request.world ? { sim: shownState(handle.readState()) } : {}),
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
        sim: shownState(c.handle.readState()),
      })),
    }),
  };
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
