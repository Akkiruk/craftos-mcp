import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { isBlockWorld, startInBlockWorld } from "./blockworld.js";
import type { RunnerConfig } from "./config.js";
import { captureScreens, stageWithin, startEngine } from "./engine.js";
import { COPY_SKIP } from "./copy.js";
import {
  type MonitorSpec,
  REDRAW_TERMINAL_LUA,
  luaString,
  monitorSetupLua,
} from "./lua.js";
import {
  DEFAULT_TIMEOUT_MS,
  UNATTENDED_LUA,
  parseLuaError,
  readResultFile,
} from "./run.js";
import type { WorldConfig } from "./world.js";
import { ensureRom } from "./versions.js";
import { listWorkspace } from "./workspace.js";

export interface TestCase {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string | undefined;
  /** ccunit.skip: not run (passed is true). */
  readonly skipped?: boolean;
  /** Where the error points (the assertion's line, for ccunit's own checks), from "file:line: message". */
  readonly file?: string;
  readonly line?: number;
}

export interface TestFileResult {
  readonly file: string;
  readonly status: "passed" | "failed" | "timed_out" | "crashed";
  readonly tests: TestCase[];
  /** Final terminal text, included when a file did not pass. */
  readonly terminal?: string[] | undefined;
  readonly durationMs: number;
}

export interface TestRunResult {
  readonly passed: number;
  readonly failed: number;
  /** ccunit.skip tests (not in passed). */
  readonly skipped?: number;
  readonly files: TestFileResult[];
}

export interface TestRequest {
  /** Workspace-relative files or directories. Default: every *.test.lua. */
  readonly paths?: readonly string[];
  readonly monitors?: readonly MonitorSpec[];
  /** Simulated world (players, virtual peripherals). */
  readonly world?: WorldConfig;
  readonly timeoutMs?: number;
  /** Run the virtual clock this many times faster than real time (default 1). */
  readonly timeScale?: number;
  /** The computer's disk size in bytes (default: the real server's 25 MB; CC:Tweaked's own default is 1,000,000). */
  readonly computerSpaceLimit?: number;
  /** Stops the run (a cancelled request): running files stop and their scratch folders go. */
  readonly signal?: AbortSignal;
  /** Called as each file finishes (progress for a long run). */
  readonly onFile?: (result: TestFileResult) => void;
}

export function discoverTests(
  workspaceDir: string,
  paths?: readonly string[],
): string[] {
  const roots = paths && paths.length > 0 ? paths : ["."];
  const found = new Set<string>();
  for (const root of roots) {
    if (root.endsWith(".lua")) {
      found.add(root.replace(/\\/g, "/"));
      continue;
    }
    // what is never copied onto a computer (node_modules, .runtime ...) holds no tests to run either
    for (const entry of listWorkspace(workspaceDir, root, COPY_SKIP)) {
      if (entry.kind === "file" && entry.path.endsWith(".test.lua"))
        found.add(entry.path);
    }
  }
  return [...found].sort();
}

export function testBoot(
  file: string,
  monitors: readonly MonitorSpec[],
): string {
  return [
    UNATTENDED_LUA,
    monitorSetupLua(monitors),
    `_G.ccunit = dofile("/ccunit/ccunit.lua")`,
    `ccunit._shell = shell`,
    // shell.run only prints a syntax error and returns false: load the file first, so the report names it and its line
    `local _, syntaxErr = loadfile(${luaString(file)}, nil, _ENV)`,
    `if syntaxErr then`,
    `  local msg = tostring(syntaxErr):gsub("^/", "")`,
    `  ccunit.test("load " .. ${luaString(file)}, function() error("syntax error in " .. msg, 0) end)`,
    `else`,
    `  local ok, err = pcall(shell.run, ${luaString(file)})`,
    `  if not ok then ccunit.test("load " .. ${luaString(file)}, function() error(err, 0) end) end`,
    `end`,
    REDRAW_TERMINAL_LUA,
    `ccunit.finish()`,
  ].join("\n");
}

async function runTestFile(
  config: RunnerConfig,
  file: string,
  request: TestRequest,
): Promise<TestFileResult> {
  const started = Date.now();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const boot = testBoot(file, request.monitors ?? []);
  const blockWorld = request.world && isBlockWorld(request.world);
  // a version whose ROM an installed package has not built yet: built now, outside the test's timeout
  await ensureRom(config, request.world?.version);
  // the copy counts against the timeout, and never blocks: other clients of the MCP server go on meanwhile
  const staged = blockWorld
    ? undefined
    : await stageWithin(
        config,
        "test",
        request.world,
        timeoutMs,
        request.signal,
      );
  if (staged === "timed_out")
    return {
      file,
      status: "timed_out",
      tests: [],
      terminal: [
        request.signal?.aborted
          ? "cancelled while copying the workspace onto the computer"
          : `copying the workspace onto the computer took more than ${timeoutMs} ms: the workspace is too big. ` +
            'Point it at the folder with your programs, or give the world a deploy list ({"deploy": [{"from": "src"}]}).',
      ],
      durationMs: Date.now() - started,
    };
  // a turtle's world: the host that shares its blocks and starts the computers it places
  const blocks = blockWorld
    ? startInBlockWorld(config, boot, {
        label: "test",
        timeScale: request.timeScale,
        world: request.world!,
      })
    : undefined;
  const handle =
    blocks?.handle ??
    startEngine(config, boot, {
      label: "test",
      timeScale: request.timeScale,
      world: request.world,
      computerSpaceLimit: request.computerSpaceLimit,
      ...(staged && { staged }),
    });
  let timedOut = false;
  const onAbort = (): void => {
    void handle.session.stop(0).catch(() => undefined);
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await handle.session
      .waitForExit(Math.max(100, timeoutMs - (Date.now() - started)))
      .catch(async () => {
        timedOut = true;
        await handle.session.stop(0);
      });
    if (request.signal?.aborted) timedOut = true;
    const parsed = readResultFile<{ tests: TestCase[]; failed: number }>(
      handle.resultsDir,
      "results.json",
    );
    // a file that never finished: the tests it got through, and the one it was in
    const streamed = parsed ? undefined : readStreamed(handle.resultsDir);
    const tests = (
      Array.isArray(parsed?.tests) ? parsed.tests : (streamed?.tests ?? [])
    ).map(withPosition);
    if (streamed?.running !== undefined)
      tests.push({
        name: streamed.running,
        passed: false,
        error: timedOut
          ? `timed out in this test (the file had ${timeoutMs} ms)`
          : "the computer stopped in this test",
      });
    const status: TestFileResult["status"] = timedOut
      ? "timed_out"
      : tests.length === 0
        ? "crashed"
        : !parsed || parsed.failed > 0 || tests.some((t) => !t.passed)
          ? "failed"
          : "passed";
    const terminal =
      status === "passed"
        ? undefined
        : captureScreens(handle.session).flatMap((s) =>
            s.lines.filter((l) => l.length > 0),
          );
    return { file, status, tests, terminal, durationMs: Date.now() - started };
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
    if (blocks) {
      blocks.network.close();
      await blocks.host.dispose();
    }
    handle.dispose();
  }
}

/**
 * How many test files run at once: CRAFTOS_TEST_CONCURRENCY, else half the machine's cores, at least 4 and at most
 * 16. Each file is its own engine, about one core while it runs, and a run takes as long as its slowest file once
 * there are enough workers, so more of them pays on a big machine (33 files: 201 s at 4, 118 s at 16 on 32 cores).
 */
export function testConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env["CRAFTOS_TEST_CONCURRENCY"]);
  if (Number.isInteger(set) && set >= 1) return set;
  return Math.min(16, Math.max(4, Math.floor(availableParallelism() / 2)));
}

export async function runTests(
  config: RunnerConfig,
  request: TestRequest = {},
  concurrency = testConcurrency(),
): Promise<TestRunResult> {
  const files = discoverTests(config.workspaceDir, request.paths);
  const results: TestFileResult[] = new Array(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (request.signal?.aborted) return;
      const index = next++;
      if (index >= files.length) return;
      results[index] = await runTestFile(config, files[index]!, request);
      request.onFile?.(results[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  // a cancelled run leaves the files it never started out
  const ran = results.filter((r): r is TestFileResult => r !== undefined);
  results.length = 0;
  results.push(...ran);
  for (const file of results) {
    for (const t of file.tests)
      if (t.skipped) skipped++;
      else if (t.passed) passed++;
      else failed++;
    // a file that broke counts once, unless a failing test already says so
    if (
      (file.status === "timed_out" || file.status === "crashed") &&
      !file.tests.some((t) => !t.passed)
    )
      failed++;
  }
  return { passed, failed, ...(skipped && { skipped }), files: results };
}

/** /results/results.jsonl (ccunit streams each test there): what finished, and the test that started but never did. */
function readStreamed(
  resultsDir: string,
): { tests: TestCase[]; running?: string } | undefined {
  let text: string;
  try {
    text = readFileSync(join(resultsDir, "results.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  const tests: TestCase[] = [];
  let running: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: { event?: string; name?: string } & Partial<TestCase>;
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // the last line, cut off mid-write
    }
    const name = String(entry.name ?? "");
    if (entry.event === "start") running = name;
    else if (entry.event === "end") {
      if (running === name) running = undefined;
      tests.push({
        name,
        passed: entry.passed === true,
        ...(entry.error !== undefined && { error: entry.error }),
        ...(entry.skipped && { skipped: true }),
      });
    }
  }
  return running === undefined ? { tests } : { tests, running };
}

/** A failure's file and line, pulled out of "file:line: message". */
function withPosition(test: TestCase): TestCase {
  if (test.passed || !test.error || test.file) return test;
  const { file, line } = parseLuaError(
    test.error.replace(/^syntax error in /, ""),
  );
  return file ? { ...test, file, line } : test;
}
